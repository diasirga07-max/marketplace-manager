(()=>{
'use strict';
if(window.GB_WAREHOUSE_BARCODE_FIX_LOADED)return;
window.GB_WAREHOUSE_BARCODE_FIX_LOADED=true;

const SID='1dLU5KOi3WBLy3uNEiqGv5rf9ka0OwcEw_RjhDQW3H1E';
const SHEET='Прайс KASPI';
let loadPromise=null;
const byBarcode=new Map();
const bySku=new Map();

const norm=v=>String(v==null?'':v).trim().toUpperCase();
const barcodeKey=v=>String(v==null?'':v).trim().replace(/[\s\u00A0]+/g,'').toUpperCase();
function cell(c){
  if(!c)return'';
  if(c.f!=null&&String(c.f).trim())return String(c.f).trim();
  if(c.v!=null)return String(c.v).trim();
  return'';
}
function msg(text,kind='warn'){
  const m=document.getElementById('whmsg');
  if(!m)return;
  m.className='whmsg '+kind;
  m.textContent=text;
}
function gviz(){
  return new Promise((resolve,reject)=>{
    const cb='__gbWhBarcode'+Date.now()+Math.random().toString(36).slice(2);
    const s=document.createElement('script');
    let done=false;
    const finish=(fn,v)=>{if(done)return;done=true;clearTimeout(tm);try{delete window[cb]}catch{};s.remove();fn(v)};
    window[cb]=r=>finish(resolve,r||{});
    const tm=setTimeout(()=>finish(reject,new Error('Таймаут загрузки штрихкодов')),18000);
    s.onerror=()=>finish(reject,new Error('Не удалось загрузить штрихкоды'));
    const q='select A,B,AA,AE where A is not null';
    s.src='https://docs.google.com/spreadsheets/d/'+SID+'/gviz/tq?sheet='+encodeURIComponent(SHEET)+'&headers=1&tqx='+encodeURIComponent('out:json;responseHandler:'+cb)+'&tq='+encodeURIComponent(q)+'&_='+Date.now();
    document.head.appendChild(s);
  });
}
async function loadMap(force=false){
  if(loadPromise&&!force)return loadPromise;
  loadPromise=(async()=>{
    const r=await gviz();
    const rows=r&&r.table&&Array.isArray(r.table.rows)?r.table.rows:[];
    byBarcode.clear();bySku.clear();
    for(const row of rows){
      const c=row.c||[];
      const sku=norm(cell(c[0]));
      if(!sku)continue;
      const rec={sku,name:cell(c[1])||sku,barcode:cell(c[2]),photo:cell(c[3])};
      bySku.set(sku,rec);
      const raw=String(rec.barcode||'').trim();
      if(raw){
        const variants=[raw,...raw.split(/[;,|\n]+/g)];
        for(const v of variants){const k=barcodeKey(v);if(k)byBarcode.set(k,rec)}
      }
    }
    window.GB_WAREHOUSE_BARCODE_MAP=byBarcode;
    return byBarcode;
  })().catch(e=>{console.warn('Warehouse barcode map failed',e);throw e});
  return loadPromise;
}
function repairPhotos(){
  const body=document.getElementById('whrows');
  if(!body)return;
  for(const tr of body.querySelectorAll('tr')){
    const sku=norm(tr.querySelector('.whsku')?.textContent||'');
    const rec=bySku.get(sku);if(!rec||!/^https?:\/\//i.test(rec.photo||''))continue;
    let img=tr.querySelector('img.whpic');
    const td=tr.querySelector('td');if(!td)continue;
    if(!img){
      img=document.createElement('img');img.className='whpic';img.loading='lazy';td.prepend(img);
    }
    if(img.src!==rec.photo)img.src=rec.photo;
    img.style.display='block';img.referrerPolicy='no-referrer';
    const no=td.querySelector('.whnop');if(no)no.style.display='none';
    img.onerror=()=>{img.style.display='none';if(no)no.style.display='flex'};
  }
}
function patchScanner(){
  const input=document.getElementById('whscan');
  const btn=document.getElementById('whdo');
  if(!input||!btn||btn.dataset.gbBarcodeFixed==='1')return false;
  const original=btn.onclick;
  if(typeof original!=='function')return false;
  btn.dataset.gbBarcodeFixed='1';
  btn.onclick=async function(ev){
    const raw=String(input.value||'').trim();
    if(!raw)return original.call(this,ev);
    try{
      await loadMap();
      const rec=byBarcode.get(barcodeKey(raw));
      if(rec){
        input.value=rec.sku;
        msg('Штрихкод найден: '+rec.sku+' · добавляю товар…','warn');
        const out=original.call(this,ev);
        await Promise.resolve(out);
        setTimeout(repairPhotos,40);
        return out;
      }
    }catch(e){console.warn('Warehouse barcode lookup failed',e)}
    return original.call(this,ev);
  };
  input.onkeydown=e=>{
    if(e.key==='Enter'){
      e.preventDefault();
      btn.onclick(e);
    }
  };
  return true;
}

let rowObserver=null;
function guard(){
  patchScanner();repairPhotos();
  const rows=document.getElementById('whrows');
  if(rows&&!rowObserver){rowObserver=new MutationObserver(()=>setTimeout(repairPhotos,0));rowObserver.observe(rows,{childList:true,subtree:true})}
}
loadMap().then(()=>{guard();repairPhotos()}).catch(()=>{});
guard();
new MutationObserver(guard).observe(document.documentElement,{childList:true,subtree:true});
})();
