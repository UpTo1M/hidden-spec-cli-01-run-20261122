// mend: applies AI-written edits to a tree of text files, per SPEC.md (version 1).
// Four formats: unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks,
// V4A patches, and JSON text-editor tool calls. Lines are matched at the first of
// three tiers (exact, trailing-whitespace-insensitive, fully-trimmed); every file is
// changed or nothing is. Node 22, standard library alone; run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then
// this file hands over to runner.ts (the last lines below): keep that hand-over and
// runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  code: string;
  path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

/** A file as lines: its own line break, its lines, whether it ends with a break. */
interface FileModel {
  br: string;
  lines: string[];
  final: boolean;
}

function parseModel(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function writeModel(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted). */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moved: Array<{ old: string; nw: string }> = [];
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
  set(p: string, v: string | null): void {
    this.now.set(p, v);
  }
}

type Edit = (tree: Tree) => void;

function needSafe(p: string): void {
  if (!safe(p)) throw new Fail('unsafe', p);
}

/** Load a file's model, or fail `missing` when it does not exist. */
function loadModel(tree: Tree, p: string): FileModel {
  const t = tree.get(p);
  if (t === null) throw new Fail('missing', p);
  return parseModel(t);
}

function saveModel(tree: Tree, p: string, m: FileModel): void {
  tree.set(p, writeModel(m));
}

/** One line, normalised at a matching tier (SPEC.md section 5). */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return trimEndWs(s);
  return trimWs(s);
}

/** Positions where O's lines match the file's lines at a tier; occurrences may overlap. */
function occurrences(lines: string[], oldLines: string[], tier: number): number[] {
  const out: number[] = [];
  const n = oldLines.length;
  for (let i = 0; i + n <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < n; j += 1) {
      if (normLine(lines[i + j]!, tier) !== normLine(oldLines[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, with its positions. */
function findTier(lines: string[], oldLines: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const occ = occurrences(lines, oldLines, tier);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

/**
 * Replace the k matched lines at `pos` with N. A context line of N (nFromO[j] >= 0)
 * is written as the file's own matched line; at tier 2 every other line of N is
 * re-indented from O's first line's leading whitespace to the file's.
 */
function applyAt(lines: string[], oldLines: string[], newLines: string[], nFromO: number[], tier: number, pos: number): string[] {
  const out: string[] = [];
  const first = oldLines.length > 0 ? lines[pos]! : '';
  const f = leadWs(first);
  const p = oldLines.length > 0 ? leadWs(oldLines[0]!) : '';
  for (let j = 0; j < newLines.length; j += 1) {
    const from = nFromO[j]!;
    if (from >= 0) out.push(lines[pos + from]!);
    else {
      const s = newLines[j]!;
      if (tier === 2 && s.trim() !== '' && s.startsWith(p)) out.push(f + s.slice(p.length));
      else out.push(s);
    }
  }
  return lines.slice(0, pos).concat(out, lines.slice(pos + oldLines.length));
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => trimEndWs(l) === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ---- Unified diffs (SPEC.md section 6) ---- */

interface BodyLine {
  kind: string; // ' ' context, '-' old, '+' new, '\' no-newline marker
  text: string;
}
interface Hunk {
  a: number;
  body: BodyLine[];
}
interface Section {
  oldPath: string | null; // null: /dev/null
  newPath: string | null;
  create: boolean;
  remove: boolean;
  hunks: Hunk[];
}

const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)\s*$/;
const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The path after `--- ` / `+++ `: text after four chars, up to the first tab, trimmed, with a leading `a/` or `b/` removed. */
function headerPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  let p = (tab >= 0 ? rest.slice(0, tab) : rest).trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** Split O/N out of a hunk or chunk body; also whether a `\` follows its last context/`+` line. */
function splitBody(body: BodyLine[]): { o: string[]; n: string[]; nFromO: number[]; backslash: boolean } {
  const o: string[] = [];
  const n: string[] = [];
  const nFromO: number[] = [];
  let last = -1;
  for (let i = 0; i < body.length; i += 1) {
    const b = body[i]!;
    if (b.kind === ' ') {
      nFromO.push(o.length);
      o.push(b.text);
      n.push(b.text);
      last = i;
    } else if (b.kind === '-') {
      o.push(b.text);
    } else if (b.kind === '+') {
      nFromO.push(-1);
      n.push(b.text);
      last = i;
    }
  }
  const backslash = last >= 0 && body[last + 1] !== undefined && body[last + 1]!.kind === '\\';
  return { o, n, nFromO, backslash };
}

/** Apply a section's hunks in order to a file model; fails with the hunk's code. */
function applyHunks(model: FileModel, hunks: Hunk[], strict: boolean, path: string): FileModel {
  let lines = model.lines.slice();
  let final = model.final;
  let d = 0;
  for (const hunk of hunks) {
    const { o, n, nFromO, backslash } = splitBody(hunk.body);
    if (o.length > 0) {
      const found = findTier(lines, o, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = hunk.a - 1 + d;
      let best = found.occ[0]!;
      for (const pos of found.occ) {
        if (Math.abs(pos - target) < Math.abs(best - target)) best = pos;
      }
      const runsToEnd = best + o.length === lines.length;
      lines = applyAt(lines, o, n, nFromO, found.tier, best);
      d += n.length - o.length;
      if (runsToEnd) final = !backslash;
    } else {
      const at = Math.min(hunk.a + d, lines.length);
      lines = lines.slice(0, at).concat(n, lines.slice(at));
      d += n.length;
      if (at === lines.length) final = !backslash;
    }
  }
  return { br: model.br, lines, final };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let hasPair = false;
  let i = 0;
  const newSection = (): Section => {
    const s: Section = { oldPath: null, newPath: null, create: false, remove: false, hunks: [] };
    sections.push(s);
    return s;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection();
      cur.oldPath = m[1]!;
      cur.newPath = m[2]!;
      inHeader = true;
      hasPair = false;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && !hasPair) {
        cur.oldPath = headerPath(line) === '/dev/null' ? null : headerPath(line);
        cur.newPath = headerPath(lines[i + 1]!) === '/dev/null' ? null : headerPath(lines[i + 1]!);
        hasPair = true;
        i += 2;
        continue;
      }
      cur = newSection();
      cur.oldPath = headerPath(line) === '/dev/null' ? null : headerPath(line);
      cur.newPath = headerPath(lines[i + 1]!) === '/dev/null' ? null : headerPath(lines[i + 1]!);
      inHeader = true;
      hasPair = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_HEAD.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const body: BodyLine[] = [];
      i += 1;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          body.push({ kind: b === '' ? ' ' : b[0]!, text: b === '' ? '' : b.slice(1) });
          i += 1;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1]!.kind === ' ' && body[body.length - 1]!.text === '') body.pop();
      cur.hunks.push({ a: Number(m[1]), body });
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.oldPath = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.newPath = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.create = true;
      else if (line.startsWith('deleted file mode')) cur.remove = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict));
}

function unifiedEdit(s: Section, strict: boolean): Edit {
  const oldP = s.oldPath;
  const newP = s.newPath;
  const isCreate = s.create || (oldP === null && newP !== null);
  const isDelete = s.remove || (newP === null && oldP !== null);
  return (tree) => {
    if (oldP !== null) needSafe(oldP);
    if (newP !== null) needSafe(newP);
    if (isCreate) {
      const p = newP!;
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      for (const hunk of s.hunks) {
        for (const b of hunk.body) {
          if (b.kind === '+') plus.push(b.text);
        }
      }
      // A created file ends with a break unless a `\` follows its last `+` line.
      let backslash = false;
      outer: for (let h = s.hunks.length - 1; h >= 0; h -= 1) {
        const body = s.hunks[h]!.body;
        for (let k = body.length - 1; k >= 0; k -= 1) {
          if (body[k]!.kind === '+') {
            backslash = body[k + 1] !== undefined && body[k + 1]!.kind === '\\';
            break outer;
          }
        }
      }
      tree.set(p, plus.length === 0 ? '' : plus.join('\n') + (backslash ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const p = oldP!;
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.set(p, null);
      return;
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const done = applyHunks(loadModel(tree, oldP), s.hunks, strict, oldP);
      tree.set(newP, writeModel(done));
      tree.set(oldP, null);
      tree.moved.push({ old: oldP, nw: newP });
      return;
    }
    const p = oldP ?? newP!;
    if (tree.get(p) === null) throw new Fail('missing', p);
    saveModel(tree, p, applyHunks(loadModel(tree, p), s.hunks, strict, p));
  };
}

/* ---- SEARCH/REPLACE blocks (SPEC.md section 7) ---- */

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const blocks: Array<{ path: string; oldLines: string[]; newLines: string[] }> = [];
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (trimEndWs(lines[i]!) !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchAt = i;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (trimEndWs(lines[j]!) === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchAt + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (trimEndWs(lines[j]!) === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchAt + 1}`);
    let path: string | null = null;
    for (let j = searchAt - 1; j > prevEnd; j -= 1) {
      const t = lines[j]!;
      if (blank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) {
      if (blocks.length > 0) path = blocks[blocks.length - 1]!.path;
      else throw new Exit2(`error: parse ${searchAt + 1}`);
    }
    blocks.push({ path, oldLines: lines.slice(searchAt + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevEnd = rep;
    i = rep + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => (tree) => {
    needSafe(b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const model = loadModel(tree, b.path);
    const found = findTier(model.lines, b.oldLines, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.occ.length > 1) throw new Fail('ambiguous', b.path);
    const nFromO = b.newLines.map(() => -1);
    const next: FileModel = {
      br: model.br,
      lines: applyAt(model.lines, b.oldLines, b.newLines, nFromO, found.tier, found.occ[0]!),
      final: model.final,
    };
    saveModel(tree, b.path, next);
  });
}

/* ---- V4A patches (SPEC.md section 8) ---- */

interface VChunk {
  anchor: string | null; // null: no @@ line; '' would mean an empty anchor, treated as none
  eof: boolean;
  body: BodyLine[];
}
interface VSection {
  kind: string; // 'add' | 'delete' | 'update'
  path: string;
  moveTo: string | null;
  lines: string[]; // add-file lines
  chunks: VChunk[];
}

const V_ADD = '*** Add File: ';
const V_DEL = '*** Delete File: ';
const V_UPD = '*** Update File: ';
const V_MOVE = '*** Move to: ';

function vSectionStart(line: string): { kind: string; path: string } | null {
  if (line.startsWith(V_ADD)) return { kind: 'add', path: line.slice(V_ADD.length).trim() };
  if (line.startsWith(V_DEL)) return { kind: 'delete', path: line.slice(V_DEL.length).trim() };
  if (line.startsWith(V_UPD)) return { kind: 'update', path: line.slice(V_UPD.length).trim() };
  return null;
}

/** First line at or after `from` equal to a single line at the first tier with one. */
function anchorPos(lines: string[], anchor: string, from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    for (let i = from; i < lines.length; i += 1) {
      if (normLine(lines[i]!, tier) === normLine(anchor, tier)) return i;
    }
  }
  return null;
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const start = vSectionStart(lines[i]!);
    if (start === null) throw new Exit2(`error: parse ${i + 1}`);
    const startLine = i + 1;
    const sec: VSection = { kind: start.kind, path: start.path, moveTo: null, lines: [], chunks: [] };
    i += 1;
    if (start.kind === 'add') {
      while (i < last && vSectionStart(lines[i]!) === null && lines[i]!.trim() !== '*** End Patch') {
        const l = lines[i]!;
        if (l === '') sec.lines.push('');
        else if (l.startsWith('+')) sec.lines.push(l.slice(1));
        else throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
      while (sec.lines.length > 0 && sec.lines[sec.lines.length - 1] === '') sec.lines.pop();
    } else if (start.kind === 'delete') {
      // A Delete File section has no lines; anything else is a parse error (next loop turn).
    } else {
      if (i < last && lines[i]!.startsWith(V_MOVE)) {
        sec.moveTo = lines[i]!.slice(V_MOVE.length).trim();
        i += 1;
      }
      let cur: VChunk | null = null;
      const closeChunk = (): void => {
        if (cur !== null) {
          sec.chunks.push(cur);
          cur = null;
        }
      };
      while (i < last) {
        const l = lines[i]!;
        if (l.startsWith('@@')) {
          closeChunk();
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          i += 1;
          continue;
        }
        if (l.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          closeChunk();
          i += 1;
          continue;
        }
        if (vSectionStart(l) !== null || l.trim() === '*** End Patch') break;
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (cur === null && sec.chunks.length > 0) throw new Exit2(`error: parse ${i + 1}`);
          if (cur === null) cur = { anchor: null, eof: false, body: [] };
          cur.body.push({ kind: l === '' ? ' ' : l[0]!, text: l === '' ? '' : l.slice(1) });
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      closeChunk();
      // Blank lines at the end of a section are not part of it: drop trailing empty
      // context lines from the last chunk, unless it was anchored to the end of file.
      if (sec.chunks.length > 0 && !sec.chunks[sec.chunks.length - 1]!.eof) {
        const b = sec.chunks[sec.chunks.length - 1]!.body;
        while (b.length > 0 && b[b.length - 1]!.kind === ' ' && b[b.length - 1]!.text === '') b.pop();
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${startLine}`);
    }
    sections.push(sec);
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => v4aEdit(s, strict));
}

function v4aEdit(s: VSection, strict: boolean): Edit {
  return (tree) => {
    needSafe(s.path);
    if (s.moveTo !== null) needSafe(s.moveTo);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.set(s.path, s.lines.length === 0 ? '' : s.lines.join('\n') + '\n');
      return;
    }
    if (s.kind === 'delete') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.set(s.path, null);
      return;
    }
    const model = loadModel(tree, s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    let lines = model.lines.slice();
    let cursor = 0;
    for (const chunk of s.chunks) {
      if (chunk.anchor !== null) {
        const at = anchorPos(lines, chunk.anchor, cursor, strict);
        if (at === null) throw new Fail('no-match', s.path);
        cursor = at + 1;
      }
      const { o, n, nFromO } = splitBody(chunk.body);
      if (o.length === 0) {
        const at = chunk.eof ? lines.length : cursor;
        lines = lines.slice(0, at).concat(n, lines.slice(at));
        cursor = at + n.length;
        continue;
      }
      if (chunk.eof) {
        const pos = lines.length - o.length;
        if (pos < cursor) throw new Fail('no-match', s.path);
        const tiers = strict ? [0] : [0, 1, 2];
        let tier = -1;
        for (const t of tiers) {
          let ok = true;
          for (let j = 0; j < o.length; j += 1) {
            if (normLine(lines[pos + j]!, t) !== normLine(o[j]!, t)) {
              ok = false;
              break;
            }
          }
          if (ok) {
            tier = t;
            break;
          }
        }
        if (tier < 0) throw new Fail('no-match', s.path);
        lines = applyAt(lines, o, n, nFromO, tier, pos);
        cursor = pos + n.length;
        continue;
      }
      const found = findTier(lines.slice(cursor), o, strict);
      if (found === null) throw new Fail('no-match', s.path);
      const pos = cursor + found.occ[0]!;
      lines = applyAt(lines, o, n, nFromO, found.tier, pos);
      cursor = pos + n.length;
    }
    const done: FileModel = { br: model.br, lines, final: model.final };
    if (s.moveTo !== null) {
      tree.set(s.moveTo, writeModel(done));
      tree.set(s.path, null);
      tree.moved.push({ old: s.path, nw: s.moveTo });
    } else {
      saveModel(tree, s.path, done);
    }
  };
}

/* ---- JSON edits (SPEC.md section 9) ---- */

/** One JSON edit object, or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  const p = o.path;
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      needSafe(p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      needSafe(p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
      tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      needSafe(p);
      const model = loadModel(tree, p);
      if (line < 0 || line > model.lines.length) throw new Fail('no-match', p);
      const next: FileModel = { br: model.br, lines: model.lines.slice(), final: model.final };
      next.lines.splice(line, 0, ...add);
      saveModel(tree, p, next);
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

/* ---- Invocation, output, atomicity (SPEC.md sections 1, 2, 10) ---- */

function parseEdits(kind: string, text: string, lines: string[], strict: boolean): Edit[] {
  if (kind === 'json') return jsonEdits(text, lines);
  if (kind === 'unified') return parseUnified(lines, strict);
  if (kind === 'search-replace') return parseSearchReplace(lines, strict);
  return parseV4a(lines, strict);
}

function cmpBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
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
    edits = parseEdits(kind, text, lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoved = tree.moved.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moved.length = beforeMoved;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Change rows, byte-sorted by path (R rows sort by their new path).
  const rows: Array<{ key: string; line: string }> = [];
  const rDone = new Set<string>();
  for (const m of tree.moved) {
    const wasOld = tree.original(m.old);
    const nowOld = tree.now.has(m.old) ? tree.now.get(m.old)! : tree.original(m.old);
    const wasNew = tree.original(m.nw);
    const nowNew = tree.now.has(m.nw) ? tree.now.get(m.nw)! : tree.original(m.nw);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: m.nw, line: `R ${m.old} -> ${m.nw}` });
      rDone.add(m.old);
      rDone.add(m.nw);
    }
  }
  for (const p of [...tree.now.keys()].sort(cmpBytes)) {
    if (rDone.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => cmpBytes(a.key, b.key));
  const out = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  out.push(`ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`);
  return { code: 0, out };
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
