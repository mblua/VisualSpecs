# Visual Specs

A local, self-contained map of a repository that you can read **without reading code**:
repositories, applications, packages and crates, directories and files as boxes; typed,
evidence-carrying relations between them; a hierarchy you expand and collapse by
double-click.

It ships with a committed map of **AgentsCommander** — 705 git-tracked files, 817 nodes,
1947 relations — produced by the extractor in this directory, not typed in by hand.

![The AgentsCommander map](docs/screenshots/agentscommander-map.png)

Visual Specs is local-first. It does not depend on the existing `web/` + SQLite + WebGL
+ `graph-analytics` pipeline, which continues to work unchanged. It has **zero runtime
dependencies** — no graphics library, no framework. Project persistence writes only a
`.visual-specs/` directory after an explicit Create/Open/Save action; there is still no
backend, network persistence, telemetry, or handle storage in IndexedDB.

---

## Quick start

Requires **Node ≥ 22.18** (or ≥ 23.6): the extractor runs `.ts` files directly through
Node's native type stripping, which is why the codebase is `erasableSyntaxOnly` and needs
no transpiler. Developed and verified on Node 24.13.

```powershell
cd VisualSpecs
npm install
npm run dev            # http://localhost:5175
```

The app opens on the committed AgentsCommander map.

**No backend, no API, no outbound call, no telemetry.** The dataset is bundled into the
build as text and parsed through the same validator an imported file goes through, and
`index.html` carries a CSP with `connect-src 'self'`. Vite of course serves the files in
`dev` and `preview` — that is a static file server on your own machine, not a service the
app talks to. Once loaded, the page makes no request of anything.

### The one command that means "green"

```powershell
npm run verify   # vitest + tsc --noEmit + vite build + BOTH browser smokes
```

`npm run build` alone does not run tests, which is exactly why this command exists.

| Script | What it proves |
|---|---|
| `npm test` | Headless tests: contract, domain, projection, outline, controller, project storage, architecture, extractor, path confinement, privacy, dataset. |
| `npm run typecheck` | `tsc --noEmit`, strict, `noUncheckedIndexedAccess`, `erasableSyntaxOnly`. |
| `npm run verify:core` | The two above. The fast inner loop; no browser needed. |
| `npm run smoke:adapter` | The shared renderer conformance suite against the **real** Canvas2DRenderer in a **real** browser, with **real** pointer events. Needs no dataset. |
| `npm run smoke` | The acceptance smoke: the whole product against the **real committed dataset**, including 1664/1200 responsive boundaries, 1680×1000, 1024×768, 800×800 and DPR 1/2. |
| `npm run verify` | test → typecheck → build → **adapter smoke** → **acceptance smoke**. **This is the gate.** |
| `npm run update:screenshots` | Regenerates the canonical captures in `docs/screenshots/`. **Deliberately not part of `verify`** — a gate that rewrites the documentation it is checking cannot fail cleanly. |

The browser smokes launch their own Vite on port 5175 with `--strictPort` and
`reuseExistingServer: false`, so an occupied port **fails the gate** instead of letting a
stale server answer for a tree that is not on disk. The first browser run needs Chromium:
`npx playwright install chromium`.

### Regenerating the dataset

```powershell
npm run extract:agentscommander
# = node tools/extractor/cli.ts --repo ../../repo-AgentsCommander --name AgentsCommander --out data/agentscommander.json
```

`generator.flags` records the flags that determine the **content** — not a transcript of the
command line. `--repo` and `--out` are deliberately absent: they name the operator's
filesystem, and printing an absolute path into a file that is about to be committed is a
leak, not provenance. `--stamp` is absent because it only controls `generatedAt`, which is
not part of the deterministic payload. Every flag listed, and every default it fell back to,
is hashed into `configDigest` — so the document declares the configuration that produced it
without declaring where it lives.

Two runs on the same **working tree** with the same flags are **byte-identical**.

### The tree, not just the commit

The extractor lists files with `git ls-files` — the index — and reads their **content from
the working tree**. If the tree is dirty, every `path:line` in the document describes the
files *on disk*, not the files at `source.commit`. Naming the commit anyway would be
asserting a provenance the document cannot back up, so it doesn't:

* `source.dirty: true`, and `stats.modifiedTrackedFiles` names what differs;
* the extractor prints a warning, and **the app shows a banner**.

The committed `data/agentscommander.json` was extracted from a clean checkout, so
`source.dirty` is absent and `stats.modifiedTrackedFiles` is empty. Mapping work in progress
is still supported; in that case the document and banner state it explicitly.

### Mapping another repository

`data/agentscommander.json` is the bundled example. To map any other repository, run the
extractor against it and write the document where Visual Specs can open it:

```powershell
npm run extract -- --repo <path-to-repo> --name <DisplayName> --out .local/<name>.json
```

`--out` must stay **inside `VisualSpecs/`** — the extractor is not a repo-escape primitive
(see *Path confinement*). `.local/` is git-ignored, so a map of your own project never shows
up as a change to this repository. The result is a normal portable Visual Specs document:
open it with **Open JSON temporarily** (below). The start-up map is whatever `src/main.ts`
imports from `data/`; the bundled file is just the default.

Everything under *Regenerating the dataset* still holds: `--repo`/`--out` never enter the
document, two runs on the same working tree are byte-identical, and a dirty tree is marked
`source.dirty` with a banner.

### Live reload — generate on save, reload in the browser

This closes the loop *edit code → re-extract → the open map updates itself*, with no manual
step and no network: freshness comes from your local disk, not from a server. Set up three
things once:

```powershell
# terminal 1 — the app
npm run dev                                                           # http://localhost:5175

# terminal 2 — the watcher: stays alive, re-extracts when the repo changes
npm run extract -- --watch --repo <path-to-repo> --name <DisplayName> --out .local/<name>.json
```

Then, **once**, in the page: **Open JSON temporarily** → pick that `.local/<name>.json`. The
status line shows **Following `<name>.json` — reloads on change**. From now on, each time you save a file in the
mapped repository the watcher re-extracts and the page revalidates and reloads the new
document by itself — **keeping the layout, expansion and selection** of the nodes that
survive, and reporting what was dropped. Invalid or half-written content never replaces the
last good map: a non-blocking notice appears and following continues.

For several repositories at once, a config file replaces the flags (see *Watch mode* under
*The extractor*) and one watcher process feeds every `out`:

```powershell
npm run extract:watch          # = node tools/extractor/cli.ts --watch --config .local/extract-watch.json
```

The app shows one map at a time and follows the file that is open, so open whichever one you
want to track.

**Four things that will bite you if you don't know them:**

* The native picker **cannot open `AppData`, `Temp` or other system folders** — Chromium
  blocks the File System Access API there. Keep the `out` under your normal project tree;
  `.local/` inside `VisualSpecs/` is fine. The picker hides dot-folders, so paste the full
  path of `.local\<name>.json` into the dialog's *File name* box to open it.
* Following needs a **secure context** — `localhost` (the `npm run dev` server) or HTTPS. A
  plain `http://<lan-ip>` serve has no `crypto.subtle`, so a picked document opens but does
  not follow.
* Detection follows git's **tracked set**. A brand-new file you have not `git add`-ed does not
  trigger a re-extraction, by design — the map is of the tracked tree. Stage it and the loop
  runs.
* The bundled `data/agentscommander.json` reloads by a different path: under `npm run dev`,
  Vite's own hot-reload refreshes the page when that file changes, so a `--watch` writing
  straight to it needs no picker. That is dev-only; the picker/follow route above also works
  on a static `build` + `preview`.

---

## Reading the map

* **Double-click** a box to expand or collapse it.
* **Drag** anything. A dragged node is *pinned* and auto-layout will never move it again.
  Dragging a container moves its whole subtree.
* **Right-drag anywhere** to pan the whole blueprint. The secondary button always means
  canvas movement, even over a node or an expanded container; it never moves the thing below.
* **Click a line** to see **every logical relation behind it** — both endpoints, the
  confidence, and the evidence (`path:line`). This is the thing the product exists to do.
  Parallel relations between the same pair are fanned out, so each one is separately
  visible and separately clickable, and two clicks on a line never collapse the box it
  crosses.
* **Click a box** to see what it is, its real physical path, and **which** relations are
  folded up inside it — by kind, each drillable to its logical edges and their evidence.
  Not a bare number.
* **Search** (or press `/`) to find a node; selecting a hit reveals it inside its collapsed
  ancestors.
* Everything the canvas does is also reachable from the **node list panel**, which is
  keyboard-navigable, and every selection — a node, an aggregated relation, or an internal
  bucket — is announced through `aria-live`. A canvas must not be the only way in.

| Key | |
|---|---|
| `F` | fit the map to the window |
| `+` / `-` | zoom in / out (also the toolbar's **+** and **−**) |
| `E` / `C` | expand all / collapse all |
| `R` | reset the layout you dragged |
| `S` | export JSON |
| `[` / `]` | show or hide the explorer / the detail panel |
| `/` | jump to the search box |

**Open JSON temporarily** reads a standalone Visual Specs document without project
persistence, and — in a secure context — **follows it on disk**: when the file is rewritten
(by the extractor's watch mode, or anything else) the map reloads itself, carrying your
layout for surviving nodes (see *Live reload*). **Export JSON** writes the document back with your layout, expansion and
viewport in it. If a project is open readwrite, exports go to `.visual-specs/exports/`;
otherwise Visual Specs uses `showSaveFilePicker` when available and an ordinary download only
when it is not; the UI says that `.visual-specs` was not written. Generated import, export and
backup names use UTC and the exact prefix `YYYYMMDD-HHMMSS_` (no `Z` in the filename), with
`-2`, `-3`, … collision suffixes. A map you deliberately collapsed comes back collapsed: `expanded: []` is a
value, not an absence.

### Projects and persistence

Project lifecycle has its own named **Project Rail**, separate from the graph **Explorer**.
Before a project exists it identifies the bundled `Example: AgentsCommander` session and
keeps Create/Open plus temporary-document actions before the map controls. After Create/Open,
the rail shows the project name, the complete canonical `project.id` as an inert injective
ASCII escape, access/document/dirty/repair/preview/recovery facts, and only the actions valid
for that state. It can then collapse to a compact context that retains an accessible full
identity, a collision-aware visible id token, state, and the one critical action. The
preference is mounted UI state only: it is not written into the document or project.

**Create Project** asks the browser for write access to a directory and creates:

```text
.visual-specs/
  .gitattributes
  .gitignore
  project.json
  data/current.json
  data/autosave-view.json   # ignored by git
  imports/YYYYMMDD-HHMMSS_<safe-source-name>.json
  exports/YYYYMMDD-HHMMSS_<safe-project-name>.json  # ignored by git
  backups/YYYYMMDD-HHMMSS_current.json               # ignored by git
```

**Open Project** starts read-only. **Enable editing** is a separate click that requests
readwrite permission, then re-reads and revalidates `project.json` and `data/current.json`
before allowing writes, preserving the view assembled while reading when the semantic document
is unchanged. Autosave stores only view state in `data/autosave-view.json`; it
never stores a full graph snapshot. Saves back up the previous `data/current.json` before
replacing it, then update `project.json` with a semantic revision:

```text
sha256(canonicalStringify(parseJson(data/current.json)))
```

**Add JSON** copies a validated external portable document into `.visual-specs/imports/`.
**Import JSON** reads only that imports area, revalidates the file at the moment of import,
and only then can replace current with a backup. **Refresh imports** observes external additions.
`exports/` are output snapshots and are not shown as imports: **Refresh exports**, **Open export
copy** and the confirmed **Restore from export** are separate explicit actions, and previews keep
the project handle/permission plus a clear **Return to project** route.

Save, Rename, Import and Restore run a fresh bounded read of the real manifest/current inside
the adapter's per-project queue. The app validates both and compares their semantic state before
the first write. A conflict—valid or invalid—aborts with no backup or replacement. A replacement
backup contains the bytes actually read from disk immediately beforehand and closes before
`current.json`. If `current.json` closes but `project.json` does not, the next Open loads the
validated current safely read-only and offers an explicit, permission-gated **Repair project**;
there is no silent adoption or overwrite.

Session-changing and project-writing actions are serialized in the UI and fenced by operation
and session epochs in the application layer. Every ref and serialized payload is captured before
its first asynchronous picker/read/write. Open/Create candidates validate all of their files and
stored-document lists while the old complete session remains visible, then install document,
project head, exact manifest identity, access, dirty/recovery facts and capabilities in one
synchronous aggregate commit. A stale completion cannot mix identities, clear a newer busy/error
state, or write a later document through an earlier project ref.

Unsupported browsers or insecure contexts do not get project persistence. They can still
open a JSON temporarily and export through Save Picker/download fallback, but the UI never claims
that `.visual-specs` was written.

### It fits in a window

Project, Explorer and Details have independent desktop preferences and three measured
presentations:

* at `>=1664px`, the 192px Project Rail, 290px Explorer and 380px Details panel can all dock;
  collapsing Project reclaims its complete width without changing the map viewport;
* at `1200..1663px`, Project is a 232px left overlay. While open it suppresses only Explorer's
  presentation (not its preference), and Details remains docked;
* below `1200px`, Project, Explorer and Details share one exclusive overlay over a full-width
  canvas. With no project, Create/Open stays inline before the map instead of covering it.

Focus moves to the exact opener before a surface is hidden, Escape closes one active overlay even
from a form control, and global map shortcuts do not run from inputs, selects, buttons, links,
contenteditable or equivalent ARIA widgets. Chrome reflow is coalesced into the next painted
frame; it does not Fit, Reset, re-project the graph, or change selection/evidence.

### What the map says about AgentsCommander

The first screen is the whole story: **the entire frontend reaches the entire backend
through exactly one file, over a transport that has two different backends behind it.**

Collapsed, `src/shared/ipc.ts` folds into its npm package and the Rust command modules fold
into their crate, and every command relation projects onto the same visible pair — so you
see **one line carrying ×137 `tauri-command`** and **one carrying ×45 `web-command`**. Click
either and it resolves into its individual commands, each pointing at the call site, the
`#[tauri::command]` attribute and the `generate_handler!` registration. Expand the crate and
the same relations resolve back to their specific files.

---

## The document

One versioned JSON document crosses the app boundary. The extractor writes it; the app
reads it and writes it back.

```jsonc
{
  "formatVersion": "1.0",
  "generator": { "name": "visual-specs-extract", "version": "0.1.0",
                 "flags": ["--name","AgentsCommander","--hierarchy","logical",
                           "--invoke-facade","transport.invoke"],
                 "configDigest": "sha256:…" },
  "source": { "kind": "git-repo", "root": "AgentsCommander", "commit": "e6a0db5…" },
  "nodes": [ /* repository, applications, packages, crates, directories, files */ ],
  "edges": [ /* imports, rust-imports, bundles, entrypoint, tauri-command, web-command */ ],
  "coverage": [ /* per relation family: available | degraded | unavailable, and WHY */ ],
  "unresolved": [ /* what the extractor saw and refused to guess about, with evidence */ ],
  "view": { "expanded": ["repo:AgentsCommander"] },
  "stats": { /* every number produced by a parser */ }
}
```

### `view` is never an observation

**Nothing under `view` is a claim about the code — even when a machine writes it.** An observation in this
document is precisely a claim carrying `evidence[]` and `confidence`, and nothing under `view` has either,
which is *why* none of it is one. `view.expanded` is written by the extractor on every run and it is a
suggested starting view, not a finding.

One key deserves saying twice, because it looks like a fact about the system and is not:

```jsonc
"view": {
  "focus": {
    "transparency": 70,
    "marks": { "dir:src/shared": "out-of-focus", "file:src/shared/ipc.ts": "in-focus" }
  }
}
```

`focus.marks` records **where a person chose to look**. `"out-of-focus"` does not mean out of scope,
excluded, unused or dead — it means someone pushed that entity into the visual background and can push it
back. It is spelled in full for exactly that reason: a bare `"out"` invites the other reading.

**No machine writes `focus`.** If a tool ever wants to suggest attention — "dim the tests", "dim vendor" —
that belongs under a different, derived, recomputed-every-run key that the UI can name as a suggestion,
because `focus.marks` means *a person said so* and has to keep meaning only that. Machine-checked in both
directions: nothing under `view` grows `evidence`/`confidence`/`path`/`line`, and no node, edge or
`unresolved` entry grows a focus key.

### The round-trip promise

> A load→save cycle preserves **every known and unknown JSON value reachable in the
> document**, and emits **deterministic key and array order**. It does **not** preserve
> input whitespace, input key order, or numeric literal spelling.

`export()` deep-clones the raw parsed tree and **deep-merges** your view over its `view`
subtree — it does not replace it. Unknown fields inside `view`, inside each `Position` and
inside `viewport` survive, and so do positions for ids that are not in the graph. Only the
arrays whose order carries no meaning (`nodes`, `edges`, `view.expanded`) are canonicalised;
`generator.flags` is never reordered, because a flag list is not a set.

### Versioning

| Input | Behaviour |
|---|---|
| `1.0` | Accept. |
| `1.7` (unknown minor) | Accept, warn once, preserve every extension. |
| unknown entry in `requires[]` | Open **read-only**: render it, refuse to export it. |
| `2.0` (unknown major) | Reject: `IncompatibleVersionError`, naming both versions. |
| not JSON / broken graph / dangerous key | `InvalidJsonError` / `IntegrityError` / `SchemaError`. |

### An imported document is untrusted input

`__proto__`, `constructor` and `prototype` as keys are a **hard rejection** anywhere at any
depth. Non-finite numbers are rejected **document-wide**. Known path fields (`node.path`,
`Evidence.path`, `source.root`) must be POSIX-relative — no absolute, no drive letter, no
UNC, no backslash, no `..`, no NUL, no control character. There are caps on bytes, nodes,
edges, string length, JSON depth and evidence count, all checked **before** the graph is
built. The app never reads a file from disk based on document content, and there is a CSP
with `connect-src 'self'`.

**Privacy, scoped honestly.** The no-absolute-path guarantee covers *known path fields only*
(`node.path`, `Evidence.path`, `source.root`), where an absolute value is a hard rejection.
Everything else the document carries — `metadata` at any depth, values inside arrays, `label`,
`note`, `snippet`, and any preserved unknown field — is **scanned, and absolute-path-looking
values are surfaced as warnings**, with the exact location. They are never silently rewritten
and never claimed to be clean: a document that has been quietly "cleaned" cannot be trusted
either. **Snippets are off by default**; `--snippets` prints a warning that it may copy a
secret out of the repository into a document you are about to commit.

---

## Architecture, in one screen

```
contract/     imports nothing              types, validation, the raw envelope, import/export
domain/       imports contract             the Outline port, visibility/NVA, geometry, layout, commands
projection/   imports contract, domain     project() → VisibleGraph; the partition law
ports/        imports nothing              GraphRenderer, the conformance suite, edge routing
app/          imports the above            AppState, the reducer, the scene builder, the controller
ui/           imports app, ports, + inner  toolbar, node list, legend, banners, detail panel
adapters/     imports ports                FakeRenderer, Canvas2DRenderer
src/main.ts   THE COMPOSITION ROOT — the only module that wires a concrete adapter to a UI
```

`contract/`, `domain/` and `projection/` are pure TypeScript: no DOM, no graphics library,
no I/O. They are the entire understanding of the product and they run headless in Node.

**These are not conventions.** `tests/architecture/boundaries.test.ts` parses every source
with the TypeScript API and fails the build on any violating import, on any DOM reference
inside a pure layer, on any HTML sink (`innerHTML`, `document.write`, `eval`, …), and on any
network call. It also asserts that **`src/` has zero bare imports** — which is the strongest
possible form of "the graphics library is a detail": there is no graphics library.

### The four constraints, and where they are paid for

1. **A collapsed container must not hide information.** A relation whose endpoint is hidden
   is redrawn against the nearest visible ancestor, and it is still reachable — with its
   evidence — from the aggregate that represents it. `projection/project.ts`.
2. **Redrawing is deterministic and lossless.** The **partition law (I9)**: the
   `sourceEdgeIds` of every visible edge and every internal bucket form an *exact partition*
   of the logical edge ids — no duplicates, no omissions, and every id in the bucket that
   *matches* its representatives. Not a sum of counters, which can be right while omitting
   one id and double-counting another. Property-tested over 480 seeded random expand/collapse
   states, and asserted on the real dataset.
3. **The layout is the user's.** Positions survive export and re-import. Pinning is what lets
   auto-layout and manual movement coexist.
4. **The graphics library is a detail.** `ports/renderer.ts` contains no graphics type.

---

## Corrections this implementation made to `docs/ARCHITECTURE.md`

The architecture was published on a 2–1 vote. Building it settled three open questions and
turned up four errata. All of them are recorded in `docs/ARCHITECTURE.md` §16, and two have
their own ADR.

1. **The N:M outline (dissent 1).** `placementOf` + injectivity (I10) genuinely cannot place
   one package under two applications. v1 ships the honest option: **primary placement** —
   each entity is placed once, deterministically, and the *other* memberships stay `bundles`
   **edges**, which project through NVA like any other relation. The promise the test proves
   is *no membership is lost*, not *an entity appears under every app that bundles it*.
   See `docs/ADR-0001-outline-placement.md`.
2. **The deep round-trip (dissent 2).** `export()` deep-merges rather than replacing the
   `view` subtree. Covered above and pinned by `tests/contract/roundtrip.test.ts`.
3. **Verify by phases (dissent 3).** `smoke:adapter` gates the renderer with no dataset;
   `verify` runs the full acceptance smoke. Both are mandatory; neither substitutes for the
   other.
4. **The renderer gate.** §8.2 framed Cytoscape-without-compound-nodes as a spike with an
   exit criterion. The gate was decided **against** it, and the reasons are in
   `docs/ADR-0002-renderer.md`. The shared conformance suite passes against the shipped
   Canvas 2D adapter in a real browser, with real pointer events.
5. **`path: ""`.** The worked example showed it on a package without saying what made it
   legal. It is now accepted only for a root node or a node declaring
   `metadata.rootAnchor: true`, and refused anywhere else — so the validator no longer
   contradicts its own example.
6. **Non-finite numbers are rejected everywhere,** not only in `view`. `1e400` parses to
   `Infinity`, and `JSON.stringify(Infinity)` is `null`; allowing one anywhere would make the
   round-trip promise false.
7. **Edge routing is part of the port.** Four typed relations join the root package and the
   Tauri crate. Drawing them on top of each other keeps them distinct in the model and merges
   them in pixels — which is the same lie. The fan-out is defined in `ports/renderer.ts`, so
   every adapter separates them identically, and each is individually clickable.
8. **A Rust `crate` is its own kind**, not a `package` with an ecosystem tag. Two of the four
   anchors are crates, and making the reader translate is the opposite of the job. Ids keep
   the `pkg:cargo:` prefix, so a stored layout survives the distinction; the shape (a clipped
   corner) carries it as well as the colour, so it survives a colour-blind reader too.
9. **`expanded: []` is a value, not an absence.** The app used to infer "this document has no
   view" from an empty expansion, and quietly re-opened a map the user had deliberately
   collapsed and saved. `importDoc` now reports what the document *said*.
10. **`--out` and the path guards fail closed.** See *Path confinement*, above.

---

## The extractor

`tools/extractor/`. A Node/TypeScript CLI sharing `src/contract/` with the app, so its output
is validated by the **same** `validate()` the app uses on import.

```powershell
npm run extract -- --repo <path> --out data/<name>.json [--hierarchy logical|physical]
                   [--name <label>] [--invoke-facade transport.invoke] [--bare-invoke]
                   [--tsconfig <path>] [--snippets] [--stamp]
```

### Watch mode

```powershell
npm run extract -- --watch --repo <path> --out data/<name>.json        # one repo
npm run extract -- --watch --config .local/extract-watch.json          # many repos
npm run extract:watch                                                  # = the line above
```

`--watch` keeps the CLI alive and re-extracts a repo when its working tree changes.
The config file maps several repos at once — entries mirror the flags exactly, and
produce **the same `generator.flags` and `configDigest`** as the equivalent command
line (pinned by test):

```json
{ "repos": [
    { "repo": "../../repo-AgentsCommander", "name": "AgentsCommander", "out": "data/agentscommander.json" }
] }
```

What it promises (plan/9-extract-watch.md is the full spec):

* **Atomic output** — every write goes to a uniquely named temp file in the same
  directory, then `rename`. A concurrent reader sees the old complete document or
  the new one, **never a torn JSON**. One-shot runs write atomically too.
* **Only real changes republish** — detection is a git-aware fingerprint
  (`ls-files` + `rev-parse` + `status --porcelain` + an lstat of the dirty set),
  debounced per repo; byte-identical output is not rewritten (watch mode only —
  a one-shot run always writes, so its mtime keeps marking "a run happened").
* **Errors do not kill the watcher** — a failing extraction is reported on stderr
  (machine-readable JSON) and retried when the repo next changes; a failed write
  retries every tick with the already-extracted text.
* `--interval <ms>` (default 1000, min 100) is a floor, not a promised cadence:
  ticks never overlap, so the real cadence is max(interval, tick duration).
* An `out` may not land inside a watched repo unless it is git-ignored there
  (exit 10) — otherwise the watcher would feed on its own output. `.local/` is
  gitignored, which is why the config lives there.

* **Files** — `git ls-files -z`, NUL-separated, invoked with an **argument array** (never a
  shell string). Before any file is read, its real path is asserted to be inside the repo:
  the extractor must not be a repo-escape primitive.
* **Ownership** — every `package.json` / `Cargo.toml` that declares a package is an **anchor**;
  every path belongs to its **nearest enclosing anchor**, which is how npm and Cargo resolve
  ownership themselves. Anchors are hoisted to the repository under `--hierarchy logical`
  (the default) and nest by path under `--hierarchy physical`. **Node ids are identical in
  both modes**, so a saved layout survives the switch. A pure pass-through directory like
  `crates/` never becomes a box.
* **Applications** — detected only from citable signals (`tauri.conf.json`, `index.html` +
  a Vite config, cargo bins, `package.json#bin`), each carrying the evidence that justified
  it. An application's link to code is a **relation** (`bundles`, `entrypoint`), never a
  containment level — because the Tauri app **spans two units** (an npm package and a Rust
  crate) and `session-bridge` **ships two binaries**, and a single-parent tree cannot
  express N:M. The npm bundle is anchored on `frontendDist`, which says where the output
  lands; `beforeBuildCommand` says only that *a* build happens, and guessing from it is
  not evidence.
* **TypeScript imports** — discovery with `ts.preProcessFile`, resolution with
  `ts.resolveModuleName` through the project's **own tsconfig**, so `moduleResolution:
  "bundler"` and `paths` aliases are honoured because it *is* the compiler's resolver. Asset
  imports (`./styles.css`, `../assets/icon.png`) that `tsc` cannot resolve but a bundler can
  are resolved against the git-tracked tree — the file provably exists, so it is proof, not a
  guess.
* **Rust** — a real **use-tree parser** (paths, `{}` groups, `as`, `self`, `super`, globs),
  because grouped use-trees are real: **813** of them in this repository, and a per-line regex
  mis-parses every one. `mod foo;` resolves to a file whose existence is **checked**;
  `#[cfg(test)] mod tests { … }` has no backing file and does not invent one. Globs go to
  `unresolved`. Coverage: **`degraded`, permanently and honestly** — no macro expansion, no
  `#[path]`, no `cfg` evaluation, no symbol resolution.
* **Commands** — the relation that makes the map worth reading. `tauri-command` requires
  **three** pieces of evidence (a literal call through the configured facade, a
  `#[tauri::command]` attribute, and registration in `generate_handler!`); `web-command`
  requires a literal call and a matching arm in the WebSocket router. A command bound to both
  is **two edges** — two different facts. Anything less, or a non-literal command name, goes
  to `unresolved` with evidence.

### Counts come from parsers, not from greps

Every number below is produced by an anchored pattern or a parser and pinned by a fixture
test. A raw grep is not evidence — that is not a slogan, it is why the architecture's own
first draft published three wrong numbers.

Current as of AgentsCommander `1b0e934`. Every figure below that is read out of the
committed document is asserted by `tests/dataset/dataset.test.ts` and, since #24,
corroborated by a method that is not the extractor's own output — so **the dataset**
cannot move without a red test.

**This table is a transcription of those assertions, and nothing checks the
transcription.** No test reads this file. If the dataset moves and this table is not
updated with it, the gate stays green and the table is simply wrong — which is exactly
what happened across the two refreshes before #24. `tests/dataset/dataset.test.ts` is the
authority; this is a copy of it. #27 tracks closing that gap.

Four figures here are asserted by nothing, and **cannot** be: they are measured against
the **mapped repository** rather than read out of the document, and §10.7 requires this
suite to pass on a clean checkout where AgentsCommander is simply absent, so no test can
reach them. They are the bare-grep contrast (141 across 21 files, and the three comment
locations), the two `generate_handler!` locations, the false-positive location at
`entity_creation.rs:388`, and the corroborated count of 812. All four were verified by
hand at `1b0e934`.

`src/shared/ipc.ts:117` is **not** in that group: it is an evidence record inside the
document, and both its path and its line are asserted.

| Fact | Value |
|---|---|
| git-tracked files | **705** |
| nodes / relations | **817** / **1947** |
| nodes by kind | repository **1** · application **5** · package **2** · crate **2** · directory **102** · file **705** |
| anchors | **4** = **2 npm packages** (the root `package.json`, `npm/package.json`) + **2 Rust crates** (`src-tauri`, `crates/session-bridge`). A crate is its own kind, not a package with an ecosystem tag. |
| applications | **5** — Tauri desktop, web, two `session-bridge` binaries, the npm CLI |
| `#[tauri::command]` attributes, **anchored** | **138**, across **20** files (an unanchored grep finds **141** across 21 — three are prose inside comments, at `commands/task.rs:426` and `session/session.rs:58` and `:606`) |
| commands registered in `generate_handler!` | **138** — the union of the two lists, at `lib.rs:2550` and `commands/resource_monitor.rs:466`, not their sum |
| `transport.invoke` call sites | **140**, **all of them in `src/shared/ipc.ts`** |
| `tauri-command` / `web-command` relations | **137** / **45** — 137 and not 138 because `get_instance_label` is registered but never called, so there is no relation to draw |
| commands bound to **both** backends | **43** |
| registered but **never called** | **`get_instance_label`** — an earlier draft asserted `"unusedCommands": []`. That was never measured, and it is false. |
| web-router-only (unresolved as Tauri) | **`subscribe_session`**, **`get_pty_size`** |
| the facade's own non-literal dispatch | **1**, at `src/shared/ipc.ts:117` — `unresolved`, never a phantom edge |
| grouped Rust use-trees | **813** — of which **one is a known false positive** (#25): `stripComments` copies string literals through, so the English word `use` in a `format!` template at `entity_creation.rs:388` parses as a six-leaf group. The corroborated count is **812**. |
| `paths` alias usages in `src/` | **0** — recorded, not mistaken for "unsupported" |

### Path confinement

An extractor that can be talked into reading or writing outside the repository it was
pointed at is not a mapping tool, it is a file primitive. One policy, in `confine.ts`, used
by the CLI, the repository reader, the TypeScript resolver and the asset resolver:

* **Cross-drive.** On Windows `relative('C:\\repo', 'D:\\out')` returns `'D:\\out'` —
  absolute, with no `..` anywhere in it — so a "does the first segment say `..`?" check
  waves it straight through. An **absolute** result is an escape.
* **Symlinks and junctions.** A directory *inside* the working root can be a junction
  landing anywhere. `--out` is checked against the **real** path of the deepest existing
  entry, and **again immediately before the write**, because `mkdir -p` follows a junction.
  A path that cannot be resolved — a broken or inaccessible link — is **refused**: a
  security check that cannot prove containment must fail closed.
* **Escapes are reported, never clamped.** `src/../../../package.json` used to normalise to
  `package.json` — a real, tracked file — so an import pointing *outside* the repository
  became an edge to an unrelated file *inside* it. It resolves to nothing now.
* **`--tsconfig`** must be inside the repository, and TypeScript reads through a **confined
  host**: an `extends` chain reaching outside the repo fails as an ordinary tsconfig error
  rather than making the compiler read arbitrary files on our behalf.

### Error contract

Every failure is deterministic and has its own exit code: not a git repository (2), `git` not
on PATH (3), unreadable or binary file (4), **a path escaping the working root through a
symlink or junction (5)**, invalid encoding (6), invalid or missing tsconfig (7), `--out`
outside the working root by the letter of the path (8), output that fails its own validator (9).

A tracked **source** symlink that escapes the repository is *not* fatal: it is **skipped and
recorded in `unresolved`** with its evidence, because one bad link should not stop a
repository from being mapped. Exit 5 is for an **output** path that escapes — which is a
write, and must never happen.

### Tests run on fixtures, not on a neighbouring repo

Visual Specs tests must pass on a clean checkout of CodebaseConstellation, where
AgentsCommander — a *different* repository — is simply absent. The extractor's tests
materialise `tools/extractor/fixtures/fixture-repo/` into a temp directory, `git init` it, and
run the real `git ls-files -z` path against it. `data/agentscommander.json` is generated once,
committed, and validated by the dataset test.

---

## Known limits

* Granularity stops at the **file**. No functions, no symbols.
* **Renames are not tracked.** A moved file is a new id and loses its stored position.
* **Rust import coverage is `degraded`,** permanently. Globs are `unresolved`.
* **Command edges are literal-only.** A name assembled at runtime — including the facade's own
  dispatch — is `unresolved` by design, not invisible.
* **External packages are not nodes**; they are counted in `stats`.
* **Multi-placement outlines are not implemented.** v1 validates injectivity and names the
  generalisation (ADR-0001).
* The default layout is a deterministic **grid pack**, not an optimised one. Expect crossings
  until you rearrange — and the arrangement you make is saved. `elkjs` behind the `AutoLayout`
  port is the deferred upgrade.
* **Privacy is guaranteed only for known path fields.** Free-form fields are scanned and warned
  about, not sanitised.
* The acceptance smoke drives the **dev server**, not the production bundle; `npm run verify`
  runs `vite build` separately, so a build failure still fails the gate, but the built artifact
  itself is not what the browser test loads.
* A pinned child dragged far outside its container grows the container symmetrically about its
  own centre; it can overlap the container's header. The user did it, and nothing is lost.
* Project persistence depends on File System Access in a secure browser context. Without it,
  Visual Specs is temporary JSON plus Save Picker export when available, otherwise download.
* Browser filesystem capabilities are not physical path security. A junction or symlink
  inside a selected root can point elsewhere, and the browser does not expose `realpath`.
  Visual Specs confines itself to constant names and validated single file segments; it does
  not claim to defeat filesystem topology outside the browser capability model.
* Project writes are serialized per project and perform fresh manifest/current validation before
  backup/replacement. File System Access has no cross-process lock or atomic compare-and-swap, so
  another tab or external process can still race between that check and the following writes.
  Export/import collision avoidance is likewise best-effort because FSA has no create-exclusive
  primitive.
* Semantic revision hashing is synchronous pure JavaScript in the contract layer. Create invokes
  its picker first so hashing cannot consume transient activation, but a document near the 64 MiB
  cap can still make that later validation visibly expensive on the main thread.
* The browser test hooks (`globalThis.__visualSpecs`, and `conformance.html`) exist **only in
  dev and test builds**. A production bundle ships neither. They are read-only — they answer
  "where is this line drawn", which only the domain knows — and the acceptance smoke drives
  import and export through the real controls, with a real download and a real file input.
* `main.js` is ~1.2 MB (73 kB gzipped) because the whole dataset is bundled into it as text.
  That is the price of "no network call, ever".
