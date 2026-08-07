// The watch loop: hybrid fingerprint, debounce state machine, scheduler, and the
// real-loop integration cases of plan/9-extract-watch.md §Verification 3–9.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extract, type ExtractResult } from '../../tools/extractor/extract.ts';
import { ExtractorError, EXIT } from '../../tools/extractor/errors.ts';
import { writeFileAtomic, writeIfChanged } from '../../tools/extractor/output.ts';
import { assembleExtractOptions, type WatchTarget } from '../../tools/extractor/watchconfig.ts';
import {
  DEFERRED_WARN_TICKS,
  FORCED_EXTRACT_TICKS,
  UNAVAILABLE_WARN_TICKS,
  afterExtractFailure,
  afterWriteFailure,
  createWatcher,
  fingerprintRepo,
  initialRepoState,
  operationInProgress,
  parsePorcelainZ,
  resolveGitDir,
  shouldLogRetry,
  tickRepo,
  type RepoState,
  type WatchIo,
} from '../../tools/extractor/watch.ts';

// ── helpers ──────────────────────────────────────────────────────────────────

interface TinyRepo {
  root: string;
  git(args: string[]): string;
  write(rel: string, content: string | Buffer): void;
  cleanup(): void;
}

function makeTinyRepo(prefix: string): TinyRepo {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const git = (args: string[]): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe', windowsHide: true });
  const write = (rel: string, content: string | Buffer): void => {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), content);
  };
  // Same guard as `makeFixtureRepo`, for the same reason (#54): the handle that owns
  // `cleanup` is only returned on the success path, so a throw from the writes or from
  // git used to leave the directory behind with nobody holding a reference. The original
  // error is re-thrown untouched — it is the one that names the cause.
  try {
    write('package.json', '{"name":"tiny"}\n');
    // A tsconfig makes the TS import pass run, and the two committed deps give
    // edits a way to CHANGE the document (an edge appears/moves). Without them,
    // content edits are invisible to the extractor and every rewrite would be
    // skip-identical'd - correct, but useless for these tests.
    write('tsconfig.json', '{"compilerOptions":{"allowImportingTsExtensions":true,"noEmit":true}}\n');
    write('src/main.ts', 'export const x = 1;\n');
    write('src/dep1.ts', 'export const d1 = 1;\n');
    write('src/dep2.ts', 'export const d2 = 2;\n');
    git(['init', '--quiet']);
    git(['config', 'user.email', 't@example.com']);
    git(['config', 'user.name', 'T']);
    git(['config', 'commit.gpgsign', 'false']);
    git(['add', '-A']);
    git(['commit', '--quiet', '-m', 'tiny']);
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }

  return {
    root,
    git,
    write,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

// ── porcelain parsing (final pass 3) ─────────────────────────────────────────

describe('parsePorcelainZ', () => {
  it('parses plain modified entries', () => {
    expect(parsePorcelainZ(' M a.ts\0 D b.ts\0')).toEqual(['a.ts', 'b.ts']);
  });
  it('consumes BOTH fields of a rename entry', () => {
    expect(parsePorcelainZ('R  new.ts\0old.ts\0 M c.ts\0')).toEqual(['new.ts', 'c.ts']);
  });
  it('handles copies and empty input', () => {
    expect(parsePorcelainZ('C  copy.ts\0orig.ts\0')).toEqual(['copy.ts']);
    expect(parsePorcelainZ('')).toEqual([]);
  });
});

// ── hybrid fingerprint against a real repo (§Verification 3) ─────────────────

describe('fingerprintRepo (hybrid)', () => {
  let repo: TinyRepo;
  beforeAll(() => {
    repo = makeTinyRepo('vs-fp-');
  });
  afterAll(() => {
    repo?.cleanup(); // see #54: `beforeAll` can throw before assigning
  });

  it('walks the pinned scenario chain', () => {
    const clean = fingerprintRepo(repo.root);
    expect(clean).not.toBeNull();

    // touch of a CLEAN tracked file → NO change (the false positive is gone by design)
    const stamp = new Date(Date.now() - 60_000);
    utimesSync(join(repo.root, 'package.json'), stamp, stamp);
    expect(fingerprintRepo(repo.root)).toBe(clean);

    // untracked file → NO change (not in the map at all)
    repo.write('scratch.txt', 'junk');
    expect(fingerprintRepo(repo.root)).toBe(clean);

    // edit a clean tracked file → change (enters the porcelain set)
    repo.write('src/main.ts', 'export const x = 1;\nexport const y = 2;\n');
    const dirty1 = fingerprintRepo(repo.root);
    expect(dirty1).not.toBe(clean);

    // edit the ALREADY-DIRTY file again → change (the porcelain-killer, pinned)
    repo.write('src/main.ts', 'export const x = 1;\nexport const y = 2;\nexport const z = 3;\n');
    const dirty2 = fingerprintRepo(repo.root);
    expect(dirty2).not.toBe(dirty1);

    // assume-unchanged toggle on the dirty file → change (porcelain input, A1-F5)
    repo.git(['update-index', '--assume-unchanged', 'src/main.ts']);
    const hidden = fingerprintRepo(repo.root);
    expect(hidden).not.toBe(dirty2);
    repo.git(['update-index', '--no-assume-unchanged', 'src/main.ts']);

    // revert the dirty file to HEAD → change (leaves the porcelain set)
    repo.git(['checkout', '--', 'src/main.ts']);
    const reverted = fingerprintRepo(repo.root);
    expect(reverted).not.toBe(dirty2);

    // a commit → change (HEAD input)
    repo.write('src/main.ts', 'export const x = 42;\n');
    repo.git(['add', '-A']);
    repo.git(['commit', '--quiet', '-m', 'edit']);
    const committed = fingerprintRepo(repo.root);
    expect(committed).not.toBe(reverted);

    // git mv (staged rename): two NUL fields survive the parser (final pass 3a)
    repo.git(['mv', 'src/main.ts', 'src/renamed.ts']);
    const renamed = fingerprintRepo(repo.root);
    expect(renamed).not.toBe(committed);
    repo.git(['mv', 'src/renamed.ts', 'src/main.ts']);

    // tracked file deleted WITHOUT staging: no throw, change via porcelain (3b)
    rmSync(join(repo.root, 'package.json'));
    const deleted = fingerprintRepo(repo.root);
    expect(deleted).not.toBe(committed);
    repo.git(['checkout', '--', 'package.json']);
  });

  it('returns null for a directory that is not a git repository', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vs-nogit-'));
    try {
      expect(fingerprintRepo(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── git dir resolution + markers, incl. linked worktree (final pass 2) ───────

describe('operation markers', () => {
  it('finds markers under the resolved git dir of a normal repo', () => {
    const repo = makeTinyRepo('vs-marker-');
    try {
      const gitDir = resolveGitDir(repo.root);
      expect(gitDir).not.toBeNull();
      expect(operationInProgress(gitDir as string)).toBeNull();
      writeFileSync(join(gitDir as string, 'MERGE_HEAD'), 'deadbeef\n');
      expect(operationInProgress(gitDir as string)).toBe('MERGE_HEAD');
    } finally {
      repo.cleanup();
    }
  });

  it('resolves a LINKED WORKTREE git dir (never a hardcoded <root>/.git)', () => {
    const repo = makeTinyRepo('vs-wt-');
    const wtRoot = join(repo.root, '..', `vs-wt-linked-${String(process.pid)}`);
    try {
      repo.git(['worktree', 'add', '--quiet', wtRoot, '-b', 'wt-branch']);
      const gitDir = resolveGitDir(wtRoot);
      expect(gitDir).not.toBeNull();
      expect((gitDir as string).includes('worktrees')).toBe(true);
      expect(operationInProgress(gitDir as string)).toBeNull();
      mkdirSync(join(gitDir as string, 'rebase-merge'), { recursive: true });
      expect(operationInProgress(gitDir as string)).toBe('rebase-merge');
    } finally {
      rmSync(wtRoot, { recursive: true, force: true });
      repo.cleanup();
    }
  });
});

// ── debounce state machine (§Verification 4, 5) ──────────────────────────────

describe('tickRepo state machine', () => {
  const run = (
    state: RepoState,
    fps: readonly (string | null)[],
    marker: string | null = null,
  ): { state: RepoState; actions: string[]; notes: string[] } => {
    const actions: string[] = [];
    const notes: string[] = [];
    for (const fp of fps) {
      const r = tickRepo(state, fp, marker);
      state = r.state;
      actions.push(r.action.kind + ('forced' in r.action && r.action.forced ? ':forced' : ''));
      notes.push(...r.notes);
    }
    return { state, actions, notes };
  };

  it('extracts only when the fingerprint is stable across two consecutive ticks', () => {
    const { actions } = run(initialRepoState(), ['A', 'A']);
    expect(actions).toEqual(['none', 'extract']);
  });

  it('coalesces a burst into one extraction', () => {
    const { actions } = run(initialRepoState(), ['A', 'B', 'B']);
    expect(actions).toEqual(['none', 'none', 'extract']);
  });

  it('forces extraction at the K-th consecutive unstable tick (A1-F7)', () => {
    const fps = ['A', 'B', 'C', 'D', 'E'];
    const { actions } = run(initialRepoState(), fps);
    expect(actions.slice(0, FORCED_EXTRACT_TICKS - 1)).toEqual(['none', 'none', 'none', 'none']);
    expect(actions[FORCED_EXTRACT_TICKS - 1]).toBe('extract:forced');
  });

  it('defers forced-K while a git operation marker is present, and warns once', () => {
    let state = initialRepoState();
    const fps: string[] = [];
    for (let i = 0; i < FORCED_EXTRACT_TICKS - 1 + DEFERRED_WARN_TICKS + 2; i += 1) {
      fps.push(`fp${String(i)}`);
    }
    const { state: after, actions, notes } = run(state, fps, 'rebase-merge');
    expect(actions.every((a) => a === 'none')).toBe(true);
    expect(notes.filter((n) => n === 'deferred-warn')).toHaveLength(1);

    // marker gone, churn continues → forced extraction resumes with a note
    const resumed = tickRepo(after, 'fresh', null);
    expect(resumed.action.kind).toBe('extract');
    expect(resumed.notes).toContain('deferred-resumed');
  });

  it('warns once after 30 unavailable ticks, and notes recovery (A1-P2-3)', () => {
    const fps: (string | null)[] = Array.from({ length: UNAVAILABLE_WARN_TICKS + 3 }, () => null);
    const { state, notes } = run(initialRepoState(), fps);
    expect(notes.filter((n) => n === 'unavailable-warn')).toHaveLength(1);
    const back = tickRepo(state, 'A', null);
    expect(back.notes).toContain('unavailable-recovered');
  });

  it('parks a deterministic extract-failure: same state is not retried (A1-F4)', () => {
    let state = afterExtractFailure(initialRepoState(), 'BROKEN');
    const same = tickRepo(state, 'BROKEN', null);
    expect(same.action.kind).toBe('none');
    // the repo moves → normal debounce applies again
    const moved = run(same.state, ['FIXED', 'FIXED']);
    expect(moved.actions).toEqual(['none', 'extract']);
  });

  it('retries ONLY the write for a pending good extraction (A1-F4 / A1-P1-2)', () => {
    const state = afterWriteFailure(initialRepoState(), 'GOOD', '{"doc":1}');
    const r = tickRepo(state, 'GOOD', null);
    expect(r.action.kind).toBe('retry-write');
    // and the retry keeps happening while the repo stays quiet
    expect(tickRepo(r.state, 'GOOD', null).action.kind).toBe('retry-write');
  });

  it('throttles retry logging: first, every 30th, publish (pre-verification 4.b)', () => {
    expect(shouldLogRetry(0)).toBe(true);
    expect(shouldLogRetry(1)).toBe(false);
    expect(shouldLogRetry(29)).toBe(false);
    expect(shouldLogRetry(30)).toBe(true);
    expect(shouldLogRetry(60)).toBe(true);
  });
});

// ── scheduler (§Verification 6) ──────────────────────────────────────────────

describe('scheduler (A1-P1-1)', () => {
  it('slow tick → zero delay + one stretch log; fast tick → interval-tick delay', () => {
    let clock = 0;
    let tickCost = 2_500;
    const scheduled: { fn: () => void; ms: number }[] = [];
    const infos: string[] = [];

    const state = { fp: 'A' };
    const target: WatchTarget = {
      options: assembleExtractOptions({ repo: 'unused', out: 'unused.json' }),
      label: 'fake',
    };
    const io: WatchIo = {
      fingerprint: () => {
        clock += tickCost;
        return state.fp;
      },
      opMarker: () => null,
      extract: () => ({ text: '{}', warnings: [], doc: { nodes: [], edges: [] } }) as unknown as ExtractResult,
      publish: () => ({ written: true }),
      onExtracted: () => {},
      onError: () => {},
      info: (line) => infos.push(line),
      now: () => clock,
      schedule: (fn, ms) => {
        scheduled.push({ fn, ms });
        return { cancel: () => {} };
      },
    };

    const watcher = createWatcher([target], 1_000, tmpdir(), io);
    watcher.start();
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.ms).toBe(1_000); // first tick armed at the interval

    scheduled[0]?.fn(); // tick 1: costs 2500 ms > interval
    expect(scheduled).toHaveLength(2);
    expect(scheduled[1]?.ms).toBe(0); // cadence stretched: re-arm immediately
    expect(infos.filter((l) => l.includes('longer than --interval'))).toHaveLength(1);

    scheduled[1]?.fn(); // tick 2: still slow — but NO second stretch log
    expect(infos.filter((l) => l.includes('longer than --interval'))).toHaveLength(1);

    tickCost = 100;
    scheduled[2]?.fn(); // tick 3: fast again
    expect(scheduled[3]?.ms).toBe(900); // interval minus tick duration
    watcher.stop();
  });
});

// ── the real loop over real repos (§Verification 7, 8) ───────────────────────

describe('watch loop integration (two tiny repos, manual ticks)', () => {
  let repoA: TinyRepo;
  let repoB: TinyRepo;
  let workRoot: string;

  interface Recorded {
    label: string;
    written: boolean;
    startup: boolean;
  }
  const events: Recorded[] = [];
  const errors: { label: string; phase: string; exitCode?: number }[] = [];
  const infos: string[] = [];
  let publishFailOnceFor: string | null = null;

  const outOf = (label: string): string => join(workRoot, `${label}.json`);

  beforeAll(() => {
    repoA = makeTinyRepo('vs-loop-a-');
    repoB = makeTinyRepo('vs-loop-b-');
    workRoot = mkdtempSync(join(tmpdir(), 'vs-loop-out-'));
  });
  afterAll(() => {
    // This is the exact pair that produced the `TypeError` in #54: `makeTinyRepo` threw
    // on `git commit` (Permission denied under contention), `repoA` stayed undefined,
    // and the teardown error is what a reader saw instead of the git one.
    repoA?.cleanup();
    repoB?.cleanup();
    rmSync(workRoot, { recursive: true, force: true });
  });

  const makeTargets = (): WatchTarget[] => [
    { options: assembleExtractOptions({ repo: repoA.root, out: 'A.json', name: 'A' }), label: 'A' },
    { options: assembleExtractOptions({ repo: repoB.root, out: 'B.json', name: 'B' }), label: 'B' },
  ];

  const io: WatchIo = {
    fingerprint: fingerprintRepo,
    opMarker: (root) => {
      const gitDir = resolveGitDir(root);
      return gitDir === null ? null : operationInProgress(gitDir);
    },
    extract,
    publish: (target, text) => {
      if (publishFailOnceFor === target.label) {
        publishFailOnceFor = null;
        const err = new Error('simulated lock') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      }
      return writeIfChanged(target.options.out, text, workRoot);
    },
    onExtracted: (target, _result, _timing, written, startup) => {
      events.push({ label: target.label, written, startup });
    },
    onError: (target, error, phase) => {
      errors.push({
        label: target.label,
        phase,
        ...(error instanceof ExtractorError ? { exitCode: error.exitCode } : {}),
      });
    },
    info: (line) => infos.push(line),
    now: Date.now,
    schedule: () => ({ cancel: () => {} }), // ticks are driven manually
  };

  it('startup pass extracts every target once, before any tick (A1-P2-1)', () => {
    const watcher = createWatcher(makeTargets(), 200, workRoot, io);
    watcher.start();
    expect(events.map((e) => `${e.label}:${String(e.startup)}:${String(e.written)}`)).toEqual([
      'A:true:true',
      'B:true:true',
    ]);
    const parsedA = JSON.parse(readFileSync(outOf('A'), 'utf8')) as { formatVersion?: string };
    expect(parsedA.formatVersion).toBe('1.0');

    // no repo change → a tick does nothing
    events.length = 0;
    watcher.tickOnce();
    expect(events).toEqual([]);

    // edit a tracked file in A → change tick (unstable) + stable tick → only A re-extracts
    const mtimeBBefore = statSync(outOf('B')).mtimeMs;
    repoA.write('src/main.ts', 'export const x = 1;\nexport const added = true;\n');
    watcher.tickOnce(); // sees movement, debounces
    expect(events).toEqual([]);
    watcher.tickOnce(); // stable → extract
    expect(events).toEqual([{ label: 'A', written: true, startup: false }]);
    expect(statSync(outOf('B')).mtimeMs).toBe(mtimeBBefore);

    // deterministic extract-failure in A: watcher survives, B still works (§V.8)
    events.length = 0;
    writeFileSync(join(repoA.root, 'src/main.ts'), Buffer.from([0xff, 0xfe, 0x27, 0x0a]));
    watcher.tickOnce();
    watcher.tickOnce();
    expect(errors.some((e) => e.label === 'A' && e.phase === 'extract' && e.exitCode === EXIT.invalidEncoding)).toBe(true);
    expect(events).toEqual([]);

    // the SAME broken fingerprint is not retried every tick
    const errorCount = errors.length;
    watcher.tickOnce();
    expect(errors.length).toBe(errorCount);

    repoB.write('src/main.ts', 'export const x = 2;\n');
    watcher.tickOnce();
    watcher.tickOnce();
    expect(events).toEqual([{ label: 'B', written: true, startup: false }]);

    // fix A → next change extracts cleanly
    events.length = 0;
    // the new import CHANGES the document — an edit invisible to the extractor
    // would be skip-identical'd (written: false), which is the feature, not the
    // point under test here
    repoA.write('src/main.ts', "import { d1 } from './dep1.ts';\nexport const x = 1;\n");
    watcher.tickOnce();
    watcher.tickOnce();
    expect(events.map((e) => `${e.label}/${String(e.written)}/${String(e.startup)}`)).toEqual(['A/true/false']);

    // write-failure: extraction succeeds, publish fails once → text retained, the
    // WRITE ALONE retried on the next tick with no further repo change (A1-P1-2)
    events.length = 0;
    publishFailOnceFor = 'A';
    repoA.write('src/main.ts', "import { d2 } from './dep2.ts';\nexport const x = 1;\n");
    watcher.tickOnce();
    watcher.tickOnce(); // extract ok, publish throws EPERM
    expect(errors.some((e) => e.label === 'A' && e.phase === 'write')).toBe(true);
    expect(events).toEqual([]);
    const staleText = readFileSync(outOf('A'), 'utf8');
    watcher.tickOnce(); // repo untouched: retry-write publishes the pending text
    expect(readFileSync(outOf('A'), 'utf8')).not.toBe(staleText);
    expect(infos.some((l) => l.includes('pending output published'))).toBe(true);
    watcher.stop();
  });
});

// ── torn-file check: concurrent reader during N≥50 atomic rewrites (§V.9) ────

describe('torn-file contract', () => {
  it('a concurrent JSON.parse reader never sees a partial document', async () => {
    const workRoot = mkdtempSync(join(tmpdir(), 'vs-torn-'));
    const outPath = join(workRoot, 'data', 'doc.json');
    const resultPath = join(workRoot, 'reader-result.json');
    const readerScript = join(workRoot, 'reader.mjs');
    writeFileSync(
      readerScript,
      [
        "import { readFileSync, writeFileSync } from 'node:fs';",
        'const [out, result, durationMs] = process.argv.slice(2);',
        'const deadline = Date.now() + Number(durationMs);',
        'let ok = 0, torn = 0, transient = 0;',
        'while (Date.now() < deadline) {',
        '  try { JSON.parse(readFileSync(out, "utf8")); ok += 1; }',
        '  catch (err) {',
        '    if (err instanceof SyntaxError) torn += 1; else transient += 1;',
        '  }',
        '}',
        'writeFileSync(result, JSON.stringify({ ok, torn, transient }));',
      ].join('\n'),
    );

    writeFileAtomic('data/doc.json', JSON.stringify({ i: -1 }), workRoot);

    const reader = spawn(process.execPath, [readerScript, outPath, resultPath, '2500'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const exited = new Promise<number | null>((resolvePromise) => {
      reader.on('exit', (code) => resolvePromise(code));
    });

    const pad = 'x'.repeat(64 * 1024); // large enough that a torn write would be VISIBLE
    for (let i = 0; i < 60; i += 1) {
      writeFileAtomic('data/doc.json', JSON.stringify({ i, pad }), workRoot);
      sleepSync(15);
    }

    const code = await exited;
    expect(code).toBe(0);
    const result = JSON.parse(readFileSync(resultPath, 'utf8')) as {
      ok: number;
      torn: number;
      transient: number;
    };
    rmSync(workRoot, { recursive: true, force: true });

    expect(result.torn).toBe(0); // the contract: NEVER a partial/torn document
    expect(result.ok).toBeGreaterThan(50); // and the reader really was reading throughout
  }, 25_000);
});
