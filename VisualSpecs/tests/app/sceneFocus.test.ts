// What focus does to a scene (Issue #17, §4.3 / §4.4 / §7).
//
// Everything here is about the ONE place that knows why something is faded. The port
// gets a resolved number; these tests are what stop that number from being wrong.

import { describe, expect, it } from 'vitest';
import { importDoc } from '../../src/contract/load.ts';
import { DEFAULT_LIMITS } from '../../src/contract/limits.ts';
import { withFocus, type FocusMark } from '../../src/contract/view.ts';
import { focusOpacity } from '../../src/domain/focus.ts';
import { computeGeometry } from '../../src/domain/layoutEngine.ts';
import { project } from '../../src/projection/project.ts';
import { buildScene, MIXED_SUBTREE_MARKER, SEARCH_EDGE_OPACITY, SEARCH_NODE_OPACITY } from '../../src/app/scene.ts';
import { stateFromLoaded, type AppState } from '../../src/app/state.ts';
import { matchNodes } from '../../src/app/search.ts';
import { sampleDoc } from '../support/doc.ts';

const MAX = DEFAULT_LIMITS.maxFocusTransparency;

function boot(over: Partial<AppState> = {}): AppState {
  return { ...stateFromLoaded(importDoc(sampleDoc())), ...over };
}

function withMarks(
  state: AppState,
  marks: readonly (readonly [string, FocusMark])[],
  transparency = 70,
): AppState {
  return {
    ...state,
    view: withFocus(state.view, { marks: new Map(marks), transparency }),
  };
}

function scene(state: AppState): ReturnType<typeof buildScene> {
  const geometry = computeGeometry(
    state.model,
    state.outline,
    state.view.expanded,
    state.view.positions,
    state.view.fitted,
  );
  const graph = project(state.model, state.outline, state.view.expanded);
  return buildScene(state, geometry, graph);
}

const nodeOpacity = (r: ReturnType<typeof buildScene>, id: string): number | undefined =>
  r.scene.nodes.find((n) => n.id === id)?.opacity;

/** The one drawn line between two given boxes, of a given kind. */
function edgeOf(
  r: ReturnType<typeof buildScene>,
  sourceId: string,
  targetId: string,
  kind = 'imports',
): { opacity: number; count: number } {
  const e = r.scene.edges.find(
    (x) => x.sourceId === sourceId && x.targetId === targetId && x.kind === kind,
  );
  if (e === undefined) throw new Error(`no ${kind} edge ${sourceId} → ${targetId}`);
  return { opacity: e.opacity, count: e.count };
}

describe('a map nobody has dimmed is untouched', () => {
  it('every node and edge is at full strength, and no focus is published', () => {
    const r = scene(boot());
    expect(r.scene.nodes.every((n) => n.opacity === 1)).toBe(true);
    expect(r.scene.edges.every((e) => e.opacity === 1)).toBe(true);
    expect(r.focus).toBeNull();
    expect(r.scene.nodes.every((n) => n.marker === undefined)).toBe(true);
  });

  it('setting a transparency without marking anything still dims nothing', () => {
    const r = scene(withMarks(boot(), [], MAX));
    expect(r.scene.nodes.every((n) => n.opacity === 1)).toBe(true);
    expect(r.scene.edges.every((e) => e.opacity === 1)).toBe(true);
  });
});

describe('§4.3 — an aggregate carries a fraction, not a bit', () => {
  // pkg-a and pkg-b collapsed: e1 (file-a1→file-b1) and e2 (file-a2→file-b1) both
  // aggregate into ONE drawn `imports` line, pkg-a → pkg-b ×2.
  const collapsed = (): AppState => {
    const base = boot();
    return { ...base, view: { ...base.view, expanded: new Set(['repo']) } };
  };

  it('the ×2 line is fully dim when the whole subtree is out of focus', () => {
    const r = scene(withMarks(collapsed(), [['pkg-a', 'out-of-focus']]));
    const line = edgeOf(r, 'pkg-a', 'pkg-b');
    expect(line.count).toBe(2);
    expect(line.opacity).toBeCloseTo(focusOpacity(70), 10);
  });

  it('re-lighting ONE entity inside it moves the line, and does not return it to full', () => {
    // The §4.1 gesture: dim the container, bring one thing back. v1 hid the relation
    // the user re-lit; v2 returned the whole line to full strength while the rest of
    // what it stands for was still switched off.
    const r = scene(
      withMarks(collapsed(), [
        ['pkg-a', 'out-of-focus'],
        ['file-a1', 'in-focus'],
      ]),
    );
    const line = edgeOf(r, 'pkg-a', 'pkg-b');
    expect(line.opacity).toBeGreaterThan(focusOpacity(70));
    expect(line.opacity).toBeLessThan(1);
  });

  it('the box stays dim while its line brightens — the override is the point', () => {
    const r = scene(
      withMarks(collapsed(), [
        ['pkg-a', 'out-of-focus'],
        ['file-a1', 'in-focus'],
      ]),
    );
    expect(nodeOpacity(r, 'pkg-a')).toBeCloseTo(focusOpacity(70), 10);
    expect(edgeOf(r, 'pkg-a', 'pkg-b').opacity).toBeGreaterThan(focusOpacity(70));
  });

  it('is EXACTLY the boolean rule at ×1 — which is what keeps the 0-of-14 evidence', () => {
    // `bundles` is its own line between the same pair: a ×1 aggregate carrying e4.
    const dim = scene(withMarks(collapsed(), [['pkg-a', 'out-of-focus']]));
    expect(edgeOf(dim, 'pkg-a', 'pkg-b', 'bundles').count).toBe(1);
    expect(edgeOf(dim, 'pkg-a', 'pkg-b', 'bundles').opacity).toBeCloseTo(focusOpacity(70), 10);

    const lit = scene(
      withMarks(collapsed(), [
        ['pkg-a', 'out-of-focus'],
        ['file-a1', 'in-focus'],
      ]),
    );
    // e4 is file-a1 → file-b1, and file-a1 is back in focus: nothing behind this line
    // is switched off, so it is at full strength. No fraction, no floor.
    expect(edgeOf(lit, 'pkg-a', 'pkg-b', 'bundles').opacity).toBe(1);
  });

  it('expanding the container does not flip a relation\'s own state', () => {
    const marks: readonly (readonly [string, FocusMark])[] = [
      ['pkg-a', 'out-of-focus'],
      ['file-a1', 'in-focus'],
    ];
    const base = boot();
    const expanded = {
      ...base,
      view: { ...base.view, expanded: new Set(['repo', 'pkg-a', 'dir-a', 'pkg-b', 'dir-b']) },
    };
    const r = scene(withMarks(expanded, marks));
    // Drawn one relation per line now. file-a1 is lit, file-a2 is not.
    expect(edgeOf(r, 'file-a1', 'file-b1').opacity).toBe(1);
    expect(edgeOf(r, 'file-a2', 'file-b1').opacity).toBeCloseTo(focusOpacity(70), 10);
  });

  it('does not dim a carrier with no resolvable logical relations (vacuous truth)', () => {
    // `[].every(...)` is `true`. No such carrier exists on the committed corpus, which
    // is exactly why the guard has to be written rather than relied upon — so this
    // manufactures one by emptying `edgeById` after the projection has bucketed.
    const state = withMarks(
      { ...boot(), view: { ...boot().view, expanded: new Set(['repo']) } },
      [['pkg-a', 'out-of-focus']],
    );
    const geometry = computeGeometry(
      state.model,
      state.outline,
      state.view.expanded,
      state.view.positions,
      state.view.fitted,
    );
    const graph = project(state.model, state.outline, state.view.expanded);
    const emptied = new Map(state.model.edgeById);
    emptied.clear();
    const r = buildScene({ ...state, model: { ...state.model, edgeById: emptied } }, geometry, graph);
    expect(r.scene.edges.every((e) => e.opacity === 1)).toBe(true);
  });
});

describe('§4.4 — the marker means "the inside disagrees with me"', () => {
  const collapsed = (): AppState => {
    const base = boot();
    return { ...base, view: { ...base.view, expanded: new Set(['repo']) } };
  };

  it('in focus, something inside dimmed → marked', () => {
    const r = scene(withMarks(collapsed(), [['file-a1', 'out-of-focus']]));
    expect(r.scene.nodes.find((n) => n.id === 'pkg-a')?.marker).toBe(MIXED_SUBTREE_MARKER);
  });

  it('dimmed, something inside re-lit → marked (the state v2 could not express)', () => {
    const r = scene(
      withMarks(collapsed(), [
        ['pkg-a', 'out-of-focus'],
        ['file-a1', 'in-focus'],
      ]),
    );
    expect(r.scene.nodes.find((n) => n.id === 'pkg-a')?.marker).toBe(MIXED_SUBTREE_MARKER);
  });

  it('dimmed, nothing re-lit → NOT marked', () => {
    const r = scene(withMarks(collapsed(), [['pkg-a', 'out-of-focus']]));
    expect(r.scene.nodes.find((n) => n.id === 'pkg-a')?.marker).toBeUndefined();
  });
});

describe('§7 — composition, band and the port invariant', () => {
  it('the dimmest reason wins, in both orders', () => {
    const base = boot();
    const searching = {
      ...base,
      search: { query: 'one.ts', matches: matchNodes(base.model, 'one.ts') },
      view: { ...base.view, expanded: new Set(['repo', 'pkg-a', 'dir-a', 'pkg-b', 'dir-b']) },
    };
    // A search miss at a subtle transparency stays at the SEARCH strength: enabling
    // focus must never brighten something the search had already dimmed.
    const subtle = scene(withMarks(searching, [['file-a2', 'out-of-focus']], 10));
    expect(nodeOpacity(subtle, 'file-a2')).toBe(SEARCH_NODE_OPACITY);

    // And at the maximum the two strengths coincide exactly — which is why §7 presents
    // the ceiling as "the dim this app already ships" rather than a new constant.
    expect(focusOpacity(MAX)).toBeCloseTo(SEARCH_NODE_OPACITY, 10);
  });

  it('a search miss renders identically whether or not it is out of focus (§13)', () => {
    const base = boot();
    const expanded = {
      ...base,
      view: { ...base.view, expanded: new Set(['repo', 'pkg-a', 'dir-a', 'pkg-b', 'dir-b']) },
      search: { query: 'one.ts', matches: matchNodes(base.model, 'one.ts') },
    };
    const inFocus = scene(withMarks(expanded, [], MAX));
    const outOfFocus = scene(withMarks(expanded, [['file-a2', 'out-of-focus']], MAX));
    // This is a RESIGNATION, asserted so it is a decision and not a surprise: `min`
    // plus a ceiling equal to the search dim makes focus unobservable on canvas for
    // anything a search does not match. §8.4's row glyphs are the mitigation.
    //
    // `toBeCloseTo`, not `toBe`, and the reason is worth writing down: `1 - 78/100` is
    // `0.21999999999999997`, one ULP BELOW `SEARCH_NODE_OPACITY`. So at the maximum
    // `min` picks the focus term, and I-F6's "equality permitted" holds to 4e-17
    // rather than exactly. Invisible at 8 bits, and a trap for any assertion written
    // as `>= SEARCH_NODE_OPACITY`.
    expect(nodeOpacity(inFocus, 'file-a2') ?? 0).toBeCloseTo(
      nodeOpacity(outOfFocus, 'file-a2') ?? 0,
      12,
    );
    expect(focusOpacity(MAX)).toBeLessThan(SEARCH_NODE_OPACITY);
    expect(SEARCH_NODE_OPACITY - focusOpacity(MAX)).toBeLessThan(1e-15);
  });

  it('keeps every opacity inside (0, 1] across the whole band', () => {
    const base = boot();
    const expanded = {
      ...base,
      view: { ...base.view, expanded: new Set(['repo', 'pkg-a', 'dir-a', 'pkg-b', 'dir-b']) },
      search: { query: 'one', matches: matchNodes(base.model, 'one') },
    };
    for (let t = DEFAULT_LIMITS.minFocusTransparency; t <= MAX; t += 1) {
      const r = scene(
        withMarks(expanded, [['pkg-a', 'out-of-focus'], ['file-a1', 'in-focus']], t),
      );
      for (const n of r.scene.nodes) {
        expect(n.opacity, `node ${n.id} at transparency ${String(t)}`).toBeGreaterThan(0);
        expect(n.opacity).toBeLessThanOrEqual(1);
      }
      for (const e of r.scene.edges) {
        expect(e.opacity, `edge ${e.id} at transparency ${String(t)}`).toBeGreaterThan(0);
        expect(e.opacity).toBeLessThanOrEqual(1);
      }
    }
    // The floor is the NODE strength; search dims edges further, so a focus-dimmed
    // edge is never the binding case for I-F6.
    expect(SEARCH_EDGE_OPACITY).toBeLessThan(SEARCH_NODE_OPACITY);
  });
});

describe('I-F2 — focus changes no count, and no filter total', () => {
  it('hiddenByFilter and every projection count are identical with and without marks', () => {
    const base = boot();
    const expanded = {
      ...base,
      view: { ...base.view, expanded: new Set(['repo', 'pkg-a', 'dir-a', 'pkg-b', 'dir-b']) },
    };
    const before = scene(expanded);
    const after = scene(
      withMarks(expanded, [['pkg-a', 'out-of-focus'], ['file-a1', 'in-focus']], MAX),
    );
    expect(after.hiddenByFilter).toEqual(before.hiddenByFilter);
    expect(after.scene.nodes.length).toBe(before.scene.nodes.length);
    expect(after.scene.edges.length).toBe(before.scene.edges.length);
    expect(after.scene.edges.map((e) => e.count)).toEqual(before.scene.edges.map((e) => e.count));
    expect(after.scene.nodes.map((n) => n.hidden)).toEqual(before.scene.nodes.map((n) => n.hidden));
    // I-F7: geometry is not a function of focus either.
    expect(after.scene.nodes.map((n) => n.position)).toEqual(
      before.scene.nodes.map((n) => n.position),
    );
  });
});
