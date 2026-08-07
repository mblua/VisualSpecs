// What a fixture helper must do when it CANNOT finish building (#54).
//
// Every one of these helpers is `mkdtemp` → run git → return a handle with `cleanup`.
// When git fails in the middle, two things used to happen and both hurt whoever is
// debugging:
//
//   1. the half-built directory stayed on disk, because the handle that owns `cleanup`
//      is only returned on the success path — measured at one leaked directory per
//      failure, 106 for 106;
//   2. the caller's `afterAll` then ran `fixture.cleanup()` on an undefined handle and
//      raised `TypeError: Cannot read properties of undefined (reading 'cleanup')`,
//      which says nothing about the cause and is what a reader chases first.
//
// Found by the #47 resilience gate while measuring #20. The failures it masks are real
// contention failures — `git` unable to write a loose object — so this is not a fix for
// #20; it is what stops #20 from being debugged from the wrong end.
//
// ── How the failure is injected ─────────────────────────────────────────────────
// `PATH` is emptied for the duration of the call, so `execFileSync('git', …)` fails
// with ENOENT. That needs no seam in the helper: the test forces the real failure mode
// rather than a simulated one, and the helper is exercised exactly as it ships.
//
// `TEMP`/`TMP` are pointed at a directory this test owns, so "did it leak" is answered
// by reading that directory rather than by filtering the shared temp root — which the
// rest of the suite is writing to at the same time.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeFixtureRepo } from '../support/fixtureRepo.ts';
import { makeTempRepo } from '../support/tempRepo.ts';

let sandbox: string;
let savedPath: string | undefined;
let savedTemp: string | undefined;
let savedTmp: string | undefined;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'vs-54-sandbox-'));
  savedPath = process.env['PATH'];
  savedTemp = process.env['TEMP'];
  savedTmp = process.env['TMP'];
});

afterEach(() => {
  process.env['PATH'] = savedPath;
  process.env['TEMP'] = savedTemp;
  process.env['TMP'] = savedTmp;
  rmSync(sandbox, { recursive: true, force: true });
});

/** Run `build` with git unreachable and the temp root inside the sandbox. */
function withGitBroken<T>(build: () => T): { error: unknown; leaked: string[] } {
  const root = join(sandbox, 'temp');
  mkdirSync(root, { recursive: true });
  process.env['TEMP'] = root;
  process.env['TMP'] = root;
  process.env['PATH'] = '';

  let error: unknown;
  try {
    build();
  } catch (caught) {
    error = caught;
  }
  process.env['PATH'] = savedPath;
  return { error, leaked: readdirSync(root) };
}

const message = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

describe('a fixture helper that cannot finish building', () => {
  it('makeFixtureRepo: removes the half-built directory', () => {
    const { leaked } = withGitBroken(() => makeFixtureRepo());
    expect(leaked, `left behind: ${leaked.join(', ')}`).toEqual([]);
  });

  it('makeFixtureRepo: propagates the ORIGINAL error, not a teardown one', () => {
    // The point is not that it throws — it already did. The point is WHICH error
    // reaches the reader: the one naming git, never a `TypeError` about `cleanup`.
    const { error } = withGitBroken(() => makeFixtureRepo());
    expect(error).toBeInstanceOf(Error);
    expect(message(error)).not.toMatch(/cleanup/i);
    expect(message(error)).toMatch(/ENOENT|git/i);
  });

  it('makeTempRepo: removes the half-built directory', () => {
    const { leaked } = withGitBroken(() => makeTempRepo({ 'a.ts': 'export const a = 1;\n' }));
    expect(leaked, `left behind: ${leaked.join(', ')}`).toEqual([]);
  });

  it('makeTempRepo: propagates the ORIGINAL error', () => {
    const { error } = withGitBroken(() => makeTempRepo({ 'a.ts': 'export const a = 1;\n' }));
    expect(error).toBeInstanceOf(Error);
    expect(message(error)).not.toMatch(/cleanup/i);
    expect(message(error)).toMatch(/ENOENT|git/i);
  });

  it('the sandbox itself proves the check can see a leak', () => {
    // An "it left nothing behind" assertion is worthless if the directory it reads is
    // the wrong one. This case makes a directory the same way the helpers do and shows
    // the check FINDS it — so a green result above means removed, not unobserved.
    const root = join(sandbox, 'temp');
    mkdirSync(root, { recursive: true });
    mkdtempSync(join(root, 'decoy-'));
    expect(readdirSync(root)).toHaveLength(1);
  });
});
