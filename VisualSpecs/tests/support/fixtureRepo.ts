// Visual Specs tests must pass on a clean checkout of CodebaseConstellation,
// where AgentsCommander — a DIFFERENT repository — is simply absent (§10.7).
//
// So the extractor's tests run against a small fixture repo, which is materialised
// into a temp directory and `git init`ed at test time. That exercises the real
// `git ls-files -z` path rather than stubbing it, and it commits no nested `.git`.

import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE_SOURCE = fileURLToPath(
  new URL('../../tools/extractor/fixtures/fixture-repo', import.meta.url),
);

export interface FixtureRepo {
  root: string;
  cleanup(): void;
}

export function makeFixtureRepo(): FixtureRepo {
  const root = mkdtempSync(join(tmpdir(), 'visual-specs-fixture-'));

  // Everything that can fail runs INSIDE the guard, because the handle that owns
  // `cleanup` only reaches the caller on the success path — so a throw from here used to
  // strand the directory with nobody left holding a reference to it. One leaked
  // directory per failure, and under the contention in #20 that is not a rare path
  // (#54). `git` failing to write a loose object is a real, recurring failure here.
  //
  // The original error is re-thrown untouched: it names the cause, and it is the one the
  // reader needs. Losing it behind a teardown error is what made #20 get debugged from
  // the wrong end.
  try {
    cpSync(FIXTURE_SOURCE, root, { recursive: true });

    const git = (args: string[]): void => {
      execFileSync('git', args, { cwd: root, stdio: 'pipe', windowsHide: true });
    };
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
