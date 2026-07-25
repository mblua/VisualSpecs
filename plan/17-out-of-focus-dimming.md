# RFC 17 — Out-of-focus dimming

Issue: https://github.com/mblua/VisualSpecs/issues/17
Branch: `feature/17-out-of-focus-dimming`
Delivery path: **full** (persistence + contract version + cross-cutting UI/renderer)
Author of this initial RFC: `vs-spec-core-lead` (core artifacts)
Status: **DRAFT — open for constructive validation and both premortems**

---

## 1. Scope and ownership

One feature, two artifacts, two owners.

| Artifact | Owner | Content |
| --- | --- | --- |
| Focus contract + domain | `vs-spec-core-lead` | `ViewState.focus`, serialized shape, `formatVersion` locus, validation, load/refresh/loss, autosave, export, focus resolution over the outline, view commands |
| Focus presentation + interaction | `vs-graph-runtime-dev` | `buildScene` mapping to `dimmed`, renderer alpha, sidebar context menu, transparency input, global toggle, sidebar row state, CSS, interaction tests |

Sections 5–6 are **decided** inside the core artifact (subject to a reproducible counterexample).
Sections 7–8 are a **proposal**; their owner may replace any mechanism there as long as the
invariants in §9 hold. Section 12 lists what the core lead is explicitly asking the other two
constructives to rule on.

## 2. Before state

- `RenderNode.dimmed` / `RenderEdge.dimmed` already exist in `ports/renderer.ts`.
- `Canvas2DRenderer` honours them with hard-coded alphas: `0.22` for nodes (line ~593), `0.14` for
  edges (line ~722).
- Exactly one producer writes those flags: `buildScene` in `app/scene.ts`, from the search query.
  There is no user-driven dimming and no way to choose the strength.
- The sidebar row (`node-row` in `ui/app.ts` `renderList`) binds `click` (expand-to + select + fit)
  and `dblclick` (toggle expand). No `contextmenu` handler exists anywhere in the app.
- `ViewState` holds `expanded`, `positions`, `fitted`, `viewport`. `fitted` (#13) is the precedent
  this RFC follows for a new additive view field, end to end: required field in `ViewState`,
  optional key in the doc, emitted only when non-empty, `formatVersion` raised at export, kept
  inert on import, dropped and reported on refresh.
- `validate.ts`: `SUPPORTED_MAJOR = 1`, `SUPPORTED_MINOR = 1`.
- `OwnershipOutline` is injective (I10) and `OutlineNodeId === NodeId`, which is why `expanded`,
  `fitted` and `positions` can all be keyed by node id today.

## 3. Requested change

A person can push individual entities out of focus from the sidebar list, choose how transparent
out-of-focus things are, and flip the whole map with one control. The state persists with the view.

## 4. The focus model

### 4.1 Tri-state, inherited, overridable

Focus is **not** a flat set of dimmed ids. Each node has one of three states:

| State | Stored as | Meaning |
| --- | --- | --- |
| explicit out | `marks[id] = "out"` | out of focus, and by inheritance so is everything under it |
| explicit in | `marks[id] = "in"` | in focus, **overriding** an `out` ancestor |
| unmarked | absent from `marks` | inherits the nearest marked ancestor; in focus if none |

The override is the point of the design. Dim `agentscommander (web)`, then bring one of its files
back into focus: the file lights up and **the container stays dim**. A flat set cannot express that
without either losing the container's own state or materialising a mark on every sibling.

### 4.2 Resolution

`resolveFocus(outline, marks) -> Map<OutlineNodeId, 'in' | 'out'>`

One pre-order walk from `outline.roots()`, carrying the inherited value down; a node's own mark, if
present, replaces the inherited value for itself and its subtree. O(n) over outline nodes, no
per-node ancestor walk. Effective state of an unreachable/unplaced entity is `in`.

Determinism note: because the outline is a tree (I10, `assertInjective`), the nearest marked
ancestor is unique and resolution is total and deterministic. Under a future multi-placement
outline it would not be — recorded in §13.

### 4.3 Edges

An edge is out of focus when **at least one endpoint is effectively out of focus**. This is the
literal reading of the request ("el nodo y sus líneas"): dimming a node dims every line that
touches it. The consequence, stated rather than discovered: an in-focus node keeps its box bright
while its connections to a dimmed neighbour fade, so its degree looks lower at a glance. The
alternative (`both endpoints out`) keeps a dimmed node visually wired to the whole map, which
defeats the purpose. Aggregated edges use their two visible endpoints; the aggregation itself is
untouched.

### 4.4 Marks are kept verbatim

An explicit mark is **never silently dropped because it agrees with what it would have inherited**.
Redundant marks are legal and preserved. Rationale: an override is a statement the user made, and
canonicalising it away means "dim parent → light child → light parent → dim parent" silently loses
the child's exception. The cost is invisible state, paid for by §8.4 (the sidebar row distinguishes
an explicit mark from an inherited one) and by the "reset to inherited" menu item. This is the
decision the semantic red team should attack first if it disagrees.

## 5. Contract and persistence (core lane — decided)

### 5.1 `ViewState`

```ts
export type FocusMark = 'out' | 'in';

export interface FocusState {
  /** Explicit marks only. Absent id = inherit. May carry INERT ids (§3.5). */
  readonly marks: ReadonlyMap<NodeId, FocusMark>;
  /** Integer percent in [FOCUS_TRANSPARENCY_MIN, FOCUS_TRANSPARENCY_MAX]. */
  readonly transparency: number;
}

export interface ViewState {
  readonly expanded: ReadonlySet<NodeId>;
  readonly positions: ReadonlyMap<NodeId, Position>;
  readonly fitted: ReadonlySet<NodeId>;
  readonly focus: FocusState;      // REQUIRED, for the same reason `fitted` is
  readonly viewport: Viewport;
}

export const FOCUS_TRANSPARENCY_DEFAULT = 80;
export const FOCUS_TRANSPARENCY_MIN = 10;
export const FOCUS_TRANSPARENCY_MAX = 95;

export function withFocus(view: ViewState, focus: FocusState): ViewState;
export function emptyFocus(): FocusState; // { marks: new Map(), transparency: DEFAULT }
```

`focus` is a **required** field precisely because `fitted` taught us the lesson: an optional field
lets `withViewport` — fired on every pan and zoom — silently drop it. All five `with*` copiers must
thread it, and the compiler enforces that.

### 5.2 Serialized shape

```json
"view": {
  "expanded": ["..."],
  "positions": { "...": { "x": 0, "y": 0 } },
  "focus": {
    "transparency": 80,
    "marks": { "agentscommander:app:web": "out", "agentscommander:file:src/main.ts": "in" }
  },
  "viewport": { "x": 0, "y": 0, "zoom": 1 }
}
```

Why an object map and not two arrays (`unfocused: []` + `refocused: []`): a key holds exactly one
value, so **"marked both in and out" is unrepresentable**, not merely rejected by a validator. The
codebase already prefers this posture — "gone by construction, not by discipline". Two arrays would
add an invariant to police, a repair path on load, and a way for a hand-edited document to be
self-contradictory.

Why `transparency` lives inside `focus` and not as a sibling view key: one new key, one version
locus, one validator, one deletion rule.

**Emission rule.** `view.focus` is written only when `marks.size > 0` **or**
`transparency !== FOCUS_TRANSPARENCY_DEFAULT`. Otherwise the key is deleted. A document that never
used the feature therefore exports to byte-identical output (AC 10). Keys inside `marks` are
inserted in sorted order, matching how `positions` is built, so the same state produces the same
bytes.

### 5.3 Version locus

`formatVersion` becomes **1.2** when `view.focus` is emitted. `SUPPORTED_MINOR` goes `1 → 2`.

`raiseFormatVersionForFitted` generalises to `raiseFormatVersion(out, view)`: compute the minimum
minor this document's content requires — `2` if `focus` is emitted, else `1` if `fitted` is
non-empty, else none — and raise only if the document currently declares less. It never lowers, and
a document that needs nothing keeps its original string untouched.

Old-reader behaviour is already correct and needs no new code: a 1.1 build reading a 1.2 document
takes the `unknown-minor` warning path, preserves `view.focus` verbatim through the raw envelope on
export, and draws every node in focus (AC 12).

### 5.4 Validation (`validate.ts`)

`view.focus`, when present, must be an object. `transparency`, when present, must be an integer
within `[MIN, MAX]` — out of range is a `problems.push`, consistent with how `viewport.zoom` is
bounded, not a silent clamp. `marks`, when present, must be an object whose every value is exactly
`"out"` or `"in"`; any other value is a problem naming the offending key. `marks` participates in
the document-wide id-count and size limits like any other keyed map.

### 5.5 Load, refresh, loss (`load.ts`)

Mirrors `fitted` exactly:

- **import**: every mark is kept, including one naming an id absent from the model, so
  load → export is lossless (§3.5). Absent ids are inert: they resolve nothing.
  A `stale-focus` warning reports how many.
- **refresh** (re-extraction): marks naming ids the new model does not have are **dropped and
  reported** in the loss report; `transparency` is carried unchanged. New `LossReport` field and
  `Warning` code `stale-focus`, added next to `stale-fitted`.

### 5.6 Autosave (`autosaveView.ts`)

`focus` is written when non-default per §5.2 and parsed with the same shape check as §5.4;
a malformed `focus` is reported as a problem and the rest of the autosaved view still loads.
This is what makes AC 9 (survives an in-app reload) true.

## 6. Domain commands (core lane — decided)

Three additions to `ViewCommand`, all pure `(ctx, view, cmd) => view`:

| Command | Effect |
| --- | --- |
| `{ type: 'SetFocus'; id; mark: FocusMark \| null }` | write one explicit mark; `null` deletes it (return to inherited) |
| `{ type: 'SetAllFocus'; mark: FocusMark }` | the global toggle |
| `{ type: 'SetFocusTransparency'; percent: number }` | clamp to `[MIN, MAX]`, round to integer, ignore non-finite |

`SetAllFocus` semantics: delete every mark whose id **is** in the model, then, for `mark === 'out'`,
write `"out"` on each `outline.roots()`. `mark === 'in'` therefore leaves no marks at all — the
natural bottom of the lattice. Both directions are one step and one undoable state change.

**Inert marks survive `SetAllFocus`**, exactly as inert positions and inert `fitted` ids survive
`ResetLayout`: they are not this graph's state and dropping them would lose data that import
promised to preserve.

Identity of returned state: each command returns `view` unchanged (same reference) when it would be
a no-op, matching `setExpanded`. This keeps the existing "no-op dispatch does not repaint" behaviour.

## 7. Scene and renderer (graph/runtime lane — proposal)

- `buildScene` resolves focus once per build (§4.2) and sets `dimmed` on a node when its effective
  state is `out`; on an edge when either endpoint's effective state is `out` (§4.3).
- `dimmed` is already OR-ed with search dimming semantically — a node dimmed by search *or* by focus
  is dimmed. Search keeps its own fixed alphas; focus contributes the configured one. That means the
  scene needs to say **why** something is dim, not just that it is. Proposal: keep `dimmed: boolean`
  for search and add `alpha?: number` (or `dimLevel: 'search' | 'focus'`) to `RenderNode`/`RenderEdge`
  so the renderer can apply the configured value without the port learning about focus as a concept.
  The port shape is this owner's call; the constraint is that the renderer must not import app state.
- `Canvas2DRenderer` uses the supplied alpha instead of a literal when one is present, keeping
  `0.22` / `0.14` as the search defaults.
- `renderer.conformance.ts` gains cases for the new field so the fake renderer stays conformant.
- `hiddenByFilter` and every count stay untouched: focus is not a filter and must not appear in
  those numbers.

## 8. UI and interaction (graph/runtime lane — proposal)

### 8.1 Context menu on a sidebar row

`contextmenu` on `.node-row`, `preventDefault`, open a positioned `role="menu"` with:

1. `Send out of focus` when the row's effective state is `in`; `Bring into focus` when it is `out`.
2. `Reset to inherited` — shown **only** when the row carries an explicit mark.

Dismiss on `Escape`, outside pointerdown, scroll, window blur, and on choosing an item. Focus
returns to the row. Keyboard path: the context-menu key and `Shift+F10` on a focused row open the
same menu, first item focused, arrow keys to move. One menu instance at a time; opening on another
row closes the first. It must not survive a re-render of the list (search typing, autosave refresh).

### 8.2 Transparency input in the left rail

A labelled numeric input — `Out-of-focus transparency`, suffix `%`, `min=10 max=95 step=5`. Applies
live on a valid value. An empty or out-of-range entry leaves the last valid value in force and says
so inline; it never writes an invalid state. Placement is in the left rail per the request; grouping
it with the global toggle (§8.3) is preferred so the two related controls sit together.

### 8.3 Global toggle below the counts box

A single button immediately below the `Nodes / Relations / Drawn / Folded away` grid. Label reflects
the action: `Dim everything` when anything is still in focus, `Show everything` when nothing is.
Dispatches `SetAllFocus`.

### 8.4 The sidebar row shows its own state

A row that is effectively out of focus renders visibly attenuated, and a row carrying an **explicit**
mark carries a distinct marker (the existing `⊂` hidden-glyph pattern is the precedent), with a
tooltip naming which state it is and whether it is inherited. Without this, §4.4's kept-verbatim
marks become invisible state and the feature becomes unfindable — which is the exact failure the
resilience red team should hunt for.

## 9. Invariants

- **I-F1 Presentational only.** Focus never participates in projection. NVA, the partition law,
  aggregated counts and internal buckets are bit-identical with and without any focus state.
- **I-F2 Counts invariant.** No focus action changes `Nodes`, `Relations`, `Drawn` or `Folded away`,
  nor `hiddenByFilter`.
- **I-F3 Unrepresentable contradiction.** No id can be both `in` and `out`.
- **I-F4 Deterministic bytes.** Same focus state → same export bytes; unused feature → no key.
- **I-F5 Lossless import, reported refresh.** Inert marks preserved on import; dropped and reported
  on refresh.
- **I-F6 Out of focus is not hidden.** An out-of-focus entity stays selectable, inspectable,
  searchable and counted; rendered alpha is never 0.
- **I-F7 Layout untouched.** No focus action changes `positions`, `expanded`, `fitted` or the
  viewport.
- **I-F8 Override independence.** Marking a descendant `in` does not change any ancestor's mark, and
  marking an ancestor `out` does not delete any descendant's mark.

## 10. Allowed files

**Core lead** — `VisualSpecs/src/contract/view.ts`, `types.ts`, `validate.ts`, `load.ts`,
`export.ts`, `autosaveView.ts`, `VisualSpecs/src/domain/commands.ts`, new
`VisualSpecs/src/domain/focus.ts`, `VisualSpecs/src/app/state.ts` (command plumbing only), plus
tests for those, plus this plan and the ADR.

**Graph/runtime** — `VisualSpecs/src/app/scene.ts`, `VisualSpecs/src/ports/renderer.ts`,
`renderer.conformance.ts`, `VisualSpecs/src/adapters/canvas2d/*`, `VisualSpecs/src/ui/app.ts`,
`VisualSpecs/src/styles.css`, plus unit and Playwright tests for those.

Neither owner edits the other's files. A change that needs the other side is a message, not an edit.

## 11. Verification

Core:

1. `focus` round-trips export → validate → import unchanged, including an inert mark.
2. Unused feature exports byte-identical to input; setting only `transparency` away from the default
   does emit the key and does bump the version.
3. Version locus: focus present → 1.2; fitted only → 1.1; neither → untouched; a doc already at 1.3
   is not lowered.
4. `validate` rejects a non-`"in"|"out"` mark value, a non-object `focus`, a non-integer and an
   out-of-range `transparency`, each with a message naming the location.
5. Refresh drops stale marks, reports them in the loss report, and keeps `transparency`.
6. Autosave round-trip preserves marks and transparency; a malformed autosaved `focus` degrades to
   default without losing the rest of the view.
7. `resolveFocus`: parent out / child in / grandchild inherits child; sibling unaffected; deep chain
   with alternating marks; unmarked graph resolves all-in; property test that no command sequence can
   produce a node with no effective state.
8. I-F1 and I-F2 as executable checks: the projection and every count are compared before/after a
   random focus command sequence.
9. I-F8 as an executable check over a random command sequence.
10. `SetAllFocus` preserves inert marks; no-op commands return the same `view` reference.
11. The model stays deep-frozen across a long random command sequence (existing I8 harness).

Graph/runtime: scene sets `dimmed`/alpha on exactly the right nodes and edges; renderer honours the
configured alpha and never 0; context-menu open/dismiss/keyboard/screen-reader paths; menu does not
survive a list re-render; transparency input rejects garbage; global toggle both directions; counts
and projection unchanged through the UI; sidebar row state visible for explicit vs inherited.

Both red teams: independent premortems on this plan (§5 semantics and §12 questions first), then
independent falsification of the executable increment.

## 12. Questions the core lead is putting to the other constructives

1. **§4.4 kept-verbatim marks.** Is preserving a redundant override the right call, or should the
   map be canonicalised (drop a mark equal to its inherited value)? Canonical is smaller and always
   visible; verbatim preserves a user's stated exception across an ancestor round trip. Core leans
   verbatim; a reproducible cognitive-usability counterexample flips it.
2. **§7 port shape.** `alpha?: number` on `RenderNode`/`RenderEdge` versus a `dimLevel` enum versus
   passing the transparency to the renderer at construction. Graph/runtime owns the call; core's only
   constraint is that the renderer port must not learn about focus, marks or app state.
3. **§4.3 edge rule.** `either endpoint out` versus `both endpoints out`. Core reads the request as
   `either`. Graph/runtime should say whether `either` produces an unreadable map on the
   AgentsCommander corpus at 744/1609.
4. **Extraction interface.** Does anything in extraction, provenance or evidence read `view`, and
   does a `stale-focus` loss entry need to appear anywhere in the re-extraction reporting the
   extraction owner owns?

## 13. What this resigns, and rollback

- **Resigns:** a flat, trivially-diffable dimmed set; the ability to canonicalise focus state; and
  simplicity in `view` — a fifth field every copier must thread.
- **Resigns for now:** right-click on canvas nodes and edges, any other menu item, and coupling the
  transparency to search dimming.
- **Multi-placement:** `focus.marks` joins `expanded`, `fitted` and `positions` in the set of view
  fields keyed by node id *because* `OutlineNodeId === NodeId` today. Relaxing I10 makes the nearest
  marked ancestor non-unique and this field re-keys with the others — appended to
  `MULTI_PLACEMENT_NOTE`'s consequence list.
- **Rollback:** the feature is additive and optional at every layer. Reverting the branch leaves
  1.2 documents readable by a 1.1 build through the `unknown-minor` + raw-envelope path already in
  place, with focus preserved on export and every node drawn in focus. No migration script, no data
  loss.
- **ADR:** the tri-state-with-override model and the object-map serialization are durable
  architectural decisions and get an ADR under the repository's existing convention, not just this
  plan.
