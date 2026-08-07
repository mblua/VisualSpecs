// The domain owns geometry; the renderer draws what it is given (§7).
//
// Sizes are DERIVED, never stored, and they are derived from a fixed character
// width model — NOT from browser text metrics, which vary by platform and would
// make the document non-deterministic. The same label produces the same box in
// Node, in Chromium, and in a unit test.

export interface Size {
  w: number;
  h: number;
}
export interface Point {
  x: number;
  y: number;
}
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const FONT_SIZE = 13;
export const CONTAINER_HEADER = 30;
export const CONTAINER_PADDING = 22;
/**
 * Width reserved in an expanded container's header, on top of the label, for the
 * caret, paddings and the fit-to-content glyph (Issue #13). Every expanded header
 * draws `▾ label` + the fit glyph, so the reserve applies to all of them; it is also
 * the legibility floor a fitted container never shrinks below (§ADR-0005). Coordinated
 * with graph/runtime's glyph metric — bump here if the header controls change.
 */
export const HEADER_RESERVE = 114;
/** Boxes need room between them for the fanned-out relations that run between. */
export const CHILD_GAP = 34;
export const MIN_LEAF_WIDTH = 96;
export const MAX_LEAF_WIDTH = 260;
export const LEAF_HEIGHT = 38;
export const COLLAPSED_CONTAINER_HEIGHT = 52;
export const MIN_COLLAPSED_CONTAINER_WIDTH = 150;
export const MAX_COLLAPSED_CONTAINER_WIDTH = 320;
/** Wrap the grid pack at this content width. */
export const MAX_ROW_WIDTH = 1500;
/**
 * Legibility floor for one level band (LVL-4', Issue #44).
 *
 * A band's height is `its content + padding`, never less than this. The two are
 * different mechanisms and both are needed: the floor only helps bands whose content
 * is shorter than it, while the padding applies always.
 *
 * It is `LEAF_HEIGHT + CHILD_GAP` because that is what a one-row band of leaves
 * already measures once it takes its half-gap from each side — so on the current
 * constants the floor is INERT, and that is the finding, not an oversight: band
 * padding coming out of `CHILD_GAP` already satisfies LVL-4' on this corpus. It is
 * written down as a floor anyway, so that lowering `LEAF_HEIGHT` or the gap for a
 * layout reason cannot silently produce a band too thin to carry its own label.
 */
export const MIN_BAND_HEIGHT = LEAF_HEIGHT + CHILD_GAP;

// A fixed proportional model. Three buckets is enough for stable, legible boxes,
// and it is exactly reproducible anywhere.
const NARROW = new Set('iljtfIr.,:;\'"|!`()[]{}-'.split(''));
const WIDE = new Set('mwMW@%QOGDHNU'.split(''));

export function measureText(text: string, fontSize: number = FONT_SIZE): number {
  let units = 0;
  for (const ch of text) {
    if (NARROW.has(ch)) units += 0.36;
    else if (WIDE.has(ch)) units += 0.92;
    else units += 0.58;
  }
  return units * fontSize;
}

export interface TruncatedLabel {
  text: string;
  truncated: boolean;
}

/** Deterministic truncation: drop characters from the end until it fits, then add
 *  an ellipsis. Never returns something wider than `maxWidth` unless a single
 *  character is already wider. */
export function truncateLabel(
  label: string,
  maxWidth: number,
  fontSize: number = FONT_SIZE,
): TruncatedLabel {
  if (measureText(label, fontSize) <= maxWidth) return { text: label, truncated: false };
  const chars = [...label];
  const ellipsisWidth = measureText('…', fontSize);
  let width = 0;
  const kept: string[] = [];
  for (const ch of chars) {
    const next = width + measureText(ch, fontSize);
    if (next + ellipsisWidth > maxWidth) break;
    kept.push(ch);
    width = next;
  }
  if (kept.length === 0) return { text: '…', truncated: true };
  return { text: `${kept.join('')}…`, truncated: true };
}

function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

export function leafSize(label: string): Size {
  const w = clamp(measureText(label) + 34, MIN_LEAF_WIDTH, MAX_LEAF_WIDTH);
  return { w: Math.round(w), h: LEAF_HEIGHT };
}

export function collapsedContainerSize(label: string): Size {
  const w = clamp(
    measureText(label) + 74, // room for the kind chip and the child-count badge
    MIN_COLLAPSED_CONTAINER_WIDTH,
    MAX_COLLAPSED_CONTAINER_WIDTH,
  );
  return { w: Math.round(w), h: COLLAPSED_CONTAINER_HEIGHT };
}

/** The label width available inside a box, once padding is taken out. */
export function labelWidthFor(size: Size, isContainer: boolean): number {
  return Math.max(16, size.w - (isContainer ? 60 : 24));
}

export function boxOf(centre: Point, size: Size): Box {
  return { x: centre.x - size.w / 2, y: centre.y - size.h / 2, w: size.w, h: size.h };
}

export function boxesOverlap(a: Box, b: Box, tolerance = 0): boolean {
  return (
    a.x < b.x + b.w - tolerance &&
    b.x < a.x + a.w - tolerance &&
    a.y < b.y + b.h - tolerance &&
    b.y < a.y + a.h - tolerance
  );
}
