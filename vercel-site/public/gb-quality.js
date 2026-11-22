(()=>{
'use strict';
// GRANTS BOOK · Показатели качества. Только отображение и ввод: все запросы к
// Kaspi и все расчёты — на сервере (/api/data?module=quality). Токен Kaspi
// в браузер не попадает.
if(window.GB_QUALITY_LOADED)return;
window.GB_QUALITY_LOADED=true;
window.GB_QUALITY_CONTROL_LOADED=true; // старый экран «Контроль качества» заменён этим разделом

const API='/api/data';
const STANDALONE=!!window.GB_QUALITY_STANDALONE;
const HOUR=3600000,DAY=86400000;
const METRICS=['rating','delays','returns','cancels','chats','chatTime'];
const ORDER_METRICS=['cancels','delays','returns'];
const TITLES={rating:'Рейтинг',delays:'Задержки передачи в Kaspi Доставку',returns:'Возвраты по качеству',cancels:'Отмены по вине продавца',chats:'Доля ответов в чатах',chatTime:'Среднее время ответа'};
const DIMS=[['brand','Бренды'],['sku','Товары (SKU)'],['category','Категории']];
const ZONE_LABEL={good:'Хорошо',normal:'Нормально',bad:'Плохо',nodata:'Нет данных',manual:'Ручной ввод'};
const STATUS_LEVELS=['Очень плохо','Плохо','Нормально','Хорошо','Отлично'];

const S={days:30,brand:'',category:'',asOf:'',data:null,loading:false,refreshing:false,open:false,detail:null,dim:'sku',targets:{},timer:null,seq:0};

// ---------- utils ----------
const $=(sel,root=document)=>root.querySelector(sel);
const esc=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const nf0=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0});
const isNum=v=>typeof v==='number'&&Number.isFinite(v);
const cnt=v=>isNum(v)?nf0.format(v):'—';
const pct=(v,d=1)=>isNum(v)?(v*100).toLocaleString('ru-RU',{minimumFractionDigits:d,maximumFractionDigits:d})+'%':'—';
const pp=(v,d=2)=>isNum(v)?((v>0?'+':'')+(v*100).toLocaleString('ru-RU',{minimumFractionDigits:d,maximumFractionDigits:d})+' п.п.'):'—';
const num=(v,d=1)=>isNum(v)?v.toLocaleString('ru-RU',{minimumFractionDigits:d,maximumFractionDigits:d}):'—';
const dm=iso=>{const m=String(iso||'').match(/^(\d{4})-(\d{2})-(\d{2})/);return m?m[3]+'.'+m[2]:String(iso||'')};
const dmy=iso=>{const m=String(iso||'').match(/^(\d{4})-(\d{2})-(\d{2})/);return m?m[3]+'.'+m[2]+'.'+m[1]:String(iso||'')};
const almaty=ms=>ms?new Date(ms).toLocaleString('ru-RU',{timeZone:'Asia/Almaty',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}):'—';
const almatyDay=ms=>ms?new Date(ms).toLocaleDateString('ru-RU',{timeZone:'Asia/Almaty',day:'2-digit',month:'2-digit'}):'—';
const isoAlmaty=ms=>new Date(ms+5*HOUR).toISOString().slice(0,10);

// Зеркало lib/quality/formulas.js для мгновенного пересчёта при смене цели в UI.
const EPS=1e-9;
function cleanNeeded(bad,total,T,strict){if(!(T>0))return bad>0?Infinity:0;if(!bad)return 0;const x=bad/T-total;return strict?Math.max(0,Math.floor(x+EPS)+1):Math.max(0,Math.ceil(x-EPS))}
function badMax(total,T){if(!total||!(T>0))return 0;const raw=total*T,r=Math.round(raw);return Math.abs(raw-r)<EPS?Math.max(0,r-1):Math.max(0,Math.floor(raw))}
function fives(avg,n,R,sum){const total=sum!=null?sum:avg*n;if(R>=5)return {need:Infinity,reserve:0};const d=R*n-total;if(d>EPS)return {need:Math.ceil(d/(5-R)-EPS),reserve:0};return {need:0,reserve:R<=1?Infinity:Math.max(0,Math.floor((total-R*n)/(R-1)+EPS))}}
function zoneOf(v,t){if(!isNum(v)||!t)return 'nodata';if(t.good==null||t.bad==null)return 'manual';if(t.lowerIsBetter){if(v<t.good-EPS)return 'good';if(v>t.bad+EPS)return 'bad';return 'normal'}if(v>t.good+EPS)return 'good';if(v<t.bad-EPS)return 'bad';return 'normal'}

async function api(op,{params={},method='GET',body=null,timeout=290000}={}){
  const q=new URLSearchParams({module:'quality',op});
  for(const [k,v] of Object.entries(params))if(v!==''&&v!=null)q.set(k,v);
  const ctrl=new AbortController(),t=setTimeout(()=>ctrl.abort(),timeout);
  try{
    const r=await fetch(API+'?'+q.toString(),{method,cache:'no-store',signal:ctrl.signal,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
    const j=await r.json().catch(()=>({ok:false,error:'Сервер вернул не JSON (HTTP '+r.status+')'}));
    if(!r.ok||j.ok===false)throw new Error(j.error||('HTTP '+r.status));
    return j;
  }catch(e){if(e&&e.name==='AbortError')throw new Error('Сервер не ответил вовремя');throw e}
  finally{clearTimeout(t)}
}

function toast(text,kind='info',ms=4500){const m=$('#gqMsg');if(!m)return;m.textContent=text;m.className='gq-msg show '+kind;clearTimeout(toast.t);if(ms)toast.t=setTimeout(()=>{m.className='gq-msg'},ms)}

function csvDownload(name,rows){
  const text='﻿'+rows.map(r=>r.map(c=>{const s=String(c==null?'':c);return /[;"\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s}).join(';')).join('\n');
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([text],{type:'text/csv;charset=utf-8'}));a.download=name;document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},500);
}

// ---------- styles ----------
function style(){
  if($('#gqCss'))return;
  const s=document.createElement('style');s.id='gqCss';s.textContent=`
:root{--gq-bg:#f5f7fa;--gq-card:#fff;--gq-line:#e4e7ec;--gq-ink:#101828;--gq-mute:#667085;--gq-good:#067647;--gq-good-bg:#ecfdf3;--gq-norm:#b54708;--gq-norm-bg:#fffaeb;--gq-bad:#b42318;--gq-bad-bg:#fef3f2;--gq-info:#175cd3;--gq-info-bg:#eff8ff}
#gbQualityV2{${STANDALONE?'min-height:100vh;':'position:fixed;inset:58px 0 0;z-index:2147483350;display:none;overflow:auto;'}background:var(--gq-bg);font-family:Inter,Arial,sans-serif;color:var(--gq-ink);font-size:14px}
#gbQualityV2 *{box-sizing:border-box}#gbQualityV2 button,#gbQualityV2 input,#gbQualityV2 select,#gbQualityV2 textarea{font:inherit}
.gq-head{position:sticky;top:0;z-index:30;background:#fff;border-bottom:1px solid var(--gq-line);padding:12px 16px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.gq-title{font-size:22px;font-weight:900;line-height:1.1}.gq-sub{font-size:12px;color:var(--gq-mute);margin-top:3px}.gq-sp{flex:1}
.gq-btn{border:1px solid #d0d5dd;background:#fff;border-radius:10px;padding:8px 12px;font-weight:750;cursor:pointer;color:var(--gq-ink);white-space:nowrap}.gq-btn:hover{background:#f9fafb}.gq-btn.dark{background:#111;color:#fff;border-color:#111}.gq-btn.small{padding:5px 9px;font-size:12px}.gq-btn:disabled{opacity:.55;cursor:wait}
.gq-body{max-width:1400px;margin:0 auto;padding:16px}
.gq-msg{display:none;margin-bottom:12px;padding:10px 12px;border-radius:10px;font-size:13px;font-weight:700}.gq-msg.show{display:block}.gq-msg.info{background:var(--gq-info-bg);color:var(--gq-info)}.gq-msg.ok{background:var(--gq-good-bg);color:var(--gq-good)}.gq-msg.warn{background:var(--gq-norm-bg);color:var(--gq-norm)}.gq-msg.err{background:var(--gq-bad-bg);color:var(--gq-bad)}
.gq-filters{display:flex;gap:8px;flex-wrap:wrap;align-items:center;background:#fff;border:1px solid var(--gq-line);border-radius:14px;padding:10px;margin-bottom:12px}
.gq-filters label{font-size:12px;color:var(--gq-mute);font-weight:700;display:flex;gap:6px;align-items:center}
.gq-select,.gq-input{border:1px solid #d0d5dd;border-radius:9px;padding:7px 9px;background:#fff;max-width:100%}
.gq-status{display:flex;gap:12px;align-items:center;flex-wrap:wrap;background:#fff;border:1px solid var(--gq-line);border-radius:14px;padding:12px 14px;margin-bottom:12px}
.gq-levels{display:flex;gap:4px;flex-wrap:wrap}.gq-level{padding:6px 10px;border-radius:999px;font-size:12px;font-weight:800;background:#f2f4f7;color:#98a2b3}.gq-level.on.l0,.gq-level.on.l1{background:var(--gq-bad-bg);color:var(--gq-bad)}.gq-level.on.l2{background:var(--gq-norm-bg);color:var(--gq-norm)}.gq-level.on.l3,.gq-level.on.l4{background:var(--gq-good-bg);color:var(--gq-good)}
.gq-warn{font-size:13px;font-weight:700;color:var(--gq-bad)}
.gq-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;margin-bottom:12px}
.gq-card{background:var(--gq-card);border:1px solid var(--gq-line);border-radius:14px;padding:14px;display:flex;flex-direction:column;gap:8px;border-top:4px solid #d0d5dd}
.gq-card.good{border-top-color:#17b26a}.gq-card.normal{border-top-color:#f79009}.gq-card.bad{border-top-color:#f04438}
.gq-ct{font-size:13px;font-weight:800;color:#344054}.gq-cv{font-size:30px;font-weight:900;line-height:1}.gq-cv small{font-size:13px;color:var(--gq-mute);font-weight:700}
.gq-chip{display:inline-flex;padding:3px 8px;border-radius:999px;font-size:11px;font-weight:800}.gq-chip.good{background:var(--gq-good-bg);color:var(--gq-good)}.gq-chip.normal{background:var(--gq-norm-bg);color:var(--gq-norm)}.gq-chip.bad{background:var(--gq-bad-bg);color:var(--gq-bad)}.gq-chip.nodata,.gq-chip.manual{background:#f2f4f7;color:var(--gq-mute)}.gq-chip.src{background:var(--gq-info-bg);color:var(--gq-info)}
.gq-line{font-size:12px;color:var(--gq-mute);line-height:1.45}.gq-line b{color:var(--gq-ink)}
.gq-delta.up{color:var(--gq-bad);font-weight:800}.gq-delta.down{color:var(--gq-good);font-weight:800}
.gq-scale{position:relative;height:10px;border-radius:6px;overflow:hidden;display:flex;margin:6px 0 2px}.gq-scale span{height:100%}.gq-scale .g{background:#abefc6}.gq-scale .n{background:#fedf89}.gq-scale .b{background:#fecdca}
.gq-scalewrap{position:relative}.gq-marker{position:absolute;top:-3px;width:4px;height:16px;border-radius:2px;background:#101828;transform:translateX(-2px)}
.gq-ticks{display:flex;justify-content:space-between;font-size:10px;color:#98a2b3}
.gq-section{background:#fff;border:1px solid var(--gq-line);border-radius:14px;padding:14px;margin-bottom:12px}
.gq-section h3{margin:0 0 10px;font-size:16px}.gq-section h4{margin:14px 0 8px;font-size:14px}
.gq-recs{display:grid;gap:8px;margin:0;padding:0;list-style:none}.gq-recs li{padding:9px 11px;border-radius:10px;background:#f9fafb;border-left:4px solid #d0d5dd;font-size:13px;line-height:1.45}.gq-recs li.high{border-left-color:#f04438;background:#fffbfa}.gq-recs li.medium{border-left-color:#f79009}
.gq-tablebox{overflow:auto;border:1px solid var(--gq-line);border-radius:12px;-webkit-overflow-scrolling:touch}
.gq-table{width:100%;border-collapse:collapse;font-size:13px;min-width:720px}.gq-table th{position:sticky;top:0;background:#f9fafb;text-align:left;padding:8px 10px;font-size:11px;color:var(--gq-mute);text-transform:uppercase;white-space:nowrap}.gq-table td{padding:8px 10px;border-top:1px solid #f2f4f7;vertical-align:top}.gq-table tr.click{cursor:pointer}.gq-table tr.click:hover td{background:#f9fafb}.gq-table tr.top td{background:#fffbfa}.gq-table tr.top td:first-child{box-shadow:inset 4px 0 0 #f04438}.gq-table .r{text-align:right;white-space:nowrap}
.gq-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.gq-tabs{display:flex;gap:4px;background:#f2f4f7;padding:3px;border-radius:10px;width:max-content;max-width:100%;overflow:auto;margin-bottom:10px}.gq-tabs button{border:0;background:transparent;padding:7px 11px;border-radius:8px;font-weight:800;cursor:pointer;white-space:nowrap}.gq-tabs button.on{background:#111;color:#fff}
.gq-grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}.gq-kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px}.gq-kvi{border:1px solid #eaecf0;border-radius:10px;padding:9px}.gq-kvi small{display:block;font-size:11px;color:var(--gq-mute);font-weight:700}.gq-kvi b{font-size:18px}
.gq-modal *{box-sizing:border-box}.gq-modal{font-family:Inter,Arial,sans-serif;color:var(--gq-ink);font-size:14px;position:fixed;inset:0;z-index:2147483400;background:rgba(16,24,40,.45);display:flex;align-items:flex-start;justify-content:center;padding:24px 12px;overflow:auto}
.gq-dialog{background:#fff;border-radius:16px;max-width:1100px;width:100%;padding:16px;box-shadow:0 20px 50px rgba(16,24,40,.25)}.gq-dialog.narrow{max-width:640px}
.gq-dhead{display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap}.gq-dhead h3{margin:0;font-size:18px;flex:1;min-width:200px}
.gq-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}.gq-form label{font-size:12px;color:var(--gq-mute);font-weight:700;display:flex;flex-direction:column;gap:4px}
.gq-empty{text-align:center;padding:30px 12px;color:var(--gq-mute)}
.gq-chart{width:100%;max-width:900px;height:auto;display:block}
.gq-note{font-size:12px;color:var(--gq-mute);line-height:1.5}
.gq-tag{display:inline-block;font-size:10px;font-weight:800;padding:1px 6px;border-radius:6px;background:#f2f4f7;color:var(--gq-mute);margin-left:4px;vertical-align:middle}.gq-tag.auto{background:#fef0c7;color:#93370d}.gq-tag.multi{background:#e0eaff;color:#3538cd}
@media(max-width:760px){.gq-head{position:static;padding:10px 16px;gap:6px}.gq-head .gq-btn{padding:6px 9px;font-size:12px}.gq-title{font-size:19px}.gq-body{padding:12px 16px}.gq-grid2{grid-template-columns:1fr}.gq-modal{padding:0}.gq-dialog{border-radius:0;min-height:100vh}.gq-cv{font-size:26px}}
`;
  document.head.appendChild(s);
}

// ---------- skeleton ----------
let root=null;
function build(){
  style();
  if(root)return root;
  root=document.createElement('section');root.id='gbQualityV2';root.setAttribute('aria-label','Показатели качества');
  root.innerHTML=`
  <div class="gq-head">
    <div><div class="gq-title">Показатели качества</div><div class="gq-sub" id="gqSub">Kaspi · отмены, задержки, возвраты, рейтинг, чаты</div></div>
    <div class="gq-sp"></div>
    <button class="gq-btn" id="gqRefresh" type="button">↻ Обновить из Kaspi</button>
    <button class="gq-btn" id="gqSnapBtn" type="button">📸 Снимок кабинета</button>
    <button class="gq-btn" id="gqImportBtn" type="button">⬆ Импорт CSV/XLSX</button>
    <button class="gq-btn" id="gqSettingsBtn" type="button">⚙ Настройки</button>
    ${STANDALONE?'<a class="gq-btn" href="/" style="text-decoration:none">← Control Center</a>':'<button class="gq-btn dark" id="gqClose" type="button">Закрыть</button>'}
  </div>
  <div class="gq-body">
    <div id="gqMsg" class="gq-msg" role="status" aria-live="polite"></div>
    <div class="gq-filters">
      <label>Период <select id="gqDays" class="gq-select"><option value="7">7 дней</option><option value="14">14 дней</option><option value="30" selected>30 дней (как Kaspi)</option><option value="90">90 дней</option></select></label>
      <label>Бренд <select id="gqBrand" class="gq-select"><option value="">Все бренды</option></select></label>
      <label>Категория <select id="gqCat" class="gq-select"><option value="">Все категории</option></select></label>
      <label>На дату <input id="gqAsOf" class="gq-input" type="date"></label>
      <span class="gq-sp"></span><span class="gq-note" id="gqData"></span>
    </div>
    <div id="gqMain"><div class="gq-empty">Загрузка…</div></div>
  </div>`;
  if(STANDALONE)document.body.appendChild(root);else document.body.appendChild(root);
  $('#gqRefresh',root).onclick=()=>refreshLoop(true);
  $('#gqSnapBtn',root).onclick=openSnapshot;
  $('#gqImportBtn',root).onclick=openImport;
  $('#gqSettingsBtn',root).onclick=openSettings;
  if(!STANDALONE)$('#gqClose',root).onclick=close;
  $('#gqDays',root).onchange=e=>{S.days=Number(e.target.value)||30;load()};
  $('#gqBrand',root).onchange=e=>{S.brand=e.target.value;load()};
  $('#gqCat',root).onchange=e=>{S.category=e.target.value;load()};
  $('#gqAsOf',root).onchange=e=>{S.asOf=e.target.value;load()};
  return root;
}

// ---------- data ----------
async function load({quiet=false}={}){
  const seq=++S.seq;S.loading=true;
  if(!quiet&&!S.data)$('#gqMain').innerHTML='<div class="gq-empty">Загрузка данных…</div>';
  try{
    const d=await api('dashboard',{params:{days:S.days,brand:S.brand,category:S.category,asOf:S.asOf}});
    if(seq!==S.seq)return;
    S.data=d;render();
    if(d.dataset&&d.dataset.refreshing)toast('Данные старше часа или загружены не полностью — сервер обновляет их в фоне. Обновлю экран через минуту.','info',8000),scheduleReload(60000);
  }catch(e){if(seq===S.seq){toast('Не удалось загрузить показатели: '+e.message,'err',0);if(!S.data)$('#gqMain').innerHTML='<div class="gq-empty">Ошибка загрузки. '+esc(e.message)+'</div>'}}
  finally{if(seq===S.seq)S.loading=false}
}
function scheduleReload(ms){clearTimeout(S.reloadT);S.reloadT=setTimeout(()=>{if(S.open||STANDALONE)load({quiet:true})},ms)}

async function refreshLoop(forceList){
  if(S.refreshing)return;S.refreshing=true;const b=$('#gqRefresh');b.disabled=true;
  try{
    for(let step=1;step<=12;step++){
      b.textContent='↻ Загрузка из Kaspi… шаг '+step;
      toast('Загружаю заказы из Kaspi (окна по 14 дней, все страницы). Шаг '+step+' — до 4 минут.','info',0);
      const r=await api('refresh',{method:'POST',body:{forceList:step===1&&!!forceList}});
      if(r.busy){toast('Обновление уже идёт на сервере. Обновлю экран через 30 секунд.','info',8000);await new Promise(x=>setTimeout(x,30000));await load({quiet:true});if(S.data&&S.data.dataset&&S.data.dataset.complete)break;continue}
      const errs=(r.listErrors||[]).length?' Ошибки списков: '+r.listErrors.join('; '):'';
      toast('Заказов: '+cnt(r.orders)+'; загружено составов: '+cnt(r.itemsLoaded)+'; осталось: '+cnt(r.itemsRemaining)+'.'+(r.persisted?'':' ⚠ '+(r.persistError||'не сохранено в таблицу'))+errs,r.complete?'ok':'info',r.complete?6000:0);
      await load({quiet:true});
      if(r.complete)break;
    }
  }catch(e){toast('Ошибка загрузки из Kaspi: '+e.message,'err',0)}
  finally{S.refreshing=false;b.disabled=false;b.textContent='↻ Обновить из Kaspi'}
}

// ---------- rendering ----------
function threshold(key){return S.data&&S.data.config&&S.data.config.thresholds?S.data.config.thresholds[key]:null}
function snapPair(key){const s=S.data&&S.data.snapshot;return s&&s[key]&&s[key].total?s[key]:null}

function scaleHtml(key,value){
  const t=threshold(key);if(!t||t.good==null||!isNum(value))return '';
  let min,max;
  if(t.lowerIsBetter){min=0;max=Math.max(t.bad*1.6,value*1.15)}else{min=Math.min(3,value-0.1);max=5}
  const w=x=>Math.max(0,Math.min(100,(x-min)/(max-min)*100));
  const segs=t.lowerIsBetter?[['g',w(t.good)-w(min)],['n',w(t.bad)-w(t.good)],['b',100-w(t.bad)]]:[['b',w(t.bad)],['n',w(t.good)-w(t.bad)],['g',100-w(t.good)]];
  const fmt=x=>t.lowerIsBetter?pct(x,0):num(x,1);
  return '<div class="gq-scalewrap"><div class="gq-scale">'+segs.map(([c,p])=>'<span class="'+c+'" style="width:'+p+'%"></span>').join('')+'</div><div class="gq-marker" style="left:'+w(value)+'%" title="'+esc(fmt(value))+'"></div></div><div class="gq-ticks"><span>'+fmt(min)+'</span><span>'+(t.lowerIsBetter?'хорошо &lt;'+fmt(t.good)+' · плохо &gt;'+fmt(t.bad):'плохо &lt;'+fmt(t.bad)+' · хорошо &gt;'+fmt(t.good))+'</span><span>'+fmt(max)+'</span></div>';
}

function sparkline(key){
  const h=(S.data.history||[]).filter(r=>r[key]&&isNum(r[key].value)).slice(-30);
  if(h.length<2)return '';
  const vals=h.map(r=>r[key].value),max=Math.max(...vals)*1.1||1,W=120,H=26;
  const pts=vals.map((v,i)=>(i/(vals.length-1)*W).toFixed(1)+','+(H-v/max*H).toFixed(1)).join(' ');
  return '<svg width="'+W+'" height="'+H+'" viewBox="0 0 '+W+' '+H+'" aria-label="История по дням"><polyline fill="none" stroke="#667085" stroke-width="1.5" points="'+pts+'"/></svg>';
}

function cardOrder(key){
  const m=S.data.metrics&&S.data.metrics[key];const snap=snapPair(key);const w=S.data.window||{};
  const official=snap?snap.bad/snap.total:null;
  const value=official!=null?official:(m?m.value:null);
  const z=zoneOf(value,threshold(key));
  const delta=m&&isNum(m.weekDelta)?'<span class="gq-delta '+(m.weekDelta>0.0001?'up':m.weekDelta<-0.0001?'down':'')+'">'+(m.weekDelta>0.0001?'▲ ':m.weekDelta<-0.0001?'▼ ':'')+pp(m.weekDelta)+' за неделю</span>':'';
  const unknown=key==='returns'&&m&&m.unknown?'<div class="gq-line">⚠ Ещё '+cnt(m.unknown)+' возврат(ов) без причины («причина неизвестна»): верхняя граница '+pct(m.upperBound,2)+'. Загрузите CSV возвратов.</div>':'';
  return '<div class="gq-card '+z+'"><div class="gq-ct">'+esc(TITLES[key])+'</div>'+
    '<div><span class="gq-cv">'+pct(value,1)+'</span> <span class="gq-chip '+z+'">'+ZONE_LABEL[z]+'</span> '+(official!=null?'<span class="gq-chip src">кабинет '+esc(dm(S.data.snapshot.date))+'</span>':'<span class="gq-chip src">расчёт по API</span>')+'</div>'+
    (official!=null?'<div class="gq-line">Кабинет: <b>'+cnt(snap.bad)+' из '+cnt(snap.total)+'</b> на '+esc(dmy(S.data.snapshot.date))+'</div>':'')+
    (m?'<div class="gq-line">Наш расчёт: <b>'+cnt(m.bad)+' из '+cnt(m.total)+'</b> = <b>'+pct(m.value,2)+'</b> с '+esc(dm(w.fromDay))+' по '+esc(dm(w.toDay))+' '+delta+'</div>':'<div class="gq-line">Нет данных API</div>')+
    unknown+scaleHtml(key,value)+
    '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:auto">'+sparkline(key)+'<button class="gq-btn small" type="button" data-why="'+key+'">Почему? →</button></div></div>';
}

function cardRating(){
  const r=S.data.manual&&S.data.manual.rating;
  if(!r)return '<div class="gq-card"><div class="gq-ct">Рейтинг</div><div class="gq-cv">—</div><div class="gq-line">Shop API не отдаёт отзывы и рейтинг. Введите значение из кабинета в «Снимок кабинета» или загрузите выгрузку отзывов.</div><button class="gq-btn small" type="button" data-open="snap">Ввести снимок</button></div>';
  const z=zoneOf(r.average,threshold('rating'));
  return '<div class="gq-card '+z+'"><div class="gq-ct">Рейтинг</div><div><span class="gq-cv">'+num(r.average,r.source==='import'?2:1)+'</span> <span class="gq-chip '+z+'">'+ZONE_LABEL[z]+'</span> <span class="gq-chip src">'+(r.source==='snapshot'?'кабинет':'импорт отзывов')+'</span></div><div class="gq-line"><b>'+cnt(r.count)+'</b> оценок с '+esc(dm(r.from))+' по '+esc(dm(r.to))+' (90 дней)</div>'+scaleHtml('rating',r.average)+'<div style="display:flex;justify-content:flex-end;margin-top:auto"><button class="gq-btn small" type="button" data-why="rating">Почему? →</button></div></div>';
}

function cardChats(kind){
  const c=S.data.manual&&S.data.manual.chats;
  const title=TITLES[kind];
  if(!c)return '<div class="gq-card"><div class="gq-ct">'+title+'</div><div class="gq-cv">—</div><div class="gq-line">Чатов в Shop API нет — только ручной ввод из кабинета.</div><button class="gq-btn small" type="button" data-open="snap">Ввести снимок</button></div>';
  if(kind==='chatTime')return '<div class="gq-card"><div class="gq-ct">'+title+'</div><div><span class="gq-cv">'+(isNum(c.avgMinutes)?cnt(c.avgMinutes)+' <small>мин</small>':'—')+'</span> <span class="gq-chip manual">ручной ввод</span></div><div class="gq-line">По чатам с ответом · снимок '+esc(dmy(c.to))+'</div></div>';
  return '<div class="gq-card"><div class="gq-ct">'+title+'</div><div><span class="gq-cv">'+pct(c.value,0)+'</span> <span class="gq-chip manual">ручной ввод</span></div><div class="gq-line"><b>'+cnt(c.answered)+' из '+cnt(c.total)+'</b> чатов с ответом · снимок '+esc(dmy(c.to))+'</div><div style="display:flex;justify-content:flex-end;margin-top:auto"><button class="gq-btn small" type="button" data-why="chats">Почему? →</button></div></div>';
}

function overall(){
  const zones=[];const m=S.data.metrics||{};
  for(const k of ORDER_METRICS){const snap=snapPair(k);const v=snap?snap.bad/snap.total:m[k]&&m[k].value;zones.push(zoneOf(v,threshold(k)))}
  const r=S.data.manual&&S.data.manual.rating;if(r)zones.push(zoneOf(r.average,threshold('rating')));
  const list=zones.filter(z=>['good','normal','bad'].includes(z));if(!list.length)return null;
  const bads=list.filter(z=>z==='bad').length,normals=list.filter(z=>z==='normal').length;
  const cv=snapPair('cancels'),cancel=cv?cv.bad/cv.total:m.cancels&&m.cancels.value;
  const veryBad=isNum(cancel)&&cancel>=0.1;
  return veryBad||bads>=2?0:bads===1?1:normals>=2?2:normals===1?3:4;
}

function render(){
  const d=S.data;if(!d)return;
  // facets
  const fill=(sel,list,cur,all)=>{const e=$(sel);if(!e)return;const items=(list||[]).slice(0,400);e.innerHTML='<option value="">'+all+'</option>'+items.map(x=>'<option value="'+esc(x.name)+'"'+(x.name===cur?' selected':'')+'>'+esc(x.name)+' ('+cnt(x.count)+')</option>').join('')+(cur&&!items.some(x=>x.name===cur)?'<option selected value="'+esc(cur)+'">'+esc(cur)+'</option>':'')};
  if(d.facets){fill('#gqBrand',d.facets.brands,S.brand,'Все бренды');fill('#gqCat',d.facets.categories,S.category,'Все категории')}
  const ds=d.dataset;
  $('#gqData').textContent=ds?('Данные Kaspi: '+cnt(ds.orders)+' заказов, обновлено '+almaty(ds.updatedAt)+(ds.complete?'':' · составов ещё не загружено: '+cnt(ds.itemsRemaining))+(ds.refreshing?' · обновляется…':'')):'';
  const w=d.window;
  $('#gqSub').textContent=w?('Окно '+S.days+' дн.: '+dmy(w.fromDay)+' — '+dmy(w.toDay)+' · рейтинг: 90 дней · Asia/Almaty'):'Kaspi · отмены, задержки, возвраты, рейтинг, чаты';
  if(d.empty){
    $('#gqMain').innerHTML='<div class="gq-section gq-empty"><h3>Данных из Kaspi пока нет</h3><p>'+esc(d.hint||'')+'</p><p class="gq-note">Рейтинг и чаты в Shop API отсутствуют — их можно ввести вручную в «Снимок кабинета» уже сейчас.</p><button class="gq-btn dark" type="button" id="gqFirstLoad">↻ Загрузить из Kaspi</button></div>'+manualOnly();
    $('#gqFirstLoad').onclick=()=>refreshLoop(true);bindCards();return;
  }
  const level=overall();
  const worse=ORDER_METRICS.filter(k=>d.metrics[k]&&isNum(d.metrics[k].weekDelta)&&d.metrics[k].weekDelta>0.001);
  let html='<div class="gq-status"><b>Общий статус:</b><div class="gq-levels">'+STATUS_LEVELS.map((l,i)=>'<span class="gq-level l'+i+(i===level?' on':'')+'">'+l+'</span>').join('')+'</div>'+
    (worse.length?'<span class="gq-warn">⚠ Ухудшается за неделю: '+worse.map(k=>esc(TITLES[k])+' ('+pp(d.metrics[k].weekDelta)+')').join(', ')+'</span>':'<span class="gq-note">За неделю показатели не ухудшились.</span>')+
    '<span class="gq-note">Статус: по официальным цифрам последнего снимка кабинета, где их нет — по расчёту API.</span></div>';
  html+='<div class="gq-cards">'+cardRating()+cardOrder('delays')+cardOrder('returns')+cardOrder('cancels')+cardChats('chats')+cardChats('chatTime')+'</div>';
  html+='<div id="gqDetail"></div>';
  html+=recsHtml()+calibHtml()+reasonsHtml();
  $('#gqMain').innerHTML=html;
  bindCards();bindReasons();
  if(S.detail)renderDetail();
}

function manualOnly(){return '<div class="gq-cards">'+cardRating()+cardChats('chats')+cardChats('chatTime')+'</div><div id="gqDetail"></div>'}

function bindCards(){
  root.querySelectorAll('[data-why]').forEach(b=>b.onclick=()=>{S.detail=b.dataset.why;renderDetail();const el=$('#gqDetail');if(el)el.scrollIntoView({behavior:'smooth',block:'start'})});
  root.querySelectorAll('[data-open="snap"]').forEach(b=>b.onclick=openSnapshot);
}

function recsHtml(){
  const r=S.data.recommendations||[];
  return '<div class="gq-section"><h3>Рекомендации</h3>'+(r.length?'<ul class="gq-recs">'+r.map(x=>'<li class="'+esc(x.severity)+'">'+esc(x.text)+'</li>').join('')+'</ul>':'<div class="gq-note">Явных проблем по данным нет.</div>')+'</div>';
}

function calibHtml(){
  const c=S.data.calibration;if(!c||!c.rows||!c.rows.length)return '';
  const snap=S.data.snapshot;
  const rows=c.rows.map(r=>'<tr><td><b>'+esc(r.label)+'</b></td><td class="r">'+cnt(r.ours.bad)+' / '+cnt(r.ours.total)+' = <b>'+pct(r.ours.value,2)+'</b>'+(r.ours.unknown?'<div class="gq-note">+'+cnt(r.ours.unknown)+' без причины (до '+pct(r.ours.upperBound,2)+')</div>':'')+'</td><td class="r">'+cnt(r.cabinet.bad)+' / '+cnt(r.cabinet.total)+' = <b>'+pct(r.cabinet.value,2)+'</b></td><td class="r">'+pp(r.diff)+'<div class="gq-note">плохих '+(r.diffBad>0?'+':'')+cnt(r.diffBad)+' · заказов '+(r.diffTotal>0?'+':'')+cnt(r.diffTotal)+'</div></td></tr>').join('');
  return '<div class="gq-section"><h3>Расхождение с кабинетом</h3><div class="gq-note" style="margin-bottom:8px">Снимок: '+esc(dmy(snap.date))+' ('+esc(snap.source||'')+'). Наш расчёт за то же окно: '+esc(dmy(c.window.fromDay))+' — '+esc(dmy(c.window.toDay))+'. Официальная цифра — кабинет; наш расчёт нужен для детализации.</div>'+
  '<div class="gq-tablebox"><table class="gq-table"><thead><tr><th>Метрика</th><th class="r">Наше (API)</th><th class="r">Кабинет</th><th class="r">Разница</th></tr></thead><tbody>'+rows+'</tbody></table></div>'+
  '<h4>Почему цифры могут расходиться</h4><ul class="gq-note" style="margin:0;padding-left:18px">'+
  '<li><b>Отмены:</b> числитель — заказы со статусом CANCELLED/CANCELLING и причиной из списка «вина продавца» (настраивается ниже). Знаменатель — '+(S.data.config.cancelDenominator==='all'?'все созданные заказы':'завершённые заказы (ARCHIVE): у кабинета 2111 ≈ числу архивных заказов за окно')+'. Kaspi может относить заказ к окну по дате отмены, а не по дате создания.</li>'+
  '<li><b>Возвраты:</b> знаменатель — выданные (COMPLETED) + возвращённые заказы; совпадает с кабинетом. Причину возврата API не отдаёт: «по качеству» считаются только возвраты с причиной из CSV-импорта, остальные — «причина неизвестна».</li>'+
  '<li><b>Задержки:</b> заказы Kaspi Доставки с наступившей плановой датой передачи (courierTransmissionPlanningDate); задержка — courierTransmissionDate позже плана или передачи нет. Если API не вернул дату передачи у выданного заказа, он не считается (см. покрытие ниже).</li>'+
  delayDiagHtml()+'<li>Покрытие окна: заказов '+cnt(c.coverage.orders)+', Kaspi Доставка '+cnt(c.coverage.kdTotal)+' (с датой передачи '+cnt(c.coverage.kdWithTransfer)+', без плановой даты '+cnt(c.coverage.kdWithoutPlan)+'), без загруженного состава '+cnt(c.coverage.missingItems)+'.</li></ul></div>';
}

function delayDiagHtml(){
  const x=S.data.delayStats;if(!x)return '';const b=x.buckets||{};
  return '<li><b>Диагностика задержек ('+esc(dm(S.data.window.fromDay))+'–'+esc(dm(S.data.window.toDay))+'):</b> заказов КД с датой передачи '+cnt(x.withTransfer)+'; факт − план: раньше более чем на сутки '+cnt(b.early24)+', раньше до суток '+cnt(b.early0_24)+', ровно в план '+cnt(b.onTime)+', позже до 1 ч '+cnt(b.late0_1)+', позже на 1–24 ч '+cnt(b.late1_24)+', позже более чем на сутки '+cnt(b.late24)+'. План переносился (по нашим наблюдениям) у '+cnt(x.planMoved)+'; не переданы при прошедшей дате '+cnt(x.overdueNoTransfer)+'.</li>';
}

function reasonsHtml(){
  const list=S.data.cancellationReasons||[];
  const st=S.data.statuses||{};
  return '<div class="gq-section"><h3>Сырые причины отмен (cancellationReason) — разметка «наша вина»</h3><div class="gq-note" style="margin-bottom:8px">Отметьте, какие причины считать виной продавца, и нажмите «Сохранить разметку». Окно: '+esc(dmy(S.data.window.fromDay))+' — '+esc(dmy(S.data.window.toDay))+'.</div>'+
  (list.length?'<div class="gq-tablebox"><table class="gq-table" style="min-width:520px"><thead><tr><th>Наша вина</th><th>Код Kaspi</th><th>Расшифровка</th><th class="r">Заказов</th></tr></thead><tbody>'+list.map(r=>'<tr><td><input type="checkbox" data-reason="'+esc(r.code)+'"'+(r.sellerFault?' checked':'')+'></td><td class="gq-mono">'+esc(r.code)+'</td><td>'+esc(r.label||'')+'</td><td class="r">'+cnt(r.count)+'</td></tr>').join('')+'</tbody></table></div><div style="margin-top:8px"><button class="gq-btn dark" type="button" id="gqSaveReasons">Сохранить разметку</button></div>':'<div class="gq-note">Отмен в окне нет.</div>')+
  '<h4>Статусы заказов в окне</h4><div class="gq-note">'+Object.entries(st).sort((a,b)=>b[1]-a[1]).map(([k,v])=>'<span class="gq-mono">'+esc(k)+'</span>: '+cnt(v)).join(' · ')+'</div></div>';
}

function bindReasons(){
  const b=$('#gqSaveReasons');if(!b)return;
  b.onclick=async()=>{
    const cfg=S.data.config;const known=new Set((S.data.cancellationReasons||[]).map(r=>r.code));
    const checked=[...root.querySelectorAll('[data-reason]')].filter(x=>x.checked).map(x=>x.dataset.reason);
    const keep=(cfg.sellerFaultReasons||[]).filter(r=>!known.has(r));
    b.disabled=true;
    try{const r=await api('settings',{method:'POST',body:{...cfg,sellerFaultReasons:[...keep,...checked]}});toast('Разметка сохранена'+(r.warning?' (⚠ '+r.warning+')':''),'ok');await load({quiet:true})}catch(e){toast('Не удалось сохранить: '+e.message,'err')}finally{b.disabled=false}
  };
}

// ---------- detail («Почему?») ----------
function targetFor(key){
  if(S.targets[key]!=null)return S.targets[key];
  const t=threshold(key);const custom=S.data.config&&S.data.config.customTargets&&S.data.config.customTargets[key];
  return custom||(t&&t.good)||null;
}

function targetControls(key,isRate){
  const t=threshold(key)||{};const cur=targetFor(key);
  const opts=[];if(t.good!=null)opts.push([t.good,'граница «хорошо» '+(isRate?pct(t.good,0):num(t.good,1))]);if(t.bad!=null)opts.push([t.bad,'граница «плохо» '+(isRate?pct(t.bad,0):num(t.bad,1))]);
  return '<div class="gq-filters" style="margin:0 0 10px"><label>Цель <select class="gq-select" data-target-sel="'+key+'">'+opts.map(([v,l])=>'<option value="'+v+'"'+(Math.abs(v-cur)<EPS?' selected':'')+'>'+l+'</option>').join('')+'<option value="custom"'+(opts.some(([v])=>Math.abs(v-cur)<EPS)?'':' selected')+'>своя цель</option></select></label><label>Своя цель <input class="gq-input" style="width:110px" data-target-inp="'+key+'" inputmode="decimal" value="'+(isRate?num(cur*100,2):num(cur,2))+'">'+(isRate?'%':'★')+'</label></div>';
}

function bindTarget(key,isRate){
  const sel=root.querySelector('[data-target-sel="'+key+'"]'),inp=root.querySelector('[data-target-inp="'+key+'"]');
  if(sel)sel.onchange=()=>{if(sel.value!=='custom'){S.targets[key]=Number(sel.value);renderDetail()}else inp.focus()};
  if(inp)inp.onchange=()=>{const v=Number(String(inp.value).replace(',','.'));if(v>0){S.targets[key]=isRate?v/100:v;renderDetail()}};
}

function renderDetail(){
  const box=$('#gqDetail');if(!box||!S.detail)return;const key=S.detail;
  if(key==='rating')return renderRatingDetail(box);
  if(key==='chats')return renderChatsDetail(box);
  const m=S.data.metrics&&S.data.metrics[key];
  if(!m){box.innerHTML='';return}
  const T=targetFor(key);
  const N=cleanNeeded(m.bad,m.total,T,false),Ns=cleanNeeded(m.bad,m.total,T,true),bm=badMax(m.total,T),days=S.days;
  const rows=(S.data.details[key]||{})[S.dim]||[];
  const reach=(m.forecast.series||[]).find(p=>isNum(p.value)&&p.value<T-EPS);
  box.innerHTML='<div class="gq-section"><div class="gq-dhead"><h3>Почему: '+esc(TITLES[key])+' — '+pct(m.value,2)+' ('+cnt(m.bad)+' из '+cnt(m.total)+')</h3><button class="gq-btn small" type="button" id="gqDetailClose">Свернуть ✕</button></div>'+
  '<div class="gq-tabs">'+ORDER_METRICS.map(k=>'<button type="button" data-detail="'+k+'" class="'+(k===key?'on':'')+'">'+esc(TITLES[k])+'</button>').join('')+'</div>'+
  '<h4>Что тянет показатель вниз</h4><div class="gq-tabs">'+DIMS.map(([k,l])=>'<button type="button" data-dim="'+k+'" class="'+(k===S.dim?'on':'')+'">'+l+'</button>').join('')+'</div>'+
  '<div class="gq-note" style="margin-bottom:6px">Вклад = плохие события группы / все заказы магазина (п.п.); доля в проблеме = плохие группы / все плохие. Заказ с несколькими позициями засчитывается каждому SKU <span class="gq-tag multi">несколько SKU</span>, поэтому сумма долей может быть больше 100%. Топ-5 виновников подсвечены. Клик по строке — список заказов.</div>'+
  breakdownTable(key,rows,m)+
  '<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap"><button class="gq-btn small" type="button" id="gqExport">⬇ Экспорт таблицы CSV</button><button class="gq-btn small" type="button" id="gqAllOrders">Все плохие заказы ('+cnt(m.bad+(m.unknown||0))+')</button></div>'+
  '<h4>Калькулятор</h4>'+targetControls(key,true)+
  '<div class="gq-kv">'+
   kv('Нужно чистых заказов сверху',cnt(N),'до '+pct(T,2)+' ровно; строго ниже — '+cnt(Ns))+
   kv('Допустимо плохих при текущем объёме','≤ '+cnt(bm),'сейчас '+cnt(m.bad)+(m.bad>bm?' → убрать '+cnt(m.bad-bm):' → запас '+cnt(bm-m.bad)))+
   kv('В день',num(m.total/days,1)+' заказов','допустимо '+num(bm/days,2)+' плохих/день')+
   kv('Выход в цель без новых нарушений',m.value!=null&&m.value<T-EPS?'уже в цели':reach?almatyDay(reach.at):'> 30 дней',reach&&reach.day>0?'через '+reach.day+' дн. при текущем темпе продаж':'')+
  '</div>'+forecastChart(m,T)+dropouts(m)+
  '</div>';
  box.querySelectorAll('[data-detail]').forEach(b=>b.onclick=()=>{S.detail=b.dataset.detail;renderDetail()});
  box.querySelectorAll('[data-dim]').forEach(b=>b.onclick=()=>{S.dim=b.dataset.dim;renderDetail()});
  $('#gqDetailClose').onclick=()=>{S.detail=null;box.innerHTML=''};
  box.querySelectorAll('tr[data-key]').forEach(tr=>tr.onclick=()=>openOrders(key,S.dim,tr.dataset.key,tr.dataset.label));
  $('#gqAllOrders').onclick=()=>openOrders(key,'',null,'все плохие заказы');
  $('#gqExport').onclick=()=>csvDownload('kachestvo-'+key+'-'+S.dim+'-'+(S.data.window.toDay)+'.csv',[[DIMS.find(d=>d[0]===S.dim)[1],'Название','Заказы','Плохие','Доля %','Вклад п.п.','Доля в проблеме %','Плохих 7д','Плохих пред. 7д','Доля 7д %','Доля пред. 7д %','Без группы показатель %','Из них в заказах с несколькими SKU','Бренд авто']].concat(rows.map(r=>[r.key,r.label,r.orders,r.bad,isNum(r.rate)?(r.rate*100).toFixed(2):'',(r.contribution*100).toFixed(3),(r.share*100).toFixed(1),r.trend.last7Bad,r.trend.prev7Bad,isNum(r.trend.last7)?(r.trend.last7*100).toFixed(2):'',isNum(r.trend.prev7)?(r.trend.prev7*100).toFixed(2):'',isNum(r.whatIf)?(r.whatIf*100).toFixed(2):'',r.multiBad,r.auto?'да':''])));
  bindTarget(key,true);
}

function kv(label,value,sub){return '<div class="gq-kvi"><small>'+esc(label)+'</small><b>'+esc(value)+'</b>'+(sub?'<div class="gq-note">'+esc(sub)+'</div>':'')+'</div>'}

function trendCell(r){
  const a=r.trend.last7,b=r.trend.prev7;
  const arrow=isNum(a)&&isNum(b)?(a>b+EPS?'<span class="gq-delta up">▲</span>':a<b-EPS?'<span class="gq-delta down">▼</span>':'='):'';
  return arrow+' '+cnt(r.trend.last7Bad)+' vs '+cnt(r.trend.prev7Bad)+'<div class="gq-note">'+pct(a,1)+' vs '+pct(b,1)+'</div>';
}

function breakdownTable(key,rows,m){
  if(!rows.length)return '<div class="gq-empty">Нет заказов в окне.</div>';
  const view=rows.filter(r=>r.bad>0).concat(rows.filter(r=>!r.bad).slice(0,50));
  return '<div class="gq-tablebox" style="max-height:520px"><table class="gq-table"><thead><tr><th>'+esc(DIMS.find(d=>d[0]===S.dim)[1])+'</th><th class="r">Заказы</th><th class="r">Плохие</th><th class="r">Доля</th><th class="r">Вклад</th><th class="r">Доля в проблеме</th><th class="r">Тренд 7д / пред. 7д</th><th class="r">Если убрать</th></tr></thead><tbody>'+
  view.map(r=>'<tr class="click'+(r.top?' top':'')+'" data-key="'+esc(r.key)+'" data-label="'+esc(r.label)+'"><td>'+(S.dim==='sku'?'<div class="gq-mono">'+esc(r.key)+'</div><div class="gq-note">'+esc(r.label)+'</div>':esc(r.label))+(r.auto?'<span class="gq-tag auto" title="Бренд определён по первому слову названия">авто</span>':'')+(r.source==='manual'?'<span class="gq-tag">вручную</span>':'')+(r.multiBad?'<span class="gq-tag multi" title="Плохие заказы с несколькими SKU">'+cnt(r.multiBad)+' мульти</span>':'')+'</td><td class="r">'+cnt(r.orders)+'</td><td class="r"><b>'+cnt(r.bad)+'</b></td><td class="r">'+pct(r.rate,1)+'</td><td class="r"><b>'+num(r.contribution*100,2)+' п.п.</b></td><td class="r">'+pct(r.share,0)+'</td><td class="r">'+trendCell(r)+'</td><td class="r" title="Общий показатель, если эта группа перестанет давать плохие события">'+pct(r.whatIf,2)+'</td></tr>').join('')+
  '</tbody></table></div>'+(rows.length>view.length?'<div class="gq-note">Показаны группы с плохими событиями и 50 крупнейших без них; полный список — в экспорте CSV.</div>':'');
}

function forecastChart(m,T){
  const s=(m.forecast&&m.forecast.series)||[];if(s.length<2)return '';
  const W=640,H=200,P={l:44,r:12,t:12,b:26};
  const vals=s.map(p=>isNum(p.value)?p.value:0);const max=Math.max(T*1.4,...vals)*1.1||0.01;
  const x=i=>P.l+i/(s.length-1)*(W-P.l-P.r),y=v=>P.t+(1-v/max)*(H-P.t-P.b);
  const pts=s.map((p,i)=>x(i).toFixed(1)+','+y(vals[i]).toFixed(1)).join(' ');
  let grid='';for(let k=0;k<=4;k++){const v=max*k/4;grid+='<line x1="'+P.l+'" x2="'+(W-P.r)+'" y1="'+y(v)+'" y2="'+y(v)+'" stroke="#eaecf0"/><text x="'+(P.l-6)+'" y="'+(y(v)+4)+'" text-anchor="end" font-size="10" fill="#667085">'+(v*100).toFixed(1)+'%</text>'}
  let xl='';s.forEach((p,i)=>{if(i%5===0)xl+='<text x="'+x(i)+'" y="'+(H-8)+'" text-anchor="middle" font-size="10" fill="#667085">'+almatyDay(p.at)+'</text>'});
  const dots=s.map((p,i)=>'<circle cx="'+x(i)+'" cy="'+y(vals[i])+'" r="3" fill="'+(vals[i]<T-EPS?'#17b26a':'#f04438')+'"><title>'+almatyDay(p.at)+': '+pct(p.value,2)+' ('+p.bad+' из '+p.total+')</title></circle>').join('');
  return '<h4>Прогноз на 30 дней (без новых нарушений, текущий темп продаж)</h4><svg class="gq-chart" viewBox="0 0 '+W+' '+H+'" role="img" aria-label="Прогноз показателя">'+grid+'<line x1="'+P.l+'" x2="'+(W-P.r)+'" y1="'+y(T)+'" y2="'+y(T)+'" stroke="#101828" stroke-dasharray="5 4"/><text x="'+(W-P.r)+'" y="'+(y(T)-4)+'" text-anchor="end" font-size="10" fill="#101828">цель '+pct(T,2)+'</text><polyline fill="none" stroke="#2a78d6" stroke-width="2" points="'+pts+'"/>'+dots+xl+'</svg>';
}

function dropouts(m){
  const list=(m.forecast&&m.forecast.dropouts)||[];if(!list.length)return '';
  const byDay=new Map();for(const d of list){const k=almatyDay(d.leavesAt);byDay.set(k,(byDay.get(k)||0)+1)}
  return '<h4>Когда плохие события выпадут из окна</h4><div class="gq-note">'+[...byDay.entries()].slice(0,40).map(([d,c])=>'<b>'+d+'</b>: −'+c).join(' · ')+(byDay.size>40?' …':'')+'</div>';
}

function renderRatingDetail(box){
  const r=S.data.manual&&S.data.manual.rating;
  if(!r){box.innerHTML='<div class="gq-section"><h3>Рейтинг</h3><div class="gq-note">Нет данных: введите снимок кабинета или загрузите отзывы.</div></div>';return}
  const R=targetFor('rating');const f=fives(r.average,r.count,R,r.source==='import'?r.sum:null);
  box.innerHTML='<div class="gq-section"><div class="gq-dhead"><h3>Рейтинг '+num(r.average,2)+' ('+cnt(r.count)+' оценок)</h3><button class="gq-btn small" type="button" id="gqDetailClose">Свернуть ✕</button></div>'+targetControls('rating',false)+
  '<div class="gq-kv">'+(f.need>0?kv('Нужно пятёрок до цели',cnt(f.need),'k = ceil((R·n − сумма) / (5 − R))'):kv('Запас','выдержит '+cnt(f.reserve)+' единиц','до падения ниже '+num(R,2)))+kv('Окно','90 дней',dmy(r.from)+' — '+dmy(r.to))+'</div>'+
  (r.source==='snapshot'?'<p class="gq-note">Сумма оценок оценена как среднее × количество (кабинет показывает округлённое среднее), поэтому результат приблизительный. Точный расчёт — по импорту отзывов.</p>':'')+'</div>';
  $('#gqDetailClose').onclick=()=>{S.detail=null;box.innerHTML=''};bindTarget('rating',false);
}

function renderChatsDetail(box){
  const c=S.data.manual&&S.data.manual.chats;
  if(!c){box.innerHTML='';return}
  if(S.targets.chats==null)S.targets.chats=(S.data.config.customTargets&&S.data.config.customTargets.chats)||0.5;
  const T=S.targets.chats;const need=Math.max(0,Math.ceil(T*c.total-c.answered-EPS));
  box.innerHTML='<div class="gq-section"><div class="gq-dhead"><h3>Чаты: '+pct(c.value,0)+' ('+cnt(c.answered)+' из '+cnt(c.total)+')</h3><button class="gq-btn small" type="button" id="gqDetailClose">Свернуть ✕</button></div>'+
  '<div class="gq-filters" style="margin:0 0 10px"><label>Цель, % <input class="gq-input" style="width:90px" id="gqChatT" inputmode="decimal" value="'+num(T*100,0)+'"></label></div><div class="gq-kv">'+kv('Нужно чатов с ответом',cnt(need),'ceil(T × всего − отвечено)')+kv('Среднее время ответа',isNum(c.avgMinutes)?cnt(c.avgMinutes)+' мин':'—','ручной ввод')+'</div><p class="gq-note">Чатов в Shop API нет: данные — из последнего снимка кабинета.</p></div>';
  $('#gqDetailClose').onclick=()=>{S.detail=null;box.innerHTML=''};
  $('#gqChatT').onchange=e=>{const v=Number(String(e.target.value).replace(',','.'));if(v>0){S.targets.chats=v/100;renderChatsDetail(box)}};
}

// ---------- modals ----------
function modal(html,narrow){
  const m=document.createElement('div');m.className='gq-modal';m.innerHTML='<div class="gq-dialog'+(narrow?' narrow':'')+'" role="dialog" aria-modal="true">'+html+'</div>';
  m.addEventListener('click',e=>{if(e.target===m)m.remove()});
  document.body.appendChild(m);
  m.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>m.remove());
  return m;
}

async function openOrders(metric,dim,key,label){
  const m=modal('<div class="gq-dhead"><h3>'+esc(TITLES[metric])+': '+esc(label||'')+'</h3><button class="gq-btn small" type="button" id="gqOrdCsv">⬇ CSV</button><button class="gq-btn small" type="button" data-close>✕</button></div><div id="gqOrdBody" class="gq-empty">Загрузка заказов…</div>');
  try{
    const r=await api('orders',{params:{metric,dim,key:key==null?'':key,days:S.days,brand:S.brand,category:S.category,asOf:S.asOf}});
    const list=r.orders||[];
    $('#gqOrdBody',m).className='';
    $('#gqOrdBody',m).innerHTML=list.length?'<div class="gq-note" style="margin-bottom:6px">'+cnt(list.length)+' заказов · окно '+esc(dmy(r.window.fromDay))+' — '+esc(dmy(r.window.toDay))+'. Ссылка ведёт в кабинет Kaspi (шаблон ссылки меняется в настройках).</div><div class="gq-tablebox" style="max-height:70vh"><table class="gq-table"><thead><tr><th>Заказ</th><th>Дата</th><th>Статус</th><th>Причина</th><th>Товары</th></tr></thead><tbody>'+list.map(o=>'<tr><td><a href="'+esc(o.url)+'" target="_blank" rel="noopener" class="gq-mono">'+esc(o.code)+'</a>'+(o.multi?'<span class="gq-tag multi">несколько SKU</span>':'')+'</td><td>'+almaty(o.createdAt)+(o.planTransfer?'<div class="gq-note">план передачи '+almaty(o.planTransfer)+(o.transfer?'<br>передан '+almaty(o.transfer):'')+'</div>':'')+'</td><td class="gq-mono">'+esc(o.status)+'</td><td>'+esc(o.reason)+'</td><td>'+(o.items||[]).map(i=>'<div><span class="gq-mono">'+esc(i.sku)+'</span> × '+cnt(i.qty)+' <span class="gq-note">'+esc(i.name)+'</span></div>').join('')+'</td></tr>').join('')+'</tbody></table></div>':'<div class="gq-empty">Нет заказов.</div>';
    $('#gqOrdCsv',m).onclick=()=>csvDownload('zakazy-'+metric+'-'+(r.window.toDay)+'.csv',[['Заказ','Создан','Статус','Причина','Несколько SKU','План передачи','Передан','SKU','Ссылка']].concat(list.map(o=>[o.code,almaty(o.createdAt),o.status,o.reason,o.multi?'да':'',o.planTransfer?almaty(o.planTransfer):'',o.transfer?almaty(o.transfer):'',(o.items||[]).map(i=>i.sku+'×'+i.qty).join(', '),o.url])));
  }catch(e){$('#gqOrdBody',m).textContent='Ошибка: '+e.message}
}

function openSnapshot(){
  const s=S.data&&S.data.snapshot||{};const v=(o,k)=>o&&o[k]!=null?esc(o[k]):'';
  const list=(S.data&&S.data.snapshots)||[];
  const m=modal('<div class="gq-dhead"><h3>📸 Снимок кабинета Kaspi</h3><button class="gq-btn small" type="button" data-close>✕</button></div>'+
  '<p class="gq-note">Перенесите цифры из кабинета продавца (Показатели качества). Последний снимок — официальная цифра на экране. Отзывов, рейтинга и чатов в Shop API нет — они берутся только отсюда или из импорта.</p>'+
  '<div class="gq-form"><label>Дата снимка<input class="gq-input" type="date" id="sDate" value="'+esc(isoAlmaty(Date.now()))+'"></label>'+
  '<label>Рейтинг<input class="gq-input" id="sRv" inputmode="decimal" placeholder="4,9" value="'+v(s.rating,'value')+'"></label><label>Оценок<input class="gq-input" id="sRc" inputmode="numeric" value="'+v(s.rating,'count')+'"></label><label>Рейтинг: с<input class="gq-input" type="date" id="sRf" value="'+v(s.rating,'from')+'"></label>'+
  '<label>Задержки: X<input class="gq-input" id="sDb" inputmode="numeric" value="'+v(s.delays,'bad')+'"></label><label>из Y заказов КД<input class="gq-input" id="sDt" inputmode="numeric" value="'+v(s.delays,'total')+'"></label>'+
  '<label>Возвраты: X<input class="gq-input" id="sRb" inputmode="numeric" value="'+v(s.returns,'bad')+'"></label><label>из Y<input class="gq-input" id="sRt" inputmode="numeric" value="'+v(s.returns,'total')+'"></label>'+
  '<label>Отмены: X<input class="gq-input" id="sCb" inputmode="numeric" value="'+v(s.cancels,'bad')+'"></label><label>из Y<input class="gq-input" id="sCt" inputmode="numeric" value="'+v(s.cancels,'total')+'"></label>'+
  '<label>Чаты с ответом<input class="gq-input" id="sHa" inputmode="numeric" value="'+v(s.chats,'answered')+'"></label><label>Всего чатов<input class="gq-input" id="sHt" inputmode="numeric" value="'+v(s.chats,'total')+'"></label><label>Время ответа, мин<input class="gq-input" id="sHm" inputmode="decimal" value="'+v(s.chats,'avgMinutes')+'"></label>'+
  '<label style="grid-column:1/-1">Комментарий<input class="gq-input" id="sNote" maxlength="300"></label></div>'+
  '<div style="margin-top:10px;display:flex;gap:8px"><button class="gq-btn dark" type="button" id="sSave">Сохранить снимок</button></div>'+
  '<h4>Сохранённые снимки</h4>'+(list.length?'<div class="gq-tablebox"><table class="gq-table" style="min-width:560px"><thead><tr><th>Дата</th><th>Рейтинг</th><th>Задержки</th><th>Возвраты</th><th>Отмены</th><th>Чаты</th><th></th></tr></thead><tbody>'+list.map(x=>'<tr><td>'+esc(dmy(x.date))+'</td><td>'+(x.rating?num(x.rating.value,1)+' ('+cnt(x.rating.count)+')':'—')+'</td><td>'+(x.delays?x.delays.bad+'/'+x.delays.total:'—')+'</td><td>'+(x.returns?x.returns.bad+'/'+x.returns.total:'—')+'</td><td>'+(x.cancels?x.cancels.bad+'/'+x.cancels.total:'—')+'</td><td>'+(x.chats?x.chats.answered+'/'+x.chats.total:'—')+'</td><td><button class="gq-btn small" type="button" data-del="'+esc(x.id)+'">Удалить</button></td></tr>').join('')+'</tbody></table></div>':'<div class="gq-note">Сохранённых снимков нет — используется опорный снимок 21.11 из постановки задачи.</div>'),true);
  $('#sSave',m).onclick=async()=>{
    const g=id=>$('#'+id,m).value.trim();
    const body={date:g('sDate'),note:g('sNote'),rating:{value:g('sRv'),count:g('sRc'),from:g('sRf'),to:g('sDate')},delays:{bad:g('sDb'),total:g('sDt')},returns:{bad:g('sRb'),total:g('sRt')},cancels:{bad:g('sCb'),total:g('sCt')},chats:{answered:g('sHa'),total:g('sHt'),avgMinutes:g('sHm')}};
    try{const r=await api('snapshot',{method:'POST',body});toast('Снимок сохранён'+(r.warning?' (⚠ '+r.warning+')':''),'ok');m.remove();load({quiet:true})}catch(e){toast('Снимок не сохранён: '+e.message,'err')}
  };
  m.querySelectorAll('[data-del]').forEach(b=>b.onclick=async()=>{if(!confirm('Удалить снимок?'))return;try{await api('snapshot-delete',{method:'POST',body:{id:b.dataset.del}});m.remove();load({quiet:true})}catch(e){toast(e.message,'err')}});
}

// ---------- import ----------
function parseCsvText(text){
  const first=text.split(/\r?\n/,1)[0]||'';const sep=(first.match(/;/g)||[]).length>(first.match(/,/g)||[]).length?';':(first.includes('\t')?'\t':',');
  const rows=[];let row=[],cell='',q=false;
  for(let i=0;i<text.length;i++){const ch=text[i];if(q){if(ch==='"'&&text[i+1]==='"'){cell+='"';i++}else if(ch==='"')q=false;else cell+=ch}else if(ch==='"')q=true;else if(ch===sep){row.push(cell);cell=''}else if(ch==='\n'){row.push(cell.replace(/\r$/,''));rows.push(row);row=[];cell=''}else cell+=ch}
  if(cell||row.length){row.push(cell);rows.push(row)}
  return rows.filter(r=>r.some(c=>String(c).trim()));
}
function loadXlsxLib(){
  if(window.XLSX)return Promise.resolve(window.XLSX);
  return new Promise((res,rej)=>{const s=document.createElement('script');s.src='https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';s.onload=()=>res(window.XLSX);s.onerror=()=>rej(new Error('Не удалось загрузить библиотеку XLSX'));document.head.appendChild(s)});
}
async function readTable(file){
  if(/\.xlsx?$/i.test(file.name)){const X=await loadXlsxLib();const wb=X.read(await file.arrayBuffer(),{type:'array',cellDates:true});const sh=wb.Sheets[wb.SheetNames[0]];return X.utils.sheet_to_json(sh,{header:1,raw:false,dateNF:'yyyy-mm-dd'}).filter(r=>r.some(c=>String(c||'').trim()))}
  return parseCsvText(await file.text());
}
const COLS={code:/номер заказа|№ заказа|заказ|order/i,reason:/причин|reason/i,date:/дата|date/i,sku:/артикул|sku|код товара/i,rating:/оценк|рейтинг|rating|звезд/i};
function detect(header){const map={};header.forEach((h,i)=>{for(const [k,re] of Object.entries(COLS))if(map[k]==null&&re.test(String(h||'')))map[k]=i});return map}
function parseDate(v){const s=String(v||'').trim();let m=s.match(/^(\d{2})\.(\d{2})\.(\d{4})(?:[ T](\d{1,2}):(\d{2}))?/);if(m)return Date.parse(m[3]+'-'+m[2]+'-'+m[1]+'T'+(m[4]||'12').padStart(2,'0')+':'+(m[5]||'00')+':00+05:00');m=s.match(/^(\d{4})-(\d{2})-(\d{2})/);if(m)return Date.parse(m[1]+'-'+m[2]+'-'+m[3]+'T12:00:00+05:00');const t=Date.parse(s);return Number.isFinite(t)?t:0}

function openImport(){
  const imp=(S.data&&S.data.imports)||{};
  const m=modal('<div class="gq-dhead"><h3>⬆ Импорт из кабинета (CSV / XLSX)</h3><button class="gq-btn small" type="button" data-close>✕</button></div>'+
  '<p class="gq-note">Возвраты: нужны колонки «Номер заказа» и «Причина» (дата и артикул — по желанию). Отзывы: «Дата» и «Оценка». Колонки определяются по заголовку. Сейчас загружено: возвратов '+cnt(imp.returns||0)+', отзывов '+cnt(imp.reviews||0)+'.</p>'+
  '<div class="gq-form"><label>Что загружаем<select class="gq-select" id="iKind"><option value="returns">Возвраты</option><option value="reviews">Отзывы / оценки</option></select></label><label>Режим<select class="gq-select" id="iMode"><option value="merge">Добавить к загруженным</option><option value="replace">Заменить всё</option></select></label><label style="grid-column:1/-1">Файл<input type="file" id="iFile" accept=".csv,.txt,.xlsx,.xls"></label></div>'+
  '<div id="iPreview" class="gq-note" style="margin-top:10px"></div><div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap"><button class="gq-btn dark" type="button" id="iGo" disabled>Импортировать</button><button class="gq-btn" type="button" id="iClear">Очистить выбранный тип</button></div>',true);
  let rows=null;
  const prep=async()=>{
    const f=$('#iFile',m).files[0];if(!f)return;const kind=$('#iKind',m).value;
    try{
      const t=await readTable(f);const head=t[0]||[];const map=detect(head);const data=t.slice(1);
      if(kind==='returns'){if(map.code==null)throw new Error('Не найдена колонка с номером заказа');rows=data.map(r=>({code:String(r[map.code]||''),reason:map.reason!=null?String(r[map.reason]||''):'',date:map.date!=null?String(r[map.date]||''):'',sku:map.sku!=null?String(r[map.sku]||''):''})).filter(r=>/\d{6,}/.test(r.code))}
      else{if(map.rating==null||map.date==null)throw new Error('Нужны колонки «Дата» и «Оценка»');rows=data.map(r=>({at:parseDate(r[map.date]),rating:String(r[map.rating]||'').replace(/[^\d.,]/g,''),sku:map.sku!=null?String(r[map.sku]||''):''})).filter(r=>r.at>0)}
      $('#iPreview',m).innerHTML='Колонки: '+Object.entries(map).map(([k,i])=>'<b>'+esc(k)+'</b> ← «'+esc(head[i])+'»').join(', ')+'. Строк к импорту: <b>'+cnt(rows.length)+'</b>.'+(kind==='returns'&&map.reason==null?' ⚠ Колонки с причиной нет — возвраты будут «причина неизвестна».':'');
      $('#iGo',m).disabled=!rows.length;
    }catch(e){rows=null;$('#iGo',m).disabled=true;$('#iPreview',m).textContent='Ошибка: '+e.message}
  };
  $('#iFile',m).onchange=prep;$('#iKind',m).onchange=prep;
  $('#iGo',m).onclick=async()=>{try{const r=await api('import',{method:'POST',body:{kind:$('#iKind',m).value,mode:$('#iMode',m).value,rows}});toast('Импортировано '+cnt(r.imported)+', всего '+cnt(r.total)+(r.warning?' (⚠ '+r.warning+')':''),'ok');m.remove();load({quiet:true})}catch(e){toast('Импорт не выполнен: '+e.message,'err')}};
  $('#iClear',m).onclick=async()=>{const kind=$('#iKind',m).value;if(!confirm('Удалить все загруженные '+(kind==='returns'?'возвраты':'отзывы')+'?'))return;try{await api('import-clear',{method:'POST',body:{kind}});toast('Очищено','ok');m.remove();load({quiet:true})}catch(e){toast(e.message,'err')}};
}

// ---------- settings ----------
async function openSettings(){
  let cfg;try{cfg=(await api('settings')).settings}catch(e){toast('Настройки не загружены: '+e.message,'err');return}
  const t=cfg.thresholds;const keys=['rating','delays','returns','cancels'];
  const isRate=k=>k!=='rating';const show=(k,v)=>v==null?'':isRate(k)?num(v*100,2):num(v,2);
  const overrides=Object.entries(cfg.brandOverrides||{}).map(([k,v])=>k+' = '+v).join('\n');
  const m=modal('<div class="gq-dhead"><h3>⚙ Настройки показателей</h3><button class="gq-btn small" type="button" data-close>✕</button></div>'+
  '<h4>Пороги зон и своя цель</h4><div class="gq-tablebox"><table class="gq-table" style="min-width:520px"><thead><tr><th>Метрика</th><th>Хорошо</th><th>Плохо</th><th>Своя цель</th></tr></thead><tbody>'+keys.map(k=>'<tr><td>'+esc(TITLES[k])+' '+(isRate(k)?'(%)':'(★)')+'</td><td><input class="gq-input" style="width:90px" data-th="'+k+'.good" value="'+show(k,t[k].good)+'"></td><td><input class="gq-input" style="width:90px" data-th="'+k+'.bad" value="'+show(k,t[k].bad)+'"></td><td><input class="gq-input" style="width:90px" data-ct="'+k+'" value="'+show(k,cfg.customTargets[k])+'" placeholder="—"></td></tr>').join('')+'<tr><td>Доля ответов в чатах (%)</td><td colspan="2" class="gq-note">ручной ввод</td><td><input class="gq-input" style="width:90px" data-ct="chats" value="'+show('chats',cfg.customTargets.chats)+'" placeholder="50"></td></tr></tbody></table></div>'+
  '<h4>Отмены</h4><div class="gq-form"><label style="grid-column:1/-1">Причины «вина продавца» (коды через запятую; разметка также в таблице сырых причин)<textarea class="gq-input" id="cfgReasons" rows="2">'+esc((cfg.sellerFaultReasons||[]).join(', '))+'</textarea></label><label>Знаменатель<select class="gq-select" id="cfgDen"><option value="finished"'+(cfg.cancelDenominator!=='all'?' selected':'')+'>Завершённые заказы (как кабинет)</option><option value="all"'+(cfg.cancelDenominator==='all'?' selected':'')+'>Все созданные заказы</option></select></label></div>'+
  '<h4>Задержки</h4><div class="gq-form"><label>Допуск, минут<input class="gq-input" id="cfgGrace" inputmode="numeric" value="'+esc(cfg.delayGraceMinutes)+'"></label></div>'+
  '<h4>Возвраты</h4><div class="gq-form"><label style="grid-column:1/-1">Слова в причине возврата = «по качеству» (через запятую)<textarea class="gq-input" id="cfgQuality" rows="2">'+esc((cfg.qualityReturnReasons||[]).join(', '))+'</textarea></label><label style="grid-column:1/-1">Статусы возврата из API<input class="gq-input" id="cfgRetSt" value="'+esc((cfg.returnStatuses||[]).join(', '))+'"></label></div>'+
  '<h4>Бренды (brand_overrides)</h4><p class="gq-note">Порядок: (а) лист «Каспи для добавления» (SKU → бренд, колонка C), (б) этот справочник, (в) первое слово названия с пометкой «авто». Формат: <span class="gq-mono">SKU = Бренд</span>, по строке.</p><textarea class="gq-input" id="cfgBrands" rows="6" style="width:100%">'+esc(overrides)+'</textarea>'+
  '<h4>Ссылка на заказ</h4><input class="gq-input" id="cfgUrl" style="width:100%" value="'+esc(cfg.orderUrlTemplate)+'"><p class="gq-note">{code} заменяется номером заказа.</p>'+
  '<div style="margin-top:12px;display:flex;gap:8px"><button class="gq-btn dark" type="button" id="cfgSave">Сохранить</button></div>',true);
  $('#cfgSave',m).onclick=async()=>{
    const val=s=>{const v=String(s||'').trim().replace(',','.');return v===''?null:Number(v)};
    const th={};m.querySelectorAll('[data-th]').forEach(i=>{const [k,f]=i.dataset.th.split('.');const v=val(i.value);th[k]=th[k]||{};th[k][f]=v==null?null:isRate(k)?v/100:v});
    const ct={};m.querySelectorAll('[data-ct]').forEach(i=>{const k=i.dataset.ct;const v=val(i.value);if(v!=null&&v>0)ct[k]=k==='rating'?v:v/100});
    const bo={};$('#cfgBrands',m).value.split('\n').forEach(l=>{const p=l.split('=');if(p.length>=2&&p[0].trim()&&p.slice(1).join('=').trim())bo[p[0].trim()]=p.slice(1).join('=').trim()});
    const list=s=>String(s||'').split(/[,\n;]/).map(x=>x.trim()).filter(Boolean);
    const body={thresholds:th,customTargets:ct,sellerFaultReasons:list($('#cfgReasons',m).value),cancelDenominator:$('#cfgDen',m).value,delayGraceMinutes:Number($('#cfgGrace',m).value)||0,qualityReturnReasons:list($('#cfgQuality',m).value),returnStatuses:list($('#cfgRetSt',m).value),brandOverrides:bo,orderUrlTemplate:$('#cfgUrl',m).value.trim()};
    try{const r=await api('settings',{method:'POST',body});toast('Настройки сохранены'+(r.warning?' (⚠ '+r.warning+')':''),'ok');S.targets={};m.remove();load({quiet:true})}catch(e){toast('Не сохранено: '+e.message,'err')}
  };
}

// ---------- open / close / nav ----------
function setUrl(open){
  if(STANDALONE)return;
  try{const q=new URLSearchParams(location.search);if(open)q.set('gq','1');else q.delete('gq');const s=q.toString();history.replaceState(history.state,'',location.pathname+(s?'?'+s:'')+location.hash)}catch{}
}
function open(){build();S.open=true;if(!STANDALONE){root.style.display='block';document.body.style.overflow='hidden'}setUrl(true);load();clearInterval(S.timer);S.timer=setInterval(()=>{if(S.open&&!S.refreshing)load({quiet:true})},HOUR)}
function close(){S.open=false;if(root)root.style.display='none';document.body.style.overflow='';setUrl(false);clearInterval(S.timer)}

function nav(){
  if($('#gbQualityNav2'))return true;
  const old=$('#gbQualityNav');if(old)old.remove();
  const all=[...document.querySelectorAll('button,a')];
  const ref=all.find(x=>/Динамика продаж/i.test(x.textContent||''))||all.find(x=>/Прайс Kaspi/i.test(x.textContent||''))||all.find(x=>/Заказы/i.test(x.textContent||''));
  if(!ref||!ref.parentElement)return false;
  const b=document.createElement('button');b.id='gbQualityNav2';b.type='button';b.className=ref.className;b.textContent='🛡 Показатели качества';b.onclick=open;
  ref.parentElement.insertBefore(b,ref.nextSibling);return true;
}

window.GBQuality={open,close,reload:()=>load()};
if(STANDALONE){const go=()=>{open()};if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',go);else go();return}
let tries=0;const boot=setInterval(()=>{if(nav()||++tries>120)clearInterval(boot)},250);
if(new URLSearchParams(location.search).get('gq')==='1')setTimeout(open,600);
window.addEventListener('keydown',e=>{if(e.key==='Escape'&&S.open&&!document.querySelector('.gq-modal'))close()});
})();
