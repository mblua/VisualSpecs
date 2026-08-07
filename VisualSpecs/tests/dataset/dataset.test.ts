// The REAL committed dataset (§12, §7 of the implementation order).
//
// This is the test that stops the product from asserting numbers no program has
// produced. Every figure below is READ OUT of `data/agentscommander.json`, which was
// written by the extractor from the repository at a named commit — not typed into a
// document by a human who was fairly sure.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { importDoc } from '../../src/contract/load.ts';
import { checkRelativePath } from '../../src/contract/paths.ts';
import { OwnershipOutline, assertInjective } from '../../src/domain/outline.ts';
import { computeGeometry } from '../../src/domain/layoutEngine.ts';
import { boxOf, boxesOverlap } from '../../src/domain/geometry.ts';
import { checkPartition, project } from '../../src/projection/project.ts';
import { stateFromLoaded } from '../../src/app/state.ts';
import { GENERATOR_VERSION } from '../../tools/extractor/extract.ts';

const TEXT = readFileSync(
  fileURLToPath(new URL('../../data/agentscommander.json', import.meta.url)),
  'utf8',
);

const loaded = importDoc(TEXT);
const doc = loaded.model;
const stats = (doc.stats ?? {}) as Record<string, unknown>;

describe('the committed dataset is a valid document', () => {
  it('loads through the same validator an imported file goes through', () => {
    expect(() => importDoc(TEXT)).not.toThrow();
    expect(loaded.readOnly).toBe(false);
  });

  it('has exactly one root, and the parent relation is an acyclic tree', () => {
    expect(doc.roots).toEqual(['repo:AgentsCommander']);
    const outline = new OwnershipOutline(doc);
    expect(() => assertInjective(outline, doc)).not.toThrow();
  });

  it('carries NO absolute path in any known path field (I7)', () => {
    for (const node of doc.nodes) {
      if (node.path === undefined) continue;
      const allowEmpty = node.parentId === null || node.metadata?.['rootAnchor'] === true;
      expect(checkRelativePath(node.path, allowEmpty), `${node.id} → ${node.path}`).toBeNull();
    }
    for (const edge of doc.edges) {
      for (const e of edge.evidence ?? []) {
        expect(checkRelativePath(e.path, false), `${edge.id} → ${e.path}`).toBeNull();
      }
    }
  });

  it('declares the provenance that produced it', () => {
    expect(doc.source?.kind).toBe('git-repo');
    expect(doc.source?.root).toBe('AgentsCommander');
    expect(doc.source?.commit).toBe('5168310b2a63149de3b846e9e45bdb4dcea696fe');
    expect(doc.generator?.name).toBe('visual-specs-extract');
    expect(doc.generator?.version).toBe(GENERATOR_VERSION);
    expect(doc.generator?.configDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(doc.generator?.flags).toContain('--hierarchy');
  });

  it('does not claim a commit it cannot back up: `dirty` and the modified files agree', () => {
    // The extractor lists files from the index and reads their CONTENT from the working
    // tree. A dirty tree means every `path:line` describes the files on disk, not the
    // files at `source.commit` — so the document has to say so. (It found out the hard
    // way: a tracked file in the mapped repository gained a line, sixteen `mod` evidence
    // lines shifted, and the document went on declaring the commit as if nothing had
    // changed.)
    const dirty = doc.source?.dirty;
    const modified = stats['modifiedTrackedFiles'];
    expect(Array.isArray(modified)).toBe(true);

    const files = modified as string[];
    if (dirty === true) {
      expect(files.length, 'source.dirty is true, so it must name what differs').toBeGreaterThan(0);
      for (const f of files) expect(f).not.toMatch(/^([A-Za-z]:|[\\/])/); // relative, always
    } else {
      expect(dirty).toBeUndefined();
      expect(files).toEqual([]);
    }
  });

  it('the declared flags MATCH the content: --hierarchy logical means the anchors are hoisted', () => {
    const flags = doc.generator?.flags ?? [];
    const hierarchy = flags[flags.indexOf('--hierarchy') + 1];
    expect(hierarchy).toBe('logical');

    // Under `logical`, every anchor is a child of the repository — including the
    // crates that physically sit inside the root npm package's directory.
    for (const anchor of doc.nodes.filter((n) => n.kind === 'package' || n.kind === 'crate')) {
      expect(anchor.parentId, `${anchor.id} should be hoisted`).toBe('repo:AgentsCommander');
    }
    const crate = doc.nodeById.get('pkg:cargo:src-tauri/Cargo.toml');
    expect(crate?.path).toBe('src-tauri'); // the breadcrumb still shows the physical path
  });

  it('does not leak an absolute path from the machine that generated it', () => {
    // `generator.flags` records the flags that determine the CONTENT — never `--repo`
    // or `--out`, which name the operator's filesystem.
    const flags = doc.generator?.flags ?? [];
    expect(flags).not.toContain('--repo');
    expect(flags).not.toContain('--out');
    for (const flag of flags) {
      expect(/^[A-Za-z]:[\\/]|^\\\\|^\//.test(flag), `flag "${flag}" looks absolute`).toBe(false);
    }
  });
});

describe('what the map says about AgentsCommander — every number from a parser', () => {
  it('maps every git-tracked file', () => {
    // Corroborated OUTSIDE the extractor: `git ls-tree -r --name-only` in the mapped
    // repository returns 741 at 5168310b, 705 at 1b0e934 and 679 at 0a3dc5a.
    //
    // 705 → 741 is +36 ADDED and NOTHING deleted — `comm` over the two sorted trees
    // gives 36 in the new side and 0 in the old. Almost all of it is one feature,
    // terminal snapshots: a new `crates/terminal-snapshot-renderer` crate with its
    // sources, assets, tests and fixtures, plus `terminal_snapshot.rs` under `api/
    // handlers`, `cli`, `phone` and `pty`, plus the `#1252` loops-layering guard and
    // three `scripts/*.mjs`.
    expect(stats['trackedFiles']).toBe(741);
    expect(doc.nodes.filter((n) => n.kind === 'file')).toHaveLength(741);
  });

  it('finds the six anchors: TWO npm packages and FOUR Rust crates — one of which is a TEST FIXTURE', () => {
    const packages = doc.nodes.filter((n) => n.kind === 'package').map((n) => n.id).sort();
    const crates = doc.nodes.filter((n) => n.kind === 'crate').map((n) => n.id).sort();

    // A crate is its own kind. The reader should not have to translate.
    expect(packages).toEqual(['pkg:npm:npm/package.json', 'pkg:npm:package.json']);

    // 2 → 4 crates, and the two arrivals are NOT the same kind of thing.
    //
    //   * `crates/terminal-snapshot-renderer` is a real unit: a workspace member,
    //     feature-gated (`protocol`, `render`), with its own `src/lib.rs`.
    //   * `…/tests/fixtures/diagnostic-failure-harness` is a THROWAWAY at version
    //     `0.0.0` that a test compiles on purpose to observe it fail.
    //
    // The root `Cargo.toml` declares exactly THREE workspace members — `src-tauri`,
    // `crates/session-bridge`, `crates/terminal-snapshot-renderer`. The harness is not
    // among them, so the map shows FOUR crates where cargo sees three. That is the
    // anchor rule working as written — a manifest that declares a package is an anchor,
    // and this one does — not a defect. It is pinned here because a reader comparing the
    // map against `cargo metadata` will find the difference, and should find the reason
    // next to it. Whether a fixture manifest ought to anchor at all is a product
    // question, not something to settle by quietly filtering it out.
    expect(crates).toEqual([
      'pkg:cargo:crates/session-bridge/Cargo.toml',
      'pkg:cargo:crates/terminal-snapshot-renderer/Cargo.toml',
      'pkg:cargo:crates/terminal-snapshot-renderer/tests/fixtures/diagnostic-failure-harness/Cargo.toml',
      'pkg:cargo:src-tauri/Cargo.toml',
    ]);

    expect(stats['anchors']).toBe(6);
    expect(stats['npmPackages']).toBe(2);
    expect(stats['rustCrates']).toBe(4);
    // `directory` is not a free parameter: a directory becomes a box exactly when it
    // lies between an anchor and a file that anchor owns (§5.2), so it is derivable
    // from `git ls-files` plus the anchor directories alone. Recomputed that way,
    // outside the extractor: 107 at 5168310b, 102 at 1b0e934, and 98 at 0a3dc5a.
    //
    // The +5 are `crates/terminal-snapshot-renderer/{assets,src,tests,tests/fixtures}`
    // and `src-tauri/src/pty/terminal_snapshot`. The harness fixture directory is NOT
    // among them: it is an anchor itself, so it is a crate box rather than a directory.
    expect(stats['nodesByKind']).toEqual({
      application: 5,
      crate: 4,
      directory: 107,
      file: 741,
      package: 2,
      repository: 1,
    });
  });

  it('carries 860 nodes and 1980 relations — and every one of the six kinds reconstructs', () => {
    // ── 1b0e934 → 5168310b: THE EXTRACTOR DID NOT MOVE ────────────────────────────
    // Before judging any figure below, the two variables were separated: the CURRENT
    // extractor was run against the OLD source tree (`1b0e9348`, in a detached
    // worktree) and reproduced the previous document exactly — 817 nodes, 1930
    // relations, 705 files, 152 unresolved, and all six kinds at 6/5/1089/648/137/45.
    // So every delta on this page is the mapped repository changing, and none of it is
    // the tool changing. That check is what makes the rest of these numbers updatable
    // at all; without it a moved figure has two possible causes and no way to choose.
    //
    // 50 relations added, 0 removed. 47 `rust-imports`, 1 `imports`, 1 `tauri-command`,
    // 1 `web-command`. Of the 50, exactly THREE join two files that already existed:
    // the two command relations for `set_terminal_snapshots_enabled`, and
    // `pty/output.rs → pty/backend.rs`, whose two `use crate::pty::backend::…` lines
    // (14 and 460) are absent from `output.rs` at 1b0e934 and present at 5168310b.
    // ──────────────────────────────────────────────────────────────────────────────

    // The README publishes these totals, so they are pinned here rather than left as
    // prose with nothing watching them (#27). Five of the six kinds were rebuilt by a
    // program that shares no code with the extractor and never opens this document.
    // §10.2 concedes the TypeScript library is unavoidable for module resolution; the
    // discovery loop, the tracked-tree fallback for asset imports, the use-tree parser
    // and every dedupe in that program were written from scratch.
    //
    //   bundles         6  by hand: session-bridge ships 2 bins, npm/package.json declares
    //                      1 bin, index.html is the web app — and the Tauri app bundles
    //                      TWO units, its crate AND the root npm package
    //   entrypoint      5  one per application, and there are exactly 5 applications
    //   imports      1090  ts.preProcessFile + ts.resolveModuleName against the mapped
    //                      repository's own tsconfig, plus the tracked-tree fallback that
    //                      resolves asset imports, deduped per (source, target)
    //   rust-imports  695  NOT by a second count — see below
    //   tauri-command 138  registered ∩ called — see the command tests below
    //   web-command    46  called ∩ web-router arms
    //                 ----
    //                 1980
    //
    // `rust-imports` IS NOT CORROBORATED BY A SECOND COUNT, DELIBERATELY. The earlier
    // reconstruction agreed with the extractor at 665 — and 18 of those 665 existed in no
    // build configuration. It agreed because it replicated the extractor's own `absolutise`
    // rule for `super::` rather than checking that rule against Rust: code independence is
    // not specification independence, and a second implementation bounds implementation
    // error, never a shared spec error. Re-running it now would agree at 648 and mean
    // exactly as much.
    //
    // What backs 648 instead is 19 NAMED CASES, each checkable by reading two files, and
    // a total cannot be satisfied that way. 665 → 648 is 18 removed and 1 restored:
    //
    //   * All 18 removed were backed ONLY by `use super::…` written inside an INLINE
    //     module — `mod tests`, `mod capture`, `mod codec_posix`, `mod codec_windows`,
    //     `mod pty_viewport_tests`, `mod startup_gate_tests`, `mod windows_impl` and
    //     others. All 32 of their evidence lines were re-read: every one sits inside an
    //     inline module, every symbol is DEFINED IN THE SOURCE FILE ITSELF, and every one
    //     is ABSENT from the `mod.rs`/`lib.rs` the old document named. `super` from inside
    //     an inline module is the file, so each was a self-relation drawn as a relation.
    //   * The 1 restored is `config/instance_gitignore.rs → config/injected_messages.rs`,
    //     from the `super::super::` at `instance_gitignore.rs:1004` and `:1025`, previously
    //     misattributed to `lib.rs`. `INJECTED_MESSAGES_FILENAME` is absent from `lib.rs`
    //     and present at `config/injected_messages.rs:32` as a `pub(crate) const`.
    //
    // One surviving edge also lost an evidence line: `commands/config.rs → lib.rs` keeps
    // its two real `use crate::ApiServerHandle;` lines (`lib.rs:182`) and drops
    // `config.rs:2254`, whose `super::super::settings_snapshot_from` is written inside
    // `mod snapshot` NESTED in `mod tests`, so it resolves to config.rs itself — where
    // `settings_snapshot_from` is defined, at line 390.
    //
    // 648 → 695 is +47, and 46 of the 47 touch a file that did not exist at 1b0e934 —
    // the `terminal_snapshot` modules and the renderer crate. The 47th is the
    // `pty/output.rs → pty/backend.rs` pair named above.
    //
    // 860 decomposes the same way: 741 tracked files + 107 directory boxes + 6 anchors
    // + 5 applications + 1 repository.
    expect(doc.nodes).toHaveLength(860);
    expect(doc.edges).toHaveLength(1980);
    expect(stats['nodeCount']).toBe(860);
    expect(stats['edgeCount']).toBe(1980);
    expect(stats['edgesByKind']).toEqual({
      bundles: 6,
      entrypoint: 5,
      imports: 1090,
      'rust-imports': 695,
      'tauri-command': 138,
      'web-command': 46,
    });

    // §10.2 says the `@shared/*`, `@sidebar/*` and `@terminal/*` aliases have ZERO
    // usages and that this is recorded rather than mistaken for "unsupported". The
    // independent resolver counted the same 0, and the same 22 external specifiers.
    expect(stats['tsPathAliasUsages']).toBe(0);
    expect(stats['externalSpecifiers']).toBe(22);
  });

  it('finds the five applications — including the crate that ships TWO binaries', () => {
    const apps = doc.nodes.filter((n) => n.kind === 'application').map((n) => n.id).sort();
    expect(apps).toEqual([
      'app:cargo-bin:crates/session-bridge/src/bin/agentscommander-api-helper.rs',
      'app:cargo-bin:crates/session-bridge/src/bin/session-bridge.rs',
      'app:npm-bin:npm/package.json#agentscommander',
      'app:tauri:src-tauri/tauri.conf.json',
      'app:web:index.html',
    ]);
  });

  it('ONE APP SPANS TWO UNITS: the Tauri app bundles its CRATE and the root npm PACKAGE', () => {
    const bundles = doc.edges.filter(
      (e) => e.kind === 'bundles' && e.sourceId === 'app:tauri:src-tauri/tauri.conf.json',
    );
    expect(bundles.map((e) => e.targetId).sort()).toEqual([
      'pkg:cargo:src-tauri/Cargo.toml',
      'pkg:npm:package.json',
    ]);
  });

  it('the whole frontend reaches the whole backend through EXACTLY ONE file', () => {
    // The most useful thing the map says about this codebase (§6.7).
    //
    // Corroborated without the AST: `transport.invoke` occurs in exactly ONE tracked
    // TypeScript file, and a textual sweep for `transport.invoke<…>(` over that file
    // finds 141 at 5168310b, 140 at 1b0e934 and 139 at 0a3dc5a. The generic argument
    // matters — a naive search for `transport.invoke(` finds ZERO, because every call
    // is written `transport.invoke<T>("name", args)`.
    //
    // 140 → 141 is ONE new call site, `ipc.ts:337`, for the one new command in this
    // delta: `set_terminal_snapshots_enabled`. It is the only command name present at
    // 5168310b and absent at 1b0e934, and no command name disappeared.
    expect(stats['invokeCallSiteFiles']).toEqual(['src/shared/ipc.ts']);
    expect(stats['invokeCallSites']).toBe(141);

    const commandEdges = doc.edges.filter((e) => e.kind.endsWith('-command'));
    const sources = new Set(commandEdges.map((e) => e.sourceId));
    expect([...sources]).toEqual(['file:src/shared/ipc.ts']);
  });

  it('counts 139 ANCHORED #[tauri::command] attributes — fewer than the 142 a bare grep finds across 21 files', () => {
    // The gap is the whole point of the anchored pattern, and it is checkable by hand.
    // A bare `grep -F '#[tauri::command'` over the tracked `.rs` files finds 142 in 21
    // files; three of those are PROSE INSIDE COMMENTS —
    //   src-tauri/src/commands/task.rs:426
    //   src-tauri/src/session/session.rs:58
    //   src-tauri/src/session/session.rs:606
    // — and none of them starts a line. 142 − 3 = 139.
    //
    // Re-read at 5168310b: the SAME three lines, at the SAME line numbers, and still
    // the only three that do not start a line. The gap did not move; the bare count and
    // the anchored count both rose by one, for the one new attribute at
    // `commands/config.rs:576`.
    expect(stats['tauriCommandAttributes']).toBe(139);

    // The ATTRIBUTE FILE count went DOWN, 21 → 20, while the attributes went UP. That
    // is not a contradiction and it is not noise: `session/session.rs` is the one file
    // whose only mentions are the two comments above, so it leaves the anchored set
    // while staying in the bare-grep set. 21 bare-grep files − 1 comment-only = 20.
    expect(stats['tauriCommandAttributeFiles']).toBe(20);

    // An attribute alone is not a callable command; Tauri requires registration. The
    // mapped repository has TWO `generate_handler![…]` lists, and the stat is the union
    // of their names, not the sum: src-tauri/src/lib.rs:2587 lists 139 distinct names,
    // and src-tauri/src/commands/resource_monitor.rs:466 lists one (`kill_resource_group`)
    // that already appears in it. 139 ∪ 1 = 139.
    //
    // Counted off-extractor by taking the last `::` segment of every entry between
    // `lib.rs:2588` and its closing bracket and de-duplicating: 139. The list moved from
    // 2550 to 2587 because `lib.rs` grew above it, not because a second list appeared.
    expect(stats['registeredCommands']).toBe(139);
  });

  it('draws 138 tauri-command and 46 web-command relations, 44 of them bound to BOTH', () => {
    // One off-extractor measurement settles all four, and it never opens this document:
    // parse the command names out of the two `generate_handler![…]` lists, parse the
    // literal command names out of `ipc.ts`, parse the `match cmd` arms out of the web
    // router, and intersect.
    //
    //   registered                                  139
    //   distinct literals called in ipc.ts           140   (over 141 call sites)
    //   web-router arm names                          47
    //   registered ∩ called                          138   ← tauri-command
    //   called ∩ web arms                             46   ← web-command
    //   registered ∩ called ∩ web arms                44   ← bound to both
    //   registered, never called       [get_instance_label]
    //   called, never registered [get_pty_size, subscribe_session]
    //
    // Every one of those six rose by exactly one, and the two named lists did not move.
    // That is what a single command bound to BOTH backends looks like, and the command
    // is `set_terminal_snapshots_enabled`: called at `ipc.ts:337`, attributed at
    // `commands/config.rs:576`, registered in the `lib.rs` list, and routed at
    // `web/commands.rs:414`. Four legs, four files, all four re-read.
    //
    // Counting the router arms requires stripping comments FIRST: a brace inside a
    // comment truncates the `match` block and a naive sweep reports 39 instead of 47.
    //
    // A command bound to both backends is TWO relations with different targets, and
    // that is not double-counting — they are two different facts (§10.4).
    expect(doc.edges.filter((e) => e.kind === 'tauri-command')).toHaveLength(138);
    expect(doc.edges.filter((e) => e.kind === 'web-command')).toHaveLength(46);
    expect(stats['commandsBoundToBothBackends']).toBe(44);
    expect(stats['webRouterArms']).toBe(47);
  });

  it('counts 893 grouped Rust use-trees — the figure the docs cite, produced by the parser', () => {
    // 812 → 893 is the largest proportional move in this delta (+10 % from +5 % more
    // files), so it was decomposed rather than accepted. The extractor increments this
    // inside the (crate root × module file) loop, so a file reachable from two roots
    // counts twice; the decomposition replicates THAT loop, not a per-file count.
    //
    // Sixteen files changed their contribution and the deltas sum to exactly 81:
    //   59  eleven files that did not exist — `pty/terminal_snapshot.rs` (12), the
    //       renderer crate's four modules (12), `pty/terminal_snapshot/{acceptance,
    //       resource}_tests.rs` (14), the `api/handlers`, `cli` and `phone` snapshot
    //       modules (20), `loops/events.rs` (1)
    //   22  five files that already existed and gained grouped imports —
    //       `agentscommander-api-helper.rs` (+11), `path_identity.rs` (+5),
    //       `config/settings.rs` (+3), `pty/output.rs` (+2), `api/schema.rs` (+1)
    // No file changed how many times the extractor walks it, so none of the +81 is a
    // double-count artefact of the new crate root.

    // An earlier draft of the architecture said "26 times across 21 files". That came
    // from a grep, it was never reproduced by a parser, and it is not even what the
    // parser measures. This is the number the tool produces, and the docs now cite THIS
    // one — which means if the tool changes, this test changes with it (§10.5).
    //
    // HISTORY, kept because it is why this figure is trustworthy at all — it describes
    // the 813 → 812 move at 1b0e934, not the 812 → 893 one above.
    //
    // 813 → 812 IS #25 CLOSED, AND IT IS A NAMED CASE RATHER THAN A TOTAL. The old
    // `stripComments` removed comments and COPIED string literals through, so the scanner
    // read string contents as code: in the `format!` template at
    // src-tauri/src/commands/entity_creation.rs:388 the English sentence
    //   "… NEVER use external memory systems from the coding agent …"
    // supplied the word `use`, the scan ran to the next `;`, and the braces and commas of
    // the surrounding `format!` arguments parsed as a six-leaf group. #29 replaced the two
    // scanners with one pass that also blanks literal contents, and the phantom is gone:
    // re-parsed at `1b0e934`, `entity_creation.rs` now yields 19 grouped statements rather
    // than 20, and NONE anywhere in the 360–400 region. That is why 812 is the whole
    // delta — the one statement I could point at and read is the one that left.
    //
    // The scanner was rewritten wholesale, so the two phase-loss cases #29 names are
    // re-checked at every corpus refresh rather than trusted. At 5168310b:
    // `commands/session.rs` (the `'"'` char literal at line 206) parses 57 `use`
    // statements against 57 textual `use` lines, and `agentscommander-api-helper.rs`
    // (the `format!("http://{address}")` at line 1247) parses 61 against 61 — it was
    // 11 against 11 at 1b0e934, and it is the file that gained the most grouped imports
    // in this delta. No real `use` line is blanked by the scan in either.
    expect(stats['rustGroupedUseStatements']).toBe(893);
  });

  it('records the Rust module shape — and the two LISTS are checked by reading, not counting', () => {
    // New in #36. Pinned here because a stats key nothing asserts is the gap #27 is about,
    // and because two of these fields are ABSENCE claims — the kind that quietly becomes
    // false without anyone noticing.
    const shape = stats['rustModuleShape'] as Record<string, unknown>;

    // `#[cfg(…)]` is NOT evaluated, so these declarations are the ones where that
    // matters: the map draws every one of these files unconditionally, and a real build
    // has only some of them. 2 → 8, and the six arrivals are a SHAPE THIS CORPUS DID NOT
    // HAVE BEFORE — feature gates rather than platform gates. Read at the source:
    //   crates/terminal-snapshot-renderer/src/lib.rs:4,6,8  `#[cfg(feature = "protocol")]`
    //   crates/terminal-snapshot-renderer/src/lib.rs:10     `#[cfg(feature = "render")]`
    //   pty/terminal_snapshot.rs:3147,3149                  `#[cfg(test)]`
    // The original two are unchanged: `screenshot/mod.rs:26` is `mod windows;` under
    // `#[cfg(target_os = "windows")]` and `:31` is `mod unsupported;` under
    // `#[cfg(not(target_os = "windows"))]`.
    expect(shape['conditionalModules']).toEqual([
      'crates/terminal-snapshot-renderer/src/lib.rs:10 mod render;',
      'crates/terminal-snapshot-renderer/src/lib.rs:4 mod json;',
      'crates/terminal-snapshot-renderer/src/lib.rs:6 mod png_validation;',
      'crates/terminal-snapshot-renderer/src/lib.rs:8 mod protocol;',
      'src-tauri/src/pty/terminal_snapshot.rs:3147 mod acceptance_tests;',
      'src-tauri/src/pty/terminal_snapshot.rs:3149 mod resource_tests;',
      'src-tauri/src/screenshot/mod.rs:26 mod windows;',
      'src-tauri/src/screenshot/mod.rs:31 mod unsupported;',
    ]);

    // "Empty means there is none to resolve, which is a different claim from cannot
    // resolve them" — so the absence is checked rather than assumed, and the check got
    // SHARPER in this delta. A bare grep for `#[path` over the 221 tracked `.rs` files
    // now finds FIVE hits, all of them in one new file — `src-tauri/tests/
    // loops_layering.rs`, at lines 40, 41, 51, 396 and 403 — and every one is prose
    // inside a `//!` or `///` doc comment describing how `#[path]` could evade a
    // layering guard. The scanner blanks comments, so it reports zero attributes, and
    // zero is right. Grep says one file; the parser says none; the parser is correct.
    expect(shape['pathAttributes']).toEqual([]);

    // THIS ABSENCE JUST BECAME FALSE, AND THAT IS THE POINT OF PINNING IT.
    //
    // `src-tauri/src/pty/terminal_snapshot.rs` is the module root, and its children —
    // `acceptance_tests.rs` and `resource_tests.rs` — live in a SIBLING directory,
    // `src-tauri/src/pty/terminal_snapshot/`. That is the 2018-edition shape, and it is
    // the first occurrence anywhere in this corpus.
    //
    // The consequence is concrete: the box the map draws for that directory holds two
    // test files, while the 3000-line file that DEFINES the module sits outside it, as a
    // peer of the box, in `pty/`. So for this one directory the box's level is not its
    // module's level — which is exactly the claim `rootOutsideDirectory` exists to stop
    // anyone from making by habit. `directoryModules` stays 18 because this directory is
    // correctly NOT counted as one.
    expect(shape['rootOutsideDirectory']).toEqual(['src-tauri/src/pty/terminal_snapshot']);

    // 18 = the tracked `*/mod.rs` files, counted with `git ls-files "*/mod.rs"`. It did
    // not move: the new crate uses a plain `src/lib.rs` and no `mod.rs` anywhere.
    expect(shape['directoryModules']).toBe(18);
    expect(shape['moduleFiles']).toBe(193);

    // The ratio is the sanity check: test scaffolding dominates, and it should. All FIVE
    // of the non-test inline modules were read, and every one is a platform shim written
    // in a `#[cfg(windows)]` / `#[cfg(not(windows))]` pair:
    //   pty/job.rs:31 `mod windows_impl` + :143 `mod stub_impl`
    //   resource_monitor/windows.rs:7 `mod platform` + :574 `mod platform`
    //   testability/window_info.rs:78 `mod windows_impl`  (`#[cfg(target_os = "windows")]`)
    // There is no non-test inline module in this corpus that is not a platform shim.
    // Re-read at 5168310b: the same five, at the same five line numbers. 36 new files
    // and a new crate added none — the count holding still means what it says.
    expect(shape['inlineModules']).toBe(5);
    expect(shape['inlineTestModules']).toBe(184);
  });

  it('records the REGISTERED-BUT-UNCALLED command that an earlier draft denied existed', () => {
    expect(stats['registeredButUncalledCommands']).toEqual(['get_instance_label']);
  });

  it('records the two WEB-ROUTER-ONLY commands as unresolved for Tauri', () => {
    const webOnly = (doc.unresolved ?? [])
      .filter((u) => u.kind === 'tauri-command' && u.reason.includes('not callable over Tauri'))
      .map((u) => u.detail?.['command'])
      .sort();
    expect(webOnly).toEqual(['get_pty_size', 'subscribe_session']);
  });

  it('records the facade’s own non-literal dispatch as unresolved, not as a phantom edge', () => {
    const nonLiteral = (doc.unresolved ?? []).filter((u) =>
      u.reason.includes('not a string literal'),
    );
    // The line is the facade's own internal dispatch,
    // `currentTransport().invoke<T>(cmd, args)`, where `cmd` is a variable (§10.4).
    // Read straight out of the file: it sits at line 117 at 1b0e934, and at 113 at
    // 0a3dc5a — four lines of drift, not a different call.
    expect(nonLiteral).toHaveLength(1);
    expect(nonLiteral[0]?.evidence[0]?.path).toBe('src/shared/ipc.ts');
    expect(nonLiteral[0]?.evidence[0]?.line).toBe(117);
  });

  it('reports rust-imports as DEGRADED, permanently and honestly', () => {
    const rust = doc.coverage.find((c) => c.kind === 'rust-imports');
    expect(rust?.status).toBe('degraded');
    expect(rust?.unresolved).toBeGreaterThan(0);
    // Everything else the extractor claims to do, it reports as available.
    for (const c of doc.coverage.filter((x) => x.kind !== 'rust-imports')) {
      expect(c.status).toBe('available');
    }
  });

  it('every inferred relation can point at itself', () => {
    for (const edge of doc.edges) {
      expect((edge.evidence ?? []).length, `${edge.id} has no evidence`).toBeGreaterThan(0);
    }
    for (const u of doc.unresolved) {
      expect(u.evidence.length, `an unresolved item without evidence is a rumour`).toBeGreaterThan(0);
    }
  });
});

describe('the initial view is legible (§9.3)', () => {
  const state = stateFromLoaded(loaded);

  it('opens on the repository, its applications and its packages — not 741 overlapping files', () => {
    // 10 → 12 visible nodes, and the arithmetic is the point: 1 repository + 5
    // applications + ANCHORS. The applications did not change; the anchors went 4 → 6,
    // so the opening view gained exactly the two new crates and nothing else.
    const graph = project(state.model, state.outline, state.view.expanded);
    expect(graph.visibleNodes).toHaveLength(1 + 5 + 6);
    expect(graph.visibleNodes[0]).toBe('repo:AgentsCommander');
  });

  it('no visible node overlaps another', () => {
    const geometry = computeGeometry(
      state.model,
      state.outline,
      state.view.expanded,
      state.view.positions,
    );
    const boxes = geometry.visibility.visible
      .filter((id) => id !== 'repo:AgentsCommander')
      .map((id) => {
        const p = geometry.position.get(id);
        const s = geometry.size.get(id);
        if (p === undefined || s === undefined) throw new Error(`no geometry for ${id}`);
        return { id, box: boxOf(p, s) };
      });

    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i];
        const b = boxes[j];
        if (a === undefined || b === undefined) continue;
        expect(boxesOverlap(a.box, b.box, 1), `${a.id} overlaps ${b.id}`).toBe(false);
      }
    }
  });

  it('collapsed, every command relation folds into one aggregate per binding — and keeps every id', () => {
    const graph = project(state.model, state.outline, state.view.expanded);
    const violations = checkPartition(state.model, state.outline, graph);
    expect(violations).toEqual([]);

    // §6.7, on the real dataset: ipc.ts and the backend files all collapse into
    // their packages, so the command edges aggregate by binding kind.
    const tauri = graph.visibleEdges.filter((e) => e.kind === 'tauri-command');
    expect(tauri).toHaveLength(1);
    expect(tauri[0]?.count).toBeGreaterThan(100);
    expect(tauri[0]?.sourceEdgeIds.length).toBe(tauri[0]?.count);

    const web = graph.visibleEdges.filter((e) => e.kind === 'web-command');
    expect(web).toHaveLength(1);
    expect(web[0]?.count).toBeGreaterThan(30);
  });

  it('the partition law holds on the real dataset, fully expanded', () => {
    const everything = new Set(state.model.nodes.map((n) => n.id));
    const graph = project(state.model, state.outline, everything);
    expect(checkPartition(state.model, state.outline, graph)).toEqual([]);
    expect(graph.visibleEdges.reduce((n, e) => n + e.count, 0)).toBe(state.model.edges.length);
  });
});
