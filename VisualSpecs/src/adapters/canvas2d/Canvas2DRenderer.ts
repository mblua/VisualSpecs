// The v1 adapter: a hand-rolled Canvas 2D renderer.
//
// §8.2 framed the renderer as a GATE, not an assumption: Cytoscape.js without
// compound nodes must pass conformance and the browser smoke, "and if it does
// not, it is replaced by a hand-rolled Canvas 2D adapter". The gate was decided
// against Cytoscape, deliberately, and the reasoning is recorded in
// docs/ADR-0002-renderer.md rather than buried here. The short version: with
// compound nodes ruled out (they own position and size, and the port says the
// domain does), what Cytoscape still sells us is canvas drawing, pan/zoom,
// hit-testing and event plumbing — which is exactly this file, at 400 lines and
// zero runtime dependencies, with full control of the drawing.
//
// Nothing above `ports/` knows this file exists. Swapping it back to Cytoscape
// changes THIS FILE and src/main.ts, and the architecture test enforces that.

import {
  assertSceneWellFormed,
  distanceToEdge,
  headerControlRect,
  routeEdges,
  HEADER_STRIP_HEIGHT,
  type EdgeRoute,
  type GraphRenderer,
  type RenderEdge,
  type RenderNode,
  type RenderScene,
  type RendererEvent,
  type Viewport,
} from '../../ports/renderer.ts';

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 8;
const DRAG_THRESHOLD = 3;
const DBLCLICK_MS = 320;
const DBLCLICK_SLOP = 6;
const EDGE_HIT_TOLERANCE = 7;
/** Extra hit slop around the fit control, in SCREEN pixels — keeps the small glyph a
 *  comfortable target at any zoom, the same trick `hitEdge` uses for a thin line. */
const CONTROL_HIT_SLOP = 5;
const FIT_PADDING = 60;

interface Pointer {
  startClient: { x: number; y: number };
  startWorld: { x: number; y: number };
  /** Right-button gestures always pan, even when they start over a node. */
  panOnly: boolean;
  /** The fit control the press landed on, if any. Set here so onPointerMove can
   *  SUPPRESS the container drag (FIT-2): a press on the glyph never moves the box. */
  controlId: string | null;
  nodeId: string | null;
  nodeStart: { x: number; y: number } | null;
  dragging: boolean;
  panStart: { x: number; y: number } | null;
}

interface ClickTarget {
  kind: 'node' | 'edge' | 'background' | 'control';
  id: string | null;
}

export class Canvas2DRenderer implements GraphRenderer {
  private host: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private scene: RenderScene = { nodes: [], edges: [] };
  private viewport: Viewport = { x: 0, y: 0, zoom: 1 };
  private handlers = new Set<(e: RendererEvent) => void>();
  private destroyed = false;

  private pointer: Pointer | null = null;
  /** While dragging, the node is drawn here instead of at its scene position. */
  private dragOverride: { id: string; x: number; y: number } | null = null;
  /** The fit control currently under the hovering pointer — drawn highlighted, so the
   *  first interactive header region is discoverable on a canvas that has no tooltip. */
  private hoverControlId: string | null = null;
  private lastClick:
    | { kind: ClickTarget['kind']; id: string | null; t: number; x: number; y: number }
    | null = null;
  private frame = 0;
  private resizeObserver: ResizeObserver | null = null;
  private cleanups: (() => void)[] = [];

  mount(host: HTMLElement): void {
    this.host = host;
    const canvas = host.ownerDocument.createElement('canvas');
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.touchAction = 'none';
    canvas.style.cursor = 'grab';
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'Repository map. Use the node list panel for a keyboard-navigable view.');
    host.appendChild(canvas);
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    const on = <K extends keyof HTMLElementEventMap>(
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
      opts?: AddEventListenerOptions,
    ): void => {
      canvas.addEventListener(type, fn as EventListener, opts);
      this.cleanups.push(() => canvas.removeEventListener(type, fn as EventListener, opts));
    };

    on('pointerdown', (e) => this.onPointerDown(e));
    on('pointermove', (e) => this.onPointerMove(e));
    on('pointerup', (e) => this.onPointerUp(e));
    on('pointercancel', () => this.onPointerCancel());
    on('wheel', (e) => this.onWheel(e), { passive: false });
    on('contextmenu', (e) => e.preventDefault());
    // Native dblclick is suppressed: this adapter derives it from pointer events,
    // so behaviour is identical under synthetic events in a test.
    on('dblclick', (e) => e.preventDefault());

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(host);
    }
    this.resize();
  }

  render(scene: RenderScene): void {
    if (this.destroyed) throw new Error('render() after destroy()');
    assertSceneWellFormed(scene);
    this.scene = scene;
    this.draw();
  }

  on(handler: (e: RendererEvent) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  fit(ids?: readonly string[]): void {
    const canvas = this.canvas;
    if (canvas === null) return;
    const wanted =
      ids === undefined
        ? this.scene.nodes.filter((n) => !n.hidden)
        : this.scene.nodes.filter((n) => ids.includes(n.id) && !n.hidden);
    if (wanted.length === 0) return;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of wanted) {
      minX = Math.min(minX, n.position.x - n.size.w / 2);
      minY = Math.min(minY, n.position.y - n.size.h / 2);
      maxX = Math.max(maxX, n.position.x + n.size.w / 2);
      maxY = Math.max(maxY, n.position.y + n.size.h / 2);
    }

    const cw = canvas.clientWidth || 1;
    const ch = canvas.clientHeight || 1;
    const w = Math.max(1, maxX - minX);
    const h = Math.max(1, maxY - minY);
    const zoom = clamp(
      Math.min((cw - FIT_PADDING * 2) / w, (ch - FIT_PADDING * 2) / h),
      MIN_ZOOM,
      MAX_ZOOM,
    );
    // screen = (world - viewport) * zoom  →  centre the content.
    const x = minX + w / 2 - cw / (2 * zoom);
    const y = minY + h / 2 - ch / (2 * zoom);
    this.viewport = { x, y, zoom };
    this.draw();
    this.emit({ type: 'viewport:change', viewport: { ...this.viewport } });
  }

  /** Zoom about the CENTRE of the host — the same maths as the wheel, minus a cursor. */
  zoomBy(factor: number): void {
    const canvas = this.canvas;
    if (canvas === null) return;
    const cx = (canvas.clientWidth || 1) / 2;
    const cy = (canvas.clientHeight || 1) / 2;
    const zoom = clamp(this.viewport.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    const wx = cx / this.viewport.zoom + this.viewport.x;
    const wy = cy / this.viewport.zoom + this.viewport.y;
    this.viewport = { x: wx - cx / zoom, y: wy - cy / zoom, zoom };
    this.draw();
    this.emit({ type: 'viewport:change', viewport: { ...this.viewport } });
  }

  getViewport(): Viewport {
    return { ...this.viewport };
  }

  setViewport(v: Viewport): void {
    this.viewport = { x: v.x, y: v.y, zoom: clamp(v.zoom, MIN_ZOOM, MAX_ZOOM) };
    this.draw();
  }

  resize(): void {
    const canvas = this.canvas;
    const ctx = this.ctx;
    if (canvas === null || ctx === null) return;
    const dpr = globalThis.devicePixelRatio ?? 1;
    const w = Math.max(1, canvas.clientWidth);
    const h = Math.max(1, canvas.clientHeight);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    this.draw();
  }

  destroy(): void {
    if (this.destroyed) return; // idempotent
    this.destroyed = true;
    for (const off of this.cleanups) off();
    this.cleanups = [];
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.handlers.clear();
    if (this.canvas !== null && this.canvas.parentNode !== null) {
      this.canvas.parentNode.removeChild(this.canvas);
    }
    this.canvas = null;
    this.ctx = null;
    this.host = null;
  }

  // --- input ---------------------------------------------------------------

  private toWorld(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const canvas = this.canvas;
    if (canvas === null) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / this.viewport.zoom + this.viewport.x,
      y: (e.clientY - rect.top) / this.viewport.zoom + this.viewport.y,
    };
  }

  private onPointerDown(e: PointerEvent): void {
    if (this.canvas === null) return;
    if (e.button !== 0 && e.button !== 2) return;
    const panOnly = e.button === 2;
    if (panOnly) e.preventDefault();
    try {
      // Synthetic pointers have no active pointer id; capture is an optimisation,
      // never a requirement, so a failure here must not break the interaction.
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* no capture available */
    }
    const world = this.toWorld(e);
    // The fit control is resolved FIRST, and it OWNS the gesture: no node is retained,
    // no drag or pan is armed. This is what makes a press on the glyph fit the box on
    // release and never move it (FIT-2), and never be reinterpreted as a container drag.
    const controlId = panOnly ? null : this.hitHeaderControl(world);
    // The right button is an unconditional canvas gesture. Do not even retain the
    // node under the pointer: that makes it impossible for a later move/up branch
    // to reinterpret the gesture as a component drag or selection.
    const node = panOnly || controlId !== null ? null : this.hitNode(world);
    this.pointer = {
      startClient: { x: e.clientX, y: e.clientY },
      startWorld: world,
      panOnly,
      controlId,
      nodeId: node?.id ?? null,
      nodeStart: node === null ? null : { ...node.position },
      dragging: false,
      // A control press pans nothing (panStart null) and drags nothing (nodeId null):
      // only the background or a right-button press pans.
      panStart:
        panOnly || (node === null && controlId === null)
          ? { x: this.viewport.x, y: this.viewport.y }
          : null,
    };
    if (this.canvas !== null) this.canvas.style.cursor = 'grabbing';
  }

  private onPointerMove(e: PointerEvent): void {
    const p = this.pointer;
    if (p === null) {
      if (this.canvas !== null) {
        const world = this.toWorld(e);
        const overControl = this.hitHeaderControl(world);
        // Highlight the fit glyph on hover — the only discoverability a tooltip-less
        // canvas can offer for the header's first interactive region. Redraw only on a
        // change, so a plain hover does not repaint every pointermove.
        if (overControl !== this.hoverControlId) {
          this.hoverControlId = overControl;
          this.draw();
        }
        const hovering = overControl !== null || this.hitNode(world) !== null || this.hitEdge(world) !== null;
        this.canvas.style.cursor = hovering ? 'pointer' : 'grab';
      }
      return;
    }

    const dxClient = e.clientX - p.startClient.x;
    const dyClient = e.clientY - p.startClient.y;
    if (!p.dragging && Math.hypot(dxClient, dyClient) < DRAG_THRESHOLD) return;
    p.dragging = true;

    if (p.nodeId !== null && p.nodeStart !== null) {
      this.dragOverride = {
        id: p.nodeId,
        x: p.nodeStart.x + dxClient / this.viewport.zoom,
        y: p.nodeStart.y + dyClient / this.viewport.zoom,
      };
      this.draw();
      return;
    }

    if (p.panStart !== null) {
      this.viewport = {
        x: p.panStart.x - dxClient / this.viewport.zoom,
        y: p.panStart.y - dyClient / this.viewport.zoom,
        zoom: this.viewport.zoom,
      };
      this.draw();
      this.emit({ type: 'viewport:change', viewport: { ...this.viewport } });
    }
  }

  /**
   * WHAT DID THE USER CLICK? Resolved once, before anything else is decided.
   *
   * An EXPANDED container is a backdrop, not a target: the edges between its own
   * children are drawn straight across it, and letting it swallow those clicks makes
   * an aggregated relation unselectable — which is exactly the click this product
   * exists to serve. So a line within tolerance wins over a container's BACKGROUND,
   * and never over a leaf or a collapsed box: if you clicked a solid box, you meant
   * the box.
   *
   * Resolving the target FIRST is what makes the double-click safe. The first cut
   * derived the double-click from `p.nodeId` — the node *under the pointer* — before
   * deciding that an edge had won. Two clicks on a line crossing a container
   * therefore emitted `node:dblclick` on the container and COLLAPSED IT: you tried
   * to inspect a relation and the box shut in your face. Only a node target may
   * produce a double-click; two clicks on a line are two clicks on the line.
   */
  private resolveTarget(p: Pointer): ClickTarget {
    // The fit control is resolved FIRST — before edge and node — mirroring the
    // edge-vs-backdrop discipline below. It is the ONLY way two quick taps on the glyph
    // cannot become a node:dblclick that collapses the box (FIT-3).
    if (p.controlId !== null) return { kind: 'control', id: p.controlId };

    const edge = this.hitEdge(p.startWorld);
    const node = p.nodeId === null ? undefined : this.scene.nodes.find((n) => n.id === p.nodeId);
    const isBackdrop = node !== undefined && node.isContainer && node.isExpanded;

    if (edge !== null && (node === undefined || isBackdrop)) return { kind: 'edge', id: edge.id };
    if (node !== undefined) return { kind: 'node', id: node.id };
    return { kind: 'background', id: null };
  }

  private onPointerUp(e: PointerEvent): void {
    const p = this.pointer;
    this.pointer = null;
    if (this.canvas !== null) this.canvas.style.cursor = 'grab';
    if (p === null) return;

    // A drag emits EXACTLY ONE dragend, and never a click.
    if (p.dragging) {
      const override = this.dragOverride;
      this.dragOverride = null;
      if (p.nodeId !== null && override !== null) {
        this.emit({
          type: 'node:dragend',
          id: p.nodeId,
          position: { x: round(override.x), y: round(override.y) },
        });
      } else {
        this.draw();
      }
      this.lastClick = null;
      return;
    }

    // A stationary right click is neither a selection nor a background click. Its
    // only meaning is "the user entered canvas-pan mode"; the context menu is also
    // suppressed by the listener installed in mount().
    if (p.panOnly) {
      this.lastClick = null;
      return;
    }

    const target = this.resolveTarget(p);

    // A tap on the fit control fits the container and NOTHING else: it is never a
    // selection and never accumulates toward a double-click, so two taps fit twice
    // (idempotent at the domain) and can never collapse the box (FIT-3).
    if (target.kind === 'control' && target.id !== null) {
      this.lastClick = null;
      this.emit({ type: 'container:fit', id: target.id });
      return;
    }

    // Click vs double-click, both derived from pointer events, so a synthetic test
    // and a real mouse behave identically — and both keyed on the RESOLVED target.
    const now = Date.now();
    const previous = this.lastClick;
    const isDouble =
      previous !== null &&
      previous.kind === target.kind &&
      previous.id === target.id &&
      now - previous.t <= DBLCLICK_MS &&
      Math.hypot(e.clientX - previous.x, e.clientY - previous.y) <= DBLCLICK_SLOP;

    if (isDouble && target.kind === 'node' && target.id !== null) {
      this.lastClick = null;
      this.emit({ type: 'node:dblclick', id: target.id });
      return;
    }

    this.lastClick = { kind: target.kind, id: target.id, t: now, x: e.clientX, y: e.clientY };

    if (target.kind === 'edge' && target.id !== null) {
      // Two clicks on a line are two clicks on the line. They never collapse a box.
      this.emit({ type: 'edge:click', id: target.id });
      return;
    }
    if (target.kind === 'node' && target.id !== null) {
      this.emit({
        type: 'node:click',
        id: target.id,
        additive: e.shiftKey || e.metaKey || e.ctrlKey,
      });
      return;
    }
    this.emit({ type: 'background:click' });
  }

  private onPointerCancel(): void {
    this.pointer = null;
    this.dragOverride = null;
    this.draw();
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const canvas = this.canvas;
    if (canvas === null) return;
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;

    const factor = Math.exp(-e.deltaY * 0.0016);
    const zoom = clamp(this.viewport.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    // Keep the world point under the cursor fixed.
    const wx = cx / this.viewport.zoom + this.viewport.x;
    const wy = cy / this.viewport.zoom + this.viewport.y;
    this.viewport = { x: wx - cx / zoom, y: wy - cy / zoom, zoom };
    this.draw();
    this.emit({ type: 'viewport:change', viewport: { ...this.viewport } });
  }

  /**
   * The fit control under a world point, or null. Reuses the CACHED scene and scans
   * only expanded containers — never a geometry recompute (a per-pointermove recompute
   * would make hover cost a full layout). The rect comes from the port so the paint and
   * the hit agree, and a SCREEN-space slop keeps the small glyph a comfortable target.
   */
  private hitHeaderControl(world: { x: number; y: number }): string | null {
    const slop = CONTROL_HIT_SLOP / this.viewport.zoom;
    let best: RenderNode | null = null;
    for (const n of this.scene.nodes) {
      if (n.hidden || !n.isContainer || !n.isExpanded) continue;
      const r = headerControlRect(n);
      if (
        world.x >= r.x - slop &&
        world.x <= r.x + r.w + slop &&
        world.y >= r.y - slop &&
        world.y <= r.y + r.h + slop
      ) {
        // A deeper (higher-z) container wins if two headers ever overlap.
        if (best === null || n.z > best.z) best = n;
      }
    }
    return best?.id ?? null;
  }

  /** Topmost first: the deepest child wins over the container behind it. */
  private hitNode(world: { x: number; y: number }): RenderNode | null {
    const candidates = this.scene.nodes.filter((n) => !n.hidden && inBox(world, n));
    if (candidates.length === 0) return null;
    let best = candidates[0] as RenderNode;
    for (const n of candidates) {
      if (n.z > best.z) best = n;
      else if (n.z === best.z && area(n) < area(best)) best = n;
    }
    return best;
  }

  /** The scene as it is DRAWN: node positions include a live drag, and the edges
   *  are fanned out by the port's routing rule, so hit-testing and painting can
   *  never disagree about where a line is. */
  private drawnScene(): RenderScene {
    if (this.dragOverride === null) return this.scene;
    const override = this.dragOverride;
    return {
      nodes: this.scene.nodes.map((n) =>
        n.id === override.id ? { ...n, position: { x: override.x, y: override.y } } : n,
      ),
      edges: this.scene.edges,
    };
  }

  private hitEdge(world: { x: number; y: number }): RenderEdge | null {
    const routes = routeEdges(this.drawnScene());
    let best: RenderEdge | null = null;
    let bestDist = EDGE_HIT_TOLERANCE / this.viewport.zoom;
    for (const e of this.scene.edges) {
      if (e.hidden) continue;
      const route = routes.get(e.id);
      if (route === undefined) continue;
      const d = distanceToEdge(route, world);
      if (d < bestDist) {
        bestDist = d;
        best = e;
      }
    }
    return best;
  }

  private emit(event: RendererEvent): void {
    for (const handler of [...this.handlers]) handler(event);
  }

  // --- drawing -------------------------------------------------------------

  private draw(): void {
    if (this.destroyed) return;
    if (this.frame !== 0) return;
    this.frame = requestAnimationFrameSafe(() => {
      this.frame = 0;
      this.paint();
    });
  }

  private paint(): void {
    const canvas = this.canvas;
    const ctx = this.ctx;
    if (canvas === null || ctx === null) return;

    const dpr = globalThis.devicePixelRatio ?? 1;
    const cw = canvas.clientWidth || 1;
    const ch = canvas.clientHeight || 1;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0b0e16';
    ctx.fillRect(0, 0, cw, ch);
    this.paintGrid(ctx, cw, ch);

    ctx.save();
    ctx.scale(this.viewport.zoom, this.viewport.zoom);
    ctx.translate(-this.viewport.x, -this.viewport.y);

    const drawn = this.drawnScene();
    const routes = routeEdges(drawn);
    const visible = drawn.nodes.filter((n) => !n.hidden);
    const containers = visible.filter((n) => n.isContainer && n.isExpanded).sort((a, b) => a.z - b.z);
    const leaves = visible.filter((n) => !(n.isContainer && n.isExpanded)).sort((a, b) => a.z - b.z);

    for (const n of containers) this.paintNode(ctx, n);
    for (const e of drawn.edges) {
      if (e.hidden) continue;
      const route = routes.get(e.id);
      if (route === undefined) continue;
      this.paintEdge(ctx, e, route);
    }
    for (const n of leaves) this.paintNode(ctx, n);

    ctx.restore();
  }

  private paintGrid(ctx: CanvasRenderingContext2D, cw: number, ch: number): void {
    const step = 32 * this.viewport.zoom;
    if (step < 12) return;
    const offsetX = (-this.viewport.x * this.viewport.zoom) % step;
    const offsetY = (-this.viewport.y * this.viewport.zoom) % step;
    ctx.fillStyle = 'rgba(148, 163, 184, 0.10)';
    for (let x = offsetX; x < cw; x += step) {
      for (let y = offsetY; y < ch; y += step) {
        ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
      }
    }
  }

  private paintNode(ctx: CanvasRenderingContext2D, n: RenderNode): void {
    // `drawnScene()` has already folded a live drag into the node's position, so
    // what is painted and what is hit-tested are the same numbers.
    const p = n.position;
    const x = p.x - n.size.w / 2;
    const y = p.y - n.size.h / 2;
    const alpha = n.dimmed ? 0.22 : 1;

    ctx.save();
    ctx.globalAlpha = alpha;

    const expanded = n.isContainer && n.isExpanded;
    const radius = n.style.shape === 'rect' ? 4 : 10;

    if (expanded) {
      ctx.fillStyle = withAlpha(n.style.fill, 0.55);
      ctx.strokeStyle = n.selected ? '#e2e8f0' : withAlpha(n.style.stroke, 0.75);
      ctx.lineWidth = n.selected ? 2.5 : 1.4;
      roundRect(ctx, x, y, n.size.w, n.size.h, radius);
      ctx.fill();
      ctx.stroke();

      // Header strip.
      ctx.fillStyle = withAlpha(n.style.stroke, 0.16);
      roundRectTop(ctx, x, y, n.size.w, HEADER_STRIP_HEIGHT, radius);
      ctx.fill();

      ctx.fillStyle = n.style.text;
      ctx.font = '600 13px ui-sans-serif, system-ui, "Segoe UI", sans-serif';
      ctx.textBaseline = 'middle';
      // The label is drawn UNTRUNCATED: the derived width is floored (HEADER_RESERVE,
      // domain) so the name + caret + fit glyph always fit — the user requires the name
      // to stay visible on a fitted box, so we floor width instead of truncating.
      ctx.fillText(`▾ ${n.label}`, x + 12, y + HEADER_STRIP_HEIGHT / 2);
      this.paintFitControl(ctx, n);
      ctx.restore();
      return;
    }

    if (n.style.shape === 'hex') {
      hexPath(ctx, x, y, n.size.w, n.size.h);
    } else if (n.style.shape === 'cut-rect') {
      cutRectPath(ctx, x, y, n.size.w, n.size.h);
    } else {
      roundRect(ctx, x, y, n.size.w, n.size.h, radius);
    }
    ctx.fillStyle = n.style.fill;
    ctx.fill();

    if (n.selected) {
      ctx.strokeStyle = '#f8fafc';
      ctx.lineWidth = 2.5;
    } else {
      ctx.strokeStyle = n.style.stroke;
      ctx.lineWidth = 1.2;
    }
    ctx.stroke();

    // Kind stripe on the left edge — cheap, and it makes the map readable at a glance.
    if (n.style.shape !== 'hex') {
      ctx.fillStyle = n.style.stroke;
      ctx.fillRect(x + 1, y + 4, 3, n.size.h - 8);
    }

    // The clipped corner of a `crate` is a shape, not a decoration: it is what makes
    // a Rust crate distinguishable from an npm package without relying on colour.
    if (n.style.shape === 'cut-rect') {
      ctx.beginPath();
      ctx.moveTo(x + n.size.w - CUT, y);
      ctx.lineTo(x + n.size.w, y + CUT);
      ctx.strokeStyle = n.style.stroke;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    ctx.fillStyle = n.style.text;
    ctx.font = n.isContainer
      ? '600 13px ui-sans-serif, system-ui, "Segoe UI", sans-serif'
      : '13px ui-sans-serif, system-ui, "Segoe UI", sans-serif';
    ctx.textBaseline = 'middle';
    const prefix = n.isContainer ? '▸ ' : '';
    ctx.fillText(`${prefix}${n.label}`, x + 12, y + n.size.h / 2);

    if (n.badge !== undefined) {
      const text = n.badge;
      ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
      const bw = ctx.measureText(text).width + 12;
      const bx = x + n.size.w - bw - 8;
      const by = y + n.size.h / 2 - 8;
      ctx.fillStyle = withAlpha(n.style.stroke, 0.28);
      roundRect(ctx, bx, by, bw, 16, 8);
      ctx.fill();
      ctx.fillStyle = n.style.text;
      ctx.fillText(text, bx + 6, by + 8);
    }

    ctx.restore();
  }

  /** The per-container fit-to-content glyph: four inward crop-mark corners that read as
   *  "hug the frame to its content". Filled backing when the container is already fitted;
   *  brighter on hover, the canvas's only discoverability for this region. Drawn at the
   *  rect the PORT defines, so paint and hit-test never disagree about where it is. */
  private paintFitControl(ctx: CanvasRenderingContext2D, n: RenderNode): void {
    const r = headerControlRect(n);
    const hovered = this.hoverControlId === n.id;
    const fitted = n.fitted === true;

    if (fitted) {
      ctx.fillStyle = withAlpha(n.style.stroke, hovered ? 0.5 : 0.32);
      roundRect(ctx, r.x - 2, r.y - 2, r.w + 4, r.h + 4, 4);
      ctx.fill();
    }

    const pad = 2;
    const arm = 4;
    const l = r.x + pad;
    const t = r.y + pad;
    const rr = r.x + r.w - pad;
    const b = r.y + r.h - pad;

    ctx.strokeStyle = fitted ? n.style.text : withAlpha(n.style.text, hovered ? 0.95 : 0.6);
    ctx.lineWidth = hovered || fitted ? 1.6 : 1.3;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(l + arm, t); ctx.lineTo(l, t); ctx.lineTo(l, t + arm); // top-left
    ctx.moveTo(rr - arm, t); ctx.lineTo(rr, t); ctx.lineTo(rr, t + arm); // top-right
    ctx.moveTo(l + arm, b); ctx.lineTo(l, b); ctx.lineTo(l, b - arm); // bottom-left
    ctx.moveTo(rr - arm, b); ctx.lineTo(rr, b); ctx.lineTo(rr, b - arm); // bottom-right
    ctx.stroke();
  }

  private paintEdge(ctx: CanvasRenderingContext2D, e: RenderEdge, route: EdgeRoute): void {
    const { a, b, control, mid } = route;
    ctx.save();
    ctx.globalAlpha = e.dimmed ? 0.14 : 1;
    ctx.strokeStyle = e.selected ? '#f8fafc' : e.style.color;
    ctx.lineWidth = e.selected ? e.style.width + 1.4 : e.style.width;
    ctx.setLineDash(e.style.dash === null ? [] : [...e.style.dash]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.quadraticCurveTo(control.x, control.y, b.x, b.y);
    ctx.stroke();
    ctx.setLineDash([]);

    if (e.style.arrow === 'triangle') {
      // The tangent at the end of a quadratic points from the control to the end.
      const angle = Math.atan2(b.y - control.y, b.x - control.x);
      const size = 8 + e.style.width;
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - size * Math.cos(angle - 0.42), b.y - size * Math.sin(angle - 0.42));
      ctx.lineTo(b.x - size * Math.cos(angle + 0.42), b.y - size * Math.sin(angle + 0.42));
      ctx.closePath();
      ctx.fillStyle = e.selected ? '#f8fafc' : e.style.color;
      ctx.fill();
    }

    if (e.label !== undefined) {
      ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
      const w = ctx.measureText(e.label).width + 12;
      ctx.fillStyle = '#0b0e16';
      roundRect(ctx, mid.x - w / 2, mid.y - 9, w, 18, 9);
      ctx.fill();
      ctx.strokeStyle = e.style.color;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = e.style.color;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      ctx.fillText(e.label, mid.x, mid.y);
      ctx.textAlign = 'left';
    }

    ctx.restore();
  }
}

// --- geometry helpers -------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function area(n: RenderNode): number {
  return n.size.w * n.size.h;
}

function inBox(p: { x: number; y: number }, n: RenderNode): boolean {
  return (
    p.x >= n.position.x - n.size.w / 2 &&
    p.x <= n.position.x + n.size.w / 2 &&
    p.y >= n.position.y - n.size.h / 2 &&
    p.y <= n.position.y + n.size.h / 2
  );
}

// Edge geometry — border points, the fan-out, the curve and the distance to it —
// lives in `ports/renderer.ts`, because it is a contract EVERY adapter must honour,
// not this adapter's taste. It is also the only way a test can know where a line is.

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function roundRectTop(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h);
  ctx.beginPath();
  ctx.moveTo(x, y + h);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h);
  ctx.closePath();
}

/** The clipped corner of a `crate` box. */
const CUT = 13;

function cutRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const r = 4;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - CUT, y);
  ctx.lineTo(x + w, y + CUT);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function hexPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const cut = Math.min(14, w / 4);
  ctx.beginPath();
  ctx.moveTo(x + cut, y);
  ctx.lineTo(x + w - cut, y);
  ctx.lineTo(x + w, y + h / 2);
  ctx.lineTo(x + w - cut, y + h);
  ctx.lineTo(x + cut, y + h);
  ctx.lineTo(x, y + h / 2);
  ctx.closePath();
}

function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (m === null) return hex;
  const n = parseInt(m[1] as string, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function requestAnimationFrameSafe(fn: () => void): number {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(fn);
  return setTimeout(fn, 16) as unknown as number;
}
