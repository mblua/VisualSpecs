// A MANIFEST IS UNTRUSTED INPUT TOO.
//
// `package.json#bin`, Cargo's `[[bin]].path` and Tauri's `frontendDist` are strings
// somebody wrote. Before `isPosixRelative` existed, the path normaliser turned every one
// of these declarations into a path INSIDE the repository — and an absolute declaration
// that gets silently rewritten as a relative one can then match a real, tracked file and
// become a relation the map asserts and cannot point at.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VisualSpecsDoc } from '../../src/contract/types.ts';
import { extract } from '../../tools/extractor/extract.ts';
import { isPosixRelative, normalisePathStrict } from '../../tools/extractor/confine.ts';
import { joinPath } from '../../tools/extractor/manifests.ts';
import { nearestNpmAnchor } from '../../tools/extractor/apps.ts';
import type { Manifest } from '../../tools/extractor/manifests.ts';
import { extractOptions, makeTempRepo, type TempRepo } from '../support/tempRepo.ts';

describe('joinPath / normalisePathStrict reject anything that is not POSIX-relative', () => {
  it('REFUSES to turn an absolute declaration into an internal path', () => {
    // Every one of these used to come back as a plausible repo-relative path.
    expect(joinPath('', '/package.json')).toBeNull(); // was 'package.json' — a real file
    expect(joinPath('src-tauri', '/package.json')).toBeNull(); // was 'src-tauri/package.json'
    expect(joinPath('', 'C:/secret')).toBeNull(); // was 'C:/secret'
    expect(joinPath('', '\\\\server\\share')).toBeNull(); // was '\\\\server\\share'
    expect(joinPath('', 'src\\main.ts')).toBeNull(); // was 'src\\main.ts'
  });

  it('rejects a drive-RELATIVE path, which resolves against a per-drive cwd', () => {
    expect(isPosixRelative('C:foo')).toBe(false);
    expect(joinPath('', 'C:foo')).toBeNull();
  });

  it('rejects a NUL or a control character', () => {
    expect(isPosixRelative('src/\0evil.ts')).toBe(false);
    expect(isPosixRelative('src/a\nb.ts')).toBe(false);
  });

  it('still accepts, and still collapses, an honest relative path', () => {
    expect(joinPath('src-tauri', '../dist')).toBe('dist');
    expect(joinPath('', './run.js')).toBe('run.js');
    expect(joinPath('npm', 'run.js')).toBe('npm/run.js');
    expect(normalisePathStrict('src/./shared/../main.ts')).toBe('src/main.ts');
  });

  it('still refuses an escape above the root, rather than clamping it', () => {
    expect(joinPath('src/shared', '../../../package.json')).toBeNull();
  });
});

describe('nearestNpmAnchor picks the LONGEST prefix, not the first match', () => {
  const anchor = (dir: string, ecosystem: 'npm' | 'cargo'): Manifest =>
    ({
      ecosystem,
      manifestPath: dir === '' ? 'package.json' : `${dir}/package.json`,
      dir,
      name: dir === '' ? 'root' : dir,
      isPackage: true,
      isWorkspace: false,
      nameLine: 1,
      cargoBins: [],
      npmBins: [],
      hasWorkspacesKey: false,
    }) as Manifest;

  it('prefers a nested package over the root, whatever order they arrive in', () => {
    // The root sorts first (`package.json` < `web/package.json`), so a `.find()` on the
    // array always returned it — which is "whichever manifest I read first wins", not
    // "nearest manifest wins".
    const anchors = [anchor('', 'npm'), anchor('web', 'npm')];
    expect(nearestNpmAnchor(anchors, 'web/dist')?.dir).toBe('web');
    expect(nearestNpmAnchor([...anchors].reverse(), 'web/dist')?.dir).toBe('web');
  });

  it('falls back to the root when nothing nested contains the directory', () => {
    const anchors = [anchor('', 'npm'), anchor('web', 'npm')];
    expect(nearestNpmAnchor(anchors, 'dist')?.dir).toBe('');
  });

  it('ignores cargo anchors entirely', () => {
    const anchors = [anchor('src-tauri', 'cargo')];
    expect(nearestNpmAnchor(anchors, 'src-tauri/dist')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// End to end, against real git repositories.
// ---------------------------------------------------------------------------

const CARGO = (name: string, extra = ''): string =>
  `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2021"\n${extra}`;

describe('a hostile manifest creates no application and no edge', () => {
  let repo: TempRepo;
  let doc: VisualSpecsDoc;

  beforeAll(() => {
    repo = makeTempRepo({
      // An npm `bin` pointing at an absolute path, and one climbing out of the tree.
      'package.json': JSON.stringify(
        { name: 'root', version: '1.0.0', bin: { evil: '/etc/passwd', climb: '../../../etc/hosts' } },
        null,
        2,
      ),
      // A Cargo [[bin]] with an absolute path.
      'crates/engine/Cargo.toml': CARGO('engine', '\n[[bin]]\nname = "evil"\npath = "/etc/passwd"\n'),
      'crates/engine/src/lib.rs': 'pub fn go() {}\n',
      // A file that an absolute declaration could have been clamped onto.
      'etc/passwd': 'not really\n',
    });
    doc = extract(extractOptions(repo.root)).doc;
  });

  afterAll(() => repo?.cleanup()); // see #54: `beforeAll` can throw before assigning

  it('emits no application for an npm bin that is not inside the package', () => {
    expect(doc.nodes.filter((n) => n.kind === 'application')).toEqual([]);
    expect(doc.edges.filter((e) => e.kind === 'entrypoint')).toEqual([]);
  });

  it('emits no application for a Cargo [[bin]] whose path is absolute', () => {
    expect(doc.nodes.some((n) => n.id.startsWith('app:cargo-bin:'))).toBe(false);
  });

  it('never points a relation at the file the clamp would have found', () => {
    const passwd = doc.nodes.find((n) => n.path === 'etc/passwd');
    expect(passwd, 'the decoy file should still be a plain file node').toBeDefined();
    expect(doc.edges.some((e) => e.targetId === passwd?.id)).toBe(false);
  });
});

describe('a document names the commit it describes — or admits it does not', () => {
  // Found the hard way. The extractor lists files from the INDEX (`git ls-files`) but
  // reads their CONTENT from the WORKING TREE. When somebody added a line to a tracked
  // file in the repository being mapped, sixteen `mod` evidence lines shifted by one —
  // and the document went on declaring `commit: e6a0db5` as if nothing had happened.
  //
  // A map that says "this is commit X" while describing something else is asserting a
  // provenance it cannot back up. It is not an error to map work in progress; it is an
  // error not to say that is what you did.

  it('records source.dirty and the modified files when the working tree differs from HEAD', () => {
    const repo = makeTempRepo({
      'package.json': JSON.stringify({ name: 'root', version: '1.0.0' }, null, 2),
      'src/main.ts': 'export const x = 1;\n',
    });
    try {
      // Clean: the document may name its commit without qualification.
      const clean = extract(extractOptions(repo.root)).doc;
      expect(clean.source?.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(clean.source?.dirty).toBeUndefined();
      expect(clean.stats?.['modifiedTrackedFiles']).toEqual([]);

      // Now dirty the tree, exactly as the AgentsCommander checkout was dirtied.
      writeFileSync(join(repo.root, 'src', 'main.ts'), 'export const x = 1;\nexport const y = 2;\n', 'utf8');

      const dirty = extract(extractOptions(repo.root));
      expect(dirty.doc.source?.commit).toMatch(/^[0-9a-f]{40}$/); // still the same commit…
      expect(dirty.doc.source?.dirty).toBe(true); // …and it says the tree is not that commit
      expect(dirty.doc.stats?.['modifiedTrackedFiles']).toEqual(['src/main.ts']);
      expect(dirty.warnings.join(' ')).toContain('DIRTY');
    } finally {
      repo.cleanup();
    }
  });
});

describe('the Tauri bundle needs a frontendDist, not a hopeful command', () => {
  const bundlesOf = (doc: VisualSpecsDoc, appId: string): string[] =>
    doc.edges
      .filter((e) => e.kind === 'bundles' && e.sourceId === appId)
      .map((e) => e.targetId)
      .sort();

  const APP = 'app:tauri:app-tauri/tauri.conf.json';

  function repoWith(build: Record<string, unknown>, extra: Record<string, string> = {}): TempRepo {
    return makeTempRepo({
      'package.json': JSON.stringify({ name: 'root', version: '1.0.0' }, null, 2),
      'app-tauri/Cargo.toml': CARGO('fixture-app'),
      'app-tauri/src/lib.rs': 'pub fn run() {}\n',
      'app-tauri/tauri.conf.json': JSON.stringify({ productName: 'App', build }, null, 2),
      ...extra,
    });
  }

  it('does NOT infer an npm bundle from beforeBuildCommand alone', () => {
    // `npm run build` tells you that a build happens. It does not tell you WHERE the
    // output lands — and the first cut defaulted to the root package and asserted it.
    const repo = repoWith({ beforeBuildCommand: 'npm run build' });
    try {
      const doc = extract(extractOptions(repo.root)).doc;
      // It still bundles its own crate, which is declared, not guessed.
      expect(bundlesOf(doc, APP)).toEqual(['pkg:cargo:app-tauri/Cargo.toml']);
      expect(doc.edges.some((e) => e.kind === 'bundles' && e.targetId.startsWith('pkg:npm:'))).toBe(
        false,
      );
    } finally {
      repo.cleanup();
    }
  });

  it('bundles the npm package that OWNS the frontendDist — the nearest one', () => {
    const repo = repoWith(
      { frontendDist: '../web/dist', beforeBuildCommand: 'npm run build' },
      {
        // A nested npm package which sorts AFTER the root, so a `.find()` would miss it.
        'web/package.json': JSON.stringify({ name: 'web', version: '1.0.0' }, null, 2),
        'web/src/main.ts': 'export const x = 1;\n',
      },
    );
    try {
      const doc = extract(extractOptions(repo.root)).doc;
      expect(bundlesOf(doc, APP)).toEqual([
        'pkg:cargo:app-tauri/Cargo.toml',
        'pkg:npm:web/package.json', // the nested one, not the root
      ]);
      const edge = doc.edges.find(
        (e) => e.kind === 'bundles' && e.targetId === 'pkg:npm:web/package.json',
      );
      expect(edge?.evidence?.[0]?.note).toContain('frontendDist');
      expect(edge?.evidence?.[0]?.note).toContain('web/dist');
    } finally {
      repo.cleanup();
    }
  });

  it('bundles NOTHING npm when the frontendDist is absolute or escapes the repository', () => {
    for (const dist of ['/var/www/dist', '../../../outside/dist', 'C:/dist']) {
      const repo = repoWith({ frontendDist: dist });
      try {
        const doc = extract(extractOptions(repo.root)).doc;
        expect(bundlesOf(doc, APP), dist).toEqual(['pkg:cargo:app-tauri/Cargo.toml']);
      } finally {
        repo.cleanup();
      }
    }
  });
});
