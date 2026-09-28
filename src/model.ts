import * as path from 'node:path';

export interface Position { line: number; character: number }
export interface SourceRange { file: string; start: Position; end: Position }
export interface SymbolRef {
  name: string;
  file?: string;
  range?: { start: Position; end: Position };
  kind: 'reference' | 'unfold';
  sourceStale?: boolean;
}
export interface ProfileNode {
  id: string;
  parentId: string | null;
  category: string;
  label: string;
  detail: string;
  startMs: number;
  durationMs: number;
  selfMs: number;
  source?: SourceRange;
  sourceKind?: 'exact' | 'inherited';
  symbols?: SymbolRef[];
  thread?: string;
}
export interface Profile {
  schemaVersion: 1;
  sourceFile: string;
  sourceText: string;
  sourceTexts?: Record<string, string>;
  leanVersion: string;
  elapsedMs: number;
  nodes: ProfileNode[];
  startedAt?: string;
  diagnostics?: unknown[];
  projectRoot?: string;
  profilePath?: string;
  captureWallMs?: number;
  thresholdMs?: number;
  captureMethod?: string;
  declarations?: Array<{ name: string; source: SourceRange; kind?: string; generated?: boolean }>;
}

function fail(message: string): never { throw new Error(`Invalid Lean profile: ${message}`); }
function object(x: unknown, name: string): Record<string, unknown> {
  if (!x || typeof x !== 'object' || Array.isArray(x)) fail(`${name} must be an object`);
  return x as Record<string, unknown>;
}
function string(x: unknown, name: string): string {
  if (typeof x !== 'string') fail(`${name} must be a string`);
  return x;
}
function number(x: unknown, name: string): number {
  if (typeof x !== 'number' || !Number.isFinite(x) || x < 0) fail(`${name} must be finite and nonnegative`);
  return x;
}
function position(x: unknown): Position {
  const v = object(x, 'position');
  const line = number(v.line, 'line'), character = number(v.character, 'character');
  if (!Number.isInteger(line) || !Number.isInteger(character)) fail('positions must be integers');
  return { line, character };
}
function range(x: unknown): { start: Position; end: Position } {
  const r = object(x, 'range');
  const start = position(r.start), end = position(r.end);
  if (end.line < start.line || (end.line === start.line && end.character < start.character)) fail('range ends before it starts');
  return { start, end };
}
function filename(x: unknown): string {
  const s = string(x, 'file');
  if (!path.isAbsolute(s) || s.includes('\0')) fail('source filenames must be absolute local paths');
  return path.normalize(s);
}

/** Length of the union, not sum, so overlapping/recursive child events are never double charged. */
export function intervalUnion(intervals: Array<[number, number]>): number {
  if (intervals.length === 0) return 0;
  intervals.sort((a, b) => a[0] - b[0]);
  let [start, end] = intervals[0], total = 0;
  for (let i = 1; i < intervals.length; i++) {
    const [a, b] = intervals[i];
    if (a <= end) end = Math.max(end, b);
    else { total += end - start; start = a; end = b; }
  }
  return total + end - start;
}

export function normalizeProfile(input: unknown): Profile {
  const p = object(input, 'recording');
  if (p.schemaVersion !== 1) {
    if (p.threads || p.meta) throw new Error('This is a Firefox profile without Lean source attribution. Use “Lean Source Profiler: Profile Current File” to capture a source-mapped recording.');
    fail('unsupported schema version (expected 1)');
  }
  if (p.success === false) fail('the captured Lean file failed to elaborate; fix its errors and capture again');
  if (!Array.isArray(p.nodes) || p.nodes.length > 300_000) fail('nodes must be an array with at most 300,000 events');
  const nodes: ProfileNode[] = p.nodes.map((raw, i) => {
    const n = object(raw, `node ${i}`);
    const source = n.source === undefined || n.source === null ? undefined : {
      file: filename(object(n.source, 'source').file), ...range(n.source)
    };
    if (n.sourceKind != null && n.sourceKind !== 'exact' && n.sourceKind !== 'inherited') fail('unknown source attribution kind');
    if (n.symbols != null && !Array.isArray(n.symbols)) fail('symbols must be an array');
    const symbols: SymbolRef[] = (n.symbols as unknown[] | undefined ?? []).map(rawSymbol => {
      const s = object(rawSymbol, 'symbol');
      if (s.kind !== 'reference' && s.kind !== 'unfold') fail('unknown symbol relationship');
      return { name: string(s.name, 'symbol name'), kind: s.kind,
        sourceStale: s.sourceStale === true,
        file: s.file == null ? undefined : filename(s.file), range: s.sourceStale === true || s.range == null ? undefined : range(s.range) };
    });
    return {
      id: string(n.id, 'node id'), parentId: n.parentId === null ? null : string(n.parentId, 'parent id'),
      category: string(n.category, 'category'), label: string(n.label, 'label'), detail: string(n.detail ?? '', 'detail'),
      startMs: number(n.startMs, 'startMs'), durationMs: number(n.durationMs, 'durationMs'), selfMs: 0,
      source, sourceKind: n.sourceKind == null ? undefined : n.sourceKind as ProfileNode['sourceKind'], symbols,
      thread: n.thread == null ? undefined : String(n.thread)
    };
  });
  const byId = new Map<string, ProfileNode>();
  for (const n of nodes) {
    if (!n.id || byId.has(n.id)) fail('event ids must be nonempty and unique');
    if (!Number.isFinite(n.startMs + n.durationMs)) fail('event interval overflows');
    byId.set(n.id, n);
  }
  const children = new Map<string, ProfileNode[]>();
  for (const n of nodes) if (n.parentId !== null) {
    if (!byId.has(n.parentId)) fail(`missing parent ${n.parentId}`);
    const siblings = children.get(n.parentId) ?? [];
    siblings.push(n); children.set(n.parentId, siblings);
  }
  // Iterative parent walk handles deep isDefEq stacks without overflowing JavaScript's stack.
  const complete = new Set<string>();
  for (const node of nodes) {
    let next: ProfileNode | undefined = node;
    const visiting = new Set<string>();
    while (next && !complete.has(next.id)) {
      if (visiting.has(next.id)) fail('cyclic event parents');
      visiting.add(next.id);
      next = next.parentId === null ? undefined : byId.get(next.parentId);
    }
    for (const id of visiting) complete.add(id);
  }
  for (const n of nodes) {
    const end = n.startMs + n.durationMs;
    const intervals: Array<[number, number]> = [];
    for (const c of children.get(n.id) ?? []) {
      const a = Math.max(n.startMs, c.startMs), b = Math.min(end, c.startMs + c.durationMs);
      if (b > a) intervals.push([a, b]);
    }
    n.selfMs = Math.max(0, n.durationMs - intervalUnion(intervals));
  }
  const sourceFile = filename(p.sourceFile), sourceText = string(p.sourceText, 'sourceText');
  const sourceTexts: Record<string, string> = Object.create(null);
  if (p.sourceTexts !== undefined) {
    for (const [file, content] of Object.entries(object(p.sourceTexts, 'sourceTexts'))) sourceTexts[filename(file)] = string(content, 'source snapshot');
  }
  sourceTexts[sourceFile] = sourceText;
  const sourceLines = new Map(Object.entries(sourceTexts).map(([file, text]) => [file, text.split(/\r?\n/)]));
  for (const n of nodes) {
    const source = n.source;
    if (!source) continue;
    const lines = sourceLines.get(source.file);
    if (lines && [source.start, source.end].some(p => p.line >= lines.length || p.character > lines[p.line].length)) fail(`event ${n.id} source range lies outside its snapshot`);
  }
  return {
    schemaVersion: 1, sourceFile, sourceText, sourceTexts,
    leanVersion: string(p.leanVersion, 'leanVersion'), elapsedMs: number(p.elapsedMs, 'elapsedMs'), nodes,
    startedAt: p.startedAt === undefined ? undefined : string(p.startedAt, 'startedAt'),
    projectRoot: p.projectRoot === undefined ? undefined : filename(p.projectRoot),
    diagnostics: Array.isArray(p.diagnostics) ? p.diagnostics : [],
    captureWallMs: p.captureWallMs === undefined ? undefined : number(p.captureWallMs, 'captureWallMs'),
    thresholdMs: p.thresholdMs === undefined ? undefined : number(p.thresholdMs, 'thresholdMs'),
    captureMethod: p.captureMethod === undefined ? undefined : string(p.captureMethod, 'captureMethod'),
    declarations: p.declarations == null ? undefined : (() => {
      if (!Array.isArray(p.declarations) || p.declarations.length > 100_000) fail('declarations must be an array with at most 100,000 entries');
      return p.declarations.map(raw => {
        const d = object(raw, 'declaration'), s = object(d.source, 'declaration source');
        const source = { file: filename(s.file), ...range(s) };
        const lines = sourceLines.get(source.file);
        if (lines && [source.start, source.end].some(pos => pos.line >= lines.length || pos.character > lines[pos.line].length)) fail('declaration range lies outside its snapshot');
        return { name: string(d.name, 'declaration name'), source,
          kind: d.kind === undefined ? undefined : string(d.kind, 'declaration kind'), generated: d.generated === true };
      });
    })()
  };
}
