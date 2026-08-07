// LevelPack (Issue #44): one band per rank, high rank at the top.
//
// The two acceptance criteria this file owns are the ones no correctness test would
// catch on its own:
//
//  - LevelPack with NO constraints is GridPack, bit for bit, on the real corpus. That
//    is what "GridPack does not break" means as an assert instead of as a promise.
//  - The result does not depend on the INSERTION ORDER of the constraint maps. A pack
//    that iterated them would return different geometry for identical data depending
//    on how the caller happened to build the map — correct-looking, and wrong.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { importDoc } from '../../src/contract/load.ts';
import { OwnershipOutline } from '../../src/domain/outline.ts';
import { CHILD_GAP, MIN_BAND_HEIGHT, leafSize } from '../../src/domain/geometry.ts';
import { GridPack } from '../../src/domain/layout/gridPack.ts';
import { LevelPack } from '../../src/domain/layout/levelPack.ts';
import type { PackConstraints, PackItem, PackResult } from '../../src/domain/layout/port.ts';

const TEXT = readFileSync(
  fileURLToPath(new URL('../../data/agentscommander.json', import.meta.url)),
  'utf8',
);
const loaded = importDoc(TEXT);

/** A comparable, order-independent view of a pack result. */
function normalise(result: PackResult): unknown {
  return {
    offsets: [...result.offsets.entries()]
      .map(([id, o]) => [id, o.x, o.y] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    width: result.width,
    height: result.height,
    bands: result.bands === undefined ? null : result.bands.map((b) => [b.rank, b.y, b.height]),
  };
}

function items(...specs: Array<[string, number, number]>): PackItem[] {
  return specs.map(([id, w, h]) => ({ id, size: { w, h } }));
}

/** Build constraints, inserting the keys in the given order. */
function constraintsFrom(
  ranks: ReadonlyArray<readonly [string, number]>,
  groups: ReadonlyArray<readonly [string, string]> = [],
): PackConstraints {
  const rank = new Map<string, number>();
  for (const [id, r] of ranks) rank.set(id, r);
  const group = new Map<string, string>();
  for (const [id, g] of groups) group.set(id, g);
  return {
    rank,
    maxRank: Math.max(...ranks.map(([, r]) => r)),
    group: group.size > 0 ? group : undefined,
  };
}

/** Every container in the real corpus, with its direct children sized as leaves. */
function corpusContainers(): Array<{ id: string; items: PackItem[] }> {
  const outline = new OwnershipOutline(loaded.model);
  const out: Array<{ id: string; items: PackItem[] }> = [];
  const stack = [...outline.roots()];
  while (stack.length > 0) {
    const n = stack.pop() as string;
    const children = outline.childrenOf(n);
    if (children.length > 0) {
      out.push({
        id: n,
        items: children.map((c) => {
          const node = loaded.model.nodeById.get(outline.entityOf(c));
          return { id: c, size: leafSize(node?.label ?? c) };
        }),
      });
      for (const c of children) stack.push(c);
    }
  }
  return out;
}

describe('LevelPack composes over GridPack rather than replacing it', () => {
  const grid = new GridPack();
  const level = new LevelPack();

  it('with no constraints, packs identically to GridPack on the real corpus', () => {
    const containers = corpusContainers();
    // The corpus has to actually exercise this, or the assert is vacuous.
    expect(containers.length).toBeGreaterThan(60);

    const mismatches: string[] = [];
    for (const container of containers) {
      const a = normalise(grid.pack(container.items));
      const b = normalise(level.pack(container.items));
      if (JSON.stringify(a) !== JSON.stringify(b)) mismatches.push(container.id);
    }
    expect(mismatches).toEqual([]);
  });

  it('falls back to the grid when the rank does not cover every item', () => {
    const list = items(['a', 100, 38], ['b', 100, 38], ['c', 100, 38]);
    const partial: PackConstraints = { rank: new Map([['a', 0]]), maxRank: 0 };
    expect(normalise(level.pack(list, partial))).toEqual(normalise(grid.pack(list)));
  });

  it('falls back to the grid when a rank is out of the declared band', () => {
    const list = items(['a', 100, 38], ['b', 100, 38]);
    const broken = constraintsFrom([
      ['a', 0],
      ['b', 5],
    ]);
    // maxRank comes out as 5 above, so narrow it to make `b` inconsistent.
    const inconsistent: PackConstraints = { rank: broken.rank, maxRank: 1 };
    expect(normalise(level.pack(list, inconsistent))).toEqual(normalise(grid.pack(list)));
  });

  it('an empty item list packs the same either way', () => {
    const empty: PackConstraints = { rank: new Map(), maxRank: 0 };
    expect(normalise(level.pack([], empty))).toEqual(normalise(grid.pack([])));
  });
});

describe('the pack does not depend on the insertion order of the constraint maps', () => {
  const level = new LevelPack();
  const list = items(
    ['a', 120, 38],
    ['b', 90, 38],
    ['c', 200, 52],
    ['d', 140, 38],
    ['e', 110, 38],
  );

  it('permuting the rank map insertion order gives a bit-identical result', () => {
    const forwards = constraintsFrom([
      ['a', 2],
      ['b', 1],
      ['c', 1],
      ['d', 0],
      ['e', 0],
    ]);
    const backwards = constraintsFrom([
      ['e', 0],
      ['d', 0],
      ['c', 1],
      ['b', 1],
      ['a', 2],
    ]);
    const shuffled = constraintsFrom([
      ['c', 1],
      ['a', 2],
      ['e', 0],
      ['b', 1],
      ['d', 0],
    ]);

    const first = normalise(level.pack(list, forwards));
    expect(normalise(level.pack(list, backwards))).toEqual(first);
    expect(normalise(level.pack(list, shuffled))).toEqual(first);
  });

  it('permuting the group map insertion order gives a bit-identical result', () => {
    const ranks: Array<readonly [string, number]> = [
      ['a', 1],
      ['b', 1],
      ['c', 1],
      ['d', 0],
      ['e', 0],
    ];
    const one = constraintsFrom(ranks, [
      ['a', 'g1'],
      ['c', 'g1'],
    ]);
    const other = constraintsFrom(ranks, [
      ['c', 'g1'],
      ['a', 'g1'],
    ]);
    expect(normalise(level.pack(list, other))).toEqual(normalise(level.pack(list, one)));
  });
});

describe('the bands say what the geometry means', () => {
  const level = new LevelPack();
  const list = items(
    ['top', 120, 38],
    ['mid1', 90, 38],
    ['mid2', 200, 52],
    ['low1', 140, 38],
    ['low2', 110, 38],
  );
  const constraints = constraintsFrom([
    ['top', 2],
    ['mid1', 1],
    ['mid2', 1],
    ['low1', 0],
    ['low2', 0],
  ]);
  const packed = level.pack(list, constraints);
  const bands = packed.bands ?? [];

  it('emits one band per rank that has items, high rank first', () => {
    expect(bands.map((b) => b.rank)).toEqual([2, 1, 0]);
  });

  it('puts high rank at the TOP — so a dependency arrow points down', () => {
    const y = (id: string) => packed.offsets.get(id)?.y ?? NaN;
    expect(y('top')).toBeLessThan(y('mid1'));
    expect(y('mid1')).toBeLessThan(y('low1'));
  });

  it('bands are contiguous: one band ends exactly where the next begins', () => {
    for (let i = 0; i + 1 < bands.length; i += 1) {
      const current = bands[i] as { y: number; height: number };
      const next = bands[i + 1] as { y: number };
      expect(current.y + current.height).toBe(next.y);
    }
  });

  it('every box the pack placed falls inside the band of its rank (LVL-12a, Y axis)', () => {
    for (const item of list) {
      const rank = constraints.rank.get(item.id) as number;
      const band = bands.find((b) => b.rank === rank) as { y: number; height: number };
      const offset = packed.offsets.get(item.id) as { y: number };
      expect(offset.y).toBeGreaterThanOrEqual(band.y);
      expect(offset.y + item.size.h).toBeLessThanOrEqual(band.y + band.height);
    }
  });

  it('takes its padding out of the CHILD_GAP: the air is half a gap on each side', () => {
    // The topmost band starts half a gap above the content origin — that overhang is
    // absorbed by the container's own padding, which is wider than it.
    expect(bands[0]?.y).toBe(-CHILD_GAP / 2);
    // A one-row band of leaves measures a row plus its two half-gaps, which is exactly
    // the legibility floor: on these constants the floor never binds.
    const single = bands.find((b) => b.rank === 2) as { height: number };
    expect(single.height).toBe(38 + CHILD_GAP);
    expect(single.height).toBeGreaterThanOrEqual(MIN_BAND_HEIGHT);
  });

  it('keeps the members of one mutual-dependency group adjacent inside their band', () => {
    const wide = items(
      ['a', 100, 38],
      ['b', 100, 38],
      ['c', 100, 38],
      ['d', 100, 38],
      ['e', 100, 38],
    );
    // a, c and e are one group; b and d sit between them in canonical order.
    const grouped = constraintsFrom(
      [
        ['a', 0],
        ['b', 0],
        ['c', 0],
        ['d', 0],
        ['e', 0],
      ],
      [
        ['a', 'g'],
        ['c', 'g'],
        ['e', 'g'],
      ],
    );
    const result = level.pack(wide, grouped);
    const order = [...result.offsets.entries()]
      .sort((p, q) => p[1].x - q[1].x)
      .map(([id]) => id);
    expect(order).toEqual(['a', 'c', 'e', 'b', 'd']);
  });
});
