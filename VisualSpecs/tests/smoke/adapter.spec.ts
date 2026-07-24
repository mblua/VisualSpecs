// The EARLY browser gate (§8.2, §13 step 4, and the coordinator's third dissent).
//
// It runs the SHARED conformance suite against the real Canvas2DRenderer, in a real
// browser, with real pointer events — which is the only place hit-testing and event
// ordering can be proven. It needs no dataset, no extractor and no detail panel, so
// it is runnable from the moment the adapter exists:
//
//     npm run smoke:adapter
//
// `FakeRenderer` cannot substitute for this, and this cannot substitute for the
// acceptance smoke. They prove different things, and both are mandatory.

import { expect, test } from '@playwright/test';

interface CaseResult {
  name: string;
  status: 'pass' | 'fail' | 'skip';
  message?: string;
}
interface Report {
  adapter: string;
  results: CaseResult[];
  passed: number;
  failed: number;
  skipped: number;
}

test('Canvas2DRenderer passes the shared GraphRenderer conformance suite', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('pageerror', (err) => consoleErrors.push(err.message));

  await page.goto('/conformance.html');
  await page.waitForFunction(() => '__CONFORMANCE__' in globalThis, undefined, { timeout: 30_000 });

  const report = (await page.evaluate(
    () => (globalThis as unknown as Record<string, unknown>)['__CONFORMANCE__'],
  )) as Report;

  const failures = report.results.filter((r) => r.status === 'fail');
  expect(
    failures.map((f) => `${f.name}: ${f.message ?? ''}`),
    'the adapter must pass every case in the shared suite',
  ).toEqual([]);

  // And it must actually have RUN the input cases that FakeRenderer skips —
  // a real adapter owns real input, and that is the whole point of this file.
  expect(report.skipped, 'a DOM adapter must not skip the input cases').toBe(0);
  expect(report.passed).toBeGreaterThanOrEqual(21);
  expect(consoleErrors).toEqual([]);
});
