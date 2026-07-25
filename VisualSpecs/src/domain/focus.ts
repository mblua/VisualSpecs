// Focus resolution (Issue #17, §4.2 / §4.4). Pure, and it never touches projection.
//
// Focus is an INHERITABLE TRI-STATE per node — explicit out-of-focus, explicit
// in-focus (overriding an out-of-focus ancestor), or unmarked (inherit). It is not a
// flat set of dimmed ids, because a flat set cannot express the one gesture the
// feature exists for: dim a container, bring one entity inside it back, and have the
// container STAY dim.
//
// Nothing here participates in projection (I-F1). `project()` takes the expansion set,
// not the view, so NVA, the partition law, the visible-edge buckets, the internal
// buckets and all four counts are physically unable to see a focus mark.

import type { NodeId } from '../contract/types.ts';
import type { FocusMark, FocusState } from '../contract/view.ts';
import type { Outline, OutlineNodeId } from './outline.ts';

/** The RESOLVED state of a node: what it renders as, mark or no mark. */
export type EffectiveFocus = 'in' | 'out';

export interface ResolvedFocus {
  /** Every outline node, resolved. Total by construction — see `resolveFocus`. */
  readonly effective: ReadonlyMap<OutlineNodeId, EffectiveFocus>;
  /**
   * Representatives whose HIDDEN SUBTREE contains an entity whose effective state
   * DIFFERS from the representative's own (§4.4).
   *
   * "Differs from mine", not "contains an out-of-focus entity". The latter is one bit
   * for a three-valued question and the value it cannot express is the override:
   * under a dimmed box it is ALWAYS true, so it carries no information exactly where
   * the tri-state model needs it. With "differs", a dimmed box with a re-lit
   * descendant and a dimmed box with nothing re-lit are distinguishable — which is
   * the whole point.
   */
  readonly subtreeDiffers: ReadonlySet<OutlineNodeId>;
}

/**
 * One pre-order walk from `outline.roots()`, carrying the inherited value down. O(V).
 *
 * TOTAL AND DETERMINISTIC BY CONSTRUCTION, not by hope: `checkIntegrity` guarantees
 * every `parentId` resolves (I2) and the ownership tree is acyclic (I3), so every
 * node's ancestor chain terminates at a root; and `assertInjective` rejects any
 * placement that is not reachable from the roots (I10). There is therefore no model
 * node that is unplaced or unreachable, and the nearest MARKED ancestor is unique
 * because the outline is a tree. Under a future multi-placement outline it would not
 * be — see `MULTI_PLACEMENT_NOTE`.
 */
export function resolveFocus(outline: Outline, marks: ReadonlyMap<NodeId, FocusMark>): Map<OutlineNodeId, EffectiveFocus> {
  const effective = new Map<OutlineNodeId, EffectiveFocus>();

  interface Frame {
    n: OutlineNodeId;
    inherited: EffectiveFocus;
  }

  const roots = outline.roots();
  const stack: Frame[] = [];
  for (let i = roots.length - 1; i >= 0; i -= 1) {
    stack.push({ n: roots[i] as OutlineNodeId, inherited: 'in' });
  }

  while (stack.length > 0) {
    const { n, inherited } = stack.pop() as Frame;
    const own = marks.get(outline.entityOf(n));
    const state: EffectiveFocus = own === undefined ? inherited : own === 'out-of-focus' ? 'out' : 'in';
    effective.set(n, state);

    const children = outline.childrenOf(n);
    for (let i = children.length - 1; i >= 0; i -= 1) {
      stack.push({ n: children[i] as OutlineNodeId, inherited: state });
    }
  }

  return effective;
}

/**
 * The effective state a node WOULD inherit if it carried no mark of its own — the
 * input to the minimal-mark write rule (§4.5). Walks the resolved map rather than the
 * outline, so it costs one lookup per ancestor of `id` and no second walk.
 *
 * `parentOf` is supplied by the caller because building it is O(V) and the command
 * layer already needs it for other things.
 */
export function inheritedFocus(
  effective: ReadonlyMap<OutlineNodeId, EffectiveFocus>,
  parentOf: ReadonlyMap<OutlineNodeId, OutlineNodeId | null>,
  id: OutlineNodeId,
): EffectiveFocus {
  const parent = parentOf.get(id) ?? null;
  if (parent === null) return 'in';
  return effective.get(parent) ?? 'in';
}

/**
 * §4.4's per-representative flag, over the NVA-DEFINED hidden subtree.
 *
 * "Hidden subtree" is *the entities whose NVA is this representative, excluding
 * itself* — NOT a walk of `childrenOf`. The two sets diverge as soon as a mid-tree
 * container is expanded while its parent is not, and using the wrong one is exactly
 * the kind of thing that ships looking correct.
 *
 * `nva` comes from `computeVisibility`, which projection and geometry already share,
 * so this is a single pass over a map that has already been built.
 */
export function computeSubtreeDiffers(
  nva: ReadonlyMap<OutlineNodeId, OutlineNodeId>,
  effective: ReadonlyMap<OutlineNodeId, EffectiveFocus>,
): Set<OutlineNodeId> {
  const differs = new Set<OutlineNodeId>();
  for (const [node, representative] of nva) {
    if (node === representative) continue; // visible in its own right, not hidden under anything
    if (differs.has(representative)) continue;
    const mine = effective.get(representative);
    const theirs = effective.get(node);
    if (mine !== undefined && theirs !== undefined && mine !== theirs) differs.add(representative);
  }
  return differs;
}

export function resolve(
  outline: Outline,
  nva: ReadonlyMap<OutlineNodeId, OutlineNodeId>,
  focus: FocusState,
): ResolvedFocus {
  const effective = resolveFocus(outline, focus.marks);
  return { effective, subtreeDiffers: computeSubtreeDiffers(nva, effective) };
}

/**
 * The opacity an out-of-focus element renders at. `1` means full strength.
 *
 * Stated here rather than left to the renderer because it is a SEMANTIC composition,
 * not a rendering detail: without a written rule, two conforming implementations
 * render opposite results — at `transparency = 10` focus alpha is 0.90 while search
 * alpha is 0.22, so a focus-wins reading would make ENABLING focus brighten a node
 * the search had dimmed.
 */
export function focusOpacity(transparency: number): number {
  return 1 - transparency / 100;
}

/**
 * An aggregated edge's focus opacity, as a FRACTION of what it stands for (§4.3).
 *
 * `brightRelations` counts the logical relations behind the line that have no
 * effectively-out endpoint; `totalRelations` is `sourceEdgeIds.length` restricted to
 * relations this build could resolve.
 *
 * One bit is wrong in BOTH directions, and both were measured. Asking the aggregate's
 * visible endpoints HID a relation the user had explicitly re-lit. Asking "every
 * relation out" did the opposite: on the committed corpus the largest drawn aggregate
 * carries 136 logical relations across 21 target entities, so bringing ONE entity back
 * into focus returned the whole ×136 line to full strength while 122 of its relations
 * were still switched off — behind a width that encodes 136.
 *
 * Exact at ×1: `bright/total ∈ {0, 1}` yields `dim` or `1`, so the boolean rule is a
 * special case and the ×1 evidence for "either endpoint" over "both" is untouched.
 * Monotone in the switched-off fraction, so it composes under `min` with search.
 *
 * VACUOUS TRUTH GUARD: `total === 0` returns `1`. `[].every(...)` is `true`, so a
 * carrier with no resolvable logical relations would otherwise dim with no marks
 * present at all and break I-F4 at the scene level. `scene.ts` already guards the
 * identical case for its dash rule (`logical.length > 0 && logical.every(...)`),
 * because whoever wrote it did not trust the empty case either.
 */
export function aggregateFocusOpacity(
  transparency: number,
  brightRelations: number,
  totalRelations: number,
  mixedFloor: number = MIXED_FRACTION_FLOOR,
): number {
  if (totalRelations <= 0) return 1;
  const dim = focusOpacity(transparency);
  const available = 1 - dim;
  const fraction = brightRelations / totalRelations;
  if (fraction <= 0) return dim;
  // A NON-ZERO bright fraction must be PERCEPTIBLY distinct from a zero one, not merely
  // numerically distinct. The plain continuous form satisfies monotonicity, exactness at
  // ×1 and composition under `min`, and still loses the override at the fine end:
  // measured at the default transparency on the corpus's ×136 aggregate, 1/136 bright
  // moves the line by Δcontrast 0.007 — one 8-bit step in one channel, while 14/136
  // moves it by 0.246 and is visible. The same argument that rejects transparency 95 as
  // "perceptually gone", applied to a difference rather than a value.
  return Math.min(1, Math.max(dim + available * fraction, dim + available * mixedFloor));
}

/**
 * The minimum lift, as a fraction of the available opacity range, that any non-zero
 * bright fraction receives.
 *
 * 0.10 of the range is 0.07 in opacity at the default transparency, which is the
 * neighbourhood of the empirically-visible 14/136 step (0.072). It is a RENDERING
 * calibration and belongs to the graph/runtime owner: core states the property, the
 * owner measures the constant against the contrast metric and pins it with a
 * conformance case — the same division that produced `RING_FLOOR`, where the number
 * core would have guessed was measurably wrong.
 */
export const MIXED_FRACTION_FLOOR = 0.1;

// THE FLOOR IS ONE-SIDED, AND THAT IS THE DESIGN.
//
// It guarantees that "some relations lit" is perceptibly distinct from "none lit". There
// is deliberately NO matching floor in the other direction: 135 of 136 relations bright
// renders at 0.9948 against 1.0, so switching ONE relation off is invisible.
//
// An override is a deliberate, rare act — a person reached into a dimmed subtree and
// named one exception — and it must be visible, or the tri-state model has no observable
// value. Switching one relation of 136 off is part of a sweep and should read as small,
// because it is.
//
// Written down because the next reader will otherwise see a one-sided floor and "fix" it.
