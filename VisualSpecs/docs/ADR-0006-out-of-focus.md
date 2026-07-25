# ADR 0006 — Out-of-focus is an inheritable tri-state per node, and an aggregate renders the fraction of what it stands for

**Status.** Accepted (Issue #17, 2026-07-25).
**Context.** `docs/ARCHITECTURE.md` §6.5 (aggregation preserves quantity and destroys information), §7 (sizes derived, positions owned); `plan/17-out-of-focus-dimming.md`; ADR 0001 (outline placement, I10); ADR 0002 (renderer port).

## The problem

On a 787-node map, reading is an exercise in subtraction: the useful move is almost always "push these six
boxes back so I can see the two that matter". Collapsing is the wrong tool — it changes the projection,
folds relations into buckets and moves the layout. Filtering by kind is the wrong tool — it masks a whole
category, not the specific instances in the way. What was missing is a per-entity, non-destructive, purely
presentational "out of focus".

## Decision 1 — an inheritable tri-state, not a flat set

Each node is `out-of-focus`, `in-focus`, or unmarked (inherits the nearest marked ancestor; in focus if
none). Effective state is resolved by one pre-order walk over the outline.

A flat set of dimmed ids cannot express the one gesture the feature exists for: dim a container, bring one
entity inside it back, and have the container **stay** dim. Either the container's own state is lost, or a
mark has to be materialised on every sibling.

Resolution is total and deterministic **by construction, not by hope**: `checkIntegrity` guarantees every
`parentId` resolves (I2) and the tree is acyclic (I3), so every ancestor chain terminates at a root, and
`assertInjective` (I10) rejects any placement unreachable from the roots. Under a future multi-placement
outline the nearest marked ancestor stops being unique — see `MULTI_PLACEMENT_NOTE`, to which
`focus.marks` is now appended alongside `expanded`, `fitted` and `positions`.

## Decision 2 — the write rule writes the MINIMAL mark, and retention is a separate rule

For a requested effective state `S` on node `n`: if `inherited(n) === S`, **delete** `n`'s own mark;
otherwise **write** `S`.

The storage rule was never the defect. The naive write rule — *"Bring into focus writes `in-focus`"* —
manufactures a permanent exemption out of a request that meant "undo my own dimming":

```
dim P      → {P:out}
light c1   → {P:out, c1:in}          the override, working
light P    → {P:in, c1:in}           naive: P now carries a mark
dim repo   → {repo:out, P:in, c1:in} → P's whole subtree stays bright, and the
                                       user asked to dim the repository
```

The general form is required rather than the symmetric one: *Send out of focus* on a node carrying its own
`in-focus` mark under an **unmarked** ancestor must **write** `out-of-focus`, because deleting would leave
it in focus — the opposite of the request.

**§4.5 governs writes; §4.6 governs retention: do not create a mark equal to its inherited value; do not
delete one that already exists.** A "simplification" that canonicalises the map whenever anything changes
passes every test that does not exercise those four steps, and silently breaks the one requirement the
user stated explicitly.

## Decision 3 — an aggregated edge's opacity is a FRACTION over `sourceEdgeIds`, with a one-sided floor

An aggregate's focus opacity is `focusOpacity + (1 - focusOpacity) × (bright / total)` over the **logical
relations it carries**, not over its visible endpoints. Exact at ×1, so the boolean rule is a special case.

One bit is wrong in **both** directions, and both were measured:

| rule | failure |
| --- | --- |
| ask the visible representatives | the aggregate is dim while carrying a relation the user explicitly re-lit — and expanding the parent flips the same logical relation from dim to bright |
| "every relation out" | one override of 21 returns a ×136 line to full strength with **122 of 136 relations still switched off**, behind a width that encodes 136 |

`VisibleEdge.sourceEdgeIds` is "the logical relations behind this one line", and asking the representatives
instead discards exactly what aggregation exists to preserve (§6.5: *"a counter preserves the QUANTITY of
information and destroys the INFORMATION"*).

**Cost, measured, and it is additive rather than multiplicative:** `project` iterates `model.edges` once and
partitions them, so `Σ|sourceEdgeIds|` over visible edges + internal buckets + out-of-scope **equals**
`|model.edges|` — verified at three expansion states (195 + 1677, 1872 + 0, 0 + 1872, all = 1872, no
duplication). And `buildScene` already maps `sourceEdgeIds → model.edgeById` three lines away for the
`allHeuristic` dash rule, so the rule is more work inside an existing loop: p50 0.200 ms at expand-all
against `project()`'s p50 1.00 ms.

**The floor is deliberately one-sided.** Any non-zero bright fraction is lifted by at least
`MIXED_FRACTION_FLOOR` of the available range, because the plain continuous form makes a fine-grained
override imperceptible: at the default transparency, 1/136 bright moves the line by Δcontrast 0.007 — one
8-bit step — while 14/136 moves it 0.246 and is visible. `0.10` reproduces that measured-visible magnitude
(14/136 is 0.1029 of the range). There is **no matching floor** for "some relations dimmed": 135/136 bright
renders at 0.9948 against 1.0, and that is correct — an override is a deliberate, rare act and must be
visible; switching one relation of 136 off is a sweep and should read as small.

### The asymmetry with search, which must not be "fixed"

`matchesUnder` (`app/scene.ts`) deliberately keeps a container's edges **bright** when a search hit is
inside it, so a hit in a collapsed box stays discoverable. Focus leaves that same aggregate bright for a
mechanically identical but **semantically opposite** reason. The two are not inconsistent and unifying them
would break one of them. This is the note most likely to be removed by someone who does not know it was
decided.

## Decision 4 — an object map, and what it costs

`view.focus.marks: Record<NodeId, "out-of-focus" | "in-focus">`. A key holds one value, so **"marked both in
and out" is unrepresentable rather than validated** — the posture this codebase already prefers ("gone by
construction, not by discipline").

**The cost, taken knowingly:** the additive-minor contract holds for unknown **keys** and would break for an
extended **value domain** of a known key, which is the one axis this shape extends. Two arrays would have
tolerated a third array and admitted contradictory state. Bought back by making an unrecognised mark value a
**warning** above `SUPPORTED_MINOR`, ignored for resolution and preserved verbatim on export; and a
**problem** at or below it, where this build owns the whole value domain.

Values are spelled in full because `view.focus` travels inside the artifact a coding agent consumes: a bare
`"out"` on a node is one reading from "out of scope", "excluded" or "dead" — a claim about the **system**
rather than about where a person is looking.

## Decision 5 — I-F9 / I-F10, the boundary for any future auto-dim feature

**(a) `view.*` carries no observations**, even when a machine writes it. An observation is precisely a claim
carrying `evidence[]` and `confidence`; nothing under `view` has either, which is *why* none of it is one.
The extractor emits `view: { expanded: [<repo>] }` on every run and that is a suggested starting view, not a
finding.

**(b) `view.focus` specifically is a human decision.** No machine writes it. Focus lives only there — never
in `nodes[].metadata`, `edges[].metadata`, `evidence[]` or `unresolved[]`.

The split matters: stating (b) as though it covered all of `view` gives (a) a refutable form, and an
invariant that can be refuted in a minute stops being quoted.

**So the boundary condition for "auto-dim tests" or "auto-dim vendor", when someone wants it:** a machine
suggestion about attention must travel under a **different, derived, recomputed-every-run key that the UI
can name**, never through `focus.marks`, which means *a person said so*. `metadata` is the shortest path to
getting this wrong — a free-form `Record<string, unknown>` the validator accepts without inspection **and
the extractor regenerates every run**, so a mark parked there would be indistinguishable from an
observation and destroyed at the next extraction. Machine-checked in both directions
(`tests/extractor/observationBoundary.test.ts`).

## Consequences

- `ViewState` gains a required fifth field, and **one exhaustive projection** now covers the five
  `VisualSpecsView`-boundary sites, because a required field only makes the `with*` copiers
  compiler-enforced and reaches nothing beyond them.
- `formatVersion` 1.2, keyed off the **typed** state. Once raised it never comes down — including after every
  mark is cleared, and including a document that legitimately declared 1.1 for `fitted`. Lowering would
  suppress `unknown-minor` for other extensions the raw envelope carries, which is worse than a stale minor.
- The renderer port's `dimmed: boolean` became a required `opacity: number` plus an optional
  `marker?: string`, with `opacity = min(searchOpacity, focusOpacity)` — dimmest reason wins, monotone,
  order-free, exactly `1` when nothing applies. Search's `0.22`/`0.14` moved from adapter literals to named
  constants in `app/scene.ts`, where app policy belongs.
- **The two dim channels are not separable by alpha at any setting** (2/255 at the default, 0/255 at the
  ceiling, because the ceiling *is* the search dim). Separability comes from the row glyphs and context, and
  focus state is unobservable on canvas for any node a search does not match. Stated, not fixed.
- **Focus is not a filter**: hit-testing never consulted opacity, so an out-of-focus node stays a click
  target. That is what makes the canvas context menu the escape hatch for the ~99% of entities the sidebar
  list does not show, and it is why the ceiling is a perceptibility floor rather than the maximum the eye
  tolerates.

## Method notes worth more than any single decision

**Never assert on a value the test rebuilds.** Two invariance checks in this issue were structurally
incapable of failing, the same error twice: an absence test asserting on the validated `doc` instead of the
emitted bytes (`validateView` is an allowlist that drops unknown keys, so the assertion passes even when the
extractor emits focus); and a projection-invariance test comparing a recomputed
`project(model, outline, view.expanded)` to itself (no focus command touches `expanded`). Assert on what the
system produces. The rebuilt form looks more rigorous, which is why it will be reached for again.

**Check an invariant at the altitude where it can be violated.** `buildScene` receives an already-built
`VisibleGraph`, so an I-F1 check written there passes while `derive()` threads the view into `project` three
lines away. Two owners reached this independently — one from implementation, one by mutation.

**A round trip must converge, not merely be identical.** Rules of the form "write it only if it was already
declared" break on idempotence first, because the first export changes what *already declared* means for the
second. The property that matters: no further round trip changes anything.

**Some failure modes are invisible to reading, and those are exactly the ones reading is trusted for.**
`droppedFitted` survived two releases because reading showed a `LossReport` field being populated — and
populating is what reading verifies. The executable version of that banner found a second instance in its
first thirty seconds: `.focus-marks-row { display: flex }` beats the `hidden` attribute's UA rule, so an
unused feature showed a permanent "0 marked" while the code plainly set `hidden`.
