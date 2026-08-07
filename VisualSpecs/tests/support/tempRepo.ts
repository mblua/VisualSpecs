// A git repository built from a map of files, for the cases the shared fixture repo
// cannot express — hostile manifests, a Tauri config with no `frontendDist`, a nested
// npm package that must win over the root one.
//
// It `git init`s for real, so `git ls-files -z` is exercised exactly as it is in
// production. No stubbing of the thing whose behaviour is the point.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ExtractOptions } from '../../tools/extractor/extract.ts';

export interface TempRepo {
  root: string;
  cleanup(): void;
}

export function makeTempRepo(files: Record<string, string>): TempRepo {
  const root = mkdtempSync(join(tmpdir(), 'visual-specs-temp-'));

  const git = (args: string[]): void => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        execFileSync('git', args, { cwd: root, stdio: 'pipe', windowsHide: true });
        return;
      } catch (error) {
        if (attempt === 4 || !isTransientGitObjectLock(error)) throw error;
        // Windows antivirus/indexers can briefly hold a newly-created loose object.
        // Retry only that precise environmental failure; ordinary Git errors remain
        // immediate and visible.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * 2 ** attempt);
      }
    }
  };

  // The writes are INSIDE the guard too (#54). This helper already tore the directory
  // down when git failed, but a throw from `writeFileSync` — a path the caller controls,
  // since `files` comes from the test — landed before the guard and leaked.
  try {
    for (const [relative, content] of Object.entries(files)) {
      const absolute = join(root, ...relative.split('/'));
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, content, 'utf8');
    }

    git(['init', '--quiet']);
    git(['config', 'user.email', 'fixture@example.com']);
    git(['config', 'user.name', 'Fixture']);
    git(['config', 'commit.gpgsign', 'false']);
    git(['add', '-A']);
    git(['commit', '--quiet', '-m', 'fixture']);
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }

  return {
    root,
    cleanup(): void {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function isTransientGitObjectLock(error: unknown): boolean {
  const value = error as { message?: unknown; stderr?: unknown };
  const stderr = Buffer.isBuffer(value.stderr)
    ? value.stderr.toString('utf8')
    : typeof value.stderr === 'string'
      ? value.stderr
      : '';
  const message = typeof value.message === 'string' ? value.message : '';
  const text = `${message}\n${stderr}`;
  return /(?:permission denied|access is denied)/i.test(text) &&
    /\.git[\\/]objects|write (?:commit )?object/i.test(text);
}

export function extractOptions(root: string, over: Partial<ExtractOptions> = {}): ExtractOptions {
  return {
    repo: root,
    out: 'data/temp.json',
    name: 'temp',
    hierarchy: 'logical',
    invokeFacade: 'transport.invoke',
    allowBareInvoke: false,
    snippets: false,
    tsconfig: undefined,
    flags: [],
    stamp: false,
    ...over,
  };
}
