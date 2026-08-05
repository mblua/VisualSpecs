// `edges[].conditions` — which build configurations a relation exists under (#38).
//
// The document merges every configuration into one graph. 77 `rust-imports` relations in
// AgentsCommander @1b0e934 exist only under `#[cfg(test)]`, and two more are a mutually
// exclusive platform pair — exactly one of `screenshot/windows.rs` and
// `screenshot/unsupported.rs` is in any build. Drawn bare, all 79 assert they are in the
// shipped binary.
//
// **Absent means UNCONDITIONAL, not "default".** That is what makes every undetected
// conditional a false claim rather than a missing nicety, and it is why the negative
// cases here matter as much as the positive ones.
//
// Sensitivity, per case:
//   * the `mod` declaration, own-attribute and nested cases each cover a shape the block
//     rule alone would miss, and each would go undetected without this file;
//   * the MIXED case is the one that keeps the feature from over-claiming — it is the
//     only case that fails if the merge unions conditions instead of dropping them;
//   * the `formatVersion` pair is the half that fails silently in production, because
//     `export.ts raiseFormatVersion` reads the `view` subtree and can never raise a minor
//     for graph data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importDoc } from '../../src/contract/load.ts';
import { SUPPORTED_MINOR } from '../../src/contract/validate.ts';
import type { VisualSpecsDoc, VisualSpecsEdge } from '../../src/contract/types.ts';
import { extract } from '../../tools/extractor/extract.ts';
import { extractOptions, makeTempRepo, type TempRepo } from '../support/tempRepo.ts';

const CARGO = `[package]
name = "fixture"
version = "0.1.0"
edition = "2021"
`;

const FILES: Record<string, string> = {
  'Cargo.toml': CARGO,

  // A `mod` declaration can be gated itself, with a predicate whose meaning lives in a
  // STRING. `neutralise` blanks literal text, so reading the attribute from the blanked
  // view would yield `#[cfg(target_os =        )]` — a condition nobody can name, which
  // would have to be dropped, which would assert the relation is unconditional.
  'src/lib.rs': `pub mod plain;
pub mod tested;
pub mod both;
pub mod reversed;
pub mod own;
pub mod nested;
pub mod union;

#[cfg(target_os = "windows")]
pub mod gated;
`,

  'src/plain.rs': 'pub fn p() -> u8 {\n    1\n}\n',
  'src/gated.rs': 'pub fn g() -> u8 {\n    2\n}\n',

  // Inside a conditional block.
  'src/tested.rs': `#[cfg(test)]
mod tests {
    use crate::plain::p;

    #[test]
    fn t() {
        assert_eq!(p(), 1);
    }
}
`,

  // The SAME pair, referenced once unconditionally and once under test. The relation is
  // in every build, so it carries nothing.
  'src/both.rs': `use crate::plain::p;

pub fn call() -> u8 {
    p()
}

#[cfg(test)]
mod tests {
    use crate::plain::p;

    #[test]
    fn t() {
        assert_eq!(p(), 1);
    }
}
`,

  // The same, with the references in the OTHER ORDER. Rust does not care, and neither
  // may the merge: whichever arrives first, one unconditional reference makes the
  // relation unconditional. Written because a mutation that broke exactly this path left
  // `both.rs` green — there the unconditional reference is first, so the second-arrival
  // branch never runs and the case could not see the defect.
  'src/reversed.rs': `#[cfg(test)]
mod tests {
    use crate::plain::p;

    #[test]
    fn t() {
        assert_eq!(p(), 1);
    }
}

use crate::plain::p;

pub fn call() -> u8 {
    p()
}
`,

  // A `use` gated on its own, with no enclosing conditional block at all.
  'src/own.rs': `#[cfg(windows)]
use crate::plain::p;

#[cfg(windows)]
pub fn call() -> u8 {
    p()
}
`,

  // Two blocks deep: the reference needs BOTH, so they conjoin into one entry rather
  // than becoming two — `conditions` entries read as alternatives.
  'src/nested.rs': `#[cfg(windows)]
mod outer {
    #[cfg(test)]
    mod inner {
        use crate::plain::p;

        #[test]
        fn t() {
            assert_eq!(p(), 1);
        }
    }
}
`,

  // Two references to the same pair under DIFFERENT conditions: the relation exists
  // under either, so the entries union.
  'src/union.rs': `#[cfg(windows)]
use crate::plain::p;

#[cfg(test)]
mod tests {
    use crate::plain::p;

    #[test]
    fn t() {
        assert_eq!(p(), 1);
    }
}
`,
};

/** No `cfg` anywhere: the document must stay at 1.0. */
const UNCONDITIONAL: Record<string, string> = {
  'Cargo.toml': CARGO,
  'src/lib.rs': 'pub mod plain;\npub mod user;\n',
  'src/plain.rs': 'pub fn p() -> u8 {\n    1\n}\n',
  'src/user.rs': 'use crate::plain::p;\n\npub fn call() -> u8 {\n    p()\n}\n',
};

let repo: TempRepo;
let plain: TempRepo;
let doc: VisualSpecsDoc;
let text: string;
let plainDoc: VisualSpecsDoc;

beforeAll(() => {
  repo = makeTempRepo(FILES);
  const result = extract(extractOptions(repo.root, { name: 'fixture' }));
  doc = result.doc;
  text = result.text;
  plain = makeTempRepo(UNCONDITIONAL);
  plainDoc = extract(extractOptions(plain.root, { name: 'plain' })).doc;
});

afterAll(() => {
  repo.cleanup();
  plain.cleanup();
});

const from = (file: string): VisualSpecsEdge | undefined =>
  doc.edges.find(
    (e) => e.kind === 'rust-imports' && e.sourceId === `file:src/${file}.rs` && e.targetId === 'file:src/plain.rs',
  );

describe('conditions: which build a relation is in', () => {
  it('marks a relation written inside a conditional block', () => {
    expect(from('tested')?.conditions).toEqual(['cfg(test)']);
  });

  it('marks a `mod` declaration gated by a predicate whose value is a STRING', () => {
    // Read from the literal view, so the value survives. From the blanked view this
    // would be `cfg(target_os =        )` — unnameable, and an unnameable condition is
    // one that gets dropped, which asserts the relation is unconditional.
    const edge = doc.edges.find(
      (e) => e.sourceId === 'file:src/lib.rs' && e.targetId === 'file:src/gated.rs',
    );
    expect(edge?.conditions).toEqual(['cfg(target_os = "windows")']);
  });

  it('marks a `use` gated on its own, with no enclosing block', () => {
    expect(from('own')?.conditions).toEqual(['cfg(windows)']);
  });

  it('conjoins nested blocks into one entry, because entries are alternatives', () => {
    expect(from('nested')?.conditions).toEqual(['cfg(all(test, windows))']);
  });

  it('unions across references, because the relation exists under either', () => {
    expect(from('union')?.conditions).toEqual(['cfg(test)', 'cfg(windows)']);
  });

  it('carries NOTHING when one reference is unconditional — the relation is in every build', () => {
    // The over-claim guard. A merge that unioned instead of dropping would label a
    // relation the shipped binary really has as test-only, and a projection filtering on
    // the field would erase it from the map.
    const edge = from('both');
    expect(edge).toBeDefined();
    expect(edge?.conditions).toBeUndefined();
    expect(edge?.evidence?.length).toBe(2);
  });

  it('drops the condition whichever reference arrives first', () => {
    // `both.rs` has the unconditional reference first, so it only exercises the
    // FIRST-arrival branch of the merge. This file has them the other way round. A
    // mutation that broke the second-arrival branch left `both.rs` green, which is how
    // the gap was found — a case that cannot fail against a defect is not covering it.
    const edge = from('reversed');
    expect(edge).toBeDefined();
    expect(edge?.conditions).toBeUndefined();
    expect(edge?.evidence?.length).toBe(2);
  });

  it('leaves every unconditional relation bare', () => {
    const bare = doc.edges.filter((e) => e.conditions === undefined);
    expect(bare.length).toBeGreaterThan(0);
    expect(bare.every((e) => !('conditions' in e))).toBe(true);
  });
});

describe('the extractor stamps the minor itself', () => {
  it('declares 1.3 when it emitted a conditional relation', () => {
    // `export.ts raiseFormatVersion` derives the minor from the `view` subtree and
    // `exportDoc` never touches `edges`, so nothing downstream can raise it. Asserted on
    // the PUBLISHED bytes, not on the validated doc, so an allowlist cannot hide it.
    expect(doc.formatVersion).toBe('1.3');
    expect((JSON.parse(text) as { formatVersion: string }).formatVersion).toBe('1.3');
  });

  it('stays at 1.0 when nothing in the repository is conditional', () => {
    expect(plainDoc.formatVersion).toBe('1.0');
    expect(plainDoc.edges.some((e) => e.conditions !== undefined)).toBe(false);
  });

  it('declares a minor this build actually knows', () => {
    // A document that announced a minor above `SUPPORTED_MINOR` would open with an
    // `unknown-minor` warning against the extractor's own output.
    expect(Number(doc.formatVersion.split('.')[1])).toBeLessThanOrEqual(SUPPORTED_MINOR);
    expect(importDoc(text).warnings.map((w) => w.code)).not.toContain('unknown-minor');
  });
});

describe('the vocabulary is declared, not left to be discovered', () => {
  it('reports every condition used, with counts', () => {
    // Without this a typo coins a condition in silence and nobody can enumerate what is
    // in the file without scanning every relation.
    expect((doc.stats ?? {})['conditionVocabulary']).toEqual({
      'cfg(all(test, windows))': 1,
      'cfg(target_os = "windows")': 1,
      'cfg(test)': 2,
      'cfg(windows)': 2,
    });
    expect((doc.stats ?? {})['conditionalEdges']).toBe(5);
  });

  it('the counts agree with the relations actually emitted', () => {
    const counted = doc.edges.filter((e) => e.conditions !== undefined).length;
    expect((doc.stats ?? {})['conditionalEdges']).toBe(counted);
  });
});

describe('the contract refuses a shape that would be ambiguous', () => {
  it('rejects an empty array, which would ask a reader to tell "none" from "unconditional"', () => {
    const broken = JSON.parse(text) as { edges: { conditions?: unknown }[] };
    broken.edges[0]!.conditions = [];
    expect(() => importDoc(JSON.stringify(broken))).toThrow(/conditions is empty/);
  });

  it('rejects a non-string entry', () => {
    const broken = JSON.parse(text) as { edges: { conditions?: unknown }[] };
    broken.edges[0]!.conditions = ['cfg(test)', 7];
    expect(() => importDoc(JSON.stringify(broken))).toThrow(/must contain non-empty strings/);
  });
});
