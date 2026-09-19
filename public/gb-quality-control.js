(function GBQualityControl(){
'use strict';
if(window.GB_QUALITY_CONTROL_LOADED)return;
window.GB_QUALITY_CONTROL_LOADED=true;

const SID='1dLU5KOi3WBLy3uNEiqGv5rf9ka0OwcEw_RjhDQW3H1E';
const REFRESH_MS=10*60*1000;
let reqSeq=0,loading=false,lastLoaded=0,countdownTimer=null;
let catalog=new Map(),kaspiLinks=new Map(),rawEvents=[],products=[],brands=[];
let scope='products',statusFilter='all',periodDays=30,query='';
const $=s=>document.querySelector(s);
const esc=v=>String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const norm=v=>String(v??'').trim().toUpperCase();
const nf=n=>new Intl.NumberFormat('ru-RU').format(Number(n)||0);
const pct=n=>(Number(n)||0).toLocaleString('ru-RU',{minimumFractionDigits:1,maximumFractionDigits:2})+'%';
const fmtTs=ms=>ms?new Date(ms).toLocaleString('ru-RU',{timeZone:'Asia/Almaty'}):'—';

function jsonp(sheet,tq){
  return new Promise((resolve,reject)=>{
    const cb='__gbq'+Date.now()+'_'+(++reqSeq),s=document.createElement('script');
    const tm=setTimeout(()=>{try{delete window[cb]}catch{};s.remove();reject(new Error('Таймаут Google Sheets: '+sheet))},40000);
    window[cb]=r=>{clearTimeout(tm);try{delete window[cb]}catch{};s.remove();resolve(r)};
    s.onerror=()=>{clearTimeout(tm);try{delete window[cb]}catch{};s.remove();reject(new Error('Не удалось загрузить '+sheet))};
    s.src='https://docs.google.com/spreadsheets/d/'+SID+'/gviz/tq?sheet='+encodeURIComponent(sheet)+'&headers=1&tqx='+encodeURIComponent('out:json;responseHandler:'+cb)+'&tq='+encodeURIComponent(tq)+'&_='+Date.now();
    document.head.appendChild(s);
  });
}
function rows(r){return r?.table?.rows?.map(x=>(x.c||[]).map(c=>c?.v==null?'':String(c.v).trim()))||[]}
function cleanSku(v){return norm(String(v||'').replace(/\s+x\d+$/i,''))}
function brandFallback(sku){const m=norm(sku).match(/^[A-ZА-ЯЁ]+/);return m?.[0]||'Без бренда'}
function statusFromCancel(rate){
  if(rate>=10)return {key:'verybad',label:'Очень плохо',cls:'verybad',rank:4};
  if(rate>=3)return {key:'bad',label:'Плохо',cls:'bad',rank:3};
  if(rate>=1)return {key:'normal',label:'Нормально',cls:'normal',rank:2};
  return {key:'good',label:'Отлично / хорошо',cls:'good',rank:1};
}
function needOrders(cancelled,total,target=0.01){
  cancelled=Math.max(0,Number(cancelled)||0);total=Math.max(0,Number(total)||0);
  if(!cancelled||!total||cancelled/total<target)return 0;
  return Math.max(0,Math.floor(cancelled/target-total)+1);
}
function ageOk(ms,days){if(!days||days>=9999)return true;const n=Number(ms)||0;return n>0&&n>=Date.now()-days*86400000}
function help(st){
  if(st.key==='verybad')return 'Критично: проверить остатки, сроки и причины отмен. При необходимости временно снять товар.';
  if(st.key==='bad')return 'Разобрать отменённые заказы и исправить остатки/сроки до новых продаж.';
  if(st.key==='normal')return 'Довести долю отмен ниже 1%.';
  return 'Контролировать и не допускать новых отмен.';
}

function aggregate(){
  const bySku=new Map();
  for(const e of rawEvents){
    if(!ageOk(e.ms,periodDays))continue;
    const sku=cleanSku(e.sku);if(!sku)continue;
    let x=bySku.get(sku);
    if(!x){
      const c=catalog.get(sku)||{};
      x={sku,name:c.name||sku,brand:c.brand||brandFallback(sku),orders:new Set(),cancelled:new Set(),units:0,cancelUnits:0,cancelCodes:[]};
      bySku.set(sku,x);
    }
    x.orders.add(e.order);
    const q=Math.max(1,Number(e.qty)||1);x.units+=q;
    if(e.status==='CANCELLED'||e.action==='RESTORED'){
      x.cancelled.add(e.order);x.cancelUnits+=q;
      if(!x.cancelCodes.includes(e.order))x.cancelCodes.push(e.order);
    }
  }
  products=[...bySku.values()].map(x=>{
    const total=x.orders.size,c=x.cancelled.size,rate=total?c/total*100:0,st=statusFromCancel(rate);
    return {...x,total,cancelledCount:c,rate,status:st,need:needOrders(c,total),kaspiUrl:kaspiLinks.get(x.sku)||''};
  }).sort((a,b)=>b.status.rank-a.status.rank||b.rate-a.rate||b.cancelledCount-a.cancelledCount||b.total-a.total);

  const byBrand=new Map();
  for(const p of products){
    const k=String(p.brand||'Без бренда').trim()||'Без бренда';
    let b=byBrand.get(k);
    if(!b)b={brand:k,orders:new Set(),cancelled:new Set(),units:0,products:0,badProducts:0,veryBadProducts:0};
    p.orders.forEach(v=>b.orders.add(v));p.cancelled.forEach(v=>b.cancelled.add(v));b.units+=p.units;b.products++;
    if(p.status.key==='bad')b.badProducts++;if(p.status.key==='verybad')b.veryBadProducts++;
  }
  brands=[...byBrand.values()].map(b=>{
    const total=b.orders.size,c=b.cancelled.size,rate=total?c/total*100:0,st=statusFromCancel(rate);
    return {...b,total,cancelledCount:c,rate,status:st,need:needOrders(c,total)};
  }).sort((a,b)=>b.status.rank-a.status.rank||b.rate-a.rate||b.cancelledCount-a.cancelledCount||b.total-a.total);
}

async function load(force=false){
  if(loading)return;
  if(!force&&lastLoaded&&Date.now()-lastLoaded<REFRESH_MS){render();return}
  loading=true;busy(true);message('Обновляю данные GRANTS BOOK…','busy');
  try{
    const [ev,cat,price]=await Promise.all([
      jsonp('_KASPI_ORDER_EVENTS','select C,D,E,G,H,I,J where G is not null'),
      jsonp('Каспи для добавления','select A,B,C where A is not null'),
      jsonp('Прайс KASPI','select A,B,R where A is not null')
    ]);
    rawEvents=rows(ev).map(r=>({order:String(r[0]||'').trim(),ms:Number(r[1])||0,status:norm(r[2]),sku:String(r[3]||'').trim(),qty:Number(r[4])||1,action:norm(r[5]),updated:String(r[6]||'')})).filter(x=>x.order&&x.sku);
    catalog=new Map();
    for(const r of rows(cat)){
      const sku=cleanSku(r[0]);if(!sku||/АРТИКУЛ|MODEL/i.test(sku))continue;
      const prev=catalog.get(sku)||{};
      catalog.set(sku,{name:String(r[1]||prev.name||sku).trim(),brand:String(r[2]||prev.brand||'').trim()});
    }
    kaspiLinks=new Map();
    for(const r of rows(price)){
      const sku=cleanSku(r[0]),name=String(r[1]||'').trim(),url=String(r[2]||'').trim();
      if(!sku||/АРТИКУЛ/i.test(sku))continue;
      const prev=catalog.get(sku)||{};catalog.set(sku,{name:prev.name||name||sku,brand:prev.brand||''});
      if(/^https?:\/\/kaspi\.kz\//i.test(url))kaspiLinks.set(sku,url);
    }
    lastLoaded=Date.now();aggregate();render();message('Данные обновлены · '+fmtTs(lastLoaded),'ok');
  }catch(e){
    console.error('Quality control load failed',e);message('Ошибка обновления: '+String(e?.message||e),'err');
  }finally{loading=false;busy(false);countdown()}
}
function filtered(){
  let a=scope==='brands'?brands:products;
  if(statusFilter!=='all')a=a.filter(x=>x.status.key===statusFilter);
  const q=query.trim().toLowerCase();
  if(q)a=a.filter(x=>scope==='brands'?x.brand.toLowerCase().includes(q):(x.sku+' '+x.name+' '+x.brand).toLowerCase().includes(q));
  return a;
}
function kpis(){
  const orders=new Set(),cancel=new Set();
  for(const x of products){x.orders.forEach(v=>orders.add(v));x.cancelled.forEach(v=>cancel.add(v))}
  const total=orders.size,c=cancel.size;
  return {products:products.length,orders:total,cancellations:c,rate:total?c/total*100:0,bad:products.filter(x=>x.status.key==='bad').length,verybad:products.filter(x=>x.status.key==='verybad').length,brandsRisk:brands.filter(x=>x.status.key==='bad'||x.status.key==='verybad').length};
}
function photo(sku){
  const u=String((window.GB_PHOTOS||{})[norm(sku)]||'').trim();
  return u?'<img class="gbq-photo" src="'+esc(u)+'" loading="lazy" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'grid\'"><div class="gbq-nophoto" style="display:none">Нет фото</div>':'<div class="gbq-nophoto">Нет фото</div>';
}
function statusHtml(st){return '<span class="gbq-status '+st.cls+'">'+esc(st.label)+'</span>'}
function na(){return '<span class="gbq-na" title="Текущая интеграция GRANTS BOOK не получает оценки из Kaspi Pay">—</span>'}
function productRow(x){
  const cancelTitle=x.cancelCodes.length?'Отменённые заказы: '+x.cancelCodes.slice(0,20).join(', '):'Отмен нет';
  const link=x.kaspiUrl?'<a class="gbq-link" href="'+esc(x.kaspiUrl)+'" target="_blank" rel="noopener">Kaspi ↗</a>':'';
  return '<tr><td>'+photo(x.sku)+'</td><td><div class="gbq-name">'+esc(x.name)+'</div><div class="gbq-sub">'+esc(x.brand||'Без бренда')+' '+link+'</div></td><td class="gbq-sku">'+esc(x.sku)+'</td><td><b>'+nf(x.total)+'</b><div class="gbq-sub">'+nf(x.units)+' шт.</div></td><td title="'+esc(cancelTitle)+'"><b>'+nf(x.cancelledCount)+'</b></td><td><b>'+pct(x.rate)+'</b></td><td>'+statusHtml(x.status)+'</td><td><b>'+nf(x.need)+'</b><div class="gbq-sub">успешных до &lt;1%</div></td><td>'+na()+'</td><td>'+na()+'</td><td class="gbq-action">'+esc(help(x.status))+'</td></tr>';
}
function brandRow(x){
  return '<tr><td><div class="gbq-brandicon">B</div></td><td><div class="gbq-name">'+esc(x.brand)+'</div><div class="gbq-sub">'+nf(x.products)+' товаров · проблемных '+nf(x.badProducts+x.veryBadProducts)+'</div></td><td class="gbq-sku">—</td><td><b>'+nf(x.total)+'</b><div class="gbq-sub">'+nf(x.units)+' шт.</div></td><td><b>'+nf(x.cancelledCount)+'</b></td><td><b>'+pct(x.rate)+'</b></td><td>'+statusHtml(x.status)+'</td><td><b>'+nf(x.need)+'</b><div class="gbq-sub">успешных до &lt;1%</div></td><td>'+na()+'</td><td>'+na()+'</td><td class="gbq-action">'+esc(help(x.status))+'</td></tr>';
}
function render(){
  if(!$('#gbQuality'))return;
  const k=kpis(),set=(id,v)=>{const e=$(id);if(e)e.textContent=v};
  set('#gbqProducts',nf(k.products));set('#gbqOrders',nf(k.orders));set('#gbqCancels',nf(k.cancellations));set('#gbqRate',pct(k.rate));set('#gbqBad',nf(k.bad));set('#gbqVeryBad',nf(k.verybad));set('#gbqBrandsRisk',nf(k.brandsRisk));
  const a=filtered(),body=$('#gbqRows');if(body)body.innerHTML=a.length?a.map(scope==='brands'?brandRow:productRow).join(''):'<tr><td colspan="11" class="gbq-empty">По выбранному фильтру данных нет.</td></tr>';
  set('#gbqCount',nf(a.length));
  $('#gbqScopeProducts')?.classList.toggle('active',scope==='products');$('#gbqScopeBrands')?.classList.toggle('active',scope==='brands');
  const c=$('#gbqCoverage');if(c)c.innerHTML='<b>Автоматически сейчас:</b> отмены по истории заказов GRANTS BOOK, проблемные товары/бренды и сколько успешных заказов нужно, чтобы доля стала ниже 1%. <b>Рейтинг и отзывы:</b> текущий подключённый Kaspi Shop API их не отдаёт, поэтому значения не выдумываются и показываются «—».';
}
function busy(v){const b=$('#gbqRefresh');if(b){b.disabled=v;b.textContent=v?'Обновляю…':'↻ Обновить'}}
function message(t,type='ok'){const e=$('#gbqMsg');if(e){e.textContent=t;e.className='gbq-msg '+type}}
function countdown(){
  clearInterval(countdownTimer);
  countdownTimer=setInterval(()=>{
    const e=$('#gbqNext');if(!e)return;
    const left=Math.max(0,REFRESH_MS-(Date.now()-lastLoaded)),m=Math.floor(left/60000),s=Math.floor((left%60000)/1000);
    e.textContent=lastLoaded?'Автообновление через '+m+':'+String(s).padStart(2,'0'):'Автообновление каждые 10 минут';
  },1000);
}
function style(){
  if($('#gbqCss'))return;
  const s=document.createElement('style');s.id='gbqCss';s.textContent=`
#gbQuality{position:fixed;inset:58px 0 0;z-index:2147483350;background:#f5f7fa;display:none;overflow:auto;font-family:Inter,Arial,sans-serif;color:#101828}#gbQuality *{box-sizing:border-box}
.gbq-head{position:sticky;top:0;z-index:20;background:#fff;border-bottom:1px solid #e4e7ec;padding:13px 18px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}.gbq-title{font-size:25px;font-weight:950}.gbq-subtitle{font-size:12px;color:#667085;margin-top:2px}.gbq-spacer{flex:1}
.gbq-btn{border:1px solid #d0d5dd;background:#fff;border-radius:11px;padding:9px 12px;font-weight:850;cursor:pointer;color:#101828}.gbq-btn.dark{background:#111;color:#fff;border-color:#111}.gbq-btn:disabled{opacity:.6;cursor:wait}
.gbq-body{max-width:1760px;margin:auto;padding:16px}.gbq-msg{padding:9px 11px;border-radius:11px;font-size:12px;font-weight:800;margin-bottom:11px}.gbq-msg.ok{background:#ecfdf3;color:#027a48}.gbq-msg.busy{background:#fffaeb;color:#b54708}.gbq-msg.err{background:#fef3f2;color:#b42318}
.gbq-kpis{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:10px;margin-bottom:12px}.gbq-kpi{background:#fff;border:1px solid #e4e7ec;border-radius:16px;padding:12px;min-height:86px}.gbq-kl{font-size:10px;color:#667085;font-weight:900;text-transform:uppercase}.gbq-kv{font-size:25px;font-weight:950;margin-top:7px}.gbq-kv.red{color:#b42318}.gbq-kv.orange{color:#b54708}
.gbq-tools{background:#fff;border:1px solid #e4e7ec;border-radius:16px;padding:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:11px}.gbq-search{flex:1;min-width:260px;border:1px solid #d0d5dd;border-radius:10px;padding:10px 12px;font-size:14px}.gbq-select{border:1px solid #d0d5dd;border-radius:10px;padding:10px 12px;background:#fff;font-weight:750}.gbq-toggle{display:flex;background:#f2f4f7;padding:3px;border-radius:10px}.gbq-toggle button{border:0;background:transparent;padding:8px 11px;border-radius:8px;font-weight:850;cursor:pointer}.gbq-toggle button.active{background:#111;color:#fff}
.gbq-tablebox{background:#fff;border:1px solid #e4e7ec;border-radius:17px;overflow:auto}.gbq-table{width:100%;border-collapse:collapse;min-width:1450px}.gbq-table th{position:sticky;top:0;background:#f9fafb;padding:10px;text-align:left;color:#667085;font-size:10px;text-transform:uppercase;z-index:2}.gbq-table td{padding:10px;border-top:1px solid #f2f4f7;vertical-align:middle}.gbq-photo,.gbq-nophoto{width:58px;height:58px;border-radius:10px;border:1px solid #e4e7ec;background:#fff}.gbq-photo{object-fit:contain}.gbq-nophoto{display:grid;place-items:center;color:#98a2b3;font-size:9px}.gbq-brandicon{width:58px;height:58px;border-radius:10px;background:#111;color:#fff;display:grid;place-items:center;font-weight:950;font-size:22px}.gbq-name{font-weight:900;max-width:360px}.gbq-sub{font-size:10px;color:#667085;margin-top:4px}.gbq-sku{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:800;font-size:12px}.gbq-link{margin-left:6px;text-decoration:none;color:#175cd3;font-weight:850}.gbq-status{display:inline-flex;padding:6px 9px;border-radius:999px;font-size:10px;font-weight:950;white-space:nowrap}.gbq-status.good{background:#ecfdf3;color:#027a48}.gbq-status.normal{background:#eff8ff;color:#175cd3}.gbq-status.bad{background:#fffaeb;color:#b54708}.gbq-status.verybad{background:#fef3f2;color:#b42318}.gbq-na{color:#98a2b3;font-weight:800}.gbq-action{max-width:260px;font-size:11px}.gbq-empty{text-align:center;padding:45px!important;color:#667085}
.gbq-info{margin-top:12px;display:grid;grid-template-columns:1.2fr 1fr;gap:10px}.gbq-card{background:#fff;border:1px solid #e4e7ec;border-radius:16px;padding:13px}.gbq-card h3{margin:0 0 7px;font-size:14px}.gbq-card p{font-size:11px;line-height:1.55;color:#475467}.gbq-rulegrid{display:grid;grid-template-columns:repeat(4,1fr);gap:7px}.gbq-rule{border:1px solid #eaecf0;border-radius:11px;padding:9px}.gbq-rule b{display:block;font-size:12px;margin-bottom:3px}.gbq-foot{font-size:10px;color:#667085;margin-top:10px}.gbq-next{font-size:11px;color:#667085;font-weight:800}
@media(max-width:1050px){.gbq-kpis{grid-template-columns:repeat(3,1fr)}.gbq-info{grid-template-columns:1fr}.gbq-rulegrid{grid-template-columns:repeat(2,1fr)}}`;
  document.head.appendChild(s);
}
function nav(){
  if($('#gbQualityNav'))return true;
  const all=[...document.querySelectorAll('button,a')];
  const ref=all.find(x=>/Динамика продаж/i.test(x.textContent||''))||all.find(x=>/Прайс Kaspi/i.test(x.textContent||''))||all.find(x=>/Заказы/i.test(x.textContent||''));
  if(!ref?.parentElement)return false;
  const b=document.createElement('button');b.id='gbQualityNav';b.className=ref.className;b.textContent='🛡 Контроль качества';b.onclick=open;ref.parentElement.insertBefore(b,ref.nextSibling);return true;
}
function build(){
  style();let o=$('#gbQuality');if(o)return o;
  o=document.createElement('section');o.id='gbQuality';o.innerHTML=`
  <div class="gbq-head"><div><div class="gbq-title">Контроль качества</div><div class="gbq-subtitle">Товары и бренды · отмены · рейтинг/отзывы · расчёт до зоны «Отлично»</div></div><div class="gbq-spacer"></div><span id="gbqNext" class="gbq-next">Автообновление каждые 10 минут</span><button id="gbqRefresh" class="gbq-btn">↻ Обновить</button><button id="gbqClose" class="gbq-btn dark">Закрыть</button></div>
  <div class="gbq-body"><div id="gbqMsg" class="gbq-msg busy">Загружаю данные…</div>
  <div class="gbq-kpis">
    <div class="gbq-kpi"><div class="gbq-kl">Товаров с заказами</div><div id="gbqProducts" class="gbq-kv">0</div></div>
    <div class="gbq-kpi"><div class="gbq-kl">Заказов</div><div id="gbqOrders" class="gbq-kv">0</div></div>
    <div class="gbq-kpi"><div class="gbq-kl">Отмен</div><div id="gbqCancels" class="gbq-kv">0</div></div>
    <div class="gbq-kpi"><div class="gbq-kl">Доля отмен</div><div id="gbqRate" class="gbq-kv">0%</div></div>
    <div class="gbq-kpi"><div class="gbq-kl">Плохо</div><div id="gbqBad" class="gbq-kv orange">0</div></div>
    <div class="gbq-kpi"><div class="gbq-kl">Очень плохо</div><div id="gbqVeryBad" class="gbq-kv red">0</div></div>
    <div class="gbq-kpi"><div class="gbq-kl">Брендов в риске</div><div id="gbqBrandsRisk" class="gbq-kv red">0</div></div>
  </div>
  <div class="gbq-tools"><div class="gbq-toggle"><button id="gbqScopeProducts" class="active">Товары</button><button id="gbqScopeBrands">Бренды</button></div>
    <select id="gbqPeriod" class="gbq-select"><option value="30">Последние 30 дней</option><option value="90">90 дней</option><option value="9999">Вся история</option></select>
    <select id="gbqStatus" class="gbq-select"><option value="all">Все статусы</option><option value="verybad">Очень плохо</option><option value="bad">Плохо</option><option value="normal">Нормально</option><option value="good">Отлично / хорошо</option></select>
    <input id="gbqSearch" class="gbq-search" placeholder="Поиск по товару, артикулу или бренду"><b id="gbqCount">0</b>
  </div>
  <div class="gbq-tablebox"><table class="gbq-table"><thead><tr><th>Фото</th><th>Товар / бренд</th><th>Артикул</th><th>Заказы</th><th>Отмены</th><th>Отмены %</th><th>Статус по отменам</th><th>До &lt;1%</th><th>Рейтинг</th><th>Отзывы</th><th>Рекомендация</th></tr></thead><tbody id="gbqRows"></tbody></table></div>
  <div class="gbq-info"><div class="gbq-card"><h3>Как считается</h3><div id="gbqCoverage"></div><p>Для отмен используется история <b>_KASPI_ORDER_EVENTS</b>: уникальные номера заказов по SKU, отменённым считается событие <b>CANCELLED / RESTORED</b>. В текущем журнале нет причины отмены, поэтому это консервативный расчёт: он может быть выше официальной доли «по вашей вине», если заказ отменил клиент.</p><p><b>До &lt;1%</b> — минимальное число следующих успешных заказов без новых отмен, при котором текущая доля станет меньше 1%.</p></div>
  <div class="gbq-card"><h3>Пороги Kaspi</h3><div class="gbq-rulegrid"><div class="gbq-rule"><b>Отлично / хорошо</b><span>Отмены &lt;1%</span></div><div class="gbq-rule"><b>Нормально</b><span>1%–&lt;3%</span></div><div class="gbq-rule"><b>Плохо</b><span>3%–&lt;10%</span></div><div class="gbq-rule"><b>Очень плохо</b><span>≥10%</span></div></div><p>Для общего статуса Kaspi также учитывает рейтинг, задержки и возвраты. «Отлично»: рейтинг &gt;4,6; отмены &lt;1%; задержки &lt;5%; возвраты &lt;1%; для статуса «Отличный продавец» — 25+ выданных заказов за 30 дней.</p></div></div>
  <div class="gbq-foot">Источник: GRANTS BOOK Google Sheets. Данные на экране обновляются каждые 10 минут. Период 30 дней соответствует окну показателей заказов Kaspi; для 90 дней/всей истории статусы — диагностическое применение тех же порогов.</div>
  </div>`;
  document.body.appendChild(o);
  $('#gbqClose').onclick=close;$('#gbqRefresh').onclick=()=>load(true);$('#gbqScopeProducts').onclick=()=>{scope='products';render()};$('#gbqScopeBrands').onclick=()=>{scope='brands';render()};
  $('#gbqStatus').onchange=e=>{statusFilter=e.target.value;render()};$('#gbqPeriod').onchange=e=>{periodDays=Number(e.target.value)||30;aggregate();render()};$('#gbqSearch').oninput=e=>{query=e.target.value||'';render()};
  return o;
}
function open(){const o=build();o.style.display='block';document.body.style.overflow='hidden';if(!lastLoaded||Date.now()-lastLoaded>=REFRESH_MS)load(true);else render();countdown()}
function close(){const o=$('#gbQuality');if(o)o.style.display='none';document.body.style.overflow=''}

let tries=0,boot=setInterval(()=>{if(nav()||++tries>80)clearInterval(boot)},250);
setInterval(()=>{if($('#gbQuality')?.style.display==='block')load(true)},REFRESH_MS);
window.addEventListener('keydown',e=>{if(e.key==='Escape'&&$('#gbQuality')?.style.display==='block')close()});
})();