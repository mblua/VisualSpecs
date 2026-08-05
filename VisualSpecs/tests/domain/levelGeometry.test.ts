// The geometry side of Issue #44, and the cost criterion that guards the trap.
//
// The trap, named before any code existed: computing the rank INSIDE `pack()`. It gives
// correct results and costs 4× more, and no correctness test detects it. Two things
// catch it — the pack count staying at `4C + 2`, and the LevelPack/GridPack ratio staying
// near ×1.2 instead of near ×3. The ratio is asserted rather than a wall-clock number, so
// the test measures the property and not the machine it runs on.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { importDoc } from '../../src/contract/load.ts';
import { OwnershipOutline, type OutlineNodeId } from '../../src/domain/outline.ts';
import { allOutlineNodes } from '../../src/domain/commands.ts';
import { CONTAINER_PADDING, type Box } from '../../src/domain/geometry.ts';
import { GridPack } from '../../src/domain/layout/gridPack.ts';
import { LevelPack } from '../../src/domain/layout/levelPack.ts';
import type { AutoLayout, PackConstraints, PackItem, PackResult } from '../../src/domain/layout/port.ts';
import {
  computeGeometry,
  type Geometry,
  type LayoutConstraints,
} from '../../src/domain/layoutEngine.ts';
import type { NodeId, Position } from '../../src/contract/types.ts';

const TEXT = readFileSync(
  fileURLToPath(new URL('../../data/agentscommander.json', import.meta.url)),
  'utf8',
);
const loaded = importDoc(TEXT);
const model = loaded.model;
const outline = new OwnershipOutline(model);

/** Everything that has children — the `ExpandAll` state. */
function everythingExpanded(): Set<OutlineNodeId> {
  const expanded = new Set<OutlineNodeId>();
  for (const n of allOutlineNodes(outline)) {
    if (outline.childrenOf(n).length > 0) expanded.add(n);
  }
  return expanded;
}

/**
 * A stand-in for `projection/levels.ts`, which `vs-spec-core-lead` owns and is writing in
 * parallel. The port takes a RANK and not the edges precisely so this side does not have
 * to wait: any deterministic assignment exercises the same geometry.
 */
function syntheticConstraints(expanded: ReadonlySet<OutlineNodeId>, bands = 3): LayoutConstraints {
  const out = new Map<OutlineNodeId, PackConstraints>();
  for (const container of expanded) {
    const children = outline.childrenOf(container);
    if (children.length === 0) continue;
    const rank = new Map<string, number>();
    children.forEach((c, i) => rank.set(c, i % bands));
    out.set(container, { rank, maxRank: Math.min(bands, children.length) - 1 });
  }
  return out;
}

/** Counts how many times the layout was asked to pack. */
function counting(inner: AutoLayout): { layout: AutoLayout; calls: () => number } {
  let calls = 0;
  return {
    layout: {
      id: inner.id,
      pack(items: readonly PackItem[], constraints?: PackConstraints): PackResult {
        calls += 1;
        return inner.pack(items, constraints);
      },
    },
    calls: () => calls,
  };
}

const NO_POSITIONS: ReadonlyMap<NodeId, Position> = new Map<NodeId, Position>();

function geometryOf(
  expanded: ReadonlySet<OutlineNodeId>,
  layout: AutoLayout,
  constraints: LayoutConstraints,
  positions: ReadonlyMap<NodeId, Position> = NO_POSITIONS,
  fitted: ReadonlySet<OutlineNodeId> = new Set<OutlineNodeId>(),
): Geometry {
  return computeGeometry(model, outline, expanded, positions, fitted, layout, constraints);
}

function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

describe('cost — the criterion that catches a rank computed inside the pack', () => {
  const expanded = everythingExpanded();

  it('packs exactly 4C + 2 times, with C the expanded containers', () => {
    // computeSizes packs once per container; assignPositions packs once per container
    // plus once for the roots; and the pipeline runs twice. One extra pack means
    // something is recomputed.
    const containers = [...expanded].filter((n) => outline.childrenOf(n).length > 0).length;
    const constraints = syntheticConstraints(expanded);

    const counted = counting(new LevelPack());
    geometryOf(expanded, counted.layout, constraints);
    expect(counted.calls()).toBe(4 * containers + 2);

    // And the same budget without constraints, so the stratified path adds no packs.
    const plain = counting(new GridPack());
    geometryOf(expanded, plain.layout, new Map());
    expect(plain.calls()).toBe(4 * containers + 2);
  });

  it('LevelPack with the rank precomputed stays near GridPack, not near 3× it', () => {
    const constraints = syntheticConstraints(expanded);
    const grid = new GridPack();
    const level = new LevelPack();

    const gridSamples: number[] = [];
    const levelSamples: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      let start = performance.now();
      geometryOf(expanded, grid, new Map());
      gridSamples.push(performance.now() - start);

      start = performance.now();
      geometryOf(expanded, level, constraints);
      levelSamples.push(performance.now() - start);
    }

    const ratio = median(levelSamples) / median(gridSamples);
    // The published baseline is 1.62 ms → 1.90 ms, a ×1.17. A rank computed inside the
    // pack lands near ×3. The bound is loose because the absolute numbers belong to the
    // machine; the SHAPE of the delta is what this asserts.
    expect(ratio).toBeLessThan(2);
  });
});

describe('bands describe the boxes they hold, or the container emits none', () => {
  const container = 'dir:src-tauri/src' as OutlineNodeId;

  /** Expand exactly one container, so the assertions are about it and not about a walk. */
  function expandedTo(id: OutlineNodeId): Set<OutlineNodeId> {
    const expanded = new Set<OutlineNodeId>(outline.roots());
    let current: OutlineNodeId | null = id;
    const parents = new Map<OutlineNodeId, OutlineNodeId>();
    const stack = [...outline.roots()];
    while (stack.length > 0) {
      const n = stack.pop() as OutlineNodeId;
      for (const c of outline.childrenOf(n)) {
        parents.set(c, n);
        stack.push(c);
      }
    }
    while (current !== null && current !== undefined) {
      expanded.add(current);
      current = parents.get(current) ?? null;
    }
    return expanded;
  }

  const expanded = expandedTo(container);
  const constraints = syntheticConstraints(expanded);
  const level = new LevelPack();

  it('the corpus actually has this container expanded with bands', () => {
    const geometry = geometryOf(expanded, level, constraints);
    const bands = geometry.bands.get(container);
    expect(bands).toBeDefined();
    expect((bands ?? []).length).toBeGreaterThan(1);
  });

  it('every band rect is contained in its container box (hard invariant)', () => {
    const geometry = geometryOf(expanded, level, constraints);
    const escapes: string[] = [];
    for (const [id, bands] of geometry.bands) {
      const own = geometry.box.get(id) as Box;
      for (const band of bands) {
        for (const rect of band.rects) {
          const inside =
            rect.x >= own.x &&
            rect.y >= own.y &&
            rect.x + rect.w <= own.x + own.w &&
            rect.y + rect.h <= own.y + own.h;
          if (!inside) escapes.push(`${id} L${band.rank}`);
        }
      }
    }
    expect(escapes).toEqual([]);
  });

  it('with no pins each band is one rect and they are contiguous', () => {
    const geometry = geometryOf(expanded, level, constraints);
    const bands = geometry.bands.get(container) ?? [];
    for (const band of bands) expect(band.rects.length).toBe(1);
    for (let i = 0; i + 1 < bands.length; i += 1) {
      const a = (bands[i] as { rects: readonly Box[] }).rects[0] as Box;
      const b = (bands[i + 1] as { rects: readonly Box[] }).rects[0] as Box;
      expect(a.y + a.h).toBeCloseTo(b.y, 6);
    }
  });

  it('LVL-12b — a box dragged out of its lane is inside no band at all', () => {
    const clean = geometryOf(expanded, level, constraints);
    const bands = clean.bands.get(container) ?? [];
    expect(bands.length).toBeGreaterThan(1);

    // Take a child of the LAST band and drag it into the FIRST one.
    const lastRank = (bands[bands.length - 1] as { rank: number }).rank;
    const rank = (constraints.get(container) as PackConstraints).rank;
    const victim = outline.childrenOf(container).find((c) => rank.get(c) === lastRank) as OutlineNodeId;
    const target = (bands[0] as { rects: readonly Box[] }).rects[0] as Box;

    const positions = new Map<NodeId, Position>([
      [
        outline.entityOf(victim),
        { x: target.x + target.w / 2, y: target.y + target.h / 2, pinned: true },
      ],
    ]);

    const dragged = geometryOf(expanded, level, constraints, positions);
    const victimBox = dragged.box.get(victim) as Box;
    const after = dragged.bands.get(container);
    // The container may legitimately go silent (correspondence); if it still draws, no
    // rect of any band may hold any part of the dragged box.
    if (after !== undefined) {
      for (const band of after) {
        for (const rect of band.rects) {
          const overlaps =
            rect.x < victimBox.x + victimBox.w &&
            victimBox.x < rect.x + rect.w &&
            rect.y < victimBox.y + victimBox.h &&
            victimBox.y < rect.y + rect.h;
          expect(overlaps).toBe(false);
        }
      }
    }
  });

  it('a band invaded by one box is cut into more rects, not stretched', () => {
    const clean = geometryOf(expanded, level, constraints);
    const before = (clean.bands.get(container) ?? []).reduce((n, b) => n + b.rects.length, 0);

    const bands = clean.bands.get(container) ?? [];
    const lastRank = (bands[bands.length - 1] as { rank: number }).rank;
    const rank = (constraints.get(container) as PackConstraints).rank;
    const victim = outline.childrenOf(container).find((c) => rank.get(c) === lastRank) as OutlineNodeId;
    const target = (bands[0] as { rects: readonly Box[] }).rects[0] as Box;
    const positions = new Map<NodeId, Position>([
      [
        outline.entityOf(victim),
        { x: target.x + target.w / 2, y: target.y + target.h / 2, pinned: true },
      ],
    ]);

    const after = geometryOf(expanded, level, constraints, positions).bands.get(container);
    if (after !== undefined) {
      const count = after.reduce((n, b) => n + b.rects.length, 0);
      expect(count).toBeGreaterThan(before);
    }
  });

  it('correspondence — a fully pinned container whose lanes moved emits no bands', () => {
    // The fit + toggle state: every child pinned where one basis left it, while the pack
    // computes lanes for the other. Reproduced by pinning every child at the position one
    // ranking produced and then asking for a DIFFERENT ranking.
    const first = syntheticConstraints(expanded, 3);
    const settled = geometryOf(expanded, level, first);

    const positions = new Map<NodeId, Position>();
    for (const c of outline.childrenOf(container)) {
      const p = settled.position.get(c);
      if (p !== undefined) positions.set(outline.entityOf(c), { x: p.x, y: p.y, pinned: true });
    }

    // A different rank assignment for the same children: the lanes move, the boxes do not.
    const other = new Map(first);
    const children = outline.childrenOf(container);
    const shifted = new Map<string, number>();
    children.forEach((c, i) => shifted.set(c, (i + 1) % 4));
    other.set(container, { rank: shifted, maxRank: 3 });

    const desynchronized = geometryOf(expanded, level, other, positions);
    expect(desynchronized.bands.has(container)).toBe(false);
  });
});

describe('the container box still contains its content', () => {
  it('a band never reaches outside the container padding', () => {
    const expanded = everythingExpanded();
    const geometry = geometryOf(expanded, new LevelPack(), syntheticConstraints(expanded));
    let checked = 0;
    for (const [id, bands] of geometry.bands) {
      const own = geometry.box.get(id) as Box;
      for (const band of bands) {
        for (const rect of band.rects) {
          expect(rect.x).toBeGreaterThanOrEqual(own.x + CONTAINER_PADDING - 0.5);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
  });
});
