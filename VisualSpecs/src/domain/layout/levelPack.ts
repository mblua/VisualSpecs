// A deterministic LAYERED pack: one band per rank, high rank at the top (Issue #44).
//
// Why high rank at the top: with that orientation every dependency arrow points DOWN,
// so a violation is an arrow that points UP. It reads without colour, without a legend
// and without being able to tell ten shades apart. Under the `observed` basis no arrow
// points up at all — the invariant guarantees it — and there the signal is the
// horizontal edges inside one band, which is why a mutual-dependency group is packed
// contiguously.
//
// It COMPOSES over GridPack rather than replacing it: with no constraints it delegates,
// bit for bit, and inside a band it wraps rows the same way. A container with no sibling
// edges is the common case (32 of 69 in the corpus have none at all) and it must keep
// packing exactly as it does today.

import { CHILD_GAP, MAX_ROW_WIDTH, MIN_BAND_HEIGHT } from '../geometry.ts';
import { GridPack } from './gridPack.ts';
import type { AutoLayout, PackBand, PackConstraints, PackItem, PackResult } from './port.ts';

export class LevelPack implements AutoLayout {
  readonly id = 'level-pack';
  private readonly gap: number;
  private readonly maxRowWidth: number;
  private readonly grid: GridPack;

  constructor(gap: number = CHILD_GAP, maxRowWidth: number = MAX_ROW_WIDTH) {
    this.gap = gap;
    this.maxRowWidth = maxRowWidth;
    this.grid = new GridPack(gap, maxRowWidth);
  }

  pack(items: readonly PackItem[], constraints?: PackConstraints): PackResult {
    if (constraints === undefined || !coversEveryItem(items, constraints)) {
      // FAIL SAFE, and deliberately all-or-nothing: a container whose rank is missing
      // or inconsistent packs as a grid rather than as a staircase with a hole in it.
      return this.grid.pack(items);
    }
    if (items.length === 0) return this.grid.pack(items);

    const byRank = groupByRank(items, constraints);

    const offsets = new Map<string, { x: number; y: number }>();
    const bands: PackBand[] = [];
    const half = this.gap / 2;
    let width = 0;
    let contentBottom = 0;
    // Top edge of the NEXT band. Bands are contiguous, so one band's bottom is the
    // next one's top; the first starts at `-half`, taking its air from the container's
    // own padding (22 px) exactly as the interior ones take theirs from the gap.
    let bandTop = -half;

    // High rank first: this walks the ranks BY NUMBER and never iterates a constraint
    // map, so insertion order cannot reach the result. A rank with no items is skipped
    // and emits no band.
    for (let rank = constraints.maxRank; rank >= 0; rank -= 1) {
      const inBand = byRank.get(rank);
      if (inBand === undefined || inBand.length === 0) continue;

      const ordered = orderWithGroupsContiguous(inBand, constraints.group);
      const rows = wrapIntoRows(ordered, this.gap, this.maxRowWidth);
      const contentHeight = rows.reduce((h, r) => h + r.height, 0) + this.gap * (rows.length - 1);

      // The band is `content + padding`, floored. The padding is the half-gap on each
      // side — space that already existed between rows and belonged to nobody, so it
      // costs the container zero extra pixels and leaves the bands contiguous.
      const natural = contentHeight + this.gap;
      // `height` is rebuilt from the ROUNDED slack rather than from `MIN_BAND_HEIGHT`,
      // so the band's edges stay integral and the contiguity arithmetic closes exactly.
      // On the current constants the floor never binds and `slack` is 0.
      const slack = Math.max(0, Math.round((MIN_BAND_HEIGHT - natural) / 2));
      const height = natural + slack * 2;

      let rowY = bandTop + half + slack;
      for (const row of rows) {
        let cursorX = 0;
        for (const item of row.items) {
          offsets.set(item.id, { x: cursorX, y: rowY });
          cursorX += item.size.w + this.gap;
        }
        width = Math.max(width, cursorX - this.gap);
        rowY += row.height + this.gap;
      }
      contentBottom = rowY - this.gap;

      bands.push({ rank, y: bandTop, height });
      bandTop += height;
    }

    return {
      offsets,
      width: Math.max(0, width),
      height: Math.max(0, contentBottom),
      bands,
    };
  }
}

/** Every item must carry an integer rank inside `[0, maxRank]`. Reading is by key. */
function coversEveryItem(items: readonly PackItem[], constraints: PackConstraints): boolean {
  if (!Number.isInteger(constraints.maxRank) || constraints.maxRank < 0) return false;
  for (const item of items) {
    const rank = constraints.rank.get(item.id);
    if (rank === undefined) return false;
    if (!Number.isInteger(rank) || rank < 0 || rank > constraints.maxRank) return false;
  }
  return true;
}

/** Canonical child order is preserved WITHIN each rank: the caller's order decides. */
function groupByRank(
  items: readonly PackItem[],
  constraints: PackConstraints,
): Map<number, PackItem[]> {
  const byRank = new Map<number, PackItem[]>();
  for (const item of items) {
    const rank = constraints.rank.get(item.id) as number;
    const list = byRank.get(rank);
    if (list === undefined) byRank.set(rank, [item]);
    else list.push(item);
  }
  return byRank;
}

/**
 * Members of one mutual-dependency group are emitted contiguously, at the position of
 * the group's FIRST member in canonical order. Everything else keeps its place.
 *
 * O(n): one pass builds the slots, `flat()` emits them. The group map is only read by
 * key — the slot order comes from the item order, never from the map's iteration.
 */
function orderWithGroupsContiguous(
  items: readonly PackItem[],
  group: ReadonlyMap<string, string> | undefined,
): readonly PackItem[] {
  if (group === undefined) return items;
  const slots: PackItem[][] = [];
  const slotOfGroup = new Map<string, PackItem[]>();
  let grouped = false;
  for (const item of items) {
    const id = group.get(item.id);
    if (id === undefined) {
      slots.push([item]);
      continue;
    }
    grouped = true;
    const slot = slotOfGroup.get(id);
    if (slot === undefined) {
      const created = [item];
      slotOfGroup.set(id, created);
      slots.push(created);
    } else {
      slot.push(item);
    }
  }
  return grouped ? slots.flat() : items;
}

interface Row {
  items: PackItem[];
  height: number;
}

/** Rows wrap on width alone — a band fills its width, it does not aim to be square.
 *  That is the one place this differs from `GridPack`, whose `targetColumns` exists to
 *  square off a block that has no rank to honour. */
function wrapIntoRows(items: readonly PackItem[], gap: number, maxRowWidth: number): Row[] {
  const rows: Row[] = [];
  let current: PackItem[] = [];
  let currentWidth = 0;
  let currentHeight = 0;

  for (const item of items) {
    if (current.length > 0 && currentWidth + item.size.w > maxRowWidth) {
      rows.push({ items: current, height: currentHeight });
      current = [];
      currentWidth = 0;
      currentHeight = 0;
    }
    current.push(item);
    currentWidth += item.size.w + gap;
    currentHeight = Math.max(currentHeight, item.size.h);
  }
  if (current.length > 0) rows.push({ items: current, height: currentHeight });
  return rows;
}
