// THE ONE mutable authority for expanded / positions / fitted / focus / viewport (§3.3).
//
// `AppState` does not carry `doc.view` as well; there is exactly one writable
// holder, so the two cannot silently diverge. Treated immutably: commands
// copy-on-write and return a new ViewState.

import type { NodeId, Position, Viewport } from './types.ts';

/**
 * A node's EXPLICIT focus state (Issue #17). Absent from `FocusState.marks` means
 * "inherit from the nearest marked ancestor", which is not the same as `in-focus`.
 *
 * Spelled in full on purpose. `view.focus` travels inside the artifact a coding agent
 * reads, and a bare `"out"` on a node is one reading away from "out of scope",
 * "excluded" or "dead" — a claim about the SYSTEM rather than about where a person is
 * looking. See I-F10: nothing under `view.*` is ever an observation.
 */
export type FocusMark = 'out-of-focus' | 'in-focus';

export interface FocusState {
  /**
   * EXPLICIT marks only. May carry INERT ids — ids that are not in the model —
   * because `import` keeps them so that load → export is lossless (§3.5). `refresh`
   * drops them and reports the count.
   */
  readonly marks: ReadonlyMap<NodeId, FocusMark>;
  /**
   * Integer percent. Repaired into the `Limits` band on load at a known minor,
   * preserved verbatim above `SUPPORTED_MINOR` (§5.4). Unlike a mark, an
   * out-of-range alpha is not human work worth preserving.
   */
  readonly transparency: number;
}

export interface ViewState {
  readonly expanded: ReadonlySet<NodeId>;
  /**
   * Includes INERT entries: positions for ids that are not in the model. `import`
   * keeps them (so load → export is lossless); `refresh` drops them and says so
   * in its loss report (§3.5).
   */
  readonly positions: ReadonlyMap<NodeId, Position>;
  /**
   * Containers the user fit to content (Issue #13). REQUIRED (not optional) so the
   * `with*` copiers below are compiler-enforced to thread it: an optional field would
   * let `withViewport` (fired on every pan/zoom) silently drop the hug. Like
   * `expanded`, may carry inert ids; import keeps them, refresh drops+reports them.
   */
  readonly fitted: ReadonlySet<NodeId>;
  /**
   * Out-of-focus state (Issue #17). REQUIRED for the same reason `fitted` is, and the
   * lesson generalises further than v1 of that RFC believed: a required field makes the
   * five copiers below compiler-enforced, and NOTHING more. It does not reach the
   * `VisualSpecsView` boundary, whose keys are all optional — see
   * `viewProjection` in `app/projectController.ts`, which is where the four remaining
   * sites are made exhaustive.
   */
  readonly focus: FocusState;
  readonly viewport: Viewport;
}

export const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };

/**
 * The default out-of-focus transparency, as a percent.
 *
 * 70 (alpha 0.30) rather than v1's 80: measured against the real canvas background
 * (`--bg: #0b0e16`), 80 put a focus-dimmed box within 1/255 per channel of a
 * SEARCH-dimmed one, re-coupling by default the two channels the design decouples.
 * The band's ceiling lives in `Limits`, not here, so re-tuning it can never make a
 * previously-valid document unopenable (§5.4).
 */
export const FOCUS_TRANSPARENCY_DEFAULT = 70;

export function emptyFocus(): FocusState {
  return { marks: new Map<NodeId, FocusMark>(), transparency: FOCUS_TRANSPARENCY_DEFAULT };
}

/** Nothing is marked and the transparency is the default: the state a document that
 *  never used the feature has, and the condition on which `export` neither emits the
 *  key nor raises `formatVersion` (§5.2, §5.3). */
export function isDefaultFocus(focus: FocusState): boolean {
  return focus.marks.size === 0 && focus.transparency === FOCUS_TRANSPARENCY_DEFAULT;
}

export function emptyView(): ViewState {
  return {
    expanded: new Set<NodeId>(),
    positions: new Map<NodeId, Position>(),
    fitted: new Set<NodeId>(),
    focus: emptyFocus(),
    viewport: DEFAULT_VIEWPORT,
  };
}

export function withExpanded(view: ViewState, expanded: ReadonlySet<NodeId>): ViewState {
  return {
    expanded,
    positions: view.positions,
    fitted: view.fitted,
    focus: view.focus,
    viewport: view.viewport,
  };
}

export function withPositions(view: ViewState, positions: ReadonlyMap<NodeId, Position>): ViewState {
  return {
    expanded: view.expanded,
    positions,
    fitted: view.fitted,
    focus: view.focus,
    viewport: view.viewport,
  };
}

export function withFitted(view: ViewState, fitted: ReadonlySet<NodeId>): ViewState {
  return {
    expanded: view.expanded,
    positions: view.positions,
    fitted,
    focus: view.focus,
    viewport: view.viewport,
  };
}

export function withFocus(view: ViewState, focus: FocusState): ViewState {
  return {
    expanded: view.expanded,
    positions: view.positions,
    fitted: view.fitted,
    focus,
    viewport: view.viewport,
  };
}

export function withViewport(view: ViewState, viewport: Viewport): ViewState {
  return {
    expanded: view.expanded,
    positions: view.positions,
    fitted: view.fitted,
    focus: view.focus,
    viewport,
  };
}
