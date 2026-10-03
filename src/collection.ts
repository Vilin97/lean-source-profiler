import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { capture, CaptureOptions, findProjectRoot, readProfile } from './capture';
import { Profile } from './model';
import { buildFileIndex, folderRows, QueryRow, queryKinds, relativePath } from './query';

export interface SessionFile { id:string;path:string;sourceFile:string;status:'ok'|'error';profile?:string;elapsedMs?:number;captureWallMs?:number;eventCount?:number;declarationCount?:number;error?:string }
export interface Session {
  schemaVersion:2;kind:'lean-source-profile-session';projectRoot:string;target:string;startedAt:string;completedAt:string;
  status:'complete'|'partial'|'cancelled';wallMs:number;files:SessionFile[];sessionPath:string;
  plannedFileCount:number;excluded:string[];singleFile?:boolean;leanVersions?:string[];
}
export interface SessionOptions extends Omit<CaptureOptions,'file'> {
  target:string;onProgress?:(progress:{completed:number;total:number;file:string;status:'ok'|'error'})=>void;
}
const excludedDirectories=new Set(['node_modules','vendor','build','dist']);
export async function discoverLeanFiles(target:string):Promise<{projectRoot:string;target:string;files:string[];excluded:string[]}> {
  const absolute=await fs.realpath(path.resolve(target)),stat=await fs.stat(absolute);
  const projectRoot=await findProjectRoot(stat.isDirectory()?path.join(absolute,'__profile_scope__.lean'):absolute);
  const files:string[]=[];
  async function visit(dir:string):Promise<void>{
    for(const entry of (await fs.readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
      if(entry.isSymbolicLink())continue;
      if(entry.isDirectory()) {if(!entry.name.startsWith('.')&&!excludedDirectories.has(entry.name))await visit(path.join(dir,entry.name));}
      else if(entry.isFile()&&entry.name.endsWith('.lean')&&entry.name!=='lakefile.lean'&&!entry.name.startsWith('.'))files.push(path.join(dir,entry.name));
    }
  }
  if(stat.isDirectory())await visit(absolute);
  else if(stat.isFile()&&absolute.endsWith('.lean'))files.push(absolute);
  else throw new Error('Profile a Lean file, folder, or project directory.');
  if(!files.length)throw new Error('No Lean source files found in the selected scope.');
  return {projectRoot,target:absolute,files:files.sort(),excluded:['hidden directories/files','.lake','.git',...excludedDirectories,'symlinks','lakefile.lean']};
}
async function atomicWrite(file:string,text:string):Promise<void>{
  const temp=`${file}.${process.pid}.tmp`;
  try{await fs.writeFile(temp,text);await fs.rename(temp,file);}finally{await fs.rm(temp,{force:true});}
}
export async function captureSession(options:SessionOptions):Promise<Session>{
  const threshold=options.thresholdMs??1;
  if(!Number.isSafeInteger(threshold)||threshold<0)throw new Error('The threshold must be a nonnegative whole number of milliseconds.');
  const scope=await discoverLeanFiles(options.target);
  if(options.signal?.aborted)throw new Error('Profile capture cancelled.');
  const stamp=new Date().toISOString().replace(/[:.]/g,'-');
  const output=path.resolve(options.output??path.join(scope.projectRoot,'.leanprofiles',`session-${stamp}`));
  await fs.mkdir(path.dirname(output),{recursive:true});
  try{await fs.mkdir(output);}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new Error(`Session output already exists: ${output}. Choose a new directory.`);throw error;}
  await fs.mkdir(path.join(output,'files'));
  const started=performance.now();
  const session:Session={schemaVersion:2,kind:'lean-source-profile-session',projectRoot:scope.projectRoot,target:scope.target,
    startedAt:new Date().toISOString(),completedAt:new Date().toISOString(),status:'partial',wallMs:0,files:[],
    sessionPath:path.join(output,'session.json'),plannedFileCount:scope.files.length,excluded:scope.excluded,leanVersions:[]};
  const rows:QueryRow[]=[];
  const indexPath=path.join(output,'index.jsonl');
  await fs.writeFile(indexPath,'',{flag:'wx'});
  let indexBytes=0,indexHealthy=true;
  async function appendRows(additions:QueryRow[]){
    if(!additions.length)return;
    const text=additions.map(row=>JSON.stringify(row)).join('\n')+'\n';
    try { await fs.appendFile(indexPath,text);indexBytes+=Buffer.byteLength(text); }
    catch(error) {
      try { await fs.truncate(indexPath,indexBytes); }
      catch { indexHealthy=false; }
      throw error;
    }
  }
  async function checkpoint(){
    session.wallMs=performance.now()-started;session.completedAt=new Date().toISOString();
    await atomicWrite(session.sessionPath,JSON.stringify(session,null,2)+'\n');
  }
  await checkpoint();
  for(let i=0;i<scope.files.length;i++){
    if(options.signal?.aborted)break;
    const file=scope.files[i],id=String(i),relative=path.relative(scope.projectRoot,file).split(path.sep).join('/');
    options.onLog?.(`[${i+1}/${scope.files.length}] ${relative}\n`);
    let entry:SessionFile;
    try{
      const profilePath=`files/${id.padStart(6,'0')}.leanprofile.json`;
      const profile=await capture({...options,file,output:path.join(output,profilePath)});
      entry={id,path:relative,sourceFile:file,status:'ok',profile:profilePath,elapsedMs:profile.elapsedMs,captureWallMs:profile.captureWallMs,eventCount:profile.nodes.length,declarationCount:profile.declarations?.filter(d=>!d.generated).length};
      const fileRows=buildFileIndex(profile,relative);
      await appendRows(fileRows);
      rows.push(...fileRows);
      if(!session.leanVersions!.includes(profile.leanVersion))session.leanVersions!.push(profile.leanVersion);
    }catch(error){
      if(!indexHealthy)throw new Error('Session index write failed and could not be rolled back. The last manifest checkpoint remains valid.',{cause:error});
      if(options.signal?.aborted)break;
      entry={id,path:relative,sourceFile:file,status:'error',error:String(error instanceof Error?error.message:error).slice(0,16000)};
      options.onLog?.(`Failed ${relative}: ${entry.error}\n`);
    }
    session.files.push(entry);await checkpoint();
    options.onProgress?.({completed:session.files.length,total:scope.files.length,file,status:entry.status});
  }
  session.status=options.signal?.aborted?'cancelled':session.files.some(f=>f.status==='error')?'partial':'complete';
  const folders=folderRows(rows);
  await appendRows(folders);
  await checkpoint();return session;
}
function validString(x:unknown):x is string{return typeof x==='string'&&!x.includes('\0');}
export async function readSession(input:string):Promise<Session>{
  let file=path.resolve(input);if((await fs.stat(file)).isDirectory())file=path.join(file,'session.json');
  const stat=await fs.stat(file);if(stat.size>150*1024*1024)throw new Error('Recording exceeds the 150 MB limit.');
  const raw=JSON.parse(await fs.readFile(file,'utf8'));
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('Invalid Lean recording: expected a profile or session object.');
  if(raw?.threads||raw?.meta)await readProfile(file); // Preserve the actionable Firefox recapture diagnostic.
  if(raw.schemaVersion===1||raw.schemaVersion===3){
    const p=await readProfile(file),root=p.projectRoot??path.dirname(p.sourceFile);
    return {schemaVersion:2,kind:'lean-source-profile-session',projectRoot:root,target:p.sourceFile,
      startedAt:p.startedAt??'',completedAt:'',status:'complete',wallMs:p.captureWallMs??p.elapsedMs,sessionPath:file,singleFile:true,
      plannedFileCount:1,excluded:[],leanVersions:[p.leanVersion],files:[{id:'0',path:path.relative(root,p.sourceFile).split(path.sep).join('/'),sourceFile:p.sourceFile,status:'ok',profile:path.basename(file),elapsedMs:p.elapsedMs,captureWallMs:p.captureWallMs,eventCount:p.nodes.length,declarationCount:p.declarations?.filter(d=>!d.generated).length}]};
  }
  const invalid=()=>{throw new Error('Invalid Lean profile session manifest.');};
  if(raw.schemaVersion!==2||raw.kind!=='lean-source-profile-session'||!Array.isArray(raw.files)||raw.files.length>100000||
    !validString(raw.projectRoot)||!path.isAbsolute(raw.projectRoot)||!validString(raw.target)||!path.isAbsolute(raw.target)||
    !['complete','partial','cancelled'].includes(raw.status)||!Number.isFinite(raw.wallMs)||raw.wallMs<0||
    !Number.isInteger(raw.plannedFileCount)||raw.plannedFileCount<raw.files.length||!validString(raw.startedAt)||!validString(raw.completedAt))invalid();
  const ids=new Set<string>(),paths=new Set<string>();
  const files:SessionFile[]=raw.files.map((f:SessionFile)=>{
    if(!f||!validString(f.id)||!f.id||ids.has(f.id)||!validString(f.path)||relativePath(f.path)!==f.path||paths.has(f.path)||
      !validString(f.sourceFile)||!path.isAbsolute(f.sourceFile)||!['ok','error'].includes(f.status))invalid();
    ids.add(f.id);paths.add(f.path);
    if(f.status==='ok'&&(!validString(f.profile)||relativePath(f.profile)!==f.profile||!Number.isFinite(f.elapsedMs)||f.elapsedMs!<0))invalid();
    if(f.status==='error'&&(f.profile!==undefined||f.elapsedMs!==undefined||f.captureWallMs!==undefined))invalid();
    if(f.captureWallMs!==undefined&&(!Number.isFinite(f.captureWallMs)||f.captureWallMs<0))invalid();
    for(const count of [f.eventCount,f.declarationCount])if(count!==undefined&&(!Number.isSafeInteger(count)||count<0))invalid();
    if(f.error!==undefined&&!validString(f.error))invalid();
    return {...f};
  });
  if(raw.status==='complete'&&(files.length!==raw.plannedFileCount||files.some(f=>f.status!=='ok')))invalid();
  return {schemaVersion:2,kind:raw.kind,projectRoot:raw.projectRoot,target:raw.target,startedAt:raw.startedAt,completedAt:raw.completedAt,
    status:raw.status,wallMs:raw.wallMs,files,plannedFileCount:raw.plannedFileCount,excluded:Array.isArray(raw.excluded)?raw.excluded.filter(validString):[],
    leanVersions:Array.isArray(raw.leanVersions)?raw.leanVersions.filter(validString):[],sessionPath:file};
}
export async function sessionProfilePath(session:Session,id:string):Promise<string>{
  const entry=session.files.find(f=>f.id===id);if(!entry||entry.status!=='ok'||!entry.profile)throw new Error('No successful file recording with that ID.');
  const base=await fs.realpath(path.dirname(session.sessionPath));
  const file=await fs.realpath(path.resolve(base,entry.profile));
  if(!file.startsWith(base+path.sep))throw new Error('Profile path escapes the session directory.');
  return file;
}
export async function readSessionProfile(session:Session,id:string):Promise<Profile>{
  const profile=await readProfile(await sessionProfilePath(session,id));
  const entry=session.files.find(f=>f.id===id)!;
  if(profile.sourceFile!==entry.sourceFile)throw new Error('File recording does not match its session entry.');
  return profile;
}
export async function readIndex(session:Session):Promise<QueryRow[]>{
  if(session.singleFile){const rows=buildFileIndex(await readSessionProfile(session,'0'),session.files[0].path);return [...rows,...folderRows(rows)];}
  const base=await fs.realpath(path.dirname(session.sessionPath)),file=await fs.realpath(path.join(base,'index.jsonl'));
  if(!file.startsWith(base+path.sep))throw new Error('Index path escapes the session directory.');
  const stat=await fs.stat(file);
  if(stat.size>256*1024*1024)throw new Error('Session index exceeds the 256 MB limit.');
  const result:QueryRow[]=[];
  const contents=await fs.readFile(file,'utf8'),lines=contents.split('\n');
  for(const [i,line] of lines.entries())if(line.trim()){
    let row;
    try { row=JSON.parse(line); }
    catch(error) {
      // Only an incomplete trailing append in an unfinished session is recoverable.
      if(i===lines.length-1&&!contents.endsWith('\n')&&session.status!=='complete')continue;
      throw error;
    }
    if(!row||!queryKinds.includes(row.kind)||!validString(row.name)||!validString(row.path)||relativePath(row.path)!==row.path||
      !Number.isFinite(row.durationMs)||row.durationMs<0||row.selfMs!==undefined&&(!Number.isFinite(row.selfMs)||row.selfMs<0))throw new Error('Invalid session index row.');
    for(const field of ['line','endLine'])if(row[field]!==undefined&&(!Number.isSafeInteger(row[field])||row[field]<1))throw new Error('Invalid index source line.');
    if(row.line!==undefined&&row.endLine!==undefined&&row.endLine<row.line)throw new Error('Invalid index source range.');
    for(const field of ['eventId','declaration'])if(row[field]!==undefined&&!validString(row[field]))throw new Error('Invalid index event reference.');
    if(row.eventIds!==undefined&&(!Array.isArray(row.eventIds)||!row.eventIds.every(validString)))throw new Error('Invalid index event references.');
    if(row.sharedWith!==undefined&&(!Array.isArray(row.sharedWith)||!row.sharedWith.every(validString)))throw new Error('Invalid shared declaration names.');
    result.push(row);
  }
  // The index is checkpointed before the manifest. If interrupted between renames,
  // ignore a newly indexed file that the opened manifest has not committed yet.
  const committed=new Set(session.files.filter(f=>f.status==='ok').map(f=>f.path));
  const rows=result.filter(row=>row.kind!=='folder'&&committed.has(row.path));
  return [...rows,...folderRows(rows)];
}
