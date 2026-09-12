(()=>{
'use strict';
if(window.GB_NEW_ORDERS_PHOTO_FIX_LOADED)return;
window.GB_NEW_ORDERS_PHOTO_FIX_LOADED=true;

const SHEET_ID='1dLU5KOi3WBLy3uNEiqGv5rf9ka0OwcEw_RjhDQW3H1E';
const SHEET='Прайс KASPI';
const map={};
const norm=v=>String(v||'').trim().toUpperCase();
const raw=c=>{if(!c)return'';if(c.v!=null&&String(c.v).trim())return String(c.v).trim();if(c.f!=null)return String(c.f).trim();return''};

function warehousePhoto(sku){
  try{
    const st=JSON.parse(localStorage.getItem('gbWhStock1')||'{}')||{};
    const x=st[norm(sku)]||{};
    return /^https?:\/\//i.test(String(x.photo||''))?String(x.photo).trim():'';
  }catch{return''}
}
function photoFor(sku){
  sku=norm(sku);
  const global=window.GB_PHOTOS||{};
  return String(map[sku]||global[sku]||warehousePhoto(sku)||'').trim();
}
function setImage(box,url,sku){
  if(!box||!/^https?:\/\//i.test(url))return;
  const current=box.querySelector('img');
  if(current&&current.dataset.gbSku===sku&&current.dataset.gbSource===url)return;
  box.textContent='';
  const img=document.createElement('img');
  img.alt='';
  img.decoding='async';
  img.referrerPolicy='no-referrer';
  img.dataset.gbSku=sku;
  img.dataset.gbSource=url;
  img.style.width='100%';img.style.height='100%';img.style.objectFit='contain';img.style.background='#fff';
  img.onerror=()=>{
    if(img.dataset.gbProxy!=='1'){
      img.dataset.gbProxy='1';
      img.src='https://images.weserv.nl/?url='+encodeURIComponent(url)+'&output=webp';
      return;
    }
    box.textContent='Нет фото';
  };
  img.src=url;
  box.appendChild(img);
}
function apply(){
  const root=document.getElementById('gbNewOrders');
  if(!root)return;
  for(const tr of root.querySelectorAll('.nwotable tbody tr')){
    const sku=norm(tr.querySelector('.nwosku')?.textContent||'');
    const box=tr.querySelector('.nwopic');
    if(!sku||!box)continue;
    const url=photoFor(sku);
    if(url)setImage(box,url,sku);
  }
}
function ensureRefreshButton(){
  const root=document.getElementById('gbNewOrders');
  if(!root||document.getElementById('gbNewOrdersForceRefresh'))return !!root;
  const tools=root.querySelector('.nwotools');
  if(!tools)return false;
  const b=document.createElement('button');
  b.id='gbNewOrdersForceRefresh';
  b.type='button';
  b.className='nwochip';
  b.textContent='🔄 Обновить';
  b.title='Принудительно обновить сегодняшние заказы и фотографии';
  b.style.background='#12b76a';
  b.style.color='#fff';
  b.style.borderColor='#12b76a';
  b.style.fontWeight='900';
  b.onclick=async()=>{
    if(b.disabled)return;
    b.disabled=true;
    const old=b.textContent;
    b.textContent='⏳ Обновляю…';
    try{
      const native=document.getElementById('nwoRefresh');
      if(native)native.click();
      await load();
      setTimeout(apply,500);
      setTimeout(apply,1500);
      b.textContent='✓ Обновлено';
    }catch(e){
      console.warn('New Orders manual refresh failed',e);
      b.textContent='⚠ Повторить';
    }finally{
      setTimeout(()=>{b.disabled=false;b.textContent=old},1400);
    }
  };
  tools.insertBefore(b,tools.firstChild);
  return true;
}
function gviz(){
  return new Promise((resolve,reject)=>{
    const cb='__gbNwoPhotoFix'+Date.now()+Math.random().toString(36).slice(2);
    const s=document.createElement('script');
    let done=false;
    const finish=(fn,v)=>{if(done)return;done=true;clearTimeout(timer);try{delete window[cb]}catch{}s.remove();fn(v)};
    window[cb]=resp=>finish(resolve,resp||{});
    const timer=setTimeout(()=>finish(reject,new Error('photo sheet timeout')),18000);
    s.onerror=()=>finish(reject,new Error('photo sheet load failed'));
    s.src='https://docs.google.com/spreadsheets/d/'+SHEET_ID+'/gviz/tq?sheet='+encodeURIComponent(SHEET)+'&headers=1&tqx='+encodeURIComponent('out:json;responseHandler:'+cb)+'&tq='+encodeURIComponent('select A,AE where A is not null')+'&_='+Date.now();
    document.head.appendChild(s);
  });
}
async function load(){
  try{
    const r=await gviz();
    const rows=r&&r.table&&Array.isArray(r.table.rows)?r.table.rows:[];
    let n=0;
    for(const row of rows){
      const c=row.c||[],sku=norm(raw(c[0])),url=raw(c[1]);
      if(sku&&/^https?:\/\//i.test(url)){map[sku]=url;n++}
    }
    window.GB_PHOTOS=Object.assign({},window.GB_PHOTOS||{},map);
    console.log('New Orders photos from Sheets AE:',n);
    apply();
  }catch(e){console.warn('New Orders photo fix:',e);apply()}
}

window.addEventListener('gb:photos-updated',()=>{Object.assign(map,window.GB_PHOTOS||{});apply()});
const mo=new MutationObserver(()=>{ensureRefreshButton();apply()});
function start(){
  const root=document.getElementById('gbNewOrders');
  if(root){mo.observe(root,{childList:true,subtree:true});ensureRefreshButton();apply()}else setTimeout(start,300);
}
start();
load();
setInterval(()=>{if(document.visibilityState==='visible'){ensureRefreshButton();apply()}},2500);
})();
