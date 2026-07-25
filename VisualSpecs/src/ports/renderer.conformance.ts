// ONE shared suite that EVERY adapter must pass (§8.3).
//
// It imports no test framework, so the same code runs under vitest against
// `FakeRenderer` and inside a real browser against `Canvas2DRenderer`. A suite
// that only ran in Node would prove nothing about the thing that actually draws.
//
// Cases that need real input (one dragend per drag; click and dblclick
// disambiguated; hit-testing) run only where an `InputDriver` is supplied — i.e.
// in the browser. `FakeRenderer` reports them as skipped rather than pretending.

import {
  MalformedSceneError,
  headerControlRect,
  routeEdges,
  type GraphRenderer,
  type RenderEdge,
  type RenderNode,
  type RenderScene,
  type RendererEvent,
} from './renderer.ts';

export interface InputDriver {
  /** Dispatch a real press/move/release at CLIENT coordinates. */
  pointerDown(x: number, y: number): void;
  pointerMove(x: number, y: number): void;
  pointerUp(x: number, y: number): void;
  click(x: number, y: number): void;
  dblclick(x: number, y: number): void;
  /** Drag with the secondary mouse button held. */
  rightDrag(fromX: number, fromY: number, toX: number, toY: number): void;
  /** Dispatch a cancelable contextmenu event; true means the adapter prevented it. */
  contextMenu(x: number, y: number): boolean;
  /** Top-left of the host element in client coordinates. */
  hostOrigin(): { x: number; y: number };
}

export interface ConformanceOptions {
  name: string;
  makeRenderer(): GraphRenderer;
  makeHost(): HTMLElement;
  /** Only adapters that own real input supply this. */
  makeInput?: (host: HTMLElement, renderer: GraphRenderer) => InputDriver;
}

export interface CaseResult {
  name: string;
  status: 'pass' | 'fail' | 'skip';
  message?: string;
}

export interface ConformanceReport {
  adapter: string;
  results: CaseResult[];
  passed: number;
  failed: number;
  skipped: number;
}

function node(id: string, x: number, y: number, over: Partial<RenderNode> = {}): RenderNode {
  return {
    id,
    kind: 'file',
    label: id,
    position: { x, y },
    size: { w: 120, h: 40 },
    isContainer: false,
    isExpanded: false,
    z: 1,
    selected: false,
    opacity: 1,
    hidden: false,
    style: { fill: '#1e293b', stroke: '#475569', text: '#e2e8f0', shape: 'round-rect' },
    ...over,
  };
}

function edge(id: string, sourceId: string, targetId: string): RenderEdge {
  return {
    id,
    kind: 'imports',
    sourceId,
    targetId,
    count: 1,
    selected: false,
    opacity: 1,
    hidden: false,
    style: { color: '#64748b', width: 1.5, dash: null, arrow: 'triangle' },
  };
}

const SCENE_A: RenderScene = {
  nodes: [
    node('container', 300, 220, {
      kind: 'package',
      isContainer: true,
      isExpanded: true,
      size: { w: 360, h: 240 },
      z: 0,
    }),
    node('a', 230, 250),
    node('b', 380, 250),
  ],
  edges: [edge('e1', 'a', 'b')],
};

/** The shape the real dataset has: FOUR typed relations between the same pair. */
const SCENE_PARALLEL: RenderScene = {
  nodes: [
    node('container', 300, 220, {
      kind: 'package',
      isContainer: true,
      isExpanded: true,
      size: { w: 360, h: 240 },
      z: 0,
    }),
    node('a', 200, 250),
    node('b', 400, 250),
  ],
  edges: [
    { ...edge('imports', 'a', 'b'), kind: 'imports' },
    { ...edge('bundles', 'a', 'b'), kind: 'bundles' },
    { ...edge('tauri', 'a', 'b'), kind: 'tauri-command' },
    { ...edge('web', 'a', 'b'), kind: 'web-command' },
  ],
};

const SCENE_B: RenderScene = {
  nodes: [
    node('container', 300, 220, {
      kind: 'package',
      isContainer: true,
      isExpanded: false,
      size: { w: 200, h: 52 },
      z: 0,
    }),
    node('c', 620, 250),
  ],
  edges: [edge('e2', 'container', 'c')],
};

export async function runConformance(opts: ConformanceOptions): Promise<ConformanceReport> {
  const results: CaseResult[] = [];

  const run = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
    try {
      await fn();
      results.push({ name, status: 'pass' });
    } catch (err) {
      results.push({
        name,
        status: 'fail',
        message: err instanceof Error ? `${err.message}` : String(err),
      });
    }
  };
  const skip = (name: string, why: string): void => {
    results.push({ name, status: 'skip', message: why });
  };

  const assert = (cond: boolean, message: string): void => {
    if (!cond) throw new Error(message);
  };

  await run('mount → render → the same scene twice is a no-op', () => {
    const host = opts.makeHost();
    const r = opts.makeRenderer();
    r.mount(host);
    r.render(SCENE_A);
    r.render(SCENE_A); // idempotent: must not throw, must not double-add
    r.destroy();
  });

  await run('render a changed scene: add / remove / move / re-parent', () => {
    const host = opts.makeHost();
    const r = opts.makeRenderer();
    r.mount(host);
    r.render(SCENE_A);
    r.render(SCENE_B); // 'a' and 'b' gone, 'c' added, container collapsed
    r.render(SCENE_A); // and back
    r.destroy();
  });

  await run('fit does not throw, with and without ids', () => {
    const host = opts.makeHost();
    const r = opts.makeRenderer();
    r.mount(host);
    r.render(SCENE_A);
    r.fit();
    r.fit(['a']);
    r.fit([]); // nothing to fit: must be a no-op, not a crash
    r.destroy();
  });

  await run('viewport get/set round-trips', () => {
    const host = opts.makeHost();
    const r = opts.makeRenderer();
    r.mount(host);
    r.render(SCENE_A);
    r.setViewport({ x: 42, y: -17, zoom: 1.75 });
    const v = r.getViewport();
    assert(
      Math.abs(v.x - 42) < 1e-6 && Math.abs(v.y + 17) < 1e-6 && Math.abs(v.zoom - 1.75) < 1e-6,
      `viewport did not round-trip: got ${JSON.stringify(v)}`,
    );
    r.destroy();
  });

  await run('zoomBy multiplies the zoom, and the controller can read it back', () => {
    const host = opts.makeHost();
    const r = opts.makeRenderer();
    r.mount(host);
    r.render(SCENE_A);
    r.setViewport({ x: 0, y: 0, zoom: 1 });

    r.zoomBy(2);
    const inZoom = r.getViewport().zoom;
    assert(Math.abs(inZoom - 2) < 1e-6, `zoomBy(2) gave zoom ${inZoom}`);

    r.zoomBy(0.5);
    const back = r.getViewport().zoom;
    assert(Math.abs(back - 1) < 1e-6, `zoomBy(0.5) did not undo it: ${back}`);
    r.destroy();
  });

  await run('fit and zoomBy emit viewport:change; setViewport does not', () => {
    // The controller counts on this. `setViewport` is the CONTROLLER talking to the
    // renderer, and an echo would be a feedback loop; `fit` and `zoomBy` are the
    // renderer moving the camera, and the controller has to hear about it — otherwise
    // the state and the picture disagree, or the controller notifies twice to be safe.
    const host = opts.makeHost();
    const r = opts.makeRenderer();
    r.mount(host);
    r.render(SCENE_A);

    const events: RendererEvent[] = [];
    const off = r.on((e) => events.push(e));

    r.setViewport({ x: 0, y: 0, zoom: 1 });
    assert(
      events.filter((e) => e.type === 'viewport:change').length === 0,
      'setViewport must not emit viewport:change — that is the feedback loop',
    );

    r.zoomBy(2);
    assert(
      events.filter((e) => e.type === 'viewport:change').length === 1,
      'zoomBy must emit exactly one viewport:change',
    );

    r.fit();
    assert(
      events.filter((e) => e.type === 'viewport:change').length >= 2,
      'fit must emit viewport:change',
    );

    off();
    r.destroy();
  });

  await run('resize does not throw and preserves the viewport', () => {
    const host = opts.makeHost();
    const r = opts.makeRenderer();
    r.mount(host);
    r.render(SCENE_A);
    r.setViewport({ x: 10, y: 10, zoom: 2 });
    r.resize();
    const v = r.getViewport();
    assert(v.zoom === 2, `resize changed the zoom: ${v.zoom}`);
    r.destroy();
  });

  await run('a malformed scene throws MalformedSceneError', () => {
    const host = opts.makeHost();
    const r = opts.makeRenderer();
    r.mount(host);
    let threw = false;
    try {
      r.render({ nodes: [node('x', 0, 0)], edges: [edge('e', 'x', 'nope')] });
    } catch (err) {
      threw = err instanceof MalformedSceneError;
    }
    assert(threw, 'an edge naming a node that is not in the scene must throw MalformedSceneError');
    r.destroy();
  });

  // --- opacity (Issue #17) --------------------------------------------------
  // The port carries a resolved number, not a reason. These cases pin the two
  // things an adapter can get wrong: refusing to draw a partly-attenuated scene,
  // and accepting one that has been attenuated out of existence.

  await run('a partly-attenuated scene renders, at node, edge and aggregate levels', () => {
    const host = opts.makeHost();
    const r = opts.makeRenderer();
    r.mount(host);
    r.render({
      nodes: [
        node('a', 230, 250, { opacity: 0.22 }),
        node('b', 380, 250, { opacity: 1 }),
        // A collapsed container carrying the scene's partial affordance.
        node('c', 300, 400, { opacity: 0.3, isContainer: true, badge: '12', marker: '◐' }),
      ],
      edges: [
        // The fractional aggregate: neither fully faded nor fully bright.
        { ...edge('e1', 'a', 'b'), count: 136, label: '×136', opacity: 0.64 },
        { ...edge('e2', 'b', 'c'), opacity: 1 },
      ],
    });
    r.destroy();
  });

  await run('opacity outside (0, 1] is a malformed scene', () => {
    const host = opts.makeHost();
    const r = opts.makeRenderer();
    const bad: Array<[string, RenderScene]> = [
      ['zero', { nodes: [node('x', 0, 0, { opacity: 0 })], edges: [] }],
      ['above one', { nodes: [node('x', 0, 0, { opacity: 1.5 })], edges: [] }],
      ['negative', { nodes: [node('x', 0, 0, { opacity: -0.2 })], edges: [] }],
      ['not a number', { nodes: [node('x', 0, 0, { opacity: Number.NaN })], edges: [] }],
      [
        'on an edge',
        { nodes: [node('x', 0, 0), node('y', 200, 0)], edges: [{ ...edge('e', 'x', 'y'), opacity: 0 }] },
      ],
    ];
    r.mount(host);
    for (const [why, scene] of bad) {
      let threw = false;
      try {
        r.render(scene);
      } catch (err) {
        threw = err instanceof MalformedSceneError;
      }
      assert(threw, `an opacity of ${why} must throw MalformedSceneError`);
    }
    r.destroy();
  });

  await run('destroy() twice is safe', () => {
    const host = opts.makeHost();
    const r = opts.makeRenderer();
    r.mount(host);
    r.render(SCENE_A);
    r.destroy();
    r.destroy();
  });

  await run('unsubscribing stops delivery', () => {
    const host = opts.makeHost();
    const r = opts.makeRenderer();
    r.mount(host);
    let seen = 0;
    const off = r.on(() => {
      seen += 1;
    });
    off();
    r.render(SCENE_A);
    r.setViewport({ x: 1, y: 1, zoom: 1 });
    assert(seen === 0, `handler fired ${seen} times after being unsubscribed`);
    r.destroy();
  });

  // --- Cases that need real input. -----------------------------------------
  if (opts.makeInput === undefined) {
    skip('click selects the node under the pointer', 'adapter owns no input (FakeRenderer)');
    skip('a drag emits exactly one dragend', 'adapter owns no input (FakeRenderer)');
    skip('right-button drag always pans the canvas', 'adapter owns no input (FakeRenderer)');
    skip('click and dblclick are disambiguated', 'adapter owns no input (FakeRenderer)');
    skip('clicking the background emits background:click', 'adapter owns no input (FakeRenderer)');
    skip('a line crossing a container is clickable', 'adapter owns no input (FakeRenderer)');
    skip('parallel relations are individually clickable', 'adapter owns no input (FakeRenderer)');
    skip('two clicks on a line never collapse the box it crosses', 'adapter owns no input (FakeRenderer)');
    skip('two taps on the fit control never collapse the container', 'adapter owns no input (FakeRenderer)');
    skip('the rest of the header still collapses on double-click', 'adapter owns no input (FakeRenderer)');
    skip('press and drag on the fit control never moves the container', 'adapter owns no input (FakeRenderer)');
    skip('one tap fits; a second tap fits again and never collapses', 'adapter owns no input (FakeRenderer)');
  } else {
    const makeInput = opts.makeInput;

    // screen = (world - viewport) * zoom, relative to the host's top-left.
    const at = (
      input: InputDriver,
      world: { x: number; y: number },
    ): { x: number; y: number } => {
      const origin = input.hostOrigin();
      return { x: origin.x + world.x, y: origin.y + world.y };
    };

    await run('click selects the node under the pointer', async () => {
      const host = opts.makeHost();
      const r = opts.makeRenderer();
      r.mount(host);
      r.setViewport({ x: 0, y: 0, zoom: 1 });
      r.render(SCENE_A);
      const events: RendererEvent[] = [];
      r.on((e) => events.push(e));
      const input = makeInput(host, r);
      const p = at(input, { x: 230, y: 250 });
      input.click(p.x, p.y);
      await tick();
      const hit = events.find((e) => e.type === 'node:click');
      assert(hit !== undefined, 'no node:click was emitted');
      assert(
        hit !== undefined && hit.type === 'node:click' && hit.id === 'a',
        `clicked node 'a' but got ${JSON.stringify(hit)}`,
      );
      r.destroy();
    });

    await run('a drag emits exactly one dragend', async () => {
      const host = opts.makeHost();
      const r = opts.makeRenderer();
      r.mount(host);
      r.setViewport({ x: 0, y: 0, zoom: 1 });
      r.render(SCENE_A);
      const events: RendererEvent[] = [];
      r.on((e) => events.push(e));
      const input = makeInput(host, r);
      const from = at(input, { x: 230, y: 250 });
      input.pointerDown(from.x, from.y);
      input.pointerMove(from.x + 30, from.y + 10);
      input.pointerMove(from.x + 60, from.y + 25);
      input.pointerUp(from.x + 60, from.y + 25);
      await tick();
      const dragends = events.filter((e) => e.type === 'node:dragend');
      assert(dragends.length === 1, `expected exactly one dragend, got ${dragends.length}`);
      const only = dragends[0];
      assert(
        only !== undefined && only.type === 'node:dragend' && only.id === 'a',
        'the dragend named the wrong node',
      );
      assert(
        only !== undefined &&
          only.type === 'node:dragend' &&
          Math.abs(only.position.x - 290) < 2 &&
          Math.abs(only.position.y - 275) < 2,
        `dragend reported the wrong world position: ${JSON.stringify(
          only !== undefined && only.type === 'node:dragend' ? only.position : null,
        )}`,
      );
      // A drag is not a click.
      assert(
        events.filter((e) => e.type === 'node:click').length === 0,
        'a drag must not also emit node:click',
      );
      r.destroy();
    });

    await run('right-button drag always pans the canvas', async () => {
      const host = opts.makeHost();
      const r = opts.makeRenderer();
      r.mount(host);
      r.setViewport({ x: 0, y: 0, zoom: 1 });
      r.render(SCENE_A);
      const events: RendererEvent[] = [];
      r.on((e) => events.push(e));
      const input = makeInput(host, r);

      // Start over a SOLID leaf. A primary-button drag here moves the node; a
      // secondary-button drag must ignore that hit and move the entire viewport.
      const from = at(input, { x: 230, y: 250 });
      input.rightDrag(from.x, from.y, from.x + 60, from.y + 25);
      await tick();

      const viewport = r.getViewport();
      assert(
        Math.abs(viewport.x + 60) < 2 && Math.abs(viewport.y + 25) < 2,
        `right drag did not pan the viewport: ${JSON.stringify(viewport)}`,
      );
      assert(
        events.some((e) => e.type === 'viewport:change'),
        'right drag emitted no viewport:change',
      );
      assert(
        events.every((e) => e.type !== 'node:dragend' && e.type !== 'node:click'),
        `right drag moved or selected the node under it: ${JSON.stringify(events)}`,
      );
      assert(input.contextMenu(from.x, from.y), 'the canvas did not suppress its context menu');
      r.destroy();
    });

    await run('a right-click on a node emits node:contextmenu; elsewhere it does not', async () => {
      const host = opts.makeHost();
      const r = opts.makeRenderer();
      r.mount(host);
      r.setViewport({ x: 0, y: 0, zoom: 1 });
      r.render(SCENE_A);
      const events: RendererEvent[] = [];
      r.on((e) => events.push(e));
      const input = makeInput(host, r);

      const onNode = at(input, { x: 380, y: 250 });
      assert(input.contextMenu(onNode.x, onNode.y), 'the canvas did not suppress its context menu');
      await tick();
      const menu = events.filter((e) => e.type === 'node:contextmenu');
      assert(menu.length === 1, `expected one node:contextmenu, got ${menu.length}`);
      assert(
        menu[0] !== undefined && menu[0].type === 'node:contextmenu' && menu[0].id === 'b',
        'node:contextmenu named the wrong node',
      );
      assert(
        menu[0] !== undefined &&
          menu[0].type === 'node:contextmenu' &&
          Number.isFinite(menu[0].client.x) &&
          Number.isFinite(menu[0].client.y),
        'node:contextmenu carried no usable pointer position',
      );
      // A right-click must not double as a selection gesture.
      assert(
        events.every((e) => e.type !== 'node:click'),
        'a right-click also emitted node:click',
      );

      // Empty canvas has no menu: a background menu is a different feature.
      events.length = 0;
      const onBackground = at(input, { x: 300, y: 560 });
      assert(
        input.contextMenu(onBackground.x, onBackground.y),
        'the canvas did not suppress its context menu on the backdrop',
      );
      await tick();
      assert(
        events.every((e) => e.type !== 'node:contextmenu'),
        'a right-click on empty canvas emitted node:contextmenu',
      );
      r.destroy();
    });

    await run('click and dblclick are disambiguated', async () => {
      const host = opts.makeHost();
      const r = opts.makeRenderer();
      r.mount(host);
      r.setViewport({ x: 0, y: 0, zoom: 1 });
      r.render(SCENE_A);
      const events: RendererEvent[] = [];
      r.on((e) => events.push(e));
      const input = makeInput(host, r);
      const p = at(input, { x: 380, y: 250 });
      input.dblclick(p.x, p.y);
      await tick();
      const dbl = events.filter((e) => e.type === 'node:dblclick');
      assert(dbl.length === 1, `expected one dblclick, got ${dbl.length}`);
      assert(
        dbl[0] !== undefined && dbl[0].type === 'node:dblclick' && dbl[0].id === 'b',
        'dblclick named the wrong node',
      );
      r.destroy();
    });

    await run('clicking the background emits background:click', async () => {
      const host = opts.makeHost();
      const r = opts.makeRenderer();
      r.mount(host);
      r.setViewport({ x: 0, y: 0, zoom: 1 });
      r.render(SCENE_A);
      const events: RendererEvent[] = [];
      r.on((e) => events.push(e));
      const input = makeInput(host, r);
      const p = at(input, { x: 20, y: 20 }); // outside every box
      input.click(p.x, p.y);
      await tick();
      assert(
        events.some((e) => e.type === 'background:click'),
        'no background:click was emitted',
      );
      r.destroy();
    });

    await run('a line crossing a container is clickable', async () => {
      // An expanded container is a BACKDROP. The edges between its own children are
      // drawn straight across it, and an aggregated relation is the single most
      // important thing in this product to be able to click. If the container
      // swallows the click, the map cannot answer the question it exists to answer.
      const host = opts.makeHost();
      const r = opts.makeRenderer();
      r.mount(host);
      r.setViewport({ x: 0, y: 0, zoom: 1 });
      r.render(SCENE_A);
      const events: RendererEvent[] = [];
      r.on((e) => events.push(e));
      const input = makeInput(host, r);

      // Midway between 'a' (230,250) and 'b' (380,250): on the line e1, over the
      // container's background, and inside neither box.
      const p = at(input, { x: 305, y: 250 });
      input.click(p.x, p.y);
      await tick();

      const hit = events.find((e) => e.type === 'edge:click');
      assert(hit !== undefined, 'clicking a line over a container background selected the container instead');
      assert(
        hit !== undefined && hit.type === 'edge:click' && hit.id === 'e1',
        `the wrong edge was selected: ${JSON.stringify(hit)}`,
      );

      // …and a SOLID box still wins over a line that happens to pass near it.
      const onNode = at(input, { x: 230, y: 250 });
      input.click(onNode.x, onNode.y);
      await tick();
      const nodeHit = events.filter((e) => e.type === 'node:click').pop();
      assert(
        nodeHit !== undefined && nodeHit.type === 'node:click' && nodeHit.id === 'a',
        'clicking a leaf must select the leaf, not a line passing through it',
      );
      r.destroy();
    });

    await run('parallel relations are individually clickable', async () => {
      // `bundles` and `imports` between the same visible pair are DIFFERENT FACTS
      // (§6.3). Keeping them distinct in the model and then drawing them on top of
      // one another tells the same lie in pixels: you cannot see them, and you
      // cannot click the one you want. The fan-out is defined in the port, so every
      // adapter separates them the same way — and this proves each one is reachable.
      const host = opts.makeHost();
      const r = opts.makeRenderer();
      r.mount(host);
      r.setViewport({ x: 0, y: 0, zoom: 1 });
      r.render(SCENE_PARALLEL);
      const events: RendererEvent[] = [];
      r.on((e) => events.push(e));
      const input = makeInput(host, r);

      const routes = routeEdges(SCENE_PARALLEL);
      for (const wanted of ['imports', 'bundles', 'tauri', 'web']) {
        const route = routes.get(wanted);
        assert(route !== undefined, `no route for ${wanted}`);
        if (route === undefined) continue;
        const p = at(input, route.mid);
        input.click(p.x, p.y);
        await tick();
        const hit = events.filter((e) => e.type === 'edge:click').pop();
        assert(
          hit !== undefined && hit.type === 'edge:click' && hit.id === wanted,
          `clicking the ${wanted} line selected ${JSON.stringify(hit)} — parallel relations are drawn on top of each other`,
        );
      }
      r.destroy();
    });

    await run('two clicks on a line never collapse the box it crosses', async () => {
      // The double-click used to be keyed on the node UNDER THE POINTER, resolved
      // before an edge was allowed to win over the container's backdrop. So clicking
      // twice on the aggregated relation — the single most important thing to inspect
      // in this product — emitted `node:dblclick` on the container and shut it. The
      // box closed in your face while you were reading it.
      //
      // The winning target is now resolved FIRST, and only a node target may produce a
      // double-click.
      const host = opts.makeHost();
      const r = opts.makeRenderer();
      r.mount(host);
      r.setViewport({ x: 0, y: 0, zoom: 1 });
      r.render(SCENE_A);
      const events: RendererEvent[] = [];
      r.on((e) => events.push(e));
      const input = makeInput(host, r);

      const route = routeEdges(SCENE_A).get('e1');
      assert(route !== undefined, 'no route for e1');
      if (route === undefined) return;

      const p = at(input, route.mid);
      input.dblclick(p.x, p.y); // two rapid press/release pairs, on the LINE
      await tick();

      assert(
        events.filter((e) => e.type === 'node:dblclick').length === 0,
        'two clicks on a line emitted node:dblclick and would have collapsed the container',
      );
      assert(
        events.filter((e) => e.type === 'edge:click').length === 2,
        `two clicks on a line should be two edge clicks, got ${JSON.stringify(events)}`,
      );

      // …and a double-click on the CONTAINER's own header still expands/collapses it.
      const onContainer = at(input, { x: 300, y: 110 }); // inside the box, off the line
      input.dblclick(onContainer.x, onContainer.y);
      await tick();
      const dbl = events.filter((e) => e.type === 'node:dblclick');
      assert(
        dbl.length === 1 && dbl[0]?.type === 'node:dblclick' && dbl[0].id === 'container',
        'a double-click on the container itself must still toggle it',
      );
      r.destroy();
    });

    // The fit-to-content control (Issue #13) is the first INTERACTIVE sub-region of a
    // node. These four cases are the resolve-first discipline made executable: a tap on
    // the glyph fits and nothing else, and can never be reinterpreted as the container's
    // drag (FIT-2) or its collapse-on-double-click (FIT-3).
    const controlPoint = (): { x: number; y: number } => {
      const r = headerControlRect(SCENE_A.nodes[0] as RenderNode);
      return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
    };

    await run('two taps on the fit control never collapse the container', async () => {
      const host = opts.makeHost();
      const r = opts.makeRenderer();
      r.mount(host);
      r.setViewport({ x: 0, y: 0, zoom: 1 });
      r.render(SCENE_A);
      const events: RendererEvent[] = [];
      r.on((e) => events.push(e));
      const input = makeInput(host, r);

      const p = at(input, controlPoint());
      input.dblclick(p.x, p.y); // two rapid taps, ON the glyph
      await tick();

      assert(
        events.filter((e) => e.type === 'node:dblclick').length === 0,
        'two taps on the fit control emitted node:dblclick and would have collapsed the container',
      );
      const fits = events.filter((e) => e.type === 'container:fit');
      assert(
        fits.length === 2 && fits.every((e) => e.type === 'container:fit' && e.id === 'container'),
        `two taps on the control should be two container:fit for 'container', got ${JSON.stringify(events)}`,
      );
      r.destroy();
    });

    await run('the rest of the header still collapses on double-click', async () => {
      const host = opts.makeHost();
      const r = opts.makeRenderer();
      r.mount(host);
      r.setViewport({ x: 0, y: 0, zoom: 1 });
      r.render(SCENE_A);
      const events: RendererEvent[] = [];
      r.on((e) => events.push(e));
      const input = makeInput(host, r);

      // The header, on the title side — well to the LEFT of the glyph, but still on the
      // 30px-tall header strip (container top edge is y=100).
      const p = at(input, { x: 160, y: 115 });
      input.dblclick(p.x, p.y);
      await tick();

      const dbl = events.filter((e) => e.type === 'node:dblclick');
      assert(
        dbl.length === 1 && dbl[0]?.type === 'node:dblclick' && dbl[0].id === 'container',
        `a double-click on the header (off the control) must still toggle the container, got ${JSON.stringify(events)}`,
      );
      assert(
        events.filter((e) => e.type === 'container:fit').length === 0,
        'a double-click on the header title must not fit',
      );
      r.destroy();
    });

    await run('press and drag on the fit control never moves the container', async () => {
      const host = opts.makeHost();
      const r = opts.makeRenderer();
      r.mount(host);
      r.setViewport({ x: 0, y: 0, zoom: 1 });
      r.render(SCENE_A);
      const events: RendererEvent[] = [];
      r.on((e) => events.push(e));
      const input = makeInput(host, r);

      const from = at(input, controlPoint());
      input.pointerDown(from.x, from.y);
      input.pointerMove(from.x + 40, from.y + 30);
      input.pointerMove(from.x + 80, from.y + 60);
      input.pointerUp(from.x + 80, from.y + 60);
      await tick();

      assert(
        events.every((e) => e.type !== 'node:dragend'),
        'a drag starting on the control moved the container',
      );
      assert(
        events.every((e) => e.type !== 'container:fit'),
        'a drag off the control must not fit — only a tap fits',
      );
      assert(
        events.every((e) => e.type !== 'node:click' && e.type !== 'node:dblclick'),
        'a drag on the control must not select or toggle the container',
      );
      const v = r.getViewport();
      assert(v.x === 0 && v.y === 0, `a drag on the control panned the canvas: ${JSON.stringify(v)}`);
      r.destroy();
    });

    await run('one tap fits; a second tap fits again and never collapses', async () => {
      const host = opts.makeHost();
      const r = opts.makeRenderer();
      r.mount(host);
      r.setViewport({ x: 0, y: 0, zoom: 1 });
      r.render(SCENE_A);
      const events: RendererEvent[] = [];
      r.on((e) => events.push(e));
      const input = makeInput(host, r);

      const p = at(input, controlPoint());
      input.click(p.x, p.y);
      await tick();
      input.click(p.x, p.y);
      await tick();

      const fits = events.filter((e) => e.type === 'container:fit');
      assert(
        fits.length === 2 && fits.every((e) => e.type === 'container:fit' && e.id === 'container'),
        `each tap on the control should emit container:fit, got ${JSON.stringify(events)}`,
      );
      assert(
        events.filter((e) => e.type === 'node:dblclick').length === 0,
        'two separate taps on the control must never become a node:dblclick collapse',
      );
      assert(
        events.filter((e) => e.type === 'node:click').length === 0,
        'a tap on the control must not select the container',
      );
      r.destroy();
    });
  }

  const passed = results.filter((r) => r.status === 'pass').length;
  const failed = results.filter((r) => r.status === 'fail').length;
  const skipped = results.filter((r) => r.status === 'skip').length;
  return { adapter: opts.name, results, passed, failed, skipped };
}

function tick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}
