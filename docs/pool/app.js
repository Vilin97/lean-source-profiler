'use strict';
const $=id=>document.getElementById(id);
let root,current,overview,metric='sourceValue',sequence=0;
const loaded=new Map();
const duration=n=>n>=3600000?(n/3600000).toFixed(2)+' h':n>=60000?(n/60000).toFixed(2)+' min':n>=1000?(n/1000).toFixed(2)+' s':n.toFixed(2)+' ms';
const radar=()=>overview?.kind==='radar-benchmark';
const libraryName=()=>overview?.name||overview?.library||'LeanPool';
const recordedName=()=>libraryName()==='LeanPool'?'pool':libraryName();
function formatValue(n){
  if(!radar())return duration(n);
  if(metric==='lines')return n.toLocaleString()+' lines';
  for(const [scale,unit] of [[1e12,'T'],[1e9,'G'],[1e6,'M'],[1e3,'K']])if(n>=scale)return (n/scale).toFixed(2)+' '+unit+' instructions';
  return n.toLocaleString()+' instructions';
}
const weight=n=>n[metric]||0;
function element(tag,text,className){const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;return el;}
async function api(route){
  const request=new URL(route,'https://snapshot.invalid/');
  const asset=request.pathname==='/overview'?'data/overview.json.gz':request.pathname==='/file'&&/^\d+$/.test(request.searchParams.get('id')||'')?'data/files/'+request.searchParams.get('id')+'.json.gz':null;
  if(!asset)throw Error('Unknown snapshot request');
  const response=await fetch(new URL(asset,location.href),{cache:'no-store'});
  if(!response.ok)throw Error('Could not load '+asset+' ('+response.status+')');
  if(typeof DecompressionStream==='undefined')throw Error('Please use a current browser to open this compressed recording.');
  const decompressed=response.body.pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(decompressed).text());
}
function attach(parent,child){child.parent=parent;parent.children.push(child);return child;}
function buildTree(data){
  if(radar())return buildRadarTree(data);
  const pool={name:libraryName(),kind:'pool',children:[],value:0,sourceValue:0};
  const projects=new Map();
  for(const item of data.inventory){const project=attach(pool,{name:item.name,kind:'project',children:[],value:0,sourceValue:0,planned:item.files,lines:item.lines,completed:0});projects.set(item.name,project);}
  for(const [path,file] of Object.entries(data.files)){
    const fullPieces=path.split('/'),pieces=fullPieces.slice(1);
    const group=data.library==='Mathlib'&&fullPieces.length<=2?'Root':pieces[0]?.replace(/\.lean$/,'');
    const project=projects.get(group);if(!project)throw Error('Unknown inventory group for '+path);
    project.completed++;let parent=project;
    for(const folder of pieces.slice(1,-1)){let next=parent.children.find(n=>n.kind==='folder'&&n.name===folder);if(!next)next=attach(parent,{name:folder,kind:'folder',children:[],value:0,sourceValue:0});parent=next;}
    const leaf=attach(parent,{...file,name:fullPieces.at(-1),kind:'file',path,children:[],loaded:false});
    for(let ancestor=parent;ancestor;ancestor=ancestor.parent){ancestor.value+=leaf.value;ancestor.sourceValue+=leaf.sourceValue;}
  }
  return pool;
}
function buildRadarTree(data){
  const library={name:data.name,kind:'pool',children:[],instructions:0,lines:0,fileCount:0};
  for(const [path,file] of Object.entries(data.files)){
    const pieces=path.split('/');let parent=library;
    for(const folder of pieces.slice(1,-1)){
      let next=parent.children.find(n=>n.kind==='folder'&&n.name===folder);
      if(!next)next=attach(parent,{name:folder,kind:'folder',children:[],instructions:0,lines:0,fileCount:0});
      parent=next;
    }
    attach(parent,{...file,name:pieces.at(-1),kind:'file',path,children:[],loaded:true});
    for(let ancestor=parent;ancestor;ancestor=ancestor.parent){ancestor.instructions+=file.instructions;ancestor.lines+=file.lines;ancestor.fileCount++;}
  }
  return library;
}
async function loadFile(file){
  if(file.loaded)return;
  let data=loaded.get(file.id);if(!data){data=await api('file?id='+encodeURIComponent(file.id));loaded.set(file.id,data);}
  if(data.path!==file.path)throw Error('The snapshot changed. Reload the snapshot to continue.');
  file.source=data.source;file.children=data.children.map(d=>({...d,parent:file,file,children:d.children.map(line=>({...line,file}))}));
  for(const d of file.children)for(const line of d.children)line.parent=d;
  file.loaded=true;
}
function ancestry(node){const list=[];for(let n=node;n;n=n.parent)list.unshift(n);return list;}
function tip(event,node){const tooltip=$('tooltip');tooltip.textContent=`${node.name}\n${formatValue(weight(node))} · ${root&&weight(root)?(100*weight(node)/weight(root)).toFixed(2):0}% of recorded ${recordedName()}\n${node.kind==='line'?'Attributed to this line’s source anchor':node.kind}`;tooltip.hidden=false;tooltip.style.left=Math.min(event.clientX+12,innerWidth-320)+'px';tooltip.style.top=Math.min(event.clientY+14,innerHeight-110)+'px';}
function drawFlame(){
  const chart=$('flame');chart.replaceChildren();const total=weight(current);let deepest=0;
  function draw(node,left,width,level){
    if(chart.clientWidth*width/100<3||level>6||weight(node)<=0)return;deepest=Math.max(deepest,level);
    const button=element('button',node.name+' · '+formatValue(weight(node)));button.dataset.kind=node.kind;button.setAttribute('aria-label',node.kind+' '+node.name+' '+formatValue(weight(node)));button.style.cssText=`left:${left}%;width:calc(${width}% - 2px);top:${level*36}px`;
    button.onclick=()=>navigate(node);button.onmousemove=e=>tip(e,node);button.onmouseleave=()=>{$('tooltip').hidden=true;};chart.append(button);
    let x=left;for(const child of [...node.children].sort((a,b)=>weight(b)-weight(a))){const w=weight(node)?width*weight(child)/weight(node):0;draw(child,x,w,level+1);x+=w;}
  }
  if(total>0)draw(current,0,100,0);else chart.append(element('p','No measured time at this level yet.'));
  chart.style.height=(deepest+1)*36+'px';$('graph-note').textContent=radar()?'Click a bar to descend through folders to files. Radar measurements stop at files; narrow bars are also listed below.':'Click a bar to descend. Files load declarations and source lines on demand; narrow bars are also listed below.';
}
function renderList(){
  const filter=$('search').value.toLowerCase(),list=$('children');list.replaceChildren();
  const children=[...current.children].filter(n=>n.name.toLowerCase().includes(filter)).sort((a,b)=>weight(b)-weight(a));
  for(const node of children){
    const button=element('button',undefined,'row'),label=element('span',node.name,'label');
    if(node.kind==='project')label.append(element('small',`${node.completed.toLocaleString()} / ${node.planned.toLocaleString()} files · ${node.lines.toLocaleString()} source lines`));
    if(radar()&&node.kind==='folder')label.append(element('small',`${node.fileCount.toLocaleString()} measured files · ${node.lines.toLocaleString()} lines`));
    if(node.kind==='file')label.append(element('small',node.path));
    const time=element('span',node.attributionStatus==='no-separate-timing'?'No separate timing':formatValue(weight(node)),'time');button.append(label,time);button.onclick=()=>navigate(node);list.append(button);
  }
  if(!children.length)list.append(element('p',radar()?'Radar provides whole-file measurements; declarations and individual lines were not timed.':current.kind==='line'?'Selected source line.':current.kind==='project'?'This project is queued for capture.':'No child entries for this selection.','muted'));
  $('children-title').textContent=current.kind==='pool'?(radar()?'Folders and root files':'Projects'):current.kind==='file'?(radar()?'File measurements':'Declarations'):current.kind==='declaration'?'Source lines':'Within '+current.name;
}
function render(){
  $('tooltip').hidden=true;const breadcrumbs=$('breadcrumbs');breadcrumbs.replaceChildren();
  ancestry(current).forEach((node,i)=>{if(i)breadcrumbs.append(element('span','/'));const b=element('button',node.name);b.onclick=()=>navigate(node);breadcrumbs.append(b);});
  $('selection').replaceChildren(element('strong',current.name),element('span',current.attributionStatus==='no-separate-timing'?'No separate timing':`${formatValue(weight(current))} · ${weight(root)?(100*weight(current)/weight(root)).toFixed(2):0}% of recorded ${recordedName()}`));
  drawFlame();renderList();renderDetail();
}
async function navigate(node){const request=++sequence;try{if(node.kind==='file')await loadFile(node);if(request!==sequence)return;current=node;$('search').value='';render();}catch(error){if(request===sequence)showError(error);}}
function findFile(path){
  const pending=[root];while(pending.length){const node=pending.pop();if(node.kind==='file'&&node.path===path)return node;pending.push(...node.children);}
}
async function initialSelection(request){
  const parameters=new URLSearchParams(location.search),path=parameters.get('path');
  if(!path)return;
  const file=findFile(path);if(!file)throw Error('File is absent from this snapshot: '+path);
  if(!radar())await loadFile(file);if(request!==sequence)return;
  let selected=file;const sourceLine=parameters.get('line');
  if(sourceLine!==null&&!radar()){
    const line=Number(sourceLine);
    if(!Number.isInteger(line)||line<1||line>file.source.split(/\r?\n/).length)throw Error('Source line is outside this file');
    const anchor=file.children.flatMap(d=>d.children).find(child=>child.line===line);
    const parent=file.children.find(d=>d.range&&d.range.start.line<=line-1&&d.range.end.line>=line-1)||file;
    selected=anchor||{name:'L'+line,kind:'line',line,value:0,sourceValue:0,children:[],file,parent};
  }
  current=selected;$('search').value='';render();
}
function sourceFile(node){return node.kind==='file'?node:node.file;}
function renderDetail(){
  const detail=$('detail'),file=sourceFile(current);detail.replaceChildren();
  if(radar()){renderRadarDetail(detail,file);return;}
  if(!file){detail.append(element('h2','Recording coverage'),element('p',`${overview.session.files.filter(f=>f.status==='ok').length} successful files of ${overview.session.plannedFileCount}. Captured files retain their declarations, source-line timing anchors and original source headers. All inventory groups remain visible.`));
    for(const f of overview.session.files.filter(f=>f.status==='error'))detail.append(element('p',f.path+': '+f.error,'error'));return;}
  detail.append(element('h2',file.path),element('p',`${duration(file.value)} frontend · ${duration(file.sourceValue)} source-attributed · ${duration(file.captureWallMs||0)} capture wall time`));
  detail.append(element('p',`Internal operation threshold: ${file.thresholdMs ?? 1} ms. Source scopes are retained below this threshold.`));
  if(file.profilingOptions?.maxHeartbeats)detail.append(element('p',`Profiling heartbeat allowance: ${file.profilingOptions.maxHeartbeats.toLocaleString()}. The uninstrumented file passed with its native Lake settings; this extra allowance covers profiling overhead.`));
  if(file.profilingOptions?.['synthInstance.maxHeartbeats'])detail.append(element('p',`Typeclass search allowance during profiling: ${file.profilingOptions['synthInstance.maxHeartbeats'].toLocaleString()}.`));
  if(current.inclusiveMs!==undefined)detail.append(element('p',`Original inclusive declaration timing: ${duration(current.inclusiveMs)}. Inclusive timings may overlap; bar widths use the allocation described above.`));
  if(current.attributionStatus==='no-separate-timing')detail.append(element('p','No elapsed time was attributed separately to this declaration. Its source range is available below.'));
  if(current.kind==='line')detail.append(element('p',`Line ${current.line}: ${duration(current.value)} attributed to events starting here. Multiline expressions are anchored at their first line.`));
  const lines=file.source.split(/\r?\n/),timings=new Map();
  for(const d of file.children)for(const l of d.children||[])timings.set(l.line,(timings.get(l.line)||0)+l.value);
  const code=element('div',undefined,'source');code.setAttribute('aria-label','Lean source snapshot');
  lines.forEach((text,i)=>{const measured=timings.get(i+1)||0,b=element('button',undefined,'code-line'+(measured?' measured':'')+(current.line===i+1?' selected':''));
    b.append(element('span',String(i+1),'number'),element('span',measured?duration(measured):'—','timing'),element('span',text));
    b.onclick=()=>{const d=file.children.find(d=>d.children?.some(l=>l.line===i+1)),l=d?.children.find(l=>l.line===i+1);if(l)navigate(l);else navigate({name:'L'+(i+1)+'  '+text.trim(),kind:'line',line:i+1,value:0,sourceValue:0,children:[],file,parent:file.children.find(d=>d.range&&d.range.start.line<=i&&d.range.end.line>=i)||file});};code.append(b);
  });detail.append(code);
  if(current.line||current.range){const line=current.line||current.range.start.line+1;requestAnimationFrame(()=>{const selected=code.children[line-1];if(!selected||!code.isConnected)return;const row=selected.getBoundingClientRect(),frame=code.getBoundingClientRect();code.scrollTop=Math.max(0,code.scrollTop+row.top-frame.top-3*row.height);});}
  const operationBox=element('div');operationBox.id='operations';detail.append(operationBox);
  if(current.kind==='line')operations(file,current.line);
}
function renderRadarDetail(detail,file){
  const selected=file||current;
  detail.append(element('h2',file?file.path:'Benchmark coverage'));
  detail.append(element('p',`${selected.instructions.toLocaleString()} CPU instructions · ${selected.lines.toLocaleString()} source lines${file?'':` · ${selected.fileCount.toLocaleString()} measured files`}`));
  if(file&&file.lines)detail.append(element('p',Math.round(file.instructions/file.lines).toLocaleString()+' instructions per source line (a whole-file average).'));
  detail.append(element('p','CPU instructions are hardware performance-counter measurements of the file compilation. They are distinct from Lean heartbeats and from source-attributed wall time. Folder widths sum their files; dependency builds and whole-build aggregate metrics are excluded.'));
  detail.append(element('p','Radar does not provide declaration or source-line measurements in this dataset. Obtaining that detail would require a separate source-profile capture.'));
  if(file){const source=element('a','Open this file at the measured Mathlib commit');source.href=file.sourceUrl;detail.append(source);}
  const benchmark=element('p'),link=element('a','Open original Radar benchmark');link.href=overview.radarUrl;benchmark.append(link);detail.append(benchmark);
  detail.append(element('p',`Coverage verified against the Git source inventory: ${Object.keys(overview.files).length.toLocaleString()} / ${Object.keys(overview.files).length.toLocaleString()} files, including Mathlib.lean. The benchmark finished successfully.`));
}
function operations(file,line){
  const target=$('operations');if(!target)return;
  const value=file.children.flatMap(d=>d.children||[]).filter(n=>n.line===line).reduce((total,n)=>total+n.sourceValue,0);
  target.replaceChildren(element('h2','Source line '+line),element('p',value?duration(value)+' of elapsed time is attributed to events anchored at this line.':'No elapsed time was attributed separately to this source line.'),element('p','Multiline operations are anchored at their first line. The complete internal operation traces are retained in the local recording; this public snapshot contains all source-level timings.'));
}
function showError(error){$('progress').textContent='Could not load recording: '+error.message;$('progress').className='error';}
async function refresh(){
  const request=++sequence;
  try{const data=await api('overview');if(request!==sequence)return;loaded.clear();overview=data;
    if(radar()){
      const previous=metric;$('metric').replaceChildren(...[['instructions','CPU instructions'],['lines','Source line count']].map(([value,label])=>{const option=element('option',label);option.value=value;return option;}));
      metric=['instructions','lines'].includes(previous)?previous:'instructions';$('metric').value=metric;
      root=buildTree(overview);current=root;
      $('progress').textContent=`${Object.keys(overview.files).length.toLocaleString()} files measured · successful Radar benchmark · ${new Date(overview.capturedAt).toLocaleString()}`;$('progress').className='';
      $('provenance').textContent=`Mathlib ${overview.commit} · ${overview.leanVersion} · Radar ${overview.run.runner} · Snapshot of whole-file instruction counts and line counts. No declaration or line timings.`;
      render();await initialSelection(request);return;
    }
    root=buildTree(overview);current=root;
    const s=overview.session,ok=s.files.filter(f=>f.status==='ok').length,bad=s.files.filter(f=>f.status==='error').length;
    $('progress').textContent=`${ok.toLocaleString()} / ${s.plannedFileCount.toLocaleString()} files captured · ${bad} failures · ${s.status} · updated ${new Date(s.completedAt).toLocaleString()}`;$('progress').className='';
    $('provenance').textContent=`${libraryName()} ${overview.commit} · lean-source-profiler ${overview.profilerCommit} · Lean ${s.leanVersions?.join(', ')} · Timings include profiler overhead. Isolated files reload imports; totals are not a parallel build duration.`;
    render();await initialSelection(request);
  }catch(error){if(request===sequence)showError(error);}
}
$('metric').onchange=()=>{metric=$('metric').value;if(current)render();};$('search').oninput=renderList;$('refresh').onclick=refresh;
new ResizeObserver(()=>{if(current)drawFlame();}).observe($('flame'));
refresh();
