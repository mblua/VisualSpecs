// rank(model, outline, container, kinds, basis) → RankResult. Pure. Never mutates.
//
// Layering answers ONE question: inside this container, what sits underneath what?
// Everything below exists because the obvious way to answer it is wrong in a way
// that only shows up on a real corpus. The four that cost the most:
//
//  1. THE INPUT IS NOT THE VISIBLE GRAPH (§6.5). Ranking `VisibleGraph` makes the
//     number move when the user expands something. Expanding `config` drops
//     `src-tauri/src` from 102 edges to 86 and `config` itself falls from rank 1 to
//     rank 0 — "base layer, depends on nobody" — precisely when the user opens it to
//     look inside. Nothing in the code changed. So this takes `(model, outline,
//     container, kinds)` and lifts each endpoint to the container's DIRECT CHILD.
//     `expanded` is not a parameter, which makes invariance under expansion hold BY
//     CONSTRUCTION rather than by a property test.
//
//  2. THE CUT IS NOT THE CLAIM. A minimum feedback arc set is not unique, and with a
//     fixed tie-break, renaming one file reassigns 18 of 23 boxes. `cutEstimate` is a
//     SIZE ESTIMATE — "held together by at least N" — never a list of things to fix.
//     What is canonical is the SCC: its membership, its internal edges, and the
//     references behind them, all invariant under rename.
//
//  3. "MUTUALLY NEEDED", NEVER "CYCLE". At container granularity, `stores ⇄ testing`
//     is true — each contains something the other needs — while "there is a cycle" is
//     a claim about FILES that this aggregation cannot make. `src/shared` shows that
//     pair from four distinct files and two edges with no cycle at all (16 such pairs
//     in the corpus), and a real 98-file SCC inside `src-tauri/src` shows as 11 boxes
//     at rank 0. The vocabulary has to survive both directions of that.
//
//  4. EVERY NUMBER CARRIES ITS PREMISE. SCC membership is monotone in the edge set OF
//     THE GRAPH IT RECEIVES; that this bounds the code below requires the observed
//     relations to be a subset of the real ones, which is extractor correctness, not
//     a theorem. `commands` once published sccSize 6 when the truth was 1 — the
//     entanglement did not exist. So the result declares `basis` and `kinds`, and
//     `LOWER_BOUND_PREMISE` is the sentence any surface quoting these numbers must
//     carry.

import type { Confidence, EdgeId, EdgeKind, NodeId } from '../contract/types.ts';
import type { GraphModel } from '../contract/model.ts';
import type { Outline, OutlineNodeId } from '../domain/outline.ts';

export type RankBasis = 'observed' | 'proposed';

/**
 * The premise, published with the claim and never without it. Both halves: the
 * reassuring one is only true alongside the other, and the other one has happened.
 */
export const LOWER_BOUND_PREMISE =
  'Lower bound over the OBSERVED relations. A missing relation can hide an entanglement; ' +
  'a spurious one invents it, and that has happened.';

/**
 * A ranked edge is identified by its STRUCTURED TUPLE, resolved against the graph —
 * never by a `VisibleEdgeId`. `v${i}` is a position, not an identity: after one
 * re-extraction, 76 of 107 surviving ids pointed at a different relation. These
 * tuples are what gets exported, so they have to mean the same thing tomorrow.
 */
export interface RankedEdge {
  readonly kind: EdgeKind;
  readonly sourceId: OutlineNodeId;
  readonly targetId: OutlineNodeId;
  /** Logical relations behind this one arc. */
  readonly count: number;
  /** §4.3's rule, and §4.3's rule ONLY. See `aggregateConfidence`. */
  readonly confidence: Confidence;
  /** How many of `count` an identifier was provably resolved to. Feeds the survival test. */
  readonly resolvedCount: number;
  readonly sourceEdgeIds: readonly EdgeId[];
}

/**
 * A set of children that need each other. The canonical, exportable claim.
 *
 * Not called a cycle anywhere the user can read, and not identified by an index the
 * next extraction would reshuffle: `members` IS the identity.
 */
export interface Scc {
  /** Sorted. Field-by-field comparison of this tuple is what canonicalises SCC order. */
  readonly members: readonly OutlineNodeId[];
  /** The arcs that hold it together, in canonical order. */
  readonly internalEdges: readonly RankedEdge[];
  /**
   * The members still mutually needed when EVERY relation an identifier was not
   * provably resolved to is dropped — one pass of Tarjan over the resolved subgraph.
   * Empty, or two or more; never one.
   *
   * This is the predicate, and it replaced two earlier candidates that were both worse:
   *
   *  - a PROPORTION ("held together by 95.6% heuristics") invites the reader to
   *    discount the claim by 95.6%, which is not what it means;
   *  - MINIMUM CONFIDENCE ("marked if any supporting edge is heuristic") marks an
   *    entanglement that is perfectly real without its one heuristic arc.
   *
   * On this corpus minimum and survival happen to mark the same 14, which is a fact
   * about the corpus and not an equivalence — so the one that answers the reader's
   * actual question is the one that ships. It also gives the panel a sentence that
   * says something: "14 need each other; N survive using only resolved relations."
   */
  readonly survivingMembers: readonly OutlineNodeId[];
}

export interface RankResult {
  readonly container: OutlineNodeId;
  /** Declared, always. A levelization figure without its basis is not reproducible. */
  readonly basis: RankBasis;
  /** Declared, always, in canonical order. Same reason. */
  readonly kinds: readonly EdgeKind[];

  /** Rank of every direct child, including the ones nothing was measured on. */
  readonly level: ReadonlyMap<OutlineNodeId, number>;
  readonly maxRank: number;

  /**
   * The children a rank badge may be shown for: those taking part in at least one
   * edge among siblings (`ce + ca > 0`).
   *
   * POSITIONING IS NOT ASSERTING. Layout needs a position for every box and band 0
   * gives it one; what changes is what the badge claims. `L0` on a child nothing was
   * measured on would assert "it is the base" — the same defect as `unranked` reading
   * as `forward`, which this design already corrected twice.
   */
  readonly ranked: ReadonlySet<OutlineNodeId>;

  /** Index into `sccs`, for children inside one. Absent means a component of one. */
  readonly sccOf: ReadonlyMap<OutlineNodeId, number>;
  readonly sccs: readonly Scc[];

  /**
   * Children that HIDE relations this aggregation level cannot speak about: at least
   * one relation of the requested kinds runs entirely inside their own subtree.
   *
   * This is the difference between "1, verified" and "1 at this level of aggregation",
   * and without it the default view draws `pkg:cargo:src-tauri/Cargo.toml` — which
   * hides 94 entangled files — identically to a container that is genuinely clean.
   */
  readonly hidesInternal: ReadonlySet<OutlineNodeId>;

  /**
   * Ce/(Ca+Ce) over unique edges, `null` where `Ca = Ce = 0`.
   *
   * NOT Martin's instability, and deliberately not named after it: this is computed
   * ONLY among siblings of the same parent, so a module with 0 internal and 40
   * external dependencies comes out undefined and looking isolated. Borrowing the name
   * would ask the reader for an intuition the number does not honor. Show it with its
   * denominator beside it.
   *
   * `null`, never `NaN`: I11 rejects non-finites in the document and the renderer port
   * rejects scenes containing them, so a derived metric emitting one would be the same
   * defect through the back door.
   */
  readonly siblingInstability: ReadonlyMap<OutlineNodeId, number | null>;

  /** Every arc among direct children, canonical order. */
  readonly edges: readonly RankedEdge[];

  /**
   * A POSSIBLE cut of this size — not the relations to cut. Empty under `observed`.
   *
   * Read it as "this is held together by at least N of M". Which relations actually
   * matter is a decision for a person; a feedback arc set only says what comes out
   * cheap, and which arcs it picks moves when a file is renamed.
   */
  readonly cutEstimate: readonly RankedEdge[];
}

// ---------------------------------------------------------------------------
// Confidence composition depends on WHAT KIND OF CLAIM is being held up.
//
// A COUNT — an aggregate ×N — degrades by conjunction: if any relation behind it is
// resolved, the line still rests on firm ground and the ×N is still true even though
// part of it is uncertain. That is §4.3, and `RankedEdge` is exactly that.
//
// An EXISTENCE CLAIM — an SCC, a cycle, a reachability — cannot use that rule: a
// single false edge creates it whole. Copying §4.3 to an SCC was a real defect, and
// the fix is not a stricter composition of the same kind but a different question
// altogether: does it survive on resolved relations alone? See `Scc.survivingMembers`.
// ---------------------------------------------------------------------------

const CONFIDENCE_ORDER: Record<Confidence, number> = {
  heuristic: 0,
  declared: 1,
  resolved: 2,
};

/** §4.3: an aggregate is only as unverified as its BEST relation. Counts, not claims. */
export function aggregateConfidence(values: readonly Confidence[]): Confidence {
  let best: Confidence = 'heuristic';
  for (const v of values) {
    if (CONFIDENCE_ORDER[v] > CONFIDENCE_ORDER[best]) best = v;
  }
  return best;
}

// ---------------------------------------------------------------------------

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Field-by-field over the member tuple. Never a concatenated string (§6.3).
 *
 * EXPORTED SO IT CAN BE TESTED DIRECTLY, and that is not incidental. The SCCs of a
 * graph are disjoint, so no two member tuples from a real corpus ever share a prefix
 * — which means a test that permutes the corpus and checks the numbering passes
 * identically against a comparator that only ever looks at field 0. The corpus cannot
 * reach the rest of this function, so the test has to.
 *
 * The prefix case is what makes the order TOTAL: when one tuple runs out, the shorter
 * one sorts first. Without that, sorting is not a total order and the "canonical"
 * numbering is only canonical for the inputs someone happened to try.
 */
export function compareMemberTuples(a: readonly string[], b: readonly string[]): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i += 1) {
    const d = cmp(a[i] as string, b[i] as string);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

function compareEdges(a: RankedEdge, b: RankedEdge): number {
  return cmp(a.kind, b.kind) || cmp(a.sourceId, b.sourceId) || cmp(a.targetId, b.targetId);
}

/**
 * For every descendant of `container`, which DIRECT child of `container` it lives in.
 * A direct child maps to itself.
 *
 * This is the lift that makes the rank independent of `expanded`: whether a node is
 * currently drawn or collapsed into its parent changes nothing here.
 */
function liftTable(
  outline: Outline,
  container: OutlineNodeId,
): ReadonlyMap<OutlineNodeId, OutlineNodeId> {
  const lift = new Map<OutlineNodeId, OutlineNodeId>();
  for (const child of outline.childrenOf(container)) {
    const stack: OutlineNodeId[] = [child];
    while (stack.length > 0) {
      const current = stack.pop() as OutlineNodeId;
      lift.set(current, child);
      for (const grandchild of outline.childrenOf(current)) stack.push(grandchild);
    }
  }
  return lift;
}

export function rank(
  model: GraphModel,
  outline: Outline,
  container: OutlineNodeId,
  kinds: ReadonlySet<EdgeKind>,
  basis: RankBasis = 'observed',
): RankResult {
  const children = outline.childrenOf(container);
  const lift = liftTable(outline, container);

  const placementOf = (entity: NodeId): OutlineNodeId | null => outline.placementOf(entity);

  // kind → source → target → logical edge ids. Nested Maps, never a composite string
  // key: `kind + '|' + s + '|' + t` is ambiguous and an imported document can collide
  // it on purpose (§6.3).
  const buckets = new Map<EdgeKind, Map<OutlineNodeId, Map<OutlineNodeId, EdgeId[]>>>();
  const hidesInternal = new Set<OutlineNodeId>();

  for (const edge of model.edges) {
    if (!kinds.has(edge.kind)) continue;

    const sourcePlacement = placementOf(edge.sourceId);
    const targetPlacement = placementOf(edge.targetId);
    if (sourcePlacement === null || targetPlacement === null) continue;

    const s = lift.get(sourcePlacement);
    const t = lift.get(targetPlacement);
    if (s === undefined || t === undefined) continue; // an endpoint outside this container

    if (s === t) {
      // Entirely inside one child. Not an arc of the ranked graph — and the reason
      // that child cannot be reported as "verified clean" at this level.
      hidesInternal.add(s);
      continue;
    }

    let bySource = buckets.get(edge.kind);
    if (bySource === undefined) {
      bySource = new Map<OutlineNodeId, Map<OutlineNodeId, EdgeId[]>>();
      buckets.set(edge.kind, bySource);
    }
    let byTarget = bySource.get(s);
    if (byTarget === undefined) {
      byTarget = new Map<OutlineNodeId, EdgeId[]>();
      bySource.set(s, byTarget);
    }
    const ids = byTarget.get(t);
    if (ids === undefined) byTarget.set(t, [edge.id]);
    else ids.push(edge.id);
  }

  // `model.edges` is in canonical id order, so every `sourceEdgeIds` is already
  // canonical; sorting the tuples is what makes the OUTPUT order canonical.
  const edges: RankedEdge[] = [];
  for (const [kind, bySource] of buckets) {
    for (const [sourceId, byTarget] of bySource) {
      for (const [targetId, ids] of byTarget) {
        const confidences = ids.map((id) => model.edgeById.get(id)?.confidence ?? 'heuristic');
        edges.push({
          kind,
          sourceId,
          targetId,
          count: ids.length,
          confidence: aggregateConfidence(confidences),
          resolvedCount: confidences.filter((c) => c === 'resolved').length,
          sourceEdgeIds: ids,
        });
      }
    }
  }
  edges.sort(compareEdges);

  // --- degree, over UNIQUE edges (102 in `src-tauri/src`, not the 333 references) ---

  const efferent = new Map<OutlineNodeId, number>();
  const afferent = new Map<OutlineNodeId, number>();
  for (const child of children) {
    efferent.set(child, 0);
    afferent.set(child, 0);
  }
  for (const e of edges) {
    efferent.set(e.sourceId, (efferent.get(e.sourceId) ?? 0) + 1);
    afferent.set(e.targetId, (afferent.get(e.targetId) ?? 0) + 1);
  }

  const ranked = new Set<OutlineNodeId>();
  const siblingInstability = new Map<OutlineNodeId, number | null>();
  for (const child of children) {
    const ce = efferent.get(child) ?? 0;
    const ca = afferent.get(child) ?? 0;
    if (ce + ca > 0) ranked.add(child);
    siblingInstability.set(child, ce + ca === 0 ? null : ce / (ce + ca));
  }

  // --- SCCs, and the survival test that calibrates them ---

  const components = tarjan(children, edges);

  // The survival test runs over the RESOLVED RELATIONS, not over aggregates whose
  // composed confidence happens to read `resolved`: an arc backed by one resolved and
  // forty heuristic relations still carries a verified dependency, and dropping it
  // would understate what survives.
  const resolvedComponents = tarjan(
    children,
    edges.filter((e) => e.resolvedCount > 0),
  );
  const resolvedComponentOf = new Map<OutlineNodeId, number>();
  resolvedComponents.forEach((members, index) => {
    for (const m of members) resolvedComponentOf.set(m, index);
  });

  // Canonical numbering: sort by the member tuple, field by field. An index derived
  // from traversal order would be reshuffled by a rename; this is not.
  const multiNode = components.filter((c) => c.length > 1).map((c) => [...c].sort(cmp));
  multiNode.sort(compareMemberTuples);

  const memberSet = new Set<OutlineNodeId>();
  const sccOf = new Map<OutlineNodeId, number>();
  multiNode.forEach((members, index) => {
    for (const m of members) {
      sccOf.set(m, index);
      memberSet.add(m);
    }
  });

  const sccs: Scc[] = multiNode.map((members) => {
    const inside = new Set(members);
    const internalEdges = edges.filter((e) => inside.has(e.sourceId) && inside.has(e.targetId));

    // Members still mutually needed on resolved relations alone. A member alone in its
    // resolved component is not "surviving": one node needs nobody.
    const byResolvedComponent = new Map<number, OutlineNodeId[]>();
    for (const m of members) {
      const c = resolvedComponentOf.get(m);
      if (c === undefined) continue;
      const group = byResolvedComponent.get(c);
      if (group === undefined) byResolvedComponent.set(c, [m]);
      else group.push(m);
    }
    const survivingMembers: OutlineNodeId[] = [];
    for (const group of byResolvedComponent.values()) {
      if (group.length >= 2) survivingMembers.push(...group);
    }
    survivingMembers.sort(cmp);

    return { members, internalEdges, survivingMembers };
  });

  // --- levels ---

  // Under `proposed`, drop a feedback arc set first so the remaining graph is acyclic
  // and every child gets a distinct rank. Under `observed`, the SCC is condensed and
  // its members SHARE a rank: the product does not assert an order it cannot point at.
  const cutEstimate = basis === 'proposed' ? feedbackArcSet(children, edges) : [];
  const cut = new Set(cutEstimate);
  const kept = basis === 'proposed' ? edges.filter((e) => !cut.has(e)) : edges;

  const level =
    basis === 'proposed'
      ? longestPath(children, kept, (n) => n)
      : levelsByCondensation(children, kept, components);

  let maxRank = 0;
  for (const value of level.values()) if (value > maxRank) maxRank = value;

  return {
    container,
    basis,
    kinds: [...kinds].sort(cmp),
    level,
    maxRank,
    ranked,
    sccOf,
    sccs,
    hidesInternal,
    siblingInstability,
    edges,
    cutEstimate,
  };
}

/** Size of the entanglement a child belongs to: 1 means "not in one AT THIS LEVEL". */
export function sccSizeOf(result: RankResult, child: OutlineNodeId): number {
  const index = result.sccOf.get(child);
  if (index === undefined) return 1;
  return result.sccs[index]?.members.length ?? 1;
}

// ---------------------------------------------------------------------------
// Tarjan. Iterative: `src-tauri/src` is shallow but a file-level graph is not, and a
// recursive version blows the stack on a corpus this shape.
// ---------------------------------------------------------------------------

function tarjan(
  nodes: readonly OutlineNodeId[],
  edges: readonly RankedEdge[],
): OutlineNodeId[][] {
  const successors = new Map<OutlineNodeId, OutlineNodeId[]>();
  for (const n of nodes) successors.set(n, []);
  for (const e of edges) successors.get(e.sourceId)?.push(e.targetId);

  const index = new Map<OutlineNodeId, number>();
  const low = new Map<OutlineNodeId, number>();
  const onStack = new Set<OutlineNodeId>();
  const stack: OutlineNodeId[] = [];
  const out: OutlineNodeId[][] = [];
  let counter = 0;

  for (const root of nodes) {
    if (index.has(root)) continue;

    // (node, next successor to visit)
    const work: { node: OutlineNodeId; i: number }[] = [{ node: root, i: 0 }];
    index.set(root, counter);
    low.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);

    while (work.length > 0) {
      const frame = work[work.length - 1] as { node: OutlineNodeId; i: number };
      const children = successors.get(frame.node) ?? [];

      if (frame.i < children.length) {
        const next = children[frame.i] as OutlineNodeId;
        frame.i += 1;
        if (!index.has(next)) {
          index.set(next, counter);
          low.set(next, counter);
          counter += 1;
          stack.push(next);
          onStack.add(next);
          work.push({ node: next, i: 0 });
        } else if (onStack.has(next)) {
          low.set(frame.node, Math.min(low.get(frame.node) ?? 0, index.get(next) ?? 0));
        }
        continue;
      }

      work.pop();
      const parent = work[work.length - 1];
      if (parent !== undefined) {
        low.set(parent.node, Math.min(low.get(parent.node) ?? 0, low.get(frame.node) ?? 0));
      }

      if (low.get(frame.node) === index.get(frame.node)) {
        const component: OutlineNodeId[] = [];
        for (;;) {
          const m = stack.pop() as OutlineNodeId;
          onStack.delete(m);
          component.push(m);
          if (m === frame.node) break;
        }
        out.push(component);
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------------

/**
 * Dependencies run from higher rank to lower, so information flows UP: a child that
 * depends on nothing among its siblings is rank 0, the base.
 */
function longestPath(
  nodes: readonly OutlineNodeId[],
  edges: readonly RankedEdge[],
  representativeOf: (n: OutlineNodeId) => OutlineNodeId,
): Map<OutlineNodeId, number> {
  const successors = new Map<OutlineNodeId, Set<OutlineNodeId>>();
  const indegree = new Map<OutlineNodeId, number>();
  const reps: OutlineNodeId[] = [];
  const seen = new Set<OutlineNodeId>();
  for (const n of nodes) {
    const r = representativeOf(n);
    if (seen.has(r)) continue;
    seen.add(r);
    reps.push(r);
    successors.set(r, new Set());
    indegree.set(r, 0);
  }

  for (const e of edges) {
    const s = representativeOf(e.sourceId);
    const t = representativeOf(e.targetId);
    if (s === t) continue;
    // A rank is decided by the EXISTENCE of a dependency, not by how many references
    // are behind it, so parallel arcs collapse here.
    const outgoing = successors.get(s);
    if (outgoing === undefined || outgoing.has(t)) continue;
    outgoing.add(t);
    indegree.set(t, (indegree.get(t) ?? 0) + 1);
  }

  // Kahn from the nodes nothing depends on, in canonical order so ties are stable.
  const order: OutlineNodeId[] = [];
  const queue = reps.filter((r) => (indegree.get(r) ?? 0) === 0).sort(cmp);
  const remaining = new Map(indegree);
  while (queue.length > 0) {
    const current = queue.shift() as OutlineNodeId;
    order.push(current);
    for (const next of [...(successors.get(current) ?? [])].sort(cmp)) {
      const left = (remaining.get(next) ?? 0) - 1;
      remaining.set(next, left);
      if (left === 0) queue.push(next);
    }
    queue.sort(cmp);
  }

  // `order` is a topological order of dependents before dependencies, so walking it
  // backwards settles every successor before its predecessor.
  const levelOfRep = new Map<OutlineNodeId, number>();
  for (const r of reps) levelOfRep.set(r, 0);
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const current = order[i] as OutlineNodeId;
    let best = 0;
    for (const next of successors.get(current) ?? []) {
      const candidate = (levelOfRep.get(next) ?? 0) + 1;
      if (candidate > best) best = candidate;
    }
    levelOfRep.set(current, best);
  }

  const out = new Map<OutlineNodeId, number>();
  for (const n of nodes) out.set(n, levelOfRep.get(representativeOf(n)) ?? 0);
  return out;
}

/**
 * Condensation, then longest path over it. Every member of an SCC shares its rank:
 * inside an entanglement there is no "underneath", and inventing one would be the map
 * asserting an order it cannot point at.
 */
function levelsByCondensation(
  nodes: readonly OutlineNodeId[],
  edges: readonly RankedEdge[],
  components: readonly (readonly OutlineNodeId[])[],
): Map<OutlineNodeId, number> {
  const representative = new Map<OutlineNodeId, OutlineNodeId>();
  for (const component of components) {
    // The smallest member names the component: stable under anything but a change of
    // membership, which IS a change of the fact.
    const name = [...component].sort(cmp)[0] as OutlineNodeId;
    for (const m of component) representative.set(m, name);
  }
  for (const n of nodes) if (!representative.has(n)) representative.set(n, n);

  return longestPath(nodes, edges, (n) => representative.get(n) ?? n);
}

// ---------------------------------------------------------------------------
// Feedback arc set — Eades–Lin–Smyth. `proposed` only, and never exported.
// ---------------------------------------------------------------------------

/**
 * A greedy linear arrangement; arcs pointing backwards in it are the cut.
 *
 * Deterministic by construction — every tie breaks on canonical id order — which is
 * an obligation even though the RESULT is only an estimate: an estimate that changes
 * on its own is still an estimate nobody can trust. Determinism is NOT stability
 * under a rename, and nothing here provides that. It cannot: a minimum feedback arc
 * set is not unique, and no rule canonicalises one without being arbitrary or fragile.
 */
function feedbackArcSet(
  nodes: readonly OutlineNodeId[],
  edges: readonly RankedEdge[],
): RankedEdge[] {
  const alive = new Set(nodes);
  const outgoing = new Map<OutlineNodeId, Set<OutlineNodeId>>();
  const incoming = new Map<OutlineNodeId, Set<OutlineNodeId>>();
  for (const n of nodes) {
    outgoing.set(n, new Set());
    incoming.set(n, new Set());
  }
  for (const e of edges) {
    if (e.sourceId === e.targetId) continue;
    outgoing.get(e.sourceId)?.add(e.targetId);
    incoming.get(e.targetId)?.add(e.sourceId);
  }

  const degree = (n: OutlineNodeId, table: Map<OutlineNodeId, Set<OutlineNodeId>>): number => {
    let count = 0;
    for (const other of table.get(n) ?? []) if (alive.has(other)) count += 1;
    return count;
  };

  const remove = (n: OutlineNodeId): void => {
    alive.delete(n);
  };

  const head: OutlineNodeId[] = [];
  const tail: OutlineNodeId[] = [];

  while (alive.size > 0) {
    let moved = true;
    while (moved) {
      moved = false;
      for (const n of [...alive].sort(cmp)) {
        if (degree(n, outgoing) === 0) {
          tail.push(n);
          remove(n);
          moved = true;
        }
      }
      for (const n of [...alive].sort(cmp)) {
        if (alive.has(n) && degree(n, incoming) === 0) {
          head.push(n);
          remove(n);
          moved = true;
        }
      }
    }
    if (alive.size === 0) break;

    let best: OutlineNodeId | null = null;
    let bestDelta = -Infinity;
    for (const n of [...alive].sort(cmp)) {
      const delta = degree(n, outgoing) - degree(n, incoming);
      if (delta > bestDelta) {
        bestDelta = delta;
        best = n;
      }
    }
    if (best === null) break;
    head.push(best);
    remove(best);
  }

  tail.reverse();
  const position = new Map<OutlineNodeId, number>();
  [...head, ...tail].forEach((n, i) => position.set(n, i));

  return edges.filter(
    (e) => (position.get(e.sourceId) ?? 0) > (position.get(e.targetId) ?? 0),
  );
}
