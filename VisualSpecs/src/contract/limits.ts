// Denial-of-service caps (§11). Checked BEFORE graph construction, so a hostile
// document is refused rather than hanging the tab.
//
// The numbers are sized for real repositories with headroom, not for elegance:
// AgentsCommander is ~640 files. A cap that a real dataset trips is a bug.

export interface Limits {
  /** Raw JSON text length, in UTF-16 code units. */
  maxBytes: number;
  maxNodes: number;
  maxEdges: number;
  /** Any single string value anywhere in the document. */
  maxStringLength: number;
  /** Nesting depth of the parsed JSON tree. */
  maxDepth: number;
  /** Evidence entries per node or edge. */
  maxEvidencePerItem: number;
  /** Total object/array nodes in the JSON tree — the real work bound. */
  maxJsonNodes: number;
  /** |x| and |y| bound in world coordinates. */
  maxCoordinate: number;
  minZoom: number;
  maxZoom: number;
  /**
   * The out-of-focus transparency band (Issue #17), as percents. These live HERE and
   * not as module constants in `contract/view.ts` for one reason: an out-of-band value
   * is CLAMPED, and the band is injectable, so re-tuning it in a future release can
   * never make a document written by the previous build unopenable. Module constants
   * plus a hard validation error would have done exactly that, on a field that
   * controls nothing but an alpha, with no minor bump available to signal it.
   */
  minFocusTransparency: number;
  /**
   * Must be < 100. At 100 the derived opacity is 0, which trips the renderer port's
   * `0 < opacity <= 1` assertion — a cosmetic Limits value must not be able to fail a
   * port invariant.
   */
  maxFocusTransparency: number;
  /**
   * Cap on `|view.focus.marks|`. Deliberately the same CONSTANT as `maxNodes`, and NOT
   * "as many marks as this document has nodes": marks legitimately outnumber a
   * document's nodes when they were authored against a larger graph, which is the
   * inert-mark case import preserves losslessly (§3.5). A per-document reading would
   * turn "preserved, inert" into "unopenable".
   */
  maxFocusMarks: number;
  /**
   * Cap on the length of a mark's key. `maxStringLength` checks string VALUES, never
   * object KEYS, so without this a 200 000-character id parses cleanly and is then
   * rendered as sidebar row text for an inert mark (§8.4.2). Not an injection risk —
   * `el()` reaches the DOM only through `createTextNode` — but a layout and reflow
   * hazard on a new surface.
   */
  maxFocusMarkKeyLength: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxBytes: 64 * 1024 * 1024,
  maxNodes: 200_000,
  maxEdges: 500_000,
  maxStringLength: 100_000,
  maxDepth: 64,
  maxEvidencePerItem: 1_000,
  maxJsonNodes: 5_000_000,
  maxCoordinate: 1_000_000,
  minZoom: 0.02,
  maxZoom: 50,
  minFocusTransparency: 10,
  // 78 is alpha 0.22 — EXACTLY the strength at which this app already dims a node that
  // does not match a search. It introduces no new constant, and it is the ceiling
  // because v1's 95 (alpha 0.05) rendered every element at 1.02–1.09:1 against the
  // background: perceptually gone while remaining fully hit-testable, since hit-testing
  // is geometric and never consulted alpha. A clickable ghost is worse than either
  // visible or hidden.
  maxFocusTransparency: 78,
  maxFocusMarks: 200_000,
  maxFocusMarkKeyLength: 2_048,
};

/** Keys that are never legal, anywhere, at any depth (§11: prototype pollution).
 *  This is the one place forward-compatibility yields to safety. */
export const DANGEROUS_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];
