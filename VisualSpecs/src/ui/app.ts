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
import { ancestryOf } from '../contract/model.ts';
import type { Controller, Derived } from '../app/controller.ts';
import type { ProjectController, ProjectControllerState } from '../app/projectController.ts';
import type { AppState } from '../app/state.ts';
import { edgeStyle, nodeStyle } from '../app/registry.ts';
import type { StoredDocRef } from '../ports/projectStore.ts';
import type { InternalBucketId } from '../projection/types.ts';
import { clear, button, el } from './dom.ts';
import { renderDetail } from './detail.ts';

export interface AppUi {
  destroy(): void;
}

const WIDE_MIN_WIDTH = 1664;
const HYBRID_MIN_WIDTH = 1200;
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

export function mountUi(root: HTMLElement, controller: Controller, projectController: ProjectController): AppUi {
  clear(root);

  const canvasHost = el('div', { class: 'canvas-host', id: 'canvas-host' }, []);
  const detailHost = el('div', { class: 'detail-body' }, []);
  const listHost = el('div', { class: 'node-list', role: 'listbox', 'aria-label': 'All nodes' }, []);
  const legendHost = el('div', { class: 'legend' }, []);
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

  const sidebar = el('aside', { class: 'panel sidebar', id: 'explorer-panel', 'aria-label': 'Explorer' }, [
    el('div', { class: 'field' }, [search]),
    countsHost,
    listHost,
    el('h3', { class: 'legend-title' }, ['Legend']),
    legendHost,
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
  };

  let lastRendered: { state: AppState; derived: Derived } | null = null;
  const unsubscribe = controller.subscribe((state, derived) => {
    lastRendered = { state, derived };
    renderBanners(state, derived);
    renderCounts(state, derived);
    renderList(state, derived);
    renderLegend(state);
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
          el('span', {}, [
            `${l.newNodes.length} new node(s); dropped ${l.droppedPositions.length} position(s) and ` +
              `${l.droppedExpanded.length} expanded id(s) that no longer exist; ${l.reparented.length} reparented.`,
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
    clear(listHost);
    const query = state.search.query.trim();
    const nodes =
      query === ''
        ? state.model.nodes.filter((n) => n.kind !== 'file' && n.kind !== 'directory')
        : state.model.nodes.filter((n) => state.search.matches.has(n.id));

    if (nodes.length === 0) {
      listHost.appendChild(el('p', { class: 'muted pad' }, ['No node matches.']));
      return;
    }

    const shown = nodes.slice(0, 400);
    for (const node of shown) {
      const style = nodeStyle(node.kind);
      const selected = state.selection.nodeIds.includes(node.id);
      const visible = derived.graph.visibleNodes.includes(node.id);
      const row = el(
        'button',
        {
          type: 'button',
          class: `node-row${selected ? ' selected' : ''}`,
          role: 'option',
          'aria-selected': selected ? 'true' : 'false',
          title: node.path ?? node.id,
        },
        [
          el('span', { class: `swatch shape-${style.shape}`, style: `--swatch:${style.stroke}` }, []),
          el('span', { class: 'node-label' }, [node.label]),
          el('span', { class: 'node-kind' }, [node.kind]),
          visible ? null : el('span', { class: 'node-hidden', title: 'Hidden inside a collapsed box' }, ['⊂']),
        ],
      );
      row.addEventListener('click', () => {
        // Reveal a hit that is hidden inside collapsed ancestors, then select it.
        controller.dispatch({ type: 'ExpandTo', id: node.id });
        controller.dispatch({ type: 'Select', nodeIds: [node.id], edgeId: null });
        controller.fit([node.id]);
      });
      row.addEventListener('dblclick', () => {
        controller.dispatch({ type: 'ToggleExpand', id: node.id });
      });
      listHost.appendChild(row);
    }
    if (nodes.length > shown.length) {
      listHost.appendChild(
        el('p', { class: 'muted pad' }, [`… and ${nodes.length - shown.length} more. Narrow the search.`]),
      );
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

    const testsOn = state.filters.hideTests;
    legendHost.appendChild(
      toggleRow('hide tests', '#94a3b8', 'Mask files the extractor marked as tests', testsOn, 'edge', () => {
        controller.dispatch({ type: 'SetFilter', hideTests: !testsOn });
      }),
    );
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
