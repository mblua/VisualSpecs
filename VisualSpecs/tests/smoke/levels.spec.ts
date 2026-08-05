// The half of criterion 8 that decides: the FRAME (Issue #44).
//
// Counting 430 `pack()` calls and 1.90 ms in Node says where the time went. It does not
// say whether the map feels heavy, and a millisecond in Node does not predict a frame of
// Chromium with the render on top. This is that second half, in the only form that is
// achievable: "p95 ≤ 16 ms from input to painted frame" cannot be met by ANY rAF-coalesced
// implementation, not even one that does no work, because waiting for the next vsync is
// already 16.7 ms. So the assertion is that turning Levels on does not STRETCH the frame.
//
// The comparison is the same control driven in both modes, at expand-all — the worst case
// the corpus offers. The only difference between the two runs is the mode, so a stretch is
// the LevelPack and the bands and nothing else.

import { expect, test, type Page } from '@playwright/test';

async function boot(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  await page.goto('/');
  await page.waitForSelector('.canvas-host canvas');
  await page.waitForFunction(() => '__visualSpecs' in globalThis);
  await page.waitForTimeout(400);
  return errors;
}

function legendRow(page: Page, label: string) {
  return page.locator('.legend-row', { hasText: label }).first();
}

/** Inter-frame intervals while driving a control on every frame — what a drag does. If
 *  the work does not fit in a frame the intervals stretch, and that is the only thing
 *  "does it stutter" can mean. */
async function drivenFrames(page: Page): Promise<number[]> {
  return page.evaluate(async () => {
    const input = document.querySelector('#focus-transparency');
    if (!(input instanceof HTMLInputElement)) throw new Error('no transparency control');
    const gaps: number[] = [];
    let previous = 0;
    let i = 0;
    await new Promise<void>((resolve) => {
      const tick = (now: number): void => {
        if (previous !== 0) gaps.push(now - previous);
        previous = now;
        input.value = String(30 + (i % 40));
        input.dispatchEvent(new Event('input', { bubbles: true }));
        i += 1;
        if (i < 60) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
    return gaps.slice(4);
  });
}

const pct = (xs: number[], p: number): number => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
};

test('interaction budget: Levels mode does not stretch the frame, at expand-all', async ({ page }) => {
  const errors = await boot(page);

  // The worst case the corpus offers: every container open.
  await page.locator('.canvas-host').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('e');
  await page.waitForTimeout(1200);

  const withoutLevels = await drivenFrames(page);

  await legendRow(page, 'levels').click();
  await page.waitForTimeout(800);
  const withLevels = await drivenFrames(page);

  // The bands are actually on screen, or this measures nothing.
  const bands = await page.evaluate(
    () =>
      (globalThis as unknown as { __visualSpecs: { scene(): { bands?: unknown[] } } }).__visualSpecs.scene()
        .bands?.length ?? 0,
  );
  expect(bands).toBeGreaterThan(0);

  const off95 = pct(withoutLevels, 0.95);
  const on95 = pct(withLevels, 0.95);
  // eslint-disable-next-line no-console
  console.log(
    `[levels] expand-all frame interval p50/p95 — levels off ${pct(withoutLevels, 0.5).toFixed(2)}/${off95.toFixed(2)}ms, ` +
      `levels on ${pct(withLevels, 0.5).toFixed(2)}/${on95.toFixed(2)}ms; ${String(bands)} bands drawn`,
  );

  expect(on95).toBeLessThanOrEqual(off95 + 8);
  expect(errors).toEqual([]);
});

test('switching basis on an already-ranked basis costs no ranking', async ({ page }) => {
  // The cost criterion, as the user meets it: the FIRST calculation of a basis is paid
  // once and declared; every later switch runs the rank pipeline zero times. Measured as
  // "the second switch back is not slower than the first one forward" — if the memo were
  // keyed without the basis, or missing, every switch would pay the full re-rank.
  await boot(page);
  await page.locator('.canvas-host').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('e');
  await page.waitForTimeout(1200);

  await legendRow(page, 'levels').click();
  await page.waitForTimeout(800);

  const timings = await page.evaluate(async () => {
    const rows = [...document.querySelectorAll('.legend-row')];
    const proposed = rows.find((r) => (r.textContent ?? '').trim().startsWith('proposed'));
    if (!(proposed instanceof HTMLElement)) throw new Error('no basis control');
    const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 300));
    const time = async (): Promise<number> => {
      const t = performance.now();
      proposed.click();
      const ms = performance.now() - t;
      await settle();
      return ms;
    };
    const first = await time(); // observed → proposed: pays the ranking, once
    const second = await time(); // back to observed: already memoized
    const third = await time(); // → proposed again: already memoized
    return { first, second, third };
  });

  // eslint-disable-next-line no-console
  console.log(
    `[levels] basis switch — first ${timings.first.toFixed(1)}ms, back ${timings.second.toFixed(1)}ms, ` +
      `again ${timings.third.toFixed(1)}ms`,
  );

  // Every switch after a basis has been computed is re-layout and render only. The bound
  // is generous because it runs on whatever CI gives us; what it catches is a memo that
  // does not hold — which would make the third switch cost the same as the first.
  expect(timings.third).toBeLessThanOrEqual(Math.max(timings.first * 0.75, 8));
});
