// The extractor, against the FIXTURE repo (§10.7).
//
// Visual Specs tests must pass on a clean checkout of CodebaseConstellation,
// where AgentsCommander — a different repository — is simply absent. So these tests
// `git init` a small fixture repo in a temp directory and run the real
// `git ls-files -z` path against it. Nothing here depends on a neighbouring repo.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { importDoc } from '../../src/contract/load.ts';
import type { VisualSpecsDoc } from '../../src/contract/types.ts';
import { extract, type ExtractOptions } from '../../tools/extractor/extract.ts';
import { EXIT, ExtractorError } from '../../tools/extractor/errors.ts';
import { makeFixtureRepo, type FixtureRepo } from '../support/fixtureRepo.ts';

let fixture: FixtureRepo;
let doc: VisualSpecsDoc;
let text: string;

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
  const result = extract(options());
  doc = result.doc;
  text = result.text;
});

afterAll(() => {
  // `?.` because `beforeAll` can throw before assigning: the helper now removes its own
  // half-built directory, so there is genuinely nothing to tear down, and calling into
  // an undefined handle would bury the real error under a `TypeError` (#54).
  fixture?.cleanup();
});

const node = (id: string) => doc.nodes.find((n) => n.id === id);
const edgesOf = (kind: string) => doc.edges.filter((e) => e.kind === kind);
const stat = (key: string): unknown => (doc.stats ?? {})[key];

describe('ownership: nearest manifest wins (§5.2)', () => {
  it('finds exactly the four anchors, and the workspace-only Cargo.toml is not one of them', () => {
    const anchors = doc.nodes
      .filter((n) => n.kind === 'package' || n.kind === 'crate')
      .map((n) => n.id)
      .sort();
    expect(anchors).toEqual([
      'pkg:cargo:app-tauri/Cargo.toml',
      'pkg:cargo:crates/engine/Cargo.toml',
      'pkg:npm:cli/package.json',
      'pkg:npm:package.json',
    ]);
  });

  it('a Cargo anchor is a CRATE and an npm anchor is a PACKAGE — the ids are unchanged', () => {
    // The reader should not have to translate "package, ecosystem: cargo" into
    // "crate". Ids keep the `pkg:cargo:` prefix, so a stored layout survives.
    const crates = doc.nodes.filter((n) => n.kind === 'crate').map((n) => n.id).sort();
    const packages = doc.nodes.filter((n) => n.kind === 'package').map((n) => n.id).sort();
    expect(crates).toEqual(['pkg:cargo:app-tauri/Cargo.toml', 'pkg:cargo:crates/engine/Cargo.toml']);
    expect(packages).toEqual(['pkg:npm:cli/package.json', 'pkg:npm:package.json']);

    expect(stat('anchors')).toBe(4);
    expect(stat('npmPackages')).toBe(2);
    expect(stat('rustCrates')).toBe(2);
  });

  it('hoists anchors to the repository and gives the root package the declared empty path', () => {
    const root = node('pkg:npm:package.json');
    expect(root?.parentId).toBe('repo:fixture');
    expect(root?.path).toBe('');
    expect(root?.metadata?.['rootAnchor']).toBe(true);
  });

  it('gives a nested crate to ITS OWN anchor, not to the npm package that physically encloses it', () => {
    expect(node('file:app-tauri/src/lib.rs')?.parentId).toBe('dir:app-tauri/src');
    // …and `app-tauri/src` belongs to the crate, not to the root package.
    expect(node('dir:app-tauri/src')?.parentId).toBe('pkg:cargo:app-tauri/Cargo.toml');
  });

  it('PRUNES a pure pass-through directory: `crates/` owns no file in its own package', () => {
    expect(node('dir:crates')).toBeUndefined();
    expect(node('dir:crates/engine')).toBeUndefined();
    expect(node('file:crates/engine/src/lib.rs')?.parentId).toBe('dir:crates/engine/src');
    expect(node('dir:crates/engine/src')?.parentId).toBe('pkg:cargo:crates/engine/Cargo.toml');
  });

  it('--hierarchy physical changes parentId and NOTHING else — ids survive the switch (§5.2)', () => {
    const physical = extract(options({ hierarchy: 'physical' })).doc;
    const logicalIds = doc.nodes.map((n) => n.id).sort();
    const physicalIds = physical.nodes.map((n) => n.id).sort();
    expect(physicalIds).toEqual(logicalIds);

    // Under `physical`, the crate nests inside the npm package that encloses it.
    const crate = physical.nodes.find((n) => n.id === 'pkg:cargo:app-tauri/Cargo.toml');
    expect(crate?.parentId).toBe('pkg:npm:package.json');
  });
});

describe('applications are related to code, not containers of it (§5.3)', () => {
  it('detects the tauri, web and cli applications from citable signals', () => {
    const apps = doc.nodes.filter((n) => n.kind === 'application').map((n) => n.id).sort();
    expect(apps).toEqual([
      'app:npm-bin:cli/package.json#fixture',
      'app:tauri:app-tauri/tauri.conf.json',
      'app:web:index.html',
    ]);
    for (const app of doc.nodes.filter((n) => n.kind === 'application')) {
      expect(app.evidence?.length ?? 0).toBeGreaterThan(0); // it must be able to point at itself
    }
  });

  it('ONE APP SPANS TWO UNITS — which is why application is not a containment level', () => {
    const bundles = edgesOf('bundles').filter(
      (e) => e.sourceId === 'app:tauri:app-tauri/tauri.conf.json',
    );
    expect(bundles.map((e) => e.targetId).sort()).toEqual([
      'pkg:cargo:app-tauri/Cargo.toml',
      'pkg:npm:package.json',
    ]);
    // The crate is DECLARED (the config sits in its manifest directory); the npm
    // package is HEURISTIC (inferred from beforeBuildCommand + frontendDist).
    const byTarget = new Map(bundles.map((e) => [e.targetId, e]));
    expect(byTarget.get('pkg:cargo:app-tauri/Cargo.toml')?.confidence).toBe('declared');
    expect(byTarget.get('pkg:npm:package.json')?.confidence).toBe('heuristic');
  });

  it('does not emit a SECOND application for the Tauri crate’s own main.rs', () => {
    expect(node('app:cargo-bin:app-tauri/src/main.rs')).toBeUndefined();
    expect(stat('suppressedTauriOwnedBins')).toEqual(['app-tauri/src/main.rs']);
    // It becomes the desktop app's entrypoint instead — nothing is silently dropped.
    const entry = edgesOf('entrypoint').find((e) => e.targetId === 'file:app-tauri/src/main.rs');
    expect(entry?.sourceId).toBe('app:tauri:app-tauri/tauri.conf.json');
  });

  it('resolves the web app’s entrypoint out of index.html', () => {
    const entry = edgesOf('entrypoint').find((e) => e.sourceId === 'app:web:index.html');
    expect(entry?.targetId).toBe('file:src/main.ts');
    expect(entry?.confidence).toBe('resolved');
  });
});

describe('TypeScript imports resolve through the project’s own tsconfig (§10.2)', () => {
  const importFrom = (from: string) =>
    edgesOf('imports')
      .filter((e) => e.sourceId === `file:${from}`)
      .map((e) => e.targetId)
      .sort();

  it('resolves a relative import, a `paths` ALIAS, an index import and a JSON import', () => {
    expect(importFrom('src/main.ts')).toEqual([
      'file:src/data.json',
      'file:src/ipc.ts',
      'file:src/shared/index.ts',
      'file:src/shared/util.ts',
      'file:src/styles.css',
    ]);
    // The alias only resolves because the extractor loaded tsconfig.json, which
    // EXTENDS tsconfig.base.json. A hard-coded extension list cannot do this.
    expect(stat('tsPathAliasUsages')).toBe(1);
  });

  it('resolves an ASSET import that tsc cannot — the target is a tracked file, so it is proof, not a guess', () => {
    const css = edgesOf('imports').find((e) => e.targetId === 'file:src/styles.css');
    expect(css?.confidence).toBe('resolved');
    expect(css?.metadata?.['via']).toBe('asset');
  });

  it('counts external specifiers rather than inventing nodes for them', () => {
    expect(doc.nodes.some((n) => n.id.includes('node_modules'))).toBe(false);
  });

  it('an import that climbs ABOVE the repository root becomes NO edge at all', () => {
    // `src/shared/escape.ts` imports `../../../package.json`. The old normaliser
    // clamped that to `package.json` — a real, tracked file at the fixture root — so
    // the map drew a relation to a file the import never touched.
    const fromEscape = doc.edges.filter((e) => e.sourceId === 'file:src/shared/escape.ts');
    expect(fromEscape).toEqual([]);
    expect(
      doc.edges.some(
        (e) => e.sourceId === 'file:src/shared/escape.ts' && e.targetId === 'file:package.json',
      ),
    ).toBe(false);
  });
});

describe('Rust use-trees and modules (§10.3)', () => {
  it('resolves `mod foo;` to a file whose existence is CHECKED', () => {
    const via = (e: { metadata?: Record<string, unknown> }): string[] =>
      (e.metadata?.['via'] as string[] | undefined) ?? [];
    const mods = edgesOf('rust-imports').filter((e) => via(e).includes('mod'));

    const fromLib = mods
      .filter((e) => e.sourceId === 'file:crates/engine/src/lib.rs')
      .map((e) => e.targetId)
      .sort();
    expect(fromLib).toEqual(['file:crates/engine/src/solver.rs', 'file:crates/engine/src/util.rs']);
    // A `mod` declaration whose file was checked really does resolve the relation.
    for (const m of mods) expect(m.confidence).toBe('resolved');

    // …and `#[cfg(test)] mod tests { … }` has no backing file, so it produced none.
    expect(mods.some((e) => e.targetId.includes('tests'))).toBe(false);
  });

  it('resolves a NESTED grouped use-tree to the files it reaches', () => {
    // `use crate::{ solver::{run as run_solver, Options}, util::{self, helper} };`
    // is FOUR imports across TWO files, and a per-line regex resolves none of them.
    const fromLib = edgesOf('rust-imports').filter(
      (e) => e.sourceId === 'file:crates/engine/src/lib.rs',
    );
    const toSolver = fromLib.find((e) => e.targetId === 'file:crates/engine/src/solver.rs');
    const toUtil = fromLib.find((e) => e.targetId === 'file:crates/engine/src/util.rs');

    // Both files are reached by BOTH a `mod` declaration and the grouped use-tree,
    // so the merged relation records both ways it was seen — it does not quietly
    // become "just a mod" and drop the use.
    expect(toSolver?.metadata?.['via']).toEqual(['mod', 'use']);
    expect(toUtil?.metadata?.['via']).toEqual(['mod', 'use']);

    const solverNotes = (toSolver?.evidence ?? []).map((e) => e.note ?? '');
    expect(solverNotes.some((n) => n.startsWith('use crate::solver'))).toBe(true);
    expect(solverNotes.some((n) => n.startsWith('mod solver'))).toBe(true);
  });

  it('a relation backed ONLY by a use-tree is heuristic — permanently and honestly', () => {
    // solver.rs reaches util.rs through `use super::util::helper;` and nothing else.
    const edge = edgesOf('rust-imports').find(
      (e) =>
        e.sourceId === 'file:crates/engine/src/solver.rs' &&
        e.targetId === 'file:crates/engine/src/util.rs',
    );
    expect(edge?.metadata?.['via']).toEqual(['use']);
    expect(edge?.confidence).toBe('heuristic'); // no macro expansion, no cfg evaluation
    expect(edge?.evidence?.[0]?.note).toContain('use super::util::helper');
  });

  it('sends EVERY glob import to unresolved, with evidence — never a guess', () => {
    const globs = (doc.unresolved ?? []).filter(
      (u) => u.kind === 'rust-imports' && u.reason.includes('glob'),
    );
    // Two real globs in the fixture: `use crate::solver::*;` in the engine, and
    // `use super::*;` inside the router's #[cfg(test)] module. Both ARE glob
    // imports in the source, so both are reported. The extractor does not decide
    // that a `use` it can see is not really there.
    const paths = globs.map((g) => g.evidence[0]?.path).sort();
    expect(paths).toEqual(['app-tauri/src/web/commands.rs', 'crates/engine/src/lib.rs']);
    for (const g of globs) expect(g.evidence[0]?.line).toBeGreaterThan(0);
  });

  it('reports rust-imports coverage as DEGRADED, and says why', () => {
    const coverage = (doc.coverage ?? []).find((c) => c.kind === 'rust-imports');
    expect(coverage?.status).toBe('degraded');
    expect(coverage?.reason).toMatch(/macro|cfg|glob/);
    expect(coverage?.unresolved).toBe(2);
  });
});

describe('the transport contract with two backends (§10.4)', () => {
  it('emits tauri-command ONLY with all THREE pieces of evidence', () => {
    const tauri = edgesOf('tauri-command');
    expect(tauri).toHaveLength(1);
    const edge = tauri[0];
    expect(edge?.metadata?.['command']).toBe('get_config');
    expect(edge?.targetId).toBe('file:app-tauri/src/commands/config.rs');
    expect(edge?.confidence).toBe('resolved');
    expect(edge?.evidence).toHaveLength(3); // the call, the attribute, the registration
    const notes = (edge?.evidence ?? []).map((e) => e.note ?? '').join(' | ');
    expect(notes).toContain('transport.invoke');
    expect(notes).toContain('#[tauri::command]');
    expect(notes).toContain('generate_handler');
  });

  it('emits web-command for a command the WebSocket router answers', () => {
    const web = edgesOf('web-command').map((e) => e.metadata?.['command']).sort();
    expect(web).toEqual(['get_config', 'ws_only']);
  });

  it('a command bound to BOTH backends is TWO edges — two different facts', () => {
    const getConfig = doc.edges.filter((e) => e.metadata?.['command'] === 'get_config');
    expect(getConfig.map((e) => e.kind).sort()).toEqual(['tauri-command', 'web-command']);
    expect(new Set(getConfig.map((e) => e.targetId)).size).toBe(2);
    expect(stat('commandsBoundToBothBackends')).toBe(1);
  });

  it('a WEB-ROUTER-ONLY command is unresolved as Tauri, and says so', () => {
    const wsOnly = (doc.unresolved ?? []).filter(
      (u) => u.detail?.['command'] === 'ws_only' && u.kind === 'tauri-command',
    );
    expect(wsOnly).toHaveLength(1);
    expect(wsOnly[0]?.reason).toContain('not callable over Tauri');
  });

  it('a NON-LITERAL command name lands in unresolved — the facade’s own dispatch', () => {
    const nonLiteral = (doc.unresolved ?? []).filter((u) =>
      u.reason.includes('not a string literal'),
    );
    expect(nonLiteral).toHaveLength(1);
    expect(nonLiteral[0]?.evidence[0]?.path).toBe('src/ipc.ts');
    expect(stat('nonLiteralCallSites')).toBe(1);
  });

  it('a REGISTERED-BUT-UNCALLED command is measured, not asserted away', () => {
    expect(stat('registeredButUncalledCommands')).toEqual(['unused_cmd']);
  });

  it('the ANCHORED attribute count ignores the one inside a comment — 135 vs 134, exactly', () => {
    // The fixture has two real `#[tauri::command]` attributes, one in a line comment
    // and one in a block comment. An unanchored grep counts four.
    expect(stat('tauriCommandAttributes')).toBe(2);
    expect(stat('registeredCommands')).toBe(2);
  });

  it('a #[cfg(test)] match arm never becomes a command', () => {
    expect(doc.edges.some((e) => e.metadata?.['command'] === 'never_shipped')).toBe(false);
    expect(stat('webRouterArms')).toBe(2);
  });
});

describe('determinism and provenance (§10.6)', () => {
  it('two runs on the same commit with the same flags are BYTE-IDENTICAL', () => {
    const a = extract(options()).text;
    const b = extract(options()).text;
    expect(b).toBe(a);
  });

  it('generatedAt is excluded from the deterministic payload unless it is asked for', () => {
    expect(doc.generator?.generatedAt).toBeUndefined();
    const stamped = extract(options({ stamp: true })).doc;
    expect(stamped.generator?.generatedAt).toBeDefined();
  });

  it('the configDigest changes when the configuration changes', () => {
    const a = extract(options()).doc.generator?.configDigest;
    const b = extract(options({ invokeFacade: 'ipc.call', flags: ['--invoke-facade', 'ipc.call'] })).doc
      .generator?.configDigest;
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(b).not.toBe(a);
  });

  it('records the commit and the exact flags', () => {
    expect(doc.source?.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(doc.generator?.flags).toEqual(['--hierarchy', 'logical']);
  });

  it('the output passes the SAME validator the app uses on import', () => {
    expect(() => importDoc(text)).not.toThrow();
  });
});

describe('the error contract (§10.6)', () => {
  it('a directory that is not a git repository has its own exit code', () => {
    // NOT a subdirectory of the fixture: `git ls-files` works perfectly well from
    // inside a repository, so that would have proven nothing. A fresh temp
    // directory belongs to no repository at all.
    const orphan = mkdtempSync(join(tmpdir(), 'visual-specs-not-a-repo-'));
    try {
      extract(options({ repo: orphan }));
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ExtractorError);
      expect((err as ExtractorError).exitCode).toBe(EXIT.notAGitRepo);
    } finally {
      rmSync(orphan, { recursive: true, force: true });
    }
  });

  it('an invalid tsconfig has its own exit code', () => {
    writeFileSync(join(fixture.root, 'broken.json'), '{ this is not json', 'utf8');
    try {
      extract(options({ tsconfig: 'broken.json' }));
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ExtractorError);
      expect((err as ExtractorError).exitCode).toBe(EXIT.badTsconfig);
    }
  });

  it('a missing tsconfig has its own exit code', () => {
    try {
      extract(options({ tsconfig: 'nope/tsconfig.json' }));
      throw new Error('expected a throw');
    } catch (err) {
      expect((err as ExtractorError).exitCode).toBe(EXIT.badTsconfig);
    }
  });

  it('REFUSES a --tsconfig that is absolute or climbs out of the repository', () => {
    for (const bad of ['/etc/tsconfig.json', 'C:/Windows/tsconfig.json', '../../tsconfig.json']) {
      try {
        extract(options({ tsconfig: bad }));
        throw new Error(`expected a throw for ${bad}`);
      } catch (err) {
        expect(err, bad).toBeInstanceOf(ExtractorError);
        expect((err as ExtractorError).exitCode, bad).toBe(EXIT.badTsconfig);
      }
    }
  });

  it('REFUSES a tsconfig whose `extends` reaches outside the repository', () => {
    // TypeScript resolves `extends` on our behalf. A confined read host turns that
    // into an ordinary tsconfig error rather than letting a tool whose job is to map
    // ONE repository read a file somewhere else on the machine.
    const outside = mkdtempSync(join(tmpdir(), 'visual-specs-outside-'));
    try {
      writeFileSync(
        join(outside, 'evil.json'),
        JSON.stringify({ compilerOptions: { target: 'ES5' } }),
        'utf8',
      );
      const relativeToRepo = relative(fixture.root, join(outside, 'evil.json'))
        .split(sep)
        .join('/');
      writeFileSync(
        join(fixture.root, 'tsconfig.evil.json'),
        JSON.stringify({ extends: relativeToRepo, include: ['src/**/*.ts'] }),
        'utf8',
      );

      extract(options({ tsconfig: 'tsconfig.evil.json' }));
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ExtractorError);
      expect((err as ExtractorError).exitCode).toBe(EXIT.badTsconfig);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('snippets are OFF by default (§11)', () => {
  it('emits no snippet unless asked, and warns loudly when asked', () => {
    const everySnippet = doc.edges.flatMap((e) => e.evidence ?? []).filter((e) => e.snippet !== undefined);
    expect(everySnippet).toHaveLength(0);

    const withSnippets = extract(options({ snippets: true }));
    expect(withSnippets.warnings.join(' ')).toContain('secret');
    const snippets = withSnippets.doc.edges
      .flatMap((e) => e.evidence ?? [])
      .filter((e) => e.snippet !== undefined);
    expect(snippets.length).toBeGreaterThan(0);
  });
});
