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

  it('carries 817 nodes and 1947 relations — and every one of the six kinds reconstructs', () => {
    // The README publishes these totals, so they are pinned here rather than left as
    // prose with nothing watching them (#27). The whole edge count was rebuilt by a
    // program that shares no code with the extractor and never opens this document —
    // though sharing no CODE is not the same as sharing no ASSUMPTION, and for one of the
    // six kinds it did share one. See the caveat under `rust-imports`.
    // §10.2 concedes the TypeScript library is unavoidable for module resolution; the
    // discovery loop, the tracked-tree fallback for asset imports, the Rust crate walk,
    // the use-tree parser and every dedupe in that program were written from scratch.
    //
    //   bundles         6  by hand: session-bridge ships 2 bins, npm/package.json declares
    //                      1 bin, index.html is the web app — and the Tauri app bundles
    //                      TWO units, its crate AND the root npm package
    //   entrypoint      5  one per application, and there are exactly 5 applications
    //   imports      1089  ts.preProcessFile + ts.resolveModuleName against the mapped
    //                      repository's own tsconfig, plus the tracked-tree fallback that
    //                      resolves asset imports, deduped per (source, target)
    //   rust-imports  665  crate walk: `mod` resolution plus longest-prefix `use`
    //                      resolution, deduped per (source, target). NOT independent for
    //                      `super::` — see the caveat below.
    //   tauri-command 137  registered ∩ called — see the command tests below
    //   web-command    45  called ∩ web-router arms
    //                 ----
    //                 1947
    //
    // CAVEAT on `rust-imports`, and it is the only one of the six (#31). That walk
    // replicates the extractor's own `absolutise` rule for `super::` — pop one module
    // segment per leading `super`, then append the tail — because it set out to measure
    // the same CLAIM. Both sides therefore agree at 665 because both apply that rule, not
    // because the rule was ever checked against Rust's module semantics. For the `super::`
    // subset this is one opinion typed twice, not a second opinion.
    //
    // #28 reported that rule resolves one level too high inside an inline module, and #29
    // — now MERGED — fixed it. So the caveat above is no longer a suspicion, it is settled:
    // re-running both implementations would have moved them together and confirmed nothing.
    // #31 carries the real check: re-derive `super`/`self` from the Rust reference rather
    // than from `imports.ts`.
    //
    // The other five kinds are derived by unrelated routes and stand as reported.
    //
    // ── THIS DOCUMENT IS 17 EDGES AHEAD OF THE EXTRACTOR THAT WOULD PRODUCE IT (#34) ──
    //
    // `data/agentscommander.json` was extracted BEFORE #29. Running the current extractor
    // over the same AgentsCommander commit `1b0e934` yields 1930 edges, not 1947, and 648
    // `rust-imports`, not 665 — measured in an isolated worktree, not inferred.
    //
    // Not 17 removals: **18 removed, 1 added**. The `super` defect invented and dropped in
    // the same bug — it also lost `config/instance_gitignore.rs → config/injected_messages.rs`,
    // from a `super::super::` at `instance_gitignore.rs:1004` misattributed to `lib.rs`.
    // So this map carries 18 `rust-imports` that exist in no build configuration and is
    // missing one that does. `rustGroupedUseStatements` is likewise 813 here and 812 from
    // the current extractor (#25, closed by the same fix).
    //
    // The regeneration is deliberately deferred until the queued additive extractor changes
    // land, so the sixteen-file re-pin happens once instead of three times. **Nothing can
    // make this test go red on that drift**: it reads the committed document and cannot
    // re-run the extractor, because §10.7 requires this suite to pass on a clean checkout
    // where AgentsCommander is absent. #34 and this notice are the only mechanisms there
    // are — which is why the map says so itself rather than only an issue saying it.
    //
    // 817 decomposes the same way: 705 tracked files + 102 directory boxes + 4 anchors
    // + 5 applications + 1 repository.
    expect(doc.nodes).toHaveLength(817);
    expect(doc.edges).toHaveLength(1947);
    expect(stats['nodeCount']).toBe(817);
    expect(stats['edgeCount']).toBe(1947);
    expect(stats['edgesByKind']).toEqual({
      bundles: 6,
      entrypoint: 5,
      imports: 1089,
      'rust-imports': 665,
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

  it('counts 813 grouped Rust use-trees — the figure the docs cite, produced by the parser', () => {
    // An earlier draft of the architecture said "26 times across 21 files". That came
    // from a grep, it was never reproduced by a parser, and it is not even what the
    // parser measures. This is the number the tool produces, and the docs now cite THIS
    // one — which means if the tool changes, this test changes with it (§10.5).
    //
    // THE REFRESH 753 → 813 IS REAL GROWTH, not a change in how the tool counts. An
    // independent re-implementation of the count — its own comment stripper, its own
    // leaf counter, its own crate walk — run over BOTH commits gives 752 at 0a3dc5a and
    // 812 at 1b0e934. Same +60, measured by a program that shares no code with the
    // extractor. The mapped repository gained 8 tracked `.rs` files over 151 commits.
    //
    // THE CONSTANT OFFSET OF ONE IS A KNOWN EXTRACTOR DEFECT, pinned here with its eyes
    // open rather than quietly absorbed. `stripComments` does what its name says — it
    // removes comments and COPIES string literals through — so `parseUseStatements`
    // scans string contents as if they were code. In the `format!` template at
    // src-tauri/src/commands/entity_creation.rs:388 the English sentence
    //   "… NEVER use external memory systems from the coding agent …"
    // supplies the word `use`; the scan then runs to the next `;`, and the braces and
    // commas of the surrounding `format!` arguments parse as a six-leaf group. One
    // phantom grouped use-tree, present identically at both commits (752+1, 812+1).
    // The honest count of grouped use-trees in the repository is 812. 813 is what the
    // committed document says, and this test characterises the committed document — so
    // it pins 813 and NAMES the one figure inside it that is not backed by real code.
    expect(stats['rustGroupedUseStatements']).toBe(813);
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
