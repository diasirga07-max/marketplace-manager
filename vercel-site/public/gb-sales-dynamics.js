(()=>{
'use strict';
// GRANTS BOOK · Динамика продаж (аналитика). Только отображение: все расчёты в /api/analytics.
if(window.GB_SALES_DYNAMICS_LOADED)return;
window.GB_SALES_DYNAMICS_LOADED=true;

const API='/api/data'; // served by api/data.js with module=analytics (Hobby: max 12 functions)
const PRESETS=[['today','Сегодня'],['yesterday','Вчера'],['7d','7 дней'],['week','Неделя'],['month','Месяц'],['3m','3 месяца'],['6m','6 месяцев'],['year','Год'],['custom','Свой период']];
const WAREHOUSES=[['all','Все склады'],['Курдай','Курдай'],['WB','WB'],['Алматы','Алматы']];
const TABS=[['overview','Обзор'],['pnl','P&L'],['expenses','Расходы'],['settings','Настройки']];
const C={s1:'#2a78d6',s2:'#eb6834',s3:'#1baf7a',s4:'#eda100',good:'#067647',bad:'#b42318',grid:'#eaecf0',axis:'#667085',ink:'#101828'};

const state={preset:'month',from:'',to:'',warehouse:'all',category:'',sku:'',tab:'overview',data:null,settings:null,expenses:[],seq:0,retry:0,overflow:'',open:false};
let retryTimer=null,resizeTimer=null;

// ---------- formatting ----------
const nf0=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0});
const nf1=new Intl.NumberFormat('ru-RU',{minimumFractionDigits:1,maximumFractionDigits:1});
const isNum=v=>typeof v==='number'&&Number.isFinite(v);
const money=v=>isNum(v)?nf0.format(Math.round(v))+' ₸':'—';
const count=v=>isNum(v)?nf0.format(Math.round(v)):'—';
const pct=v=>isNum(v)?nf1.format(v)+'%':'—';
const esc=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ddmmyyyy=iso=>{const m=String(iso||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);return m?`${m[3]}.${m[2]}.${m[1]}`:String(iso||'')};
const MONTHS=['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
const monthLabel=key=>{const [y,m]=String(key).split('-').map(Number);return m?`${MONTHS[m-1]} ${y}`:key};
const short=v=>{const a=Math.abs(v);return a>=1e6?nf1.format(v/1e6)+' млн':a>=1e3?nf0.format(v/1e3)+' тыс':nf0.format(v)};
function almatyToday(){const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Almaty',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));return `${p.year}-${p.month}-${p.day}`}
function fmtTime(v){if(!v)return '—';const d=new Date(v);return Number.isNaN(d.getTime())?String(v):d.toLocaleString('ru-RU',{timeZone:'Asia/Almaty',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}

// ---------- URL state ----------
function readUrl(){
  const q=new URLSearchParams(location.search);
  if(q.get('gd_p')&&PRESETS.some(p=>p[0]===q.get('gd_p')))state.preset=q.get('gd_p');
  state.from=q.get('gd_from')||'';state.to=q.get('gd_to')||'';
  if(WAREHOUSES.some(w=>w[0]===q.get('gd_w')))state.warehouse=q.get('gd_w');
  state.category=q.get('gd_c')||'';state.sku=q.get('gd_s')||'';
  if(TABS.some(t=>t[0]===q.get('gd_tab')))state.tab=q.get('gd_tab');
  return q.get('gd')==='1';
}
function writeUrl(){
  try{
    const q=new URLSearchParams(location.search);
    ['gd','gd_p','gd_from','gd_to','gd_w','gd_c','gd_s','gd_tab'].forEach(k=>q.delete(k));
    if(state.open){
      q.set('gd','1');q.set('gd_p',state.preset);
      if(state.preset==='custom'){q.set('gd_from',state.from);q.set('gd_to',state.to)}
      if(state.warehouse!=='all')q.set('gd_w',state.warehouse);
      if(state.category)q.set('gd_c',state.category);
      if(state.sku)q.set('gd_s',state.sku);
      if(state.tab!=='overview')q.set('gd_tab',state.tab);
    }
    const s=q.toString();history.replaceState(history.state,'',location.pathname+(s?'?'+s:'')+location.hash);
  }catch{}
}

// ---------- API ----------
async function api(op,params={},options={}){
  const q=new URLSearchParams({module:'analytics',op});
  for(const [k,v] of Object.entries(params))if(v!==''&&v!=null)q.set(k,v);
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),options.timeout||290000);
  try{
    const r=await fetch(API+'?'+q.toString(),{method:options.body?'POST':'GET',headers:options.body?{'Content-Type':'application/json'}:{},body:options.body?JSON.stringify(options.body):undefined,cache:'no-store',signal:controller.signal});
    let json={};try{json=await r.json()}catch{throw new Error(`Сервер вернул HTTP ${r.status} без данных`)}
    if(!r.ok||json.ok===false){
      if(r.status===401&&json.code==='access_required')throw new Error('Нужен код доступа GRANTS BOOK');
      throw new Error(json.error||`HTTP ${r.status}`);
    }
    return json;
  }catch(e){if(e.name==='AbortError')throw new Error('Сервер не ответил вовремя. Попробуйте ещё раз.');throw e}
  finally{clearTimeout(timer)}
}

// ---------- styles & skeleton ----------
function addStyle(){
  if(document.getElementById('gbDynStyle'))return;
  const st=document.createElement('style');st.id='gbDynStyle';st.textContent=`
#gbDyn{--bg:#f5f7fa;--card:#fff;--line:#e4e7ec;--ink:#101828;--muted:#667085;--soft:#f2f4f7;--accent:#2a78d6;position:fixed;inset:58px 0 0;z-index:2147483200;background:var(--bg);display:none;flex-direction:column;font-family:Inter,Arial,sans-serif;color:var(--ink);overflow:auto}
#gbDyn *{box-sizing:border-box}
.gd-head{position:sticky;top:0;z-index:30;background:var(--card);border-bottom:1px solid var(--line);padding:12px 20px 10px;display:flex;flex-direction:column;gap:10px}
.gd-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.gd-title{font-size:24px;font-weight:900;margin-right:auto}.gd-sub{display:block;color:var(--muted);font-size:12px;font-weight:500;margin-top:2px}
.gd-btn,.gd-in,.gd-sel{border:1px solid #d0d5dd;background:#fff;border-radius:10px;padding:8px 11px;font:600 13px Inter,Arial,sans-serif;color:var(--ink);min-height:36px}
.gd-btn{cursor:pointer}.gd-btn:hover{background:var(--soft)}.gd-btn.dark{background:#101828;color:#fff;border-color:#101828}.gd-btn.primary{background:var(--accent);color:#fff;border-color:var(--accent)}
.gd-btn:disabled{opacity:.55;cursor:default}
.gd-chips{display:flex;gap:4px;flex-wrap:wrap;background:var(--soft);padding:3px;border-radius:12px}
.gd-chip{border:0;background:transparent;border-radius:9px;padding:7px 10px;font:600 13px Inter,Arial,sans-serif;color:#344054;cursor:pointer}.gd-chip.on{background:#fff;color:var(--ink);box-shadow:0 1px 2px rgba(16,24,40,.12)}
.gd-custom{display:none;gap:6px;align-items:center}.gd-custom.on{display:flex}
.gd-tabs{display:flex;gap:2px;border-bottom:1px solid var(--line);margin:0 -20px -10px;padding:0 20px;overflow-x:auto}
.gd-tab{border:0;background:none;padding:10px 12px;font:700 14px Inter,Arial,sans-serif;color:var(--muted);border-bottom:2px solid transparent;cursor:pointer;white-space:nowrap}.gd-tab.on{color:var(--ink);border-bottom-color:var(--ink)}
.gd-body{padding:16px 20px 40px;max-width:1500px;width:100%;margin:0 auto}
.gd-status{color:var(--muted);font-size:12.5px;margin:0 0 12px;line-height:1.5}
.gd-msg{border-radius:12px;padding:10px 14px;margin:0 0 12px;font-size:13.5px;line-height:1.45;display:none}.gd-msg.on{display:block}
.gd-msg.warn{background:#fffaeb;border:1px solid #fedf89;color:#7a2e0e}.gd-msg.error{background:#fef3f2;border:1px solid #fecdca;color:#912018}.gd-msg.info{background:#eff8ff;border:1px solid #b2ddff;color:#194185}
.gd-kpis{display:grid;grid-template-columns:repeat(auto-fill,minmax(205px,1fr));gap:10px;margin-bottom:14px}
.gd-kpi{min-width:0;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px 14px;min-height:118px;display:flex;flex-direction:column;gap:3px}
.gd-kl{font-size:12.5px;color:var(--muted);font-weight:600;display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.gd-kv{font-size:22px;font-weight:800;letter-spacing:-.01em;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gd-kh{font-size:11.5px;color:var(--muted)}
.gd-d{font-size:12px;font-variant-numeric:tabular-nums;display:flex;gap:4px;align-items:baseline;white-space:nowrap}.gd-d b{font-weight:700}.gd-d .lbl{color:var(--muted);min-width:56px}
.gd-d.up b{color:${C.good}}.gd-d.down b{color:${C.bad}}.gd-d.flat b{color:var(--muted)}
.gd-badge{font-size:10.5px;font-weight:700;border-radius:999px;padding:1px 7px;background:#fffaeb;color:#b54708;border:1px solid #fedf89}
.gd-grid{display:grid;grid-template-columns:2fr 1fr;gap:12px;margin-bottom:12px}
.gd-card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;min-width:0}.gd-card h3{margin:0 0 2px;font-size:15px}.gd-card .gd-kh{margin-bottom:8px}
.gd-legend{display:flex;gap:12px;flex-wrap:wrap;font-size:12px;color:#344054;margin-bottom:6px}.gd-legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:5px;vertical-align:-1px}
.gd-chart{position:relative;height:260px}.gd-chart canvas{width:100%;height:100%;display:block}
.gd-tip{position:absolute;pointer-events:none;background:#101828;color:#fff;border-radius:8px;padding:7px 9px;font-size:12px;line-height:1.45;white-space:nowrap;display:none;z-index:5;font-variant-numeric:tabular-nums}
.gd-tw{overflow:auto;border:1px solid var(--line);border-radius:12px;background:#fff}
.gd-table{width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums}
.gd-table th,.gd-table td{padding:8px 10px;border-bottom:1px solid #f2f4f7;text-align:right;white-space:nowrap}
.gd-table th{position:sticky;top:0;background:#f9fafb;color:#475467;font-weight:700;font-size:12px;z-index:1}
.gd-table th:first-child,.gd-table td:first-child{text-align:left;position:sticky;left:0;background:inherit}
.gd-table tbody tr{background:#fff}.gd-table tr.sub td{font-weight:700;background:#f9fafb}.gd-table tr.res td{font-weight:800;background:#ecfdf3}.gd-table tr.tot td{font-weight:800;background:#eff8ff}
.gd-table td.neg{color:#b42318}.gd-table td.total,.gd-table th.total{background:#f2f4f7;font-weight:800}
.gd-sk{background:linear-gradient(90deg,#eef0f3 25%,#f7f8fa 37%,#eef0f3 63%);background-size:400% 100%;animation:gdsk 1.3s ease infinite;border-radius:8px}
@keyframes gdsk{0%{background-position:100% 50%}100%{background-position:0 50%}}
.gd-form{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;align-items:end}
.gd-form label{display:flex;flex-direction:column;gap:5px;font-size:12.5px;font-weight:600;color:#344054}
.gd-form .hint{font-weight:400;color:var(--muted);font-size:11.5px}
.gd-actions{display:flex;gap:8px;margin-top:14px;flex-wrap:wrap}
.gd-empty{color:var(--muted);text-align:center;padding:30px 10px}
.gd-progress{height:4px;background:var(--soft);border-radius:4px;overflow:hidden;margin:0 0 12px;display:none}.gd-progress.on{display:block}.gd-progress i{display:block;height:100%;background:var(--accent);transition:width .4s}
@media(max-width:1000px){.gd-grid{grid-template-columns:1fr}}
@media(max-width:760px){#gbDyn{inset:54px 0 0}.gd-head{padding:10px 12px 8px}.gd-tabs{margin:0 -12px -8px;padding:0 12px}.gd-body{padding:12px}.gd-title{font-size:20px}.gd-kpis{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.gd-d{white-space:normal;flex-wrap:wrap;gap:0 4px}.gd-d .lbl{width:100%}.gd-kpi{padding:10px;min-height:104px}.gd-kv{font-size:17px}.gd-d .lbl{min-width:0}.gd-chart{height:220px}.gd-row .gd-sel,.gd-row .gd-in{flex:1 1 140px}}
`;document.head.appendChild(st);
}

function build(){
  addStyle();let root=document.getElementById('gbDyn');if(root)return root;
  root=document.createElement('section');root.id='gbDyn';root.setAttribute('aria-label','Динамика продаж');
  root.innerHTML=`<div class="gd-head">
  <div class="gd-row"><div class="gd-title">Динамика продаж<span class="gd-sub" id="gdSub">Kaspi · завершённые заказы по дате выдачи · Asia/Almaty</span></div>
  <button class="gd-btn" id="gdRefresh" title="Заново загрузить текущий период из Kaspi">↻ Обновить из Kaspi</button><button class="gd-btn" id="gdCopy" title="Скопировать ссылку с фильтрами">🔗 Ссылка</button><button class="gd-btn dark" id="gdClose">Закрыть</button></div>
  <div class="gd-row"><div class="gd-chips" id="gdChips">${PRESETS.map(([k,l])=>`<button class="gd-chip" data-p="${k}">${l}</button>`).join('')}</div>
  <div class="gd-custom" id="gdCustom"><input class="gd-in" type="date" id="gdFrom"><span>—</span><input class="gd-in" type="date" id="gdTo"><button class="gd-btn" id="gdApply">Показать</button></div></div>
  <div class="gd-row"><select class="gd-sel" id="gdWh">${WAREHOUSES.map(([k,l])=>`<option value="${k}">${l}</option>`).join('')}</select>
  <select class="gd-sel" id="gdCat"><option value="">Все категории</option></select>
  <input class="gd-in" id="gdSku" list="gdSkuList" placeholder="Товар: артикул или название" style="min-width:min(240px,100%)"><datalist id="gdSkuList"></datalist>
  <button class="gd-btn" id="gdReset">Сбросить фильтры</button></div>
  <div class="gd-tabs" id="gdTabs">${TABS.map(([k,l])=>`<button class="gd-tab" data-t="${k}">${l}</button>`).join('')}</div>
</div>
<div class="gd-body"><div class="gd-progress" id="gdProg"><i style="width:0"></i></div><div class="gd-msg" id="gdMsg"></div><div id="gdPanel"></div></div>`;
  document.body.appendChild(root);
  root.querySelectorAll('.gd-chip').forEach(b=>b.onclick=()=>{state.preset=b.dataset.p;if(state.preset==='custom'){if(!state.from){state.to=almatyToday();state.from=state.to.slice(0,8)+'01'}syncControls();return}syncControls();load()});
  root.querySelector('#gdApply').onclick=()=>{const f=root.querySelector('#gdFrom').value,t=root.querySelector('#gdTo').value;if(!f||!t)return showMsg('Выберите обе даты','warn');if(f>t)return showMsg('Дата «С» не может быть позже даты «По»','warn');state.from=f;state.to=t;load()};
  root.querySelector('#gdWh').onchange=e=>{state.warehouse=e.target.value;load()};
  root.querySelector('#gdCat').onchange=e=>{state.category=e.target.value;load()};
  root.querySelector('#gdSku').onchange=e=>{const v=e.target.value.trim();state.sku=v?v.split(' — ')[0].trim():'';load()};
  root.querySelector('#gdReset').onclick=()=>{state.warehouse='all';state.category='';state.sku='';syncControls();load()};
  root.querySelector('#gdRefresh').onclick=()=>load({force:true});
  root.querySelector('#gdCopy').onclick=()=>{writeUrl();const url=location.href;(navigator.clipboard?navigator.clipboard.writeText(url):Promise.reject()).then(()=>showMsg('Ссылка с фильтрами скопирована','info',3000)).catch(()=>window.prompt('Скопируйте ссылку:',url))};
  root.querySelector('#gdClose').onclick=close;
  root.querySelectorAll('.gd-tab').forEach(b=>b.onclick=()=>{state.tab=b.dataset.t;syncControls();renderPanel()});
  return root;
}

function syncControls(){
  const root=build();
  root.querySelectorAll('.gd-chip').forEach(b=>b.classList.toggle('on',b.dataset.p===state.preset));
  root.querySelector('#gdCustom').classList.toggle('on',state.preset==='custom');
  if(state.preset==='custom'){root.querySelector('#gdFrom').value=state.from;root.querySelector('#gdTo').value=state.to}
  root.querySelector('#gdFrom').max=root.querySelector('#gdTo').max=almatyToday();
  root.querySelector('#gdWh').value=state.warehouse;
  root.querySelectorAll('.gd-tab').forEach(b=>b.classList.toggle('on',b.dataset.t===state.tab));
  const filtersHidden=state.tab==='expenses'||state.tab==='settings';
  root.querySelector('#gdChips').parentElement.style.display=filtersHidden?'none':'';
  root.querySelector('#gdWh').parentElement.style.display=filtersHidden?'none':'';
  writeUrl();
}

let msgTimer=null;
function showMsg(text,kind='warn',hideMs=0){const el=document.getElementById('gdMsg');if(!el)return;clearTimeout(msgTimer);el.className='gd-msg'+(text?' on '+kind:'');el.innerHTML=text||'';if(hideMs)msgTimer=setTimeout(()=>showMsg(''),hideMs)}
function progress(done,total){const el=document.getElementById('gdProg');if(!el)return;el.classList.toggle('on',total>0&&done<total);el.firstElementChild.style.width=(total?Math.round(done/total*100):0)+'%'}

function skeleton(){
  return `<div class="gd-sk" style="height:14px;width:45%;margin-bottom:14px"></div><div class="gd-kpis">${Array.from({length:14},()=>`<div class="gd-kpi"><div class="gd-sk" style="height:12px;width:55%"></div><div class="gd-sk" style="height:24px;width:75%;margin-top:6px"></div><div class="gd-sk" style="height:10px;width:65%;margin-top:8px"></div><div class="gd-sk" style="height:10px;width:60%;margin-top:4px"></div></div>`).join('')}</div><div class="gd-grid"><div class="gd-card"><div class="gd-sk" style="height:260px"></div></div><div class="gd-card"><div class="gd-sk" style="height:260px"></div></div></div>`;
}

// ---------- loading ----------
async function load(options={}){
  build();syncControls();clearTimeout(retryTimer);
  if(!options.continuation)state.retry=0;
  const seq=++state.seq,panel=document.getElementById('gdPanel');
  if(!state.data||options.force)panel.innerHTML=skeleton();
  else panel.style.opacity='.55';
  document.getElementById('gdRefresh').disabled=true;
  if(!options.continuation)showMsg(options.force?'Загружаю период заново из Kaspi. Первый раз это может занять до пары минут…':'', 'info');
  const params={preset:state.preset,warehouse:state.warehouse,category:state.category,sku:state.sku};
  if(state.preset==='custom'){params.from=state.from;params.to=state.to}
  if(options.force)params.force=1;
  try{
    const data=await api('dashboard',params);
    if(seq!==state.seq)return;
    state.data=data;state.settings=data.settings;
    fillFilterOptions(data);
    showMsg('');
    // Do not show zeros while the selected period is still being loaded from Kaspi.
    if(data.complete===false&&(state.tab==='overview'||state.tab==='pnl'))panel.innerHTML=skeleton();
    else renderPanel();
    const months=Object.values(data.months||{}),total=months.length,done=months.filter(m=>!['pending','missing','loading'].includes(m.state)).length;
    progress(done,total);
    if(data.pendingMonths&&data.pendingMonths.length&&state.retry<120){
      state.retry++;
      showMsg(`Догружаю историю из Kaspi: готово ${done} из ${total} месяцев. Осталось: ${data.pendingMonths.map(monthLabel).join(', ')}. Первая загрузка месяца из Kaspi занимает 1–3 минуты, страница обновится сама.`,'info');
      retryTimer=setTimeout(()=>load({continuation:true}),4000);
    }
  }catch(error){
    if(seq!==state.seq)return;
    if(!state.data)panel.innerHTML=`<div class="gd-empty">Нет данных для отображения.</div>`;
    showMsg('Не удалось загрузить аналитику: '+esc(error.message)+(state.data?' Показаны предыдущие данные.':''),'error');
  }finally{
    if(seq===state.seq){panel.style.opacity='';document.getElementById('gdRefresh').disabled=false}
  }
}

function fillFilterOptions(data){
  const cat=document.getElementById('gdCat'),opts=data.options||{};
  const cats=(opts.categories||[]).map(c=>c.name);if(state.category&&!cats.includes(state.category))cats.unshift(state.category);
  cat.innerHTML='<option value="">Все категории</option>'+cats.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('');cat.value=state.category;
  document.getElementById('gdSkuList').innerHTML=(opts.products||[]).map(p=>`<option value="${esc(p.sku)} — ${esc(p.name)}"></option>`).join('');
  const sku=document.getElementById('gdSku');
  if(document.activeElement!==sku){const p=(opts.products||[]).find(x=>x.sku===state.sku);sku.value=state.sku?(p?`${p.sku} — ${p.name}`:state.sku):''}
}

// ---------- overview ----------
const CARDS=[
  {k:'revenue',l:'Выручка',f:money},
  {k:'orders',l:'Заказы',f:count},
  {k:'units',l:'Штуки',f:count},
  {k:'avgCheck',l:'Средний чек',f:money},
  {k:'cogs',l:'Себестоимость',f:money,inverse:true,partialHint:true},
  {k:'commission',l:'Комиссия Kaspi',f:money,inverse:true,src:'commission'},
  {k:'delivery',l:'Доставка',f:money,inverse:true,src:'delivery'},
  {k:'expenses',l:'Прочие расходы',f:money,inverse:true},
  {k:'tax',l:'Налог',f:money,inverse:true},
  {k:'grossProfit',l:'Валовая прибыль',f:money,partial:true},
  {k:'netProfit',l:'Чистая прибыль',f:money,partial:true},
  {k:'margin',l:'Маржа',f:pct,points:true,partial:true},
  {k:'roi',l:'ROI',f:pct,points:true,partial:true},
  {k:'cancelOrders',l:'Возвраты и отмены',f:count,inverse:true,cancel:true},
];

function deltaLine(label,d,card){
  if(!d)return `<div class="gd-d flat"><span class="lbl">${label}</span><b>нет данных</b></div>`;
  const abs=d.abs,dir=Math.abs(abs)<1e-9?'flat':(abs>0)!==!!card.inverse?'up':'down',arrow=abs>0?'▲':abs<0?'▼':'•';
  let text;
  if(card.points)text=`${arrow} ${nf1.format(Math.abs(abs))} п.п.`;
  else{const p=d.pct==null?'—':nf1.format(Math.abs(d.pct))+'%';const a=card.f===money?money(Math.abs(abs)):count(Math.abs(abs));text=`${arrow} ${p} · ${abs>0?'+':abs<0?'−':''}${a}`}
  return `<div class="gd-d ${dir}" title="Было: ${esc(card.f(d.base))}"><span class="lbl">${label}</span><b>${text}</b></div>`;
}

function cardHtml(card,data){
  const s=data.summary,v=s[card.k];
  let hint='',badge='';
  if(card.partial&&s.partial)badge=`<span class="gd-badge" title="Прибыль посчитана только по товарам с себестоимостью">частично · ${nf0.format(s.coverage)}%</span>`;
  if(card.partialHint)hint=s.partial?`покрытие себестоимостью ${nf1.format(s.coverage)}% (нет у ${count(s.missingUnits)} шт.)`:'себестоимость есть у всех товаров';
  if(card.src==='commission')hint=s.commissionFromApiPct>0?`из Kaspi ${nf0.format(s.commissionFromApiPct)}%, остальное ${nf1.format(data.settings.commissionPct)}%`:`${nf1.format(data.settings.commissionPct)}% от выручки (Настройки)`;
  if(card.src==='delivery')hint=`из данных Kaspi ${nf0.format(s.deliveryFromApiPct)}%, остальное ${data.settings.deliveryFallback==='percent'?nf1.format(data.settings.deliveryPct)+'% от выручки':'по тарифу'}`;
  if(card.k==='expenses')hint=`ручные ${money(s.otherExpenses)} · Kaspi ${money(s.kaspiExtra)}`;
  if(card.k==='tax')hint=`${nf1.format(data.settings.taxPct)}% от ${data.settings.taxBase==='profit'?'прибыли':'выручки'}`;
  if(card.k==='roi')hint='прибыль / себестоимость';
  if(card.k==='margin')hint='чистая прибыль / выручка';
  let value=card.f(v);
  if(card.cancel){value=`${count(s.cancelOrders)} <span style="font-size:14px;color:#667085;font-weight:600">зак. · ${pct(s.cancelRate)}</span>`;hint=`${count(s.cancelUnits)} шт. · ${money(s.cancelAmount)} · отмен ${count(s.cancelled)}, возвратов ${count(s.returned)}`}
  const dp=data.deltas.previous,dy=data.deltas.yoy,key=card.cancel?'cancelOrders':card.k;
  return `<div class="gd-kpi"><div class="gd-kl">${card.l}${badge}</div><div class="gd-kv">${value}</div><div class="gd-kh">${esc(hint)}</div>${deltaLine('к пред.',dp&&dp[key],card)}${deltaLine('год назад',dy&&dy[key],card)}</div>`;
}

function statusLine(data){
  const p=data.period,cp=data.comparison;
  const range=p.from===p.to?ddmmyyyy(p.from):`${ddmmyyyy(p.from)} — ${ddmmyyyy(p.to)}`;
  const scale={hour:'по часам',day:'по дням',week:'по неделям',month:'по месяцам'}[p.granularity];
  const filt=[data.filters.warehouse!=='all'?'склад '+data.filters.warehouse:'',data.filters.category?'категория «'+data.filters.category+'»':'',data.filters.sku?'товар '+data.filters.sku:''].filter(Boolean).join(', ');
  const refreshing=Object.values(data.months||{}).some(m=>m.refreshing);
  return `<b>${esc(p.label)}</b>: ${range} (${p.days} дн., график ${scale})${filt?' · фильтр: '+esc(filt):''}. Сравнение: пред. период ${ddmmyyyy(cp.previous.from)}—${ddmmyyyy(cp.previous.to)}, год назад ${ddmmyyyy(cp.yoy.from)}—${ddmmyyyy(cp.yoy.to)}. Обновлено ${fmtTime(data.generatedAt)}${refreshing?' · текущий месяц обновляется в фоне':''} · сервер ${count(data.ms)} мс.`;
}

function warnings(data){
  const out=[];
  if(data.summary.partial)out.push(`Себестоимость не найдена для ${count(data.summary.missingUnits)} шт. (покрытие ${nf1.format(data.summary.coverage)}%). Прибыль, маржа и ROI посчитаны «частично» — только по товарам с себестоимостью из «Прайс KASPI».`);
  if(data.catalog&&data.catalog.warning)out.push(esc(data.catalog.warning));
  for(const e of (data.errors||[]).slice(0,4))out.push(`${monthLabel(e.month)}: ${esc(e.message)}`);
  if(!data.comparison.previous.available)out.push('Для предыдущего периода нет данных из Kaspi — сравнение недоступно.');
  return out;
}

function renderOverview(data){
  const s=data.series||[];
  const warn=warnings(data);
  return `<div class="gd-status">${statusLine(data)}</div>${warn.length?`<div class="gd-msg warn on">${warn.map(w=>'⚠ '+w).join('<br>')}</div>`:''}
  <div class="gd-kpis">${CARDS.map(c=>cardHtml(c,data)).join('')}</div>
  <div class="gd-grid">
    <div class="gd-card"><h3>Выручка и прибыль</h3><div class="gd-kh">₸ ${({hour:'по часам',day:'по дням',week:'по неделям',month:'по месяцам'})[data.period.granularity]}${data.summary.partial?' · прибыль частично':''}</div>${legend([['Выручка',C.s1],['Валовая прибыль',C.s2],['Чистая прибыль',C.s3]])}<div class="gd-chart"><canvas id="gdChMoney"></canvas><div class="gd-tip"></div></div></div>
    <div class="gd-card"><h3>Заказы</h3><div class="gd-kh">завершённые заказы, шт.</div><div class="gd-legend">&nbsp;</div><div class="gd-chart"><canvas id="gdChOrders"></canvas><div class="gd-tip"></div></div></div>
  </div>
  <div class="gd-grid" style="grid-template-columns:1fr">
    <div class="gd-card"><h3>Структура расходов</h3><div class="gd-kh">₸, накопительно</div>${legend([['Себестоимость',C.s1],['Комиссия Kaspi',C.s2],['Доставка',C.s3],['Налог и прочие',C.s4]])}<div class="gd-chart"><canvas id="gdChCosts"></canvas><div class="gd-tip"></div></div></div>
  </div>
  <div class="gd-card"><h3>Таблица ${({hour:'по часам',day:'по дням',week:'по неделям',month:'по месяцам'})[data.period.granularity]}</h3><div class="gd-kh">те же данные, что на графиках</div>
  <div class="gd-tw" style="max-height:420px"><table class="gd-table"><thead><tr><th>Период</th><th>Заказы</th><th>Шт</th><th>Выручка</th><th>Ср. чек</th><th>Себестоимость</th><th>Комиссия</th><th>Доставка</th><th>Налог</th><th>Расходы</th><th>Валовая</th><th>Чистая</th><th>Отмены</th></tr></thead><tbody>
  ${s.map(r=>`<tr><td>${esc(r.label)}</td><td>${count(r.orders)}</td><td>${count(r.units)}</td><td>${money(r.revenue)}</td><td>${r.orders?money(r.avgCheck):'—'}</td><td>${money(r.cogs)}</td><td>${money(r.commission)}</td><td>${money(r.delivery)}</td><td>${money(r.tax)}</td><td>${money(r.expenses)}</td><td>${money(r.grossProfit)}</td><td class="${r.netProfit<0?'neg':''}">${money(r.netProfit)}${r.partial&&r.revenue?' *':''}</td><td>${count(r.cancelOrders)}</td></tr>`).join('')}
  <tr class="tot"><td>Итого</td><td>${count(data.summary.orders)}</td><td>${count(data.summary.units)}</td><td>${money(data.summary.revenue)}</td><td>${money(data.summary.avgCheck)}</td><td>${money(data.summary.cogs)}</td><td>${money(data.summary.commission)}</td><td>${money(data.summary.delivery)}</td><td>${money(data.summary.tax)}</td><td>${money(data.summary.expenses)}</td><td>${money(data.summary.grossProfit)}</td><td>${money(data.summary.netProfit)}</td><td>${count(data.summary.cancelOrders)}</td></tr>
  </tbody></table></div>${data.summary.partial?'<div class="gd-kh" style="margin-top:6px">* прибыль частично (не у всех товаров есть себестоимость)</div>':''}</div>`;
}

function legend(items){return `<div class="gd-legend">${items.map(([n,c])=>`<span><i style="background:${c}"></i>${n}</span>`).join('')}</div>`}

// ---------- charts (canvas, one y-axis, crosshair tooltip) ----------
const charts=new Map();
function chart(id,cfg){
  const canvas=document.getElementById(id);if(!canvas)return;
  charts.set(id,cfg);drawChart(canvas,cfg,-1);
  const box=canvas.parentElement,tip=box.querySelector('.gd-tip');
  canvas.onmousemove=e=>{const r=canvas.getBoundingClientRect(),geo=cfg.geo;if(!geo)return;const n=cfg.labels.length;const i=Math.max(0,Math.min(n-1,Math.round((e.clientX-r.left-geo.left-geo.step/2*(cfg.type!=='line'))/geo.step)));drawChart(canvas,cfg,i);
    tip.innerHTML=`<b>${esc(cfg.labels[i])}</b><br>`+cfg.series.map(s=>`<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${s.color};margin-right:5px"></span>${esc(s.name)}: ${cfg.fmt(s.values[i])}`).join('<br>')+(cfg.total?`<br>Итого: ${cfg.fmt(cfg.series.reduce((a,s)=>a+(s.values[i]||0),0))}`:'');
    tip.style.display='block';const x=geo.xOf(i);tip.style.left=Math.min(Math.max(0,x+12),box.clientWidth-tip.offsetWidth)+'px';tip.style.top='8px'};
  canvas.onmouseleave=()=>{tip.style.display='none';drawChart(canvas,cfg,-1)};
}
function drawChart(canvas,cfg,hover){
  const rect=canvas.getBoundingClientRect(),dpr=Math.max(1,window.devicePixelRatio||1);
  canvas.width=Math.max(1,Math.round(rect.width*dpr));canvas.height=Math.max(1,Math.round(rect.height*dpr));
  const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);const W=rect.width,H=rect.height;ctx.clearRect(0,0,W,H);
  const n=cfg.labels.length;if(!n)return;
  const stack=cfg.type==='stack';
  let max=0,min=0;
  for(let i=0;i<n;i++){if(stack){max=Math.max(max,cfg.series.reduce((a,s)=>a+Math.max(0,s.values[i]||0),0))}else for(const s of cfg.series){const v=s.values[i]||0;max=Math.max(max,v);min=Math.min(min,v)}}
  if(max===min)max=min+1;
  const span=(max-min)*1.08;max=min<0?max+(span-(max-min))/2:min+span;
  const left=62,right=10,top=10,bottom=26,pw=Math.max(10,W-left-right),ph=Math.max(10,H-top-bottom);
  const yOf=v=>top+ph*(1-(v-min)/(max-min));
  const step=cfg.type==='line'?(n>1?pw/(n-1):pw):pw/n;
  const xOf=i=>cfg.type==='line'?left+(n>1?i*step:pw/2):left+i*step+step/2;
  cfg.geo={left,step,xOf};
  ctx.font='11px Inter,Arial,sans-serif';ctx.textAlign='right';ctx.fillStyle=C.axis;ctx.strokeStyle=C.grid;ctx.lineWidth=1;
  for(let k=0;k<=4;k++){const v=min+(max-min)*k/4,y=yOf(v);ctx.beginPath();ctx.moveTo(left,Math.round(y)+.5);ctx.lineTo(W-right,Math.round(y)+.5);ctx.stroke();ctx.fillText(short(v),left-8,y+4)}
  if(min<0){ctx.strokeStyle='#98a2b3';ctx.beginPath();ctx.moveTo(left,yOf(0));ctx.lineTo(W-right,yOf(0));ctx.stroke()}
  ctx.textAlign='center';ctx.fillStyle=C.axis;
  const every=Math.max(1,Math.ceil(n/Math.max(2,Math.floor(pw/64))));
  for(let i=0;i<n;i++)if(i%every===0||i===n-1&&n<=40)ctx.fillText(String(cfg.labels[i]).split('–')[0],xOf(i),H-8);
  if(hover>=0){ctx.fillStyle='rgba(16,24,40,.05)';const hw=cfg.type==='line'?Math.max(12,step):step;ctx.fillRect(xOf(hover)-hw/2,top,hw,ph)}
  if(cfg.type==='line'){
    for(const s of cfg.series){ctx.strokeStyle=s.color;ctx.lineWidth=2;ctx.lineJoin='round';ctx.beginPath();s.values.forEach((v,i)=>{const x=xOf(i),y=yOf(v||0);i?ctx.lineTo(x,y):ctx.moveTo(x,y)});ctx.stroke();
      if(n<=40||hover>=0)s.values.forEach((v,i)=>{if(n>40&&i!==hover)return;ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(xOf(i),yOf(v||0),i===hover?5:3,0,Math.PI*2);ctx.fill();ctx.fillStyle=s.color;ctx.beginPath();ctx.arc(xOf(i),yOf(v||0),i===hover?4:2,0,Math.PI*2);ctx.fill()})}
  }else{
    const bw=Math.max(2,Math.min(42,step-2));
    for(let i=0;i<n;i++){let base=0;cfg.series.forEach((s,si)=>{const v=Math.max(0,s.values[i]||0);if(!v)return;const y0=yOf(base),y1=yOf(base+v),h=Math.max(1,y0-y1-(si?2:0));ctx.fillStyle=s.color;const x=xOf(i)-bw/2,top2=y1;const r=Math.min(4,bw/2,h);const isTop=si===cfg.series.length-1||cfg.series.slice(si+1).every(t=>!(t.values[i]>0));ctx.beginPath();if(isTop&&ctx.roundRect)ctx.roundRect(x,top2,bw,h,[r,r,0,0]);else ctx.rect(x,top2,bw,h);ctx.fill();base+=v})}
  }
}
function drawOverviewCharts(data){
  const s=data.series||[],labels=s.map(r=>r.label);
  chart('gdChMoney',{type:'line',labels,fmt:money,series:[{name:'Выручка',color:C.s1,values:s.map(r=>r.revenue)},{name:'Валовая прибыль',color:C.s2,values:s.map(r=>r.grossProfit)},{name:'Чистая прибыль',color:C.s3,values:s.map(r=>r.netProfit)}]});
  chart('gdChOrders',{type:'bar',labels,fmt:count,series:[{name:'Заказы',color:C.s1,values:s.map(r=>r.orders)}]});
  chart('gdChCosts',{type:'stack',labels,fmt:money,total:true,series:[{name:'Себестоимость',color:C.s1,values:s.map(r=>r.cogs)},{name:'Комиссия Kaspi',color:C.s2,values:s.map(r=>r.commission)},{name:'Доставка',color:C.s3,values:s.map(r=>r.delivery)},{name:'Налог и прочие',color:C.s4,values:s.map(r=>r.tax+r.expenses)}]});
}

// ---------- P&L ----------
function renderPnl(data){
  const p=data.pnl;if(!p||!p.columns.length)return '<div class="gd-empty">Нет данных</div>';
  const head=p.columns.map(c=>`<th>${monthLabel(c.key)}${c.partial?' *':''}<div style="font-weight:500;color:#98a2b3;font-size:11px">${ddmmyyyy(c.from).slice(0,5)}–${ddmmyyyy(c.to).slice(0,5)}</div></th>`).join('');
  const cls={subtotal:'sub',result:'res',total:'tot'};
  const cell=(v,kind)=>kind==='percent'?pct(v):v==null?'—':money(v);
  const rows=p.rows.map(r=>`<tr class="${cls[r.kind]||''}"><td>${esc(r.label)}</td>${r.values.map(v=>`<td class="${isNum(v)&&v<0&&r.kind!=='percent'?'neg':''}">${cell(v,r.kind)}</td>`).join('')}<td class="total ${isNum(r.total)&&r.total<0&&r.kind!=='percent'?'neg':''}">${cell(r.total,r.kind)}</td></tr>`).join('');
  return `<div class="gd-status">${statusLine(data)}</div><div class="gd-card"><h3>Отчёт о прибылях и убытках (P&L)</h3><div class="gd-kh">${esc(p.note)}${p.columns.some(c=>c.partial)?' * — в месяце есть товары без себестоимости.':''}</div>
  <div class="gd-tw"><table class="gd-table"><thead><tr><th>Статья</th>${head}<th class="total">Итого</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
}

// ---------- expenses ----------
async function loadExpenses(){
  try{const r=await api('expenses');state.expenses=r.expenses||[];if(!state.settings){const s=await api('settings');state.settings=s.settings}}
  catch(e){showMsg('Не удалось загрузить расходы: '+esc(e.message),'error')}
}
function renderExpenses(){
  const cats=(state.settings&&state.settings.expenseCategories)||['Реклама','Упаковка','Зарплата','Аренда','Прочее'];
  const byMonth=new Map();for(const e of state.expenses){if(!byMonth.has(e.month))byMonth.set(e.month,[]);byMonth.get(e.month).push(e)}
  const months=[...byMonth.keys()].sort().reverse();
  const list=months.length?months.map(m=>{const items=byMonth.get(m),sum=items.reduce((a,e)=>a+e.amount,0);return `<tr class="sub"><td>${monthLabel(m)}</td><td></td><td>${money(sum)}</td><td></td><td></td></tr>`+items.map(e=>`<tr><td style="padding-left:22px">${esc(e.category)}</td><td style="text-align:left">${esc(e.comment)}</td><td>${money(e.amount)}</td><td><button class="gd-btn" data-edit="${esc(e.id)}">Изменить</button></td><td><button class="gd-btn" data-del="${esc(e.id)}">Удалить</button></td></tr>`).join('')}).join(''):`<tr><td colspan="5" class="gd-empty">Расходов пока нет</td></tr>`;
  return `<div class="gd-card" style="margin-bottom:12px"><h3>Добавить расход</h3><div class="gd-kh">Реклама, упаковка, зарплата, аренда и т.д. Сумма за месяц распределяется по дням месяца и вычитается из чистой прибыли.</div>
  <form id="gdExpForm" class="gd-form"><input type="hidden" name="id"><label>Месяц<input class="gd-in" type="month" name="month" required value="${almatyToday().slice(0,7)}"></label>
  <label>Категория<select class="gd-sel" name="category">${cats.map(c=>`<option>${esc(c)}</option>`).join('')}</select></label>
  <label>Сумма, ₸<input class="gd-in" name="amount" inputmode="decimal" required placeholder="150 000"></label>
  <label>Комментарий<input class="gd-in" name="comment" maxlength="200" placeholder="необязательно"></label></form>
  <div class="gd-actions"><button class="gd-btn primary" id="gdExpSave">Сохранить расход</button><button class="gd-btn" id="gdExpCancel" style="display:none">Отменить изменение</button></div></div>
  <div class="gd-card"><h3>Расходы по месяцам</h3><div class="gd-kh">Хранятся на сервере (скрытый лист «GB_Аналитика_Расходы» в Google Таблице).</div><div class="gd-tw"><table class="gd-table"><thead><tr><th>Категория</th><th style="text-align:left">Комментарий</th><th>Сумма</th><th></th><th></th></tr></thead><tbody>${list}</tbody></table></div></div>`;
}
function bindExpenses(){
  const form=document.getElementById('gdExpForm');if(!form)return;
  document.getElementById('gdExpSave').onclick=async()=>{
    const fd=Object.fromEntries(new FormData(form).entries());
    if(!fd.month||!String(fd.amount).trim())return showMsg('Укажите месяц и сумму','warn');
    const btn=document.getElementById('gdExpSave');btn.disabled=true;
    try{const r=await api('expenses',{},{body:fd});state.expenses=r.expenses;state.data=null;showMsg('Расход сохранён','info',2500);renderPanel()}
    catch(e){showMsg('Не удалось сохранить: '+esc(e.message),'error')}finally{btn.disabled=false}
  };
  document.getElementById('gdExpCancel').onclick=()=>renderPanel();
  document.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>{const e=state.expenses.find(x=>x.id===b.dataset.edit);if(!e)return;form.id.value=e.id;form.month.value=e.month;if(![...form.category.options].some(o=>o.value===e.category))form.category.add(new Option(e.category,e.category));form.category.value=e.category;form.amount.value=e.amount;form.comment.value=e.comment;document.getElementById('gdExpSave').textContent='Сохранить изменения';document.getElementById('gdExpCancel').style.display='';form.scrollIntoView({behavior:'smooth',block:'center'})});
  document.querySelectorAll('[data-del]').forEach(b=>b.onclick=async()=>{if(!confirm('Удалить этот расход?'))return;b.disabled=true;try{const r=await api('expense-delete',{},{body:{id:b.dataset.del}});state.expenses=r.expenses;state.data=null;renderPanel()}catch(e){showMsg('Не удалось удалить: '+esc(e.message),'error');b.disabled=false}});
}

// ---------- settings ----------
function renderSettings(){
  const s=state.settings;if(!s)return skeleton();
  return `<div class="gd-card"><h3>Настройки аналитики</h3><div class="gd-kh">Хранятся на сервере (скрытый лист «GB_Аналитика_Настройки»). Применяются ко всем периодам сразу, без перезагрузки данных из Kaspi.</div>
  <form id="gdSetForm" class="gd-form">
  <label>Комиссия Kaspi, %<input class="gd-in" name="commissionPct" inputmode="decimal" value="${s.commissionPct}"><span class="hint">Kaspi API не отдаёт комиссию по заказу, поэтому берётся этот %.</span></label>
  <label>Доставка, если нет в данных Kaspi<select class="gd-sel" name="deliveryFallback"><option value="tariff"${s.deliveryFallback==='tariff'?' selected':''}>По тарифу Kaspi Доставки</option><option value="percent"${s.deliveryFallback==='percent'?' selected':''}>% от выручки</option></select><span class="hint">Если Kaspi вернул стоимость доставки для продавца — берётся она.</span></label>
  <label>Доставка, % от выручки<input class="gd-in" name="deliveryPct" inputmode="decimal" value="${s.deliveryPct}"><span class="hint">Используется только при выборе «% от выручки».</span></label>
  <label>Налог, %<input class="gd-in" name="taxPct" inputmode="decimal" value="${s.taxPct}"></label>
  <label>База налога<select class="gd-sel" name="taxBase"><option value="revenue"${s.taxBase==='revenue'?' selected':''}>Выручка</option><option value="profit"${s.taxBase==='profit'?' selected':''}>Прибыль</option></select></label>
  <label>Тестовые заказы на 10 ₸<select class="gd-sel" name="excludeTenTenge"><option value="1"${s.excludeTenTenge?' selected':''}>Исключать</option><option value="0"${!s.excludeTenTenge?' selected':''}>Учитывать</option></select></label>
  <label style="grid-column:1/-1">Категории расходов (через запятую)<input class="gd-in" name="expenseCategories" value="${esc(s.expenseCategories.join(', '))}"></label>
  </form><div class="gd-actions"><button class="gd-btn primary" id="gdSetSave">Сохранить настройки</button></div></div>`;
}
function bindSettings(){
  const btn=document.getElementById('gdSetSave');if(!btn)return;
  btn.onclick=async()=>{
    const f=Object.fromEntries(new FormData(document.getElementById('gdSetForm')).entries());
    const n=v=>Number(String(v).replace(',','.'));
    const body={commissionPct:n(f.commissionPct),deliveryFallback:f.deliveryFallback,deliveryPct:n(f.deliveryPct),taxPct:n(f.taxPct),taxBase:f.taxBase,excludeTenTenge:f.excludeTenTenge==='1',expenseCategories:String(f.expenseCategories).split(',').map(x=>x.trim()).filter(Boolean)};
    for(const k of ['commissionPct','deliveryPct','taxPct'])if(!Number.isFinite(body[k])||body[k]<0||body[k]>100)return showMsg('Проценты должны быть числами от 0 до 100','warn');
    btn.disabled=true;
    try{const r=await api('settings',{},{body});state.settings=r.settings;state.data=null;showMsg('Настройки сохранены','info',2500);renderPanel()}
    catch(e){showMsg('Не удалось сохранить: '+esc(e.message),'error')}finally{btn.disabled=false}
  };
}

// ---------- panel router ----------
async function renderPanel(){
  const panel=document.getElementById('gdPanel');if(!panel)return;
  if(state.tab==='expenses'){if(!state.expensesLoaded){panel.innerHTML=skeleton();await loadExpenses();state.expensesLoaded=true}panel.innerHTML=renderExpenses();bindExpenses();return}
  if(state.tab==='settings'){if(!state.settings){panel.innerHTML=skeleton();try{state.settings=(await api('settings')).settings}catch(e){showMsg('Не удалось загрузить настройки: '+esc(e.message),'error')}}panel.innerHTML=renderSettings();bindSettings();return}
  if(!state.data){load();return}
  if(state.tab==='pnl'){panel.innerHTML=renderPnl(state.data);return}
  panel.innerHTML=renderOverview(state.data);drawOverviewCharts(state.data);
}

// ---------- open / close / nav ----------
function open(){const root=build();if(!state.open){state.overflow=document.body.style.overflow}state.open=true;document.body.style.overflow='hidden';root.style.display='flex';syncControls();renderPanel()}
function close(){state.open=false;clearTimeout(retryTimer);const root=document.getElementById('gbDyn');if(root)root.style.display='none';document.body.style.overflow=state.overflow;writeUrl()}
function ensureNav(){
  if(document.getElementById('gbDynNav'))return true;
  const all=[...document.querySelectorAll('button,a')],ref=all.find(el=>/Прайс Kaspi/i.test(el.textContent||''))||all.find(el=>/Настройки/i.test(el.textContent||''));
  if(!ref||!ref.parentElement)return false;
  const b=document.createElement('button');b.id='gbDynNav';b.type='button';b.className=ref.className;b.textContent='📈 Динамика продаж';b.onclick=open;ref.parentElement.insertBefore(b,ref);return true;
}

addStyle();
const autoOpen=readUrl();
if(!ensureNav()){let n=0,t=setInterval(()=>{if(ensureNav()||++n>60){clearInterval(t);if(autoOpen)open()}},300)}else if(autoOpen)open();
window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(state.open&&state.tab==='overview'&&state.data)drawOverviewCharts(state.data)},150)});
window.GB_SALES_DYNAMICS={open,close,reload:()=>load({})};
})();
