# RFC 17 — Out-of-focus dimming

Issue: https://github.com/mblua/VisualSpecs/issues/17
Branch: `feature/17-out-of-focus-dimming`
Delivery path: **full**
Status: **v2 — revised after four reviews. Round 2: both red teams verify the closures below.**

Follow-ups opened, deliberately out of scope: **#18** (sidebar roving tabindex), **#19** (pan rebuilds
the whole sidebar per pointermove).

## 0. Review record

| Reviewer | Verdict on v1 | Disposition |
| --- | --- | --- |
| `vs-extraction-evidence-dev` | VALIDATED_WITH_CHANGES (C1–C4) | all accepted |
| `vs-graph-runtime-dev` | VALIDATED_WITH_CHANGES (C1–C6, §D/§E) | all accepted except C4, **overturned by F1** |
| `vs-resilience-red-team` | 4 P1 / 6 P2 / 3 P3 (R1–R13) | all accepted |
| `vs-semantic-red-team` | 9 P1 / 6 P2 / 4 P3 (F1–F20) | all accepted |

v1's §7/§8 are replaced by graph/runtime's §D/§E, carried below as §7/§8.

**Arbitration — F1 over graph/runtime C4.** v1 §4.3 asked an aggregated edge's *visible endpoints*.
`vs-semantic-red-team` measured that this makes the override — the entire justification for the
tri-state model — unrepresentable whenever the parent is collapsed, which is the default view
(`initialExpanded` = roots only). graph/runtime rejected the logical-relation rule on cost,
reading it as `O(edges × sourceEdgeIds)`. That reading is wrong: `project` iterates `model.edges`
exactly once and partitions them, so `Σ|sourceEdgeIds|` over all visible edges and internal buckets
**equals** `|model.edges|`. The rule is one additive pass over 1872 logical relations — the same order
as `project` itself, measured at p50 1.00 ms. Cost objection does not hold; the measured semantic
defect does. Core decides §4.3 and takes the logical rule. graph/runtime's second objection — that an
aggregate may then disagree with its own endpoints' dimming — is answered in §4.3.

## 1. Scope and ownership

| Artifact | Owner |
| --- | --- |
| Focus contract, domain, focus semantics | `vs-spec-core-lead` |
| Focus presentation and interaction | `vs-graph-runtime-dev` |
| Extraction-side non-regression and invariance | `vs-extraction-evidence-dev` |

Neither owner edits another's files. A change that needs the other side is a message, not an edit.

## 2. Before state

- `RenderNode.dimmed` / `RenderEdge.dimmed` exist; `Canvas2DRenderer` honours them with literals
  `0.22` (nodes, `:593`) and `0.14` (edges, `:722`). One producer: search, in `app/scene.ts`.
- No `contextmenu` handler exists anywhere in the app.
- `ViewState` holds `expanded`, `positions`, `fitted`, `viewport`. `fitted` (#13) is the precedent for
  a new additive view field — **and the source of three defects this RFC must not copy** (§2.1).
- `validate.ts`: `SUPPORTED_MAJOR = 1`, `SUPPORTED_MINOR = 1`.
- `OwnershipOutline` is injective (I10) and `OutlineNodeId === NodeId`.
- **Corpora.** Two datasets, both real, named on every measurement: the **user's running app**
  (744 nodes / 1609 relations / 14 drawn / 1419 folded, from the screenshot that opened this issue)
  and the **committed corpus** `data/agentscommander.json` at `e94f003` (787 nodes / 1872 relations;
  default view 10 visible nodes / 14 drawn edges / 2 internal buckets; expand-all 787 / 1713 / 0;
  exactly **one** outline root).

### 2.1 What the `fitted` precedent gets wrong, so this RFC stops copying it

1. `export.ts:107` does `delete rawView['fitted']` when the set is empty, so a document that declared
   `"fitted": []` loses the key on a no-op round trip. Measured (semantic C2). Fixed here (§5.2) and
   fixed for `fitted` in passing.
2. `droppedFitted` has been in `LossReport` since #13 and is printed by nothing
   (`ui/app.ts:1253-1256`). `docs/ARCHITECTURE.md:433` still documents `LossReport` without it.
3. `stale-fitted` is constructed in `load.ts` and dropped by the banner allowlist
   (`ui/app.ts:1234-1242`), which accepts three codes.

Copying `fitted` "exactly" would have produced a `droppedFocus` field that reaches no human. Losing a
layout silently is recoverable — auto-layout re-derives it. **Losing an attention decision silently is
not: nothing in the system can re-derive what a person chose to push into the background.**

## 3. Requested change

A person can push individual entities out of focus from the sidebar list, choose how transparent
out-of-focus things are, and flip the whole map with one control. The state persists with the view.

## 4. The focus model

### 4.1 Tri-state, inherited, overridable

| State | Stored as | Meaning |
| --- | --- | --- |
| explicit out | `marks[id] = "out-of-focus"` | out of focus, and by inheritance so is everything under it |
| explicit in | `marks[id] = "in-focus"` | in focus, **overriding** an out-of-focus ancestor |
| unmarked | absent | inherits the nearest marked ancestor; in focus if none |

Values are spelled `"out-of-focus"` / `"in-focus"`, not `"out"` / `"in"` (semantic F16). This document
is read by coding agents, and a bare `"out"` on a node is one reading away from "out of scope",
"excluded" or "dead" — a claim about the system rather than about where a person is looking.

The override is the point. Dim `agentscommander (web)`, then bring one of its files back: the file
lights up and **the container stays dim**.

### 4.2 Resolution

`resolveFocus(outline, marks) -> Map<OutlineNodeId, 'in' | 'out'>` — one pre-order walk from
`outline.roots()` carrying the inherited value down. O(n). Measured by `vs-resilience-red-team` at
**0.049 ms** over 787 outline nodes.

Totality and determinism are **verified, not assumed** (semantic C8): `checkIntegrity` guarantees I2
and I3, so every node's ancestor chain terminates at a root, and `assertInjective` rejects any
placement unreachable from the roots. There is no model node that is unplaced or unreachable, so the
walk assigns an effective state to every one. v1 worried this might not hold; it does.

### 4.3 Edges — over logical relations, not visible endpoints

**An aggregated edge is out of focus iff every logical relation it carries has at least one
effectively-out-of-focus endpoint**, where a logical relation's endpoints are its own entities
(`edge.sourceId` / `edge.targetId`), not the aggregate's representatives.

`VisibleEdge.sourceEdgeIds` is already there and is exactly "the logical relations behind this one
line". Using the representatives instead destroys the information aggregation exists to preserve —
`projection/project.ts`'s own §6.5: *"A counter preserves the QUANTITY of information and destroys the
INFORMATION."*

For a ×1 aggregate between two visible leaves this is **identical** to "either endpoint out of focus",
so `vs-graph-runtime-dev`'s measurement stands: under a *both-endpoints* rule, marking any of the three
right-clickable packages in the default view dims **0 of 14** drawn edges — the feature would appear
broken in the state the app opens in. The `either`-vs-`both` question was the wrong axis; the axis is
**endpoints vs logical relations**.

The measured case this fixes (semantic F1), `repo → { P → { c1, c2 }, Q }`, `e1: c1→Q`, `e2: c2→Q`,
`marks = { P: out, c1: in }` — the RFC's own motivating scenario:

| | v1 rule (endpoints) | v2 rule (logical) |
| --- | --- | --- |
| P collapsed | `P→Q ×2` **dimmed** — hides `e1`, which the user explicitly re-lit | `P→Q ×2` bright — `e1` has no out endpoint |
| P expanded | `c1→Q` bright, `c2→Q` dimmed | identical |

Under v1 the same logical relation flipped from dim to bright purely by expanding P.

**graph/runtime's objection, answered.** An aggregate may now be bright while its source box is dim.
That is not a lie, it is the aggregate telling the truth about what it stands for: the box is dim
because you dimmed it, and the line is bright because at least one relation it carries runs between two
things you still want to see. The alternative hides a relation the user explicitly asked to keep.

**Consequence, measured, accepted rather than fixed** (graph/runtime, `vs-resilience-red-team` R13): of
the 639 edges dimmed when `dir:src/shared` goes out of focus at expand-all, **532 (83%) have a bright
endpoint**, so an in-focus node's degree looks lower at a glance. Worst case dims 37.3% of drawn edges;
63% of the map stays at full strength. The most *reachable* actions are the most drastic: dimming
`pkg:npm:package.json` — one of the ten rows available without typing — fades 67% of all relations. The
detail panel remains the authoritative enumeration of a node's relations, so the count is not lost,
only the glance. A second attenuation level for half-dim edges is not being invented.

### 4.4 Collapsed representatives

A collapsed container renders by **its own** effective state. Additionally, the scene exposes whether a
representative's hidden subtree contains any effectively-out-of-focus entity, so graph/runtime can
render a **partial** affordance (the descendant-count badge, `scene.ts:72-75`, is the precedent).

Without this, marking an entity inside a collapsed box was a silent no-op on the node side (semantic
F2) — and on the default view that is the majority of entities. §4.3 already fixes the edge side: an
aggregate carrying only relations of a marked hidden entity now dims.

### 4.5 The write rule — minimal mark for the requested effective state

This is the correction that removes the state a user cannot explain (semantic F7). For a requested
effective state `S` on node `n`:

- if `inherited(n) === S` → **delete** `n`'s own mark, if any;
- otherwise → **write** mark `S` on `n`.

So *Bring into focus* on a node carrying its own out-of-focus mark **deletes that mark** rather than
writing an in-focus one. Writing an explicit in-focus mark is reserved for its real meaning:
overriding an **ancestor's** mark.

The sequence v1 produced, and what v2 produces:

| # | action | v1 marks | v2 marks |
| --- | --- | --- | --- |
| 1 | dim `P` | `{P:out}` | `{P:out}` |
| 2 | light `c1` | `{P:out, c1:in}` | `{P:out, c1:in}` |
| 3 | light `P` | `{P:in, c1:in}` | `{c1:in}` |
| 4 | dim `repo` | `{repo:out, P:in, c1:in}` → **P's whole subtree stays bright** | `{repo:out, c1:in}` → P dim, `c1` bright |

At v1 step 4 the user asked to dim the repository and a subtree stayed lit, because of a mark created
at step 3 that meant "undo my own dimming", not "P is permanently exempt". §8.1 gave two different
intentions the same command. v2 keeps only genuine exceptions.

### 4.6 Marks are kept verbatim once written

§4.5 guarantees no mark is redundant *at the moment it is written*. A mark that becomes redundant
*later*, because an ancestor changed, is **kept**. That is the case verbatim storage exists for: "dim
parent → light child → light parent → dim parent" must not lose the child's exception, and §4.5's
table shows it does not.

Both red teams were asked to falsify verbatim storage and neither did. `vs-semantic-red-team`:
"canonicalising is not required and I am not asking for it." `vs-resilience-red-team`: verbatim is
defensible *if* §8.4's visibility actually reaches the user — which v1 did not deliver (§8.4 below).

## 5. Contract and persistence (core lane)

### 5.1 `ViewState`

```ts
export type FocusMark = 'out-of-focus' | 'in-focus';

export interface FocusState {
  /** Explicit marks only. Absent id = inherit. May carry INERT ids (§5.5). */
  readonly marks: ReadonlyMap<NodeId, FocusMark>;
  /** Integer percent, repaired into the Limits band on load (§5.4). */
  readonly transparency: number;
}

export interface ViewState {
  readonly expanded: ReadonlySet<NodeId>;
  readonly positions: ReadonlyMap<NodeId, Position>;
  readonly fitted: ReadonlySet<NodeId>;
  readonly focus: FocusState;      // REQUIRED
  readonly viewport: Viewport;
}

export const FOCUS_TRANSPARENCY_DEFAULT = 70;
export function withFocus(view: ViewState, focus: FocusState): ViewState;
export function emptyFocus(): FocusState;
```

**Where v1's compiler-enforcement argument stopped, and what replaces it.** v1 claimed a required
field makes omission impossible. Both red teams found the same hole from different directions:
`ViewState → VisualSpecsView` maps into an **all-optional** target
(`projectController.ts:1414 toVisualSpecsView`), so omitting `focus` there compiles cleanly, and
`viewKey` — the sole dirty/autosave trigger — never changes. So:

`viewKey` is derived from an **exhaustive** `Record<keyof ViewState, ...>` projection, making a future
view field a compile error at that site too. Construction, not memory.

### 5.2 Serialized shape, and merged key-by-key

```json
"view": {
  "focus": {
    "transparency": 70,
    "marks": { "dir:src/shared": "out-of-focus", "file:src/shared/ipc.ts": "in-focus" }
  }
}
```

An object map, because a key holds one value: **"marked both in and out" is unrepresentable**, not
merely rejected. Confirmed by `vs-semantic-red-team` (I-F3, no counterexample).

**v1's emission rule was a measured regression of losslessness** (semantic F3). Today `view.focus` is
an unknown key, so `mergeView` preserves it whole; v1's *"otherwise the key is deleted"* would have
exported a document carrying `view.focus = { transparency, marks, groups: [...] }` with the whole
subtree **gone, `groups` and all** — data the product does not lose today, lost by a user who did
nothing but open and export. So:

- `focus` merges **key-by-key**, spreading the original object and overwriting only `transparency` and
  `marks` — the posture `mergeView` already uses for `positions` and `viewport`, and for the same
  reason.
- Inside `marks`, an entry whose value this build **recognises** (`"out-of-focus"` / `"in-focus"`) is
  rewritten from the typed state; an entry whose value it does not recognise is **left verbatim**
  (§5.4, forward compatibility).
- The key is deleted only when it was **absent in `raw`** and the state is default. AC 10 is satisfied
  by that clause alone.
- Keys inserted in sorted order; `canonicalStringify` finishes the job. Same posture as `positions`.
- The same `delete`-on-empty defect is fixed for `fitted` in passing (§2.1.1).

### 5.3 Version locus

`formatVersion` → **1.2** when `view.focus` is emitted; `SUPPORTED_MINOR` `1 → 2`.
`raiseFormatVersionForFitted` generalises to `raiseFormatVersion`: compute the minimum minor the
content requires (`2` if focus is emitted, else `1` if `fitted` is non-empty, else none) and raise only
if the document declares less. Never lowers.

The old-reader path needs no new code and is **verified twice independently**: `vs-extraction-evidence-dev`
ran a 1.1-era reader against a hand-written 1.2 document (`unknown-minor` taken, `raw.view.focus`
survived verbatim), and `vs-semantic-red-team` traced `mergeView` + `validateView` to the same
conclusion. AC 12's first half is already satisfied by existing code.

### 5.4 Validation

- `focus` must be an object.
- `transparency` must be an integer. Out of the band is **clamped, with a warning** — not a hard
  problem. v1 said "a `problems.push`, consistent with how `viewport.zoom` is bounded", and both red
  teams showed the cited precedent does not apply: `viewport.zoom`'s bounds live in the **injectable**
  `Limits`, while v1 put focus bounds in `contract/view.ts` as module constants. Effect of v1: re-tune
  the range in any future release and every 1.2 document written by the previous build becomes
  **unopenable**, on a field that controls nothing but an alpha, with no minor bump available to signal
  it. Refusing to open a 787-node map over a cosmetic integer is disproportionate.
- The band moves into `Limits` as `minFocusTransparency` / `maxFocusTransparency`, alongside
  `minZoom` / `maxZoom`, so the boundary is injectable and the repair is testable.
- **Repaired, not preserved.** Clamping rewrites the value on export. Inert *marks* are preserved
  because they name real user work for another graph; an out-of-range cosmetic integer is not work.
  Stated as a deliberate asymmetry rather than discovered.
- A mark value that is neither recognised token is a problem **when the document declares a minor this
  build knows**, and a **warning** when `parsedVersion.minor > SUPPORTED_MINOR` — in which case the
  entry is ignored by the typed state and preserved verbatim on export (§5.2). Without this, a 1.3
  document with a third mark value would fail to open while `validate` simultaneously told the user
  "unknown fields are preserved verbatim on export" (semantic F11). The additive-minor contract must
  hold on the one axis this shape extends, or the object map's cost is higher than v1 admitted.
- `marks` is capped by a new `maxFocusMarks` in `Limits`, defaulting to `maxNodes`. v1 claimed marks
  "participate in the document-wide id-count and size limits"; **no such limit exists** (extraction C4,
  semantic F15). What actually bounds them is `maxJsonNodes` (5M), `maxBytes` and `maxDepth` via
  `scanJson`. A document with 200k nodes and 4M inert marks would validate, be preserved losslessly,
  then be sorted on every export and `JSON.stringify`-ed on every view change — which
  `vs-resilience-red-team` measured happens **once per pan frame** (#19). A resource cap is what
  `Limits` is for.
- `marks` is built with `Object.create(null)`, as `validateView` already does for `positions`.
  `scanJson` already rejects `__proto__` / `constructor` keys and non-finite numbers anywhere in the
  document — verified against raw JSON text by `vs-resilience-red-team`; this is defence in depth.

### 5.5 Load, refresh, loss

- **import**: every mark is kept, including one naming an absent id, so load → export is lossless.
  Absent ids are inert. A `stale-focus` warning records the count.
- **refresh**: marks naming ids the new model lacks are dropped and reported in `LossReport.droppedFocus`;
  `transparency` carries unchanged.
- **The report must be observable, not merely recorded** (extraction C1, resilience R8, semantic F6).
  Assigned explicitly to graph/runtime in §8.5, because in #13 this obligation fell between the lanes
  and nobody shipped it.
- I-F5 is scoped to `refresh()` in the app. There is a **third** path and it reports nothing: a CLI
  re-extraction publishing over the same `--out` replaces the entire `view` subtree — focus,
  positions, fitted, viewport alike — with no warning. Demonstrated with verbatim output by
  `vs-extraction-evidence-dev` on the committed corpus, and now executable as case 4 of
  `tests/extractor/focus.test.ts`. Predates this issue; owner is extraction; recorded, not fixed here.

### 5.6 Autosave — `focus` degrades, its siblings do not

v1 promised "a malformed `focus` is reported as a problem **and the rest of the autosaved view still
loads**". Both red teams measured that this is impossible as stated: `parseAutosaveView` accumulates
into `problems[]` and then `throw new SchemaError(problems)` (`autosaveView.ts:59`), whose only caller
replaces everything with *"autosave-view.json is corrupt and was ignored."* `problems.push` **is** total
rejection. On a realistic session that discards 400 positions, 60 expanded ids and the viewport over
one bad byte. v1's §5.4 and §5.6 were mutually exclusive; semantic F5 is explicit — *"do not ship both
sentences."*

Shipping one: **in the autosave path, an invalid `focus` degrades to `emptyFocus()` with a recoverable
problem naming the field, and the rest of the view loads.** `parseAutosaveView` gains a separation
between fatal and recoverable problems; `focus` is the only recoverable one.

Scoped to `focus` on principle, not convenience: a **cosmetic field must never be able to discard real
work**. `positions`, `expanded`, `fitted` and `viewport` carry work whose partial acceptance is a
genuine semantic question — a half-loaded layout may be worse than none. An invalid alpha has no
semantic content at all. Their all-or-nothing behaviour is pre-existing, unchanged here, and named in
§13.

**Autosave has no version locus** (resilience R11): `AUTOSAVE_VIEW_FORMAT_VERSION` is pinned to `'1.0'`
with an exact-match requirement, so an older build parses an autosave, drops `focus`, and erases it on
the next write. Bumping it would make that build reject the *whole* cache instead of one field — worse.
Recorded as an accepted limit; the autosave is a cache, the document is the record.

## 6. Domain commands (core lane)

| Command | Effect |
| --- | --- |
| `SetFocus { id, requested: FocusMark }` | apply §4.5's minimal-mark rule |
| `SetFocusInherited { id }` | delete `id`'s own mark |
| `SetAllFocus { mark }` | the global toggle |
| `SetFocusTransparency { percent }` | clamp into the `Limits` band, round, ignore non-finite |

`SetAllFocus`: delete every mark whose id **is** in the model, then, for out-of-focus, write the mark on
each `outline.roots()`. In-focus therefore leaves no marks — the bottom of the lattice. **Inert marks
survive**, exactly as inert positions and `fitted` ids survive `ResetLayout`.

On the committed corpus there is exactly **one** root, so `SetAllFocus` writes one mark and "dim one
root" and "dim the whole map" coincide. §8.3's label rule is unreadable without that fact.

**The toggle's label derives from this command's own fixpoint**: `Show everything` when every outline
root is marked out-of-focus, otherwise `Dim everything`. v1's "`Dim everything` when anything is still
in focus" made the label read idempotent on a destructive action: dim everything → bring one file back →
label reverts to `Dim everything` → the user presses it expecting a no-op and their override is deleted
(graph/runtime C3).

**v1's "one undoable state change" was false and is deleted.** `grep -rin "undo\|redo\|history" src/`
finds no undo anywhere in this application, and the autosave fires on the next `viewKey` change, so
destroyed marks are persisted before the user can decline to save (semantic F9). The semantics stay —
the issue approved clearing overrides — but the safety property was asserted and does not exist.
Mitigations, in §8.3: the destructive direction **confirms, naming the number of explicit marks it will
delete**, and a `Clear all focus (N)` action is always available while any mark exists, so the way back
is never behind a button labelled `Dim everything`.

`VIEW_COMMANDS` becomes `Record<ViewCommand['type'], true>`, with a test asserting every
`ViewCommand['type']` routes to `applyViewCommand`. Today it is an untyped `Set<string>` with no
exhaustiveness check and no test: add a command to the union, forget the set, and `apply()` falls to
`default: return state` — the command is silently swallowed and `tsc` is happy. Both red teams found
this independently (R9, F14), and §10 authorises core to touch exactly that line.

Each command returns the same `view` reference when it would be a no-op.

## 7. Scene and renderer (graph/runtime lane)

**Port.** `dimmed: boolean` → required `opacity: number` on `RenderNode` and `RenderEdge`. Two fields
that both mean "how faded" have an undefined interaction — `{dimmed: true, alpha: 0.9}` has no answer in
the contract, so each adapter invents one. A `dimLevel` enum was rejected because it forces the renderer
to hold the policy table, which is the renderer learning about search and focus as concepts.
Cross-cutting change to the port contract: **2-of-3 constructive support recorded** (graph/runtime
proposes, core supports, extraction has no basis on a port it does not touch); no dissent.

**Composition.** `opacity = min(searchOpacity, focusOpacity)` — dimmest reason wins. Monotone,
associative, order-free, exactly `1` when nothing applies, so a document with neither search nor focus
produces a byte-identical scene and the screenshot baselines cannot move.

v1 left this undefined and semantic F10 showed one reading destroys search: at `transparency = 10` focus
alpha is `0.90` while search is `0.22`, so a focus-wins implementation makes **enabling focus brighten a
node the search had dimmed**. Two implementations could satisfy every written word of v1 and render
opposite results. The conversion is also stated, because v1 never did: `focusOpacity = 1 - transparency/100`,
identical for nodes and edges. Search keeps its own differing values.

**Policy moves out of the adapter.** `SEARCH_NODE_OPACITY = 0.22` and `SEARCH_EDGE_OPACITY = 0.14`
become named constants in `app/scene.ts`, values unchanged.

**Perceptibility floor.** `maxFocusTransparency = 78` (alpha `0.22`), `FOCUS_TRANSPARENCY_DEFAULT = 70`
(alpha `0.30`), `minFocusTransparency = 10`. v1's `MAX = 95` / `DEFAULT = 80` were a guess: measured
against the real palette (`--bg: #0b0e16`), 95 puts every element at **1.02–1.09:1** — perceptually gone
while remaining fully hit-testable, a clickable ghost. 78 introduces no new constant; it is the node dim
this app already ships for search, already blessed by the screenshot baselines. At v1's default of 80 the
focus dim was **1/255 per channel** from search dimming — the two channels v1 explicitly decoupled,
re-coupled by its own default (resilience R5).

**I-F6 is restated on the composited pixel, not the pre-composite alpha.** v1 said "alpha is never 0",
which `MAX = 95` satisfies and defeats: the expanded-container header strip applies alpha twice
(`withAlpha(stroke, 0.16)` inside `globalAlpha`) and composites to `0.008` — the same 8-bit value as the
background. An invariant true of an intermediate and false of the output protects nothing.

**Floors graph/runtime owns.** The expanded-container chrome keeps its own floor so a dimmed container is
as perceptible as a dimmed leaf. **The selection ring keeps ≥ 3:1 against its box at every transparency**:
it is drawn inside the same `globalAlpha` today, so at v1's default a *selected* out-of-focus node sat at
1.81:1 and at max 1.11:1. I-F6 promised out-of-focus stays selectable; nothing promised the selection
stays *visible*, and it did not.

**Hit-testing is unchanged.** `hitNode` filters `hidden` only, never dimming, so an out-of-focus node
still receives clicks. That is correct — focus is not a filter, and I-F6 says out-of-focus stays
selectable. It is only tolerable because the floor above keeps those targets perceptible; at v1's `MAX`
a click on apparent empty canvas would have selected an invisible node (resilience R6).

**Untouched.** `hiddenByFilter`, `hidden`, edge routing and every count.

**Port invariant.** `assertSceneWellFormed` asserts `0 < opacity <= 1` on every node and edge, turning
I-F6 into a check at the port boundary. `renderer.conformance.ts` gains mid-range and floor cases.

**Resolution.** `buildScene` calls `resolveFocus` once per build and consumes §4.4's partial-subtree
flags. It does not reimplement focus resolution.

## 8. UI and interaction (graph/runtime lane)

### 8.1 The context menu lives in `shell`, not in the list

Two independent reasons, each alone fatal to an in-row menu: `renderList` is called on **every**
controller notification and opens with `clear(listHost)`, so `SetFocus` destroys the row the menu is
anchored to as a consequence of the menu's own action; and `.node-list` is
`max-height: 44vh; overflow-y: auto`, which **clips** an absolutely-positioned child exactly where the
last rows are.

One menu element created once in `mountUi`, appended to `shell`, rendered with the native popover API
(`popover="auto"`) for platform light-dismiss and top-layer rendering. It holds the **node id** from the
row's `data-node-id`, never the row element, so a row replaced mid-flight is irrelevant. One menu at a
time by construction.

Items: the focus action labelled for what it does given the row's effective state, and
`Reset to inherited` shown only when the row carries an explicit mark.

**Lifetime is decoupled from controller notifications.** v1 said the menu must not survive a list
re-render; `vs-resilience-red-team` measured why that requirement would have been satisfied far too
aggressively: `Canvas2DRenderer` emits `viewport:change` from its **pointermove** pan handler, so today
panning rebuilds up to 400 sidebar buttons per pointermove, and `startFollowLoop` polls at 1000 ms. A
notification-closed menu would die on an incidental one-pixel drag, on momentum scrolling, and once a
second on any followed document. Because the menu holds an id rather than an element, closing is
unnecessary: it closes on **user intent** (`Escape`, outside pointerdown, list scroll, resize, choosing
an item) and when its node id leaves the model. The underlying rebuild cost is #19.

**Escape ordering.** `ui/app.ts:989-1002` runs its overlay-Escape branch **before** `isInteractionEvent`,
so in the narrow and hybrid bands Escape with the menu open would close the whole sidebar and take the
anchor row with it. The menu must consume Escape first.

**Menu items must be `<button>`.** `isInteractionEvent` whitelists by tag and by role and includes
neither `menu` nor `menuitem`, so `<div role="menuitem">` items would leave the bare-key shortcuts live
under menu typeahead: `r` → `ResetLayout`, which wipes the hand-made layout with no undo — and
`Reset to inherited` starts with `r` (resilience R12). The transparency input is safe: it is an
`<input>`, so `isInteractionEvent` returns true.

**Keyboard.** `Shift+F10` and the context-menu key on a focused row open the same menu, first item
focused, arrows within. `renderList` restores focus to nothing today — click a row and focus falls to
`<body>` — so rows gain `data-node-id`, and the focused id is remembered before `clear(listHost)` and
restored after. Reaching an arbitrary row without tabbing through its predecessors is **#18**.

### 8.2 Both controls under the counts box, in the Explorer sidebar

Verified in code, not chosen by taste: below **1664 px** the Project rail and the Explorer are mutually
exclusive (`applyLayout` sets `sidebar.hidden`/`projectRail.hidden`; at hybrid
`sidebarOpen = sidebarPreference === 'open' && !projectOpen`; at narrow a single `activeOverlay` owns the
screen). A transparency control in the Project rail could not be adjusted while looking at the list it
dims. The "left rail" of the request is the leftmost panel holding the counts box and the node list the
user was right-clicking in, which satisfies both of the user's placement statements at once.

```
counts box  →  [ Dim everything / Show everything ]  →  Out-of-focus transparency [====|--] 70 %
            →  N marked · M not listed here  →  node list
```

A `range` with a live numeric readout, because this is a perceptual setting: you watch the map fade
while dragging rather than type a value and evaluate it. The readout is the typed and accessible entry,
bound to the same command; empty or out-of-range leaves the last valid value in force and says so
inline. Dispatches coalesce to one per animation frame. Budget: **p95 ≤ 16 ms input → painted frame at
expand-all on the committed corpus**, reported with numbers; fallback is committing on `change`.

`derive()` is measured at p50 3.82 ms / p95 5.26 ms at expand-all, of which `resolveFocus` is 0.049 ms.
A transparency keystroke re-runs full layout and projection for a value that affects only a paint
constant — architecturally wrong, within a frame budget, and recorded in §13 rather than restructured
here.

### 8.3 The global toggle, and an always-truthful way back

One toggle, labelled from §6's fixpoint. Its destructive direction **confirms, naming the number of
explicit marks it will delete**. Beside it, `Clear all focus (N)` is present whenever any mark exists.

This closes the state enumeration `vs-resilience-red-team` built. Two states a person is *actually* in
after using the feature had no control that said "clear focus": roots out + one override, and one node
dimmed out of 786 bright. In the second, the only control could **only make things darker**, and the way
back was behind a destructive click labelled `Dim everything`. The user asked for one toggle and gets
one; the escape hatch is a separate, always-honest action rather than a mode of that toggle.

### 8.4 Row state, and the counter that makes an unlisted mark reachable

`renderList` filters `file` and `directory` out on an empty query, so on the committed corpus the list
shows **10 rows of 787 entities (1.3%)**, and any short query overflows the 400-row cap (`"e"` → 685
matches, 285 unreachable). Both red teams and graph/runtime found this independently (R3, F8). It means
v1's §8.4 could not pay for §4.6's verbatim marks: for 777 of 787 entities the state is not merely
invisible, it is **unreachable** — type `ipc`, dim the file, clear the search, and the mark exists with
no row anywhere in the UI and no per-node route to remove it.

Three affordances, together:

1. **Row glyphs**, distinguished by shape rather than colour, consistent with the port's existing
   `cut-rect`/`hex` reasoning: `◐` explicitly out of focus, `○` an explicit in-focus override, nothing
   for inherited — so *glyph present ⟺ you said something about this row*. `title` names the state and,
   when inherited, the ancestor it came from. The row itself renders attenuated, matching the map.
2. **The counter is a disclosure, not a tooltip.** `N marked · M not listed here` expands to show the
   unlisted marked entities **as real rows**, built by the same row builder — same glyph, same context
   menu, same click-to-select — so each is individually actionable via `SetFocusInherited` instead of
   only nukeable. A `title` was rejected for three reasons: not keyboard-reachable, read-only (it makes
   an unreachable mark *visible* and leaves it unreachable, which is the easier half of the problem),
   and unbounded. Capped and worded like the existing "… and N more". Hidden entirely when
   `marks.size === 0`, so a document that never used the feature has a visually unchanged sidebar.
   An **inert** mark has no `GraphNode`, so its row degrades to the raw id with a distinct marker and
   keeps `Reset to inherited` — deleting an inert mark is the one meaningful thing you can do to one.
3. **The detail panel** says whether the selected entity is out of focus and *why* — own mark, or
   inherited from ⟨ancestor⟩. It works for entities with no sidebar row, and #13 already put the
   accessible keyboard route for `FitContainer` there.

### 8.5 The loss banner names all four

The refresh loss banner names dropped positions, expanded ids, **fitted ids** and **focus marks**.
`droppedFitted` surfacing is an accepted, recorded scope addition: we are opening that exact code path,
and shipping focus beside a structurally identical mute sibling would be arbitrary.

**No new warning-allowlist entry for `stale-focus`.** graph/runtime's split is the right one and v1 was
wrong to ask for a banner: the three existing `stale-*` warnings are mute on the **import** path, and
there muting is *correct* — every stale entry is kept, inert, and nothing the user sees changes, so a
banner alarms about a non-event. The import case is discharged better by §8.4's counter, which reports
an inert mark where the user can act on it and does not scroll away. **Refresh** is where the
requirement is real: it changes what the user sees, and under follow-file it happens unattended.

## 9. Invariants

- **I-F1 Presentational only.** Focus never participates in projection. Verified structurally by
  `vs-semantic-red-team`: `project(model, outline, expanded)` takes the expansion set, not the view, so
  focus is physically incapable of reaching NVA, the partition law or the buckets.
- **I-F2 Counts invariant.** All four counts read `model.nodes.length`, `model.edges.length`,
  `graph.visibleEdges.length` and a sum over `internalBuckets`; none can see `view.focus`. Verified
  structurally; also an executable check on the corpus.
- **I-F3 Unrepresentable contradiction.** No id can be both in and out of focus.
- **I-F4 Deterministic bytes.** Same focus state → same bytes; unused feature → no key.
- **I-F5 Lossless import, reported refresh.** Scoped to `refresh()` in the app (§5.5).
- **I-F6 Perceptibility floor.** The **composited** opacity of an out-of-focus entity never falls below
  the strength at which search already dims, and the selection ring and container chrome keep their own
  floors, so an out-of-focus entity stays perceptible as well as selectable, inspectable, searchable and
  counted.
- **I-F7 Layout untouched.** No focus action changes `positions`, `expanded`, `fitted` or the viewport.
- **I-F8 Override independence.** Marking a descendant in focus does not change any ancestor's mark, and
  marking an ancestor does not delete any descendant's mark.
- **I-F9 Focus is a human statement.** Focus lives only under `view.focus` — never in
  `nodes[].metadata`, `edges[].metadata`, `evidence[]` or `unresolved[]` — and no extractor ever emits
  `view.focus`. `metadata` is a free-form `Record<string, unknown>` the validator accepts without
  inspection *and regenerates on every run*, so a mark parked there would be indistinguishable from an
  observation about the code and destroyed at the next extraction. Already executable
  (`tests/extractor/focus.test.ts`).
- **I-F10 `view.*` is never an observation.** Stated in `contract/types.ts` and in ARCHITECTURE. A
  future machine suggestion about attention ("auto-dim tests", "auto-dim vendor") must travel under a
  different, derived, recomputed-every-run key that the UI can name, because `view.focus.marks` means
  *a person said so* and must keep meaning only that.

## 10. Allowed files

**Core lead** — `contract/view.ts`, `types.ts`, `validate.ts`, `limits.ts`, `load.ts`, `export.ts`,
`autosaveView.ts`, `domain/commands.ts`, new `domain/focus.ts`, `app/state.ts`,
**`app/controller.ts`**, **`app/projectController.ts`**, tests for those, this plan, ADR-0006, and the
`LossReport` section of `docs/ARCHITECTURE.md`.

The two bolded files were unassigned in v1. Three of the five sites that must thread `focus` live there
and two are compile errors, so **v1 could not be implemented without violating itself** — both red teams
said so independently. The dangerous one is not the compile errors: `exportText`'s obvious silencer is
`focus: emptyFocus()`, which type-checks and drops every mark from every export.

**Graph/runtime** — `app/scene.ts`, `ports/renderer.ts`, `renderer.conformance.ts`,
`adapters/canvas2d/*`, `ui/app.ts`, **`ui/detail.ts`**, `styles.css`,
**`tests/app/controller.test.ts:82-87`** (the five `dimmed` assertions follow the semantics, not the
directory), plus unit and Playwright tests for those.

**Extraction** — `tests/extractor/**`.

## 11. Verification

Core, by finding:

1. `focus` round-trips export → validate → import unchanged, including an inert mark and an
   unrecognised mark value from a higher minor (§5.2, §5.4).
2. A document carrying an unknown sub-key inside `view.focus` keeps it through a round trip — the F3
   regression, as a test.
3. A document declaring `"fitted": []` keeps the key through a no-op round trip — §2.1.1.
4. Unused feature exports byte-identical **at `exportDoc`**; AC 10 is scoped there, because
   `Controller.exportText` injects a position for every visible node and is never byte-identical
   independently of this feature (semantic F18).
5. Version locus: focus → 1.2; fitted only → 1.1; neither → untouched; a 1.3 document is not lowered.
6. `validate` clamps and warns on an out-of-range `transparency`; rejects an unrecognised mark value at a
   known minor; warns and preserves it above `SUPPORTED_MINOR`; rejects over `maxFocusMarks`. Bounds
   injected through `Limits`, so the boundary is exercised without recompiling.
7. Refresh drops stale marks, populates `droppedFocus`, and keeps `transparency`.
8. Autosave: round-trip preserves marks and transparency; an invalid `focus` degrades to default while
   positions, expanded, fitted and viewport still load, naming the field.
9. **The autosave key changes when and only when focus changes**, and is insensitive to mark insertion
   order — `JSON.stringify` is order-sensitive where `canonicalStringify` is not, so
   `SetFocus(x, …)` then delete then re-add must not manufacture a spurious dirty write (semantic F4/C6).
10. A mark survives autosave → restore and preview → return.
11. `resolveFocus`: parent out / child in / grandchild inherits child; siblings unaffected; deep
    alternating chain; unmarked graph resolves all-in; property test that every model node gets an
    effective state.
12. §4.3 on the F1 case: `marks = { P: out, c1: in }` leaves `P→Q ×2` bright while P is collapsed, and
    expanding P does not flip `e1`.
13. §4.4: a mark on an entity inside a collapsed container dims the aggregates carrying only its
    relations, and the representative reports a partial subtree.
14. §4.5's write rule reproduces the four-step table, and step 4 leaves no `P` mark.
15. I-F1 / I-F2 / I-F7 / I-F8 as executable checks over a random focus-command sequence; the model stays
    deep-frozen (existing I8 harness).
16. `SetAllFocus` preserves inert marks; every command returns the same reference on a no-op; every
    `ViewCommand['type']` routes to `applyViewCommand`.

Graph/runtime: opacity on exactly the right nodes and edges; `min` composition in both orders;
`0 < opacity <= 1` at every transparency; conformance mid-range and floor; container-chrome and
selection-ring floors; I-F1/I-F2 on the corpus; I-F7 geometry identical; menu open on right-click and
`Shift+F10`; menu survives a pan, a follow tick and a list rebuild; menu not clipped on the last row of
a scrolled list; Escape closes the menu and not the sidebar; focus returns to the correct row after a
rebuild; transparency rejects garbage without writing state; toggle both directions including
dim → override → toggle; confirmation names the count; `Clear all focus` present whenever marks exist; a
mark on a file still reported after the search is cleared; explicit vs inherited distinguishable; the
refresh banner names fitted ids and focus marks by name.

Extraction: the extractor emits `1.0` and no `focus` anywhere (landed, `000e190`); then extract → apply
focus → re-extract, asserting projection, every count and every observation are bit-identical with and
without focus state — I-F1/I-F2 verified by the corpus rather than by the code implementing the rule.

**AC ↔ verification map** (semantic F17): AC1–AC2 → graph/runtime menu and keyboard tests; AC3 → 11.13,
11.15, graph/runtime opacity tests; AC4 → 11.11, 11.13; AC5 → 11.11, 11.12, 11.14; AC6 → §8.4, all
three affordances; AC7 → 11.6, 11.8, graph/runtime input tests; AC8 → 11.16, graph/runtime toggle
tests; AC9 → 11.8, 11.9, 11.10; AC10 → 11.4 (scoped); AC11 → 11.7 plus the §8.5 banner test;
AC12 → 11.1, 11.5.

## 12. Resolved questions

v1 §12's four questions are closed. Q1 (verbatim marks): keep, and fix the **write** rule — §4.5/§4.6.
Q2 (port shape): `opacity: number`, 2-of-3 recorded — §7. Q3 (edge rule): the axis was wrong; logical
relations, not endpoints — §4.3. Q4 (extraction): extraction writes `view` unconditionally and reads it
never; nothing in provenance or evidence can see focus; one fixture pinned `formatVersion` and does not
break — §5.5, I-F9.

## 13. What this resigns

- **A flat, trivially-diffable dimmed set**, and simplicity in `view` — a fifth field every copier must
  thread, plus an exhaustive projection so the next one cannot be forgotten.
- **Forward compatibility on the mark **value** axis**, bought back by §5.4's warn-and-preserve rule.
  The object map makes contradiction unrepresentable and makes an extended value domain a version
  concern; two arrays would have traded those the other way.
- **An in-focus node's degree looks lower at a glance**: 83% of the edges dimmed by a subtree mark have a
  bright endpoint. Measured, accepted, not fixed with a second attenuation level.
- **A transparency keystroke re-runs layout and projection** (p50 3.82 ms at expand-all) for a value that
  affects only a paint constant. Within a frame budget; the restructuring belongs with #19.
- **`focus.transparency` is repaired on load, not preserved**, unlike inert marks.
- **The autosave has no version locus**, so an older build erases focus from the cache silently.
- **`positions`/`expanded`/`fitted`/`viewport` stay all-or-nothing in the autosave.** Pre-existing; only
  `focus` degrades gracefully.
- **A CLI re-extraction over the same `--out` replaces the whole `view` subtree with no warning.**
  Pre-existing, executable, owner extraction.
- **Out of scope:** right-click on canvas nodes and edges; any other menu item; coupling the transparency
  to search dimming; #18; #19.
- **Multi-placement:** `focus.marks` joins `expanded`, `fitted` and `positions` in the fields keyed by
  node id *because* `OutlineNodeId === NodeId` today. Relaxing I10 makes the nearest marked ancestor
  non-unique and this field re-keys with the others — appended to `MULTI_PLACEMENT_NOTE`.
- **Rollback:** additive and optional at every layer. Reverting leaves 1.2 documents readable by a 1.1
  build through the `unknown-minor` + raw-envelope path, focus preserved on export, every node in focus.
  No migration, no data loss.

**ADR-0006** records the tri-state-with-override model, the object-map serialization with its
forward-compatibility cost, §4.3's logical-relation edge rule together with the `matchesUnder` asymmetry
it deliberately does not mirror — search keeps a container's edges bright so a hit inside a collapsed box
stays discoverable; focus does the mechanically identical thing for the opposite semantic reason —
§4.5's write rule, and I-F9/I-F10 as the boundary condition for any future auto-dim feature.
