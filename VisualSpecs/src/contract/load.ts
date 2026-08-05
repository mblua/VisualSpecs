// import(doc) and refresh(newDoc, currentView) — two operations with opposite
// obligations (§3.5). `import` never quietly throws data away; `refresh` throws
// away exactly what no longer exists, and hands back a loss report.

import type {
  DeepReadonly,
  JsonValue,
  LossReport,
  NodeId,
  Position,
  Warning,
} from './types.ts';
import { DEFAULT_LIMITS, type Limits } from './limits.ts';
import { buildModel, type GraphModel } from './model.ts';
import { deepFreeze, parseJson, scanJson } from './json.ts';
import { validate } from './validate.ts';
import {
  DEFAULT_VIEWPORT,
  FOCUS_TRANSPARENCY_DEFAULT,
  type FocusMark,
  type FocusState,
  type ViewState,
} from './view.ts';

/**
 * The transparency band is a `Limits` value and an out-of-band number is REPAIRED,
 * not rejected. Refusing to open an 817-node map over a cosmetic alpha is
 * disproportionate, and module constants plus a hard error would have made every
 * document written by a build with a different band unopenable, on a field that
 * controls nothing but an alpha, with no minor bump available to signal it.
 *
 * Repaired and not preserved, unlike an inert mark: a mark names real human work for
 * another graph; an out-of-range integer is not work. That asymmetry is deliberate.
 */
function clampTransparency(value: number | undefined, limits: Limits): number {
  if (value === undefined || !Number.isFinite(value)) return FOCUS_TRANSPARENCY_DEFAULT;
  return Math.min(limits.maxFocusTransparency, Math.max(limits.minFocusTransparency, Math.round(value)));
}

/**
 * WHICH parts of `view` the document actually provided.
 *
 * This exists because "the user deliberately collapsed everything" and "the
 * extractor shipped no view at all" are DIFFERENT DOCUMENTS, and `expanded.size
 * === 0` cannot tell them apart. Inferring one from the other threw away a view the
 * user had explicitly saved: `Collapse all → Export → Import` came back expanded.
 * An empty array is a value, not an absence.
 */
export interface ViewProvided {
  readonly expanded: boolean;
  readonly positions: boolean;
  readonly viewport: boolean;
}

export interface LoadedDoc {
  /** The exact parsed JSON tree, deep-frozen. Never mutated. The extension envelope. */
  readonly raw: DeepReadonly<JsonValue>;
  /** Validated, indexed, canonicalised view over `raw`. What the algorithms consume. */
  readonly model: GraphModel;
  /** THE ONE mutable authority for expanded / positions / viewport. */
  readonly view: ViewState;
  /** What the document said, as opposed to what it happens to contain. */
  readonly viewProvided: ViewProvided;
  readonly warnings: readonly Warning[];
  readonly readOnly: boolean;
}

/**
 * Open a document. Discards NOTHING: a position naming a node that is not in the
 * graph is kept (inert, warned, not rendered), so load → export is lossless.
 */
export function importDoc(text: string, limits: Limits = DEFAULT_LIMITS): LoadedDoc {
  const parsed = parseJson(text, limits);
  const scan = scanJson(parsed, limits);
  const { doc, warnings, readOnly } = validate(parsed, limits, scan);
  const model = buildModel(doc);

  const allWarnings: Warning[] = [...warnings];

  const positions = new Map<NodeId, Position>();
  const stalePositions: NodeId[] = [];
  for (const [id, p] of Object.entries(doc.view?.positions ?? {})) {
    positions.set(id, p);
    if (!model.nodeById.has(id)) stalePositions.push(id);
  }
  if (stalePositions.length > 0) {
    allWarnings.push({
      code: 'stale-position',
      message:
        `${stalePositions.length} stored position(s) name nodes that are not in this graph. ` +
        `They are kept so that exporting this document loses nothing, but nothing is drawn for them.`,
      ids: stalePositions,
    });
  }

  const expanded = new Set<NodeId>(doc.view?.expanded ?? []);
  const staleExpanded = [...expanded].filter((id) => !model.nodeById.has(id));
  if (staleExpanded.length > 0) {
    allWarnings.push({
      code: 'stale-expanded',
      message:
        `${staleExpanded.length} expanded id(s) name nodes that are not in this graph. ` +
        `They are retained but inert.`,
      ids: staleExpanded,
    });
  }

  // `fitted` (Issue #13) mirrors `expanded`: kept even when it names an absent node,
  // so import is lossless (§3.5). A stale fitted id is inert — the size override needs
  // `childrenShown`, which an absent id can never satisfy — so it cannot misbehave.
  const fitted = new Set<NodeId>(doc.view?.fitted ?? []);
  const staleFitted = [...fitted].filter((id) => !model.nodeById.has(id));
  if (staleFitted.length > 0) {
    allWarnings.push({
      code: 'stale-fitted',
      message:
        `${staleFitted.length} fitted id(s) name nodes that are not in this graph. ` +
        `They are retained but inert.`,
      ids: staleFitted,
    });
  }

  // `focus` (Issue #17) mirrors `fitted` in keeping inert entries so import is
  // lossless — and DELIBERATELY does NOT warn about them, which is where it stops
  // mirroring `fitted`. A `stale-focus` warning would be the fourth `stale-*` code
  // the banner allowlist drops on the floor: a Warning no consumer reads is worse
  // than no warning, because its existence reads as evidence that staleness IS
  // reported. Inert marks reach the user through the sidebar's mark counter, which
  // has to enumerate them anyway to render their rows — and where the user can act
  // on them instead of watching a banner scroll away.
  const marks = new Map<NodeId, FocusMark>();
  for (const [id, mark] of Object.entries(doc.view?.focus?.marks ?? {})) marks.set(id, mark);
  const focus: FocusState = {
    marks,
    transparency: clampTransparency(doc.view?.focus?.transparency, limits),
  };

  const view: ViewState = {
    expanded,
    positions,
    fitted,
    focus,
    viewport: doc.view?.viewport ?? DEFAULT_VIEWPORT,
  };

  return {
    raw: deepFreeze(parsed) as DeepReadonly<JsonValue>,
    model,
    view,
    viewProvided: {
      // `expanded: []` is a VALUE — a map the user deliberately collapsed. Only an
      // absent key means "this document has no opinion".
      expanded: doc.view?.expanded !== undefined,
      positions: doc.view?.positions !== undefined,
      viewport: doc.view?.viewport !== undefined,
    },
    warnings: allWarnings,
    readOnly,
  };
}

export interface RefreshResult {
  loaded: LoadedDoc;
  loss: LossReport;
}

/**
 * Re-extract on a newer commit and KEEP MY LAYOUT. Positions and expansion for
 * ids that no longer exist are dropped — deliberately, and reported.
 *
 * The layout is carried across by node id, which is stable while the path holds
 * (§5.1). A renamed file is a new id and loses its position; that is a stated limit.
 */
export function refresh(
  text: string,
  previous: { model: GraphModel; view: ViewState },
  limits: Limits = DEFAULT_LIMITS,
): RefreshResult {
  const fresh = importDoc(text, limits);
  const model = fresh.model;

  const droppedPositions: NodeId[] = [];
  const positions = new Map<NodeId, Position>();
  for (const [id, p] of previous.view.positions) {
    if (model.nodeById.has(id)) positions.set(id, p);
    else droppedPositions.push(id);
  }
  // A position the NEW document ships for a node the user never moved is still
  // useful; the user's own position wins where both exist.
  for (const [id, p] of fresh.view.positions) {
    if (!positions.has(id) && model.nodeById.has(id)) positions.set(id, p);
  }

  const droppedExpanded: NodeId[] = [];
  const expanded = new Set<NodeId>();
  for (const id of previous.view.expanded) {
    if (model.nodeById.has(id)) expanded.add(id);
    else droppedExpanded.push(id);
  }

  // `fitted` is dropped + reported on refresh, exactly like positions/expanded: a
  // container that no longer exists cannot stay fitted (§3.5 — refresh reports loss).
  const droppedFitted: NodeId[] = [];
  const fitted = new Set<NodeId>();
  for (const id of previous.view.fitted) {
    if (model.nodeById.has(id)) fitted.add(id);
    else droppedFitted.push(id);
  }

  // Focus marks are dropped + reported on refresh, like positions/expanded/fitted.
  // The difference is what the loss MEANS: a dropped position costs a layout that
  // auto-layout re-derives, while nothing in this system can re-derive an attention
  // decision. That is why §8.5 requires `droppedFocus` to reach the loss BANNER and
  // not merely the report object — `droppedFitted` has been in `LossReport` since #13
  // and printed by nothing, and under follow-file this refresh fires unattended.
  const droppedFocus: NodeId[] = [];
  const marks = new Map<NodeId, FocusMark>();
  for (const [id, mark] of previous.view.focus.marks) {
    if (model.nodeById.has(id)) marks.set(id, mark);
    else droppedFocus.push(id);
  }

  const newNodes = model.nodes.filter((n) => !previous.model.nodeById.has(n.id)).map((n) => n.id);
  const reparented = model.nodes
    .filter((n) => {
      const before = previous.model.nodeById.get(n.id);
      return before !== undefined && before.parentId !== n.parentId;
    })
    .map((n) => n.id);

  const loaded: LoadedDoc = {
    raw: fresh.raw,
    model,
    view: {
      expanded,
      positions,
      fitted,
      // `transparency` carries unchanged: it is a preference about how to look, not a
      // fact about the graph, so a re-extraction has nothing to say about it.
      focus: { marks, transparency: previous.view.focus.transparency },
      viewport: previous.view.viewport,
    },
    // The view carried across from the previous session is AUTHORITATIVE, even when
    // it is empty. `refresh` must never re-open a map the user had collapsed.
    viewProvided: { expanded: true, positions: true, viewport: true },
    warnings: fresh.warnings.filter(
      (w) => w.code !== 'stale-position' && w.code !== 'stale-expanded' && w.code !== 'stale-fitted',
    ),
    readOnly: fresh.readOnly,
  };

  return {
    loaded,
    loss: {
      droppedPositions: droppedPositions.sort(),
      droppedExpanded: droppedExpanded.sort(),
      droppedFitted: droppedFitted.sort(),
      droppedFocus: droppedFocus.sort(),
      newNodes: [...newNodes].sort(),
      reparented: [...reparented].sort(),
    },
  };
}
