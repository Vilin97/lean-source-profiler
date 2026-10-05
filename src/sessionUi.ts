import * as vscode from 'vscode';
import * as path from 'node:path';
import { captureSession, readSession, readSessionProfile, Session } from './collection';
import { findProjectRoot } from './capture';
import { ProfileUI, formatDuration } from './ui';
import { startViewer } from './viewer';

export class SessionUI implements vscode.Disposable {
  private current?:Session;
  private viewers:Array<{close():Promise<void>}>=[];
  constructor(private context:vscode.ExtensionContext,private ui:ProfileUI,private output:vscode.OutputChannel,private captureState:{running?:AbortController}){}
  dispose(){this.captureState.running?.abort();for(const viewer of this.viewers)void viewer.close();}
  async open(file:string){
    const session=await readSession(file);
    if(session.singleFile){const profile=await readSessionProfile(session,'0');await this.ui.showProfile(profile);return profile;}
    this.current=session;await this.context.workspaceState.update('lastSession',session.sessionPath);
    await this.selectFile();return session;
  }
  async openFile(recording:string,id:string){
    const session=await readSession(recording),profile=await readSessionProfile(session,id);
    this.current=session;await this.context.workspaceState.update('lastSession',session.sessionPath);
    await this.ui.showProfile(profile);return profile;
  }
  async selectFile(){
    if(!this.current){const saved=this.context.workspaceState.get<string>('lastSession');if(saved)this.current=await readSession(saved);}
    if(!this.current){void vscode.window.showInformationMessage('Open or capture a project session first.');return;}
    const session=this.current;
    let prefix='';
    const total=session.files.reduce((sum,f)=>sum+(f.elapsedMs??0),0);
    while(true){
      type Item=vscode.QuickPickItem&{folder?:string;id?:string;back?:boolean};
      const folders=new Map<string,{ms:number;count:number}>(),items:Item[]=[];
      const selected=session.files.filter(f=>!prefix||f.path.startsWith(prefix+'/'));
      for(const file of selected){
        const rel=prefix?file.path.slice(prefix.length+1):file.path,slash=rel.indexOf('/');
        if(slash>=0){const name=rel.slice(0,slash),folder=folders.get(name)??{ms:0,count:0};folder.ms+=file.elapsedMs??0;folder.count++;folders.set(name,folder);}
        else items.push({label:`$(${file.status==='ok'?'file-code':'error'}) ${rel}`,description:file.status==='ok'?`${formatDuration(file.elapsedMs??0)} · ${total?((file.elapsedMs??0)/total*100).toFixed(1):'0'}% of capture`:'capture failed',detail:file.error?.split('\n')[0],id:file.id});
      }
      for(const [name,data]of folders)items.push({label:`$(folder) ${name}`,description:`${formatDuration(data.ms)} · ${total?(data.ms/total*100).toFixed(1):'0'}% · ${data.count} files`,folder:prefix?`${prefix}/${name}`:name});
      items.sort((a,b)=>Number(!!b.folder)-Number(!!a.folder)||a.label.localeCompare(b.label));
      if(prefix)items.unshift({label:'$(arrow-left) Parent folder',back:true});
      const item=await vscode.window.showQuickPick(items,{title:`Lean profile · ${prefix||path.basename(session.projectRoot)} · ${session.status}`,placeHolder:'Choose a captured file for source overlays, or enter a folder',matchOnDescription:true});
      if(!item)return;
      if(item.back){prefix=path.posix.dirname(prefix);if(prefix==='.')prefix='';continue;}
      if(item.folder){prefix=item.folder;continue;}
      const file=session.files.find(f=>f.id===item.id)!;
      if(file.status==='error'){void vscode.window.showErrorMessage(file.error?.slice(0,1500)??'File capture failed.');continue;}
      await this.ui.showProfile(await readSessionProfile(session,file.id));return;
    }
  }
  async captureFolder(uri?:vscode.Uri,project=false){
    if(!vscode.workspace.isTrusted){void vscode.window.showWarningMessage('Trust this workspace before profiling its Lean code.');return;}
    if(this.captureState.running){void vscode.window.showInformationMessage('A Lean capture is already running. Cancel it before starting another.');return;}
    if(project){
      const active=vscode.window.activeTextEditor?.document.uri;
      if(active?.scheme==='file')uri=vscode.Uri.file(await findProjectRoot(active.fsPath));
      else {const folders=vscode.workspace.workspaceFolders??[];uri=folders.length===1?folders[0].uri:(await vscode.window.showWorkspaceFolderPick())?.uri;}
    }
    uri??=(await vscode.window.showOpenDialog({canSelectFiles:false,canSelectFolders:true,canSelectMany:false,title:'Choose a Lean folder to profile'}))?.[0];
    if(!uri||uri.scheme!=='file')return;
    const target=uri.fsPath;
    const dirty=vscode.workspace.textDocuments.filter(d=>d.isDirty&&d.uri.scheme==='file'&&d.uri.fsPath.startsWith(target+path.sep));
    if(dirty.length){if(await vscode.window.showInformationMessage(`Save ${dirty.length} edited files in this scope before profiling?`,'Save and Profile')!=='Save and Profile')return;
      if((await Promise.all(dirty.map(d=>d.save()))).some(saved=>!saved))return;}
    if(this.captureState.running){void vscode.window.showInformationMessage('A Lean capture is already running.');return;}
    const controller=new AbortController();this.captureState.running=controller;this.output.clear();
    try{
      const config=vscode.workspace.getConfiguration('leanSourceProfiler',uri);
      const session=await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:`Profiling ${path.basename(target)}`,cancellable:true},async(progress,token)=>{
        const cancel=token.onCancellationRequested(()=>controller.abort());
        try{return await captureSession({target,extensionRoot:this.context.extensionPath,mode:config.get<'compact'|'detailed'>('captureMode','compact'),thresholdMs:config.get<number>('thresholdMs',1),lakePath:config.get<string>('lakePath','lake'),signal:controller.signal,
          onLog:s=>{this.output.append(s);const match=s.match(/^\[(\d+)\/(\d+)\] (.+)/);if(match)progress.report({message:`${match[1]}/${match[2]} ${match[3]}`});},
          onProgress:p=>progress.report({message:`${p.completed}/${p.total} completed`,increment:100/p.total})});}finally{cancel.dispose();}
      });
      this.current=session;await this.context.workspaceState.update('lastSession',session.sessionPath);
      await this.context.workspaceState.update('lastProfile',session.sessionPath);
      this.output.appendLine(`Saved session: ${session.sessionPath}`);
      void vscode.window.showInformationMessage(`Session ${session.status}: ${session.files.filter(f=>f.status==='ok').length}/${session.plannedFileCount} files captured.`, 'Browse Sources','Standalone Viewer').then(action=>{
        if(action==='Browse Sources')return this.selectFile();if(action==='Standalone Viewer')return this.view(session.sessionPath);
      });
      if(session.status==='complete')await this.selectFile();
      return session;
    }finally{this.captureState.running=undefined;}
  }
  async view(file?:string){
    file??=this.current?.sessionPath??this.context.workspaceState.get<string>('lastProfile');
    if(!file)file=(await vscode.window.showOpenDialog({canSelectMany:false,filters:{'Lean profile or session':['json']},title:'Open profile in standalone viewer'}))?.[0].fsPath;
    if(!file)return;
    const viewer=await startViewer(file,{open:true});this.viewers.push(viewer);this.output.appendLine(`Viewer: ${viewer.url}`);
  }
}
