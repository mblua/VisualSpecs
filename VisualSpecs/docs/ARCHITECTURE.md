# Visual Specs — Architecture

Visual Specs is a local, self-contained web app that renders a repository as a **blueprint you can read without reading code**: repositories, applications, packages/crates, directories and files as nodes; typed relations between them; a hierarchy you expand and collapse by double-click.

It lives at `VisualSpecs/` inside the CodebaseConstellation repository. It does not depend on the existing `web/` + SQLite + WebGL + `graph-analytics` pipeline, which continues to work unchanged. §14 states exactly which principles of that pipeline are preserved and which implementation is deliberately not reused.

## 1. Problem and constraints

The question a reader brings to this tool is: *what runs here, what does it contain, and what talks to what?* Answering it must not require opening a single source file.

Four constraints shape everything below.

1. **A collapsed container must not hide information.** A relation whose endpoint is hidden is redrawn against the nearest visible ancestor, and it is still reachable — with its evidence — from the aggregate that represents it. Collapsing changes what you *see*, never what the graph *is*.
2. **Redrawing must be deterministic and lossless.** Relations landing on the same visible pair merge into one visual edge that carries the ids of every logical relation behind it. Every logical relation is accounted for in exactly one bucket, always.
3. **The layout is the user's.** Nodes move. Positions survive export and re-import.
4. **The graphics library is a detail.** Swapping it must not touch the contract, the hierarchy, the projection, the aggregation, or import/export.

A fifth constraint is imposed by the product's own purpose: **the map may never assert something it cannot point at.** Every inferred relation carries evidence and a confidence, every relation family reports a coverage level, and anything the extractor cannot resolve is recorded as unresolved rather than guessed. §10 explains why this is written in blood.

## 2. Architectural shape

Ports and adapters. The dependency rules, stated as import rules rather than arrows:

* `contract/` imports **nothing**.
* `domain/` imports `contract/`.
* `projection/` imports `contract/` and `domain/`.
* `app/` imports `contract/`, `domain/`, `projection/`, `ports/`.
* `ports/` imports no inner contracts and exposes only renderer/storage ports.
* `ui/` imports `app/` and `ports/`. **`app/` never imports `ui/`.**
* `adapters/` import `ports/` and other adapters only.
* **`src/main.ts` is the composition root — the only normal module that imports concrete adapters and the UI root, and wires them together.**

`contract/`, `domain/` and `projection/` are pure TypeScript: no DOM, no graphics library, no I/O. They are the entire "understanding" of the product and they run headless in Node.

These are not conventions. An architecture test (§12) parses every source file with the TypeScript API and fails the build on any violating import — in particular, on any import of a renderer/storage adapter from `contract/`, `domain/`, `projection/`, `app/` or `ui/`. It also asserts that File System Access, picker and IDB names appear only in `src/adapters/filesystem/`, and that `Blob`/`URL` appear only under `src/adapters/`.

### 2.1 Why the layers land where they do

Projection and aggregation are pure functions over plain data. Once that is true, the graphics library has no say in them, and replacing it becomes a contained change. If instead the library owned the hierarchy — most graph libraries offer "compound"/"group" nodes that do exactly this — then expand/collapse, aggregation and export would all be entangled with its internal model, and constraint 4 would be unsatisfiable. §8.2 shows this is not hypothetical: it is precisely why this design does **not** use Cytoscape's compound nodes.

## 3. The document contract

One versioned portable JSON document crosses the interchange boundary. The extractor writes it; the app reads it, and writes it back. Project persistence adds a second JSON, `.visual-specs/project.json`, which is local metadata only and never an interchange format.

### 3.0 Portable document vs local project manifest

The portable document is `VisualSpecsDoc` with `formatVersion` 1.x. It can be exported,
opened temporarily, committed as `data/current.json`, or copied into `imports/`.

The local manifest is `VisualSpecsProjectManifestV1`:

```ts
{
  schema: 'visual-specs.project',
  formatVersion: '1.0',
  project: { id, name, createdAtUtc, updatedAtUtc },
  current: { docId, revision, committedAtUtc },
  files: {
    current: 'data/current.json',
    autosaveView: 'data/autosave-view.json'
  }
}
```

`project.name` is display data and an export-name hint, not a path. The `files` object is
accepted only when it contains those exact literal values; adapters never resolve paths from
manifest content. Unknown manifest fields are preserved after a successful exact-version scan at
the root and inside `project`, `current`, `files` and `migration`, but cannot weaken safety or
choose files.

Autosave is a third local file, `data/autosave-view.json`, containing only `VisualSpecsView`
plus `projectId`, `docId` and `baseRevision`. It is ignored unless all three match the
current manifest. It never stores nodes or edges.

The revision is semantic:

```ts
sha256(canonicalStringify(parseJson(data/current.json)))
```

Whitespace, CRLF/LF and key order do not create conflicts; content changes do.

### 3.0.1 ProjectStore and browser capability storage

`ProjectStore` is a port of bytes, text and opaque refs. It imports no contract types and
exposes no DOM, File System Access, Blob, URL or IndexedDB names. The app may call only
methods enabled by `capabilities()` and by the current project access mode.

`FsaProjectStore` owns browser File System Access:

* Create asks for readwrite directory access before semantic hashing or other long work, writes `data/current.json`, `.gitattributes`,
  `.gitignore`, `imports/.gitkeep`, recreates ignored `exports/` and `backups/`, and writes
  `project.json` last.
* Open asks for read access and reads `project.json`, `data/current.json` and optional
  `data/autosave-view.json`; the app validates immediately.
* Enable editing is a separate user action. It requests readwrite permission, then re-reads
  and revalidates before writes are enabled. It preserves the in-memory view only when the
  document revision and manifest semantics remain unchanged.
* Save, Rename, Import and Restore re-read manifest/current inside the per-project queue. The app
  validates those texts synchronously in the queue and throws on external change before the first
  write. Replacement writes and closes a backup made from the just-read current bytes, replaces
  current, then writes `project.json`. A failed backup aborts the replace.
* A valid current paired with a stale manifest opens in safe read-only mode. An explicit Repair
  action obtains permission, re-reads/revalidates the skew and updates only the manifest to adopt
  the current revision; Open never repairs silently.
* Add JSON writes only to `imports/`; Export JSON writes only to `exports/`; imports and
  exports have separate refresh/preview/restore UI flows.
* No-project/read-only-project export uses Save Picker when present and download only when it is
  absent. Permission revocation on any write degrades app access to readonly and stops autosave.
* Generated filenames use UTC with the exact prefix `YYYYMMDD-HHMMSS_` and no `Z` character.

Every adapter read gets a `File`, checks `File.size <= maxBytes`, and only then calls
`File.text()`. The app still parses and validates immediately after each read; size preflight
is not a substitute for the contract scanner.

The security claim is capability-scoped: the user grants the browser a directory capability,
Visual Specs navigates only constant names or validated single-segment filenames, and no path
from portable JSON or `project.json` chooses a file. The adapter uses `resolve()` where the
browser exposes it to confirm `.visual-specs` is the direct selected child. Local queueing cannot
make the fresh-read check atomic against another tab or external process; a residual race remains
between validation and write. It does **not**
claim physical anti-junction safety: File System Access exposes no `realpath`, so a symlink or
junction inside the selected root can point elsewhere. Export/import collision avoidance is
also best-effort under app serialization; FSA has no create-exclusive primitive.

### 3.1 Types

```ts
// src/contract/types.ts — depends on nothing.

export type NodeId = string;
export type EdgeId = string;

/** Open vocabulary. Validation checks shape, never vocabulary. See §3.7. */
export type NodeKind = string;   // 'repository' | 'application' | 'package' | 'crate' | 'directory' | 'file' | …
export type EdgeKind = string;   // 'imports' | 'bundles' | 'entrypoint' | 'tauri-command' | 'web-command' | …

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
  /** POSIX-relative. Present for nodes backed by the filesystem. */
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
  confidence: 'declared' | 'resolved' | 'heuristic';
  metadata?: Record<string, unknown>;
  evidence?: Evidence[];
}

/** Per relation family. Preserves the capability-gate discipline of the existing
 *  pipeline (§14): a non-empty relation set is not automatically trustworthy. */
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

export interface Position { x: number; y: number; /** user-placed: never auto-repacked */ pinned?: boolean }

export interface VisualSpecsView {
  positions?: Record<NodeId, Position>;
  expanded?: NodeId[];
  viewport?: { x: number; y: number; zoom: number };
}

export interface VisualSpecsDoc {
  /** "MAJOR.MINOR". See §3.4. */
  formatVersion: string;
  /** Reserved. A reader seeing an unknown entry opens read-only. See §3.4. */
  requires?: string[];
  generator?: {
    name: string; version: string;
    /** The flags that determine the CONTENT of this document — NOT a transcript of the
     *  command line. `--repo` and `--out` are excluded: they name the operator's
     *  filesystem, and printing an absolute path into a file about to be committed is a
     *  leak, not provenance. `--stamp` is excluded because it only controls
     *  `generatedAt`, which is not part of the deterministic payload. See §16.18. */
    flags?: string[];
    /** Hash of flags + resolver config. Part of the deterministic payload. */
    configDigest?: string;
    /** NOT part of the deterministic payload. */
    generatedAt?: string;
  };
  source?: { kind: string; root: string; commit?: string };
  nodes: VisualSpecsNode[];
  edges: VisualSpecsEdge[];
  coverage?: Coverage[];
  unresolved?: Unresolved[];
  view?: VisualSpecsView;
  stats?: Record<string, unknown>;
  /** Reserved for v1.x. Not emitted and not consumed in v1. See §5.4. */
  outlines?: unknown[];
}
```

### 3.2 Worked example — a fragment of the real AgentsCommander document

**Read this carefully.** The paths, manifests, line numbers and the specific facts called out below were **read from the repository and verified**. Every *aggregate count* in `stats` and `coverage` is **illustrative of the shape only** and **must be regenerated by the implemented extractor** before `data/agentscommander.json` is committed. This document does not get to assert numbers that no program has produced. §10.5 explains why that sentence exists.

```jsonc
{
  "formatVersion": "1.0",
  "generator": {
    "name": "visual-specs-extract", "version": "0.1.0",
    "flags": ["--hierarchy", "logical", "--relations", "ts-imports,rust-imports,transport-commands"],
    "configDigest": "sha256:…"
  },
  "source": { "kind": "git-repo", "root": "AgentsCommander", "commit": "e6a0db5" },

  "nodes": [
    { "id": "repo:AgentsCommander", "kind": "repository",
      "label": "AgentsCommander", "parentId": null, "path": "" },

    // --- applications: what runs. Linked to code by RELATIONS, not containment. §5.3 ---
    { "id": "app:tauri:src-tauri/tauri.conf.json", "kind": "application",
      "label": "Agents Commander (desktop)", "parentId": "repo:AgentsCommander",
      "metadata": { "flavor": "desktop" },
      "evidence": [{ "path": "src-tauri/tauri.conf.json", "line": 5 }] },

    { "id": "app:web:index.html", "kind": "application",
      "label": "AgentsCommander UI (web)", "parentId": "repo:AgentsCommander",
      "metadata": { "flavor": "web" },
      "evidence": [{ "path": "index.html", "line": 13 }] },

    { "id": "app:cargo-bin:crates/session-bridge/src/bin/session-bridge.rs",
      "kind": "application", "label": "session-bridge", "parentId": "repo:AgentsCommander",
      "evidence": [{ "path": "crates/session-bridge/src/bin/session-bridge.rs",
                     "note": "cargo bin target (src/bin/*.rs)" }] },

    { "id": "app:cargo-bin:crates/session-bridge/src/bin/agentscommander-api-helper.rs",
      "kind": "application", "label": "agentscommander-api-helper", "parentId": "repo:AgentsCommander",
      "evidence": [{ "path": "crates/session-bridge/src/bin/agentscommander-api-helper.rs",
                     "note": "cargo bin target (src/bin/*.rs)" }] },

    { "id": "app:npm-bin:npm/package.json#agentscommander", "kind": "application",
      "label": "@mblua/agentscommander (cli)", "parentId": "repo:AgentsCommander",
      "evidence": [{ "path": "npm/package.json", "line": 7 }] },

    // --- packages / crates: anchored at their manifest, hoisted to the repo. §5.2 ---
    // `path: ""` means "the repository root directory". It is legal ONLY for a root
    // node or for a node that DECLARES itself a root anchor — otherwise the validator
    // would be contradicting its own example. See §16.4.
    { "id": "pkg:npm:package.json", "kind": "package", "label": "agentscommander",
      "parentId": "repo:AgentsCommander", "path": "",
      "metadata": { "ecosystem": "npm", "version": "0.10.0", "hasWorkspacesKey": false,
                    "rootAnchor": true },
      "evidence": [{ "path": "package.json", "line": 2 }] },

    // A Rust CRATE is its own kind — not a package with an ecosystem tag. Two of the
    // four anchors are crates, and making the reader translate is the work this map
    // exists to do for them. The ID keeps the `pkg:cargo:` prefix, so a saved layout
    // survives the distinction. See §16.10.
    { "id": "pkg:cargo:src-tauri/Cargo.toml", "kind": "crate", "label": "agentscommander-new",
      "parentId": "repo:AgentsCommander", "path": "src-tauri",
      "metadata": { "ecosystem": "cargo", "libName": "agentscommander_lib" },
      "evidence": [{ "path": "src-tauri/Cargo.toml", "line": 2 }] },

    { "id": "pkg:cargo:crates/session-bridge/Cargo.toml", "kind": "crate",
      "label": "session-bridge", "parentId": "repo:AgentsCommander",
      "path": "crates/session-bridge",
      "evidence": [{ "path": "crates/session-bridge/Cargo.toml", "line": 2 }] },

    { "id": "pkg:npm:npm/package.json", "kind": "package", "label": "@mblua/agentscommander",
      "parentId": "repo:AgentsCommander", "path": "npm",
      "evidence": [{ "path": "npm/package.json", "line": 2 }] },

    { "id": "file:src/shared/ipc.ts", "kind": "file", "label": "ipc.ts",
      "parentId": "dir:src/shared", "path": "src/shared/ipc.ts",
      "metadata": { "language": "typescript", "isTest": false } }
    // … one node per git-tracked file (705 tracked files, verified)
  ],

  "edges": [
    // The desktop app spans TWO packages. This is why 'application' is not a
    // containment level, and why the ownership tree cannot host an app-centric
    // hierarchy without help. §5.3, §5.4.
    { "id": "bundles:app:tauri:src-tauri/tauri.conf.json->pkg:cargo:src-tauri/Cargo.toml",
      "kind": "bundles", "confidence": "declared",
      "sourceId": "app:tauri:src-tauri/tauri.conf.json",
      "targetId": "pkg:cargo:src-tauri/Cargo.toml",
      "evidence": [{ "path": "src-tauri/tauri.conf.json",
                     "note": "the Tauri config sits in the crate's own manifest directory" }] },

    { "id": "bundles:app:tauri:src-tauri/tauri.conf.json->pkg:npm:package.json",
      "kind": "bundles", "confidence": "heuristic",
      "sourceId": "app:tauri:src-tauri/tauri.conf.json",
      "targetId": "pkg:npm:package.json",
      "evidence": [{ "path": "src-tauri/tauri.conf.json", "line": 9,
                     "note": "beforeBuildCommand: npm run build" },
                   { "path": "src-tauri/tauri.conf.json", "line": 7,
                     "note": "frontendDist: ../dist" }] },

    // A TypeScript import, RESOLVED through the project's tsconfig (§10.2).
    { "id": "imports:file:src/main.tsx->file:src/shared/platform.ts",
      "kind": "imports", "confidence": "resolved",
      "sourceId": "file:src/main.tsx", "targetId": "file:src/shared/platform.ts",
      "evidence": [{ "path": "src/main.tsx", "line": 3 }] },

    // A command call bound to the TAURI backend. High confidence requires THREE
    // pieces of evidence: the literal call, the attribute, and the registration. §10.4.
    { "id": "tauri-command:file:src/shared/ipc.ts->file:src-tauri/src/commands/config.rs#get_settings",
      "kind": "tauri-command", "confidence": "resolved", "label": "get_settings",
      "sourceId": "file:src/shared/ipc.ts",
      "targetId": "file:src-tauri/src/commands/config.rs",
      "metadata": { "command": "get_settings", "binding": "tauri" },
      "evidence": [{ "path": "src/shared/ipc.ts", "line": 462,
                     "note": "transport.invoke<AppSettings>(\"get_settings\")" },
                   { "path": "src-tauri/src/commands/config.rs",
                     "note": "#[tauri::command] fn get_settings" },
                   { "path": "src-tauri/src/lib.rs", "line": 2047,
                     "note": "registered in tauri::generate_handler![…]" }] },

    // The SAME command name, bound to the WEB backend. This is a different fact,
    // a different target file, and therefore a different logical edge. §10.4.
    { "id": "web-command:file:src/shared/ipc.ts->file:src-tauri/src/web/commands.rs#get_settings",
      "kind": "web-command", "confidence": "resolved", "label": "get_settings",
      "sourceId": "file:src/shared/ipc.ts",
      "targetId": "file:src-tauri/src/web/commands.rs",
      "metadata": { "command": "get_settings", "binding": "web" },
      "evidence": [{ "path": "src/shared/ipc.ts", "line": 462 },
                   { "path": "src-tauri/src/web/commands.rs",
                     "note": "match arm \"get_settings\" in the WebSocket router" }] }
  ],

  "coverage": [
    { "kind": "imports",        "status": "available", "emitted": 0, "unresolved": 0 },
    { "kind": "rust-imports",   "status": "degraded",  "emitted": 0, "unresolved": 0,
      "reason": "no macro expansion, no #[path], no cfg evaluation, glob imports unresolved" },
    { "kind": "tauri-command",  "status": "available", "emitted": 0, "unresolved": 0 },
    { "kind": "web-command",    "status": "available", "emitted": 0, "unresolved": 0 }
  ],

  "unresolved": [
    { "kind": "tauri-command", "reason": "command name is not a string literal",
      "evidence": [{ "path": "src/shared/ipc.ts", "line": 104,
                     "note": "the facade itself: currentTransport().invoke<T>(cmd, args)" }] }
  ],

  "view": {
    "positions": { "repo:AgentsCommander": { "x": 0, "y": 0 } },
    "expanded": ["repo:AgentsCommander"],
    "viewport": { "x": 0, "y": 0, "zoom": 1 }
  },

  "stats": { "trackedFiles": 705 }
}
```

### 3.3 Round-trip: what is actually promised

**Not** "byte-compatible". That was never achievable: `JSON.parse` followed by `JSON.stringify` legitimately rewrites `1e2` as `100`, normalises escapes, and drops whitespace, and the loader canonicalises array order on top of that.

> **The promise.** A load→save cycle preserves **every known and unknown JSON value reachable in the document**, and emits **deterministic key and array order**. It does **not** preserve input whitespace, input key order, or numeric literal spelling.

The mechanism is a **raw envelope with a single mutable authority**:

```ts
export interface LoadedDoc {
  /** The exact parsed JSON tree, deep-frozen. Never mutated. The extension envelope. */
  raw: DeepReadonly<JsonValue>;
  /** Validated, indexed, canonicalised view over `raw`. What the algorithms consume. */
  model: GraphModel;
  /** THE ONE mutable authority for expanded / positions / viewport. */
  view: ViewState;
  warnings: Warning[];
}
```

* `raw` is immutable and complete. Unknown fields — at the root, in a node, in an edge, in `evidence`, in `source`, in `generator`, in `view`, inside a `Position` object, arbitrarily nested — are never dropped, because they were never removed in the first place.
* `model` is a *derived index*. It is not a second copy of the truth; it is a lookup structure.
* **`AppState` does not contain `doc.view`.** There is exactly one writable holder of expansion/positions/viewport: `AppState.view`. The previous design carried both and could silently diverge — that was a real defect, and it is gone by construction, not by discipline.
* **`export()` = deep-clone `raw`, replace only its `view` subtree from `ViewState`, serialise canonically.** Everything else is carried across untouched.

### 3.4 Versioning

`formatVersion` is `MAJOR.MINOR`. **Every minor within a major MUST be additive and optional.** That precondition is what makes forward compatibility safe, and it is now part of the contract rather than an assumption.

| Input | Behaviour |
|---|---|
| `1.0` | Accept. |
| `1.7` (unknown minor, same major) | **Accept**, warn once, preserve all extensions (§3.3). |
| `1.x` with an unknown entry in `requires[]` | **Open read-only**: render it, refuse to export. A reader that cannot honour a declared requirement must not write the document back. |
| `2.0` (unknown major) | Reject: `IncompatibleVersionError`, naming both versions. |
| missing / non-string | Reject: `SchemaError`. |
| not valid JSON | Reject: `InvalidJsonError`, carrying the engine's message. **No character offset is promised** — `JSON.parse` does not expose one portably. |
| valid JSON, broken graph | Reject: `IntegrityError`, listing the offending ids. |
| dangerous key present | Reject: `SchemaError`. See §11. |

### 3.5 Import is not refresh

Two distinct operations, because they have opposite obligations:

| | `import(doc)` | `refresh(newDoc, currentView)` |
|---|---|---|
| Purpose | Open a document. | Re-extract on a newer commit and **keep my layout**. |
| Discards | **Nothing.** | Positions/expansion for ids that no longer exist. |
| Stale `view.positions` referencing unknown nodes | Kept in `raw`, warned, not rendered — so load→export stays lossless. | Dropped, deliberately. |
| Returns | `LoadedDoc` + warnings. | `LoadedDoc` + a **loss report**: `{ droppedPositions, droppedExpanded, droppedFitted, droppedFocus, newNodes, reparented }`. |

The "re-extract and keep your layout" capability lives entirely in `refresh`, where the loss is explicit and shown to the user. `import` never quietly throws data away.

### 3.6 Facts and view state

`nodes`/`edges` are facts about the code. `view` is what the user did with the mouse. Both live in one document, in separate sections, and `view.positions` is keyed by node id — which is stable (§5.1), which is what makes `refresh` possible.

`view` is optional. An extractor document has none; the app computes a deterministic initial layout (§7). An exported document always has one.

### 3.7 Kinds are an open vocabulary

`NodeKind` and `EdgeKind` are plain strings. `validate()` checks the *shape* of a document, never its vocabulary. The UI holds a kind registry (colour, shape, z-order) with a defined fallback for kinds it has never seen, so an unknown kind renders rather than crashing.

This makes new *kinds* free. It does **not** — and this is a correction to an earlier draft of this document — make new *hierarchies* free. See §5.4, which is where that promise is actually paid for.

## 4. Invariants

Enforced by `contract/validate.ts` on load, and by construction thereafter.

| # | Invariant | Why |
|---|---|---|
| **I1** | Node ids unique; edge ids unique. | Aggregation and `sourceEdgeIds` are meaningless otherwise. |
| **I2** | Every `parentId` names an existing node. | No orphans. |
| **I3** | The parent relation is **acyclic**; nodes form a forest with exactly one parent each. | **Projection is only well-defined on a tree.** "Nearest visible ancestor" has no meaning in a DAG. |
| **I4** | Every edge endpoint names an existing node. | No dangling relations. |
| **I5** | Containment is **not** an edge kind. Hierarchy is `parentId`. | A `contains` edge would project onto itself: collapse a folder and its own containment edges become self-loops at the folder. Structural containment deletes that bug class. §14 explains why the existing SQLite schema is right to do the opposite. |
| **I6** | The core never parses a node id. Ids are opaque strings. | Only the extractor knows ids look like `file:src/x.ts`. Nothing else may assume it — see I10. |
| **I7** | **Known path fields** (`node.path`, `Evidence.path`, `source.root`) are POSIX-relative and pass §11's validator. | Privacy. **Scoped deliberately**: this cannot be promised for `metadata`, `label`, `note`, `snippet` or preserved unknown fields, which are free-form. Those are *scanned and warned about*, never silently rewritten. Claiming more would be a lie. |
| **I8** | `project()` never mutates the model. | The mechanical form of *"collapsing never mutates the logical relation"*: a signature, not a promise. |
| **I9** | **Partition law.** The `sourceEdgeIds` of all visible edges and all internal buckets form an **exact partition** of `{e.id \| e ∈ model.edges}`: every logical edge id appears **exactly once**, and in the bucket that matches `(NVA(source), NVA(target), kind)`. | The strongest executable statement of *"no relation is ever lost"*. A sum of counters is **not** enough — it can be right while omitting one id and double-counting another. §6.5. |
| **I10** | The outline consumed by projection is **injective**: each entity has at most one placement. | NVA is undefined if an entity sits in two places at once. §5.4 defines what happens when this is relaxed. |
| **I11** | All numbers in `view` are finite; `zoom > 0`; coordinates and zoom within stated bounds. | `1e400` parses to `Infinity` and destroys a layout. §11. |

## 5. Entities, ownership, and future hierarchies

### 5.1 Identity

```
repo:<name>
app:<signal-kind>:<signal-path>[#<name>]
pkg:<ecosystem>:<manifest-path>
dir:<repo-relative-path>
file:<repo-relative-path>
```

Deterministic, human-readable, and stable across re-extraction while paths hold. **Ids do not encode the parent**, so switching hierarchy mode (§5.2) does not change any id — which is what lets `view.positions` survive the switch.

Readable ids over hashes, deliberately: evidence, diffs and bug reports stay legible. **Renames produce new ids; there is no rename tracking** — a stated limit.

### 5.2 The ownership tree: "nearest manifest wins"

Mechanical, no inference:

1. **Git-tracked files only** (`git ls-files -z`). Generated and ignored files never enter the graph.
2. Every `package.json` and `Cargo.toml` is an **anchor** at its own directory.
3. Every path belongs to its **nearest enclosing anchor** — which is how npm and Cargo themselves resolve ownership. So `src-tauri/**` belongs to the `agentscommander-new` crate, not to the root npm package that physically encloses it.
4. Anchors are **children of the repository** (hoisted). Directories and files nest by path within their owning package.
5. Directory nodes exist only where a directory transitively owns ≥1 file *in its own package*; pure pass-through directories are pruned.

For AgentsCommander the four anchors are `/` (npm `agentscommander`), `/src-tauri` (crate `agentscommander-new`), `/crates/session-bridge` (crate `session-bridge`) and `/npm` (npm `@mblua/agentscommander`).

**Hoisting is a lens, and it says so.** Physically, `src-tauri/` sits inside the root npm package's directory. Nesting it there buries both crates and makes the first screen useless; hoisting puts every unit of code at the top level, where it belongs conceptually. The honest consequences, spelled out:

* The extractor supports **`--hierarchy logical` (default) and `--hierarchy physical`**, and both are tested.
* Under `logical`, the UI shows a **"ownership outline (hoisted)"** badge. It is not presented as the filesystem.
* **The breadcrumb always shows the physical path**, from `node.path`, in every mode. `crates/session-bridge` is one glance away even when no `crates/` box exists.
* Switching mode changes `parentId` only. **Node ids are unchanged**, so `view.positions` survive. `view.expanded` may name a container that exists in only one mode (e.g. `dir:crates`); those entries are dropped with a warning by `refresh`, and retained-but-inert by `import`. Container membership changes, so auto-laid-out children may be re-packed — **pinned nodes are never moved** (§7).

### 5.3 Applications are related to code, not containers of it

An `application` is something that **runs**. It is detected only from citable signals, and each application node carries the evidence that justified it:

| Signal | Flavor | Verified in AgentsCommander |
|---|---|---|
| `tauri.conf.json` | `desktop` | `src-tauri/tauri.conf.json` |
| root `index.html` + a Vite config | `web` | `index.html` → `/src/main.tsx` |
| Cargo `src/main.rs`, `src/bin/*.rs`, `[[bin]]` | `bin` | `crates/session-bridge/src/bin/session-bridge.rs` **and** `…/agentscommander-api-helper.rs` |
| npm `package.json#bin` | `cli` | `npm/package.json` → `run.js` |

An application's link to code is a **typed relation** — `bundles`, `entrypoint` — not a containment level. This is forced by the repository:

* The Tauri desktop app **spans two units of code**. `src-tauri/tauri.conf.json` declares `frontendDist: "../dist"` (and `beforeBuildCommand: "npm run build"`): it bundles the root **npm package**'s Vite output alongside its own **Rust crate**. **One app, one package and one crate.** (`frontendDist` is what locates the output; the build command alone says only that *a* build happens, and guessing from it is exactly what §B1/§16.19 forbids.)
* The `session-bridge` crate ships **two binaries**. **Two apps, one crate.**

Applications and the units they bundle — packages and crates alike — are therefore **N:M**, and a single-parent tree cannot express N:M. As a containment level, the second fact alone would demand a crate with two parents, violating **I3**.

### 5.4 The frontier: ownership tree vs. presentation outlines

An earlier draft of this document claimed that a future `server → apps → modules → files` hierarchy was "just a new kind plus a re-extraction". **That was false, and it is worth being precise about why**, because the correction is the most important structural idea here.

`VisualSpecsNode.parentId` gives each entity exactly one parent. But membership is N:M (§5.3). So an app-centric hierarchy — in which a *file* or a *package* appears under **every application that bundles it** — cannot be expressed by re-parenting, without either duplicating the entity or arbitrarily picking one owner and losing the rest. A new `kind` string does nothing about that.

The fix is to separate two things that this design was conflating:

* **The ownership tree** — the canonical, factual, single-parent placement of every entity. It is what `parentId` means, and it is not negotiable.
* **An outline** — a *presentation* tree over the *same* entities, in which a node is a lightweight **reference** to an entity, never a copy of it, and which never copies or duplicates edges.

**Projection no longer consumes `parentId`. It consumes an `Outline`:**

```ts
// src/domain/outline.ts
export type OutlineNodeId = string;

export interface Outline {
  readonly id: string;
  roots(): readonly OutlineNodeId[];
  childrenOf(n: OutlineNodeId): readonly OutlineNodeId[];   // deterministic order
  entityOf(n: OutlineNodeId): NodeId;
  /** Injective in v1 (I10): an entity has at most one placement. */
  placementOf(e: NodeId): OutlineNodeId | null;
}
```

* **v1 ships exactly one implementation**: `OwnershipOutline`, built from `parentId`. Nothing else changes for the user.
* **Edges always connect entities, never outline nodes.** An outline cannot lose, duplicate, or invent a relation, because it does not own any.
* **The test suite ships a second implementation**, `AppCentricOutline` (a fixture-only outline that places each package under **one** of the applications that bundle it), and runs the *same* projection and the *same* partition law against it. **The frontier is therefore a passing test, not a paragraph.** That is the difference between this version and the last one.

  > **Correction, made during implementation (§16.1).** An earlier wording of this bullet said the fixture outline "places packages under the applications that bundle them" — plural. **It cannot**, and no test could have made it. `placementOf` is injective by I10, so an entity has *one* placement; a package bundled by two applications cannot be a child of both. What v1 actually ships is **primary placement**: each entity is placed once, under a deterministically chosen parent, and **every other membership remains a `bundles` edge**, which projects through NVA, aggregates, and carries its evidence exactly like any other relation. What the fixture proves is therefore *no membership is lost* — which is the promise that matters — and **not** *an entity appears under every app that bundles it*, which needs multi-placement and is not implemented. See `ADR-0001-outline-placement.md`.
* **Required fixture**: one application bundling **two units** — an npm package and a Rust crate — and one **unit bundled by two applications**: the exact N:M shape verified in AgentsCommander. It asserts that no membership is lost and no `sourceEdgeId` is duplicated under either outline.

**When injectivity is relaxed** (a multi-placement outline — genuinely useful for the app-centric view, and deferred), the partition law generalises: the partition is over `(logicalEdgeId × placementPair)` rather than `logicalEdgeId`, and the contract must then declare an explicit fan-out policy (`all-pairs` or `primary-placement`). **v1 does not implement this**; it validates **I10**, and it names the generalisation so that arriving at it is a decision, not an accident. `VisualSpecsDoc.outlines` is reserved for it.

## 6. Projection

Pure. `project(model, outline, expanded) → VisibleGraph`. Never mutates. `src/projection/`.

### 6.1 Visibility and Nearest Visible Ancestor

Everything below is defined over **outline nodes**, not over `parentId` directly. In v1 the outline is the ownership outline, so they coincide — but the code depends on the port.

> An outline node is **visible** iff every strict ancestor of it is in `expanded`. Roots have no ancestors and are always visible.
> **NVA(n)** is `n` if `n` is visible, else the deepest visible ancestor of `n`. It always exists (roots are visible) and is unique (the outline is a tree).

Expansion state inside a hidden subtree is remembered but inert, so collapsing and re-expanding restores exactly the view you left.

One pre-order walk, **O(V)**:

```
function project(model, outline, expanded):
    nva          = new Map<OutlineNodeId, OutlineNodeId>()
    visibleNodes = []

    function visit(n, isVisible, representative):
        if isVisible:
            visibleNodes.push(n)
            nva.set(n, n)
            rep = n
            childrenVisible = expanded.has(n)      # children show only if THIS node is expanded
        else:
            nva.set(n, representative)             # hidden: inherit the representative
            rep = representative
            childrenVisible = false                # a hidden node's children are hidden too

        for child in outline.childrenOf(n):        # deterministic order — §6.6
            visit(child, childrenVisible, rep)

    for root in outline.roots():
        visit(root, true, root)
```

### 6.2 Resolving an entity to its representative

```
function representativeOf(entityId):
    placement = outline.placementOf(entityId)
    if placement == null: return null              # entity not in this outline: edge is out of scope
    return nva.get(placement)
```

### 6.3 Bucketing — no string keys anywhere

Edge ids and kinds are **opaque strings from an untrusted document**. They may contain any character, including whatever delimiter we might have been tempted to use. Concatenating `kind + '|' + source + '|' + target` is therefore **ambiguous and exploitable**: `(kind="k|a", src="b", tgt="c")` and `(kind="k", src="a|b", tgt="c")` produce the identical key `"k|a|b|c"`, and no `split` can tell them apart. An imported document can trigger this on purpose.

Buckets are **nested Maps**. Nothing is ever encoded or parsed:

```
visible  : Map<EdgeKind, Map<OutlineNodeId /*src*/, Map<OutlineNodeId /*tgt*/, EdgeId[]>>>
internal : Map<EdgeKind, Map<OutlineNodeId /*container*/, EdgeId[]>>

for edge in model.edges:                           # canonical order — §6.6
    s = representativeOf(edge.sourceId)
    t = representativeOf(edge.targetId)
    if s == null or t == null: continue            # not represented in this outline

    if s === t:
        internal[edge.kind][s].push(edge.id)       # collapsed into ONE visible node
    else:
        visible[edge.kind][s][t].push(edge.id)     # a drawn relation
```

**Kind is part of the bucket identity.** `bundles` and `entrypoint` between the same visible pair stay two edges: they are different facts and must not merge into a meaningless "×2".

### 6.4 Visible identities are not logical identities

An aggregated edge **does not exist in `doc.edges`**. Typing its id as `EdgeId` was a category error.

```ts
export type VisibleEdgeId    = string & { readonly __brand: 'VisibleEdgeId' };
export type InternalBucketId = string & { readonly __brand: 'InternalBucketId' };

export interface VisibleEdge {
  id: VisibleEdgeId;                       // opaque, projection-assigned
  kind: EdgeKind;                          // the structured tuple is CARRIED,
  sourceId: OutlineNodeId;                 // never re-parsed out of the id
  targetId: OutlineNodeId;
  count: number;
  sourceEdgeIds: readonly EdgeId[];        // the logical relations behind this one line
}

export interface InternalBucket {
  id: InternalBucketId;
  kind: EdgeKind;
  containerId: OutlineNodeId;              // both endpoints collapsed into this node
  count: number;
  sourceEdgeIds: readonly EdgeId[];        // ← the fix: internal relations keep their ids
}

export interface VisibleGraph {
  visibleNodes: readonly OutlineNodeId[];
  visibleEdges: readonly VisibleEdge[];
  internalBuckets: readonly InternalBucket[];
  nva: ReadonlyMap<OutlineNodeId, OutlineNodeId>;
}
```

Ids are assigned **after** bucketing: sort the structured tuples with a **field-by-field tuple comparator** (never a concatenated string), then assign `v0, v1, …` / `i0, i1, …` by index. Deterministic, collision-free, delimiter-free.

`AppState.selection` holds a `VisibleEdgeId | InternalBucketId`, and the controller resolves it **against `VisibleGraph`**, never against `doc.edges`.

### 6.5 The partition law (I9)

An earlier draft kept only `internalEdgeCounts: Map<NodeId, number>` for relations whose endpoints collapsed together. That preserved the *quantity* of information and destroyed the *information* — you could see "214 internal relations" and never learn which. Worse, the law it supported (`Σ counts == edges.length`) can hold **while omitting one id and double-counting another**.

> **I9.** Let `B` be the multiset union of `sourceEdgeIds` over all `visibleEdges` and all `internalBuckets`. Then `B` is **exactly** the set `{e.id | e ∈ model.edges represented in this outline}` — same cardinality, **no duplicates, no omissions**. Furthermore, for every logical edge `e`, the bucket containing `e.id` **matches** `(representativeOf(e.sourceId), representativeOf(e.targetId), e.kind)`.

The second sentence is what makes it a real law: it checks that every id is in the *right* bucket, not merely in *a* bucket. Tested as a property over hundreds of seeded pseudo-random expand/collapse sequences (§12).

**Filters do not participate.** `hideTests`, node-kind and edge-kind filters are a **scene mask applied after projection**: projection always runs over the full model, filters only set `dimmed`/`hidden` flags and report their own totals (`hiddenByFilter`). **NVA never changes and the partition law is never invalidated by a filter**, because the law is stated over the unfiltered projection. Re-projecting a filtered model would be a *different* algorithm with a *different* law; it is explicitly out of scope.

### 6.6 Determinism

Determinism is a property of the **loader and the projector**, not a demand on the input file. A hand-edited or third-party document with shuffled arrays must still produce an identical `VisibleGraph`.

* The loader canonicalises `model`: edges sorted by `edge.id`; children sorted by `(kindRank, label, id)` — one ordering, used for the walk, for layout, and for display.
* `kindRank` is a fixed table (`repository < application < package < crate < directory < file < unknown`), so unknown future kinds sort last, stably, with no code change.
* Bucket iteration is by sorted tuple; `sourceEdgeIds` in canonical edge-id order.

### 6.7 What this does on the real dataset

`src/shared/ipc.ts` is the single command facade for the whole frontend (§10.4). Collapsed to the default view, every command relation from it projects onto the same visible pair and aggregates into **one edge per binding kind**, each carrying every `sourceEdgeId` behind it. Expand the crate, then `src/`, then `commands/`, and that one edge resolves into per-file edges. Collapse again and the aggregate returns, with the model untouched.

That is constraints 1 and 2 demonstrated on real data — and it is also the most useful thing the map says about this codebase: **the entire frontend reaches the entire backend through exactly one file, over a transport that has two different backends behind it.**

The exact counts come from the extractor, not from this document (§10.5).

## 7. Geometry, layout and movement

The domain owns geometry. The renderer draws what it is given.

**Coordinate system.** One world space, y-down, units are pixels at zoom 1. Every node's `position` is its **centre**, **absolute**, in world coordinates — for leaves *and containers alike*. There is no parent-relative coordinate space.

**Sizes are derived, never stored.** A leaf's size comes from a **deterministic text-measure function** (a fixed character-width model with a label-truncation rule) — *not* from browser text metrics, which vary by platform and would make the document non-deterministic. An expanded container's size is the bounding box of its children plus padding. A collapsed container has a fixed size per kind. **`view` stores positions only**; sizes are recomputed, so they can never go stale.

**`AutoLayout` is a port** (`domain/layout/port.ts`), implemented in v1 by `gridPack`: a deterministic row-pack in canonical child order.

**Pinning is what lets auto-layout and manual movement coexist.** Without it, either auto-repacking destroys the user's placement (breaking constraint 3) or expansion overlaps siblings (breaking legibility). So:

* A node the user has **dragged** is marked `pinned: true` in `view.positions`. **A pinned node is never moved by auto-layout.**
* Auto-layout writes positions for unpinned nodes only.
* **On expand**, children are laid out lazily and persisted. The container's size grows; its parent then re-packs its *unpinned* children in canonical order, and this cascades upward. The cascade is deterministic and bounded by tree depth.
* **Dragging a container is a domain command**, not a renderer behaviour: `MoveNode(container, pos)` translates the container **and its entire subtree** by the delta, and marks the container pinned. Descendant absolute positions are rewritten, so an export is trivially correct and re-import reproduces the arrangement exactly.
* A container you moved stays where you put it across expand → collapse, because its own position is stored and it is pinned.

The trade-off, plainly: a grid pack produces more edge crossings than a layered layout. It is chosen because it is **deterministic, instant, diffable and predictable**, and because the user moves nodes — an engine that re-optimises on every change fights them. `elkjs` behind `AutoLayout` is the deferred upgrade.

## 8. Rendering

### 8.1 The port

`src/ports/renderer.ts`. **No graphics-library type appears in this file.** Colours are hex strings, sizes are numbers, shapes are string literals.

```ts
export interface RenderNode {
  id: string; kind: string; label: string;
  position: { x: number; y: number };   // absolute world centre — domain-authoritative
  size: { w: number; h: number };       // domain-authoritative (§7)
  isContainer: boolean; isExpanded: boolean;
  z: number;                            // containers render behind their children
  selected: boolean; dimmed: boolean; hidden: boolean;
  style: { fill: string; stroke: string; text: string; shape: 'rect' | 'round-rect' | 'hex' };
  badge?: string;
}

export interface RenderEdge {
  id: string; kind: string;
  sourceId: string; targetId: string;
  count: number; label?: string;        // e.g. "×34"
  selected: boolean; dimmed: boolean; hidden: boolean;
  style: { color: string; width: number; dash: readonly number[] | null; arrow: 'triangle' | 'none' };
}

export interface RenderScene { nodes: readonly RenderNode[]; edges: readonly RenderEdge[] }

export type RendererEvent =
  | { type: 'node:click';      id: string; additive: boolean }
  | { type: 'node:dblclick';   id: string }
  | { type: 'node:dragend';    id: string; position: { x: number; y: number } }
  | { type: 'edge:click';      id: string }
  | { type: 'background:click' }
  | { type: 'viewport:change'; viewport: Viewport };

export interface GraphRenderer {
  mount(host: HTMLElement): void;
  render(scene: RenderScene): void;              // declarative, idempotent
  on(handler: (e: RendererEvent) => void): () => void;
  fit(ids?: readonly string[]): void;
  getViewport(): Viewport;
  setViewport(v: Viewport): void;
  resize(): void;
  destroy(): void;                               // idempotent
}
```

`render(scene)` is **declarative and idempotent**: the controller hands over a complete scene and the adapter diffs it. The controller never issues `addNode`/`removeEdge` imperatives. An imperative port would smear rendering state across the controller and defeat the entire exercise.

### 8.2 The v1 adapter: Cytoscape.js **without compound nodes**

An earlier draft claimed Cytoscape's compound nodes would render containers "for free" while the domain stayed authoritative for `position` and `size`. **That claim was wrong, and it was made without verification.** Cytoscape's documentation is explicit that a compound parent has **no independent position or dimensions — they are inferred from its descendants**, and that reparenting is not an ordinary `data` update. Since expand/collapse reparents on every double-click, that impedance mismatch would be hit constantly, and the port's central promise — the domain owns geometry — would be false.

**The adapter therefore does not use compound parents at all.**

* Containers are **ordinary Cytoscape nodes**: a rectangle with a domain-computed `position` and `size`, drawn behind its children via `z-index`. Children are separate nodes positioned inside it. The domain remains authoritative for every pixel, exactly as the port says.
* `layout: { name: 'preset' }` consumes our positions verbatim; Cytoscape's layout engine is never invoked and cannot leak into an export.
* Dragging a container is handled in the **domain** (§7), not by the renderer — which is better anyway: it is deterministic, headless-testable and correctly exported.
* What Cytoscape is still bought for: canvas rendering, pan/zoom/`fit`, hit-testing, event plumbing, edge routing with labels, HiDPI, and a **headless mode** for tests. That remains substantial.

**The adapter is a gate, not an assumption.** Step 4 of §13 is an explicit spike with an exit criterion: the Cytoscape adapter must pass the full conformance suite **and** the browser smoke. **If it does not, it is replaced by a hand-rolled Canvas 2D adapter** — a contained change, precisely because the port exists. This document does not claim the spike has already succeeded.

> **Outcome (§16.6).** The gate was decided **against** Cytoscape, and v1 ships the hand-rolled **Canvas 2D** adapter with **zero runtime dependencies**. With compound nodes ruled out, what remained to buy was canvas drawing, pan/zoom, hit-testing and event plumbing — all of which this product owns anyway, because the domain owns geometry. The exit criterion was honoured: the shared conformance suite passes against the real adapter in a real browser, with real pointer events. The reasoning, and the fact that the spike was decided on its requirements rather than run to failure, are recorded in `ADR-0002-renderer.md`.

### 8.3 Conformance

`src/ports/renderer.conformance.ts` — one shared suite that **every** adapter must pass, run against `FakeRenderer` (headless, under vitest) and **`Canvas2DRenderer`** (in a real browser, with real pointer events — see §16.6 for why that is the shipped adapter):

mount → render → **render the same scene twice is a no-op** → change scene (add / remove / move / re-parent a node across expand-collapse) → container drag vs child drag → **right-button pan over a node** → **event ordering** (a drag emits exactly one `dragend`; click and dblclick are disambiguated) → `fit` → viewport `get`/`set` round-trip → `resize` → error handling on a malformed scene → **`destroy()` twice is safe**.

### 8.4 Changing the renderer

> Changing the renderer changes **the composition root plus the new adapter's files**. **No code in `contract/`, `domain/` or `projection/` changes** — and that is enforced by the import-DAG architecture test, not by hope.

1. Write `src/adapters/<lib>/<Lib>Renderer.ts implements GraphRenderer`.
2. Run the conformance suite against it, plus the browser smoke.
3. Change the wiring in `src/main.tsx`.

**`FakeRenderer` is the continuous proof the seam is real**: it implements `GraphRenderer`, records the last scene, and injects events. Every controller test runs against it, headless. If a controller test ever needs Cytoscape, the seam has been broken and CI says so. **`FakeRenderer` does not substitute for the browser** — it cannot prove canvas output, hit-testing or real event behaviour. That is what §12's Playwright smoke is for, and it is mandatory.

## 9. State, interaction, accessibility

### 9.1 State

```ts
interface AppState {
  raw:       DeepReadonly<JsonValue>;   // immutable extension envelope (§3.3)
  model:     GraphModel;                // derived index
  outline:   Outline;                   // v1: OwnershipOutline
  view:      ViewState;                 // THE single mutable authority: expanded, positions, viewport
  selection: { nodeIds: readonly string[]; edgeId: VisibleEdgeId | InternalBucketId | null };
  search:    { query: string; matches: ReadonlySet<string> };
  filters:   { nodeKinds: ReadonlySet<string>; edgeKinds: ReadonlySet<string>; hideTests: boolean };
  readOnly:  boolean;                   // set when `requires[]` is unsatisfiable (§3.4)
}
```

Commands are pure — `(state, command) => state`: `Expand` · `Collapse` · `ToggleExpand` · `ExpandAll` · `CollapseAll` · `ExpandTo` · `MoveNode` · `ResetLayout` · `Select` · `SetSearch` · `SetFilter` · `SetViewport` · `Import` · `Refresh`.

### 9.2 The loop

```
UI intent ──▶ controller.dispatch(command)
                ├─▶ commands.apply(state, cmd)              ──▶ new AppState     (pure)
                ├─▶ projection.project(model, outline, exp) ──▶ VisibleGraph     (pure)
                ├─▶ scene.build(visibleGraph, registry, st) ──▶ RenderScene      (pure)
                └─▶ renderer.render(scene)                                        (adapter)

renderer event ──▶ controller.handle(event) ──▶ dispatch(command) ──▶ (loop)
```

Three pure steps, one impure call. Everything above `render` is testable without a DOM.

### 9.3 Interactions

* **Double-click a container** → `ToggleExpand`; children lazily laid out and persisted (§7).
* **Drag** → `MoveNode` → pinned; container drags translate the subtree.
* **Right-button drag anywhere** → viewport pan; hit-testing cannot reinterpret it as a node/container drag, selection, or background click, and the browser context menu is suppressed over the canvas.
* **Click a node** → detail panel: kind, real physical path, breadcrumb, metadata, evidence, child count, and its **internal buckets** — *which* relations are hidden inside it, by kind, each drillable to its logical edges and evidence. Not a bare number.
* **Click an aggregated edge** → detail panel lists its `sourceEdgeIds`: every logical relation, both endpoints, `confidence`, and evidence (`path:line`, plus the snippet if the document has one). **This is where the product delivers its promise.**
* **Search** → matches highlight, others dim; `ExpandTo` reveals a hit hidden inside collapsed ancestors.
* **Coverage banner** → if any relation family is `degraded` or `unavailable`, the UI says so, with the reason. A quiet map is not a trustworthy map.
* **Initial view** → `expanded = { repository }`: the repository, **5 applications, 2 npm packages and 2 Rust crates** — ten boxes. Not 705 overlapping files. Asserted by test (§12) and measured by the browser smoke.

### 9.4 Accessibility (minimum, in v1)

A canvas must not be the only way in.

* A **searchable node list panel**: every node reachable, selectable and expandable from a keyboard-navigable list.
* Expand / collapse / fit / zoom / reset available as **toolbar buttons and keyboard shortcuts**, not mouse-only.
* Visible focus ring; accessible names on all panels and controls; selection changes announced via `aria-live`.
* The detail panel is ordinary focusable DOM — evidence is readable and copyable without touching the canvas.

Rich a11y beyond this is deferred; this floor is not.

## 10. The extractor

`VisualSpecs/tools/extractor/`. A Node/TypeScript CLI inside the Visual Specs package, sharing `src/contract/` with the app.

```powershell
npm run extract -- --repo C:\path\to\AgentsCommander --out data\agentscommander.json
```

Sharing the contract means **the extractor's output is validated by the same `validate()` the app uses on import** — one definition of a valid document, so the tool and the app cannot drift *in shape*. It does **not** prevent the extractor from emitting semantically wrong relations; only evidence, coverage levels and golden tests do that. (An earlier draft over-claimed here.)

Node rather than Rust because it gives **one toolchain and a shared contract**, and because the TypeScript compiler API is needed anyway (§10.2). A Rust crate under `VisualSpecs/` is **possible** — a nested or excluded workspace would keep it out of the root `members = ["crates/*"]` — just costlier for this product. The earlier "Cargo makes it impossible" was a false dichotomy.

### 10.1 Files and manifests

`git ls-files -z` — **NUL-separated**, so paths containing spaces, quotes or newlines survive — invoked with an **argument array, never a shell string** (§11). `git rev-parse HEAD` records the commit. Then every tracked `package.json` and `Cargo.toml` is parsed; a root `Cargo.toml` with `[workspace]` and no `[package]` is a workspace, not a package; a `package.json` with no `workspaces` key is a single package. **Both cases occur here** — verified.

### 10.2 TypeScript imports

Discovery and resolution are **two different problems**, and an earlier draft conflated them.

* **Discovery**: `ts.preProcessFile(text, true, true)` returns every import specifier with its position, without a type-check. It is a fast scanner — it takes text and flags, and it does **not** receive a filename or `CompilerOptions`. **It cannot, by itself, apply `moduleResolution`, `paths`, `extends`, or extension rules.**
* **Resolution**: load the project's tsconfig with `ts.readConfigFile` + `ts.parseJsonConfigFileContent`, then resolve each specifier with **`ts.resolveModuleName(specifier, containingFile, compilerOptions, host)`**, restricted to git-tracked files under the repo root. AgentsCommander declares `moduleResolution: "bundler"` and `paths` for `@shared/*`, `@sidebar/*`, `@terminal/*` — the resolver must honour them, not a hard-coded extension list. (Those aliases currently have **zero** usages in `src/` — verified — so the alias path is exercised by fixtures, and that fact is recorded rather than mistaken for "unsupported".)
* Bare specifiers (`solid-js`, `@tauri-apps/api/core`) → external; counted in `stats`, **not** emitted as nodes in v1.
* Anything the resolver cannot place inside the tracked tree → **`unresolved[]` with evidence**. Never a guess.
* Fixtures for: `.ts/.tsx/.mts/.cts/.d.ts/.json`, `index` resolution, re-export, `import type`, `export type … from`, literal dynamic `import()`, import attributes, a `paths` alias, and a `tsconfig` `extends` chain.

### 10.3 Rust imports

A naive line scanner is not adequate, and the repository proves it: **grouped use-trees are real** — `use crate::{…}`, `use crate::a::{…}`, `use super::{…}`. The extractor's own parser counts **813** of them (`stats.rustGroupedUseStatements`, pinned by the dataset test). A per-line regex mis-parses every one.

> **813 includes one known false positive**, and the dataset test names it rather than absorbing it. `stripComments` removes comments but copies **string literals** through, so `parseUseStatements` scans string contents as code: the English word `use` in a `format!` template at `src-tauri/src/commands/entity_creation.rs:388` opens a statement that runs to the next `;` and parses the surrounding arguments as a six-leaf group. An independent re-implementation counts **812** real grouped use-trees. The defect is stable across commits — 752+1 at `0a3dc5a`, 812+1 at `1b0e934` — so it distorts the level, never the trend.

> An earlier draft of this document said "26 times across 21 files". That number came from a grep, it was never reproduced by a parser, and it is not what the parser measures — which is the whole point of §10.5. The figure above is the one the tool produces, and if the tool changes, the test changes with it.

* A **dedicated use-tree parser** (paths, `{}` groups, `as` aliases, `self`, `*`) — a small, well-defined grammar, ~120 lines, unit-tested. No native dependency.
* `mod foo;` → resolved to `<dir>/foo.rs` or `<dir>/foo/mod.rs`; `'resolved'` when the file exists, and **checked, never assumed** — inline `#[cfg(test)] mod tests { … }` has no backing file.
* `use crate::…`, `use super::…`, `use self::…` → longest-prefix resolution to a file within the crate.
* Glob imports (`use crate::foo::*`) → **`unresolved`**, with evidence. Not a guess.
* **Coverage: `degraded`, permanently and honestly.** No macro expansion, no `#[path = "…"]`, no `cfg` evaluation, no symbol resolution. Rust import edges carry `confidence: 'heuristic'` and their evidence line so a reader can check them.

### 10.4 Command relations: a transport contract with two backends

This is the relation that makes the map worth reading, and it is where the earlier draft was most wrong. It called the relation "Tauri IPC" and matched a bare `invoke("name")`. **The repository does not work that way.**

What is actually there, all verified:

* `src/shared/ipc.ts` defines a **facade**: `const transport = { invoke: <T>(cmd, args) => currentTransport().invoke<T>(cmd, args), … }`, and every command call in the frontend goes through it as `transport.invoke<T>("name", args)` — **140 call sites, all in that one file** (`stats.invokeCallSites`, pinned by the dataset test).
* `createDefaultTransport()` returns **`isTauri ? new TauriTransport() : new WsTransport()`**. `TauriTransport` dynamically imports `@tauri-apps/api/core` and calls its `invoke`. `WsTransport.invoke(cmd, args)` sends `{id, cmd, args}` **over a WebSocket**.
* **So a call site is not unconditionally Tauri IPC.** It is a *command contract* with **two backends**, selected at runtime by platform.
* Backend 1 — **Tauri**: `#[tauri::command]` attributes (**138**, across 20 files, using an *anchored* pattern — `stats.tauriCommandAttributes` and `stats.tauriCommandAttributeFiles`) **plus** registration in `tauri::generate_handler![…]` at `src-tauri/src/lib.rs:2550`. Tauri requires that registration; an unregistered attribute is not callable.
* Backend 2 — **the web router**: `src-tauri/src/web/commands.rs`, a `match` with **46 arms** keyed by command name (`stats.webRouterArms`), reached over the WebSocket transport. Counting these requires stripping comments first: a brace inside a comment truncates the `match` block and a naive count reports 39.

The extraction rules that follow:

| Emit | Requires | Confidence |
|---|---|---|
| `tauri-command` | (1) literal call through the configured facade, **(2)** `#[tauri::command]` on `fn <name>`, **(3)** registration in `generate_handler!` | `resolved` — **all three**, each contributing evidence |
| `web-command` | (1) literal call, (2) a matching arm in the web router | `resolved` |
| *nothing* | fewer than the required pieces, or a non-literal command name | → **`unresolved[]`** with evidence |

The facade is a **configurable rule** (`--invoke-facade "transport.invoke"`, plus bare `invoke(` for repos that call the Tauri API directly), not a hard-coded regex. The facade's own internal `currentTransport().invoke<T>(cmd, args)` — where `cmd` is a **variable** — is precisely the case that must land in `unresolved`, not become a phantom edge.

A command bound to **both** backends produces **two** logical edges with different targets. That is not double-counting: they are two different facts, and seeing both is the point.

Verified consequences that the earlier draft got wrong:

* `subscribe_session` (`src-tauri/src/web/commands.rs:570`) and `get_pty_size` (`:594`) are **web-router only** — they are *not* `#[tauri::command]`. They resolve as `web-command` and are **unresolved as Tauri**.
* `get_instance_label` is defined (`src-tauri/src/commands/config.rs:2004`) and registered (`src-tauri/src/lib.rs:2644`) but has **no call site in `ipc.ts`** — a **registered-but-uncalled command**. An earlier draft of this document asserted `"unusedCommands": []`. That was false. It is also why the drawn `tauri-command` aggregate is **137** and not the 138 that are registered.

### 10.5 Counts come from parsers, not from greps

The previous version of this document asserted three numbers as observed fact. Two were wrong and one was invented:

* "135 `#[tauri::command]`" — an **unanchored grep**, which also matched a comment at `src-tauri/src/commands/task.rs`. At `1b0e934` the same mistake would report **141** across 21 files, three of them prose inside comments; the anchored count is **138** across 20 files.
* "131 invoke sites in `ipc.ts`, 136 overall" — the regex matched `invoke` in unrelated contexts. The real figure at `1b0e934` is **140 `transport.invoke` sites, all in `ipc.ts`**.
* `"unusedCommands": []` — never measured. It is **false**; see `get_instance_label` above.

Hence the rule, which is now part of the product: **every dataset count must be produced by an anchored pattern or a parser, and pinned by a fixture test. A raw grep is not evidence.** A tool whose purpose is to let people trust a map without reading the code cannot afford to be casual about its own numbers.

### 10.6 Determinism, provenance, and errors

The **canonical payload** — `nodes`, `edges`, `coverage`, `unresolved` — is byte-identical across two runs on the same commit with the same flags. `generator.generatedAt` is **excluded** from it (injected or omitted). `generator.configDigest` hashes the flags and resolver configuration, so a document declares the configuration that produced it.

`data/agentscommander.json` carries `source.commit`, `generator.version`, `generator.flags` and `generator.configDigest`, and the README carries the exact regeneration command. A test fails if the committed document's content is inconsistent with its declared flags.

**Extractor error contract** — every one deterministic, with a distinct non-zero exit code and a machine-readable message: not a Git repository · `git` not on PATH · unreadable or binary file · symlink escaping the root · invalid encoding · invalid or missing tsconfig · `--out` outside the working root.

### 10.7 Tests run on fixtures, not on a neighbouring repo

Visual Specs tests must pass on a clean checkout of **CodebaseConstellation**, where AgentsCommander — a *different repository* — is simply absent. So the extractor's tests run against a small fixture repo in `tools/extractor/fixtures/` (an npm package, a crate, a `tauri.conf.json`, grouped Rust use-trees, a `paths` alias, a facade call resolving to Tauri, one resolving only to the web router, one registered-but-uncalled command, and one deliberately unresolvable dynamic call). `data/agentscommander.json` is generated once and committed, and validated by the dataset test (§12).

## 11. Security and privacy

Everything is local. **No network calls, no telemetry, no remote assets** — dependencies are bundled. `index.html` carries a CSP with `connect-src 'self'`, so an imported document cannot cause the app to phone home. The architecture test asserts that no runtime source uses `fetch`, `XMLHttpRequest`, `WebSocket`, dynamic script injection, or a remote asset URL.

**An imported document is untrusted input.**

| Threat | Mitigation |
|---|---|
| **Prototype pollution** | `__proto__`, `constructor`, `prototype` as keys **anywhere** → **hard rejection** (`SchemaError`), not preservation. This is the one place forward-compatibility yields to safety, and the contract says so out loud. Internal maps use `Object.create(null)`. |
| **XSS** via `label`, `path`, `note`, `snippet` | No `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval` or `new Function` — **enforced by an AST-based sink check** in the architecture test, not by grepping for strings. Text reaches the DOM only through escaped interpolation, and the canvas via text drawing. |
| **Non-finite / absurd numbers** | `1e400` parses to `Infinity` and destroys a layout. All `view` numbers must be finite; `zoom > 0`; coordinates and zoom bounded (**I11**). |
| **Denial of service** | Caps on bytes, node count, edge count, string length, JSON depth and evidence count, checked **before** graph construction. Exceeding a cap is a `SchemaError`, not a hung tab. |
| **Path traversal / repo escape** | Known path fields are validated **POSIX-relative**: no absolute, no drive letter, no UNC, **no backslash**, no `..` segment, no NUL, no control characters, no empty segment. `source.root` is a validated basename. The **app never reads a file from disk based on document content.** |
| **Symlink escape (extractor)** | `git ls-files` can list a tracked symlink pointing outside the repository. Before reading any file, its real path is resolved and **asserted to be inside the repo root**; otherwise it is skipped and recorded in `unresolved`. The extractor must not be a repo-escape primitive, even though AgentsCommander has no such symlinks today. |
| **Shell injection (extractor)** | Git is invoked with an **argument array** (`execFile`), never an interpolated shell string, and read with `-z`. |

**Privacy, scoped honestly.** The no-absolute-path guarantee (**I7**) covers **known path fields only**: `node.path`, `Evidence.path`, `source.root`. It **cannot** be claimed for `metadata`, `label`, `note`, `snippet`, or preserved unknown fields, which are free-form by design — and preserving unknown fields is, unavoidably, in tension with sanitising them. The resolution: those fields are **scanned, and absolute-path-looking values are surfaced as warnings**, never silently rewritten and never claimed to be clean.

**Snippets are opt-in, and off by default.** Evidence defaults to `path` + `line`, which is sufficient to find the code. `--snippets` enables verbatim source text and prints a warning that it may copy a secret from the repository into a JSON document that is then committed. The earlier default was on; that was the wrong default.

## 12. Testing

Almost all of the product is pure, so almost all of the tests are fast and headless — but **not all of them**, and the browser test is not optional.

**`npm run verify` = `vitest run` + `tsc --noEmit` + `vite build` + the adapter smoke + the acceptance smoke.** (`npm run build` alone does not run tests; the single verification command exists so that "green" means something.) The browser gate arrives in **two phases** — an early adapter smoke that needs no dataset, and the final acceptance smoke that needs the real one. Both are mandatory and neither substitutes for the other; see §16.3.

| Layer | What is proven |
|---|---|
| **contract** | Semantic round-trip including **deeply nested unknown fields** at root/node/edge/evidence/source/generator/view/position — **surviving `Load → MoveNode → ToggleExpand → Export`**. Canonical key/array order. The version matrix (§3.4), including `requires[]` → read-only. Dangerous-key rejection. Finite numbers, `1e400`, zoom bounds. Caps: bytes, nodes, edges, string length, depth. `import` vs `refresh`, and the loss report. |
| **domain** | Hierarchy queries; deterministic child order; **command purity** (the model is deep-frozen; a long random command sequence must not mutate it — **I8**). Pinning: an auto-repack never moves a pinned node. Container drag translates the subtree exactly. |
| **projection** | NVA correctness. **File→file projects to container→container; expanding restores the specific endpoints.** Aggregation `count` + `sourceEdgeIds`, **identical under a shuffled input document**. **The partition law (I9)** as a property test over seeded pseudo-random expand/collapse sequences — *including the placement check*, so an id in the wrong bucket fails. Internal buckets keep their ids. **Adversarial ids**: `\|`, `:`, `->`, `#`, Unicode, RTL marks, emoji. **Filters are a mask**: applying any filter leaves NVA and the partition law unchanged. |
| **outline (C1)** | The **same** projection, aggregation and partition law run against a **second, fixture-only `AppCentricOutline`** over the same entities. The **N:M fixture** — one app bundling a package *and* a crate, one crate bundled by two apps — asserts no membership is lost and no `sourceEdgeId` is duplicated. **I10** (injectivity) is validated. |
| **app / controller** | Against `FakeRenderer`, headless: expand, drag, **move → export → reload restores position**, search reveals a hidden hit, selecting an aggregated edge surfaces its `sourceEdgeIds`, selecting a container surfaces its internal buckets. |
| **adapters** | The shared conformance suite (§8.3) against `FakeRenderer` **and** `Canvas2DRenderer` — the latter in a real browser, where `skipped === 0` is asserted, so a DOM adapter cannot quietly decline the input cases. |
| **browser smoke (Playwright, mandatory)** | Loads the **real committed dataset**; asserts the canvas is **not blank** (pixel sample); asserts the initial view is **legible** — node bounds do **not overlap**, labels are rendered, `fit` leaves padding; expand → collapse; **drag → export → reload → position restored**; click an aggregated edge → the detail panel lists its logical relations; captures a screenshot artifact. `web/` already demonstrates this pattern; Visual Specs brings its own dependency and imports nothing from it. |
| **geometry** | A deterministic unit test asserts the initial view's node bounds do not overlap and labels fit — the cheap gate that runs on every commit, with the browser smoke as the real proof. **`≤15 visible nodes` is necessary but not sufficient**, and is no longer the only check. |
| **architecture** | The import DAG (§2), by parsing every source with the TypeScript API: no renderer/storage adapter outside `adapters/`; `app/` never imports `ui/`; nothing imports outside `VisualSpecs/`; FSA/pickers/IDB stay in `adapters/filesystem/`; `Blob`/`URL` stay under `adapters/`. Plus the **AST sink check** (§11). |
| **extractor** | Golden output over the fixture repo. **Determinism**: two runs, identical canonical payload. Output validates against `contract/validate`. Unit tests for TS resolution via tsconfig; **Rust grouped use-trees**; the facade rule; the **three-evidence Tauri rule**; a web-router-only command; a registered-but-uncalled command; a non-literal call landing in `unresolved`. The error contract (§10.6). |
| **privacy** | Hostile fixtures: absolute path, `..`, UNC, backslash, NUL, a path containing a newline, a symlink escaping the root, `__proto__`, `1e400`, a depth bomb, an oversized document, and a simulated secret in a snippet. |
| **dataset** | Loads `data/agentscommander.json`; validates it; asserts a single acyclic root, no dangling ids, no absolute paths in known path fields; asserts the declared flags match the content; asserts the initial view is legible. |

## 13. Implementation order

Each step is shippable and leaves `npm run verify` green.

| # | Step | Delivers |
|---|---|---|
| **0** | Scaffold + **the architecture test and `npm run verify` on day one**. | The guardrail exists *before* the code it guards. Added last, it never lands. |
| **1** | `contract/`: types, versioning, raw envelope, canonical serialisation, validator, typed errors, caps, dangerous keys, finite numbers. `import` vs `refresh`. | Round-trip and persistence criteria, complete. |
| **2** | `domain/` + `projection/`: model index, **`Outline` port**, `OwnershipOutline`, commands, NVA, nested-Map bucketing, visible/internal buckets, partition law. | **The two hard semantics, provable headless, with no UI in existence.** Plus the N:M fixture and the second outline. |
| **3** | `ports/` + `FakeRenderer` + controller + scene builder + geometry/`gridPack` + pinning. | Every interaction and the geometry, tested without a browser. |
| **4** | **Adapter spike + gate**: an adapter must pass conformance **and** the browser smoke, or it is replaced. **Outcome: the gate was decided against Cytoscape, and `Canvas2DRenderer` ships** (§16.6, `ADR-0002`). | The renderer decision is *settled by evidence*, not asserted. |
| **5** | Import/export UI, persistence, `refresh` + loss report. | Drag → export → reload, end to end. |
| **6** | `tools/extractor/`: files → manifests → ownership → apps → TS resolution → Rust use-trees → transport commands (3-evidence rule) → coverage/unresolved → emit + validate. Fixtures, determinism, error contract. | A reproducible, honest tool. |
| **7** | Generate and commit `data/agentscommander.json` with full provenance; dataset test. | **The real map, with real numbers.** |
| **8** | Detail panel (evidence, `sourceEdgeIds`, internal buckets), search, list panel, legend, breadcrumb, filters, coverage banner, **accessibility floor (§9.4)**. | The product's actual promise. |
| **9** | README + ADRs. | Usage, contract, extractor, limits, renderer swap, preserved principles. |

Steps 1–2 deliver both hard semantics with no renderer, no UI and no framework in the repository. If they are wrong, we find out on day two, in a unit test.

## 14. Relationship to the existing pipeline

Visual Specs is self-contained in `VisualSpecs/` and imports nothing from `web/`, `crates/`, `schema/`, `graph-analytics/` or root `fixtures/`; it is **not** added to the root `Cargo.toml`, which stays `members = ["crates/*"]`. At runtime it writes only `.visual-specs/` inside a user-selected directory, and only after explicit browser permission. The architecture test asserts no import escapes `VisualSpecs/`, and the boundary test also asserts that Visual Specs **scripts** neither read nor write `web/` artifacts.

### What is preserved

These principles come from `schema/README.md`, ADR 0001 and `constellation-ingest`, and they were right. Visual Specs keeps them — in its own code:

* **Git-tracked paths only.**
* **Deterministic, stable identities.**
* **An open vocabulary** rather than a closed enum.
* **Evidence and `confidence` on every inferred relation.**
* **Capability gates** — `available | degraded | unavailable` per relation family. A non-empty relation set is not automatically trustworthy, and the UI shows the gate.
* **Conformance testing** as the way a replaceable component earns its place.

### What is deliberately not reused

* The **SQLite snapshot store**, the **WebGL/three renderer**, and the **Python analytics** pipeline — kept, untouched, and not taken as a dependency.
* **`contains` as an edge.** That is *correct* for an immutable SQLite snapshot, where containment is just another queryable relation. It is *wrong* for a collapsible NVA-projected view, where a containment edge would project onto itself (**I5**). The two models disagree because they answer different questions, not because one is a mistake.

### Not duplicating bugs

`constellation-ingest` already extracts TS/Rust imports. Reimplementing that is a real maintenance cost, and the mitigation is not to copy code (the brief forbids depending on it) but to **share a documented fixture corpus**: a mini-repo whose expected import semantics are written down, which both extractors can be run against, so the two either agree or say why they differ.

## 15. Known limits

* Granularity stops at the **file**. No functions, no symbols.
* **Renames are not tracked.** A moved file is a new id and loses its stored position.
* **Rust import coverage is `degraded`**, permanently: no macro expansion, no `#[path]`, no `cfg` evaluation; glob imports go to `unresolved`.
* **Command edges are literal-only.** A command name assembled at runtime — including the facade's own internal dispatch — is `unresolved` by design, not invisible.
* **External packages are not nodes** in v1; they are counted in `stats`.
* **Multi-placement outlines are not implemented** (§5.4). v1 validates injectivity; the generalised law is named, not shipped.
* The default layout is a deterministic **grid pack**, not an optimised one. Expect crossings until you rearrange — and the arrangement you make is saved.
* **Privacy is guaranteed only for known path fields** (§11). Free-form fields are scanned and warned about, not sanitised.
* Snippets are **off by default**; enabling them may copy source text, including secrets, into the document.
* The acceptance smoke drives the **dev server**, not the production bundle. `npm run verify` runs `vite build` separately, so a build failure still fails the gate — but the artifact the browser loads is not the built one.
* A pinned child dragged outside its container grows the container **symmetrically about its own centre** (§7), so the user's stored position never moves. It can therefore overlap the container's header. The user did it, and nothing is lost.

## 16. Corrections the implementation made to this document

This document was published on a **2–1 vote**. Building it settled the three dissents and
turned up four errata. Everything below is a change to what this document *asserts*, made
because the code proved it necessary — not a change of taste. Two have their own ADR.

### 16.1 The N:M outline — dissent 1 (§5.4)

An injective `placementOf` (I10) **cannot** place one package under two applications, so a
fixture outline that "places packages under the applications that bundle them" was an
impossible promise. v1 ships **primary placement**: each entity is placed exactly once, under
a deterministically chosen parent, and **every other membership stays a `bundles` edge**,
which projects through NVA like any other relation. The test proves *no membership is lost*;
it does not claim multi-placement, which is named, specified and **not shipped**.
`assertInjective()` makes I10 an executable check rather than an assumption.
→ `ADR-0001-outline-placement.md`.

### 16.2 The deep round-trip — dissent 2 (§3.3)

`export()` **deep-merges** the ViewState over `raw.view`; it does not replace that subtree.
Replacing it silently drops unknown fields *inside* `view`, *inside* each `Position` and
*inside* `viewport` — precisely the loss the raw envelope exists to prevent. Positions for ids
that are not in the graph are kept (they are `import`'s promise, and only `refresh` may drop
them). Only arrays whose order carries no meaning are canonicalised — `nodes`, `edges`,
`view.expanded`. **`generator.flags` is never reordered:** a flag list is not a set, and
sorting it would corrupt the provenance the document exists to declare.

### 16.3 Verify by phases — dissent 3 (§12, §13)

The browser gate arrives in **two** phases, and the early one may not demand features that do
not exist yet:

* `npm run smoke:adapter` — the shared conformance suite against the real adapter, on a
  synthetic fixture scene. **No dataset, no UI, no extractor.** Runnable from step 4.
* `npm run smoke` — the acceptance smoke against the **real committed dataset**.
* `npm run verify` = `vitest run` + `tsc --noEmit` + `vite build` + **both** smokes.
* `npm run verify:core` = tests + typecheck, for the inner loop.

### 16.4 `path: ""` (§3.1, §3.2, §11)

The worked example showed `"path": ""` on a package while §11 forbade an empty path segment,
so the example contradicted the validator. **Resolved in the validator, not in prose:** the
empty path means *the repository root directory*, and it is accepted **only** for a root node
(`parentId === null`) or a node that **declares** `metadata.rootAnchor: true`. Any other node
carrying `path: ""` is a `SchemaError`. The extractor sets the flag on the root anchor, and a
hostile fixture asserts the rejection.

### 16.5 Non-finite numbers are rejected **document-wide** (I11)

I11 required finite numbers only inside `view`. That is not enough: `JSON.parse('1e400')`
yields `Infinity`, `JSON.stringify(Infinity)` yields `null`, so a non-finite number *anywhere*
— in `metadata`, in a preserved unknown field — would silently become `null` on export and
**break the round-trip promise of §3.3**. Validation now rejects a non-finite number anywhere
in the document.

### 16.6 The renderer gate was decided against Cytoscape (§8.2, §13 step 4)

v1 ships a hand-rolled **Canvas 2D** adapter and zero runtime dependencies. The exit criterion
was honoured in full — the shared conformance suite passes against the real adapter in a real
browser with real pointer events — but the spike was decided on its requirements rather than
run to failure, and that deviation is recorded rather than skipped.
→ `ADR-0002-renderer.md`.

### 16.7 Edge routing is part of the port (§6.3, §8.1)

§6.3 insists that `bundles` and `imports` between the same visible pair "stay two edges: they
are different facts". On the real dataset **four** typed relations join the root npm package
and the Tauri crate. Keeping them distinct in the model and then drawing them **on top of one
another** tells the same lie in pixels: you cannot see them, and you cannot click the one you
want — including the aggregated command edge, which is the single most important click in the
product. **Edge routing therefore moved into `ports/renderer.ts`** (`routeEdges`,
`EDGE_FAN_SPACING`): every adapter fans parallel relations out identically, each is separately
visible and separately clickable, and a test can compute where a line is without copying an
adapter's internals. Two cases in the shared conformance suite pin it.

Relatedly: an **expanded container is a backdrop**. A line within tolerance wins over it, and
never over a leaf or a collapsed box.

### 16.8 `ui/` may import the inner, pure layers (§2)

§2 says "`ui/` imports `app/` and `ports/`". The detail panel renders `Evidence`, `VisualSpecsEdge`
and `InternalBucket` values directly, and routing those types back out through `app/` would be
re-export ceremony with no architectural benefit. The rule the architecture test enforces is
the **directional** one, without exception: no inner layer imports an outer one, `app/` never
imports `ui/`, and nothing but a composition root touches `adapters/`.

### 16.9 `expanded: []` is a VALUE, not an absence (§3.6, §9.3)

§3.6 says "`view` is optional. An extractor document has none; the app computes a deterministic
initial layout." The first implementation asked `expanded.size === 0` — and an extractor
document with **no view** and a user's document with an **empty one** are indistinguishable
that way. So `Collapse all → Export → Import` came back **expanded**: the app silently
overrode a decision the user had made and saved.

`importDoc` now reports `viewProvided: { expanded, positions, viewport }` — what the document
*said*, as opposed to what it happens to contain — and the initial view is computed only when
the document provided no expansion. `refresh` carries the previous expansion across
authoritatively, empty or not.

Six acceptance tests were green while this was broken, because the smoke called an
export/import **hook on the same controller** and never restored anything from bytes. A test
that says "reload" and means "method call" is a test that has stopped being evidence.

### 16.10 A Rust `crate` is a first-class kind (§5.2, §6.6)

Two of AgentsCommander's four anchors are crates. Emitting them as `kind: "package"` with
`metadata.ecosystem: "cargo"` made the reader translate — which is precisely the work the map
exists to do for them. Cargo anchors are now `crate`, npm anchors are `package`, and the
canonical order is `repository < application < package < crate < directory < file`.

**Ids are unchanged** (`pkg:cargo:…`), so a stored layout survives the distinction — which is
the property §5.2 promised and this is the first thing to test it. The distinction is carried
by SHAPE (a clipped corner) as well as colour, so it survives a colour-blind reader.

### 16.11 The privacy scanner covers the document, not three field names (§11)

§11 promises that free-form values are "scanned, and absolute-path-looking values are surfaced
as warnings". The first implementation only looked at `label`, `note` and `snippet`, so
`metadata.cwd = "C:\\Users\\secret"` — and any preserved unknown field, and anything nested in
an object or an array — produced nothing at all. The mitigation the document described did not
exist, which is worse than not having it: the user was told the app would point at the leak.

Every string, at every depth, is scanned now. Known path fields remain a hard rejection.

### 16.12 The extractor is not a file primitive (§11)

Three separate copies of the same containment guard, and all three were wrong on Windows:

    const rel = relative(root, candidate);
    if (rel === '' || rel.split(sep)[0] === '..') reject();

`path.win32.relative('C:\\repo', 'D:\\outside')` returns `'D:\\outside'` — **absolute**, with
no `..` in it — so `--out D:\anywhere` passed, a tracked symlink to another drive was not an
escape, and a TypeScript import resolved to another drive looked internal. One policy now
lives in `tools/extractor/confine.ts` and every caller uses it:

* an **absolute** result of `relative()` is an escape;
* `--out` is checked against the **real** path of the deepest existing entry, and **again
  immediately before the write** (`mkdir -p` follows a junction);
* a path that **cannot be resolved** — a broken or inaccessible link — is **refused**. A
  security check that cannot prove containment must fail closed, and `existsSync` follows
  links, so a dangling symlink looked "absent" and was waved through to its parent;
* lexical failure and symlink failure get **different exit codes** (8 and 5), because one is a
  typo and the other is worth investigating;
* an escape is **reported, never clamped**: `src/../../../package.json` used to normalise to
  `package.json`, a real tracked file, so an import pointing *outside* the repository became an
  edge to an unrelated file *inside* it;
* `--tsconfig` must be inside the repository, and TypeScript reads through a **confined host**,
  so an `extends` chain reaching outside fails as an ordinary tsconfig error rather than making
  the compiler read arbitrary files on our behalf.

Exit 5 is for an **output** that escapes. A tracked **source** symlink that escapes is skipped
and recorded in `unresolved` — the first draft's error contract claimed both, which was never
true of the code.

### 16.13 Two clicks on a line must not close the box it crosses (§8.3)

The double-click was derived from the node *under the pointer*, resolved BEFORE deciding that
an edge had won over an expanded container's backdrop. So clicking twice on the aggregated
command relation emitted `node:dblclick` on the repository and **collapsed it**: the box shut
in your face while you were trying to read the relation. The winning target is resolved first
now, and only a node target may produce a double-click.

### 16.14 The gate has to be trustworthy (§12)

* `reuseExistingServer: false`, and Vite is spawned as `node .../vite.js` with `--strictPort`,
  so a stale server cannot answer for a tree that is not on disk and Playwright kills the
  process that is actually listening rather than an `npm` wrapper around it.
* The acceptance smoke writes its screenshots to `testInfo.outputPath()`. It used to write
  them into `docs/`, so **every run of the gate rewrote the documentation it was checking**.
  The canonical captures have their own command, `npm run update:screenshots`.
* `git` is invoked with its stderr **captured**, not inherited — the error-contract test used
  to print `fatal: not a git repository` into the middle of an otherwise green run.
* The browser test hooks and `conformance.html` exist only in dev/test builds.

### 16.15 The map has to fit in a window (§9.4)

Fixed `290px 1fr 380px` columns left an 800×800 window **130 pixels** of canvas. The panels
are drawers now: docked above 1200px, floating over the canvas below it, and always one key or
one button away. The acceptance smoke measures the canvas at 1680×1000, 1024×768 and 800×800 —
because a screenshot proves it was drawn, not that it was usable.

Also, the accessibility floor §9.4 promised: zoom exists (toolbar and `+`/`-`, through the
controller and a `zoomBy` port method — the UI never touches the adapter), and `aria-live`
announces a node, an **aggregated relation** and an **internal bucket**. It used to return
early when no node was selected, so the single most important thing this product can tell you
was the one thing it would not say out loud.

### 16.16 A new kind must not arrive switched off (§3.7)

`Refresh` copied the user's filters verbatim, so any node or edge kind introduced by a newer
extraction was **hidden by default**. That is the exact opposite of what an OPEN vocabulary is
for. A kind the user switched off stays off; a kind they have never seen is shown.

### 16.18 `generator.flags` is a configuration, not a transcript (§3.1)

The field was documented as "exact CLI flags used", and it is not — deliberately. `--repo`
and `--out` are excluded because they name the operator's filesystem, and printing an
absolute path into a document that is about to be committed is a leak, not provenance.
`--stamp` is excluded because it only controls `generatedAt`, which is not part of the
deterministic payload. What is recorded is every flag that determines the CONTENT, plus the
defaults it fell back to, all hashed into `configDigest` — so the document declares the
configuration that produced it without declaring where it lives.

### 16.19 `frontendDist` is the anchor; a build command is not evidence (§5.3, §10.1)

The Tauri npm bundle was inferred from `beforeBuildCommand || frontendDist`. When only the
command was present, the code defaulted the output directory to `''` and pinned the bundle
on the ROOT npm package — inferring *what an app ships* from the fact that it runs *some*
command. `npm run build` tells you a build happens; it does not tell you where the output
lands. No `frontendDist` resolving inside the repository ⇒ **no npm bundle edge**.

And among the npm anchors that *could* own the output, the nearest one wins — the longest
directory prefix, exactly as §5.2 already says ownership works. The first cut took the first
`.find()` match, which meant the root always won, because `''` is a prefix of everything and
sorts first. That is not "nearest manifest wins"; it is "whichever manifest I read first
wins".

### 16.20 A manifest is untrusted input too (§11)

`package.json#bin`, Cargo's `[[bin]].path` and `frontendDist` are strings somebody wrote, and
the path normaliser turned every one of these into a path *inside* the repository:

    joinPath('',          '/package.json')   →  'package.json'          ← a real, tracked file
    joinPath('src-tauri', '/package.json')   →  'src-tauri/package.json'
    joinPath('',          'C:/secret')       →  'C:/secret'
    joinPath('',          'src\\main.ts')    →  'src\\main.ts'

An ABSOLUTE declaration silently rewritten as a relative one can then match a tracked file
and become a relation the map asserts and cannot point at. `isPosixRelative` now rejects a
leading `/` or `\`, a UNC path, a drive-absolute *or drive-relative* path (`C:foo`), any
backslash, and any control character — **before** `.`/`..` are collapsed.

The one deliberate exception is `<script src="/src/main.tsx">`: an HTML document's leading
slash is rooted at the SERVED root, not the filesystem, so exactly one slash is stripped **at
the caller**, in `apps.ts`, where the meaning of the slash is known. `//evil.com/x.js` still
has a leading slash after that strip, and is still refused.

### 16.21 Valid UTF-8 is not invalid UTF-8 (§10.6)

`readTextFile` decoded leniently and then searched the *result* for U+FFFD. But a lenient
decoder SUBSTITUTES U+FFFD for every byte it cannot decode, so that check could not tell
"these bytes are not UTF-8" from "this file legitimately contains the replacement character".
A perfectly valid source file that mentions U+FFFD was refused. It decodes in **fatal mode**
now, which asks the question we actually mean.

### 16.22 `maxBytes` means bytes (§11)

The cap was compared against `text.length`, which counts UTF-16 code units. A document of CJK
or emoji is up to three times bigger than its `.length` suggests, so a denial-of-service guard
could be sailed straight past. It is measured in UTF-8 bytes now — without allocating a copy
of the document to count it — and the file input refuses an oversized file by `file.size`
*before* reading it.

### 16.23 Two clicks, one announcement, one panel

Three small things that each made the product quietly less than it claimed:

* **Internal buckets were not selectable.** The detail panel held an `aria-live` announcement
  for them that **no UI could reach**: the branch existed, and clicking the disclosure only
  opened it. A screen reader never learned that 665 relations had been folded into that box.
  The `<summary>` now selects the bucket through the ordinary command loop.
* **Two floating drawers left 80px of map.** Measuring the canvas said 800×560 and told us
  nothing, because the drawers were lying *on top of it*. Below the breakpoint they are
  mutually exclusive, `Escape` dismisses the open one, and the smoke measures the
  **unobscured** width.
* **`fit()` and `zoomBy()` notified twice.** The renderer emits `viewport:change`, the
  controller applied the identical viewport again, and every zoom re-rendered the UI twice.
  One action, one notification — and the port now says which calls emit and which must not.

### 16.25 A document may not name a commit it cannot back up (§10.1, §10.6)

Found by a mystery, and worth the detour. Two extractions of the same repository at the
same commit, with the same flags, produced different bytes: sixteen `mod` evidence lines
had shifted by one. Determinism is a *promise* here, so this had to be explained rather
than re-run until it agreed.

It was not the extractor. **Someone added a line to a tracked file in the repository being
mapped.**

Which exposed the real defect. The extractor lists files with `git ls-files` — the INDEX —
and reads their CONTENT from the WORKING TREE. So when the tree is dirty, every `path:line`
in every piece of evidence describes the file **on disk**, while `source.commit` says the
document describes a **commit**. The map was asserting a provenance it could not back up,
which is the exact failure mode §10.5 exists to prevent — this time about the tool's own
output rather than about the repository's.

Mapping work in progress is a perfectly reasonable thing to want. Not saying that is what
you did is not. So:

* `source.dirty: true` when tracked files differ from `source.commit`;
* `stats.modifiedTrackedFiles` names them;
* the extractor prints a warning, and **the app shows a banner** — a map that cannot back
  its own provenance says so at the top, next to the coverage gates;
* the committed `data/agentscommander.json` currently comes from a clean checkout, so
  `source.dirty` is absent and `stats.modifiedTrackedFiles` is empty. A future extraction
  from work in progress records the dirty tree and surfaces the banner instead of pretending
  it describes the commit exactly.

Determinism is unchanged, and is now honest about what it is determinism *of*: the same
tree, the same flags, the same bytes. A different tree is a different document, and the
document says which tree it was.

### 16.24 Two things the extractor found that this document had wrong

* **Asset imports are real relations.** `import './styles.css'` and
  `import icon from '../assets/icon-16.png'` are resolved by the bundler, not by `tsc`. The
  first implementation dropped all 20 of them into `unresolved[]` — but their targets are
  **git-tracked files that provably exist**, so joining the specifier to the containing
  directory and checking the tracked set *resolves* them. They are edges, and dropping them
  was losing 20 real relations.
* **A `mod` and a `use` between the same pair of files are one relation with two backings.**
  Merging them naively kept whichever arrived first, so a pair backed by both was labelled
  `via: "mod"`, `confidence: "resolved"`, and the heuristic `use` vanished into it. The merge
  now records `via: ["mod", "use"]` and keeps the strongest confidence — the evidence was never
  the problem; the *character* of the relation was.
