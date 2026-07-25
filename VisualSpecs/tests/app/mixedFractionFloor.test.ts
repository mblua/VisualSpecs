// Calibration of `MIXED_FRACTION_FLOOR` (Issue #17, §4.3's fourth constraint).
//
// The fraction satisfies monotonicity, exactness at ×1 and composition under `min`,
// and the PLAIN continuous form still loses the override at the fine end: on the
// corpus's ×136 aggregate, one bright relation moves the line by a single 8-bit step.
// The same argument that rejects transparency 95 as "perceptually gone", applied to a
// difference rather than to a value.
//
// Core states the property; the number is a rendering calibration and is measured
// here, exactly as `RING_FLOOR` was. What decides it is not taste: 0.10 reproduces
// the ONE step this review measured and called visible — 14/136, which is 0.1029 of
// the range — on every edge kind in the palette.

import { describe, expect, it } from 'vitest';
import { CANVAS_BACKGROUND } from '../../src/adapters/canvas2d/Canvas2DRenderer.ts';
import { DEFAULT_LIMITS } from '../../src/contract/limits.ts';
import { aggregateFocusOpacity, MIXED_FRACTION_FLOOR } from '../../src/domain/focus.ts';
import { edgeStyle, knownEdgeKinds, UNKNOWN_EDGE_STYLE } from '../../src/app/registry.ts';

type RGB = readonly [number, number, number];

const hex = (v: string): RGB => [
  parseInt(v.slice(1, 3), 16),
  parseInt(v.slice(3, 5), 16),
  parseInt(v.slice(5, 7), 16),
];

/** Source-over, quantised — the pixel a screen actually shows. */
const composite = (fg: RGB, bg: RGB, alpha: number): RGB =>
  [0, 1, 2].map((i) =>
    Math.round(alpha * (fg[i] as number) + (1 - alpha) * (bg[i] as number)),
  ) as unknown as RGB;

const luminance = (c: RGB): number => {
  const ch = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2]);
};

/** The largest per-channel move, in 8-bit steps. */
const steps = (a: RGB, b: RGB): number =>
  Math.max(...[0, 1, 2].map((i) => Math.abs((a[i] as number) - (b[i] as number))));

/** Relative luminance change — palette-independent, which is what lets the seven
 *  kinds be compared to one another and to the review's measured case. */
const relative = (a: RGB, b: RGB): number =>
  Math.abs(luminance(a) - luminance(b)) / Math.max(luminance(a), luminance(b));

const BACKGROUND = hex(CANVAS_BACKGROUND);
const COLOURS: readonly (readonly [string, string])[] = [
  ...knownEdgeKinds().map((k) => [k, edgeStyle(k).color] as const),
  ['unknown', UNKNOWN_EDGE_STYLE.color] as const,
];

/** The corpus's largest drawn aggregate, and the case every one of these is about. */
const TOTAL = 136;
const DEFAULT_TRANSPARENCY = 70;

function move(
  transparency: number,
  bright: number,
  floor: number,
  colour: string,
): { steps: number; relative: number } {
  const off = composite(
    hex(colour),
    BACKGROUND,
    aggregateFocusOpacity(transparency, 0, TOTAL, floor),
  );
  const on = composite(
    hex(colour),
    BACKGROUND,
    aggregateFocusOpacity(transparency, bright, TOTAL, floor),
  );
  return { steps: steps(off, on), relative: relative(off, on) };
}

describe('the plain continuous form loses the override at the fine end', () => {
  it('moves a ×136 line by one or two 8-bit steps for one bright relation', () => {
    for (const [kind, colour] of COLOURS) {
      const m = move(DEFAULT_TRANSPARENCY, 1, 0, colour);
      expect(m.steps, `${kind} with no floor`).toBeLessThanOrEqual(2);
      expect(m.relative, `${kind} with no floor`).toBeLessThan(0.05);
    }
  });
});

describe('MIXED_FRACTION_FLOOR reproduces the step this review measured as visible', () => {
  // 14/136 = 0.1029 of the range was measured and called visible; 1/136 was not. The
  // floor lifts the smallest non-zero fraction to that same magnitude, so it collapses
  // only the band that was already indistinguishable.
  const REFERENCE_BRIGHT = 14;

  it('lifts one bright relation to the reference step, on every edge kind', () => {
    for (const [kind, colour] of COLOURS) {
      const reference = move(DEFAULT_TRANSPARENCY, REFERENCE_BRIGHT, 0, colour);
      const lifted = move(DEFAULT_TRANSPARENCY, 1, MIXED_FRACTION_FLOOR, colour);
      expect(lifted.relative, `${kind}`).toBeGreaterThanOrEqual(reference.relative * 0.9);
      expect(lifted.steps, `${kind}`).toBeGreaterThanOrEqual(reference.steps - 1);
    }
  });

  it('pins the worst kind at the default transparency: 11 of 255 steps, 26%', () => {
    let worstSteps = Infinity;
    let worstRelative = Infinity;
    let who = '';
    for (const [kind, colour] of COLOURS) {
      const m = move(DEFAULT_TRANSPARENCY, 1, MIXED_FRACTION_FLOOR, colour);
      if (m.steps < worstSteps) {
        worstSteps = m.steps;
        who = kind;
      }
      worstRelative = Math.min(worstRelative, m.relative);
    }
    // The reference — 14/136 with no floor, the case the review measured and called
    // visible — is 11 steps and 26.21% on this same worst kind. The floor reproduces
    // it at 11 steps and 26.07%, which is the whole calibration argument in two
    // numbers. Quantised, because a continuous sweep reads ~1 point higher and would
    // pin a value no screen produces.
    expect(worstSteps, `worst kind: ${who}`).toBeGreaterThanOrEqual(11);
    expect(worstRelative).toBeGreaterThanOrEqual(0.26);
  });

  it('scales with the setting: it is a fraction of the AVAILABLE range, not of opacity', () => {
    // At transparency 10 the whole dimming range is 0.10 of opacity, so a tenth of it
    // is 0.01 — and nothing can be more visible than the effect it modulates. The
    // floor degrades with the setting rather than fighting it, which is why it is
    // expressed against `1 - dim`.
    const low = move(DEFAULT_LIMITS.minFocusTransparency, 1, MIXED_FRACTION_FLOOR, '#6f92e8');
    const high = move(DEFAULT_LIMITS.maxFocusTransparency, 1, MIXED_FRACTION_FLOOR, '#6f92e8');
    expect(low.steps).toBeLessThan(high.steps);
    expect(high.steps).toBeGreaterThanOrEqual(11);
  });

  it('costs resolution ONLY below itself, and keeps the fraction above it', () => {
    const t = DEFAULT_TRANSPARENCY;
    const floored = Math.floor(MIXED_FRACTION_FLOOR * TOTAL);
    // Everything from 1 up to the floor renders identically — the band the plain form
    // could not distinguish anyway.
    expect(aggregateFocusOpacity(t, 1, TOTAL)).toBeCloseTo(
      aggregateFocusOpacity(t, floored, TOTAL),
      10,
    );
    // Above it, the fraction is carried unchanged: 34/136 and 68/136 stay distinct.
    expect(aggregateFocusOpacity(t, 34, TOTAL)).toBeLessThan(aggregateFocusOpacity(t, 68, TOTAL));
    expect(aggregateFocusOpacity(t, 68, TOTAL)).toBeLessThan(aggregateFocusOpacity(t, 135, TOTAL));
  });

  it('leaves the two ends exact — no floor at 0 bright, no ceiling below 1 at all bright', () => {
    for (let t = DEFAULT_LIMITS.minFocusTransparency; t <= DEFAULT_LIMITS.maxFocusTransparency; t += 1) {
      expect(aggregateFocusOpacity(t, 0, TOTAL)).toBeCloseTo(1 - t / 100, 10);
      expect(aggregateFocusOpacity(t, TOTAL, TOTAL)).toBe(1);
      // ×1 stays the boolean rule, which is what keeps the 0-of-14 evidence intact.
      expect(aggregateFocusOpacity(t, 0, 1)).toBeCloseTo(1 - t / 100, 10);
      expect(aggregateFocusOpacity(t, 1, 1)).toBe(1);
    }
  });
});
