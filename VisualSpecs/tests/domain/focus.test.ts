// Focus resolution, the write rule, and the global toggle (Issue #17, §4.2–§4.6, §6).
//
// Almost every case here exists because a review found the obvious implementation
// wrong. Where that is true the comment says which failure the case pins, because a
// test whose reason is not written down is a test someone deletes as redundant.

import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from '../../src/contract/limits.ts';
import { importDoc } from '../../src/contract/load.ts';
import type { FocusMark, ViewState } from '../../src/contract/view.ts';
import { emptyFocus, withFocus } from '../../src/contract/view.ts';
import { applyViewCommand, type CommandContext, type ViewCommand } from '../../src/domain/commands.ts';
import {
  aggregateFocusOpacity,
  computeSubtreeDiffers,
  focusOpacity,
  resolveFocus,
} from '../../src/domain/focus.ts';
import { computeGeometry } from '../../src/domain/layoutEngine.ts';
import { OwnershipOutline } from '../../src/domain/outline.ts';
import { computeVisibility } from '../../src/domain/visibility.ts';
import { docText, node, sampleDoc } from '../support/doc.ts';

function setup(text: string = sampleDoc()) {
  const loaded = importDoc(text);
  const outline = new OwnershipOutline(loaded.model);
  const geometry = computeGeometry(loaded.model, outline, loaded.view.expanded, loaded.view.positions);
  const ctx: CommandContext = { model: loaded.model, outline, geometry, limits: DEFAULT_LIMITS };
  return { loaded, outline, ctx };
}

function marksOf(view: ViewState): Record<string, FocusMark> {
  return Object.fromEntries([...view.focus.marks.entries()].sort()) as Record<string, FocusMark>;
}

function run(ctx: CommandContext, view: ViewState, ...cmds: ViewCommand[]): ViewState {
  let next = view;
  for (const cmd of cmds) next = applyViewCommand(ctx, next, cmd);
  return next;
}

describe('resolveFocus (§4.2)', () => {
  it('resolves every outline node, with no marks, to in focus', () => {
    const { loaded, outline } = setup();
    const effective = resolveFocus(outline, new Map());
    // Totality is the claim: I2/I3 + assertInjective mean no model node is unplaced or
    // unreachable, so the walk assigns a state to every one of them.
    expect(effective.size).toBe(loaded.model.nodes.length);
    expect([...effective.values()].every((v) => v === 'in')).toBe(true);
  });

  it('inherits down a subtree, and an explicit in-focus mark overrides an out-of-focus ancestor', () => {
    const { outline } = setup();
    const effective = resolveFocus(
      outline,
      new Map<string, FocusMark>([
        ['pkg-a', 'out-of-focus'],
        ['file-a1', 'in-focus'],
      ]),
    );
    expect(effective.get('pkg-a')).toBe('out');
    expect(effective.get('dir-a')).toBe('out');
    expect(effective.get('file-a2')).toBe('out');
    // The override, which is the only reason the tri-state model exists.
    expect(effective.get('file-a1')).toBe('in');
    // A sibling subtree is untouched.
    expect(effective.get('pkg-b')).toBe('in');
    expect(effective.get('file-b1')).toBe('in');
  });

  it('lets the nearest mark win down an alternating chain', () => {
    const { outline } = setup();
    const effective = resolveFocus(
      outline,
      new Map<string, FocusMark>([
        ['repo', 'out-of-focus'],
        ['pkg-a', 'in-focus'],
        ['dir-a', 'out-of-focus'],
        ['file-a1', 'in-focus'],
      ]),
    );
    expect(effective.get('repo')).toBe('out');
    expect(effective.get('pkg-a')).toBe('in');
    expect(effective.get('dir-a')).toBe('out');
    expect(effective.get('file-a2')).toBe('out');
    expect(effective.get('file-a1')).toBe('in');
    // Inherited from `repo`, not from `pkg-a`.
    expect(effective.get('pkg-b')).toBe('out');
  });
});

describe('§4.4 — the subtree flag means "differs from mine", not "contains an out-of-focus entity"', () => {
  // The v2 flag was "the hidden subtree contains an out-of-focus entity". Under a
  // DIMMED box that is always true, so it carried no information exactly where the
  // tri-state model needs it: a representative could signal "something below me is
  // dimmed" and never "something below me is LIT".
  function differsUnder(marks: Map<string, FocusMark>) {
    const { outline } = setup();
    // Only the roots are expanded initially, so pkg-a/pkg-b are collapsed
    // representatives with hidden subtrees.
    const { nva } = computeVisibility(outline, new Set(['repo']));
    return computeSubtreeDiffers(nva, resolveFocus(outline, marks));
  }

  it('flags a bright box with a dimmed descendant', () => {
    const differs = differsUnder(new Map([['file-a1', 'out-of-focus']]));
    expect(differs.has('pkg-a')).toBe(true);
  });

  it('flags a dimmed box with a re-lit descendant — the case a one-bit flag could not express', () => {
    const differs = differsUnder(
      new Map<string, FocusMark>([
        ['pkg-a', 'out-of-focus'],
        ['file-a1', 'in-focus'],
      ]),
    );
    expect(differs.has('pkg-a')).toBe(true);
  });

  it('does NOT flag a dimmed box whose whole subtree is dimmed with it', () => {
    // This is the row that renders identically to the one above under the v2 flag.
    const differs = differsUnder(new Map([['pkg-a', 'out-of-focus']]));
    expect(differs.has('pkg-a')).toBe(false);
  });
});

describe('§4.3 — an aggregate carries the fraction of what it stands for', () => {
  const t = 70;
  const dim = focusOpacity(t);

  it('is exact at ×1, so the boolean rule is a special case', () => {
    expect(aggregateFocusOpacity(t, 0, 1)).toBeCloseTo(dim, 10);
    expect(aggregateFocusOpacity(t, 1, 1)).toBe(1);
  });

  it('returns 1 for a carrier with no resolvable relations (the vacuous-truth guard)', () => {
    // `[].every(...)` is true, so an "every relation is out" rule would dim a line with
    // no marks present at all and break I-F4 at the scene level.
    expect(aggregateFocusOpacity(t, 0, 0)).toBe(1);
  });

  it('is monotone in the bright fraction', () => {
    const values = [0, 1, 5, 14, 68, 135, 136].map((b) => aggregateFocusOpacity(t, b, 136));
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i] as number).toBeGreaterThanOrEqual(values[i - 1] as number);
    }
  });

  it('lifts ANY non-zero fraction clear of the all-off value', () => {
    // The measured failure: with the plain continuous form, 1/136 bright moved the line
    // by 0.007 of contrast — one 8-bit step — so re-lighting one entity of 21 was
    // invisible on exactly the aggregate the rule was introduced for.
    const allOff = aggregateFocusOpacity(t, 0, 136);
    const oneBright = aggregateFocusOpacity(t, 1, 136);
    const floorLift = (1 - dim) * 0.1;
    expect(oneBright - allOff).toBeGreaterThanOrEqual(floorLift - 1e-12);
  });

  it('never exceeds 1, whatever the floor', () => {
    expect(aggregateFocusOpacity(10, 1, 1, 0.9)).toBe(1);
    expect(aggregateFocusOpacity(78, 136, 136, 0.9)).toBe(1);
  });
});

describe('§4.5 — the minimal-mark write rule', () => {
  it('reproduces the four-step table, leaving no residual mark at step 3', () => {
    const { loaded, ctx } = setup();
    let view = loaded.view;

    view = run(ctx, view, { type: 'SetFocus', id: 'pkg-a', requested: 'out-of-focus' });
    expect(marksOf(view)).toEqual({ 'pkg-a': 'out-of-focus' });

    view = run(ctx, view, { type: 'SetFocus', id: 'file-a1', requested: 'in-focus' });
    expect(marksOf(view)).toEqual({ 'file-a1': 'in-focus', 'pkg-a': 'out-of-focus' });

    // Step 3 is the whole point: "undo my own dimming" DELETES pkg-a's mark instead of
    // writing an in-focus one. The naive rule left `pkg-a: in-focus` here...
    view = run(ctx, view, { type: 'SetFocus', id: 'pkg-a', requested: 'in-focus' });
    expect(marksOf(view)).toEqual({ 'file-a1': 'in-focus' });

    // ...and that residue then refused to dim, when the user asked to dim everything
    // above it. Here pkg-a dims and only the genuine exception stays lit.
    view = run(ctx, view, { type: 'SetFocus', id: 'repo', requested: 'out-of-focus' });
    expect(marksOf(view)).toEqual({ 'file-a1': 'in-focus', repo: 'out-of-focus' });
    const effective = resolveFocus(setup().outline, view.focus.marks);
    expect(effective.get('pkg-a')).toBe('out');
    expect(effective.get('file-a2')).toBe('out');
    expect(effective.get('file-a1')).toBe('in');
  });

  it('WRITES out-of-focus over an own in-focus mark when no ancestor is marked', () => {
    // The literal symmetric rule would have deleted the mark and left the node IN
    // focus — the opposite of what was asked. This is why the general form is needed.
    const { loaded, ctx } = setup();
    let view = withFocus(loaded.view, {
      marks: new Map<string, FocusMark>([['file-a1', 'in-focus']]),
      transparency: emptyFocus().transparency,
    });
    view = run(ctx, view, { type: 'SetFocus', id: 'file-a1', requested: 'out-of-focus' });
    expect(marksOf(view)).toEqual({ 'file-a1': 'out-of-focus' });
    expect(resolveFocus(setup().outline, view.focus.marks).get('file-a1')).toBe('out');
  });

  it('§4.6 keeps a mark that becomes redundant later', () => {
    const { loaded, ctx } = setup();
    let view = run(
      ctx,
      loaded.view,
      { type: 'SetFocus', id: 'pkg-a', requested: 'out-of-focus' },
      { type: 'SetFocus', id: 'file-a1', requested: 'in-focus' },
      { type: 'SetFocus', id: 'pkg-a', requested: 'in-focus' },
    );
    // file-a1's mark now agrees with what it would inherit. It is KEPT, because
    // re-dimming the parent must not lose the exception the user made.
    expect(marksOf(view)).toEqual({ 'file-a1': 'in-focus' });
    view = run(ctx, view, { type: 'SetFocus', id: 'pkg-a', requested: 'out-of-focus' });
    expect(resolveFocus(setup().outline, view.focus.marks).get('file-a1')).toBe('in');
  });

  it('SetFocusInherited deletes only that node’s own mark', () => {
    const { loaded, ctx } = setup();
    const view = run(
      ctx,
      loaded.view,
      { type: 'SetFocus', id: 'pkg-a', requested: 'out-of-focus' },
      { type: 'SetFocus', id: 'file-a1', requested: 'in-focus' },
      { type: 'SetFocusInherited', id: 'file-a1' },
    );
    expect(marksOf(view)).toEqual({ 'pkg-a': 'out-of-focus' });
  });

  it('I-F8: marking a descendant never changes an ancestor’s mark, or the reverse', () => {
    const { loaded, ctx } = setup();
    const view = run(
      ctx,
      loaded.view,
      { type: 'SetFocus', id: 'file-a1', requested: 'out-of-focus' },
      { type: 'SetFocus', id: 'repo', requested: 'out-of-focus' },
    );
    expect(marksOf(view)).toEqual({ 'file-a1': 'out-of-focus', repo: 'out-of-focus' });
  });

  it('returns the same view reference for a no-op', () => {
    const { loaded, ctx } = setup();
    const once = run(ctx, loaded.view, { type: 'SetFocus', id: 'pkg-a', requested: 'out-of-focus' });
    const twice = applyViewCommand(ctx, once, {
      type: 'SetFocus',
      id: 'pkg-a',
      requested: 'out-of-focus',
    });
    expect(twice).toBe(once);
    expect(applyViewCommand(ctx, loaded.view, { type: 'SetFocusInherited', id: 'pkg-a' })).toBe(
      loaded.view,
    );
  });
});

describe('§6 — SetAllFocus and the confirmation predicate', () => {
  it('clears in-model marks and marks the roots, and in-focus leaves nothing', () => {
    const { loaded, ctx } = setup();
    const dimmed = run(
      ctx,
      loaded.view,
      { type: 'SetFocus', id: 'file-a1', requested: 'out-of-focus' },
      { type: 'SetAllFocus', mark: 'out-of-focus' },
    );
    expect(marksOf(dimmed)).toEqual({ repo: 'out-of-focus' });
    const cleared = run(ctx, dimmed, { type: 'SetAllFocus', mark: 'in-focus' });
    expect(marksOf(cleared)).toEqual({});
  });

  it('preserves INERT marks, exactly as ResetLayout preserves inert positions', () => {
    const { loaded, ctx } = setup();
    const withInert = withFocus(loaded.view, {
      marks: new Map<string, FocusMark>([
        ['file-a1', 'out-of-focus'],
        ['ghost-from-another-commit', 'out-of-focus'],
      ]),
      transparency: emptyFocus().transparency,
    });
    const cleared = run(ctx, withInert, { type: 'SetAllFocus', mark: 'in-focus' });
    expect(marksOf(cleared)).toEqual({ 'ghost-from-another-commit': 'out-of-focus' });
  });

  it('clamps SetFocusTransparency into the injected band and ignores non-finite input', () => {
    const { loaded, ctx } = setup();
    expect(run(ctx, loaded.view, { type: 'SetFocusTransparency', percent: 999 }).focus.transparency)
      .toBe(DEFAULT_LIMITS.maxFocusTransparency);
    expect(run(ctx, loaded.view, { type: 'SetFocusTransparency', percent: -5 }).focus.transparency)
      .toBe(DEFAULT_LIMITS.minFocusTransparency);
    expect(run(ctx, loaded.view, { type: 'SetFocusTransparency', percent: 42.4 }).focus.transparency)
      .toBe(42);
    expect(
      applyViewCommand(ctx, loaded.view, { type: 'SetFocusTransparency', percent: Number.NaN }),
    ).toBe(loaded.view);
  });

  // The predicate is `inverse(apply(view)).marks !== view.marks`. Two earlier
  // formulations were false for MORE THAN ONE ROOT, where the damage is done by ADDING
  // a mark rather than deleting one — and the committed corpus has exactly one root, so
  // a test written against it would be green forever.
  describe('the confirmation predicate needs a TWO-ROOT fixture', () => {
    const twoRoots = docText(
      [
        node('r1', 'repository', null, { path: 'one' }),
        node('r2', 'repository', null, { path: 'two' }),
        node('f1', 'file', 'r1', { path: 'one/a.ts' }),
      ],
      [],
    );

    function roundTrips(view: ViewState, mark: FocusMark, ctx: CommandContext): boolean {
      const there = applyViewCommand(ctx, view, { type: 'SetAllFocus', mark });
      const inverse: FocusMark = mark === 'out-of-focus' ? 'in-focus' : 'out-of-focus';
      const back = applyViewCommand(ctx, there, { type: 'SetAllFocus', mark: inverse });
      const a = JSON.stringify(marksOf(view));
      const b = JSON.stringify(marksOf(back));
      return a === b;
    }

    it('needs no confirmation when only root marks exist and there is one root', () => {
      const { loaded, ctx } = setup();
      const dimmed = run(ctx, loaded.view, { type: 'SetAllFocus', mark: 'out-of-focus' });
      expect(roundTrips(dimmed, 'in-focus', ctx)).toBe(true);
    });

    it('DOES need confirmation with two roots and only one of them marked', () => {
      const { loaded, ctx } = setup(twoRoots);
      const half = run(ctx, loaded.view, { type: 'SetFocus', id: 'r1', requested: 'out-of-focus' });
      expect(marksOf(half)).toEqual({ r1: 'out-of-focus' });
      // Pressing the toggle dims r2 as well, and the inverse clears everything: the
      // user's deliberate "half the map dimmed" is unrecoverable. Both discarded
      // formulations classified this as needing no confirmation.
      expect(roundTrips(half, 'out-of-focus', ctx)).toBe(false);
    });

    it('DOES need confirmation when an override would be deleted', () => {
      const { loaded, ctx } = setup();
      const withOverride = run(
        ctx,
        loaded.view,
        { type: 'SetAllFocus', mark: 'out-of-focus' },
        { type: 'SetFocus', id: 'file-a1', requested: 'in-focus' },
      );
      expect(roundTrips(withOverride, 'in-focus', ctx)).toBe(false);
    });
  });
});

describe('I-F7 — no focus command touches layout, expansion or the viewport', () => {
  it('leaves positions, expanded, fitted and viewport identical', () => {
    const { loaded, ctx } = setup();
    const before = loaded.view;
    const after = run(
      ctx,
      before,
      { type: 'SetFocus', id: 'pkg-a', requested: 'out-of-focus' },
      { type: 'SetFocus', id: 'file-a1', requested: 'in-focus' },
      { type: 'SetFocusTransparency', percent: 33 },
      { type: 'SetAllFocus', mark: 'out-of-focus' },
      { type: 'SetFocusInherited', id: 'repo' },
    );
    expect(after.positions).toBe(before.positions);
    expect(after.expanded).toBe(before.expanded);
    expect(after.fitted).toBe(before.fitted);
    expect(after.viewport).toBe(before.viewport);
  });
});
