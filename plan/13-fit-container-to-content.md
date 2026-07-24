# Plan 13 — Per-container "fit to content"

- **Issue:** #13
- **Owner (core):** vs-spec-core-lead
- **Co-owner (graph/runtime):** vs-graph-runtime-dev
- **Delivery path:** Full
- **Status:** **READY_FOR_IMPLEMENTATION (Step 6, 2026-07-24).** B-full (Hug Total) + legibility floor. Round-2: 3-of-3 constructive SUPPORT; resilience NO-BLOCK (FIT-1 fixed, measured); semantic P1 **F2** (serializer under-enumeration) resolved by the complete `fitted` serialization thread below — semantic verifies the doc-path round-trip at the final gate (Step 9). F1 fold verified. All non-blocking findings folded; two v1 limitations documented (FIT-11 re-fit-to-retighten, NR-2 nested whitespace).
- **Target repo:** repo-VisualSpecs (`mblua/VisualSpecs`)

## Implementation status (Step 7-8, 2026-07-24)

**Core lane (vs-spec-core-lead): DONE + verified, uncommitted** (shared working tree; awaiting graph/runtime green before the combined commit). Plan + ADR committed at `e52884e`.
- Command + geometry: `domain/commands.ts` (`FitContainer` + guard + finite refusal; `ResetLayout` clears `fitted`), `domain/layoutEngine.ts` (`growForPinnedChildren` legibility floor for `fitted`; `computeGeometry` gains an optional `fitted` param defaulting to `NO_FITTED`), `domain/geometry.ts` (`HEADER_RESERVE = 114`), `app/state.ts` (`VIEW_COMMANDS` += `FitContainer`), `app/controller.ts` (derive passes `view.fitted`).
- Full `fitted` serialization thread (F2): `contract/types.ts` (`VisualSpecsView.fitted`, `stale-fitted`, `LossReport.droppedFitted`), `contract/view.ts` (`ViewState.fitted` **required** + `withFitted` + copiers), `contract/validate.ts` (parse + `SUPPORTED_MINOR = 1`), `contract/export.ts` (`mergeView` conditional emit + `raiseFormatVersionForFitted` locus), `contract/autosaveView.ts` (`viewToJson`/`parseView` optional key, NO version bump), `contract/load.ts` (import inert `stale-fitted` / refresh `droppedFitted`), `app/projectController.ts` (three view helpers).
- Verified: **100/100** domain/contract/projection tests pass incl. 9 new in `tests/domain/fit-container.test.ts` (FIT-1 floor-lowered-but-legible, no-clip, collapsed no-op, `fit∘fit==fit`, never-non-finite, export→import restores hug @1.1, no-fit doc stays 1.0, refresh `droppedFitted`). Core files typecheck-clean.

**Graph/runtime lane: in progress** (shared tree — `adapters/canvas2d/*`, `app/scene.ts`, `ports/renderer.ts`, `ui/*`, the `container:fit` case in `controller.ts`). Awaiting their green ping, then combined `verify:core` + one commit + Step 9 gates.

## Scope

Add a per-container action that shrinks an expanded container to hug its children with only the standard padding as margin, **preserving the children's positions and relative arrangement**. Confirmed product decision: preserve arrangement, do NOT re-pack.

### Non-goals

- No re-packing / re-flow of children (that is the existing global `Reset layout` / `R`).
- No change to the auto-layout engine (`GridPack`). (B-full **does** change `growForPinnedChildren`: for a fitted container it initializes `halfW/halfH` at the legibility floor instead of the grid-pack natural — see B-full design.)
- No new persisted schema field. No undo system (out of scope; the app has none today).
- No recursion into nested expanded sub-containers in v1 (see Open questions).

## Before state (root cause)

- Sizes are **derived, never stored** (`domain/geometry.ts`, `domain/layoutEngine.ts`).
- Dragging a node **pins** it: `domain/commands.ts` `moveNode` → `positions.set(entity, { x, y, pinned: true })`.
- An expanded container's box grows **symmetrically about its stored centre** to contain all pinned children (`growForPinnedChildren`), so passive growth never moves the user's stored centre.
- Children pinned below/above centre therefore produce an equal empty band on the opposite side — the wasted space seen on `Frontend` in the AgentsCommander corpus.
- Existing escape hatch is **global only**: `ResetLayout` (key `R`) throws away every manual position and re-packs the whole map.

## Requested change

A pure view command `FitContainer { id }` and a per-container control that dispatches it.

### Algorithm

Given the geometry the user is looking at (`ctx.geometry`: `position` = world centres, `size` = derived sizes) and the target container `id`:

0. **Guard (F1, P1 fix).** No-op — return `view` unchanged — unless `ctx.geometry.visibility.childrenShown.has(id)`. `childrenShown` provably implies ≥1 **visible** child (`visibility.ts:55-61,77-79`), so it excludes the documented "expanded but ancestor-collapsed / inert" state (`visibility.ts:62-67`) where the children are absent from `ctx.geometry.position`. This guard — **not** `view.expanded.has(id)` — is the source-level close of the empty-bbox → `NaN` defect. Every UI dispatch route (glyph, `H`, detail button) applies the same `childrenShown` predicate (no-op + status when false).
1. **Freeze** the arrangement. For each currently-visible direct child `c` of `id`, write `positions[entityOf(c)] = { x: drawnCentre.x, y: drawnCentre.y, pinned: true }`. Visually nothing moves; unpinned children just become explicit and pinned. (Handles mixed pinned/unpinned deterministically.)
2. **Compute the children bounding box** from frozen centres + sizes:
   `left = min(cx - w/2)`, `right = max(cx + w/2)`, `top = min(cy - h/2)`, `bottom = max(cy + h/2)`.
3. **Recentre** the container: `Cx = (left+right)/2`, `Cy = (top+bottom - CONTAINER_HEADER)/2`. **Defense in depth (F1):** if `Cx`/`Cy` are not both finite, no-op — the command must never construct an I11-invalid (non-finite) `Position`. Else `positions[entityOf(id)] = { x: Cx, y: Cy, pinned: true }`.
4. Return the new view. The existing two-pass pipeline (`computeGeometry`) derives the box.

**Integration precondition (N-D):** `ctx.geometry` must be the geometry of the current `(model, outline, view.expanded, view.positions)` at dispatch time; a stale/cached geometry (mid-drag) would freeze wrong centres. Asserted in the controller wiring + test.

No change to `growForPinnedChildren`; the recentred stored position makes the *existing* symmetric rule produce a tight box.

### Why the box hugs exactly (proof)

Let `top`/`bottom` be the children's outer edges and `H = CONTAINER_HEADER`, `P = CONTAINER_PADDING`. Set `Cy = (top + bottom - H) / 2`. `growForPinnedChildren` computes:

- `needTop  = Cy - top + P + H = (bottom - top)/2 + P + H/2`
- `needBottom = bottom - Cy + P = (bottom - top)/2 + P + H/2`

So `needTop == needBottom` → the box is `2·(needTop)` tall, centred on `Cy`: top edge `= top - P - H`, bottom edge `= bottom + P`. Zero empty band; `P` (22px) remains as the intended margin, `H` (30px) reserved for the header only. Horizontally `Cx = (left+right)/2` makes `needW` equal on both sides → width `= (right-left) + 2·P`. Tight.

## Identity & compatibility

- **Model untouched** (I8): `FitContainer` is a pure `(ctx, view, cmd) => view` command; it rewrites `view.positions` and `view.fitted`. Entity identity, provenance and evidence are unaffected.
- **Serialization (B-full — see the full `fitted` thread below, F2):** positions already persist with an optional `pinned` flag. **B-full adds a `fitted` set to the view**, which must be threaded through **every** doc touch point (type, import parse, export emit) — not just the autosave. Doc `formatVersion` minor-bumps `1.0 → 1.1`; the autosave version does NOT bump.
- **Aggregated connections / edges:** derived from boxes; they re-route automatically to the new box edges. Verified SAFE by the semantic gate — `project()` takes no size/position/`fitted`, so NVA, buckets, visible-edge ids and partition I9 are invariant under the fitted floor.

## Invariants (B-full)

| Invariant | Effect |
| --- | --- |
| Sizes derived, positions owned (§7) | Preserved — fit writes only `view.positions` + `view.fitted`; size stays derived (the `fitted` floor is a derivation input, not a stored size). |
| Symmetric growth about stored centre | **Modified for `n ∈ fitted`:** `growForPinnedChildren` initializes at the legibility floor instead of the grid-pack natural. Non-fitted containers unchanged. This is the approved B-full change (durable → ADR-0005). |
| Legibility floor (NEW, B-full) | A fitted container's width ≥ `headerFloor` (name + caret + fit glyph) and height ≥ `HEADER+2P` — the box never hides its own header/controls. |
| Model immutability under view commands (I8) | Must hold — pure view command; model untouched (semantic-verified). |
| Determinism of geometry | Must hold — pure function of `(model, outline, expanded, positions, fitted)`; `measureText` is a fixed proportional model. |
| Round-trip / lossless view (§3.3/§3.5) | `fitted` threaded through all doc touch points (F2); import lossless (inert `stale-fitted`), refresh reports `droppedFitted`. |

## Allowed files / systems

- **Core (vs-spec-core-lead):**
  - `domain/commands.ts` — `FitContainer` in the `ViewCommand` union + handler (guard `childrenShown`, freeze children, add to `fitted`, recenter, finite refusal).
  - `domain/layoutEngine.ts` — `growForPinnedChildren` legibility-floor init for `n ∈ fitted`; `domain/geometry.ts` — the `headerFloor`/reserve constant (fit-glyph reserve, coordinated with graph/runtime).
  - `app/state.ts` — add `'FitContainer'` to `VIEW_COMMANDS` (FIT-5).
  - `contract/view.ts` — `fitted` on `ViewState` (required) + `emptyView`/`with*`; `contract/types.ts` — `VisualSpecsView.fitted` + `LossReport.droppedFitted`; `contract/validate.ts` — `validateView` parse + `SUPPORTED_MINOR`; `contract/export.ts` — `mergeView` emit + `exportDoc` version locus; `contract/autosaveView.ts` — `viewToJson`/`parseView` optional key; `contract/load.ts` — import inert (`stale-fitted`) / refresh drop (`droppedFitted`).
  - Core unit tests under `tests/domain/` + `tests/contract/` (see Verification).
  - ADR `VisualSpecs/docs/ADR-0005-fit-container.md` (durable decision record) at readiness.
- **Graph/runtime (vs-graph-runtime-dev):** the on-canvas per-container control (header, next to the ▾ caret), renderer hit-testing, the renderer event, and the controller wiring that calls `controller.dispatch({ type: 'FitContainer', id })`. Owner decides exact files (`adapters/canvas2d/Canvas2DRenderer.ts`, `ports/renderer.ts`, `app/controller.ts`, `ui/app.ts`) and whether a keyboard shortcut is added.

## Verification (B-full)

- **Core:**
  - **FIT-1 acceptance:** a `bbox < grid-natural` arrangement (vertical stack) fits to the **legibility floor**, not the grid-pack floor (assert width ≈ `max(childBboxW+2P, headerFloor)`), so the floor cannot silently mask a non-tight box.
  - **No-clip (FIT-6/#1):** a child pinned outside the legibility floor stays fully contained — the floor replaces only the initial `halfW/halfH`, never containment.
  - **F2 doc-path round-trip:** `fit → exportDoc → importDoc → fitted restored` (tight box, not grid-natural); `fit → pan (SetViewport) → fitted preserved`; autosave `fit → viewToJson → parseView → fitted` round-trip.
  - **Reconciliation:** `import` of a doc whose `fitted` names an absent node → `stale-fitted` warning, kept inert, zero geometry; `refresh` deleting a fitted container → `droppedFitted` reported.
  - **Guard (F1):** fit on an expanded-but-ancestor-collapsed container is a no-op (`childrenShown`); fit never writes a non-finite position.
  - **Command registration (FIT-5):** dispatching `FitContainer` changes state (guards the `VIEW_COMMANDS` set entry).
  - **Idempotency:** `fit∘fit == fit` incl. long-label / single-child; model-untouched (I8).
- **Graph/runtime:** glyph renders only on expanded containers + reflects `fitted` state; `hitHeaderControl` reuses cached scene geometry (no per-`pointermove` recompute); FIT-2 (drag-suppress in `onPointerDown`) + FIT-3 (control wins in `resolveTarget`, four conformance cases); mandatory detail-panel button (FIT-8); `H` guarded during pointer gesture (FIT-7); honest status wording (FIT-9); before/after visible-state evidence.
- **Semantic red team (final gate):** doc-path round-trip, pan-preserves-fitted, stale-fitted-inert, `fit∘fit`; identity/aliasing; before/after contract excludes `view.fitted` + `view.positions`.
- **Resilience red team (final gate):** re-run the FIT-1 measurement under the built increment (legibility-floor hug); no-clip; degenerate/large arrangements; rollback degradation; performance.

## Rollback / migration (B-full — supersedes the old "none required")

- **Doc:** minor bump `1.0 → 1.1` is the announce + migration; old docs (no `fitted`) load as `fitted = ∅` = current behavior (default, no rewrite). An old reader opening a 1.1 doc: `unknown-minor` warning, stays read-WRITE, and the `raw` envelope preserves `fitted` on re-export.
- **Autosave:** NOT versioned-bumped; `fitted` is an optional key. Old parser ignores it → graceful degradation (recenter-only look, positions intact). Known accepted cost: an old app re-saving the autosave drops `fitted` (disposable, regenerated).
- **Feature revert:** reverting the code leaves existing docs valid — `fitted` becomes an ignored key; children stay pinned (the freeze), only the tight-size intent is lost. Recoverable by re-fitting once the feature returns.
- **User escape hatch:** global `Reset layout` (`R`) clears `fitted` + positions. No undo exists today; a fit is reversible only via `R` (whole map) or manual re-drag — called out in the honest status message (FIT-9).

## Constructive validation (Step 4) — 3-of-3 SUPPORT

- **Core (vs-spec-core-lead):** owner. SUPPORT.
- **Extraction (vs-extraction-evidence-dev):** SUPPORT. `Position={x,y,pinned?}` carries no provenance; re-extraction reconciles by node-id and ignores `pinned` (`load.ts:131-134`); before/after re-extraction is byte-identical. `pinned` already persisted (`autosaveView.ts:104`) — no version bump.
- **Graph/runtime (vs-graph-runtime-dev):** SUPPORT. Recenter is a pure position write the renderer just draws; verified safe against drag, hit-testing and edge routing. Owns a new `RendererEvent` `{ type:'container:fit'; id }`, the on-canvas control + `hitHeaderControl`, `controller` wiring, and the accessible non-canvas route.

## Resolved decisions

1. **Subtree recursion:** v1 fits **direct visible children only**. Recursive "fit all descendants" is a later extension (candidate `Shift+H`). Both constructives support.
2. **Control affordance (OQ#2):** an **icon/glyph** on the right of the header (not a text button), world-space, with a min screen-pixel hit tolerance. Plus a **keyboard shortcut `H`** ("hug to contents") acting on the current selection (no-op + status message when the selection is not an expanded container), and an optional detail-panel button — required by **§9.4** (the canvas `role="img"` must not be the only input). Graph/runtime owns final glyph choice and a11y, validated in-browser.
3. **Idempotency (OQ#3):** confirmed a fixpoint by both core and graph/runtime from the pipeline (after a fit the children are pinned at their frozen centres and the container's stored centre already equals the derived bbox centre). Core owns the `fit∘fit == fit` test.
4. **Header width (core geometry owner's call):** chosen **(ii)** — the renderer truncates the header label to reserve glyph width (`truncateLabel(label, labelWidthFor(size,true) - glyphWidth)`), leaving derived geometry **untouched**. Rejected (i) (widening every container's minimum) for wider blast radius against the derived-size surface.
5. **First interactive header sub-region:** the `▾` caret is a **visual** precedent only, not an interaction one (expand/collapse is `node:dblclick` on the whole node; `hitNode` tests whole boxes). This feature adds the **first** header hit sub-region. Handled with **resolve-first** discipline (the control hit resolves before node resolution, mirroring `resolveTarget` edge-vs-backdrop order) so two quick taps on the glyph can never be read as a `node:dblclick` collapse. New conformance cases required: "two clicks on the fit control never collapse the container" and "the rest of the header still collapses on double-click".

## Recorded non-blocking findings

- **N1 (extraction):** freezing turns auto-laid-out children into explicit `pinned:true`, so a fitted container yields **more** `LossReport.droppedPositions` if a later re-extraction changes a child id (e.g. file rename). Not a defect — loss is reported loudly (`stale-position` warning, `LossReport`, surfaced at `ui/app.ts:1200`). Consistent with "absence is reported, not silently resolved."
- **N2 (graph/runtime → core test design):** `growForPinnedChildren` floors `halfH/halfW` at the grid-pack `natural` size (which ignores pins). The core tight-box test **must** use an arrangement whose frozen bbox **exceeds** the grid-pack natural, so the floor does not silently mask whether the recenter actually produced the tight box. Folded into core verification.
- **N3 (core → graph/runtime UX wording):** the post-fit status message must **not** call `Reset layout (R)` an "undo" — `R` re-packs the whole map, it is not a per-container undo. Prefer wording like "Fitted &lt;label&gt; to its contents." without implying a targeted undo.
- **N4 (graph/runtime):** at very small zoom no world-space header affordance is usable (inherent); the `H` shortcut / detail button is the mitigation.

## Premortem findings (Step 5)

### Semantic red team — NEEDS WORK: 1 blocking (P1) + 4 non-blocking

- **F1 [P1, BLOCKING] — FOLDED INTO PLAN (Algorithm step 0 + step 3 finite guard).** Fit on an expanded-but-ancestor-collapsed (inert) container computes a bbox over the empty set → `NaN` centre → cascades `NaN` up every ancestor's geometry, serializes as `null`, and on reload `parsePositions` rejects it → the **entire** autosave view (positions + expansion + viewport) is silently dropped (`CORRUPT_AUTOSAVE_WARNING`, `projectController.ts:869-884`). Reachable via the a11y-required `H`/detail route. Fix (accepted): guard on `visibility.childrenShown.has(id)` at the command **and** every UI route, plus a finite-output refusal. Conformance: "fit on expanded-but-hidden container is a no-op", "fit never writes a non-finite position for any reachable state", `fit → autosave → reload` round-trip.
- **Conceded safe (with evidence):** identity/lifecycle (I8 + I10 `assertInjective`), aggregated connections/projections (`project()` is position-independent; `expanded` untouched → NVA/partition I9 invariant), idempotency for all finite arrangements, serialization for finite fits.
- **N-A [non-blocking, forward]:** fit inherits `moveNode`'s freeze-by-`entityOf`; if I10 is ever relaxed to multi-placement, `positions` must first be re-keyed to `OutlineNodeId` or the same entity placed twice gets last-wins aliasing. Record fit as a second consumer that migrates together (`outline.ts:38-51`). Confirms N1 stays non-blocking (reconciliation is id-existence only, `project()` position-independent).
- **N-B [non-blocking, forward → core contract invariant]:** a pure fit **does** change `DocRevision` (`revision.ts:7-9`) and exported bytes (`export.ts:40-52`) because both hash/serialize `view.positions`; it does **not** change the model or `project()`. **Invariant to pin:** any future before/after coding-agent contract and semantic diff must diff the **model/projection** layer, never `exportDoc` text or `DocRevision`, or a cosmetic fit pollutes it with a spurious view-only delta.
- **N-C [non-blocking → resilience lane]:** frozen pins are centres from the pre-fit box; after a `refresh` that resizes a surviving child or adds a sibling, the pins are stale and the tight-box guarantee is void post-refresh. Layout quality, not semantic loss.
- **N-D [non-blocking → integration]:** fit assumes fresh `ctx.geometry`; folded into the Algorithm as an integration precondition + controller assertion/test.

### Resilience red team — BLOCKS on 1×P1 (FIT-1) + P2/P3 non-veto + negative results

- **FIT-1 [P1, BLOCKING, MEASURED] — see the OPEN floor decision below.** Measured with real `computeGeometry`/`GridPack`: 9 leaves stacked vertically (extent 96w×518h) → fitted box **400×592**, ideal hug **140×592** → **260px horizontal empty band** (2.85× too wide). Height fits exactly; width pinned at the grid-pack floor. The "zero empty band / tight" claim is stated **unconditionally** and is false for arrangements more compact than `ceil(√n)` columns (any vertical list/cluster; even 2 stacked children). My N2 test strategy was **testing-to-green** — it must instead include a `bbox < natural` case asserting the floor behavior. Unblocks via **(a)** honest promise+message+test (recommended by resilience) or **(b)** B-full tight hug (new round).
- **FIT-2 [P2 → graph/runtime]:** starting a drag on the glyph moves the container. Drag-vs-click is decided in `onPointerMove` from `p.nodeId` set in `onPointerDown`; resolve-first in `onPointerUp` is too late. `onPointerDown` must detect the control and set a flag suppressing the drag branch.
- **FIT-3 [P2 → graph/runtime]:** two quick taps on the glyph collapse the container unless **three** coordinated changes: (1) `resolveTarget` hit-tests the control first and returns a new `kind:'control'`; (2) a control tap emits `container:fit`; (3) `onPointerDown` suppresses drag for the control. Conformance: (i) two taps on control never collapse; (ii) rest of header still collapses on dblclick; (iii) press+drag on control never moves; (iv) single tap fits, second tap = idempotent no-op, never collapse.
- **FIT-4 [P2 cognitive]:** `H` is a bare unmodified key doing a bulk irreversible mutation (pins ALL direct children) with no undo (only global `R` or manual re-drag). Does not demand undo to unblock — demands an honest status message (FIT-9).
- **FIT-5 [P3 → core]:** `VIEW_COMMANDS` (`state.ts:53-63`) is a hardcoded `Set`; the `never` exhaustive catches a missing switch `case` but **not** a missing Set entry. Forgetting `'FitContainer'` in the Set → `apply` falls to default → silent no-op. Requires a "dispatch FitContainer changes state" test.
- **FIT-6 [P3 → core]:** the degenerate guard is load-bearing (must early-return before bbox). Corroborates semantic F1: with the `childrenShown` guard the NaN path is closed; within the normal pipeline fit is numerically safe (coords capped ±1e6; bbox = bounded average; autosave rejects non-finite on reload → recoverable, not a permanent brick). Guard must be tested.
- **FIT-7 [P3, pre-existing]:** `H` (like `R`) fires during an in-progress canvas pointer gesture (`isInteractionEvent` only blocks typing targets), leaving a stale drag. Guard view-mutating shortcuts while a pointer gesture is active.
- **FIT-8 [P3 → a11y]:** the canvas glyph is undiscoverable (canvas is `role="img"`, no sub-region tooltip/aria) and unusable at small zoom. The non-canvas detail-panel button is therefore **MANDATORY** per §9.4, not optional.
- **FIT-9 [P3]:** status wording — not "undo" for `R`; not "fitted to its contents" when the box stayed at the natural floor. Prefer e.g. "Fitted &lt;label&gt; (minimum: automatic layout)."

**Negative results (measured; close attack surface):**
- **Siblings do NOT move when fitting a nested container** (`s1.y 217→217`, 0px, even as `cont.h` fell 1042→192): sibling layout uses the container's *natural* pack size, recomputed fresh each pass independent of pins; the grown size only affects the drawn box. De-risks nesting.
- The container does not visually "jump": the box shrinks in place around stationary children; the moving stored centre is invisible derived metadata.
- Idempotency holds by construction. Brick by NaN/Infinity/overflow is not reachable by normal fit (only via a missing FIT-6 guard).
- **Performance:** fit = one full `computeGeometry` recompute = same cost as a drag/expand (~0.2-0.3s for the corpus). Requirement: `hitHeaderControl` must reuse cached geometry and scan only expanded containers — never recompute geometry per `pointermove`.

## OPEN — natural-size floor leaves residual slack (recenter is partial)

`growForPinnedChildren` floors `halfW/halfH` at the grid-pack `natural` size (which ignores pins) and only grows. Recentring removes the **asymmetric** empty band (the dominant waste, e.g. `Frontend`'s empty top) but cannot shrink a dimension **below** the grid-pack footprint. Concretely, a vertical stack of 3 leaves: grid-pack targets 2 columns → `natural.w ≈ 2·leaf`, while the stack's true width is `1·leaf` → the fitted box stays ≈2× wider than needed. So recenter-only = "kills the big band, may leave ~1-axis residual slack for arrangements more compact than the grid-pack."

**Measured severity (resilience FIT-1):** vertical stack of 9 → 260px residual (2.85× too wide); the user's screenshot case (vertical stack of 3) → ~144px residual (~2× too wide). Height always hugs; only the more-compact-than-grid axis keeps slack.

**DECISION (user, 2026-07-24): B-full (Hug Total) with a legibility floor.** The residual slack is unacceptable for the stated goal ("casi mínimo, apenas margen"); tighten both axes, but **never below showing the container's name + its header buttons.**

### B-full design

**New state.** Add `readonly fitted: ReadonlySet<NodeId>` to `ViewState` (parallel to `expanded`). Additive and versionable: serialized as a sorted id array; absent in old documents → empty set → exactly current behavior (migration is a default, no data rewrite). `FitContainer { id }` now: freeze children (pin at drawn centres) → **add `id` to `fitted`** → recenter+pin the container at the children's bbox centre. Still a pure view command (model untouched).

**Size derivation (the invariant change).** For a container `n ∈ fitted` with `childrenShown`, its size is the tight child bounding box + margins instead of the grid-pack natural floor. Cleanest locus: `growForPinnedChildren` already has the placed child positions — for a fitted container, initialize `halfW/halfH` at the **legibility floor** (below) instead of `natural/2`, then grow to the pinned children. `computeSizes` still computes a natural size (position-independent); the fitted override only lowers the floor in the grow pass.

**Legibility floor (the user's constraint — hard).** A fitted container's derived size is:
- `width  = max(childBboxWidth  + 2·PAD, headerFloor)`
- `height = max(childBboxHeight + 2·PAD + HEADER, HEADER + 2·PAD)`

where `headerFloor` guarantees the expanded header shows **`▾ label` + the fit glyph** (plus paddings). Per graph/runtime: an **expanded** header draws only `▾ label` — **no** kind chip or count badge (those are collapsed-container affordances) — so the reserve is `left-pad + '▾ ' + label + gap + fitGlyph + right-pad`, **not** the wider chip reserve. Concretely `headerWidth = measureText(label) + reserve`, `reserve ≈ +90 → +~114` (fit glyph ~+20-24px; graph/runtime fixes the exact px against the real glyph metric). The container can never shrink below its own header. **This supersedes Resolved-decision #4:** the label is **no longer truncated** (that would hide the name the user requires; and `scene.ts:52`'s truncate is already a no-op for expanded headers because `headerWidth` floors the width); width is floored instead.

### Round-2 constructive re-validation — 3-of-3 SUPPORT on B-full

Core owner + graph/runtime + extraction all SUPPORT B-full. Resolutions:

- **OQ1 — Parent packing (RESOLVED, v1):** `computeSizes` stays position-independent (reports the natural size); the fitted override lives **only** in `growForPinnedChildren` (the container's own box). A fitted, pinned child leaves the usual pinned-child "pack hole" in its parent — identical to any dragged child today, and graph/runtime confirms it is visually acceptable ("siblings do NOT move", measured). Not reopening for v1.
- **OQ2 — `fitted` lifecycle (RESOLVED):** dragging a child of a fitted container re-hugs automatically (the pipeline re-derives from the new pinned positions). `ResetLayout` (R) **clears `fitted`** (it is the escape hatch). graph/runtime adds a `fitted` boolean to the `RenderNode` so the glyph can show fitted state (filled vs outline) — accepted, mitigates FIT-9 discoverability.
- **OQ4 — Idempotency (holds):** children re-pinned at identical drawn centres; `Cx/Cy` recomputed from the same bbox; the legibility floor is deterministic → `fit∘fit == fit`. Core owns the test.

### Serialization & migration (B-full) — extraction-validated, evidence-backed

Two serializers, **opposite version policies** — respect both:

- **Exported doc (`VisualSpecsDoc.formatVersion`): bump MINOR `1.0 → 1.1` + raise `SUPPORTED_MINOR`.** An unknown minor emits an `unknown-minor` warning and stays read-WRITE (`validate.ts:83-95`; additive-optional); the `raw` envelope + `export.ts` `mergeView` clone-and-overwrite means a `fitted`-bearing doc round-trips intact through an old reader. The minor bump IS the "announce"; migration is the default (absent → ∅), zero rewrite.
- **Autosave sidecar (`AUTOSAVE_VIEW_FORMAT_VERSION`): do NOT bump — bumping is destructive.** Its parser requires strict equality (`autosaveView.ts:45-47`); a bump makes an old app / rollback reject the **whole** autosave (all positions + expansion + viewport + fitted) → total layout loss. Instead add `fitted` as an **optional key** in `viewToJson`/`parseView`; old parser ignores it → graceful degradation (recenter-only look); new parser + old doc → ∅ → current behavior. Known, accepted cost: `viewToJson`'s whitelist rebuild does not preserve unknown keys, so an *old* app re-saving the autosave drops `fitted` (disposable, regenerated, positions survive).
- **Reconciliation — `fitted` mirrors `expanded`, distinguishing import vs refresh:** on **import**, a `fitted` id naming an absent node is kept **inert + `stale-fitted` warning** (do NOT drop — §3.5 import is lossless); on **refresh**, it is **dropped + reported** in `LossReport.droppedFitted` (new field, parallel to `droppedExpanded`/`droppedPositions`). Safety: a stale/inert `fitted` id has zero geometric effect (the size override requires `childrenShown`), so it cannot trigger the F1 NaN path.
- **N-B extended:** `fitted` also enters `exportDoc` → `DocRevision`. Any before/after coding-agent contract and semantic diff must exclude **`view.fitted` and `view.positions`**, diffing only the model/projection layer.

### `fitted` serialization thread — ALL touch points (F2 fix, P1)

Round-2 semantic (F2) + resilience (FIT-10) proved the earlier "raw envelope + `mergeView` handles it" framing false: on a **fresh** doc there is no `raw.view.fitted` to preserve, so a session fit is dropped on export/import/refresh — silently reverting the hug. `fitted` must be threaded **everywhere `expanded` is**, parallel and complete:

1. **`VisualSpecsView` type** (`contract/types.ts:88-92`) — add `fitted`.
2. **`ViewState`** (`contract/view.ts`) — add `readonly fitted: ReadonlySet<NodeId>`, **REQUIRED, not optional** (F2b): TS then forces every copier; an optional field lets `withViewport` (fires on **every pan/zoom**) silently drop the hug with no compiler error.
3. **`emptyView` + all four `with*` helpers** (`view.ts:22-40`) — thread `fitted` (compiler-enforced by #2).
4. **`validateView` (import)** (`validate.ts:502-588`) — parse `view.fitted` into the typed `doc.view` (today it reads only positions/expanded/viewport, so a 1.1 doc's `fitted` is dropped before `load.ts` can lift it).
5. **`mergeView` (export)** (`export.ts:58-91`) — emit `rawView['fitted']` from the live set (today writes only positions/expanded/viewport).
6. **`exportDoc` version locus (F2a)** (`export.ts:43-51`) — `exportDoc` never writes `formatVersion` today, so the bump has no locus on the user-export path. Set `formatVersion = max(raw, '1.1')` when `view.fitted` is non-empty (so an old reader gets the `unknown-minor` announce); define the downgrade rule when `fitted` empties.
7. **Autosave `viewToJson`/`parseView`** (`autosaveView.ts:97-136`) — add `fitted` as an **optional** key; **do NOT** bump `AUTOSAVE_VIEW_FORMAT_VERSION` (strict-equality parser, `:45-47`; a bump discards the whole autosave on rollback).
8. **`load.ts` import/refresh reconciliation** — import keeps stale `fitted` ids **inert + `stale-fitted` warning** (mirror `expanded`, NOT filter — filtering on import violates §3.5); refresh **drops + reports** them in `LossReport.droppedFitted`.
9. **`LossReport.droppedFitted`** (`contract/types.ts:174-179`, NR-1) — new field parallel to `droppedExpanded`, plus its UI surface, or refresh drops `fitted` silently.
10. **`SUPPORTED_MINOR`** — raise in the new build so 1.1 is first-class.

**Required conformance (semantic will verify at the gate):** doc-path `fit → exportDoc → importDoc → fitted restored` (not only the autosave round-trip); `fit → pan → fitted preserved`; `stale-fitted` inert on import; `droppedFitted` reported on refresh.

### Round-2 premortem results (B-full delta)

**Resilience — NO BLOCK. FIT-1 acceptance PASSES (measured).** B-full box hugs the legibility floor, not grid-pack: 3-stack `270→141×232`, 9-stack `400→141×592`, long-label `321×232` (name always fits). Measured no-clip (floor is a *minimum*, grow contains any outlier child); children **centered** under a wide header, not pushed aside; rollback = acceptable degradation; no thrash; perf = one bounded recompute. New: **FIT-10 [P2 must-test]** (serializer completeness — folded into the F2 thread), **FIT-11/12/13 [P3]** below.

**Semantic — NEEDS WORK: 1×P1 (F2) + non-blocking. F1 fold verified.** F2 = the same serializer gap, extended to all doc touch points + version locus + required-field → **folded as the `fitted` serialization thread above.** Conceded SAFE with evidence: §3.5 lossless-import (given mirror-not-filter), identity/aliasing of `fitted`, projection/diff under the size change, idempotency of the floor.

**Folded non-blocking findings:**
- **FIT-11 [P3, v1 limitation — DOCUMENTED]:** `growForPinnedChildren` grows symmetric about the stored centre, and `FitContainer` recenters only at fit time. Expanding/collapsing/dragging a child of a fitted container afterward can re-introduce some slack (symmetric grow around the now-stale centre) until re-fit. v1 decision: **floor-only + recenter-at-fit**, NOT a live derived-centre (which would break "positions owned"). Re-fit (H / glyph) re-tightens. Follow-up: live-hug (derive the fitted container's centre each pass).
- **NR-2 / OQ1 correction [P3, v1 limitation — DOCUMENTED]:** for a **nested** fitted child, pass-2 `computeSizes` packs the parent against the child's *grown (tight)* size (`layoutEngine.ts:61,108`) while `assignPositions` places it at its *natural* size (`:164,178`) → residual whitespace **in the parent**. So a fitted child is **not** "identical to a dragged child" (which keeps natural size). No semantic/identity/diff/idempotency effect. v1: fits are cleanest one level (top-level container, the screenshot case — no fitted parent). Follow-up: have `computeSizes` report the tight size for fitted containers.
- **FIT-12 [P3, honest degradation]:** on rollback the freeze-pins persist while `fitted` is dropped → the fit's cost (mass-pin, N1 `droppedPositions` exposure) remains without its benefit (tight box); full revert needs global `R`. Called out in the status message.
- **NR-3 [forward]:** `fitted` joins `expanded`/`positions` as `NodeId`-keyed view state; all three must re-key to `OutlineNodeId` together if I10 is ever relaxed to multi-placement (extends N-A).
