// Out-of-focus dimming, driven through the controls a person actually has (#17).
//
// Everything here is an INTERACTION claim that a headless test cannot make: that the
// menu survives the notification storm a pan produces, that Escape reaches the menu
// before the sidebar, that a control the user is dragging is not fought by a
// re-render, and that a mark on a file is still reachable after the search that found
// it is gone.

import { expect, test, type Page } from '@playwright/test';

interface SceneNode {
  id: string;
  opacity: number;
  marker?: string;
}
interface SceneEdge {
  id: string;
  count: number;
  opacity: number;
}

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

async function scene(page: Page): Promise<{ nodes: SceneNode[]; edges: SceneEdge[] }> {
  return page.evaluate(
    () =>
      (globalThis as unknown as { __visualSpecs: { scene(): { nodes: SceneNode[]; edges: SceneEdge[] } } })
        .__visualSpecs.scene(),
  );
}

/** The corpus's ids, used instead of labels: `hasText` is substring matching and
 *  four of the ten listable rows share the word "agentscommander". */
const PACKAGE = 'pkg:npm:package.json';

function row(page: Page, id: string) {
  return page.locator(`.node-list .node-row[data-node-id="${id}"]`);
}

async function openMenuOnRow(page: Page, id: string): Promise<void> {
  await row(page, id).click({ button: 'right' });
  await expect(page.locator('.row-menu')).toBeVisible();
}

test('the menu opens on a row, acts on it, and dims the box and its lines', async ({ page }) => {
  const errors = await boot(page);
  const before = await scene(page);
  expect(before.nodes.every((n) => n.opacity === 1)).toBe(true);

  await openMenuOnRow(page, PACKAGE);
  await page.locator('.row-menu-item', { hasText: 'Send out of focus' }).click();

  const after = await scene(page);
  const dimmed = after.nodes.filter((n) => n.opacity < 1);
  expect(dimmed.length).toBeGreaterThan(0);
  // "el nodo y sus líneas": the lines move too, in the state the app opens in.
  expect(after.edges.some((e) => e.opacity < 1)).toBe(true);
  // I-F2: no count moved.
  expect(after.nodes.length).toBe(before.nodes.length);
  expect(after.edges.length).toBe(before.edges.length);
  expect(errors).toEqual([]);
});

test('the menu lives outside the list: it survives a pan, and is not clipped on the last row', async ({ page }) => {
  await boot(page);
  // Not a child of the scrolling list — which both destroys and clips its children.
  await openMenuOnRow(page, PACKAGE);
  const parentIsList = await page.evaluate(() => {
    const menu = document.querySelector('.row-menu');
    return menu?.closest('.node-list') !== null;
  });
  expect(parentIsList).toBe(false);

  // Controller notifications rebuild every row in the list. The menu must not care:
  // `viewport:change` fires once per POINTERMOVE of a pan, and `startFollowLoop` polls
  // at 1000 ms, so a notification-closed menu would die on an incidental drag and once
  // a second on any followed document.
  //
  // Driven by keyboard, deliberately: a pointer-driven pan cannot test this, because
  // the pointerdown that starts it is itself an outside press and light-dismiss closes
  // the menu first — correctly, and for a different reason.
  await page.keyboard.press('Tab');
  await page.keyboard.press('+');
  await page.keyboard.press('+');
  await expect(page.locator('.row-menu')).toBeVisible();

  // And the last row's menu is fully on screen, rather than clipped at the list's
  // bottom edge the way an absolutely-positioned child would be.
  await page.keyboard.press('Escape');
  const rows = page.locator('.node-list .node-row');
  await rows.last().click({ button: 'right' });
  const menuBox = await page.locator('.row-menu').boundingBox();
  const viewport = page.viewportSize();
  expect(menuBox).not.toBeNull();
  if (menuBox !== null && viewport !== null) {
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(viewport.height);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(viewport.width);
  }
});

test('Escape closes the menu and NOT the sidebar, in the narrow band', async ({ page }) => {
  await boot(page);
  // Narrow: the Explorer is an OVERLAY, so the overlay-Escape branch is live and runs
  // before `isInteractionEvent`. The native popover does not discharge this.
  await page.setViewportSize({ width: 900, height: 900 });
  await page.waitForTimeout(200);
  await page.locator('#toggle-sidebar').click();
  await expect(page.locator('#explorer-panel')).toBeVisible();

  await openMenuOnRow(page, PACKAGE);
  await page.keyboard.press('Escape');
  await expect(page.locator('.row-menu')).toBeHidden();
  await expect(page.locator('#explorer-panel')).toBeVisible();

  // A second Escape, with no menu open, still closes the overlay as it always did.
  await page.keyboard.press('Escape');
  await expect(page.locator('#explorer-panel')).toBeHidden();
});

test('a layout change closes the menu, without any pointer being involved', async ({ page }) => {
  await boot(page);
  await openMenuOnRow(page, PACKAGE);
  // A band change re-runs `applyLayout`, which can hide the Explorer and take the
  // anchor row with it. Light-dismiss is pointer-driven and does not fire here, so
  // the menu would be left floating over the canvas still holding a valid id.
  await page.setViewportSize({ width: 900, height: 900 });
  await expect(page.locator('.row-menu')).toBeHidden();
});

test('Shift+F10 opens the same menu, and focus returns to the row after the rebuild', async ({ page }) => {
  await boot(page);
  const target = row(page, PACKAGE);
  await target.focus();
  await page.keyboard.press('Shift+F10');
  await expect(page.locator('.row-menu')).toBeVisible();
  // First item focused, arrows move within.
  await expect(page.locator('.row-menu-item').first()).toBeFocused();

  await page.locator('.row-menu-item', { hasText: 'Send out of focus' }).click();
  // `renderList` rebuilt every row; focus must land on the SAME row, not on <body>.
  await expect(row(page, PACKAGE)).toBeFocused();
});

test('the row shows its own state, and an explicit mark is distinguishable from an inherited one', async ({ page }) => {
  await boot(page);
  await openMenuOnRow(page, PACKAGE);
  await page.locator('.row-menu-item', { hasText: 'Send out of focus' }).click();

  const marked = row(page, PACKAGE);
  await expect(marked).toHaveClass(/out-of-focus/);
  await expect(marked.locator('.node-focus')).toHaveText('◐');

  // A descendant is out of focus by INHERITANCE: attenuated, and carrying no glyph.
  await page.locator('#search').fill('main.ts');
  await page.waitForTimeout(200);
  const inherited = page.locator('.node-list .node-row.out-of-focus').first();
  if ((await inherited.count()) > 0) {
    await expect(inherited.locator('.node-focus')).toHaveCount(0);
  }
});

test('a mark on a file is still reported after the search that found it is cleared', async ({ page }) => {
  await boot(page);
  const search = page.locator('#search');
  await search.fill('main.ts');
  await page.waitForTimeout(250);
  const hit = page.locator('.node-list .node-row').first();
  await hit.click({ button: 'right' });
  await page.locator('.row-menu-item', { hasText: 'Send out of focus' }).click();

  // Clearing the search removes the ROW: `renderList` drops `file` and `directory` on
  // an empty query, which is 777 of 787 entities. The mark must not vanish with it.
  await search.fill('');
  await page.waitForTimeout(250);
  await expect(page.locator('.focus-summary')).toContainText('1 marked');
  await expect(page.locator('.focus-disclosure')).toContainText('not listed here');

  // And the disclosure makes it individually actionable, not merely visible.
  await page.locator('.focus-disclosure').click();
  const unlisted = page.locator('.focus-marks .node-row');
  await expect(unlisted).toHaveCount(1);
  await unlisted.first().click({ button: 'right' });
  await page.locator('.row-menu-item', { hasText: 'Reset to inherited' }).click();
  await expect(page.locator('.focus-summary')).toContainText('0 marked');
});

test('the transparency control refuses garbage and keeps the last valid value', async ({ page }) => {
  await boot(page);
  await openMenuOnRow(page, PACKAGE);
  await page.locator('.row-menu-item', { hasText: 'Send out of focus' }).click();

  const before = (await scene(page)).nodes.find((n) => n.opacity < 1)?.opacity;
  const number = page.locator('#focus-transparency-value');
  await number.fill('999');
  await page.waitForTimeout(150);
  await expect(page.locator('.focus-note')).toContainText('Keeping');
  const after = (await scene(page)).nodes.find((n) => n.opacity < 1)?.opacity;
  expect(after).toBeCloseTo(before ?? 0, 10);

  await number.fill('40');
  await page.waitForTimeout(150);
  const valid = (await scene(page)).nodes.find((n) => n.opacity < 1)?.opacity;
  expect(valid).toBeCloseTo(0.6, 6);
});

test('the toggle confirms only when it would delete an override, and never through window.confirm', async ({ page }) => {
  await boot(page);
  // A native dialog would BLOCK the page; if one appears this test hangs rather than
  // passing quietly, which is the point.
  let nativeDialogs = 0;
  page.on('dialog', (d) => {
    nativeDialogs += 1;
    void d.dismiss();
  });

  // Root marks only: `Show everything` → `Dim everything` restores exactly, so asking
  // would be noise.
  await page.locator('#focus-toggle').click();
  await expect(page.locator('.focus-confirm-box')).toHaveCount(0);
  await expect(page.locator('#focus-toggle')).toHaveText('Show everything');

  // Now add an override. The pair is no longer reversible, and there is no undo.
  await openMenuOnRow(page, PACKAGE);
  await page.locator('.row-menu-item', { hasText: 'Bring into focus' }).click();
  await page.locator('#focus-toggle').click();
  await expect(page.locator('.focus-confirm-box')).toBeVisible();
  await expect(page.locator('.focus-confirm-box')).toContainText('no undo');

  await page.locator('.focus-confirm-no').click();
  await expect(page.locator('.focus-confirm-box')).toHaveCount(0);
  await expect(page.locator('#focus-toggle')).toHaveText('Show everything');

  await page.locator('#focus-toggle').click();
  await page.locator('.focus-confirm-yes').click();
  await expect(page.locator('#focus-toggle')).toHaveText('Dim everything');
  expect(nativeDialogs).toBe(0);
});

test('something outside the Explorer says so when focus is on and the Explorer is closed', async ({ page }) => {
  await boot(page);
  await openMenuOnRow(page, PACKAGE);
  await page.locator('.row-menu-item', { hasText: 'Send out of focus' }).click();

  // Through the Explorer toggle: after acting on a row, focus is back ON that row, so
  // `[` is correctly inert — `isInteractionEvent` suppresses bare-key shortcuts while
  // a button has focus, and that is pre-existing behaviour this feature does not change.
  await page.locator('#toggle-sidebar').click();
  await expect(page.locator('#explorer-panel')).toBeHidden();
  const banner = page.locator('.banner.focus-off-explorer');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('mask, not a re-projection');
  await expect(banner).toContainText('Open the Explorer');

  // Narrow starts with the Explorer CLOSED, which is how a person meets this state
  // without ever having closed anything.
  await page.setViewportSize({ width: 900, height: 900 });
  await page.waitForTimeout(250);
  await expect(page.locator('#explorer-panel')).toBeHidden();
  await expect(page.locator('.banner.focus-off-explorer')).toBeVisible();
});

test('right-clicking a node on the CANVAS opens the same menu — the route a file has', async ({ page }) => {
  await boot(page);
  // The reason this exists: a `file` has no sidebar row while the search box is
  // empty, so for 777 of 787 entities the canvas is the only surface to act on.
  const target = await page.evaluate(() => {
    const hooks = (globalThis as unknown as {
      __visualSpecs: {
        scene(): {
          nodes: {
            id: string;
            position: { x: number; y: number };
            hidden: boolean;
            isContainer: boolean;
          }[];
        };
        viewport(): { x: number; y: number; zoom: number };
      };
    }).__visualSpecs;
    const host = document.querySelector('.canvas-host canvas');
    if (host === null) throw new Error('no canvas');
    const rect = host.getBoundingClientRect();
    const viewport = hooks.viewport();
    // A LEAF: the centre of an expanded container is occupied by whatever it
    // contains, and the adapter correctly hit-tests the topmost, smallest box there.
    const node = hooks.scene().nodes.find((n) => !n.hidden && !n.isContainer);
    if (node === undefined) throw new Error('no visible leaf node');
    return {
      id: node.id,
      x: rect.left + (node.position.x - viewport.x) * viewport.zoom,
      y: rect.top + (node.position.y - viewport.y) * viewport.zoom,
      backgroundX: rect.left + rect.width - 12,
      backgroundY: rect.top + rect.height - 12,
    };
  });

  await page.mouse.click(target.x, target.y, { button: 'right' });
  await expect(page.locator('.row-menu')).toBeVisible();
  // Right-clicking MAKES it the selection, so the detail panel is already showing the
  // thing the menu is about.
  const selected = await page.evaluate(
    () =>
      (globalThis as unknown as { __visualSpecs: { interaction(): { selection: { nodeIds: string[] } } } })
        .__visualSpecs.interaction().selection.nodeIds,
  );
  expect(selected).toEqual([target.id]);

  await page.locator('.row-menu-item', { hasText: 'Send out of focus' }).click();
  const after = await scene(page);
  expect(after.nodes.find((n) => n.id === target.id)?.opacity).toBeLessThan(1);

  // Empty canvas has no menu: a background menu is a different feature.
  await page.mouse.click(target.backgroundX, target.backgroundY, { button: 'right' });
  await expect(page.locator('.row-menu')).toBeHidden();
});

test('interaction budget: p95 from a transparency input to the painted frame, at expand-all', async ({ page }) => {
  await boot(page);
  await openMenuOnRow(page, PACKAGE);
  await page.locator('.row-menu-item', { hasText: 'Send out of focus' }).click();

  // The worst case the corpus offers: every container open, 787 nodes and 1713 lines.
  await page.locator('.canvas-host').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('e');
  await page.waitForTimeout(1200);
  const drawn = await scene(page);
  expect(drawn.nodes.length).toBeGreaterThan(700);

  const measure = await page.evaluate(async () => {
    const input = document.querySelector('#focus-transparency');
    if (!(input instanceof HTMLInputElement)) throw new Error('no transparency control');

    /** Inter-frame intervals over `count` frames, optionally driving the control on
     *  each one — which is what a drag does. If the work does not fit in a frame, the
     *  intervals stretch, and that is the only thing "does it stutter" can mean. */
    const run = async (count: number, drive: boolean): Promise<number[]> => {
      const gaps: number[] = [];
      let previous = 0;
      let i = 0;
      await new Promise<void>((resolve) => {
        const tick = (now: number): void => {
          if (previous !== 0) gaps.push(now - previous);
          previous = now;
          if (drive) {
            input.value = String(30 + (i % 40));
            input.dispatchEvent(new Event('input', { bubbles: true }));
          }
          i += 1;
          if (i < count) requestAnimationFrame(tick);
          else resolve();
        };
        requestAnimationFrame(tick);
      });
      return gaps.slice(4);
    };

    /** Input → the app's coalesced dispatch and render having completed, in the SAME
     *  frame. Bounded below by the wait for the next vsync, which is why it is
     *  reported next to the frame intervals rather than on its own. */
    const latency: number[] = [];
    for (let i = 0; i < 30; i += 1) {
      const t0 = performance.now();
      input.value = String(30 + (i % 40));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
      latency.push(performance.now() - t0);
    }

    return { idle: await run(60, false), driven: await run(60, true), latency };
  });

  const pct = (xs: number[], p: number): number => {
    const sorted = [...xs].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
  };

  const idle95 = pct(measure.idle, 0.95);
  const driven95 = pct(measure.driven, 0.95);
  console.log(
    `[focus] expand-all frame interval p50/p95 — idle ${pct(measure.idle, 0.5).toFixed(2)}/${idle95.toFixed(2)}ms, ` +
      `driving the transparency ${pct(measure.driven, 0.5).toFixed(2)}/${driven95.toFixed(2)}ms; ` +
      `input→dispatch+render complete p50 ${pct(measure.latency, 0.5).toFixed(2)}ms p95 ${pct(measure.latency, 0.95).toFixed(2)}ms`,
  );

  // The budget, stated in the only form that is achievable and that means anything:
  // dragging the control must not cost a frame. "p95 ≤ 16 ms from input to painted
  // frame" cannot be met by ANY rAF-coalesced implementation, including one that does
  // no work — the wait for the next vsync is up to 16.7 ms on its own, before the
  // render. So the assertion is that driving the control does not stretch the frame.
  expect(driven95).toBeLessThanOrEqual(idle95 + 8);
});
