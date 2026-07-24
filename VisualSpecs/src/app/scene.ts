// scene.build(visibleGraph, registry, state) → RenderScene. Pure.
//
// FILTERS DO NOT PARTICIPATE IN PROJECTION (§6.5). They are a scene mask applied
// AFTER it: they set `dimmed`/`hidden` and report their own totals. NVA never
// changes, and the partition law is never invalidated by a filter, because the law
// is stated over the unfiltered projection.

import type { VisualSpecsEdge } from '../contract/types.ts';
import { descendantsOf } from '../contract/model.ts';
import type { Geometry } from '../domain/layoutEngine.ts';
import { labelWidthFor, truncateLabel } from '../domain/geometry.ts';
import type { VisibleGraph } from '../projection/types.ts';
import type { RenderEdge, RenderNode, RenderScene } from '../ports/renderer.ts';
import { edgeStyle, nodeStyle } from './registry.ts';
import type { AppState } from './state.ts';

export interface SceneResult {
  scene: RenderScene;
  hiddenByFilter: { nodes: number; edges: number };
}

export function buildScene(state: AppState, geometry: Geometry, graph: VisibleGraph): SceneResult {
  const { model, outline, view, selection, search, filters } = state;
  const selectedNodes = new Set<string>(selection.nodeIds);
  const searching = search.query.trim() !== '';

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
      dimmed: searching && !search.matches.has(entity),
      hidden,
      style: { fill: style.fill, stroke: style.stroke, text: style.text, shape: style.shape },
    };

    if (isContainer && !isExpanded) {
      const count = descendantsOf(model, entity).length;
      if (count > 0) node.badge = String(count);
    }
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
      dimmed: searching && !sourceMatched && !targetMatched,
      hidden,
      style: {
        color: style.color,
        width: style.width + Math.min(3, Math.log2(v.count + 1) * 0.6),
        dash: allHeuristic && style.dash === null ? [6, 4] : style.dash,
        arrow: 'triangle',
      },
    });
  }

  return {
    scene: { nodes, edges },
    hiddenByFilter: { nodes: hiddenNodeCount, edges: hiddenEdgeCount },
  };
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
