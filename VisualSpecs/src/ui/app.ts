// The UI shell. `ui/` imports `app/` and `ports/` (and the inner, pure layers);
// `app/` never imports `ui/`.
//
// A canvas must not be the only way in (§9.4). Everything the map can do is also
// reachable from a keyboard-navigable node list, the toolbar has real buttons with
// real shortcuts, selection — node, aggregated edge, AND internal bucket — is
// announced via aria-live, and the detail panel is ordinary focusable DOM.
//
// The two side panels are DRAWERS. At a wide viewport they are docked and open, as
// before. Below a breakpoint they float over the canvas and start closed, because a
// 290px explorer and a 380px detail panel in a 800px window left the map 130px of
// width — a strip of pixels in which nothing can be read, selected, or believed.

import { VisualSpecsError } from '../contract/errors.ts';
import { DEFAULT_LIMITS } from '../contract/limits.ts';
import { ancestryOf } from '../contract/model.ts';
import type { FocusMark } from '../contract/view.ts';
import { applyViewCommand } from '../domain/commands.ts';
import type { Controller, Derived } from '../app/controller.ts';
import type { ProjectController, ProjectControllerState } from '../app/projectController.ts';
import type { AppState } from '../app/state.ts';
import { edgeStyle, nodeStyle } from '../app/registry.ts';
import type { GraphRenderer } from '../ports/renderer.ts';
import type { StoredDocRef } from '../ports/projectStore.ts';
import type { InternalBucketId } from '../projection/types.ts';
import { clear, button, el } from './dom.ts';
import { renderDetail } from './detail.ts';

export interface AppUi {
  destroy(): void;
}

const WIDE_MIN_WIDTH = 1664;
const HYBRID_MIN_WIDTH = 1200;
/** How many rows either list renders before it says "… and N more". Shared by the
 *  node list and the marks disclosure, so a large mark set is capped the same way and
 *  `Clear all focus` stays the global escape. */
const LIST_CAP = 400;
const ZOOM_STEP = 1.25;
const PROJECT_ID_COLUMNS_PER_LINE = 24;

type LayoutBand = 'wide' | 'hybrid' | 'narrow';
type Surface = 'project' | 'sidebar' | 'detail';
export type ProjectCriticalAction = 'return' | 'repair' | 'enable' | 'save' | null;

export interface EscapedProjectId {
  atoms: readonly string[];
  full: string;
}

export interface PreviousProjectIdentity {
  name: string;
  rawId: string;
  compactToken: string;
}

export interface ProjectPresentation {
  statuses: readonly string[];
  criticalAction: ProjectCriticalAction;
}

/** Injective presentation of the exact JavaScript UTF-16 code-unit sequence. */
export function escapeManifestProjectId(raw: string): EscapedProjectId {
  const atoms: string[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const unit = raw.charCodeAt(index);
    if (unit >= 0x21 && unit <= 0x7e && unit !== 0x5c) {
      atoms.push(String.fromCharCode(unit));
    } else {
      atoms.push('\\u' + unit.toString(16).toUpperCase().padStart(4, '0'));
    }
  }
  return { atoms, full: atoms.join('') };
}

export function compactManifestProjectId(
  raw: string,
  previous: PreviousProjectIdentity | null,
): string {
  const atoms = escapeManifestProjectId(raw).atoms;
  const edgeAtoms = 8;
  const defaultToken =
    atoms.length <= edgeAtoms * 2 + 1
      ? atoms.join('')
      : atoms.slice(0, edgeAtoms).join('') + '...' + atoms.slice(-edgeAtoms).join('');
  if (previous === null || previous.rawId === raw || defaultToken !== previous.compactToken) {
    return defaultToken;
  }

  const previousAtoms = escapeManifestProjectId(previous.rawId).atoms;
  const shared = Math.min(atoms.length, previousAtoms.length);
  let differing = 0;
  while (differing < shared && atoms[differing] === previousAtoms[differing]) differing += 1;
  const start = Math.max(0, differing - 3);
  const end = Math.min(atoms.length, differing + 4);
  let token =
    (start > 0 ? '...' : '') +
    atoms.slice(start, end).join('') +
    (end < atoms.length ? '...' : '') +
    ';len=' +
    raw.length;
  if (token === previous.compactToken) token += ';at=' + differing;
  return token;
}

export function deriveProjectPresentation(state: ProjectControllerState): ProjectPresentation {
  const statuses: string[] = [];
  if (state.manifestProjectId === null) {
    statuses.push(state.sessionKind === 'example' ? 'Example document' : 'Temporary document');
  } else {
    statuses.push('Project access: ' + (state.access === 'readwrite' ? 'editable' : 'read-only'));
    if (state.readOnly) statuses.push('Document: read-only');
    if (state.projectDirty === true) statuses.push('Unsaved project changes');
    if (state.sessionKind === 'project-preview' && state.dirty) {
      statuses.push('Unsaved Preview changes');
    }
    if (state.previewing) statuses.push('Preview');
    if (state.needsRepair) statuses.push('Repair needed');
    if (state.pendingAutosave) statuses.push('Recovery available');
    if (state.corruptAutosaveIgnored) statuses.push('Corrupt autosave ignored');
  }
  if (state.followState.kind !== 'none') statuses.push(state.followState.label);
  if (state.lifecycleBusy) statuses.push('Project operation in progress');

  const criticalAction: ProjectCriticalAction = state.canReturnToProject
    ? 'return'
    : state.canRepairProject
      ? 'repair'
      : state.canEnableEditing
        ? 'enable'
        : state.canWriteProject && state.projectDirty === true
          ? 'save'
          : null;
  return { statuses, criticalAction };
}

export function discardConfirmationCopy(
  state: ProjectControllerState,
  action: string,
): string | null {
  if (!state.hasDiscardableChanges) return null;
  const losses: string[] = [];
  if (state.sessionKind === 'project-preview') {
    if (state.dirty) losses.push('the current Preview has unsaved view changes');
    if (state.projectDirty === true) {
      losses.push('the open project has unsaved layout or view changes');
    }
  } else if (state.sessionKind === 'project') {
    losses.push('the open project has unsaved layout or view changes');
  } else if (state.dirty) {
    losses.push('the current document has unsaved view changes');
  }
  if (losses.length === 0) return null;
  const named = losses.length === 1 ? losses[0] : losses[0] + ' and ' + losses[1];
  return named + ' and will be lost if you ' + action + '. Continue?';
}

export function restoreConfirmationCopy(
  state: ProjectControllerState,
  fileName: string,
): string {
  const loss = discardConfirmationCopy(state, 'restore ' + fileName + ' as current');
  if (loss === null) {
    return 'Restore ' + fileName + ' as current? The current file will be backed up first.';
  }
  return (
    loss.replace(/ Continue\?$/u, '') +
    ' The current file will be backed up first. Continue?'
  );
}

/**
 * The read-only browser test hooks exist in dev and test builds ONLY.
 *
 * Declared at module scope so that Vite replaces `import.meta.env.DEV` with `false` in
 * a production build, the constant folds to `false`, and BOTH branches that mention the
 * global are eliminated — the assignment and the cleanup. The first cut gated only the
 * assignment, so `delete globalThis.__visualSpecs` survived into `dist` and the
 * bundle still carried the literal.
 */
const IS_TEST_BUILD = import.meta.env.DEV || import.meta.env.MODE === 'test';
const TEST_HOOK = '__visualSpecs';

export function mountUi(
  root: HTMLElement,
  controller: Controller,
  projectController: ProjectController,
  renderer?: GraphRenderer,
): AppUi {
  clear(root);

  const canvasHost = el('div', { class: 'canvas-host', id: 'canvas-host' }, []);
  const detailHost = el('div', { class: 'detail-body' }, []);
  const listHost = el('div', { class: 'node-list', role: 'listbox', 'aria-label': 'All nodes' }, []);
  const legendHost = el('div', { class: 'legend' }, []);
  /**
   * The view modes, anchored to the foot of the Explorer (Issue #48).
   *
   * They used to be the last rows of the legend, and the legend's length is a function of
   * how many kinds the CORPUS has — so how much of the feature a person could reach
   * depended on their window height and on their repository. Neither is a property of the
   * control: `levels` needed a 1293 px window to be visible without scrolling, and a 1080p
   * screen gives about 1000.
   *
   * They are not part of the legend in the first place. The legend answers "what is each
   * colour"; these change what the map IS.
   */
  const modesHost = el('div', { class: 'modes', 'aria-label': 'View modes' }, []);
  const bannerHost = el('div', { class: 'banners' }, []);
  const projectRail = el('aside', {
    class: 'project-rail',
    id: 'project-rail',
    'aria-label': 'Project',
  });
  const actionErrorHost = el('div', {
    class: 'action-error',
    role: 'alert',
    'aria-live': 'assertive',
    hidden: 'true',
  });
  const statusHost = el('div', { class: 'status', role: 'status', 'aria-live': 'polite' }, []);
  const countsHost = el('div', { class: 'counts' }, []);
  /** Everything about out-of-focus dimming (#17), directly under the counts box. */
  const focusHost = el('div', { class: 'focus-controls' }, []);
  /**
   * The row context menu, created ONCE and parented to `shell` — never to a row.
   *
   * Two independent reasons, each alone fatal to an in-row menu: `renderList` runs on
   * every controller notification and opens with `clear(listHost)`, so `SetFocus`
   * would destroy the anchor of the menu that dispatched it; and `.node-list` is
   * `overflow-y: auto`, which CLIPS an absolutely-positioned child exactly where the
   * last rows are. `popover="auto"` then buys light-dismiss and top-layer rendering
   * from the platform instead of from a z-index contest with the project overlay.
   */
  const rowMenu = el('div', {
    class: 'row-menu',
    role: 'menu',
    popover: 'auto',
    'aria-label': 'Focus actions',
  });

  const shell = el('div', { class: 'shell' }, []);
  let currentProjectState = projectController.snapshot();

  // --- drawers -------------------------------------------------------------

  let projectPreference: 'expanded' | 'collapsed' = 'expanded';
  let sidebarPreference: 'open' | 'closed' = 'open';
  let detailPreference: 'open' | 'closed' = 'open';
  let activeOverlay: Surface | null = null;
  const overlayOpeners: Record<Surface, HTMLElement | null> = {
    project: null,
    sidebar: null,
    detail: null,
  };
  let sidebarOpen = false;
  let detailOpen = false;
  let projectOpen = false;
  let currentBand = layoutBand();
  let destroyed = false;
  let resizeFrame: number | null = null;
  let paintFrame: number | null = null;
  let focusFrame: number | null = null;
  let layoutToken = 0;
  const layoutTimings: Array<{ band: LayoutBand; durationMs: number }> = [];

  function layoutBand(): LayoutBand {
    if (globalThis.innerWidth >= WIDE_MIN_WIDTH) return 'wide';
    if (globalThis.innerWidth >= HYBRID_MIN_WIDTH) return 'hybrid';
    return 'narrow';
  }

  function scheduleResize(): void {
    const token = ++layoutToken;
    const startedAt = performance.now();
    if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
    if (paintFrame !== null) cancelAnimationFrame(paintFrame);
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = null;
      if (destroyed || token !== layoutToken) return;
      controller.resize();
      paintFrame = requestAnimationFrame(() => {
        paintFrame = null;
        if (destroyed || token !== layoutToken) return;
        layoutTimings.push({ band: currentBand, durationMs: performance.now() - startedAt });
        if (layoutTimings.length > 100) layoutTimings.shift();
      });
    });
  }

  function scheduleFocus(target: () => HTMLElement | null): void {
    if (focusFrame !== null) cancelAnimationFrame(focusFrame);
    focusFrame = requestAnimationFrame(() => {
      focusFrame = null;
      if (destroyed) return;
      const destination = target();
      if (
        destination !== null &&
        destination.isConnected &&
        !destination.hidden &&
        destination.closest('[hidden]') === null
      ) {
        destination.focus({ preventScroll: true });
      }
    });
  }

  function positionProjectOverlay(): void {
    if (
      currentBand === 'wide' ||
      currentProjectState.manifestProjectId === null ||
      projectRail.hidden
    ) {
      workspace.style.removeProperty('--project-overlay-top');
      return;
    }
    const workspaceRect = workspace.getBoundingClientRect();
    const bodyRect = body.getBoundingClientRect();
    workspace.style.setProperty(
      '--project-overlay-top',
      Math.max(0, bodyRect.top - workspaceRect.top) + 'px',
    );
  }

  function projectOpenerCanSurviveClose(opener: HTMLElement | null): opener is HTMLElement {
    if (
      opener === null ||
      !opener.isConnected ||
      opener.hidden ||
      opener.getAttribute('aria-disabled') === 'true' ||
      (opener instanceof HTMLButtonElement && opener.disabled) ||
      !projectCompact.contains(opener)
    ) {
      return false;
    }
    for (let ancestor = opener.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
      if (ancestor.hidden && ancestor !== projectCompact) return false;
    }
    return true;
  }

  function projectOpenerOrFallback(): HTMLElement {
    const opener = overlayOpeners.project;
    return projectOpenerCanSurviveClose(opener) ? opener : projectShow;
  }

  function preserveProjectOpenerOrFallback(): void {
    overlayOpeners.project = projectOpenerOrFallback();
  }

  function setSurface(which: Surface, open: boolean, opener: HTMLElement): void {
    const band = layoutBand();
    if (which === 'project') {
      projectPreference = open ? 'expanded' : 'collapsed';
      if (band === 'wide') {
        activeOverlay = null;
      } else {
        activeOverlay = open ? 'project' : null;
      }
    } else if (which === 'sidebar') {
      if (band !== 'narrow') sidebarPreference = open ? 'open' : 'closed';
      if (band === 'narrow') {
        activeOverlay = open ? 'sidebar' : null;
      } else if (open && activeOverlay === 'project') {
        activeOverlay = null;
      }
    } else {
      if (band !== 'narrow') detailPreference = open ? 'open' : 'closed';
      if (band === 'narrow') activeOverlay = open ? 'detail' : null;
    }
    // Only the surface that actually becomes the active overlay owns this opener.
    // Docked Details/Explorer toggles must not overwrite an open Project overlay.
    if (open && band !== 'wide' && activeOverlay === which) overlayOpeners[which] = opener;
    applyLayout();
    if (open) {
      scheduleFocus(() =>
        which === 'project'
          ? projectRail.hidden
            ? null
            : projectCollapse
          : which === 'sidebar'
            ? sidebar.hidden
              ? null
              : search
            : detailPanel.hidden
              ? null
              : detailPanel,
      );
    } else {
      const destination =
        which === 'project'
          ? projectOpenerOrFallback()
          : opener.isConnected && !opener.hidden
            ? opener
            : overlayOpeners[which];
      scheduleFocus(() => destination);
    }
  }

  function setPanel(which: 'sidebar' | 'detail', open: boolean): void {
    const opener = which === 'sidebar' ? sidebarToggle : detailToggle;
    setSurface(which, open, opener);
  }

  function applyLayout(): void {
    const band = layoutBand();
    const bandChanged = band !== currentBand;
    currentBand = band;
    const hasProject = currentProjectState.manifestProjectId !== null;
    projectOpen =
      !hasProject ||
      (band === 'wide' ? projectPreference === 'expanded' : activeOverlay === 'project');
    sidebarOpen =
      band === 'wide'
        ? sidebarPreference === 'open'
        : band === 'hybrid'
          ? sidebarPreference === 'open' && !projectOpen
          : activeOverlay === 'sidebar';
    detailOpen =
      band === 'narrow' ? activeOverlay === 'detail' : detailPreference === 'open';

    // Close the menu when the layout actually MOVES, and not merely when this runs.
    // `applyLayout` is called from `renderProjectState`, i.e. on every ProjectController
    // notification — so an unconditional close here is the same defect as closing on
    // every controller notification, wearing a different hat: the menu would die once a
    // second on a followed document. `[` and `]` hide the sidebar without firing
    // `resize`, and popover light-dismiss is pointer-driven and does not fire on a
    // keydown, so the real cases still have to be caught — they are, by the predicate.
    if (bandChanged || !sidebarOpen) closeRowMenu();

    shell.classList.toggle('wide', band === 'wide');
    shell.classList.toggle('hybrid', band === 'hybrid');
    shell.classList.toggle('narrow', band === 'narrow');
    shell.classList.toggle('docked', band !== 'narrow');
    shell.classList.toggle('floating', band === 'narrow');
    shell.classList.toggle('has-project', hasProject);
    shell.classList.toggle('no-project', !hasProject);
    shell.classList.toggle('project-open', projectOpen);
    shell.classList.toggle('sidebar-open', sidebarOpen);
    shell.classList.toggle('detail-open', detailOpen);

    // Reveal the destination first and move focus synchronously before hiding the
    // currently focused subtree. This prevents browsers from falling back to body
    // during collapse, overlay replacement, or a breakpoint transition.
    if (projectOpen) {
      projectRail.hidden = false;
      if (document.activeElement instanceof Node && projectCompact.contains(document.activeElement)) {
        (hasProject ? projectCollapse : createProject).focus({ preventScroll: true });
      }
      projectCompact.hidden = true;
      projectShow.hidden = true;
    } else {
      projectCompact.hidden = !hasProject;
      projectShow.hidden = !hasProject;
      if (document.activeElement instanceof Node && projectRail.contains(document.activeElement)) {
        projectShow.focus({ preventScroll: true });
      }
      projectRail.hidden = true;
    }
    if (
      !sidebarOpen &&
      document.activeElement instanceof Node &&
      sidebar.contains(document.activeElement)
    ) {
      sidebarToggle.focus({ preventScroll: true });
    }
    if (
      !detailOpen &&
      document.activeElement instanceof Node &&
      detailPanel.contains(document.activeElement)
    ) {
      detailToggle.focus({ preventScroll: true });
    }
    projectShow.setAttribute('aria-expanded', projectOpen ? 'true' : 'false');
    projectCollapse.setAttribute('aria-expanded', projectOpen ? 'true' : 'false');
    sidebarToggle.setAttribute('aria-expanded', sidebarOpen ? 'true' : 'false');
    detailToggle.setAttribute('aria-expanded', detailOpen ? 'true' : 'false');
    sidebar.hidden = !sidebarOpen;
    detailPanel.hidden = !detailOpen;
    positionProjectOverlay();
    // The off-Explorer focus banner depends on whether the Explorer is open, and the
    // panel toggles do not go through the controller — so the banners are re-rendered
    // from the state we already have rather than waiting for the next notification.
    if (lastRendered !== null) renderBanners(lastRendered.state, lastRendered.derived);
    scheduleResize();
  }

  const sidebarToggle = button('Explorer', () => setPanel('sidebar', !sidebarOpen), {
    title: 'Show or hide the explorer ([)',
    'aria-expanded': 'true',
    'aria-controls': 'explorer-panel',
    id: 'toggle-sidebar',
  });
  const detailToggle = button('Details', () => setPanel('detail', !detailOpen), {
    title: 'Show or hide the detail panel (])',
    'aria-expanded': 'true',
    'aria-controls': 'details-panel',
    id: 'toggle-detail',
  });

  // --- controls ------------------------------------------------------------

  const search = el('input', {
    type: 'search',
    id: 'search',
    class: 'search',
    placeholder: 'Search nodes by name or path…',
    'aria-label': 'Search nodes by name or path',
    autocomplete: 'off',
  });
  search.addEventListener('input', () => {
    controller.dispatch({ type: 'SetSearch', query: search.value });
  });

  const fileInput = el('input', {
    type: 'file',
    accept: 'application/json,.json',
    class: 'hidden-input',
    id: 'import-input',
    'aria-label': 'Open a Visual Specs document temporarily',
  });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file === undefined) return;
    void runProjectAction(
      'Open temporary JSON',
      () =>
        projectController.openTemporarySource({
          sourceName: file.name,
          sizeBytes: file.size,
          readText: async () => file.text(),
        }),
      `Imported ${file.name}.`,
    );
    fileInput.value = '';
  });

  const projectName = el('input', {
    type: 'text',
    class: 'project-name',
    maxlength: '120',
    'aria-label': 'Project name',
    placeholder: 'Visual Specs',
  });
  let projectNameComposing = false;
  projectName.addEventListener('compositionstart', () => {
    projectNameComposing = true;
  });
  projectName.addEventListener('compositionend', () => {
    projectNameComposing = false;
  });
  let renderedProjectKey: string | null | undefined;
  let renderedProjectName = '';
  let renderedManifestProjectId: string | null | undefined;
  let selectedProjectIdentity: PreviousProjectIdentity | null = null;
  let importRefs: readonly StoredDocRef[] = [];
  let exportRefs: readonly StoredDocRef[] = [];
  const importSelect = el('select', { class: 'project-imports', 'aria-label': 'Project imports' });
  const exportSelect = el('select', { class: 'project-exports', 'aria-label': 'Project export copies' });

  const handlers = {
    createProject(): void {
      if (!confirmDestructive('create a different project')) return;
      void runProjectAction('Create project', () =>
        projectController.createProject(projectName.value || 'Visual Specs'),
      );
    },
    openProject(): void {
      if (!confirmDestructive('open another project')) return;
      void runProjectAction('Open project', () => projectController.openProject());
    },
    enableEditing(): void {
      void runProjectAction('Enable editing', () => projectController.enableEditing());
    },
    repairProject(): void {
      void runProjectAction('Repair project', () => projectController.repairProject());
    },
    renameProject(): void {
      void runProjectAction('Rename project', () =>
        projectController.renameProject(projectName.value),
      );
    },
    saveProject(): void {
      void runProjectAction('Save project', () => projectController.saveCurrent());
    },
    addJson(): void {
      void runProjectAction('Add JSON', () => projectController.addJsonToProject());
    },
    refreshImports(): void {
      void runProjectAction('Refresh imports', () => projectController.refreshImports());
    },
    importJson(): void {
      const ref = importRefs[importSelect.selectedIndex];
      if (ref !== undefined) {
        if (!confirmDestructive('import ' + ref.fileName + ' as current')) return;
        void runProjectAction('Import JSON', () => projectController.importStoredDoc(ref));
      }
    },
    refreshExports(): void {
      void runProjectAction('Refresh exports', () => projectController.refreshExports());
    },
    openExport(): void {
      const ref = exportRefs[exportSelect.selectedIndex];
      if (ref !== undefined) {
        const replaceFocusedTrigger = document.activeElement === openExport;
        void runProjectAction('Open export copy', async () => {
          await projectController.previewStoredExport(ref);
          if (!replaceFocusedTrigger) return;
          scheduleFocus(() => {
            const active = document.activeElement;
            const focusWasReleased =
              active === document.body ||
              (active instanceof Node && projectData.contains(active));
            return currentProjectState.previewing && focusWasReleased ? returnToProject : null;
          });
        });
      }
    },
    restoreExport(): void {
      const ref = exportRefs[exportSelect.selectedIndex];
      if (ref === undefined) return;
      if (!globalThis.confirm(restoreConfirmationCopy(currentProjectState, ref.fileName))) return;
      void runProjectAction('Restore from export', () =>
        projectController.restoreStoredExport(ref),
      );
    },
    returnToProject(): void {
      void runProjectAction('Return to project', () => projectController.returnToProject());
    },
    openTemporary(): void {
      if (currentProjectState.canPickTemporaryJson) {
        // Pinned order: picker FIRST on the click's fresh activation; the
        // discard confirm AFTER a file was actually picked and BEFORE
        // installing it. Confirm-first let a slow answer expire the transient
        // activation and made showOpenFilePicker throw SecurityError.
        void runProjectAction('Open temporary JSON', async () => {
          const source = await projectController.pickTemporaryJson();
          if (!confirmDestructive('open a temporary JSON document')) {
            // Same semantics as a picker cancel: Cancelled status, and a
            // pre-existing action error is NOT cleared by a non-action.
            throw new DOMException('Open cancelled by the user.', 'AbortError');
          }
          await projectController.openTemporarySource(source);
        });
        return;
      }
      if (!confirmDestructive('open a temporary JSON document')) return;
      fileInput.click();
    },
    restoreAutosave(): void {
      void runProjectAction('Restore autosave view', () =>
        projectController.restoreAutosaveView(),
      );
    },
    keepAutosave(): void {
      void runProjectAction('Keep current view', () => projectController.keepCurrentView());
    },
    exportAutosave(): void {
      void runProjectAction('Export autosave copy', () =>
        projectController.exportAutosaveCopy(),
      );
    },
    exportJson(): void {
      void doExport();
    },
  };

  const createProject = button('Create Project', handlers.createProject);
  const openProject = button('Open Project', handlers.openProject);
  const enableEditing = button('Enable editing', handlers.enableEditing);
  const repairProject = button('Repair project', handlers.repairProject);
  const renameProject = button('Rename', handlers.renameProject);
  const saveProject = button('Save', handlers.saveProject);
  const addJson = button('Add JSON', handlers.addJson);
  const refreshImports = button('Refresh imports', handlers.refreshImports);
  const importJson = button('Import JSON', handlers.importJson);
  const refreshExports = button('Refresh exports', handlers.refreshExports);
  const openExport = button('Open export copy', handlers.openExport);
  const restoreExport = button('Restore from export', handlers.restoreExport);
  const returnToProject = button('Return to project', handlers.returnToProject);
  const openTemporary = button('Open JSON temporarily', handlers.openTemporary);
  const restoreAutosave = button('Restore view', handlers.restoreAutosave);
  const keepAutosave = button('Keep current', handlers.keepAutosave);
  const exportAutosave = button('Export autosave copy', handlers.exportAutosave);
  const projectMessage = el('span', { class: 'project-message' }, []);
  const autosaveActions = el('span', { class: 'autosave-actions' }, [
    restoreAutosave,
    keepAutosave,
    exportAutosave,
  ]);
  const exportJson = button('Export JSON', handlers.exportJson, {
    title: 'Save this map, with your layout (S)',
    id: 'export-btn',
  });

  const projectShow = button(
    'Show project rail',
    () => setSurface('project', true, projectShow),
    {
      id: 'show-project-rail',
      'aria-controls': 'project-rail',
      'aria-expanded': 'true',
    },
  );
  const projectCollapse = button(
    'Collapse project rail',
    () => setSurface('project', false, projectShow),
    {
      id: 'collapse-project-rail',
      'aria-controls': 'project-rail',
      'aria-expanded': 'true',
    },
  );
  const expandedProjectName = el('bdi', { class: 'project-identity-name', dir: 'auto' });
  const expandedProjectId = el('span', {
    class: 'project-id-full',
    dir: 'ltr',
  });
  const expandedIdentityA11y = el('span', {
    class: 'sr-only',
    id: 'project-identity-expanded-label',
  });
  const expandedIdentityKind = el('span', { class: 'project-identity-kind' }, ['Project']);
  const expandedIdentity = el(
    'div',
    {
      class: 'project-identity',
      role: 'group',
      'aria-labelledby': 'project-identity-expanded-label',
    },
    [
      expandedIdentityA11y,
      expandedIdentityKind,
      expandedProjectName,
      el('span', { class: 'project-id-label' }, ['Project ID']),
      expandedProjectId,
    ],
  );
  const expandedStatusHost = el('div', {
    class: 'project-states',
    'aria-label': 'Project state',
  });
  const compactProjectName = el('bdi', { class: 'project-compact-name', dir: 'auto' });
  const compactProjectId = el('span', { class: 'project-id-compact', dir: 'ltr' });
  const compactIdentityA11y = el('span', {
    class: 'sr-only',
    id: 'project-identity-compact-label',
  });
  const compactIdentity = el(
    'span',
    {
      class: 'project-compact-identity',
      role: 'group',
      'aria-labelledby': 'project-identity-compact-label',
    },
    [
      compactIdentityA11y,
      compactProjectName,
      el('span', { class: 'project-id-label' }, ['ID']),
      compactProjectId,
    ],
  );
  const compactStatusHost = el('span', {
    class: 'project-compact-states',
    'aria-label': 'Project state',
  });

  const compactReturn = button('Return to project', handlers.returnToProject);
  const compactRepair = button('Repair project', handlers.repairProject);
  const compactEnable = button('Enable editing', handlers.enableEditing);
  const compactSave = button('Save', handlers.saveProject);
  const compactRecovery: HTMLButtonElement = button('Recovery available', () =>
    setSurface('project', true, compactRecovery),
  );
  const compactCritical = el('span', { class: 'project-compact-action' }, [
    compactReturn,
    compactRepair,
    compactEnable,
    compactSave,
    compactRecovery,
  ]);
  const projectCompact = el(
    'div',
    {
      class: 'project-compact',
      'aria-label': 'Project context',
    },
    [projectShow, compactIdentity, compactStatusHost, compactCritical],
  );

  const criticalActions = el('div', { class: 'project-critical-actions' }, [
    returnToProject,
    repairProject,
    enableEditing,
    saveProject,
  ]);
  const projectNameField = el('label', { class: 'project-name-field' }, [
    el('span', { class: 'field-label' }, ['Project name']),
    projectName,
  ]);
  const sessionKindLabel = el('span', { class: 'project-session-kind' });
  const sessionDisplayLabel = el('bdi', { class: 'project-session-label', dir: 'auto' });
  const sessionIdentity = el('p', { class: 'project-session-identity' }, [
    sessionKindLabel,
    sessionDisplayLabel,
  ]);
  const contextActions = el('div', { class: 'project-action-group' }, [
    sessionIdentity,
    projectNameField,
    createProject,
    openProject,
  ]);
  const projectEditActions = el('div', { class: 'project-action-group project-edit-actions' }, [
    renameProject,
    addJson,
  ]);
  const projectImportActions = el('div', { class: 'project-action-group project-import-actions' }, [
    refreshImports,
    importSelect,
    importJson,
  ]);
  const projectExportActions = el('div', { class: 'project-action-group project-export-actions' }, [
    refreshExports,
    exportSelect,
    openExport,
    restoreExport,
  ]);
  const projectData = el('section', { class: 'project-data', 'aria-label': 'Project data' }, [
    el('h3', { class: 'project-group-title' }, ['Project data']),
    projectEditActions,
    projectImportActions,
    projectExportActions,
  ]);
  const documentActions = el('section', { class: 'project-document', 'aria-label': 'Document' }, [
    el('h3', { class: 'project-group-title' }, ['Document']),
    el('div', { class: 'project-action-group project-document-actions' }, [
      openTemporary,
      exportJson,
    ]),
  ]);
  const projectOnly = el('div', { class: 'project-only' }, [
    expandedIdentity,
    expandedStatusHost,
    criticalActions,
    projectData,
    autosaveActions,
  ]);

  projectRail.append(
    el('div', { class: 'project-rail-header' }, [
      el('h2', {}, ['Project']),
      projectCollapse,
    ]),
    contextActions,
    projectOnly,
    documentActions,
    projectMessage,
  );

  function confirmDestructive(action: string): boolean {
    const copy = discardConfirmationCopy(currentProjectState, action);
    return copy === null || globalThis.confirm(copy);
  }

  const toolbar = el('div', { class: 'toolbar', role: 'toolbar', 'aria-label': 'Map controls' }, [
    el('div', { class: 'brand' }, [
      el('span', { class: 'brand-mark' }, ['◈']),
      el('span', { class: 'brand-name' }, ['Visual Specs']),
    ]),
    sidebarToggle,
    detailToggle,
    el('span', { class: 'divider' }, []),
    button('Fit', () => controller.fit(), { title: 'Fit the map to the window (F)' }),
    button('−', () => controller.zoomBy(1 / ZOOM_STEP), {
      title: 'Zoom out (-)',
      'aria-label': 'Zoom out',
      id: 'zoom-out',
    }),
    button('+', () => controller.zoomBy(ZOOM_STEP), {
      title: 'Zoom in (+)',
      'aria-label': 'Zoom in',
      id: 'zoom-in',
    }),
    el('span', { class: 'divider' }, []),
    button('Expand all', () => controller.dispatch({ type: 'ExpandAll' }), { title: 'Expand every container (E)' }),
    button('Collapse all', () => controller.dispatch({ type: 'CollapseAll' }), { title: 'Collapse everything (C)' }),
    button('Reset layout', () => controller.dispatch({ type: 'ResetLayout' }), {
      title: 'Throw away the positions you dragged and re-pack (R)',
    }),
    el('span', { class: 'spacer' }, []),
  ]);

  // Everything above the anchored modes scrolls together, exactly as the whole panel used
  // to. Only `modesHost` is pulled out of the flow, so the height reserved permanently is
  // just the mode bar's — the ~74 px the decision accepted, and not a pixel more.
  const sidebarScroll = el('div', { class: 'sidebar-scroll' }, [
    el('div', { class: 'field' }, [search]),
    countsHost,
    // The user placed the toggle "immediately below the counts box" and the
    // transparency control "in the left rail". Below 1664px the Project rail and the
    // Explorer are mutually exclusive (`applyLayout`), so a control in the rail could
    // not be adjusted while looking at the list it dims — and the leftmost panel that
    // holds the counts box and the node list satisfies both statements at once.
    focusHost,
    listHost,
    el('h3', { class: 'legend-title' }, ['Legend']),
    legendHost,
  ]);

  const sidebar = el('aside', { class: 'panel sidebar', id: 'explorer-panel', 'aria-label': 'Explorer' }, [
    sidebarScroll,
    modesHost,
  ]);

  const detailPanel = el('aside', { class: 'panel detail-panel', id: 'details-panel', 'aria-label': 'Details', tabindex: '-1' }, [
    detailHost,
  ]);

  const body = el('div', { class: 'body' }, [sidebar, canvasHost, detailPanel]);
  const workspaceMain = el('div', { class: 'workspace-main' }, [
    projectCompact,
    toolbar,
    actionErrorHost,
    bannerHost,
    body,
    statusHost,
    fileInput,
  ]);
  const workspace = el('div', { class: 'workspace' }, [projectRail, workspaceMain]);
  shell.appendChild(workspace);
  shell.appendChild(rowMenu);
  root.appendChild(shell);

  // --- behaviour -----------------------------------------------------------

  /** So that "Selection cleared." is announced on a real clear, and never on a load
   *  where there was nothing selected in the first place. */
  let hadSelection = false;
  /** A selection emptied BY a refresh is announced by the reload announcement
   *  (cause, not symptom); the bare "Selection cleared." is suppressed then. */
  let lastLoss: AppState['loss'] = null;
  /** Each live-region announcement from the project controller is spoken once. */
  let announcedSeq = 0;

  function setStatus(message: string): void {
    clear(statusHost);
    statusHost.appendChild(el('span', {}, [message]));
  }

  let actionEpoch = 0;
  const projectActionAttempts: Record<string, number> = Object.create(null) as Record<
    string,
    number
  >;

  function clearActionError(): void {
    actionErrorHost.textContent = '';
    actionErrorHost.hidden = true;
  }

  function reportActionError(action: string, err: unknown): void {
    const message =
      err instanceof VisualSpecsError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'The document could not be read.';
    actionErrorHost.textContent = action + ' failed. ' + message;
    actionErrorHost.hidden = false;
    setStatus(action + ' failed.');
  }

  async function runProjectAction(
    label: string,
    action: () => void | Promise<void>,
    successStatus?: string,
  ): Promise<void> {
    if (IS_TEST_BUILD) {
      projectActionAttempts[label] = (projectActionAttempts[label] ?? 0) + 1;
    }
    const epoch = ++actionEpoch;
    try {
      await action();
      if (epoch === actionEpoch) {
        clearActionError();
        if (successStatus !== undefined) setStatus(successStatus);
      }
    } catch (err) {
      if (epoch !== actionEpoch) return;
      if (isPickerCancellation(err)) {
        setStatus('Cancelled. No project or document state changed.');
        return;
      }
      reportActionError(label, err);
    }
  }

  async function doExport(): Promise<void> {
    await runProjectAction(
      'Export JSON',
      () => projectController.exportJson(),
      'Exported. Your layout, expansion and viewport are in the file.',
    );
  }

  // Read-only hooks for the browser tests: they let a test know WHERE a line is
  // drawn, which only the domain knows (§7). They never bypass the loop, and the
  // acceptance smoke drives import/export through the real controls.
  //
  // They exist ONLY in dev and test builds. A production bundle ships no such object —
  // and, since `IS_TEST_BUILD` folds to `false`, not even the name of one.
  if (IS_TEST_BUILD) {
    (globalThis as unknown as Record<string, unknown>)[TEST_HOOK] = {
      scene: () => controller.derived.scene.scene,
      viewport: () => controller.state.view.viewport,
      raw: () => controller.state.raw,
      // Read-only, like every other hook here: it answers "what mode is the app in",
      // which is what an anchored control has to keep dispatching unchanged (#48).
      levels: () => ({ ...controller.state.levels }),
      interaction: () => ({
        selection: {
          nodeIds: [...controller.state.selection.nodeIds],
          edgeId: controller.state.selection.edgeId,
        },
        expanded: [...controller.state.view.expanded],
        positions: [...controller.state.view.positions.entries()],
        filters: {
          nodeKinds: [...controller.state.filters.nodeKinds],
          edgeKinds: [...controller.state.filters.edgeKinds],
        },
      }),
      project: () => projectController.snapshot(),
      projectActions: () => ({ ...projectActionAttempts }),
      layout: () => ({
        band: currentBand,
        projectPreference,
        sidebarPreference,
        detailPreference,
        activeOverlay,
        projectOpen,
        sidebarOpen,
        detailOpen,
        timings: layoutTimings.map((timing) => ({ ...timing })),
        pendingFrames: {
          resize: resizeFrame !== null,
          paint: paintFrame !== null,
          focus: focusFrame !== null,
        },
        canvas: canvasHost.getBoundingClientRect().toJSON(),
      }),
    };
  }

  // FIT-7: true while a pointer gesture is in progress on the canvas. Read by onKey to
  // refuse view-mutating shortcuts mid-drag.
  let canvasGestureActive = false;
  const markGestureStart = (): void => {
    canvasGestureActive = true;
  };
  const markGestureEnd = (): void => {
    canvasGestureActive = false;
  };

  const onKey = (e: KeyboardEvent): void => {
    // The menu consumes Escape FIRST. The overlay branch below runs before
    // `isInteractionEvent`, so in the narrow and hybrid bands Escape would otherwise
    // close the whole sidebar and take the anchor row with it. The native popover
    // does not discharge this: light-dismiss closes the popover, and this
    // document-level listener still fires on the same keystroke.
    if (e.key === 'Escape' && menuNodeId !== null) {
      e.preventDefault();
      closeRowMenu();
      return;
    }
    if (e.key === 'Escape' && pendingConfirm !== null) {
      e.preventDefault();
      pendingConfirm = null;
      refreshFocus();
      focusToggle.focus({ preventScroll: true });
      return;
    }
    if (e.key === 'Escape' && activeOverlay !== null) {
      e.preventDefault();
      const closing = activeOverlay;
      const opener =
        closing === 'project'
          ? projectOpenerOrFallback()
          : overlayOpeners[closing] ??
            (closing === 'sidebar'
              ? sidebarToggle
              : detailToggle);
      setSurface(closing, false, opener);
      return;
    }
    if (isInteractionEvent(e)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // FIT-7: a view-mutating shortcut fired mid-gesture (a drag in progress on the
    // canvas) would leave a stale drag to commit on top of the mutation. Ignore the
    // view-mutating keys while a canvas pointer gesture is active; camera/panel/search
    // keys stay live.
    if (canvasGestureActive && 'eEcCrRhH'.includes(e.key)) return;
    switch (e.key) {
      case 'f':
      case 'F':
        controller.fit();
        break;
      case 'h':
      case 'H':
        // Fit the selected expanded container(s) to their contents (Issue #13). The
        // keyboard route required by §9.4; a no-op with guidance when the selection is
        // not an expanded container.
        fitContainers(controller.state.selection.nodeIds);
        break;
      case 'e':
      case 'E':
        controller.dispatch({ type: 'ExpandAll' });
        break;
      case 'c':
      case 'C':
        controller.dispatch({ type: 'CollapseAll' });
        break;
      case 'r':
      case 'R':
        controller.dispatch({ type: 'ResetLayout' });
        break;
      case 's':
      case 'S':
        if (currentProjectState.canExport) void doExport();
        break;
      case '+':
      case '=':
        controller.zoomBy(ZOOM_STEP);
        break;
      case '-':
      case '_':
        controller.zoomBy(1 / ZOOM_STEP);
        break;
      case '[':
        setPanel('sidebar', !sidebarOpen);
        break;
      case ']':
        setPanel('detail', !detailOpen);
        break;
      case 'Escape':
        break;
      case '/':
        e.preventDefault();
        if (!sidebarOpen) setPanel('sidebar', true);
        search.focus();
        break;
      default:
        break;
    }
  };
  document.addEventListener('keydown', onKey);
  canvasHost.addEventListener('pointerdown', markGestureStart);
  globalThis.addEventListener('pointerup', markGestureEnd);
  globalThis.addEventListener('pointercancel', markGestureEnd);

  const onResize = (): void => {
    const next = layoutBand();
    if (next !== currentBand) {
      const previous = currentBand;
      const focused = document.activeElement;
      const retainedProjectOverlay = activeOverlay === 'project';
      if (next === 'wide') {
        activeOverlay = null;
      } else if (next === 'hybrid') {
        const automaticallyPromoted =
          previous === 'wide' &&
          currentProjectState.manifestProjectId !== null &&
          projectPreference === 'expanded';
        activeOverlay =
          automaticallyPromoted
            ? 'project'
            : activeOverlay === 'project' && projectPreference === 'expanded'
              ? 'project'
              : null;
        if (activeOverlay === 'project') {
          if (automaticallyPromoted) overlayOpeners.project = projectShow;
          else preserveProjectOpenerOrFallback();
        }
      } else if (focused instanceof Node && projectRail.contains(focused)) {
        activeOverlay = currentProjectState.manifestProjectId === null ? null : 'project';
        if (activeOverlay === 'project') {
          if (retainedProjectOverlay) preserveProjectOpenerOrFallback();
          else overlayOpeners.project = projectShow;
        }
      } else if (focused instanceof Node && sidebar.contains(focused)) {
        activeOverlay = 'sidebar';
        overlayOpeners.sidebar = sidebarToggle;
      } else if (focused instanceof Node && detailPanel.contains(focused)) {
        activeOverlay = 'detail';
        overlayOpeners.detail = detailToggle;
      } else {
        activeOverlay = null;
      }
      currentBand = next;
    }
    applyLayout();
    const focused = document.activeElement;
    if (focused instanceof Node && projectRail.hidden && projectRail.contains(focused)) {
      projectShow.focus();
    } else if (focused instanceof Node && sidebar.hidden && sidebar.contains(focused)) {
      sidebarToggle.focus();
    } else if (focused instanceof Node && detailPanel.hidden && detailPanel.contains(focused)) {
      detailToggle.focus();
    }
  };
  globalThis.addEventListener('resize', onResize);

  /**
   * Fit every expanded container among `ids` to its contents (Issue #13), and say what
   * happened. The status is deliberately honest (FIT-9): it never calls `Reset layout`
   * an "undo" — `R` re-packs the whole map — and it names the container, no more.
   *
   * `setStatus` runs AFTER dispatch because `announce()` (fired synchronously inside
   * dispatch for the still-selected container) would otherwise be the last word.
   */
  function fitContainers(ids: readonly string[]): void {
    const state = controller.state;
    const targets = ids.filter(
      (id) => state.view.expanded.has(id) && state.outline.childrenOf(id).length > 0,
    );
    if (targets.length === 0) {
      setStatus('Select an expanded container to fit it to its contents.');
      return;
    }
    for (const id of targets) controller.dispatch({ type: 'FitContainer', id });
    const first = state.model.nodeById.get(state.outline.entityOf(targets[0] as string));
    setStatus(
      targets.length === 1
        ? `Fitted ${first?.label ?? 'container'} to its contents.`
        : `Fitted ${targets.length} containers to their contents.`,
    );
  }

  // ─── focus: controls, menu and the counter (Issue #17) ─────────────────────

  const FOCUS_MIN = DEFAULT_LIMITS.minFocusTransparency;
  const FOCUS_MAX = DEFAULT_LIMITS.maxFocusTransparency;

  /** The row the open menu acts on. The menu holds the ID, never the row element:
   *  `renderList` rebuilds every row on every notification, including the one the
   *  menu's own command causes. */
  let menuNodeId: string | null = null;
  /** Every row currently mounted, by node id — the menu's anchor lookup and the
   *  focus restore both need it, and neither can hold an element across a rebuild. */
  const rowsById = new Map<string, HTMLElement>();
  /** Which ids the node list is actually showing. `renderList` drops `file` and
   *  `directory` on an empty query and caps at 400, so a mark can be UNREACHABLE
   *  rather than merely invisible; this is what the counter counts. */
  let listedIds = new Set<string>();
  /** The counter's disclosure — unlisted marks, as real rows. */
  let marksOpen = false;
  let pendingConfirm: { copy: string; run: () => void } | null = null;
  let transparencyNote = '';
  let transparencyFrame: number | null = null;
  let pendingTransparency: number | null = null;

  const focusToggle = button('Dim everything', () => onToggleAll(), {
    class: 'focus-toggle',
    id: 'focus-toggle',
  });
  const focusSummary = el('span', { class: 'focus-summary' }, []);
  const clearAll = button('Clear all focus', () => onClearAll(), { class: 'focus-clear' });
  const marksDisclosure = button('', () => {
    marksOpen = !marksOpen;
    refreshFocus();
  }, { class: 'focus-disclosure', 'aria-expanded': 'false' });
  const marksList = el('div', { class: 'focus-marks', role: 'listbox', 'aria-label': 'Marked entities not in the list' }, []);
  const transparencyRange = el('input', {
    type: 'range',
    class: 'focus-range',
    id: 'focus-transparency',
    min: FOCUS_MIN,
    max: FOCUS_MAX,
    step: 1,
    'aria-label': 'Out-of-focus transparency, percent',
  });
  const transparencyNumber = el('input', {
    type: 'number',
    class: 'focus-number',
    id: 'focus-transparency-value',
    min: FOCUS_MIN,
    max: FOCUS_MAX,
    step: 1,
    'aria-label': 'Out-of-focus transparency, percent (typed)',
  });
  const transparencyNoteHost = el('span', { class: 'focus-note', role: 'status' }, []);
  const confirmHost = el('div', { class: 'focus-confirm' }, []);

  focusHost.append(
    focusToggle,
    el('div', { class: 'focus-marks-row' }, [focusSummary, marksDisclosure, clearAll]),
    marksList,
    el('label', { class: 'focus-field', for: 'focus-transparency' }, ['Out-of-focus transparency']),
    el('div', { class: 'focus-slider' }, [
      transparencyRange,
      transparencyNumber,
      el('span', { class: 'focus-pct' }, ['%']),
    ]),
    transparencyNoteHost,
    confirmHost,
  );

  transparencyRange.addEventListener('input', () => {
    commitTransparency(transparencyRange.value, 'range');
  });
  transparencyNumber.addEventListener('input', () => {
    commitTransparency(transparencyNumber.value, 'number');
  });

  /**
   * A `range` fires continuously, so dispatches coalesce to one per animation frame.
   * Measured: `derive()` is p50 3.82 ms at expand-all, which leaves the rest of the
   * frame for the paint. A transparency keystroke re-running layout and projection
   * for what is only a paint constant is architecturally wrong and stays within
   * budget; restructuring belongs with #19.
   */
  function commitTransparency(raw: string, from: 'range' | 'number'): void {
    const value = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(value) || value < FOCUS_MIN || value > FOCUS_MAX) {
      // Never write an invalid state: the last valid value stays in force, and the
      // control says so instead of silently snapping.
      transparencyNote = `Enter a whole number between ${FOCUS_MIN} and ${FOCUS_MAX}. Keeping ${currentTransparency()}%.`;
      renderTransparencyNote();
      return;
    }
    transparencyNote = '';
    renderTransparencyNote();
    // Mirror the sibling control immediately so the pair never disagrees mid-drag.
    if (from === 'range') transparencyNumber.value = String(Math.round(value));
    else transparencyRange.value = String(Math.round(value));

    pendingTransparency = Math.round(value);
    if (transparencyFrame !== null) return;
    transparencyFrame = requestAnimationFrame(() => {
      transparencyFrame = null;
      const percent = pendingTransparency;
      pendingTransparency = null;
      if (destroyed || percent === null) return;
      controller.dispatch({ type: 'SetFocusTransparency', percent });
    });
  }

  function renderTransparencyNote(): void {
    clear(transparencyNoteHost);
    if (transparencyNote !== '') transparencyNoteHost.appendChild(el('span', {}, [transparencyNote]));
  }

  function currentTransparency(): number {
    return lastRendered?.state.view.focus.transparency ?? DEFAULT_LIMITS.maxFocusTransparency;
  }

  /** Marks that `SetAllFocus` can actually delete, and the inert ones it preserves. */
  function markCounts(state: AppState): { clearable: number; inert: number } {
    let clearable = 0;
    let inert = 0;
    for (const id of state.view.focus.marks.keys()) {
      if (state.model.nodeById.has(id)) clearable += 1;
      else inert += 1;
    }
    return { clearable, inert };
  }

  /**
   * Confirm ⟺ `inverse(apply(view)).marks ≠ view.marks`.
   *
   * The property itself, run rather than reasoned about. A case analysis of "which
   * marks would the inverse recreate" is wrong for more than one root, where the
   * damage is done by ADDING a mark rather than by deleting one; both commands are
   * pure and O(marks), so running the pair costs nothing and cannot drift from the
   * command it is predicting.
   *
   * `SetAllFocus` destroys in BOTH directions, and the casually-pressed one is
   * `Show everything` — "let me see everything for a second". There is no undo in
   * this application, and the autosave persists the loss before anyone can decline it.
   */
  function isReversible(state: AppState, mark: FocusMark): boolean {
    // `limits` only bounds `SetFocusTransparency`, which this pair never touches.
    const ctx = {
      model: state.model,
      outline: state.outline,
      geometry: controller.derived.geometry,
      limits: DEFAULT_LIMITS,
    };
    const inverse: FocusMark = mark === 'out-of-focus' ? 'in-focus' : 'out-of-focus';
    const applied = applyViewCommand(ctx, state.view, { type: 'SetAllFocus', mark });
    const back = applyViewCommand(ctx, applied, { type: 'SetAllFocus', mark: inverse });
    return sameMarks(back.focus.marks, state.view.focus.marks);
  }

  function sameMarks(
    a: ReadonlyMap<string, FocusMark>,
    b: ReadonlyMap<string, FocusMark>,
  ): boolean {
    if (a.size !== b.size) return false;
    for (const [id, mark] of a) {
      if (b.get(id) !== mark) return false;
    }
    return true;
  }

  function everyRootOut(state: AppState): boolean {
    const roots = state.outline.roots();
    return roots.length > 0 && roots.every((r) => state.view.focus.marks.get(r) === 'out-of-focus');
  }

  /**
   * An in-app confirmation, NOT `globalThis.confirm`. Chrome's "prevent this page from
   * creating additional dialogs" makes that return `false` for the rest of the page's
   * life; the app's two existing uses are rare project-lifecycle actions, but a focus
   * toggle is not, so one ticked box would turn `Dim everything` into a permanent
   * silent no-op. `null` copy means no confirmation is warranted, matching
   * `discardConfirmationCopy`.
   */
  function ask(copy: string | null, run: () => void): void {
    if (copy === null) {
      run();
      return;
    }
    pendingConfirm = { copy, run };
    refreshFocus();
    const confirmButton = confirmHost.querySelector('.focus-confirm-yes');
    if (confirmButton instanceof HTMLElement) confirmButton.focus({ preventScroll: true });
  }

  function onToggleAll(): void {
    const state = lastRendered?.state;
    if (state === undefined) return;
    const showing = everyRootOut(state);
    const mark: FocusMark = showing ? 'in-focus' : 'out-of-focus';
    const { clearable } = markCounts(state);
    const copy = isReversible(state, mark)
      ? null
      : `${showing ? 'Show everything' : 'Dim everything'} changes ${clearable} explicit mark(s) ` +
        `in a way pressing it again will not put back. There is no undo. Continue?`;
    ask(copy, () => {
      controller.dispatch({ type: 'SetAllFocus', mark });
    });
  }

  function onClearAll(): void {
    const state = lastRendered?.state;
    if (state === undefined) return;
    const { clearable } = markCounts(state);
    if (clearable === 0) return;
    ask(
      `Clear all focus deletes ${clearable} explicit mark(s). There is no undo. Continue?`,
      () => {
        controller.dispatch({ type: 'SetAllFocus', mark: 'in-focus' });
      },
    );
  }

  function effectiveFocusOf(derived: Derived, id: string): 'in' | 'out' {
    return derived.scene.focus?.effective.get(id) ?? 'in';
  }

  /** The nearest ancestor carrying an explicit mark — what an inherited row inherits
   *  FROM, which is the half of "inherited" a bare label leaves out. */
  function markedAncestorOf(state: AppState, id: string): string | null {
    let current = state.model.nodeById.get(id)?.parentId ?? null;
    while (current !== null) {
      if (state.view.focus.marks.has(current)) return current;
      current = state.model.nodeById.get(current)?.parentId ?? null;
    }
    return null;
  }

  function focusRowTitle(state: AppState, derived: Derived, id: string): string {
    const effective = effectiveFocusOf(derived, id);
    const mark = state.view.focus.marks.get(id);
    if (mark !== undefined) {
      return mark === 'out-of-focus'
        ? 'Out of focus — you marked this row.'
        : 'In focus — you marked this row, overriding an out-of-focus ancestor.';
    }
    if (effective === 'out') {
      const ancestor = markedAncestorOf(state, id);
      const label = ancestor === null ? null : state.model.nodeById.get(ancestor)?.label ?? ancestor;
      return label === null
        ? 'Out of focus — inherited.'
        : `Out of focus — inherited from ${label}.`;
    }
    return 'In focus.';
  }

  /** Glyph present ⟺ you said something about this row. Two shapes, not two colours,
   *  for the same reason the port distinguishes a crate by `cut-rect`. */
  function focusGlyph(mark: FocusMark | undefined): string | null {
    if (mark === 'out-of-focus') return '◐';
    if (mark === 'in-focus') return '○';
    return null;
  }

  // --- the row menu ---------------------------------------------------------

  function menuItems(state: AppState, derived: Derived, id: string): HTMLButtonElement[] {
    const effective = effectiveFocusOf(derived, id);
    const mark = state.view.focus.marks.get(id);
    // `<button role="menuitem">`, not `<div>`: `isInteractionEvent` whitelists BUTTON
    // by tag and knows nothing about `menuitem`, so a div would leave the bare-key
    // shortcuts live under typeahead — and `Reset to inherited` starts with `r`,
    // which is `ResetLayout`, which wipes a hand-made layout with no undo.
    const item = (label: string, run: () => void): HTMLButtonElement =>
      button(label, () => {
        closeRowMenu();
        run();
      }, { role: 'menuitem', class: 'row-menu-item' });

    const items: HTMLButtonElement[] = [
      effective === 'out'
        ? item('Bring into focus', () => {
            controller.dispatch({ type: 'SetFocus', id, requested: 'in-focus' });
          })
        : item('Send out of focus', () => {
            controller.dispatch({ type: 'SetFocus', id, requested: 'out-of-focus' });
          }),
    ];
    if (mark !== undefined) {
      items.push(
        item('Reset to inherited', () => {
          controller.dispatch({ type: 'SetFocusInherited', id });
        }),
      );
    }
    return items;
  }

  function openRowMenu(id: string, x: number, y: number): void {
    const rendered = lastRendered;
    if (rendered === null) return;
    closeRowMenu();
    menuNodeId = id;
    clear(rowMenu);
    // Name what this will act on. The canvas draws REPRESENTATIVES, not entities, so
    // right-clicking a collapsed box marks the container — correct, and not always
    // what the person is pointing at, especially when they are pointing at it because
    // the ▣ says something inside it differs.
    const node = rendered.state.model.nodeById.get(id);
    const collapsed =
      rendered.state.outline.childrenOf(id).length > 0 && !rendered.state.view.expanded.has(id);
    rowMenu.appendChild(
      el('p', { class: 'row-menu-label' }, [
        collapsed ? `${node?.label ?? id} and everything inside it` : node?.label ?? id,
      ]),
    );
    const items = menuItems(rendered.state, rendered.derived, id);
    for (const i of items) rowMenu.appendChild(i);
    rowMenu.style.left = `${String(Math.round(x))}px`;
    rowMenu.style.top = `${String(Math.round(y))}px`;
    rowMenu.showPopover();
    // Clamp AFTER showing: the size is only known once it is in the top layer.
    const box = rowMenu.getBoundingClientRect();
    const maxLeft = Math.max(0, globalThis.innerWidth - box.width - 4);
    const maxTop = Math.max(0, globalThis.innerHeight - box.height - 4);
    rowMenu.style.left = `${String(Math.round(Math.min(x, maxLeft)))}px`;
    rowMenu.style.top = `${String(Math.round(Math.min(y, maxTop)))}px`;
    // NOT through `scheduleFocus`: it keeps a single rAF slot and cancels whatever is
    // pending, so a follow tick or a pan would steal the menu's focus back to a row —
    // once a second under `extract:watch`.
    items[0]?.focus({ preventScroll: true });
  }

  function closeRowMenu(): void {
    if (menuNodeId === null) return;
    const id = menuNodeId;
    menuNodeId = null;
    rowMenu.hidePopover();
    const row = rowsById.get(id);
    if (row !== undefined && row.isConnected) row.focus({ preventScroll: true });
  }

  rowMenu.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    const items = [...rowMenu.querySelectorAll('.row-menu-item')].filter(
      (n): n is HTMLElement => n instanceof HTMLElement,
    );
    if (items.length === 0) return;
    e.preventDefault();
    const at = items.findIndex((n) => n === document.activeElement);
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? items.length - 1
          : e.key === 'ArrowDown'
            ? (at + 1 + items.length) % items.length
            : (at - 1 + items.length) % items.length;
    items[next]?.focus({ preventScroll: true });
  });

  // Light-dismiss closes the popover without telling us, so the id has to be synced
  // back or the next open would think one is already up.
  rowMenu.addEventListener('toggle', (e) => {
    const state = (e as unknown as { newState?: string }).newState;
    if (state === 'closed') menuNodeId = null;
  });

  // A scrolling list moves the anchor out from under a fixed menu.
  listHost.addEventListener('scroll', () => {
    closeRowMenu();
  });

  /**
   * The canvas is the second producer of a node id (§8.3.1), and it needed no new menu
   * machinery: the menu already holds an id rather than a row, because `renderList`
   * destroys rows. The constraint that forced that design is what makes this cheap.
   *
   * It matters most for the 98.7% of entities the sidebar will not list on an empty
   * query — a `file` box you can see, right-click and act on, with no search first.
   */
  const offRenderer =
    renderer?.on((event) => {
      if (event.type !== 'node:contextmenu') return;
      // Right-clicking MAKES it the selection, as a left click does. Demanding a prior
      // selection would cost two gestures for nothing.
      controller.dispatch({ type: 'Select', nodeIds: [event.id], edgeId: null });
      openRowMenu(event.id, event.client.x, event.client.y);
    }) ?? null;

  // A right-drag pans, and `contextmenu` fires at the start of it on Windows — so the
  // menu can open and then the camera moves out from under it. The first move with a
  // button held is the moment that stops being a click.
  canvasHost.addEventListener('pointermove', (e) => {
    if (e.buttons !== 0) closeRowMenu();
  });

  // --- the shared row, used by the node list AND by the counter's disclosure ---

  /**
   * One row builder, so an unlisted mark is reachable in exactly the same way as a
   * listed one — same glyph, same context menu, same `Reset to inherited`. A tooltip
   * would have made an unreachable mark *visible* and left it unreachable, which is
   * the easier half of the problem.
   *
   * `node === null` is an INERT mark: an id the model does not have. There is no
   * label, kind or path to render, so the row shows the raw id — and it keeps the
   * menu, because deleting an inert mark is the one meaningful thing you can do to it.
   */
  function buildNodeRow(
    state: AppState,
    derived: Derived,
    id: string,
    node: { label: string; kind: string; path?: string } | null,
    inList: boolean,
  ): HTMLElement {
    const style = nodeStyle(node?.kind ?? 'file');
    const selected = state.selection.nodeIds.includes(id);
    const effective = effectiveFocusOf(derived, id);
    const mark = state.view.focus.marks.get(id);
    const glyph = focusGlyph(mark);
    const visible = inList && derived.graph.visibleNodes.includes(id);

    const row = el(
      'button',
      {
        type: 'button',
        class:
          `node-row${selected ? ' selected' : ''}` +
          `${effective === 'out' ? ' out-of-focus' : ''}${node === null ? ' inert' : ''}`,
        role: 'option',
        'aria-selected': selected ? 'true' : 'false',
        'data-node-id': id,
        title: node === null ? `${id} — not in this graph` : node.path ?? id,
      },
      [
        el('span', { class: `swatch shape-${style.shape}`, style: `--swatch:${style.stroke}` }, []),
        el('span', { class: 'node-label' }, [node?.label ?? id]),
        el('span', { class: 'node-kind' }, [node === null ? 'inert' : node.kind]),
        glyph === null
          ? null
          : el('span', { class: 'node-focus', title: focusRowTitle(state, derived, id) }, [glyph]),
        inList && !visible
          ? el('span', { class: 'node-hidden', title: 'Hidden inside a collapsed box' }, ['⊂'])
          : null,
      ],
    );

    if (node !== null) {
      row.addEventListener('click', () => {
        // Reveal a hit that is hidden inside collapsed ancestors, then select it.
        controller.dispatch({ type: 'ExpandTo', id });
        controller.dispatch({ type: 'Select', nodeIds: [id], edgeId: null });
        controller.fit([id]);
      });
      row.addEventListener('dblclick', () => {
        controller.dispatch({ type: 'ToggleExpand', id });
      });
    }
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openRowMenu(id, e.clientX, e.clientY);
    });
    row.addEventListener('keydown', (e) => {
      // The context-menu key, and Shift+F10 for keyboards without one. Reaching an
      // arbitrary row without tabbing through its predecessors is #18.
      if (e.key !== 'ContextMenu' && !(e.key === 'F10' && e.shiftKey)) return;
      e.preventDefault();
      const box = row.getBoundingClientRect();
      openRowMenu(id, box.left + 8, box.bottom);
    });

    rowsById.set(id, row);
    return row;
  }

  function refreshFocus(): void {
    if (lastRendered !== null) renderFocusControls(lastRendered.state, lastRendered.derived);
  }

  function renderFocusControls(state: AppState, derived: Derived): void {
    const marks = state.view.focus.marks;
    const { clearable, inert } = markCounts(state);
    const showing = everyRootOut(state);

    // The label is the command's own fixpoint, not "is anything still in focus":
    // the latter reads idempotent on a map that is already dimmed except for one
    // deliberate exception, and pressing it would delete that exception.
    focusToggle.textContent = showing ? 'Show everything' : 'Dim everything';
    focusToggle.title = showing
      ? 'Bring the whole map back into focus'
      : 'Push the whole map out of focus';

    const unlisted = [...marks.keys()].filter((id) => !listedIds.has(id));
    const hasMarks = marks.size > 0;
    const marksRow = focusSummary.parentElement;
    if (marksRow !== null) marksRow.hidden = !hasMarks;
    marksList.hidden = !hasMarks || !marksOpen;

    focusSummary.textContent =
      inert === 0
        ? `${String(clearable)} marked`
        : `${String(clearable)} marked · ${String(inert)} inert`;
    // `N` counts only what `SetAllFocus` can delete. Counting inert marks too would
    // make the button read `Clear all focus (5)`, delete 3, then read
    // `Clear all focus (2)` and do nothing on every further press.
    clearAll.textContent = `Clear all focus (${String(clearable)})`;
    clearAll.hidden = clearable === 0;

    marksDisclosure.hidden = unlisted.length === 0;
    marksDisclosure.textContent = marksOpen
      ? 'Hide the ones not listed'
      : `Show ${String(unlisted.length)} not listed here`;
    marksDisclosure.setAttribute('aria-expanded', marksOpen ? 'true' : 'false');

    clear(marksList);
    if (hasMarks && marksOpen) {
      const shown = unlisted.slice(0, LIST_CAP);
      for (const id of shown) {
        const node = state.model.nodeById.get(id) ?? null;
        marksList.appendChild(buildNodeRow(state, derived, id, node, false));
      }
      if (unlisted.length > shown.length) {
        marksList.appendChild(
          el('p', { class: 'muted pad' }, [
            `… and ${String(unlisted.length - shown.length)} more. Clear all focus is the global escape.`,
          ]),
        );
      }
    }

    // Do not fight a control the user is holding: a `range` fires while dragged, and
    // rewriting its value mid-drag makes it stutter against its own dispatches.
    const percent = String(state.view.focus.transparency);
    if (document.activeElement !== transparencyRange) transparencyRange.value = percent;
    if (document.activeElement !== transparencyNumber) transparencyNumber.value = percent;

    clear(confirmHost);
    if (pendingConfirm !== null) {
      const { copy, run } = pendingConfirm;
      confirmHost.appendChild(
        el('div', { class: 'focus-confirm-box', role: 'alertdialog', 'aria-label': 'Confirm' }, [
          el('p', {}, [copy]),
          el('div', { class: 'focus-confirm-actions' }, [
            button('Continue', () => {
              pendingConfirm = null;
              run();
              refreshFocus();
              focusToggle.focus({ preventScroll: true });
            }, { class: 'focus-confirm-yes' }),
            button('Cancel', () => {
              pendingConfirm = null;
              refreshFocus();
              focusToggle.focus({ preventScroll: true });
            }, { class: 'focus-confirm-no' }),
          ]),
        ]),
      );
    }
  }

  const cb = {
    onSelectNode: (id: string): void => {
      controller.dispatch({ type: 'Select', nodeIds: [id], edgeId: null });
    },
    onExpandTo: (id: string): void => {
      controller.dispatch({ type: 'ExpandTo', id });
    },
    onSelectBucket: (id: InternalBucketId): void => {
      controller.dispatch({ type: 'Select', nodeIds: [], edgeId: id });
    },
    onFitContainer: (id: string): void => {
      fitContainers([id]);
    },
    onResetLayoutScope: (id: string): void => {
      // Scoped, so the rest of the document keeps the layout the user made. The panel
      // already stated how many pins this discards before offering the button.
      controller.dispatch({ type: 'ResetLayout', scope: id });
    },
  };

  let lastRendered: { state: AppState; derived: Derived } | null = null;
  const unsubscribe = controller.subscribe((state, derived) => {
    lastRendered = { state, derived };
    // The menu survives notifications by design — panning fires one per pointermove
    // and a followed document fires one a second — but not the disappearance of the
    // thing it acts on. O(1), so the guard cannot become the cost it avoids.
    if (menuNodeId !== null && !state.model.nodeById.has(menuNodeId)) closeRowMenu();
    renderBanners(state, derived);
    renderCounts(state, derived);
    renderList(state, derived);
    renderFocusControls(state, derived);
    renderLegend(state);
    renderModes(state);
    renderDetail(detailHost, state, derived, cb);
    announce(state, derived);
    positionProjectOverlay();
  });
  const unsubscribeProject = projectController.subscribe(renderProjectState);

  applyLayout();

  function renderBanners(state: AppState, derived: Derived): void {
    clear(bannerHost);

    // The document names a commit but was extracted from a DIRTY working tree, so every
    // `path:line` in it describes the files on disk rather than the files at that commit.
    // A map that cannot back its own provenance has to say so, out loud, at the top.
    if (state.model.source?.dirty === true) {
      const commit = state.model.source.commit?.slice(0, 7) ?? 'the commit';
      bannerHost.appendChild(
        el('div', { class: 'banner warn dirty' }, [
          el('strong', {}, ['Extracted from a dirty working tree. ']),
          el('span', {}, [
            `Tracked files differ from ${commit}, so the evidence points at the files on disk, ` +
              `not at that commit.`,
          ]),
        ]),
      );
    }

    // A quiet map is not a trustworthy map (§9.3).
    const degraded = state.model.coverage.filter((c) => c.status !== 'available');
    if (degraded.length > 0) {
      bannerHost.appendChild(
        el('div', { class: 'banner warn coverage' }, [
          el('strong', {}, ['Coverage: ']),
          ...degraded.flatMap((c) => [
            el('span', { class: 'cov' }, [
              el('code', {}, [c.kind]),
              el('span', { class: `cov-status ${c.status}` }, [c.status]),
              el('span', { class: 'muted' }, [c.reason ?? '']),
            ]),
          ]),
        ]),
      );
    }

    const unresolved = state.model.unresolved.length;
    if (unresolved > 0) {
      bannerHost.appendChild(
        el('div', { class: 'banner info unresolved' }, [
          el('strong', {}, [`${unresolved} unresolved `]),
          el('span', {}, [
            'relation(s) were seen but not guessed at. They are listed in the document, with evidence.',
          ]),
        ]),
      );
    }

    if (state.readOnly) {
      bannerHost.appendChild(
        el('div', { class: 'banner warn' }, [
          el('strong', {}, ['Read-only. ']),
          el('span', {}, [
            'This document declares a requirement this build does not implement, so it will not be written back.',
          ]),
        ]),
      );
    }

    for (const w of state.warnings) {
      if (
        w.code === 'unknown-minor' ||
        w.code === 'snippet-present' ||
        w.code === 'absolute-path-in-free-form-field'
      ) {
        bannerHost.appendChild(el('div', { class: 'banner info' }, [el('span', {}, [w.message])]));
      }
    }

    if (state.loss !== null) {
      const l = state.loss;
      bannerHost.appendChild(
        el('div', { class: 'banner info' }, [
          el('strong', {}, [
            currentProjectState.followState.kind !== 'none' && currentProjectState.lastReloadAt !== null
              ? `Refreshed at ${currentProjectState.lastReloadAt}. `
              : 'Refreshed. ',
          ]),
          // All FOUR dropped kinds, not two. `droppedFitted` has been in `LossReport`
          // since #13 and was printed by nothing; a focus mark would have been the
          // second silent one. Losing a layout is recoverable — auto-layout re-derives
          // it — but nothing in this system can re-derive what a person chose to push
          // into the background, and under follow-file the refresh is unattended.
          el('span', {}, [
            `${l.newNodes.length} new node(s); dropped ${l.droppedPositions.length} position(s), ` +
              `${l.droppedExpanded.length} expanded id(s), ${l.droppedFitted.length} fitted id(s) and ` +
              `${l.droppedFocus.length} focus mark(s) that no longer exist; ${l.reparented.length} reparented.`,
          ]),
        ]),
      );
    }

    // The second mask, said the same way as the first. `applyLayout` starts the
    // Explorer CLOSED at narrow, and closed at hybrid in a temporary session with no
    // project — and every focus control lives inside it, so without this a person
    // meets a visibly faded map with no on-screen explanation and no on-screen escape.
    // Reachable by dimming, resizing, and coming back tomorrow, because focus
    // survives a reload. `renderBanners` rebuilds from state, so it cannot be
    // clobbered by the next notification the way the single `status` slot would be.
    if (!sidebarOpen && state.view.focus.marks.size > 0) {
      const marked = state.view.focus.marks.size;
      bannerHost.appendChild(
        el('div', { class: 'banner info focus-off-explorer' }, [
          el('span', {}, [
            `Focus is dimming ${marked} marked entit${marked === 1 ? 'y' : 'ies'} and what they contain. ` +
              `Projection is unchanged — focus is a mask, not a re-projection. ` +
              `Open the Explorer to change or clear it.`,
          ]),
        ]),
      );
    }

    const hidden = derived.scene.hiddenByFilter;
    if (hidden.nodes > 0 || hidden.edges > 0) {
      bannerHost.appendChild(
        el('div', { class: 'banner info' }, [
          el('span', {}, [
            `A filter is hiding ${hidden.nodes} node(s) and ${hidden.edges} relation(s). Projection is unchanged — a filter is a mask, not a re-projection.`,
          ]),
        ]),
      );
    }
  }

  function renderCounts(state: AppState, derived: Derived): void {
    clear(countsHost);
    const internal = derived.graph.internalBuckets.reduce((n, b) => n + b.count, 0);
    countsHost.appendChild(
      el('dl', { class: 'counts-grid' }, [
        el('dt', {}, ['Nodes']),
        el('dd', {}, [String(state.model.nodes.length)]),
        el('dt', {}, ['Relations']),
        el('dd', {}, [String(state.model.edges.length)]),
        el('dt', {}, ['Drawn']),
        el('dd', {}, [String(derived.graph.visibleEdges.length)]),
        el('dt', {}, ['Folded away']),
        el(
          'dd',
          {
            title:
              'Relations with both endpoints inside one collapsed box. Select the box to see them.',
          },
          [String(internal)],
        ),
      ]),
    );
  }

  function renderList(state: AppState, derived: Derived): void {
    // `renderList` runs on EVERY controller notification and rebuilds every row, so
    // the focused row is destroyed under the user — today focus falls to `<body>`.
    // Remember it by id and restore it after, and ONLY when focus was in the list:
    // restoring unconditionally would steal it from whatever else had it, including
    // the menu, once a second under `extract:watch`.
    const active = document.activeElement;
    const restoreId =
      active instanceof HTMLElement && listHost.contains(active)
        ? active.dataset['nodeId'] ?? null
        : null;

    clear(listHost);
    rowsById.clear();
    listedIds = new Set<string>();
    const query = state.search.query.trim();
    const nodes =
      query === ''
        ? state.model.nodes.filter((n) => n.kind !== 'file' && n.kind !== 'directory')
        : state.model.nodes.filter((n) => state.search.matches.has(n.id));

    if (nodes.length === 0) {
      listHost.appendChild(el('p', { class: 'muted pad' }, ['No node matches.']));
      return;
    }

    const shown = nodes.slice(0, LIST_CAP);
    for (const node of shown) {
      listedIds.add(node.id);
      listHost.appendChild(buildNodeRow(state, derived, node.id, node, true));
    }
    if (nodes.length > shown.length) {
      listHost.appendChild(
        el('p', { class: 'muted pad' }, [`… and ${nodes.length - shown.length} more. Narrow the search.`]),
      );
    }

    if (restoreId !== null) {
      const row = rowsById.get(restoreId);
      if (row !== undefined) row.focus({ preventScroll: true });
    }
  }

  function renderLegend(state: AppState): void {
    clear(legendHost);

    const nodeKinds = [...new Set(state.model.nodes.map((n) => n.kind))].sort();
    const edgeKinds = [...new Set(state.model.edges.map((e) => e.kind))].sort();

    for (const kind of nodeKinds) {
      const style = nodeStyle(kind);
      const on = state.filters.nodeKinds.has(kind);
      legendHost.appendChild(
        toggleRow(kind, style.stroke, style.title, on, `shape-${style.shape}`, () => {
          const next = new Set(state.filters.nodeKinds);
          if (on) next.delete(kind);
          else next.add(kind);
          controller.dispatch({ type: 'SetFilter', nodeKinds: next });
        }),
      );
    }
    for (const kind of edgeKinds) {
      const style = edgeStyle(kind);
      const on = state.filters.edgeKinds.has(kind);
      legendHost.appendChild(
        toggleRow(kind, style.color, style.title, on, 'edge', () => {
          const next = new Set(state.filters.edgeKinds);
          if (on) next.delete(kind);
          else next.add(kind);
          controller.dispatch({ type: 'SetFilter', edgeKinds: next });
        }),
      );
    }

  }

  /**
   * The view modes, in their own anchored bar (Issue #48).
   *
   * Same rows and the SAME COMMANDS as when they lived at the bottom of the legend —
   * `SetFilter` and `SetLevels`, unchanged. What moved is where they are drawn.
   */
  function renderModes(state: AppState): void {
    clear(modesHost);

    const testsOn = state.filters.hideTests;
    modesHost.appendChild(
      toggleRow('hide tests', '#94a3b8', 'Mask files the extractor marked as tests', testsOn, 'edge', () => {
        controller.dispatch({ type: 'SetFilter', hideTests: !testsOn });
      }),
    );

    // Levels (Issue #44). Two controls, because the basis is not a colour: `observed` and
    // `proposed` are two ARRANGEMENTS of the same document, so switching re-ranks and the
    // boxes move. `observed` is the default — it is what was measured, while `proposed` is
    // the output of a heuristic — and it is always labelled as such on screen.
    const levelsOn = state.levels.active;
    modesHost.appendChild(
      toggleRow(
        'levels',
        '#8ea0bf',
        'Lay each container out by dependency level: high rank on top, so every dependency points down',
        levelsOn,
        'edge',
        () => {
          controller.dispatch({ type: 'SetLevels', active: !levelsOn });
        },
      ),
    );
    // The bar grows from two rows to three here. It grows UPWARD, into the scrollable area
    // above it: its bottom edge is pinned to the foot of the panel and its top edge rises,
    // so a third row can never push `levels` past the bottom of the viewport. Measured —
    // `.modes` bottom stays put (661 → 661) while top rises (594 → 564). That is what
    // anchoring buys, and it is acceptance criterion 3.
    if (levelsOn) {
      const proposed = state.levels.basis === 'proposed';
      modesHost.appendChild(
        toggleRow(
          'proposed basis',
          '#d99a4e',
          'Show the levels a proposed cut would produce. The rank is exact given the cut; ' +
            'what is heuristic is the cut, and badges say so with *',
          proposed,
          'edge',
          () => {
            controller.dispatch({ type: 'SetLevels', basis: proposed ? 'observed' : 'proposed' });
          },
        ),
      );
    }
  }

  function toggleRow(
    label: string,
    color: string,
    title: string,
    on: boolean,
    shapeClass: string,
    onToggle: () => void,
  ): HTMLElement {
    const b = el(
      'button',
      {
        type: 'button',
        class: `legend-row${on ? '' : ' off'}`,
        title,
        'aria-pressed': on ? 'true' : 'false',
      },
      [
        el('span', { class: `swatch ${shapeClass}`, style: `--swatch:${color}` }, []),
        el('span', {}, [label]),
      ],
    );
    b.addEventListener('click', onToggle);
    return b;
  }

  /**
   * Announce what is selected — a node, an AGGREGATED EDGE, or an INTERNAL BUCKET.
   *
   * The first cut returned early when there was no selected node, so clicking the one
   * line that carries 133 command relations announced nothing at all. The thing this
   * product exists to tell you was the thing it would not say out loud.
   *
   * Clearing the selection is also an event. Returning early left the *previous*
   * selection announced, so a screen reader would still be describing a thing that is
   * no longer selected. `hadSelection` is what keeps that from firing on a fresh load,
   * where nothing was ever selected and there is nothing to clear.
   */
  function announce(state: AppState, derived: Derived): void {
    const lossChanged = state.loss !== lastLoss;
    lastLoss = state.loss;
    const edgeId = state.selection.edgeId;
    const hasSelection = edgeId !== null || state.selection.nodeIds.length > 0;
    if (!hasSelection) {
      if (hadSelection && !lossChanged) setStatus('Selection cleared.');
      hadSelection = false;
      return;
    }
    hadSelection = true;

    if (edgeId !== null) {
      const visible = derived.graph.visibleEdgeById.get(edgeId as never);
      if (visible !== undefined) {
        const source = state.model.nodeById.get(state.outline.entityOf(visible.sourceId));
        const target = state.model.nodeById.get(state.outline.entityOf(visible.targetId));
        setStatus(
          `Selected relation ${visible.kind}, ${source?.label ?? visible.sourceId} to ${target?.label ?? visible.targetId}. ` +
            `${visible.count} logical relation${visible.count === 1 ? '' : 's'} behind it, listed with evidence in the detail panel.`,
        );
        return;
      }
      const bucket = derived.graph.internalBucketById.get(edgeId as never);
      if (bucket !== undefined) {
        const container = state.model.nodeById.get(state.outline.entityOf(bucket.containerId));
        setStatus(
          `Selected ${bucket.count} ${bucket.kind} relation${bucket.count === 1 ? '' : 's'} folded inside ${container?.label ?? bucket.containerId}.`,
        );
        return;
      }
    }

    const id = state.selection.nodeIds[0];
    if (id === undefined) return;
    const node = state.model.nodeById.get(state.outline.entityOf(id));
    if (node === undefined) return;
    const buckets = derived.graph.internalBucketsByNode.get(id) ?? [];
    const folded = buckets.reduce((n, b) => n + b.count, 0);
    const where = ancestryOf(state.model, node.id)
      .map((a) => state.model.nodeById.get(a)?.label ?? a)
      .join(' / ');
    setStatus(
      `Selected ${node.kind} ${node.label} — ${where}.` +
        (folded > 0 ? ` ${folded} relation${folded === 1 ? '' : 's'} folded inside it.` : ''),
    );
  }

  function setHiddenSafely(
    element: HTMLElement,
    hidden: boolean,
    focusDestination: HTMLElement = projectCollapse,
  ): void {
    if (hidden) {
      const focused = document.activeElement;
      if (focused instanceof Node && element.contains(focused)) focusDestination.focus();
    }
    element.hidden = hidden;
  }

  function renderEscapedAtoms(host: HTMLElement, atoms: readonly string[]): void {
    clear(host);
    // Newlines are presentation-only line boxes inserted strictly BETWEEN escape
    // atoms. One text node keeps DOM work bounded at the contract maximum; no atom
    // is sliced, the rail cannot overflow horizontally, and the associated hidden
    // accessible label retains the exact separator-free escaped identity.
    const lines: string[] = [];
    let line = '';
    let columns = 0;
    for (const atom of atoms) {
      if (columns > 0 && columns + atom.length > PROJECT_ID_COLUMNS_PER_LINE) {
        lines.push(line);
        line = '';
        columns = 0;
      }
      line += atom;
      columns += atom.length;
    }
    if (line !== '') lines.push(line);
    host.dataset['atomCount'] = String(atoms.length);
    host.dataset['lineCount'] = String(lines.length);
    host.textContent = lines.join('\n');
  }

  function patchStoredSelect(
    select: HTMLSelectElement,
    refs: readonly StoredDocRef[],
    emptyLabel: string,
  ): void {
    const selected = select.value;
    const existing = new Map(
      Array.from(select.options, (option) => [option.value, option] as const),
    );
    const desired =
      refs.length === 0
        ? [{ id: '', displayName: emptyLabel }]
        : refs.map((ref) => ({ id: ref.id, displayName: ref.displayName }));
    const retained = new Set<HTMLOptionElement>();
    for (const item of desired) {
      const option = existing.get(item.id) ?? el('option', { value: item.id });
      option.value = item.id;
      if (option.textContent !== item.displayName) option.textContent = item.displayName;
      retained.add(option);
      select.appendChild(option);
    }
    for (const option of Array.from(select.options)) {
      if (!retained.has(option)) option.remove();
    }
    select.value = desired.some((item) => item.id === selected) ? selected : desired[0]?.id ?? '';
  }

  function renderProjectState(project: ProjectControllerState): void {
    const previousManifestId = renderedManifestProjectId;
    const hasProject = project.manifestProjectId !== null;
    const committedDifferentProject =
      hasProject &&
      previousManifestId !== undefined &&
      project.manifestProjectId !== previousManifestId;
    currentProjectState = project;

    if (project.announcement !== null && project.announcement.seq !== announcedSeq) {
      announcedSeq = project.announcement.seq;
      setStatus(project.announcement.text);
    }
    // The reload banner reads lastReloadAt from THIS snapshot; re-render it so
    // the timestamp never lags one reload behind the message line.
    if (lastRendered !== null) renderBanners(lastRendered.state, lastRendered.derived);

    const nameNeedsSync =
      project.projectKey !== renderedProjectKey ||
      project.name !== renderedProjectName ||
      project.manifestProjectId !== previousManifestId;
    if (
      nameNeedsSync &&
      document.activeElement !== projectName &&
      !projectNameComposing
    ) {
      projectName.value = project.name;
      renderedProjectKey = project.projectKey;
      renderedProjectName = project.name;
    }

    sessionKindLabel.textContent =
      project.sessionKind === 'example'
        ? 'Example: '
        : project.sessionKind === 'temporary'
          ? 'Temporary: '
          : project.sessionKind === 'project-preview'
            ? 'Project preview: '
            : 'Project: ';
    sessionDisplayLabel.textContent =
      project.sessionKind === 'project' || project.sessionKind === 'project-preview'
        ? project.name
        : project.displayLabel;

    if (hasProject) {
      const rawId = project.manifestProjectId as string;
      const previousForCollision =
        selectedProjectIdentity !== null &&
        selectedProjectIdentity.name === project.name &&
        selectedProjectIdentity.rawId !== rawId
          ? selectedProjectIdentity
          : null;
      const escaped = escapeManifestProjectId(rawId);
      const token =
        selectedProjectIdentity !== null && selectedProjectIdentity.rawId === rawId
          ? selectedProjectIdentity.compactToken
          : compactManifestProjectId(rawId, previousForCollision);
      selectedProjectIdentity = { name: project.name, rawId, compactToken: token };

      expandedProjectName.textContent = project.name;
      compactProjectName.textContent = project.name;
      compactProjectId.textContent = token;
      renderEscapedAtoms(expandedProjectId, escaped.atoms);
      const accessibleIdentity =
        'Project ' + project.name + '. Project ID ' + escaped.full + '.';
      expandedIdentityA11y.textContent = accessibleIdentity;
      compactIdentityA11y.textContent = accessibleIdentity;
      expandedIdentityKind.textContent =
        project.sessionKind === 'project-preview' ? 'Project preview' : 'Project';
    } else {
      expandedProjectName.textContent = project.displayLabel;
      compactProjectName.textContent = '';
      compactProjectId.textContent = '';
      expandedProjectId.textContent = '';
      expandedIdentityA11y.textContent = '';
      compactIdentityA11y.textContent = '';
    }
    renderedManifestProjectId = project.manifestProjectId;

    if (committedDifferentProject) {
      projectPreference = 'expanded';
      if (layoutBand() !== 'wide') {
        activeOverlay = 'project';
        overlayOpeners.project = projectShow;
      }
    } else if (!hasProject && activeOverlay === 'project') {
      activeOverlay = null;
    }

    const presentation = deriveProjectPresentation(project);
    expandedStatusHost.textContent = presentation.statuses.join(' · ');
    compactStatusHost.textContent = presentation.statuses.join(' · ');

    createProject.disabled = !project.canCreateProject;
    createProject.hidden = project.previewing;
    openProject.disabled = !project.canOpenProject;
    openTemporary.disabled = project.lifecycleBusy;
    projectName.disabled = project.lifecycleBusy;

    const critical = presentation.criticalAction;
    setHiddenSafely(returnToProject, critical !== 'return');
    setHiddenSafely(repairProject, critical !== 'repair');
    setHiddenSafely(enableEditing, critical !== 'enable');
    setHiddenSafely(saveProject, critical !== 'save');
    setHiddenSafely(compactReturn, critical !== 'return', projectShow);
    setHiddenSafely(compactRepair, critical !== 'repair', projectShow);
    setHiddenSafely(compactEnable, critical !== 'enable', projectShow);
    setHiddenSafely(compactSave, critical !== 'save', projectShow);
    setHiddenSafely(compactRecovery, !project.pendingAutosave, projectShow);

    returnToProject.disabled = !project.canReturnToProject;
    repairProject.disabled = !project.canRepairProject;
    enableEditing.disabled = !project.canEnableEditing;
    saveProject.disabled = !project.canWriteProject;
    compactReturn.disabled = !project.canReturnToProject;
    compactRepair.disabled = !project.canRepairProject;
    compactEnable.disabled = !project.canEnableEditing;
    compactSave.disabled = !project.canWriteProject;

    renameProject.disabled = !project.canWriteProject;
    setHiddenSafely(renameProject, !project.canWriteProject);
    addJson.disabled = !project.canAddImport;
    setHiddenSafely(addJson, !project.canAddImport);
    refreshImports.disabled = !project.canBrowseProject;
    importJson.disabled = !project.canImport || project.imports.length === 0;
    setHiddenSafely(importJson, !project.canImport);
    importSelect.disabled = !project.canBrowseProject || project.imports.length === 0;
    refreshExports.disabled = !project.canBrowseProject;
    openExport.disabled = !project.canBrowseProject || project.exports.length === 0;
    restoreExport.disabled = !project.canRestoreExport || project.exports.length === 0;
    setHiddenSafely(restoreExport, !project.canRestoreExport);
    exportSelect.disabled = !project.canBrowseProject || project.exports.length === 0;
    exportJson.disabled = !project.canExport;
    restoreAutosave.disabled = project.lifecycleBusy;
    keepAutosave.disabled = project.lifecycleBusy;
    exportAutosave.disabled = project.readOnly || project.lifecycleBusy;
    setHiddenSafely(exportAutosave, project.readOnly);

    setHiddenSafely(projectOnly, !hasProject, createProject);
    setHiddenSafely(projectData, !hasProject || project.previewing);
    setHiddenSafely(autosaveActions, !project.pendingAutosave || project.previewing);
    setHiddenSafely(projectCollapse, !hasProject, createProject);

    if (importRefs !== project.imports) {
      importRefs = project.imports;
      patchStoredSelect(importSelect, project.imports, 'No imports');
    }
    if (exportRefs !== project.exports) {
      exportRefs = project.exports;
      patchStoredSelect(exportSelect, project.exports, 'No export copies');
    }

    projectMessage.textContent =
      (project.followState.kind !== 'none' ? project.followState.label + ' \u00b7 ' : '') +
      project.persistenceLabel +
      ' ' +
      project.message;
    applyLayout();
    if (committedDifferentProject) {
      scheduleFocus(() => (projectRail.hidden ? null : projectCollapse));
    }
  }

  return {
    destroy(): void {
      destroyed = true;
      layoutToken += 1;
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      if (paintFrame !== null) cancelAnimationFrame(paintFrame);
      if (focusFrame !== null) cancelAnimationFrame(focusFrame);
      resizeFrame = null;
      paintFrame = null;
      focusFrame = null;
      unsubscribe();
      unsubscribeProject();
      if (offRenderer !== null) offRenderer();
      closeRowMenu();
      if (transparencyFrame !== null) cancelAnimationFrame(transparencyFrame);
      transparencyFrame = null;
      document.removeEventListener('keydown', onKey);
      canvasHost.removeEventListener('pointerdown', markGestureStart);
      globalThis.removeEventListener('pointerup', markGestureEnd);
      globalThis.removeEventListener('pointercancel', markGestureEnd);
      globalThis.removeEventListener('resize', onResize);
      if (IS_TEST_BUILD) {
        delete (globalThis as unknown as Record<string, unknown>)[TEST_HOOK];
      }
      clear(root);
    },
  };
}

export function canvasHostOf(root: HTMLElement): HTMLElement {
  const host = root.querySelector('.canvas-host');
  if (host === null) throw new Error('the canvas host was not mounted');
  return host as HTMLElement;
}

function isInteractionEvent(event: KeyboardEvent): boolean {
  const interactiveTags = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON']);
  for (const target of event.composedPath()) {
    if (!(target instanceof Element)) continue;
    if (interactiveTags.has(target.tagName)) return true;
    if (target instanceof HTMLAnchorElement && target.hasAttribute('href')) return true;
    if (target instanceof HTMLElement && target.isContentEditable) return true;
    const role = target.getAttribute('role');
    if (role === 'combobox' || role === 'listbox' || role === 'option') return true;
  }
  return false;
}

function isPickerCancellation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    String(err.name) === 'AbortError'
  );
}
