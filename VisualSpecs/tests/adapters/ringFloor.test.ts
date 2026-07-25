// The selection ring's perceptibility floor (Issue #17, §7), swept rather than sampled.
//
// I-F6 promises an out-of-focus entity stays SELECTABLE. Nothing promised the
// selection stays VISIBLE, and it does not: a ring drawn at its box's own opacity
// loses contrast against that box as both fade toward the same backdrop. At the
// default transparency of 70 a selected out-of-focus node's ring sits at 2.62:1.
//
// Two things this file exists to stop:
//
//  1. `RING_FLOOR` being "optimised" toward a believed 0.34. A leaf-only sweep
//     suggests 0.34 is the minimum; the CONTAINER branch fails there at 2.71, and the
//     container branch is the binding one because `#e2e8f0` over a `×0.55` fill loses
//     more than the darker fill gives back.
//  2. The sweep being done in continuous colour. A screen shows 8-BIT pixels, and the
//     rounding is what decides the marginal cases: continuous arithmetic says a leaf
//     at 0.34 passes with 3.0018, and the quantised pixel a user actually sees is
//     2.9967. The model here quantises, deliberately.

import { describe, expect, it } from 'vitest';
import {
  CANVAS_BACKGROUND,
  CONTAINER_FILL_ALPHA,
  RING_FLOOR,
  SELECTION_RING_CONTAINER,
  SELECTION_RING_LEAF,
} from '../../src/adapters/canvas2d/Canvas2DRenderer.ts';
import { DEFAULT_LIMITS } from '../../src/contract/limits.ts';
import { knownNodeKinds, nodeStyle, UNKNOWN_NODE_STYLE } from '../../src/app/registry.ts';
import { focusOpacity } from '../../src/domain/focus.ts';

type RGB = readonly [number, number, number];

function hex(value: string): RGB {
  return [
    parseInt(value.slice(1, 3), 16),
    parseInt(value.slice(3, 5), 16),
    parseInt(value.slice(5, 7), 16),
  ];
}

/** Source-over, then quantised — because that is what lands in the framebuffer. */
function composite(fg: RGB, bg: RGB, alpha: number): RGB {
  return [0, 1, 2].map((i) =>
    Math.round(alpha * (fg[i] as number) + (1 - alpha) * (bg[i] as number)),
  ) as unknown as RGB;
}

function relativeLuminance(c: RGB): number {
  const channel = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2])
  );
}

function contrast(a: RGB, b: RGB): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const BACKGROUND = hex(CANVAS_BACKGROUND);
/** Every kind the registry knows, plus the fallback an unknown kind renders through. */
const FILLS: readonly (readonly [string, string])[] = [
  ...knownNodeKinds().map((kind) => [kind, nodeStyle(kind).fill] as const),
  ['unknown', UNKNOWN_NODE_STYLE.fill] as const,
];
const BAND: number[] = [];
for (let t = DEFAULT_LIMITS.minFocusTransparency; t <= DEFAULT_LIMITS.maxFocusTransparency; t += 1) {
  BAND.push(t);
}

interface Worst {
  ratio: number;
  where: string;
}

/** The two branches `paintNode` actually has, drawn exactly as it draws them. */
function sweep(floor: number, branch: 'leaf' | 'container'): Worst {
  const ring = hex(branch === 'leaf' ? SELECTION_RING_LEAF : SELECTION_RING_CONTAINER);
  let worst: Worst = { ratio: Infinity, where: '' };
  for (const transparency of BAND) {
    const opacity = focusOpacity(transparency);
    const ringAlpha = Math.max(opacity, floor);
    // An expanded container is see-through: its fill carries `×0.55` BEFORE globalAlpha.
    const fillAlpha = branch === 'container' ? CONTAINER_FILL_ALPHA * opacity : opacity;
    for (const [kind, fill] of FILLS) {
      const box = composite(hex(fill), BACKGROUND, fillAlpha);
      const ratio = contrast(composite(ring, box, ringAlpha), box);
      if (ratio < worst.ratio) worst = { ratio, where: `${kind} at transparency ${String(transparency)}` };
    }
  }
  return worst;
}

describe('the selection ring holds a contrast floor against its own box (§7)', () => {
  it('is 3:1 or better at the shipped RING_FLOOR, on both branches, across the whole band', () => {
    const leaf = sweep(RING_FLOOR, 'leaf');
    const container = sweep(RING_FLOOR, 'container');
    expect(leaf.ratio, `worst leaf case: ${leaf.where}`).toBeGreaterThanOrEqual(3);
    expect(container.ratio, `worst container case: ${container.where}`).toBeGreaterThanOrEqual(3);
  });

  it('pins the worst case, so a palette change cannot quietly erode the margin', () => {
    // The container branch is the binding one and this is the number to watch.
    expect(sweep(RING_FLOOR, 'container').ratio).toBeCloseTo(3.3, 1);
    expect(sweep(RING_FLOOR, 'leaf').ratio).toBeCloseTo(3.68, 1);
  });

  it('fails on BOTH branches at 0.34 — the value a leaf-only sweep would suggest', () => {
    // The margin over the true container minimum (0.371) is 0.029, so "it looks like
    // 0.34 is enough" is exactly the optimisation this test exists to reject.
    expect(sweep(0.34, 'container').ratio).toBeLessThan(3);
    expect(sweep(0.34, 'leaf').ratio).toBeLessThan(3);
    expect(sweep(0.34, 'container').ratio).toBeCloseTo(2.71, 2);
  });

  it('the container branch is stricter than the leaf branch at every floor', () => {
    for (const floor of [0.34, 0.4, 0.5, 0.8]) {
      expect(sweep(floor, 'container').ratio).toBeLessThan(sweep(floor, 'leaf').ratio);
    }
  });

  it('is a no-op when nothing is out of focus, so no in-focus map changes', () => {
    expect(Math.max(1, RING_FLOOR)).toBe(1);
  });
});
