// One definition of a valid document, used by the app on import AND by the
// extractor on emit (§10). Shape only — never vocabulary (§3.7).

import type {
  Confidence,
  Coverage,
  Evidence,
  FocusMarkToken,
  VisualSpecsFocus,
  VisualSpecsDoc,
  VisualSpecsEdge,
  VisualSpecsNode,
  VisualSpecsView,
  JsonObject,
  JsonValue,
  Unresolved,
  Warning,
} from './types.ts';
import { DEFAULT_LIMITS, type Limits } from './limits.ts';
import { IncompatibleVersionError, IntegrityError, SchemaError } from './errors.ts';
import { isJsonObject, scanJson, type ScanResult } from './json.ts';
import { checkRelativePath, checkSourceRoot, describePathProblem } from './paths.ts';

export const SUPPORTED_MAJOR = 1;
// 1.1 adds `view.fitted` (Issue #13): additive and optional, read by this build.
// 1.2 adds `view.focus` (Issue #17): likewise.
// Fresh extracts still emit 1.0; a doc becomes 1.1 or 1.2 only when it carries the
// corresponding state (see export.ts `raiseFormatVersion`).
export const SUPPORTED_MINOR = 2;
export const SUPPORTED_VERSION = `${SUPPORTED_MAJOR}.${SUPPORTED_MINOR}`;

/** Optional capabilities this build can honour. v1 declares none, so ANY entry in
 *  `requires[]` is unknown and opens the document read-only (§3.4). */
export const KNOWN_REQUIREMENTS: readonly string[] = [];

const CONFIDENCES: readonly string[] = ['declared', 'resolved', 'heuristic'];
const COVERAGE_STATUSES: readonly string[] = ['available', 'degraded', 'unavailable'];

export interface ValidationResult {
  doc: VisualSpecsDoc;
  warnings: Warning[];
  /** `requires[]` carries something this build does not understand: render, never write. */
  readOnly: boolean;
}

/** Validate an already-parsed, already-scanned tree. */
export function validate(
  raw: JsonValue,
  limits: Limits = DEFAULT_LIMITS,
  scan?: ScanResult,
): ValidationResult {
  const s = scan ?? scanJson(raw, limits);
  const warnings: Warning[] = [];
  const problems: string[] = [];

  // --- Caps and hostile shapes, before anything is indexed (§11). -----------
  if (s.dangerousKeyPaths.length > 0) {
    // The one place forward-compatibility yields to safety. Hard rejection.
    throw new SchemaError(
      s.dangerousKeyPaths.map((p) => `dangerous key at ${p} (prototype pollution)`),
    );
  }
  if (s.nonFinitePaths.length > 0) {
    throw new SchemaError(
      s.nonFinitePaths.map(
        (p) => `non-finite number at ${p}; JSON cannot represent it and it cannot round-trip`,
      ),
    );
  }
  if (s.oversizedStringPaths.length > 0) {
    throw new SchemaError(
      s.oversizedStringPaths.map(
        (p) => `string at ${p} is longer than the ${limits.maxStringLength} character cap`,
      ),
    );
  }

  if (!isJsonObject(raw)) throw new SchemaError(['the document root is not a JSON object']);

  // --- Version (§3.4) ------------------------------------------------------
  const formatVersion = raw['formatVersion'];
  if (typeof formatVersion !== 'string') {
    throw new SchemaError(['formatVersion is missing or is not a string']);
  }
  const parsedVersion = parseVersion(formatVersion);
  if (parsedVersion === null) {
    throw new SchemaError([`formatVersion "${formatVersion}" is not of the form MAJOR.MINOR`]);
  }
  if (parsedVersion.major !== SUPPORTED_MAJOR) {
    throw new IncompatibleVersionError(formatVersion, String(SUPPORTED_MAJOR));
  }
  if (parsedVersion.minor > SUPPORTED_MINOR) {
    // Every minor within a major is additive and optional, so this is safe —
    // and the raw envelope means the extensions survive an export untouched.
    warnings.push({
      code: 'unknown-minor',
      message:
        `This document declares formatVersion ${formatVersion}; this build knows ${SUPPORTED_VERSION}. ` +
        `Unknown fields are preserved verbatim on export.`,
    });
  }

  let readOnly = false;
  const requires = raw['requires'];
  if (requires !== undefined) {
    if (!isStringArray(requires)) {
      problems.push('requires must be an array of strings');
    } else {
      const unknown = requires.filter((r) => !KNOWN_REQUIREMENTS.includes(r));
      if (unknown.length > 0) {
        readOnly = true;
        warnings.push({
          code: 'read-only',
          message:
            `This document requires ${unknown.join(', ')}, which this build does not implement. ` +
            `It is open read-only: a reader that cannot honour a declared requirement must not write it back.`,
          requires: unknown,
        });
      }
    }
  }

  // --- Nodes and edges -----------------------------------------------------
  const rawNodes = raw['nodes'];
  const rawEdges = raw['edges'];
  if (!Array.isArray(rawNodes)) problems.push('nodes is missing or is not an array');
  if (!Array.isArray(rawEdges)) problems.push('edges is missing or is not an array');
  if (problems.length > 0) throw new SchemaError(problems);

  const nodeArray = rawNodes as JsonValue[];
  const edgeArray = rawEdges as JsonValue[];

  if (nodeArray.length > limits.maxNodes) {
    throw new SchemaError([`document has ${nodeArray.length} nodes, over the ${limits.maxNodes} cap`]);
  }
  if (edgeArray.length > limits.maxEdges) {
    throw new SchemaError([`document has ${edgeArray.length} edges, over the ${limits.maxEdges} cap`]);
  }

  const nodes: VisualSpecsNode[] = [];
  nodeArray.forEach((value, i) => {
    const node = validateNode(value, i, limits, problems);
    if (node !== null) nodes.push(node);
  });

  const edges: VisualSpecsEdge[] = [];
  edgeArray.forEach((value, i) => {
    const edge = validateEdge(value, i, limits, problems);
    if (edge !== null) edges.push(edge);
  });

  const coverage = validateCoverage(raw['coverage'], problems);
  const unresolved = validateUnresolved(raw['unresolved'], limits, problems);
  // The declared minor is threaded in because §5.4's repair rules are CONDITIONAL on
  // it: at or below what this build knows, an unrecognised value is a problem; above
  // it, the same value is a warning and is preserved verbatim on export. Without the
  // condition a 1.3 document would fail to open while `validate` was simultaneously
  // telling the user "unknown fields are preserved verbatim on export".
  const view = validateView(raw['view'], limits, problems, parsedVersion.minor, warnings);
  const source = validateSource(raw['source'], problems);
  const generator = validateGenerator(raw['generator'], problems);

  if (problems.length > 0) throw new SchemaError(problems);

  // --- Integrity (I1–I4): a valid shape can still be a broken graph. -------
  checkIntegrity(nodes, edges);

  // --- Warnings the user is owed (§11) -------------------------------------
  for (const hit of s.absolutePathLike) {
    warnings.push({
      code: 'absolute-path-in-free-form-field',
      message: `${hit.where} looks like an absolute path ("${truncate(hit.value, 60)}"). Free-form fields are never rewritten, only reported.`,
      where: hit.where,
    });
  }
  const snippetCount = countSnippets(nodes, edges, unresolved);
  if (snippetCount > 0) {
    warnings.push({
      code: 'snippet-present',
      message: `This document carries ${snippetCount} verbatim source snippets. They may contain secrets copied out of the repository.`,
      count: snippetCount,
    });
  }

  const doc: VisualSpecsDoc = {
    formatVersion,
    nodes,
    edges,
  };
  if (isStringArray(requires)) doc.requires = requires;
  if (generator !== undefined) doc.generator = generator;
  if (source !== undefined) doc.source = source;
  if (coverage !== undefined) doc.coverage = coverage;
  if (unresolved !== undefined) doc.unresolved = unresolved;
  if (view !== undefined) doc.view = view;
  if (isJsonObject(raw['stats'])) doc.stats = raw['stats'];

  return { doc, warnings, readOnly };
}

// ---------------------------------------------------------------------------

function parseVersion(v: string): { major: number; minor: number } | null {
  const m = /^(\d+)\.(\d+)$/.exec(v);
  if (m === null) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) return null;
  return { major, minor };
}

function isStringArray(v: JsonValue | undefined): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

function validateNode(
  value: JsonValue,
  index: number,
  limits: Limits,
  problems: string[],
): VisualSpecsNode | null {
  const at = `nodes[${index}]`;
  if (!isJsonObject(value)) {
    problems.push(`${at} is not an object`);
    return null;
  }
  const id = value['id'];
  const kind = value['kind'];
  const label = value['label'];
  const parentId = value['parentId'];

  let ok = true;
  if (typeof id !== 'string' || id === '') {
    problems.push(`${at}.id is missing or empty`);
    ok = false;
  }
  if (typeof kind !== 'string' || kind === '') {
    problems.push(`${at}.kind is missing or empty`);
    ok = false;
  }
  if (typeof label !== 'string') {
    problems.push(`${at}.label is missing or is not a string`);
    ok = false;
  }
  if (!(parentId === null || typeof parentId === 'string')) {
    problems.push(`${at}.parentId must be a node id or null`);
    ok = false;
  }
  if (!ok) return null;

  const metadata = value['metadata'];
  if (metadata !== undefined && !isJsonObject(metadata)) {
    problems.push(`${at}.metadata is not an object`);
    return null;
  }

  const node: VisualSpecsNode = {
    id: id as string,
    kind: kind as string,
    label: label as string,
    parentId: parentId as string | null,
  };
  if (metadata !== undefined) node.metadata = metadata as Record<string, unknown>;

  const path = value['path'];
  if (path !== undefined) {
    if (typeof path !== 'string') {
      problems.push(`${at}.path is not a string`);
    } else {
      // The empty path means "the repository root directory". It is legal only
      // for a root node or a manifest anchored at the repository root — which
      // the node must DECLARE, so the validator never has to guess (§3.1).
      const isRoot = node.parentId === null;
      const isRootAnchor =
        isJsonObject(metadata) && (metadata as JsonObject)['rootAnchor'] === true;
      const problem = checkRelativePath(path, isRoot || isRootAnchor);
      if (problem === 'empty') {
        problems.push(
          `${at}.path is empty, but ${node.id} is neither a root nor declared with metadata.rootAnchor: true`,
        );
      } else if (problem !== null) {
        problems.push(`${at}.path ${describePathProblem(problem)}: "${truncate(path, 60)}"`);
      } else {
        node.path = path;
      }
    }
  }

  const evidence = validateEvidenceArray(value['evidence'], `${at}.evidence`, limits, problems);
  if (evidence !== undefined) node.evidence = evidence;

  return node;
}

function validateEdge(
  value: JsonValue,
  index: number,
  limits: Limits,
  problems: string[],
): VisualSpecsEdge | null {
  const at = `edges[${index}]`;
  if (!isJsonObject(value)) {
    problems.push(`${at} is not an object`);
    return null;
  }
  const id = value['id'];
  const kind = value['kind'];
  const sourceId = value['sourceId'];
  const targetId = value['targetId'];
  const confidence = value['confidence'];

  let ok = true;
  if (typeof id !== 'string' || id === '') {
    problems.push(`${at}.id is missing or empty`);
    ok = false;
  }
  if (typeof kind !== 'string' || kind === '') {
    problems.push(`${at}.kind is missing or empty`);
    ok = false;
  }
  if (typeof sourceId !== 'string' || sourceId === '') {
    problems.push(`${at}.sourceId is missing or empty`);
    ok = false;
  }
  if (typeof targetId !== 'string' || targetId === '') {
    problems.push(`${at}.targetId is missing or empty`);
    ok = false;
  }
  if (typeof confidence !== 'string' || !CONFIDENCES.includes(confidence)) {
    problems.push(`${at}.confidence must be one of ${CONFIDENCES.join(' | ')}`);
    ok = false;
  }
  if (!ok) return null;

  const metadata = value['metadata'];
  if (metadata !== undefined && !isJsonObject(metadata)) {
    problems.push(`${at}.metadata is not an object`);
    return null;
  }

  const edge: VisualSpecsEdge = {
    id: id as string,
    kind: kind as string,
    sourceId: sourceId as string,
    targetId: targetId as string,
    confidence: confidence as Confidence,
  };
  const label = value['label'];
  if (label !== undefined) {
    if (typeof label !== 'string') problems.push(`${at}.label is not a string`);
    else edge.label = label;
  }
  if (metadata !== undefined) edge.metadata = metadata as Record<string, unknown>;

  const evidence = validateEvidenceArray(value['evidence'], `${at}.evidence`, limits, problems);
  if (evidence !== undefined) edge.evidence = evidence;

  return edge;
}

function validateEvidenceArray(
  value: JsonValue | undefined,
  at: string,
  limits: Limits,
  problems: string[],
): Evidence[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    problems.push(`${at} is not an array`);
    return undefined;
  }
  if (value.length > limits.maxEvidencePerItem) {
    problems.push(`${at} has ${value.length} entries, over the ${limits.maxEvidencePerItem} cap`);
    return undefined;
  }
  const out: Evidence[] = [];
  value.forEach((item, i) => {
    const itemAt = `${at}[${i}]`;
    if (!isJsonObject(item)) {
      problems.push(`${itemAt} is not an object`);
      return;
    }
    const path = item['path'];
    if (typeof path !== 'string') {
      problems.push(`${itemAt}.path is missing or is not a string`);
      return;
    }
    const problem = checkRelativePath(path, false);
    if (problem !== null) {
      problems.push(`${itemAt}.path ${describePathProblem(problem)}: "${truncate(path, 60)}"`);
      return;
    }
    const ev: Evidence = { path };
    const line = item['line'];
    if (line !== undefined) {
      if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) {
        problems.push(`${itemAt}.line must be a 1-based integer`);
      } else {
        ev.line = line;
      }
    }
    const snippet = item['snippet'];
    if (snippet !== undefined) {
      if (typeof snippet !== 'string') problems.push(`${itemAt}.snippet is not a string`);
      else ev.snippet = snippet;
    }
    const note = item['note'];
    if (note !== undefined) {
      if (typeof note !== 'string') problems.push(`${itemAt}.note is not a string`);
      else ev.note = note;
    }
    out.push(ev);
  });
  return out;
}

function validateCoverage(value: JsonValue | undefined, problems: string[]): Coverage[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    problems.push('coverage is not an array');
    return undefined;
  }
  const out: Coverage[] = [];
  value.forEach((item, i) => {
    const at = `coverage[${i}]`;
    if (!isJsonObject(item)) {
      problems.push(`${at} is not an object`);
      return;
    }
    const kind = item['kind'];
    const status = item['status'];
    const emitted = item['emitted'];
    const unresolved = item['unresolved'];
    if (typeof kind !== 'string' || kind === '') {
      problems.push(`${at}.kind is missing`);
      return;
    }
    if (typeof status !== 'string' || !COVERAGE_STATUSES.includes(status)) {
      problems.push(`${at}.status must be one of ${COVERAGE_STATUSES.join(' | ')}`);
      return;
    }
    if (typeof emitted !== 'number' || !Number.isInteger(emitted) || emitted < 0) {
      problems.push(`${at}.emitted must be a non-negative integer`);
      return;
    }
    if (typeof unresolved !== 'number' || !Number.isInteger(unresolved) || unresolved < 0) {
      problems.push(`${at}.unresolved must be a non-negative integer`);
      return;
    }
    const cov: Coverage = {
      kind,
      status: status as Coverage['status'],
      emitted,
      unresolved,
    };
    const reason = item['reason'];
    if (reason !== undefined) {
      if (typeof reason !== 'string') problems.push(`${at}.reason is not a string`);
      else cov.reason = reason;
    }
    out.push(cov);
  });
  return out;
}

function validateUnresolved(
  value: JsonValue | undefined,
  limits: Limits,
  problems: string[],
): Unresolved[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    problems.push('unresolved is not an array');
    return undefined;
  }
  const out: Unresolved[] = [];
  value.forEach((item, i) => {
    const at = `unresolved[${i}]`;
    if (!isJsonObject(item)) {
      problems.push(`${at} is not an object`);
      return;
    }
    const kind = item['kind'];
    const reason = item['reason'];
    if (typeof kind !== 'string' || kind === '') {
      problems.push(`${at}.kind is missing`);
      return;
    }
    if (typeof reason !== 'string' || reason === '') {
      problems.push(`${at}.reason is missing`);
      return;
    }
    const evidence = validateEvidenceArray(item['evidence'], `${at}.evidence`, limits, problems);
    if (evidence === undefined) {
      problems.push(`${at}.evidence is required: an unresolved item without evidence is a rumour`);
      return;
    }
    const u: Unresolved = { kind, reason, evidence };
    const detail = item['detail'];
    if (detail !== undefined) {
      if (!isJsonObject(detail)) problems.push(`${at}.detail is not an object`);
      else u.detail = detail as Record<string, unknown>;
    }
    out.push(u);
  });
  return out;
}

function validateView(
  value: JsonValue | undefined,
  limits: Limits,
  problems: string[],
  declaredMinor: number,
  warnings: Warning[],
): VisualSpecsView | undefined {
  if (value === undefined) return undefined;
  if (!isJsonObject(value)) {
    problems.push('view is not an object');
    return undefined;
  }
  const view: VisualSpecsView = {};

  const positions = value['positions'];
  if (positions !== undefined) {
    if (!isJsonObject(positions)) {
      problems.push('view.positions is not an object');
    } else {
      const out: Record<string, { x: number; y: number; pinned?: boolean }> = Object.create(
        null,
      ) as Record<string, { x: number; y: number; pinned?: boolean }>;
      for (const id of Object.keys(positions)) {
        const at = `view.positions["${id}"]`;
        const p = positions[id];
        if (!isJsonObject(p)) {
          problems.push(`${at} is not an object`);
          continue;
        }
        const x = p['x'];
        const y = p['y'];
        // I11: 1e400 parses to Infinity and destroys a layout. scanJson has
        // already rejected non-finite numbers document-wide; bounds are checked here.
        if (typeof x !== 'number' || !Number.isFinite(x) || Math.abs(x) > limits.maxCoordinate) {
          problems.push(`${at}.x must be a finite number within ±${limits.maxCoordinate}`);
          continue;
        }
        if (typeof y !== 'number' || !Number.isFinite(y) || Math.abs(y) > limits.maxCoordinate) {
          problems.push(`${at}.y must be a finite number within ±${limits.maxCoordinate}`);
          continue;
        }
        const pos: { x: number; y: number; pinned?: boolean } = { x, y };
        const pinned = p['pinned'];
        if (pinned !== undefined) {
          if (typeof pinned !== 'boolean') problems.push(`${at}.pinned is not a boolean`);
          else pos.pinned = pinned;
        }
        out[id] = pos;
      }
      view.positions = out;
    }
  }

  const expanded = value['expanded'];
  if (expanded !== undefined) {
    if (!isStringArray(expanded)) problems.push('view.expanded is not an array of node ids');
    else view.expanded = expanded;
  }

  const fitted = value['fitted'];
  if (fitted !== undefined) {
    if (!isStringArray(fitted)) problems.push('view.fitted is not an array of node ids');
    else view.fitted = fitted;
  }

  const focus = value['focus'];
  if (focus !== undefined) {
    if (!isJsonObject(focus)) {
      problems.push('view.focus is not an object');
    } else {
      const out: VisualSpecsFocus = {};

      // `transparency` is CLAMPED on load rather than rejected (see load.ts), so an
      // out-of-band value is not a problem here. Only a non-integer is, and only at a
      // minor this build knows: above that, a widened band in a newer minor is not
      // this build's business to reject.
      const transparency = focus['transparency'];
      if (transparency !== undefined) {
        if (typeof transparency !== 'number' || !Number.isInteger(transparency)) {
          problems.push('view.focus.transparency is not an integer');
        } else {
          out.transparency = transparency;
        }
      }

      const marks = focus['marks'];
      if (marks !== undefined) {
        if (!isJsonObject(marks)) {
          problems.push('view.focus.marks is not an object');
        } else {
          const ids = Object.keys(marks);
          if (ids.length > limits.maxFocusMarks) {
            problems.push(
              `view.focus.marks has ${ids.length} entries, over the ${limits.maxFocusMarks} cap`,
            );
          } else {
            const accepted: Record<string, FocusMarkToken> = Object.create(null) as Record<
              string,
              FocusMarkToken
            >;
            let unknownTokens = 0;
            for (const id of ids) {
              // `scanJson` bounds string VALUES, never object KEYS, so without this an
              // arbitrarily long id parses cleanly and is then rendered as sidebar row
              // text for an inert mark. Not an injection risk — `el()` reaches the DOM
              // only through `createTextNode` — but a layout hazard on a new surface.
              if (id.length > limits.maxFocusMarkKeyLength) {
                problems.push(
                  `view.focus.marks has a key longer than ${limits.maxFocusMarkKeyLength} characters`,
                );
                continue;
              }
              const mark = marks[id];
              if (mark === 'out-of-focus' || mark === 'in-focus') {
                accepted[id] = mark;
                continue;
              }
              if (declaredMinor > SUPPORTED_MINOR) {
                // A newer minor may extend the value domain of this known key. The
                // additive-minor contract has to hold on the one axis this shape
                // extends, or the object map costs more than it was argued to: the
                // entry is ignored for resolution and preserved verbatim on export
                // through the raw envelope (see export.ts `mergeView`).
                unknownTokens += 1;
                continue;
              }
              problems.push(
                `view.focus.marks["${id}"] must be "out-of-focus" or "in-focus"`,
              );
            }
            if (unknownTokens > 0) {
              warnings.push({
                code: 'unknown-focus-mark',
                message:
                  `${unknownTokens} focus mark(s) use a value this build does not know. ` +
                  `They are ignored when deciding what is dimmed, and preserved unchanged on export.`,
                count: unknownTokens,
              });
            }
            out.marks = accepted;
          }
        }
      }

      view.focus = out;
    }
  }

  const viewport = value['viewport'];
  if (viewport !== undefined) {
    if (!isJsonObject(viewport)) {
      problems.push('view.viewport is not an object');
    } else {
      const x = viewport['x'];
      const y = viewport['y'];
      const zoom = viewport['zoom'];
      const okX = typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= limits.maxCoordinate;
      const okY = typeof y === 'number' && Number.isFinite(y) && Math.abs(y) <= limits.maxCoordinate;
      const okZoom =
        typeof zoom === 'number' &&
        Number.isFinite(zoom) &&
        zoom >= limits.minZoom &&
        zoom <= limits.maxZoom;
      if (!okX) problems.push(`view.viewport.x must be a finite number within ±${limits.maxCoordinate}`);
      if (!okY) problems.push(`view.viewport.y must be a finite number within ±${limits.maxCoordinate}`);
      if (!okZoom) {
        problems.push(
          `view.viewport.zoom must be a finite number in [${limits.minZoom}, ${limits.maxZoom}]`,
        );
      }
      if (okX && okY && okZoom) {
        view.viewport = { x: x as number, y: y as number, zoom: zoom as number };
      }
    }
  }

  return view;
}

function validateSource(value: JsonValue | undefined, problems: string[]): VisualSpecsDoc['source'] {
  if (value === undefined) return undefined;
  if (!isJsonObject(value)) {
    problems.push('source is not an object');
    return undefined;
  }
  const kind = value['kind'];
  const root = value['root'];
  if (typeof kind !== 'string') {
    problems.push('source.kind is missing or is not a string');
    return undefined;
  }
  if (typeof root !== 'string') {
    problems.push('source.root is missing or is not a string');
    return undefined;
  }
  const problem = checkSourceRoot(root);
  if (problem !== null) {
    problems.push(`source.root must be a plain basename; it ${describePathProblem(problem)}`);
    return undefined;
  }
  const out: VisualSpecsDoc['source'] = { kind, root };
  const commit = value['commit'];
  if (commit !== undefined) {
    if (typeof commit !== 'string') problems.push('source.commit is not a string');
    else out.commit = commit;
  }
  const dirty = value['dirty'];
  if (dirty !== undefined) {
    if (typeof dirty !== 'boolean') problems.push('source.dirty is not a boolean');
    else out.dirty = dirty;
  }
  return out;
}

function validateGenerator(value: JsonValue | undefined, problems: string[]): VisualSpecsDoc['generator'] {
  if (value === undefined) return undefined;
  if (!isJsonObject(value)) {
    problems.push('generator is not an object');
    return undefined;
  }
  const name = value['name'];
  const version = value['version'];
  if (typeof name !== 'string') {
    problems.push('generator.name is missing or is not a string');
    return undefined;
  }
  if (typeof version !== 'string') {
    problems.push('generator.version is missing or is not a string');
    return undefined;
  }
  const out: VisualSpecsDoc['generator'] = { name, version };
  const flags = value['flags'];
  if (flags !== undefined) {
    if (!isStringArray(flags)) problems.push('generator.flags is not an array of strings');
    else out.flags = flags;
  }
  for (const key of ['configDigest', 'generatedAt'] as const) {
    const v = value[key];
    if (v === undefined) continue;
    if (typeof v !== 'string') problems.push(`generator.${key} is not a string`);
    else out[key] = v;
  }
  return out;
}

function countSnippets(
  nodes: readonly VisualSpecsNode[],
  edges: readonly VisualSpecsEdge[],
  unresolved: readonly Unresolved[] | undefined,
): number {
  let n = 0;
  const count = (evidence: readonly Evidence[] | undefined): void => {
    if (evidence === undefined) return;
    for (const e of evidence) if (e.snippet !== undefined) n += 1;
  };
  for (const node of nodes) count(node.evidence);
  for (const edge of edges) count(edge.evidence);
  if (unresolved !== undefined) for (const u of unresolved) count(u.evidence);
  return n;
}

/** I1–I4: the graph must be well formed, or projection has no meaning. */
export function checkIntegrity(nodes: readonly VisualSpecsNode[], edges: readonly VisualSpecsEdge[]): void {
  const problems: string[] = [];

  // I1 — unique ids.
  const byId = new Map<string, VisualSpecsNode>();
  const dupNodes: string[] = [];
  for (const n of nodes) {
    if (byId.has(n.id)) dupNodes.push(n.id);
    else byId.set(n.id, n);
  }
  if (dupNodes.length > 0) problems.push(`duplicate node ids: ${list(dupNodes)}`);

  const edgeIds = new Set<string>();
  const dupEdges: string[] = [];
  for (const e of edges) {
    if (edgeIds.has(e.id)) dupEdges.push(e.id);
    else edgeIds.add(e.id);
  }
  if (dupEdges.length > 0) problems.push(`duplicate edge ids: ${list(dupEdges)}`);

  // I2 — every parentId names an existing node.
  const missingParents: string[] = [];
  for (const n of nodes) {
    if (n.parentId !== null && !byId.has(n.parentId)) missingParents.push(`${n.id} → ${n.parentId}`);
  }
  if (missingParents.length > 0) problems.push(`parentId names a node that does not exist: ${list(missingParents)}`);

  // I4 — every edge endpoint names an existing node.
  const dangling: string[] = [];
  for (const e of edges) {
    if (!byId.has(e.sourceId)) dangling.push(`${e.id} → sourceId ${e.sourceId}`);
    if (!byId.has(e.targetId)) dangling.push(`${e.id} → targetId ${e.targetId}`);
  }
  if (dangling.length > 0) problems.push(`edge endpoint names a node that does not exist: ${list(dangling)}`);

  // I3 — acyclic. Only meaningful once parents resolve, so it is checked last.
  if (missingParents.length === 0 && dupNodes.length === 0) {
    const cyclic = findCycle(nodes, byId);
    if (cyclic !== null) {
      problems.push(
        `the parent relation has a cycle (${cyclic.join(' → ')}); projection is only well defined on a tree`,
      );
    }
  }

  if (problems.length > 0) throw new IntegrityError(problems);
}

function findCycle(
  nodes: readonly VisualSpecsNode[],
  byId: ReadonlyMap<string, VisualSpecsNode>,
): string[] | null {
  // 0 = unseen, 1 = on the current chain, 2 = proven acyclic.
  const state = new Map<string, 0 | 1 | 2>();
  for (const n of nodes) state.set(n.id, 0);

  for (const start of nodes) {
    if (state.get(start.id) !== 0) continue;
    const chain: string[] = [];
    let current: VisualSpecsNode | undefined = start;
    while (current !== undefined) {
      const st = state.get(current.id);
      if (st === 1) {
        const at = chain.indexOf(current.id);
        return [...chain.slice(at), current.id];
      }
      if (st === 2) break;
      state.set(current.id, 1);
      chain.push(current.id);
      current = current.parentId === null ? undefined : byId.get(current.parentId);
    }
    for (const id of chain) state.set(id, 2);
  }
  return null;
}

function list(items: readonly string[]): string {
  const head = items.slice(0, 5).join(', ');
  return items.length > 5 ? `${head} (+${items.length - 5} more)` : head;
}
