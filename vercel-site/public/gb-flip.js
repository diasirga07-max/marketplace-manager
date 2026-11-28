(()=>{
'use strict';
// GRANTS BOOK · Flip (Flip.kz): заказы, продажи, динамика. Только отображение:
// все запросы к Flip — на сервере (/api/data?module=flip). Ключ Flip в браузер не попадает.
if(window.GB_FLIP_LOADED)return;
window.GB_FLIP_LOADED=true;

const API='/api/data';
const TABS=[['orders','Заказы'],['sales','Продажи'],['dynamics','Динамика']];
const SALES_PRESETS=[['today','Сегодня'],['7d','7 дней'],['30d','30 дней'],['custom','Свой период']];
const DYN_PRESETS=[['7d','7 дней'],['30d','30 дней'],['90d','90 дней'],['custom','Свой период']];
const GRAINS=[['day','Дни'],['week','Недели'],['month','Месяцы']];
const SOURCES=[['flip','Flip'],['kaspi','Kaspi'],['both','Вместе']];
const C={flip:'#2a78d6',kaspi:'#eb6834',grid:'#eaecf0',axis:'#667085'};
const VIEWED_KEY='gb_flip_orders_viewed_at';
const BADGE_MS=5*60000;

const state={open:false,tab:'orders',overflow:'',
  orders:null,ordersLoading:false,prevViewed:0,
  sales:{preset:'7d',from:'',to:'',page:1,data:null,loading:false},
  dyn:{preset:'30d',from:'',to:'',grain:'day',source:'flip',flip:null,kaspi:null,kaspiKey:'',loading:false,seq:0,backfill:false}};

// ---------- utils ----------
const $=(sel,root=document)=>root.querySelector(sel);
const esc=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const nf0=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0});
const isNum=v=>typeof v==='number'&&Number.isFinite(v);
const money=v=>isNum(v)?nf0.format(Math.round(v))+' ₸':'—';
const count=v=>isNum(v)?nf0.format(Math.round(v)):'—';
const ddmmyyyy=iso=>{const m=String(iso||'').match(/^(\d{4})-(\d{2})-(\d{2})/);return m?`${m[3]}.${m[2]}.${m[1]}`:String(iso||'')};
const fmtTime=ms=>ms?new Date(ms).toLocaleString('ru-RU',{timeZone:'Asia/Almaty',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}):'—';
function almatyToday(){const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Almaty',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));return `${p.year}-${p.month}-${p.day}`}
function addDays(iso,n){const d=new Date(iso+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)}
function weekStart(iso){const d=new Date(iso+'T12:00:00Z');return addDays(iso,-((d.getUTCDay()+6)%7))}
function plural(n,a,b,c){const x=Math.abs(n)%100,y=x%10;if(x>10&&x<20)return c;if(y>1&&y<5)return b;if(y===1)return a;return c}
function lsGet(k){try{return localStorage.getItem(k)||''}catch{return ''}}
function lsSet(k,v){try{localStorage.setItem(k,String(v))}catch{}}

async function api(module,op,params={},options={}){
  const q=new URLSearchParams({module,op});
  for(const [k,v] of Object.entries(params))if(v!==''&&v!=null)q.set(k,v);
  const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),options.timeout||290000);
  try{
    const r=await fetch(API+'?'+q.toString(),{method:options.body?'POST':'GET',headers:options.body?{'Content-Type':'application/json'}:{},body:options.body?JSON.stringify(options.body):undefined,cache:'no-store',signal:ctrl.signal});
    let json={};try{json=await r.json()}catch{throw new Error(`Сервер вернул HTTP ${r.status} без данных`)}
    if(!r.ok||json.ok===false){if(r.status===401&&json.code==='access_required')throw new Error('Нужен код доступа GRANTS BOOK');throw new Error(json.error||`HTTP ${r.status}`)}
    return json;
  }catch(e){if(e.name==='AbortError')throw new Error('Сервер не ответил вовремя. Попробуйте ещё раз.');throw e}
  finally{clearTimeout(timer)}
}
const flip=(op,params,options)=>api('flip',op,params,options);

// ---------- styles & skeleton ----------
function addStyle(){
  if($('#gbFlipStyle'))return;
  const st=document.createElement('style');st.id='gbFlipStyle';st.textContent=`
#gbFlip{--bg:#f5f7fa;--card:#fff;--line:#e4e7ec;--ink:#101828;--muted:#667085;--soft:#f2f4f7;--accent:#2a78d6;position:fixed;inset:58px 0 0;z-index:2147483250;background:var(--bg);display:none;flex-direction:column;font-family:Inter,Arial,sans-serif;color:var(--ink);overflow:auto}
#gbFlip *{box-sizing:border-box}
.gf-head{position:sticky;top:0;z-index:30;background:var(--card);border-bottom:1px solid var(--line);padding:12px 20px 10px;display:flex;flex-direction:column;gap:10px}
.gf-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.gf-title{font-size:24px;font-weight:900;margin-right:auto}.gf-sub{display:block;color:var(--muted);font-size:12px;font-weight:500;margin-top:2px}
.gf-btn,.gf-in{border:1px solid #d0d5dd;background:#fff;border-radius:10px;padding:8px 11px;font:600 13px Inter,Arial,sans-serif;color:var(--ink);min-height:36px}
.gf-btn{cursor:pointer}.gf-btn:hover{background:var(--soft)}.gf-btn.dark{background:#101828;color:#fff;border-color:#101828}.gf-btn:disabled{opacity:.55;cursor:default}
.gf-chips{display:flex;gap:4px;flex-wrap:wrap;background:var(--soft);padding:3px;border-radius:12px}
.gf-chip{border:0;background:transparent;border-radius:9px;padding:7px 10px;font:600 13px Inter,Arial,sans-serif;color:#344054;cursor:pointer}.gf-chip.on{background:#fff;color:var(--ink);box-shadow:0 1px 2px rgba(16,24,40,.12)}
.gf-custom{display:none;gap:6px;align-items:center}.gf-custom.on{display:flex}
.gf-tabs{display:flex;gap:2px;border-bottom:1px solid var(--line);margin:0 -20px -10px;padding:0 20px;overflow-x:auto}
.gf-tab{border:0;background:none;padding:10px 12px;font:700 14px Inter,Arial,sans-serif;color:var(--muted);border-bottom:2px solid transparent;cursor:pointer;white-space:nowrap}.gf-tab.on{color:var(--ink);border-bottom-color:var(--ink)}
.gf-body{padding:16px 20px 40px;max-width:1500px;width:100%;margin:0 auto}
.gf-status{color:var(--muted);font-size:12.5px;margin:0 0 12px;line-height:1.5}
.gf-msg{border-radius:12px;padding:10px 14px;margin:0 0 12px;font-size:13.5px;line-height:1.45}
.gf-msg.warn{background:#fffaeb;border:1px solid #fedf89;color:#7a2e0e}.gf-msg.error{background:#fef3f2;border:1px solid #fecdca;color:#912018}.gf-msg.info{background:#eff8ff;border:1px solid #b2ddff;color:#194185}
.gf-kpis{display:grid;grid-template-columns:repeat(auto-fill,minmax(205px,1fr));gap:10px;margin-bottom:14px}
.gf-kpi{min-width:0;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px 14px;display:flex;flex-direction:column;gap:3px}
.gf-kl{font-size:12.5px;color:var(--muted);font-weight:600}.gf-kv{font-size:22px;font-weight:800;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.gf-kh{font-size:11.5px;color:var(--muted)}
.gf-card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;min-width:0;margin-bottom:12px}.gf-card h3{margin:0 0 2px;font-size:15px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}.gf-card .gf-kh{margin-bottom:8px}
.gf-legend{display:flex;gap:12px;flex-wrap:wrap;font-size:12px;color:#344054;margin-bottom:6px}.gf-legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:5px;vertical-align:-1px}
.gf-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.gf-chart{position:relative;height:260px}.gf-chart canvas{width:100%;height:100%;display:block}
.gf-tip{position:absolute;pointer-events:none;background:#101828;color:#fff;border-radius:8px;padding:7px 9px;font-size:12px;line-height:1.45;white-space:nowrap;display:none;z-index:5;font-variant-numeric:tabular-nums}
.gf-tw{overflow:auto;border:1px solid var(--line);border-radius:12px;background:#fff}
.gf-table{width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums}
.gf-table th,.gf-table td{padding:8px 10px;border-bottom:1px solid #f2f4f7;text-align:left;white-space:nowrap}
.gf-table th{position:sticky;top:0;background:#f9fafb;color:#475467;font-weight:700;font-size:12px;z-index:1}
.gf-table td.r,.gf-table th.r{text-align:right}.gf-table tr.tot td{font-weight:800;background:#eff8ff}.gf-table tr.new td{background:#fffaeb}
.gf-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.gf-pill{display:inline-flex;align-items:center;font-size:10.5px;font-weight:800;border-radius:999px;padding:1px 7px;background:#fef0c7;color:#93370d}.gf-pill.grey{background:#f2f4f7;color:#475467}
.gf-empty{color:var(--muted);text-align:center;padding:30px 10px}
.gf-sk{background:linear-gradient(90deg,#eef0f3 25%,#f7f8fa 37%,#eef0f3 63%);background-size:400% 100%;animation:gfsk 1.3s ease infinite;border-radius:8px}
@keyframes gfsk{0%{background-position:100% 50%}100%{background-position:0 50%}}
.gf-navbadge{display:inline-flex;min-width:18px;height:18px;padding:0 5px;margin-left:6px;border-radius:999px;background:#f04438;color:#fff;font-size:11px;font-weight:800;align-items:center;justify-content:center;vertical-align:1px}
.gf-pager{display:flex;gap:8px;align-items:center;margin-top:10px;font-size:13px;color:var(--muted)}
@media(max-width:1000px){.gf-grid{grid-template-columns:1fr}}
@media(max-width:760px){#gbFlip{inset:54px 0 0}.gf-head{padding:10px 16px 8px}.gf-tabs{margin:0 -16px -8px;padding:0 16px}.gf-body{padding:12px 16px}.gf-title{font-size:20px}.gf-kpis{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.gf-kv{font-size:18px}.gf-chart{height:220px}}
`;document.head.appendChild(st);
}

function build(){
  addStyle();let root=$('#gbFlip');if(root)return root;
  root=document.createElement('section');root.id='gbFlip';root.setAttribute('aria-label','Flip');
  root.innerHTML=`<div class="gf-head">
  <div class="gf-row"><div class="gf-title">Flip<span class="gf-sub">Flip.kz · заказы, продажи и динамика · Asia/Almaty</span></div>
  <button class="gf-btn dark" id="gfClose" type="button">Закрыть</button></div>
  <div class="gf-tabs">${TABS.map(([k,l])=>`<button class="gf-tab" type="button" data-t="${k}">${l}</button>`).join('')}</div>
</div><div class="gf-body"><div id="gfPanel"></div></div>`;
  document.body.appendChild(root);
  $('#gfClose',root).onclick=close;
  root.querySelectorAll('.gf-tab').forEach(b=>b.onclick=()=>{state.tab=b.dataset.t;render()});
  return root;
}

function skeleton(){return `<div class="gf-kpis">${Array.from({length:4},()=>`<div class="gf-kpi"><div class="gf-sk" style="height:12px;width:55%"></div><div class="gf-sk" style="height:24px;width:75%;margin-top:8px"></div></div>`).join('')}</div><div class="gf-card"><div class="gf-sk" style="height:220px"></div></div>`}
const kpi=(label,value,hint='')=>`<div class="gf-kpi"><div class="gf-kl">${esc(label)}</div><div class="gf-kv">${value}</div>${hint?`<div class="gf-kh">${hint}</div>`:''}</div>`;
const msg=(kind,text)=>`<div class="gf-msg ${kind}">${text}</div>`;

function render(){
  const root=build();
  root.querySelectorAll('.gf-tab').forEach(b=>b.classList.toggle('on',b.dataset.t===state.tab));
  writeUrl();
  if(state.tab==='orders')return renderOrders();
  if(state.tab==='sales')return renderSales();
  return renderDynamics();
}

// ---------- orders ----------
async function loadOrders(live=false){
  if(state.ordersLoading)return;state.ordersLoading=true;state.ordersError='';renderOrders();
  try{state.orders=await flip('orders',{live:live?1:''},{timeout:120000})}
  catch(e){state.ordersError=e.message}
  finally{state.ordersLoading=false;markViewed();if(state.tab==='orders'&&state.open)renderOrders()}
}

function renderOrders(){
  const panel=$('#gfPanel');if(!panel)return;
  const d=state.orders;
  const head=`<div class="gf-row" style="margin-bottom:12px"><button class="gf-btn" id="gfOrdersLive" type="button" ${state.ordersLoading?'disabled':''}>${state.ordersLoading?'↻ Загружаю из Flip…':'↻ Обновить из Flip'}</button><span class="gf-status" style="margin:0">${d?(d.source==='live'?'Данные из Flip на ':'Снимок последнего опроса (каждые 5 минут) от ')+esc(fmtTime(d.fetchedAt)):''}</span></div>`;
  if(!d&&!state.ordersLoading&&!state.ordersError){panel.innerHTML=head+skeleton();bindOrders();loadOrders(false);return}
  if(!d){panel.innerHTML=head+(state.ordersError?msg('error','Не удалось загрузить заказы: '+esc(state.ordersError)):skeleton());bindOrders();return}
  const groups=d.groups||[];
  const isNew=it=>!it.firstSeenAt||it.firstSeenAt>state.prevViewed;
  let units=0,total=0,fresh=0;
  const byStore=new Map();
  for(const g of groups){const key=g.groupStoreName||'Склад не указан';if(!byStore.has(key))byStore.set(key,[]);byStore.get(key).push(g);for(const it of g.items||[]){units++;total+=it.price||0;if(isNew(it))fresh++}}
  const warn=[];
  if(state.ordersError)warn.push(msg('error','Не удалось обновить: '+esc(state.ordersError)));
  if(!d.initialized)warn.push(msg('info','Опрос новых заказов ещё не запускался: при первом запуске текущие заказы будут запомнены без уведомления.'));
  const stores=[...byStore.entries()].sort((a,b)=>a[0].localeCompare(b[0],'ru'));
  panel.innerHTML=head+warn.join('')+`<div class="gf-kpis">${kpi('Ожидают обработки',count(units),'единиц товара (одна строка = 1 шт.)')}${kpi('Групп заказов',count(groups.length))}${kpi('Сумма (закупочная)',money(total))}${kpi('Новых с прошлого просмотра',count(fresh))}</div>`+
  (stores.length?stores.map(([name,list])=>{
    const su=list.reduce((n,g)=>n+(g.items||[]).length,0),st=list.reduce((n,g)=>n+(g.total||0),0);
    const rows=list.flatMap(g=>(g.items||[]).map(it=>`<tr class="${isNew(it)?'new':''}"><td>${esc(g.groupName||g.groupId)}<div class="gf-kh gf-mono">${esc(g.groupId)}</div></td><td class="gf-mono">${esc(it.article||'—')}</td><td>${esc((it.partnerCodes||[]).join(', ')||'—')}</td><td class="r">${money(it.price)}</td><td class="gf-mono">${esc(it.preorderId||'—')}</td><td>${it.firstSeenAt?esc(fmtTime(it.firstSeenAt)):'<span class="gf-pill grey">ещё не опрошен</span>'} ${isNew(it)?'<span class="gf-pill">новый</span>':''}</td></tr>`)).join('');
    return `<div class="gf-card"><h3>🏬 ${esc(name)}</h3><div class="gf-kh">${count(su)} ${plural(su,'единица','единицы','единиц')} · ${money(st)}</div><div class="gf-tw"><table class="gf-table"><thead><tr><th>Группа</th><th>Артикул</th><th>Наши коды</th><th class="r">Цена</th><th>preorderId</th><th>Появился</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
  }).join(''):'<div class="gf-card"><div class="gf-empty">Заказов, ожидающих обработки, нет 🎉</div></div>');
  bindOrders();
}
function bindOrders(){const b=$('#gfOrdersLive');if(b)b.onclick=()=>loadOrders(true)}

function markViewed(){lsSet(VIEWED_KEY,Date.now());setBadge(0)}

// ---------- sales ----------
function salesRange(){
  const s=state.sales,today=almatyToday();
  if(s.preset==='today')return {from:today,to:today};
  if(s.preset==='7d')return {from:addDays(today,-6),to:today};
  if(s.preset==='30d')return {from:addDays(today,-29),to:today};
  return {from:s.from||addDays(today,-6),to:s.to||today};
}
async function loadSales(){
  const s=state.sales;if(s.loading)return;s.loading=true;s.error='';renderSales();
  const {from,to}=salesRange();
  try{s.data=await flip('sales',{from,to,page:s.page},{timeout:120000})}catch(e){s.error=e.message;s.data=null}
  finally{s.loading=false;if(state.tab==='sales'&&state.open)renderSales()}
}
function periodControls(prefix,presets,cur,from,to){
  return `<div class="gf-row" style="margin-bottom:12px"><div class="gf-chips">${presets.map(([k,l])=>`<button class="gf-chip ${k===cur?'on':''}" type="button" data-${prefix}="${k}">${l}</button>`).join('')}</div>
  <div class="gf-custom ${cur==='custom'?'on':''}"><input class="gf-in" type="date" id="${prefix}From" value="${esc(from)}" max="${almatyToday()}"><span>—</span><input class="gf-in" type="date" id="${prefix}To" value="${esc(to)}" max="${almatyToday()}"><button class="gf-btn" type="button" id="${prefix}Apply">Показать</button></div></div>`;
}
function bindPeriod(prefix,target,reload){
  document.querySelectorAll(`[data-${prefix}]`).forEach(b=>b.onclick=()=>{target.preset=b.dataset[prefix];target.page=1;if(target.preset==='custom'){const t=almatyToday();target.from=target.from||addDays(t,-6);target.to=target.to||t;render();return}reload()});
  const a=$('#'+prefix+'Apply');if(a)a.onclick=()=>{const f=$('#'+prefix+'From').value,t=$('#'+prefix+'To').value;if(!f||!t||f>t){alert('Выберите корректный период: дата «С» не позже даты «По»');return}target.from=f;target.to=t;target.page=1;reload()};
}
function renderSales(){
  const panel=$('#gfPanel');if(!panel)return;const s=state.sales,{from,to}=salesRange();
  const controls=periodControls('gfs',SALES_PRESETS,s.preset,s.from||from,s.to||to);
  if(s.loading||(!s.data&&!s.error)){panel.innerHTML=controls+skeleton();bindPeriod('gfs',s,loadSales);if(!s.loading&&!s.data)loadSales();return}
  if(s.error){panel.innerHTML=controls+msg('error','Не удалось получить отчёт Flip: '+esc(s.error));bindPeriod('gfs',s,loadSales);return}
  const d=s.data,fields=(d.fields||[]).filter(f=>f.kind!=='text'),texts=(d.fields||[]).filter(f=>f.kind==='text');
  const label=d.range.from===d.range.to?ddmmyyyy(d.range.from):ddmmyyyy(d.range.from)+' — '+ddmmyyyy(d.range.to);
  let html=controls+`<div class="gf-status">Период ${esc(label)} · тип поставщика: <b>${esc(d.supplierType||'не указан')}</b> · обновлено ${esc(fmtTime(d.generatedAt))}</div>`;
  html+=fields.length?`<div class="gf-kpis">${fields.map(f=>kpi(f.label,f.kind==='count'?count(f.value):money(f.value),f.label!==f.key?`<span class="gf-mono">${esc(f.key)}</span>`:'')).join('')}</div>`:msg('info','За выбранный период продаж нет (Flip не вернул итогов).');
  if(texts.length)html+=`<div class="gf-card"><h3>Реквизиты акта</h3><div class="gf-tw"><table class="gf-table"><tbody>${texts.map(f=>`<tr><td>${esc(f.label)}</td><td>${esc(f.value)}</td></tr>`).join('')}</tbody></table></div></div>`;
  if(d.items){
    const it=d.items,cols=it.columns||[];
    html+=`<div class="gf-card"><h3>Операции</h3><div class="gf-kh">${count(it.pagination.total)} ${plural(it.pagination.total,'операция','операции','операций')}</div>`+
    (it.rows.length?`<div class="gf-tw" style="max-height:520px"><table class="gf-table"><thead><tr>${cols.map(c=>`<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${it.rows.map(r=>`<tr>${cols.map(c=>{const v=r[c];return `<td class="${typeof v==='number'?'r':''}">${v===undefined||v===null?'—':esc(typeof v==='number'?nf0.format(v):Array.isArray(v)?v.join(', '):v)}</td>`}).join('')}</tr>`).join('')}</tbody></table></div>`:'<div class="gf-empty">Операций нет</div>')+
    (it.pagination.pages>1?`<div class="gf-pager"><button class="gf-btn" type="button" id="gfsPrev" ${s.page<=1?'disabled':''}>←</button>Страница ${s.page} из ${it.pagination.pages}<button class="gf-btn" type="button" id="gfsNext" ${s.page>=it.pagination.pages?'disabled':''}>→</button></div>`:'')+`</div>`;
  }else{
    html+=`<div class="gf-card"><div class="gf-kh" style="margin:0">Детализация операций доступна только поставщикам с типом «fee»; для вашего типа Flip отдаёт только итоги.</div></div>`;
  }
  panel.innerHTML=html;bindPeriod('gfs',s,loadSales);
  const prev=$('#gfsPrev'),next=$('#gfsNext');if(prev)prev.onclick=()=>{s.page--;loadSales()};if(next)next.onclick=()=>{s.page++;loadSales()};
}

// ---------- dynamics ----------
function dynRange(){
  const d=state.dyn,today=almatyToday(),end=addDays(today,-1); // Flip daily totals are saved for finished days
  if(d.preset==='7d')return {from:addDays(end,-6),to:end};
  if(d.preset==='30d')return {from:addDays(end,-29),to:end};
  if(d.preset==='90d')return {from:addDays(end,-89),to:end};
  return {from:d.from||addDays(end,-29),to:d.to||end};
}
const RANK={hour:0,day:1,week:2,month:3};
// Re-buckets a Kaspi series (finer granularity) into day/week/month keys.
function bucketOf(iso,grain){return grain==='month'?iso.slice(0,7):grain==='week'?weekStart(iso):iso}
function rebucketKaspi(kaspi,grain,from){
  const out=new Map();
  for(const r of kaspi.series||[]){
    const iso=kaspi.period.granularity==='hour'?from:(r.from||r.key);
    const k=bucketOf(iso,grain);const cur=out.get(k)||{revenue:0,units:0};cur.revenue+=r.revenue||0;cur.units+=r.units||0;out.set(k,cur);
  }
  return out;
}
async function loadDynamics(){
  const d=state.dyn,seq=++d.seq,{from,to}=dynRange();d.loading=true;d.error='';d.kaspiError='';renderDynamics();
  try{
    let grain=d.grain;
    if(d.source!=='flip'){
      const key=from+'|'+to;
      if(d.kaspiKey!==key||!d.kaspi){d.kaspi=null;d.kaspi=await api('analytics','dashboard',{preset:'custom',from,to},{timeout:290000});d.kaspiKey=key}
      if(RANK[d.kaspi.period.granularity]>RANK[grain]){grain=d.kaspi.period.granularity;d.grainNote=`Kaspi для такого периода отдаёт данные только ${grain==='week'?'по неделям':'по месяцам'} — график показан так же.`}else d.grainNote='';
    }else d.grainNote='';
    if(d.source!=='kaspi')d.flip=await flip('dynamics',{from,to,granularity:grain});
    if(seq!==d.seq)return;
    d.effGrain=grain;
  }catch(e){if(seq!==d.seq)return;d.error=e.message}
  finally{if(seq===d.seq){d.loading=false;if(state.tab==='dynamics'&&state.open)renderDynamics()}}
}
function dynRows(){
  const d=state.dyn,{from,to}=dynRange(),grain=d.effGrain||d.grain;
  const kaspi=d.source!=='flip'&&d.kaspi?rebucketKaspi(d.kaspi,grain,from):new Map();
  let base=d.source!=='kaspi'&&d.flip?d.flip.series:null;
  if(!base){ // Kaspi only: build labels from Kaspi series
    base=(d.kaspi&&d.kaspi.series||[]).map(r=>({key:bucketOf(d.kaspi.period.granularity==='hour'?from:(r.from||r.key),grain),label:r.label,revenue:0,units:0,missing:0}));
    const seen=new Set();base=base.filter(r=>!seen.has(r.key)&&seen.add(r.key));
    if(d.kaspi&&d.kaspi.period.granularity==='hour')base=[{key:from,label:ddmmyyyy(from).slice(0,5),revenue:0,units:0,missing:0}];
  }
  return base.map(r=>{const k=kaspi.get(r.key)||{revenue:0,units:0};return {key:r.key,label:r.label,flipRevenue:r.revenue||0,flipUnits:r.units||0,missing:r.missing||0,kaspiRevenue:k.revenue,kaspiUnits:k.units}});
}
function renderDynamics(){
  const panel=$('#gfPanel');if(!panel)return;const d=state.dyn,{from,to}=dynRange();
  const controls=periodControls('gfd',DYN_PRESETS,d.preset,d.from||from,d.to||to)+
    `<div class="gf-row" style="margin-bottom:12px"><div class="gf-chips">${GRAINS.map(([k,l])=>`<button class="gf-chip ${k===d.grain?'on':''}" type="button" data-gfg="${k}">${l}</button>`).join('')}</div>
    <div class="gf-chips">${SOURCES.map(([k,l])=>`<button class="gf-chip ${k===d.source?'on':''}" type="button" data-gfsrc="${k}">${l}</button>`).join('')}</div>
    <span style="flex:1"></span><button class="gf-btn" type="button" id="gfBackfill" ${d.backfill?'disabled':''}>${d.backfill?esc(d.backfillText||'Загружаю историю…'):'⤓ Загрузить историю Flip за 90 дней'}</button></div>`;
  const bind=()=>{
    bindPeriod('gfd',d,loadDynamics);
    document.querySelectorAll('[data-gfg]').forEach(b=>b.onclick=()=>{d.grain=b.dataset.gfg;loadDynamics()});
    document.querySelectorAll('[data-gfsrc]').forEach(b=>b.onclick=()=>{d.source=b.dataset.gfsrc;loadDynamics()});
    const bf=$('#gfBackfill');if(bf)bf.onclick=runBackfill;
  };
  const needFlip=d.source!=='kaspi',needKaspi=d.source!=='flip';
  if(d.loading||(!d.error&&((needFlip&&!d.flip)||(needKaspi&&!d.kaspi)))){panel.innerHTML=controls+(needKaspi&&!d.kaspi?msg('info','Загружаю продажи Kaspi из «Динамики продаж» — при холодном кэше это может занять пару минут.'):'')+skeleton();bind();if(!d.loading)loadDynamics();return}
  if(d.error){panel.innerHTML=controls+msg('error','Не удалось загрузить динамику: '+esc(d.error));bind();return}
  const rows=dynRows(),grain=d.effGrain||d.grain;
  const sum=(k)=>rows.reduce((a,r)=>a+r[k],0);
  const showF=needFlip,showK=needKaspi;
  const warns=[];
  if(d.grainNote)warns.push(msg('info',esc(d.grainNote)));
  if(showF&&d.flip){const h=d.flip.history;if(!h.days)warns.push(msg('warn','История Flip пока пуста. Нажмите «Загрузить историю Flip за 90 дней» — дальше итоги будут сохраняться каждую ночь в 01:00.'));else if(d.flip.summary.missing)warns.push(msg('warn',`Нет сохранённых итогов Flip за ${count(d.flip.summary.missing)} ${plural(d.flip.summary.missing,'день','дня','дней')} периода — догрузите историю.`))}
  const kpis=[];
  if(showF){kpis.push(kpi('Выручка Flip',money(sum('flipRevenue'))));kpis.push(kpi('Продано Flip, шт',count(sum('flipUnits'))))}
  if(showK){kpis.push(kpi('Выручка Kaspi',money(sum('kaspiRevenue')),'завершённые заказы по дате выдачи'));kpis.push(kpi('Продано Kaspi, шт',count(sum('kaspiUnits'))))}
  if(showF&&showK){kpis.push(kpi('Выручка вместе',money(sum('flipRevenue')+sum('kaspiRevenue'))));const t=sum('flipRevenue')+sum('kaspiRevenue');kpis.push(kpi('Доля Flip',t?nf0.format(sum('flipRevenue')/t*100)+'%':'—'))}
  const series=(kind)=>[...(showK?[{name:'Kaspi',color:C.kaspi,values:rows.map(r=>r['kaspi'+kind])}]:[]),...(showF?[{name:'Flip',color:C.flip,values:rows.map(r=>r['flip'+kind])}]:[])];
  const leg=`<div class="gf-legend">${series('Revenue').map(s=>`<span><i style="background:${s.color}"></i>${s.name}</span>`).join('')}</div>`;
  const gl={day:'по дням',week:'по неделям',month:'по месяцам'}[grain]||'';
  panel.innerHTML=controls+warns.join('')+`<div class="gf-status">${esc(ddmmyyyy(from))} — ${esc(ddmmyyyy(to))} · ${gl}${showF&&d.flip&&d.flip.history.days?` · история Flip: ${count(d.flip.history.days)} дн. с ${esc(ddmmyyyy(d.flip.history.first))}`:''}</div>
  <div class="gf-kpis">${kpis.join('')}</div>
  <div class="gf-grid"><div class="gf-card"><h3>Выручка</h3><div class="gf-kh">₸ ${gl}</div>${leg}<div class="gf-chart"><canvas id="gfChRev"></canvas><div class="gf-tip"></div></div></div>
  <div class="gf-card"><h3>Продано, шт</h3><div class="gf-kh">${gl}</div>${leg}<div class="gf-chart"><canvas id="gfChUnits"></canvas><div class="gf-tip"></div></div></div></div>
  <div class="gf-card"><h3>Таблица ${gl}</h3><div class="gf-tw" style="max-height:420px"><table class="gf-table"><thead><tr><th>Период</th>${showF?'<th class="r">Выручка Flip</th><th class="r">Flip, шт</th>':''}${showK?'<th class="r">Выручка Kaspi</th><th class="r">Kaspi, шт</th>':''}${showF&&showK?'<th class="r">Вместе</th>':''}</tr></thead><tbody>
  ${rows.map(r=>`<tr><td>${esc(r.label)}${showF&&r.missing?' <span class="gf-pill" title="нет итогов Flip за часть дней">неполно</span>':''}</td>${showF?`<td class="r">${money(r.flipRevenue)}</td><td class="r">${count(r.flipUnits)}</td>`:''}${showK?`<td class="r">${money(r.kaspiRevenue)}</td><td class="r">${count(r.kaspiUnits)}</td>`:''}${showF&&showK?`<td class="r">${money(r.flipRevenue+r.kaspiRevenue)}</td>`:''}</tr>`).join('')}
  <tr class="tot"><td>Итого</td>${showF?`<td class="r">${money(sum('flipRevenue'))}</td><td class="r">${count(sum('flipUnits'))}</td>`:''}${showK?`<td class="r">${money(sum('kaspiRevenue'))}</td><td class="r">${count(sum('kaspiUnits'))}</td>`:''}${showF&&showK?`<td class="r">${money(sum('flipRevenue')+sum('kaspiRevenue'))}</td>`:''}</tr></tbody></table></div></div>`;
  bind();
  const labels=rows.map(r=>r.label);
  chart('gfChRev',{labels,fmt:money,series:series('Revenue'),total:showF&&showK});
  chart('gfChUnits',{labels,fmt:count,series:series('Units'),total:showF&&showK});
}

async function runBackfill(){
  const d=state.dyn;if(d.backfill)return;
  if(!confirm('Загрузить итоги Flip за последние 90 дней? Это по одному запросу на день с паузой — займёт несколько минут.'))return;
  d.backfill=true;d.backfillText='Загружаю историю…';renderDynamics();
  try{
    for(let i=0;i<6;i++){
      const r=await flip('backfill',{},{body:{days:90},timeout:295000});
      d.backfillText=`Загружено ещё ${r.loaded}, осталось ${r.remaining}…`;renderDynamics();
      if(r.errors&&r.errors.length&&!r.loaded){throw new Error(r.errors[0].date+': '+r.errors[0].error)}
      if(r.finished)break;
    }
    d.flip=null;
  }catch(e){alert('Не удалось загрузить историю: '+e.message)}
  finally{d.backfill=false;d.backfillText='';loadDynamics()}
}

// ---------- chart (canvas, stacked bars, crosshair tooltip) ----------
function short(v){const a=Math.abs(v);if(a>=1e9)return (v/1e9).toFixed(1).replace('.0','')+' млрд';if(a>=1e6)return (v/1e6).toFixed(1).replace('.0','')+' млн';if(a>=1e3)return (v/1e3).toFixed(0)+' тыс';return nf0.format(v)}
const charts=new Map();
function chart(id,cfg){
  const canvas=document.getElementById(id);if(!canvas)return;charts.set(id,cfg);draw(canvas,cfg,-1);
  const box=canvas.parentElement,tip=box.querySelector('.gf-tip');
  canvas.onmousemove=e=>{const r=canvas.getBoundingClientRect(),g=cfg.geo;if(!g)return;const n=cfg.labels.length;const i=Math.max(0,Math.min(n-1,Math.floor((e.clientX-r.left-g.left)/g.step)));draw(canvas,cfg,i);
    tip.innerHTML=`<b>${esc(cfg.labels[i])}</b><br>`+cfg.series.map(s=>`<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${s.color};margin-right:5px"></span>${esc(s.name)}: ${cfg.fmt(s.values[i])}`).join('<br>')+(cfg.total?`<br>Вместе: ${cfg.fmt(cfg.series.reduce((a,s)=>a+(s.values[i]||0),0))}`:'');
    tip.style.display='block';const x=g.left+i*g.step+g.step/2;tip.style.left=Math.min(Math.max(0,x+12),box.clientWidth-tip.offsetWidth)+'px';tip.style.top='8px'};
  canvas.onmouseleave=()=>{tip.style.display='none';draw(canvas,cfg,-1)};
}
function draw(canvas,cfg,hover){
  const rect=canvas.getBoundingClientRect(),dpr=Math.max(1,window.devicePixelRatio||1);
  canvas.width=Math.max(1,Math.round(rect.width*dpr));canvas.height=Math.max(1,Math.round(rect.height*dpr));
  const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);const W=rect.width,H=rect.height;ctx.clearRect(0,0,W,H);
  const n=cfg.labels.length;if(!n)return;
  let max=0;for(let i=0;i<n;i++)max=Math.max(max,cfg.series.reduce((a,s)=>a+Math.max(0,s.values[i]||0),0));
  if(!max)max=1;max*=1.08;
  const left=62,right=10,top=10,bottom=26,pw=Math.max(10,W-left-right),ph=Math.max(10,H-top-bottom),step=pw/n;
  const yOf=v=>top+ph*(1-v/max);cfg.geo={left,step};
  ctx.font='11px Inter,Arial,sans-serif';ctx.textAlign='right';ctx.fillStyle=C.axis;ctx.strokeStyle=C.grid;ctx.lineWidth=1;
  for(let k=0;k<=4;k++){const v=max*k/4,y=yOf(v);ctx.beginPath();ctx.moveTo(left,Math.round(y)+.5);ctx.lineTo(W-right,Math.round(y)+.5);ctx.stroke();ctx.fillText(short(v),left-8,y+4)}
  ctx.textAlign='center';const every=Math.max(1,Math.ceil(n/Math.max(2,Math.floor(pw/64))));
  for(let i=0;i<n;i++)if(i%every===0)ctx.fillText(String(cfg.labels[i]).split('–')[0],left+i*step+step/2,H-8);
  if(hover>=0){ctx.fillStyle='rgba(16,24,40,.05)';ctx.fillRect(left+hover*step,top,step,ph)}
  const bw=Math.max(2,Math.min(42,step-2));
  for(let i=0;i<n;i++){let base=0;const x=left+i*step+step/2-bw/2;cfg.series.forEach((s,si)=>{const v=Math.max(0,s.values[i]||0);if(!v)return;const y1=yOf(base+v),h=Math.max(1,yOf(base)-y1-(si?2:0));ctx.fillStyle=s.color;const isTop=cfg.series.slice(si+1).every(t=>!(t.values[i]>0)),r=Math.min(4,bw/2,h);ctx.beginPath();if(isTop&&ctx.roundRect)ctx.roundRect(x,y1,bw,h,[r,r,0,0]);else ctx.rect(x,y1,bw,h);ctx.fill();base+=v})}
}

// ---------- nav, badge, url ----------
function setBadge(n){const b=$('#gbFlipNavBadge');if(!b)return;b.textContent=n>99?'99+':String(n);b.style.display=n>0?'inline-flex':'none';b.title=n?`${n} ${plural(n,'новый заказ','новых заказа','новых заказов')} Flip`:''}
async function refreshBadge(){
  if(state.open&&state.tab==='orders')return;
  try{const r=await flip('badge',{since:Number(lsGet(VIEWED_KEY))||0},{timeout:30000});setBadge(r.count||0)}catch{/* badge is best effort */}
}
function ensureNav(){
  if($('#gbFlipNav'))return true;
  const all=[...document.querySelectorAll('button,a')];
  const ref=$('#gbQualityNav2')||$('#gbDynNav')||all.find(el=>/Прайс Kaspi/i.test(el.textContent||''))||all.find(el=>/Настройки/i.test(el.textContent||''));
  if(!ref||!ref.parentElement)return false;
  const b=document.createElement('button');b.id='gbFlipNav';b.type='button';b.className=ref.className;b.innerHTML='🟠 Flip<span class="gf-navbadge" id="gbFlipNavBadge" style="display:none"></span>';b.onclick=()=>open('orders');
  ref.parentElement.insertBefore(b,ref.nextSibling);refreshBadge();return true;
}
function writeUrl(){try{const q=new URLSearchParams(location.search);if(state.open)q.set('flip',state.tab);else q.delete('flip');const s=q.toString();history.replaceState(history.state,'',location.pathname+(s?'?'+s:'')+location.hash)}catch{}}

function open(tab){
  const root=build();if(!state.open)state.overflow=document.body.style.overflow;
  state.open=true;if(tab&&TABS.some(t=>t[0]===tab))state.tab=tab;
  document.body.style.overflow='hidden';root.style.display='flex';
  if(state.tab==='orders'){state.prevViewed=Number(lsGet(VIEWED_KEY))||0;state.orders=null;render();loadOrders(false)}else render();
}
function close(){state.open=false;const root=$('#gbFlip');if(root)root.style.display='none';document.body.style.overflow=state.overflow;writeUrl();refreshBadge()}

addStyle();
const autoTab=new URLSearchParams(location.search).get('flip');
let tries=0;const boot=setInterval(()=>{if(ensureNav()||++tries>120){clearInterval(boot);if(autoTab)open(autoTab)}},300);
setInterval(refreshBadge,BADGE_MS);
let resizeTimer=null;
window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(state.open&&state.tab==='dynamics')for(const [id,cfg] of charts){const c=document.getElementById(id);if(c)draw(c,cfg,-1)}},150)});
window.addEventListener('keydown',e=>{if(e.key==='Escape'&&state.open)close()});
window.GBFlip={open,close,refreshBadge};
})();
