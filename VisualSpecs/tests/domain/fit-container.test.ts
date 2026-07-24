// FitContainer (Issue #13, ADR-0005): hug a container to its children down to the
// legibility floor, preserving the arrangement. These are the acceptance cases the
// red teams required — FIT-1 (floor lowered but legible), no-clip, the F1 guard,
// idempotency, and the export→import doc round-trip.

import { describe, expect, it } from 'vitest';
import { importDoc, refresh } from '../../src/contract/load.ts';
import { exportDoc } from '../../src/contract/export.ts';
import { applyViewCommand, type CommandContext } from '../../src/domain/commands.ts';
import { computeGeometry } from '../../src/domain/layoutEngine.ts';
import { OwnershipOutline } from '../../src/domain/outline.ts';
import { HEADER_RESERVE, measureText, type Box } from '../../src/domain/geometry.ts';
import type { ViewState } from '../../src/contract/view.ts';
import { node, docText } from '../support/doc.ts';

const LABEL = 'Frontend';

// A container `C` (expanded) with three leaf children stacked in a vertical column —
// the arrangement GridPack would never produce, and the one where the natural floor
// otherwise leaves ~2× horizontal slack.
function stackedDoc(): string {
  return docText(
    [
      node('C', 'directory', null, { label: LABEL }),
      node('a', 'file', 'C', { label: 'Web' }),
      node('b', 'file', 'C', { label: 'Telegram' }),
      node('c', 'file', 'C', { label: 'Whatsapp' }),
    ],
    [],
    { view: { expanded: ['C'] } },
  );
}

function geom(model: CommandContext['model'], outline: OwnershipOutline, view: ViewState) {
  return computeGeometry(model, outline, view.expanded, view.positions, view.fitted);
}

/** Load, expand C, and pin a/b/c into a vertical column. Returns the view + tools. */
function setupStack() {
  const loaded = importDoc(stackedDoc());
  const outline = new OwnershipOutline(loaded.model);
  let view = loaded.view;

  const column: Array<[string, number]> = [
    ['a', 0],
    ['b', 90],
    ['c', 180],
  ];
  for (const [id, y] of column) {
    const geometry = geom(loaded.model, outline, view);
    view = applyViewCommand({ model: loaded.model, outline, geometry }, view, {
      type: 'MoveNode',
      id,
      position: { x: 0, y },
    });
  }
  const ctx = (v: ViewState): CommandContext => ({
    model: loaded.model,
    outline,
    geometry: geom(loaded.model, outline, v),
  });
  return { loaded, outline, view, ctx };
}

function contains(outer: Box, inner: Box): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

describe('FitContainer — FIT-1 acceptance (legibility floor, not grid-pack)', () => {
  it('hugs a vertical stack below the grid-pack natural width, but never below the header', () => {
    const { loaded, outline, view, ctx } = setupStack();

    const before = geom(loaded.model, outline, view).box.get('C');
    if (before === undefined) throw new Error('no box for C before fit');

    const fitted = applyViewCommand(ctx(view), view, { type: 'FitContainer', id: 'C' });
    const after = geom(loaded.model, outline, fitted).box.get('C');
    if (after === undefined) throw new Error('no box for C after fit');

    // The floor was lowered: the box is strictly narrower than the grid-pack natural.
    expect(after.w).toBeLessThan(before.w);

    // …but never below the legibility floor — the header still shows `▾ label` + glyph.
    const legibilityFloor = measureText(LABEL) + HEADER_RESERVE;
    expect(after.w).toBeGreaterThanOrEqual(legibilityFloor);

    // The children keep their arrangement and stay fully inside the hugged box.
    for (const id of ['a', 'b', 'c']) {
      const child = geom(loaded.model, outline, fitted).box.get(id);
      if (child === undefined) throw new Error(`no box for ${id}`);
      expect(contains(after, child)).toBe(true);
    }
  });

  it('marks the container fitted and the dispatch changes state (FIT-5)', () => {
    const { view, ctx } = setupStack();
    const fitted = applyViewCommand(ctx(view), view, { type: 'FitContainer', id: 'C' });
    expect(fitted).not.toBe(view);
    expect(fitted.fitted.has('C')).toBe(true);
  });
});

describe('FitContainer — no-clip (the floor is a minimum, grow still contains)', () => {
  it('a child dragged far outside the legibility floor is never clipped', () => {
    const { loaded, outline, view, ctx } = setupStack();
    // Drag `c` far to the right, well beyond any header floor.
    const dragged = applyViewCommand(ctx(view), view, {
      type: 'MoveNode',
      id: 'c',
      position: { x: 2000, y: 0 },
    });
    const fitted = applyViewCommand(ctx(dragged), dragged, { type: 'FitContainer', id: 'C' });
    const box = geom(loaded.model, outline, fitted);
    const outer = box.box.get('C');
    const outlier = box.box.get('c');
    if (outer === undefined || outlier === undefined) throw new Error('missing boxes');
    expect(contains(outer, outlier)).toBe(true);
  });
});

describe('FitContainer — guard (F1) and idempotency', () => {
  it('is a no-op on a collapsed container (childrenShown guard)', () => {
    const loaded = importDoc(stackedDoc());
    const outline = new OwnershipOutline(loaded.model);
    // Collapse C: it is no longer childrenShown, so a fit must be a no-op.
    const collapsed = applyViewCommand(
      { model: loaded.model, outline, geometry: geom(loaded.model, outline, loaded.view) },
      loaded.view,
      { type: 'Collapse', id: 'C' },
    );
    const fitted = applyViewCommand(
      { model: loaded.model, outline, geometry: geom(loaded.model, outline, collapsed) },
      collapsed,
      { type: 'FitContainer', id: 'C' },
    );
    expect(fitted).toBe(collapsed);
  });

  it('fit ∘ fit == fit (fitted set, positions, and box are all fixpoints)', () => {
    const { loaded, outline, view, ctx } = setupStack();
    const once = applyViewCommand(ctx(view), view, { type: 'FitContainer', id: 'C' });
    const twice = applyViewCommand(ctx(once), once, { type: 'FitContainer', id: 'C' });

    expect([...twice.fitted].sort()).toEqual([...once.fitted].sort());
    const boxOnce = geom(loaded.model, outline, once).box.get('C');
    const boxTwice = geom(loaded.model, outline, twice).box.get('C');
    expect(boxTwice).toEqual(boxOnce);
  });

  it('never writes a non-finite position', () => {
    const { view, ctx } = setupStack();
    const fitted = applyViewCommand(ctx(view), view, { type: 'FitContainer', id: 'C' });
    for (const p of fitted.positions.values()) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    }
  });
});

describe('FitContainer — persistence (F2 doc round-trip + reconciliation)', () => {
  it('export → import restores the fitted hug (not the grid-pack natural)', () => {
    const { loaded, outline, view, ctx } = setupStack();
    const fitted = applyViewCommand(ctx(view), view, { type: 'FitContainer', id: 'C' });
    const hugged = geom(loaded.model, outline, fitted).box.get('C');
    if (hugged === undefined) throw new Error('no hugged box');

    const text = exportDoc({ raw: loaded.raw, view: fitted, readOnly: false });
    // The document announces itself as 1.1 once it carries a fitted container.
    expect(JSON.parse(text).formatVersion).toBe('1.1');

    const reloaded = importDoc(text);
    const outline2 = new OwnershipOutline(reloaded.model);
    expect(reloaded.view.fitted.has('C')).toBe(true);
    const restored = geom(reloaded.model, outline2, reloaded.view).box.get('C');
    expect(restored).toEqual(hugged);
  });

  it('a document that never fits exports without a `fitted` key and stays 1.0', () => {
    const loaded = importDoc(stackedDoc());
    const text = exportDoc({ raw: loaded.raw, view: loaded.view, readOnly: false });
    const parsed = JSON.parse(text);
    expect(parsed.formatVersion).toBe('1.0');
    expect(parsed.view?.fitted).toBeUndefined();
  });

  it('refresh drops a fitted id whose container disappeared, and reports it', () => {
    const { loaded, outline, view, ctx } = setupStack();
    const fitted = applyViewCommand(ctx(view), view, { type: 'FitContainer', id: 'C' });

    // Re-extract a document that no longer has container `C`.
    const withoutC = docText([node('R', 'repository', null)], []);
    const { loss } = refresh(withoutC, { model: loaded.model, view: fitted });
    expect(loss.droppedFitted).toContain('C');
  });
});
