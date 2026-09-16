(()=>{
'use strict';
if(window.GB_ORDERS_PHOTO_ENRICH_LOADED)return;
window.GB_ORDERS_PHOTO_ENRICH_LOADED=true;

const RAW='https://raw.githubusercontent.com/diasirga07-max/marketplace-manager/main/public/';
const PRICE_SHEET_ID='1dLU5KOi3WBLy3uNEiqGv5rf9ka0OwcEw_RjhDQW3H1E';
const PRICE_SHEET_NAME='Прайс KASPI';
const originalFetch=window.fetch.bind(window);
let photoMapPromise=null;
let priceSourcePromise=null;
const resolvedCache=new Map();

const norm=v=>String(v==null?'':v).trim().toUpperCase();
const goodUrl=v=>/^https?:\/\//i.test(String(v||'').trim())?String(v).trim():'';
const cell=c=>c&&c.v!=null?String(c.v).trim():'';

async function loadPhotoMap(){
  if(photoMapPromise)return photoMapPromise;
  photoMapPromise=(async()=>{
    try{
      const parts=await Promise.all(Array.from({length:8},(_,i)=>
        originalFetch(RAW+'gb-photo-map-'+i+'.pack?v=orders-photo-20260916-2',{cache:'no-store'})
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

function loadPriceSources(){
  if(priceSourcePromise)return priceSourcePromise;
  priceSourcePromise=new Promise(resolve=>{
    const cb='__gbOrderPhotoSources_'+Date.now()+'_'+Math.random().toString(36).slice(2);
    const s=document.createElement('script');
    const done=(value)=>{try{delete window[cb]}catch{};s.remove();resolve(value)};
    const timer=setTimeout(()=>done(new Map()),18000);
    window[cb]=resp=>{
      clearTimeout(timer);
      try{
        const map=new Map();
        const rows=resp&&resp.table&&Array.isArray(resp.table.rows)?resp.table.rows:[];
        for(const row of rows){
          const c=row.c||[];
          const sku=norm(cell(c[0]));
          if(!sku)continue;
          map.set(sku,{kaspiUrl:goodUrl(cell(c[1])),photo:goodUrl(cell(c[2]))});
        }
        done(map);
      }catch(e){console.warn('Price photo source parse failed',e);done(new Map())}
    };
    s.onerror=()=>{clearTimeout(timer);done(new Map())};
    const tq='select A,R,AE where A is not null';
    s.src='https://docs.google.com/spreadsheets/d/'+PRICE_SHEET_ID+'/gviz/tq?sheet='+encodeURIComponent(PRICE_SHEET_NAME)+'&headers=1&tqx='+encodeURIComponent('out:json;responseHandler:'+cb)+'&tq='+encodeURIComponent(tq)+'&_='+Date.now();
    document.head.appendChild(s);
  });
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
      if(photo){
        window.GB_PHOTOS=window.GB_PHOTOS||{};
        window.GB_PHOTOS[sku]=photo;
      }
      return photo;
    }catch(e){console.warn('Kaspi photo fallback failed',sku,e);return''}
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
  const photoMap=await loadPhotoMap();
  const rows=[];
  for(const g of ['Курдай','WB','Алматы'])for(const r of (Array.isArray(groups[g])?groups[g]:[]))rows.push(r);

  for(const r of rows){
    if(goodUrl(r&&r.photo))continue;
    const sku=norm(r&&r.sku);
    const mapped=goodUrl(photoMap&&photoMap[sku]);
    if(mapped)r.photo=mapped;
  }

  const missing=rows.filter(r=>!goodUrl(r&&r.photo)&&norm(r&&r.sku));
  if(!missing.length)return groups;

  const sources=await loadPriceSources();
  for(const r of missing){
    const sku=norm(r.sku),src=sources.get(sku);
    const direct=goodUrl(src&&src.photo);
    if(direct){r.photo=direct;window.GB_PHOTOS=window.GB_PHOTOS||{};window.GB_PHOTOS[sku]=direct;}
  }

  const unresolved=missing.filter(r=>!goodUrl(r.photo));
  await mapLimit(unresolved,6,async r=>{
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
      if(body&&body.groups){
        await enrichGroups(body.groups);
        init={...init,body:JSON.stringify(body)};
      }
    }catch(e){console.warn('Order photo enrichment before Sheets sync failed',e)}
  }
  return originalFetch(input,init);
};

loadPhotoMap().catch(()=>{});
window.GB_ENRICH_ORDER_PHOTOS=enrichGroups;
})();
