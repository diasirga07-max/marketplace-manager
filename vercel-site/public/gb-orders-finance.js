(()=>{
'use strict';
if(window.GB_ORDERS_FINANCE_LOADED)return;
window.GB_ORDERS_FINANCE_LOADED=true;

/*
 * GRANTS BOOK · Заказы: СУММА / ОПТ. ЦЕНА / ПРИБЫЛЬ / ЗАКАЗАНО + итоги над таблицей.
 *
 * Все названия колонок собраны здесь. Сравнение идёт без учёта регистра, лишних пробелов и «ё».
 * Сначала ищется точное совпадение, затем — заголовок, который содержит один из вариантов.
 */
const COLUMN_MAP={
  // Excel заказов (ActiveOrders_*.xlsx и аналогичные выгрузки)
  excel:{
    orderCode:['№ заказа','номер заказа','заказ','order'],
    sku:['артикул','sku','код товара'],
    qty:['количество','кол-во','qty'],
    // Сумма по строке (цена продажи × количество). Используется в первую очередь.
    lineSum:['сумма','сумма заказа','сумма продажи','итого','стоимость','total'],
    // Цена продажи за 1 шт. Используется, если колонки суммы нет.
    unitPrice:['цена продажи','цена за единицу','цена за ед.','цена за шт','цена','price'],
    // Оптовая (закупочная) цена за 1 шт.
    wholesale:['оптовая цена','цена оптовая','опт','опт. цена','закуп','закупочная цена','себестоимость']
  },
  // Google Таблица «Прайс KASPI» — запасной источник цен по артикулу
  priceSheet:{
    sheetId:'1dLU5KOi3WBLy3uNEiqGv5rf9ka0OwcEw_RjhDQW3H1E',
    sheetName:'Прайс KASPI',
    sku:['артикул','артикул wb','артикул kaspi','sku','код товара','ч'],
    skuFallbackColumn:'A',
    wholesale:['цена оптовая','оптовая цена','закупочная цена','себестоимость'],
    salePrice:['цена kaspi округл. до 10 (₸)','цена kaspi (₸) [расчет]','цена kaspi','цена продажи']
  }
};
// Слова, по которым колонка опта не должна приниматься за цену/сумму продажи
const WHOLESALE_WORDS=['опт','закуп','себестоим'];

const SUPPLIER_API='/api/orders-sheets-sync?op=supplier-orders';
const EXCEL_EXTRA_KEY='gbOrdersFinanceExcelV1';
const EXCEL_META_KEY='gbLocalOrderExcelMetaV1';
const GROUPS=['Курдай','WB','Алматы'];
const NEW_HEADS=['Сумма','Опт. цена','Прибыль','Заказано'];

const $=s=>document.querySelector(s);
const clean=v=>String(v==null?'':v).trim();
const normHeader=v=>clean(v).toLowerCase().replace(/ё/g,'е').replace(/\s+/g,' ');
const normSku=v=>clean(v).toUpperCase();
const normCode=v=>clean(v).replace(/-1$/,'').replace(/\s+/g,'');
const esc=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtNum=n=>new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0}).format(Math.round(n)).replace(/ | /g,' ');
const money=n=>Number.isFinite(n)?fmtNum(n)+' ₸':'—';
const plural=(n,one,few,many)=>{const m10=n%10,m100=n%100;return m10===1&&m100!==11?one:m10>=2&&m10<=4&&(m100<12||m100>14)?few:many};
const positions=n=>n+' '+plural(n,'позиция','позиции','позиций');
function skuGroup(s){const x=normSku(s);if(/^OPT/.test(x))return'Курдай';if(/^WB/.test(x))return'WB';return'Алматы'}
function currentGroup(){try{return GROUPS.includes(S.g)?S.g:'Алматы'}catch{return'Алматы'}}
function parseMoney(v){
  if(v==null||v==='')return null;
  if(typeof v==='number')return Number.isFinite(v)?v:null;
  let t=String(v).replace(/[\s  ']/g,'').replace(/(KZT|₸|тг)/gi,'').replace(/[^0-9.,\-]/g,'');
  if(!/[0-9]/.test(t))return null;
  const c=t.lastIndexOf(','),d=t.lastIndexOf('.');
  if(c>=0&&d>=0){const dec=c>d?',':'.',grp=dec===','?'.':',';t=t.split(grp).join('').replace(dec,'.')}
  else if(c>=0)t=/^\d{1,3}(,\d{3})+$/.test(t)?t.replace(/,/g,''):t.replace(',','.');
  else if(d>=0&&/^\d{1,3}(\.\d{3})+$/.test(t))t=t.replace(/\./g,'');
  const n=Number(t);return Number.isFinite(n)?n:null;
}
function findColumn(headers,variants,{exclude=[]}={}){
  const h=headers.map(normHeader),vs=variants.map(normHeader);
  const ok=i=>h[i]&&!exclude.some(w=>h[i].includes(w));
  for(const v of vs){const i=h.findIndex((x,idx)=>x===v&&ok(idx));if(i>=0)return i}
  for(const v of vs){if(v.length<3)continue;const i=h.findIndex((x,idx)=>x.includes(v)&&ok(idx));if(i>=0)return i}
  return -1;
}
function readJson(key){try{return JSON.parse(localStorage.getItem(key)||'null')}catch{return null}}
function writeJson(key,v){try{if(v==null)localStorage.removeItem(key);else localStorage.setItem(key,JSON.stringify(v))}catch(e){console.warn('Finance local cache write failed',e)}}

/* ---------- Excel заказов: дочитываем колонки цен ---------- */
let excelExtra=readJson(EXCEL_EXTRA_KEY);
let xlsxPromise=null;
function loadScript(src){return new Promise((res,rej)=>{const s=document.createElement('script');s.src=src;s.async=true;s.onload=()=>res();s.onerror=()=>{s.remove();rej(new Error('Не удалось загрузить модуль Excel'))};document.head.appendChild(s)})}
function ensureXLSX(){
  if(window.XLSX)return Promise.resolve(window.XLSX);
  if(!xlsxPromise)xlsxPromise=loadScript('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js')
    .catch(()=>loadScript('https://unpkg.com/xlsx@0.18.5/dist/xlsx.full.min.js'))
    .then(()=>{if(!window.XLSX)throw new Error('Модуль Excel не загрузился');return window.XLSX})
    .catch(e=>{xlsxPromise=null;throw e});
  return xlsxPromise;
}
function parseExcelRows(rows,fileName){
  const M=COLUMN_MAP.excel;
  let headerRow=-1,headers=[];
  for(let r=0;r<Math.min(10,rows.length);r++){
    const h=(rows[r]||[]).map(clean);
    const hits=[findColumn(h,M.orderCode),findColumn(h,M.sku),findColumn(h,M.qty)].filter(i=>i>=0).length;
    if(hits>=2){headerRow=r;headers=h;break}
  }
  const result={fileName,at:new Date().toISOString(),headers:headers.filter(Boolean),found:{},lines:{},orderLines:{}};
  if(headerRow<0)return result; // компактный файл без заголовков (A=заказ, B=артикул, C=кол-во) — цен в нём нет
  const idx={
    code:findColumn(headers,M.orderCode,{exclude:['дата','статус','сумм']}),
    sku:findColumn(headers,M.sku),
    qty:findColumn(headers,M.qty),
    lineSum:findColumn(headers,M.lineSum,{exclude:WHOLESALE_WORDS}),
    unit:findColumn(headers,M.unitPrice,{exclude:WHOLESALE_WORDS.concat(['сумм'])}),
    wholesale:findColumn(headers,M.wholesale)
  };
  for(const k of ['lineSum','unit','wholesale'])if(idx[k]>=0)result.found[k]=headers[idx[k]];
  if(idx.code<0||idx.sku<0)return result;
  for(let i=headerRow+1;i<rows.length;i++){
    const r=rows[i]||[];const code=normCode(r[idx.code]);const sku=normSku(r[idx.sku]);
    if(!/^\d{6,14}$/.test(code)||!sku)continue;
    const q=Math.max(1,Math.round(parseMoney(r[idx.qty])||1));
    const key=code+'|'+sku;
    const prev=result.lines[key]||{q:0,sum:null,unit:null,w:null};
    prev.q+=q;
    const sum=idx.lineSum>=0?parseMoney(r[idx.lineSum]):null;
    const unit=idx.unit>=0?parseMoney(r[idx.unit]):null;
    const w=idx.wholesale>=0?parseMoney(r[idx.wholesale]):null;
    if(sum!=null&&sum>=0)prev.sum=(prev.sum||0)+sum;
    if(unit!=null&&unit>=0)prev.unit=unit;
    if(w!=null&&w>0)prev.w=w; // 0 или пусто = цены нет
    result.lines[key]=prev;
    (result.orderLines[code]=result.orderLines[code]||[]).push(key);
  }
  return result;
}
async function readExcelFile(file){
  try{
    const X=await ensureXLSX();
    const ext=(file.name.split('.').pop()||'').toLowerCase();
    const wb=ext==='csv'?X.read(await file.text(),{type:'string'}):X.read(await file.arrayBuffer(),{type:'array',cellDates:false});
    const rows=wb.SheetNames.length?X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1,raw:true,defval:''}):[];
    excelExtra=parseExcelRows(rows,file.name);
    writeJson(EXCEL_EXTRA_KEY,excelExtra);
  }catch(e){
    console.error('Finance: Excel price columns read failed',e);
    excelExtra={fileName:file.name,at:new Date().toISOString(),headers:[],found:{},lines:{},orderLines:{},error:String(e&&e.message||e)};
    writeJson(EXCEL_EXTRA_KEY,excelExtra);
  }
  schedule(50);
}
document.addEventListener('change',e=>{
  const input=e.target;
  if(!input||input.id!=='gbExcelImportFile')return;
  const f=input.files&&input.files[0];
  if(f)readExcelFile(f);
},true);
document.addEventListener('click',e=>{
  if(e.target&&e.target.closest&&e.target.closest('#gbExcelImportClear'))setTimeout(()=>{if(!excelActive()){excelExtra=null;writeJson(EXCEL_EXTRA_KEY,null);schedule(20)}},300);
},true);

function excelRecords(){try{return window.GB_ORDER_EXCEL?.getRecords?.()||[]}catch{return[]}}
function excelActive(){return window.GB_EXCEL_ORDER_MODE===true&&excelRecords().length>0}
function excelExtraFresh(){
  if(!excelExtra)return false;
  const meta=readJson(EXCEL_META_KEY)||{};
  return !meta.name||meta.name===excelExtra.fileName;
}

/* ---------- «Прайс KASPI»: оптовая цена и цена продажи по артикулу ---------- */
const catalog={ready:false,loading:false,error:'',bySku:new Map(),columns:{}};
let jsonpSeq=0;
function gviz(params){
  return new Promise((resolve,reject)=>{
    const cb='__gbFinCb'+Date.now()+'_'+(++jsonpSeq);
    const s=document.createElement('script');let done=false;
    const finish=()=>{try{delete window[cb]}catch{}s.remove()};
    const t=setTimeout(()=>{if(done)return;done=true;finish();reject(new Error('Таймаут Google Sheets'))},20000);
    window[cb]=resp=>{if(done)return;done=true;clearTimeout(t);finish();resp&&resp.status==='error'?reject(new Error((resp.errors&&resp.errors[0]&&resp.errors[0].detailed_message)||'Ошибка Google Sheets')):resolve(resp)};
    s.onerror=()=>{if(done)return;done=true;clearTimeout(t);finish();reject(new Error('Не удалось загрузить «Прайс KASPI»'))};
    const P=COLUMN_MAP.priceSheet;
    s.src='https://docs.google.com/spreadsheets/d/'+P.sheetId+'/gviz/tq?sheet='+encodeURIComponent(P.sheetName)+'&'+params+'&tqx='+encodeURIComponent('out:json;responseHandler:'+cb)+'&_='+Date.now();
    document.head.appendChild(s);
  });
}
const letter=i=>{let n=i+1,s='';while(n){n--;s=String.fromCharCode(65+n%26)+s;n=Math.floor(n/26)}return s};
const cellVal=c=>c&&c.v!=null?c.v:(c&&c.f!=null?c.f:'');
async function loadCatalog(){
  if(catalog.loading||catalog.ready)return;
  catalog.loading=true;
  try{
    const P=COLUMN_MAP.priceSheet;
    const head=await gviz('headers=0&range='+encodeURIComponent('A1:AZ1'));
    const headers=((head.table&&head.table.rows&&head.table.rows[0]&&head.table.rows[0].c)||[]).map(c=>clean(cellVal(c)));
    let skuIdx=findColumn(headers,P.sku);
    if(skuIdx<0)skuIdx=P.skuFallbackColumn.charCodeAt(0)-65;
    const wIdx=findColumn(headers,P.wholesale);
    const pIdx=findColumn(headers,P.salePrice,{exclude:WHOLESALE_WORDS});
    catalog.columns={sku:headers[skuIdx]||letter(skuIdx),wholesale:wIdx>=0?headers[wIdx]:'',salePrice:pIdx>=0?headers[pIdx]:''};
    const cols=[skuIdx,wIdx,pIdx].map(i=>i>=0?letter(i):null);
    const sel=cols.filter(Boolean).join(',');
    const data=await gviz('headers=1&tq='+encodeURIComponent('select '+sel+' where '+cols[0]+' is not null'));
    const map=new Map();
    for(const row of (data.table&&data.table.rows)||[]){
      const c=row.c||[];let k=0;
      const sku=normSku(cellVal(c[k++]));
      const w=wIdx>=0?parseMoney(cellVal(c[k++])):null;
      const p=pIdx>=0?parseMoney(cellVal(c[k++])):null;
      if(!sku)continue;
      if(map.has(sku)){map.get(sku).duplicate=true;continue}
      map.set(sku,{wholesale:w!=null&&w>0?w:null,price:p!=null&&p>0?p:null});
    }
    for(const [k,v] of map)if(v.duplicate)map.delete(k); // неоднозначные дубли не используем
    catalog.bySku=map;catalog.ready=true;catalog.error='';
  }catch(e){
    console.error('Finance: Прайс KASPI load failed',e);
    catalog.error=String(e&&e.message||e);
    setTimeout(()=>{catalog.loading=false;loadCatalog()},60000);
  }finally{if(catalog.ready)catalog.loading=false;schedule(10)}
}

/* ---------- Заказано у поставщика (Google Таблица через API) ---------- */
const supplier={ready:false,error:'',items:{},saving:new Set()};
async function loadSupplier(){
  try{
    const r=await fetch(SUPPLIER_API+'&_='+Date.now(),{cache:'no-store'});
    const j=await r.json().catch(()=>({}));
    if(!r.ok||!j.ok)throw new Error(j.error||('HTTP '+r.status));
    supplier.items=j.items||{};supplier.ready=true;supplier.error='';
  }catch(e){console.warn('Finance: supplier orders load failed',e);supplier.error=String(e&&e.message||e)}
  schedule(10);
}
async function saveSupplier(sku,qty){
  const key=normSku(sku);supplier.saving.add(key);schedule(0);
  try{
    const r=await fetch(SUPPLIER_API,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sku:key,qty}),cache:'no-store'});
    const j=await r.json().catch(()=>({}));
    if(!r.ok||!j.ok)throw new Error(j.error||('HTTP '+r.status));
    supplier.items[key]={qty:j.item.qty,updatedAt:j.item.updatedAt};supplier.error='';
  }catch(e){alert('Не удалось сохранить «Заказано» для '+key+':\n'+String(e&&e.message||e))}
  finally{supplier.saving.delete(key);schedule(0)}
}

/* ---------- Модель: суммы по артикулу для текущей вкладки ---------- */
function buildModel(){
  const g=currentGroup(),items=new Map();
  const item=sku=>{const k=normSku(sku);let x=items.get(k);if(!x){x={sku:k,qty:0,sale:0,saleUnits:0,saleSources:new Set(),wUnit:null,wSource:''};items.set(k,x)}return x};
  const cat=sku=>catalog.bySku.get(normSku(sku))||null;
  const extra=excelActive()&&excelExtraFresh()?excelExtra:null;

  if(excelActive()){
    for(const r of excelRecords()){
      const sku=normSku(r&&r.s);if(!sku||skuGroup(sku)!==g)continue;
      const q=Math.max(1,Math.round(Number(r.q)||1)),code=normCode(r.c),x=item(sku);x.qty+=q;
      const line=extra&&extra.lines[code+'|'+sku];
      let sale=null,src='';
      if(line){
        const siblings=(extra.orderLines[code]||[]).map(k=>extra.lines[k]).filter(Boolean);
        // Если в многотоварном заказе во всех строках одна и та же сумма — это сумма всего заказа, а не строки.
        const repeatedTotal=siblings.length>1&&line.sum!=null&&siblings.every(s=>s.sum===line.sum);
        if(line.sum!=null&&!repeatedTotal){sale=line.sum*(q/Math.max(1,line.q));src='Excel'}
        else if(line.unit!=null){sale=line.unit*q;src='Excel'}
        if(line.w!=null&&x.wUnit==null){x.wUnit=line.w;x.wSource='Excel'}
      }
      if(sale==null){const c=cat(sku);if(c&&c.price!=null){sale=c.price*q;src='Прайс KASPI'}}
      if(sale!=null){x.sale+=sale;x.saleUnits+=q;x.saleSources.add(src)}
    }
  }else if(typeof S!=='undefined'&&S.orders&&Array.isArray(S.orders.rows)){
    for(const r of S.orders.rows){
      const sku=normSku(r&&r.sku);if(!sku)continue;
      if((r.group||skuGroup(sku))!==g)continue;
      const q=Math.max(0,Number(r.quantity)||0);if(!q)continue;
      const x=item(sku);x.qty+=q;
      let sale=null,src='';
      if(Number(r.totalPrice)>0){sale=Number(r.totalPrice);src='Kaspi'}
      else{const c=cat(sku);if(c&&c.price!=null){sale=c.price*q;src='Прайс KASPI'}}
      if(sale!=null){x.sale+=sale;x.saleUnits+=q;x.saleSources.add(src)}
      if(x.wUnit==null&&r.wholesale!=null&&Number(r.wholesale)>0){x.wUnit=Number(r.wholesale);x.wSource='Прайс KASPI'}
    }
  }
  for(const x of items.values()){
    if(x.wUnit==null){const c=cat(x.sku);if(c&&c.wholesale!=null){x.wUnit=c.wholesale;x.wSource='Прайс KASPI'}}
    x.saleComplete=x.saleUnits>=x.qty&&x.qty>0;
    x.saleTotal=x.saleUnits?x.sale:null;
    x.wTotal=x.wUnit!=null?x.wUnit*x.qty:null;
    x.profit=x.wUnit!=null&&x.saleComplete?x.sale-x.wTotal:null;
  }
  return items;
}

/* ---------- Отрисовка ---------- */
function ensureStyle(){
  if($('#gbFinStyle'))return;
  const s=document.createElement('style');s.id='gbFinStyle';
  s.textContent=`
#orderHead .gb-fin-head{white-space:nowrap}
#ot .gb-fin-cell{white-space:nowrap;vertical-align:middle}
#ot .gb-fin-sub{display:block;margin-top:3px;font-size:11px;font-weight:700;color:#667085}
#ot .gb-fin-pos{color:#027a48}#ot .gb-fin-neg{color:#b42318}
#ot .gb-fin-dash{color:#98a2b3;font-weight:800}
#ot .gb-fin-badge{display:inline-block;padding:5px 9px;border-radius:999px;font-size:11px;font-weight:850;line-height:1.2;white-space:nowrap}
#ot .gb-fin-badge.ok{background:#ecfdf3;color:#067647;border:1px solid #abefc6}
#ot .gb-fin-badge.part{background:#fffaeb;color:#b54708;border:1px solid #fedf89}
#ot .gb-fin-badge.none{background:#f2f4f7;color:#475467;border:1px solid #e4e7ec}
#ot .gb-fin-edit{display:flex;gap:4px;align-items:center;margin-top:6px}
#ot .gb-fin-edit input{width:64px;padding:5px 6px;border:1px solid #d0d5dd;border-radius:7px;font:700 12px Arial,sans-serif}
#ot .gb-fin-edit button{padding:5px 8px;border:1px solid #d0d5dd;border-radius:7px;background:#fff;font:800 11px Arial,sans-serif;cursor:pointer}
#ot .gb-fin-edit button:hover{background:#f5f7fb}
#ot .gb-fin-edit button:disabled{opacity:.6;cursor:wait}
.gb-fin-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;max-width:100%}
#gbFinTotals{display:flex;flex-wrap:wrap;gap:10px;margin:12px 0}
#gbFinTotals .gb-fin-card{box-sizing:border-box;flex:1 1 150px;min-width:140px;padding:11px 13px;border:1px solid #e4e7ec;border-radius:12px;background:#fff}
#gbFinTotals small{display:block;font-size:11px;font-weight:800;color:#667085;text-transform:uppercase;letter-spacing:.02em}
#gbFinTotals b{display:block;margin-top:4px;font-size:18px;font-weight:900;color:#101828;white-space:nowrap}
#gbFinTotals .gb-fin-note{display:block;margin-top:2px;font-size:11px;font-weight:700;color:#98a2b3}
#gbFinTotals b.gb-fin-pos{color:#027a48}#gbFinTotals b.gb-fin-neg{color:#b42318}
#gbFinWarn{display:none;margin:10px 0;padding:10px 13px;border:1px solid #fedf89;border-radius:12px;background:#fffaeb;color:#93370d;font-size:12px;font-weight:750;line-height:1.45}
#gbFinWarn.show{display:block}
@media(max-width:700px){#gbFinTotals .gb-fin-card{flex-basis:calc(50% - 10px)}#gbFinTotals b{font-size:16px}}
`;
  document.head.appendChild(s);
}
function headerIndex(headers,name){return headers.findIndex(th=>normHeader(th.textContent)===name)}
function skuFromCell(td){
  if(!td)return'';
  const v=td.querySelector('.gb-copy-value');
  if(v)return normSku(v.textContent);
  const c=td.cloneNode(true);c.querySelectorAll('button,a,span,.muted').forEach(e=>e.remove());
  return normSku(String(c.textContent||'').replace(/WB:\s*.*$/i,'').replace(/\s*WB\s*[↗↑]?\s*$/i,''));
}
function sourceNote(x){return [...x.saleSources].filter(Boolean).join(' + ')}
function cellsHtml(x){
  if(!x)return['<span class="gb-fin-dash">—</span>','<span class="gb-fin-dash">—</span>','<span class="gb-fin-dash">—</span>',''];
  const sale=x.saleTotal==null?'<span class="gb-fin-dash">—</span><span class="gb-fin-sub">нет цены</span>'
    :'<b>'+money(x.saleTotal)+'</b><span class="gb-fin-sub">'+esc(sourceNote(x))+(x.saleComplete?'':' · '+x.saleUnits+' из '+x.qty+' шт')+'</span>';
  const w=x.wUnit==null?'<span class="gb-fin-dash">—</span>'
    :'<b>'+money(x.wUnit)+'</b><span class="gb-fin-sub">× '+x.qty+' = '+money(x.wTotal)+'</span>';
  const p=x.profit==null?'<span class="gb-fin-dash">—</span>'
    :'<b class="'+(x.profit>=0?'gb-fin-pos':'gb-fin-neg')+'">'+(x.profit>0?'+':'')+money(x.profit)+'</b>';
  return[sale,w,p,null];
}
function orderedHtml(x,sku){
  const key=normSku(sku),need=x?x.qty:0,rec=supplier.items[key],n=rec?Number(rec.qty)||0:0;
  let badge;
  if(!supplier.ready&&!supplier.error)badge='<span class="gb-fin-badge none">Загрузка…</span>';
  else if(n>0&&n>=need)badge='<span class="gb-fin-badge ok">✓ Заказано: '+n+' шт</span>';
  else if(n>0)badge='<span class="gb-fin-badge part">Заказано '+n+' из '+need+'</span>';
  else badge='<span class="gb-fin-badge none">Не заказано</span>';
  const busy=supplier.saving.has(key);
  return badge+'<div class="gb-fin-edit"><input type="number" min="0" step="1" inputmode="numeric" value="'+(n||'')+'" placeholder="шт" aria-label="Заказано у поставщика, шт" data-gb-fin-sku="'+esc(key)+'"'+(busy?' disabled':'')+'><button type="button" data-gb-fin-save="'+esc(key)+'"'+(busy?' disabled':'')+'>'+(busy?'…':'Сохранить')+'</button></div>'
    +(rec&&rec.updatedAt?'<span class="gb-fin-sub">'+esc(rec.updatedAt)+'</span>':'');
}
function setCell(td,html){
  if(td.dataset.gbFinHtml===html)return;
  if(td.contains(document.activeElement))return; // не сбиваем ввод
  td.dataset.gbFinHtml=html;td.innerHTML=html;
}
function ensureScrollWrapper(table){
  if(!table||table.dataset.gbFinScroll)return;
  table.dataset.gbFinScroll='1';
  const parent=table.parentElement;if(!parent)return;
  const ox=getComputedStyle(parent).overflowX;
  if(ox==='auto'||ox==='scroll'){parent.classList.add('gb-fin-scroll');return}
  const wrap=document.createElement('div');wrap.className='gb-fin-scroll';
  parent.insertBefore(wrap,table);wrap.appendChild(table);
}
function ensurePanels(table){
  const anchor=table.closest('.gb-fin-scroll')||table;
  let warn=$('#gbFinWarn');
  if(!warn){warn=document.createElement('div');warn.id='gbFinWarn';warn.setAttribute('role','status')}
  let totals=$('#gbFinTotals');
  if(!totals){totals=document.createElement('div');totals.id='gbFinTotals'}
  if(anchor.previousElementSibling!==warn||warn.previousElementSibling!==totals){
    anchor.parentElement.insertBefore(totals,anchor);
    anchor.parentElement.insertBefore(warn,anchor);
  }
  return{warn,totals};
}
function warnings(){
  const out=[];
  if(excelActive()){
    const meta=readJson(EXCEL_META_KEY)||{};
    if(!excelExtra||!excelExtraFresh()){
      out.push('Цены из Excel «'+esc(meta.name||'файл')+'» ещё не прочитаны (файл загружен до появления этих столбцов). Нажмите «📥 Загрузить Excel» и выберите файл ещё раз. Пока суммы и опт берутся из «Прайс KASPI».');
    }else{
      const found=excelExtra.headers.length?excelExtra.headers.map(h=>'«'+esc(h)+'»').join(', '):'заголовки не найдены (файл без шапки)';
      if(!excelExtra.found.wholesale){
        out.push('⚠ В Excel «'+esc(excelExtra.fileName)+'» не найдена колонка оптовой цены (ищу: '+COLUMN_MAP.excel.wholesale.map(v=>'«'+esc(v)+'»').join(', ')+'). Найдены колонки: '+found+'. Опт взят из «Прайс KASPI»'+(catalog.columns.wholesale?' → «'+esc(catalog.columns.wholesale)+'»':'')+'.');
      }
      if(!excelExtra.found.lineSum&&!excelExtra.found.unit){
        out.push('В Excel нет колонки суммы/цены продажи — сумма посчитана по цене из «Прайс KASPI»'+(catalog.columns.salePrice?' → «'+esc(catalog.columns.salePrice)+'»':'')+'.');
      }
      if(excelExtra.error)out.push('Ошибка чтения цен из Excel: '+esc(excelExtra.error));
    }
  }
  if(catalog.error)out.push('Не удалось загрузить «Прайс KASPI»: '+esc(catalog.error)+'. Повтор через минуту.');
  else if(catalog.ready&&!catalog.columns.wholesale)out.push('В «Прайс KASPI» не найдена колонка оптовой цены.');
  if(supplier.error)out.push('«Заказано»: не удалось загрузить данные из Google Таблицы — '+esc(supplier.error));
  return out;
}

let model=new Map();
function ensure(){
  const head=$('#orderHead'),body=$('#ot');if(!head||!body)return;
  const table=body.closest('table');if(!table)return;
  ensureStyle();
  const heads=[...head.querySelectorAll(':scope > th')];
  const skuIdx=headerIndex(heads,'артикул');
  const qtyIdx=headerIndex(heads,'кол-во');
  if(skuIdx<0||qtyIdx<0)return;
  ensureScrollWrapper(table);
  const {warn:warnEl,totals:totalsEl}=ensurePanels(table);
  const hasDataRows=[...body.querySelectorAll(':scope > tr')].some(tr=>tr.querySelectorAll(':scope > td').length>Math.max(skuIdx,qtyIdx));
  if(!hasDataRows){
    // Пустая таблица (например, «Excel не загружен») — новые колонки не добавляем, чтобы не спорить с другими аддонами.
    head.querySelectorAll('[data-gb-fin]').forEach(th=>th.remove());
    totalsEl.innerHTML='';totalsEl.dataset.gbFinHtml='';
    const wHtml=warnings().join('<br>');
    if(warnEl.dataset.gbFinHtml!==wHtml){warnEl.dataset.gbFinHtml=wHtml;warnEl.innerHTML=wHtml;warnEl.classList.toggle('show',!!wHtml)}
    return;
  }
  model=buildModel();

  // Заголовки
  if(!head.querySelector('[data-gb-fin]')){
    let after=heads[qtyIdx];
    NEW_HEADS.forEach((t,i)=>{const th=document.createElement('th');th.className='gb-fin-head';th.dataset.gbFin=String(i);th.textContent=t;after.after(th);after=th});
  }

  // Строки
  const visible=[];
  for(const tr of body.querySelectorAll(':scope > tr')){
    const cells=[...tr.querySelectorAll(':scope > td')];
    if(cells.length<=Math.max(skuIdx,qtyIdx)){
      const only=cells.length===1?cells[0]:null; // «Нет заказов» — растягиваем на новые колонки
      if(only&&only.colSpan>1&&!only.dataset.gbFinSpan){only.dataset.gbFinSpan='1';only.colSpan+=NEW_HEADS.length}
      continue;
    }
    const sku=skuFromCell(cells[skuIdx]);if(!sku)continue;
    let fin=[...tr.querySelectorAll(':scope > td[data-gb-fin]')];
    if(fin.length!==NEW_HEADS.length){
      fin.forEach(td=>td.remove());fin=[];
      let after=cells[qtyIdx];
      for(let i=0;i<NEW_HEADS.length;i++){const td=document.createElement('td');td.className='gb-fin-cell';td.dataset.gbFin=String(i);after.after(td);after=td;fin.push(td)}
    }
    const x=model.get(sku)||null;
    const html=cellsHtml(x);
    for(let i=0;i<3;i++)setCell(fin[i],html[i]);
    setCell(fin[3],orderedHtml(x,sku));
    visible.push({sku,x});
  }

  // Итоги по видимым строкам (вкладка + поиск)
  const warn=warnEl,totals=totalsEl;
  let sale=0,wsum=0,profit=0,profitRows=0,missingW=0,saleMissing=0,notOrdered=0;
  for(const {sku,x} of visible){
    if(x&&x.saleTotal!=null)sale+=x.saleTotal;
    if(!x||!x.saleComplete)saleMissing++;
    if(x&&x.wTotal!=null)wsum+=x.wTotal;else missingW++;
    if(x&&x.profit!=null){profit+=x.profit;profitRows++}
    const rec=supplier.items[normSku(sku)];if(!rec||!(Number(rec.qty)>0))notOrdered++;
  }
  const g=currentGroup(),q=clean($('#os')&&$('#os').value);
  const scope=esc(g)+(q?' · поиск «'+esc(q)+'»':'')+' · '+visible.length+' поз.';
  const totalsHtml=
    '<div class="gb-fin-card"><small>Сумма продаж</small><b>'+money(sale)+'</b><span class="gb-fin-note">'+scope+(saleMissing?' · без цены: '+saleMissing:'')+'</span></div>'+
    '<div class="gb-fin-card"><small>Опт всего</small><b>'+money(wsum)+'</b><span class="gb-fin-note">'+(missingW?'без опта: '+missingW+' поз.':'по всем позициям')+'</span></div>'+
    '<div class="gb-fin-card"><small>Прибыль</small><b class="'+(profit>=0?'gb-fin-pos':'gb-fin-neg')+'">'+(profitRows?(profit>0?'+':'')+money(profit):'—')+'</b><span class="gb-fin-note">'+(profitRows<visible.length?'посчитано для '+profitRows+' из '+visible.length+' поз.':'по всем позициям')+'</span></div>'+
    '<div class="gb-fin-card"><small>Не заказано</small><b>'+positions(notOrdered)+'</b><span class="gb-fin-note">'+(supplier.ready?'из '+visible.length:'загрузка…')+'</span></div>';
  if(totals.dataset.gbFinHtml!==totalsHtml){totals.dataset.gbFinHtml=totalsHtml;totals.innerHTML=totalsHtml}
  const w=warnings();const wHtml=w.join('<br>');
  if(warn.dataset.gbFinHtml!==wHtml){warn.dataset.gbFinHtml=wHtml;warn.innerHTML=wHtml;warn.classList.toggle('show',!!wHtml)}
}

let timer=null;
let due=0;
// Троттлинг, а не debounce: частые перерисовки других аддонов не должны откладывать наш пересчёт бесконечно.
function schedule(ms=30){
  const at=Date.now()+ms;
  if(timer&&due<=at)return;
  clearTimeout(timer);due=at;
  timer=setTimeout(()=>{timer=null;requestAnimationFrame(ensure)},ms);
}

// Сохранение «Заказано»
function saveFrom(key){
  const input=[...document.querySelectorAll('#ot input[data-gb-fin-sku]')].find(i=>i.dataset.gbFinSku===key);
  if(!input)return;
  const raw=clean(input.value);const n=raw===''?0:Number(raw);
  if(!Number.isInteger(n)||n<0){alert('Введите целое число штук (0 — не заказано)');input.focus();return}
  input.blur();saveSupplier(key,n);
}
document.addEventListener('click',e=>{
  const b=e.target&&e.target.closest&&e.target.closest('#ot [data-gb-fin-save]');
  if(b){e.preventDefault();e.stopPropagation();saveFrom(b.dataset.gbFinSave);return}
  if(e.target&&e.target.closest&&e.target.closest('#ot .gb-fin-edit'))e.stopPropagation();
},true);
document.addEventListener('keydown',e=>{
  const i=e.target;
  if(i&&i.matches&&i.matches('#ot input[data-gb-fin-sku]')&&e.key==='Enter'){e.preventDefault();saveFrom(i.dataset.gbFinSku)}
},true);
document.addEventListener('input',e=>{if(e.target&&e.target.id==='os')schedule(60)},true);
document.addEventListener('click',e=>{if(e.target&&e.target.closest&&e.target.closest('#groups button'))schedule(120)},true);

let observed=false;
function boot(){
  const head=$('#orderHead'),body=$('#ot');
  if(!head||!body){setTimeout(boot,250);return}
  if(!observed){
    observed=true;
    const mo=new MutationObserver(muts=>{
      // реагируем только на изменения, которые сделали не мы
      if(muts.some(m=>!(m.target.closest&&m.target.closest('[data-gb-fin],#gbFinTotals,#gbFinWarn'))))schedule(40);
    });
    mo.observe(head,{childList:true,subtree:true});
    mo.observe(body,{childList:true,subtree:true});
  }
  loadCatalog();loadSupplier();schedule(0);
  setInterval(()=>{if(document.visibilityState==='visible')loadSupplier()},120000);
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();

window.GB_ORDERS_FINANCE={COLUMN_MAP,render:()=>schedule(0),reloadSupplier:loadSupplier,model:()=>model};
})();
