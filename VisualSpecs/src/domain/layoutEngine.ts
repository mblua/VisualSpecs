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
import type { AutoLayout } from './layout/port.ts';

export interface Geometry {
  readonly visibility: Visibility;
  readonly size: ReadonlyMap<OutlineNodeId, Size>;
  /** Absolute world centre. */
  readonly position: ReadonlyMap<OutlineNodeId, Point>;
  readonly box: ReadonlyMap<OutlineNodeId, Box>;
  /** Depth in the visible tree — containers render behind their children (§8.1). */
  readonly z: ReadonlyMap<OutlineNodeId, number>;
}

export const DEFAULT_AUTO_LAYOUT: AutoLayout = new GridPack();

/** No container fitted — the derivation default. The one production caller (derive())
 *  always passes `view.fitted` explicitly; this keeps existing call sites terse. */
const NO_FITTED: ReadonlySet<OutlineNodeId> = new Set<OutlineNodeId>();

export function computeGeometry(
  model: GraphModel,
  outline: Outline,
  expanded: ReadonlySet<OutlineNodeId>,
  positions: ReadonlyMap<NodeId, Position>,
  fitted: ReadonlySet<OutlineNodeId> = NO_FITTED,
  layout: AutoLayout = DEFAULT_AUTO_LAYOUT,
): Geometry {
  const visibility = computeVisibility(outline, expanded);

  // Pass 1 uses natural sizes; pass 2 re-packs against the sizes that pinning
  // grew. Two passes, always — deterministic and bounded.
  let sizes = computeSizes(model, outline, visibility, layout, null);
  let placed = assignPositions(outline, visibility, sizes, positions, layout);
  sizes = growForPinnedChildren(model, outline, visibility, sizes, placed, fitted);

  sizes = computeSizes(model, outline, visibility, layout, sizes);
  placed = assignPositions(outline, visibility, sizes, positions, layout);
  sizes = growForPinnedChildren(model, outline, visibility, sizes, placed, fitted);

  const box = new Map<OutlineNodeId, Box>();
  const z = new Map<OutlineNodeId, number>();
  const depth = new Map<OutlineNodeId, number>();
  for (const n of visibility.visible) {
    const p = placed.get(n);
    const s = sizes.get(n);
    if (p === undefined || s === undefined) continue;
    box.set(n, { x: p.x - s.w / 2, y: p.y - s.h / 2, w: s.w, h: s.h });
    const d = depth.get(n) ?? 0;
    z.set(n, d);
    if (visibility.childrenShown.has(n)) {
      for (const c of outline.childrenOf(n)) depth.set(c, d + 1);
    }
  }

  return { visibility, size: sizes, position: placed, box, z };
}

/** Post-order sizes. `grown` carries the previous pass's grown sizes for leaves of
 *  this walk (collapsed nodes never grow, so only containers differ). */
function computeSizes(
  model: GraphModel,
  outline: Outline,
  visibility: Visibility,
  layout: AutoLayout,
  grown: ReadonlyMap<OutlineNodeId, Size> | null,
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
    const packed = layout.pack(items);
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
): Map<OutlineNodeId, Point> {
  const placed = new Map<OutlineNodeId, Point>();

  const pinnedCentre = (n: OutlineNodeId): Point | null => {
    const stored = positions.get(outline.entityOf(n));
    if (stored === undefined || stored.pinned !== true) return null;
    return { x: stored.x, y: stored.y };
  };

  // Roots: packed at the world origin, unless the user pinned them.
  const roots = outline.roots();
  const rootItems = roots.map((r) => ({ id: r, size: sizes.get(r) ?? { w: 0, h: 0 } }));
  const rootPack = layout.pack(rootItems);
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
    const packed = layout.pack(items);

    const contentX = centre.x - size.w / 2 + CONTAINER_PADDING;
    const contentY = centre.y - size.h / 2 + CONTAINER_HEADER + CONTAINER_PADDING;

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

  return placed;
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
