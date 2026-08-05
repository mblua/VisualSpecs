// A dedicated use-tree parser (§10.3).
//
// A naive line scanner is not adequate, and the repository proves it: grouped
// use-trees — `use crate::{…}`, `use crate::a::{…}`, `use super::{…}` — are real
// and common, and a per-line regex mis-parses every one of them. Nesting is
// arbitrary: `use crate::a::{b, c::{d, e}, f as g};` is four distinct imports.
//
// The grammar is small and closed, so it gets a real parser rather than a regex:
//
//   use-tree := path                       // use a::b::c;
//             | path '::' '*'              // use a::b::*;      → glob
//             | path '::' '{' list '}'     // use a::{b, c};
//             | '{' list '}'
//   list     := use-tree (',' use-tree)* ','?
//   path     := segment ('::' segment)*
//   segment  := ident | 'crate' | 'self' | 'super'
//
// `as` aliases are parsed and dropped: an alias renames a binding, it does not
// change which file the import reaches.

export interface UseLeaf {
  /** Full path segments, e.g. ['crate', 'commands', 'config', 'get_settings']. */
  path: string[];
  /** `use a::b::*` — a glob. Never guessed at; always goes to `unresolved`. */
  glob: boolean;
}

export interface UseStatement {
  leaves: UseLeaf[];
  /** 1-based line of the `use` keyword. */
  line: number;
  /**
   * The inline modules enclosing this statement, outermost first — `['tests']` for a
   * `use` written inside `#[cfg(test)] mod tests { … }`, `[]` at file level.
   *
   * `super` is relative to the ENCLOSING MODULE, and an inline `mod X { … }` is one.
   * Without this, `use super::X` inside `mod tests` resolves one level too high: it
   * lands on the parent instead of on the file itself, and the caller publishes a
   * relation no build has. In AgentsCommander that produced 16 such edges, 14 of them
   * pointing at a `mod.rs` that already declares every sibling — so each one closed a
   * two-cycle that does not exist.
   */
  enclosingModules: string[];
  /**
   * Attributes written immediately above the statement, verbatim (literals intact), e.g.
   * `['#[cfg(windows)]']`. A `use` can be gated on its own, without any enclosing block.
   */
  attributes: string[];
  /**
   * The `#[cfg(…)]` attributes that gate this statement — its own, plus every enclosing
   * inline module's, outermost first. Empty means the statement is unconditional.
   */
  cfg: string[];
}

/**
 * ONE pass over the source that knows every lexical form that can hide a `"` or a brace:
 * line and (nested) block comments, strings, raw strings, and character literals.
 * Offsets and newline positions are preserved exactly, so a reported line still points at
 * its own source line — asserted at the end, because a silent drift here mis-attributes
 * every line number downstream and the totals still look right.
 *
 * There is deliberately no second scanner composed on top of this one. An earlier cut of
 * this file had `stripComments` (which did not know character literals) feeding a separate
 * literal-blanker, and the two disagreed on the first `'"'` in the corpus —
 * `commands/session.rs:206`, `token_has_unclosed_quote(token, '"')`. The comment scanner
 * took that `"` as the start of a string and stayed out of phase for the rest of the file,
 * so the blanker erased real code and preserved string contents. Two scanners over the
 * same text will eventually disagree; one cannot.
 *
 * `blankLiteralContents` is the only difference between the two exported views.
 */
function scan(source: string, blankLiteralContents: boolean): string {
  const out: string[] = [];
  let i = 0;
  const n = source.length;

  /** Replace a span with spaces, keeping newlines where they were. */
  const blank = (from: number, to: number): number => {
    const stop = Math.min(to, n);
    for (let k = from; k < stop; k += 1) out.push(source[k] === '\n' ? '\n' : ' ');
    return stop;
  };
  /** Copy a span verbatim. */
  const keep = (from: number, to: number): number => {
    const stop = Math.min(to, n);
    for (let k = from; k < stop; k += 1) out.push(source[k] as string);
    return stop;
  };
  const literal = (from: number, to: number): number =>
    blankLiteralContents ? blank(from, to) : keep(from, to);

  while (i < n) {
    const ch = source[i] as string;
    const next = source[i + 1];

    // Raw strings: r"…", r#"…"#, br"…". No escapes; the hash count closes them.
    if ((ch === 'r' || ch === 'b') && !/[A-Za-z0-9_]/.test(source[i - 1] ?? ' ')) {
      let j = i;
      if (source[j] === 'b' && source[j + 1] === 'r') j += 1;
      if (source[j] === 'r') {
        let k = j + 1;
        let hashes = 0;
        while (source[k] === '#') {
          hashes += 1;
          k += 1;
        }
        if (source[k] === '"') {
          const close = `"${'#'.repeat(hashes)}`;
          const end = source.indexOf(close, k + 1);
          i = literal(i, end === -1 ? n : end + close.length);
          continue;
        }
      }
    }

    if (ch === '/' && next === '/') {
      let j = i;
      while (j < n && source[j] !== '\n') j += 1;
      i = blank(i, j);
      continue;
    }

    if (ch === '/' && next === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (source[j] === '/' && source[j + 1] === '*') {
          depth += 1;
          j += 2;
          continue;
        }
        if (source[j] === '*' && source[j + 1] === '/') {
          depth -= 1;
          j += 2;
          continue;
        }
        j += 1;
      }
      i = blank(i, j);
      continue;
    }

    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source[j] === '"') {
          j += 1;
          break;
        }
        j += 1;
      }
      i = literal(i, j);
      continue;
    }

    // A `'` opens a character literal only in the two closed, bounded forms — `'x'` and
    // an escape like `'\n'` or `'\''` that closes on the same line. Anything else is a
    // lifetime (`&'a str`); treating one as an unterminated literal swallows the file.
    if (ch === "'") {
      if (next === '\\') {
        let j = i + 2;
        while (j < n && j < i + 12 && source[j] !== "'" && source[j] !== '\n') j += 1;
        if (source[j] === "'") {
          i = literal(i, j + 1);
          continue;
        }
      } else if (source[i + 2] === "'" && next !== '\n') {
        i = literal(i, i + 3);
        continue;
      }
    }

    out.push(ch);
    i += 1;
  }

  const text = out.join('');
  /* c8 ignore start — a guard, not a branch anyone is meant to reach */
  if (text.length !== source.length) {
    throw new Error('rust scan: output length drifted from the source');
  }
  /* c8 ignore stop */
  return text;
}

/**
 * Comments blanked, literals left verbatim. Line and column of everything else are
 * unchanged.
 */
export function stripComments(source: string): string {
  return scan(source, false);
}

/**
 * Comments blanked AND the text of every literal blanked, so the braces that remain are
 * code. `format!("{}", x)` is everywhere in this corpus, and a brace matcher that counts
 * the `{` inside it walks off the end of the module it was measuring.
 */
export function neutralise(source: string): string {
  return scan(source, true);
}


export interface InlineModuleSpan {
  name: string;
  /** Offset of the opening brace. */
  open: number;
  /** Offset of the matching closing brace. */
  close: number;
  /** Attributes written immediately above, e.g. `['#[cfg(test)]']`. */
  attributes: string[];
}

/** A contiguous run of `#[…]` attributes ending just before `end`, outermost first. */
const ATTR_RUN = /((?:#\[[^\]]*\]\s*)*)$/;
function attributesBefore(text: string, end: number): string[] {
  const run = ATTR_RUN.exec(text.slice(Math.max(0, end - 600), end))?.[1] ?? '';
  return run.match(/#\[[^\]]*\]/g) ?? [];
}

/**
 * Both views of a source at once. They come from the SAME scan, so they have identical
 * length and identical newline positions and an offset means the same thing in either.
 *
 * That is what lets a caller match braces on the blanked view — where `format!("{}")`
 * cannot be miscounted — while reading attribute text from the view that kept its
 * literals, so `#[cfg(target_os = "windows")]` can be quoted verbatim instead of arriving
 * as `#[cfg(target_os =           )]`. A condition nobody can name is a condition that
 * has to be dropped, and dropping it would assert the relation is unconditional.
 */
export interface SourceViews {
  /** Comments blanked, literals kept. Read attribute TEXT here. */
  literal: string;
  /** Comments and literal text blanked. Match BRACES here. */
  blanked: string;
}

export function views(source: string): SourceViews {
  return { literal: stripComments(source), blanked: neutralise(source) };
}

/**
 * Every inline `mod X { … }` in the source, nested ones included. Expects text whose
 * comments and literals have already been neutralised, so the braces it counts are code.
 *
 * Literal TEXT inside an attribute is blanked by `neutralise`, so `#[cfg(feature = "x")]`
 * arrives as `#[cfg(feature =     )]`. That is enough to tell `cfg` from `path` and to
 * spot `test`, which is all any caller here needs; it is not enough to read a value, and
 * nothing should try.
 */
export function inlineModuleSpans(text: string, attributeSource?: string): InlineModuleSpan[] {
  const attrText = attributeSource ?? text;
  const out: InlineModuleSpan[] = [];
  const re = /(^|[;{}\s])(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const open = match.index + match[0].length - 1;
    const close = matchBrace(text, open);
    if (close === -1) continue;
    out.push({
      name: match[2] as string,
      open,
      close,
      // Offsets are shared between the two views, so attributes may be read from the one
      // that kept its literals. See `SourceViews`.
      attributes: attributesBefore(attrText, match.index + (match[1] === '' ? 0 : 1)),
    });
    // `lastIndex` is left just past the opening brace on purpose: a module nested inside
    // this one has to be found too.
  }
  return out;
}

const USE_RE = /(^|[;{}\s])(?:pub(?:\s*\([^)]*\))?\s+)?use\s+/g;

/** Every `use` statement in a Rust source, with its nested tree fully expanded. */
export function parseUseStatements(source: string): UseStatement[] {
  const { literal, blanked: text } = views(source);
  const spans = inlineModuleSpans(text, literal);
  const out: UseStatement[] = [];

  USE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = USE_RE.exec(text)) !== null) {
    const bodyStart = match.index + match[0].length;
    const end = findStatementEnd(text, bodyStart);
    if (end === -1) continue;
    const body = text.slice(bodyStart, end);
    const line = text.slice(0, match.index + match[0].length).split('\n').length;

    // Outermost first: the spans are emitted in source order, and one that contains this
    // statement and starts earlier is further out.
    const enclosing = spans.filter(
      (s) => match !== null && s.open < match.index && match.index < s.close,
    );
    const enclosingModules = enclosing.map((s) => s.name);
    const attributes = attributesBefore(literal, match.index + (match[1] === '' ? 0 : 1));
    const cfg = [...enclosing.flatMap((s) => s.attributes), ...attributes].filter((a) =>
      a.startsWith('#[cfg('),
    );

    const leaves = parseTree(body);
    if (leaves.length > 0) out.push({ leaves, line, enclosingModules, attributes, cfg });
    USE_RE.lastIndex = end;
  }

  return out;
}

/** The `;` that closes the statement, skipping any it finds inside braces. */
function findStatementEnd(text: string, from: number): number {
  let depth = 0;
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (ch === ';' && depth <= 0) return i;
  }
  return -1;
}

export function parseTree(body: string): UseLeaf[] {
  const leaves: UseLeaf[] = [];
  walk(body.trim(), [], leaves);
  return leaves;
}

function walk(input: string, prefix: string[], out: UseLeaf[]): void {
  const trimmed = input.trim();
  if (trimmed === '') return;

  const brace = indexOfTopLevelBrace(trimmed);
  if (brace === -1) {
    // A plain path, possibly a glob, possibly aliased.
    const withoutAlias = trimmed.split(/\s+as\s+/)[0] as string;
    const segments = withoutAlias
      .split('::')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    if (segments.length === 0) return;
    if (segments[segments.length - 1] === '*') {
      out.push({ path: [...prefix, ...segments.slice(0, -1)], glob: true });
      return;
    }
    out.push({ path: [...prefix, ...segments], glob: false });
    return;
  }

  const head = trimmed.slice(0, brace);
  const close = matchBrace(trimmed, brace);
  if (close === -1) return;
  const inner = trimmed.slice(brace + 1, close);

  const headSegments = head
    .split('::')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const nextPrefix = [...prefix, ...headSegments];

  for (const part of splitTopLevel(inner)) {
    const p = part.trim();
    if (p === '') continue;
    if (p === 'self') {
      // `use a::{self, b}` imports `a` itself.
      out.push({ path: [...nextPrefix], glob: false });
      continue;
    }
    if (p.startsWith('self as ')) {
      out.push({ path: [...nextPrefix], glob: false });
      continue;
    }
    walk(p, nextPrefix, out);
  }
}

function indexOfTopLevelBrace(s: string): number {
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === '{') return i;
  }
  return -1;
}

function matchBrace(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts;
}

export interface ModDeclaration {
  name: string;
  line: number;
  /**
   * Attributes written immediately above, e.g. `['#[cfg(target_os =     )]']`. Literal
   * text inside them is blanked (see `inlineModuleSpans`), so these are good for asking
   * WHICH attribute is present and never for reading its value.
   *
   * Nothing here acts on them: `#[path = "…"]` is still not resolved and `#[cfg(…)]` is
   * still not evaluated. They are carried so the extractor can REPORT how many of each it
   * walked past, which is the difference between "cannot resolve `#[path]`" and "there is
   * no `#[path]` to resolve".
   */
  attributes: string[];
  /**
   * The `#[cfg(…)]` attributes gating this declaration — its own, plus every enclosing
   * inline module's. `#[cfg(target_os = "windows")] mod windows;` means the relation to
   * that file exists only on Windows, and its sibling `mod unsupported;` only elsewhere.
   */
  cfg: string[];
}

/**
 * `mod foo;` — a DECLARATION, which has a backing file. `mod tests { … }` is an
 * INLINE module and has none. The difference is the semicolon, and conflating them
 * would invent a file that does not exist.
 */
export function parseModDeclarations(source: string): ModDeclaration[] {
  // Braces and statements are found on the blanked view — a `"mod foo;"` inside a string
  // literal would otherwise declare a module, and declaring one invents a file. Attribute
  // TEXT is read from the literal view at the same offsets. See `SourceViews`.
  const { literal, blanked: text } = views(source);
  const spans = inlineModuleSpans(text, literal);
  const out: ModDeclaration[] = [];
  const re = /(^|[;{}\s])(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const at = match.index + (match[1] === '' ? 0 : 1);
    const attributes = attributesBefore(literal, at);
    const enclosing = spans.filter((s) => s.open < match!.index && match!.index < s.close);
    out.push({
      name: match[2] as string,
      line: text.slice(0, match.index + match[0].length).split('\n').length,
      attributes,
      cfg: [...enclosing.flatMap((s) => s.attributes), ...attributes].filter((a) =>
        a.startsWith('#[cfg('),
      ),
    });
  }
  return out;
}

/**
 * The `#[cfg(…)]` attributes gating one reference, as ONE vocabulary entry.
 *
 * A reference nested in two conditional blocks needs BOTH, so several attributes conjoin
 * into Rust's own syntax for that — `cfg(all(test, windows))` — rather than becoming two
 * array entries. `VisualSpecsEdge.conditions` is a set of configurations the relation
 * exists under, so its entries read as alternatives; putting a conjunction in there would
 * invert the meaning.
 *
 * Returns null when the reference is unconditional, which is not the same as an empty
 * condition and must stay distinguishable from it.
 */
export function conditionOf(cfg: readonly string[]): string | null {
  const predicates = [
    ...new Set(
      cfg
        .map((a) => /^#\[\s*(cfg\s*\(.*\))\s*\]$/s.exec(a.replace(/\s+/g, ' '))?.[1])
        .filter((p): p is string => p !== undefined)
        .map((p) => p.replace(/\s+/g, ' ').trim()),
    ),
  ].sort();
  if (predicates.length === 0) return null;
  if (predicates.length === 1) return predicates[0] as string;
  const inner = predicates.map((p) => p.replace(/^cfg\s*\(/, '').replace(/\)$/, ''));
  return `cfg(all(${inner.join(', ')}))`;
}
