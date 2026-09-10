(()=>{
'use strict';
if(window.GB_SHEET_PHOTO_PATCH_LOADED)return;
window.GB_SHEET_PHOTO_PATCH_LOADED=true;

const SID='1dLU5KOi3WBLy3uNEiqGv5rf9ka0OwcEw_RjhDQW3H1E';
const OLD_SID='1qNILk0sLSVExmeIG3_ER8oeBMibSK4NtmXrG8BNpCiM';
const SHEET='Прайс KASPI';
const STOCK_KEY='gbWhStock1';
const RAW='https://raw.githubusercontent.com/diasirga07-max/marketplace-manager/main/public/';
const PACK_VERSION='price-map-5803-20260906b';
const norm=v=>String(v||'').trim().toUpperCase();
const validPhoto=v=>/^https:\/\//i.test(String(v||'').trim())?String(v).trim():'';
let req=0,observer=null,timer=null;

function jsonp(sid,tq){
  return new Promise((ok,no)=>{
    const cb='__gbph'+Date.now()+'_'+(++req),s=document.createElement('script');
    const tm=setTimeout(()=>{delete window[cb];s.remove();no(Error('Таймаут Google Sheets'))},25000);
    window[cb]=r=>{clearTimeout(tm);delete window[cb];s.remove();ok(r)};
    s.onerror=()=>{clearTimeout(tm);delete window[cb];s.remove();no(Error('Не удалось загрузить '+SHEET))};
    s.src='https://docs.google.com/spreadsheets/d/'+sid+'/gviz/tq?sheet='+encodeURIComponent(SHEET)+'&headers=1&tqx='+encodeURIComponent('out:json;responseHandler:'+cb)+'&tq='+encodeURIComponent(tq)+'&_='+Date.now();
    document.head.appendChild(s);
  });
}
const rows=r=>r?.table?.rows?.map(x=>(x.c||[]).map(c=>c?.v==null?'':String(c.v).trim()))||[];

async function loadPackedMap(){
  try{
    const parts=await Promise.all(Array.from({length:8},(_,i)=>
      fetch(RAW+'gb-photo-map-'+i+'.pack?v='+PACK_VERSION,{cache:'no-store'})
        .then(r=>{if(!r.ok)throw new Error('photo map '+i+' HTTP '+r.status);return r.text()})
    ));
    const packed=parts.join('').replace(/\s+/g,'');
    const bytes=Uint8Array.from(atob(packed),c=>c.charCodeAt(0));
    const text=await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    return JSON.parse(text)||{};
  }catch(e){
    console.error('Warehouse packed photo map failed',e);
    return {};
  }
}

function mergeSheet(result,out){
  if(result.status!=='fulfilled')return;
  for(const x of rows(result.value)){
    const sku=norm(x[0]);
    if(!sku)continue;
    const name=String(x[1]||'').trim();
    const photo=validPhoto(x[2]);
    out[sku]=out[sku]||{};
    if(name)out[sku].name=name;
    if(photo)out[sku].photo=photo;
  }
}

function updateStock(photoMap,nameMap){
  let st={};
  try{st=JSON.parse(localStorage.getItem(STOCK_KEY)||'{}')||{}}catch{}
  let changed=0;
  for(const [key,item] of Object.entries(st)){
    const sku=norm(item?.sku||key);
    const p=validPhoto(photoMap[sku]);
    if(p&&item.photo!==p){item.photo=p;changed++}
    if(!item.name&&nameMap[sku])item.name=nameMap[sku];
  }
  if(changed)localStorage.setItem(STOCK_KEY,JSON.stringify(st));
  return changed;
}

function fixDom(){
  const body=document.getElementById('whrows');
  if(!body)return;
  const photos=window.GB_PHOTOS||{};
  for(const row of body.querySelectorAll('tr')){
    const sku=norm(row.querySelector('.whsku')?.textContent);
    const url=validPhoto(photos[sku]);
    if(!sku||!url)continue;
    const cell=row.querySelector('td');
    if(!cell)continue;
    let img=cell.querySelector('img.whpic');
    if(!img){
      cell.innerHTML='';
      img=document.createElement('img');
      img.className='whpic';
      img.loading='lazy';
      img.referrerPolicy='no-referrer';
      img.alt=sku;
      cell.appendChild(img);
    }
    if(img.getAttribute('src')!==url)img.src=url;
    img.style.display='block';
    img.onerror=()=>{
      img.style.display='none';
      if(!cell.querySelector('.whnop')){
        const d=document.createElement('div');d.className='whnop';d.textContent='Нет фото';cell.appendChild(d);
      }
    };
  }
}

function watchRows(){
  const body=document.getElementById('whrows');
  if(!body){setTimeout(watchRows,300);return}
  if(observer)return;
  observer=new MutationObserver(()=>{clearTimeout(timer);timer=setTimeout(fixDom,35)});
  observer.observe(body,{childList:true,subtree:true});
  fixDom();
}

async function load(){
  const [packed,cur,old]=await Promise.all([
    loadPackedMap(),
    Promise.resolve().then(()=>jsonp(SID,'select A,B,AE where A is not null')).then(v=>({status:'fulfilled',value:v}),e=>({status:'rejected',reason:e})),
    Promise.resolve().then(()=>jsonp(OLD_SID,'select A,B,AE where A is not null')).then(v=>({status:'fulfilled',value:v}),e=>({status:'rejected',reason:e}))
  ]);

  const sheet={};
  mergeSheet(old,sheet);
  mergeSheet(cur,sheet);

  const photos={...packed,...(window.GB_PHOTOS||{})};
  const names={};
  for(const [sku,x] of Object.entries(sheet)){
    if(x.name)names[sku]=x.name;
    if(validPhoto(x.photo))photos[sku]=x.photo;
  }
  window.GB_PHOTOS=photos;
  window.GB_PRICE_PHOTO_COUNT=Object.keys(photos).length;

  const changed=updateStock(photos,names);
  console.info('Warehouse photos ready:',Object.keys(photos).length,'stock updated:',changed,'WBBOOK1266:',photos.WBBOOK1266||'missing');
  fixDom();
  document.dispatchEvent(new CustomEvent('gb:photos-updated'));
}

watchRows();
load();
document.addEventListener('click',e=>{if(e.target?.closest?.('#gbWhNav'))setTimeout(fixDom,120)},true);
document.addEventListener('gb:photos-updated',()=>setTimeout(fixDom,20));
})();
