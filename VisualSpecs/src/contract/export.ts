// export() = deep-clone `raw`, DEEP-MERGE the ViewState over its `view` subtree,
// serialise canonically. Everything else is carried across untouched (§3.3).
//
// "Deep-merge", not "replace". Replacing the `view` subtree would silently drop
// unknown fields inside `view` and inside each `Position` — which is precisely
// the loss the raw envelope exists to prevent. So:
//
//   * unknown keys in `view`            → preserved (we clone and overwrite keys)
//   * unknown keys inside a `Position`  → preserved (we spread the original object)
//   * unknown keys inside `viewport`    → preserved (same)
//   * inert positions (ids not in the graph) → preserved, because ViewState keeps
//                                         them after `import` (§3.5)
//   * unknown arrays                    → order preserved, untouched
//   * known graph arrays (nodes, edges) → canonicalised by id, so a shuffled input
//                                         document exports to identical bytes
//   * order-bearing known arrays (`generator.flags`, `requires`, `coverage`,
//     `unresolved`)                     → left exactly as they are; sorting CLI
//                                         flags would corrupt their meaning

import type { DeepReadonly, JsonObject, JsonValue } from './types.ts';
import { canonicalStringify, deepClone, isJsonObject } from './json.ts';
import type { ViewState } from './view.ts';

export interface ExportInput {
  readonly raw: DeepReadonly<JsonValue>;
  readonly view: ViewState;
  readonly readOnly?: boolean;
}

export class ReadOnlyExportError extends Error {
  constructor() {
    super(
      'This document declares a requirement this build does not implement, so it was opened read-only. ' +
        'A reader that cannot honour a declared requirement must not write the document back.',
    );
    this.name = 'ReadOnlyExportError';
  }
}

export function exportDoc(input: ExportInput): string {
  if (input.readOnly === true) throw new ReadOnlyExportError();

  const out = deepClone(input.raw as JsonValue);
  if (!isJsonObject(out)) {
    throw new Error('the document root is not a JSON object');
  }

  mergeView(out, input.view);
  raiseFormatVersionForFitted(out, input.view);
  canonicaliseGraphArrays(out);

  return canonicalStringify(out);
}

/**
 * Version locus for `fitted` (F2a, §3.4). `exportDoc` otherwise never writes
 * `formatVersion`, so a document that gains `view.fitted` must announce itself as 1.1 —
 * otherwise an old reader opens it with no `unknown-minor` warning. The bump is additive
 * and only ever raises within major 1; a doc without any fitted container is left at its
 * original version (so it still round-trips to identical bytes).
 */
function raiseFormatVersionForFitted(out: JsonObject, view: ViewState): void {
  if (view.fitted.size === 0) return;
  const current = typeof out['formatVersion'] === 'string' ? out['formatVersion'] : '1.0';
  const parts = current.split('.');
  const major = Number.parseInt(parts[0] ?? '', 10);
  const minor = Number.parseInt(parts[1] ?? '', 10);
  if (!Number.isFinite(major) || major < 1 || (major === 1 && (!Number.isFinite(minor) || minor < 1))) {
    out['formatVersion'] = '1.1';
  }
}

function mergeView(out: JsonObject, view: ViewState): void {
  const existing = out['view'];
  const rawView: JsonObject = isJsonObject(existing) ? existing : (Object.create(null) as JsonObject);

  // --- positions: merge onto each ORIGINAL Position object, key by key. -----
  const existingPositions = rawView['positions'];
  const basePositions: JsonObject = isJsonObject(existingPositions)
    ? existingPositions
    : (Object.create(null) as JsonObject);

  const positions: JsonObject = Object.create(null) as JsonObject;
  for (const id of [...view.positions.keys()].sort()) {
    const p = view.positions.get(id);
    if (p === undefined) continue;
    const base = basePositions[id];
    const merged: JsonObject = isJsonObject(base)
      ? ({ ...base } as JsonObject)
      : (Object.create(null) as JsonObject);
    merged['x'] = p.x;
    merged['y'] = p.y;
    if (p.pinned === true) merged['pinned'] = true;
    else delete merged['pinned'];
    positions[id] = merged;
  }
  rawView['positions'] = positions;

  // --- expanded: a known array whose order carries no meaning. Canonicalised.
  rawView['expanded'] = [...view.expanded].sort();

  // --- fitted (Issue #13): emitted ONLY when non-empty, so a document that never
  //     used the feature exports to identical bytes (no `fitted` key appears). An
  //     emptied set deletes the key. exportDoc raises formatVersion to 1.1 when this
  //     is present, so an old reader gets the `unknown-minor` announce.
  if (view.fitted.size > 0) rawView['fitted'] = [...view.fitted].sort();
  else delete rawView['fitted'];

  // --- viewport: merge onto the original object, so unknown keys survive. ---
  const existingViewport = rawView['viewport'];
  const viewport: JsonObject = isJsonObject(existingViewport)
    ? ({ ...existingViewport } as JsonObject)
    : (Object.create(null) as JsonObject);
  viewport['x'] = view.viewport.x;
  viewport['y'] = view.viewport.y;
  viewport['zoom'] = view.viewport.zoom;
  rawView['viewport'] = viewport;

  out['view'] = rawView;
}

/** nodes and edges are keyed sets whose array order carries no meaning, so they
 *  are sorted by id. Determinism, for free, even from a hand-edited document. */
function canonicaliseGraphArrays(out: JsonObject): void {
  for (const key of ['nodes', 'edges'] as const) {
    const arr = out[key];
    if (!Array.isArray(arr)) continue;
    const sorted = [...arr].sort((a, b) => {
      const ida = isJsonObject(a) && typeof a['id'] === 'string' ? a['id'] : '';
      const idb = isJsonObject(b) && typeof b['id'] === 'string' ? b['id'] : '';
      return ida < idb ? -1 : ida > idb ? 1 : 0;
    });
    out[key] = sorted;
  }
}
