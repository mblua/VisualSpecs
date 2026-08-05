// ResetLayout { scope } (#44): realign ONE container without discarding the document's
// layout, and say what it costs before it costs it.

import { describe, expect, it } from 'vitest';
import { importDoc } from '../../src/contract/load.ts';
import { DEFAULT_LIMITS } from '../../src/contract/limits.ts';
import {
  applyViewCommand,
  resetLayoutPreview,
  type CommandContext,
} from '../../src/domain/commands.ts';
import { computeGeometry } from '../../src/domain/layoutEngine.ts';
import { OwnershipOutline } from '../../src/domain/outline.ts';
import { withPositions } from '../../src/contract/view.ts';
import type { Position } from '../../src/contract/types.ts';
import { sampleDoc } from '../support/doc.ts';

function setup() {
  const loaded = importDoc(sampleDoc());
  const outline = new OwnershipOutline(loaded.model);
  const geometry = computeGeometry(
    loaded.model,
    outline,
    loaded.view.expanded,
    loaded.view.positions,
  );
  const ctx: CommandContext = { model: loaded.model, outline, geometry, limits: DEFAULT_LIMITS };

  // A hand-made arrangement across both packages, plus one position naming an id that
  // is not in this graph at all.
  const positions = new Map<string, Position>([
    ['pkg-a', { x: 10, y: 10, pinned: true }],
    ['dir-a', { x: 20, y: 20, pinned: true }],
    ['file-a1', { x: 30, y: 30, pinned: true }],
    ['file-a2', { x: 40, y: 40 }],
    ['pkg-b', { x: 50, y: 50, pinned: true }],
    ['file-b1', { x: 60, y: 60, pinned: true }],
    ['ghost', { x: 70, y: 70, pinned: true }],
  ]);
  return { ctx, view: withPositions(loaded.view, positions) };
}

describe('ResetLayout with a scope', () => {
  it('drops what is INSIDE the container and leaves the rest of the document alone', () => {
    const { ctx, view } = setup();
    const after = applyViewCommand(ctx, view, { type: 'ResetLayout', scope: 'pkg-a' });

    // Inside pkg-a: gone.
    expect(after.positions.has('dir-a')).toBe(false);
    expect(after.positions.has('file-a1')).toBe(false);
    expect(after.positions.has('file-a2')).toBe(false);

    // The container itself keeps its position: realigning what is inside a box must
    // not move the box.
    expect(after.positions.get('pkg-a')).toEqual({ x: 10, y: 10, pinned: true });

    // Another branch of the document: untouched.
    expect(after.positions.get('pkg-b')).toEqual({ x: 50, y: 50, pinned: true });
    expect(after.positions.get('file-b1')).toEqual({ x: 60, y: 60, pinned: true });
  });

  it('declares how many pins it will discard BEFORE discarding them', () => {
    const { ctx, view } = setup();
    const preview = resetLayoutPreview(ctx, view, 'pkg-a');

    // dir-a and file-a1 are pinned; file-a2 is a derived position, dropped but not
    // hand-made. A prompt that counted all three would overstate the loss.
    expect(preview.pinned).toBe(2);
    expect(preview.positions).toBe(3);

    // And the preview matches what the command then does.
    const after = applyViewCommand(ctx, view, { type: 'ResetLayout', scope: 'pkg-a' });
    expect(view.positions.size - after.positions.size).toBe(preview.positions);
  });

  it('un-fits the scope, because its size hugged an arrangement that is about to change', () => {
    const { ctx, view } = setup();
    const fitted = applyViewCommand(ctx, view, { type: 'FitContainer', id: 'pkg-a' });
    const after = applyViewCommand(ctx, fitted, { type: 'ResetLayout', scope: 'pkg-a' });
    expect(after.fitted.has('pkg-a')).toBe(false);
  });

  it('without a scope it still resets the whole document, exactly as before', () => {
    const { ctx, view } = setup();
    const after = applyViewCommand(ctx, view, { type: 'ResetLayout' });
    for (const id of ['pkg-a', 'dir-a', 'file-a1', 'file-a2', 'pkg-b', 'file-b1']) {
      expect(after.positions.has(id), `${id} survived a full reset`).toBe(false);
    }
  });

  it('an INERT position survives both forms — it is not this graph\'s layout to discard (§3.5)', () => {
    const { ctx, view } = setup();
    const scoped = applyViewCommand(ctx, view, { type: 'ResetLayout', scope: 'pkg-a' });
    const whole = applyViewCommand(ctx, view, { type: 'ResetLayout' });
    expect(scoped.positions.get('ghost')).toEqual({ x: 70, y: 70, pinned: true });
    expect(whole.positions.get('ghost')).toEqual({ x: 70, y: 70, pinned: true });
    // And the preview does not count it as something it will destroy.
    expect(resetLayoutPreview(ctx, view).positions).toBe(6);
  });
});
