// The autosave hostile-input matrix (§11.8), and the fatal/recoverable split it exists
// to prove.
//
// This file exists because the first implementation of that split did not have one. Every
// recovery branch pushed its text into `problems[]` — the array `parseAutosaveView`
// throws on — so a line that literally read "focus marks were reset" reset nothing and
// discarded the user's entire saved layout. Five of the seven shapes the plan calls
// recoverable were fatal, and the tests that existed could not see it.
//
// So each case here asserts BOTH halves: that the session survived, and that the survival
// was reported. A repair nobody is told about is the defect this feature keeps
// rediscovering one layer down.

import { describe, expect, it } from 'vitest';
import {
  AUTOSAVE_VIEW_FORMAT_VERSION,
  AUTOSAVE_VIEW_SCHEMA,
  autosaveViewText,
  parseAutosaveView,
} from '../../src/contract/autosaveView.ts';
import { SchemaError } from '../../src/contract/errors.ts';
import { DEFAULT_LIMITS } from '../../src/contract/limits.ts';
import type { DocRevision } from '../../src/contract/revision.ts';
import type { JsonObject, JsonValue } from '../../src/contract/types.ts';

const REVISION = ('sha256:' + 'a'.repeat(64)) as DocRevision;

/** A realistic session: enough positions and expansion that losing them is a real loss. */
function baselineView(): JsonObject {
  const positions: JsonObject = {};
  for (let i = 0; i < 400; i += 1) positions[`n${i}`] = { x: i, y: i * 2 };
  return {
    positions,
    expanded: Array.from({ length: 60 }, (_, i) => `c${i}`),
    fitted: ['c0'],
    viewport: { x: 12, y: 34, zoom: 1.5 },
  };
}

function textWithFocus(focus: JsonValue | undefined): string {
  const view = baselineView();
  if (focus !== undefined) view['focus'] = focus;
  const base = JSON.parse(
    autosaveViewText({
      schema: AUTOSAVE_VIEW_SCHEMA,
      formatVersion: AUTOSAVE_VIEW_FORMAT_VERSION,
      projectId: 'p',
      docId: 'd',
      baseRevision: REVISION,
      savedAtUtc: '2026-07-25T00:00:00Z',
      view: {},
    }),
  ) as JsonObject;
  base['view'] = view;
  return JSON.stringify(base);
}

/** The session survived: every non-focus field is intact. */
function expectSessionIntact(view: {
  positions?: Record<string, unknown>;
  expanded?: string[];
  fitted?: string[];
  viewport?: { x: number; y: number; zoom: number };
}): void {
  expect(Object.keys(view.positions ?? {}).length).toBe(400);
  expect(view.expanded?.length).toBe(60);
  expect(view.fitted).toEqual(['c0']);
  expect(view.viewport).toEqual({ x: 12, y: 34, zoom: 1.5 });
}

describe('§11.8 — shapes the plan calls RECOVERABLE keep the rest of the view', () => {
  const recoverable: Array<[string, JsonValue]> = [
    ['transparency out of the band', { transparency: 200, marks: {} }],
    ['transparency is a string', { transparency: '70', marks: {} }],
    ['transparency is fractional', { transparency: 70.5, marks: {} }],
    ['focus is not an object', 'out-of-focus'],
    ['marks is not an object', { transparency: 70, marks: 'nope' }],
    ['a mark value from a newer minor', { transparency: 70, marks: { a: 'pinned' } }],
    ['a mark value that is not a string', { transparency: 70, marks: { a: 7 } }],
  ];

  for (const [name, focus] of recoverable) {
    it(`${name} — session survives and the repair is reported`, () => {
      const parsed = parseAutosaveView(textWithFocus(focus), DEFAULT_LIMITS);
      expectSessionIntact(parsed.view);
      // The other half. Without this assertion every case above passes on an
      // implementation that repairs silently, which is the defect one level down.
      expect(parsed.recovered.length).toBeGreaterThan(0);
    });
  }

  it('reports nothing when there is nothing to repair', () => {
    const parsed = parseAutosaveView(
      textWithFocus({ transparency: 70, marks: { a: 'out-of-focus' } }),
      DEFAULT_LIMITS,
    );
    expect(parsed.recovered).toEqual([]);
    expect(parsed.view.focus?.marks).toEqual({ a: 'out-of-focus' });
  });
});

describe('§11.8 — the repairs are the ones the plan specifies, not just "something"', () => {
  it('clamps an out-of-band transparency into the Limits band', () => {
    // Unclamped, 200 reaches `focusOpacity` as 1 - 200/100 = -1 and fails the renderer
    // port's `0 < opacity <= 1` assertion. This was the third door into ViewState and
    // the one that leaked.
    const high = parseAutosaveView(textWithFocus({ transparency: 200 }), DEFAULT_LIMITS);
    expect(high.view.focus?.transparency).toBe(DEFAULT_LIMITS.maxFocusTransparency);
    const low = parseAutosaveView(textWithFocus({ transparency: -5 }), DEFAULT_LIMITS);
    expect(low.view.focus?.transparency).toBe(DEFAULT_LIMITS.minFocusTransparency);
  });

  it('resets marks AS A UNIT when one entry is structurally invalid, keeping none', () => {
    // Per-ENTRY dropping is what this must not do: `marks` entries are coupled through
    // inheritance, so dropping one re-resolves an arbitrarily large subtree — and
    // dropping a child mark leaves the map darker than the user left it, which does not
    // look broken, it looks like a decision.
    const parsed = parseAutosaveView(
      textWithFocus({ marks: { parent: 'out-of-focus', child: 7 } }),
      DEFAULT_LIMITS,
    );
    expect(parsed.view.focus?.marks).toEqual({});
    expect(parsed.recovered.join(' ')).toContain('all of them were reset');
  });

  it('keeps the valid marks when the only fault is a token from a newer minor', () => {
    // Not a unit reset: an unknown token was never applied by this build, so ignoring it
    // changes nothing about what resolves here. Dropping it costs a newer build's state
    // in the cache, which the autosave's missing version locus already resigns.
    const parsed = parseAutosaveView(
      textWithFocus({ marks: { a: 'pinned', b: 'out-of-focus' } }),
      DEFAULT_LIMITS,
    );
    expect(parsed.view.focus?.marks).toEqual({ b: 'out-of-focus' });
    expect(parsed.recovered.join(' ')).toContain('newer version');
  });
});

describe('§11.8 — shapes the plan QUALIFIES as still fatal', () => {
  // `scanJson` runs before any field is read and throws on these. The plan carries the
  // qualifier rather than promising a recovery the code cannot deliver: a document-wide
  // safety scan with a per-field exception is a worse trade than a sentence.
  //
  // These two MUST be built by editing the JSON TEXT, not a JS object literal. `1e400`
  // in a literal becomes `Infinity` and `JSON.stringify` writes it as `null`; a
  // `__proto__` key in a literal sets the prototype and never becomes an own property.
  // Either way the hostile input never reaches the parser and the case passes while
  // testing nothing — the same trap the extraction owner hit and reported on its own
  // absence tests.
  const fatal: Array<[string, string, RegExp]> = [
    [
      'a non-finite number inside focus',
      textWithFocus({ transparency: 70 }).replace('"transparency":70', '"transparency":1e400'),
      /non-finite number at \$\.view\.focus\.transparency/,
    ],
    [
      'a prototype-pollution key inside marks',
      textWithFocus({ marks: { placeholder: 'out-of-focus' } }).replace(
        '"placeholder"',
        '"__proto__"',
      ),
      /dangerous key at \$\.view\.focus\.marks\.__proto__/,
    ],
  ];

  for (const [name, text, reason] of fatal) {
    it(`${name} is fatal, and fatal FOR THE STATED REASON`, () => {
      // Asserting only `toThrow(SchemaError)` would also pass on a JSON syntax error
      // introduced by the text surgery above, i.e. on a test that never delivered its
      // hostile input. The message is what distinguishes the two.
      let caught: unknown;
      try {
        parseAutosaveView(text, DEFAULT_LIMITS);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SchemaError);
      expect((caught as SchemaError).message).toMatch(reason);
    });
  }

  it('a malformed NON-focus field is still fatal — focus is the only recoverable one', () => {
    // The scoping is on principle: a cosmetic field must never discard real work, and
    // positions/expanded/viewport carry work whose partial acceptance is a genuine
    // semantic question. Their all-or-nothing behaviour is pre-existing and unchanged.
    const parsedBase = JSON.parse(textWithFocus(undefined)) as JsonObject;
    const view = parsedBase['view'] as JsonObject;
    (view['viewport'] as JsonObject)['zoom'] = 9999;
    expect(() => parseAutosaveView(JSON.stringify(parsedBase), DEFAULT_LIMITS)).toThrow(SchemaError);
  });
});
