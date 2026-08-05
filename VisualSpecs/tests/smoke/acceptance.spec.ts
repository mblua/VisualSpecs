// The ACCEPTANCE smoke (§12, mandatory).
//
// It loads the REAL committed dataset in a real browser and proves what a headless
// test cannot: that the canvas is not blank, that the first screen is legible, that
// expand/collapse works through actual double-clicks, that a drag survives a REAL
// export and a REAL import, and that clicking an aggregated edge shows the logical
// relations behind it — which is the product's entire promise.
//
// ── Two things this file used to fake, and no longer does ────────────────────
//
//  * "reload" meant calling a global hook on the SAME controller. That is not a
//    reload; it is a method call with a suggestive name, and it is why a real
//    `Collapse all → Export → Import` round-trip was broken while six acceptance
//    tests were green. Export now goes through the Export JSON button and a real
//    download; import goes through the real `input[type=file]`; and where the test
//    says "reload", it navigates a fresh page.
//  * Screenshots were written into `docs/`, so the verification gate rewrote the
//    documentation it was verifying. They go to `testInfo.outputPath()` now. The
//    canonical README captures have their own command.

import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { routeEdges, type RenderScene } from '../../src/ports/renderer.ts';

interface SceneNode {
  id: string;
  kind: string;
  position: { x: number; y: number };
  size: { w: number; h: number };
  hidden: boolean;
  style: { shape: string };
}
interface SceneEdge {
  id: string;
  kind: string;
  sourceId: string;
  targetId: string;
  count: number;
  hidden: boolean;
}
/** Read-only, dev/test-only, and it never bypasses the loop: it answers "where is
 *  this line drawn", which only the domain knows. Everything a USER can do, the test
 *  does through the same controls the user has. */
interface Hooks {
  scene(): { nodes: SceneNode[]; edges: SceneEdge[] };
  viewport(): { x: number; y: number; zoom: number };
}

async function boot(page: Page): Promise<string[]> {
  const errors: string[] = [];
  // This suite deliberately covers the DownloadStore branch. Save Picker has its
  // own controlled UI/adapter tests; leaving Chromium's native picker available
  // here would open an unautomatable modal while `exportThroughUi` waits for a
  // download event that correctly never arrives.
  await page.addInitScript(() => {
    delete (globalThis as unknown as Record<string, unknown>)['showSaveFilePicker'];
  });
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

async function readScene(page: Page): Promise<{
  scene: { nodes: SceneNode[]; edges: SceneEdge[] };
  viewport: { x: number; y: number; zoom: number };
}> {
  return page.evaluate(() => {
    const hooks = (globalThis as unknown as Record<string, unknown>)['__visualSpecs'] as Hooks;
    return { scene: hooks.scene(), viewport: hooks.viewport() };
  });
}

/** Click a WORLD point on the canvas, the way a user would. */
async function clickWorld(
  page: Page,
  world: { x: number; y: number },
  viewport: { x: number; y: number; zoom: number },
  action: 'click' | 'dblclick' = 'click',
): Promise<void> {
  const box = await page.locator('.canvas-host canvas').boundingBox();
  if (box === null) throw new Error('no canvas');
  const p = {
    x: box.x + (world.x - viewport.x) * viewport.zoom,
    y: box.y + (world.y - viewport.y) * viewport.zoom,
  };
  if (action === 'dblclick') await page.mouse.dblclick(p.x, p.y);
  else await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(220);
}

/**
 * Press "Export JSON" and read the bytes the browser actually downloaded.
 *
 * Arm the wait, THEN click, THEN await — the single correct order. The first version
 * raced two `waitForEvent('download')` calls against each other and left one of them
 * dangling on the page for the rest of the test.
 */
async function exportThroughUi(page: Page): Promise<string> {
  const downloading = page.waitForEvent('download');
  await page.locator('#export-btn').click();
  const download = await downloading;
  const path = await download.path();
  if (path === null) throw new Error('the export produced no file');
  return readFileSync(path, 'utf8');
}

/** Import through the real file input, the way a user would. */
async function importThroughUi(page: Page, name: string, text: string): Promise<void> {
  await page.locator('#import-input').setInputFiles({
    name,
    mimeType: 'application/json',
    buffer: Buffer.from(text, 'utf8'),
  });
  await page.waitForTimeout(300);
}

/** Sample the canvas: a blank map passes every other assertion in this file. */
async function inkCoverage(page: Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector('.canvas-host canvas');
    if (!(canvas instanceof HTMLCanvasElement)) return -1;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return -1;
    const { width, height } = canvas;
    const data = ctx.getImageData(0, 0, width, height).data;
    let ink = 0;
    let sampled = 0;
    for (let y = 0; y < height; y += 4) {
      for (let x = 0; x < width; x += 4) {
        const i = (y * width + x) * 4;
        sampled += 1;
        const r = data[i] ?? 0;
        const g = data[i + 1] ?? 0;
        const b = data[i + 2] ?? 0;
        if (Math.abs(r - 11) > 6 || Math.abs(g - 14) > 6 || Math.abs(b - 22) > 6) ink += 1;
      }
    }
    return sampled === 0 ? 0 : ink / sampled;
  });
}

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
}

// ---------------------------------------------------------------------------

test('the map opens on the real AgentsCommander dataset, and the canvas is not blank', async ({
  page,
}, testInfo) => {
  const errors = await boot(page);

  expect(await inkCoverage(page), 'the canvas is blank').toBeGreaterThan(0.01);

  // The COMMITTED corpus, `data/agentscommander.json`, refreshed to AgentsCommander
  // `1b0e934` (#24). These numbers go stale whenever that dataset moves and this file is
  // not touched with it — the assertion is unchanged in strictness, only in which
  // dataset it is true of.
  //
  // 817 is not a figure to take on faith. It is 705 git-tracked files + 102 directory
  // boxes + 4 anchors + 5 applications + 1 repository, and the first two are corroborated
  // off-extractor by the dataset test: `git ls-files` gives 705, and the §5.2 rule gives
  // 102 from that list plus the four anchor directories alone.
  await expect(page.locator('.counts-grid')).toContainText('817');
  await expect(page.locator('.node-list')).toContainText('AgentsCommander');

  // A quiet map is not a trustworthy map.
  await expect(page.locator('.banner.coverage')).toContainText('rust-imports');
  await expect(page.locator('.banner.coverage')).toContainText('degraded');

  await shot(page, testInfo, 'map');
  expect(errors).toEqual([]);
});

test('a map extracted from a DIRTY working tree says so, at the top', async ({ page }) => {
  // The extractor lists files from the index and reads their CONTENT from the working
  // tree, so a dirty tree means the evidence describes the files on disk, not the files
  // at `source.commit`. A map that cannot back its own provenance has to say so.
  await boot(page);

  const dirty = await page.evaluate(() => {
    const el = document.querySelector('.banner.dirty');
    return el === null ? null : (el.textContent ?? '');
  });

  const source = JSON.parse(await exportThroughUi(page)) as {
    source?: { dirty?: boolean; commit?: string };
  };

  if (source.source?.dirty === true) {
    expect(dirty, 'source.dirty is true but nothing says so on screen').not.toBeNull();
    expect(dirty).toContain('dirty working tree');
    expect(dirty).toContain((source.source.commit ?? '').slice(0, 7));
  } else {
    // A clean tree needs no such banner — and must not invent one.
    expect(dirty).toBeNull();
  }
});

test('the initial view is LEGIBLE: the repository, its applications, its packages and its crates', async ({
  page,
}) => {
  await boot(page);
  const { scene } = await readScene(page);
  const visible = scene.nodes.filter((n) => !n.hidden);

  // 1 repository + 5 applications + 2 packages + 2 crates. Not 705 files.
  expect(visible).toHaveLength(10);
  expect(visible.filter((n) => n.kind === 'crate')).toHaveLength(2);
  expect(visible.filter((n) => n.kind === 'package')).toHaveLength(2);
  expect(visible.filter((n) => n.kind === 'application')).toHaveLength(5);
});

test('the UI distinguishes a Rust crate from an npm package', async ({ page }) => {
  await boot(page);

  // In the legend, and in the node list, and on the canvas — by SHAPE, not only colour.
  await expect(page.locator('.legend')).toContainText('crate');
  await expect(page.locator('.legend')).toContainText('package');

  const { scene } = await readScene(page);
  const crates = scene.nodes.filter((n) => n.kind === 'crate');
  const packages = scene.nodes.filter((n) => n.kind === 'package');
  expect(crates.length).toBeGreaterThan(0);
  expect(packages.length).toBeGreaterThan(0);
  for (const c of crates) expect(c.style.shape).toBe('cut-rect');
  for (const p of packages) expect(p.style.shape).toBe('round-rect');

  // The crate the Tauri app is built from is named, and it says it is a crate.
  await page.getByRole('option', { name: /agentscommander-new/ }).click();
  await expect(page.locator('.detail .chip')).toContainText('crate');
  await expect(page.locator('.detail')).toContainText('src-tauri');
});

test('selecting a container names WHICH relations are folded inside it', async ({ page }) => {
  await boot(page);

  await page.getByRole('option', { name: /agentscommander-new/ }).click();
  await expect(page.locator('.detail')).toContainText('Hidden inside this box');

  // Selecting the CONTAINER is announced as the container — kind, name, and how much is
  // folded away inside it.
  await expect(page.locator('.status')).toContainText('Selected crate agentscommander-new');
  await expect(page.locator('.status')).toContainText('folded inside it');

  const buckets = page.locator('.bucket');
  expect(await buckets.count()).toBeGreaterThan(0);

  // Opening a bucket now SELECTS it (see the next test), and its logical relations —
  // with their evidence — are what the panel shows.
  await buckets.first().locator('summary').click();
  await page.waitForTimeout(200);

  const evidence = await page.locator('.evidence code').first().textContent();
  expect(evidence).toMatch(/^[\w./-]+(:\d+)?$/); // a real path:line…
  expect(evidence).not.toMatch(/^[A-Za-z]:/); // …never an absolute path
});

test('an internal bucket can be SELECTED and is announced', async ({ page }) => {
  // The detail panel used to hold an announcement for internal buckets that no UI could
  // reach: the branch existed, and clicking the disclosure only opened it. A screen
  // reader never learned that 665 rust-imports had been folded into that box.
  await boot(page);
  await page.getByRole('option', { name: /agentscommander-new/ }).click();
  await expect(page.locator('.detail')).toContainText('Hidden inside this box');

  // Find the bucket by KIND, not by a count that a re-extraction could change.
  const summary = page.locator('.bucket summary').filter({ hasText: 'rust-imports' }).first();
  await expect(summary).toBeVisible();

  // Take the count from the badge itself, so the assertion below stays true whatever the
  // dataset says.
  const badge = await summary.locator('.count').textContent();
  const count = Number((badge ?? '').replace(/[^\d]/g, ''));
  expect(count).toBeGreaterThan(0);

  await summary.click();
  await page.waitForTimeout(250);

  // The bucket is now SELECTED — the panel shows its logical relations…
  await expect(page.locator('.detail .chip')).toContainText('rust-imports');
  await expect(page.locator('.detail h2')).toContainText('Inside agentscommander-new');
  await expect(page.locator('.logical').first().locator('.evidence li').first()).toBeVisible();

  // …and it is ANNOUNCED: kind, count, container.
  const status = await page.locator('.status').textContent();
  expect(status).toContain('rust-imports');
  expect(status).toContain(String(count));
  expect(status).toContain('agentscommander-new');
  expect(status).toMatch(/folded inside/i);
});

test('the bucket disclosure is operable from the keyboard', async ({ page }) => {
  await boot(page);
  await page.getByRole('option', { name: /agentscommander-new/ }).click();

  const summary = page.locator('.bucket summary').filter({ hasText: 'rust-imports' }).first();
  await summary.focus();
  await page.keyboard.press('Enter'); // a <summary> is natively activated by Enter
  await page.waitForTimeout(250);

  await expect(page.locator('.detail .chip')).toContainText('rust-imports');
  await expect(page.locator('.status')).toContainText('rust-imports');
});

/** A canvas point that is inside no node box — genuine background, not "the top-left
 *  corner and fingers crossed". The map is fitted and centred, so a corner is not
 *  reliably empty; ask the scene where the boxes actually are. */
async function emptyCanvasPoint(page: Page): Promise<{ x: number; y: number }> {
  const box = await page.locator('.canvas-host canvas').boundingBox();
  if (box === null) throw new Error('no canvas');
  const { scene, viewport } = await readScene(page);

  const toClient = (w: { x: number; y: number }) => ({
    x: box.x + (w.x - viewport.x) * viewport.zoom,
    y: box.y + (w.y - viewport.y) * viewport.zoom,
  });
  const boxes = scene.nodes
    .filter((n) => !n.hidden)
    .map((n) => {
      const tl = toClient({ x: n.position.x - n.size.w / 2, y: n.position.y - n.size.h / 2 });
      const br = toClient({ x: n.position.x + n.size.w / 2, y: n.position.y + n.size.h / 2 });
      return { l: tl.x, t: tl.y, r: br.x, b: br.y };
    });

  for (let y = box.y + 8; y < box.y + box.height - 8; y += 17) {
    for (let x = box.x + 8; x < box.x + box.width - 8; x += 23) {
      const inside = boxes.some((b) => x >= b.l - 12 && x <= b.r + 12 && y >= b.t - 12 && y <= b.b + 12);
      if (!inside) return { x, y };
    }
  }
  throw new Error('the canvas has no empty point');
}

test('clearing the selection is announced, and does not leave the old one standing', async ({
  page,
}) => {
  await boot(page);
  await page.getByRole('option', { name: /agentscommander-new/ }).click();
  await expect(page.locator('.status')).toContainText('Selected crate agentscommander-new');

  const empty = await emptyCanvasPoint(page);
  await page.mouse.click(empty.x, empty.y);
  await page.waitForTimeout(250);

  // Announcing nothing left the PREVIOUS selection standing, so a screen reader would
  // still be describing a thing that is no longer selected.
  await expect(page.locator('.status')).toContainText('Selection cleared');
  await expect(page.locator('.detail-panel')).toContainText('Nothing selected');
});

test('clicking the aggregated command edge lists every relation behind it, with evidence', async ({
  page,
}, testInfo) => {
  await boot(page);

  // §6.7 on the real dataset: collapsed to the first screen, EVERY command relation
  // from `src/shared/ipc.ts` projects onto one visible pair and aggregates into a
  // single line per binding. Four typed relations join that pair, so the line we want
  // is one of four parallel curves — `routeEdges` is the port's own rule for where
  // each is drawn, and the test uses the SAME rule the adapter does.
  const { scene, viewport } = await readScene(page);
  const edge = scene.edges.find((e) => e.kind === 'tauri-command' && !e.hidden);
  expect(edge, 'no aggregated tauri-command edge is drawn').toBeDefined();
  if (edge === undefined) throw new Error('unreachable');
  // 137, and NOT the 138 commands `generate_handler!` registers. The gap is one command:
  // `get_instance_label` is registered but has no call site in `ipc.ts`, so there is no
  // relation to draw. Corroborated off-extractor by intersecting the names parsed out of
  // the two `generate_handler![…]` lists (138) with the literal command names passed to
  // `transport.invoke` in `ipc.ts` (139 distinct over 140 call sites): the intersection
  // is 137, the only registered-but-uncalled name is `get_instance_label`, and the only
  // called-but-unregistered names are `get_pty_size` and `subscribe_session` — the two
  // web-router-only commands. The dataset test pins all three facts (§12).
  expect(edge.count).toBe(137);

  const route = routeEdges(scene as unknown as RenderScene).get(edge.id);
  expect(route).toBeDefined();
  if (route === undefined) throw new Error('unreachable');

  await clickWorld(page, route.mid, viewport);

  // THIS is where the product delivers its promise.
  await expect(page.locator('.detail .chip')).toContainText('tauri-command');
  await expect(page.locator('.detail')).toContainText('137 logical relations behind this line');

  const first = page.locator('.logical').first();
  await expect(first.locator('.confidence')).toContainText('resolved');
  await expect(first.locator('.cmd')).not.toBeEmpty();

  // Three pieces of evidence: the call, the attribute, the registration (§10.4).
  const evidence = first.locator('.evidence li');
  expect(await evidence.count()).toBe(3);
  await expect(evidence.nth(0)).toContainText('src/shared/ipc.ts');
  await expect(evidence.nth(1)).toContainText('#[tauri::command]');
  await expect(evidence.nth(2)).toContainText('generate_handler');

  // …and an aggregated relation is ANNOUNCED. The thing this product exists to say
  // out loud was, for one release, the one thing it would not say.
  await expect(page.locator('.status')).toContainText('Selected relation tauri-command');
  await expect(page.locator('.status')).toContainText('137 logical relations');

  await shot(page, testInfo, 'edge-detail');
});

test('two clicks on a line never collapse the box it crosses', async ({ page }) => {
  await boot(page);
  const { scene, viewport } = await readScene(page);
  const edge = scene.edges.find((e) => e.kind === 'tauri-command' && !e.hidden);
  if (edge === undefined) throw new Error('no aggregated edge');
  const route = routeEdges(scene as unknown as RenderScene).get(edge.id);
  if (route === undefined) throw new Error('no route');

  // The line is drawn ACROSS the repository's backdrop. A double-click keyed on the
  // node under the pointer would collapse the repository — the box would shut in your
  // face while you were trying to read the relation.
  await clickWorld(page, route.mid, viewport, 'dblclick');

  const after = await readScene(page);
  expect(after.scene.nodes.filter((n) => !n.hidden)).toHaveLength(10);
  await expect(page.locator('.detail .chip')).toContainText('tauri-command');
});

test('expand and collapse, through real double-clicks on the canvas', async ({ page }, testInfo) => {
  await boot(page);
  const { scene, viewport } = await readScene(page);
  const crate = scene.nodes.find((n) => n.id === 'pkg:cargo:src-tauri/Cargo.toml');
  expect(crate).toBeDefined();
  if (crate === undefined) throw new Error('unreachable');

  await clickWorld(page, crate.position, viewport, 'dblclick');
  const expanded = await readScene(page);
  expect(expanded.scene.nodes.filter((n) => !n.hidden).length).toBeGreaterThan(10);
  await shot(page, testInfo, 'expanded');

  await clickWorld(page, crate.position, expanded.viewport, 'dblclick');
  const collapsed = await readScene(page);
  expect(collapsed.scene.nodes.filter((n) => !n.hidden)).toHaveLength(10);
});

test('right-button drag pans the whole canvas, even over the expanded repository', async ({
  page,
}) => {
  await boot(page);
  const before = await readScene(page);
  const repository = before.scene.nodes.find((n) => n.id === 'repo:AgentsCommander');
  expect(repository).toBeDefined();
  if (repository === undefined) throw new Error('repository node is missing');

  const canvas = page.locator('.canvas-host canvas');
  const box = await canvas.boundingBox();
  if (box === null) throw new Error('no canvas');

  // The repository header is part of the violet expanded container and contains no
  // child node. A primary-button drag there targets the container; the secondary
  // button must instead force canvas-pan mode before hit-testing can choose it.
  const startWorld = {
    x: repository.position.x,
    y: repository.position.y - repository.size.h / 2 + 18,
  };
  const start = {
    x: box.x + (startWorld.x - before.viewport.x) * before.viewport.zoom,
    y: box.y + (startWorld.y - before.viewport.y) * before.viewport.zoom,
  };
  const delta = { x: 120, y: 80 };

  const contextMenuPrevented = await canvas.evaluate((element) => {
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(contextMenuPrevented, 'the browser context menu must not take over the gesture').toBe(
    true,
  );

  await page.mouse.move(start.x, start.y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(start.x + delta.x, start.y + delta.y, { steps: 8 });
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(250);

  const after = await readScene(page);
  expect(after.viewport.x).toBeCloseTo(
    before.viewport.x - delta.x / before.viewport.zoom,
    1,
  );
  expect(after.viewport.y).toBeCloseTo(
    before.viewport.y - delta.y / before.viewport.zoom,
    1,
  );

  const repositoryAfter = after.scene.nodes.find((n) => n.id === repository.id);
  expect(repositoryAfter?.position, 'right drag must not move the container').toEqual(
    repository.position,
  );
  await expect(page.locator('.detail-panel')).toContainText('Nothing selected');
});

test('drag → REAL export → REAL import restores the position, the expansion and the viewport', async ({
  page,
}, testInfo) => {
  await boot(page);

  const { scene, viewport } = await readScene(page);
  const target = scene.nodes.find((n) => n.id === 'app:web:index.html');
  expect(target).toBeDefined();
  if (target === undefined) throw new Error('unreachable');

  const box = await page.locator('.canvas-host canvas').boundingBox();
  if (box === null) throw new Error('no canvas');
  const from = {
    x: box.x + (target.position.x - viewport.x) * viewport.zoom,
    y: box.y + (target.position.y - viewport.y) * viewport.zoom,
  };

  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 120, from.y + 90, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(250);

  // Export through the BUTTON, and read the bytes the browser really wrote.
  const exported = await exportThroughUi(page);
  const doc = JSON.parse(exported) as {
    view: {
      positions: Record<string, { x: number; y: number; pinned?: boolean }>;
      expanded: string[];
      viewport: { x: number; y: number; zoom: number };
    };
  };
  const moved = doc.view.positions['app:web:index.html'];
  expect(moved?.pinned, 'a dragged node is pinned').toBe(true);
  expect(moved?.x).not.toBe(target.position.x);
  expect(doc.view.expanded).toEqual(['repo:AgentsCommander']);

  // Import through the FILE INPUT, into a freshly loaded page.
  await page.reload();
  await page.waitForSelector('.canvas-host canvas');
  await importThroughUi(page, 'roundtrip.json', exported);
  await expect(page.locator('.status')).toContainText('Imported roundtrip.json');

  const restored = await exportThroughUi(page);
  const back = JSON.parse(restored) as {
    view: {
      positions: Record<string, { x: number; y: number; pinned?: boolean }>;
      expanded: string[];
      viewport: { x: number; y: number; zoom: number };
    };
  };
  expect(back.view.positions['app:web:index.html']?.x).toBeCloseTo(moved?.x ?? 0, 1);
  expect(back.view.positions['app:web:index.html']?.y).toBeCloseTo(moved?.y ?? 0, 1);
  expect(back.view.positions['app:web:index.html']?.pinned).toBe(true);
  expect(back.view.expanded).toEqual(['repo:AgentsCommander']);
  expect(back.view.viewport.zoom).toBeCloseTo(doc.view.viewport.zoom, 3);

  await shot(page, testInfo, 'dragged');
});

test('a map the user deliberately COLLAPSED comes back collapsed', async ({ page }) => {
  // The regression that six green acceptance tests missed, because "reload" meant
  // calling a hook on the same controller. `expanded: []` is a value, not an absence.
  const errors = await boot(page);

  await page.getByRole('button', { name: 'Collapse all' }).click();
  await page.waitForTimeout(200);

  const exported = await exportThroughUi(page);
  const doc = JSON.parse(exported) as { view: { expanded: string[] } };
  expect(doc.view.expanded, 'Collapse all must export an empty expansion').toEqual([]);

  await page.reload();
  await page.waitForSelector('.canvas-host canvas');
  await importThroughUi(page, 'collapsed.json', exported);

  // The root must still be collapsed: exactly one visible node, and nothing inside it.
  const { scene } = await readScene(page);
  const visible = scene.nodes.filter((n) => !n.hidden);
  expect(visible.map((n) => n.id)).toEqual(['repo:AgentsCommander']);

  const again = JSON.parse(await exportThroughUi(page)) as { view: { expanded: string[] } };
  expect(again.view.expanded, 'importing a collapsed map must not re-open it').toEqual([]);

  expect(errors).toEqual([]);
});

test('zoom in and zoom out, from the toolbar and from the keyboard', async ({ page }) => {
  await boot(page);
  const start = (await readScene(page)).viewport.zoom;

  await page.locator('#zoom-in').click();
  await page.waitForTimeout(120);
  const zoomedIn = (await readScene(page)).viewport.zoom;
  expect(zoomedIn).toBeGreaterThan(start);

  await page.locator('#zoom-out').click();
  await page.waitForTimeout(120);
  expect((await readScene(page)).viewport.zoom).toBeCloseTo(start, 4);

  // …and the keys the toolbar promises actually do it.
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('+');
  await page.waitForTimeout(120);
  expect((await readScene(page)).viewport.zoom).toBeGreaterThan(start);

  await page.keyboard.press('-');
  await page.waitForTimeout(120);
  expect((await readScene(page)).viewport.zoom).toBeCloseTo(start, 4);
});

// ---------------------------------------------------------------------------
// The map has to be usable in a window, not only in a wide monitor.
// ---------------------------------------------------------------------------

for (const size of [
  { name: '1680x1000', width: 1680, height: 1000, docked: true },
  { name: '1024x768', width: 1024, height: 768, docked: false },
  { name: '800x800', width: 800, height: 800, docked: false },
]) {
  test(`the canvas keeps a usable width at ${size.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    const errors = await boot(page);

    const canvas = await page.locator('.canvas-host canvas').boundingBox();
    expect(canvas).not.toBeNull();
    if (canvas === null) throw new Error('unreachable');

    if (size.docked) {
      // Wide: the panels are docked and open, exactly as before.
      await expect(page.locator('.sidebar')).toBeVisible();
      await expect(page.locator('.detail-panel')).toBeVisible();
      // The selected 192px Project Rail is now a fourth wide-screen column.
      // 1680 - 192 Project - 290 Explorer - 380 Details = 818 nominal canvas.
      expect(canvas.width).toBeGreaterThanOrEqual(800);
    } else {
      // Narrow: the panels float, so the map keeps essentially the whole window.
      // 130px of canvas — what the fixed 290px + 380px columns left at 800px — is not
      // a map, it is a strip.
      expect(canvas.width).toBeGreaterThan(size.width * 0.9);
    }
    expect(canvas.height).toBeGreaterThan(300);
    expect(await inkCoverage(page)).toBeGreaterThan(0.005);

    // Both panels are REACHABLE and dismissable, whatever they started as. Docked at a
    // wide viewport, they start open; floating at a narrow one, they start closed — and
    // a control that toggles is a control the user cannot get stuck behind.
    for (const [toggle, panel] of [
      ['#toggle-sidebar', '.sidebar'],
      ['#toggle-detail', '.detail-panel'],
    ] as const) {
      const startedVisible = await page.locator(panel).isVisible();

      await page.locator(toggle).click();
      await page.waitForTimeout(150);
      expect(await page.locator(panel).isVisible(), `${panel} did not toggle`).toBe(!startedVisible);

      await page.locator(toggle).click();
      await page.waitForTimeout(150);
      expect(await page.locator(panel).isVisible(), `${panel} did not toggle back`).toBe(
        startedVisible,
      );
    }

    // Opening a panel at a narrow viewport must not shrink the map away again: the
    // panels FLOAT there, they do not take a column.
    if (!size.docked) {
      await page.locator('#toggle-detail').click();
      await page.waitForTimeout(200);
      const withPanel = await page.locator('.canvas-host canvas').boundingBox();
      expect(withPanel?.width ?? 0).toBeGreaterThan(size.width * 0.9);
      await page.locator('#toggle-detail').click();
      await page.waitForTimeout(150);
    }

    // Nothing has overflowed the window into somewhere the user cannot reach.
    const overflow = await page.evaluate(() => ({
      x: document.documentElement.scrollWidth - globalThis.innerWidth,
      y: document.documentElement.scrollHeight - globalThis.innerHeight,
    }));
    expect(overflow.x).toBeLessThanOrEqual(1);
    expect(overflow.y).toBeLessThanOrEqual(1);

    await shot(page, testInfo, `viewport-${size.name}`);
    expect(errors).toEqual([]);
  });
}

/**
 * The measurement that actually matters at a narrow viewport.
 *
 * The canvas is 800×560 whether or not two drawers are lying on top of it — measuring the
 * canvas told us nothing. A 320px explorer on the left and a 400px detail panel on the
 * right leave **80 pixels** of map you can see or click, and the map is the product.
 */
async function unobscuredMapWidth(page: Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector('.canvas-host canvas');
    if (!(canvas instanceof HTMLCanvasElement)) return 0;
    const c = canvas.getBoundingClientRect();

    let left = c.left;
    let right = c.right;
    for (const selector of ['.sidebar', '.detail-panel']) {
      const panel = document.querySelector(selector);
      if (!(panel instanceof HTMLElement) || panel.hidden) continue;
      const p = panel.getBoundingClientRect();
      if (p.width === 0) continue;
      // The panels are edge-anchored, so each one eats into one side of the map.
      if (p.left <= c.left + 1) left = Math.max(left, p.right);
      else right = Math.min(right, p.left);
    }
    return Math.max(0, right - left);
  });
}

test('at 800x800 the drawers are mutually exclusive, and the map stays usable', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 800, height: 800 });
  const errors = await boot(page);

  const isOpen = async (selector: string): Promise<boolean> => page.locator(selector).isVisible();

  // Both start closed at a narrow viewport.
  expect(await isOpen('.sidebar')).toBe(false);
  expect(await isOpen('.detail-panel')).toBe(false);
  expect(await unobscuredMapWidth(page)).toBeGreaterThan(700);

  // Try to get BOTH open. This is the state the previous release could reach.
  await page.locator('#toggle-sidebar').click();
  await page.waitForTimeout(150);
  await page.locator('#toggle-detail').click();
  await page.waitForTimeout(150);

  const openCount =
    (await isOpen('.sidebar') ? 1 : 0) + (await isOpen('.detail-panel') ? 1 : 0);
  expect(openCount, 'two drawers must never be open over a narrow map').toBeLessThanOrEqual(1);

  // …and whatever IS open still leaves a usable map, not an 80px sliver.
  const withOne = await unobscuredMapWidth(page);
  expect(withOne, `only ${withOne}px of map left uncovered`).toBeGreaterThan(350);

  // Escape dismisses the floating drawer.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  expect(await isOpen('.sidebar')).toBe(false);
  expect(await isOpen('.detail-panel')).toBe(false);
  expect(await unobscuredMapWidth(page)).toBeGreaterThan(700);

  await shot(page, testInfo, 'narrow-drawers');
  expect(errors).toEqual([]);
});

test('at 1680x1000 BOTH panels stay open — they are docked, not in the way', async ({ page }) => {
  await page.setViewportSize({ width: 1680, height: 1000 });
  await boot(page);

  await expect(page.locator('.sidebar')).toBeVisible();
  await expect(page.locator('.detail-panel')).toBeVisible();
  // Docked panels take their own columns, so nothing covers the map.
  const canvas = await page.locator('.canvas-host canvas').boundingBox();
  expect(await unobscuredMapWidth(page)).toBeCloseTo(canvas?.width ?? 0, 0);
});
