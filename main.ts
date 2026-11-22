// main.ts is mend, the CLI SPEC.md specifies. It applies the edits AI models write, in four formats, to a tree
// of text files: unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON edits. Every file is changed or
// nothing is. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, as [old, new] pairs, for the `R` output lines. */
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** A file's lines, its own line break, and whether it ends with one (SPEC.md section 3). */
function splitFile(text: string): { lines: string[]; br: string; final: boolean } {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** Section 5: one line against another at a tier. */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return a.replace(/[ \t]+$/, '') === b.replace(/[ \t]+$/, '');
  return a.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '') === b.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function tiers(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** Positions where O occurs in `file` at a tier, from `from` onwards; occurrences may overlap. */
function occurrencesAt(file: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = from; i + o.length <= file.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (!lineEq(file[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface Found {
  tier: number;
  positions: number[];
}

/** The first tier at which O occurs in `file` from `from`, with every position there, or null. */
function findTier(file: string[], o: string[], strict: boolean, from: number): Found | null {
  for (const tier of tiers(strict)) {
    const positions = occurrencesAt(file, o, tier, from);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** One line of N: a context line names its index in O, an added line names none. */
interface NewLine {
  text: string;
  oIndex: number | null;
}

/**
 * Build N as it is written over the matched lines at `at`: context lines are the file's own matched
 * lines, and at tier 2 every other line is re-indented from O's first line's leading whitespace to the
 * file's first matched line's (SPEC.md section 5).
 */
function buildNew(file: string[], at: number, o: string[], n: NewLine[], tier: number): string[] {
  const f = leadingWs(file[at] ?? '');
  const p = leadingWs(o[0] ?? '');
  return n.map((nl) => {
    if (nl.oIndex !== null) return file[at + nl.oIndex]!;
    if (tier === 2) {
      const t = nl.text;
      if (t !== '' && !/^[ \t]+$/.test(t) && t.startsWith(p)) return f + t.slice(p.length);
    }
    return nl.text;
  });
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const { lines, br, final } = splitFile(before);
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(lines, br, final));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Unified diffs (SPEC.md section 6) ----

interface Hunk {
  /** The -A number of the header. */
  a: number;
  oldLines: string[];
  newLines: NewLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  lastNoEol: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  lastPlusNoEol: boolean;
}

interface Section {
  /** null when the old path is /dev/null; undefined when no line names one. */
  hdrOld: string | null | undefined;
  hdrNew: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  gitOld: string | undefined;
  gitNew: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** The path after `--- `/`+++ `: up to the first tab, surrounding spaces removed, `a/`/`b/` stripped. */
function headerPath(line: string): string | null {
  let p = line.slice(4).split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parse one hunk at `i` (its header line) and return the index after its body. */
function parseHunk(lines: string[], i: number, sec: Section): number {
  const m = HUNK_HEAD.exec(lines[i]!);
  if (m === null) throw new Exit2(`error: parse ${i + 1}`);
  const a = Number(m[1]);
  i += 1;
  const raw: string[] = [];
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
      raw.push(l);
      i += 1;
    } else break;
  }
  while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  const oldLines: string[] = [];
  const newLines: NewLine[] = [];
  let lastCtxPlus = -1;
  let lastPlus = -1;
  raw.forEach((l, idx) => {
    if (l === '' || l.startsWith(' ')) {
      const text = l === '' ? '' : l.slice(1);
      oldLines.push(text);
      newLines.push({ text, oIndex: oldLines.length - 1 });
      lastCtxPlus = idx;
    } else if (l.startsWith('-')) {
      oldLines.push(l.slice(1));
    } else if (l.startsWith('+')) {
      newLines.push({ text: l.slice(1), oIndex: null });
      lastCtxPlus = idx;
      lastPlus = idx;
    }
  });
  const followsBackslash = (idx: number): boolean => idx >= 0 && idx + 1 < raw.length && raw[idx + 1]!.startsWith('\\');
  sec.hunks.push({ a, oldLines, newLines, lastNoEol: followsBackslash(lastCtxPlus), lastPlusNoEol: followsBackslash(lastPlus) });
  return i;
}

/** A section's old path, new path and kind, from its header lines. */
function resolveSection(sec: Section): { oldP: string | null; newP: string | null; kind: 'create' | 'delete' | 'move' | 'change' } {
  let oldP: string | null = null;
  let newP: string | null = null;
  let oldNull = false;
  let newNull = false;
  if (sec.hdrOld !== undefined) {
    if (sec.hdrOld === null) oldNull = true;
    else oldP = sec.hdrOld;
  } else if (sec.renameFrom !== undefined) oldP = sec.renameFrom;
  else if (sec.gitOld !== undefined) oldP = sec.gitOld;
  if (sec.hdrNew !== undefined) {
    if (sec.hdrNew === null) newNull = true;
    else newP = sec.hdrNew;
  } else if (sec.renameTo !== undefined) newP = sec.renameTo;
  else if (sec.gitNew !== undefined) newP = sec.gitNew;
  if (oldNull || sec.newFile) return { oldP, newP, kind: 'create' };
  if (newNull || sec.deletedFile) return { oldP, newP, kind: 'delete' };
  if (oldP !== newP) return { oldP, newP, kind: 'move' };
  return { oldP, newP, kind: 'change' };
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  const { oldP, newP, kind } = resolveSection(sec);
  return (tree) => {
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (kind === 'create') {
      if (newP === null) throw new Fail('unsafe', '');
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let noEol = false;
      for (const h of sec.hunks) {
        let hadPlus = false;
        for (const nl of h.newLines) {
          if (nl.oIndex === null) {
            plus.push(nl.text);
            hadPlus = true;
          }
        }
        if (hadPlus) noEol = h.lastPlusNoEol;
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (kind === 'delete') {
      if (oldP === null) throw new Fail('unsafe', '');
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    const oldPath = oldP!;
    const before = tree.get(oldPath);
    if (before === null) throw new Fail('missing', oldPath);
    if (kind === 'move' && tree.get(newP!) !== null) throw new Fail('exists', newP!);
    const { lines, br, final } = splitFile(before);
    let cur = lines;
    let finalBreak = final;
    let d = 0;
    for (const h of sec.hunks) {
      if (h.oldLines.length === 0) {
        const wasLen = cur.length;
        const pos = Math.min(h.a + d, wasLen);
        const ins = h.newLines.map((nl) => nl.text);
        cur = [...cur.slice(0, pos), ...ins, ...cur.slice(pos)];
        if (pos === wasLen) finalBreak = !h.lastNoEol;
        d += ins.length;
        continue;
      }
      const found = findTier(cur, h.oldLines, strict, 0);
      if (found === null) throw new Fail('no-match', oldPath);
      const target = h.a - 1 + d;
      let best = found.positions[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.positions) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const atEnd = best + h.oldLines.length === cur.length;
      const built = buildNew(cur, best, h.oldLines, h.newLines, found.tier);
      cur = [...cur.slice(0, best), ...built, ...cur.slice(best + h.oldLines.length)];
      if (atEnd) finalBreak = !h.lastNoEol;
      d += h.newLines.length - h.oldLines.length;
    }
    const out = joinFile(cur, br, finalBreak);
    if (kind === 'move') {
      tree.now.set(oldPath, null);
      tree.now.set(newP!, out);
      tree.moves.push([oldPath, newP!]);
    } else {
      tree.now.set(oldPath, out);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let i = 0;
  const startSection = (gitOld: string | undefined, gitNew: string | undefined): Section => {
    const sec: Section = { hdrOld: undefined, hdrNew: undefined, renameFrom: undefined, renameTo: undefined, gitOld, gitNew, newFile: false, deletedFile: false, hunks: [] };
    sections.push(sec);
    cur = sec;
    inHeader = true;
    return sec;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*?) b\/(.*)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(m[1]!, m[2]!);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      const followed = (lines[i + 1] ?? '').startsWith('+++ ');
      if (inHeader && cur !== null) {
        if (!followed) throw new Exit2(`error: parse ${i + 2}`);
        if (cur.hdrOld !== undefined) {
          // A second ---/+++ pair in a header starts a new section.
          const sec = startSection(undefined, undefined);
          sec.hdrOld = headerPath(line);
          sec.hdrNew = headerPath(lines[i + 1]!);
          i += 2;
          continue;
        }
        cur.hdrOld = headerPath(line);
        cur.hdrNew = headerPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      if (followed) {
        const sec = startSection(undefined, undefined);
        sec.hdrOld = headerPath(line);
        sec.hdrNew = headerPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      i = parseHunk(lines, i, cur);
      inHeader = false;
      continue;
    }
    if (inHeader && cur !== null) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections.map((sec) => unifiedEdit(sec, strict));
}

// ---- SEARCH/REPLACE blocks (SPEC.md section 7) ----

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  const n: NewLine[] = newLines.map((text) => ({ text, oIndex: null }));
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const { lines, br, final } = splitFile(before);
    const found = findTier(lines, oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const at = found.positions[0]!;
    const built = buildNew(lines, at, oldLines, n, found.tier);
    const cur = [...lines.slice(0, at), ...built, ...lines.slice(at + oldLines.length)];
    tree.now.set(path, joinFile(cur, br, final));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let j = s - 1; j >= prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = s + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq === -1) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${s + 1}`);
    edits.push(searchReplaceEdit(path, lines.slice(s + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

// ---- V4A patches (SPEC.md section 8) ----

interface VChunk {
  /** null: no anchor (a chunk without an `@@` line, or an empty anchor). */
  anchor: string | null;
  oldLines: string[];
  newLines: NewLine[];
  /** Anchored to the end of the file by a `*** End of File` line. */
  eof: boolean;
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const { lines, br, final } = splitFile(before);
    let cur = lines;
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let anchorAt: number | null = null;
        for (const tier of tiers(strict)) {
          for (let k = cursor; k < cur.length; k += 1) {
            if (lineEq(cur[k]!, ch.anchor, tier)) {
              anchorAt = k;
              break;
            }
          }
          if (anchorAt !== null) break;
        }
        if (anchorAt === null) throw new Fail('no-match', path);
        cursor = anchorAt + 1;
      }
      if (ch.oldLines.length === 0) {
        const pos = ch.eof ? cur.length : cursor;
        const ins = ch.newLines.map((nl) => nl.text);
        cur = [...cur.slice(0, pos), ...ins, ...cur.slice(pos)];
        cursor = pos + ins.length;
        continue;
      }
      let found: Found | null = null;
      if (ch.eof) {
        const at = cur.length - ch.oldLines.length;
        if (at >= cursor) {
          for (const tier of tiers(strict)) {
            if (occurrencesAt(cur, ch.oldLines, tier, at).includes(at)) {
              found = { tier, positions: [at] };
              break;
            }
          }
        }
      } else {
        found = findTier(cur, ch.oldLines, strict, cursor);
      }
      if (found === null) throw new Fail('no-match', path);
      const at = found.positions[0]!;
      const built = buildNew(cur, at, ch.oldLines, ch.newLines, found.tier);
      cur = [...cur.slice(0, at), ...built, ...cur.slice(at + ch.oldLines.length)];
      cursor = at + built.length;
    }
    const out = joinFile(cur, br, final);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

const SECTION_START = (l: string): boolean => l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

/** Parse one V4A section starting at `i` (its header line); return the index after it. */
/** Parse one V4A section starting at `i` (its header line); return the index after it. */
function parseV4aSection(lines: string[], i: number, last: number, edits: Edit[], strict: boolean): number {
  const line = lines[i]!;
  // The section's raw lines run to the next section or `*** End Patch`; blank lines at the end
  // of a section are not part of it, so they are dropped before the lines are read.
  let end = i + 1;
  while (end < last && !SECTION_START(lines[end]!)) end += 1;
  const raw = lines.slice(i + 1, end);
  while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
  if (line.startsWith('*** Add File: ')) {
    const path = line.slice('*** Add File: '.length).trim();
    const fileLines: string[] = [];
    for (let k = 0; k < raw.length; k += 1) {
      const l = raw[k]!;
      if (l.startsWith('+')) fileLines.push(l.slice(1));
      else if (l === '') fileLines.push('');
      else throw new Exit2(`error: parse ${i + 2 + k}`);
    }
    edits.push(v4aAddEdit(path, fileLines));
    return end;
  }
  if (line.startsWith('*** Delete File: ')) {
    const path = line.slice('*** Delete File: '.length).trim();
    for (let k = 0; k < raw.length; k += 1) {
      if (!blank(raw[k]!)) throw new Exit2(`error: parse ${i + 2 + k}`);
    }
    edits.push(v4aDeleteEdit(path));
    return end;
  }
  // *** Update File:
  const path = line.slice('*** Update File: '.length).trim();
  const updateLine = i + 1;
  let moveTo: string | null = null;
  let k = 0;
  if (k < raw.length && raw[k]!.startsWith('*** Move to: ')) {
    moveTo = raw[k]!.slice('*** Move to: '.length).trim();
    k += 1;
  }
  const chunks: VChunk[] = [];
  let cur: { anchor: string | null; body: string[]; eof: boolean } | null = null;
  let chunkOpen = false;
  const closeChunk = (): void => {
    if (cur === null) return;
    const oldLines: string[] = [];
    const newLines: NewLine[] = [];
    for (const l of cur.body) {
      if (l === '' || l.startsWith(' ')) {
        const text = l === '' ? '' : l.slice(1);
        oldLines.push(text);
        newLines.push({ text, oIndex: oldLines.length - 1 });
      } else if (l.startsWith('-')) oldLines.push(l.slice(1));
      else if (l.startsWith('+')) newLines.push({ text: l.slice(1), oIndex: null });
    }
    chunks.push({ anchor: cur.anchor, oldLines, newLines, eof: cur.eof });
    cur = null;
    chunkOpen = false;
  };
  for (; k < raw.length; k += 1) {
    const l = raw[k]!;
    if (l.startsWith('@@')) {
      closeChunk();
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
      chunkOpen = true;
      continue;
    }
    if (l.trim() === '*** End of File') {
      if (!chunkOpen || cur === null) throw new Exit2(`error: parse ${i + 2 + k}`);
      cur.eof = true;
      closeChunk();
      continue;
    }
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (!chunkOpen) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${i + 2 + k}`);
        cur = { anchor: null, body: [], eof: false };
        chunkOpen = true;
      }
      cur!.body.push(l);
      continue;
    }
    throw new Exit2(`error: parse ${i + 2 + k}`);
  }
  closeChunk();
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
  edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
  return end;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (!SECTION_START(line)) throw new Exit2(`error: parse ${i + 1}`);
    i = parseV4aSection(lines, i, last, edits, strict);
  }
  return edits;
}


function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // One output line per changed path, in byte order; a successful move prints `R old -> new`
  // instead of the pair's `D` and `A` lines, and sorts by its new path.
  const movedOld = new Set<string>();
  const movedNew = new Set<string>();
  const rows: { key: string; text: string }[] = [];
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      movedOld.add(oldP);
      movedNew.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (!check) {
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
    if (movedOld.has(p) || movedNew.has(p)) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.text);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
