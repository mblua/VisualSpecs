// THE COMPOSITION ROOT — the only module that imports a concrete adapter and a UI
// root, and wires them together (§2). Changing the renderer changes this file plus
// the new adapter's files. Nothing in contract/, domain/ or projection/ moves, and
// the architecture test enforces that rather than trusting it.

import './styles.css';
// The committed dataset is imported as TEXT and parsed through the same validator
// an imported file goes through — so the app makes no network call of any kind
// (§11), and the real document is exercised by the real code path.
import datasetText from '../data/agentscommander.json?raw';

import { VisualSpecsError } from './contract/errors.ts';
import { DEFAULT_LIMITS } from './contract/limits.ts';
import { importDoc } from './contract/load.ts';
import { stateFromLoaded } from './app/state.ts';
import { Controller } from './app/controller.ts';
import { ProjectController } from './app/projectController.ts';
import { Canvas2DRenderer } from './adapters/canvas2d/Canvas2DRenderer.ts';
import { FsaProjectStore } from './adapters/filesystem/FsaProjectStore.ts';
import { canvasHostOf, mountUi } from './ui/app.ts';
import type { GraphRenderer } from './ports/renderer.ts';
import type { ProjectStore } from './ports/projectStore.ts';

export function boot(input: {
  root: HTMLElement;
  renderer: GraphRenderer;
  projectStore: ProjectStore;
  datasetText: string;
}): Controller {
  try {
    const loaded = importDoc(input.datasetText);
    const controller = new Controller(input.renderer, stateFromLoaded(loaded));
    const projectController = new ProjectController(controller, input.projectStore, DEFAULT_LIMITS, {
      sessionKind: 'example',
      displayLabel: 'AgentsCommander',
    });

    // The renderer is handed over so the UI can hear `node:contextmenu` (#17 §8.3.1).
    // A menu is presentation, not state, so it does not travel through the command
    // loop — and `ui/` still knows only the PORT, never this adapter.
    mountUi(input.root, controller, projectController, input.renderer);
    input.renderer.mount(canvasHostOf(input.root));
    controller.start();
    controller.fit();
    projectController.markClean();
    return controller;
  } catch (err) {
    const message =
      err instanceof VisualSpecsError ? err.message : err instanceof Error ? err.message : String(err);
    const pre = document.createElement('pre');
    pre.className = 'boot-error';
    pre.textContent = `Visual Specs could not open its dataset.\n\n${message}`;
    input.root.appendChild(pre);
    throw err;
  }
}

const root = document.getElementById('root');
if (root === null) throw new Error('#root is missing from index.html');

boot({
  root,
  renderer: new Canvas2DRenderer(),
  projectStore: new FsaProjectStore({ maxBytes: DEFAULT_LIMITS.maxBytes }),
  datasetText,
});
