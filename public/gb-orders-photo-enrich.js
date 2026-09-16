(()=>{
'use strict';
if(window.GB_ORDERS_PHOTO_ENRICH_LOADED)return;
window.GB_ORDERS_PHOTO_ENRICH_LOADED=true;

const RAW='https://raw.githubusercontent.com/diasirga07-max/marketplace-manager/main/public/';
const PRICE_SHEET_ID='1dLU5KOi3WBLy3uNEiqGv5rf9ka0OwcEw_RjhDQW3H1E';
const PRICE_SHEET_NAME='Прайс KASPI';
const EXPORT_SHEET_ID='1543WyOY5gsP3i3rcxcmp1dtxYHy6uPUtdFj8Xs58Cr4';
const PHOTO_CACHE_SHEET='_ORDER_PRODUCT_PHOTOS';
const originalFetch=window.fetch.bind(window);
let photoMapPromise=null;
let orderCachePromise=null;
let priceSourcePromise=null;
const resolvedCache=new Map();

const norm=v=>String(v==null?'':v).trim().toUpperCase();
const goodUrl=v=>/^https?:\/\//i.test(String(v||'').trim())?String(v).trim():'';
const cell=c=>c&&c.v!=null?String(c.v).trim():'';

function jsonpSheet(spreadsheetId,sheetName,tq,label){
  return new Promise(resolve=>{
    const cb='__gb_'+label+'_'+Date.now()+'_'+Math.random().toString(36).slice(2);
    const s=document.createElement('script');
    let finished=false;
    const done=value=>{if(finished)return;finished=true;clearTimeout(timer);try{delete window[cb]}catch{};s.remove();resolve(value)};
    const timer=setTimeout(()=>done(null),18000);
    window[cb]=resp=>done(resp);
    s.onerror=()=>done(null);
    s.src='https://docs.google.com/spreadsheets/d/'+spreadsheetId+'/gviz/tq?sheet='+encodeURIComponent(sheetName)+'&headers=1&tqx='+encodeURIComponent('out:json;responseHandler:'+cb)+'&tq='+encodeURIComponent(tq)+'&_='+Date.now();
    document.head.appendChild(s);
  });
}

async function loadPhotoMap(){
  if(photoMapPromise)return photoMapPromise;
  photoMapPromise=(async()=>{
    try{
      const parts=await Promise.all(Array.from({length:8},(_,i)=>
        originalFetch(RAW+'gb-photo-map-'+i+'.pack?v=orders-photo-20260916-3',{cache:'no-store'})
          .then(r=>{if(!r.ok)throw new Error('photo map '+r.status);return r.text()})
      ));
      const packed=parts.join('').replace(/\s+/g,'');
      const bytes=Uint8Array.from(atob(packed),c=>c.charCodeAt(0));
      const text=await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
      const fresh=JSON.parse(text)||{};
      window.GB_PHOTOS=Object.assign({},window.GB_PHOTOS||{},fresh);
      return window.GB_PHOTOS;
    }catch(e){
      console.warn('Orders photo map load failed',e);
      return window.GB_PHOTOS||{};
    }
  })();
  return photoMapPromise;
}

async function loadOrderPhotoCache(force=false){
  if(orderCachePromise&&!force)return orderCachePromise;
  orderCachePromise=(async()=>{
    const resp=await jsonpSheet(EXPORT_SHEET_ID,PHOTO_CACHE_SHEET,'select A,B where A is not null','orderPhotoCache');
    const map=new Map();
    const rows=resp&&resp.table&&Array.isArray(resp.table.rows)?resp.table.rows:[];
    for(const row of rows){
      const c=row.c||[],sku=norm(cell(c[0])),photo=goodUrl(cell(c[1]));
      if(sku&&photo)map.set(sku,photo);
    }
    window.GB_PHOTOS=window.GB_PHOTOS||{};
    for(const [sku,photo] of map)if(!goodUrl(window.GB_PHOTOS[sku]))window.GB_PHOTOS[sku]=photo;
    return map;
  })().catch(e=>{console.warn('Order photo cache load failed',e);return new Map()});
  return orderCachePromise;
}

function loadPriceSources(){
  if(priceSourcePromise)return priceSourcePromise;
  priceSourcePromise=(async()=>{
    const resp=await jsonpSheet(PRICE_SHEET_ID,PRICE_SHEET_NAME,'select A,R,AE where A is not null','orderPricePhoto');
    const map=new Map();
    const rows=resp&&resp.table&&Array.isArray(resp.table.rows)?resp.table.rows:[];
    for(const row of rows){
      const c=row.c||[],sku=norm(cell(c[0]));
      if(!sku)continue;
      map.set(sku,{kaspiUrl:goodUrl(cell(c[1])),photo:goodUrl(cell(c[2]))});
    }
    return map;
  })().catch(e=>{console.warn('Price photo source load failed',e);return new Map()});
  return priceSourcePromise;
}

async function resolveFromKaspi(sku,url){
  if(!sku||!url)return'';
  if(resolvedCache.has(sku))return resolvedCache.get(sku);
  const p=(async()=>{
    try{
      const r=await originalFetch('/api/product-photo?sku='+encodeURIComponent(sku)+'&url='+encodeURIComponent(url)+'&_='+Date.now(),{cache:'no-store'});
      const j=await r.json().catch(()=>null);
      const photo=r.ok&&j&&j.ok?goodUrl(j.photo):'';
      if(photo){window.GB_PHOTOS=window.GB_PHOTOS||{};window.GB_PHOTOS[sku]=photo;}
      return photo;
    }catch(e){return''}
  })();
  resolvedCache.set(sku,p);
  return p;
}

async function mapLimit(items,limit,fn){
  let cursor=0;
  async function worker(){while(true){const i=cursor++;if(i>=items.length)return;await fn(items[i],i)}}
  await Promise.all(Array.from({length:Math.min(limit,Math.max(1,items.length))},worker));
}

async function enrichGroups(groups){
  if(!groups||typeof groups!=='object')return groups;
  const [photoMap,orderCache]=await Promise.all([loadPhotoMap(),loadOrderPhotoCache()]);
  const rows=[];
  for(const g of ['Курдай','WB','Алматы'])for(const r of (Array.isArray(groups[g])?groups[g]:[]))rows.push(r);

  for(const r of rows){
    if(goodUrl(r&&r.photo))continue;
    const sku=norm(r&&r.sku);
    const cached=goodUrl(orderCache&&orderCache.get(sku));
    const mapped=goodUrl(photoMap&&photoMap[sku]);
    const photo=cached||mapped;
    if(photo)r.photo=photo;
  }

  let missing=rows.filter(r=>!goodUrl(r&&r.photo)&&norm(r&&r.sku));
  if(!missing.length)return groups;

  const sources=await loadPriceSources();
  for(const r of missing){
    const sku=norm(r.sku),src=sources.get(sku),direct=goodUrl(src&&src.photo);
    if(direct){r.photo=direct;window.GB_PHOTOS=window.GB_PHOTOS||{};window.GB_PHOTOS[sku]=direct;}
  }

  missing=rows.filter(r=>!goodUrl(r&&r.photo)&&norm(r&&r.sku));
  await mapLimit(missing,4,async r=>{
    const sku=norm(r.sku),src=sources.get(sku);
    const photo=await resolveFromKaspi(sku,src&&src.kaspiUrl);
    if(photo)r.photo=photo;
  });
  return groups;
}

window.fetch=async function(input,init){
  const url=typeof input==='string'?input:String(input&&input.url||'');
  const method=String(init&&init.method||'GET').toUpperCase();
  if(method==='POST'&&/\/api\/orders-sheets-sync(?:\?|$)/.test(url)&&init&&typeof init.body==='string'){
    try{
      const body=JSON.parse(init.body);
      if(body&&body.groups){await enrichGroups(body.groups);init={...init,body:JSON.stringify(body)}}
    }catch(e){console.warn('Order photo enrichment before Sheets sync failed',e)}
  }
  return originalFetch(input,init);
};

Promise.all([loadPhotoMap(),loadOrderPhotoCache()]).catch(()=>{});
window.GB_ENRICH_ORDER_PHOTOS=enrichGroups;
window.GB_RELOAD_ORDER_PHOTO_CACHE=()=>loadOrderPhotoCache(true);
})();
