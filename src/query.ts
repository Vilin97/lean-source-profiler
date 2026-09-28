import * as path from 'node:path';
import { intervalUnion, Profile, ProfileNode, SourceRange } from './model';

export type QueryKind = 'file' | 'folder' | 'declaration' | 'tactic';
export interface QueryRow {
  kind: QueryKind; name: string; path: string; durationMs: number;
  selfMs?: number; line?: number; endLine?: number; eventId?: string; eventIds?: string[]; declaration?: string;
  captureWallMs?: number; attribution?: 'recorded-interval-union' | 'shared' | 'source-interval-union'; sharedWith?: string[];
}
export interface QueryOptions { kind?: QueryKind; limit?: number; path?: string; sort?: 'durationMs' | 'selfMs' }
export const queryKinds = ['file', 'folder', 'declaration', 'tactic'] as const;
export function relativePath(value: string): string {
  const p = value.replace(/\\/g, '/');
  if (path.posix.isAbsolute(p) || /^[A-Za-z]:/.test(p) || p.split('/').includes('..') || p.includes('\0')) throw new Error('Use a relative path within the recording.');
  return path.posix.normalize(p).replace(/\/$/, '') || '.';
}
export function queryRows(rows: QueryRow[], options: QueryOptions = {}): QueryRow[] {
  if (options.kind !== undefined && !queryKinds.includes(options.kind)) throw new Error('Unknown query kind. Use file, folder, declaration, or tactic.');
  const limit = options.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100_000) throw new Error('limit must be an integer from 1 to 100000.');
  const sort = options.sort ?? 'durationMs';
  if (sort !== 'durationMs' && sort !== 'selfMs') throw new Error('sort must be durationMs or selfMs.');
  const prefix = relativePath(options.path ?? '.');
  return rows.filter(row => (!options.kind || row.kind === options.kind) &&
    (prefix === '.' || row.path === prefix || row.path.startsWith(`${prefix}/`)) &&
    (sort !== 'selfMs' || row.selfMs !== undefined))
    .sort((a, b) => (b[sort] ?? 0) - (a[sort] ?? 0) || a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0) || a.name.localeCompare(b.name)).slice(0, limit);
}
const posCompare = (a: {line:number;character:number}, b: {line:number;character:number}) => a.line-b.line || a.character-b.character;
function contains(outer: SourceRange, inner: SourceRange): boolean {
  return outer.file === inner.file && posCompare(outer.start, inner.start) <= 0 && posCompare(inner.end, outer.end) <= 0;
}
function sourceKey(s: SourceRange): string { return `${s.start.line}:${s.start.character}:${s.end.line}:${s.end.character}`; }
function tacticEligible(n: ProfileNode): boolean {
  return n.category === 'Source.tactic' && n.sourceKind === 'exact' && !!n.source &&
    !/Lean\.Parser\.Tactic\.tacticSeq\w*\b/.test(n.label) &&
    !(/Lean\.Parser\.Tactic\.seq1?\b/.test(n.label) && n.source.start.line !== n.source.end.line);
}
function snippet(profile: Profile, range: SourceRange): string {
  const lines = profile.sourceText.split(/\r?\n/);
  return lines.slice(range.start.line, range.end.line+1).map((s,i) => s.slice(i===0 ? range.start.character : 0,
    range.start.line+i===range.end.line ? range.end.character : undefined)).join(' ').replace(/\s+/g,' ').slice(0,180);
}
export function buildFileIndex(profile: Profile, filePath: string): QueryRow[] {
  const byId=new Map(profile.nodes.map(n=>[n.id,n]));
  function roots(nodes:ProfileNode[]):string[]{
    const members=new Set(nodes.map(n=>n.id));
    return nodes.filter(n=>{let parent=n.parentId;while(parent!==null){if(members.has(parent))return false;parent=byId.get(parent)?.parentId??null;}return true;}).map(n=>n.id);
  }
  const rows: QueryRow[] = [{ kind:'file', name:path.posix.basename(filePath), path:filePath, durationMs:profile.elapsedMs, captureWallMs:profile.captureWallMs }];
  const declarations = (profile.declarations ?? []).filter(d => !d.generated && d.source.file === profile.sourceFile);
  const groups = new Map<string, {source:SourceRange;names:string[];nodes:ProfileNode[]}>();
  for (const d of declarations) {
    const key=sourceKey(d.source), group=groups.get(key) ?? {source:d.source,names:[],nodes:[]};
    group.names.push(d.name); groups.set(key,group);
  }
  const ordered=[...groups.values()].sort((a,b)=>posCompare(a.source.start,b.source.start));
  const prefixEnd:SourceRange['end'][]=[];
  for(const group of ordered){const previous=prefixEnd[prefixEnd.length-1];prefixEnd.push(previous&&posCompare(previous,group.source.end)>0?previous:group.source.end);}
  // Prefix maxima keep lookup efficient without losing outer declarations after an inner scope.
  function owners(range:SourceRange) {
    let lo=0,hi=ordered.length;
    while(lo<hi){const mid=(lo+hi)>>>1;if(posCompare(ordered[mid].source.start,range.start)<=0)lo=mid+1;else hi=mid;}
    const result:typeof ordered=[];
    for(let i=lo-1;i>=0;i--){if(posCompare(prefixEnd[i],range.end)<0)break;
      const group=ordered[i];if(contains(group.source,range))result.push(group);}
    return result.sort((a,b)=>posCompare(b.source.start,a.source.start)||posCompare(a.source.end,b.source.end));
  }
  for(const node of profile.nodes) if(node.source?.file===profile.sourceFile)for(const group of owners(node.source))group.nodes.push(node);
  for(const group of ordered) {
    if(!group.nodes.length) continue; // Older captures may lack declaration trace coverage; never invent a zero timing.
    const durationMs=intervalUnion(group.nodes.map(n=>[n.startMs,n.startMs+n.durationMs]));
    const representative=group.nodes.reduce((a,b)=>a.durationMs>=b.durationMs?a:b);
    for(const name of group.names) rows.push({kind:'declaration',name,path:filePath,durationMs,
      line:group.source.start.line+1,endLine:group.source.end.line+1,eventId:representative.id,eventIds:roots(group.nodes),
      attribution:group.names.length>1?'shared':'recorded-interval-union',sharedWith:group.names.length>1?group.names:undefined});
  }
  const tactics=new Map<string,ProfileNode[]>();
  for(const n of profile.nodes) if(tacticEligible(n)&&n.source!.file===profile.sourceFile) {
    const key=sourceKey(n.source!), values=tactics.get(key)??[];values.push(n);tactics.set(key,values);
  }
  for(const values of tactics.values()) {
    const n=values.reduce((a,b)=>a.durationMs>=b.durationMs?a:b),source=n.source!;
    rows.push({kind:'tactic',name:snippet(profile,source)||n.label,path:filePath,
      durationMs:intervalUnion(values.map(n=>[n.startMs,n.startMs+n.durationMs])),
      // Self belongs to the representative event; nested wrappers sharing a source range are not summed.
      selfMs:n.selfMs,eventId:n.id,eventIds:roots(values),attribution:'source-interval-union',line:source.start.line+1,endLine:source.end.line+1,declaration:owners(source)[0]?.names.join(', ')});
  }
  return rows;
}
export function folderRows(files: QueryRow[]): QueryRow[] {
  const totals=new Map<string,number>();
  for(const file of files.filter(r=>r.kind==='file')) {
    let dir=path.posix.dirname(file.path);
    while(true){totals.set(dir,(totals.get(dir)??0)+file.durationMs);if(dir==='.')break;dir=path.posix.dirname(dir);}
  }
  return [...totals].map(([folder,durationMs])=>({kind:'folder',name:folder==='.'?'.':path.posix.basename(folder),path:folder,durationMs}));
}
