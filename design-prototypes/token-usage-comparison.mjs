import { ResultAsync } from 'neverthrow';
import { mountChart } from '../apps/web/src/lib/chart-render.ts';
import { seriesStyles } from '../apps/web/src/lib/chart-spec.ts';
const iconPaths={
 bars:'M2 13h12M3 11V8h2v3M7 11V3h2v8M11 11V5h2v6',
 trend:'M2 3v10h12M4 10l3-4 3 2 3-5',
 gauge:'M2 12a6 6 0 1 1 12 0M8 10l3-4M8 11h.01',
 layers:'M8 2l6 3-6 3-6-3zM2 8l6 3 6-3M2 11l6 3 6-3',
 sum:'M12 3H4l4 5-4 5h8'
};
const iconNames={bars:'Bars',trend:'Trend',gauge:'Gauge',layers:'Layers',sum:'Sum'};
const modelNames={'gpt-6-astra':'Astra','gpt-6.1-sol':'Sol','gpt-5.6-terra':'Terra','gpt-6-luna':'Luna'};
const useNames={root:'Root',subagent:'Subagent',compaction:'Compaction',turn_summary:'Turn summary',headline:'Headline',orb_name:'Orb name'};
const tokenNames={input:'Uncached input',cache_read:'Cache read',cache_write:'Cache write',output:'Output'};
const HOUR=3600000,DAY=24*HOUR,end=Date.UTC(2026,9,13,17);
const orbs={
 '7816fba1':{name:'Token usage display',project:'pi-orb'},
 '026e91c3':{name:'Provider cache audit',project:'pi-orb'},
 'f479d46a':{name:'Runtime handshake',project:'pi-orb'},
 '8204c89b':{name:'Editor navigation',project:'editor'},
 'bb2e1381':{name:'Compiler recovery',project:'compiler'},
 '63ea624b':{name:'Workspace uploads',project:'pi-orb'}
};
const ledger=[];
const useKeys=Object.keys(useNames),modelKeys=Object.keys(modelNames),orbKeys=Object.keys(orbs);
for(let d=0;d<184;d++)for(let j=0;j<6;j++){
 const use=useKeys[j],id=ledger.length+1,scale=1+.4*Math.sin(d*.16+j)+.2*Math.cos(d*.43);
 const presentation=j>2,input=Math.round((presentation?180+j*30:6000+j*1200)*scale*(1+(d%23===0?1.3:0)));
 ledger.push({id,at:end-d*DAY-(j*3+1)*HOUR,orb_id:id%31===0?'deleted-729a':orbKeys[(d+j)%6],use,provider:'openai-codex',model:presentation?modelKeys[3]:j===0?modelKeys[0]:d%4===0?modelKeys[2]:modelKeys[1],input,output:Math.round((presentation?60+j*8:700+j*200)*scale),cache_read:presentation?0:input*(d%23===0?1:9),cache_write:0,outcome:id%37===0?'error':'stop'});
}
let icon='bars',period='week',breakdown='use',ranking='total',displayOpen=true,epoch=0,mounted=[],coverageOpener=null;
const shell=document.getElementById('shell'),dialog=document.querySelector('dialog');
const dateFmt=new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',month:'short',day:'numeric'});
const clockFmt=new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',hour:'numeric',minute:'2-digit'});
function fmt(n){return n>=1e6?(n/1e6).toFixed(2)+'M':n>=1000?(n/1000).toFixed(1)+'k':String(n)}
function exact(n){return n.toLocaleString('en-US')}
function aggregate(rows){const a={input:0,output:0,cache_read:0,cache_write:0,calls:rows.length};for(const r of rows)for(const k of Object.keys(tokenNames))a[k]+=r[k];a.total=a.input+a.output+a.cache_read+a.cache_write;const p=a.input+a.cache_read+a.cache_write;a.share=p?a.cache_read/p:0;return a}
function startTime(){if(period==='day')return end-DAY;if(period==='week')return end-7*DAY;const d=new Date(end);d.setUTCMonth(d.getUTCMonth()-(period==='month'?1:6));return d.getTime()}
function groups(rows,key){const g={};for(const r of rows)(g[r[key]]??=[]).push(r);return Object.entries(g).map(([key,rs])=>({key,name:key==='deleted-729a'?'Deleted orb · 729a':key in orbs?orbs[key].name:useNames[key],value:ranking==='total'?aggregate(rs).total:aggregate(rs)[ranking]})).sort((a,b)=>b.value-a.value)}
function state(){
 const start=startTime(),rows=ledger.filter(r=>r.at>=start&&r.at<end).sort((a,b)=>a.at-b.at);
 const series=breakdown==='tokens'?Object.keys(tokenNames).map(key=>({key,name:tokenNames[key]})):breakdown==='use'?useKeys.map(key=>({key,name:useNames[key]})):modelKeys.map(key=>({key,name:modelNames[key]}));
 const interval=period==='day'?HOUR/4:period==='week'?HOUR:period==='month'?6*HOUR:DAY,buckets=[];
 for(let at=start;at<end;at+=interval){const until=Math.min(at+interval,end),rs=rows.filter(r=>r.at>=at&&r.at<until);buckets.push({at,until,values:series.map(s=>breakdown==='tokens'?aggregate(rs)[s.key]:aggregate(rs.filter(r=>r[breakdown]===s.key)).total)})}
 return {start,end,rows,series,buckets,summary:aggregate(rows),orbs:groups(rows,'orb_id'),uses:groups(rows,'use')};
}

function svgIcon(name,extra=''){return '<svg class="ic '+extra+'" viewBox="0 0 16 16" aria-hidden="true" data-selected-icon="'+name+'"><path d="'+iconPaths[name]+'"/></svg>'}
function chartState(){
 const s=state();
 const spec={kind:'line',title:'Consumption over time',unit:'tokens',series:s.series.map((series,i)=>({name:series.name,points:s.buckets.map(b=>[b.at,b.values[i]])}))};
 const xAxis={ticks:s.buckets.map(b=>b.at),labelEvery:Math.ceil(s.buckets.length/(innerWidth<600?3:8)),format:period==='day'?'%H:%M':period==='week'?'%a %H:%M':'%b %d'};
 return {...s,spec,xAxis};
}
window.usageStudy={state:chartState};
function cleanup(){epoch++;for(const c of mounted)c.finalize();mounted=[];}
function summaryHTML(a){return '<section class="summary" aria-label="Period summary">'+[['total','All tokens'],['input','Uncached input'],['output','Output'],['share','Prompt cache share'],['calls','Recorded calls']].map(([k,name])=>'<div class="summary-item"><div class="value" data-summary="'+k+'" data-value="'+a[k]+'" title="'+(k==='share'?(a[k]*100).toFixed(3)+'%':exact(a[k]))+'">'+(k==='share'?(a[k]*100).toFixed(1)+'%':fmt(a[k]))+'</div><div class="summary-name">'+name+'</div></div>').join('')+'</section>';}
function phoneKey(spec){
 const styles=seriesStyles(spec.series.length);
 return '<div class="chart-key">'+spec.series.map((s,i)=>'<span data-series="'+s.name+'" tabindex="0"><svg width="14" height="2" aria-hidden="true"><line x1="0" y1="1" x2="14" y2="1" stroke="'+styles.colors[i]+'" stroke-width="2" stroke-dasharray="'+styles.dash[i].join(' ')+'"/></svg>'+s.name+'</span>').join('')+'</div>';
}
function updateHighlight(name){
 const key=shell.querySelector('.chart-key');
 if(key){key.toggleAttribute('data-highlighted',name!==null);key.querySelectorAll('[data-series]').forEach(n=>n.toggleAttribute('data-on',n.dataset.series===name));}
}
async function draw(target,spec,options,myEpoch){
 const host=document.createElement('div');target.append(host);
 const started=performance.now();
 const result=await mountChart(host,spec,{narrow:innerWidth<600,height:300,onHighlight:updateHighlight,...options});
 return result.match(c=>{
  if(myEpoch!==epoch){c.finalize();host.remove();return null;}
  mounted.push(c);
  console.debug('chart render',{scope:'usage-study',title:spec.title,outcome:'rendered',ms:Math.round(performance.now()-started)});
  return c;
 },failure=>{
  if(myEpoch===epoch){target.textContent='Chart failed: '+failure.message;target.classList.add('chart-error');}
  console.debug('chart render',{scope:'usage-study',title:spec.title,outcome:'failed',message:failure.message});
  return null;
 });
}
function renderDisplay(){
 cleanup();const myEpoch=epoch,s=chartState(),step=period==='day'?'15 minutes':period==='week'?'Hourly':period==='month'?'6 hours':'Daily';
 const opt=(k,name,current)=>'<option value="'+k+'" '+(k===current?'selected':'')+'>'+name+'</option>';
 shell.innerHTML='<article data-ready="false"><div class="header"><button class="icon-button" data-back aria-label="Back to dashboard"><svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5"/></svg></button><h2>Usage</h2></div><div class="toolbar"><div class="periods" aria-label="Time period">'+[['day','Last day'],['week','Week'],['month','Month'],['6months','6 months']].map(([k,name])=>'<button data-period="'+k+'" aria-pressed="'+(k===period)+'" class="'+(k===period?'active':'')+'">'+name+'</button>').join('')+'</div><label>Breakdown <select data-breakdown aria-label="Series breakdown">'+opt('tokens','Token kind',breakdown)+opt('use','Use',breakdown)+opt('model','Model',breakdown)+'</select></label></div><div class="range"><span>'+dateFmt.format(s.start)+' '+clockFmt.format(s.start)+' → '+dateFmt.format(end)+' '+clockFmt.format(end)+' · Pacific</span><button data-coverage>Recorded Pi + Luna ⓘ</button></div><div class="content"><div class="upper">'+summaryHTML(s.summary)+'<section class="section"><div class="section-head"><h3>Consumption over time</h3><span class="muted">'+step+' · '+s.buckets.length+' points</span></div>'+(innerWidth<600?phoneKey(s.spec):'')+'<div class="chart-canvas" data-timeline></div></section></div><div class="rank-control"><h3>Rankings</h3><label>Measure <select data-ranking aria-label="Ranking measure">'+opt('total','All tokens',ranking)+opt('input','Uncached input',ranking)+opt('output','Output',ranking)+'</select></label></div><div class="rankings"><section class="section"><div class="section-head"><h3>Top orbs</h3><span class="muted">Top 5</span></div><div class="chart-canvas" data-orbs></div></section><section class="section"><div class="section-head"><h3>Use</h3></div><div class="chart-canvas" data-uses></div></section></div></div><footer class="footer">pi-orb</footer></article>';
 shell.querySelector('[data-back]').onclick=()=>{displayOpen=false;dashboard();shell.querySelector('[data-access]').focus()};
 shell.querySelectorAll('[data-period]').forEach(b=>b.onclick=()=>{period=b.dataset.period;renderDisplay();shell.querySelector('[data-period="'+period+'"]').focus()});
 for(const [selector,update] of [['[data-breakdown]',v=>breakdown=v],['[data-ranking]',v=>ranking=v]]){shell.querySelector(selector).onchange=e=>{update(e.target.value);renderDisplay();shell.querySelector(selector).focus()};}
 shell.querySelector('[data-coverage]').onclick=e=>{coverageOpener=e.currentTarget;dialog.showModal()};
 const barSpec=(rows,title)=>({kind:'bar',title,unit:'tokens',bars:rows.map(g=>({label:g.name,value:g.value}))});
 const timeline=shell.querySelector('[data-timeline]'),orbChart=shell.querySelector('[data-orbs]'),useChart=shell.querySelector('[data-uses]');
 const tasks=[draw(timeline,s.spec,{xAxis:s.xAxis},myEpoch),draw(orbChart,barSpec(s.orbs.slice(0,5),'Top orbs'),{},myEpoch),draw(useChart,barSpec(s.uses,'Use'),{},myEpoch)];
 void Promise.all(tasks).then(([line,...bars])=>{
  if(myEpoch!==epoch)return;
  if(line!==null){shell.querySelectorAll('.chart-key [data-series]').forEach(n=>{n.onpointerenter=n.onfocus=()=>line.highlight(n.dataset.series);n.onpointerleave=n.onblur=()=>line.highlight(null);});}
  shell.querySelector('[data-ready]').dataset.ready=String(line!==null&&bars.every(c=>c!==null));
 });
}
function dashboard(){
 cleanup();shell.innerHTML='<div data-dashboard><div class="dashboard-totals">'+[[3,'projects'],[6,'orbs'],[4,'busy'],[0,'failed']].map(([n,t])=>'<div class="dashboard-total"><b>'+n+'</b><span>'+t+'</span></div>').join('')+'<div class="header-actions"><button class="icon-button" data-access aria-label="Usage" title="Usage">'+svgIcon(icon)+'</button><button class="icon-button" aria-label="Settings" disabled>⚙</button></div></div><div class="board">'+['pi-orb','editor','compiler'].map(p=>'<section class="column"><div class="project-head"><h2>'+p+'</h2><p class="muted">schani/'+p+'</p></div>'+Object.entries(orbs).filter(([id,o])=>o.project===p).map(([id,o])=>'<div class="orb">'+o.name+'<p>'+id+' · 2h</p></div>').join('')+'</section>').join('')+'</div><footer class="footer">pi-orb · central durable · gce</footer></div>';
 shell.querySelector('[data-access]').onclick=()=>{displayOpen=true;renderDisplay()};
}
function closeCoverage(){dialog.close();coverageOpener?.focus()}
document.querySelector('.dialog-close').onclick=closeCoverage;dialog.addEventListener('cancel',e=>{e.preventDefault();closeCoverage()});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!dialog.open&&displayOpen){e.preventDefault();displayOpen=false;dashboard();shell.querySelector('[data-access]').focus()}});
document.querySelector('.icons').innerHTML=Object.keys(iconPaths).map(k=>'<button data-icon="'+k+'">'+svgIcon(k)+iconNames[k]+'</button>').join('');
function chooseIcon(k){icon=k;document.querySelectorAll('[data-icon]').forEach(b=>{b.classList.toggle('active',b.dataset.icon===icon);b.setAttribute('aria-pressed',String(b.dataset.icon===icon))});if(!displayOpen)dashboard();}
document.querySelectorAll('[data-icon]').forEach(b=>b.onclick=()=>chooseIcon(b.dataset.icon));chooseIcon('bars');
let lastWidth=innerWidth;window.addEventListener('resize',()=>{if(lastWidth!==innerWidth){lastWidth=innerWidth;if(displayOpen)renderDisplay()}});
void ResultAsync.fromPromise(document.fonts.load('11px "JetBrains Mono"'),cause=>({type:'font_load_failed',message:String(cause)})).match(renderDisplay,failure=>{shell.textContent='Chart font failed: '+failure.message;});
