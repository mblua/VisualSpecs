// Is the box the map draws for a directory the module a reader will read it as?
//
// Rust allows both shapes, and they differ in exactly the way that matters to a level:
//
//   src/inside/mod.rs   the module `inside` IS this file, INSIDE the box
//   src/outside.rs      the module `outside` IS this file, a SIBLING of the box
//
// In the second, the directory box holds the module's children but not the file that
// defines it, and the root is ranked against its own children's container. Calling that
// box's rank "the level of `outside`" is wrong.
//
// AgentsCommander @1b0e934 is entirely the first shape — 18 of 18, zero `#[path]`, zero
// siblings — which is why a level per directory needs no caveat there. This fixture
// deliberately contains BOTH, because the field exists for repositories unlike that one
// and a fixture built only from the corpus we have would never exercise the case it was
// written for.
//
// Sensitivity: the `rootOutsideDirectory` case is the one that would go undetected
// without this file. The rest pin what the extractor walks past without acting on —
// `#[path]` is still unresolved and `cfg` still unevaluated, and reporting the counts is
// the whole point: "there is no `#[path]` here" and "I cannot resolve `#[path]`" are
// different claims, and only a measurement can tell a reader which one applies.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { VisualSpecsDoc } from '../../src/contract/types.ts';
import { extract } from '../../tools/extractor/extract.ts';
import { extractOptions, makeTempRepo, type TempRepo } from '../support/tempRepo.ts';

let repo: TempRepo;
let doc: VisualSpecsDoc;

const FILES: Record<string, string> = {
  'Cargo.toml': `[package]
name = "fixture"
version = "0.1.0"
edition = "2021"
`,

  'src/lib.rs': `pub mod inside;
pub mod outside;
`,

  // Root INSIDE the directory. Also carries every declaration the extractor walks past
  // without acting on, so each one is counted somewhere a reader can see it.
  'src/inside/mod.rs': `pub mod leaf;

#[cfg(unix)]
pub mod gated;

#[path = "moved.rs"]
mod moved;

#[cfg(windows)]
mod windows_impl {
    pub fn probe() -> u8 {
        1
    }
}

#[cfg(test)]
mod tests {
    mod nested {
        pub fn helper() -> u8 {
            2
        }
    }
}
`,
  'src/inside/leaf.rs': 'pub fn leaf() -> u8 {\n    3\n}\n',
  'src/inside/gated.rs': 'pub fn gated() -> u8 {\n    4\n}\n',

  // Root OUTSIDE the directory it owns — the shape AgentsCommander does not have.
  'src/outside.rs': `pub mod leaf;
`,
  'src/outside/leaf.rs': 'pub fn leaf() -> u8 {\n    5\n}\n',
};

beforeAll(() => {
  repo = makeTempRepo(FILES);
  doc = extract(extractOptions(repo.root, { name: 'fixture' })).doc;
});

afterAll(() => {
  repo.cleanup();
});

const shape = () => (doc.stats ?? {})['rustModuleShape'] as Record<string, unknown>;

describe('rustModuleShape: whether a directory box IS its module', () => {
  it('names the directory whose module root is a SIBLING, not a child', () => {
    // `src/outside/` holds `leaf.rs`, but the module `outside` is `src/outside.rs`, which
    // the map draws next to the box rather than inside it.
    expect(shape()['rootOutsideDirectory']).toEqual(['src/outside']);
  });

  it('counts the directory whose module root is `mod.rs`, inside the box', () => {
    expect(shape()['directoryModules']).toBe(1);
  });

  it('ignores a directory that is nobody\'s module', () => {
    // `src/` holds tracked `.rs` and has neither a `mod.rs` nor a `src.rs` beside it. It
    // is the crate source root, not a module, and must be counted as neither.
    expect(shape()['rootOutsideDirectory']).not.toContain('src');
    expect(shape()['directoryModules']).toBe(1);
  });

  it('counts only the module files it actually reached from a crate root', () => {
    // lib.rs, inside/mod.rs, inside/leaf.rs, inside/gated.rs, outside.rs, outside/leaf.rs.
    // `moved` is NOT among them: `#[path]` is not resolved, so no file backs that module.
    expect(shape()['moduleFiles']).toBe(6);
  });

  it('reports `#[path]` declarations it walked past without resolving', () => {
    expect(shape()['pathAttributes']).toEqual(['src/inside/mod.rs:7 mod moved;']);
    // And it did not invent the file the attribute names.
    const targets = doc.edges.filter((e) => e.kind === 'rust-imports').map((e) => e.targetId);
    expect(targets).not.toContain('file:src/inside/moved.rs');
  });

  it('reports `mod X;` under a `#[cfg(…)]` — shown unconditionally, built conditionally', () => {
    expect(shape()['conditionalModules']).toEqual(['src/inside/mod.rs:4 mod gated;']);
    // `cfg` is not evaluated, so the relation IS drawn. Saying so is the point.
    const edge = doc.edges.find(
      (e) => e.sourceId === 'file:src/inside/mod.rs' && e.targetId === 'file:src/inside/gated.rs',
    );
    expect(edge).toBeDefined();
  });

  it('separates inline modules from the test scaffolding that would drown them', () => {
    // `windows_impl` is a module with no file and no box, and it is not test code.
    expect(shape()['inlineModules']).toBe(1);
    // `tests` and the `nested` inside it — nested one counts, and it inherits `cfg(test)`
    // from its parent rather than carrying the attribute itself.
    expect(shape()['inlineTestModules']).toBe(2);
  });

  it('is a plain record on `stats`, so a reader that ignores it is unaffected', () => {
    // `stats` is `Record<string, unknown>` and the validator copies it verbatim: additive,
    // no schema change, no formatVersion bump.
    expect(Object.keys(shape()).sort()).toEqual([
      'conditionalModules',
      'directoryModules',
      'inlineModules',
      'inlineTestModules',
      'moduleFiles',
      'pathAttributes',
      'rootOutsideDirectory',
    ]);
  });
});
