// src/ports/renderer.ts — NO graphics-library type appears in this file (§8.1).
// Colours are hex strings, sizes are numbers, shapes are string literals.
//
// `render(scene)` is DECLARATIVE and IDEMPOTENT: the controller hands over a
// complete scene and the adapter diffs it. The controller never issues
// addNode/removeEdge imperatives — an imperative port would smear rendering state
// across the controller and defeat the entire exercise.

/**
 * The viewport, and the ONE coordinate convention every adapter owes the port:
 *
 *   screen = (world - {viewport.x, viewport.y}) * viewport.zoom
 *
 * relative to the top-left of the host element. Stating it here is what lets a
 * shared test drive real pointer events at a known world position without knowing
 * anything about the adapter's internals — and it is still only numbers, so no
 * graphics library leaks into this file.
 */
export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

/** `cut-rect` — a rectangle with a clipped top-right corner. It exists so that a
 *  Rust `crate` is distinguishable from an npm `package` by SHAPE and not only by
 *  colour, which is what an accessible legend actually needs. An adapter that does
 *  not know a shape must fall back to `rect` rather than fail. */
export type NodeShape = 'rect' | 'round-rect' | 'hex' | 'cut-rect';
export type ArrowShape = 'triangle' | 'none';

export interface RenderNode {
  id: string;
  kind: string;
  label: string;
  /** absolute world centre — domain-authoritative */
  position: { x: number; y: number };
  /** domain-authoritative (§7) */
  size: { w: number; h: number };
  isContainer: boolean;
  isExpanded: boolean;
  /** containers render behind their children */
  z: number;
  selected: boolean;
  /**
   * How strongly this element is attenuated. `1` is full strength; the port never
   * sees `0` (`assertSceneWellFormed`).
   *
   * REQUIRED, and one number rather than a flag plus a level. Two fields that both
   * mean "how faded" have an undefined interaction — `{dimmed: true, alpha: 0.9}`
   * has no answer in this contract, so each adapter would invent one — and an enum
   * of REASONS would force the adapter to hold the policy table, i.e. to learn what
   * search and focus are. The port is handed the resolved number; WHY something is
   * faded is the scene's business, and the strengths live in `app/scene.ts`.
   */
  opacity: number;
  hidden: boolean;
  style: { fill: string; stroke: string; text: string; shape: NodeShape };
  badge?: string;
  /**
   * A short presentational glyph, chosen by the scene, drawn beside the badge.
   * Exactly the `badge` bargain: the port renders it without knowing what it means.
   * A field named for its meaning — `subtreeHasOutOfFocus` and friends — would put
   * an application concept into the port, which is the thing this file does not do.
   */
  marker?: string;
  /** The user has "fit to content" this container (Issue #13). Purely presentational:
   *  the fit glyph is drawn filled when true, outline when false/absent. Absent → not
   *  fitted. Only meaningful on an expanded container. */
  fitted?: boolean;
}

export interface RenderEdge {
  id: string;
  kind: string;
  sourceId: string;
  targetId: string;
  count: number;
  /** e.g. "×34" */
  label?: string;
  selected: boolean;
  /** See `RenderNode.opacity`. An aggregate's value is not a bit: a line standing for
   *  many relations can be partly attenuated (§4.3 of the focus RFC). */
  opacity: number;
  hidden: boolean;
  style: { color: string; width: number; dash: readonly number[] | null; arrow: ArrowShape };
}

/**
 * One rank's lane behind the boxes of an expanded container (Issue #44).
 *
 * Identity is the STRUCTURED PAIR `(containerId, rank)`, never `container + '#L' + rank`:
 * an outline id is an opaque string from an untrusted document and can contain any
 * delimiter, which is the §6.3 defect this repository already paid for once.
 *
 * `rects` is one or more rectangles because a band bites out exactly its intersection
 * with any box of another rank — so it never contains a part of a box it does not speak
 * for. Ordered by `(y, x)` and non-overlapping, which `assertSceneWellFormed` checks on
 * every render: that is what turns the clip's determinism into something verified
 * continuously rather than only in a test.
 *
 * A band is PICTORIAL. It is not hit-tested: a click on a band is a click on the
 * container, exactly as it is today.
 */
export interface RenderBand {
  containerId: string;
  rank: number;
  rects: readonly Rect[];
  /** Behind the container's children, in front of the container itself. */
  z: number;
  /** e.g. "L3" — the port draws it without knowing what it means. */
  label: string;
  style: { fill: string; text: string };
  opacity: number;
  hidden: boolean;
}

export interface RenderScene {
  nodes: readonly RenderNode[];
  edges: readonly RenderEdge[];
  /**
   * OPTIONAL, so an adapter that predates level bands keeps compiling and keeps
   * working. One that ignores them loses the perceptual aid and loses NO information:
   * the rank travels in the node's badge, which is the authority. Same honest
   * degradation as "an adapter that does not know a shape falls back to `rect`".
   */
  bands?: readonly RenderBand[];
}

export type RendererEvent =
  | { type: 'node:click'; id: string; additive: boolean }
  | { type: 'node:dblclick'; id: string }
  | { type: 'node:dragend'; id: string; position: { x: number; y: number } }
  | { type: 'edge:click'; id: string }
  // A right-click that landed on a node (Issue #17 §8.3.1). It exists because a
  // `file` has no sidebar row while the search box is empty — 807 of 817 entities on
  // the real corpus — so for most of the graph the canvas is the ONLY surface a
  // person can act on. It is its own event rather than a flag on `node:click` for the
  // same reason `container:fit` is: a right-click is not a selection gesture, and
  // folding it in would make every menu open also mean "and toggle whatever a click
  // would have toggled".
  //
  // `client` is the pointer in CLIENT coordinates, because a menu is anchored to the
  // pointer and not to the world. Still only numbers, and the port already states the
  // screen↔world relation at the top of this file, so nothing leaks.
  | { type: 'node:contextmenu'; id: string; client: { x: number; y: number } }
  | { type: 'background:click' }
  // The per-container "fit to content" control on an expanded header (Issue #13).
  // It is its OWN event, not a node:click: the control is the first interactive
  // sub-region of a node, and folding it into node:click would make a fit collapse
  // the box on the second tap (the same class of bug resolveTarget already guards
  // for a line crossing a container). The controller maps it to FitContainer.
  | { type: 'container:fit'; id: string }
  | { type: 'viewport:change'; viewport: Viewport };

export interface GraphRenderer {
  mount(host: HTMLElement): void;
  /** declarative, idempotent */
  render(scene: RenderScene): void;
  on(handler: (e: RendererEvent) => void): () => void;
  /**
   * Fit the content to the host.
   *
   * `fit()` and `zoomBy()` MOVE THE CAMERA, so they emit `viewport:change` — they are
   * the renderer's own decision, and the controller learns about them the same way it
   * learns about a wheel or a pan. `setViewport()` does NOT emit, because the controller
   * is the one calling it, and an echo would be a feedback loop.
   */
  fit(ids?: readonly string[]): void;
  /**
   * Multiply the zoom by `factor`, keeping the CENTRE of the host fixed.
   *
   * The controller cannot do this itself: `screen = (world - viewport) * zoom` needs
   * the host's pixel size to know what "the centre" is, and the host belongs to the
   * adapter. It is still only numbers, so no graphics type leaks — and it is what
   * lets the toolbar's Zoom buttons and the `+`/`-` keys work through the ordinary
   * command loop instead of reaching into Canvas2D from the UI.
   */
  zoomBy(factor: number): void;
  getViewport(): Viewport;
  setViewport(v: Viewport): void;
  resize(): void;
  /** idempotent */
  destroy(): void;
}

// ---------------------------------------------------------------------------
// The expanded-container header, and its fit-to-content control, are part of the
// CONTRACT — like edge routing — not an adapter's private taste (Issue #13).
//
// The control is the first INTERACTIVE sub-region of a node in this renderer:
// hit-testing whole boxes is not enough for it. Stating its world rectangle here is
// what lets the shared conformance suite drive a real click at the glyph without any
// adapter-private knowledge, exactly as `routeEdges` lets a test know where a line is.
// ---------------------------------------------------------------------------

/** The header strip height of an expanded container, in world units. MUST equal the
 *  domain's `CONTAINER_HEADER`; the port may not import the domain, so it is restated
 *  here as the rendering contract every adapter draws to. */
export const HEADER_STRIP_HEIGHT = 30;

/** The fit-to-content control's square and its inset from the box's right/top, world units. */
export const HEADER_CONTROL_SIZE = 14;
export const HEADER_CONTROL_MARGIN = 9;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The world-space rectangle of a container's fit-to-content control. Only meaningful
 *  for an EXPANDED container (its header is where the control lives). The adapter DRAWS
 *  here and hit-tests here; the conformance suite CLICKS here. One source of truth. */
export function headerControlRect(node: {
  position: { x: number; y: number };
  size: { w: number; h: number };
}): Rect {
  const left = node.position.x - node.size.w / 2;
  const top = node.position.y - node.size.h / 2;
  return {
    x: left + node.size.w - HEADER_CONTROL_MARGIN - HEADER_CONTROL_SIZE,
    y: top + (HEADER_STRIP_HEIGHT - HEADER_CONTROL_SIZE) / 2,
    w: HEADER_CONTROL_SIZE,
    h: HEADER_CONTROL_SIZE,
  };
}

// ---------------------------------------------------------------------------
// Edge routing is part of the CONTRACT, not of an adapter's taste.
//
// §6.3 says that `bundles` and `imports` between the same visible pair "stay two
// edges: they are different facts and must not merge into a meaningless ×2". On the
// real dataset the root npm package and the Tauri crate are joined by FOUR of them
// — bundles, imports, tauri-command, web-command. Keeping them distinct in the
// model and then drawing them on top of one another is the same lie told in
// pixels: you cannot see them, and you cannot click the one you want.
//
// So the fan-out is defined here, in numbers, and every adapter draws it the same
// way. It is also what lets a test know where a line actually IS.
// ---------------------------------------------------------------------------

export interface Point {
  x: number;
  y: number;
}

/** Perpendicular separation between parallel relations, in world units. Wide enough
 *  that the count labels (an 18px pill) sitting at each curve's midpoint do not
 *  collide — four relations between one pair is the normal case here, not the edge
 *  case, and overlapping labels are unreadable. */
export const EDGE_FAN_SPACING = 26;

export interface EdgeRoute {
  /** On the source box's border. */
  a: Point;
  /** On the target box's border. */
  b: Point;
  /** Quadratic control point. */
  control: Point;
  /** The point the curve actually passes through at its middle — where the count
   *  label sits, and the most natural place to click. */
  mid: Point;
}

/** Deterministic: the scene's edge order fixes each edge's place in the fan. */
export function edgeFanOffsets(edges: readonly RenderEdge[]): Map<string, number> {
  // Nested maps, keyed by the endpoint ids themselves. Nothing is concatenated, so
  // an id containing any delimiter cannot collide with another (§6.3).
  const byPair = new Map<string, Map<string, RenderEdge[]>>();
  for (const e of edges) {
    const lo = e.sourceId <= e.targetId ? e.sourceId : e.targetId;
    const hi = e.sourceId <= e.targetId ? e.targetId : e.sourceId;
    let inner = byPair.get(lo);
    if (inner === undefined) {
      inner = new Map<string, RenderEdge[]>();
      byPair.set(lo, inner);
    }
    const list = inner.get(hi);
    if (list === undefined) inner.set(hi, [e]);
    else list.push(e);
  }

  const offsets = new Map<string, number>();
  for (const [, inner] of byPair) {
    for (const [, list] of inner) {
      const n = list.length;
      list.forEach((e, i) => {
        offsets.set(e.id, (i - (n - 1) / 2) * EDGE_FAN_SPACING);
      });
    }
  }
  return offsets;
}

export function routeEdges(scene: RenderScene): Map<string, EdgeRoute> {
  const byId = new Map<string, RenderNode>();
  for (const n of scene.nodes) byId.set(n.id, n);
  const offsets = edgeFanOffsets(scene.edges);

  const routes = new Map<string, EdgeRoute>();
  for (const e of scene.edges) {
    const s = byId.get(e.sourceId);
    const t = byId.get(e.targetId);
    if (s === undefined || t === undefined) continue;

    const a = borderPoint(s.position, s.size, t.position);
    const b = borderPoint(t.position, t.size, s.position);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const offset = offsets.get(e.id) ?? 0;
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;

    routes.set(e.id, {
      a,
      b,
      // A quadratic whose control point is twice the offset passes exactly through
      // `mid` at t = 0.5, so the label and the click target agree with the curve.
      control: { x: cx + nx * offset * 2, y: cy + ny * offset * 2 },
      mid: { x: cx + nx * offset, y: cy + ny * offset },
    });
  }
  return routes;
}

export function pointOnEdge(route: EdgeRoute, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * route.a.x + 2 * u * t * route.control.x + t * t * route.b.x,
    y: u * u * route.a.y + 2 * u * t * route.control.y + t * t * route.b.y,
  };
}

/** Distance from a world point to the drawn curve, by sampling it. */
export function distanceToEdge(route: EdgeRoute, p: Point, samples = 24): number {
  let best = Infinity;
  let previous = pointOnEdge(route, 0);
  for (let i = 1; i <= samples; i += 1) {
    const current = pointOnEdge(route, i / samples);
    best = Math.min(best, distanceToSegment(p, previous, current));
    previous = current;
  }
  return best;
}

/** Where the line between two boxes should start and stop: on their borders. */
export function borderPoint(centre: Point, size: { w: number; h: number }, towards: Point): Point {
  const dx = towards.x - centre.x;
  const dy = towards.y - centre.y;
  if (dx === 0 && dy === 0) return { ...centre };
  const scale = Math.min(
    dx === 0 ? Infinity : size.w / 2 / Math.abs(dx),
    dy === 0 ? Infinity : size.h / 2 / Math.abs(dy),
  );
  return { x: centre.x + dx * scale, y: centre.y + dy * scale };
}

export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2));
  return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
}

export class MalformedSceneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedSceneError';
  }
}

/** Every adapter runs this on the scene it is handed. A malformed scene is a bug
 *  in the controller, and it must surface as an error, not as a blank canvas. */
export function assertSceneWellFormed(scene: RenderScene): void {
  if (!Array.isArray(scene.nodes) || !Array.isArray(scene.edges)) {
    throw new MalformedSceneError('scene must carry a nodes array and an edges array');
  }
  const ids = new Set<string>();
  for (const n of scene.nodes) {
    if (typeof n.id !== 'string' || n.id === '') {
      throw new MalformedSceneError('every scene node needs a non-empty id');
    }
    if (ids.has(n.id)) throw new MalformedSceneError(`duplicate scene node id: ${n.id}`);
    ids.add(n.id);
    if (!Number.isFinite(n.position.x) || !Number.isFinite(n.position.y)) {
      throw new MalformedSceneError(`node ${n.id} has a non-finite position`);
    }
    if (!Number.isFinite(n.size.w) || !Number.isFinite(n.size.h) || n.size.w < 0 || n.size.h < 0) {
      throw new MalformedSceneError(`node ${n.id} has an invalid size`);
    }
    assertOpacity(n.opacity, `node ${n.id}`);
  }
  const edgeIds = new Set<string>();
  for (const e of scene.edges) {
    if (typeof e.id !== 'string' || e.id === '') {
      throw new MalformedSceneError('every scene edge needs a non-empty id');
    }
    if (edgeIds.has(e.id)) throw new MalformedSceneError(`duplicate scene edge id: ${e.id}`);
    edgeIds.add(e.id);
    if (!ids.has(e.sourceId)) {
      throw new MalformedSceneError(`edge ${e.id} names a source node that is not in the scene`);
    }
    if (!ids.has(e.targetId)) {
      throw new MalformedSceneError(`edge ${e.id} names a target node that is not in the scene`);
    }
    assertOpacity(e.opacity, `edge ${e.id}`);
  }
  assertBandsWellFormed(scene, byId(scene.nodes));
}

function byId(nodes: readonly RenderNode[]): Map<string, RenderNode> {
  const out = new Map<string, RenderNode>();
  for (const n of nodes) out.set(n.id, n);
  return out;
}

/**
 * Bands get the same rigour as nodes and edges, plus the two properties that are
 * specific to them (Issue #44):
 *
 *  - **Canonical order**: `rects` sorted by `(y, x)` and non-overlapping. The clip is a
 *    Y sweep with merged X intervals; a botched merge leaves rects out of order or
 *    overlapping, and this catches it AT THE RENDER instead of waiting for someone to
 *    compare two runs.
 *  - **Containment**: every rect inside its container's box. A band outside asserts a
 *    level over space that belongs to — and is laid out by — somebody else. Measured
 *    violation before this existed: after a fit under one basis and a toggle to the
 *    other, `src-tauri/src` drew 566 px of zebra below its own bottom edge.
 *
 * Containment is the belt: the correspondence condition in the domain is what stops the
 * scene from getting here at all. Both, for different reasons.
 */
function assertBandsWellFormed(scene: RenderScene, nodes: Map<string, RenderNode>): void {
  if (scene.bands === undefined) return;
  for (const band of scene.bands) {
    const where = `band ${band.containerId} L${String(band.rank)}`;
    if (!Number.isInteger(band.rank) || band.rank < 0) {
      throw new MalformedSceneError(`${where} has a non-integral rank`);
    }
    if (!Array.isArray(band.rects) || band.rects.length === 0) {
      throw new MalformedSceneError(`${where} carries no rects — a band with none is not emitted`);
    }
    assertOpacity(band.opacity, where);

    const owner = nodes.get(band.containerId);
    if (owner === undefined) {
      throw new MalformedSceneError(`${where} names a container that is not in the scene`);
    }
    const left = owner.position.x - owner.size.w / 2;
    const top = owner.position.y - owner.size.h / 2;

    band.rects.forEach((rect, i) => {
      if (
        !Number.isFinite(rect.x) ||
        !Number.isFinite(rect.y) ||
        !Number.isFinite(rect.w) ||
        !Number.isFinite(rect.h) ||
        rect.w < 0 ||
        rect.h < 0
      ) {
        throw new MalformedSceneError(`${where} has an invalid rect`);
      }
      // A half-pixel of tolerance: the domain rounds container sizes to integers and the
      // band takes its padding from a gap that can be odd.
      if (
        rect.x < left - 0.5 ||
        rect.y < top - 0.5 ||
        rect.x + rect.w > left + owner.size.w + 0.5 ||
        rect.y + rect.h > top + owner.size.h + 0.5
      ) {
        throw new MalformedSceneError(`${where} draws outside its container box`);
      }
      const previous = band.rects[i - 1];
      if (previous !== undefined) {
        const ordered = previous.y < rect.y || (previous.y === rect.y && previous.x <= rect.x);
        if (!ordered) throw new MalformedSceneError(`${where} has rects out of (y, x) order`);
      }
      // Against EVERY earlier rect, not only the previous one: with a correct Y sweep
      // the strips are disjoint so the neighbour check would do, but a botched sweep is
      // exactly what this exists to catch, and then the overlap need not be adjacent.
      // `rects` per band is single digits, so the quadratic pass is free.
      for (let j = 0; j < i; j += 1) {
        const other = band.rects[j] as Rect;
        const overlaps =
          other.x < rect.x + rect.w &&
          rect.x < other.x + other.w &&
          other.y < rect.y + rect.h &&
          rect.y < other.y + other.h;
        if (overlaps) throw new MalformedSceneError(`${where} has overlapping rects`);
      }
    });
  }
}

/**
 * I-F6 at the port boundary, rather than as prose in a plan.
 *
 * `0` is excluded on purpose: an element the port is handed is an element the user
 * can still see, select and inspect. Attenuating something to nothing while it stays
 * in the hit-test produces a target you can click and cannot find — which is worse
 * than hiding it, and `hidden` is how a scene says "do not draw this".
 */
function assertOpacity(opacity: number, where: string): void {
  if (!Number.isFinite(opacity) || opacity <= 0 || opacity > 1) {
    throw new MalformedSceneError(`${where} has an opacity outside (0, 1]: ${String(opacity)}`);
  }
}
