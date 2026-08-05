// Rust module resolution — honestly DEGRADED, permanently (§10.3).
//
// No macro expansion, no `#[path = "…"]`, no `cfg` evaluation, no symbol
// resolution. Glob imports go to `unresolved` rather than becoming a guess. Every
// `use` edge carries `confidence: 'heuristic'` and its evidence line, so a reader
// can check it in one click. `mod foo;` resolves to a file whose existence is
// CHECKED, never assumed — which is why it earns `resolved`.
//
// The coverage record says all of this out loud, and the UI shows the coverage
// record. A quiet map is not a trustworthy map.

import type { VisualSpecsEdge, Unresolved } from '../../../src/contract/types.ts';
import type { Manifest } from '../manifests.ts';
import { dirOf } from '../manifests.ts';
import { fileNodeId } from '../ownership.ts';
import { readTextFile } from '../repo.ts';
import { inlineModuleSpans, neutralise, parseModDeclarations, parseUseStatements } from './usetree.ts';

/**
 * Whether the box the map draws for a directory IS the Rust module a reader will read it
 * as — measured, per repository, instead of assumed.
 *
 * Rust lets a module's root file sit OUTSIDE the directory holding its children:
 * `src/config.rs` beside `src/config/foo.rs`. The map draws a `config/` box containing
 * `foo.rs` and draws `config.rs` as a SIBLING of that box, so the box's level excludes the
 * file that defines the module. Calling that level "the level of `config`" is then wrong.
 * With `src/config/mod.rs` the two coincide, root included, and it is right.
 *
 * AgentsCommander is entirely the second shape, so a level per directory needs no caveat
 * THERE. A modern Rust codebase defaults to the first, and needs one. Which it is belongs
 * in the document, not in a reviewer's memory.
 */
export interface RustModuleShape {
  /** Modules with a backing file, reached by walking `mod` declarations from every crate root. */
  moduleFiles: number;
  /** …whose file is `<dir>/mod.rs`: the directory IS the module, its root included. */
  directoryModules: number;
  /**
   * Directories holding tracked Rust code whose module root is the SIBLING `<dir>.rs`,
   * outside the box. Listed rather than counted: each entry is a directory whose level is
   * not its module's level, and a reader deserves to see which.
   */
  rootOutsideDirectory: string[];
  /** Inline `mod X { … }` outside `#[cfg(test)]` — a module with no file, so no box. */
  inlineModules: number;
  /** Inline modules inside `#[cfg(test)]`. Separated because test scaffolding dominates
   *  the count and would drown the number above. */
  inlineTestModules: number;
  /** `mod X;` under a `#[cfg(…)]`: the map shows the file unconditionally, the build does
   *  not. `#[cfg(…)]` is still not evaluated; these are the declarations where that matters. */
  conditionalModules: string[];
  /** `#[path = "…"]` declarations walked past. NOT resolved. Empty means there is none to
   *  resolve, which is a different claim from "cannot resolve them". */
  pathAttributes: string[];
}

export interface RustResult {
  edges: VisualSpecsEdge[];
  unresolved: Unresolved[];
  crateRoots: string[];
  groupedUseCount: number;
  moduleShape: RustModuleShape;
}

interface CrateIndex {
  /** Module path (e.g. 'crate::commands::config') → the file that defines it. */
  moduleFile: Map<string, string>;
  /** File → its module path. */
  fileModule: Map<string, string>;
  root: string;
  crateName: string;
}

export function extractRustImports(
  root: string,
  files: readonly string[],
  manifests: readonly Manifest[],
): RustResult {
  const tracked = new Set(files);
  const edges: VisualSpecsEdge[] = [];
  const unresolved: Unresolved[] = [];
  const crateRoots: string[] = [];
  let groupedUseCount = 0;

  // Module shape. Sets, because a file can be reached from more than one crate root —
  // `lib.rs` and every `src/bin/*.rs` are separate roots over a shared module tree.
  const moduleFiles = new Set<string>();
  const pathAttributes = new Set<string>();
  const conditionalModules = new Set<string>();
  let inlineModules = 0;
  let inlineTestModules = 0;
  const inlineCounted = new Set<string>();

  const crates = manifests.filter((m) => m.ecosystem === 'cargo' && m.isPackage);

  for (const crate of crates) {
    const base = crate.dir === '' ? '' : `${crate.dir}/`;
    const libRs = `${base}src/lib.rs`;
    const mainRs = `${base}src/main.rs`;
    const rootFiles = [libRs, mainRs].filter((f) => tracked.has(f));
    // Binaries in src/bin/*.rs are their own crate roots.
    for (const f of files) {
      if (f.startsWith(`${base}src/bin/`) && f.endsWith('.rs') && !f.slice(`${base}src/bin/`.length).includes('/')) {
        rootFiles.push(f);
      }
    }
    if (rootFiles.length === 0) continue;

    for (const rootFile of rootFiles) {
      crateRoots.push(rootFile);
      const index = indexCrate(root, rootFile, tracked, crate.name);

      for (const [modulePath, file] of index.moduleFile) {
        void modulePath;
        const source = readTextFile(root, file);

        moduleFiles.add(file);
        if (!inlineCounted.has(file)) {
          inlineCounted.add(file);
          const spans = inlineModuleSpans(neutralise(source));
          for (const span of spans) {
            if (isUnderCfgTest(span, spans)) inlineTestModules += 1;
            else inlineModules += 1;
          }
        }

        // --- mod declarations: a file including another file. ---------------
        for (const decl of parseModDeclarations(source)) {
          // Recorded, never acted on: `#[path]` is not resolved and `cfg` is not evaluated.
          // Saying how many were walked past is what separates "cannot" from "none here".
          const where = `${file}:${decl.line} mod ${decl.name};`;
          if (decl.attributes.some((a) => a.startsWith('#[path'))) pathAttributes.add(where);
          if (decl.attributes.some((a) => a.startsWith('#[cfg('))) conditionalModules.add(where);

          const target = resolveChildModuleFile(file, decl.name, tracked, rootFile);
          if (target === null) continue; // inline module or a file that is not tracked
          if (target === file) continue;
          edges.push({
            id: `rust-imports:${fileNodeId(file)}->${fileNodeId(target)}`,
            kind: 'rust-imports',
            sourceId: fileNodeId(file),
            targetId: fileNodeId(target),
            confidence: 'resolved',
            evidence: [{ path: file, line: decl.line, note: `mod ${decl.name};` }],
            metadata: { via: 'mod' },
          });
        }

        // --- use trees ------------------------------------------------------
        for (const statement of parseUseStatements(source)) {
          if (statement.leaves.length > 1) groupedUseCount += 1;
          for (const leaf of statement.leaves) {
            const head = leaf.path[0];
            if (head === undefined) continue;
            if (head !== 'crate' && head !== 'self' && head !== 'super') continue; // external crate

            if (leaf.glob) {
              unresolved.push({
                kind: 'rust-imports',
                reason: 'a glob import cannot be resolved to a specific file without symbol resolution',
                evidence: [{ path: file, line: statement.line, note: `use ${leaf.path.join('::')}::*;` }],
                detail: { from: file, path: leaf.path.join('::') },
              });
              continue;
            }

            // The module the statement is WRITTEN IN, not the module of the file. A
            // `use super::X` inside `mod tests { … }` means the file itself — a
            // self-relation, dropped below — and counting the inline nesting is what
            // makes that come out right. See `UseStatement.enclosingModules`.
            const writtenIn = [
              index.fileModule.get(file) ?? 'crate',
              ...statement.enclosingModules,
            ].join('::');
            const absolute = absolutise(leaf.path, writtenIn);
            const target = longestPrefixModuleFile(absolute, index);
            if (target === null || target === file) continue;

            edges.push({
              id: `rust-imports:${fileNodeId(file)}->${fileNodeId(target)}`,
              kind: 'rust-imports',
              sourceId: fileNodeId(file),
              targetId: fileNodeId(target),
              // Heuristic, permanently: no macro expansion, no cfg evaluation, no
              // symbol resolution. The evidence line is how a reader checks it.
              confidence: 'heuristic',
              evidence: [{ path: file, line: statement.line, note: `use ${leaf.path.join('::')};` }],
              metadata: { via: 'use' },
            });
          }
        }
      }
    }
  }

  dedupe(edges);
  edges.sort((a, b) => (a.id < b.id ? -1 : 1));
  unresolved.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  crateRoots.sort();

  const moduleShape: RustModuleShape = {
    moduleFiles: moduleFiles.size,
    ...directoryShape(files, moduleFiles),
    inlineModules,
    inlineTestModules,
    conditionalModules: [...conditionalModules].sort(),
    pathAttributes: [...pathAttributes].sort(),
  };

  return { edges, unresolved, crateRoots, groupedUseCount, moduleShape };
}

/** Is this inline module a test module, or nested inside one? */
function isUnderCfgTest(
  span: { open: number; close: number; attributes: string[] },
  all: readonly { open: number; close: number; attributes: string[] }[],
): boolean {
  const isTest = (attrs: readonly string[]): boolean =>
    attrs.some((a) => /^#\[cfg\(.*\btest\b/.test(a));
  if (isTest(span.attributes)) return true;
  return all.some((s) => s.open < span.open && span.close < s.close && isTest(s.attributes));
}

/**
 * For every directory holding tracked Rust code, is its module's root file INSIDE it
 * (`<dir>/mod.rs`) or beside it (`<dir>.rs`)?
 *
 * Asked against the RESOLVED module files, not against path shapes: a `config.rs` that no
 * `mod config;` ever reaches is not the root of anything, and counting it would report a
 * gap that does not exist. Directories with neither — a crate's `src/`, a `src/bin/`, an
 * integration-test directory — are modules of nothing and are simply not counted.
 */
function directoryShape(
  files: readonly string[],
  moduleFiles: ReadonlySet<string>,
): { directoryModules: number; rootOutsideDirectory: string[] } {
  const dirs = new Set<string>();
  for (const f of files) {
    if (!f.endsWith('.rs')) continue;
    const dir = dirOf(f);
    if (dir !== '') dirs.add(dir);
  }

  let directoryModules = 0;
  const rootOutsideDirectory: string[] = [];
  for (const dir of dirs) {
    if (moduleFiles.has(`${dir}/mod.rs`)) {
      directoryModules += 1;
      continue;
    }
    const parent = dirOf(dir);
    const name = parent === '' ? dir : dir.slice(parent.length + 1);
    const sibling = parent === '' ? `${name}.rs` : `${parent}/${name}.rs`;
    if (moduleFiles.has(sibling)) rootOutsideDirectory.push(dir);
  }

  return { directoryModules, rootOutsideDirectory: rootOutsideDirectory.sort() };
}

/** Walk `mod` declarations from a crate root and map module paths to files. */
function indexCrate(
  root: string,
  rootFile: string,
  tracked: ReadonlySet<string>,
  crateName: string,
): CrateIndex {
  const moduleFile = new Map<string, string>();
  const fileModule = new Map<string, string>();
  const queue: { modulePath: string; file: string }[] = [{ modulePath: 'crate', file: rootFile }];

  while (queue.length > 0) {
    const item = queue.shift();
    if (item === undefined) break;
    if (moduleFile.has(item.modulePath)) continue;
    moduleFile.set(item.modulePath, item.file);
    fileModule.set(item.file, item.modulePath);

    let source: string;
    try {
      source = readTextFile(root, item.file);
    } catch {
      continue;
    }
    for (const decl of parseModDeclarations(source)) {
      const childFile = resolveChildModuleFile(item.file, decl.name, tracked, rootFile);
      if (childFile === null) continue;
      queue.push({ modulePath: `${item.modulePath}::${decl.name}`, file: childFile });
    }
  }

  return { moduleFile, fileModule, root: rootFile, crateName };
}

/**
 * `mod foo;` inside `<dir>/x.rs` resolves to `<dir>/x/foo.rs` or `<dir>/x/foo/mod.rs`;
 * inside a crate root or a `mod.rs`, to `<dir>/foo.rs` or `<dir>/foo/mod.rs`.
 * Existence is CHECKED against the tracked set — `#[cfg(test)] mod tests { … }` has
 * no backing file, and inventing one would be a lie.
 */
function resolveChildModuleFile(
  parentFile: string,
  name: string,
  tracked: ReadonlySet<string>,
  rootFile: string,
): string | null {
  const dir = dirOf(parentFile);
  const stem = parentFile.slice(dir === '' ? 0 : dir.length + 1).replace(/\.rs$/, '');
  const isRootLike = parentFile === rootFile || stem === 'mod' || stem === 'lib' || stem === 'main';
  const base = isRootLike ? dir : `${dir}/${stem}`;

  const candidates = [`${base}/${name}.rs`, `${base}/${name}/mod.rs`];
  for (const candidate of candidates) {
    if (tracked.has(candidate)) return candidate;
  }
  return null;
}

/** Turn `self::`/`super::` into an absolute `crate::…` path. */
function absolutise(path: readonly string[], currentModule: string): string[] {
  const head = path[0];
  if (head === 'crate') return [...path];

  const current = currentModule.split('::');
  if (head === 'self') return [...current, ...path.slice(1)];
  if (head === 'super') {
    let i = 0;
    const base = [...current];
    while (path[i] === 'super') {
      base.pop();
      i += 1;
    }
    return [...base, ...path.slice(i)];
  }
  return [...path];
}

/** The longest prefix of the path that names a module we know a file for. The tail
 *  is the imported ITEM, which this tool does not resolve — granularity stops at
 *  the file (§15). */
function longestPrefixModuleFile(path: readonly string[], index: CrateIndex): string | null {
  for (let end = path.length; end > 0; end -= 1) {
    const key = path.slice(0, end).join('::');
    const file = index.moduleFile.get(key);
    if (file !== undefined) return file;
  }
  return null;
}

/**
 * Two references between the SAME pair of files are ONE relation, and the extra
 * evidence lines are kept on it.
 *
 * But the merge must not OVER-CLAIM. `mod solver;` and `use crate::solver::run;`
 * both point from lib.rs at solver.rs, and the first cut of this function kept
 * whichever arrived first — so a file pair backed by both ended up labelled
 * `via: "mod"`, `confidence: "resolved"`, and the heuristic `use` disappeared into
 * it. The evidence was still there; the CHARACTER of the relation was not. So:
 *
 *   * `via` becomes the sorted set of every way the relation was seen;
 *   * `confidence` keeps the STRONGEST backing, because a `mod` declaration whose
 *     file was checked really does resolve the relation — the `use` adds evidence
 *     to it, not doubt.
 */
function dedupe(edges: VisualSpecsEdge[]): void {
  const byId = new Map<string, VisualSpecsEdge>();
  const viasById = new Map<string, Set<string>>();

  for (const edge of edges) {
    const via = String(edge.metadata?.['via'] ?? '');
    const seen = byId.get(edge.id);

    if (seen === undefined) {
      byId.set(edge.id, edge);
      viasById.set(edge.id, new Set(via === '' ? [] : [via]));
      continue;
    }

    viasById.get(edge.id)?.add(via);
    for (const ev of edge.evidence ?? []) {
      if (!(seen.evidence ?? []).some((e) => e.path === ev.path && e.line === ev.line)) {
        (seen.evidence ??= []).push(ev);
      }
    }
    if (edge.confidence === 'resolved') seen.confidence = 'resolved';
  }

  edges.length = 0;
  for (const edge of byId.values()) {
    const vias = [...(viasById.get(edge.id) ?? [])].filter((v) => v !== '').sort();
    if (vias.length > 0) edge.metadata = { ...edge.metadata, via: vias };
    edge.evidence?.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
    edges.push(edge);
  }
}
