(()=>{
'use strict';
if(window.GB_PREORDER_DATES_V2_LOADED)return;
window.GB_PREORDER_DATES_V2_LOADED=true;
window.GB_PREORDER_DATES_LOADED=true;
const API='/api/preorder-dates';
const LIVE_API='/api/data?op=orders';
const LIVE_FALLBACK='https://grants-book-kaspi-assistant-aex41sn9x-dias10.vercel.app/api/data?op=orders';
const $=s=>document.querySelector(s);
const esc=v=>String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const codeKey=s=>String(s||'').trim().replace(/-1$/,'');
const norm=s=>String(s||'').trim().toUpperCase();
let orders=[],liveByOrder=new Map(),filter='all',query='';

function dayKey(d=new Date()){const x=new Date(d.getTime()+5*3600000);return x.toISOString().slice(0,10)}
function plusDay(k,n){const d=new Date(k+'T00:00:00+05:00');return dayKey(new Date(d.getTime()+n*86400000))}
function fmtDay(k){if(!k)return'Дата не определена';const d=new Date(k+'T00:00:00+05:00');return new Intl.DateTimeFormat('ru-RU',{timeZone:'Asia/Almaty',day:'numeric',month:'long',weekday:'long'}).format(d)}
function fmtShort(k){if(!k)return'';const [y,m,d]=k.split('-');return `${d}.${m}.${y}`}
function fmtDT(ms){if(!Number(ms))return'—';return new Date(Number(ms)).toLocaleString('ru-RU',{timeZone:'Asia/Almaty',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}
function money(n){return new Intl.NumberFormat('ru-RU').format(Number(n)||0)+' ₸'}

async function jsonResponse(response,label){
  const text=await response.text();
  let data;
  try{data=text?JSON.parse(text):{}}catch{throw Error(`${label}: сервер вернул не JSON (HTTP ${response.status})`)}
  if(!response.ok)throw Error(data?.error||`${label}: HTTP ${response.status}`);
  return data;
}

async function fetchLive(){
  const urls=[LIVE_API,LIVE_FALLBACK];
  let last=null;
  for(const url of urls){
    try{
      const r=await fetch(url+(url.includes('?')?'&':'?')+'_='+Date.now(),{cache:'no-store'});
      const j=await jsonResponse(r,'Заказы');
      if(Array.isArray(j?.rows))return j.rows;
    }catch(e){last=e}
  }
  console.warn('Live order enrichment unavailable',last);
  return [];
}
function buildLiveMap(rows){
  const map=new Map();
  for(const r of rows||[]){
    const code=codeKey(r?.orderCode);if(!code)continue;
    const item={sku:norm(r?.sku),qty:Math.max(1,Number(r?.quantity)||1),name:String(r?.name||r?.sku||'Товар'),photo:String(r?.photo||'').trim()};
    if(!map.has(code))map.set(code,[]);
    const list=map.get(code),key=item.sku+'|'+item.name;
    const old=list.find(x=>(x.sku+'|'+x.name)===key);
    if(old){old.qty=Math.max(old.qty,item.qty);if(!old.photo&&item.photo)old.photo=item.photo}else list.push(item);
  }
  liveByOrder=map;
}
function itemInfo(o){return liveByOrder.get(codeKey(o.code))||[]}

function css(){
  if($('#gbPreCssV2'))return;
  const s=document.createElement('style');s.id='gbPreCssV2';s.textContent=`
#gbPre{position:fixed;inset:58px 0 0;z-index:2147483450;background:#f5f7fa;display:none;overflow:auto;font-family:Inter,Arial,sans-serif;color:#101828}#gbPre *{box-sizing:border-box}.pdh{position:sticky;top:0;z-index:30;background:#fff;border-bottom:1px solid #e4e7ec;padding:13px 18px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}.pdt{font-size:25px;font-weight:950;margin-right:auto}.pdsub{font-size:12px;color:#667085;margin-top:2px}.pdbtn{border:1px solid #d0d5dd;background:#fff;border-radius:11px;padding:9px 12px;font-weight:850;cursor:pointer;color:#101828}.pdbtn.dark{background:#111;color:#fff;border-color:#111}.pdbtn.green{background:#12b76a;color:#fff;border-color:#12b76a}.pdbtn.blue{background:#1570ef;color:#fff;border-color:#1570ef}.pdbtn:disabled{opacity:.5;cursor:not-allowed}.pdbody{padding:16px;max-width:1550px;margin:auto}.pdkpis{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:13px}.pdk{background:#fff;border:1px solid #e4e7ec;border-radius:15px;padding:12px}.pdkl{font-size:10px;text-transform:uppercase;color:#667085;font-weight:900}.pdkv{font-size:27px;font-weight:950;margin-top:5px}.pdtools{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:14px}.pdsearch{flex:1;min-width:240px;border:1px solid #d0d5dd;border-radius:11px;padding:10px 12px;font-weight:700}.pdchip{border:1px solid #d0d5dd;background:#fff;border-radius:999px;padding:8px 11px;font-weight:850;cursor:pointer}.pdchip.on{background:#111;color:#fff;border-color:#111}.pdgroup{background:#fff;border:1px solid #e4e7ec;border-radius:18px;margin-bottom:14px;overflow:hidden}.pdghead{padding:13px 15px;background:#f9fafb;border-bottom:1px solid #eaecf0;display:flex;gap:10px;align-items:center;flex-wrap:wrap}.pdgdate{font-size:18px;font-weight:950}.pdgcount{font-size:12px;color:#667085;font-weight:800}.pdghead.today{background:#fffaeb}.pdghead.overdue{background:#fef3f2}.pdghead.today .pdgdate{color:#b54708}.pdghead.overdue .pdgdate{color:#b42318}.pdcard{display:grid;grid-template-columns:125px minmax(260px,1.25fr) minmax(210px,.7fr) minmax(260px,.8fr);gap:14px;align-items:center;padding:14px;border-top:1px solid #f2f4f7}.pdcard:first-child{border-top:0}.pdpics{display:flex;gap:6px;flex-wrap:wrap}.pdpicbox{width:64px;height:82px;border:1px solid #e4e7ec;border-radius:10px;background:#fff;position:relative;display:flex;align-items:center;justify-content:center;overflow:hidden;color:#98a2b3;font-size:10px;text-align:center}.pdpicbox img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#fff}.pdcode{font:900 16px ui-monospace,SFMono-Regular,Menlo,monospace}.pdnames{font-size:13px;font-weight:800;margin-top:6px;line-height:1.35}.pdmeta{font-size:11px;color:#667085;margin-top:5px}.pddate{font-size:16px;font-weight:950}.pddate small{display:block;font-size:11px;color:#667085;margin-top:4px;font-weight:700}.pdactions{display:flex;gap:8px;flex-direction:column}.pddateedit{display:grid;grid-template-columns:1fr auto;gap:7px}.pddateinput{width:100%;border:1px solid #b8c1ce;border-radius:11px;padding:9px 11px;font-weight:800;background:#fff}.pdnote{font-size:10px;line-height:1.35;color:#667085}.pdmsg{display:none;margin-bottom:12px;padding:10px 12px;border-radius:11px;font-weight:850}.pdmsg.show{display:block}.pdmsg.ok{background:#ecfdf3;color:#027a48}.pdmsg.warn{background:#fffaeb;color:#b54708}.pdmsg.err{background:#fef3f2;color:#b42318}.pdempty{padding:36px;text-align:center;color:#667085;font-weight:800}.pdspin{padding:30px;text-align:center;font-weight:850;color:#667085}@media(max-width:950px){.pdkpis{grid-template-columns:repeat(2,1fr)}.pdcard{grid-template-columns:110px 1fr}.pdactions{grid-column:1/-1}.pdt{font-size:21px}}@media(max-width:620px){#gbPre{inset:52px 0 0}.pdcard{grid-template-columns:1fr}.pdpics{grid-column:1}.pdactions{grid-column:1}.pdkpis{grid-template-columns:repeat(2,1fr)}}`;
  document.head.appendChild(s);
}
function nav(){
  if($('#gbPreNav'))return true;
  const e=[...document.querySelectorAll('button,a')],ref=e.find(x=>/Принятие товара/i.test(x.textContent||''))||e.find(x=>/Мой склад/i.test(x.textContent||''))||e.find(x=>/Динамика продаж/i.test(x.textContent||''));
  if(!ref?.parentElement)return false;
  const b=document.createElement('button');b.id='gbPreNav';b.className=ref.className;b.textContent='📅 Даты принятия';b.onclick=open;ref.parentElement.insertBefore(b,ref);return true;
}
function showMsg(t,type='warn'){const m=$('#pdmsg');if(!m)return;m.textContent=t;m.className='pdmsg show '+type;setTimeout(()=>{if(m.textContent===t)m.className='pdmsg'},6500)}
function build(){
  css();let o=$('#gbPre');if(o){o.innerHTML='';o.remove()}
  o=document.createElement('section');o.id='gbPre';
  o.innerHTML=`<div class="pdh"><div><div class="pdt">Даты принятия предзаказов</div><div class="pdsub">Показывается только фактическая дата из Kaspi. Локальная подмена даты отключена.</div></div><button id="pdrefresh" class="pdbtn">↻ Обновить</button><button id="pdclose" class="pdbtn dark">Закрыть</button></div><div class="pdbody"><div id="pdmsg" class="pdmsg"></div><div class="pdkpis"><div class="pdk"><div class="pdkl">Сегодня</div><div id="pdtoday" class="pdkv">0</div></div><div class="pdk"><div class="pdkl">Просрочено</div><div id="pdoverdue" class="pdkv">0</div></div><div class="pdk"><div class="pdkl">Ближайшие 7 дней</div><div id="pdweek" class="pdkv">0</div></div><div class="pdk"><div class="pdkl">Всего ждут прибытия</div><div id="pdtotal" class="pdkv">0</div></div></div><div class="pdtools"><button class="pdchip on" data-f="all">Все</button><button class="pdchip" data-f="today">Сегодня</button><button class="pdchip" data-f="overdue">Просрочено</button><button class="pdchip" data-f="week">7 дней</button><input id="pdq" class="pdsearch" placeholder="Поиск по номеру заказа, товару или артикулу"></div><div id="pdcontent"><div class="pdspin">Загрузка предзаказов…</div></div></div>`;
  document.body.appendChild(o);$('#pdclose').onclick=close;$('#pdrefresh').onclick=()=>load(true);$('#pdq').oninput=e=>{query=String(e.target.value||'').trim().toLowerCase();render()};o.querySelectorAll('[data-f]').forEach(b=>b.onclick=()=>{filter=b.dataset.f;o.querySelectorAll('[data-f]').forEach(x=>x.classList.toggle('on',x===b));render()});return o;
}
function filtered(){const today=dayKey(),week=plusDay(today,7);return orders.filter(o=>{const d=o.arrivalDate||'';if(filter==='today'&&d!==today)return false;if(filter==='overdue'&&(!d||d>=today))return false;if(filter==='week'&&(!d||d<today||d>week))return false;if(query){const its=itemInfo(o),hay=[o.code,...its.flatMap(x=>[x.sku,x.name])].join(' ').toLowerCase();if(!hay.includes(query))return false}return true})}
function photoHtml(items){const list=(items||[]).slice(0,3);if(!list.length)return'<div class="pdpicbox">Нет фото</div>';return list.map(x=>x.photo?`<div class="pdpicbox"><span>Нет фото</span><img src="${esc(x.photo)}" alt="" loading="lazy" onerror="this.style.display='none'"></div>`:'<div class="pdpicbox">Нет фото</div>').join('')}
function render(){
  const today=dayKey(),week=plusDay(today,7);$('#pdtoday').textContent=orders.filter(x=>x.arrivalDate===today).length;$('#pdoverdue').textContent=orders.filter(x=>x.arrivalDate&&x.arrivalDate<today).length;$('#pdweek').textContent=orders.filter(x=>x.arrivalDate&&x.arrivalDate>=today&&x.arrivalDate<=week).length;$('#pdtotal').textContent=orders.length;
  const a=filtered(),groups=new Map();for(const o of a){const k=o.arrivalDate||'9999-99-99';if(!groups.has(k))groups.set(k,[]);groups.get(k).push(o)}const c=$('#pdcontent');if(!a.length){c.innerHTML='<div class="pdempty">Нет предзаказов для выбранного фильтра.</div>';return}
  c.innerHTML=[...groups.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([k,list])=>{const cls=k===today?'today':(k<today?'overdue':''),title=k==='9999-99-99'?'Дата прибытия не определена':fmtDay(k)+' · до 23:59';return `<section class="pdgroup"><div class="pdghead ${cls}"><div class="pdgdate">${esc(title)}</div><div class="pdgcount">${list.length} заказ(ов)</div></div><div>${list.map(card).join('')}</div></section>`}).join('');
  c.querySelectorAll('[data-arrived]').forEach(b=>b.onclick=()=>arrived(b.dataset.arrived,b));c.querySelectorAll('[data-change]').forEach(b=>b.onclick=()=>changeDate(b.dataset.change));
}
function card(o){
  const its=itemInfo(o),names=its.length?its.map(x=>`${esc(x.name)}${x.qty>1?' ×'+x.qty:''}`).join('<br>'):'Товар: данные изображения загружаются из активных заказов',skus=its.map(x=>x.sku).filter(Boolean).join(', '),tx=o.courierTransmissionPlanningDate?fmtDT(o.courierTransmissionPlanningDate):'—',d=o.arrivalDate||'';
  return `<article class="pdcard"><div class="pdpics">${photoHtml(its)}</div><div><div class="pdcode">№ ${esc(o.code)}</div><div class="pdnames">${names}</div><div class="pdmeta">${skus?'Артикул: '+esc(skus)+' · ':''}${money(o.totalPrice)}</div></div><div><div class="pddate">${d?esc(fmtDay(d)):'—'}<small>Фактическая дата из Kaspi</small></div><div class="pdmeta">Передача курьеру: ${esc(tx)}<br>Доставка клиенту: ${esc(fmtDT(o.plannedDeliveryDate))}</div></div><div class="pdactions"><div class="pddateedit"><input class="pddateinput" type="date" data-date-input="${esc(codeKey(o.code))}" value="${esc(d)}"><button class="pdbtn blue" data-change="${esc(o.code)}">Изменить дату</button></div><div class="pdnote">Выбрать новую дату можно здесь. GRANTS BOOK не покажет её как применённую, пока Kaspi реально не вернёт новую дату.</div><button class="pdbtn green" data-arrived="${esc(o.code)}">✓ Товар прибыл</button></div></article>`;
}
function dateInput(code){const k=codeKey(code);return [...document.querySelectorAll('[data-date-input]')].find(x=>x.dataset.dateInput===k)||null}
async function changeDate(code){
  const inp=dateInput(code),d=String(inp?.value||'');if(!/^\d{4}-\d{2}-\d{2}$/.test(d)){showMsg('Выберите новую дату в календаре.','warn');inp?.focus();return}
  const current=orders.find(x=>codeKey(x.code)===codeKey(code))?.arrivalDate||'';if(d===current){showMsg('Выбрана текущая дата Kaspi: '+fmtShort(d)+'.','warn');return}
  try{
    const r=await fetch(API,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'changeDate',code,newDate:d})});const j=await jsonResponse(r,'Изменение даты');
    if(j?.ok){await load(false);showMsg('Kaspi подтвердил изменение даты заказа '+code+'.','ok');return}
  }catch(e){
    try{await navigator.clipboard.writeText(`${code} новая дата ${fmtShort(d)}`)}catch{}
    window.open('https://kaspi.kz/mc/','_blank','noopener');showMsg('Kaspi API не разрешает менять планируемую дату прибытия. Номер заказа и выбранная дата скопированы; открыт кабинет Kaspi.','warn');
  }
}
async function arrived(code,b){
  if(!confirm('Подтвердить в Kaspi, что товар по заказу '+code+' прибыл?\n\nЗаказ будет реально переведён в статус ARRIVED.'))return;b.disabled=true;b.textContent='Отмечаю…';
  try{const r=await fetch(API,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'arrived',code})}),j=await jsonResponse(r,'Kaspi');if(!j.ok)throw Error(j.error||'Kaspi не подтвердил действие');orders=orders.filter(x=>codeKey(x.code)!==codeKey(code));render();showMsg('Заказ '+code+' отмечен «Товар прибыл».','ok')}catch(e){showMsg('Не удалось отметить '+code+': '+(e.message||e),'err');b.disabled=false;b.textContent='✓ Товар прибыл'}
}
async function load(force=false){
  const b=$('#pdrefresh');if(b){b.disabled=true;b.textContent='Обновляю…'}$('#pdcontent').innerHTML='<div class="pdspin">Получаю актуальные предзаказы и фотографии…</div>';
  try{
    const [preResult,liveRows]=await Promise.all([fetch(API+'?_='+Date.now(),{cache:'no-store'}).then(r=>jsonResponse(r,'Kaspi API')),fetchLive()]);
    if(!preResult?.ok)throw Error(preResult?.error||'Ошибка Kaspi API');orders=Array.isArray(preResult.orders)?preResult.orders:[];buildLiveMap(liveRows);render();if(force)showMsg('Данные обновлены. Даты взяты из Kaspi; найдено предзаказов: '+orders.length+'.','ok');
  }catch(e){$('#pdcontent').innerHTML='<div class="pdempty">Ошибка загрузки: '+esc(e.message||e)+'</div>';showMsg('Не удалось загрузить даты принятия.','err')}
  finally{if(b){b.disabled=false;b.textContent='↻ Обновить'}}
}
function open(){const o=$('#gbPre')||build();o.style.display='block';load(false)}function close(){$('#gbPre')?.style.setProperty('display','none')}
const old=$('#gbPre');if(old)old.remove();build();nav();let tries=0;const t=setInterval(()=>{if(nav()||++tries>30)clearInterval(t)},700);
})();