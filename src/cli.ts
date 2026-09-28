#!/usr/bin/env node
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { capture } from './capture';
import { captureSession, discoverLeanFiles, readIndex, readSession } from './collection';
import { queryRows, QueryKind } from './query';

const help=`Lean Source Profiler

  lean-profile profile FILE.lean [--output FILE.leanprofile.json]
  lean-profile profile DIRECTORY [--output NEW_SESSION_DIRECTORY]
  lean-profile profile --project PROJECT_DIRECTORY [--output NEW_SESSION_DIRECTORY]
  lean-profile profile DIRECTORY --list
  lean-profile open RECORDING_OR_SESSION
  lean-profile view RECORDING_OR_SESSION [--port 0] [--no-open]
  lean-profile query RECORDING_OR_SESSION --kind file|folder|declaration|tactic [--limit 20] [--path SUBTREE] [--json|--jsonl]

Run with node out/cli.js in this repository, or use lean-profile after npm link.
Capture options: --threshold MS --lake PATH. Imports must already be built.
Folder/project capture is sequential; failed files are recorded and others continue.
Queries rank inclusive recorded time; file/folder times include loading imports.
View starts a local standalone browser viewer; open loads source overlays in VS Code.
Tested toolchain: Lean 4.34.0-rc2. Ctrl-C cancels capture or stops the viewer.
`;
interface Args { positional:string[];values:Map<string,string>;flags:Set<string> }
function parse(args:string[],values:string[],flags:string[]):Args {
  const result:Args={positional:[],values:new Map(),flags:new Set()};
  for(let i=0;i<args.length;i++) {
    const arg=args[i]==='-o'?'--output':args[i];
    if(flags.includes(arg)){result.flags.add(arg);continue;}
    if(values.includes(arg)){const value=args[++i];if(value===undefined||value.startsWith('--'))throw new Error(`Missing value for ${arg}`);result.values.set(arg,value);continue;}
    if(arg.startsWith('-'))throw new Error(`Unknown argument ${arg}`);
    result.positional.push(arg);
  }
  return result;
}
function one(args:Args):string {if(args.positional.length!==1)throw new Error('Supply exactly one target or recording path.\n'+help);return args.positional[0];}
async function openCode(file:string){
  const uri=`vscode://local-lean-tools.lean-source-profiler/open?file=${encodeURIComponent(path.resolve(file))}`;
  const child=spawn('code',['--open-url',uri],{shell:false,stdio:'inherit'});
  await new Promise<void>((resolve,reject)=>{child.on('error',reject);child.on('close',code=>code===0?resolve():reject(new Error(`VS Code exited ${code}`)));});
}
async function main(){
  const [command,...rest]=process.argv.slice(2);
  if(!command||command==='--help'||command==='-h'){console.log(help);return;}
  if(command==='open'){await openCode(one(parse(rest,[],[])));return;}
  if(command==='view'){
    const args=parse(rest,['--port'],['--no-open']),file=one(args);
    const {startViewer}=await import('./viewer');
    const server=await startViewer(file,{port:Number(args.values.get('--port')??0),open:!args.flags.has('--no-open')});
    console.log(server.url);console.error('Local viewer running. Ctrl-C to stop.');
    const stop=()=>{void server.close().then(()=>{process.exitCode=0;});};
    process.once('SIGINT',stop);process.once('SIGTERM',stop);return;
  }
  if(command==='query'){
    const args=parse(rest,['--kind','--limit','--path','--sort'],['--json','--jsonl']);
    if(args.flags.has('--json')&&args.flags.has('--jsonl'))throw new Error('Choose --json or --jsonl.');
    const session=await readSession(one(args)),rows=queryRows(await readIndex(session),{
      kind:args.values.get('--kind') as QueryKind|undefined,limit:args.values.has('--limit')?Number(args.values.get('--limit')):undefined,
      path:args.values.get('--path'),sort:args.values.get('--sort') as 'durationMs'|'selfMs'|undefined});
    const metadata={status:session.status,completedFiles:session.files.filter(f=>f.status==='ok').length,
      failedFiles:session.files.filter(f=>f.status==='error').length,plannedFiles:session.plannedFileCount,
      notes:session.files.some(f=>f.status==='ok'&&f.declarationCount===undefined)?['Some recordings predate semantic declaration capture; recapture them to query declarations.']:[],
      metric:'file/folder: sum of isolated Lean processing elapsed ms; declaration/tactic: inclusive recorded interval ms'};
    if(args.flags.has('--json'))console.log(JSON.stringify({...metadata,results:rows},null,2));
    else if(args.flags.has('--jsonl')){console.error(JSON.stringify(metadata));for(const row of rows)console.log(JSON.stringify(row));}
    else {
      console.error(`${metadata.status}: ${metadata.completedFiles}/${metadata.plannedFiles} files captured, ${metadata.failedFiles} failed. ${metadata.metric}.`);
      console.log('milliseconds\tkind\tpath:line\tname');
      for(const row of rows)console.log(`${row.durationMs.toFixed(3)}\t${row.kind}\t${row.path}${row.line?':'+row.line:''}\t${row.name.replace(/[\t\r\n]/g,' ')}`);
    }
    return;
  }
  if(command!=='profile')throw new Error(help);
  const args=parse(rest,['--output','--threshold','--lake','--project'],['--list']);
  const project=args.values.get('--project');
  if(project&&args.positional.length)throw new Error('Use either a target path or --project PROJECT_DIRECTORY.');
  const target=project??one(args),stat=await fs.stat(target);
  if(project&&!stat.isDirectory())throw new Error('--project requires a project directory.');
  if(args.flags.has('--list')){console.log(JSON.stringify(await discoverLeanFiles(target),null,2));return;}
  const controller=new AbortController();
  process.once('SIGINT',()=>{process.exitCode=130;controller.abort();});
  process.once('SIGTERM',()=>{process.exitCode=143;controller.abort();});
  const common={extensionRoot:path.resolve(__dirname,'..'),output:args.values.get('--output'),
    thresholdMs:args.values.has('--threshold')?Number(args.values.get('--threshold')):1,lakePath:args.values.get('--lake'),
    signal:controller.signal,onLog:(s:string)=>process.stderr.write(s)};
  if(stat.isDirectory()){
    const session=await captureSession({...common,target});console.log(session.sessionPath);
    console.error(`${session.status}: ${session.files.filter(f=>f.status==='ok').length}/${session.plannedFileCount} files captured; ${(session.wallMs/1000).toFixed(2)} s capture wall time.`);
    if(session.status!=='complete')process.exitCode=session.status==='cancelled'?(process.exitCode||130):1;
  }else{
    const profile=await capture({...common,file:target});console.log(profile.profilePath);
    console.error(`${profile.nodes.length} events; ${profile.elapsedMs.toFixed(1)} ms Lean processing; ${profile.captureWallMs?.toFixed(1)} ms capture wall time.`);
  }
}
main().catch(error=>{console.error(error.message);process.exitCode ||= 1;});
