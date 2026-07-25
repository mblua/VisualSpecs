// I-F1 / I-F2 verified from OUTSIDE the domain (Issue #17, §6 item 2).
//
// `project()` takes the expansion set and not the view, so focus is physically unable
// to reach the projection — and that is exactly why this file exists somewhere other
// than next to the code that arranges it. A unit test written against `project()`'s
// signature proves the signature; it cannot notice the day someone threads the view
// through "just for the scene" and the guarantee quietly becomes a convention. These
// tests approach from the artifact end: extract a repository, apply focus the way a
// person would, and demand that every observation, every count and the whole
// projection come out bit-identical — then re-extract and demand the extractor did
// not notice any of it happened.
//
// The full loop is the point: extract → apply focus → export → re-extract. Each hop
// is a place where a human decision and an extracted observation could contaminate
// each other, and each hop is checked in bytes rather than in shape.
//
// POSITIVE CONTROL. Invariance tests are vacuous if the thing that must not change
// was never disturbed. Every case that asserts "identical" is paired with an
// assertion that the focus sequence genuinely changed the resolved state, so a
// no-op sequence fails the test instead of passing it trivially.
//
// This deliberately does not touch `buildScene` or the renderer port beyond
// `hiddenByFilter`, which is the one scene-level number I-F2 names. Opacity, glyphs
// and the port's shape belong to the graph/runtime owner; the projection, the counts
// and the observations are what the corpus can adjudicate.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { importDoc, refresh } from '../../src/contract/load.ts';
import { exportDoc } from '../../src/contract/export.ts';
import { canonicalStringify } from '../../src/contract/json.ts';
import { DEFAULT_LIMITS } from '../../src/contract/limits.ts';
import type { JsonObject, JsonValue } from '../../src/contract/types.ts';
import type { GraphModel } from '../../src/contract/model.ts';
import { apply, stateFromLoaded, type AppState } from '../../src/app/state.ts';
import { derive } from '../../src/app/controller.ts';
import type { CommandContext, ViewCommand } from '../../src/domain/commands.ts';
import { computeGeometry } from '../../src/domain/layoutEngine.ts';
import { resolve } from '../../src/domain/focus.ts';
import { project } from '../../src/projection/project.ts';
import type { VisibleGraph } from '../../src/projection/types.ts';
import { extract, type ExtractOptions } from '../../tools/extractor/extract.ts';
import { makeFixtureRepo, type FixtureRepo } from '../support/fixtureRepo.ts';

const CORPUS = fileURLToPath(new URL('../../data/agentscommander.json', import.meta.url));

let fixture: FixtureRepo;
let fixtureText: string;

const options = (over: Partial<ExtractOptions> = {}): ExtractOptions => ({
  repo: fixture.root,
  out: 'data/fixture.json',
  name: 'fixture',
  hierarchy: 'logical',
  invokeFacade: 'transport.invoke',
  allowBareInvoke: false,
  snippets: false,
  tsconfig: undefined,
  flags: ['--hierarchy', 'logical'],
  stamp: false,
  ...over,
});

beforeAll(() => {
  fixture = makeFixtureRepo();
  fixtureText = extract(options()).text;
});

afterAll(() => {
  fixture.cleanup();
});

// ── the loop, as functions ───────────────────────────────────────────────────

const stateOf = (text: string): AppState => stateFromLoaded(importDoc(text, DEFAULT_LIMITS));

/**
 * Dispatch a sequence through the real reducer, recomputing geometry between steps
 * exactly as the controller does. Going through `apply` rather than `applyViewCommand`
 * keeps the `VIEW_COMMANDS` routing in the path: a focus command that fell through to
 * `default: return state` would silently make every invariance assertion below pass.
 */
function dispatchAll(state: AppState, commands: readonly ViewCommand[]): AppState {
  let current = state;
  for (const cmd of commands) {
    const ctx: CommandContext = {
      model: current.model,
      outline: current.outline,
      geometry: computeGeometry(
        current.model,
        current.outline,
        current.view.expanded,
        current.view.positions,
        current.view.fitted,
      ),
      limits: DEFAULT_LIMITS,
    };
    current = apply(current, cmd, ctx);
  }
  return current;
}

const projectionOf = (state: AppState): VisibleGraph =>
  project(state.model, state.outline, state.view.expanded);

/** The whole projection as bytes: every visible identity, every aggregate's members,
 *  and the NVA map the partition law is stated over. */
function projectionBytes(graph: VisibleGraph): string {
  return canonicalStringify({
    visibleNodes: [...graph.visibleNodes],
    visibleEdges: graph.visibleEdges.map((e) => ({
      id: e.id,
      kind: e.kind,
      sourceId: e.sourceId,
      targetId: e.targetId,
      count: e.count,
      sourceEdgeIds: [...e.sourceEdgeIds],
    })),
    internalBuckets: graph.internalBuckets.map((b) => ({
      id: b.id,
      kind: b.kind,
      containerId: b.containerId,
      count: b.count,
      sourceEdgeIds: [...b.sourceEdgeIds],
    })),
    nva: [...graph.nva].map(([node, representative]) => [node, representative]),
    outOfScopeEdgeIds: [...graph.outOfScopeEdgeIds],
  } as unknown as JsonValue);
}

/** Every observation the document carries, as bytes. */
function observationBytes(model: GraphModel): string {
  return canonicalStringify({
    nodes: model.nodes,
    edges: model.edges,
    unresolved: model.unresolved,
  } as unknown as JsonValue);
}

/** The four numbers in the counts box, plus `hiddenByFilter` (§9 I-F2). */
function counts(state: AppState): Record<string, number> {
  const derived = derive(state);
  return {
    nodes: state.model.nodes.length,
    relations: state.model.edges.length,
    drawn: derived.graph.visibleEdges.length,
    foldedAway: derived.graph.internalBuckets.reduce((n, b) => n + b.count, 0),
    hiddenNodes: derived.scene.hiddenByFilter.nodes,
    hiddenEdges: derived.scene.hiddenByFilter.edges,
  };
}

/** How many entities the focus state actually pushes out, and how many marks say so. */
function focusEffect(state: AppState): { out: number; marks: number } {
  const graph = projectionOf(state);
  const resolved = resolve(state.outline, graph.nva, state.view.focus);
  let out = 0;
  for (const effective of resolved.effective.values()) if (effective === 'out') out += 1;
  return { out, marks: state.view.focus.marks.size };
}

/** A directory with at least one file of its own — the pair the override needs. */
function pickOverridePair(model: GraphModel): { container: string; child: string } {
  for (const node of model.nodes) {
    if (node.kind !== 'file') continue;
    const parent = node.parentId === null ? undefined : model.nodeById.get(node.parentId);
    if (parent !== undefined && parent.kind === 'directory') {
      return { container: parent.id, child: node.id };
    }
  }
  throw new Error('no directory with a file child in this model');
}

const withoutView = (text: string): string => {
  const doc = JSON.parse(text) as JsonObject;
  delete doc['view'];
  delete doc['formatVersion']; // asserted separately: it is the one key focus may move
  return canonicalStringify(doc as JsonValue);
};

// ── the full loop, on a repository the test extracts itself ──────────────────

describe('extract → apply focus → export → re-extract (I-F1, I-F2)', () => {
  it('leaves the projection, every count and every observation bit-identical', () => {
    const base = dispatchAll(stateOf(fixtureText), [{ type: 'ExpandAll' }]);
    const pair = pickOverridePair(base.model);
    const focused = dispatchAll(base, [
      { type: 'SetAllFocus', mark: 'out-of-focus' },
      { type: 'SetFocus', id: pair.container, requested: 'out-of-focus' },
      { type: 'SetFocus', id: pair.child, requested: 'in-focus' },
      { type: 'SetFocusTransparency', percent: 55 },
    ]);

    // Positive control: the sequence really did something, and it did it with an
    // override alive — a child in focus under an out-of-focus container.
    const before = focusEffect(base);
    const after = focusEffect(focused);
    expect(before).toEqual({ out: 0, marks: 0 });
    expect(after.out).toBeGreaterThan(0);
    expect(after.marks).toBeGreaterThan(0);
    expect(focused.view.focus.marks.get(pair.child)).toBe('in-focus');
    expect(focused.view.focus.transparency).toBe(55);

    // I-F1: the projection is untouched, in bytes.
    expect(projectionBytes(projectionOf(focused))).toBe(projectionBytes(projectionOf(base)));
    // I-F2: all four counts and `hiddenByFilter`.
    expect(counts(focused)).toEqual(counts(base));
    // The observations, in bytes — and by identity, because a view command has no
    // business even copying the model.
    expect(observationBytes(focused.model)).toBe(observationBytes(base.model));
    expect(focused.model).toBe(base.model);
    expect(focused.raw).toBe(base.raw);
  });

  it('exports focus without moving a single observation byte', () => {
    const base = dispatchAll(stateOf(fixtureText), [{ type: 'ExpandAll' }]);
    const pair = pickOverridePair(base.model);
    const focused = dispatchAll(base, [
      { type: 'SetFocus', id: pair.container, requested: 'out-of-focus' },
      { type: 'SetFocus', id: pair.child, requested: 'in-focus' },
    ]);

    const exported = exportDoc({ raw: focused.raw, view: focused.view, readOnly: false });
    const parsed = JSON.parse(exported) as JsonObject;
    const view = parsed['view'] as JsonObject;

    // The human decision is in the document…
    expect(view['focus']).toEqual({
      marks: { [pair.container]: 'out-of-focus', [pair.child]: 'in-focus' },
      transparency: 70,
    });
    expect(parsed['formatVersion']).toBe('1.2');
    expect(JSON.parse(fixtureText)['formatVersion']).toBe('1.0');

    // …and everything that is not `view` is byte-for-byte what the extractor said.
    // `formatVersion` is excluded and asserted above: it is the only key outside
    // `view` that focus is allowed to move.
    expect(withoutView(exported)).toBe(withoutView(fixtureText));
  });

  it('re-extracts to the identical bytes: the extractor never noticed', () => {
    const base = dispatchAll(stateOf(fixtureText), [{ type: 'ExpandAll' }]);
    const pair = pickOverridePair(base.model);
    const focused = dispatchAll(base, [
      { type: 'SetAllFocus', mark: 'out-of-focus' },
      { type: 'SetFocus', id: pair.child, requested: 'in-focus' },
    ]);
    expect(focusEffect(focused).out).toBeGreaterThan(0);

    // A second extraction of an unchanged repository, after a person spent a session
    // marking things. Byte-identical to the first, including `formatVersion`.
    expect(extract(options()).text).toBe(fixtureText);
  });

  it('carries every mark through a refresh onto the re-extracted document', () => {
    const base = dispatchAll(stateOf(fixtureText), [{ type: 'ExpandAll' }]);
    const pair = pickOverridePair(base.model);
    const focused = dispatchAll(base, [
      { type: 'SetFocus', id: pair.container, requested: 'out-of-focus' },
      { type: 'SetFocus', id: pair.child, requested: 'in-focus' },
    ]);

    // Positive control, and not a formality: comparing "the marks that survived" with
    // "the marks there were" is satisfied by two empty sets, so without this line a
    // reducer that dropped `SetFocus` on the floor would make this case pass.
    expect(focused.view.focus.marks.size).toBe(2);

    // `refresh` is the path a follow-file auto-reload takes. The re-extracted document
    // has no `view` at all; the marks come from the session, and nothing in this graph
    // disappeared, so nothing may be dropped.
    const { loaded, loss } = refresh(extract(options()).text, {
      model: focused.model,
      view: focused.view,
    });
    expect(loss.droppedFocus).toEqual([]);
    expect([...loaded.view.focus.marks.entries()].sort()).toEqual(
      [...focused.view.focus.marks.entries()].sort(),
    );
    expect(loaded.view.focus.transparency).toBe(focused.view.focus.transparency);
    // And the refreshed document's observations are still the extractor's.
    expect(observationBytes(loaded.model)).toBe(observationBytes(base.model));
  });
});

// ── the same question, adjudicated by the real corpus ────────────────────────

describe('the committed AgentsCommander corpus is indifferent to focus', () => {
  it('787 nodes: projection, counts and observations bit-identical under focus', () => {
    const corpusText = readFileSync(CORPUS, 'utf8');
    const base = stateOf(corpusText);
    const pair = pickOverridePair(base.model);
    const focused = dispatchAll(base, [
      { type: 'SetAllFocus', mark: 'out-of-focus' },
      { type: 'SetFocus', id: pair.child, requested: 'in-focus' },
      { type: 'SetFocusTransparency', percent: 40 },
    ]);

    // Positive control on the corpus: `SetAllFocus` marks the roots, so the whole
    // map resolves out except the one entity brought back — an override that spans
    // the real ownership tree, not a two-node fixture.
    const after = focusEffect(focused);
    expect(focusEffect(base).out).toBe(0);
    expect(after.out).toBeGreaterThan(1);
    expect(focused.view.focus.marks.get(pair.child)).toBe('in-focus');

    expect(projectionBytes(projectionOf(focused))).toBe(projectionBytes(projectionOf(base)));
    expect(counts(focused)).toEqual(counts(base));
    expect(observationBytes(focused.model)).toBe(observationBytes(base.model));
    expect(focused.model).toBe(base.model);
  });
});
