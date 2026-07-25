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
    expect(doc.source?.commit).toBe('0a3dc5aadea1c192fb01bb82055d95131f722418');
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
    expect(stats['trackedFiles']).toBe(679);
    expect(doc.nodes.filter((n) => n.kind === 'file')).toHaveLength(679);
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
    expect(stats['nodesByKind']).toEqual({
      application: 5,
      crate: 2,
      directory: 98,
      file: 679,
      package: 2,
      repository: 1,
    });
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
    expect(stats['invokeCallSiteFiles']).toEqual(['src/shared/ipc.ts']);
    expect(stats['invokeCallSites']).toBe(139);

    const commandEdges = doc.edges.filter((e) => e.kind.endsWith('-command'));
    const sources = new Set(commandEdges.map((e) => e.sourceId));
    expect([...sources]).toEqual(['file:src/shared/ipc.ts']);
  });

  it('counts 137 ANCHORED #[tauri::command] attributes — fewer than the 140 a bare grep finds across 22 files', () => {
    expect(stats['tauriCommandAttributes']).toBe(137);
    expect(stats['tauriCommandAttributeFiles']).toBe(21);
    expect(stats['registeredCommands']).toBe(137);
  });

  it('counts 753 grouped Rust use-trees — the figure the docs cite, produced by the parser', () => {
    // An earlier draft of the architecture said "26 times across 21 files". That came
    // from a grep, it was never reproduced by a parser, and it is not even what the
    // parser measures. This is the number the tool produces, and the docs now cite THIS
    // one — which means if the tool changes, this test changes with it (§10.5).
    expect(stats['rustGroupedUseStatements']).toBe(753);
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
    expect(nonLiteral).toHaveLength(1);
    expect(nonLiteral[0]?.evidence[0]?.path).toBe('src/shared/ipc.ts');
    expect(nonLiteral[0]?.evidence[0]?.line).toBe(113);
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

  it('opens on the repository, its applications and its packages — not 637 overlapping files', () => {
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
