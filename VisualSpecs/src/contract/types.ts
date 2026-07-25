// src/contract/types.ts — depends on nothing. See docs/ARCHITECTURE.md §3.1.

export type NodeId = string;
export type EdgeId = string;

/** Open vocabulary. Validation checks shape, never vocabulary. See §3.7. */
export type NodeKind = string; // 'repository' | 'application' | 'package' | 'crate' | 'directory' | 'file' | …
export type EdgeKind = string; // 'imports' | 'bundles' | 'entrypoint' | 'tauri-command' | 'web-command' | …

export type Confidence = 'declared' | 'resolved' | 'heuristic';

export interface Evidence {
  /** POSIX-relative. Validated: see §11. */
  path: string;
  /** 1-based. */
  line?: number;
  /** Verbatim source text. OFF by default; see §11. */
  snippet?: string;
  note?: string;
}

export interface VisualSpecsNode {
  id: NodeId;
  kind: NodeKind;
  label: string;
  /** Canonical OWNERSHIP placement. Exactly one. `null` only for a root. See §5. */
  parentId: NodeId | null;
  /**
   * POSIX-relative. Present for nodes backed by the filesystem.
   *
   * The empty string denotes the repository root directory and is accepted ONLY
   * for a root node (`parentId === null`) or for a node that declares
   * `metadata.rootAnchor === true` — a manifest anchored at the repository root,
   * such as the root `package.json`. Any other node carrying `path: ""` is a
   * `SchemaError`. (This resolves the erratum in the worked example of §3.2,
   * which showed `path: ""` on a package without saying what made it legal.)
   */
  path?: string;
  metadata?: Record<string, unknown>;
  evidence?: Evidence[];
}

export interface VisualSpecsEdge {
  id: EdgeId;
  kind: EdgeKind;
  sourceId: NodeId;
  targetId: NodeId;
  label?: string;
  /** 'declared'  — read straight out of a manifest.
   *  'resolved'  — an identifier was resolved to a file that provably exists.
   *  'heuristic' — pattern-matched; may be wrong. Always carries evidence. */
  confidence: Confidence;
  metadata?: Record<string, unknown>;
  evidence?: Evidence[];
}

/** Per relation family. A non-empty relation set is not automatically trustworthy. */
export interface Coverage {
  kind: EdgeKind;
  status: 'available' | 'degraded' | 'unavailable';
  /** Why it is degraded/unavailable, in plain words. */
  reason?: string;
  emitted: number;
  unresolved: number;
}

/** Something the extractor saw but refused to guess about. */
export interface Unresolved {
  kind: EdgeKind | 'node';
  reason: string;
  evidence: Evidence[];
  detail?: Record<string, unknown>;
}

export interface Position {
  x: number;
  y: number;
  /** user-placed: never auto-repacked */
  pinned?: boolean;
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export interface VisualSpecsView {
  positions?: Record<NodeId, Position>;
  expanded?: NodeId[];
  /**
   * Containers the user "fit to content" (Issue #13). Parallel to `expanded`: a set
   * of ids serialized as an array. A fitted container's size is derived from its
   * children's bounding box + a legibility floor, not the grid-pack natural. Added in
   * doc formatVersion 1.1; absent → no container is fitted (current behavior).
   */
  fitted?: NodeId[];
  /**
   * Out-of-focus state (Issue #17). Added in doc formatVersion 1.2; absent → every node
   * is in focus.
   *
   * I-F10 — NOTHING UNDER `view.*` IS EVER AN OBSERVATION. `positions`, `expanded` and
   * `fitted` are decisions about how structure is DISPLAYED; `focus.marks` is a claim
   * about where a person is LOOKING. It must never be read as a claim about the system,
   * which is why its values are spelled `"out-of-focus"` / `"in-focus"` rather than
   * `"out"` / `"in"` — a bare `"out"` on a node is one reading from "out of scope",
   * "excluded" or "dead".
   *
   * I-F9 — focus lives only here. Never in `nodes[].metadata`, `edges[].metadata`,
   * `evidence[]` or `unresolved[]`: `metadata` is a free-form record the validator
   * accepts without inspection AND the extractor regenerates on every run, so a mark
   * parked there would be indistinguishable from an observation about the code and
   * destroyed at the next extraction. A future machine suggestion about attention
   * ("auto-dim tests", "auto-dim vendor") must travel under a different, derived,
   * recomputed-every-run key that the UI can name, because `focus.marks` means
   * *a person said so* and must keep meaning only that.
   */
  focus?: VisualSpecsFocus;
  viewport?: Viewport;
}

export interface VisualSpecsFocus {
  /** Integer percent. Out of the `Limits` band is clamped on load, not rejected. */
  transparency?: number;
  /**
   * EXPLICIT marks only. An id absent from this map INHERITS from its nearest marked
   * ancestor, which is not the same as being in focus. An object map rather than two
   * arrays so that "marked both in and out" is unrepresentable rather than merely
   * rejected: a key holds one value.
   */
  marks?: Record<NodeId, FocusMarkToken>;
}

/** The two tokens this build understands. A higher minor may add a third; §5.4 keeps
 *  such a value verbatim rather than failing to open the document. */
export type FocusMarkToken = 'out-of-focus' | 'in-focus';

export interface VisualSpecsGenerator {
  name: string;
  version: string;
  /**
   * The flags that determine the CONTENT of this document — not a transcript of the
   * command line.
   *
   * `--repo` and `--out` are deliberately absent: they name the environment the tool
   * ran in, and writing them here would print an absolute path from the operator's
   * machine into a file that is about to be committed. `--stamp` is absent because it
   * only controls `generatedAt`, which is not part of the deterministic payload.
   *
   * Every flag listed here, and every default it fell back to, is also hashed into
   * `configDigest` — so the document declares the configuration that produced it,
   * without declaring where it lives.
   */
  flags?: string[];
  /** Hash of the payload-affecting flags + the resolver configuration. */
  configDigest?: string;
  /** NOT part of the deterministic payload. */
  generatedAt?: string;
}

export interface VisualSpecsSource {
  kind: string;
  root: string;
  commit?: string;
  /**
   * The working tree had TRACKED files differing from `commit` when this was extracted.
   *
   * The extractor lists files from the index and reads their CONTENT from the working
   * tree, so a dirty tree means the evidence — every `path:line` in the document —
   * describes the files on disk, not the files at `commit`. Saying "commit e6a0db5"
   * without saying that would be asserting a provenance the document cannot back up.
   *
   * It is a fact, not an error: mapping work in progress is a reasonable thing to do.
   */
  dirty?: boolean;
}

export interface VisualSpecsDoc {
  /** "MAJOR.MINOR". See §3.4. */
  formatVersion: string;
  /** Reserved. A reader seeing an unknown entry opens read-only. See §3.4. */
  requires?: string[];
  generator?: VisualSpecsGenerator;
  source?: VisualSpecsSource;
  nodes: VisualSpecsNode[];
  edges: VisualSpecsEdge[];
  coverage?: Coverage[];
  unresolved?: Unresolved[];
  view?: VisualSpecsView;
  stats?: Record<string, unknown>;
  /** Reserved for v1.x. Not emitted and not consumed in v1. See §5.4. */
  outlines?: unknown[];
}

// ---------------------------------------------------------------------------
// The raw envelope (§3.3). `raw` is the exact parsed tree; it is never mutated.
// ---------------------------------------------------------------------------

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type DeepReadonly<T> = T extends JsonPrimitive
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : { readonly [K in keyof T]: DeepReadonly<T[K]> };

export type Warning =
  | { code: 'unknown-minor'; message: string }
  | { code: 'stale-position'; message: string; ids: string[] }
  | { code: 'stale-expanded'; message: string; ids: string[] }
  | { code: 'stale-fitted'; message: string; ids: string[] }
  /** A focus mark whose value a newer minor introduced. Ignored for resolution,
   *  preserved verbatim on export — the additive-minor contract on the one axis
   *  `marks: {id: token}` extends. There is deliberately NO `stale-focus` code: see
   *  load.ts on why a warning no consumer reads is worse than none. */
  | { code: 'unknown-focus-mark'; message: string; count: number }
  | { code: 'absolute-path-in-free-form-field'; message: string; where: string }
  | { code: 'read-only'; message: string; requires: string[] }
  | { code: 'snippet-present'; message: string; count: number };

/** What `refresh` throws away, out loud (§3.5). */
export interface LossReport {
  droppedPositions: string[];
  droppedExpanded: string[];
  droppedFitted: string[];
  /**
   * Focus marks a re-extraction dropped (Issue #17). MUST reach the loss banner, not
   * just this object: a dropped position costs a layout auto-layout re-derives, while
   * nothing in this system can re-derive an attention decision. `droppedFitted` has
   * been here since #13 and printed by nothing, which is the mistake this field is
   * required not to repeat.
   */
  droppedFocus: string[];
  newNodes: string[];
  reparented: string[];
}
