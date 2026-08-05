// `super` is relative to the ENCLOSING MODULE, and an inline `mod X { … }` is one.
//
// Found while measuring the corpus for the levelization RFC: 16 `rust-imports` edges in
// `data/agentscommander.json` assert a relation no build has. The minimal case, verified
// by hand against AgentsCommander `1b0e934`:
//
//   commands/window.rs:966  #[cfg(test)]
//   commands/window.rs:967  mod tests {
//   commands/window.rs:968      use super::{ get_watchers_scope, … };
//
// `get_watchers_scope` is defined at `window.rs:868`. Inside `mod tests`, `super` is
// `crate::commands::window` — the file ITSELF, so the true relation is a self-loop and
// `extractRustImports` already drops those. The document instead published
// `window.rs -> commands/mod.rs`, a file of 22 lines that is nothing but `pub mod X;`
// declarations and where `get_watchers_scope` appears zero times.
//
// 14 of the 16 point at a `mod.rs`, which already has `mod` edges to every child — so
// each false edge closes a two-cycle. They accounted for 16 of the repository's 67
// feedback arcs and were the entire reason `src-tauri/src/config` showed a 14-node SCC
// instead of 2.
//
// ── What each case is sensitive to ──────────────────────────────────────────────
// The two negative cases are the defect. The three POSITIVE ones exist because a fix
// that simply ignored `super` inside an inline module would pass every negative case and
// silently delete relations that are real: a file-level `use super::`, a `super::super::`
// written from inside an inline module, and the `mod` edges that hold the tree together.
// A one-sided fixture would have licensed that fix.
//
// Asserted on the edges the extractor PUBLISHES, not on the parser's intermediate output:
// the parser is where the fix lands, so a test that read it back would be insulated from
// the very defect it is meant to catch.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { VisualSpecsDoc } from '../../src/contract/types.ts';
import { extract } from '../../tools/extractor/extract.ts';
import { extractOptions, makeTempRepo, type TempRepo } from '../support/tempRepo.ts';

let repo: TempRepo;
let doc: VisualSpecsDoc;

const CARGO = `[package]
name = "fixture"
version = "0.1.0"
edition = "2021"
`;

const FILES: Record<string, string> = {
  'Cargo.toml': CARGO,

  'src/lib.rs': `pub mod commands;
pub mod util;
`,

  // The parent module. Like the real `commands/mod.rs` it is mostly declarations, but it
  // does define one item, so a file-level `use super::…` from a child is legitimate.
  'src/commands/mod.rs': `pub mod deep;
pub mod legit;
pub mod platform;
pub mod window;

pub fn helper_in_parent() {}
`,

  // THE DEFECT. The only `super` in this file is written inside `mod tests`, where it
  // means the file itself. Nothing here may produce an edge to `commands/mod.rs`.
  'src/commands/window.rs': `pub fn get_watchers_scope() -> u8 {
    7
}

#[cfg(test)]
mod tests {
    use super::get_watchers_scope;

    #[test]
    fn scope_is_seven() {
        assert_eq!(get_watchers_scope(), 7);
    }
}
`,

  // THE CONTROL for the negative above: a file-level `use super::` really does reach the
  // parent, and must survive the fix.
  'src/commands/legit.rs': `use super::helper_in_parent;

pub fn call_it() {
    helper_in_parent();
}
`,

  // Depth must be COUNTED, not merely detected: from inside one inline module,
  // `super::super::` reaches the parent module and that edge is real.
  'src/commands/deep.rs': `mod inner {
    use super::super::helper_in_parent;

    pub fn reach() {
        helper_in_parent();
    }
}
`,

  // The same defect outside `cfg(test)`: a platform shim is an inline module too.
  // One of the 16 real cases is exactly this shape
  // (`testability/window_info.rs:79`, inside `#[cfg(windows)] mod windows_impl`).
  'src/commands/platform.rs': `pub struct WindowInfoOutput;

#[cfg(windows)]
mod windows_impl {
    use super::WindowInfoOutput;

    pub fn probe() -> WindowInfoOutput {
        WindowInfoOutput
    }
}
`,

  'src/util.rs': `pub fn shared() -> u8 {
    1
}
`,
};

beforeAll(() => {
  repo = makeTempRepo(FILES);
  doc = extract(extractOptions(repo.root, { name: 'fixture' })).doc;
});

afterAll(() => {
  repo.cleanup();
});

const rustEdges = () => doc.edges.filter((e) => e.kind === 'rust-imports');
const edge = (from: string, to: string) =>
  rustEdges().find((e) => e.sourceId === `file:${from}` && e.targetId === `file:${to}`);

describe('`super` inside an inline module is the file itself, not its parent', () => {
  it('emits NO edge for a `use super::X` written inside `mod tests` when X is defined in that file', () => {
    // The defect: this resolved one level too high and landed on `commands/mod.rs`.
    expect(edge('src/commands/window.rs', 'src/commands/mod.rs')).toBeUndefined();
  });

  it('emits NO edge for the same shape in a production inline module (`#[cfg(windows)] mod windows_impl`)', () => {
    expect(edge('src/commands/platform.rs', 'src/commands/mod.rs')).toBeUndefined();
  });

  it('KEEPS a file-level `use super::…`, which does reach the parent', () => {
    const e = edge('src/commands/legit.rs', 'src/commands/mod.rs');
    expect(e).toBeDefined();
    expect(e?.evidence?.[0]?.note).toBe('use super::helper_in_parent;');
  });

  it('KEEPS `super::super::` written from inside an inline module — depth is counted, not just detected', () => {
    const e = edge('src/commands/deep.rs', 'src/commands/mod.rs');
    expect(e).toBeDefined();
    expect(e?.evidence?.[0]?.note).toBe('use super::super::helper_in_parent;');
  });

  it('leaves the `mod` declaration edges untouched — the tree still hangs together', () => {
    const mods = rustEdges().filter((e) => {
      const via = e.metadata?.['via'];
      return Array.isArray(via) && via.includes('mod');
    });
    expect(mods.map((e) => `${e.sourceId} -> ${e.targetId}`).sort()).toEqual([
      'file:src/commands/mod.rs -> file:src/commands/deep.rs',
      'file:src/commands/mod.rs -> file:src/commands/legit.rs',
      'file:src/commands/mod.rs -> file:src/commands/platform.rs',
      'file:src/commands/mod.rs -> file:src/commands/window.rs',
      'file:src/lib.rs -> file:src/commands/mod.rs',
      'file:src/lib.rs -> file:src/util.rs',
    ]);
  });

  it('publishes no relation whose evidence line sits in a module that cannot reach the target', () => {
    // The whole class, stated once: every `use super::…` edge must be backed by evidence
    // written at a nesting depth that can actually reach the target. Here that means the
    // two files whose only `super` is inline-scoped contribute no `use` edge at all.
    const fromInlineOnly = rustEdges().filter(
      (e) =>
        (e.sourceId === 'file:src/commands/window.rs' ||
          e.sourceId === 'file:src/commands/platform.rs') &&
        (e.metadata?.['via'] as string[] | undefined)?.includes('use'),
    );
    expect(fromInlineOnly).toEqual([]);
  });
});
