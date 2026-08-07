import { defineConfig } from '@playwright/test';

// Three projects, and a gate that is allowed to be trusted.
//
//   adapter     — the shared conformance suite against Canvas2DRenderer, on a
//                 synthetic fixture scene. Needs no dataset and no UI, so it is
//                 runnable from step 4 onward: `npm run smoke:adapter`.
//   acceptance  — the whole product against the REAL committed dataset, at three
//                 viewports. This is the one `npm run verify` runs, and it may not be
//                 weakened.
//   screenshots — the canonical README captures. NOT part of `verify`: a gate that
//                 rewrites the documentation it is supposed to be checking is a gate
//                 that cannot fail cleanly. `npm run update:screenshots`.
//
// ── Why the web server is spawned the way it is ──────────────────────────────
//
// `reuseExistingServer: true` means a stale server from an earlier run can answer the
// smoke, so the tests pass against a tree that is not the one on disk. That is a
// FALSE GREEN, and a reviewer caught one: `npm run verify` exited 0 while a Vite from
// a previous run was still listening on 5175.
//
// It is `false` now, and `--strictPort` makes Vite fail rather than drift to another
// port — so an occupied port fails the gate instead of quietly bypassing it.
//
// Vite is launched as `node .../vite.js` rather than `npm run dev` because on Windows
// Playwright kills the process it spawned: with npm in the middle, that is the npm
// wrapper, and the real Vite process is orphaned and keeps the port. Spawning node
// directly means the thing Playwright kills is the thing that is listening.
export default defineConfig({
  testDir: './tests/smoke',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results',
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:5175',
    viewport: { width: 1680, height: 1000 },
    deviceScaleFactor: 1,
  },
  projects: [
    { name: 'adapter', testMatch: /(adapter|projectStore)\.spec\.ts/ },
    { name: 'acceptance', testMatch: /(acceptance|projectUi|followFile|focus|levels|modeAnchor)\.spec\.ts/ },
    { name: 'screenshots', testMatch: /screenshots\.spec\.ts/ },
  ],
  webServer: {
    command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5175 --strictPort',
    url: 'http://localhost:5175',
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
