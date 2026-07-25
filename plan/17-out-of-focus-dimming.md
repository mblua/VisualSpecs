# RFC 17 — Out-of-focus dimming

Issue: https://github.com/mblua/VisualSpecs/issues/17 · Branch: `feature/17-out-of-focus-dimming`
Delivery path: **full** · Status: **v3 — READY_FOR_IMPLEMENTATION**

Follow-ups, deliberately out of scope: **#18** (sidebar roving tabindex), **#19** (pan rebuilds the
sidebar per pointermove).

## 0. Review record

Two premortem rounds, four reviewers, **51 findings, all accepted, none dismissed**. v1 →
v2 closed 32; v2 → v3 closes the 19 raised against v2, of which 5 were P1.

| Reviewer | Round 1 | Round 2 |
| --- | --- | --- |
| `vs-extraction-evidence-dev` | C1–C4, all accepted | — (owns `tests/extractor/**`, item 1 landed `000e190`) |
| `vs-graph-runtime-dev` | C1–C6 + §D/§E accepted; **C4 overturned by F1, withdrawn on measurement** | `marker?: string`, `RING_FLOOR`, Escape correction, §4.5/§4.6 sentence |
| `vs-resilience-red-team` | R1–R13 | 1 P1 (Q1), 5 P2, 8 P3 — R3+R4 **closed**, one-vs-two **not** escalated |
| `vs-semantic-red-team` | F1–F20 | 4 P1 (N1–N4), 5 P2, 3 P3 — 8 of 10 v1 blockers closed |

Round 3 is the **final adversarial gate against the executable increment** (Step 9), not a third
premortem. Every remaining fix is a rule, a predicate, a constant or an owner assignment; no design
question is open. Both red teams re-verify against code, which is the stronger test.

Arbitration record: **F1 over graph/runtime C4** — v1 asked an aggregate's visible endpoints, which
made the override unrepresentable whenever the parent is collapsed, i.e. the default view.
graph/runtime rejected the logical rule as `O(edges × sourceEdgeIds)`; `project` partitions
`model.edges` exactly once, so the sum over all three sinks **equals** `|model.edges|`. Confirmed by
measurement at three expansion states by both graph/runtime and `vs-resilience-red-team` (195 + 1677,
1872 + 0, 0 + 1872 — exact partition, no duplication). graph/runtime withdrew both halves on evidence.

## 1. Ownership

| Artifact | Owner |
| --- | --- |
| Focus contract, domain, focus semantics | `vs-spec-core-lead` |
| Focus presentation and interaction | `vs-graph-runtime-dev` |
| Extraction-side non-regression and invariance | `vs-extraction-evidence-dev` |

Neither owner edits another's files.

## 2. Before state

- `RenderNode.dimmed` / `RenderEdge.dimmed` exist; `Canvas2DRenderer` honours them with literals
  `0.22` (nodes, `:593`) and `0.14` (edges, `:722`). One producer: search, in `app/scene.ts`.
- No `contextmenu` handler exists anywhere in the app.
- `ViewState` holds `expanded`, `positions`, `fitted`, `viewport`. `validate.ts`:
  `SUPPORTED_MAJOR = 1`, `SUPPORTED_MINOR = 1`. `OwnershipOutline` is injective (I10) and
  `OutlineNodeId === NodeId`.
- **There are no pixel-comparison assertions in the suite.** `grep -c toHaveScreenshot
  tests/smoke/*.spec.ts` → 0 everywhere, and `screenshots.spec.ts` is deliberately outside
  `npm run verify`. Any claim of the form "the baselines cannot move" is unenforced in both
  directions; v2 leaned on it twice and should not have.
- **Corpora, named on every measurement.** The **user's running app**: 744 nodes / 1609 relations /
  14 drawn / 1419 folded, from the screenshot that opened this issue. The **committed corpus**
  `data/agentscommander.json` at `e94f003`: 787 nodes / 1872 relations; default view 10 visible nodes,
  14 drawn edges carrying 195 logical relations, 1677 folded into 2 internal buckets (**89.6%**);
  expand-all 787 / 1713 / 0; exactly **one** outline root.

### 2.1 Three defects in the `fitted` precedent this RFC does not copy

1. `export.ts:107` deletes `rawView['fitted']` when empty, so a document declaring `"fitted": []`
   loses the key on a no-op round trip. Fixed here for both fields.
2. `droppedFitted` has been in `LossReport` since #13 and is printed by nothing;
   `docs/ARCHITECTURE.md:433` still documents `LossReport` without it.
3. `stale-fitted` is constructed in `load.ts` and dropped by the banner allowlist
   (`ui/app.ts:1234-1242`), which accepts three codes.

Copying `fitted` "exactly" would have produced a `droppedFocus` that reaches no human. Losing a layout
silently is recoverable — auto-layout re-derives it. **Losing an attention decision silently is not:
nothing in the system can re-derive what a person chose to push into the background.** That asymmetry
governs §5.5, §5.6 and §8.5.

## 3. Requested change

A person can push individual entities out of focus from the sidebar list, choose how transparent
out-of-focus things are, and flip the whole map with one control. The state persists with the view.

## 4. The focus model

### 4.1 Tri-state, inherited, overridable

| State | Stored as | Meaning |
| --- | --- | --- |
| explicit out | `marks[id] = "out-of-focus"` | out of focus; by inheritance so is everything under it |
| explicit in | `marks[id] = "in-focus"` | in focus, **overriding** an out-of-focus ancestor |
| unmarked | absent | inherits the nearest marked ancestor; in focus if none |

Values are spelled in full because this document is read by coding agents: a bare `"out"` on a node is
one reading from "out of scope" / "excluded" / "dead", which is a claim about the system rather than
about where a person is looking.

### 4.2 Resolution

`resolveFocus(outline, marks) -> Map<OutlineNodeId, 'in' | 'out'>` — one pre-order walk from
`outline.roots()` carrying the inherited value down. **Measured at 0.049 ms** over 787 outline nodes.

Totality and determinism are verified, not assumed: `checkIntegrity` guarantees I2/I3 so every
ancestor chain terminates at a root, and `assertInjective` rejects any placement unreachable from the
roots. No model node is unplaced or unreachable.

### 4.3 Edges — over logical relations, and the aggregate carries the fraction

`VisibleEdge.sourceEdgeIds` is "the logical relations behind this one line". A relation is out of focus
when at least one of **its own entity endpoints** is effectively out of focus — not when the
aggregate's representatives are.

**An aggregate's focus opacity is a fraction, not a bit:**

```
focusOpacity(aggregate) = focusOpacity + (1 - focusOpacity) × (brightRelations / totalRelations)
```

For a ×1 aggregate this is **exactly** the boolean rule: `bright/total ∈ {0, 1}` gives `focusOpacity`
or `1`. So graph/runtime's measurement stands — under a *both-endpoints* rule, marking any of the
three right-clickable packages in the default view dims **0 of 14** drawn edges, and the feature would
appear broken in the state the app opens in.

**Why a bit is wrong in both directions, measured.** v1 asked the representatives and *hid* a relation
the user had explicitly re-lit. v2 asked "every relation out" and did the opposite: the largest drawn
aggregate at the default view is `pkg:npm:package.json → pkg:cargo:src-tauri/Cargo.toml ×136` with 1
source and 21 target entities, so §4.1's own gesture — dim the container, bring **one** entity back —
returned the whole ×136 line to full strength while **122 of its 136 relations were still switched
off**, behind a line width that encodes 136. *v1 hid 1 relation the user wanted; v2 showed 122 the
user did not.* One bit cannot describe a mixed set.

This became fixable only because §7 replaced `dimmed: boolean` with `opacity: number`: two closures
interacted and the interaction had not been revisited. The fraction is free — §4.3 walks
`sourceEdgeIds`, and `scene.ts:89-93` **already** maps `sourceEdgeIds → model.edgeById` for the
`allHeuristic` dash rule, three lines above where this goes.

**Fourth constraint, and it is semantic rather than a matter of taste: a non-zero bright fraction must
be PERCEPTIBLY distinct from a zero one.** The first three constraints — monotone, exact at ×1,
composed under `min` — are all satisfied by the plain continuous form, and the plain continuous form
makes a fine-grained override *imperceptible* on exactly the aggregates where this rule was needed.
Measured in §7's own metric at the default transparency, on the ×136 aggregate:

| bright / total | opacity | contrast | Δ vs all-off |
| --- | --- | --- | --- |
| 0/136 | 0.3000 | 1.610:1 | — |
| **1/136** | 0.3051 | 1.617:1 | **0.007** — one 8-bit step, gone |
| 14/136 | 0.3721 | 1.856:1 | 0.246 — visible |
| 136/136 | 1.0000 | 6.387:1 | 4.776 |

§7 rejects `transparency = 95` because 1.02–1.09:1 is perceptually gone; this is the same argument
applied to a *difference* rather than a value. Without the fourth constraint the chain reads: v1 hid one
relation the user wanted, v2 showed 122 the user did not, v3 shows the fraction and loses the override
again at the fine end — present in the number, below threshold on the screen.

So `aggregateFocusOpacity` lifts **any** non-zero bright fraction by at least a floor's worth of the
available range, preserving the fraction above that floor. Three discrete levels also satisfy all four
constraints and are a legitimate alternative.

The presentation function is `vs-graph-runtime-dev`'s call as a legibility decision, and **the floor's
value is theirs to calibrate against the contrast metric, with a conformance case pinning it** — the
same division that produced `RING_FLOOR`, where core stated the property and the owner measured the
constant. The four constraints are the boundary that choice moves inside.

**Guard against vacuous truth.** A carrier with zero resolvable logical relations must **not** dim:
`[].every(…)` is `true`, which would dim a line with no marks present at all and break I-F4 at the
scene level. Zero such carriers exist on the committed corpus at any expansion state, so this is
latent — and `scene.ts:94` already writes `logical.length > 0 && logical.every(…)` three lines away,
because whoever wrote it did not trust the empty case either.

**Internal buckets carry no pixel, and that must be stated.** `RenderScene` is `{nodes, edges}`;
buckets never reach the renderer, so `opacity` never applies and `assertSceneWellFormed` never sees
them. But **89.6% of this corpus's relations are folded into buckets in the default view**, so "focus
fades every relation touching an entity" is silently false for the overwhelming majority of relations
until the user expands. §8.4.3's detail panel therefore reports, for a selected container, how many of
its folded-away relations are out of focus. One number, from the same resolved map.

**Cost.** The worst case is one pass over `|model.edges|` = 1872, at expand-all: **p50 0.200 ms,
p95 0.660 ms**, against `project()` p50 1.00 ms and `buildScene` p50 1.19 ms. The default view costs a
ninth of that (195 of 1872), because `buildScene` iterates `visibleEdges` alone — the equality with
`|model.edges|` holds only over all three sinks.

**Resigned, measured:** of the 639 edges dimmed when `dir:src/shared` goes out of focus at expand-all,
**532 (83%) have a bright endpoint**, so an in-focus node's degree looks lower at a glance. Worst case
dims 37.3% of drawn edges. The most *reachable* actions are the most drastic: dimming
`pkg:npm:package.json`, one of the ten rows available without typing, fades 67% of all relations.

### 4.4 Collapsed representatives

A collapsed container renders by **its own** effective state. Additionally the scene exposes, per
representative, whether **its hidden subtree contains an entity whose effective state differs from its
own** — so graph/runtime can render a partial affordance (`badge` precedent, `scene.ts:72-75`).

"Differs from mine" and not "contains an out-of-focus entity", because the latter is one bit for a
three-valued question and the value it cannot express is the override. Measured:

| scenario | box | v2 flag | differs? |
| --- | --- | --- | --- |
| `P` in focus, `c2` dimmed | in | true | true |
| `P` dimmed, `c1` re-lit | out | true | **true** |
| `P` dimmed, nothing re-lit | out | true | **false** |

Rows 2 and 3 are different states that rendered identically under v2, and under a dim box the v2 flag
is *always* true and therefore carries no information at all. So a representative could signal
"something below me is dimmed" and never "something below me is **lit**" — precisely §4.1's motivating
state and the only reason the tri-state model exists.

**"Hidden subtree" means the entities whose NVA is this representative, excluding itself.** A walk of
`childrenOf` and the NVA map are not the same set once a mid-tree container is expanded but its parent
is not.

### 4.5 The write rule — minimal mark for the requested effective state

For a requested effective state `S` on node `n`:

- if `inherited(n) === S` → **delete** `n`'s own mark, if any;
- otherwise → **write** mark `S` on `n`.

So *Bring into focus* on a node carrying its own out-of-focus mark **deletes that mark** rather than
writing an in-focus one; writing an explicit in-focus mark is reserved for overriding an **ancestor's**
mark. The general form is required rather than the symmetric one: *Send out of focus* on a node
carrying its own in-focus mark under an **unmarked** ancestor must write `out`, because deleting would
leave the node in focus — the opposite of the request.

| # | action | v2 marks | v3 marks |
| --- | --- | --- | --- |
| 1 | dim `P` | `{P:out}` | `{P:out}` |
| 2 | light `c1` | `{P:out, c1:in}` | `{P:out, c1:in}` |
| 3 | light `P` | `{P:in, c1:in}` | `{c1:in}` |
| 4 | dim `repo` | `{repo:out, P:in, c1:in}` → **P's subtree stays bright** | `{repo:out, c1:in}` → P dim, `c1` bright |

At v2 step 4 the user asked to dim the repository and a subtree stayed lit, because of a mark created
at step 3 that meant "undo my own dimming", not "P is permanently exempt".

**§4.5 governs writes; §4.6 governs retention: do not *create* a mark equal to its inherited value; do
not *delete* one that already exists.** A future "simplification" that deletes any mark agreeing with
its inherited value would pass every test not exercising the four-step sequence and would silently
break the one requirement the user stated explicitly. §11.14 is that sequence.

**One action has no visible canvas effect, by design:** for a node carrying its own out-of-focus mark
under an out-of-focus ancestor, *Reset to inherited* deletes the mark and nothing on the canvas
changes — the glyph disappearing is the only feedback. Correct, and stated so it is not later "fixed"
as a no-op.

### 4.6 Marks are kept verbatim once written

§4.5 guarantees no mark is redundant when written. A mark that becomes redundant *later*, because an
ancestor changed, is **kept** — that is the case verbatim storage exists for. Both red teams were
asked to falsify it; neither did.

## 5. Contract and persistence (core lane)

### 5.1 `ViewState`, and one exhaustive projection for all five sites

```ts
export type FocusMark = 'out-of-focus' | 'in-focus';
export interface FocusState {
  readonly marks: ReadonlyMap<NodeId, FocusMark>;   // may carry INERT ids (§5.5)
  readonly transparency: number;                    // integer percent
}
export interface ViewState {
  readonly expanded: ReadonlySet<NodeId>;
  readonly positions: ReadonlyMap<NodeId, Position>;
  readonly fitted: ReadonlySet<NodeId>;
  readonly focus: FocusState;                       // REQUIRED
  readonly viewport: Viewport;
}
export const FOCUS_TRANSPARENCY_DEFAULT = 70;
export function withFocus(view: ViewState, focus: FocusState): ViewState;
export function emptyFocus(): FocusState;
```

A required field makes the five `with*` copiers compiler-enforced. **It does not reach the
`VisualSpecsView` boundary, whose keys are all optional** — and there are four sites there, not one:

| Site | Direction | Protection |
| --- | --- | --- |
| `contract/view.ts` `with*` ×5 | required → required | compile error |
| `contract/export.ts` `mergeView` | explicit | §5.2 |
| `app/controller.ts:195` `exportText` | required literal | compile error — silencer is `focus: emptyFocus()` |
| `projectController.ts:1443` `cloneView` | required target | compile error |
| `projectController.ts:1452` `viewKey` | trigger | exhaustive projection |
| `projectController.ts:1414` `toVisualSpecsView` | optional target | exhaustive projection |
| `projectController.ts:1429` `toViewState` | optional source | exhaustive projection |
| `autosaveView.ts:97` `viewToJson` | optional source | exhaustive projection |
| `autosaveView.ts:120` `parseView` | optional target | exhaustive projection |

**All five of the last rows are typed off one exhaustive `Record`-shaped projection over
`keyof ViewState`**, so a future view field is a compile error at every one. v2 guarded only
`viewKey` — the *trigger* — which is **worse than v1**: v1 wrote nothing and correctly reported the
session clean, whereas guarding the trigger alone means `viewKey` changes → `dirty` →
`scheduleAutosave` → `flushAutosave` writes a file **with no `focus`** → `'Autosaved view.'` → reload
→ every mark gone. The user gets positive confirmation of a save that did not save. Measured:
`viewToJson(view with focus)` emits `[positions, expanded, fitted, viewport]`.

The read side is quieter and the same shape: without a `parseFocus`, `view.focus` is always
`undefined`, so `toViewState`'s `?? fallback.focus` silently keeps **what is on screen** instead of
what was saved — a restore that appears to work.

### 5.1.1 The same gap, three times, one layer further in each time

This is the pattern, written down because it has now cost three review rounds:

| | The guard | What it does not reach |
| --- | --- | --- |
| v1 | a **required field** | the `VisualSpecsView` boundary, whose keys are all optional |
| v2 | an **exhaustive projection** | the payload — it guarded only the dirty *trigger* |
| v3 | the exhaustive projection | **canonicality** — it forces each field to be *mentioned*, never *canonicalised* |

`Record<keyof ViewState, (view) => JsonValue>` accepts `focus: () => something` whether or not the
something is sorted. And the property is already absent for a sibling: `toVisualSpecsView` sorts
`expanded` and `fitted` and iterates `positions` in **Map insertion order**, so
`MoveNode a; MoveNode b; ResetLayout; MoveNode b; MoveNode a` yields identical position values and a
**different** `viewKey` — reachable through ordinary commands, not constructed by hand. Today's cost is
over-reporting rather than a write out of nowhere, on a path that runs once per pan pointermove (#19).

So the obligation is carried **by construction, not by a test**: each projector's return type is a
branded canonical value that only the canonicalising helper can produce, so a projector that forgets to
sort does not type-check. `positions` is sorted in the same pass — one line, in a function this issue
rewrites anyway — which makes §11.9's `positions` clause a real check instead of a carve-out around a
known gap.

A test would have closed the third instance and left the fourth to be rediscovered.

### 5.2 Serialized shape, merged key-by-key

```json
"view": { "focus": { "transparency": 70, "marks": { "dir:src/shared": "out-of-focus" } } }
```

An object map, because a key holds one value: **"marked both in and out" is unrepresentable**, not
merely rejected.

- `focus` merges **key-by-key**, spreading the original object and overwriting only `transparency` and
  `marks` — the posture `mergeView` already uses for `positions` and `viewport`. v1's
  "otherwise the key is deleted" was a measured regression: today `view.focus` is an unknown key
  preserved whole, so v1 would have exported a document carrying `view.focus = {..., groups: [...]}`
  with the subtree **gone**, for a user who did nothing but open and export.
- **The typed state wins for any id it contains; verbatim preservation applies only to ids absent from
  it.** Without this, an id carrying an unrecognised value from a higher minor (§5.4) is claimed by
  both clauses, and two conforming implementations disagree about whether a right-click did anything.
  So "preserved verbatim" is conditional, and says so.
- The key is deleted only when it was **absent in `raw`** and the typed state is default.
- Keys inserted in sorted order; `canonicalStringify` finishes the job.
- The same delete-on-empty defect is fixed for `fitted` (§2.1.1).

### 5.3 Version locus — off the typed state, not off the key

`formatVersion` → **1.2** when the **typed** state is non-default (marks non-empty or transparency
non-default); `SUPPORTED_MINOR` `1 → 2`. `raiseFormatVersionForFitted` generalises to
`raiseFormatVersion`, raising only if the document declares less, never lowering.

Keying off *whether the key appears in the output* would make §5.2 and §5.3 contradict: the exact
document that motivated §5.2's fix — 1.0, `view.focus = { groups: [...] }`, no marks, default
transparency — correctly keeps its key, and would then have been raised to 1.2 with a `unknown-minor`
warning for a 1.1 reader, on a document whose focus state is empty and where the user did nothing.
A document that clears every mark is **not raised**. A document already written at 1.2 **stays** 1.2,
because `raiseFormatVersion` never lowers and must not: lowering would suppress `unknown-minor` for any
*other* 1.2 extension the raw envelope is carrying, which is a worse failure than a stale minor.
Measured on the precedent — session 1 exports 1.1, session 2 reopens and clears everything and still
exports 1.1 — so an earlier claim that a cleared document "returns to its original declared version"
held only *within* one editing session, while `raw` was still the unraised file. Once reopened, the
raised version **is** its declared version. `vs-resilience-red-team`'s "permanently 1.2" finding is
therefore accepted and resigned in §13, not closed.

The old-reader path needs no new code and was verified independently by extraction (a 1.1-era reader
against a hand-written 1.2 document: `unknown-minor` taken, `raw.view.focus` verbatim) and by semantic
(tracing `mergeView` + `validateView`).

### 5.4 Validation

- `focus` must be an object; `transparency` an integer.
- **Repair is conditional on the declared minor, on all three axes.** At or below `SUPPORTED_MINOR`:
  out-of-band `transparency` is **clamped with a warning**, and an unrecognised mark value is a
  problem. Above `SUPPORTED_MINOR`: both are **clamped/ignored for rendering and preserved verbatim on
  export**. v2 repaired `transparency` unconditionally while preserving unknown mark values on the
  ground that unknown minors must not be corrupted — the same reasoning, opposite conclusions, one
  bullet apart.
- Clamping is not a hard problem. v1 cited `viewport.zoom` as precedent; its bounds live in the
  **injectable** `Limits` while v1 put focus bounds in `contract/view.ts` as module constants, so
  re-tuning the range in any future release would have made every 1.2 document from the previous build
  **unopenable** over a cosmetic integer, with no minor bump available to signal it.
- The band moves into `Limits` as `minFocusTransparency` / `maxFocusTransparency`, so the boundary is
  injectable and the repair testable. `maxFocusTransparency` is itself bounded **< 100**: injecting
  `100` yields `focusOpacity = 0` and trips §7's `0 < opacity` port assertion, turning a cosmetic
  Limits value into an assertion failure.
- `maxFocusMarks` in `Limits` caps the mark count, defaulting to the **`DEFAULT_LIMITS.maxNodes`
  constant (200 000)** — *not* to the document's own node count. The second reading would make a
  document whose marks were authored against a larger graph fail to open, converting I-F5's
  "preserved, inert, warned" into "unopenable". v1 claimed marks "participate in the document-wide
  id-count and size limits"; **no such limit existed** — what bounds them is `maxJsonNodes` (5M),
  `maxBytes` and `maxDepth` via `scanJson`.
- **Mark keys are length-capped.** `scanJson`'s `maxStringLength` checks string *values*, not object
  *keys*, so a 200 000-character mark key parses cleanly today and §8.4.2 renders raw ids as row text.
  Not an injection risk — `el()` reaches the DOM only through `createTextNode` and an architecture
  test fails the build on any `innerHTML` — but a layout and reflow hazard on a new surface.
  graph/runtime additionally truncates in the row.
- `marks` is built with `Object.create(null)`. `scanJson` already rejects `__proto__` / `constructor`
  keys and non-finite numbers document-wide, verified against raw JSON text; this is defence in depth.

### 5.5 Load, refresh, loss

- **import**: every mark kept, including one naming an absent id, so load → export is lossless. Absent
  ids are inert.
- **refresh**: marks naming ids the new model lacks are dropped and reported in
  `LossReport.droppedFocus`; `transparency` carries unchanged.
- **No `stale-focus` warning is constructed.** §8.5 decides nothing would show it on the import path,
  and a `Warning` no consumer reads is §2.1.3 — the defect this plan documents two pages earlier. The
  information the user needs about inert marks comes from §8.4's counter, which must enumerate them
  anyway to render inert rows.
- I-F5 is scoped to `refresh()`. A **third** path reports nothing: a CLI re-extraction publishing over
  the same `--out` replaces the entire `view` subtree with no warning. Demonstrated by extraction with
  verbatim output, now executable as case 4 of `tests/extractor/focus.test.ts`. Predates this issue;
  owner extraction; recorded, not fixed here.

### 5.6 Autosave — per-entry degradation, with a surface and an owner

**Degradation is by kind, not by entry, because `marks` entries are coupled through inheritance.**

- An **unrecognised mark value** — a string this build does not know — is **preserved verbatim and
  ignored for resolution**, mirroring §5.4 into the autosave path. This is the only reachable path (a
  higher minor adding a third token) and the autosave has no version locus of its own, so without this
  clause the cache would treat a future token as corruption where the document treats it as forward
  compatibility.
- Any **structurally invalid entry** — a key or value that is not a string — degrades `marks` **as a
  unit**, because the unrecoverable thing must never be *partially* applied. `transparency` is still
  clamped and kept.
- **The report names the effective-state delta, not an entry count**: "focus changed for N entities".
- Wholesale `emptyFocus()` is reserved for `focus` not being an object at all.

v3's first attempt degraded **per entry**, and that is right for `positions`, `expanded` and `fitted`,
whose entries are independent — one dropped entry affects one node. `focus.marks` entries are coupled
through inheritance, so **one dropped entry re-resolves an arbitrarily large subtree.** Measured on the
committed corpus from this RFC's own worked example (dim a package, bring one subtree back, 390 of 787
nodes effectively out of focus): dropping the **child** entry flips **76 nodes in → out** (10% of the
graph); dropping the **parent** entry flips **390 nodes out → in** (50%). One dropped `positions` entry
costs one node a position that auto-layout re-derives.

The direction is what makes it more than a curiosity: dropping the child mark makes the map *darker*
than the user left it, so the entity they explicitly re-lit is now dark and the map does not look
broken — it looks like a decision. §2.1 is the section that says nothing in the system can re-derive an
attention decision. And "N entries dropped" does not name the subtree that moved, which is why the
report is stated as a delta.

Note for anyone revising this: **§11.8 would have passed.** It asserts that per-entry degradation keeps
valid marks and reports a count, which is exactly the defective behaviour — the test cannot see the
re-resolution, because the re-resolution is *correct* given the marks that survived. Two red teams
pushed this rule from wholesale to per-entry from opposite directions and neither extreme is right for
an inherited structure.

v2 degraded wholesale, and that was an own-goal: §2.1's argument for treating focus differently from a
layout is that **nothing can re-derive a mark**, while §5.6 justified degrading it as a *cosmetic
field with no semantic content*. Both cannot be true of the same field. The real distinction is
*inside* `focus`: `transparency` is cosmetic and repairable, `marks` is human work and is exactly the
unrecoverable thing. So v2's fix for the all-or-nothing defect discarded the unrecoverable part
silently — and a map with no marks is indistinguishable from a map whose marks were just deleted,
whereas the all-or-nothing behaviour it replaced at least said *"autosave-view.json is corrupt and was
ignored"*.

**Surface and owner, because a report with neither is the defect this plan keeps catching.** The fatal
case already has `ProjectControllerState.corruptAutosaveIgnored`, rendered at `ui/app.ts:112`. The
recoverable case gets its own `ProjectControllerState` field — core, `projectController.ts` — rendered
by graph/runtime alongside §8.4's counter. `parseAutosaveView` gains a fatal/recoverable split in its
return type; its caller (`projectController.ts:869-884`) currently has only
`catch { warnings.push(CORRUPT_AUTOSAVE_WARNING) }`.

**Qualified, because two hostile shapes never reach the split.** `parseAutosaveView` runs `scanJson`
first (`autosaveView.ts:26-38`) and throws on dangerous keys, non-finite numbers and oversized
strings **before any field is read**, so `focus.transparency: 1e400` and `focus.marks.__proto__` still
discard the whole autosave. A document-wide safety scan with a per-field exception is a worse trade
than a sentence, so the promise carries the qualifier instead.

**Autosave has no version locus**: `AUTOSAVE_VIEW_FORMAT_VERSION` is pinned to `'1.0'` with an
exact-match requirement, so an older build parses an autosave, drops `focus`, and erases it on the next
write. Bumping it would make that build reject the *whole* cache instead of one field. Accepted limit;
the autosave is a cache, the document is the record.

## 6. Domain commands (core lane)

| Command | Effect |
| --- | --- |
| `SetFocus { id, requested }` | §4.5's minimal-mark rule |
| `SetFocusInherited { id }` | delete `id`'s own mark |
| `SetAllFocus { mark }` | the global toggle and `Clear all focus` |
| `SetFocusTransparency { percent }` | clamp into the `Limits` band, round, ignore non-finite |

`SetAllFocus`: delete every mark whose id **is** in the model, then, for out-of-focus, write the mark
on each `outline.roots()`. **Inert marks survive**, as inert positions and `fitted` ids survive
`ResetLayout`. On the committed corpus there is exactly **one** root, so `SetAllFocus` writes one mark
and "dim one root" and "dim the whole map" coincide.

**Label:** `Show everything` when every outline root is marked out-of-focus, otherwise `Dim
everything` — the command's own fixpoint. v1's "when anything is still in focus" made the label read
idempotent on a destructive action.

**v1's "one undoable state change" is deleted.** There is no undo anywhere in this application, and
the autosave persists the destruction before the user can decline to save.

**Confirmation predicate, stated as the property itself rather than a case analysis:**

```
confirm  ⟺  inverse(apply(view)).marks ≠ view.marks
```

Both commands are pure and O(marks), so running the pair to decide costs nothing and needs no reasoning
about roots or overrides. `SetAllFocus` destroys in **both** directions, and the casually-pressed one is
`Show everything` — *"let me see everything for a second"* — the exact scenario this was raised on, and
the one no reader would classify as "the destructive direction". `Clear all focus` obeys the same test.

Two earlier formulations were wrong and the corpus could not have shown it. "Confirm when the action
deletes marks the inverse would not recreate" misses the two-root case, where the damage is done by
*adding* a mark: roots `r1`, `r2`, `marks = {r1: out-of-focus}`, no overrides, label `Dim everything`
(not *every* root is marked) — pressing it gives `{r1: out, r2: out}` and the inverse gives `{}`, so a
deliberate "half the map dimmed" is unrecoverable while `r1`'s mark was deleted and faithfully
recreated. And "with only root marks present, no confirmation is warranted" is false for the same
reason. **§6 states that the committed corpus has exactly one root, so a test written against the corpus
is green forever** — this is the class of defect a code gate cannot find, which is why §11's test uses a
**two-root fixture** rather than the corpus.

The reversibility intent is preserved exactly where it was right: single root with only root marks →
the round trip is equal → no confirmation. A confirmation on a genuinely reversible act trains people
to click through confirmations, which costs more than it buys.

`VIEW_COMMANDS` becomes `Record<ViewCommand['type'], true>` with a test asserting every
`ViewCommand['type']` routes to `applyViewCommand`. Today it is an untyped `Set<string>` with no
exhaustiveness check and no test: add a command, forget the set, and `apply()` falls to
`default: return state` — silently swallowed, `tsc` happy. Both red teams found it independently.

Each command returns the same `view` reference on a no-op.

## 7. Scene and renderer (graph/runtime lane)

**Port:** `dimmed: boolean` → required `opacity: number`, plus `marker?: string` — a scene-chosen
presentational glyph on the `badge` precedent, carrying §4.4's partial affordance. Not
`subtreeHasOutOfFocus`, which would put focus into the port. Optional is right for `marker` because it
is usually absent, exactly like `badge?: string`; `opacity` is required because it governs whether the
user can see the thing at all. One cross-cutting port change, **2-of-3 recorded** (graph/runtime
proposes, core supports, extraction has no basis on a port it does not touch), no dissent.

**Composition:** `opacity = min(searchOpacity, focusOpacity)` — dimmest reason wins. Monotone,
order-free, exactly `1` when nothing applies. `focusOpacity = 1 - transparency/100`, identical for
nodes and edges; search keeps its own differing values, which move from `Canvas2DRenderer` literals to
named `SEARCH_NODE_OPACITY = 0.22` / `SEARCH_EDGE_OPACITY = 0.14` in `app/scene.ts`.

Without a stated rule two conforming implementations render opposite results: at `transparency = 10`
focus alpha is `0.90` and search `0.22`, so a focus-wins reading makes **enabling focus brighten a
node the search had dimmed**.

**Band:** `maxFocusTransparency = 78` (alpha `0.22`), `FOCUS_TRANSPARENCY_DEFAULT = 70` (alpha `0.30`),
`minFocusTransparency = 10`. v1's `95` / `80` were a guess: at 95 every element sits at
**1.02–1.09:1** — perceptually gone while fully hit-testable, a clickable ghost. 78 introduces no new
constant; it is the node dim this app already ships for search.

**I-F6 is stated on the composited pixel**, not the pre-composite alpha: at v1's max the expanded
container header strip composited to `0.008`, the same 8-bit value as the background. At 78 nothing
quantises into the backdrop any more (header `0.0352`, 3/255).

**The plan does not claim the two channels are separable by alpha, because they are not.** Measured
against the real palette, focus-dimmed vs search-dimmed is 2/255 (1.015:1) at the default and
**0/255** at the maximum — the maximum *is* the search dim, which §7 presents as a virtue and is
exactly why the collision exists. Separability is delivered by §8.4's row glyphs and by context.

**Selection ring: `RING_FLOOR = 0.40`, drawn as `max(opacity, RING_FLOOR)`.** Required because at the
new default of 70 the ring is **2.62:1** without it. The conformance case pins **0.38 / 3.30** — the
container-branch minimum and worst case — not 0.34 / 3.70: a full sweep of all seven kinds across both
ring branches and the whole band found `0.34` **fails on both** (leaf: `repository` 2.9967,
`directory` 2.9980 — just under, not "exactly 3.00"; container: every kind at ~2.71). True minima are
0.35 leaf and **0.38 container**. So `0.40`'s real margin is **0.02**, and anyone later "optimising"
toward a believed 0.34 breaks containers immediately.

The floor also raises a **search**-dimmed selected node's ring from 1.95:1 to 3.71:1. That is an
improvement and is kept, and it is owned here explicitly rather than inherited: a selected node under
an active search renders differently after this change.

**Container chrome floor is stated on the border, and the header strip is resigned.** The header
carries 36–45% of a dimmed leaf's contrast-above-1 at every setting, and raising the fill to match
would require undoing the `×0.55` that makes an expanded container see-through — so the floor is not
satisfiable there. The border (`withAlpha(stroke, 0.75)`) already **exceeds** a dimmed leaf box at
every transparency (1.077 vs 1.032 at max), so a floor stated on the border is already satisfied.
Writing down which element it means keeps the conformance case off the wrong one.

**I-F6's edge clause:** a dimmed edge is measured against the **node** floor (`0.22`), not the edge
one. Search dims edges to `0.14`, so a focus-dimmed edge at `0.22` is never the binding case, and the
invariant is load-bearing only for nodes — where the maximum equals the floor exactly (equality, not
strictly above).

**Hit-testing unchanged.** `hitNode` filters `hidden` only, so an out-of-focus node still receives
clicks — correct, because focus is not a filter. It is tolerable only because the band's ceiling keeps
those targets perceptible.

**Untouched:** `hiddenByFilter`, `hidden`, edge routing, every count.
**Port invariant:** `assertSceneWellFormed` asserts `0 < opacity <= 1` on every node and edge.

## 8. UI and interaction (graph/runtime lane)

### 8.1 The context menu lives in `shell`

Two independent reasons, each alone fatal to an in-row menu: `renderList` runs on **every** controller
notification and opens with `clear(listHost)`; and `.node-list` is `max-height: 44vh; overflow-y: auto`,
which **clips** an absolutely-positioned child exactly where the last rows are.

One menu element created in `mountUi`, appended to `shell`, `popover="auto"` for platform light-dismiss
and top-layer rendering. It holds the **node id** from `data-node-id`, never the row element.

Items: the focus action labelled for what it does given the effective state, and `Reset to inherited`
only when the row carries an explicit mark.

**Lifetime is decoupled from controller notifications.** `viewport:change` fires from the
**pointermove** pan handler, so panning rebuilds up to 400 sidebar buttons per pointermove and
`startFollowLoop` polls at 1000 ms — a notification-closed menu would die on an incidental drag, on
momentum scroll, and once a second on any followed document. Because the menu holds an id, closing is
unnecessary: it closes on **user intent** — Escape, outside pointerdown, list scroll, resize, item
chosen, **and any panel/overlay change** — and when its node id leaves the model, checked as
`nodeById.has(id)`, O(1). The `[` and `]` panel toggles hide the sidebar **without** firing `resize`,
and popover light-dismiss is pointer-driven so it does not fire on a keydown: right-click a row, press
`[`, and the menu would be left floating over the canvas still holding a valid id. The underlying
rebuild cost is #19.

**Escape needs an explicit early return in `onKey` guarded on "menu open".** `ui/app.ts:989-1002` runs
its overlay-Escape branch **before** `isInteractionEvent`, so in the narrow and hybrid bands Escape
would close the whole sidebar and take the anchor row with it. The native popover does **not** discharge
this: light-dismiss closes the popover but does not stop the document-level `keydown` firing on the same
keystroke. Tested on that exact keystroke in the narrow band.

**Menu items must be `<button role="menuitem">`.** `isInteractionEvent` (`ui/app.ts:1730-1741`)
whitelists `INPUT/TEXTAREA/SELECT/BUTTON` and roles `combobox/listbox/option` — `menu` and `menuitem`
are absent, so `<div role="menuitem">` leaves the bare-key shortcuts live under typeahead: `r` →
`ResetLayout`, which wipes the hand-made layout with no undo, and `Reset to inherited` starts with `r`.

**The two focus mechanisms must not share `scheduleFocus`'s single rAF slot.** `ui/app.ts:243-249`
keeps one `focusFrame` and cancels any pending one, so a follow tick or a pan would restore focus to a
row while the menu is open — the menu stays up and the keyboard leaves it, once a second under
`extract:watch`. Two constraints: the row restore is a no-op unless focus was inside the list before
the rebuild, and the menu's focus does not share the slot.

**Keyboard.** `Shift+F10` and the context-menu key open the same menu, first item focused, arrows
within. Rows gain `data-node-id`; the focused id is remembered before `clear(listHost)` and restored
after, because `renderList` drops focus to `<body>` today. Reaching an arbitrary row without tabbing
through its predecessors is **#18**.

### 8.2 Both controls under the counts box, in the Explorer sidebar

Below **1664 px** the Project rail and the Explorer are mutually exclusive, so a transparency control
in the rail could not be adjusted while looking at the list it dims. The "left rail" of the request is
the leftmost panel holding the counts box and the node list the user was right-clicking in, which
satisfies both of the user's placement statements at once.

```
counts box
[ Dim everything / Show everything ]                    ← the one toggle, fixpoint label
N marked · M inert   [ Clear all focus (N) ]            ← only when marks exist
Out-of-focus transparency  [====|--] 70 %
node list
```

A `range` with a live numeric readout, because this is a perceptual setting: you watch the map fade
while dragging. The readout is the typed and accessible entry, bound to the same command; empty or
out-of-range leaves the last valid value in force and says so inline. Dispatches coalesce to one per
animation frame. Budget: **p95 ≤ 16 ms input → painted frame at expand-all**, reported with numbers;
fallback is committing on `change`. `derive()` is p50 3.82 ms / p95 5.26 ms at expand-all, of which
`resolveFocus` is 0.049 ms; a transparency keystroke re-running layout and projection for a paint
constant is architecturally wrong, within budget, and resigned in §13.

### 8.3 The toggle, `Clear all focus`, and saying so when the Explorer is closed

One toggle, labelled from §6's fixpoint, confirming per §6's predicate. Beside it `Clear all focus (N)`
whenever any clearable mark exists — a distinct control whose label states its own effect and
magnitude, not a mode of the toggle. `vs-resilience-red-team` re-ran its state enumeration against
this and closed it, explicitly declining the one-vs-two escalation: the counter-as-rows disclosure
makes each mark *individually* actionable, which is better than the second button it had asked for.

**`N` counts only clearable (in-model) marks; inert marks are reported separately as `M inert`.**
`SetAllFocus` deliberately preserves inert marks, so a button counting them would read
`Clear all focus (5)`, delete 3, then read `Clear all focus (2)` and do nothing on every further
press — always present, always enabled, naming a count, inert. The per-row `Reset to inherited` on an
inert row remains the route for those.

**The confirmation must not be `globalThis.confirm`.** Chrome's "prevent this page from creating
additional dialogs" makes it return `false` for the rest of the page's life; the app's existing two
uses are rare project-lifecycle actions, but a focus toggle is not rare, so one ticked box would turn
`Dim everything` into a permanent silent no-op. An in-app confirmation, consistent with
`discardConfirmationCopy`'s "no confirmation needed → `null`" pattern.

**When the Explorer is closed and marks exist, something outside it must say so.** `applyLayout`
starts the Explorer **closed** at narrow (`activeOverlay` begins `null`) and closed at hybrid in a
temporary session with no project (`projectOpen` is `true` when `!hasProject`). Since §13 resigns any
canvas affordance and every focus control lives in the Explorer, a person otherwise meets a visibly
faded map with no on-screen explanation and no on-screen escape — reachable by dimming, resizing, and
returning tomorrow, because focus survives reload.

**The announcement goes in `bannerHost`, not the `status` region.** `statusHost` is
`role="status" aria-live="polite"` with a single slot that `announce()` (`ui/app.ts:1425`) rewrites on
**every controller notification**, so there are only two outcomes there and both are failures: write
the focus state once and the next single click clobbers it — P2-d returning on a longer fuse — or
re-assert it after every notification and a `polite` region re-announces an unchanged state to a screen
reader at `viewport:change` frequency, which is once per pan pointermove.

`bannerHost` already carries exactly this shape of persistent state, rebuilt from state rather than from
events: "Read-only", and three lines from where a focus banner goes, *"A filter is hiding N node(s) and
M relation(s). Projection is unchanged — a filter is a mask, not a re-projection."* **A focus banner is
that same sentence for the other mask**, and the parallel is worth preserving in its wording.

§11's presence assertion would have passed either way — it checks presence at a moment, and neither
failure above is a failure of presence at that moment.

### 8.3.1 Right-click on a canvas node — in scope, at the user's request

**Requested by the user after seeing it in the running app**, with the reason three reviewers had
already reached independently: a `file` node is drawn on the canvas and has **no sidebar row**, so
there was no surface to right-click and no way to bring it back into focus. The screenshot that made
the case is a single `run.js` box.

`contextmenu` on the canvas host hit-tests to a node and opens **the same menu instance** with that
node's id, and — as a left click already does — selects it. So the user's "when an element is selected
on the canvas" is satisfied without demanding a prior selection, which would have cost two gestures.

**This costs almost nothing, and the reason is a design decision taken for something else.** §8.1's
menu holds a **node id**, never a row element, because `renderList` destroys rows on every controller
notification. That same choice makes the menu reusable from a second, completely different surface with
no new menu machinery: one more producer of an id.

- `hitNode` filters `hidden` only and never dimming, so an **out-of-focus node is still hit-testable** —
  which is precisely what makes this the escape hatch for a node with no row. §7's decision not to make
  focus a filter is what makes this work, and §7's perceptibility ceiling is what makes the target
  findable.
- The renderer port emits a `node:contextmenu` event alongside `node:click` / `background:click`. Port
  change, so cross-cutting: graph/runtime proposes and owns it, core supports — **2 of 3**, no dissent.
- **Right-click on an edge does nothing**, stated so it is not discovered: an edge has no focus state of
  its own, it derives one from its endpoints (§4.3), so a menu there would have nothing to offer.
- Right-click on empty canvas does nothing. A background menu is a different feature.
- **Keyboard parity is already covered** and needs no canvas key handling: §8.4.3's detail panel is the
  accessible route to the same actions for any selected entity, which is where #13 put the accessible
  route for `FitContainer` for the same reason.

**What this supersedes.** §8.4's mark counter was accepted by both red teams as the mitigation for the
1.3%-of-entities reachability problem, and it remains valuable — it is the only surface that *reports*
what is marked. But the canvas menu is a strictly better answer to "how do I get this one thing back",
because it works on the thing the user is looking at rather than on a list they must first make show it.
Both ship.

### 8.4 Row state, and the counter that makes an unlisted mark reachable

`renderList` filters `file` and `directory` out on an empty query, so the list shows **10 rows of 787
entities (1.3%)**, and any short query overflows the 400-row cap (`"e"` → 685 matches, 285
unreachable). Three reviewers found this independently. It means a mark on a file is **unreachable**,
not merely invisible, once the search is cleared — and the RFC's own worked example, "dim
`agentscommander (web)`, then bring one of its files back", could not be performed on the happy path.

1. **Row glyphs**, by shape not colour, consistent with the port's `cut-rect`/`hex` reasoning: `◐`
   explicitly out of focus, `○` an explicit in-focus override, nothing for inherited — so *glyph
   present ⟺ you said something about this row*. `title` names the state and, when inherited, the
   ancestor. The row renders attenuated, matching the map.
2. **The counter is a disclosure, not a tooltip**: it expands to show unlisted marked entities **as
   real rows**, same row builder, same glyph, same context menu, so each is individually actionable via
   `SetFocusInherited`. A `title` was rejected as not keyboard-reachable, read-only (it makes an
   unreachable mark *visible* and leaves it unreachable) and unbounded. Inert marks render as the raw
   id — truncated per §5.4 — with a distinct marker, and keep `Reset to inherited`, since deleting an
   inert mark is the one meaningful thing you can do to one.
3. **The detail panel** says whether the selected entity is out of focus and *why* — own mark, or
   inherited from ⟨ancestor⟩ — and for a container, how many of its folded-away relations are out of
   focus (§4.3). It works for entities with no sidebar row, and #13 already put the accessible
   keyboard route there.

### 8.5 The loss banner names all four

The refresh loss banner names dropped positions, expanded ids, **fitted ids** and **focus marks**.
`droppedFitted` surfacing is an accepted, recorded scope addition.

**No warning-allowlist entry, and no `stale-focus` warning at all** (§5.5). The three existing
`stale-*` warnings are mute on the **import** path and there muting is *correct* — entries are kept,
inert, and nothing the user sees changes, so a banner alarms about a non-event. **Refresh** is where
the requirement is real: it changes what the user sees, and under follow-file it happens unattended.

## 9. Invariants

- **I-F1 Presentational only.** Focus never participates in projection. Verified structurally by both
  red teams: `project(model, outline, expanded)` takes the expansion set, not the view, and §4.3's
  logical walk reads `model.edgeById` inside `buildScene` without entering `project`.
- **I-F2 Counts invariant.** All four counts read `model.nodes.length`, `model.edges.length`,
  `graph.visibleEdges.length` and a sum over `internalBuckets`; none can see `view.focus`.
- **I-F3 Unrepresentable contradiction.** No id can be both in and out of focus.
- **I-F4 Deterministic bytes.** Same focus state → same bytes. A document that never carried the key
  never gains one, and a scene with no marks has every `opacity` at `1` (§4.3's vacuous-truth guard).
- **I-F5 Lossless import, reported refresh.** Scoped to `refresh()` (§5.5).
- **I-F6 Perceptibility floor.** The **composited** opacity of an out-of-focus entity never falls below
  the node search-dim strength (`0.22`, equality permitted); the selection ring holds `RING_FLOOR` and
  the container **border** holds its own floor, so an out-of-focus entity stays perceptible as well as
  selectable, inspectable, searchable and counted.
- **I-F7 Layout untouched.** No focus action changes `positions`, `expanded`, `fitted` or the viewport.
- **I-F8 Override independence.** Marking a descendant does not change any ancestor's mark, and marking
  an ancestor does not delete any descendant's mark.
- **I-F9 Focus is a human statement.** Focus lives only under `view.focus` — never in
  `nodes[].metadata`, `edges[].metadata`, `evidence[]` or `unresolved[]` — and no extractor ever emits
  `view.focus`. `metadata` is a free-form `Record<string, unknown>` the validator accepts without
  inspection *and regenerates every run*, so a mark parked there would be indistinguishable from an
  observation and destroyed at the next extraction. Executable: `tests/extractor/focus.test.ts`.
- **I-F10, in two parts.** (a) **`view.*` carries no observations** — nothing under `view` is a claim
  about the code, *even when a machine writes it*. An observation is precisely a claim carrying
  `evidence[]` and `confidence`, and nothing under `view` has either, which is *why* none of it is one.
  (b) **`view.focus` specifically is a human decision** — no machine writes it, and a machine suggestion
  about attention must travel under a different, derived, recomputed-every-run key the UI can name.

  The split matters. Stating (b) as though it covered all of `view` gives (a) a visible counterexample:
  the extractor emits `view: { expanded: [<repo>] }` on **every run**. That is a suggested starting view,
  not a finding — but "no machine writes under `view`" is refutable in a minute, and an invariant with a
  refutable form stops being quoted.

  Stated in `contract/types.ts`, in **`VisualSpecs/README.md`'s document section** — where a consumer of
  the artifact actually looks, rather than only where an implementer does — in ARCHITECTURE, and in
  ADR-0006. **Not in the document itself**: an explanatory key would break I-F4 and AC 10 by making a
  document that never used the feature stop exporting byte-identically.

  Machine-checked in both directions by extraction: nothing under `view` ever grows `evidence`,
  `confidence`, `path` or `line`, and no observation ever grows a focus key. That is the checkable form of
  the whole invariant, and it follows from the definition rather than restating the prose.

## 10. Allowed files

**Core** — `contract/view.ts`, `types.ts`, `validate.ts`, `limits.ts`, `load.ts`, `export.ts`,
`autosaveView.ts`, `domain/commands.ts`, new `domain/focus.ts`, `app/state.ts`, `app/controller.ts`,
`app/projectController.ts`, tests for those, this plan, ADR-0006, and the `LossReport` section of
`docs/ARCHITECTURE.md`.

**Graph/runtime** — `app/scene.ts`, `ports/renderer.ts`, `renderer.conformance.ts`,
`adapters/canvas2d/*`, `ui/app.ts`, `ui/detail.ts`, `styles.css`,
`tests/app/controller.test.ts:82-87`, plus unit and Playwright tests. `vs-resilience-red-team` grepped
`dimmed` across `src/` and `tests/` and confirmed every site is inside a named file with no orphan.

**Extraction** — `tests/extractor/**`.

## 11. Verification

Core:

1. `focus` round-trips export → validate → import unchanged, including an inert mark **and** an
   unrecognised mark value from a higher minor.
2. A document with an unknown sub-key inside `view.focus` keeps it through a round trip.
3. A document declaring `"fitted": []` keeps the key through a no-op round trip.
4. Unused feature exports byte-identical **at `exportDoc`** — AC 10 is scoped there, because
   `Controller.exportText` injects a position for every visible node and is never byte-identical
   independently of this feature.
5. Version locus off the **typed** state: focus non-default → 1.2; the §5.2 key-preserved-but-default
   document stays at its declared version; clearing every mark returns it there; a 1.3 document is not
   lowered.
6. `validate`: clamps and warns on out-of-band `transparency` at or below `SUPPORTED_MINOR`; preserves
   verbatim above it; rejects an unrecognised mark value at a known minor and warns above; rejects over
   `maxFocusMarks`; rejects an over-long mark key; rejects `maxFocusTransparency >= 100`. Bounds
   injected through `Limits`.
7. Refresh drops stale marks, populates `droppedFocus`, keeps `transparency`.
8. **Autosave hostile-input matrix** — which shapes are recoverable (range, type, non-object, bad
   token) and which are fatal (`1e400`, `__proto__`, oversized string, because `scanJson` runs first);
   per-entry degradation keeps valid marks and reports the dropped count; positions, expanded, fitted
   and viewport survive a recoverable case.
9. **The autosave key changes whenever any view field changes, focus included**, and is insensitive to
   insertion order for **every** keyed field — `marks` *and* `positions`. `JSON.stringify` is
   order-sensitive where `canonicalStringify` is not, so `SetFocus(x); SetFocus(y);
   SetFocusInherited(x); SetFocus(x)` must not manufacture a spurious dirty write, and neither must
   `MoveNode a; MoveNode b; ResetLayout; MoveNode b; MoveNode a`. The `positions` half is a **new**
   property, not a preserved one: it does not hold today (§5.1.1). Focus is a new *sufficient*
   condition for dirtiness, not the only one.
10. A mark survives autosave → restore and preview → return, **driven through `ProjectController`'s own
    path** (`flushAutosave` → `writeAutosaveView` → `prepareProjectCandidate` → `toViewState`), not the
    codec boundary — a test written at `autosaveViewText` / `parseAutosaveView` passes while
    `toVisualSpecsView` still drops focus.
11. `resolveFocus`: parent out / child in / grandchild inherits child; siblings unaffected; deep
    alternating chain; unmarked graph resolves all-in; property test that every model node gets a state.
12. §4.3: the `{P:out, c1:in}` case; the ×136 fraction; the ×1 identity; expanding `P` does not flip a
    relation's own state.
13. §4.4's flag means *differs from mine*, over the NVA-defined hidden subtree, in all three scenarios.
14. §4.5's four-step table, and step 4 leaving no `P` mark.
15. I-F1 / I-F2 / I-F7 / I-F8 as executable checks over a random focus-command sequence; the model
    stays deep-frozen.
16. `SetAllFocus` preserves inert marks; no-op commands return the same reference; every
    `ViewCommand['type']` routes to `applyViewCommand`.
17. **The partition property**: `Σ|sourceEdgeIds|` over visible edges + internal buckets + out-of-scope
    `== |model.edges|` at every expansion state, no duplication. It is the load-bearing assumption of
    §4.3's cost argument and nothing else asserts it.

Graph/runtime: opacity on exactly the right nodes and edges, including the fractional aggregate;
`min` composition in both orders; the **four-state table** showing non-matching + out-of-focus renders
identically to non-matching + in-focus (§13); `0 < opacity <= 1` at every transparency; the
**vacuous-truth guard** — no visible edge with empty or wholly unresolvable `sourceEdgeIds` dims;
`focusOpacity` equals `SEARCH_NODE_OPACITY` at the maximum, asserted rather than assumed;
**the ring floor swept over every kind × both ring colours × the whole band, pinning 0.38 / 3.30**;
container border floor; I-F1/I-F2 on the corpus; I-F7 geometry identical; menu opens on right-click and
`Shift+F10`; survives pan, momentum scroll, follow tick and rebuild; closes on panel toggle; not
clipped on the last row; Escape closes the menu and not the sidebar; menu focus does not share
`scheduleFocus`'s slot; focus returns to the correct row after a rebuild only when it was in the list;
transparency rejects garbage; toggle both directions including dim → override → toggle; the
confirmation fires on the correct predicate and is not `globalThis.confirm`; `Clear all focus (N)`
counts only clearable marks; the off-Explorer announcement appears at narrow and at hybrid-without-project;
a mark on a file is still reported after the search is cleared; explicit vs inherited distinguishable;
the refresh banner names fitted ids and focus marks.

Extraction: the extractor emits `1.0` and no `focus` anywhere (landed, `000e190`); then
extract → apply focus → re-extract, asserting projection, every count and every observation are
bit-identical with and without focus state.

**AC ↔ verification:** AC1–AC2 → graph/runtime menu and keyboard; AC3 → 11.12, 11.15, plus §4.3's
internal-bucket statement; AC4 → 11.11, 11.13; AC5 → 11.11, 11.12, 11.14; AC6 → §8.4's three
affordances + §8.3's off-Explorer announcement; AC7 → 11.6, 11.8; AC8 → 11.16 + toggle tests;
AC9 → 11.8, 11.9, 11.10; AC10 → 11.4 (scoped); AC11 → 11.7 + the §8.5 banner test; AC12 → 11.1, 11.5.

## 12. Resolved questions

v1 §12's four questions are closed: verbatim marks kept and the **write** rule fixed (§4.5/§4.6);
`opacity: number` + `marker?: string`, 2-of-3 recorded (§7); the edge axis was endpoints-vs-logical
relations, and the answer is a fraction rather than a bit (§4.3); extraction writes `view`
unconditionally and reads it never, nothing in provenance or evidence can see focus (§5.5, I-F9).

## 13. What this resigns

- **A flat, trivially-diffable dimmed set**, and simplicity in `view` — a fifth field, plus one
  exhaustive projection so the next one cannot be forgotten at any of five sites.
- **Forward compatibility on the mark-value axis**, bought back by §5.4's minor-conditional
  preserve rule. The object map makes contradiction unrepresentable and makes an extended value domain
  a version concern; two arrays would have traded those the other way.
- **An in-focus node's degree looks lower at a glance**: 83% of the edges dimmed by a subtree mark have
  a bright endpoint.
- **Focus is unobservable on canvas for every node a search does not match.** `min` plus a `0.22`
  ceiling means a non-matching node renders at `0.22` whether or not it is out of focus, and
  `renderList` shows only matching rows during a search, so the sidebar hides it at the same moment.
  `min` is still the right composition — no alternative keeps monotonicity and the no-op property —
  so this is stated, with §8.4's counter as the mitigation, rather than discovered by a user who clears
  a search and finds things still dim.
- **The two dim channels are not separable by alpha at any setting** (2/255 at the default, 0/255 at
  the maximum). Separability comes from the row glyphs and context.
- **The container header strip cannot meet a perceptibility floor** without undoing the `×0.55` that
  makes an expanded container see-through. The floor is stated on the border, which already exceeds it.
- **`RING_FLOOR = 0.40` has a 0.02 margin** over the measured 0.38 container minimum.
- **The counter's disclosure is capped** like the existing "… and N more", so a large enough mark set
  again has entries with no row. Acceptable because `Clear all focus` is an always-available global
  escape.
- **A transparency keystroke re-runs layout and projection** (p50 3.82 ms) for a paint constant.
  Restructuring belongs with #19.
- **A document written at 1.2 stays at 1.2 even after every mark is cleared**, so a 1.1 reader keeps
  getting `unknown-minor` for a document carrying no focus information. `raiseFormatVersion` never
  lowers, and it must not: lowering would suppress `unknown-minor` for any other 1.2 extension the raw
  envelope carries.
- **`focus.transparency` is repaired on load at known minors**, unlike inert marks.
- **The autosave has no version locus**, and two hostile shapes (`1e400`, `__proto__`) bypass §5.6's
  per-entry degradation because `scanJson` runs first and discards the whole cache.
- **`positions`/`expanded`/`fitted`/`viewport` stay all-or-nothing in the autosave.** Pre-existing.
- **A CLI re-extraction over the same `--out` replaces the whole `view` subtree with no warning.**
  Pre-existing, executable, owner extraction.
- **Out of scope:** any other menu item; coupling the transparency to search dimming; #18; #19.
- **Multi-placement:** `focus.marks` joins `expanded`, `fitted` and `positions` in the fields keyed by
  node id *because* `OutlineNodeId === NodeId` today; relaxing I10 makes the nearest marked ancestor
  non-unique and this field re-keys with the others. Appended to `MULTI_PLACEMENT_NOTE`.
- **Rollback:** additive and optional at every layer. Reverting leaves 1.2 documents readable by a 1.1
  build through the `unknown-minor` + raw-envelope path, focus preserved on export, every node in
  focus. No migration, no data loss.

**ADR-0006** records the tri-state-with-override model; the object-map serialization with its
forward-compatibility cost; §4.3's logical-relation rule, its fractional form, and the `matchesUnder`
asymmetry it deliberately does not mirror — search keeps a container's edges bright so a hit inside a
collapsed box stays discoverable, focus does the mechanically identical thing for the opposite semantic
reason; §4.5's write rule and its writes-versus-retention distinction; and I-F9/I-F10 as the boundary
condition for any future auto-dim feature.
