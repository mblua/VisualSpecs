// The controller, against FakeRenderer, headless (§8.4, §12).
//
// FakeRenderer is the continuous proof the seam is real: if a controller test ever
// needed the Canvas adapter, the seam would be broken and this file would say so.

import { describe, expect, it } from 'vitest';
import { FakeRenderer } from '../../src/adapters/fake/FakeRenderer.ts';
import { Controller } from '../../src/app/controller.ts';
import { SEARCH_NODE_OPACITY } from '../../src/app/scene.ts';
import { stateFromLoaded } from '../../src/app/state.ts';
import { importDoc } from '../../src/contract/load.ts';
import { sampleDoc } from '../support/doc.ts';

function boot(text = sampleDoc()) {
  const renderer = new FakeRenderer();
  const controller = new Controller(renderer, stateFromLoaded(importDoc(text)));
  controller.start();
  return { renderer, controller };
}

describe('the loop', () => {
  it('renders the initial view: the repository and its children, not every file', () => {
    const { renderer } = boot();
    expect(renderer.nodeIds().sort()).toEqual(['pkg-a', 'pkg-b', 'repo']);
  });

  it('double-clicking a container expands it', () => {
    const { renderer } = boot();
    renderer.emit({ type: 'node:dblclick', id: 'pkg-a' });
    expect(renderer.nodeIds()).toContain('dir-a');
    renderer.emit({ type: 'node:dblclick', id: 'pkg-a' });
    expect(renderer.nodeIds()).not.toContain('dir-a');
  });

  it('clicking a node selects it; clicking the background clears the selection', () => {
    const { renderer, controller } = boot();
    renderer.emit({ type: 'node:click', id: 'pkg-a', additive: false });
    expect(controller.state.selection.nodeIds).toEqual(['pkg-a']);
    expect(renderer.node('pkg-a')?.selected).toBe(true);

    renderer.emit({ type: 'background:click' });
    expect(controller.state.selection.nodeIds).toEqual([]);
  });

  it('selecting an AGGREGATED edge surfaces its sourceEdgeIds — the product’s promise', () => {
    const { renderer, controller } = boot();
    const aggregate = controller.derived.graph.visibleEdges.find(
      (e) => e.kind === 'imports' && e.count === 2,
    );
    expect(aggregate).toBeDefined();

    renderer.emit({ type: 'edge:click', id: aggregate?.id ?? '' });
    expect(controller.state.selection.edgeId).toBe(aggregate?.id);

    const resolved = controller.derived.graph.visibleEdgeById.get(
      controller.state.selection.edgeId as never,
    );
    // Resolved against the VisibleGraph, never against doc.edges (§6.4).
    expect([...(resolved?.sourceEdgeIds ?? [])]).toEqual(['e1', 'e2']);
    for (const id of resolved?.sourceEdgeIds ?? []) {
      expect(controller.state.model.edgeById.has(id)).toBe(true);
    }
  });

  it('selecting a container surfaces WHICH relations are hidden inside it, not a bare number', () => {
    const { controller } = boot();
    const buckets = controller.derived.graph.internalBucketsByNode.get('pkg-a') ?? [];
    expect(buckets).toHaveLength(1);
    expect([...(buckets[0]?.sourceEdgeIds ?? [])]).toEqual(['e3']);
  });

  it('search dims the misses and ExpandTo reveals a hit hidden inside collapsed ancestors', () => {
    const { renderer, controller } = boot();
    controller.dispatch({ type: 'SetSearch', query: 'two.ts' });
    expect(controller.state.search.matches.has('file-a2')).toBe(true);

    // The hit is not drawn yet — it is inside a collapsed package.
    expect(renderer.nodeIds()).not.toContain('file-a2');
    controller.dispatch({ type: 'ExpandTo', id: 'file-a2' });

    // ExpandTo opened every ancestor: repo → pkg-a → dir-a.
    expect(renderer.nodeIds()).toContain('file-a2');
    // These followed the semantics rather than the field name when `dimmed: boolean`
    // became `opacity: number` (#17): the strength search dims at is now app policy
    // in `app/scene.ts`, so the assertion names the constant instead of a literal.
    expect(renderer.node('file-a2')?.opacity).toBe(1);
    // A visible node that does not match is dimmed, not hidden.
    expect(renderer.node('pkg-b')?.opacity).toBe(SEARCH_NODE_OPACITY);
    expect(renderer.node('pkg-b')?.hidden).toBe(false);
    // A sibling that does not match is dimmed too.
    expect(renderer.node('file-a1')?.opacity).toBe(SEARCH_NODE_OPACITY);
  });

  it('a filter masks the scene without re-projecting it', () => {
    const { renderer, controller } = boot();
    const before = controller.derived.graph.visibleEdges.length;
    controller.dispatch({ type: 'SetFilter', edgeKinds: new Set(['imports']) });

    // The PROJECTION is unchanged…
    expect(controller.derived.graph.visibleEdges.length).toBe(before);
    // …the SCENE is masked.
    const bundles = renderer.lastScene?.edges.filter((e) => e.kind === 'bundles') ?? [];
    expect(bundles.length).toBeGreaterThan(0);
    for (const e of bundles) expect(e.hidden).toBe(true);
  });

  it('render is declarative: the controller never issues addNode/removeEdge', () => {
    const { renderer } = boot();
    const first = renderer.renderCount;
    renderer.emit({ type: 'node:dblclick', id: 'pkg-a' });
    expect(renderer.renderCount).toBe(first + 1);
    // A whole scene, every time.
    expect(renderer.lastScene?.nodes.length).toBeGreaterThan(0);
  });
});

describe('drag → export → reload', () => {
  it('restores the position, the expansion and the viewport', () => {
    const { renderer, controller } = boot();

    // Open the package AND the directory, so file-a1 is a box the user can grab.
    renderer.emit({ type: 'node:dblclick', id: 'pkg-a' });
    renderer.emit({ type: 'node:dblclick', id: 'dir-a' });
    expect(renderer.nodeIds()).toContain('file-a1');

    renderer.emit({ type: 'node:dragend', id: 'file-a1', position: { x: 777, y: 555 } });
    controller.dispatch({ type: 'SetViewport', viewport: { x: 12, y: 34, zoom: 1.5 } });

    const exported = controller.exportText();

    // A brand-new controller, from the exported bytes alone.
    const renderer2 = new FakeRenderer();
    const controller2 = new Controller(renderer2, stateFromLoaded(importDoc(exported)));
    controller2.start();

    expect(controller2.state.view.positions.get('file-a1')).toEqual({
      x: 777,
      y: 555,
      pinned: true,
    });
    expect(controller2.state.view.expanded.has('pkg-a')).toBe(true);
    expect(controller2.state.view.expanded.has('dir-a')).toBe(true);
    expect(controller2.state.view.viewport).toEqual({ x: 12, y: 34, zoom: 1.5 });

    // …and the node is actually drawn there.
    expect(renderer2.node('file-a1')?.position).toEqual({ x: 777, y: 555 });
  });

  it('the exported document re-imports cleanly', () => {
    const { renderer, controller } = boot();
    renderer.emit({ type: 'node:dragend', id: 'pkg-a', position: { x: 10, y: 20 } });
    const exported = controller.exportText();
    expect(() => importDoc(exported)).not.toThrow();
  });
});

describe('import is not refresh (§3.5)', () => {
  it('import keeps a stale position; refresh drops it and SAYS SO', () => {
    const withGhost = JSON.stringify({
      ...(JSON.parse(sampleDoc()) as object),
      view: { positions: { ghost: { x: 1, y: 2 } }, expanded: ['repo'] },
    });

    const { controller } = boot(withGhost);
    // import discards NOTHING.
    expect(controller.state.view.positions.has('ghost')).toBe(true);
    expect(controller.state.warnings.some((w) => w.code === 'stale-position')).toBe(true);

    // refresh drops what no longer exists, and hands back a loss report.
    controller.refreshText(sampleDoc());
    expect(controller.state.view.positions.has('ghost')).toBe(false);
    expect(controller.state.loss?.droppedPositions).toEqual(['ghost']);
  });

  it('refresh keeps the layout the user made', () => {
    const { renderer, controller } = boot();
    renderer.emit({ type: 'node:dragend', id: 'pkg-b', position: { x: 400, y: 300 } });
    controller.refreshText(sampleDoc());
    expect(controller.state.view.positions.get('pkg-b')).toEqual({ x: 400, y: 300, pinned: true });
  });
});

describe('refresh and an OPEN vocabulary (§3.7)', () => {
  it('a kind that did not exist before is SHOWN, not hidden by an inherited filter', () => {
    const { controller } = boot();

    // The user hides one kind they know about.
    const withoutBundles = new Set(
      [...controller.state.filters.edgeKinds].filter((k) => k !== 'bundles'),
    );
    controller.dispatch({ type: 'SetFilter', edgeKinds: withoutBundles });
    expect(controller.state.filters.edgeKinds.has('bundles')).toBe(false);

    // A newer extraction introduces a kind nobody has ever seen.
    const next = JSON.parse(sampleDoc()) as { nodes: unknown[]; edges: unknown[] };
    next.edges.push({
      id: 'e5',
      kind: 'tauri-command',
      sourceId: 'file-a1',
      targetId: 'file-b1',
      confidence: 'resolved',
    });
    next.nodes.push({ id: 'crate-c', kind: 'crate', label: 'crate-c', parentId: 'repo' });
    controller.refreshText(JSON.stringify(next));

    // The new kinds are visible — a filter cannot hide what the user never switched off…
    expect(controller.state.filters.edgeKinds.has('tauri-command')).toBe(true);
    expect(controller.state.filters.nodeKinds.has('crate')).toBe(true);
    // …and the one they DID switch off stays off.
    expect(controller.state.filters.edgeKinds.has('bundles')).toBe(false);
    expect(controller.state.filters.edgeKinds.has('imports')).toBe(true);
  });
});

describe('zoom goes through the controller and the port, never around them', () => {
  it('zoomBy asks the renderer and records the viewport it comes back with', () => {
    const { renderer, controller } = boot();
    const before = controller.state.view.viewport.zoom;

    controller.zoomBy(2);
    expect(renderer.zoomCalls).toEqual([2]);
    expect(controller.state.view.viewport.zoom).toBeCloseTo(before * 2, 6);

    controller.zoomBy(0.5);
    expect(controller.state.view.viewport.zoom).toBeCloseTo(before, 6);
  });

  it('ONE notification per action — the renderer already told us the camera moved', () => {
    // `fit()` and `zoomBy()` emit `viewport:change`, which the controller turns into state
    // and a notification. Reading the viewport back and applying the IDENTICAL value a
    // second time notified again, so every zoom re-rendered the whole UI twice.
    const { controller } = boot();

    let notifications = 0;
    const off = controller.subscribe(() => {
      notifications += 1;
    });
    expect(notifications).toBe(1); // subscribe delivers the current state immediately
    notifications = 0;

    controller.zoomBy(2);
    expect(notifications, 'zoomBy notified more than once').toBe(1);

    notifications = 0;
    controller.fit();
    expect(notifications, 'fit notified more than once').toBe(1);

    off();
  });
});

describe('destroy', () => {
  it('unwires the renderer and is safe to call twice', () => {
    const { renderer, controller } = boot();
    controller.destroy();
    controller.destroy();
    expect(renderer.destroyCount).toBeGreaterThanOrEqual(1);
  });
});

describe('refresh carries the selection for surviving ids (A2-F4)', () => {
  it('keeps selected surviving nodes and drops vanished ids only', () => {
    const { renderer, controller } = boot();
    renderer.emit({ type: 'node:click', id: 'pkg-a', additive: false });
    renderer.emit({ type: 'node:click', id: 'pkg-b', additive: true });
    expect(controller.state.selection.nodeIds).toEqual(['pkg-a', 'pkg-b']);

    // pkg-b and its subtree vanish in the new document.
    const next = JSON.parse(sampleDoc()) as {
      nodes: { id: string }[];
      edges: { targetId: string }[];
    };
    next.nodes = next.nodes.filter((n) => !['pkg-b', 'dir-b', 'file-b1'].includes(n.id));
    next.edges = next.edges.filter((e) => e.targetId !== 'file-b1');
    controller.refreshText(JSON.stringify(next));

    expect(controller.state.selection.nodeIds).toEqual(['pkg-a']);
  });

  it('keeps a surviving selected aggregated edge and it resolves against the NEW projection', () => {
    const { renderer, controller } = boot();
    const aggregate = controller.derived.graph.visibleEdges.find(
      (e) => e.kind === 'imports' && e.count === 2,
    );
    expect(aggregate).toBeDefined();
    renderer.emit({ type: 'edge:click', id: aggregate?.id ?? '' });
    expect(controller.state.selection.edgeId).toBe(aggregate?.id);

    controller.refreshText(sampleDoc());

    expect(controller.state.selection.edgeId).toBe(aggregate?.id);
    expect(
      controller.derived.graph.visibleEdgeById.get(controller.state.selection.edgeId as never),
    ).toBeDefined();
  });

  it('clears a selected edge whose underlying relations vanished', () => {
    const { renderer, controller } = boot();
    const aggregate = controller.derived.graph.visibleEdges.find(
      (e) => e.kind === 'imports' && e.count === 2,
    );
    renderer.emit({ type: 'edge:click', id: aggregate?.id ?? '' });
    expect(controller.state.selection.edgeId).toBe(aggregate?.id);

    const next = JSON.parse(sampleDoc()) as { edges: { kind: string }[] };
    next.edges = next.edges.filter((e) => e.kind !== 'imports');
    controller.refreshText(JSON.stringify(next));

    expect(controller.state.selection.edgeId).toBeNull();
  });
});

describe('dispatch atomicity under a throwing install (resilience A2-P3 hardening)', () => {
  it('a Refresh whose apply throws leaves state AND derived exactly as they were', () => {
    // The scriptable half of the class: `apply` (which runs stateFromLoaded for
    // Refresh) throwing must not tear the controller. A poisoned model makes the
    // install throw at first touch. The derive-AFTER-apply half needs an
    // injection seam in controller.ts (outside this artifact's files) and is
    // escalated per the plan, not silently approximated.
    const { controller } = boot();
    const before = controller.state;
    const beforeDerived = controller.derived;

    const loaded = importDoc(sampleDoc());
    const poisonedModel = new Proxy(loaded.model, {
      get() {
        throw new Error('poisoned model');
      },
    });
    expect(() =>
      controller.dispatch({
        type: 'Refresh',
        loaded: { ...loaded, model: poisonedModel as never },
        loss: {
          droppedPositions: [],
          droppedExpanded: [],
          droppedFitted: [],
          droppedFocus: [],
          newNodes: [],
          reparented: [],
        },
      }),
    ).toThrow('poisoned model');

    expect(controller.state).toBe(before);
    expect(controller.derived).toBe(beforeDerived);
  });
});

describe('the fit-to-content control (Issue #13)', () => {
  it('a container:fit event maps to FitContainer: the box joins view.fitted and its children are pinned', () => {
    const { renderer, controller } = boot();
    renderer.emit({ type: 'node:dblclick', id: 'pkg-a' }); // expand it first
    expect(controller.state.view.expanded.has('pkg-a')).toBe(true);
    expect(controller.state.view.fitted.has('pkg-a')).toBe(false);

    renderer.emit({ type: 'container:fit', id: 'pkg-a' });

    // Only FitContainer adds to `fitted`: this is the proof the renderer event reached
    // the command through the controller wiring.
    expect(controller.state.view.fitted.has('pkg-a')).toBe(true);
    // …and its effect propagated — freezing pins the visible children at drawn centres.
    expect(controller.state.view.positions.get('dir-a')?.pinned).toBe(true);
  });

  it('is a safe no-op on a collapsed container (the childrenShown guard)', () => {
    const { renderer, controller } = boot();
    const before = controller.state;

    renderer.emit({ type: 'container:fit', id: 'pkg-b' }); // pkg-b is collapsed

    expect(controller.state.view.fitted.has('pkg-b')).toBe(false);
    // A no-op view command returns the same view, so dispatch short-circuits: same state.
    expect(controller.state).toBe(before);
  });

  it('removes the wasted band: the visible box shrinks to hug its children (before/after evidence)', () => {
    const { renderer, controller } = boot();
    renderer.emit({ type: 'node:dblclick', id: 'pkg-a' });
    renderer.emit({ type: 'node:dblclick', id: 'dir-a' });
    expect(renderer.nodeIds()).toContain('file-a1');
    expect(renderer.nodeIds()).toContain('file-a2');

    // Drag one child far off-centre. The container grows SYMMETRICALLY about its stored
    // centre to contain it, so the opposite side becomes an empty band — the exact waste
    // (Frontend in the corpus) this feature exists to remove.
    const child = renderer.node('file-a2');
    expect(child).toBeDefined();
    renderer.emit({
      type: 'node:dragend',
      id: 'file-a2',
      position: { x: (child as { position: { x: number } }).position.x, y: (child as { position: { y: number } }).position.y + 500 },
    });

    // The symmetric-growth box before the fit — tall, because half of it is the empty
    // band mirroring the dragged child (measured: 270×1112 for this scenario).
    const beforeH = renderer.node('dir-a')?.size.h ?? 0;
    expect(beforeH).toBeGreaterThan(0);

    renderer.emit({ type: 'container:fit', id: 'dir-a' });

    const after = renderer.node('dir-a');
    expect(after).toBeDefined();
    // The band is gone: the fitted box is strictly shorter than the symmetric one
    // (measured: 1112 → 612, the ~500px band removed).
    expect(after?.size.h).toBeLessThan(beforeH);
    // The glyph will render "fitted".
    expect(after?.fitted).toBe(true);

    // …and every visible child still sits inside the fitted box — a hug loses nothing.
    const box = {
      l: (after as NonNullable<typeof after>).position.x - (after as NonNullable<typeof after>).size.w / 2,
      r: (after as NonNullable<typeof after>).position.x + (after as NonNullable<typeof after>).size.w / 2,
      t: (after as NonNullable<typeof after>).position.y - (after as NonNullable<typeof after>).size.h / 2,
      b: (after as NonNullable<typeof after>).position.y + (after as NonNullable<typeof after>).size.h / 2,
    };
    for (const id of ['file-a1', 'file-a2']) {
      const c = renderer.node(id) as NonNullable<ReturnType<typeof renderer.node>>;
      expect(c.position.x - c.size.w / 2).toBeGreaterThanOrEqual(box.l - 0.5);
      expect(c.position.x + c.size.w / 2).toBeLessThanOrEqual(box.r + 0.5);
      expect(c.position.y - c.size.h / 2).toBeGreaterThanOrEqual(box.t - 0.5);
      expect(c.position.y + c.size.h / 2).toBeLessThanOrEqual(box.b + 0.5);
    }
  });
});
