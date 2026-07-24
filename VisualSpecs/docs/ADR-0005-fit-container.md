# ADR 0005 — Per-container "fit to content" adds a `fitted` view state that overrides the size floor

**Status.** Accepted (Issue #13, 2026-07-24). Not yet shipped.
**Context.** `docs/ARCHITECTURE.md` §7 (sizes derived, positions owned); `domain/layoutEngine.ts` (`growForPinnedChildren`); `plan/13-fit-container-to-content.md`.

## The problem

An expanded container's box grows **symmetrically about its stored centre** to contain its pinned children (`growForPinnedChildren`), and its size is floored at the **grid-pack natural** footprint (`computeSizes`, `max(packed.width + 2P, headerWidth)`) and never shrinks below it. When a user drags a container's children off-centre, the symmetric growth mirrors an equal empty band on the opposite side — large wasted space (the `Frontend` container in the AgentsCommander corpus is ~87% empty).

Two candidate fixes were considered and measured (resilience red team, real `computeGeometry`):

- **Recenter-only:** move the container's stored centre to the children's bbox centre so symmetric growth hugs. Removes the asymmetric band but **cannot shrink below the grid-pack floor** — a vertical stack of 3 stays ~2× too wide (measured: 9-stack 400px vs 140px ideal). Rejected by the user: does not meet "casi mínimo, apenas margen."
- **Hug total (chosen):** additionally lower the size floor for fitted containers.

## The decision

Add a per-container **`fitted: ReadonlySet<NodeId>`** to `ViewState` (parallel to `expanded`, required so the copiers are compiler-enforced). `FitContainer { id }` freezes the children (pins them at their drawn centres), adds `id` to `fitted`, and recenters the container. For `n ∈ fitted` with `childrenShown`, `growForPinnedChildren` initializes at a **legibility floor** instead of the grid-pack natural:

- `width  = max(childBboxW + 2·PAD, headerFloor)`
- `height = max(childBboxH + 2·PAD + HEADER, HEADER + 2·PAD)`

where `headerFloor` guarantees the header always shows the container **name + caret + fit glyph**. The floor is only the *initial* half-extent; the existing grow loop still runs, so a child pinned outside the floor is never clipped.

## What this resigns (stated so it can be argued with)

- **The size floor is no longer purely the grid-pack natural.** Size is still *derived* (the `fitted` flag is a derivation input, not a stored size), but the derivation now branches on view state. Non-fitted containers are unchanged.
- **The container's stored centre moves** at fit time (a legitimate explicit user action, like a drag). Symmetric growth is preserved for non-fitted containers.
- **A schema addition.** `fitted` is threaded through every doc touch point; the exported doc `formatVersion` minor-bumps `1.0 → 1.1` (additive, announced via `unknown-minor`); the autosave version does **not** bump (its parser is strict-equality; a bump would discard the whole autosave on rollback). Old docs → `fitted = ∅` = current behavior.

## Consequences and accepted v1 limitations

- **Reversibility:** the change is additive and staged. `Reset layout` (R) clears `fitted`. A code revert leaves docs valid (`fitted` becomes an ignored key).
- **FIT-11:** fit recenters only at fit time; expanding/dragging a child afterward can re-introduce slack until re-fit. A live derived-centre hug is a deliberate follow-up, not v1 (it would make the container's position derived, not owned).
- **NR-2:** a *nested* fitted child leaves residual whitespace in its parent (the parent packs against the child's natural size, draws it tight). Fits are cleanest one level (top-level container). Follow-up: report the tight size from `computeSizes` for fitted containers.
- **Contract:** any before/after coding-agent contract and semantic diff must exclude `view.fitted` and `view.positions`, diffing only the model/projection layer — a cosmetic hug must never surface as a model-level delta.

Reviewed constructively 3-of-3 (core, extraction, graph/runtime) and adversarially by both red teams (semantic F1/F2, resilience FIT-1..FIT-13); see `plan/13-fit-container-to-content.md` for the full evidence trail.
