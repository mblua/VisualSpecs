// The detail panel — where the product delivers its promise (§9.3).
//
//  * Click a node   → kind, REAL physical path, breadcrumb, metadata, evidence,
//                     child count, and its INTERNAL BUCKETS: *which* relations are
//                     hidden inside it, by kind, each drillable to its logical
//                     edges and their evidence. Not a bare number.
//  * Click an edge  → every logical relation behind the line: both endpoints,
//                     confidence, and evidence (path:line, plus the snippet if the
//                     document has one).
//
// It is ordinary focusable DOM: evidence is readable and copyable without touching
// the canvas.

import type { Evidence, VisualSpecsEdge, VisualSpecsNode } from '../contract/types.ts';
import { ancestryOf, descendantsOf } from '../contract/model.ts';
import type { Derived } from '../app/controller.ts';
import type { AppState } from '../app/state.ts';
import { edgeStyle, nodeStyle } from '../app/registry.ts';
import type { InternalBucket, InternalBucketId, VisibleEdge } from '../projection/types.ts';
import { clear, el } from './dom.ts';

export interface DetailCallbacks {
  onSelectNode(id: string): void;
  onExpandTo(id: string): void;
  /** Selecting an internal bucket goes through the ordinary command loop, exactly like
   *  selecting a node or an edge — so `aria-live` announces it and the state is real. */
  onSelectBucket(id: InternalBucketId): void;
  /** Fit an expanded container to its contents (Issue #13). This is the MANDATORY
   *  non-canvas route to the feature (§9.4, FIT-8): the on-canvas glyph is invisible to
   *  a screen reader and unusable at small zoom, so the panel must offer real DOM. */
  onFitContainer(id: string): void;
}

export function renderDetail(
  host: HTMLElement,
  state: AppState,
  derived: Derived,
  cb: DetailCallbacks,
): void {
  clear(host);

  const { selection } = state;
  if (selection.edgeId !== null) {
    const visible = derived.graph.visibleEdgeById.get(selection.edgeId as never);
    if (visible !== undefined) {
      host.appendChild(edgeDetail(state, visible, cb));
      return;
    }
    const bucket = derived.graph.internalBucketById.get(selection.edgeId as never);
    if (bucket !== undefined) {
      host.appendChild(bucketDetail(state, bucket, cb));
      return;
    }
  }

  const nodeId = selection.nodeIds[0];
  if (nodeId !== undefined) {
    host.appendChild(nodeDetail(state, derived, nodeId, cb));
    return;
  }

  host.appendChild(
    el('div', { class: 'empty' }, [
      el('p', {}, ['Nothing selected.']),
      el('p', { class: 'muted' }, [
        'Click a box to see what it is and what is hidden inside it. Click a line to see every relation behind it, with its evidence. Double-click to expand or collapse.',
      ]),
    ]),
  );
}

function nodeDetail(
  state: AppState,
  derived: Derived,
  outlineId: string,
  cb: DetailCallbacks,
): HTMLElement {
  const entity = state.outline.entityOf(outlineId);
  const node = state.model.nodeById.get(entity);
  if (node === undefined) return el('div', { class: 'empty' }, ['This node is not in the graph.']);

  const style = nodeStyle(node.kind);
  const children = state.outline.childrenOf(outlineId);
  const descendants = descendantsOf(state.model, entity);
  const buckets = derived.graph.internalBucketsByNode.get(outlineId) ?? [];

  const sections: HTMLElement[] = [
    el('header', { class: 'detail-head' }, [
      el('span', { class: 'chip', style: `--chip:${style.stroke}` }, [node.kind]),
      el('h2', {}, [node.label]),
    ]),
    breadcrumb(state, entity, cb),
  ];

  // The breadcrumb ALWAYS shows the physical path, in every hierarchy mode (§5.2).
  sections.push(
    kv([
      ['Physical path', node.path === undefined ? '—' : node.path === '' ? '(repository root)' : node.path],
      ['Direct children', String(children.length)],
      ['Everything inside', String(descendants.length)],
    ]),
  );

  // Fit to content — the accessible, keyboard-and-screen-reader route to the same
  // command the header glyph fires (§9.4 / FIT-8). Only meaningful on an EXPANDED
  // container; the command itself re-guards on childrenShown.
  if (children.length > 0 && state.view.expanded.has(outlineId)) {
    const isFitted = state.view.fitted.has(outlineId);
    const fitBtn = el(
      'button',
      {
        type: 'button',
        class: 'detail-action',
        title: 'Shrink this container to hug its contents, keeping the arrangement (H)',
      },
      [isFitted ? 'Re-fit to content' : 'Fit to content'],
    );
    fitBtn.addEventListener('click', () => cb.onFitContainer(outlineId));
    sections.push(el('div', { class: 'detail-actions' }, [fitBtn]));
  }

  if (node.metadata !== undefined && Object.keys(node.metadata).length > 0) {
    sections.push(
      section(
        'Metadata',
        kv(Object.entries(node.metadata).map(([k, v]) => [k, formatValue(v)])),
      ),
    );
  }

  if (node.evidence !== undefined && node.evidence.length > 0) {
    sections.push(section('Why this node exists', evidenceList(node.evidence)));
  }

  if (buckets.length > 0) {
    const total = buckets.reduce((n, b) => n + b.count, 0);
    sections.push(
      section(
        `Hidden inside this box — ${total} relation${total === 1 ? '' : 's'}`,
        el(
          'ul',
          { class: 'bucket-list' },
          buckets.map((b) => bucketRow(state, b, cb)),
        ),
        'Collapsing changed what you see, never what the graph is. These relations have both endpoints inside this box.',
      ),
    );
  }

  return el('div', { class: 'detail' }, sections);
}

function bucketRow(state: AppState, bucket: InternalBucket, cb: DetailCallbacks): HTMLElement {
  const style = edgeStyle(bucket.kind);
  const summary = el(
    'summary',
    { 'aria-label': `${bucket.count} ${bucket.kind} relations folded inside this box` },
    [
      el('span', { class: 'swatch', style: `--swatch:${style.color}` }, []),
      el('span', { class: 'bucket-kind' }, [bucket.kind]),
      el('span', { class: 'count' }, [`×${bucket.count}`]),
    ],
  );

  // A `<summary>` is natively focusable and activated by Enter and Space, so ONE click
  // handler serves the mouse and the keyboard. It opens the disclosure as before AND
  // selects the bucket — which is what makes it announceable. Before this, the panel
  // held an announcement for buckets that no UI could ever reach: the branch existed,
  // and nothing could get to it.
  summary.addEventListener('click', () => {
    cb.onSelectBucket(bucket.id);
  });

  const details = el('details', { class: 'bucket' }, [
    summary,
    logicalEdgeList(state, bucket.sourceEdgeIds, cb),
  ]);
  return el('li', {}, [details]);
}

function edgeDetail(state: AppState, visible: VisibleEdge, cb: DetailCallbacks): HTMLElement {
  const style = edgeStyle(visible.kind);
  const source = state.model.nodeById.get(state.outline.entityOf(visible.sourceId));
  const target = state.model.nodeById.get(state.outline.entityOf(visible.targetId));

  return el('div', { class: 'detail' }, [
    el('header', { class: 'detail-head' }, [
      el('span', { class: 'chip', style: `--chip:${style.color}` }, [visible.kind]),
      el('h2', {}, [`${source?.label ?? visible.sourceId} → ${target?.label ?? visible.targetId}`]),
    ]),
    el('p', { class: 'muted' }, [style.title]),
    section(
      `${visible.count} logical relation${visible.count === 1 ? '' : 's'} behind this line`,
      logicalEdgeList(state, visible.sourceEdgeIds, cb),
      visible.count > 1
        ? 'This one line stands for every relation below. Collapsing merged them; expanding resolves them back to their specific endpoints.'
        : undefined,
    ),
  ]);
}

function bucketDetail(state: AppState, bucket: InternalBucket, cb: DetailCallbacks): HTMLElement {
  const style = edgeStyle(bucket.kind);
  const containerEntity = state.outline.entityOf(bucket.containerId);
  const container = state.model.nodeById.get(containerEntity);

  const back = el('button', { type: 'button', class: 'link' }, [
    `← back to ${container?.label ?? bucket.containerId}`,
  ]);
  back.addEventListener('click', () => {
    cb.onSelectNode(containerEntity);
  });

  return el('div', { class: 'detail' }, [
    el('header', { class: 'detail-head' }, [
      el('span', { class: 'chip', style: `--chip:${style.color}` }, [bucket.kind]),
      el('h2', {}, [`Inside ${container?.label ?? bucket.containerId}`]),
    ]),
    el('nav', { class: 'breadcrumb' }, [back]),
    section(
      `${bucket.count} relation${bucket.count === 1 ? '' : 's'} with both endpoints in this box`,
      logicalEdgeList(state, bucket.sourceEdgeIds, cb),
      'Collapsing changed what you see, never what the graph is.',
    ),
  ]);
}

const MAX_LISTED = 300;

function logicalEdgeList(
  state: AppState,
  ids: readonly string[],
  cb: DetailCallbacks,
): HTMLElement {
  const shown = ids.slice(0, MAX_LISTED);
  const items = shown.map((id) => {
    const edge = state.model.edgeById.get(id);
    if (edge === undefined) return el('li', {}, [id]);
    return el('li', { class: 'logical' }, [logicalEdge(state, edge, cb)]);
  });

  const list = el('ul', { class: 'logical-list' }, items);
  if (ids.length > shown.length) {
    list.appendChild(
      el('li', { class: 'muted' }, [
        `… and ${ids.length - shown.length} more. All ${ids.length} ids are in the exported document; the panel lists the first ${MAX_LISTED}.`,
      ]),
    );
  }
  return list;
}

function logicalEdge(state: AppState, edge: VisualSpecsEdge, cb: DetailCallbacks): HTMLElement {
  const source = state.model.nodeById.get(edge.sourceId);
  const target = state.model.nodeById.get(edge.targetId);

  const head = el('div', { class: 'logical-head' }, [
    el('span', { class: `confidence ${edge.confidence}` }, [edge.confidence]),
    edge.label !== undefined ? el('code', { class: 'cmd' }, [edge.label]) : null,
  ]);

  const endpoints = el('div', { class: 'endpoints' }, [
    nodeLink(state, source, cb),
    el('span', { class: 'arrow' }, ['→']),
    nodeLink(state, target, cb),
  ]);

  const parts: (HTMLElement | null)[] = [head, endpoints];
  if (edge.evidence !== undefined && edge.evidence.length > 0) {
    parts.push(evidenceList(edge.evidence));
  }
  return el('div', {}, parts);
}

function nodeLink(
  state: AppState,
  node: VisualSpecsNode | undefined,
  cb: DetailCallbacks,
): HTMLElement {
  if (node === undefined) return el('span', {}, ['(unknown)']);
  const b = el('button', { type: 'button', class: 'link', title: node.path ?? node.id }, [
    node.path !== undefined && node.path !== '' ? node.path : node.label,
  ]);
  b.addEventListener('click', () => {
    cb.onExpandTo(node.id);
    cb.onSelectNode(node.id);
  });
  return b;
}

function evidenceList(evidence: readonly Evidence[]): HTMLElement {
  return el(
    'ul',
    { class: 'evidence' },
    evidence.map((e) => {
      const where = e.line === undefined ? e.path : `${e.path}:${e.line}`;
      const parts: (HTMLElement | string)[] = [el('code', {}, [where])];
      if (e.note !== undefined) parts.push(el('span', { class: 'note' }, [e.note]));
      if (e.snippet !== undefined) parts.push(el('pre', { class: 'snippet' }, [e.snippet]));
      return el('li', {}, parts);
    }),
  );
}

function breadcrumb(state: AppState, entity: string, cb: DetailCallbacks): HTMLElement {
  const chain = ancestryOf(state.model, entity);
  const parts: (HTMLElement | string)[] = [];
  chain.forEach((id, i) => {
    const node = state.model.nodeById.get(id);
    if (node === undefined) return;
    if (i > 0) parts.push(el('span', { class: 'sep' }, ['/']));
    if (id === entity) {
      parts.push(el('span', { class: 'here' }, [node.label]));
      return;
    }
    const b = el('button', { type: 'button', class: 'link' }, [node.label]);
    b.addEventListener('click', () => {
      cb.onSelectNode(id);
    });
    parts.push(b);
  });
  return el('nav', { class: 'breadcrumb', 'aria-label': 'Breadcrumb' }, parts);
}

function section(title: string, body: HTMLElement, note?: string): HTMLElement {
  return el('section', {}, [
    el('h3', {}, [title]),
    note !== undefined ? el('p', { class: 'muted' }, [note]) : null,
    body,
  ]);
}

function kv(pairs: readonly (readonly [string, string])[]): HTMLElement {
  const dl = el('dl', { class: 'kv' }, []);
  for (const [k, v] of pairs) {
    dl.appendChild(el('dt', {}, [k]));
    dl.appendChild(el('dd', {}, [v]));
  }
  return dl;
}

function formatValue(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v === null) return 'null';
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}
