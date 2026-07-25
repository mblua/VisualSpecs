// I-F1 and I-F2 where they can actually be violated: at `derive()`.
//
// `buildScene` cannot break I-F1 on its own — it is handed a `VisibleGraph` that is
// already built. The place focus could reach the projection is the COMPOSITION, and
// the composition is `derive(state)`: geometry, then `project`, then `buildScene`. A
// check written against `project()` directly is checking a function that was never in
// danger, and it passes while `derive` threads the view into the projection three
// lines away.
//
// Concretely, this is the mutation it exists to kill:
//
//   const effective = resolveFocus(state.outline, state.view.focus.marks);
//   const expanded = new Set([...state.view.expanded].filter((id) => effective.get(id) !== 'out'));
//   const graph = project(state.model, state.outline, expanded);
//
// which is invisible until a mark exists AND names an expanded container — so a suite
// that only ever marks leaves, or only ever marks with everything collapsed, reports
// green.

import { describe, expect, it } from 'vitest';
import { importDoc } from '../../src/contract/load.ts';
import { DEFAULT_LIMITS } from '../../src/contract/limits.ts';
import { withFocus, type FocusMark } from '../../src/contract/view.ts';
import { resolveFocus } from '../../src/domain/focus.ts';
import { project } from '../../src/projection/project.ts';
import { derive } from '../../src/app/controller.ts';
import { stateFromLoaded, type AppState } from '../../src/app/state.ts';
import { sampleDoc } from '../support/doc.ts';

const EVERYTHING_OPEN = new Set(['repo', 'pkg-a', 'dir-a', 'pkg-b', 'dir-b']);

function state(marks: readonly (readonly [string, FocusMark])[], transparency = 70): AppState {
  const base = stateFromLoaded(importDoc(sampleDoc()));
  const opened = { ...base, view: { ...base.view, expanded: EVERYTHING_OPEN } };
  return { ...opened, view: withFocus(opened.view, { marks: new Map(marks), transparency }) };
}

/** Everything the projection is, reduced to something comparable. */
function projectionOf(s: AppState): unknown {
  const { graph } = derive(s);
  return {
    visibleNodes: [...graph.visibleNodes],
    visibleEdges: graph.visibleEdges.map((e) => ({
      id: e.id,
      kind: e.kind,
      sourceId: e.sourceId,
      targetId: e.targetId,
      count: e.count,
      sourceEdgeIds: [...e.sourceEdgeIds],
    })),
    internalBuckets: graph.internalBuckets.map((b) => ({
      id: b.id,
      kind: b.kind,
      containerId: b.containerId,
      count: b.count,
      sourceEdgeIds: [...b.sourceEdgeIds],
    })),
    nva: [...graph.nva].sort(),
    outOfScopeEdgeIds: [...graph.outOfScopeEdgeIds],
  };
}

describe('I-F1 — focus never participates in projection, checked through derive()', () => {
  const CASES: readonly (readonly [string, readonly (readonly [string, FocusMark])[]])[] = [
    ['a marked EXPANDED container', [['pkg-a', 'out-of-focus']]],
    ['a marked expanded container with an override inside it', [
      ['pkg-a', 'out-of-focus'],
      ['file-a1', 'in-focus'],
    ]],
    ['a marked expanded DIRECTORY, one level down', [['dir-a', 'out-of-focus']]],
    ['the root marked', [['repo', 'out-of-focus']]],
    ['a marked leaf', [['file-a1', 'out-of-focus']]],
    ['an inert mark naming nothing in this graph', [['ghost', 'out-of-focus']]],
  ];

  const baseline = projectionOf(state([]));

  for (const [what, marks] of CASES) {
    it(`is bit-identical with ${what}`, () => {
      expect(projectionOf(state(marks))).toEqual(baseline);
    });
  }

  it('is bit-identical at every transparency in the band', () => {
    for (let t = DEFAULT_LIMITS.minFocusTransparency; t <= DEFAULT_LIMITS.maxFocusTransparency; t += 1) {
      expect(projectionOf(state([['pkg-a', 'out-of-focus']], t))).toEqual(baseline);
    }
  });
});

describe('the check is not vacuous', () => {
  it('detects the exact mutation it exists to kill', () => {
    // Proven rather than asserted: an invariant test that cannot fail is decoration.
    // This reproduces the mutation locally — focus filtering the expansion set on its
    // way into `project` — and shows the comparison above is sensitive to it, without
    // touching a file this lane does not own.
    const marked = state([['pkg-a', 'out-of-focus']]);
    const effective = resolveFocus(marked.outline, marked.view.focus.marks);
    const mutated = new Set(
      [...marked.view.expanded].filter((id) => effective.get(id) !== 'out'),
    );
    expect(mutated).not.toEqual(marked.view.expanded);

    const honest = project(marked.model, marked.outline, marked.view.expanded);
    const leaked = project(marked.model, marked.outline, mutated);
    expect([...leaked.visibleNodes]).not.toEqual([...honest.visibleNodes]);
    // …and the comparison this file runs is over exactly those fields.
    expect(projectionOf(marked)).toEqual(projectionOf(state([])));
  });
});

describe('I-F2 and I-F7 — no count and no geometry moves either', () => {
  it('keeps hiddenByFilter, every count and every position identical', () => {
    const before = derive(state([]));
    const after = derive(state([['pkg-a', 'out-of-focus'], ['file-a1', 'in-focus']]));

    expect(after.scene.hiddenByFilter).toEqual(before.scene.hiddenByFilter);
    expect(after.graph.visibleEdges.length).toBe(before.graph.visibleEdges.length);
    expect(after.graph.internalBuckets.reduce((n, b) => n + b.count, 0)).toBe(
      before.graph.internalBuckets.reduce((n, b) => n + b.count, 0),
    );
    // I-F7: the layout is not a function of focus.
    expect([...after.geometry.position]).toEqual([...before.geometry.position]);
    expect([...after.geometry.size]).toEqual([...before.geometry.size]);
    expect([...after.geometry.z]).toEqual([...before.geometry.z]);
    // The scene DOES change — that is the whole feature — so a test that found the
    // projection identical and stopped there would be checking nothing.
    expect(after.scene.scene.nodes.some((n) => n.opacity < 1)).toBe(true);
  });
});
