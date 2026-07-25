// Pure view commands: (context, view, command) => view. They never touch the
// model — I8 in its mechanical form. The model is deep-frozen in tests and a long
// random command sequence must leave it untouched.

import type { NodeId, Position, Viewport } from '../contract/types.ts';
import type { GraphModel } from '../contract/model.ts';
import type { Limits } from '../contract/limits.ts';
import type { FocusMark, FocusState, ViewState } from '../contract/view.ts';
import { withExpanded, withFitted, withFocus, withPositions, withViewport } from '../contract/view.ts';
import type { Outline, OutlineNodeId } from './outline.ts';
import { inheritedFocus, resolveFocus } from './focus.ts';
import type { Geometry } from './layoutEngine.ts';
import { CONTAINER_HEADER, type Point } from './geometry.ts';

export type ViewCommand =
  | { type: 'Expand'; id: OutlineNodeId }
  | { type: 'Collapse'; id: OutlineNodeId }
  | { type: 'ToggleExpand'; id: OutlineNodeId }
  | { type: 'ExpandAll' }
  | { type: 'CollapseAll' }
  | { type: 'ExpandTo'; id: OutlineNodeId }
  | { type: 'MoveNode'; id: OutlineNodeId; position: Point }
  | { type: 'FitContainer'; id: OutlineNodeId }
  | { type: 'ResetLayout' }
  | { type: 'SetViewport'; viewport: Viewport }
  | { type: 'SetFocus'; id: OutlineNodeId; requested: FocusMark }
  | { type: 'SetFocusInherited'; id: OutlineNodeId }
  | { type: 'SetAllFocus'; mark: FocusMark }
  | { type: 'SetFocusTransparency'; percent: number };

export interface CommandContext {
  readonly model: GraphModel;
  readonly outline: Outline;
  /** The geometry the user is looking at. `MoveNode` needs it to compute the delta. */
  readonly geometry: Geometry;
  /** `SetFocusTransparency` clamps into the injected band, so the domain and the
   *  validator agree on the same numbers rather than each holding their own. */
  readonly limits: Limits;
}

export function applyViewCommand(
  ctx: CommandContext,
  view: ViewState,
  cmd: ViewCommand,
): ViewState {
  switch (cmd.type) {
    case 'Expand':
      return setExpanded(view, cmd.id, true);
    case 'Collapse':
      return setExpanded(view, cmd.id, false);
    case 'ToggleExpand':
      return setExpanded(view, cmd.id, !view.expanded.has(cmd.id));
    case 'ExpandAll': {
      const next = new Set<OutlineNodeId>(view.expanded);
      for (const n of allOutlineNodes(ctx.outline)) {
        if (ctx.outline.childrenOf(n).length > 0) next.add(n);
      }
      return withExpanded(view, next);
    }
    case 'CollapseAll':
      return withExpanded(view, new Set<OutlineNodeId>());
    case 'ExpandTo': {
      const next = new Set<OutlineNodeId>(view.expanded);
      for (const ancestor of outlineAncestorsOf(ctx.outline, cmd.id)) next.add(ancestor);
      return withExpanded(view, next);
    }
    case 'MoveNode':
      return moveNode(ctx, view, cmd.id, cmd.position);
    case 'FitContainer':
      return fitContainer(ctx, view, cmd.id);
    case 'ResetLayout': {
      // Clears the layout the user made. INERT positions — those naming ids that
      // are not in this graph — are kept, because they are not this graph's layout
      // and dropping them would make an export lose data that `import` promised
      // to preserve (§3.5).
      const next = new Map<NodeId, Position>();
      for (const [id, p] of view.positions) {
        if (!ctx.model.nodeById.has(id)) next.set(id, p);
      }
      // R is the fit escape hatch: it un-fits every container it re-packs. Inert
      // fitted ids (not in this graph) are kept for the same §3.5 reason as positions.
      const nextFitted = new Set<NodeId>();
      for (const id of view.fitted) {
        if (!ctx.model.nodeById.has(id)) nextFitted.add(id);
      }
      return withFitted(withPositions(view, next), nextFitted);
    }
    case 'SetViewport':
      return withViewport(view, cmd.viewport);
    case 'SetFocus':
      return setFocus(ctx, view, cmd.id, cmd.requested);
    case 'SetFocusInherited':
      return clearFocusMark(ctx, view, cmd.id);
    case 'SetAllFocus':
      return setAllFocus(ctx, view, cmd.mark);
    case 'SetFocusTransparency':
      return setFocusTransparency(ctx, view, cmd.percent);
    default: {
      const exhaustive: never = cmd;
      void exhaustive;
      return view;
    }
  }
}

/**
 * THE WRITE RULE (§4.5): write the MINIMAL mark that achieves the requested effective
 * state. If the node would already inherit what was asked for, its own mark is DELETED
 * rather than a redundant one written.
 *
 * This is not an optimisation, it is the fix for a state a user cannot explain. The
 * naive rule — "*Bring into focus* writes `in-focus`" — manufactures a permanent
 * exemption out of a request that meant "undo my own dimming":
 *
 *     dim P      → {P:out}
 *     light c1   → {P:out, c1:in}        the override, working
 *     light P    → {P:in, c1:in}         naive: P now carries a mark
 *     dim repo   → {repo:out, P:in, c1:in}
 *                                        → P's WHOLE SUBTREE stays bright, and the
 *                                          user asked to dim the repository
 *
 * Under the minimal rule step 3 deletes P's mark instead, so step 4 dims P and leaves
 * only `c1` — a genuine exception the user made — lit.
 *
 * The general form is required rather than the symmetric one ("*Bring into focus*
 * deletes an out-of-focus mark"): *Send out of focus* on a node carrying its own
 * `in-focus` mark under an UNMARKED ancestor must WRITE `out-of-focus`, because
 * deleting would leave the node in focus — the opposite of the request.
 *
 * §4.5 governs WRITES; §4.6 governs RETENTION. Do not create a mark equal to its
 * inherited value; do not DELETE one that already exists. A "simplification" that
 * canonicalises the map whenever anything changes passes every test that does not
 * exercise the four steps above, and silently breaks the one requirement the user
 * stated explicitly.
 */
function setFocus(
  ctx: CommandContext,
  view: ViewState,
  id: OutlineNodeId,
  requested: FocusMark,
): ViewState {
  const entity = ctx.outline.entityOf(id);
  const effective = resolveFocus(ctx.outline, view.focus.marks);
  const parentOf = buildOutlineParents(ctx.outline);
  const inherited = inheritedFocus(effective, parentOf, id);
  const target = requested === 'out-of-focus' ? 'out' : 'in';

  if (inherited === target) return deleteMark(view, entity);

  if (view.focus.marks.get(entity) === requested) return view;
  const marks = new Map(view.focus.marks);
  marks.set(entity, requested);
  return withFocus(view, { marks, transparency: view.focus.transparency });
}

/** `Reset to inherited`. Under an out-of-focus ancestor this has NO visible canvas
 *  effect — the row glyph disappearing is the only feedback. That is correct, and it is
 *  written down so it is not later "fixed" as a no-op. */
function clearFocusMark(ctx: CommandContext, view: ViewState, id: OutlineNodeId): ViewState {
  return deleteMark(view, ctx.outline.entityOf(id));
}

function deleteMark(view: ViewState, entity: NodeId): ViewState {
  if (!view.focus.marks.has(entity)) return view;
  const marks = new Map(view.focus.marks);
  marks.delete(entity);
  return withFocus(view, { marks, transparency: view.focus.transparency });
}

/**
 * The global toggle, and `Clear all focus`.
 *
 * Clears every mark whose id IS in the model, then — for out-of-focus — marks each
 * root. In-focus therefore leaves no marks at all: the bottom of the lattice.
 *
 * INERT marks survive, exactly as inert positions and inert `fitted` ids survive
 * `ResetLayout`: they are not this graph's state, and dropping them would lose data
 * that `import` promised to preserve (§3.5). The visible consequence is owned in the
 * UI: `Clear all focus (N)` counts only CLEARABLE marks and reports inert ones
 * separately, because a button that counts what it cannot delete says `(5)`, deletes
 * 3, then says `(2)` and does nothing on every further press.
 */
function setAllFocus(ctx: CommandContext, view: ViewState, mark: FocusMark): ViewState {
  const marks = new Map<NodeId, FocusMark>();
  for (const [id, m] of view.focus.marks) {
    if (!ctx.model.nodeById.has(id)) marks.set(id, m);
  }
  if (mark === 'out-of-focus') {
    for (const root of ctx.outline.roots()) marks.set(ctx.outline.entityOf(root), mark);
  }
  if (sameMarks(view.focus.marks, marks)) return view;
  return withFocus(view, { marks, transparency: view.focus.transparency });
}

function setFocusTransparency(ctx: CommandContext, view: ViewState, percent: number): ViewState {
  if (!Number.isFinite(percent)) return view;
  const { minFocusTransparency: lo, maxFocusTransparency: hi } = ctx.limits;
  const next = Math.min(hi, Math.max(lo, Math.round(percent)));
  if (next === view.focus.transparency) return view;
  return withFocus(view, { marks: view.focus.marks, transparency: next });
}

function sameMarks(
  a: ReadonlyMap<NodeId, FocusMark>,
  b: ReadonlyMap<NodeId, FocusMark>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [id, mark] of a) {
    if (b.get(id) !== mark) return false;
  }
  return true;
}

function setExpanded(view: ViewState, id: OutlineNodeId, on: boolean): ViewState {
  if (view.expanded.has(id) === on) return view;
  const next = new Set<OutlineNodeId>(view.expanded);
  if (on) next.add(id);
  else next.delete(id);
  return withExpanded(view, next);
}

/**
 * Dragging a container is a DOMAIN command, not a renderer behaviour (§7):
 * it translates the container and its entire subtree by the delta, and marks the
 * container pinned. Descendant absolute positions are rewritten, so an export is
 * trivially correct and a re-import reproduces the arrangement exactly.
 */
function moveNode(
  ctx: CommandContext,
  view: ViewState,
  id: OutlineNodeId,
  target: Point,
): ViewState {
  const current = ctx.geometry.position.get(id);
  const dx = current === undefined ? 0 : target.x - current.x;
  const dy = current === undefined ? 0 : target.y - current.y;

  const positions = new Map<NodeId, Position>(view.positions);

  for (const d of outlineDescendantsOf(ctx.outline, id)) {
    const entity = ctx.outline.entityOf(d);
    const stored = view.positions.get(entity);
    if (stored !== undefined) {
      const moved: Position = { x: stored.x + dx, y: stored.y + dy };
      if (stored.pinned === true) moved.pinned = true;
      positions.set(entity, moved);
      continue;
    }
    const drawn = ctx.geometry.position.get(d);
    if (drawn !== undefined) {
      // Unpinned: auto-layout would re-derive exactly this, but persisting it
      // keeps the exported document self-describing.
      positions.set(entity, { x: drawn.x + dx, y: drawn.y + dy });
    }
  }

  positions.set(ctx.outline.entityOf(id), { x: target.x, y: target.y, pinned: true });
  return withPositions(view, positions);
}

/**
 * Fit a container to its contents (Issue #13, ADR-0005). Preserves the children's
 * arrangement: it freezes them where they are and marks the container `fitted`, so the
 * size derivation hugs their bounding box down to the legibility floor.
 *
 * Guarded on `childrenShown` (not `expanded`): an expanded-but-ancestor-collapsed
 * container has no visible children, so its bbox would be empty → NaN. That guard, plus
 * the finite check on the centre, makes it impossible to write an I11-invalid position.
 */
function fitContainer(ctx: CommandContext, view: ViewState, id: OutlineNodeId): ViewState {
  if (!ctx.geometry.visibility.childrenShown.has(id)) return view;

  const positions = new Map<NodeId, Position>(view.positions);
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  let frozen = 0;

  // 1. Freeze: pin every visible child at its current drawn centre; nothing moves on
  //    screen. Accumulate the children's bounding box.
  for (const c of ctx.outline.childrenOf(id)) {
    const box = ctx.geometry.box.get(c);
    if (box === undefined) continue;
    positions.set(ctx.outline.entityOf(c), {
      x: box.x + box.w / 2,
      y: box.y + box.h / 2,
      pinned: true,
    });
    left = Math.min(left, box.x);
    right = Math.max(right, box.x + box.w);
    top = Math.min(top, box.y);
    bottom = Math.max(bottom, box.y + box.h);
    frozen += 1;
  }
  if (frozen === 0) return view;

  // 2. Recentre the container on the children's bbox. The `-CONTAINER_HEADER` offset in
  //    Cy absorbs the header, so the symmetric grow + legibility floor hug tightly.
  //    Defense in depth (I11): never write a non-finite centre.
  const cx = (left + right) / 2;
  const cy = (top + bottom - CONTAINER_HEADER) / 2;
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return view;
  positions.set(ctx.outline.entityOf(id), { x: cx, y: cy, pinned: true });

  // 3. Mark the container fitted — drives the legibility-floor size derivation.
  const fitted = new Set<OutlineNodeId>(view.fitted);
  fitted.add(id);

  return withFitted(withPositions(view, positions), fitted);
}

export function allOutlineNodes(outline: Outline): OutlineNodeId[] {
  const out: OutlineNodeId[] = [];
  const stack: OutlineNodeId[] = [...outline.roots()].reverse();
  while (stack.length > 0) {
    const n = stack.pop() as OutlineNodeId;
    out.push(n);
    const children = outline.childrenOf(n);
    for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i] as OutlineNodeId);
  }
  return out;
}

/** Strict ancestors of `n`, root-first. Built by a walk, because the Outline port
 *  deliberately exposes only downward links. */
export function outlineAncestorsOf(outline: Outline, n: OutlineNodeId): OutlineNodeId[] {
  const parentOf = buildOutlineParents(outline);
  const chain: OutlineNodeId[] = [];
  let current = parentOf.get(n) ?? null;
  while (current !== null && current !== undefined) {
    chain.push(current);
    current = parentOf.get(current) ?? null;
  }
  chain.reverse();
  return chain;
}

/** `n` and every descendant, canonical pre-order. */
export function outlineDescendantsOf(outline: Outline, n: OutlineNodeId): OutlineNodeId[] {
  const out: OutlineNodeId[] = [];
  const stack: OutlineNodeId[] = [n];
  while (stack.length > 0) {
    const current = stack.pop() as OutlineNodeId;
    out.push(current);
    const children = outline.childrenOf(current);
    for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i] as OutlineNodeId);
  }
  return out;
}

export function buildOutlineParents(outline: Outline): Map<OutlineNodeId, OutlineNodeId | null> {
  const parentOf = new Map<OutlineNodeId, OutlineNodeId | null>();
  const stack: OutlineNodeId[] = [];
  for (const r of outline.roots()) {
    parentOf.set(r, null);
    stack.push(r);
  }
  while (stack.length > 0) {
    const n = stack.pop() as OutlineNodeId;
    for (const c of outline.childrenOf(n)) {
      parentOf.set(c, n);
      stack.push(c);
    }
  }
  return parentOf;
}

/**
 * The initial view (§9.3): the repository, its applications, its packages and its
 * crates — not 637 overlapping files. A document that carries its own `view` keeps it,
 * including one whose expansion is deliberately EMPTY (§16.9).
 */
export function initialExpanded(outline: Outline): Set<OutlineNodeId> {
  return new Set<OutlineNodeId>(outline.roots());
}
