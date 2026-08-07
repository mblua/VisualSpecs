// The kind registry (§3.7). Kinds are an OPEN vocabulary: an unknown kind renders
// through the fallback rather than crashing the app. New kinds are free; new
// hierarchies are not (§5.4).

import type { NodeShape } from '../ports/renderer.ts';

export interface NodeStyle {
  fill: string;
  stroke: string;
  text: string;
  shape: NodeShape;
  /** Shown in the legend and in the detail panel. */
  title: string;
}

export interface EdgeStyle {
  color: string;
  width: number;
  dash: readonly number[] | null;
  title: string;
}

const NODE_STYLES: Record<string, NodeStyle> = {
  repository: {
    fill: '#141a2e',
    stroke: '#4c5f9e',
    text: '#cbd5f5',
    shape: 'round-rect',
    title: 'Repository',
  },
  application: {
    fill: '#2a1f13',
    stroke: '#d99a4e',
    text: '#f5d9a8',
    shape: 'hex',
    title: 'Application — something that runs',
  },
  package: {
    fill: '#0f2529',
    stroke: '#3fa3ad',
    text: '#a9e5ec',
    shape: 'round-rect',
    title: 'npm package — a unit of code with a package.json',
  },
  crate: {
    // Distinguished from a package by SHAPE (a clipped corner) as well as colour, so
    // the distinction survives a colour-blind reader and a greyscale print.
    fill: '#2a1a13',
    stroke: '#cf7a4f',
    text: '#f0c9ac',
    shape: 'cut-rect',
    title: 'Rust crate — a unit of code with a Cargo.toml',
  },
  directory: {
    fill: '#161b26',
    stroke: '#3d4759',
    text: '#a9b4c8',
    shape: 'round-rect',
    title: 'Directory',
  },
  file: {
    fill: '#1b2231',
    stroke: '#46536b',
    text: '#c7d1e2',
    shape: 'rect',
    title: 'File',
  },
};

export const UNKNOWN_NODE_STYLE: NodeStyle = {
  fill: '#241d2e',
  stroke: '#8b6fb0',
  text: '#d9c9ec',
  shape: 'round-rect',
  title: 'Unknown kind — rendered through the fallback style',
};

const EDGE_STYLES: Record<string, EdgeStyle> = {
  imports: { color: '#6f92e8', width: 1.4, dash: null, title: 'TypeScript import (resolved via tsconfig)' },
  'rust-imports': {
    color: '#d98d5f',
    width: 1.4,
    dash: [6, 4],
    title: 'Rust use/mod — heuristic, coverage is degraded',
  },
  bundles: { color: '#a78bfa', width: 2, dash: null, title: 'An application bundles this package' },
  entrypoint: { color: '#f472b6', width: 2, dash: null, title: 'An application enters here' },
  'tauri-command': {
    color: '#34d399',
    width: 1.8,
    dash: null,
    title: 'Command call bound to the Tauri backend',
  },
  'web-command': {
    color: '#22d3ee',
    width: 1.8,
    dash: [7, 3],
    title: 'Command call bound to the WebSocket router',
  },
};

export const UNKNOWN_EDGE_STYLE: EdgeStyle = {
  color: '#94a3b8',
  width: 1.3,
  dash: [2, 3],
  title: 'Unknown relation kind — rendered through the fallback style',
};

/**
 * A level band's fill (Issue #44) — a two-step LUMINANCE zebra, not a colour ramp.
 *
 * Two reasons it is not a ramp. With up to ten levels, ten steps of a sequential ramp
 * over `--bg: #0b0e16` are not discriminable between non-adjacent pairs, so the reader
 * cannot tell "this is level 6" from the colour — and the ORDER is already carried by the
 * vertical position, which does it better. And the band is painted OVER the container's
 * own fill, which comes from six different kinds through `withAlpha`: a chromatic ramp on
 * top of six different backgrounds has no constant contrast, while an alternation of
 * luminance does.
 *
 * The rank travels in the badge, which is the authority. This only has to make the
 * staircase legible as a staircase.
 */
export function bandStyle(rank: number): { fill: string; text: string } {
  return rank % 2 === 0
    ? { fill: 'rgba(255, 255, 255, 0.038)', text: '#8ea0bf' }
    : { fill: 'rgba(255, 255, 255, 0.012)', text: '#8ea0bf' };
}

export function nodeStyle(kind: string): NodeStyle {
  return NODE_STYLES[kind] ?? UNKNOWN_NODE_STYLE;
}

export function edgeStyle(kind: string): EdgeStyle {
  return EDGE_STYLES[kind] ?? UNKNOWN_EDGE_STYLE;
}

export function knownNodeKinds(): string[] {
  return Object.keys(NODE_STYLES);
}

export function knownEdgeKinds(): string[] {
  return Object.keys(EDGE_STYLES);
}
