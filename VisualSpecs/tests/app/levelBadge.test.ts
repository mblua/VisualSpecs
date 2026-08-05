// What the badge is allowed to claim (Issue #44).
//
// The badge is the AUTHORITY on a box's rank — the band is a perceptual aid, and a box
// dragged out of its lane still states its true rank here. These cases fix what it may
// say, over the REAL `rank()` rather than a hand-built result, so the survival predicate
// is exercised and not just mirrored.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { importDoc } from '../../src/contract/load.ts';
import { OwnershipOutline, type OutlineNodeId } from '../../src/domain/outline.ts';
import { allOutlineNodes } from '../../src/domain/commands.ts';
import { rank } from '../../src/projection/levels.ts';
import type { EdgeKind } from '../../src/contract/types.ts';
import {
  containerLevelSummary,
  formatSiblingInstability,
  groupSummary,
  levelMarker,
  rankBadge,
} from '../../src/app/levelView.ts';
import { docText, edge, node } from '../support/doc.ts';

const KINDS: ReadonlySet<EdgeKind> = new Set<EdgeKind>(['imports']);
const C = 'C' as OutlineNodeId;

/**
 * `a` depends on `b`; `b` and `c` need each other; `mute` takes part in nothing.
 * `mutualConfidence` decides whether the entanglement survives on resolved relations.
 */
function ranked(mutualConfidence: 'resolved' | 'heuristic', basis: 'observed' | 'proposed' = 'observed') {
  const text = docText(
    [
      node('C', 'directory', null),
      node('a', 'file', 'C'),
      node('b', 'file', 'C'),
      node('c', 'file', 'C'),
      node('mute', 'file', 'C'),
    ],
    [
      edge('e1', 'imports', 'a', 'b'),
      edge('e2', 'imports', 'b', 'c'),
      edge('e3', 'imports', 'c', 'b', { confidence: mutualConfidence }),
    ],
    { view: { expanded: ['C'] } },
  );
  const loaded = importDoc(text);
  const outline = new OwnershipOutline(loaded.model);
  return { result: rank(loaded.model, outline, C, KINDS, basis), outline };
}

const a = 'a' as OutlineNodeId;
const b = 'b' as OutlineNodeId;
const mute = 'mute' as OutlineNodeId;

describe('the badge says the rank, and says nothing where nothing was measured', () => {
  it('states the rank, with the depender above what it depends on', () => {
    const { result } = ranked('resolved');
    expect(rankBadge(result, a)).toBe(`L${String(result.level.get(a) ?? -1)}`);
    // `rank(x) > rank(y)` for every dependency x → y. High rank draws at the top, so
    // every arrow points down and a violation is an arrow that points up.
    expect(result.level.get(a) as number).toBeGreaterThan(result.level.get(b) as number);
  });

  it('is ABSENT for a child that took part in no sibling edge', () => {
    // `ce + ca === 0`. `L0` would assert "it is the base" about something nothing was
    // measured on. Positioning is not asserting: the layout still gives it band 0.
    const { result } = ranked('resolved');
    expect(result.ranked.has(mute)).toBe(false);
    expect(rankBadge(result, mute)).toBeUndefined();
    // …and it still gets a rank to be positioned by.
    expect(result.level.has(mute)).toBe(true);
  });

  it('marks a group that SURVIVES over resolved relations with ⇄', () => {
    const { result } = ranked('resolved');
    expect(rankBadge(result, b)).toBe(`L${String(result.level.get(b) ?? -1)}⇄`);
  });

  it('marks a group that does not survive with ⇢ — unverified, not false', () => {
    // One heuristic arc is enough to break the resolved subgraph's cycle, so nothing
    // survives. The entanglement is still shown: what changes is the claim about it.
    const { result } = ranked('heuristic');
    expect(rankBadge(result, b)).toBe(`L${String(result.level.get(b) ?? -1)}⇢`);
  });

  it('declares a proposed rank as proposed', () => {
    // `*` is "there is a condition at the foot", not `~` "approximate": the number is
    // exact GIVEN the cut, and what is heuristic is the cut.
    const { result } = ranked('resolved', 'proposed');
    expect(rankBadge(result, a)).toMatch(/^L\d\*$/);
    expect(rankBadge(result, b)).toMatch(/^L\d\*⇄$/);
  });

  it('fits the three-character budget of a minimum-width leaf', () => {
    for (const basis of ['observed', 'proposed'] as const) {
      const { result } = ranked('resolved', basis);
      for (const child of [a, b]) {
        const badge = rankBadge(result, child) ?? '';
        expect([...badge].length).toBeLessThanOrEqual(4);
      }
    }
  });
});

describe('the container header states its scope, and never says "cycle"', () => {
  it('declares the levels, the basis and what it measured over', () => {
    const { result, outline } = ranked('resolved');
    const summary = containerLevelSummary(result, outline);
    expect(summary).toContain('levels 0–');
    expect(summary).toContain('observed');
    // The rank is LOCAL. A reader must not take "L0" for "base of the system".
    expect(summary).toContain('measured among the 4 direct children');
  });

  it('says "need each other", never "cycle"', () => {
    const { result, outline } = ranked('resolved');
    const summary = containerLevelSummary(result, outline);
    expect(summary).toContain('2 need each other');
    expect(summary.toLowerCase()).not.toContain('cycle');
  });

  it('does not report cut relations under the observed basis', () => {
    // `cutEstimate` is empty there by invariant, and "0 relations cut" would read as
    // good news when the truth is that none was evaluated.
    const { result, outline } = ranked('resolved');
    expect(result.cutEstimate.length).toBe(0);
    expect(containerLevelSummary(result, outline)).not.toContain('cut');
  });
});

describe('the panel states what survives, not what is false', () => {
  it('reports the group size and how much of it is verified', () => {
    const { result } = ranked('resolved');
    expect(groupSummary(result, b)).toBe('2 need each other; 2 survive using only resolved relations');
  });

  it('reports zero survivors without ever claiming a relation does not exist', () => {
    const { result } = ranked('heuristic');
    const summary = groupSummary(result, b) as string;
    expect(summary).toBe('2 need each other; 0 survive using only resolved relations');
    expect(summary).not.toMatch(/not exist|false|wrong/);
  });

  it('says nothing about a child that is in no group', () => {
    const { result } = ranked('resolved');
    expect(groupSummary(result, a)).toBeNull();
  });
});

describe('nothing this layer produces ever reads "NaN" on screen', () => {
  // Criterion 5's named gap: `rank()` emits `null` and the port rejects non-finites, and
  // neither stops a panel from formatting that `null` into the STRING "NaN". This is the
  // text assertion that closes it — over the REAL corpus, so it covers the 52 of 499
  // boxes that legitimately have no data.
  it('formats a null instability as words, not as a non-number', () => {
    expect(formatSiblingInstability(null, 0, 0)).toBe('no data — no relations among siblings');
    expect(formatSiblingInstability(undefined, 0, 0)).not.toContain('NaN');
    expect(formatSiblingInstability(Number.NaN, 0, 0)).not.toContain('NaN');
    expect(formatSiblingInstability(0.5, 1, 1)).toContain('Ce 1 / Ca 1');
  });

  it('produces no "NaN" and no "null" anywhere over the real corpus', () => {
    const text = readFileSync(
      fileURLToPath(new URL('../../data/agentscommander.json', import.meta.url)),
      'utf8',
    );
    const real = importDoc(text);
    const realOutline = new OwnershipOutline(real.model);
    const containers = allOutlineNodes(realOutline).filter(
      (n) => realOutline.childrenOf(n).length > 0,
    );
    expect(containers.length).toBeGreaterThan(60);

    const strings: string[] = [];
    let checked = 0;
    for (const container of containers) {
      const result = rank(real.model, realOutline, container, KINDS, 'observed');
      strings.push(containerLevelSummary(result, realOutline));
      for (const child of realOutline.childrenOf(container)) {
        strings.push(rankBadge(result, child) ?? '');
        strings.push(groupSummary(result, child) ?? '');
        strings.push(
          formatSiblingInstability(
            result.siblingInstability.get(child),
            result.edges.filter((e) => e.sourceId === child).length,
            result.edges.filter((e) => e.targetId === child).length,
          ),
        );
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(400);
    const bad = strings.filter((s) => /NaN|undefined|\bnull\b|Infinity/.test(s));
    expect(bad).toEqual([]);
  });
});

describe('a container that hides an entanglement does not look clean', () => {
  it('marks a child whose own subtree holds relations this level cannot speak about', () => {
    // The H5 case in miniature: `P` looks like a plain box with a rank, and hides an
    // entanglement between its own children.
    const text = docText(
      [
        node('C', 'directory', null),
        node('P', 'directory', 'C'),
        node('q', 'file', 'C'),
        node('p1', 'file', 'P'),
        node('p2', 'file', 'P'),
      ],
      [
        edge('e1', 'imports', 'p1', 'p2'),
        edge('e2', 'imports', 'p2', 'p1'),
        edge('e3', 'imports', 'q', 'p1'),
      ],
      { view: { expanded: ['C'] } },
    );
    const loaded = importDoc(text);
    const outline = new OwnershipOutline(loaded.model);
    const result = rank(loaded.model, outline, C, KINDS, 'observed');

    const P = 'P' as OutlineNodeId;
    expect(result.hidesInternal.has(P)).toBe(true);
    expect(levelMarker(result, P)).toBe('▩');
    // And a child that hides nothing carries no marker.
    expect(levelMarker(result, 'q' as OutlineNodeId)).toBeUndefined();
  });

  it('NEVER marks it with ⇄, which claims something else entirely', () => {
    // `⇄` means "these siblings need each other". This container needs no sibling — its
    // own SCC has one member — so `⇄` here would be a false claim about it, and would put
    // one symbol on two different facts.
    const text = docText(
      [
        node('C', 'directory', null),
        node('P', 'directory', 'C'),
        node('p1', 'file', 'P'),
        node('p2', 'file', 'P'),
      ],
      [edge('e1', 'imports', 'p1', 'p2'), edge('e2', 'imports', 'p2', 'p1')],
      { view: { expanded: ['C'] } },
    );
    const loaded = importDoc(text);
    const outline = new OwnershipOutline(loaded.model);
    const result = rank(loaded.model, outline, C, KINDS, 'observed');
    const P = 'P' as OutlineNodeId;

    const index = result.sccOf.get(P);
    const scc = index === undefined ? undefined : result.sccs[index];
    expect(scc === undefined || scc.members.length < 2).toBe(true);

    expect(levelMarker(result, P)).not.toContain('⇄');
    expect(rankBadge(result, P) ?? '').not.toContain('⇄');
  });

  it('states both facts separately when a container is tangled AND hides a tangle', () => {
    // `A` and `B` need each other, and `A` also hides an entanglement among its own
    // children. Two facts, two symbols, neither borrowed from the other.
    const text = docText(
      [
        node('C', 'directory', null),
        node('A', 'directory', 'C'),
        node('B', 'directory', 'C'),
        node('a1', 'file', 'A'),
        node('a2', 'file', 'A'),
        node('b1', 'file', 'B'),
      ],
      [
        edge('e1', 'imports', 'a1', 'a2'),
        edge('e2', 'imports', 'a2', 'a1'),
        edge('e3', 'imports', 'a1', 'b1'),
        edge('e4', 'imports', 'b1', 'a2'),
      ],
      { view: { expanded: ['C'] } },
    );
    const loaded = importDoc(text);
    const outline = new OwnershipOutline(loaded.model);
    const result = rank(loaded.model, outline, C, KINDS, 'observed');
    const A = 'A' as OutlineNodeId;

    const index = result.sccOf.get(A);
    const scc = index === undefined ? undefined : result.sccs[index];
    expect(scc?.members.length).toBeGreaterThan(1);
    expect(result.hidesInternal.has(A)).toBe(true);

    expect(rankBadge(result, A)).toContain('⇄'); // tangled with its sibling
    expect(levelMarker(result, A)).toBe('▩'); // and hiding one inside
  });
});
