(()=>{
  'use strict';
  if(window.GB_PRICE_PHOTO_REFRESH_LOADED)return;
  window.GB_PRICE_PHOTO_REFRESH_LOADED=true;
  const RAW='https://raw.githubusercontent.com/diasirga07-max/marketplace-manager/main/public/';
  let mapPromise=null,timer=null;
  const norm=v=>String(v||'').trim().toUpperCase();
  async function loadFreshMap(){
    if(mapPromise)return mapPromise;
    mapPromise=(async()=>{
      const parts=await Promise.all(Array.from({length:8},(_,i)=>fetch(RAW+'gb-photo-map-'+i+'.pack?v=price-map-5803-20260906b',{cache:'no-store'}).then(r=>{if(!r.ok)throw new Error('photo map '+r.status);return r.text()})));
      const packed=parts.join('').replace(/\s+/g,'');
      const bytes=Uint8Array.from(atob(packed),c=>c.charCodeAt(0));
      const text=await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
      const fresh=JSON.parse(text)||{};
      window.GB_PHOTOS=Object.assign({},window.GB_PHOTOS||{},fresh);
      window.GB_PRICE_PHOTO_COUNT=Object.keys(fresh).length;
      return fresh;
    })().catch(e=>{console.error('Fresh Kaspi price photo map failed',e);return window.GB_PHOTOS||{}});
    return mapPromise;
  }
  async function apply(){
    const grid=document.getElementById('gbpeGrid');if(!grid)return;
    const map=await loadFreshMap();
    grid.querySelectorAll('tbody tr').forEach(tr=>{
      const cell=tr.querySelector('.gbpe-cell[data-c="25"]');
      const skuEl=tr.querySelector('.gbpe-cell[data-c="0"]');
      if(!cell||!skuEl)return;
      const sku=norm(skuEl.textContent),url=map[sku]||((window.GB_PHOTOS||{})[sku]);
      if(!url)return;
      if(cell.dataset.gbpeFreshPhoto===url&&cell.querySelector('img.gbpe-photo'))return;
      cell.dataset.gbpeFreshPhoto=url;
      cell.dataset.gbpePhotoFailed='';
      cell.innerHTML='';
      const img=document.createElement('img');
      img.className='gbpe-photo';img.loading='lazy';img.referrerPolicy='no-referrer';img.alt=sku;
      img.onerror=()=>{const d=document.createElement('div');d.className='gbpe-photoempty';d.textContent='Нет фото';img.replaceWith(d)};
      img.src=url;cell.appendChild(img);
    });
  }
  function watch(){
    const grid=document.getElementById('gbpeGrid');if(!grid)return false;
    new MutationObserver(()=>{clearTimeout(timer);timer=setTimeout(apply,40)}).observe(grid,{childList:true,subtree:true});
    apply();return true;
  }
  let tries=0;const t=setInterval(()=>{tries++;if(watch()||tries>160)clearInterval(t)},250);
  document.addEventListener('click',e=>{if(e.target&&e.target.closest&&e.target.closest('#gbPriceNav'))setTimeout(apply,100)},true);
})();