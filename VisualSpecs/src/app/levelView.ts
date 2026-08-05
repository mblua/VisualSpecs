// Levels mode: application policy, not document state (Issue #44).
//
// It lives in `AppState` and NOT in `ViewState`, next to `search` and `filters`. A way of
// looking is not human work: putting it in `ViewState` would drag format, `validate`,
// export and autosave behind it, and would make the same document export differently
// depending on which mode you happened to be in.
//
// THE BASIS IS GEOMETRY, NOT COLOUR. `observed` and `proposed` are two arrangements of
// the same document — `src-tauri/src` has 2 bands under one and 10 under the other — so
// the toggle re-ranks and the boxes move. That is why the memo key carries the basis: with
// a key that did not, the toggle returns the previous ranking, nothing moves, and it reads
// as "the button is broken".

import type { EdgeKind } from '../contract/types.ts';
import type { GraphModel } from '../contract/model.ts';
import type { Outline, OutlineNodeId } from '../domain/outline.ts';
import type { LayoutConstraints } from '../domain/layoutEngine.ts';
import type { PackConstraints } from '../domain/layout/port.ts';
import { rank, type RankBasis, type RankResult } from '../projection/levels.ts';

export type { RankBasis };

export interface LevelsMode {
  readonly active: boolean;
  readonly basis: RankBasis;
}

export const LEVELS_OFF: LevelsMode = { active: false, basis: 'observed' };

/**
 * The cost of Levels mode, measured on the committed corpus (`fe3ae85`, 817 nodes) and
 * DECLARED rather than estimated, because the honest answer here was "accept it and say
 * what it is".
 *
 * ```
 * rank() one container (the working case)                0.76 ms
 * rank() all 107 containers, observed                   33.6  ms   ← expand-all only
 * rank() all 107, both bases (warm-up, rejected)        81.9  ms
 * ranking again with the cache warm                      0.02 ms
 * ```
 *
 * Ranking is lazy — only containers whose children are on screen — so the 33.6 ms is the
 * expand-all case and not the working one: with a single container open it is 0.76 ms,
 * inside the +2 ms budget on `derive()`. Switching basis with everything expanded pays it
 * again for the new basis, once, and the memo makes every later switch free.
 *
 * That cost is inherent: the basis IS the geometry, so changing it re-ranks everything
 * visible. Two ways out were rejected — warming the other basis, which doubles the cost of
 * the much more common expand; and ranking only what is in the viewport, which would make
 * `derive()` depend on the camera and break "same document → same scene".
 */
export const LEVELS_COST = {
  oneContainerMs: 0.76,
  allExpandedMs: 33.6,
  warmCacheMs: 0.02,
  corpus: 'fe3ae85',
} as const;

export type Rankings = ReadonlyMap<OutlineNodeId, RankResult>;
export const NO_RANKINGS: Rankings = new Map<OutlineNodeId, RankResult>();

/**
 * The relation kinds a level is computed over.
 *
 * DECLARED, always, and independent of the scene's filters: §6.5 makes filters a
 * post-projection mask, so `hideTests` does not recompute the rank. That a test imports
 * its subject is a true fact of the graph, and re-ranking without it would be
 * re-projecting. Looking at a filtered scene while ranking over the whole graph is
 * legitimate — the two sets are declared, not tied together.
 */
export const DEPENDENCY_KINDS: ReadonlySet<EdgeKind> = new Set<EdgeKind>([
  'imports',
  'rust-imports',
  'tauri-command',
  'web-command',
]);

/**
 * Memoized ranking, keyed by `(container, kinds, basis)`.
 *
 * NOT by `expanded`: `rank()` lifts each endpoint to the direct child of the container,
 * so the result is invariant under expansion by construction.
 *
 * The basis IS in the key, and that is not bookkeeping: the basis decides geometry, so a
 * key without it returns the previous ranking on toggle, nothing moves, and the failure
 * presents as "the button does nothing" — the worst place to start looking.
 *
 * Nested maps, never a composite string key (§6.3): an outline id is opaque text from an
 * untrusted document and can contain any delimiter.
 */
export class RankCache {
  private model: GraphModel | null = null;
  private kinds: ReadonlySet<EdgeKind> | null = null;
  private readonly byBasis = new Map<RankBasis, Map<OutlineNodeId, RankResult>>();

  get(
    model: GraphModel,
    outline: Outline,
    container: OutlineNodeId,
    kinds: ReadonlySet<EdgeKind>,
    basis: RankBasis,
  ): RankResult {
    // A new document, or a different kind set, invalidates everything. Identity is
    // enough: `GraphModel` is never mutated in place (I8).
    if (this.model !== model || this.kinds !== kinds) {
      this.model = model;
      this.kinds = kinds;
      this.byBasis.clear();
    }
    let forBasis = this.byBasis.get(basis);
    if (forBasis === undefined) {
      forBasis = new Map<OutlineNodeId, RankResult>();
      this.byBasis.set(basis, forBasis);
    }
    const hit = forBasis.get(container);
    if (hit !== undefined) return hit;

    const computed = rank(model, outline, container, kinds, basis);
    forBasis.set(container, computed);
    return computed;
  }
}

/**
 * Rank every container whose children are on screen, and NOTHING else.
 *
 * Lazy on purpose: a collapsed container is not stratified, so ranking it is work nobody
 * looks at. Ranking all 107 costs 21.9 ms — fine once per load, but the basis toggle
 * invalidates every entry and that lands inside an interaction. On the opening view this
 * is a single container.
 *
 * `rank()` does not take `expanded`: each endpoint is lifted to the direct child of the
 * container, so the rank is invariant under expansion BY CONSTRUCTION — which is also why
 * expanding a sibling can no longer make a box jump bands.
 */
export function rankVisibleContainers(
  model: GraphModel,
  outline: Outline,
  childrenShown: ReadonlySet<OutlineNodeId>,
  kinds: ReadonlySet<EdgeKind>,
  basis: RankBasis,
  cache: RankCache,
): Rankings {
  const out = new Map<OutlineNodeId, RankResult>();
  for (const container of childrenShown) {
    out.set(container, cache.get(model, outline, container, kinds, basis));
  }
  return out;
  // NO WARM-UP OF THE OTHER BASIS — tried, measured, removed.
  //
  // Ranking the opposite basis here so the toggle would be free costs 81.9 ms instead of
  // 33.6 ms for all 107 containers, because `proposed` is the more expensive of the two.
  // That does not remove the jank: it moves it onto EXPANDING, which is a far more common
  // interaction than switching basis, and doubles it on the way. A mitigation that makes
  // the common case worse to protect the rare one is not a mitigation.
  //
  // What is left is declared rather than hidden — see `LEVELS_COST` below.
}

/**
 * The numbers the layout port is allowed to see: a rank, a ceiling and a grouping.
 * No relation crosses this line — `domain/` cannot import `projection/`, and the pack
 * holding the edges would mean Tarjan living in a second place.
 *
 * The group is the OBSERVED grouping and carries no basis: the edges are drawn either
 * way and have to be kept from crossing the band. The predicate changes what is
 * ASSERTED, never where a box is drawn.
 */
export function packConstraintsFrom(rankings: Rankings): LayoutConstraints {
  const out = new Map<OutlineNodeId, PackConstraints>();
  for (const [container, result] of rankings) {
    const rankMap = new Map<string, number>();
    for (const [id, value] of result.level) rankMap.set(id, value);

    const group = new Map<string, string>();
    for (const [id, index] of result.sccOf) {
      const scc = result.sccs[index];
      if (scc !== undefined && scc.members.length > 1) group.set(id, String(index));
    }

    out.set(container, {
      rank: rankMap,
      maxRank: result.maxRank,
      group: group.size > 0 ? group : undefined,
    });
  }
  return out;
}

/** The SCC a child belongs to, when it has more than one member. */
function groupOf(result: RankResult, child: OutlineNodeId): RankResult['sccs'][number] | null {
  const index = result.sccOf.get(child);
  if (index === undefined) return null;
  const scc = result.sccs[index];
  if (scc === undefined || scc.members.length < 2) return null;
  return scc;
}

/**
 * The badge, which is THE AUTHORITY on a box's rank: the band is a perceptual aid, and a
 * box the user dragged out of its lane still states its true rank here. It is present
 * always in Levels mode, not only when the box is out of lane — a badge that appears only
 * when the band lies is a badge nobody has learned to read by the time it matters.
 *
 * Three characters is the budget: a minimum leaf is 96 px wide and the badge is drawn at
 * 11 px with 12 px of padding, so `L1→L7` (~57 px) would leave under 40 px for the file
 * name. The before/after pair lives in the detail panel, which has the width for it.
 *
 *  - `L1`   — clean
 *  - `L1⇄`  — in a group that SURVIVES over resolved relations alone
 *  - `L1⇢`  — in a group that does not survive: "unverified", never "false". The test
 *             marks ABSENCE OF VERIFICATION, not falsehood.
 *  - `L7*`  — proposed: the number is exact GIVEN THE CUT; what is heuristic is the cut.
 *             Hence `*` ("there is a condition at the foot") and not `~` ("approximate").
 *  - absent — not in `ranked`, i.e. `ce + ca === 0`: nothing was measured about this
 *             child. Positioning is not asserting; the layout still gives it band 0.
 */
export function rankBadge(result: RankResult, child: OutlineNodeId): string | undefined {
  if (!result.ranked.has(child)) return undefined;
  const level = result.level.get(child);
  if (level === undefined) return undefined;

  let badge = `L${String(level)}`;
  if (result.basis === 'proposed') badge += '*';

  const scc = groupOf(result, child);
  if (scc !== null) badge += scc.survivingMembers.length >= 2 ? '⇄' : '⇢';
  return badge;
}

/**
 * The glyph beside the badge, for what the badge cannot say (H5).
 *
 * `pkg:cargo:src-tauri/Cargo.toml` carries a rank, is in no group, and hides 94 entangled
 * files: with the default view it would look exactly like a container that is genuinely
 * clean. `hidesInternal` is the difference between "1, verified" and "1 at this level of
 * aggregation", and this is the channel for it.
 *
 * `marker` is a free string the port draws without interpreting, so it COMPOSES: the
 * focus feature's mixed-subtree glyph and this one no longer compete for the field, and
 * there is no precedence rule to get wrong.
 */
export const HIDES_INTERNAL_MARKER = '⇄';

export function levelMarker(result: RankResult, child: OutlineNodeId): string | undefined {
  return result.hidesInternal.has(child) ? HIDES_INTERNAL_MARKER : undefined;
}

/**
 * What the container's header states about its own ranking.
 *
 * The word *cycle* does not appear. At container granularity "these siblings need each
 * other" is true and useful; "there is a cycle" is a claim about FILES that cannot be made
 * from this level of aggregation — `src/shared` shows `stores ⇄ testing` from four
 * distinct files and two edges with no cycle at all.
 *
 * The SCOPE is declared because the rank is LOCAL: in the repository root 1751 of 1947
 * relations are internal to a single unit, so a reader who takes `L0` for "base of the
 * system" is reading something we told them.
 *
 * Under `observed` it does NOT report cut relations: `cutEstimate` is empty there by
 * invariant, and "0 relations cut" would read as good news when the truth is that none
 * was evaluated.
 */
export function containerLevelSummary(result: RankResult, outline: Outline): string {
  const children = outline.childrenOf(result.container);
  const entangled = children.filter((c) => groupOf(result, c) !== null).length;

  const parts = [
    `levels 0–${String(result.maxRank)}`,
    result.basis,
    `measured among the ${String(children.length)} direct children`,
  ];
  if (entangled > 0) parts.splice(2, 0, `${String(entangled)} need each other`);
  if (result.basis === 'proposed' && result.cutEstimate.length > 0) {
    parts.splice(2, 0, `a possible cut of ${String(result.cutEstimate.length)} of ${String(result.edges.length)}`);
  }
  return parts.join(' · ');
}

/** What the detail panel says about one group. States what survives, and states that the
 *  test marks absence of verification rather than falsehood. */
export function groupSummary(result: RankResult, child: OutlineNodeId): string | null {
  const scc = groupOf(result, child);
  if (scc === null) return null;
  const surviving = scc.survivingMembers.length;
  return (
    `${String(scc.members.length)} need each other; ` +
    `${String(surviving)} survive using only resolved relations`
  );
}
