// scene.build(visibleGraph, registry, state) → RenderScene. Pure.
//
// FILTERS DO NOT PARTICIPATE IN PROJECTION (§6.5). They are a scene mask applied
// AFTER it: they set `opacity`/`hidden` and report their own totals. NVA never
// changes, and the partition law is never invalidated by a filter, because the law
// is stated over the unfiltered projection.
//
// Focus (Issue #17) is the second such mask, and this file is the ONLY place that
// knows why something is faded. The port is handed a resolved number; the semantics
// of the number live in `domain/focus.ts` and the two strengths search uses live
// here — they are app policy, and a second adapter would otherwise have to reinvent
// them from literals buried in the first one.

import type { VisualSpecsEdge } from '../contract/types.ts';
import { descendantsOf } from '../contract/model.ts';
import { aggregateFocusOpacity, focusOpacity, resolve, type ResolvedFocus } from '../domain/focus.ts';
import type { Geometry } from '../domain/layoutEngine.ts';
import { labelWidthFor, truncateLabel } from '../domain/geometry.ts';
import { buildOutlineParents } from '../domain/commands.ts';
import type { VisibleGraph } from '../projection/types.ts';
import type { RenderBand, RenderEdge, RenderNode, RenderScene } from '../ports/renderer.ts';
import { bandStyle, edgeStyle, nodeStyle } from './registry.ts';
import type { AppState } from './state.ts';
import { levelMarker, NO_RANKINGS, rankBadge, type Rankings } from './levelView.ts';

/**
 * How strongly a search attenuates what it does not match. These were literals at
 * `Canvas2DRenderer.ts:593` and `:722`; they are policy, not drawing, and they
 * differ between the two because a line at the node strength still reads as clutter.
 */
export const SEARCH_NODE_OPACITY = 0.22;
export const SEARCH_EDGE_OPACITY = 0.14;

/**
 * The glyph a collapsed representative carries when its hidden subtree disagrees
 * with it (§4.4): "the inside is not what the outside looks like". That is the state
 * the tri-state model exists for, and the one a single dimmed box cannot show.
 *
 * A glyph on a canvas cannot explain itself — there is no tooltip out there. The
 * detail panel is what explains it, for whatever is selected, which is also the
 * route that works for entities with no sidebar row at all.
 */
export const MIXED_SUBTREE_MARKER = '▣';

/**
 * A container in Levels mode that was ranked and drew no lanes (Issue #44).
 *
 * The glyph is not the explanation — a glyph on a canvas cannot explain itself, which is
 * why the detail panel carries the sentence. What it does is stop the degradation from
 * being silent, and silence is the one thing it must not be: the container looks exactly
 * like one with nothing to stratify unless it says otherwise.
 */
export const LANES_HIDDEN_MARKER = '⊘';

/**
 * The parent walk, memoized per outline.
 *
 * A scene is built on every command, and the badge needs to know which container states a
 * box's rank. Walking the whole outline each time is O(V) of pure repetition: an `Outline`
 * is immutable for the life of a document, so a `WeakMap` keyed by it is exact and lets
 * the entry go when the document does.
 */
const PARENTS_BY_OUTLINE = new WeakMap<object, ReadonlyMap<string, string | null>>();

function parentsOf(outline: AppState['outline']): ReadonlyMap<string, string | null> {
  const key = outline as unknown as object;
  const hit = PARENTS_BY_OUTLINE.get(key);
  if (hit !== undefined) return hit;
  const built = buildOutlineParents(outline);
  PARENTS_BY_OUTLINE.set(key, built);
  return built;
}

export interface SceneResult {
  scene: RenderScene;
  hiddenByFilter: { nodes: number; edges: number };
  /**
   * The focus this scene was built from, or `null` when no mark exists.
   *
   * Published rather than recomputed by the sidebar, so the row glyph and the box on
   * the canvas cannot disagree about what state an entity is in. Two walks would also
   * be two chances to drift — and if the view contradicts the projection, the view is
   * the thing that is wrong.
   */
  focus: ResolvedFocus | null;
}

export function buildScene(
  state: AppState,
  geometry: Geometry,
  graph: VisibleGraph,
  rankings: Rankings = NO_RANKINGS,
): SceneResult {
  const { model, outline, view, selection, search, filters } = state;
  // Which container each visible node hangs from — the rank of a box is stated by ITS
  // OWN container's ranking, and a rank from one container is not comparable with a rank
  // from another.
  const parentOf = state.levels.active ? parentsOf(outline) : null;
  const selectedNodes = new Set<string>(selection.nodeIds);
  const searching = search.query.trim() !== '';

  // Nothing marked means nothing is out of focus, so every focus term is 1. Skipping
  // the whole apparatus keeps a map nobody has dimmed exactly as cheap to build as it
  // was before this feature existed — which is most maps, most of the time.
  const focusing = view.focus.marks.size > 0;
  const resolved = focusing ? resolve(outline, graph.nva, view.focus) : null;
  const outOfFocusOpacity = focusing ? focusOpacity(view.focus.transparency) : 1;

  const nodes: RenderNode[] = [];
  const hiddenNodes = new Set<string>();
  let hiddenNodeCount = 0;

  for (const n of graph.visibleNodes) {
    const entity = outline.entityOf(n);
    const guideNode = model.nodeById.get(entity);
    if (guideNode === undefined) continue;

    const position = geometry.position.get(n);
    const size = geometry.size.get(n);
    if (position === undefined || size === undefined) continue;

    const isContainer = outline.childrenOf(n).length > 0;
    const isExpanded = isContainer && view.expanded.has(n);

    const kindShown = filters.nodeKinds.has(guideNode.kind);
    const testHidden = filters.hideTests && guideNode.metadata?.['isTest'] === true;
    const hidden = !kindShown || testHidden;
    if (hidden) {
      hiddenNodes.add(n);
      hiddenNodeCount += 1;
    }

    const style = nodeStyle(guideNode.kind);
    const label = truncateLabel(guideNode.label, labelWidthFor(size, isContainer)).text;

    const node: RenderNode = {
      id: n,
      kind: guideNode.kind,
      label,
      position: { x: position.x, y: position.y },
      size: { w: size.w, h: size.h },
      isContainer,
      isExpanded,
      // Only an expanded container can show the "fitted" affordance; the flag is
      // presentational (glyph filled vs outline), the geometry is already derived tight.
      fitted: isExpanded && view.fitted.has(n),
      z: geometry.z.get(n) ?? 0,
      selected: selectedNodes.has(n),
      // A collapsed container renders by its OWN effective state (§4.4). What is
      // inside it gets the marker, not the box's opacity: a box that fades because of
      // something the user cannot see is not telling them anything.
      opacity: Math.min(
        searching && !search.matches.has(entity) ? SEARCH_NODE_OPACITY : 1,
        resolved?.effective.get(n) === 'out' ? outOfFocusOpacity : 1,
      ),
      hidden,
      style: { fill: style.fill, stroke: style.stroke, text: style.text, shape: style.shape },
    };

    if (isContainer && !isExpanded) {
      const count = descendantsOf(model, entity).length;
      if (count > 0) node.badge = String(count);
    }

    // The rank badge is THE AUTHORITY and is present always in Levels mode, not only when
    // the box is out of its lane: a badge that appears only when the band lies is one
    // nobody has learned to read by the time it matters. Dragging a box never changes it.
    const markers: string[] = [];
    if (resolved?.subtreeDiffers.has(n) === true) markers.push(MIXED_SUBTREE_MARKER);

    if (parentOf !== null) {
      const container = parentOf.get(n);
      const ranking = container === null || container === undefined ? undefined : rankings.get(container);
      if (ranking !== undefined) {
        const rankText = rankBadge(ranking, n);
        if (rankText !== undefined) {
          // A collapsed container already shows its descendant count; the two are joined
          // rather than made to fight over the field.
          node.badge = node.badge === undefined ? rankText : `${rankText}·${node.badge}`;
        }
        const hides = levelMarker(ranking, n);
        if (hides !== undefined) markers.push(hides);
      }
    }
    // DECLARED DEGRADATION. A container that WAS ranked and still drew no lanes — either
    // its bands stopped describing their own boxes (a fit under one basis, then a toggle
    // to the other) or the clip ate one of them past the point of being a lane. Not
    // drawing them is right; doing it in silence is not, because a stripe that vanishes
    // without explanation is an assertion of its own.
    if (isExpanded && rankings.has(n) && !geometry.bands.has(n)) {
      markers.push(LANES_HIDDEN_MARKER);
    }
    // `marker` is a free string the port draws without interpreting, so it COMPOSES:
    // focus's mixed-subtree glyph and the hidden-entanglement glyph stop competing for
    // one field, and there is no precedence rule to get wrong.
    if (markers.length > 0) node.marker = markers.join('');
    nodes.push(node);
  }

  const edges: RenderEdge[] = [];
  let hiddenEdgeCount = 0;

  for (const v of graph.visibleEdges) {
    const kindShown = filters.edgeKinds.has(v.kind);
    const endpointHidden = hiddenNodes.has(v.sourceId) || hiddenNodes.has(v.targetId);
    const hidden = !kindShown || endpointHidden;
    if (hidden) hiddenEdgeCount += 1;

    const style = edgeStyle(v.kind);
    const logical = v.sourceEdgeIds
      .map((id) => model.edgeById.get(id))
      .filter((e): e is VisualSpecsEdge => e !== undefined);
    // An aggregate is drawn dashed when EVERY relation behind it is heuristic —
    // the line is then as uncertain as the weakest thing it stands for.
    const allHeuristic = logical.length > 0 && logical.every((e) => e.confidence === 'heuristic');

    const sourceMatched = searching && matchesUnder(state, graph, v.sourceId);
    const targetMatched = searching && matchesUnder(state, graph, v.targetId);

    edges.push({
      id: v.id,
      kind: v.kind,
      sourceId: v.sourceId,
      targetId: v.targetId,
      count: v.count,
      label: v.count > 1 ? `×${v.count}` : undefined,
      selected: selection.edgeId === v.id,
      // §4.3 — a line standing for many relations carries a FRACTION, not a bit. The
      // walk it needs is the one three lines above, already mapping `sourceEdgeIds`
      // through `model.edgeById` for the dash rule.
      opacity: Math.min(
        searching && !sourceMatched && !targetMatched ? SEARCH_EDGE_OPACITY : 1,
        resolved === null
          ? 1
          : aggregateFocusOpacity(
              view.focus.transparency,
              brightRelations(logical, resolved.effective),
              logical.length,
            ),
      ),
      hidden,
      style: {
        color: style.color,
        width: style.width + Math.min(3, Math.log2(v.count + 1) * 0.6),
        dash: allHeuristic && style.dash === null ? [6, 4] : style.dash,
        arrow: 'triangle',
      },
    });
  }

  // Level bands. The domain already resolved them into drawable rectangles, clipped
  // exactly and only for containers whose lanes still describe their boxes — a
  // desynchronized container emits none at all, and the header declares that.
  const bands: RenderBand[] = [];
  for (const [container, lanes] of geometry.bands) {
    const z = (geometry.z.get(container) ?? 0) + 0.5;
    const hidden = hiddenNodes.has(container);
    for (const lane of lanes) {
      bands.push({
        containerId: container,
        rank: lane.rank,
        rects: lane.rects,
        z,
        label: `L${String(lane.rank)}`,
        style: bandStyle(lane.rank),
        opacity: 1,
        hidden,
      });
    }
  }

  return {
    scene: bands.length > 0 ? { nodes, edges, bands } : { nodes, edges },
    hiddenByFilter: { nodes: hiddenNodeCount, edges: hiddenEdgeCount },
    focus: resolved,
  };
}

/**
 * How many of the relations behind one drawn line have NO effectively-out endpoint.
 *
 * The endpoints asked are the relation's OWN entities, not the aggregate's
 * representatives. Asking the representatives hides a relation the user explicitly
 * re-lit whenever its parent is collapsed — which is the state the app opens in.
 */
function brightRelations(
  logical: readonly VisualSpecsEdge[],
  effective: ReadonlyMap<string, 'in' | 'out'>,
): number {
  let bright = 0;
  for (const e of logical) {
    if (effective.get(e.sourceId) !== 'out' && effective.get(e.targetId) !== 'out') bright += 1;
  }
  return bright;
}

/** A search hit inside a collapsed container should keep the container's edges
 *  bright — the hit is in there, it is just not drawn yet. */
function matchesUnder(state: AppState, graph: VisibleGraph, visibleId: string): boolean {
  const entity = state.outline.entityOf(visibleId);
  if (state.search.matches.has(entity)) return true;
  for (const d of descendantsOf(state.model, entity)) {
    const placement = state.outline.placementOf(d);
    if (placement === null) continue;
    if (graph.nva.get(placement) !== visibleId) continue;
    if (state.search.matches.has(d)) return true;
  }
  return false;
}
