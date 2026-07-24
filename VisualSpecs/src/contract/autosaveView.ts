import { SchemaError } from './errors.ts';
import { DEFAULT_LIMITS, type Limits } from './limits.ts';
import { canonicalStringify, isJsonObject, parseJson, scanJson } from './json.ts';
import type { JsonObject, JsonValue, NodeId, Position, VisualSpecsView, Viewport } from './types.ts';
import { isDocRevision, type DocRevision } from './revision.ts';

export const AUTOSAVE_VIEW_SCHEMA = 'visual-specs.autosave-view';
export const AUTOSAVE_VIEW_FORMAT_VERSION = '1.0';

export interface VisualSpecsAutosaveViewV1 {
  schema: typeof AUTOSAVE_VIEW_SCHEMA;
  formatVersion: typeof AUTOSAVE_VIEW_FORMAT_VERSION;
  projectId: string;
  docId: string;
  baseRevision: DocRevision;
  savedAtUtc: string;
  view: VisualSpecsView;
}

export function parseAutosaveView(
  text: string,
  limits: Limits = DEFAULT_LIMITS,
): VisualSpecsAutosaveViewV1 {
  const raw = parseJson(text, limits);
  const scan = scanJson(raw, limits);
  if (scan.dangerousKeyPaths.length > 0) {
    throw new SchemaError(
      scan.dangerousKeyPaths.map((p) => `dangerous key at ${p} (prototype pollution)`),
    );
  }
  if (scan.nonFinitePaths.length > 0) {
    throw new SchemaError(scan.nonFinitePaths.map((p) => `non-finite number at ${p}`));
  }
  if (scan.oversizedStringPaths.length > 0) {
    throw new SchemaError(
      scan.oversizedStringPaths.map((p) => `string at ${p} is longer than the cap`),
    );
  }
  if (!isJsonObject(raw)) throw new SchemaError(['autosave-view root is not an object']);

  const problems: string[] = [];
  if (raw['schema'] !== AUTOSAVE_VIEW_SCHEMA) {
    problems.push(`schema must be ${AUTOSAVE_VIEW_SCHEMA}`);
  }
  if (raw['formatVersion'] !== AUTOSAVE_VIEW_FORMAT_VERSION) {
    problems.push(`formatVersion must be ${AUTOSAVE_VIEW_FORMAT_VERSION}`);
  }
  const projectId = stringField(raw, 'projectId', problems);
  const docId = stringField(raw, 'docId', problems);
  const baseRevisionValue = raw['baseRevision'];
  const baseRevision = isDocRevision(baseRevisionValue) ? baseRevisionValue : null;
  if (baseRevision === null) problems.push('baseRevision must be sha256:<64 lowercase hex>');
  const savedAtUtc = stringField(raw, 'savedAtUtc', problems);
  if (savedAtUtc !== null && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(savedAtUtc)) {
    problems.push('savedAtUtc must be an ISO UTC timestamp');
  }
  const view = parseView(raw['view'], limits, problems);

  if (problems.length > 0) throw new SchemaError(problems);
  if (projectId === null || docId === null || baseRevision === null || savedAtUtc === null || view === null) {
    throw new SchemaError(['autosave-view is incomplete']);
  }
  return {
    schema: AUTOSAVE_VIEW_SCHEMA,
    formatVersion: AUTOSAVE_VIEW_FORMAT_VERSION,
    projectId,
    docId,
    baseRevision,
    savedAtUtc,
    view,
  };
}

export function autosaveViewText(input: VisualSpecsAutosaveViewV1): string {
  return canonicalStringify({
    schema: AUTOSAVE_VIEW_SCHEMA,
    formatVersion: AUTOSAVE_VIEW_FORMAT_VERSION,
    projectId: input.projectId,
    docId: input.docId,
    baseRevision: input.baseRevision,
    savedAtUtc: input.savedAtUtc,
    view: viewToJson(input.view),
  });
}

export function autosaveMatches(
  autosave: VisualSpecsAutosaveViewV1,
  current: { projectId: string; docId: string; revision: DocRevision },
): boolean {
  return (
    autosave.projectId === current.projectId &&
    autosave.docId === current.docId &&
    autosave.baseRevision === current.revision
  );
}

export function viewToJson(view: VisualSpecsView): JsonObject {
  const out: JsonObject = Object.create(null) as JsonObject;
  if (view.positions !== undefined) {
    const positions: JsonObject = Object.create(null) as JsonObject;
    for (const id of Object.keys(view.positions).sort()) {
      const p = view.positions[id];
      if (p === undefined) continue;
      positions[id] = p.pinned === true ? { x: p.x, y: p.y, pinned: true } : { x: p.x, y: p.y };
    }
    out['positions'] = positions;
  }
  if (view.expanded !== undefined) out['expanded'] = [...view.expanded].sort();
  if (view.fitted !== undefined) out['fitted'] = [...view.fitted].sort();
  if (view.viewport !== undefined) {
    out['viewport'] = {
      x: view.viewport.x,
      y: view.viewport.y,
      zoom: view.viewport.zoom,
    };
  }
  return out;
}

function parseView(
  value: JsonValue | undefined,
  limits: Limits,
  problems: string[],
): VisualSpecsView | null {
  if (!isJsonObject(value)) {
    problems.push('view is missing or is not an object');
    return null;
  }
  const view: VisualSpecsView = {};
  const positions = parsePositions(value['positions'], limits, problems);
  const expanded = parseExpanded(value['expanded'], problems);
  const fitted = parseFitted(value['fitted'], problems);
  const viewport = parseViewport(value['viewport'], limits, problems);
  if (positions !== undefined) view.positions = positions;
  if (expanded !== undefined) view.expanded = expanded;
  if (fitted !== undefined) view.fitted = fitted;
  if (viewport !== undefined) view.viewport = viewport;
  return view;
}

function parsePositions(
  value: JsonValue | undefined,
  limits: Limits,
  problems: string[],
): Record<NodeId, Position> | undefined {
  if (value === undefined) return undefined;
  if (!isJsonObject(value)) {
    problems.push('view.positions is not an object');
    return undefined;
  }
  const out: Record<NodeId, Position> = Object.create(null) as Record<NodeId, Position>;
  for (const id of Object.keys(value)) {
    const p = value[id];
    if (!isJsonObject(p)) {
      problems.push(`view.positions["${id}"] is not an object`);
      continue;
    }
    const x = p['x'];
    const y = p['y'];
    if (typeof x !== 'number' || !Number.isFinite(x) || Math.abs(x) > limits.maxCoordinate) {
      problems.push(`view.positions["${id}"].x is outside the coordinate cap`);
      continue;
    }
    if (typeof y !== 'number' || !Number.isFinite(y) || Math.abs(y) > limits.maxCoordinate) {
      problems.push(`view.positions["${id}"].y is outside the coordinate cap`);
      continue;
    }
    const pos: Position = { x, y };
    const pinned = p['pinned'];
    if (pinned !== undefined) {
      if (typeof pinned !== 'boolean') problems.push(`view.positions["${id}"].pinned is not a boolean`);
      else pos.pinned = pinned;
    }
    out[id] = pos;
  }
  return out;
}

function parseExpanded(value: JsonValue | undefined, problems: string[]): NodeId[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    problems.push('view.expanded is not an array of strings');
    return undefined;
  }
  return value;
}

function parseFitted(value: JsonValue | undefined, problems: string[]): NodeId[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    problems.push('view.fitted is not an array of strings');
    return undefined;
  }
  return value;
}

function parseViewport(
  value: JsonValue | undefined,
  limits: Limits,
  problems: string[],
): Viewport | undefined {
  if (value === undefined) return undefined;
  if (!isJsonObject(value)) {
    problems.push('view.viewport is not an object');
    return undefined;
  }
  const x = value['x'];
  const y = value['y'];
  const zoom = value['zoom'];
  const okX = typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= limits.maxCoordinate;
  const okY = typeof y === 'number' && Number.isFinite(y) && Math.abs(y) <= limits.maxCoordinate;
  const okZoom =
    typeof zoom === 'number' &&
    Number.isFinite(zoom) &&
    zoom >= limits.minZoom &&
    zoom <= limits.maxZoom;
  if (!okX) problems.push('view.viewport.x is outside the coordinate cap');
  if (!okY) problems.push('view.viewport.y is outside the coordinate cap');
  if (!okZoom) problems.push('view.viewport.zoom is outside the zoom cap');
  return okX && okY && okZoom ? { x, y, zoom } : undefined;
}

function stringField(object: JsonObject, key: string, problems: string[]): string | null {
  const value = object[key];
  if (typeof value !== 'string' || value === '') {
    problems.push(`${key} must be a non-empty string`);
    return null;
  }
  return value;
}
