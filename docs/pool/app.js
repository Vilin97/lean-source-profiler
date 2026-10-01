'use strict';
const $=id=>document.getElementById(id);
let root,current,overview,metric='sourceValue',sequence=0;
const loaded=new Map();
const duration=n=>n>=3600000?(n/3600000).toFixed(2)+' h':n>=60000?(n/60000).toFixed(2)+' min':n>=1000?(n/1000).toFixed(2)+' s':n.toFixed(2)+' ms';
const weight=n=>n[metric]||0;
function element(tag,text,className){const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;return el;}
async function api(route){
  const request=new URL(route,'https://snapshot.invalid/');
  const asset=request.pathname==='/overview'?'data/overview.json.gz':request.pathname==='/file'&&/^\d+$/.test(request.searchParams.get('id')||'')?'data/files/'+request.searchParams.get('id')+'.json.gz':null;
  if(!asset)throw Error('Unknown snapshot request');
  const response=await fetch(new URL(asset,location.href));
  if(!response.ok)throw Error('Could not load '+asset+' ('+response.status+')');
  if(typeof DecompressionStream==='undefined')throw Error('Please use a current browser to open this compressed recording.');
  const decompressed=response.body.pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(decompressed).text());
}
function attach(parent,child){child.parent=parent;parent.children.push(child);return child;}
function buildTree(data){
  const pool={name:'LeanPool',kind:'pool',children:[],value:0,sourceValue:0};
  const projects=new Map();
  for(const item of data.inventory){const project=attach(pool,{name:item.name,kind:'project',children:[],value:0,sourceValue:0,planned:item.files,lines:item.lines,completed:0});projects.set(item.name,project);}
  for(const [path,file] of Object.entries(data.files)){
    const pieces=path.split('/').slice(1),project=projects.get(pieces[0].replace(/\.lean$/,''));if(!project)continue;
    project.completed++;let parent=project;
    for(const folder of pieces.slice(1,-1)){let next=parent.children.find(n=>n.kind==='folder'&&n.name===folder);if(!next)next=attach(parent,{name:folder,kind:'folder',children:[],value:0,sourceValue:0});parent=next;}
    const leaf=attach(parent,{...file,name:pieces.at(-1),kind:'file',path,children:[],loaded:false});
    for(let ancestor=parent;ancestor;ancestor=ancestor.parent){ancestor.value+=leaf.value;ancestor.sourceValue+=leaf.sourceValue;}
  }
  return pool;
}
async function loadFile(file){
  if(file.loaded)return;
  let data=loaded.get(file.id);if(!data){data=await api('file?id='+encodeURIComponent(file.id));loaded.set(file.id,data);}
  file.source=data.source;file.children=data.children.map(d=>({...d,parent:file,file,children:d.children.map(line=>({...line,file}))}));
  for(const d of file.children)for(const line of d.children)line.parent=d;
  file.loaded=true;
}
function ancestry(node){const list=[];for(let n=node;n;n=n.parent)list.unshift(n);return list;}
function tip(event,node){const tooltip=$('tooltip');tooltip.textContent=`${node.name}\n${duration(weight(node))} · ${root&&weight(root)?(100*weight(node)/weight(root)).toFixed(2):0}% of recorded pool\n${node.kind==='line'?'Attributed to this line’s source anchor':node.kind}`;tooltip.hidden=false;tooltip.style.left=Math.min(event.clientX+12,innerWidth-320)+'px';tooltip.style.top=Math.min(event.clientY+14,innerHeight-110)+'px';}
function drawFlame(){
  const chart=$('flame');chart.replaceChildren();const total=weight(current);let deepest=0;
  function draw(node,left,width,level){
    if(chart.clientWidth*width/100<3||level>6||weight(node)<=0)return;deepest=Math.max(deepest,level);
    const button=element('button',node.name+' · '+duration(weight(node)));button.dataset.kind=node.kind;button.setAttribute('aria-label',node.kind+' '+node.name+' '+duration(weight(node)));button.style.cssText=`left:${left}%;width:calc(${width}% - 2px);top:${level*36}px`;
    button.onclick=()=>navigate(node);button.onmousemove=e=>tip(e,node);button.onmouseleave=()=>{$('tooltip').hidden=true;};chart.append(button);
    let x=left;for(const child of [...node.children].sort((a,b)=>weight(b)-weight(a))){const w=weight(node)?width*weight(child)/weight(node):0;draw(child,x,w,level+1);x+=w;}
  }
  if(total>0)draw(current,0,100,0);else chart.append(element('p','No measured time at this level yet.'));
  chart.style.height=(deepest+1)*36+'px';$('graph-note').textContent='Click a bar to descend. Files load declarations and source lines on demand; narrow bars are also listed below.';
}
function renderList(){
  const filter=$('search').value.toLowerCase(),list=$('children');list.replaceChildren();
  const children=[...current.children].filter(n=>n.name.toLowerCase().includes(filter)).sort((a,b)=>weight(b)-weight(a));
  for(const node of children){
    const button=element('button',undefined,'row'),label=element('span',node.name,'label');
    if(node.kind==='project')label.append(element('small',`${node.completed.toLocaleString()} / ${node.planned.toLocaleString()} files · ${node.lines.toLocaleString()} source lines`));
    if(node.kind==='file')label.append(element('small',node.path));
    const time=element('span',node.attributionStatus==='no-separate-timing'?'No separate timing':duration(weight(node)),'time');button.append(label,time);button.onclick=()=>navigate(node);list.append(button);
  }
  if(!children.length)list.append(element('p',current.kind==='line'?'Selected source line.':current.kind==='project'?'This project is queued for capture.':'No child entries for this selection.','muted'));
  $('children-title').textContent=current.kind==='pool'?'Projects':current.kind==='file'?'Declarations':current.kind==='declaration'?'Source lines':'Within '+current.name;
}
function render(){
  $('tooltip').hidden=true;const breadcrumbs=$('breadcrumbs');breadcrumbs.replaceChildren();
  ancestry(current).forEach((node,i)=>{if(i)breadcrumbs.append(element('span','/'));const b=element('button',node.name);b.onclick=()=>navigate(node);breadcrumbs.append(b);});
  $('selection').replaceChildren(element('strong',current.name),element('span',current.attributionStatus==='no-separate-timing'?'No separate timing':`${duration(weight(current))} · ${weight(root)?(100*weight(current)/weight(root)).toFixed(2):0}% of recorded pool`));
  drawFlame();renderList();renderDetail();
}
async function navigate(node){const request=++sequence;try{if(node.kind==='file')await loadFile(node);if(request!==sequence)return;current=node;$('search').value='';render();}catch(error){if(request===sequence)showError(error);}}
function sourceFile(node){return node.kind==='file'?node:node.file;}
function renderDetail(){
  const detail=$('detail'),file=sourceFile(current);detail.replaceChildren();
  if(!file){detail.append(element('h2','Recording coverage'),element('p',`${overview.session.files.filter(f=>f.status==='ok').length} successful files of ${overview.session.plannedFileCount}. All inventoried projects, folders, files, declarations and source-line timing anchors are included. Source snapshots retain their original headers and attribution.`));
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
function operations(file,line){
  const target=$('operations');if(!target)return;
  const value=file.children.flatMap(d=>d.children||[]).filter(n=>n.line===line).reduce((total,n)=>total+n.sourceValue,0);
  target.replaceChildren(element('h2','Source line '+line),element('p',value?duration(value)+' of elapsed time is attributed to events anchored at this line.':'No elapsed time was attributed separately to this source line.'),element('p','Multiline operations are anchored at their first line. The complete internal operation traces are retained in the local recording; this public snapshot contains all source-level timings.'));
}
function showError(error){$('progress').textContent='Could not load recording: '+error.message;$('progress').className='error';}
async function refresh(){
  const request=++sequence;
  try{const data=await api('overview');if(request!==sequence)return;overview=data;root=buildTree(overview);current=root;
    const s=overview.session,ok=s.files.filter(f=>f.status==='ok').length,bad=s.files.filter(f=>f.status==='error').length;
    $('progress').textContent=`${ok.toLocaleString()} / ${s.plannedFileCount.toLocaleString()} files captured · ${bad} failures · ${s.status} · updated ${new Date(s.completedAt).toLocaleString()}`;$('progress').className='';
    $('provenance').textContent=`LeanPool ${overview.commit} · lean-source-profiler ${overview.profilerCommit} · Lean ${s.leanVersions?.join(', ')} · Timings include profiler overhead. Isolated files reload imports; totals are not a parallel build duration.`;
    render();
  }catch(error){if(request===sequence)showError(error);}
}
$('metric').onchange=()=>{metric=$('metric').value;if(current)render();};$('search').oninput=renderList;$('refresh').onclick=refresh;
new ResizeObserver(()=>{if(current)drawFlame();}).observe($('flame'));
refresh();
