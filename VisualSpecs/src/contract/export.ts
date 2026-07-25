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
import { isDefaultFocus, type ViewState } from './view.ts';

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
  raiseFormatVersion(out, input.view);
  canonicaliseGraphArrays(out);

  return canonicalStringify(out);
}

/**
 * Version locus (F2a, §3.4). `exportDoc` otherwise never writes `formatVersion`, so a
 * document that gains `view.fitted` must announce itself as 1.1 and one that gains
 * `view.focus` as 1.2 — otherwise an old reader opens it with no `unknown-minor`
 * warning. Additive, and it only ever RAISES within major 1.
 *
 * Keyed off the TYPED state, deliberately, and not off whether the key appears in the
 * output. §5.2 keeps a `view.focus` subtree that was present in `raw` even when this
 * build's focus state is empty — so keying off the emitted key would raise a document
 * whose focus state is default, on which the user did nothing, and hand a 1.1 reader an
 * `unknown-minor` warning for nothing.
 *
 * It never LOWERS, and must not: a document already written at 1.2 stays 1.2 even after
 * every mark is cleared, because lowering would suppress `unknown-minor` for any OTHER
 * 1.2 extension the raw envelope is carrying — a worse failure than a stale minor.
 */
function raiseFormatVersion(out: JsonObject, view: ViewState): void {
  const required = !isDefaultFocus(view.focus) ? 2 : view.fitted.size > 0 ? 1 : 0;
  if (required === 0) return;

  const current = typeof out['formatVersion'] === 'string' ? out['formatVersion'] : '1.0';
  const parts = current.split('.');
  const major = Number.parseInt(parts[0] ?? '', 10);
  const minor = Number.parseInt(parts[1] ?? '', 10);
  if (!Number.isFinite(major) || major < 1) {
    out['formatVersion'] = `1.${required}`;
    return;
  }
  if (major === 1 && (!Number.isFinite(minor) || minor < required)) {
    out['formatVersion'] = `1.${required}`;
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

  // --- fitted (Issue #13): emitted when non-empty, so a document that never used the
  //     feature exports to identical bytes (no `fitted` key appears).
  //
  //     The key is deleted ONLY when it was absent from the input. `delete` on an
  //     emptied set was a losslessness bug: a document that declared `"fitted": []`
  //     lost the key on a no-op round trip, and an empty array is a VALUE — the same
  //     mistake `viewProvided` exists to prevent for `expanded`.
  if (view.fitted.size > 0) rawView['fitted'] = [...view.fitted].sort();
  else if ('fitted' in rawView) rawView['fitted'] = [];

  // --- focus (Issue #17): merged KEY BY KEY, like `positions` and `viewport` below,
  //     and for the same reason. A whole-object rebuild plus a delete is the one shape
  //     that cannot preserve anything: today `view.focus` is an unknown key that
  //     `mergeView` carries through intact, so rebuilding it would make this feature
  //     LOSE data the product does not lose — a document carrying
  //     `focus: { transparency, marks, <anything a newer minor added> }` would export
  //     with the whole subtree gone, for a user who did nothing but open and export.
  if (isDefaultFocus(view.focus) && !('focus' in rawView)) {
    // Never used, never declared: no key, so the export is byte-identical.
  } else {
    const existingFocus = rawView['focus'];
    const focusOut: JsonObject = isJsonObject(existingFocus)
      ? ({ ...existingFocus } as JsonObject)
      : (Object.create(null) as JsonObject);
    focusOut['transparency'] = view.focus.transparency;

    // Inside `marks`, the TYPED STATE WINS for any id it contains; verbatim
    // preservation applies only to ids absent from it. Without that precedence an id
    // carrying a token from a newer minor is claimed by both rules at once, and two
    // conforming implementations disagree about whether a right-click did anything.
    // So: drop the entries this build recognises (the typed state is authoritative for
    // those, including by deleting them), keep the ones it does not.
    const existingMarks = focusOut['marks'];
    const marksOut: JsonObject = Object.create(null) as JsonObject;
    if (isJsonObject(existingMarks)) {
      for (const id of Object.keys(existingMarks).sort()) {
        const value = existingMarks[id];
        if (value === 'out-of-focus' || value === 'in-focus') continue;
        if (view.focus.marks.has(id)) continue;
        marksOut[id] = value as JsonValue;
      }
    }
    for (const id of [...view.focus.marks.keys()].sort()) {
      marksOut[id] = view.focus.marks.get(id) as JsonValue;
    }
    focusOut['marks'] = marksOut;
    rawView['focus'] = focusOut;
  }

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
