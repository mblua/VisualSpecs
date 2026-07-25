// Export of `view.focus` (§5.2, §5.3): what it preserves, and what it must NOT invent.
//
// The second half is the reason this file exists. The first implementation wrote
// `transparency` and a `marks` object unconditionally, so a document that declared
// NEITHER came back declaring BOTH — an absence turned into a value, which is the exact
// inversion of the lesson `viewProvided` exists to teach for `expanded: []`. And the
// existing byte-identity test could not see it, because it only covers documents with no
// `focus` key at all, which is the one case where the bug is invisible.

import { describe, expect, it } from 'vitest';
import { exportDoc } from '../../src/contract/export.ts';
import { importDoc } from '../../src/contract/load.ts';
import { DEFAULT_LIMITS, LimitsError } from '../../src/contract/limits.ts';
import { FOCUS_TRANSPARENCY_DEFAULT, withFocus, type FocusMark } from '../../src/contract/view.ts';
import type { JsonObject } from '../../src/contract/types.ts';
import { docText, edge, node } from '../support/doc.ts';

/** A document with a FULLY SPECIFIED `view`, so a round trip is byte-identical for
 *  reasons that have nothing to do with focus. `mergeView` has always written
 *  `positions` and `viewport` unconditionally, so an extractor-shaped fixture — no
 *  `view` at all — gains them and fails for an unrelated, pre-existing reason. */
function docWith(view: JsonObject, extra: JsonObject = {}): string {
  // Nodes in ID ORDER, because `canonicaliseGraphArrays` sorts them: an unsorted fixture
  // fails a byte-identity assertion for a pre-existing reason that has nothing to do with
  // focus, which is exactly the trap §13 warns about.
  return docText(
    [node('a', 'file', 'repo', { path: 'a.ts' }), node('repo', 'repository', null, { path: '' })],
    [edge('e1', 'imports', 'a', 'a')],
    { view, ...extra },
  );
}

const FULL_VIEW: JsonObject = {
  positions: { repo: { x: 0, y: 0 }, a: { x: 10, y: 10 } },
  expanded: ['repo'],
  viewport: { x: 0, y: 0, zoom: 1 },
};

function reexport(text: string): JsonObject {
  const loaded = importDoc(text);
  const out = exportDoc({ raw: loaded.raw, view: loaded.view, readOnly: false });
  return JSON.parse(out) as JsonObject;
}

describe('an unusable transparency band is a CALLER bug and is rejected', () => {
  // `limits.ts` promised in as many words that a cosmetic policy value must not be able
  // to fail a port invariant, and nothing enforced it: four consumers read
  // `maxFocusTransparency` and none validated it. At 100 the derived opacity is 0, which
  // is exactly what the renderer port's `0 < opacity <= 1` assertion exists to catch.
  const band = (over: Partial<typeof DEFAULT_LIMITS>) => ({ ...DEFAULT_LIMITS, ...over });

  it('rejects maxFocusTransparency at 100, where the opacity would be 0', () => {
    expect(() => importDoc(docWith(FULL_VIEW), band({ maxFocusTransparency: 100 }))).toThrow(
      LimitsError,
    );
  });

  it('rejects a band that is inverted or non-integer', () => {
    expect(() =>
      importDoc(docWith(FULL_VIEW), band({ minFocusTransparency: 80, maxFocusTransparency: 78 })),
    ).toThrow(LimitsError);
    expect(() => importDoc(docWith(FULL_VIEW), band({ maxFocusTransparency: 77.5 }))).toThrow(
      LimitsError,
    );
  });

  it('accepts the shipped band, so the guard is not simply refusing everything', () => {
    // Without this a broken `assertLimits` that always threw would pass both cases above.
    expect(() => importDoc(docWith(FULL_VIEW), DEFAULT_LIMITS)).not.toThrow();
  });
});

describe('export invents nothing under view.focus', () => {
  it('a document with NO focus key round-trips byte-identically and gains none', () => {
    const text = docWith(FULL_VIEW);
    const loaded = importDoc(text);
    const out = exportDoc({ raw: loaded.raw, view: loaded.view, readOnly: false });
    expect(JSON.parse(out)).toEqual(JSON.parse(text));
    expect((JSON.parse(out) as JsonObject)['formatVersion']).toBe('1.0');
    expect(Object.keys((JSON.parse(out) as { view: JsonObject }).view)).not.toContain('focus');
  });

  it('a focus subtree of ONLY unknown keys keeps them and gains neither transparency nor marks', () => {
    // The measured case: `{"groups":[…]}` used to come back as
    // `{"groups":[…],"marks":{},"transparency":70}` — two decisions nobody made.
    const text = docWith({ ...FULL_VIEW, focus: { groups: [{ name: 'backend', ids: ['a'] }] } });
    const view = reexport(text)['view'] as JsonObject;
    const focus = view['focus'] as JsonObject;
    expect(focus['groups']).toEqual([{ name: 'backend', ids: ['a'] }]);
    expect('transparency' in focus).toBe(false);
    expect('marks' in focus).toBe(false);
    // And the version is not raised for a focus state that says nothing.
    expect(reexport(text)['formatVersion']).toBe('1.0');
  });

  it('a declared but EMPTY focus object survives a no-op round trip', () => {
    // `focus: {}` is a value, like `"fitted": []`. The #13 bug this feature fixes was
    // deleting exactly that kind of declared emptiness.
    const text = docWith({ ...FULL_VIEW, focus: {} });
    const view = reexport(text)['view'] as JsonObject;
    expect('focus' in view).toBe(true);
    expect(view['focus']).toEqual({});
  });

  it('writes transparency when the document declared it, even at the default value', () => {
    const text = docWith({ ...FULL_VIEW, focus: { transparency: FOCUS_TRANSPARENCY_DEFAULT } });
    const focus = (reexport(text)['view'] as JsonObject)['focus'] as JsonObject;
    expect(focus['transparency']).toBe(FOCUS_TRANSPARENCY_DEFAULT);
  });

  it('writes transparency when a person changed it, and raises the version', () => {
    const loaded = importDoc(docWith(FULL_VIEW));
    const view = withFocus(loaded.view, { marks: new Map(), transparency: 40 });
    const out = JSON.parse(exportDoc({ raw: loaded.raw, view, readOnly: false })) as JsonObject;
    expect(((out['view'] as JsonObject)['focus'] as JsonObject)['transparency']).toBe(40);
    expect(out['formatVersion']).toBe('1.2');
  });

  it('rejects an unknown mark token at a minor this build knows', () => {
    // At or below `SUPPORTED_MINOR` an unrecognised token is a problem, not a warning:
    // this build owns the whole value domain at its own version.
    const text = docWith({ ...FULL_VIEW, focus: { marks: { repo: 'muted' } } });
    expect(() => importDoc(text)).toThrow(/must be "out-of-focus" or "in-focus"/);
  });

  it('writes marks when there are marks, and preserves an unknown token beside them', () => {
    // Above `SUPPORTED_MINOR` the same token is a warning and survives export verbatim,
    // because the additive-minor contract has to hold on the one axis this shape extends.
    const higher = docWith({ ...FULL_VIEW, focus: { marks: { repo: 'muted' } } }, {
      formatVersion: '1.3',
    });
    const l = importDoc(higher);
    expect(l.warnings.map((w) => w.code)).toContain('unknown-focus-mark');
    const marked = withFocus(l.view, {
      marks: new Map<string, FocusMark>([['a', 'out-of-focus']]),
      transparency: l.view.focus.transparency,
    });
    const out = JSON.parse(exportDoc({ raw: l.raw, view: marked, readOnly: false })) as JsonObject;
    const focus = (out['view'] as JsonObject)['focus'] as JsonObject;
    // The typed state wins for ids it contains; the unknown token is preserved verbatim.
    expect(focus['marks']).toEqual({ a: 'out-of-focus', repo: 'muted' });
    // 1.3 is not lowered.
    expect(out['formatVersion']).toBe('1.3');
  });
});
