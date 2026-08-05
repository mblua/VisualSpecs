// AutoLayout is a port (§7). v1 implements it with `gridPack`; `elkjs` behind
// this interface is the deferred upgrade, and swapping it touches nothing else.
//
// ── Why `pack()` is handed a RANK and never the edges (Issue #44) ─────────────
// A layered pack needs to know what sits under what. It does NOT get the relations:
// `tests/architecture/boundaries.test.ts` fixes `ALLOWED.domain = ['contract','domain']`,
// so this file cannot import `projection/` and a `pack(items, edges)` taking
// `VisibleEdge[]` does not compile. Redeclaring the type here would be worse: the
// layout would then have to decide what a cycle is and which edge to cut, which is
// Tarjan and a feedback arc set reimplemented in a second place. The projection owns
// the ORDER; this port draws the order it was given.
//
// Everything below is numbers and strings for exactly that reason.

import type { Size } from '../geometry.ts';

export interface PackItem {
  id: string;
  size: Size;
}

/**
 * Optional stratification constraints. Absent → the pack is free to arrange as it
 * likes, which is what `GridPack` has always done.
 *
 * READ BY KEY ONLY. An implementation may not iterate these maps: `Map` iterates in
 * insertion order, so a pack that walked them would return different geometry for the
 * same data depending on how the caller happened to build them. The determinism test
 * permutes the insertion order and requires a bit-identical `PackResult`.
 */
export interface PackConstraints {
  /** Rank of each item. Contiguous integers in `[0, maxRank]`. */
  readonly rank: ReadonlyMap<string, number>;
  /** The highest rank present. Explicit so it is not derived in two places. */
  readonly maxRank: number;
  /**
   * Mutual-dependency group, only for items in a group of more than one member.
   * Members of one group are packed CONTIGUOUSLY inside their band — a group's edges
   * run horizontally within the band, and separated members turn them into lines
   * crossing the boxes in between.
   *
   * The group is the OBSERVED grouping and does not know about `RankBasis`: the edges
   * are drawn either way and have to be kept from crossing.
   */
  readonly group?: ReadonlyMap<string, string>;
}

/** One rank's horizontal lane, relative to the content origin — the same frame as
 *  `offsets`. Bands are CONTIGUOUS: each one extends to the midpoint of the gap that
 *  separates it from its neighbour, which is why `y` can be negative and `y + height`
 *  can exceed `PackResult.height` by the same half-gap. That overhang is absorbed by
 *  the container's own padding, which is wider than it (§ADR band padding, Issue #44). */
export interface PackBand {
  readonly rank: number;
  readonly y: number;
  readonly height: number;
}

export interface PackResult {
  /** Top-left offset of each item, relative to the content origin. */
  offsets: ReadonlyMap<string, { x: number; y: number }>;
  /** Extent of the packed content. */
  width: number;
  height: number;
  /** Present only when the pack stratified. Ordered by `y` ascending, which — because
   *  high rank sits at the top — is descending rank. */
  bands?: readonly PackBand[];
}

export interface AutoLayout {
  readonly id: string;
  /** Deterministic: the same items in the same order, under the same constraints,
   *  always pack the same way. */
  pack(items: readonly PackItem[], constraints?: PackConstraints): PackResult;
}
