// The round-trip promise (§3.3), and the coordinator's SECOND DISSENT.
//
// > A load→save cycle preserves EVERY known and unknown JSON value reachable in the
// > document, and emits deterministic key and array order. It does NOT preserve
// > input whitespace, input key order, or numeric literal spelling.
//
// The mechanism is a raw envelope with a single mutable authority, and `export()`
// DEEP-MERGES the ViewState over `raw.view` rather than replacing that subtree —
// because replacing it silently drops unknown fields inside `view` and inside each
// `Position`, which is exactly the loss the envelope exists to prevent.

import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from '../../src/contract/limits.ts';
import { exportDoc, ReadOnlyExportError } from '../../src/contract/export.ts';
import { importDoc } from '../../src/contract/load.ts';
import { applyViewCommand } from '../../src/domain/commands.ts';
import { computeGeometry } from '../../src/domain/layoutEngine.ts';
import { OwnershipOutline } from '../../src/domain/outline.ts';
import type { JsonObject } from '../../src/contract/types.ts';

/** A document with an unknown field at EVERY level the contract names. */
const EXTENDED = {
  formatVersion: '1.0',
  unknownAtRoot: { deeply: { nested: [1, 'two', { three: true }] } },
  generator: { name: 'x', version: '1', unknownInGenerator: 'kept' },
  source: { kind: 'git-repo', root: 'demo', unknownInSource: [1, 2, 3] },
  nodes: [
    {
      id: 'repo',
      kind: 'repository',
      label: 'repo',
      parentId: null,
      path: '',
      unknownInNode: 'kept',
      evidence: [{ path: 'a.ts', line: 1, unknownInEvidence: { x: 1 } }],
    },
    { id: 'a', kind: 'file', label: 'a', parentId: 'repo', path: 'a.ts' },
    { id: 'b', kind: 'file', label: 'b', parentId: 'repo', path: 'b.ts' },
  ],
  edges: [
    {
      id: 'e1',
      kind: 'imports',
      sourceId: 'a',
      targetId: 'b',
      confidence: 'resolved',
      unknownInEdge: { deep: [{ deeper: null }] },
    },
  ],
  view: {
    unknownInView: 'kept',
    positions: {
      a: { x: 10, y: 20, unknownInPosition: 'kept', pinned: true },
      // An INERT position: `ghost` is not a node in this graph. `import` keeps it,
      // so that load → export loses nothing (§3.5).
      ghost: { x: 1, y: 2, unknownInGhost: true },
    },
    expanded: ['repo'],
    viewport: { x: 5, y: 6, zoom: 2, unknownInViewport: 'kept' },
  },
  unknownArray: [3, 1, 2],
};

function reexport(text: string, mutate = true): JsonObject {
  const loaded = importDoc(text);
  let view = loaded.view;

  if (mutate) {
    const outline = new OwnershipOutline(loaded.model);
    const geometry = computeGeometry(loaded.model, outline, view.expanded, view.positions);
    const ctx = { model: loaded.model, outline, geometry, limits: DEFAULT_LIMITS };
    // The exact sequence the dissent asked for: MoveNode, then ToggleExpand.
    view = applyViewCommand(ctx, view, { type: 'MoveNode', id: 'b', position: { x: 111, y: 222 } });
    view = applyViewCommand(ctx, view, { type: 'ToggleExpand', id: 'repo' });
  }

  return JSON.parse(exportDoc({ raw: loaded.raw, view })) as JsonObject;
}

describe('deep round-trip', () => {
  it('preserves unknown fields at every level through Load → MoveNode → ToggleExpand → Export', () => {
    const out = reexport(JSON.stringify(EXTENDED));

    expect(out['unknownAtRoot']).toEqual({ deeply: { nested: [1, 'two', { three: true }] } });
    expect((out['generator'] as JsonObject)['unknownInGenerator']).toBe('kept');
    expect((out['source'] as JsonObject)['unknownInSource']).toEqual([1, 2, 3]);

    const nodes = out['nodes'] as JsonObject[];
    const repo = nodes.find((n) => n['id'] === 'repo') as JsonObject;
    expect(repo['unknownInNode']).toBe('kept');
    expect((repo['evidence'] as JsonObject[])[0]?.['unknownInEvidence']).toEqual({ x: 1 });

    const edges = out['edges'] as JsonObject[];
    expect(edges[0]?.['unknownInEdge']).toEqual({ deep: [{ deeper: null }] });

    // …and inside `view`, and inside a `Position`, and inside `viewport` —
    // the four places a "replace the view subtree" export would have destroyed.
    const view = out['view'] as JsonObject;
    expect(view['unknownInView']).toBe('kept');
    const positions = view['positions'] as JsonObject;
    expect((positions['a'] as JsonObject)['unknownInPosition']).toBe('kept');
    expect((view['viewport'] as JsonObject)['unknownInViewport']).toBe('kept');
  });

  it('keeps an INERT position for an id that is not in the graph', () => {
    const out = reexport(JSON.stringify(EXTENDED));
    const positions = (out['view'] as JsonObject)['positions'] as JsonObject;
    const ghost = positions['ghost'] as JsonObject;
    expect(ghost).toBeDefined();
    expect(ghost['x']).toBe(1);
    expect(ghost['unknownInGhost']).toBe(true);
  });

  it('writes the ViewState over the known view fields', () => {
    const out = reexport(JSON.stringify(EXTENDED));
    const view = out['view'] as JsonObject;
    const positions = view['positions'] as JsonObject;

    // MoveNode pinned `b` where we put it.
    expect(positions['b']).toMatchObject({ x: 111, y: 222, pinned: true });
    // ToggleExpand collapsed the repository.
    expect(view['expanded']).toEqual([]);
    // The viewport is carried across untouched.
    expect(view['viewport']).toMatchObject({ x: 5, y: 6, zoom: 2 });
  });

  it('preserves the order of UNKNOWN arrays and canonicalises only the known ones', () => {
    const out = reexport(JSON.stringify(EXTENDED), false);
    // An unknown array's order may carry meaning we cannot see. Untouched.
    expect(out['unknownArray']).toEqual([3, 1, 2]);
    // `nodes` and `edges` are keyed sets: sorted by id, so a shuffled input document
    // exports to identical bytes.
    expect((out['nodes'] as JsonObject[]).map((n) => n['id'])).toEqual(['a', 'b', 'repo']);
  });

  it('never reorders generator.flags — a flag list is not a set', () => {
    const text = JSON.stringify({
      ...EXTENDED,
      generator: { name: 'x', version: '1', flags: ['--z', '--a', '--m'] },
    });
    const out = reexport(text, false);
    expect((out['generator'] as JsonObject)['flags']).toEqual(['--z', '--a', '--m']);
  });

  it('is byte-identical when the input arrays are shuffled', () => {
    const shuffled = {
      ...EXTENDED,
      nodes: [...EXTENDED.nodes].reverse(),
      edges: [...EXTENDED.edges].reverse(),
    };
    const a = exportDoc(pick(importDoc(JSON.stringify(EXTENDED))));
    const b = exportDoc(pick(importDoc(JSON.stringify(shuffled))));
    expect(a).toBe(b);
  });

  it('is idempotent: exporting an exported document changes nothing', () => {
    const once = exportDoc(pick(importDoc(JSON.stringify(EXTENDED))));
    const twice = exportDoc(pick(importDoc(once)));
    expect(twice).toBe(once);
  });

  it('refuses to export a read-only document', () => {
    const text = JSON.stringify({ ...EXTENDED, requires: ['multi-placement-outlines'] });
    const loaded = importDoc(text);
    expect(loaded.readOnly).toBe(true);
    expect(() => exportDoc({ raw: loaded.raw, view: loaded.view, readOnly: loaded.readOnly })).toThrow(
      ReadOnlyExportError,
    );
  });
});

function pick(loaded: ReturnType<typeof importDoc>) {
  return { raw: loaded.raw, view: loaded.view };
}
