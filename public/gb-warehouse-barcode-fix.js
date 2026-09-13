(()=>{
'use strict';
if(window.GB_WAREHOUSE_BARCODE_FIX_LOADED)return;
window.GB_WAREHOUSE_BARCODE_FIX_LOADED=true;

const SID='1dLU5KOi3WBLy3uNEiqGv5rf9ka0OwcEw_RjhDQW3H1E';
const PRICE_SHEET='Прайс KASPI';
const ORDERS_SHEET='KASPI_ЗАКАЗЫ';
const SK='gbWhStock1',DK='gbWhDocs1',HK='gbWhHist1';
let pricePromise=null,ordersPromise=null;
const byBarcode=new Map(),bySku=new Map(),byOrder=new Map();

const norm=v=>String(v==null?'':v).trim().toUpperCase();
const barcodeKey=v=>String(v==null?'':v).trim().replace(/[\s\u00A0]+/g,'').toUpperCase();
const orderKey=v=>String(v==null?'':v).trim().replace(/-1$/,'');
const now=()=>new Date().toISOString();
function cell(c){
  if(!c)return'';
  if(c.f!=null&&String(c.f).trim())return String(c.f).trim();
  if(c.v!=null)return String(c.v).trim();
  return'';
}
function load(key,def){try{return JSON.parse(localStorage.getItem(key)||'')||def}catch{return def}}
function save(key,val){localStorage.setItem(key,JSON.stringify(val))}
function msg(text,kind='warn'){
  const m=document.getElementById('whmsg');if(!m)return;
  m.className='whmsg '+kind;m.textContent=text;
}
function gviz(sheet,query,label){
  return new Promise((resolve,reject)=>{
    const cb='__gbWhFix'+Date.now()+Math.random().toString(36).slice(2);
    const s=document.createElement('script');let done=false;
    const finish=(fn,v)=>{if(done)return;done=true;clearTimeout(tm);try{delete window[cb]}catch{};s.remove();fn(v)};
    window[cb]=r=>finish(resolve,r||{});
    const tm=setTimeout(()=>finish(reject,new Error('Таймаут '+label)),18000);
    s.onerror=()=>finish(reject,new Error('Не удалось загрузить '+label));
    s.src='https://docs.google.com/spreadsheets/d/'+SID+'/gviz/tq?sheet='+encodeURIComponent(sheet)+'&headers=1&tqx='+encodeURIComponent('out:json;responseHandler:'+cb)+'&tq='+encodeURIComponent(query)+'&_='+Date.now();
    document.head.appendChild(s);
  });
}
function registerBarcode(value,rec){
  const raw=String(value||'').trim();if(!raw)return;
  for(const v of [raw,...raw.split(/[;,|\n]+/g)]){const k=barcodeKey(v);if(k)byBarcode.set(k,rec)}
}
async function loadPrices(force=false){
  if(pricePromise&&!force)return pricePromise;
  pricePromise=(async()=>{
    const r=await gviz(PRICE_SHEET,'select A,B,AA,AE where A is not null','прайса и штрихкодов');
    const rows=r?.table?.rows||[];byBarcode.clear();bySku.clear();
    for(const row of rows){
      const c=row.c||[],sku=norm(cell(c[0]));if(!sku)continue;
      const rec={sku,name:cell(c[1])||sku,barcode:cell(c[2]),photo:cell(c[3])};
      bySku.set(sku,rec);registerBarcode(rec.barcode,rec);
      const embedded=String(rec.name||'').match(/\b\d{8,14}\b/g)||[];
      for(const b of embedded)registerBarcode(b,rec);
    }
    window.GB_WAREHOUSE_BARCODE_MAP=byBarcode;
    return bySku;
  })().catch(e=>{console.warn('Warehouse price/barcode map failed',e);throw e});
  return pricePromise;
}
function parseItems(raw){
  return String(raw||'').split(/;|\n/).map(part=>{
    const s=String(part||'').trim();if(!s)return null;
    const m=s.match(/^(.*?)(?:\s+x(\d+))?$/i);
    const sku=norm(m&&m[1]?m[1]:s),qty=Math.max(1,Number(m&&m[2]?m[2]:1)||1);
    return sku?{sku,qty}:null;
  }).filter(Boolean);
}
async function loadOrders(force=false){
  if(ordersPromise&&!force)return ordersPromise;
  ordersPromise=(async()=>{
    const r=await gviz(ORDERS_SHEET,'select A,B where A is not null','заказов Kaspi');
    const rows=r?.table?.rows||[];byOrder.clear();
    for(const row of rows){
      const c=row.c||[],code=orderKey(cell(c[0]));if(!code)continue;
      const items=parseItems(cell(c[1]));if(items.length)byOrder.set(code,items);
    }
    return byOrder;
  })().catch(e=>{console.warn('Warehouse orders map failed',e);throw e});
  return ordersPromise;
}
function addHistory(label,units){
  const h=load(HK,[]);h.unshift({label,units,at:now()});h.splice(50);save(HK,h);
}
function refreshWarehouse(){
  const q=document.getElementById('whq');if(q)q.dispatchEvent(new Event('input',{bubbles:true}));
  setTimeout(repairPhotos,30);
}
function addLocalItems(items,label,orderCode=''){
  const st=load(SK,{});let units=0;
  for(const item of items||[]){
    const sku=norm(item.sku);if(!sku)continue;
    const qty=Math.max(1,Number(item.qty||item.quantity)||1),rec=bySku.get(sku)||{};
    const z=st[sku]||{sku,name:'',photo:'',quantity:0,lastAt:''};
    z.quantity=(Number(z.quantity)||0)+qty;
    z.name=String(rec.name||z.name||sku).trim();
    z.photo=String(rec.photo||z.photo||'').trim();
    z.lastAt=now();st[sku]=z;units+=qty;
  }
  save(SK,st);
  if(orderCode){
    const code=orderKey(orderCode),ds=load(DK,{}),prev=ds[code]||null,scans=(Number(prev?.scans)||0)+1;
    ds[code]={at:prev?.at||now(),lastAt:now(),units:(Number(prev?.units)||0)+units,lastUnits:units,scans};save(DK,ds);
    addHistory('Накладная '+code+(prev?' · повтор '+scans:''),units);
  }else addHistory(label,units);
  refreshWarehouse();
  return units;
}
function repairPhotos(){
  const body=document.getElementById('whrows');if(!body)return;
  for(const tr of body.querySelectorAll('tr')){
    const sku=norm(tr.querySelector('.whsku')?.textContent||''),rec=bySku.get(sku);
    if(!rec||!/^https?:\/\//i.test(rec.photo||''))continue;
    const td=tr.querySelector('td');if(!td)continue;
    let img=tr.querySelector('img.whpic');
    if(!img){img=document.createElement('img');img.className='whpic';img.loading='lazy';td.prepend(img)}
    img.src=rec.photo;img.style.display='block';img.referrerPolicy='no-referrer';
    const no=td.querySelector('.whnop');if(no)no.style.display='none';
    img.onerror=()=>{img.style.display='none';if(no)no.style.display='flex'};
  }
}
function focusInput(){setTimeout(()=>document.getElementById('whscan')?.focus(),30)}
function patchScanner(){
  const input=document.getElementById('whscan'),btn=document.getElementById('whdo');
  if(!input||!btn||btn.dataset.gbBarcodeFixed==='2')return false;
  btn.dataset.gbBarcodeFixed='2';
  btn.onclick=async function(){
    const raw=String(input.value||'').trim();if(!raw)return;
    input.value='';msg('Распознаю…','warn');
    try{
      await Promise.all([loadPrices(),loadOrders()]);
      const skuRec=bySku.get(norm(raw));
      if(skuRec){
        const n=addLocalItems([{sku:skuRec.sku,qty:1}],'Товар '+skuRec.sku);
        msg('✓ '+skuRec.name+' · +'+n+' шт.','ok');focusInput();return;
      }
      const barRec=byBarcode.get(barcodeKey(raw));
      if(barRec){
        const n=addLocalItems([{sku:barRec.sku,qty:1}],'Товар '+barRec.sku+' · штрихкод '+raw);
        msg('✓ '+barRec.name+' · '+barRec.sku+' · +'+n+' шт.','ok');focusInput();return;
      }
      const code=orderKey(raw),orderItems=byOrder.get(code);
      if(orderItems?.length){
        const n=addLocalItems(orderItems,'Накладная '+code,code);
        msg('✓ Накладная '+code+': добавлено '+n+' шт., одинаковые товары объединены','ok');focusInput();return;
      }
      msg('Товар или накладная не найдены в актуальном Прайс KASPI / KASPI_ЗАКАЗЫ.','err');focusInput();
    }catch(e){msg('Ошибка загрузки данных: '+(e?.message||e),'err');focusInput()}
  };
  input.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();btn.onclick()}};
  return true;
}

let rowObserver=null;
function guard(){
  patchScanner();repairPhotos();
  const rows=document.getElementById('whrows');
  if(rows&&!rowObserver){rowObserver=new MutationObserver(()=>setTimeout(repairPhotos,0));rowObserver.observe(rows,{childList:true,subtree:true})}
}
Promise.allSettled([loadPrices(),loadOrders()]).then(()=>{guard();repairPhotos()});
guard();
new MutationObserver(guard).observe(document.documentElement,{childList:true,subtree:true});
})();
