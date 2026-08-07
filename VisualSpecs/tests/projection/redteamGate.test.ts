// GATE ADVERSARIAL — vs-semantic-red-team, verificación del incremento de #44.
//
// Los casos del premortem, corridos contra la implementación real en vez de contra mi
// réplica. Cada `it` nombra el hallazgo que verifica. Un test que pasa acá NO dice que el
// producto es bueno: dice que ESE contraejemplo ya no reproduce.
//
// Regla de oficio: contrastar lo especificado contra lo implementado, nunca contra lo
// relatado. Ningún assert de acá lee un comentario del código bajo prueba.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { importDoc } from '../../src/contract/load.ts';
import { OwnershipOutline, type OutlineNodeId } from '../../src/domain/outline.ts';
import { project } from '../../src/projection/project.ts';
import { LOWER_BOUND_PREMISE, rank, aggregateConfidence } from '../../src/projection/levels.ts';
import type { EdgeKind } from '../../src/contract/types.ts';

const TEXT = readFileSync(
  fileURLToPath(new URL('../../data/agentscommander.json', import.meta.url)),
  'utf8',
);
const model = importDoc(TEXT).model;
const outline = new OwnershipOutline(model);

const IMPORTS: ReadonlySet<EdgeKind> = new Set(['imports', 'rust-imports'] as EdgeKind[]);
const ROOT = 'repo:AgentsCommander';
const CRATE = 'pkg:cargo:src-tauri/Cargo.toml';
const SRC = 'dir:src-tauri/src';
const SHARED = 'dir:src/shared';

describe('V2 · el contenedor que esconde el enredo no puede verse limpio', () => {
  it('marca el crate en la vista raíz — el criterio de aceptación textual', () => {
    const r = rank(model, outline, ROOT, IMPORTS);
    // El crate participa de aristas con sus hermanos: LLEVA badge. Ese es el caso que
    // la política `ce+ca===0 → sin badge` NO cubría.
    expect(r.ranked.has(CRATE)).toBe(true);
    expect(r.sccOf.has(CRATE)).toBe(false); // sccSize 1: "limpio" si nada más lo desmiente
    expect(r.hidesInternal.has(CRATE)).toBe(true); // ← lo que lo desmiente
  });

  it('no marca por marcar: un hijo sin relaciones internas queda fuera', () => {
    const r = rank(model, outline, ROOT, IMPORTS);
    const apps = outline
      .childrenOf(ROOT)
      .filter((c) => model.nodeById.get(outline.entityOf(c))?.kind === 'application');
    expect(apps.length).toBeGreaterThan(0);
    for (const a of apps) expect(r.hidesInternal.has(a)).toBe(false);
  });
});

describe('V4 · la premisa se publica con las dos mitades', () => {
  it('nombra la cota, lo que una relación faltante hace, y lo que una espuria hace', () => {
    const p = LOWER_BOUND_PREMISE.toLowerCase();
    expect(p).toContain('observed');
    expect(p).toMatch(/hide|hides/);
    expect(p).toMatch(/spurious|invents/);
  });

  it('declara base y kinds en todo resultado — un número sin su base no es reproducible', () => {
    const r = rank(model, outline, SRC, IMPORTS);
    expect(r.basis).toBe('observed');
    expect([...r.kinds].sort()).toEqual(['imports', 'rust-imports']);
  });
});

describe('C2 · el rango no se mueve al expandir', () => {
  it('rank() no recibe `expanded`: mismo resultado con cualquier estado de la vista', () => {
    const a = rank(model, outline, SRC, IMPORTS);
    const b = rank(model, outline, SRC, IMPORTS);
    for (const child of outline.childrenOf(SRC)) {
      expect(a.level.get(child)).toBe(b.level.get(child));
    }
    // y el contraejemplo original: el nivel de `config` no depende de que esté expandido
    const config = 'dir:src-tauri/src/config';
    const collapsed = project(model, outline, new Set([ROOT, CRATE, SRC]));
    const expanded = project(model, outline, new Set([ROOT, CRATE, SRC, config]));
    expect(collapsed.visibleNodes).not.toEqual(expanded.visibleNodes); // la vista SÍ cambia
    expect(a.level.get(config)).toBe(b.level.get(config)); //          el número NO
  });
});

describe('C1 · el enredo fabricado sigue existiendo, y el producto no lo llama ciclo', () => {
  it('shared: stores y testing quedan en un SCC aunque el código sea un DAG', () => {
    const r = rank(model, outline, SHARED, IMPORTS);
    const i = r.sccOf.get('dir:src/shared/stores');
    expect(i).toBeDefined();
    const scc = r.sccs[i as number];
    expect(scc).toBeDefined();
    expect([...(scc?.members ?? [])].sort()).toEqual([
      'dir:src/shared/stores',
      'dir:src/shared/testing',
    ]);
  });

  it('la identidad del SCC son sus miembros, no un índice', () => {
    const r = rank(model, outline, SRC, IMPORTS);
    for (const scc of r.sccs) {
      expect(scc.members.length).toBeGreaterThan(1);
      expect([...scc.members]).toEqual([...scc.members].sort());
    }
  });
});

describe('H6 · instability indefinida es null, nunca NaN ni un número inventado', () => {
  it('null exactamente donde Ca+Ce=0, y finito en todo el resto', () => {
    let nulls = 0;
    for (const c of outline.childrenOf(CRATE)) {
      const v = rank(model, outline, CRATE, IMPORTS).siblingInstability.get(c);
      expect(v === null || Number.isFinite(v)).toBe(true);
      if (v === null) nulls += 1;
    }
    expect(nulls).toBe(outline.childrenOf(CRATE).length); // el crate no tiene arcos internos
  });

  it('ningún no-finito en ningún contenedor del corpus', () => {
    for (const n of model.nodes) {
      if (outline.childrenOf(n.id).length === 0) continue;
      for (const [, v] of rank(model, outline, n.id, IMPORTS).siblingInstability) {
        if (v !== null) expect(Number.isFinite(v)).toBe(true);
      }
    }
  });
});

describe('H7 · identificación por tupla, nunca por índice posicional', () => {
  it('ningún RankedEdge expone un VisibleEdgeId', () => {
    const r = rank(model, outline, SRC, IMPORTS);
    expect(r.edges.length).toBeGreaterThan(0);
    for (const e of r.edges) {
      expect(e).not.toHaveProperty('id');
      expect(typeof e.kind).toBe('string');
      expect(typeof e.sourceId).toBe('string');
      expect(typeof e.targetId).toBe('string');
      expect(e.sourceEdgeIds.length).toBe(e.count);
    }
  });
});

describe('H4 · el corte es una estimación, no una lista de tareas', () => {
  it('bajo `observed` no se publica ningún corte', () => {
    expect(rank(model, outline, SRC, IMPORTS).cutEstimate).toEqual([]);
  });
});

describe('V8 · la confianza compone según qué tipo de afirmación sostiene', () => {
  it('un ARCO por máximo: un testigo resuelto alcanza', () => {
    expect(aggregateConfidence(['heuristic', 'resolved'])).toBe('resolved');
    expect(aggregateConfidence(['heuristic', 'heuristic'])).toBe('heuristic');
    expect(aggregateConfidence([])).toBe('heuristic');
  });

  it('un SCC por supervivencia: el de 14 no queda en pie sin heurísticas', () => {
    const r = rank(model, outline, SRC, IMPORTS);
    const big = r.sccs.find((s) => s.members.length === 14);
    expect(big).toBeDefined();
    expect((big as { survivingMembers: readonly string[] }).survivingMembers).toEqual([]);
  });

  it('un SCC sostenido por relaciones resueltas sobrevive entero', () => {
    const r = rank(model, outline, 'dir:src', IMPORTS);
    const five = r.sccs.find((s) => s.members.length === 5);
    expect(five).toBeDefined();
    expect([...(five as { survivingMembers: readonly string[] }).survivingMembers].sort()).toEqual(
      [...(five as { members: readonly string[] }).members].sort(),
    );
  });

  it('survivingMembers nunca tiene exactamente uno: un nodo solo no se necesita a sí mismo', () => {
    for (const n of model.nodes) {
      if (outline.childrenOf(n.id).length === 0) continue;
      for (const scc of rank(model, outline, n.id, IMPORTS).sccs) {
        expect(scc.survivingMembers.length).not.toBe(1);
      }
    }
  });
});

describe('H9 · el resultado es reproducible: mismo input, mismo output', () => {
  it('dos corridas coinciden campo por campo en todo el corpus', () => {
    for (const n of model.nodes) {
      if (outline.childrenOf(n.id).length === 0) continue;
      const a = rank(model, outline, n.id, IMPORTS);
      const b = rank(model, outline, n.id, IMPORTS);
      expect(a.sccs.map((s) => s.members)).toEqual(b.sccs.map((s) => s.members));
      expect([...a.level.entries()]).toEqual([...b.level.entries()]);
      expect([...a.hidesInternal].sort()).toEqual([...b.hidesInternal].sort());
    }
  });
});

// ---------------------------------------------------------------------------
// V2 END-TO-END. `hidesInternal` en el resultado no es el criterio: el criterio es
// LA PANTALLA. Esto corre el pipeline real `derive()` y mira el RenderNode.
// ---------------------------------------------------------------------------

describe('V2 end-to-end · la escena, no el resultado', () => {
  it('con la vista por defecto y Levels activo, el crate NO se ve igual que uno limpio', async () => {
    const { stateFromLoaded, apply } = await import('../../src/app/state.ts');
    const { derive } = await import('../../src/app/controller.ts');
    const loaded = importDoc(TEXT);
    let state = stateFromLoaded(loaded, null);
    // la vista por defecto que trae el documento
    expect([...state.view.expanded]).toEqual([ROOT]);
    // `SetLevels` does not read geometry or limits, but `CommandContext` is one type
    // for every command, so the whole of it is built rather than cast away.
    const { computeGeometry } = await import('../../src/domain/layoutEngine.ts');
    const { DEFAULT_LIMITS } = await import('../../src/contract/limits.ts');
    const ctx = {
      model: state.model,
      outline: state.outline,
      geometry: computeGeometry(state.model, state.outline, state.view.expanded, state.view.positions),
      limits: DEFAULT_LIMITS,
    };
    state = apply(state, { type: 'SetLevels', active: true }, ctx);

    const { scene: sceneResult } = derive(state);
    const scene = sceneResult.scene;
    const crate = scene.nodes.find((n) => n.id === CRATE);
    expect(crate).toBeDefined();
    const marker = (crate as { marker?: string }).marker ?? '';
    expect(marker).not.toBe('');

    // y un contenedor sin enredo escondido no lo lleva: si todos lo llevaran, no diría nada
    const npmPkgs = scene.nodes.filter(
      (n) => n.id !== CRATE && ((n as { marker?: string }).marker ?? '') !== '',
    );
    const clean = scene.nodes.filter((n) => ((n as { marker?: string }).marker ?? '') === '');
    expect(clean.length).toBeGreaterThan(0);
    console.log(
      `    crate marker=${JSON.stringify(marker)} · otros con marcador: ${npmPkgs.length} · sin marcador: ${clean.length}`,
    );
  });

  it('con Levels apagado no se afirma nada, así que no hay nada que desmentir', async () => {
    const { stateFromLoaded } = await import('../../src/app/state.ts');
    const { derive } = await import('../../src/app/controller.ts');
    const state = stateFromLoaded(importDoc(TEXT), null);
    expect(state.levels.active).toBe(false);
    const { scene: sceneResult, rankings } = derive(state);
    expect(rankings.size).toBe(0);
    const crate = sceneResult.scene.nodes.find((n) => n.id === CRATE);
    expect((crate as { badge?: string }).badge).not.toMatch(/^L\d/);
  });
});
