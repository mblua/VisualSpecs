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
    expect(doc.source?.commit).toBe('1b0e934824709cb701715aa07d3a95d9dfe33daa');
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
    // Corroborated OUTSIDE the extractor: `git ls-files | wc -l` in the mapped
    // repository at 1b0e934 returns 705, and at 0a3dc5a it returned 679.
    expect(stats['trackedFiles']).toBe(705);
    expect(doc.nodes.filter((n) => n.kind === 'file')).toHaveLength(705);
  });

  it('finds the four anchors: TWO npm packages and TWO Rust crates', () => {
    const packages = doc.nodes.filter((n) => n.kind === 'package').map((n) => n.id).sort();
    const crates = doc.nodes.filter((n) => n.kind === 'crate').map((n) => n.id).sort();

    // A crate is its own kind. The reader should not have to translate.
    expect(packages).toEqual(['pkg:npm:npm/package.json', 'pkg:npm:package.json']);
    expect(crates).toEqual([
      'pkg:cargo:crates/session-bridge/Cargo.toml',
      'pkg:cargo:src-tauri/Cargo.toml',
    ]);

    expect(stats['anchors']).toBe(4);
    expect(stats['npmPackages']).toBe(2);
    expect(stats['rustCrates']).toBe(2);
    // `directory` is not a free parameter: a directory becomes a box exactly when it
    // lies between an anchor and a file that anchor owns (§5.2), so it is derivable
    // from `git ls-files` plus the four anchor directories alone. Recomputed that way,
    // outside the extractor: 102 at 1b0e934, and 98 at 0a3dc5a — which is the number
    // this test used to pin.
    expect(stats['nodesByKind']).toEqual({
      application: 5,
      crate: 2,
      directory: 102,
      file: 705,
      package: 2,
      repository: 1,
    });
  });

  it('carries 817 nodes and 1930 relations — and every one of the six kinds reconstructs', () => {
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
    //   imports      1089  ts.preProcessFile + ts.resolveModuleName against the mapped
    //                      repository's own tsconfig, plus the tracked-tree fallback that
    //                      resolves asset imports, deduped per (source, target)
    //   rust-imports  648  NOT by a second count — see below
    //   tauri-command 137  registered ∩ called — see the command tests below
    //   web-command    45  called ∩ web-router arms
    //                 ----
    //                 1930
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
    // 817 decomposes the same way: 705 tracked files + 102 directory boxes + 4 anchors
    // + 5 applications + 1 repository.
    expect(doc.nodes).toHaveLength(817);
    expect(doc.edges).toHaveLength(1930);
    expect(stats['nodeCount']).toBe(817);
    expect(stats['edgeCount']).toBe(1930);
    expect(stats['edgesByKind']).toEqual({
      bundles: 6,
      entrypoint: 5,
      imports: 1089,
      'rust-imports': 648,
      'tauri-command': 137,
      'web-command': 45,
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
    // finds 140 at 1b0e934 and 139 at 0a3dc5a. The generic argument matters — a naive
    // search for `transport.invoke(` finds ZERO, because every call is written
    // `transport.invoke<T>("name", args)`.
    expect(stats['invokeCallSiteFiles']).toEqual(['src/shared/ipc.ts']);
    expect(stats['invokeCallSites']).toBe(140);

    const commandEdges = doc.edges.filter((e) => e.kind.endsWith('-command'));
    const sources = new Set(commandEdges.map((e) => e.sourceId));
    expect([...sources]).toEqual(['file:src/shared/ipc.ts']);
  });

  it('counts 138 ANCHORED #[tauri::command] attributes — fewer than the 141 a bare grep finds across 21 files', () => {
    // The gap is the whole point of the anchored pattern, and it is checkable by hand.
    // A bare `grep -F '#[tauri::command'` over the tracked `.rs` files finds 141 in 21
    // files; three of those are PROSE INSIDE COMMENTS —
    //   src-tauri/src/commands/task.rs:426
    //   src-tauri/src/session/session.rs:58
    //   src-tauri/src/session/session.rs:606
    // — and none of them starts a line. 141 − 3 = 138.
    expect(stats['tauriCommandAttributes']).toBe(138);

    // The ATTRIBUTE FILE count went DOWN, 21 → 20, while the attributes went UP. That
    // is not a contradiction and it is not noise: `session/session.rs` is the one file
    // whose only mentions are the two comments above, so it leaves the anchored set
    // while staying in the bare-grep set. 21 bare-grep files − 1 comment-only = 20.
    expect(stats['tauriCommandAttributeFiles']).toBe(20);

    // An attribute alone is not a callable command; Tauri requires registration. The
    // mapped repository has TWO `generate_handler![…]` lists, and the stat is the union
    // of their names, not the sum: src-tauri/src/lib.rs:2550 lists 138 distinct names,
    // and src-tauri/src/commands/resource_monitor.rs:466 lists one that already appears
    // in it. 138 ∪ 1 = 138.
    expect(stats['registeredCommands']).toBe(138);
  });

  it('draws 137 tauri-command and 45 web-command relations, 43 of them bound to BOTH', () => {
    // One off-extractor measurement settles all four, and it never opens this document:
    // parse the command names out of the two `generate_handler![…]` lists, parse the
    // literal command names out of `ipc.ts`, parse the `match cmd` arms out of the web
    // router, and intersect.
    //
    //   registered                                  138
    //   distinct literals called in ipc.ts           139   (over 140 call sites)
    //   web-router arm names                          46
    //   registered ∩ called                          137   ← tauri-command
    //   called ∩ web arms                             45   ← web-command
    //   registered ∩ called ∩ web arms                43   ← bound to both
    //   registered, never called       [get_instance_label]
    //   called, never registered [get_pty_size, subscribe_session]
    //
    // Counting the router arms requires stripping comments FIRST: a brace inside a
    // comment truncates the `match` block and a naive sweep reports 39 instead of 46.
    //
    // A command bound to both backends is TWO relations with different targets, and
    // that is not double-counting — they are two different facts (§10.4).
    expect(doc.edges.filter((e) => e.kind === 'tauri-command')).toHaveLength(137);
    expect(doc.edges.filter((e) => e.kind === 'web-command')).toHaveLength(45);
    expect(stats['commandsBoundToBothBackends']).toBe(43);
    expect(stats['webRouterArms']).toBe(46);
  });

  it('counts 812 grouped Rust use-trees — the figure the docs cite, produced by the parser', () => {
    // An earlier draft of the architecture said "26 times across 21 files". That came
    // from a grep, it was never reproduced by a parser, and it is not even what the
    // parser measures. This is the number the tool produces, and the docs now cite THIS
    // one — which means if the tool changes, this test changes with it (§10.5).
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
    // The scanner was rewritten wholesale, so the two phase-loss cases #29 names were
    // re-checked rather than trusted: `commands/session.rs` (the `'"'` char literal at
    // line 206) parses 57 `use` statements against 57 textual `use` lines, and
    // `agentscommander-api-helper.rs` (the `format!("http://{address}")` at line 1247)
    // parses 11 against 11. No real `use` line was blanked by the new scan.
    expect(stats['rustGroupedUseStatements']).toBe(812);
  });

  it('records the Rust module shape — and the two LISTS are checked by reading, not counting', () => {
    // New in #36. Pinned here because a stats key nothing asserts is the gap #27 is about,
    // and because two of these fields are ABSENCE claims — the kind that quietly becomes
    // false without anyone noticing.
    const shape = stats['rustModuleShape'] as Record<string, unknown>;

    // `#[cfg(…)]` is NOT evaluated, so these two declarations are the ones where that
    // matters: on a non-Windows build exactly one of them exists, and the map draws both
    // files unconditionally. Read at the source: `screenshot/mod.rs:26` is `mod windows;`
    // under `#[cfg(target_os = "windows")]`, and `:31` is `mod unsupported;` under
    // `#[cfg(not(target_os = "windows"))]`.
    expect(shape['conditionalModules']).toEqual([
      'src-tauri/src/screenshot/mod.rs:26 mod windows;',
      'src-tauri/src/screenshot/mod.rs:31 mod unsupported;',
    ]);

    // "Empty means there is none to resolve, which is a different claim from cannot
    // resolve them" — so the absence is checked rather than assumed. A grep for `#[path`
    // over all 203 tracked `.rs` files finds zero, in zero files.
    expect(shape['pathAttributes']).toEqual([]);

    // Likewise: no directory of tracked Rust code has its module root in a SIBLING
    // `<dir>.rs`. Checked by asking git for a tracked `<dir>.rs` next to every directory
    // holding a `.rs` file — there is none, so every directory's level is its module's.
    expect(shape['rootOutsideDirectory']).toEqual([]);

    // 18 = the tracked `*/mod.rs` files under the two crates, counted with `git ls-files`.
    expect(shape['directoryModules']).toBe(18);
    expect(shape['moduleFiles']).toBe(181);

    // The ratio is the sanity check: test scaffolding dominates, and it should. All FIVE
    // of the non-test inline modules were read, and every one is a platform shim written
    // in a `#[cfg(windows)]` / `#[cfg(not(windows))]` pair:
    //   pty/job.rs:31 `mod windows_impl` + :143 `mod stub_impl`
    //   resource_monitor/windows.rs:7 `mod platform` + :574 `mod platform`
    //   testability/window_info.rs:78 `mod windows_impl`  (`#[cfg(target_os = "windows")]`)
    // There is no non-test inline module in this corpus that is not a platform shim.
    expect(shape['inlineModules']).toBe(5);
    expect(shape['inlineTestModules']).toBe(175);
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

  it('opens on the repository, its applications and its packages — not 705 overlapping files', () => {
    const graph = project(state.model, state.outline, state.view.expanded);
    expect(graph.visibleNodes).toHaveLength(1 + 5 + 4);
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
