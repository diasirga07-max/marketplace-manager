(()=>{
'use strict';
if(window.GB_ORDER_EXCEL_IMPORT_LOADED)return;
window.GB_ORDER_EXCEL_IMPORT_LOADED=true;

const STORE='gbLocalOrderExcelV1';
const META='gbLocalOrderExcelMetaV1';
const GROUPS=['Курдай','WB','Алматы'];
let records=[];
let meta={};
let renderTimer=null;
let xlsxPromise=null;
let wbLinks={};
let wbLinksPromise=null;

const $=s=>document.querySelector(s);
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function clean(v){return String(v==null?'':v).trim()}
function code(v){return clean(v).replace(/-1$/,'').replace(/\s+/g,'')}
function isCode(v){return /^\d{8,14}$/.test(code(v))}
function skuGroup(s){const x=clean(s).toUpperCase();if(/^OPT/.test(x))return'Курдай';if(/^WB/.test(x))return'WB';return'Алматы'}
function currentGroup(){try{return GROUPS.includes(S.g)?S.g:'Алматы'}catch{return'Алматы'}}
function num(v){const n=Number(String(v??'').replace(',','.').replace(/[^0-9.\-]/g,''));return Number.isFinite(n)?n:0}
function fmtQty(v){const n=Math.max(1,Math.round(num(v)||1));return n}
function statusStage(v){const s=clean(v).toLowerCase();if(s.includes('передач'))return'Передача курьеру';if(s.includes('прибыт'))return'Прибытие в точку';if(s.includes('упаков'))return'Упаковка';if(s.includes('нов'))return'Новый';return clean(v)||'Из Excel'}

function save(){try{localStorage.setItem(STORE,JSON.stringify(records));localStorage.setItem(META,JSON.stringify(meta))}catch(e){console.warn('Excel snapshot local save failed',e)}}
function restore(){try{const a=JSON.parse(localStorage.getItem(STORE)||'[]');const m=JSON.parse(localStorage.getItem(META)||'{}');if(Array.isArray(a)&&a.length){records=a.filter(r=>r&&isCode(r.c)&&r.s);meta=m||{};window.GB_EXCEL_ORDER_MODE=true}}catch(e){console.warn('Excel snapshot restore failed',e)}}
function clearSnapshot(){records=[];meta={};window.GB_EXCEL_ORDER_MODE=false;try{localStorage.removeItem(STORE);localStorage.removeItem(META)}catch{};const st=$('#gbExcelImportStatus');if(st)st.textContent='';try{if(typeof renderOrders==='function')renderOrders()}catch{} }

function loadScript(src){return new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=src;s.async=true;s.onload=()=>resolve();s.onerror=()=>{s.remove();reject(new Error('Не удалось загрузить модуль Excel'))};document.head.appendChild(s)})}
async function ensureXLSX(){
  if(window.XLSX)return window.XLSX;
  if(xlsxPromise)return xlsxPromise;
  xlsxPromise=(async()=>{try{await loadScript('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js')}catch{await loadScript('https://unpkg.com/xlsx@0.18.5/dist/xlsx.full.min.js')}if(!window.XLSX)throw new Error('Модуль Excel не загрузился');return window.XLSX})().catch(e=>{xlsxPromise=null;throw e});
  return xlsxPromise;
}

function wbSearchUrl(sku){return 'https://www.wildberries.ru/catalog/0/search.aspx?search='+encodeURIComponent(clean(sku))}
function wbUrl(sku){return wbLinks[clean(sku).toUpperCase()]||wbSearchUrl(sku)}
function wbLinkHtml(x){
  if(skuGroup(x?.sku)!=='WB')return '';
  const url=wbUrl(x.sku);
  const exact=!!wbLinks[clean(x.sku).toUpperCase()];
  return '<a href="'+esc(url)+'" target="_blank" rel="noopener noreferrer" title="'+(exact?'Открыть карточку товара Wildberries':'Найти товар на Wildberries')+'" style="display:inline-flex;align-items:center;gap:4px;margin-left:8px;padding:4px 8px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;color:#111827;text-decoration:none;font-size:11px;font-weight:900;white-space:nowrap">WB ↗</a>';
}
async function loadWBLinks(){
  if(wbLinksPromise)return wbLinksPromise;
  wbLinksPromise=(async()=>{
    try{
      const r=await fetch('/api/wb-links?_='+Date.now(),{cache:'no-store'});
      const j=await r.json().catch(()=>({}));
      if(r.ok&&j&&j.ok&&j.links&&typeof j.links==='object'){
        wbLinks=j.links;
        window.GB_WB_LINKS=wbLinks;
        if(window.GB_EXCEL_ORDER_MODE&&currentGroup()==='WB')scheduleRender(10);
      }
    }catch(e){console.warn('WB links load failed',e)}
    return wbLinks;
  })();
  return wbLinksPromise;
}

function normHeader(v){return clean(v).toLowerCase().replace(/ё/g,'е').replace(/\s+/g,' ')}
function detectColumns(rows){
  const fixed={code:0,name:3,altName:2,sku:4,status:9,qty:21,start:0};
  for(let r=0;r<Math.min(8,rows.length);r++){
    const h=(rows[r]||[]).map(normHeader);let score=0;
    const find=re=>h.findIndex(x=>re.test(x));
    const c=find(/(^|\s)(№|номер)?\s*заказ|order/);if(c>=0)score++;
    const s=find(/артикул|sku/);if(s>=0)score++;
    const q=find(/количество|кол-?во|qty/);if(q>=0)score++;
    if(score>=2){
      const n=find(/назван|наимен|товар|product/),st=find(/статус|status|state/);
      return{code:c>=0?c:0,sku:s>=0?s:4,qty:q>=0?q:21,name:n>=0?n:3,altName:n>=0?n:2,status:st>=0?st:9,start:r+1};
    }
  }

  // Компактный файл без заголовков: A = номер заказа, B = артикул, C = количество.
  // Именно такой формат формирует пользовательский файл «для сайта.xlsx».
  const sample=rows.slice(0,Math.min(30,rows.length)).filter(r=>Array.isArray(r)&&r.some(v=>clean(v)));
  const compact=sample.filter(r=>{
    const width=r.reduce((m,v,i)=>clean(v)?i+1:m,0);
    return width<=3&&isCode(r[0])&&!!clean(r[1])&&/^\d+(?:[.,]\d+)?$/.test(clean(r[2]))&&num(r[2])>0;
  });
  if(sample.length&&compact.length>=Math.min(3,sample.length)&&compact.length/sample.length>=0.8){
    return{code:0,sku:1,qty:2,name:-1,altName:-1,status:-1,start:0};
  }

  return fixed;
}

function rowsToRecords(rows){
  const c=detectColumns(rows),out=[];
  for(let i=c.start;i<rows.length;i++){
    const r=rows[i]||[],oc=code(r[c.code]);if(!isCode(oc))continue;
    const sk=clean(r[c.sku]);if(!sk)continue;
    const nm=clean(r[c.name])||clean(r[c.altName])||sk||'Товар';
    out.push({c:oc,s:sk,n:nm,q:fmtQty(r[c.qty]),t:clean(r[c.status])});
  }
  return out;
}

async function parseFile(file){
  const ext=(file.name.split('.').pop()||'').toLowerCase();
  let rows=[];
  if(ext==='csv'){
    const text=await file.text();const X=await ensureXLSX();const wb=X.read(text,{type:'string'});rows=X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1,raw:true,defval:''});
  }else{
    const X=await ensureXLSX();const buf=await file.arrayBuffer();const wb=X.read(buf,{type:'array',cellDates:false});if(!wb.SheetNames.length)throw new Error('В Excel нет листов');rows=X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1,raw:true,defval:''});
  }
  const a=rowsToRecords(rows);if(!a.length)throw new Error('Не найдены заказы. Поддерживаются два формата: 1) колонки с заголовками «номер заказа / артикул / количество»; 2) без заголовков: A=номер заказа, B=артикул, C=количество.');
  return a;
}

function stats(){
  const orders=new Set(records.map(r=>r.c)),units=records.reduce((s,r)=>s+fmtQty(r.q),0),g={Курдай:0,WB:0,Алматы:0};
  for(const r of records)g[skuGroup(r.s)]++;
  return{orders:orders.size,lines:records.length,units,g};
}

function aggregate(group){
  const map=new Map();
  for(const r of records){if(skuGroup(r.s)!==group)continue;const k=clean(r.s).toUpperCase();let x=map.get(k);if(!x){x={sku:r.s,name:r.n,qty:0,orders:new Set(),stages:new Map()};map.set(k,x)}x.qty+=fmtQty(r.q);x.orders.add(r.c);const st=statusStage(r.t);x.stages.set(st,(x.stages.get(st)||0)+fmtQty(r.q));}
  return [...map.values()].sort((a,b)=>b.qty-a.qty||String(a.name).localeCompare(String(b.name),'ru'));
}

function stageHtml(x){return [...x.stages.entries()].map(([s,n])=>'<span style="display:inline-block;margin:2px 4px 2px 0;padding:5px 8px;border-radius:999px;background:#eef2ff;font-size:11px;font-weight:800">'+esc(s)+' · '+n+'</span>').join('')||'—'}
function photoCell(x){try{if(typeof pic==='function')return pic({sku:x.sku,name:x.name})}catch{}return '<div style="width:64px;height:64px;border-radius:12px;background:#f2f4f7;display:grid;place-items:center;font-size:10px;font-weight:800;color:#667085">EXCEL</div>'}

function renderImported(){
  if(!window.GB_EXCEL_ORDER_MODE||!records.length)return;
  const ot=$('#ot');if(!ot)return;
  const g=currentGroup();if(g==='WB')loadWBLinks();let a=aggregate(g);const q=clean($('#os')?.value).toLowerCase();if(q)a=a.filter(x=>(x.sku+' '+x.name+' '+[...x.orders].join(' ')).toLowerCase().includes(q));
  const head=$('#orderHead');if(head)head.innerHTML='<th>Фото</th><th>Товар</th><th>Артикул</th><th>Кол-во</th><th>Заказы</th><th>Этапы</th>';
  ot.innerHTML=a.length?a.map(x=>'<tr data-gb-excel="1"><td>'+photoCell(x)+'</td><td><b>'+esc(x.name)+'</b></td><td class="sku">'+esc(x.sku)+(g==='WB'?wbLinkHtml(x):'')+'</td><td><b style="font-size:20px">'+x.qty+'</b></td><td>'+esc([...x.orders].join(', '))+'</td><td>'+stageHtml(x)+'</td></tr>').join(''):'<tr><td colspan="6">Нет заказов</td></tr>';
  const st=stats();
  const set=(id,v)=>{const e=$(id);if(e)e.textContent=String(v)};set('#all',st.orders);set('#ck',new Set(records.filter(r=>skuGroup(r.s)==='Курдай').map(r=>r.c)).size);set('#cw',new Set(records.filter(r=>skuGroup(r.s)==='WB').map(r=>r.c)).size);set('#ca',new Set(records.filter(r=>skuGroup(r.s)==='Алматы').map(r=>r.c)).size);
  const fresh=$('#fresh');if(fresh)fresh.textContent='Excel: '+(meta.name||'файл')+' · '+st.orders+' заказов · '+st.units+' ед. · загружено '+(meta.at||'');
  const status=$('#gbExcelImportStatus');if(status)status.textContent='Excel активен: '+st.orders+' заказов / '+st.lines+' позиций / '+st.units+' ед.';
}
function scheduleRender(ms=20){clearTimeout(renderTimer);renderTimer=setTimeout(renderImported,ms)}

async function importFile(file){
  const b=$('#gbExcelImportBtn'),status=$('#gbExcelImportStatus');if(b){b.disabled=true;b.textContent='Читаю Excel…'}if(status)status.textContent='Обработка файла…';
  try{
    const a=await parseFile(file);records=a;meta={name:file.name,at:new Date().toLocaleString('ru-RU')};window.GB_EXCEL_ORDER_MODE=true;save();
    const st=stats();if(status)status.textContent='Готово: '+st.orders+' заказов · '+st.lines+' позиций · '+st.units+' ед. Автосортировка: Курдай '+st.g.Курдай+', WB '+st.g.WB+', Алматы '+st.g.Алматы+'.';
    scheduleRender(0);
  }catch(e){console.error('Excel import failed',e);if(status)status.textContent='Ошибка Excel: '+String(e?.message||e);alert('Не удалось обработать Excel:\n'+String(e?.message||e))}
  finally{if(b){b.disabled=false;b.textContent='📥 Загрузить Excel'}const f=$('#gbExcelImportFile');if(f)f.value=''}
}

function ensureUI(){
  if($('#gbExcelImportBtn'))return true;const fresh=$('#fresh');if(!fresh||!fresh.parentElement)return false;
  const b=document.createElement('button');b.id='gbExcelImportBtn';b.type='button';b.className='btn alt';b.textContent='📥 Загрузить Excel';b.style.marginLeft='8px';
  const clear=document.createElement('button');clear.id='gbExcelImportClear';clear.type='button';clear.className='btn alt';clear.textContent='Сбросить Excel';clear.style.cssText='margin-left:6px;display:'+(records.length?'inline-flex':'none');
  const input=document.createElement('input');input.id='gbExcelImportFile';input.type='file';input.accept='.xlsx,.xls,.csv';input.hidden=true;
  const status=document.createElement('span');status.id='gbExcelImportStatus';status.style.cssText='display:inline-block;margin-left:8px;font-size:11px;font-weight:800;color:#475467';
  fresh.parentElement.appendChild(b);fresh.parentElement.appendChild(clear);fresh.parentElement.appendChild(input);fresh.parentElement.appendChild(status);
  b.addEventListener('click',()=>input.click());input.addEventListener('change',()=>{const f=input.files&&input.files[0];if(f)importFile(f)});clear.addEventListener('click',()=>{if(confirm('Отключить загруженный Excel и снова показывать live-заказы сайта?')){clearSnapshot();clear.style.display='none'}});
  if(records.length){clear.style.display='inline-flex';scheduleRender(50)}
  return true;
}

restore();
loadWBLinks();
let tries=0;const boot=setInterval(()=>{tries++;if(ensureUI()){clearInterval(boot);if(records.length)scheduleRender(80)}else if(tries>160)clearInterval(boot)},250);
document.addEventListener('click',e=>{if(e.target?.closest?.('#groups button'))scheduleRender(60)},true);
document.addEventListener('input',e=>{if(e.target?.id==='os')scheduleRender(20)},true);
const mo=new MutationObserver(()=>{ensureUI();if(window.GB_EXCEL_ORDER_MODE&&records.length){const ot=$('#ot');if(ot&&!ot.querySelector('[data-gb-excel="1"]'))scheduleRender(30)}});mo.observe(document.documentElement,{subtree:true,childList:true});
window.GB_ORDER_EXCEL={render:renderImported,clear:clearSnapshot,getRecords:()=>records.slice()};
})();