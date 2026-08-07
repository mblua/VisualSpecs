// The loop (§9.2):
//
//   UI intent ──▶ controller.dispatch(command)
//                   ├─▶ commands.apply(state, cmd)              ──▶ new AppState  (pure)
//                   ├─▶ projection.project(model, outline, exp) ──▶ VisibleGraph  (pure)
//                   ├─▶ scene.build(visibleGraph, registry, st) ──▶ RenderScene   (pure)
//                   └─▶ renderer.render(scene)                                    (adapter)
//
//   renderer event ──▶ controller.handle(event) ──▶ dispatch(command) ──▶ (loop)
//
// Three pure steps, one impure call. Everything above `render` is testable without
// a DOM, and every controller test in this repository runs against FakeRenderer.

import type { NodeId, Position } from '../contract/types.ts';
import { importDoc, refresh, type LoadedDoc } from '../contract/load.ts';
import { DEFAULT_LIMITS, type Limits } from '../contract/limits.ts';
import { exportDoc } from '../contract/export.ts';
import type { ViewState } from '../contract/view.ts';
import { computeGeometry, DEFAULT_AUTO_LAYOUT, type Geometry } from '../domain/layoutEngine.ts';
import type { CommandContext } from '../domain/commands.ts';
import { computeVisibility } from '../domain/visibility.ts';
import { LevelPack } from '../domain/layout/levelPack.ts';
import { project } from '../projection/project.ts';
import type { VisibleGraph } from '../projection/types.ts';
import type { GraphRenderer, RendererEvent } from '../ports/renderer.ts';
import { apply, stateFromLoaded, type AppCommand, type AppState } from './state.ts';
import { buildScene, type SceneResult } from './scene.ts';
import {
  DEPENDENCY_KINDS,
  NO_RANKINGS,
  packConstraintsFrom,
  RankCache,
  rankVisibleContainers,
  type Rankings,
} from './levelView.ts';

/** Levels mode swaps the layout, and nothing else: `DEFAULT_AUTO_LAYOUT` stays GridPack,
 *  so every existing test and every existing document keeps the geometry it had. */
const LEVEL_LAYOUT = new LevelPack();

export interface Derived {
  geometry: Geometry;
  graph: VisibleGraph;
  scene: SceneResult;
  /** Empty unless Levels mode is on. The sidebar and the detail panel read it. */
  rankings: Rankings;
}

export type Listener = (state: AppState, derived: Derived) => void;

export class Controller {
  private readonly renderer: GraphRenderer;
  private currentState: AppState;
  private currentDerived: Derived;
  private listeners = new Set<Listener>();
  private offRenderer: (() => void) | null = null;
  /**
   * The same band `validate` and `load` are given, so the domain's clamp on
   * `SetFocusTransparency` and the contract's clamp on load cannot disagree. Injectable
   * and defaulted, matching `importDoc(text, limits = DEFAULT_LIMITS)`; a second
   * hard-coded `DEFAULT_LIMITS` here would have been a split brain the moment a test
   * injected a narrow band at the contract boundary.
   */
  private readonly limits: Limits;
  /**
   * Memoized rankings, keyed by `(container, kinds, basis)` — NOT by `expanded`, because
   * `rank()` lifts endpoints to direct children and is invariant under expansion.
   *
   * It lives on the controller and not in a module: two controllers in one process would
   * otherwise share a memo keyed by container id, and the tests build several.
   */
  private readonly rankCache = new RankCache();

  constructor(renderer: GraphRenderer, initial: AppState, limits: Limits = DEFAULT_LIMITS) {
    this.renderer = renderer;
    this.currentState = initial;
    this.limits = limits;
    this.currentDerived = derive(initial, this.rankCache);
  }

  get state(): AppState {
    return this.currentState;
  }

  get derived(): Derived {
    return this.currentDerived;
  }

  /** Wire the renderer's events into the loop. Returns nothing: `destroy()` unwires. */
  start(): void {
    this.offRenderer = this.renderer.on((event) => {
      this.handle(event);
    });
    this.renderer.setViewport(this.currentState.view.viewport);
    this.render();
  }

  handle(event: RendererEvent): void {
    switch (event.type) {
      case 'node:click':
        this.dispatch({
          type: 'Select',
          nodeIds: event.additive
            ? uniq([...this.currentState.selection.nodeIds, event.id])
            : [event.id],
          edgeId: null,
        });
        return;
      case 'node:dblclick':
        this.dispatch({ type: 'ToggleExpand', id: event.id });
        return;
      case 'node:dragend':
        this.dispatch({ type: 'MoveNode', id: event.id, position: event.position });
        return;
      case 'container:fit':
        // The header's fit control. The command guards on `childrenShown`, so a fit on
        // a non-visible container is a safe no-op (§ADR-0005 / F1).
        this.dispatch({ type: 'FitContainer', id: event.id });
        return;
      case 'edge:click':
        this.dispatch({
          type: 'Select',
          nodeIds: [],
          edgeId: event.id as AppState['selection']['edgeId'],
        });
        return;
      case 'background:click':
        this.dispatch({ type: 'Select', nodeIds: [], edgeId: null });
        return;
      // A right-click on a node opens a MENU, which is presentation, not state (#17
      // §8.3.1). The UI subscribes to the renderer for it and dispatches whatever the
      // user then chooses, through this same loop. Named rather than left to
      // `default:` so the exhaustiveness check keeps meaning what it says.
      case 'node:contextmenu':
        return;
      case 'viewport:change':
        // The renderer already moved the camera. Record it, tell the UI, but do
        // NOT push it back into the renderer — that is the feedback loop.
        this.currentState = apply(
          this.currentState,
          { type: 'SetViewport', viewport: event.viewport },
          this.context(),
        );
        this.notify();
        return;
      default: {
        const exhaustive: never = event;
        void exhaustive;
      }
    }
  }

  dispatch(cmd: AppCommand): void {
    const before = this.currentState;
    this.currentState = apply(before, cmd, this.context());
    if (this.currentState === before) return;

    this.currentDerived = derive(this.currentState, this.rankCache);

    if (this.currentState.view.viewport !== before.view.viewport) {
      this.renderer.setViewport(this.currentState.view.viewport);
    }
    this.render();
  }

  /** Import is not refresh (§3.5): this one discards nothing. */
  importText(text: string): void {
    const loaded = importDoc(text);
    this.replaceLoaded(loaded);
  }

  replaceLoaded(loaded: LoadedDoc): void {
    this.installLoaded(loaded, () => undefined);
  }

  /**
   * Install one already-validated document together with related application state.
   *
   * `installRelated` is deliberately synchronous: ProjectController uses it to
   * publish the matching ref/head/identity/dirty facts after the new AppState exists
   * but before any Controller subscriber can observe it. No store or await belongs
   * inside this boundary.
   */
  installLoaded(
    loaded: LoadedDoc,
    installRelated: () => void,
    viewOverride?: ViewState,
  ): void {
    const loadedState = stateFromLoaded(loaded);
    this.currentState =
      viewOverride === undefined ? loadedState : { ...loadedState, view: viewOverride };
    this.currentDerived = derive(this.currentState, this.rankCache);
    this.renderer.setViewport(this.currentState.view.viewport);
    installRelated();
    this.render();
  }

  replaceView(view: ViewState): void {
    this.installView(view, () => undefined);
  }

  /** Atomic sibling of `installLoaded` for a view-only application transition. */
  installView(view: ViewState, installRelated: () => void): void {
    this.currentState = { ...this.currentState, view };
    this.currentDerived = derive(this.currentState, this.rankCache);
    this.renderer.setViewport(this.currentState.view.viewport);
    installRelated();
    this.render();
  }

  /** Re-extract on a newer commit and keep my layout — with the loss shown. */
  refreshText(text: string): void {
    const { loaded, loss } = refresh(text, {
      model: this.currentState.model,
      view: this.currentState.view,
    });
    this.dispatch({ type: 'Refresh', loaded, loss });
  }

  /**
   * Export the document. The positions of every VISIBLE node are persisted, not
   * just the pinned ones, so the exported file describes the layout you are
   * looking at (§7: "children are laid out lazily and persisted"). Auto-layout
   * re-derives the unpinned ones identically on reload, so this is a convenience,
   * not a source of truth.
   */
  exportText(): string {
    const positions = new Map<NodeId, Position>(this.currentState.view.positions);
    for (const n of this.currentDerived.graph.visibleNodes) {
      const entity = this.currentState.outline.entityOf(n);
      if (positions.has(entity)) continue;
      const p = this.currentDerived.geometry.position.get(n);
      if (p !== undefined) positions.set(entity, { x: round(p.x), y: round(p.y) });
    }
    // Threading `focus` here is NOT bookkeeping. This literal is the export path, and
    // the obvious way to silence the compile error a required field creates is
    // `focus: emptyFocus()` — which type-checks and drops every mark from every export
    // while the app still shows them on screen. A required field makes the omission
    // loud; only reading it from state makes the export correct.
    const view: ViewState = {
      expanded: this.currentState.view.expanded,
      positions,
      fitted: this.currentState.view.fitted,
      focus: this.currentState.view.focus,
      viewport: this.currentState.view.viewport,
    };
    return exportDoc({ raw: this.currentState.raw, view, readOnly: this.currentState.readOnly });
  }

  fit(ids?: readonly string[]): void {
    this.renderer.fit(ids);
    this.syncViewportFromRenderer();
  }

  /** The toolbar's Zoom buttons and the `+` / `-` keys, through the ordinary loop.
   *  The UI never touches the adapter; it asks the controller, which asks the port. */
  zoomBy(factor: number): void {
    this.renderer.zoomBy(factor);
    this.syncViewportFromRenderer();
  }

  /**
   * Read back what the renderer actually did — and say nothing if it already told us.
   *
   * `fit()` and `zoomBy()` emit `viewport:change`, which `handle()` has already turned
   * into state and a notification. Applying the identical viewport a second time and
   * notifying again made every zoom re-render the whole UI twice. One action, one
   * notification. The read-back stays because an adapter is allowed to clamp what it was
   * asked for, and the state must reflect where the camera really is.
   */
  private syncViewportFromRenderer(): void {
    const viewport = this.renderer.getViewport();
    const current = this.currentState.view.viewport;
    if (current.x === viewport.x && current.y === viewport.y && current.zoom === viewport.zoom) {
      return;
    }
    this.currentState = apply(this.currentState, { type: 'SetViewport', viewport }, this.context());
    this.notify();
  }

  resize(): void {
    this.renderer.resize();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.currentState, this.currentDerived);
    return () => {
      this.listeners.delete(listener);
    };
  }

  destroy(): void {
    if (this.offRenderer !== null) this.offRenderer();
    this.offRenderer = null;
    this.listeners.clear();
    this.renderer.destroy();
  }

  private context(): CommandContext {
    return {
      model: this.currentState.model,
      outline: this.currentState.outline,
      geometry: this.currentDerived.geometry,
      limits: this.limits,
    };
  }

  private render(): void {
    this.renderer.render(this.currentDerived.scene.scene);
    this.notify();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener(this.currentState, this.currentDerived);
  }
}

/**
 * The pipeline, and why the rank comes FIRST (Issue #44).
 *
 * `derive()` used to compute the geometry before the projection. The rank is a projection
 * result and the layout consumes it, so the order inverts to
 * `rank → computeGeometry → project → buildScene`. There is no cycle: none of them
 * depends on the geometry.
 *
 * `cache` is threaded rather than global: two controllers in one process — which the
 * tests do — must not share a memo keyed by container id.
 */
export function derive(state: AppState, cache: RankCache = new RankCache()): Derived {
  const rankings = state.levels.active
    ? rankVisibleContainers(
        state.model,
        state.outline,
        // Only containers whose children are on screen: a collapsed one is not
        // stratified, so ranking it is work nobody looks at.
        computeVisibility(state.outline, state.view.expanded).childrenShown,
        DEPENDENCY_KINDS,
        state.levels.basis,
        cache,
      )
    : NO_RANKINGS;

  const geometry = computeGeometry(
    state.model,
    state.outline,
    state.view.expanded,
    state.view.positions,
    state.view.fitted,
    state.levels.active ? LEVEL_LAYOUT : DEFAULT_AUTO_LAYOUT,
    packConstraintsFrom(rankings),
  );
  const graph = project(state.model, state.outline, state.view.expanded);
  const scene = buildScene(state, geometry, graph, rankings);
  return { geometry, graph, scene, rankings };
}

export function controllerFrom(renderer: GraphRenderer, loaded: LoadedDoc): Controller {
  return new Controller(renderer, stateFromLoaded(loaded));
}

function uniq(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
