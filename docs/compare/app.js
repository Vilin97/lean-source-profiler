'use strict';
const $=id=>document.getElementById(id),node=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
let manifest,dataset,rows=[],visible=[],selected,points,sequence=0;
const cache=new Map();
const number=(value,digits=2)=>value.toLocaleString(undefined,{maximumFractionDigits:digits});
const formatTime=value=>number(value/1000)+' s';
const wallKey=()=>dataset.wallKey;
const ours=()=>$('ours').value;
const reference=()=>$('reference').value==='instructions'?'instructions':wallKey();
const isInstructions=()=>$('reference').value==='instructions';
const referenceLabel=()=>isInstructions()?'Radar instructions':'Radar compilation wall time';
const ourLabel=()=>ours()==='frontendMs'?'Our frontend time':'Our source-attributed time';
const referenceFormat=value=>isInstructions()?number(value/1e9)+' G instructions':formatTime(value);
const link=(title,url)=>{const a=node('a',title);a.href=url;return a;};
async function read(path){
 const response=await fetch(new URL(path,location.href));if(!response.ok)throw Error(path+' returned '+response.status);
 if(!path.endsWith('.gz'))return response.json();
 return JSON.parse(await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).text());
}
function aggregate(files){
 const groups=new Map();for(const row of files){let group=groups.get(row.project);if(!group){group={path:row.project,project:row.project,files:0,frontendMs:0,sourceMs:0,instructions:0,[wallKey()]:0};groups.set(row.project,group);}
  group.files++;for(const key of ['frontendMs','sourceMs','instructions',wallKey()])group[key]+=row[key];}
 return [...groups.values()];
}
function values(){
 const base=$('level').value==='files'?rows:aggregate(rows),totalOurs=d3.sum(base,r=>r[ours()]),totalReference=d3.sum(base,r=>r[reference()]);
 return base.map(row=>({...row,ourShare:totalOurs?row[ours()]/totalOurs:0,referenceShare:totalReference?row[reference()]/totalReference:0}));
}
function renderStats(){
 const oursKey=ours(),referenceKey=reference(),kind=$('level').value==='files'?'fileComparisons':'projectComparisons';
 const stats=dataset.report[kind].find(s=>s.ours===oursKey&&s.reference===referenceKey);
 const correlation=stats.spearman===null?'undefined':number(stats.spearman,3);
 const disagreement=stats.costShareTotalVariationPercent===null?'undefined':number(stats.costShareTotalVariationPercent)+'%';
 $('summary').textContent=`${visible.length.toLocaleString()} matched ${$('level').value==='files'?'files':'groups'} · Rank correlation ${correlation} · Share disagreement ${disagreement}`;
}
function renderTable(){
 const search=$('search').value.toLowerCase();
 const matches=visible.filter(r=>r.path.toLowerCase().includes(search)).sort((a,b)=>Math.abs(b.ourShare-b.referenceShare)-Math.abs(a.ourShare-a.referenceShare));
 $('listed').textContent=`${Math.min(50,matches.length)} of ${matches.length.toLocaleString()} matches`;
 $('our-column').textContent=ourLabel();$('reference-column').textContent=referenceLabel();$('rows').replaceChildren();
 for(const row of matches.slice(0,50)){
  const tr=node('tr'),cell=node('td'),button=node('button',row.path);button.type='button';button.onclick=()=>select(row);cell.append(button);tr.append(cell);
  tr.append(node('td',formatTime(row[ours()])),node('td',referenceFormat(row[reference()])),node('td',number(100*(row.ourShare-row.referenceShare))+' pp'));
  $('rows').append(tr);
 }
}
function select(row){selected=row;renderSelected();draw();}
function renderSelected(){
 const box=$('selected');box.replaceChildren();if(!selected){box.append(node('h2','Inspect a point'),node('p','Select a point, search for a file, or choose a row below.'));return;}
 box.append(node('h2',selected.path),node('p',`${ourLabel()}: ${formatTime(selected[ours()])} · ${referenceLabel()}: ${referenceFormat(selected[reference()])}`));
 box.append(node('p',`Our cost share ${number(selected.ourShare*100)}% · Radar cost share ${number(selected.referenceShare*100)}% · Difference ${number((selected.ourShare-selected.referenceShare)*100)} percentage points`));
 if($('level').value==='files'){
  const source=new URL(dataset.explorer,location.href);source.searchParams.set('path',selected.path);box.append(link('Explore declarations and source lines',source.href));
  box.append(link('Source at the measured commit',dataset.repository+'/blob/'+dataset.commit+'/'+selected.path.split('/').map(encodeURIComponent).join('/')));
 }else box.append(node('p',`${selected.files.toLocaleString()} matched source files in this group.`));
}
function showTooltip(event,row){
 const tip=$('tooltip');tip.textContent=`${row.path}\n${ourLabel()}: ${formatTime(row[ours()])}\n${referenceLabel()}: ${referenceFormat(row[reference()])}`;tip.hidden=false;
 tip.style.left=Math.max(8,Math.min(event.clientX+12,innerWidth-370))+'px';tip.style.top=Math.max(8,Math.min(event.clientY+12,innerHeight-tip.offsetHeight-8))+'px';
}
function draw(){
 if(!dataset||!visible.length)return;
 const element=$('scatter'),svg=d3.select(element);svg.selectAll('*').remove();
 const width=element.clientWidth,height=element.clientHeight,margin={left:68,right:14,top:12,bottom:70};
 const w=width-margin.left-margin.right,h=height-margin.top-margin.bottom;
 const xValue=r=>r[reference()]/(isInstructions()?1e9:1000),yValue=r=>r[ours()]/1000;
 const x=d3.scaleSymlog().constant(isInstructions()?.05:.01).domain([0,d3.max(visible,xValue)*1.1||1]).range([margin.left+4,margin.left+w-4]);
 const y=d3.scaleSymlog().constant(.01).domain([0,d3.max(visible,yValue)*1.1||1]).range([margin.top+h-4,margin.top+4]);
 svg.attr('viewBox',`0 0 ${width} ${height}`);svg.append('title').text(`${visible.length} matched ${$('level').value}; ${ourLabel()} versus ${referenceLabel()}`);
 svg.append('rect').attr('class','frame').attr('x',margin.left).attr('y',margin.top).attr('width',w).attr('height',h);
 svg.append('g').attr('transform',`translate(0,${margin.top+h})`).call(d3.axisBottom(x).tickValues(d3.ticks(0,Math.log10(1+x.domain()[1]/x.constant()),width<500?3:6).map(v=>x.constant()*(10**v-1))).tickFormat(v=>number(v,2)));
 svg.append('g').attr('transform',`translate(${margin.left},0)`).call(d3.axisLeft(y).tickValues(d3.ticks(0,Math.log10(1+y.domain()[1]/y.constant()),5).map(v=>y.constant()*(10**v-1))).tickFormat(v=>number(v,2)));
 svg.append('text').attr('class','axis-title').attr('data-axis','x').attr('x',margin.left+w/2).attr('y',height-12).attr('text-anchor','middle').text(isInstructions()?'Radar instructions (billions)':'Radar compilation wall time (s)');
 svg.append('text').attr('class','axis-title').attr('data-axis','y').attr('transform',`translate(16,${margin.top+h/2}) rotate(-90)`).attr('text-anchor','middle').text(ourLabel()+' (s)');
 const positions=visible.map(row=>({row,x:x(xValue(row)),y:y(yValue(row))}));
 svg.append('g').selectAll('circle').data(positions).join('circle').attr('cx',p=>p.x).attr('cy',p=>p.y).attr('r',p=>selected?.path===p.row.path?5:2.7).attr('class',p=>selected?.path===p.row.path?'selected':null);
 points=d3.quadtree().x(p=>p.x).y(p=>p.y).addAll(positions);
 element.onpointermove=event=>{const p=d3.pointer(event,element),nearest=points.find(p[0],p[1],18);if(nearest)showTooltip(event,nearest.row);else $('tooltip').hidden=true;};
 element.onpointerleave=()=>{$('tooltip').hidden=true;};element.onclick=event=>{const p=d3.pointer(event,element),nearest=points.find(p[0],p[1],24);if(nearest)select(nearest.row);};
 $('axis-note').textContent=`Axes use a symmetric log scale with a linear region near zero. All ${visible.length.toLocaleString()} matched ${$('level').value==='files'?'files':'groups'} remain visible, including zero source times.`;
}
function render(){
 visible=values();if(selected)selected=visible.find(row=>row.path===selected.path);renderStats();renderTable();renderSelected();draw();
}
async function load(){
 const request=++sequence;try{
  const entry=manifest.datasets.find(d=>d.id===$('dataset').value);let data=cache.get(entry.id);if(!data){data=await read(entry.asset);cache.set(entry.id,data);}if(request!==sequence)return;
  dataset=data;rows=data.files;for(const row of rows)for(const key of ['sourceMs','frontendMs','instructions',wallKey()])if(!Number.isFinite(row[key])||row[key]<0)throw Error('Invalid measurement for '+row.path);
  if(new Set(rows.map(r=>r.path)).size!==rows.length)throw Error('Duplicate source rows');
  selected=undefined;$('search').value='';$('incomplete').hidden=dataset.complete;
  $('status').textContent=`${dataset.name} · ${rows.length.toLocaleString()} / ${dataset.expectedFiles.toLocaleString()} files matched · ${dataset.complete?'complete verified coverage':'partial preview'}`;
  $('provenance').textContent=`${dataset.library} ${dataset.commit} · ${dataset.description}`;
  $('links').replaceChildren(link('Source explorer',new URL(dataset.explorer,location.href).href),link('Dataset and methods',dataset.methods),link('Profiler source', 'https://github.com/Vilin97/lean-source-profiler'));
  render();
 }catch(error){$('status').textContent='Could not load comparison: '+error.message;$('status').className='error';}
}
async function main(){manifest=await read('manifest.json');for(const entry of manifest.datasets){const option=node('option',entry.name);option.value=entry.id;$('dataset').append(option);}await load();}
for(const id of ['ours','reference','level'])$(id).onchange=()=>{selected=undefined;render();};$('dataset').onchange=load;$('search').oninput=renderTable;
new ResizeObserver(()=>draw()).observe($('scatter'));
main().catch(error=>{$('status').textContent=error.message;$('status').className='error';});
