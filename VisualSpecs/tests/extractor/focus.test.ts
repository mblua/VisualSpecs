// I-F9, second half (RFC 17 §9): no extractor ever emits `view.focus`.
//
// Focus is a human statement about attention — "I decided to push this into the
// background" — and it must never arrive with the authority of an observation about
// the code. Today the extractor has no concept of focus at all, so this holds by
// construction. These tests exist so that it holds by ASSERTION: the obvious future
// feature ("auto-dim tests", "auto-dim vendor") would have a tool writing a human
// decision through the channel that means *a person said so*. A machine suggestion
// about attention must travel under a different, derived, recomputed key. Arriving
// there should be a decision, not an accident nobody noticed.
//
// Two things are checked deliberately on the EMITTED TEXT rather than on the
// validated `doc`:
//
//  * `validate.ts` `validateView` is an allowlist — it copies `positions`,
//    `expanded`, `fitted` and `viewport` into the typed view and drops everything
//    else. Asserting `doc.view.focus === undefined` would therefore pass even if the
//    extractor emitted focus, which is a test that cannot fail.
//  * the first half of I-F9 (focus never in `nodes[].metadata`, `edges[].metadata`,
//    `evidence[]` or `unresolved[]`) is only visible in the raw tree: `metadata` is a
//    free-form `Record<string, unknown>` the validator accepts without inspection.
//
// Like every other extractor test, this runs against the fixture repo (§10.7): Visual
// Specs must pass on a clean checkout where AgentsCommander is simply absent. The
// committed corpus is read as a file, which is exactly how it would reach a git diff.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extract, type ExtractOptions } from '../../tools/extractor/extract.ts';
import { writeFileAtomic } from '../../tools/extractor/output.ts';
import { makeFixtureRepo, type FixtureRepo } from '../support/fixtureRepo.ts';

const CORPUS = fileURLToPath(new URL('../../data/agentscommander.json', import.meta.url));

let fixture: FixtureRepo;
let emittedText: string;

const options = (over: Partial<ExtractOptions> = {}): ExtractOptions => ({
  repo: fixture.root,
  out: 'data/fixture.json',
  name: 'fixture',
  hierarchy: 'logical',
  invokeFacade: 'transport.invoke',
  allowBareInvoke: false,
  snippets: false,
  tsconfig: undefined,
  flags: ['--hierarchy', 'logical'],
  stamp: false,
  ...over,
});

beforeAll(() => {
  fixture = makeFixtureRepo();
  emittedText = extract(options()).text;
});

afterAll(() => {
  fixture?.cleanup(); // see #54: `beforeAll` can throw before assigning
});

interface EmittedDoc {
  formatVersion?: unknown;
  view?: Record<string, unknown>;
}

const parse = (text: string): EmittedDoc => JSON.parse(text) as EmittedDoc;

/**
 * Every path at which `key` appears as an object key, anywhere in the tree.
 *
 * A substring search for `"focus"` would be simpler and wrong: a repository is
 * allowed to contain a file called `focus.ts`, and the id of that node is not a
 * focus mark. This looks at keys, and reports where it found them so a failure names
 * the offending location instead of merely asserting false.
 */
function pathsToKey(value: unknown, key: string): string[] {
  const found: string[] = [];
  const walk = (v: unknown, path: string): void => {
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        walk(item, `${path}[${i}]`);
      });
      return;
    }
    if (v === null || typeof v !== 'object') return;
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      if (k === key) found.push(`${path}.${k}`);
      walk(child, `${path}.${k}`);
    }
  };
  walk(value, '$');
  return found;
}

describe('the extractor has no opinion about focus (RFC 17 I-F9)', () => {
  it('a fresh extract declares 1.0 and emits a view of exactly one key: expanded', () => {
    const doc = parse(emittedText);
    // `formatVersion` is the literal in extract.ts. A fresh document carries no view
    // state a human authored, so nothing may raise it: 1.1 would mean `fitted`, 1.2
    // would mean `focus`, and the extractor produces neither.
    expect(doc.formatVersion).toBe('1.0');
    expect(Object.keys(doc.view ?? {})).toEqual(['expanded']);
    expect(doc.view?.['expanded']).toEqual(['repo:fixture']);
  });

  it('emits no `focus` key ANYWHERE — not in view, not in metadata, not in evidence', () => {
    // The whole of I-F9 from the extraction side, in one assertion: focus state lives
    // only under `view.focus`, written only by a human action, and `metadata` is
    // extractor territory that is regenerated on every run.
    expect(pathsToKey(parse(emittedText), 'focus')).toEqual([]);
  });

  it('the committed AgentsCommander corpus carries no focus state either', () => {
    // The corpus is the extractor's output under version control: whatever it holds
    // is what a reader of this repository receives. A `focus` key here would mean a
    // human attention preference was committed as though it were part of the map.
    const corpus = readFileSync(CORPUS, 'utf8');
    expect(pathsToKey(parse(corpus), 'focus')).toEqual([]);
    expect(
      parse(corpus).formatVersion,
      'the committed corpus is a fresh extract; a raised minor means view state was committed with it',
    ).toBe('1.0');
  });

  it('re-extracting over a document that HAS focus replaces the whole view subtree', () => {
    // The known limit recorded in RFC 17 §13, made executable rather than left to be
    // rediscovered: a CLI re-extraction publishing over an existing document does not
    // preserve ANY view key — `focus`, `positions`, `fitted` and `viewport` alike —
    // and says nothing about it. `refresh()` in the app is the path that carries view
    // state across a re-extraction (it keeps the in-memory view and reports its
    // losses); publishing over a file is not that path and never was.
    //
    // This is asserted, not endorsed. If the extractor ever learns to preserve a view
    // it did not write, this test is the one that should be rewritten first.
    const root = mkdtempSync(join(tmpdir(), 'vs-focus-'));
    try {
      const before = parse(emittedText);
      const human = {
        ...before,
        formatVersion: '1.2',
        view: {
          expanded: ['repo:fixture'],
          positions: { 'file:src/main.ts': { x: 100, y: 200, pinned: true } },
          fitted: ['dir:src'],
          focus: { transparency: 60, marks: { 'dir:src': 'out', 'file:src/main.ts': 'in' } },
          viewport: { x: 10, y: 20, zoom: 1.5 },
        },
      };
      const out = writeFileAtomic('data/doc.json', JSON.stringify(human), root);
      expect(pathsToKey(parse(readFileSync(out, 'utf8')), 'focus')).toEqual(['$.view.focus']);

      // Exactly what `cli.ts` and every `--watch` tick do with a fresh extraction.
      writeFileAtomic('data/doc.json', extract(options()).text, root);

      const after = parse(readFileSync(out, 'utf8'));
      expect(after.formatVersion).toBe('1.0');
      expect(Object.keys(after.view ?? {})).toEqual(['expanded']);
      expect(pathsToKey(after, 'focus')).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
