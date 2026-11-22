(()=>{
'use strict';
// GRANTS BOOK · Расходники. Только отображение и ввод: справочник, история цен,
// остатки и расчёт «Сейчас» хранятся и считаются на сервере
// (/api/data?module=consumables). Стоимость расходников вычитается из прибыли
// в «Продажи Kaspi» и «Динамика продаж».
if(window.GB_CONSUMABLES_LOADED)return;
window.GB_CONSUMABLES_LOADED=true;

const API='/api/data';
const TABS=[['now','Сейчас'],['book','Справочник'],['prices','История цен'],['journal','Журнал']];
const S={tab:'now',state:null,now:null,loading:false,nowLoading:false,open:false,draft:null,overflow:''};

// ---------- utils ----------
const $=(sel,root=document)=>root.querySelector(sel);
const esc=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const isNum=v=>typeof v==='number'&&Number.isFinite(v);
const nf0=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0});
const nf1=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1});
const nf2=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2});
const nf4=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:4});
const money=v=>isNum(v)?nf0.format(Math.round(v))+' ₸':'—';
const unitMoney=v=>isNum(v)?(v>=10?nf2.format(v):nf4.format(v))+' ₸':'—';
const parseNum=v=>{if(v===''||v==null)return NaN;return Number(String(v).replace(/[\s ₸]/g,'').replace(',','.'))};
const dmy=v=>{if(!v)return '—';if(typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)){const [y,m,d]=v.split('-');return d+'.'+m+'.'+y}const d=new Date(v);return Number.isNaN(d.getTime())?String(v):d.toLocaleString('ru-RU',{timeZone:'Asia/Almaty',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'})};
// Unit of an item: 'pcs' | 'cm' | 'roll' (from the server prices table).
const unitOf=key=>{const p=S.state&&S.state.prices&&S.state.prices[key];if(p&&p.unit)return p.unit;return key==='stretch'?'cm':'pcs'};
const isCm=key=>unitOf(key)==='cm';
// Base units: шт or см. Display: шт, or метры + рулоны.
function qtyText(key,v,packUnits){if(!isNum(v))return '—';const u=unitOf(key);if(u==='cm'){const m=v/100,rolls=packUnits>0?v/packUnits:0;return nf1.format(m)+' м · '+nf2.format(rolls)+' рул.'}if(u==='roll')return nf2.format(v)+' рул.';return nf0.format(Math.round(v))+' шт'}
function packWord(key){return key==='label'||unitOf(key)!=='pcs'?'рул.':'пач.'}
function almatyToday(){const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Almaty',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));return p.year+'-'+p.month+'-'+p.day}

async function api(op,{params={},body=null,timeout=290000}={}){
  const q=new URLSearchParams({module:'consumables',op});
  for(const [k,v] of Object.entries(params))if(v!==''&&v!=null)q.set(k,v);
  const ctrl=new AbortController(),t=setTimeout(()=>ctrl.abort(),timeout);
  try{
    const r=await fetch(API+'?'+q.toString(),{method:body?'POST':'GET',cache:'no-store',signal:ctrl.signal,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
    const j=await r.json().catch(()=>({ok:false,error:'Сервер вернул не JSON (HTTP '+r.status+')'}));
    if(!r.ok||j.ok===false){if(r.status===401&&j.code==='access_required')throw new Error('Нужен код доступа GRANTS BOOK');throw new Error(j.error||('HTTP '+r.status))}
    return j;
  }catch(e){if(e&&e.name==='AbortError')throw new Error('Сервер не ответил вовремя');throw e}
  finally{clearTimeout(t)}
}

function toast(text,kind='info',ms=4500){const m=$('#gcMsg');if(!m)return;m.textContent=text;m.className='gc-msg show '+kind;clearTimeout(toast.t);if(ms)toast.t=setTimeout(()=>{m.className='gc-msg'},ms)}
function changed(){try{window.dispatchEvent(new CustomEvent('gb:consumables-changed'))}catch{}}

// ---------- styles ----------
function style(){
  if($('#gcCss'))return;
  const s=document.createElement('style');s.id='gcCss';s.textContent=`
#gbConsumables{--gc-line:#e4e7ec;--gc-ink:#101828;--gc-mute:#667085;--gc-good:#067647;--gc-good-bg:#ecfdf3;--gc-warn:#b54708;--gc-warn-bg:#fffaeb;--gc-bad:#b42318;--gc-bad-bg:#fef3f2;--gc-info:#175cd3;--gc-info-bg:#eff8ff;position:fixed;inset:58px 0 0;z-index:2147483300;display:none;overflow:auto;background:#f5f7fa;font-family:Inter,Arial,sans-serif;color:var(--gc-ink);font-size:14px;-webkit-overflow-scrolling:touch}
#gbConsumables *{box-sizing:border-box}#gbConsumables button,#gbConsumables input,#gbConsumables select{font:inherit}
.gc-head{position:sticky;top:0;z-index:30;background:#fff;border-bottom:1px solid var(--gc-line);padding:12px 16px 0;display:flex;flex-direction:column;gap:10px}
.gc-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.gc-sp{flex:1}
.gc-title{font-size:22px;font-weight:900;line-height:1.1}.gc-sub{font-size:12px;color:var(--gc-mute);margin-top:3px}
.gc-btn{border:1px solid #d0d5dd;background:#fff;border-radius:10px;padding:8px 12px;font-weight:750;cursor:pointer;color:var(--gc-ink);white-space:nowrap;min-height:36px}.gc-btn:hover{background:#f9fafb}.gc-btn.dark{background:#111;color:#fff;border-color:#111}.gc-btn.primary{background:#2a78d6;color:#fff;border-color:#2a78d6}.gc-btn.small{padding:5px 9px;font-size:12px;min-height:30px}.gc-btn.danger{color:var(--gc-bad)}.gc-btn:disabled{opacity:.55;cursor:wait}
.gc-tabs{display:flex;gap:2px;overflow-x:auto;margin:0 -16px;padding:0 16px}.gc-tab{border:0;background:none;padding:10px 12px;font-weight:800;color:var(--gc-mute);border-bottom:2px solid transparent;cursor:pointer;white-space:nowrap}.gc-tab.on{color:var(--gc-ink);border-bottom-color:var(--gc-ink)}
.gc-body{max-width:1300px;margin:0 auto;padding:16px}
.gc-msg{display:none;margin-bottom:12px;padding:10px 12px;border-radius:10px;font-size:13px;font-weight:700}.gc-msg.show{display:block}.gc-msg.info{background:var(--gc-info-bg);color:var(--gc-info)}.gc-msg.ok{background:var(--gc-good-bg);color:var(--gc-good)}.gc-msg.warn{background:var(--gc-warn-bg);color:var(--gc-warn)}.gc-msg.err{background:var(--gc-bad-bg);color:var(--gc-bad)}
.gc-alert{padding:11px 13px;border-radius:12px;margin-bottom:12px;font-size:13px;font-weight:700;line-height:1.45;border:1px solid #fedf89;background:var(--gc-warn-bg);color:#93370d}.gc-alert.err{border-color:#fecdca;background:var(--gc-bad-bg);color:var(--gc-bad)}
.gc-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin-bottom:12px}
.gc-kpi{background:#fff;border:1px solid var(--gc-line);border-radius:14px;padding:12px 14px;display:flex;flex-direction:column;gap:4px}.gc-kpi small{font-size:11px;font-weight:800;color:var(--gc-mute);text-transform:uppercase;letter-spacing:.03em}.gc-kpi b{font-size:24px;font-weight:900;line-height:1.1}.gc-kpi span{font-size:12px;color:var(--gc-mute)}
.gc-kpi.good b{color:var(--gc-good)}.gc-kpi.bad b{color:var(--gc-bad)}.gc-kpi.warn b{color:var(--gc-warn)}
.gc-items{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:10px}
.gc-item{background:#fff;border:1px solid var(--gc-line);border-radius:14px;padding:12px 14px;border-left:5px solid #d0d5dd;display:flex;flex-direction:column;gap:6px}
.gc-item.green{border-left-color:#17b26a}.gc-item.yellow{border-left-color:#f79009}.gc-item.red{border-left-color:#f04438}
.gc-item h4{margin:0;font-size:15px;display:flex;gap:8px;align-items:center;justify-content:space-between}
.gc-chip{display:inline-flex;padding:3px 8px;border-radius:999px;font-size:11px;font-weight:800;white-space:nowrap}.gc-chip.green{background:var(--gc-good-bg);color:var(--gc-good)}.gc-chip.yellow{background:var(--gc-warn-bg);color:var(--gc-warn)}.gc-chip.red{background:var(--gc-bad-bg);color:var(--gc-bad)}.gc-chip.unknown{background:#f2f4f7;color:var(--gc-mute)}
.gc-kv{display:grid;grid-template-columns:auto 1fr;gap:3px 10px;font-size:13px}.gc-kv span{color:var(--gc-mute)}.gc-kv b{text-align:right;font-variant-numeric:tabular-nums}
.gc-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:4px}
.gc-section{background:#fff;border:1px solid var(--gc-line);border-radius:14px;padding:14px;margin-bottom:12px}.gc-section h3{margin:0 0 4px;font-size:16px}.gc-note{font-size:12px;color:var(--gc-mute);line-height:1.5}
.gc-form{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:10px;margin-top:10px;align-items:end}
.gc-form label,.gc-field{display:flex;flex-direction:column;gap:4px;font-size:12px;color:#344054;font-weight:700}
.gc-in,.gc-sel{border:1px solid #d0d5dd;border-radius:9px;padding:8px 9px;background:#fff;width:100%;min-width:0;min-height:36px}.gc-in.bad{border-color:#f04438;background:#fffbfa}
.gc-calc{font-size:13px;font-weight:800;padding:8px 10px;border-radius:9px;background:#f2f4f7;min-height:36px;display:flex;align-items:center}
.gc-tablebox{overflow:auto;border:1px solid var(--gc-line);border-radius:12px;margin-top:10px;-webkit-overflow-scrolling:touch}
.gc-table{width:100%;border-collapse:collapse;font-size:13px}.gc-table th{background:#f9fafb;text-align:left;padding:8px;font-size:11px;color:var(--gc-mute);text-transform:uppercase;white-space:nowrap}.gc-table td{padding:6px 8px;border-top:1px solid #f2f4f7;vertical-align:middle}.gc-table td.r,.gc-table th.r{text-align:right;white-space:nowrap}.gc-table .gc-in{min-width:70px;padding:6px 7px;min-height:32px}
.gc-empty{text-align:center;padding:30px 12px;color:var(--gc-mute)}
.gc-steps{margin:8px 0 0;padding-left:18px;font-size:13px;line-height:1.6}
.gc-modal{position:fixed;inset:0;z-index:2147483450;background:rgba(16,24,40,.45);display:flex;align-items:flex-start;justify-content:center;padding:24px 12px;overflow:auto;font-family:Inter,Arial,sans-serif;color:#101828;font-size:14px}
.gc-modal *{box-sizing:border-box}.gc-dialog{background:#fff;border-radius:16px;max-width:520px;width:100%;padding:16px;box-shadow:0 20px 50px rgba(16,24,40,.25)}.gc-dialog h3{margin:0 0 6px}
@media(max-width:760px){#gbConsumables{inset:54px 0 0}.gc-head{position:static;padding:10px 16px 0}.gc-title{font-size:19px}.gc-body{padding:12px 16px}.gc-head .gc-btn{padding:6px 9px;font-size:12px}.gc-kpi b{font-size:20px}.gc-items{grid-template-columns:1fr}.gc-form{grid-template-columns:repeat(2,minmax(0,1fr))}.gc-modal{padding:0}.gc-dialog{border-radius:0;min-height:100vh;max-width:none}}
`;
  document.head.appendChild(s);
}

// ---------- skeleton ----------
let root=null;
function build(){
  style();if(root)return root;
  root=document.createElement('section');root.id='gbConsumables';root.setAttribute('aria-label','Расходники');
  root.innerHTML=`<div class="gc-head">
    <div class="gc-row"><div><div class="gc-title">🧻 Расходники</div><div class="gc-sub">Термоэтикетки, курьерские пакеты, стрейч, скотч · стоимость вычитается из прибыли в «Продажи Kaspi» и «Динамика продаж»</div></div><div class="gc-sp"></div>
    <button class="gc-btn" id="gcRefresh" type="button">↻ Обновить</button><button class="gc-btn dark" id="gcClose" type="button">Закрыть</button></div>
    <div class="gc-tabs">${TABS.map(([k,l])=>`<button class="gc-tab" type="button" data-t="${k}">${l}</button>`).join('')}</div>
  </div><div class="gc-body"><div id="gcMsg" class="gc-msg" role="status" aria-live="polite"></div><div id="gcMain"><div class="gc-empty">Загрузка…</div></div></div>`;
  document.body.appendChild(root);
  $('#gcClose',root).onclick=close;
  $('#gcRefresh',root).onclick=()=>{loadState(true);if(S.tab==='now')loadNow(true)};
  root.querySelectorAll('.gc-tab').forEach(b=>b.onclick=()=>{S.tab=b.dataset.t;render();if(S.tab==='now'&&!S.now)loadNow()});
  return root;
}

async function loadState(force=false){
  S.loading=true;
  try{S.state=await api('state',{params:{force:force?1:''}});S.draft=null}
  catch(e){toast('Не удалось загрузить расходники: '+e.message,'err',0)}
  finally{S.loading=false;render()}
}
async function loadNow(force=false){
  if(S.nowLoading)return;S.nowLoading=true;render();
  try{S.now=await api('now',{params:{force:force?1:''}});if(S.now.partial)setTimeout(()=>{if(S.open&&S.tab==='now')loadNow(true)},60000)}
  catch(e){S.nowError=e.message}
  finally{S.nowLoading=false;render()}
}

function render(){
  if(!root)return;
  root.querySelectorAll('.gc-tab').forEach(b=>b.classList.toggle('on',b.dataset.t===S.tab));
  const main=$('#gcMain',root);
  if(!S.state){main.innerHTML='<div class="gc-empty">'+(S.loading?'Загрузка…':'Нет данных')+'</div>';return}
  const head=statusAlert();
  if(S.tab==='now'){main.innerHTML=head+renderNow();bindNow();return}
  if(S.tab==='book'){main.innerHTML=head+renderBook();bindBook();return}
  if(S.tab==='prices'){main.innerHTML=renderPrices();return}
  main.innerHTML=renderJournal();
}

function statusAlert(){
  const st=S.state.status||{};
  if(!st.configured)return '<div class="gc-alert">⚠ Расходники не учтены — заполните цены в «Справочнике». Пока цены равны 0, прибыль в «Продажи Kaspi» и «Динамике продаж» считается без расходников.</div>';
  if(st.zero&&st.zero.length)return '<div class="gc-alert">⚠ Не заданы цены: '+esc(st.zero.join(', '))+'. Эти позиции считаются по 0 ₸.</div>';
  return '';
}

// ---------- «Сейчас» ----------
function renderNow(){
  if(S.nowLoading&&!S.now)return '<div class="gc-empty">Считаю активные заказы и расход с последней инвентаризации…<br><span class="gc-note">Первый расчёт может занять до минуты.</span></div>';
  if(!S.now)return '<div class="gc-alert err">Не удалось посчитать: '+esc(S.nowError||'нет данных')+' <button class="gc-btn small" id="gcNowRetry" type="button">Повторить</button></div>';
  const n=S.now,rows=n.rows||[];
  const known=rows.filter(r=>r.status!=='unknown');
  const shortRows=known.filter(r=>r.enough===false);
  const minDays=known.filter(r=>r.avgDaily>0).reduce((m,r)=>Math.min(m,r.daysLeftInfinite?Infinity:r.daysLeft),Infinity);
  const stages=Object.entries(n.activeByStage||{}).map(([k,v])=>esc(k)+': '+nf0.format(v)).join(' · ');
  const enoughCls=!known.length?'':shortRows.length?'bad':'good';
  const kpis=`<div class="gc-kpis">
    <div class="gc-kpi"><small>Активные заказы</small><b>${nf0.format(n.activeOrders)}</b><span>${nf0.format(n.activeUnits)} шт · новые и принятые, не отправленные${stages?' · '+stages:''}</span></div>
    <div class="gc-kpi ${enoughCls}"><small>Хватит на текущие заказы</small><b>${!known.length?'—':shortRows.length?'Нет':'Да'}</b><span>${!known.length?'проведите инвентаризацию':shortRows.length?'не хватает: '+shortRows.map(r=>esc(r.title)+' — '+qtyText(r.key,r.short,r.packUnits)).join('; '):'по всем позициям с остатком'}</span></div>
    <div class="gc-kpi ${minDays<(S.state.config.warnDays||7)?'warn':''}"><small>Хватит на</small><b>${minDays===Infinity?'—':nf0.format(Math.floor(minDays))+' дн.'}</b><span>по самой дефицитной позиции · в среднем ${nf1.format(n.avgOrdersPerDay)} заказов/день за 30 дней</span></div>
    <div class="gc-kpi"><small>Отправлено за 30 дней</small><b>${nf0.format(n.shippedRecent)}</b><span>заказов · расход списывается автоматически</span></div>
  </div>`;
  const warn=(n.warnings||[]).map(w=>'<div class="gc-alert">'+esc(w)+'</div>').join('');
  const items=rows.map(itemCard).join('');
  const nf=n.withoutFormat||[];
  const noFormat=nf.length?`<div class="gc-section"><h3>Товары без формата в активных заказах · ${nf.length}</h3><div class="gc-note">Для них берётся формат по умолчанию${n.defaultFormat?' («'+esc(n.defaultFormat)+'»)':''}. Назначьте формат в «Справочнике» → «Форматы товара».</div><div class="gc-tablebox"><table class="gc-table" style="min-width:420px"><thead><tr><th>Артикул</th><th>Товар</th><th class="r">Шт</th><th class="r">Заказов</th></tr></thead><tbody>${nf.slice(0,100).map(r=>`<tr><td>${esc(r.sku)}</td><td>${esc(r.name)}</td><td class="r">${nf0.format(r.qty)}</td><td class="r">${nf0.format(r.orders)}</td></tr>`).join('')}</tbody></table></div><div class="gc-actions"><button class="gc-btn small" type="button" id="gcNoFmtCopy">Перенести артикулы в массовое назначение</button></div></div>`:'';
  return warn+kpis+noFormat+`<div class="gc-items">${items}</div><p class="gc-note" style="margin-top:12px">Остаток = остаток на дату последней инвентаризации + приходы после неё − расход по заказам, переданным в доставку после этой даты. Обновлено ${esc(dmy(n.generatedAt))}${n.cached?' · кэш':''}${S.nowLoading?' · обновляю…':''}. Жёлтый — запаса меньше ${nf0.format(S.state.config.warnDays||7)} дней, красный — не хватает на текущие заказы. Рекомендация — до запаса на ${nf0.format(S.state.config.planDays||30)} дней.</p>`;
}
function itemCard(r){
  const label={green:'Хватает',yellow:'Мало',red:'Не хватает',unknown:'Нет остатка'}[r.status]||r.status;
  const days=r.status==='unknown'?'—':r.daysLeftInfinite?'∞ (нет расхода)':nf0.format(Math.floor(r.daysLeft))+' дн.';
  const buy=r.buyPacks>0?nf0.format(r.buyPacks)+' '+packWord(r.key)+' ('+qtyText(r.key,r.buyUnits,r.packUnits)+')':'не нужно';
  return `<div class="gc-item ${r.status}"><h4><span>${esc(r.title)}</span><span class="gc-chip ${r.status}">${label}</span></h4>
  <div class="gc-kv">
    <span>Нужно на активные</span><b>${r.monthly?'— (расход по месяцам)':qtyText(r.key,r.need,r.packUnits)}</b>
    <span>Остаток сейчас</span><b>${r.current==null?'—':qtyText(r.key,r.current,r.packUnits)}</b>
    ${r.stockAt?`<span>Инвентаризация</span><b>${qtyText(r.key,r.stockQty,r.packUnits)} · ${esc(dmy(r.stockAt))}</b><span>Приход / расход после</span><b>+${qtyText(r.key,r.receivedSince,r.packUnits)} / −${qtyText(r.key,r.usedSince,r.packUnits)}</b>`:''}
    <span>Хватит на текущие</span><b>${r.enough==null?'—':r.enough?'да':'нет, не хватает '+qtyText(r.key,r.short,r.packUnits)}</b>
    <span>Средний расход</span><b>${qtyText(r.key,r.avgDaily,r.packUnits)}/день</b>
    <span>Хватит на</span><b>${days}</b>
    <span>Рекомендуем докупить</span><b>${buy}</b>
  </div>
  <div class="gc-actions"><button class="gc-btn small" type="button" data-op="receipt" data-item="${esc(r.key)}">＋ Приход</button><button class="gc-btn small" type="button" data-op="inventory" data-item="${esc(r.key)}">📋 Инвентаризация</button></div></div>`;
}
function bindNow(){
  const retry=$('#gcNowRetry');if(retry)retry.onclick=()=>loadNow(true);
  root.querySelectorAll('[data-op]').forEach(b=>b.onclick=()=>openStockDialog(b.dataset.item,b.dataset.op));
  const copy=$('#gcNoFmtCopy');if(copy)copy.onclick=()=>{S.massSkus=(S.now.withoutFormat||[]).map(r=>r.sku).join('\n');S.tab='book';render();const box=$('#gcMassSkus');if(box){box.scrollIntoView({block:'center'});box.focus()}};
}

function openStockDialog(item,type){
  const st=S.state,title=(st.titles||{})[item]||item,pu=(st.prices[item]||{}).packUnits||0,cm=isCm(item),roll=unitOf(item)==='roll';
  const m=document.createElement('div');m.className='gc-modal';
  m.innerHTML=`<div class="gc-dialog" role="dialog" aria-modal="true"><h3>${type==='inventory'?'Инвентаризация':'Приход'} · ${esc(title)}</h3>
  <div class="gc-note">${type==='inventory'?'Укажите фактический остаток на складе сейчас. Расход по заказам, отправленным после этого момента, будет списываться автоматически.':'Добавьте полученное количество — оно прибавится к остатку.'}</div>
  <div class="gc-form"><label>Количество<input class="gc-in" id="gcQty" inputmode="decimal" autofocus placeholder="0"></label>
  <label>Единица<select class="gc-sel" id="gcUnit">${roll?'<option value="base">рулоны</option>':`<option value="pack">${cm||item==='label'?'рулоны':'пачки'} (по ${cm?nf1.format(pu/100)+' м':nf0.format(pu)+' шт'})</option><option value="base">${cm?'метры':'штуки'}</option>`}</select></label>
  <label style="grid-column:1/-1">Комментарий<input class="gc-in" id="gcComment" maxlength="200" placeholder="необязательно"></label></div>
  <div class="gc-actions" style="margin-top:12px"><button class="gc-btn primary" id="gcOk" type="button">Сохранить</button><button class="gc-btn" id="gcCancel" type="button">Отмена</button></div></div>`;
  document.body.appendChild(m);
  const closeM=()=>m.remove();
  m.addEventListener('click',e=>{if(e.target===m)closeM()});
  $('#gcCancel',m).onclick=closeM;
  $('#gcOk',m).onclick=async()=>{
    const qty=parseNum($('#gcQty',m).value);
    if(!Number.isFinite(qty)||qty<0||(type==='receipt'&&qty<=0)){$('#gcQty',m).classList.add('bad');return}
    const btn=$('#gcOk',m);btn.disabled=true;
    try{S.state=await api('stock',{body:{item,type,qty,unit:$('#gcUnit',m).value,comment:$('#gcComment',m).value}});closeM();toast(type==='inventory'?'Остаток записан':'Приход добавлен','ok');S.now=null;render();loadNow(true)}
    catch(e){btn.disabled=false;toast('Не удалось сохранить: '+e.message,'err',0)}
  };
  setTimeout(()=>{const i=$('#gcQty',m);if(i)i.focus()},30);
}

// ---------- «Справочник» ----------
function draft(){if(!S.draft)S.draft=JSON.parse(JSON.stringify(S.state.config));return S.draft}
function stockLine(key){
  const stock=S.state.config.stock[key],row=S.now&&S.now.rows?S.now.rows.find(r=>r.key===key):null,pu=(S.state.prices[key]||{}).packUnits;
  if(!stock)return '<span class="gc-note">Остаток не задан — «Инвентаризация» на вкладке «Сейчас»</span>';
  const last=row&&row.lastMoveAt?row.lastMoveAt:stock.at;
  return '<span class="gc-note">Остаток: <b>'+(row&&row.current!=null?qtyText(key,row.current,pu):qtyText(key,stock.qty,pu)+' на дату инвентаризации')+'</b> · последний приход/инвентаризация '+esc(dmy(last))+'</span>';
}
function fromField(key){const f=(S.state.inForce||{})[key];return `<label>Цена действует с<input class="gc-in" type="date" data-from="${esc(key)}" max="${esc(S.state.today)}" value="${esc(S.state.today)}"><span class="gc-note">${f?'сейчас: '+unitMoney(f.unitPrice)+' с '+dmy(f.from):'цена ещё не задана'}</span></label>`}
function renderBook(){
  const c=draft();
  const bagOptions=sel=>c.bags.map(b=>`<option value="${esc(b.id)}"${b.id===sel?' selected':''}>${esc(b.name)} ${esc(b.width)}×${esc(b.height)}</option>`).join('');
  const bagRows=c.bags.map((b,i)=>`<tr data-bag="${i}"><td><input class="gc-in" data-b="name" value="${esc(b.name)}" style="min-width:110px"></td><td><input class="gc-in" data-b="width" inputmode="decimal" value="${esc(b.width)}"></td><td><input class="gc-in" data-b="height" inputmode="decimal" value="${esc(b.height)}"></td><td><input class="gc-in" data-b="flap" inputmode="decimal" value="${esc(b.flap)}"></td><td><input class="gc-in" data-b="packPrice" inputmode="decimal" value="${esc(b.packPrice)}"></td><td><input class="gc-in" data-b="packQty" inputmode="numeric" value="${esc(b.packQty)}"></td><td class="r" data-unit="bag:${esc(b.id)}">${unitMoney(b.packQty>0?b.packPrice/b.packQty:NaN)}</td><td><input class="gc-in" type="date" data-from="bag:${esc(b.id)}" max="${esc(S.state.today)}" value="${esc(S.state.today)}"></td><td style="text-align:center"><input type="radio" name="gcDefBag" value="${esc(b.id)}"${b.id===c.defaultBag?' checked':''} aria-label="По умолчанию"></td><td>${stockLine('bag:'+b.id)}</td><td><button class="gc-btn small danger" type="button" data-delbag="${i}" title="Удалить размер">✕</button></td></tr>`).join('');
  const skuBagRows=Object.entries(c.bagBySku).map(([sku,id])=>`<tr><td><input class="gc-in" data-skubag="sku" value="${esc(sku)}"></td><td><select class="gc-sel" data-skubag="bag">${bagOptions(id)}</select></td><td><button class="gc-btn small danger" type="button" data-delrow>✕</button></td></tr>`).join('');
  const skuStretchRows=Object.entries(c.stretch.bySku).map(([sku,cm])=>`<tr><td><input class="gc-in" data-skustretch="sku" value="${esc(sku)}"></td><td><input class="gc-in" data-skustretch="cm" inputmode="decimal" value="${esc(cm)}"></td><td><button class="gc-btn small danger" type="button" data-delrow>✕</button></td></tr>`).join('');
  return `<form id="gcBook" onsubmit="return false">
  <div class="gc-section"><h3>a) ${esc(c.label.name)}</h3><div class="gc-note">Цена за 1 этикетку считается автоматически.</div>
    <div class="gc-form"><label>Цена за рулон, ₸<input class="gc-in" data-f="label.packPrice" inputmode="decimal" value="${esc(c.label.packPrice)}"></label>
    <label>Этикеток в рулоне, шт<input class="gc-in" data-f="label.packQty" inputmode="numeric" value="${esc(c.label.packQty)}"></label>
    <div class="gc-field">Цена 1 этикетки<div class="gc-calc" data-unit="label"></div></div>
    <label>Расход<select class="gc-sel" data-f="label.mode"><option value="order"${c.label.mode==='order'?' selected':''}>1 этикетка на заказ</option><option value="unit"${c.label.mode==='unit'?' selected':''}>1 этикетка на каждую единицу товара</option></select></label>
    ${fromField('label')}</div><div style="margin-top:8px">${stockLine('label')}</div></div>

  <div class="gc-section"><h3>b) Курьерские пакеты</h3><div class="gc-note">Расход: 1 пакет на заказ. Выбор: артикул → размер (если у товаров заказа разные пакеты — самый большой), иначе пакет по умолчанию; если единиц в заказе больше N — пакет из правила (если он не меньше).</div>
    <div class="gc-tablebox"><table class="gc-table" style="min-width:1050px"><thead><tr><th>Название</th><th>Ш, см</th><th>В, см</th><th>Клапан, см</th><th>Цена за пачку, ₸</th><th>Шт в пачке</th><th class="r">Цена 1 шт</th><th>Цена действует с</th><th>По умолч.</th><th>Остаток</th><th></th></tr></thead><tbody>${bagRows||'<tr><td colspan="11" class="gc-empty">Нет размеров</td></tr>'}</tbody></table></div>
    <div class="gc-actions"><button class="gc-btn small" type="button" id="gcAddBag">＋ Добавить размер</button></div>
    <div class="gc-form"><label>Если в заказе больше N единиц<input class="gc-in" data-f="bagRule.minUnits" inputmode="numeric" value="${esc(c.bagRule.minUnits)}"><span class="gc-note">0 — правило выключено</span></label>
    <label>…брать пакет<select class="gc-sel" data-f="bagRule.bagId"><option value="">— не выбран —</option>${bagOptions(c.bagRule.bagId)}</select></label></div>
    <h4 style="margin:14px 0 0;font-size:14px">Артикул → размер пакета</h4>
    <div class="gc-tablebox"><table class="gc-table" style="min-width:420px"><thead><tr><th>Артикул</th><th>Пакет</th><th></th></tr></thead><tbody id="gcSkuBag">${skuBagRows}</tbody></table></div>
    <div class="gc-actions"><button class="gc-btn small" type="button" id="gcAddSkuBag">＋ Артикул</button></div></div>

  ${formatsSection(c,bagOptions)}

  <div class="gc-section"><h3>c) Стрейч-плёнка</h3><div class="gc-note">Цена 1 см = цена рулона / (длина × 100). См на 1 единицу: переопределение по артикулу → формат артикула → значение по умолчанию ниже.</div>
    <div class="gc-form"><label>Цена за рулон, ₸<input class="gc-in" data-f="stretch.packPrice" inputmode="decimal" value="${esc(c.stretch.packPrice)}"></label>
    <label>Длина рулона, м<input class="gc-in" data-f="stretch.lengthM" inputmode="decimal" value="${esc(c.stretch.lengthM)}"></label>
    <label>Ширина, см<input class="gc-in" data-f="stretch.widthCm" inputmode="decimal" value="${esc(c.stretch.widthCm)}"></label>
    <div class="gc-field">Цена 1 см<div class="gc-calc" data-unit="stretch"></div></div>
    <label>См на 1 единицу (по умолч.)<input class="gc-in" data-f="stretch.cmPerUnit" inputmode="decimal" value="${esc(c.stretch.cmPerUnit)}"></label>
    ${fromField('stretch')}</div><div style="margin-top:8px">${stockLine('stretch')}</div>
    <h4 style="margin:14px 0 0;font-size:14px">Артикул → см на единицу</h4>
    <div class="gc-tablebox"><table class="gc-table" style="min-width:420px"><thead><tr><th>Артикул</th><th>См на единицу</th><th></th></tr></thead><tbody id="gcSkuStretch">${skuStretchRows}</tbody></table></div>
    <div class="gc-actions"><button class="gc-btn small" type="button" id="gcAddSkuStretch">＋ Артикул</button></div></div>

  ${tapesSection(c)}

  <div class="gc-section"><h3>Запас и предупреждения</h3><div class="gc-form">
    <label>Докупать до запаса на, дней<input class="gc-in" data-f="planDays" inputmode="numeric" value="${esc(c.planDays)}"></label>
    <label>Жёлтый статус, если меньше, дней<input class="gc-in" data-f="warnDays" inputmode="numeric" value="${esc(c.warnDays)}"></label></div></div>

  <div class="gc-actions" style="position:sticky;bottom:0;background:#f5f7fa;padding:10px 0"><button class="gc-btn primary" type="button" id="gcSave">💾 Сохранить справочник</button><button class="gc-btn" type="button" id="gcReset">Отменить изменения</button><span class="gc-note">При изменении цены сохраняется запись в «Истории цен»: отчёты за прошлые даты считаются по цене, действовавшей на дату выдачи заказа.</span></div>
  </form>
  <div class="gc-section"><h3>Проверить расчёт заказа</h3><div class="gc-note">Строки «артикул × количество», например <b>KITAPENT00082 x1</b>. Считается по сохранённому справочнику и ценам на выбранную дату.</div>
    <div class="gc-form"><label style="grid-column:span 2">Состав заказа<input class="gc-in" id="gcPrevItems" value="KITAPENT00082 x1"></label><label>Дата выдачи<input class="gc-in" type="date" id="gcPrevDate" value="${esc(S.state.today)}"></label><label>Заказов за месяц<input class="gc-in" id="gcPrevMonth" inputmode="numeric" placeholder="авто"><span class="gc-note">для скотча «рулонов в месяц»</span></label><div class="gc-field">&nbsp;<button class="gc-btn" type="button" id="gcPrevGo">Рассчитать</button></div></div>
    <div id="gcPrevOut"></div></div>`;
}

function formatsSection(c,bagOptions){
  const counts={};for(const id of Object.values(c.skuFormat))counts[id]=(counts[id]||0)+1;
  const rows=c.formats.map((f,i)=>`<tr data-fmt="${i}"><td><input class="gc-in" data-fm="name" value="${esc(f.name)}" style="min-width:80px"></td><td><select class="gc-sel" data-fm="bagId"><option value="">— пакет по умолчанию —</option>${bagOptions(f.bagId)}</select></td><td><input class="gc-in" data-fm="cmPerUnit" inputmode="decimal" value="${f.cmPerUnit==null?'':esc(f.cmPerUnit)}" placeholder="общее"></td><td style="text-align:center"><input type="radio" name="gcDefFmt" value="${esc(f.id)}"${f.id===c.defaultFormat?' checked':''} aria-label="По умолчанию"></td><td class="r">${nf0.format(counts[f.id]||0)}</td><td><button class="gc-btn small danger" type="button" data-delfmt="${i}" title="Удалить формат">✕</button></td></tr>`).join('');
  const q=(S.fmtFilter||'').trim().toUpperCase();
  const all=Object.entries(c.skuFormat).filter(([sku,id])=>!q||sku.includes(q)||((c.formats.find(f=>f.id===id)||{}).name||'').toUpperCase()===q);
  const shown=all.slice(0,200);
  const fmtOptions=c.formats.map(f=>`<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('');
  return `<div class="gc-section"><h3>Форматы товара</h3><div class="gc-note">Формат задаёт пакет по умолчанию и см стрейча на 1 единицу. Порядок выбора: переопределение по артикулу → формат артикула (или формат по умолчанию) → общие значения. В заказе с разными форматами берётся самый крупный пакет.</div>
    <div class="gc-tablebox"><table class="gc-table" style="min-width:640px"><thead><tr><th>Формат</th><th>Пакет</th><th>См стрейча на 1 шт</th><th>По умолч.</th><th class="r">Артикулов</th><th></th></tr></thead><tbody>${rows||'<tr><td colspan="6" class="gc-empty">Нет форматов</td></tr>'}</tbody></table></div>
    <div class="gc-actions"><button class="gc-btn small" type="button" id="gcAddFmt">＋ Добавить формат</button><label class="gc-note" style="display:flex;gap:6px;align-items:center"><input type="radio" name="gcDefFmt" value=""${c.defaultFormat?'':' checked'}> без формата по умолчанию</label></div>
    <h4 style="margin:14px 0 0;font-size:14px">Массовое назначение</h4><div class="gc-note">Вставьте список артикулов (по одному в строке, через пробел, запятую или «;») и выберите формат.</div>
    <div class="gc-form"><label style="grid-column:1/-1">Артикулы<textarea class="gc-in" id="gcMassSkus" rows="4" placeholder="KITAPENT00082&#10;KITAPENT00083">${esc(S.massSkus||'')}</textarea></label>
    <label>Формат<select class="gc-sel" id="gcMassFmt">${fmtOptions}</select></label>
    <div class="gc-field">&nbsp;<button class="gc-btn" type="button" id="gcMassSet">Назначить</button></div><div class="gc-field">&nbsp;<button class="gc-btn" type="button" id="gcMassClear">Снять формат</button></div></div>
    <h4 style="margin:14px 0 0;font-size:14px">Артикул → формат · ${nf0.format(Object.keys(c.skuFormat).length)}</h4>
    <div class="gc-form"><label>Поиск<input class="gc-in" id="gcFmtFilter" value="${esc(S.fmtFilter||'')}" placeholder="артикул или формат"></label></div>
    ${shown.length?`<div class="gc-tablebox" style="max-height:320px"><table class="gc-table" style="min-width:380px"><thead><tr><th>Артикул</th><th>Формат</th><th></th></tr></thead><tbody>${shown.map(([sku,id])=>`<tr><td>${esc(sku)}</td><td><select class="gc-sel" data-skufmt="${esc(sku)}">${c.formats.map(f=>`<option value="${esc(f.id)}"${f.id===id?' selected':''}>${esc(f.name)}</option>`).join('')}</select></td><td><button class="gc-btn small danger" type="button" data-delskufmt="${esc(sku)}">✕</button></td></tr>`).join('')}</tbody></table></div>${all.length>shown.length?`<div class="gc-note">Показаны первые 200 из ${nf0.format(all.length)} — уточните поиск.</div>`:''}`:'<div class="gc-note" style="margin-top:6px">Привязок пока нет.</div>'}
  </div>`;
}
function tapesSection(c){
  const rows=c.tapes.map((t,i)=>`<tr data-tape="${i}"><td><input class="gc-in" data-t="name" value="${esc(t.name)}" style="min-width:150px"></td><td><input class="gc-in" data-t="packPrice" inputmode="decimal" value="${esc(t.packPrice)}"></td><td><select class="gc-sel" data-t="mode"><option value="month"${t.mode==='month'?' selected':''}>рулонов в месяц</option><option value="order"${t.mode==='order'?' selected':''}>см на заказ</option></select></td><td><input class="gc-in" data-t="rollsPerMonth" inputmode="decimal" value="${esc(t.rollsPerMonth)}"${t.mode==='month'?'':' disabled'}></td><td><input class="gc-in" data-t="cmPerOrder" inputmode="decimal" value="${esc(t.cmPerOrder)}"${t.mode==='order'?'':' disabled'}></td><td><input class="gc-in" data-t="lengthM" inputmode="decimal" value="${esc(t.lengthM)}"${t.mode==='order'?'':' disabled'}></td><td class="r" data-tapeunit="${i}"></td><td><input class="gc-in" type="date" data-from="tape:${esc(t.id)}" max="${esc(S.state.today)}" value="${esc(S.state.today)}"></td><td>${stockLine('tape:'+t.id)}</td><td><button class="gc-btn small danger" type="button" data-deltape="${i}" title="Удалить">✕</button></td></tr>`).join('');
  return `<div class="gc-section"><h3>d) Скотч</h3><div class="gc-note"><b>Рулонов в месяц:</b> стоимость на заказ = рулонов в месяц × цена рулона / число заказов за этот календарный месяц (выданные, без отменённых); для текущего месяца число заказов — прогноз по прошедшим дням. Остаток — в рулонах, расход = рулоны/месяц пропорционально прошедшим дням. <b>См на заказ:</b> см × цена рулона / (длина × 100).</div>
    <div class="gc-tablebox"><table class="gc-table" style="min-width:1100px"><thead><tr><th>Название</th><th>Цена за рулон, ₸</th><th>Режим</th><th>Рулонов в месяц</th><th>См на заказ</th><th>Длина рулона, м</th><th class="r">Цена</th><th>Цена действует с</th><th>Остаток</th><th></th></tr></thead><tbody>${rows||'<tr><td colspan="10" class="gc-empty">Нет скотча</td></tr>'}</tbody></table></div>
    <div class="gc-actions"><button class="gc-btn small" type="button" id="gcAddTape">＋ Добавить скотч</button></div></div>`;
}
function setPath(obj,path,value){const parts=path.split('.');let o=obj;for(let i=0;i<parts.length-1;i++)o=o[parts[i]];o[parts[parts.length-1]]=value}
function readBook(){
  const c=draft(),form=$('#gcBook');if(!form)return c;
  form.querySelectorAll('[data-f]').forEach(el=>{const p=el.dataset.f;const v=el.tagName==='SELECT'?el.value:el.value.trim();setPath(c,p,el.tagName==='SELECT'?v:v)});
  form.querySelectorAll('tr[data-bag]').forEach(tr=>{const b=c.bags[Number(tr.dataset.bag)];if(!b)return;tr.querySelectorAll('[data-b]').forEach(el=>{b[el.dataset.b]=el.dataset.b==='name'?el.value:el.value.trim()})});
  const def=form.querySelector('input[name="gcDefBag"]:checked');if(def)c.defaultBag=def.value;
  form.querySelectorAll('tr[data-fmt]').forEach(tr=>{const f=c.formats[Number(tr.dataset.fmt)];if(!f)return;tr.querySelectorAll('[data-fm]').forEach(el=>{const v=el.value.trim();f[el.dataset.fm]=el.dataset.fm==='cmPerUnit'?(v===''?null:v):v})});
  const defFmt=form.querySelector('input[name="gcDefFmt"]:checked');if(defFmt)c.defaultFormat=defFmt.value;
  form.querySelectorAll('[data-skufmt]').forEach(el=>{c.skuFormat[el.dataset.skufmt]=el.value});
  form.querySelectorAll('tr[data-tape]').forEach(tr=>{const t=c.tapes[Number(tr.dataset.tape)];if(!t)return;tr.querySelectorAll('[data-t]').forEach(el=>{t[el.dataset.t]=el.dataset.t==='name'||el.dataset.t==='mode'?el.value:el.value.trim()})});
  const mass=$('#gcMassSkus');if(mass)S.massSkus=mass.value;
  c.bagBySku={};form.querySelectorAll('#gcSkuBag tr').forEach(tr=>{const sku=tr.querySelector('[data-skubag="sku"]').value.trim().toUpperCase(),bag=tr.querySelector('[data-skubag="bag"]').value;if(sku)c.bagBySku[sku]=bag});
  c.stretch.bySku={};form.querySelectorAll('#gcSkuStretch tr').forEach(tr=>{const sku=tr.querySelector('[data-skustretch="sku"]').value.trim().toUpperCase(),cm=tr.querySelector('[data-skustretch="cm"]').value.trim();if(sku)c.stretch.bySku[sku]=cm});
  return c;
}
// Same rules as the server: prices and quantities ≥ 0, pack quantity > 0.
function validate(){
  const form=$('#gcBook');let ok=true;
  form.querySelectorAll('.gc-in').forEach(el=>el.classList.remove('bad'));
  const mark=(el,cond)=>{if(!cond){el.classList.add('bad');ok=false}};
  form.querySelectorAll('[data-f]').forEach(el=>{if(el.tagName==='SELECT')return;const p=el.dataset.f,v=parseNum(el.value);if(/packQty|lengthM|planDays|warnDays/.test(p))mark(el,Number.isFinite(v)&&v>0);else mark(el,Number.isFinite(v)&&v>=0)});
  form.querySelectorAll('tr[data-bag] [data-b]').forEach(el=>{const k=el.dataset.b;if(k==='name')return;const v=parseNum(el.value);mark(el,k==='packQty'?Number.isFinite(v)&&v>0:el.value.trim()===''||Number.isFinite(v)&&v>=0)});
  form.querySelectorAll('[data-skustretch="cm"]').forEach(el=>{const v=parseNum(el.value);mark(el,Number.isFinite(v)&&v>=0)});
  form.querySelectorAll('[data-fm="cmPerUnit"]').forEach(el=>{if(el.value.trim()==='')return;const v=parseNum(el.value);mark(el,Number.isFinite(v)&&v>=0)});
  form.querySelectorAll('tr[data-tape] [data-t]').forEach(el=>{const k=el.dataset.t;if(k==='name'||k==='mode'||el.disabled)return;const v=parseNum(el.value);mark(el,k==='lengthM'?Number.isFinite(v)&&v>0:Number.isFinite(v)&&v>=0)});
  return ok;
}
function updateUnits(){
  const form=$('#gcBook');if(!form)return;
  const v=p=>parseNum((form.querySelector(`[data-f="${p}"]`)||{}).value);
  const set=(key,val)=>{const el=form.querySelector(`[data-unit="${key}"]`);if(el)el.textContent=Number.isFinite(val)?unitMoney(val):'—'};
  set('label',v('label.packQty')>0?v('label.packPrice')/v('label.packQty'):NaN);
  set('stretch',v('stretch.lengthM')>0?v('stretch.packPrice')/(v('stretch.lengthM')*100):NaN);
  form.querySelectorAll('tr[data-tape]').forEach(tr=>{const g=k=>parseNum(tr.querySelector(`[data-t="${k}"]`).value),mode=tr.querySelector('[data-t="mode"]').value,cell=tr.querySelector('[data-tapeunit]');if(!cell)return;if(mode==='month'){const m=g('rollsPerMonth')*g('packPrice');cell.textContent=Number.isFinite(m)?money(m)+'/мес':'—'}else{const l=g('lengthM');cell.textContent=l>0?unitMoney(g('packPrice')/(l*100))+'/см':'—'}});
  form.querySelectorAll('tr[data-bag]').forEach(tr=>{const p=parseNum(tr.querySelector('[data-b="packPrice"]').value),q=parseNum(tr.querySelector('[data-b="packQty"]').value),cell=tr.querySelector('[data-unit]');if(cell)cell.textContent=q>0&&p>=0?unitMoney(p/q):'—'});
}
function bindBook(){
  const form=$('#gcBook');if(!form)return;
  updateUnits();form.addEventListener('input',updateUnits);
  $('#gcAddBag').onclick=()=>{const c=readBook();c.bags.push({id:'bag-'+Date.now().toString(36),name:'Пакет '+(c.bags.length+1),width:'',height:'',flap:'',packPrice:0,packQty:100});render()};
  form.querySelectorAll('[data-delbag]').forEach(b=>b.onclick=()=>{const c=readBook(),i=Number(b.dataset.delbag),bag=c.bags[i];if(!bag)return;if(!confirm('Удалить «'+bag.name+'»? История цен сохранится для старых отчётов.'))return;c.bags.splice(i,1);if(c.defaultBag===bag.id)c.defaultBag=c.bags[0]?c.bags[0].id:'';if(c.bagRule.bagId===bag.id)c.bagRule.bagId='';for(const [k,v] of Object.entries(c.bagBySku))if(v===bag.id)delete c.bagBySku[k];render()});
  $('#gcAddSkuBag').onclick=()=>{const c=readBook();if(!c.bags.length)return toast('Сначала добавьте размер пакета','warn');c.bagBySku['']=c.bags[0].id;render();const rows=root.querySelectorAll('#gcSkuBag tr');const last=rows[rows.length-1];if(last)last.querySelector('input').focus()};
  $('#gcAddSkuStretch').onclick=()=>{const c=readBook();c.stretch.bySku['']=c.stretch.cmPerUnit;render();const rows=root.querySelectorAll('#gcSkuStretch tr');const last=rows[rows.length-1];if(last)last.querySelector('input').focus()};
  form.querySelectorAll('[data-delrow]').forEach(b=>b.onclick=()=>{b.closest('tr').remove()});
  form.querySelectorAll('[data-t="mode"]').forEach(el=>el.onchange=()=>{readBook();render()});
  $('#gcAddTape').onclick=()=>{const c=readBook();c.tapes.push({id:'tape-'+Date.now().toString(36),name:'Скотч '+(c.tapes.length+1),packPrice:0,mode:'month',rollsPerMonth:1,cmPerOrder:50,lengthM:100});render()};
  form.querySelectorAll('[data-deltape]').forEach(b=>b.onclick=()=>{const c=readBook(),t=c.tapes[Number(b.dataset.deltape)];if(!t||!confirm('Удалить «'+t.name+'»? История цен сохранится для старых отчётов.'))return;c.tapes.splice(Number(b.dataset.deltape),1);render()});
  $('#gcAddFmt').onclick=()=>{const c=readBook();c.formats.push({id:'fmt-'+Date.now().toString(36),name:'Формат '+(c.formats.length+1),bagId:'',cmPerUnit:null});render()};
  form.querySelectorAll('[data-delfmt]').forEach(b=>b.onclick=()=>{const c=readBook(),i=Number(b.dataset.delfmt),f=c.formats[i];if(!f)return;const n=Object.values(c.skuFormat).filter(id=>id===f.id).length;if(!confirm('Удалить формат «'+f.name+'»?'+(n?' Привязка снимется у '+n+' артикулов.':'')))return;c.formats.splice(i,1);for(const [k,v] of Object.entries(c.skuFormat))if(v===f.id)delete c.skuFormat[k];if(c.defaultFormat===f.id)c.defaultFormat=c.formats[0]?c.formats[0].id:'';render()});
  const massList=()=>[...new Set(($('#gcMassSkus').value||'').split(/[\s,;]+/).map(x=>x.trim().toUpperCase()).filter(Boolean))];
  $('#gcMassSet').onclick=()=>{const c=readBook(),list=massList(),fmt=$('#gcMassFmt').value;if(!list.length)return toast('Вставьте артикулы','warn');if(!fmt)return toast('Сначала добавьте формат','warn');for(const sku of list)c.skuFormat[sku]=fmt;S.massSkus='';render();toast('Формат «'+((c.formats.find(f=>f.id===fmt)||{}).name||fmt)+'» назначен '+list.length+' артикулам. Не забудьте сохранить справочник.','info',6000)};
  $('#gcMassClear').onclick=()=>{const c=readBook(),list=massList();let n=0;for(const sku of list)if(c.skuFormat[sku]){delete c.skuFormat[sku];n++}S.massSkus='';render();toast('Формат снят у '+n+' артикулов. Не забудьте сохранить справочник.','info',6000)};
  form.querySelectorAll('[data-delskufmt]').forEach(b=>b.onclick=()=>{const c=readBook();delete c.skuFormat[b.dataset.delskufmt];render()});
  const filter=$('#gcFmtFilter');if(filter)filter.onchange=()=>{readBook();S.fmtFilter=filter.value;render();const f=$('#gcFmtFilter');if(f)f.focus()};
  $('#gcReset').onclick=()=>{S.draft=null;render()};
  $('#gcSave').onclick=async()=>{
    if(!validate())return toast('Проверьте поля, выделенные красным: цены и количества ≥ 0, количество в упаковке > 0','warn',6000);
    const config=readBook(),priceFrom={};
    form.querySelectorAll('[data-from]').forEach(el=>{if(el.value)priceFrom[el.dataset.from]=el.value});
    const btn=$('#gcSave');btn.disabled=true;
    try{
      const r=await api('config',{body:{config,priceFrom}});S.state=r;S.draft=null;S.now=null;S.massSkus='';
      toast(r.priceChanges&&r.priceChanges.length?'Сохранено. Новых цен в истории: '+r.priceChanges.length+'. Отчёты «Продажи» и «Динамика» пересчитаны.':'Справочник сохранён','ok',6000);
      changed();render();
    }catch(e){toast('Не удалось сохранить: '+e.message,'err',0)}finally{btn.disabled=false}
  };
  $('#gcPrevGo').onclick=async()=>{
    const items=$('#gcPrevItems').value.split(/[;,\n]+/).map(s=>s.trim()).filter(Boolean).map(s=>{const m=s.match(/^(.*?)(?:\s*[x×*]\s*(\d+))?$/i);return {sku:(m[1]||s).trim(),qty:Number(m[2]||1)}});
    const out=$('#gcPrevOut');out.innerHTML='<div class="gc-note">Считаю…</div>';
    try{const r=await api('preview',{body:{items,date:$('#gcPrevDate').value,monthOrders:parseNum($('#gcPrevMonth').value)||undefined}});out.innerHTML=previewHtml(r.cost,r.date)}catch(e){out.innerHTML='<div class="gc-alert err">'+esc(e.message)+'</div>'}
  };
}
function previewHtml(c,date){
  const u=c.usage,p=c.prices||{};
  if(!u||!u.units)return '<div class="gc-note">В заказе нет товаров.</div>';
  const reason={sku:'по артикулу',format:'по формату',rule:'правило: больше '+S.state.config.bagRule.minUnits+' ед.',default:'по умолчанию'}[u.bagReason]||'';
  const src={sku:'артикул',format:'формат',default:'общее'};
  const steps=[
    `Этикетка: ${u.labels} × ${unitMoney(p.label)} = <b>${money(c.label)}</b>`,
    `Пакет: ${esc(c.bagTitle||'—')} (${esc(reason)}) = <b>${money(c.bag)}</b>`,
    `Стрейч: ${u.items.map(i=>esc(i.sku)+(i.format?' ['+esc(i.format)+(i.ownFormat?'':', по умолч.')+']':'')+' '+i.qty+' × '+nf1.format(i.cmPerUnit)+' см ('+(src[i.cmSource]||'')+')').join(' + ')} = ${nf1.format(u.stretchCm)} см × ${unitMoney(p.stretch)} = <b>${money(c.stretch)}</b>`,
    ...(c.tapes||[]).map(t=>t.mode==='month'?`${esc(t.name)}: ${nf2.format(t.rollsPerMonth)} рул./мес × ${money(t.rollPrice)} / ${t.monthOrders?nf0.format(t.monthOrders)+' заказов'+(t.projected?' (прогноз на месяц)':''):'число заказов за месяц неизвестно'} = <b>${unitMoney(t.cost)}</b>`:`${esc(t.name)}: ${nf1.format(t.cm)} см × ${unitMoney(t.unitPrice)} = <b>${unitMoney(t.cost)}</b>`),
    `Итого на заказ: <b>${money(c.total)}</b>`,
  ];
  const alloc=c.items.length>1?'<div class="gc-note" style="margin-top:6px">По товарам (стрейч — свой, этикетка + пакет + скотч = '+unitMoney(c.shared)+' делятся по количеству): '+c.items.map(i=>esc(i.sku)+' — '+money(i.total)).join('; ')+'</div>':'';
  const prices=(c.missing||[]).filter(k=>!k.endsWith(':orders')),months=(c.missing||[]).filter(k=>k.endsWith(':orders'));
  const miss=(prices.length?'<div class="gc-alert">На '+esc(dmy(date))+' не задана цена: '+esc(prices.map(k=>(S.state.titles||{})[k]||k).join(', '))+' — считается 0 ₸.</div>':'')+(months.length?'<div class="gc-alert">Число заказов за месяц неизвестно (нет в кэше «Динамики продаж») — укажите его в поле «Заказов за месяц». В отчётах оно считается автоматически.</div>':'');
  return miss+'<ol class="gc-steps">'+steps.map(s=>'<li>'+s+'</li>').join('')+'</ol>'+alloc;
}

// ---------- history & journal ----------
function renderPrices(){
  const st=S.state,list=[...st.history].sort((a,b)=>b.from.localeCompare(a.from)||String(b.createdAt).localeCompare(String(a.createdAt)));
  return `<div class="gc-section"><h3>История цен</h3><div class="gc-note">Цена применяется к заказам, выданным начиная с даты «Действует с». Отчёты за прошлые даты не пересчитываются по новой цене. Хранится в скрытом листе «GB_Расходники_Цены».</div>
  ${list.length?`<div class="gc-tablebox"><table class="gc-table" style="min-width:620px"><thead><tr><th>Позиция</th><th>Действует с</th><th class="r">Цена упаковки</th><th class="r">В упаковке</th><th class="r">Цена за ед.</th><th>Записано</th></tr></thead><tbody>${list.map(r=>`<tr><td>${esc((st.titles||{})[r.item]||r.item.replace(/^bag:/,'Пакет '))}</td><td>${esc(dmy(r.from))}</td><td class="r">${money(r.packPrice)}</td><td class="r">${r.packUnits>1&&(r.item==='stretch'||r.item.startsWith('tape:'))?nf1.format(r.packUnits/100)+' м':r.item.startsWith('tape:')?'1 рул.':nf0.format(r.packUnits)+' шт'}</td><td class="r">${unitMoney(r.unitPrice)}${r.packUnits>1&&(r.item==='stretch'||r.item.startsWith('tape:'))?'/см':r.item.startsWith('tape:')?'/рул.':''}</td><td>${esc(dmy(r.createdAt))}</td></tr>`).join('')}</tbody></table></div>`:'<div class="gc-empty">Цен ещё нет — заполните «Справочник».</div>'}</div>`;
}
function renderJournal(){
  const st=S.state,list=st.journal||[];
  return `<div class="gc-section"><h3>Журнал операций</h3><div class="gc-note">Приходы и инвентаризации. Расход по заказам списывается автоматически и сюда не пишется.</div>
  ${list.length?`<div class="gc-tablebox"><table class="gc-table" style="min-width:600px"><thead><tr><th>Дата</th><th>Позиция</th><th>Операция</th><th class="r">Количество</th><th>Комментарий</th></tr></thead><tbody>${list.map(r=>`<tr><td>${esc(dmy(r.at))}</td><td>${esc((st.titles||{})[r.item]||r.item)}</td><td>${r.type==='inventory'?'📋 Инвентаризация':'＋ Приход'}</td><td class="r">${r.type==='inventory'?'= ':'+'}${qtyText(r.item,r.qty,(st.prices[r.item]||{}).packUnits)}</td><td>${esc(r.comment)}</td></tr>`).join('')}</tbody></table></div>`:'<div class="gc-empty">Операций пока нет.</div>'}</div>`;
}

// ---------- open / close / nav ----------
function setUrl(open){try{const q=new URLSearchParams(location.search);if(open)q.set('gc','1');else q.delete('gc');const s=q.toString();history.replaceState(history.state,'',location.pathname+(s?'?'+s:'')+location.hash)}catch{}}
function open(tab){build();if(tab&&TABS.some(t=>t[0]===tab))S.tab=tab;if(!S.open)S.overflow=document.body.style.overflow;S.open=true;root.style.display='block';document.body.style.overflow='hidden';setUrl(true);render();loadState();if(S.tab==='now')loadNow()}
function close(){S.open=false;if(root)root.style.display='none';document.body.style.overflow=S.overflow||'';setUrl(false)}

// «🧻 Расходники» goes right after «📦 Мой склад» (fallback: after «Динамика продаж»).
function nav(force){
  const existing=$('#gbConsumablesNav'),wh=$('#gbWhNav');
  if(existing){if(wh&&existing.previousElementSibling!==wh&&wh.parentElement)wh.parentElement.insertBefore(existing,wh.nextSibling);return !!wh}
  const all=[...document.querySelectorAll('button,a')];
  const ref=wh||(force?(all.find(x=>/Динамика продаж/i.test(x.textContent||''))||all.find(x=>/Прайс Kaspi/i.test(x.textContent||''))):null);
  if(!ref||!ref.parentElement)return false;
  const b=document.createElement('button');b.id='gbConsumablesNav';b.type='button';b.className=ref.className;b.classList.remove('on','active');b.textContent='🧻 Расходники';b.onclick=()=>open();
  ref.parentElement.insertBefore(b,ref.nextSibling);return !!wh;
}

window.GBConsumables={open,close,reload:()=>loadState(true)};
let tries=0;const boot=setInterval(()=>{tries++;if(nav(tries>40)||tries>240)clearInterval(boot)},250);
if(new URLSearchParams(location.search).get('gc')==='1')setTimeout(()=>open(),700);
window.addEventListener('keydown',e=>{if(e.key==='Escape'&&S.open&&!document.querySelector('.gc-modal'))close()});
})();
