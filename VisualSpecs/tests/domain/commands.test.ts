// Command purity (I8) and pinning (§7).

import { describe, expect, it } from 'vitest';
import { importDoc } from '../../src/contract/load.ts';
import { DEFAULT_LIMITS } from '../../src/contract/limits.ts';
import { deepFreeze } from '../../src/contract/json.ts';
import { applyViewCommand, type ViewCommand } from '../../src/domain/commands.ts';
import { computeGeometry } from '../../src/domain/layoutEngine.ts';
import { OwnershipOutline } from '../../src/domain/outline.ts';
import { boxesOverlap, boxOf } from '../../src/domain/geometry.ts';
import { mulberry32, sampleDoc } from '../support/doc.ts';

function setup() {
  const loaded = importDoc(sampleDoc());
  const outline = new OwnershipOutline(loaded.model);
  // Deep-freeze the model: a mutation is then a TypeError, not a silent bug.
  deepFreeze(loaded.model.nodes as unknown as never);
  deepFreeze(loaded.model.edges as unknown as never);
  const geometry = computeGeometry(loaded.model, outline, loaded.view.expanded, loaded.view.positions);
  return { loaded, outline, ctx: { model: loaded.model, outline, geometry, limits: DEFAULT_LIMITS } };
}

describe('purity (I8)', () => {
  it('a long random command sequence never mutates the model', () => {
    const { loaded, outline, ctx } = setup();
    const before = JSON.stringify(loaded.model.nodes) + JSON.stringify(loaded.model.edges);

    const ids = ['repo', 'pkg-a', 'pkg-b', 'dir-a', 'dir-b', 'file-a1', 'file-a2', 'file-b1'];
    const rnd = mulberry32(99);
    let view = loaded.view;

    for (let i = 0; i < 400; i += 1) {
      const id = ids[Math.floor(rnd() * ids.length)] as string;
      const pool: ViewCommand[] = [
        { type: 'ToggleExpand', id },
        { type: 'Expand', id },
        { type: 'Collapse', id },
        { type: 'ExpandAll' },
        { type: 'CollapseAll' },
        { type: 'ExpandTo', id },
        { type: 'MoveNode', id, position: { x: rnd() * 500, y: rnd() * 500 } },
        { type: 'ResetLayout' },
        { type: 'SetViewport', viewport: { x: rnd() * 10, y: rnd() * 10, zoom: 1 + rnd() } },
      ];
      const cmd = pool[Math.floor(rnd() * pool.length)] as ViewCommand;
      const geometry = computeGeometry(loaded.model, outline, view.expanded, view.positions);
      view = applyViewCommand({ ...ctx, geometry }, view, cmd);
    }

    expect(JSON.stringify(loaded.model.nodes) + JSON.stringify(loaded.model.edges)).toBe(before);
  });

  it('returns a NEW ViewState and leaves the old one alone', () => {
    const { loaded, ctx } = setup();
    const before = loaded.view;
    const after = applyViewCommand(ctx, before, { type: 'ToggleExpand', id: 'pkg-a' });
    expect(after).not.toBe(before);
    expect(before.expanded.has('pkg-a')).toBe(false);
    expect(after.expanded.has('pkg-a')).toBe(true);
  });
});

describe('pinning (§7)', () => {
  it('auto-layout NEVER moves a pinned node', () => {
    const { loaded, outline, ctx } = setup();
    let view = applyViewCommand(ctx, loaded.view, { type: 'Expand', id: 'repo' });
    view = applyViewCommand(ctx, view, { type: 'MoveNode', id: 'pkg-b', position: { x: 900, y: 700 } });

    // Expanding a sibling re-packs the UNPINNED children and cascades upward…
    const geometry1 = computeGeometry(loaded.model, outline, view.expanded, view.positions);
    const pinnedBefore = geometry1.position.get('pkg-b');
    expect(pinnedBefore).toEqual({ x: 900, y: 700 });

    const view2 = applyViewCommand(
      { ...ctx, geometry: geometry1 },
      view,
      { type: 'Expand', id: 'pkg-a' },
    );
    const geometry2 = computeGeometry(loaded.model, outline, view2.expanded, view2.positions);

    // …and pkg-b, which the user placed, has not moved a pixel.
    expect(geometry2.position.get('pkg-b')).toEqual({ x: 900, y: 700 });
  });

  it('dragging a CONTAINER translates its whole subtree by the delta', () => {
    const { loaded, outline, ctx } = setup();
    let view = applyViewCommand(ctx, loaded.view, { type: 'ExpandAll' });
    let geometry = computeGeometry(loaded.model, outline, view.expanded, view.positions);

    const before = geometry.position.get('file-a1');
    const containerBefore = geometry.position.get('pkg-a');
    if (before === undefined || containerBefore === undefined) throw new Error('no geometry');

    const target = { x: containerBefore.x + 300, y: containerBefore.y + 150 };
    view = applyViewCommand({ ...ctx, geometry }, view, { type: 'MoveNode', id: 'pkg-a', position: target });
    geometry = computeGeometry(loaded.model, outline, view.expanded, view.positions);

    expect(geometry.position.get('pkg-a')).toEqual(target);
    const after = geometry.position.get('file-a1');
    expect(after?.x).toBeCloseTo(before.x + 300, 6);
    expect(after?.y).toBeCloseTo(before.y + 150, 6);
  });

  it('a container you moved stays where you put it across expand → collapse', () => {
    const { loaded, outline, ctx } = setup();
    let view = applyViewCommand(ctx, loaded.view, { type: 'Expand', id: 'repo' });
    view = applyViewCommand(ctx, view, { type: 'MoveNode', id: 'pkg-a', position: { x: 640, y: 480 } });

    view = applyViewCommand(ctx, view, { type: 'Expand', id: 'pkg-a' });
    view = applyViewCommand(ctx, view, { type: 'Collapse', id: 'pkg-a' });

    const geometry = computeGeometry(loaded.model, outline, view.expanded, view.positions);
    expect(geometry.position.get('pkg-a')).toEqual({ x: 640, y: 480 });
  });

  it('ResetLayout throws away the layout but keeps INERT positions, so an export loses nothing', () => {
    const loaded = importDoc(
      JSON.stringify({
        ...(JSON.parse(sampleDoc()) as object),
        view: { positions: { 'pkg-a': { x: 5, y: 5, pinned: true }, ghost: { x: 9, y: 9 } } },
      }),
    );
    const outline = new OwnershipOutline(loaded.model);
    const geometry = computeGeometry(loaded.model, outline, loaded.view.expanded, loaded.view.positions);
    const view = applyViewCommand({ model: loaded.model, outline, geometry, limits: DEFAULT_LIMITS }, loaded.view, {
      type: 'ResetLayout',
    });

    expect(view.positions.has('pkg-a')).toBe(false);
    expect(view.positions.get('ghost')).toEqual({ x: 9, y: 9 });
  });
});

describe('geometry is legible (§12, the cheap gate)', () => {
  it('the initial view does not overlap any node with any other', () => {
    const { loaded, outline } = setup();
    const geometry = computeGeometry(loaded.model, outline, new Set(['repo']), new Map());

    const boxes = [...geometry.visibility.visible]
      .filter((id) => id !== 'repo') // the container legitimately contains its children
      .map((id) => {
        const p = geometry.position.get(id);
        const s = geometry.size.get(id);
        if (p === undefined || s === undefined) throw new Error(`no geometry for ${id}`);
        return { id, box: boxOf(p, s) };
      });

    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i];
        const b = boxes[j];
        if (a === undefined || b === undefined) continue;
        expect(boxesOverlap(a.box, b.box, 1), `${a.id} overlaps ${b.id}`).toBe(false);
      }
    }
  });

  it('two passes are enough: without pins the layout is a fixed point', () => {
    const { loaded, outline } = setup();
    const a = computeGeometry(loaded.model, outline, new Set(['repo', 'pkg-a']), new Map());
    const b = computeGeometry(loaded.model, outline, new Set(['repo', 'pkg-a']), new Map());
    expect([...b.position.entries()]).toEqual([...a.position.entries()]);
    expect([...b.size.entries()]).toEqual([...a.size.entries()]);
  });
});
