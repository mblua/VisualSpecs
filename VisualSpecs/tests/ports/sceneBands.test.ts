// `assertSceneWellFormed` over level bands (Issue #44).
//
// The point of putting these in the port's assertion rather than only in a unit test is
// that they run on EVERY render. A botched clip is caught in the act instead of waiting
// for someone to compare two runs — and the containment rule catches the one defect that
// was measured before the mechanism existed: after a fit under one basis and a toggle to
// the other, `src-tauri/src` drew 566 px of zebra below its own bottom edge, over
// whatever the parent's layout decides.

import { describe, expect, it } from 'vitest';
import {
  assertSceneWellFormed,
  MalformedSceneError,
  type RenderBand,
  type RenderNode,
  type RenderScene,
} from '../../src/ports/renderer.ts';

function container(): RenderNode {
  return {
    id: 'C',
    kind: 'directory',
    label: 'C',
    position: { x: 0, y: 0 },
    size: { w: 400, h: 200 },
    isContainer: true,
    isExpanded: true,
    z: 0,
    selected: false,
    opacity: 1,
    hidden: false,
    style: { fill: '#000', stroke: '#111', text: '#fff', shape: 'rect' },
  };
}

/** The container spans x ∈ [-200, 200], y ∈ [-100, 100]. */
function band(rects: RenderBand['rects']): RenderBand {
  return {
    containerId: 'C',
    rank: 0,
    rects,
    z: 0.5,
    label: 'L0',
    style: { fill: '#222', text: '#aaa' },
    opacity: 1,
    hidden: false,
  };
}

function sceneWith(...bands: RenderBand[]): RenderScene {
  return { nodes: [container()], edges: [], bands };
}

describe('a well-formed band', () => {
  it('accepts a single rect inside the container', () => {
    expect(() =>
      assertSceneWellFormed(sceneWith(band([{ x: -180, y: -80, w: 360, h: 40 }]))),
    ).not.toThrow();
  });

  it('accepts a clipped band: several rects in (y, x) order that do not overlap', () => {
    expect(() =>
      assertSceneWellFormed(
        sceneWith(
          band([
            { x: -180, y: -80, w: 360, h: 10 },
            { x: -180, y: -70, w: 100, h: 20 },
            { x: 40, y: -70, w: 140, h: 20 },
            { x: -180, y: -50, w: 360, h: 10 },
          ]),
        ),
      ),
    ).not.toThrow();
  });

  it('accepts a scene with no bands at all — the field is optional', () => {
    expect(() => assertSceneWellFormed({ nodes: [container()], edges: [] })).not.toThrow();
  });
});

describe('a malformed band is a bug in the controller and must surface', () => {
  it('rejects a band drawn outside its container box', () => {
    // 566 px below the bottom edge is the measured defect; one pixel is enough here.
    expect(() =>
      assertSceneWellFormed(sceneWith(band([{ x: -180, y: 95, w: 360, h: 20 }]))),
    ).toThrow(MalformedSceneError);
  });

  it('rejects rects out of (y, x) order', () => {
    expect(() =>
      assertSceneWellFormed(
        sceneWith(
          band([
            { x: 40, y: -70, w: 140, h: 20 },
            { x: -180, y: -70, w: 100, h: 20 },
          ]),
        ),
      ),
    ).toThrow(/order/);
  });

  it('rejects overlapping rects even when they are not adjacent', () => {
    expect(() =>
      assertSceneWellFormed(
        sceneWith(
          band([
            { x: -180, y: -80, w: 100, h: 60 },
            { x: -60, y: -70, w: 40, h: 10 },
            { x: -170, y: -60, w: 40, h: 10 },
          ]),
        ),
      ),
    ).toThrow(/overlapping/);
  });

  it('rejects a band with no rects — a band that holds nothing is not emitted', () => {
    expect(() => assertSceneWellFormed(sceneWith(band([])))).toThrow(/no rects/);
  });

  it('rejects a band naming a container that is not in the scene', () => {
    const orphan = { ...band([{ x: -180, y: -80, w: 360, h: 40 }]), containerId: 'missing' };
    expect(() => assertSceneWellFormed(sceneWith(orphan))).toThrow(/not in the scene/);
  });

  it('rejects a non-finite rect', () => {
    expect(() =>
      assertSceneWellFormed(sceneWith(band([{ x: -180, y: Number.NaN, w: 360, h: 40 }]))),
    ).toThrow(/invalid rect/);
  });

  it('holds bands to the same opacity band as nodes and edges', () => {
    const invisible = { ...band([{ x: -180, y: -80, w: 360, h: 40 }]), opacity: 0 };
    expect(() => assertSceneWellFormed(sceneWith(invisible))).toThrow(/opacity/);
  });
});
