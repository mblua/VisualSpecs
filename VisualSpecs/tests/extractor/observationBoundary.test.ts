// I-F10, in the form a machine can check, in both directions (RFC 17 §9).
//
// The invariant reads: `view.*` carries no observations — even when a machine writes
// it, as the extractor does with `view.expanded` — and `view.focus` specifically is a
// human decision no machine writes.
//
// Prose that says "this is not an observation" cannot be checked, and a doc comment on
// a type is read by whoever opens that type — not by the coding agent reading the
// artifact, which is the audience the invariant exists to protect. So this file does
// not restate the prose. It uses the DEFINITION the prose rests on:
//
//     An observation is exactly a claim that carries `evidence[]` and `confidence`.
//     Nothing under `view` carries either, which is WHY none of it is one.
//
// From that definition both directions fall out mechanically, and neither is a list of
// blessed key names that someone must remember to extend:
//
//   A. no `evidence`, `confidence`, `path` or `line` anywhere under `$.view`
//      — the view never grows the signature of a claim about the code;
//   B. no `focus`, `marks` or `transparency` anywhere under `$.nodes`, `$.edges` or
//      `$.unresolved` — an observation never grows the signature of a decision.
//
// Direction B is the one with a real attacker: `metadata` is a free-form
// `Record<string, unknown>` the validator accepts without inspection, and it is the
// shortest path from a UI flag to something indistinguishable from a finding.
//
// The subjects are the three documents this system actually produces: what the
// extractor emits, what an export writes after a person has marked things — the only
// one where `view.focus` exists at all — and the corpus under version control.
//
// KNOWN LIMIT, stated rather than hidden: the walk compares object KEYS, so an entity
// whose id were literally `path` or `evidence` would register as a hit inside
// `view.positions` or `view.marks`. No id the extractor produces has that shape (they
// are all `repo:` / `pkg:` / `dir:` / `file:` prefixed) and the documents here are
// built by this test, so it cannot fire spuriously — but a hand-written document could
// make it, and that is a false positive, not a defect it caught.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { importDoc } from '../../src/contract/load.ts';
import { exportDoc } from '../../src/contract/export.ts';
import { withFocus } from '../../src/contract/view.ts';
import type { FocusMark } from '../../src/contract/view.ts';
import type { NodeId } from '../../src/contract/types.ts';
import { extract, type ExtractOptions } from '../../tools/extractor/extract.ts';
import { makeFixtureRepo, type FixtureRepo } from '../support/fixtureRepo.ts';

const CORPUS = fileURLToPath(new URL('../../data/agentscommander.json', import.meta.url));

/** The signature of a claim about the code. */
const OBSERVATION_KEYS = ['evidence', 'confidence', 'path', 'line'] as const;
/** The signature of a decision about attention. */
const DECISION_KEYS = ['focus', 'marks', 'transparency'] as const;
/** Where observations live. */
const OBSERVATION_ROOTS = ['$.nodes', '$.edges', '$.unresolved'] as const;

let fixture: FixtureRepo;
let extracted: string;
let exportedWithFocus: string;

const options = (): ExtractOptions => ({
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
});

beforeAll(() => {
  fixture = makeFixtureRepo();
  extracted = extract(options()).text;

  // The document as it exists after a person has used the feature: marks on real
  // entities, a transparency they chose, and a moved node so `view` is not just focus.
  const loaded = importDoc(extracted);
  const container = loaded.model.nodes.find((n) => n.kind === 'directory');
  const child = loaded.model.nodes.find(
    (n) => n.kind === 'file' && n.parentId === container?.id,
  );
  if (container === undefined || child === undefined) throw new Error('fixture shape changed');
  const marks = new Map<NodeId, FocusMark>([
    [container.id, 'out-of-focus'],
    [child.id, 'in-focus'],
  ]);
  exportedWithFocus = exportDoc({
    raw: loaded.raw,
    view: withFocus(loaded.view, { marks, transparency: 40 }),
    readOnly: false,
  });
});

afterAll(() => {
  fixture.cleanup();
});

/**
 * Every path at which `key` appears as an object key. Deliberately a local copy of the
 * walk in `focus.test.ts`: that file asserts the extractor's silence about focus and
 * imports nothing but the extractor, and threading a shared helper through
 * `tests/support/` to save fifteen lines would couple two files that are better left
 * able to fail independently.
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

const under = (paths: readonly string[], prefix: string): string[] =>
  paths.filter((p) => p === prefix || p.startsWith(`${prefix}.`) || p.startsWith(`${prefix}[`));

/** Every path in the document at which the signature of a claim appears. */
function observationSignatures(doc: unknown): string[] {
  return OBSERVATION_KEYS.flatMap((key) => pathsToKey(doc, key));
}

function decisionSignatures(doc: unknown): string[] {
  return DECISION_KEYS.flatMap((key) => pathsToKey(doc, key));
}

const subjects = (): readonly { name: string; text: string }[] => [
  { name: 'a fresh extract', text: extracted },
  { name: 'an export after a person marked things', text: exportedWithFocus },
  { name: 'the committed AgentsCommander corpus', text: readFileSync(CORPUS, 'utf8') },
];

describe('the observation / decision boundary is machine-checkable (I-F10)', () => {
  it('A: nothing under `view` carries the signature of a claim about the code', () => {
    for (const subject of subjects()) {
      const doc = JSON.parse(subject.text) as unknown;
      expect(under(observationSignatures(doc), '$.view'), subject.name).toEqual([]);
    }
  });

  it('B: no observation carries the signature of a decision about attention', () => {
    for (const subject of subjects()) {
      const doc = JSON.parse(subject.text) as unknown;
      const decisions = decisionSignatures(doc);
      for (const root of OBSERVATION_ROOTS) {
        expect(under(decisions, root), `${subject.name} → ${root}`).toEqual([]);
      }
    }
  });

  it('and the only `focus` in any of them is the one under `view`', () => {
    for (const subject of subjects()) {
      const doc = JSON.parse(subject.text) as unknown;
      const focusPaths = pathsToKey(doc, 'focus');
      expect(focusPaths.length <= 1, subject.name).toBe(true);
      for (const path of focusPaths) expect(path, subject.name).toBe('$.view.focus');
    }
  });

  it('positive control: the subjects really do carry observations and a decision', () => {
    // Without this, all three assertions above are satisfied by an empty document —
    // the same vacuity that a `toEqual([])` on a walk that found nothing always risks.
    const extractedDoc = JSON.parse(extracted) as unknown;
    const corpusDoc = JSON.parse(readFileSync(CORPUS, 'utf8')) as unknown;
    const exportedDoc = JSON.parse(exportedWithFocus) as unknown;

    // Claims exist, and they are where claims belong.
    expect(pathsToKey(extractedDoc, 'confidence').length).toBeGreaterThan(0);
    expect(pathsToKey(corpusDoc, 'evidence').length).toBeGreaterThan(100);
    expect(under(observationSignatures(corpusDoc), '$.nodes').length).toBeGreaterThan(0);
    expect(under(observationSignatures(corpusDoc), '$.edges').length).toBeGreaterThan(0);

    // …and the export under test really does carry the decision, with both a mark and
    // a chosen transparency, so direction B has something to find if it is wrong.
    expect(pathsToKey(exportedDoc, 'focus')).toEqual(['$.view.focus']);
    expect(pathsToKey(exportedDoc, 'marks')).toEqual(['$.view.focus.marks']);
    expect(pathsToKey(exportedDoc, 'transparency')).toEqual(['$.view.focus.transparency']);
  });
});
