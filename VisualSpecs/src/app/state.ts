// AppState and the pure command reducer (§9.1).
//
// AppState does NOT contain `doc.view`. There is exactly one writable holder of
// expansion / positions / viewport — `AppState.view` — so the two cannot silently
// diverge. That was a real defect in an earlier design, and it is gone by
// construction, not by discipline.

import type { DeepReadonly, JsonValue, LossReport, Warning } from '../contract/types.ts';
import type { GraphModel } from '../contract/model.ts';
import type { LoadedDoc } from '../contract/load.ts';
import type { ViewState } from '../contract/view.ts';
import type { Outline, OutlineNodeId } from '../domain/outline.ts';
import { OwnershipOutline, assertInjective } from '../domain/outline.ts';
import { applyViewCommand, initialExpanded, type CommandContext, type ViewCommand } from '../domain/commands.ts';
import { withExpanded } from '../contract/view.ts';
import type { InternalBucketId, VisibleEdgeId } from '../projection/types.ts';
import { project } from '../projection/project.ts';
import { matchNodes } from './search.ts';
import { LEVELS_OFF, type LevelsMode, type RankBasis } from './levelView.ts';

export interface Filters {
  /** The node kinds that are SHOWN. */
  readonly nodeKinds: ReadonlySet<string>;
  /** The edge kinds that are SHOWN. */
  readonly edgeKinds: ReadonlySet<string>;
  readonly hideTests: boolean;
}

export interface AppState {
  readonly raw: DeepReadonly<JsonValue>;
  readonly model: GraphModel;
  readonly outline: Outline;
  readonly view: ViewState;
  readonly selection: {
    readonly nodeIds: readonly string[];
    readonly edgeId: VisibleEdgeId | InternalBucketId | null;
  };
  readonly search: { readonly query: string; readonly matches: ReadonlySet<string> };
  readonly filters: Filters;
  /**
   * Levels mode (Issue #44). Session state, like `search` and `filters` and NOT like
   * `view`: a way of looking is not human work, and putting it under `view` would drag
   * format, validate, export and autosave behind it — and would make the same document
   * export differently depending on the mode you happened to be in.
   */
  readonly levels: LevelsMode;
  /** set when `requires[]` is unsatisfiable (§3.4) */
  readonly readOnly: boolean;
  readonly warnings: readonly Warning[];
  readonly loss: LossReport | null;
}

export type AppCommand =
  | ViewCommand
  | { type: 'Select'; nodeIds: readonly string[]; edgeId: VisibleEdgeId | InternalBucketId | null }
  | { type: 'SetSearch'; query: string }
  | { type: 'SetFilter'; nodeKinds?: ReadonlySet<string>; edgeKinds?: ReadonlySet<string>; hideTests?: boolean }
  | { type: 'SetLevels'; active?: boolean; basis?: RankBasis }
  | { type: 'Import'; loaded: LoadedDoc }
  | { type: 'Refresh'; loaded: LoadedDoc; loss: LossReport };

/**
 * Every `ViewCommand` type, routed to `applyViewCommand`.
 *
 * A `Record<ViewCommand['type'], true>` and NOT a `Set<string>`: as a set this was a
 * hand-maintained duplicate of the union with no exhaustiveness check and no test, so
 * adding a command and forgetting the set compiled cleanly and made `apply()` fall
 * through to `default: return state` — the command silently swallowed, `tsc` happy.
 * Both red teams found that independently. As a Record, forgetting one is a compile
 * error, and adding a stale key is too.
 */
const VIEW_COMMANDS: Record<ViewCommand['type'], true> = {
  Expand: true,
  Collapse: true,
  ToggleExpand: true,
  ExpandAll: true,
  CollapseAll: true,
  ExpandTo: true,
  MoveNode: true,
  FitContainer: true,
  ResetLayout: true,
  SetViewport: true,
  SetFocus: true,
  SetFocusInherited: true,
  SetAllFocus: true,
  SetFocusTransparency: true,
};

function isViewCommand(type: string): type is ViewCommand['type'] {
  return Object.hasOwn(VIEW_COMMANDS, type);
}

export function stateFromLoaded(loaded: LoadedDoc, loss: LossReport | null = null): AppState {
  const outline = new OwnershipOutline(loaded.model);
  // I10 is not an aspiration. Every outline the app constructs is checked.
  assertInjective(outline, loaded.model);

  // An extractor document has no `view`; the app then computes a deterministic
  // initial one — the repository, its applications, its packages and its crates: ten
  // boxes, not 705 files (§9.3).
  //
  // The condition is "the document PROVIDED no expansion", NOT "the expansion is
  // empty". `expanded: []` is a map the user deliberately collapsed and saved, and
  // treating it as an absence silently re-opened it on import. An empty array is a
  // value.
  const view = loaded.viewProvided.expanded
    ? loaded.view
    : withExpanded(loaded.view, initialExpanded(outline) as ReadonlySet<OutlineNodeId>);

  const nodeKinds = new Set<string>(loaded.model.nodes.map((n) => n.kind));
  const edgeKinds = new Set<string>(loaded.model.edges.map((e) => e.kind));

  return {
    raw: loaded.raw,
    model: loaded.model,
    outline,
    view,
    selection: { nodeIds: [], edgeId: null },
    search: { query: '', matches: new Set<string>() },
    filters: { nodeKinds, edgeKinds, hideTests: false },
    levels: LEVELS_OFF,
    readOnly: loaded.readOnly,
    warnings: loaded.warnings,
    loss,
  };
}

/**
 * Carry the user's filters across a refresh — WITHOUT hiding what they have never
 * seen. A kind that did not exist before cannot have been switched off, so it is
 * shown; a kind they switched off stays off. Copying the old set verbatim would make
 * every newly-introduced kind invisible by default, which is exactly the wrong
 * default for an OPEN vocabulary (§3.7) and for the `server → app → module` future
 * the outline frontier exists to serve.
 */
function carryFilters(previous: AppState, next: AppState): Filters {
  const carry = (
    before: ReadonlySet<string>,
    enabledBefore: ReadonlySet<string>,
    after: ReadonlySet<string>,
  ): Set<string> => {
    const enabled = new Set<string>();
    for (const kind of after) {
      if (!before.has(kind)) enabled.add(kind); // brand new: show it
      else if (enabledBefore.has(kind)) enabled.add(kind); // known: as the user left it
    }
    return enabled;
  };

  const beforeNodeKinds = new Set(previous.model.nodes.map((n) => n.kind));
  const beforeEdgeKinds = new Set(previous.model.edges.map((e) => e.kind));
  const afterNodeKinds = new Set(next.model.nodes.map((n) => n.kind));
  const afterEdgeKinds = new Set(next.model.edges.map((e) => e.kind));

  return {
    nodeKinds: carry(beforeNodeKinds, previous.filters.nodeKinds, afterNodeKinds),
    edgeKinds: carry(beforeEdgeKinds, previous.filters.edgeKinds, afterEdgeKinds),
    hideTests: previous.filters.hideTests,
  };
}

/**
 * The selection survives a refresh for ids the new document still has. A visible
 * edge or internal bucket id is a projection-level identity, so survival is
 * checked against the projection of the NEW model under the carried expansion —
 * the same projection `derive` computes right after. This runs only when an edge
 * is actually selected.
 */
function carrySelection(previous: AppState, next: AppState): AppState['selection'] {
  const nodeIds = previous.selection.nodeIds.filter((id) =>
    next.model.nodeById.has(next.outline.entityOf(id)),
  );
  let edgeId = previous.selection.edgeId;
  if (edgeId !== null) {
    const graph = project(next.model, next.outline, next.view.expanded);
    if (
      !graph.visibleEdgeById.has(edgeId as VisibleEdgeId) &&
      !graph.internalBucketById.has(edgeId as InternalBucketId)
    ) {
      edgeId = null;
    }
  }
  if (nodeIds.length === 0 && edgeId === null) return { nodeIds: [], edgeId: null };
  return { nodeIds, edgeId };
}

export function apply(state: AppState, cmd: AppCommand, ctx: CommandContext): AppState {
  if (isViewCommand(cmd.type)) {
    const view = applyViewCommand(ctx, state.view, cmd as ViewCommand);
    return view === state.view ? state : { ...state, view };
  }

  switch (cmd.type) {
    case 'Select':
      return { ...state, selection: { nodeIds: [...cmd.nodeIds], edgeId: cmd.edgeId } };

    case 'SetSearch': {
      const matches = matchNodes(state.model, cmd.query);
      return { ...state, search: { query: cmd.query, matches } };
    }

    case 'SetFilter':
      return {
        ...state,
        filters: {
          nodeKinds: cmd.nodeKinds ?? state.filters.nodeKinds,
          edgeKinds: cmd.edgeKinds ?? state.filters.edgeKinds,
          hideTests: cmd.hideTests ?? state.filters.hideTests,
        },
      };

    case 'SetLevels': {
      const next: LevelsMode = {
        active: cmd.active ?? state.levels.active,
        basis: cmd.basis ?? state.levels.basis,
      };
      if (next.active === state.levels.active && next.basis === state.levels.basis) return state;
      return { ...state, levels: next };
    }

    case 'Import':
      return stateFromLoaded(cmd.loaded, null);

    case 'Refresh': {
      const next = stateFromLoaded(cmd.loaded, cmd.loss);
      // Refresh keeps the user's layout AND what they were looking at — including
      // the selection, restricted to ids that still exist. Under follow-file
      // auto-reload the extractor rewrites every few seconds; resetting the
      // selection each time would clear the entity the user is inspecting.
      return {
        ...next,
        // The mode is session state, so a re-extraction does not drop the user out of it.
        levels: state.levels,
        selection: carrySelection(state, next),
        search:
          state.search.query === ''
            ? next.search
            : {
                query: state.search.query,
                matches: matchNodes(cmd.loaded.model, state.search.query),
              },
        filters: carryFilters(state, next),
      };
    }

    default:
      return state;
  }
}
