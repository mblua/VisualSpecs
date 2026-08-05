// Files → manifests → ownership → apps → TS resolution → Rust use-trees →
// transport commands → coverage/unresolved → emit + validate (§13, step 6).
//
// Determinism (§10.6): the canonical payload — nodes, edges, coverage, unresolved —
// is byte-identical across two runs on the same commit with the same flags.
// `generator.generatedAt` is excluded from it unless it is explicitly asked for.
// `generator.configDigest` hashes the flags and the resolver configuration, so a
// document declares the configuration that produced it.
//
// AND: every count in `stats` is produced by a parser or an anchored pattern, and
// pinned by a fixture test. A raw grep is not evidence (§10.5).

import { createHash } from 'node:crypto';
import type {
  Coverage,
  Evidence,
  VisualSpecsDoc,
  VisualSpecsEdge,
  VisualSpecsNode,
  JsonValue,
  Unresolved,
} from '../../src/contract/types.ts';
import { canonicalStringify } from '../../src/contract/json.ts';
import { importDoc } from '../../src/contract/load.ts';
import { EXIT, ExtractorError } from './errors.ts';
import { basename } from './manifests.ts';
import { readManifests } from './manifests.ts';
import { buildOwnership, type Hierarchy } from './ownership.ts';
import { detectApps } from './apps.ts';
import { readRepo, readTextFile } from './repo.ts';
import { extractTsImports } from './tsimports.ts';
import { extractRustImports } from './rust/imports.ts';
import { extractCommands } from './commands.ts';

export const GENERATOR_NAME = 'visual-specs-extract';
export const GENERATOR_VERSION = '0.1.0';

export interface ExtractOptions {
  repo: string;
  out: string;
  /** What to call the repository. Defaults to the directory's own name — which is
   *  a working-copy detail, so it is overridable, and the override is recorded in
   *  `generator.flags` rather than being an unexplained relabelling. */
  name: string | undefined;
  hierarchy: Hierarchy;
  invokeFacade: string;
  allowBareInvoke: boolean;
  snippets: boolean;
  tsconfig: string | undefined;
  /** The flags that determine the CONTENT, for provenance — not a transcript of the
   *  command line. `--repo`, `--out` and `--stamp` are deliberately absent; see
   *  `VisualSpecsGenerator.flags`. */
  flags: string[];
  /** Include `generator.generatedAt`. Excluded from the deterministic payload. */
  stamp: boolean;
}

export interface ExtractResult {
  doc: VisualSpecsDoc;
  text: string;
  warnings: string[];
}

export function extract(options: ExtractOptions): ExtractResult {
  const warnings: string[] = [];
  const repo = readRepo(options.repo);
  const repoName = options.name ?? basename(repo.root.split(/[\\/]/).join('/'));

  const manifests = readManifests(repo.root, repo.files);
  const ownership = buildOwnership(repoName, repo.files, manifests, options.hierarchy);
  const apps = detectApps(repo.root, repo.files, manifests, ownership);

  const ts = extractTsImports(repo.root, repo.files, options.tsconfig);
  const rust = extractRustImports(repo.root, repo.files, manifests);
  const commands = extractCommands(repo.root, repo.files, {
    invokeFacade: options.invokeFacade,
    allowBareInvoke: options.allowBareInvoke,
  });

  if (repo.dirty) {
    warnings.push(
      `the working tree is DIRTY: ${repo.modifiedTrackedFiles.length} tracked file(s) differ from ` +
        `${repo.commit?.slice(0, 7) ?? 'HEAD'}. Every path:line in this document describes the files ` +
        `on disk, not the files at that commit. The document records source.dirty = true.`,
    );
  }

  const nodes: VisualSpecsNode[] = [...ownership.nodes, ...apps.nodes];
  const edges: VisualSpecsEdge[] = [...apps.edges, ...ts.edges, ...rust.edges, ...commands.edges];

  const unresolved: Unresolved[] = [
    ...ts.unresolved,
    ...rust.unresolved,
    ...commands.unresolved,
    ...repo.skipped.map(
      (s): Unresolved => ({
        kind: 'node',
        reason: s.reason,
        evidence: [{ path: s.path }],
      }),
    ),
  ];

  // Drop any edge whose endpoint is not a node. Nothing should produce one; if
  // something does, it is a bug, and a silently dangling edge would be worse.
  const nodeIds = new Set(nodes.map((n) => n.id));
  const kept: VisualSpecsEdge[] = [];
  for (const edge of edges) {
    if (nodeIds.has(edge.sourceId) && nodeIds.has(edge.targetId)) {
      kept.push(edge);
      continue;
    }
    warnings.push(`dropped edge ${edge.id}: an endpoint is not a node`);
  }

  if (options.snippets) {
    warnings.push(
      '--snippets copies verbatim source text into the document. It may copy a secret out of the repository into a JSON file you are about to commit.',
    );
    attachSnippets(repo.root, nodes, kept, unresolved);
  }

  const coverage = buildCoverage(kept, unresolved, ts.tsconfigs.length > 0);

  const configDigest = digestOf({
    generator: GENERATOR_VERSION,
    hierarchy: options.hierarchy,
    invokeFacade: options.invokeFacade,
    allowBareInvoke: options.allowBareInvoke,
    snippets: options.snippets,
    tsconfig: ts.tsconfigs,
    flags: options.flags,
  });

  const doc: VisualSpecsDoc = {
    formatVersion: '1.0',
    generator: {
      name: GENERATOR_NAME,
      version: GENERATOR_VERSION,
      flags: options.flags,
      configDigest,
      ...(options.stamp ? { generatedAt: new Date().toISOString() } : {}),
    },
    source: {
      kind: 'git-repo',
      root: repoName,
      ...(repo.commit === undefined ? {} : { commit: repo.commit }),
      // A document that names a commit while describing a dirty working tree is
      // asserting a provenance it cannot back up. It says so instead.
      ...(repo.dirty ? { dirty: true } : {}),
    },
    nodes: nodes.sort((a, b) => (a.id < b.id ? -1 : 1)),
    edges: kept.sort((a, b) => (a.id < b.id ? -1 : 1)),
    coverage,
    unresolved,
    // The initial view: the repository, its applications and its packages. Not 705
    // overlapping files (§9.3). Positions are left to the deterministic auto-layout.
    view: { expanded: [ownership.repoId] },
    stats: {
      trackedFiles: repo.files.length,
      /** Tracked files that differ from `source.commit`. Empty when the tree is clean. */
      modifiedTrackedFiles: repo.modifiedTrackedFiles,
      nodeCount: nodes.length,
      edgeCount: kept.length,
      nodesByKind: countBy(nodes.map((n) => n.kind)),
      edgesByKind: countBy(kept.map((e) => e.kind)),
      /** Manifest anchors, split by what they actually are. */
      anchors: ownership.anchors.length,
      npmPackages: ownership.anchors.filter((a) => a.ecosystem === 'npm').length,
      rustCrates: ownership.anchors.filter((a) => a.ecosystem === 'cargo').length,
      applications: apps.nodes.length,
      suppressedTauriOwnedBins: apps.suppressedTauriOwnedBins,
      externalSpecifiers: ts.externalSpecifiers.length,
      externalSpecifierNames: ts.externalSpecifiers.slice(0, 200),
      tsPathAliasUsages: ts.aliasHits,
      tsconfigs: ts.tsconfigs,
      rustCrateRoots: rust.crateRoots,
      rustGroupedUseStatements: rust.groupedUseCount,
      /** Whether a directory box IS the Rust module a reader reads it as — measured per
       *  repository, so a level shown per directory is backed by this and not by a habit
       *  picked up from one corpus. See `RustModuleShape`. */
      rustModuleShape: rust.moduleShape,
      ...commands.stats,
    },
  };

  const json = JSON.parse(JSON.stringify(doc)) as JsonValue;
  const text = canonicalStringify(json);

  // The extractor's output is validated by the SAME validate() the app uses on
  // import. One definition of a valid document, so the tool and the app cannot
  // drift in shape. (It does not prevent the extractor from emitting a
  // semantically wrong relation; only evidence and fixtures do that.)
  try {
    importDoc(text);
  } catch (err) {
    throw new ExtractorError(
      EXIT.invalidOutput,
      `the extractor produced a document its own validator refuses: ${(err as Error).message}`,
    );
  }

  return { doc, text, warnings };
}

function buildCoverage(
  edges: readonly VisualSpecsEdge[],
  unresolved: readonly Unresolved[],
  hasTsconfig: boolean,
): Coverage[] {
  const emitted = countBy(edges.map((e) => e.kind));
  const unresolvedBy = countBy(unresolved.map((u) => u.kind));

  const entry = (
    kind: string,
    status: Coverage['status'],
    reason?: string,
  ): Coverage => ({
    kind,
    status,
    ...(reason === undefined ? {} : { reason }),
    emitted: emitted[kind] ?? 0,
    unresolved: unresolvedBy[kind] ?? 0,
  });

  return [
    entry('bundles', 'available'),
    entry('entrypoint', 'available'),
    hasTsconfig
      ? entry('imports', 'available')
      : entry('imports', 'unavailable', 'no tsconfig.json was found, so module resolution could not run'),
    entry(
      'rust-imports',
      'degraded',
      'no macro expansion, no #[path], no cfg evaluation; glob imports are unresolved and item-level symbols are not resolved',
    ),
    entry(
      'tauri-command',
      'available',
      'requires a literal call, a #[tauri::command] attribute, and registration in generate_handler!',
    ),
    entry(
      'web-command',
      'available',
      'requires a literal call and a matching arm in the web router',
    ),
  ];
}

function attachSnippets(
  root: string,
  nodes: readonly VisualSpecsNode[],
  edges: readonly VisualSpecsEdge[],
  unresolved: readonly Unresolved[],
): void {
  const cache = new Map<string, string[]>();
  const lines = (path: string): string[] => {
    const hit = cache.get(path);
    if (hit !== undefined) return hit;
    let value: string[] = [];
    try {
      value = readTextFile(root, path).split(/\r?\n/);
    } catch {
      value = [];
    }
    cache.set(path, value);
    return value;
  };
  const fill = (evidence: Evidence[] | undefined): void => {
    if (evidence === undefined) return;
    for (const e of evidence) {
      if (e.line === undefined) continue;
      const line = lines(e.path)[e.line - 1];
      if (line !== undefined) e.snippet = line.trim();
    }
  };
  for (const n of nodes) fill(n.evidence);
  for (const e of edges) fill(e.evidence);
  for (const u of unresolved) fill(u.evidence);
}

function countBy(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

function digestOf(config: unknown): string {
  const canonical = canonicalStringify(JSON.parse(JSON.stringify(config)) as JsonValue);
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}
