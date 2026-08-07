// Sizes are derived, positions are owned. §7, made executable.
//
// Geometry is a pure function of (model, outline, expanded, PINNED positions).
// Auto-layout owns every unpinned node and re-packs it in canonical order on
// every change; a pinned node is never moved. That is what lets the user's layout
// and a deterministic default layout coexist.
//
// The one subtlety: an expanded container's box is the bounding box of its
// children, and a PINNED child can sit outside the box its unpinned siblings
// would have produced. The container therefore grows SYMMETRICALLY about its own
// centre until it contains every child — symmetrically, because the centre is the
// user's stored position and growing asymmetrically would move it. Growing a
// container changes the size its own parent packed against, so the pipeline is
// run twice; without pins the second pass is a bit-for-bit no-op, which is
// asserted by test.

import type { VisualSpecsNode, NodeId, Position } from '../contract/types.ts';
import type { GraphModel } from '../contract/model.ts';
import type { Outline, OutlineNodeId } from './outline.ts';
import { computeVisibility, type Visibility } from './visibility.ts';
import {
  CONTAINER_HEADER,
  CONTAINER_PADDING,
  HEADER_RESERVE,
  collapsedContainerSize,
  leafSize,
  measureText,
  type Box,
  type Point,
  type Size,
} from './geometry.ts';
import { GridPack } from './layout/gridPack.ts';
import type { AutoLayout, PackBand, PackConstraints } from './layout/port.ts';

/** One rank's lane, in world coordinates, as ONE OR MORE rectangles.
 *
 *  More than one when a box of another rank invades it: the band bites out exactly the
 *  intersection, so it never contains any part of a box it does not speak for. The
 *  vertical corridor is the particular case of a box invading it top to bottom.
 *  Ordered by `(y, x)`. */
export interface LevelBand {
  readonly rank: number;
  readonly rects: readonly Box[];
}

export interface Geometry {
  readonly visibility: Visibility;
  readonly size: ReadonlyMap<OutlineNodeId, Size>;
  /** Absolute world centre. */
  readonly position: ReadonlyMap<OutlineNodeId, Point>;
  readonly box: ReadonlyMap<OutlineNodeId, Box>;
  /** Depth in the visible tree — containers render behind their children (§8.1). */
  readonly z: ReadonlyMap<OutlineNodeId, number>;
  /** Level bands per expanded container. A container in a desynchronized state emits
   *  NO bands at all rather than bands that speak for boxes that are not there. */
  readonly bands: ReadonlyMap<OutlineNodeId, readonly LevelBand[]>;
}

/** Stratification constraints per container. `ROOT_PACK` keys the pack of the roots,
 *  which has no container of its own. */
export type LayoutConstraints = ReadonlyMap<OutlineNodeId, PackConstraints>;

/** The key under which the ROOTS' pack takes its constraints. Roots are packed at the
 *  world origin and belong to no container, so they need a key that no outline node can
 *  collide with — the empty string is not a valid `NodeId`. */
export const ROOT_PACK = '' as OutlineNodeId;

export const DEFAULT_AUTO_LAYOUT: AutoLayout = new GridPack();

/** No container fitted — the derivation default. The one production caller (derive())
 *  always passes `view.fitted` explicitly; this keeps existing call sites terse. */
const NO_FITTED: ReadonlySet<OutlineNodeId> = new Set<OutlineNodeId>();

const NO_CONSTRAINTS: LayoutConstraints = new Map<OutlineNodeId, PackConstraints>();

/**
 * How much of a lane has to survive the clip for the container to keep drawing bands.
 *
 * 0.6 — below that the stripe is more hole than band and says less than nothing. See
 * `resolveBands` for the measurements this comes off: ordinary dragging costs a lane
 * 3–12 % of its area, so this fires only on a state somebody built deliberately, and it
 * degrades the way we agreed — the container emits nothing AND the scene declares it,
 * because a stripe that vanishes without explanation is silence.
 */
const MIN_BAND_AREA_FRACTION = 0.6;

export function computeGeometry(
  model: GraphModel,
  outline: Outline,
  expanded: ReadonlySet<OutlineNodeId>,
  positions: ReadonlyMap<NodeId, Position>,
  fitted: ReadonlySet<OutlineNodeId> = NO_FITTED,
  layout: AutoLayout = DEFAULT_AUTO_LAYOUT,
  constraints: LayoutConstraints = NO_CONSTRAINTS,
): Geometry {
  const visibility = computeVisibility(outline, expanded);

  // Pass 1 uses natural sizes; pass 2 re-packs against the sizes that pinning
  // grew. Two passes, always — deterministic and bounded.
  let sizes = computeSizes(model, outline, visibility, layout, null, constraints);
  let placed = assignPositions(outline, visibility, sizes, positions, layout, constraints);
  sizes = growForPinnedChildren(model, outline, visibility, sizes, placed.placed, fitted);

  sizes = computeSizes(model, outline, visibility, layout, sizes, constraints);
  placed = assignPositions(outline, visibility, sizes, positions, layout, constraints);
  sizes = growForPinnedChildren(model, outline, visibility, sizes, placed.placed, fitted);

  const box = new Map<OutlineNodeId, Box>();
  const z = new Map<OutlineNodeId, number>();
  const depth = new Map<OutlineNodeId, number>();
  for (const n of visibility.visible) {
    const p = placed.placed.get(n);
    const s = sizes.get(n);
    if (p === undefined || s === undefined) continue;
    box.set(n, { x: p.x - s.w / 2, y: p.y - s.h / 2, w: s.w, h: s.h });
    const d = depth.get(n) ?? 0;
    z.set(n, d);
    if (visibility.childrenShown.has(n)) {
      for (const c of outline.childrenOf(n)) depth.set(c, d + 1);
    }
  }

  const bands = resolveBands(outline, visibility, placed.bands, box, constraints);

  return { visibility, size: sizes, position: placed.placed, box, z, bands };
}

/**
 * Turn the pack's lanes into drawable rectangles — the last step, because it needs the
 * FINAL boxes: `growForPinnedChildren` runs after the final `assignPositions`, so the
 * container's width is only known here.
 *
 * Two things happen, and they are different:
 *
 *  - **Correspondence.** A band asserts something about the boxes of its rank. If any
 *    band holds none of them, the geometry is desynchronized — which is what a fit under
 *    one basis followed by a toggle to the other produces: every child stays pinned where
 *    the fit left it while the pack computes lanes for the other basis. The container
 *    then emits NO bands and the scene declares it. This is checked BEFORE clipping,
 *    because the failure is not that a lane overflows: it is that it speaks for nobody.
 *    Note it cannot fire without pins — without them every band holds its own boxes by
 *    construction.
 *  - **Exact clipping.** A band bites out exactly its intersection with any box of
 *    another rank, so it never contains a part of a box it does not speak for.
 */
function resolveBands(
  outline: Outline,
  visibility: Visibility,
  packBands: ReadonlyMap<OutlineNodeId, readonly PackBand[]>,
  box: ReadonlyMap<OutlineNodeId, Box>,
  constraints: LayoutConstraints,
): Map<OutlineNodeId, readonly LevelBand[]> {
  const out = new Map<OutlineNodeId, readonly LevelBand[]>();

  for (const [container, lanes] of packBands) {
    if (lanes.length === 0) continue;
    const own = box.get(container);
    const rank = constraints.get(container)?.rank;
    if (own === undefined || rank === undefined) continue;

    // The band spans the width of the FINAL content, not of the pack: the container may
    // have grown around a pinned child after the pack ran. The X axis carries no rank,
    // so stretching it asserts nothing extra — unlike Y, where the height is the rank.
    const left = own.x + CONTAINER_PADDING;
    const width = Math.max(0, own.w - CONTAINER_PADDING * 2);

    const children = outline.childrenOf(container);
    const boxes: Array<{ box: Box; rank: number | undefined }> = [];
    for (const c of children) {
      const b = box.get(c);
      if (b !== undefined) boxes.push({ box: b, rank: rank.get(c) });
    }

    const resolved: LevelBand[] = [];
    let desynchronized = false;

    for (const lane of lanes) {
      const laneBox: Box = { x: left, y: lane.y, w: width, h: lane.height };
      const mine = boxes.filter((b) => b.rank === lane.rank);
      // A box belongs to the band that holds its centre.
      const holds = mine.some((b) => centreInside(b.box, laneBox));
      if (!holds) {
        desynchronized = true;
        break;
      }
      const blockers = boxes.filter((b) => b.rank !== lane.rank).map((b) => b.box);
      const rects = subtractBoxes(laneBox, blockers);

      // The second trigger of the same declared degradation: a lane so eaten away that it
      // is more hole than band. Defined OVER THE RESULT — the area that survives — rather
      // than as a threshold picked on the input; a number you read off the outcome beats
      // one you argue for beforehand.
      //
      // Measured on `dir:src-tauri/src` (23 children, corpus `fe3ae85`), dragging boxes of
      // one rank into another's lane: 1 box loses 3.1 % of the lane, 2 lose 6.2 %, 4 lose
      // 9.1 %, 6 lose 12.5 % — and at 12.5 % the zebra still reads as a band. The
      // threshold is set where a lane stops being a lane, which takes a state the user
      // built on purpose, not an ordinary drag.
      const survivingArea = rects.reduce((a, r) => a + r.w * r.h, 0);
      const laneArea = laneBox.w * laneBox.h;
      if (laneArea > 0 && survivingArea / laneArea < MIN_BAND_AREA_FRACTION) {
        desynchronized = true;
        break;
      }
      resolved.push({ rank: lane.rank, rects });
    }

    if (desynchronized) continue;
    out.set(container, resolved);
  }

  return out;
}

function centreInside(inner: Box, outer: Box): boolean {
  const cx = inner.x + inner.w / 2;
  const cy = inner.y + inner.h / 2;
  return cx >= outer.x && cx <= outer.x + outer.w && cy >= outer.y && cy <= outer.y + outer.h;
}

/**
 * `band` minus every blocker, as a canonical set of rectangles ordered by `(y, x)`.
 *
 * A horizontal sweep: the blockers' Y edges (clamped to the band) cut it into strips;
 * within each strip the occupied X intervals are sorted field by field and merged, and
 * one rect is emitted per gap. Canonical — recomputing in another order cannot produce a
 * different partition, which matters because otherwise `rects` would depend on the
 * iteration order over the invading boxes, which comes from canonical child order, which
 * includes the label.
 *
 * With no blockers this is one strip and one rect: the common case does not pay for the
 * generality.
 */
function subtractBoxes(band: Box, blockers: readonly Box[]): Box[] {
  const bottom = band.y + band.h;
  const right = band.x + band.w;
  const overlapping = blockers.filter(
    (b) => b.x < right && b.x + b.w > band.x && b.y < bottom && b.y + b.h > band.y,
  );
  if (overlapping.length === 0) return [{ ...band }];

  const cuts = new Set<number>([band.y, bottom]);
  for (const b of overlapping) {
    if (b.y > band.y && b.y < bottom) cuts.add(b.y);
    const bBottom = b.y + b.h;
    if (bBottom > band.y && bBottom < bottom) cuts.add(bBottom);
  }
  const edges = [...cuts].sort((a, b) => a - b);

  const out: Box[] = [];
  for (let i = 0; i + 1 < edges.length; i += 1) {
    const y0 = edges[i] as number;
    const y1 = edges[i + 1] as number;
    if (y1 <= y0) continue;

    const spans: Array<[number, number]> = [];
    for (const b of overlapping) {
      if (b.y >= y1 || b.y + b.h <= y0) continue;
      const x0 = Math.max(b.x, band.x);
      const x1 = Math.min(b.x + b.w, right);
      if (x1 > x0) spans.push([x0, x1]);
    }
    spans.sort((p, q) => p[0] - q[0] || p[1] - q[1]);

    let cursor = band.x;
    for (const [x0, x1] of spans) {
      if (x0 > cursor) out.push({ x: cursor, y: y0, w: x0 - cursor, h: y1 - y0 });
      cursor = Math.max(cursor, x1);
    }
    if (cursor < right) out.push({ x: cursor, y: y0, w: right - cursor, h: y1 - y0 });
  }
  return out;
}

/** Post-order sizes. `grown` carries the previous pass's grown sizes for leaves of
 *  this walk (collapsed nodes never grow, so only containers differ). */
function computeSizes(
  model: GraphModel,
  outline: Outline,
  visibility: Visibility,
  layout: AutoLayout,
  grown: ReadonlyMap<OutlineNodeId, Size> | null,
  constraints: LayoutConstraints,
): Map<OutlineNodeId, Size> {
  const sizes = new Map<OutlineNodeId, Size>();
  // `visible` is pre-order, so reversing it gives a valid post-order.
  for (let i = visibility.visible.length - 1; i >= 0; i -= 1) {
    const n = visibility.visible[i] as OutlineNodeId;
    const node = model.nodeById.get(outline.entityOf(n));
    const label = node?.label ?? n;

    if (!visibility.childrenShown.has(n)) {
      const hasChildren = outline.childrenOf(n).length > 0;
      sizes.set(n, hasChildren ? collapsedContainerSize(label) : leafSize(label));
      continue;
    }

    const children = outline.childrenOf(n);
    const items = children.map((c) => ({
      id: c,
      size: grown?.get(c) ?? sizes.get(c) ?? leafSize(labelOf(model, outline, c)),
    }));
    const packed = layout.pack(items, constraints.get(n));
    const headerWidth = measureText(label) + HEADER_RESERVE;
    sizes.set(n, {
      w: Math.round(Math.max(packed.width + CONTAINER_PADDING * 2, headerWidth)),
      h: Math.round(packed.height + CONTAINER_HEADER + CONTAINER_PADDING * 2),
    });
  }
  return sizes;
}

function labelOf(model: GraphModel, outline: Outline, n: OutlineNodeId): string {
  const node: VisualSpecsNode | undefined = model.nodeById.get(outline.entityOf(n));
  return node?.label ?? n;
}

/** Pre-order positions. Pinned nodes keep their stored centre; everything else is
 *  packed in canonical order. */
function assignPositions(
  outline: Outline,
  visibility: Visibility,
  sizes: ReadonlyMap<OutlineNodeId, Size>,
  positions: ReadonlyMap<NodeId, Position>,
  layout: AutoLayout,
  constraints: LayoutConstraints,
): { placed: Map<OutlineNodeId, Point>; bands: Map<OutlineNodeId, readonly PackBand[]> } {
  const placed = new Map<OutlineNodeId, Point>();
  // The lanes are carried out of the SAME pack that placed the children. Packing a
  // second time to read them back would be a fifth pack per container and would break
  // the `4C + 2` budget — which is the one criterion that catches a rank computed inside
  // the pack, correct-looking and 4× more expensive.
  const bands = new Map<OutlineNodeId, readonly PackBand[]>();

  const pinnedCentre = (n: OutlineNodeId): Point | null => {
    const stored = positions.get(outline.entityOf(n));
    if (stored === undefined || stored.pinned !== true) return null;
    return { x: stored.x, y: stored.y };
  };

  // Roots: packed at the world origin, unless the user pinned them.
  const roots = outline.roots();
  const rootItems = roots.map((r) => ({ id: r, size: sizes.get(r) ?? { w: 0, h: 0 } }));
  const rootPack = layout.pack(rootItems, constraints.get(ROOT_PACK));
  for (const r of roots) {
    const pin = pinnedCentre(r);
    if (pin !== null) {
      placed.set(r, pin);
      continue;
    }
    const offset = rootPack.offsets.get(r) ?? { x: 0, y: 0 };
    const s = sizes.get(r) ?? { w: 0, h: 0 };
    placed.set(r, { x: offset.x + s.w / 2, y: offset.y + s.h / 2 });
  }

  for (const n of visibility.visible) {
    if (!visibility.childrenShown.has(n)) continue;
    const centre = placed.get(n);
    const size = sizes.get(n);
    if (centre === undefined || size === undefined) continue;

    const children = outline.childrenOf(n);
    const items = children.map((c) => ({ id: c, size: sizes.get(c) ?? { w: 0, h: 0 } }));
    const packed = layout.pack(items, constraints.get(n));

    const contentX = centre.x - size.w / 2 + CONTAINER_PADDING;
    const contentY = centre.y - size.h / 2 + CONTAINER_HEADER + CONTAINER_PADDING;

    if (packed.bands !== undefined && packed.bands.length > 0) {
      bands.set(
        n,
        packed.bands.map((b) => ({ rank: b.rank, y: contentY + b.y, height: b.height })),
      );
    }

    for (const c of children) {
      const pin = pinnedCentre(c);
      if (pin !== null) {
        placed.set(c, pin);
        continue;
      }
      const offset = packed.offsets.get(c) ?? { x: 0, y: 0 };
      const cs = sizes.get(c) ?? { w: 0, h: 0 };
      placed.set(c, { x: contentX + offset.x + cs.w / 2, y: contentY + offset.y + cs.h / 2 });
    }
  }

  return { placed, bands };
}

/** Grow every expanded container symmetrically about its own centre until it
 *  contains all of its children. Without pins this is exactly the identity. */
function growForPinnedChildren(
  model: GraphModel,
  outline: Outline,
  visibility: Visibility,
  sizes: ReadonlyMap<OutlineNodeId, Size>,
  placed: ReadonlyMap<OutlineNodeId, Point>,
  fitted: ReadonlySet<OutlineNodeId>,
): Map<OutlineNodeId, Size> {
  const out = new Map<OutlineNodeId, Size>(sizes);

  for (let i = visibility.visible.length - 1; i >= 0; i -= 1) {
    const n = visibility.visible[i] as OutlineNodeId;
    if (!visibility.childrenShown.has(n)) continue;
    const centre = placed.get(n);
    const natural = out.get(n);
    if (centre === undefined || natural === undefined) continue;

    // A fitted container (Issue #13, ADR-0005) hugs its children: its floor is the
    // LEGIBILITY minimum — the header must still show `▾ label` + the fit glyph — not
    // the grid-pack natural. The grow loop below still contains every pinned child, so
    // the floor is only the starting half-extent and a child pinned outside it is
    // never clipped. A non-fitted container keeps the natural floor unchanged.
    let halfW: number;
    let halfH: number;
    if (fitted.has(n)) {
      halfW = (measureText(labelOf(model, outline, n)) + HEADER_RESERVE) / 2;
      halfH = (CONTAINER_HEADER + CONTAINER_PADDING * 2) / 2;
    } else {
      halfW = natural.w / 2;
      halfH = natural.h / 2;
    }

    for (const c of outline.childrenOf(n)) {
      const cp = placed.get(c);
      const cs = out.get(c);
      if (cp === undefined || cs === undefined) continue;
      const needW = Math.abs(cp.x - centre.x) + cs.w / 2 + CONTAINER_PADDING;
      const needTop = centre.y - (cp.y - cs.h / 2) + CONTAINER_PADDING + CONTAINER_HEADER;
      const needBottom = cp.y + cs.h / 2 - centre.y + CONTAINER_PADDING;
      halfW = Math.max(halfW, needW);
      halfH = Math.max(halfH, needTop, needBottom);
    }

    out.set(n, { w: Math.round(halfW * 2), h: Math.round(halfH * 2) });
  }

  return out;
}
