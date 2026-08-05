// The version matrix (§3.4), the invariants (§4), and the hostile-input contract
// (§11). An imported document is untrusted input, and every one of these cases is a
// document someone can hand the app.

import { describe, expect, it } from 'vitest';
import {
  IncompatibleVersionError,
  IntegrityError,
  InvalidJsonError,
  SchemaError,
} from '../../src/contract/errors.ts';
import { importDoc } from '../../src/contract/load.ts';
import { SUPPORTED_MAJOR, SUPPORTED_MINOR } from '../../src/contract/validate.ts';
import { DEFAULT_LIMITS } from '../../src/contract/limits.ts';
import { utf8ByteLength } from '../../src/contract/json.ts';
import { docText, edge, node } from '../support/doc.ts';

const OK = docText([node('r', 'repository', null, { path: '' })], []);

describe('version matrix (§3.4)', () => {
  it('accepts 1.0', () => {
    expect(importDoc(OK).warnings).toHaveLength(0);
  });

  it('accepts an unknown MINOR, warns once, and preserves the extensions', () => {
    // DERIVED, never typed (#41). The property under test is "one minor above whatever
    // this build supports" — a literal encodes today's SUPPORTED_MINOR into a string
    // nothing updates. It does not rot silently: the day the project reaches that minor
    // the `unknown-minor` warning stops firing and this goes red. The trap is that the
    // failure points at the assertion rather than at the stale literal, so the obvious
    // repair is to bump the number, which restores green and defers the problem forever
    // — while the case name stops describing what the case does.
    const text = JSON.stringify({
      formatVersion: `${SUPPORTED_MAJOR}.${SUPPORTED_MINOR + 1}`,
      nodes: [node('r', 'repository', null)],
      edges: [],
      somethingFromTheFuture: { kept: true },
    });
    const loaded = importDoc(text);
    expect(loaded.warnings.filter((w) => w.code === 'unknown-minor')).toHaveLength(1);
    expect((loaded.raw as Record<string, unknown>)['somethingFromTheFuture']).toEqual({ kept: true });
  });

  it('opens READ-ONLY when requires[] carries something it cannot honour', () => {
    const text = JSON.stringify({
      formatVersion: '1.0',
      requires: ['multi-placement-outlines'],
      nodes: [node('r', 'repository', null)],
      edges: [],
    });
    const loaded = importDoc(text);
    expect(loaded.readOnly).toBe(true);
    expect(loaded.warnings.some((w) => w.code === 'read-only')).toBe(true);
  });

  it('rejects an unknown MAJOR, naming both versions', () => {
    const text = JSON.stringify({ formatVersion: '2.0', nodes: [], edges: [] });
    expect(() => importDoc(text)).toThrow(IncompatibleVersionError);
    try {
      importDoc(text);
    } catch (err) {
      expect((err as Error).message).toContain('2.0');
      expect((err as Error).message).toContain('1');
    }
  });

  it('rejects a missing or non-string formatVersion', () => {
    expect(() => importDoc(JSON.stringify({ nodes: [], edges: [] }))).toThrow(SchemaError);
    expect(() => importDoc(JSON.stringify({ formatVersion: 1, nodes: [], edges: [] }))).toThrow(
      SchemaError,
    );
  });

  it('rejects invalid JSON, carrying the engine message', () => {
    expect(() => importDoc('{ not json')).toThrow(InvalidJsonError);
  });
});

describe('integrity (I1–I4)', () => {
  it('rejects duplicate node ids', () => {
    const text = docText([node('a', 'file', null), node('a', 'file', null)], []);
    expect(() => importDoc(text)).toThrow(IntegrityError);
  });

  it('rejects duplicate edge ids', () => {
    const text = docText(
      [node('a', 'file', null), node('b', 'file', null)],
      [edge('e', 'imports', 'a', 'b'), edge('e', 'imports', 'b', 'a')],
    );
    expect(() => importDoc(text)).toThrow(IntegrityError);
  });

  it('rejects a parentId that names no node', () => {
    const text = docText([node('a', 'file', 'nope')], []);
    expect(() => importDoc(text)).toThrow(IntegrityError);
  });

  it('rejects a dangling edge endpoint', () => {
    const text = docText([node('a', 'file', null)], [edge('e', 'imports', 'a', 'ghost')]);
    expect(() => importDoc(text)).toThrow(IntegrityError);
  });

  it('rejects a CYCLE in the parent relation — projection is only defined on a tree (I3)', () => {
    const text = docText([node('a', 'dir', 'b'), node('b', 'dir', 'a')], []);
    expect(() => importDoc(text)).toThrow(IntegrityError);
    try {
      importDoc(text);
    } catch (err) {
      expect((err as Error).message).toContain('cycle');
    }
  });
});

describe('paths (I7, §11)', () => {
  const bad = [
    ['absolute', '/etc/passwd'],
    ['drive letter', 'C:/Users/secret'],
    ['UNC', '//server/share'],
    ['backslash', 'src\\main.ts'],
    ['parent segment', '../../etc/passwd'],
    ['empty segment', 'src//main.ts'],
  ] as const;

  for (const [label, path] of bad) {
    it(`rejects a ${label} in node.path`, () => {
      const text = docText([node('r', 'repository', null), node('a', 'file', 'r', { path })], []);
      expect(() => importDoc(text)).toThrow(SchemaError);
    });
  }

  it('rejects a NUL and a control character', () => {
    const withNul = docText(
      [node('r', 'repository', null), node('a', 'file', 'r', { path: 'src/\u0000evil.ts' })],
      [],
    );
    expect(() => importDoc(withNul)).toThrow(SchemaError);
    const withNewline = docText(
      [node('r', 'repository', null), node('a', 'file', 'r', { path: 'src/a\nb.ts' })],
      [],
    );
    expect(() => importDoc(withNewline)).toThrow(SchemaError);
  });

  it('rejects a bad path in EVIDENCE too, not only in node.path', () => {
    const text = docText(
      [node('r', 'repository', null, { evidence: [{ path: '/abs/olute' }] })],
      [],
    );
    expect(() => importDoc(text)).toThrow(SchemaError);
  });

  it('accepts path: "" ONLY for a root or a declared root anchor — the §3.2 erratum', () => {
    const root = docText([node('r', 'repository', null, { path: '' })], []);
    expect(() => importDoc(root)).not.toThrow();

    const anchor = docText(
      [
        node('r', 'repository', null, { path: '' }),
        node('p', 'package', 'r', { path: '', metadata: { rootAnchor: true } }),
      ],
      [],
    );
    expect(() => importDoc(anchor)).not.toThrow();

    // …and refuses it anywhere else, so the validator does not contradict itself.
    const bogus = docText(
      [node('r', 'repository', null, { path: '' }), node('f', 'file', 'r', { path: '' })],
      [],
    );
    expect(() => importDoc(bogus)).toThrow(SchemaError);
  });
});

describe('numbers and caps (I11, §11)', () => {
  it('rejects 1e400 — it parses to Infinity and would destroy a layout', () => {
    const text =
      '{"formatVersion":"1.0","nodes":[{"id":"r","kind":"repository","label":"r","parentId":null}],' +
      '"edges":[],"view":{"positions":{"r":{"x":1e400,"y":0}}}}';
    expect(() => importDoc(text)).toThrow(SchemaError);
  });

  it('rejects a non-finite number ANYWHERE, not only in view — it cannot round-trip', () => {
    const text =
      '{"formatVersion":"1.0","nodes":[{"id":"r","kind":"repository","label":"r","parentId":null,' +
      '"metadata":{"weight":1e400}}],"edges":[]}';
    expect(() => importDoc(text)).toThrow(SchemaError);
  });

  it('rejects a zoom outside its bounds', () => {
    const text = docText([node('r', 'repository', null)], [], {
      view: { viewport: { x: 0, y: 0, zoom: 0 } },
    });
    expect(() => importDoc(text)).toThrow(SchemaError);
  });

  it('rejects a coordinate outside its bounds', () => {
    const text = docText([node('r', 'repository', null)], [], {
      view: { positions: { r: { x: DEFAULT_LIMITS.maxCoordinate * 10, y: 0 } } },
    });
    expect(() => importDoc(text)).toThrow(SchemaError);
  });

  it('rejects a depth bomb before it can hang the tab', () => {
    let payload = '1';
    for (let i = 0; i < DEFAULT_LIMITS.maxDepth + 20; i += 1) payload = `[${payload}]`;
    const text = `{"formatVersion":"1.0","nodes":[],"edges":[],"bomb":${payload}}`;
    expect(() => importDoc(text)).toThrow(SchemaError);
  });

  it('rejects an over-long string', () => {
    const text = docText(
      [node('r', 'repository', null, { label: 'x'.repeat(DEFAULT_LIMITS.maxStringLength + 1) })],
      [],
    );
    expect(() => importDoc(text)).toThrow(SchemaError);
  });

  it('rejects a document over the byte cap', () => {
    const tiny = { ...DEFAULT_LIMITS, maxBytes: 10 };
    expect(() => importDoc(OK, tiny)).toThrow(SchemaError);
  });

  it('measures the cap in UTF-8 BYTES, not UTF-16 code units', () => {
    // A document that fits comfortably by `.length` and does NOT fit in bytes. The first
    // cut compared `text.length`, so a document of CJK or emoji could be up to three
    // times the size the cap allowed — a strange way for a denial-of-service guard to
    // behave, and not what `maxBytes` says.
    const label = '中'.repeat(300); // 300 code units, 900 UTF-8 bytes
    const text = docText([node('r', 'repository', null, { label })], []);
    expect(text.length).toBeLessThan(700);
    expect(utf8ByteLength(text)).toBeGreaterThan(700);

    const limits = { ...DEFAULT_LIMITS, maxBytes: 700 };
    expect(() => importDoc(text, limits)).toThrow(SchemaError);
    try {
      importDoc(text, limits);
    } catch (err) {
      expect((err as SchemaError).message).toContain('byte');
    }

    // …and the same document is accepted once the cap really does cover its bytes.
    expect(() => importDoc(text, { ...DEFAULT_LIMITS, maxBytes: 4000 })).not.toThrow();
  });

  it('counts a surrogate pair as four bytes, not six', () => {
    expect(utf8ByteLength('a')).toBe(1);
    expect(utf8ByteLength('ñ')).toBe(2);
    expect(utf8ByteLength('中')).toBe(3);
    expect(utf8ByteLength('🙈')).toBe(4); // one code point, two UTF-16 code units
    expect(utf8ByteLength('a中🙈')).toBe(1 + 3 + 4);
  });

  it('rejects a document over the node cap', () => {
    const tiny = { ...DEFAULT_LIMITS, maxNodes: 1 };
    const text = docText([node('r', 'repository', null), node('a', 'file', 'r')], []);
    expect(() => importDoc(text, tiny)).toThrow(SchemaError);
  });
});

describe('prototype pollution (§11)', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    it(`HARD-REJECTS "${key}" as a key, anywhere — the one place forward-compatibility yields to safety`, () => {
      const text = `{"formatVersion":"1.0","nodes":[],"edges":[],"metadata":{"deep":{"${key}":{"polluted":true}}}}`;
      expect(() => importDoc(text)).toThrow(SchemaError);
      // …and it did not pollute anything on the way to being refused.
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    });
  }
});

describe('free-form fields are scanned, never rewritten (§11)', () => {
  it('warns about an absolute-path-looking label rather than silently cleaning it', () => {
    const text = docText(
      [node('r', 'repository', null, { label: 'C:/Users/maria/secret/repo' })],
      [],
    );
    const loaded = importDoc(text);
    expect(loaded.warnings.some((w) => w.code === 'absolute-path-in-free-form-field')).toBe(true);
    // Not rewritten. Claiming it was clean would be a lie.
    expect(loaded.model.nodes[0]?.label).toBe('C:/Users/maria/secret/repo');
  });

  it('warns when the document carries verbatim snippets', () => {
    const text = docText(
      [node('r', 'repository', null, { evidence: [{ path: 'a.ts', line: 1, snippet: 'const KEY = "sk-live-123"' }] })],
      [],
    );
    const loaded = importDoc(text);
    expect(loaded.warnings.some((w) => w.code === 'snippet-present')).toBe(true);
  });
});
