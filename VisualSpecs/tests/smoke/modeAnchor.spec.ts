// The view modes are anchored to the foot of the Explorer (Issue #48).
//
// The defect this covers is not that the control was broken — it worked, and nobody could
// see it. It was the last row of the legend, and the legend's length is a function of how
// many KINDS the corpus has, so how much of the feature a person could reach depended on
// their window height and on their repository. Neither is a property of the control.
//
// Every assertion here is about what is REACHABLE at a given viewport, which is the only
// form the defect had. They run at 700 px tall because that is the acceptance criterion;
// the old layout needed 1293 px.

import { expect, test, type Page } from '@playwright/test';

// 700 px tall is the acceptance criterion. The WIDTH is the suite's usual 1680: below
// 1664 the Project rail and the Explorer are mutually exclusive (`applyLayout`), so a
// narrower window would hide the panel outright and the test would be measuring the
// responsive layout instead of the anchoring.
const SHORT = { width: 1680, height: 700 };

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

/** Is this element fully inside the viewport, without anybody scrolling anything? */
async function fullyVisible(page: Page, selector: string, text: string): Promise<boolean> {
  return page.evaluate(
    ({ sel, label }) => {
      const row = [...document.querySelectorAll(sel)].find(
        (e) => (e.textContent ?? '').trim().startsWith(label),
      );
      if (row === undefined) return false;
      const r = row.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= window.innerHeight && r.height > 0;
    },
    { sel: selector, label: text },
  );
}

/** A document with many more kinds than AgentsCommander, so the legend is long. */
function manyKindsDoc(kinds: number): string {
  const nodes: Array<Record<string, unknown>> = [
    { id: 'root', kind: 'repository', label: 'Wide', parentId: null },
  ];
  for (let i = 0; i < kinds; i += 1) {
    nodes.push({ id: `n${String(i)}`, kind: `kind-${String(i)}`, label: `n${String(i)}`, parentId: 'root' });
  }
  return JSON.stringify({
    formatVersion: '1.0',
    generator: { name: 'test', version: '0' },
    nodes,
    edges: [],
    roots: ['root'],
  });
}

test.use({ viewport: SHORT });

test('criterion 1 — levels is visible at 700px without scrolling, on the real corpus', async ({ page }) => {
  const errors = await boot(page);

  expect(await fullyVisible(page, '.modes .legend-row', 'levels')).toBe(true);
  expect(await fullyVisible(page, '.modes .legend-row', 'hide tests')).toBe(true);

  // And it is genuinely anchored, not merely lucky: the scrollable body above it does
  // overflow at this height, which is exactly the condition that used to bury it.
  const overflows = await page.evaluate(() => {
    const s = document.querySelector('.sidebar-scroll');
    return s === null ? false : s.scrollHeight > s.clientHeight;
  });
  expect(overflows).toBe(true);
  expect(errors).toEqual([]);

  await page.screenshot({ path: 'artifacts/anchor-700.png' });
});

test('the Explorer itself is hidden below 1664px wide — preexisting, and worth stating', async ({
  page,
}) => {
  // Not introduced here and not in scope to change: `applyLayout` makes the Project rail
  // and the Explorer mutually exclusive below 1664 px. It matters for how criterion 1 is
  // read — "a 700 px window" is satisfiable only while the panel is on screen at all —
  // so it is asserted rather than left as folklore.
  await boot(page);
  expect(await fullyVisible(page, '.modes .legend-row', 'levels')).toBe(true);

  await page.setViewportSize({ width: 1400, height: 700 });
  await page.waitForTimeout(400);
  const explorerShown = await page.evaluate(() => {
    const panel = document.querySelector('#explorer-panel');
    return panel !== null && !panel.hasAttribute('hidden');
  });
  expect(explorerShown).toBe(false);
});

test('criterion 2 — it stays visible when the corpus has far more kinds', async ({ page }) => {
  await boot(page);
  // 40 node kinds against AgentsCommander's 6: the legend gets much longer, and under the
  // old layout every extra kind pushed the modes further down.
  await page.locator('#import-input').setInputFiles({
    name: 'wide.json',
    mimeType: 'application/json',
    buffer: Buffer.from(manyKindsDoc(40), 'utf8'),
  });
  await page.waitForTimeout(400);

  const legendRows = await page.locator('.legend .legend-row').count();
  expect(legendRows).toBeGreaterThan(30);
  expect(await fullyVisible(page, '.modes .legend-row', 'levels')).toBe(true);
});

test('criterion 3 — proposed basis appears in the bar and does not push levels out', async ({ page }) => {
  await boot(page);

  const before = await page.evaluate(() => document.querySelectorAll('.modes .legend-row').length);
  expect(before).toBe(2);

  await page.locator('.modes .legend-row', { hasText: 'levels' }).first().click();
  await page.waitForTimeout(400);

  // The bar grew from two rows to three…
  const after = await page.evaluate(() => document.querySelectorAll('.modes .legend-row').length);
  expect(after).toBe(3);
  // …and it grew UPWARD into the scroller: both are still fully on screen.
  expect(await fullyVisible(page, '.modes .legend-row', 'proposed basis')).toBe(true);
  expect(await fullyVisible(page, '.modes .legend-row', 'levels')).toBe(true);
});

test('criterion 4 — the kinds legend still scrolls and still reaches its last kind', async ({ page }) => {
  await boot(page);

  const lastKind = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.legend .legend-row')];
    return (rows[rows.length - 1]?.textContent ?? '').trim();
  });
  expect(lastKind.length).toBeGreaterThan(0);

  await page.evaluate(() => {
    const s = document.querySelector('.sidebar-scroll');
    if (s !== null) s.scrollTop = s.scrollHeight;
  });
  await page.waitForTimeout(200);

  expect(await fullyVisible(page, '.legend .legend-row', lastKind)).toBe(true);
  // And the anchored bar is still there after scrolling to the very bottom.
  expect(await fullyVisible(page, '.modes .legend-row', 'levels')).toBe(true);
});

test('criterion 5 — toggling from the bar dispatches the same SetLevels', async ({ page }) => {
  await boot(page);

  const read = async (): Promise<{ active: boolean; basis: string }> =>
    page.evaluate(
      () =>
        (globalThis as unknown as { __visualSpecs: { levels(): { active: boolean; basis: string } } })
          .__visualSpecs.levels(),
    );

  expect(await read()).toEqual({ active: false, basis: 'observed' });

  await page.locator('.modes .legend-row', { hasText: 'levels' }).first().click();
  await page.waitForTimeout(300);
  expect(await read()).toEqual({ active: true, basis: 'observed' });

  await page.locator('.modes .legend-row', { hasText: 'proposed basis' }).first().click();
  await page.waitForTimeout(300);
  expect(await read()).toEqual({ active: true, basis: 'proposed' });
});

test('criterion 6 — the anchored controls are reachable by keyboard, after the legend', async ({ page }) => {
  await boot(page);

  // They are real buttons in document order after the legend, so Tab reaches them and a
  // screen reader meets them where the DOM says they are.
  const order = await page.evaluate(() => {
    const all = [...document.querySelectorAll('.sidebar button')];
    let lastLegend = -1;
    all.forEach((b, i) => {
      if (b.closest('.legend') !== null) lastLegend = i;
    });
    const firstMode = all.findIndex((b) => b.closest('.modes') !== null);
    return { lastLegend, firstMode, total: all.length };
  });
  expect(order.firstMode).toBeGreaterThan(order.lastLegend);

  // Focus the levels button directly and drive it with the keyboard alone.
  await page.locator('.modes .legend-row', { hasText: 'levels' }).first().focus();
  const focused = await page.evaluate(() =>
    (document.activeElement?.textContent ?? '').trim().startsWith('levels'),
  );
  expect(focused).toBe(true);

  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  const active = await page.evaluate(
    () =>
      (globalThis as unknown as { __visualSpecs: { levels(): { active: boolean } } }).__visualSpecs.levels()
        .active,
  );
  expect(active).toBe(true);
});
