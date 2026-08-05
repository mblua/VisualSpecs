// Levelization (#44). The laws that make a rank worth showing.
//
// Read the negatives here as carefully as the positives: several of these assert what
// the module REFUSES to claim, and those are the ones that were expensive to learn.

import { describe, expect, it } from 'vitest';
import { importDoc } from '../../src/contract/load.ts';
import { OwnershipOutline } from '../../src/domain/outline.ts';
import type { Outline, OutlineNodeId } from '../../src/domain/outline.ts';
import type { GraphModel } from '../../src/contract/model.ts';
import {
  aggregateConfidence,
  compareMemberTuples,
  rank,
  sccSizeOf,
} from '../../src/projection/levels.ts';
import type { RankResult } from '../../src/projection/levels.ts';
import { docText, edge, node } from '../support/doc.ts';
import type { VisualSpecsEdge, VisualSpecsNode } from '../../src/contract/types.ts';

const IMPORTS = new Set(['imports']);

/**
 *   repo
 *   ├── a ── a1, a2      a1→a2 stays inside a; a1→b1 crosses
 *   ├── b ── b1          b1→c1
 *   ├── c ── c1
 *   ├── d ── d1          d1→e1  ┐ mutually needed
 *   ├── e ── e1          e1→d1  ┘
 *   └── z ── z1          nothing at all
 */
function ladderDoc(): string {
  const nodes: VisualSpecsNode[] = [
    node('repo', 'repository', null, { path: '' }),
    ...['a', 'b', 'c', 'd', 'e', 'z'].map((id) => node(id, 'directory', 'repo', { path: id })),
    ...['a1', 'a2'].map((id) => node(id, 'file', 'a', { path: `a/${id}.ts` })),
    node('b1', 'file', 'b', { path: 'b/b1.ts' }),
    node('c1', 'file', 'c', { path: 'c/c1.ts' }),
    node('d1', 'file', 'd', { path: 'd/d1.ts' }),
    node('e1', 'file', 'e', { path: 'e/e1.ts' }),
    node('z1', 'file', 'z', { path: 'z/z1.ts' }),
  ];
  const edges: VisualSpecsEdge[] = [
    edge('e-inside', 'imports', 'a1', 'a2'),
    edge('e-ab', 'imports', 'a1', 'b1'),
    edge('e-bc', 'imports', 'b1', 'c1'),
    edge('e-de', 'imports', 'd1', 'e1'),
    edge('e-ed', 'imports', 'e1', 'd1'),
  ];
  return docText(nodes, edges);
}

function load(text: string): { model: GraphModel; outline: Outline } {
  const loaded = importDoc(text);
  return { model: loaded.model, outline: new OwnershipOutline(loaded.model) };
}

function rankRepo(text = ladderDoc(), basis: 'observed' | 'proposed' = 'observed'): RankResult {
  const { model, outline } = load(text);
  return rank(model, outline, 'repo', IMPORTS, basis);
}

describe('the rank a container gives its children', () => {
  it('a child that depends on nothing among its siblings is the base, and dependents sit above it', () => {
    const result = rankRepo();
    // c ← b ← a. Information flows UP: the arrow points down the stack.
    expect(result.level.get('c')).toBe(0);
    expect(result.level.get('b')).toBe(1);
    expect(result.level.get('a')).toBe(2);
    expect(result.maxRank).toBe(2);
  });

  it('lifts each endpoint to the container DIRECT CHILD, so a file→file relation ranks its directories', () => {
    const result = rankRepo();
    const ab = result.edges.find((e) => e.sourceId === 'a' && e.targetId === 'b');
    expect(ab).toBeDefined();
    expect(ab?.count).toBe(1);
    expect([...(ab?.sourceEdgeIds ?? [])]).toEqual(['e-ab']);
  });

  it('a relation with both endpoints inside ONE child is not an arc of the ranked graph', () => {
    const result = rankRepo();
    expect(result.edges.some((e) => e.sourceId === 'a' && e.targetId === 'a')).toBe(false);
  });

  it('members of an entanglement SHARE a rank — no order is invented inside it', () => {
    const result = rankRepo();
    expect(result.level.get('d')).toBe(result.level.get('e'));
    expect(sccSizeOf(result, 'd')).toBe(2);
    expect(sccSizeOf(result, 'e')).toBe(2);
    expect(sccSizeOf(result, 'a')).toBe(1);
  });
});

describe('what the module refuses to claim', () => {
  it('a child taking part in no sibling edge gets NO badge — L0 would assert "it is the base"', () => {
    const result = rankRepo();
    expect(result.ranked.has('z')).toBe(false);
    // It still HAS a level, because layout needs a position for every box.
    // Positioning is not asserting.
    expect(result.level.has('z')).toBe(true);
    expect(result.ranked.has('a')).toBe(true);
  });

  it('sibling instability is null where Ca = Ce = 0, and never a non-finite', () => {
    const result = rankRepo();
    expect(result.siblingInstability.get('z')).toBeNull();
    for (const [id, value] of result.siblingInstability) {
      if (value === null) continue;
      expect(Number.isFinite(value), `${id} is not finite`).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    // a depends on b and nothing depends on a: purely efferent.
    expect(result.siblingInstability.get('a')).toBe(1);
    // c is depended upon and depends on nothing: purely afferent.
    expect(result.siblingInstability.get('c')).toBe(0);
  });

  it('a child hiding relations inside its own subtree is NOT reportable as verified clean', () => {
    const result = rankRepo();
    // `a` holds a1→a2, which this level cannot speak about.
    expect(result.hidesInternal.has('a')).toBe(true);
    expect(sccSizeOf(result, 'a')).toBe(1); // "1 at this level", not "1, verified"
    // b, c, z hide nothing: their 1 IS verified at this level.
    expect(result.hidesInternal.has('b')).toBe(false);
    expect(result.hidesInternal.has('z')).toBe(false);
  });

  it('the cut is empty under `observed`, and only an ESTIMATE under `proposed`', () => {
    expect(rankRepo(ladderDoc(), 'observed').cutEstimate).toEqual([]);

    const proposed = rankRepo(ladderDoc(), 'proposed');
    expect(proposed.cutEstimate).toHaveLength(1); // one of d→e / e→d, not both
    // With the entanglement cut, d and e can no longer share a rank.
    expect(proposed.level.get('d')).not.toBe(proposed.level.get('e'));
  });

  it('declares the basis and the kinds it was computed over — a figure without them is not reproducible', () => {
    const result = rankRepo();
    expect(result.basis).toBe('observed');
    expect(result.kinds).toEqual(['imports']);
    expect(rankRepo(ladderDoc(), 'proposed').basis).toBe('proposed');
  });
});

describe('identity and determinism', () => {
  it('every ranked edge carries its structured tuple, never a positional id', () => {
    const result = rankRepo();
    for (const e of result.edges) {
      expect(typeof e.kind).toBe('string');
      expect(typeof e.sourceId).toBe('string');
      expect(typeof e.targetId).toBe('string');
      expect(e.sourceEdgeIds.length).toBe(e.count);
      // `v${i}` is a position, not an identity. Nothing here may look like one.
      expect(/^v\d+$/.test(e.sourceId)).toBe(false);
      expect(/^v\d+$/.test(e.targetId)).toBe(false);
    }
  });

  it('permuting what rank() RECEIVES changes nothing', () => {
    // Permuting the document would only prove buildModel canonicalises. This permutes
    // the two orders rank() actually reads: the edge list and the child list.
    const { model, outline } = load(ladderDoc());
    const straight = rank(model, outline, 'repo', IMPORTS);

    const shuffledModel: GraphModel = { ...model, edges: [...model.edges].reverse() };
    const reversedOutline: Outline = {
      id: outline.id,
      roots: () => outline.roots(),
      childrenOf: (n: OutlineNodeId) => [...outline.childrenOf(n)].reverse(),
      entityOf: (n: OutlineNodeId) => outline.entityOf(n),
      placementOf: (e) => outline.placementOf(e),
    };
    const shuffled = rank(shuffledModel, reversedOutline, 'repo', IMPORTS);

    expect([...shuffled.level.entries()].sort()).toEqual([...straight.level.entries()].sort());
    expect(shuffled.sccs).toEqual(straight.sccs);
    expect(shuffled.edges).toEqual(straight.edges);
    expect(shuffled.maxRank).toBe(straight.maxRank);
  });

  it('SCC membership is the identity, and it is sorted — a rename cannot reshuffle a traversal index', () => {
    const result = rankRepo();
    expect(result.sccs).toHaveLength(1);
    expect(result.sccs[0]?.members).toEqual(['d', 'e']);
    expect(result.sccs[0]?.internalEdges.map((e) => `${e.sourceId}->${e.targetId}`)).toEqual([
      'd->e',
      'e->d',
    ]);
  });

  it('the rank of a container does not depend on what is expanded — `expanded` is not an input', () => {
    // Stated as a test so the property is not silently lost if the signature changes.
    // This is invariance BY CONSTRUCTION: there is no expansion state to vary. A test
    // that varied it would be measuring the harness, not the module.
    expect(rank.length).toBeLessThanOrEqual(5);
    const source = rank.toString();
    expect(source.includes('expanded')).toBe(false);
  });
});

// The SCCs of a graph are disjoint, so no corpus produces two member tuples sharing a
// prefix. Every test above that touches SCC numbering therefore passes unchanged
// against a comparator that only looks at field 0 — the corpus cannot reach the rest
// of the function, so these do it with tuples built by hand.
describe('the member-tuple order, which no corpus can exercise', () => {
  it('compares field by field PAST field 0', () => {
    expect(compareMemberTuples(['a', 'b'], ['a', 'c'])).toBeLessThan(0);
    expect(compareMemberTuples(['a', 'c'], ['a', 'b'])).toBeGreaterThan(0);
    expect(compareMemberTuples(['a', 'b', 'x'], ['a', 'b', 'y'])).toBeLessThan(0);
    // Kills the "only look at field 0" implementation: identical there, ordered here.
    expect(compareMemberTuples(['a', 'b'], ['a', 'c'])).not.toBe(0);
  });

  it('sorts the SHORTER tuple first when one runs out — the prefix case', () => {
    expect(compareMemberTuples(['a'], ['a', 'b'])).toBeLessThan(0);
    expect(compareMemberTuples(['a', 'b'], ['a'])).toBeGreaterThan(0);
    expect(compareMemberTuples([], ['a'])).toBeLessThan(0);
  });

  it('is a TOTAL order: irreflexive, antisymmetric and transitive on a hand-built set', () => {
    const tuples: readonly (readonly string[])[] = [
      [],
      ['a'],
      ['a', 'a'],
      ['a', 'b'],
      ['a', 'b', 'c'],
      ['b'],
      ['b', 'a'],
    ];
    // Not Math.sign: it returns -0 for 0, and `toBe` is Object.is.
    const sign = (n: number): number => (n < 0 ? -1 : n > 0 ? 1 : 0);

    for (const t of tuples) expect(compareMemberTuples(t, t)).toBe(0);
    for (const x of tuples) {
      for (const y of tuples) {
        expect(sign(compareMemberTuples(x, y))).toBe(-sign(compareMemberTuples(y, x)) + 0);
      }
    }
    for (const x of tuples) {
      for (const y of tuples) {
        for (const z of tuples) {
          if (compareMemberTuples(x, y) < 0 && compareMemberTuples(y, z) < 0) {
            expect(compareMemberTuples(x, z)).toBeLessThan(0);
          }
        }
      }
    }
  });

  it('never joins the fields into one string — a delimiter would collide (§6.3)', () => {
    // ['a|b'] and ['a', 'b'] are different tuples; concatenating with '|' makes them
    // equal, and an imported document can produce ids containing any character.
    expect(compareMemberTuples(['a|b'], ['a', 'b'])).not.toBe(0);
  });
});

describe('confidence', () => {
  it('an aggregate is only as unverified as its BEST relation (§4.3)', () => {
    expect(aggregateConfidence(['heuristic', 'heuristic'])).toBe('heuristic');
    expect(aggregateConfidence(['heuristic', 'resolved'])).toBe('resolved');
    expect(aggregateConfidence(['heuristic', 'declared'])).toBe('declared');
    expect(aggregateConfidence([])).toBe('heuristic');
  });

  it('an entanglement held together only by heuristics does not survive the resolved subgraph', () => {
    const nodes: VisualSpecsNode[] = [
      node('repo', 'repository', null, { path: '' }),
      ...['p', 'q'].map((id) => node(id, 'directory', 'repo', { path: id })),
      node('p1', 'file', 'p', { path: 'p/p1.ts' }),
      node('q1', 'file', 'q', { path: 'q/q1.ts' }),
    ];
    const guessed = docText(nodes, [
      edge('h1', 'imports', 'p1', 'q1', { confidence: 'heuristic' }),
      edge('h2', 'imports', 'q1', 'p1', { confidence: 'heuristic' }),
    ]);
    const guessedResult = rankRepo(guessed);
    expect(guessedResult.sccs[0]?.members).toEqual(['p', 'q']);
    expect(guessedResult.sccs[0]?.survivingMembers).toEqual([]);

    // One resolved relation in each direction is enough to hold it up.
    const verified = docText(nodes, [
      edge('h1', 'imports', 'p1', 'q1', { confidence: 'heuristic' }),
      edge('r1', 'imports', 'p1', 'q1'),
      edge('r2', 'imports', 'q1', 'p1'),
    ]);
    const verifiedResult = rankRepo(verified);
    expect(verifiedResult.sccs[0]?.survivingMembers).toEqual(['p', 'q']);
  });

  it('an arc backed by one resolved relation among forty heuristics still carries a verified dependency', () => {
    const nodes: VisualSpecsNode[] = [
      node('repo', 'repository', null, { path: '' }),
      ...['p', 'q'].map((id) => node(id, 'directory', 'repo', { path: id })),
      ...Array.from({ length: 3 }, (_, i) => node(`p${i}`, 'file', 'p', { path: `p/${i}.ts` })),
      node('q1', 'file', 'q', { path: 'q/q1.ts' }),
    ];
    const edges: VisualSpecsEdge[] = [
      edge('g1', 'imports', 'p0', 'q1', { confidence: 'heuristic' }),
      edge('g2', 'imports', 'p1', 'q1', { confidence: 'heuristic' }),
      edge('g3', 'imports', 'p2', 'q1'),
      edge('back', 'imports', 'q1', 'p0'),
    ];
    const result = rankRepo(docText(nodes, edges));
    const pq = result.edges.find((e) => e.sourceId === 'p' && e.targetId === 'q');
    expect(pq?.count).toBe(3);
    expect(pq?.resolvedCount).toBe(1);
    expect(pq?.confidence).toBe('resolved');
    // And the entanglement survives, because the resolved relation is one of the three.
    expect(result.sccs[0]?.survivingMembers).toEqual(['p', 'q']);
  });
});
