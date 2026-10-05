(()=>{
  'use strict';
  if (window.GB_WB_LINK_COLUMN_LOADED) return;
  window.GB_WB_LINK_COLUMN_LOADED = true;

  const STYLE_ID='gbWbLinkColumnStyle';
  if(!document.getElementById(STYLE_ID)){
    const s=document.createElement('style');
    s.id=STYLE_ID;
    s.textContent=`
      #orderHead .gb-wb-link-head{white-space:nowrap}
      #ot .gb-wb-link-cell{white-space:nowrap;vertical-align:middle}
      #ot .gb-wb-open{
        display:inline-flex;align-items:center;gap:5px;
        padding:6px 9px;border:1px solid #d9dee8;border-radius:8px;
        background:#fff;color:#344054;text-decoration:none;
        font:700 11px/1 Arial,sans-serif;box-shadow:0 1px 2px rgba(16,24,40,.05);
        cursor:pointer;position:relative;z-index:5;pointer-events:auto
      }
      #ot .gb-wb-open:hover{background:#f5f7fb;border-color:#b9c2d0}
      #ot .gb-wb-missing{font:700 11px/1 Arial,sans-serif;color:#98a2b3}
    `;
    document.head.appendChild(s);
  }

  const norm=v=>String(v||'').trim().toUpperCase();
  let liveMap=new Map();
  let liveMapPromise=null;

  function loadLiveMap(force=false){
    if(liveMapPromise&&!force)return liveMapPromise;
    liveMapPromise=(async()=>{
      try{
        const r=await fetch('/api/wb-links?_='+Date.now(),{cache:'no-store'});
        const j=await r.json().catch(()=>null);
        if(!r.ok||!j||!j.ok||!j.links||typeof j.links!=='object'){
          throw new Error(j?.error||('HTTP '+r.status));
        }
        const map=new Map();
        for(const [sku,url] of Object.entries(j.links)){
          const key=norm(sku);
          const link=String(url||'').trim();
          if(key&&/^https?:\/\//i.test(link))map.set(key,link);
        }
        liveMap=map;
        requestAnimationFrame(()=>ensure());
        return map;
      }catch(e){
        console.warn('WB link API load failed',e);
        return liveMap;
      }
    })();
    return liveMapPromise;
  }

  function skuMap(){
    const map=new Map(liveMap);
    try{
      if(typeof grouped==='function'){
        const rows=grouped();
        for(const x of (Array.isArray(rows)?rows:[])){
          const sku=norm(x?.sku);
          const url=String(x?.wbUrl||'').trim();
          if(sku&&/^https?:\/\//i.test(url)&&!map.has(sku))map.set(sku,url);
        }
      }
    }catch(e){console.warn('WB link map failed',e)}
    return map;
  }

  function renderLinkCell(cell,url){
    const key=String(url||'');
    if(cell.dataset.gbWbUrl===key)return;
    cell.dataset.gbWbUrl=key;
    cell.textContent='';

    if(url){
      const a=document.createElement('a');
      a.className='gb-wb-open';
      a.href=url;
      a.target='_blank';
      a.rel='noopener noreferrer';
      a.textContent='Открыть WB ↗';
      a.addEventListener('click',e=>{
        e.stopPropagation();
      });
      cell.appendChild(a);
    }else{
      const span=document.createElement('span');
      span.className='gb-wb-missing';
      span.textContent='Нет ссылки';
      cell.appendChild(span);
    }
  }

  function cleanSkuFromCell(td){
    if(!td)return'';
    const clone=td.cloneNode(true);
    clone.querySelectorAll('button,a,.muted').forEach(el=>el.remove());
    let text=String(clone.textContent||'').trim();
    text=text.replace(/WB:\s*.*$/i,'').trim();
    text=text.replace(/\s*WB\s*[↗↑]?\s*$/i,'').trim();
    return norm(text);
  }

  function ensure(){
    if(typeof S==='undefined'||S.g!=='WB')return;

    const head=document.getElementById('orderHead');
    const body=document.getElementById('ot');
    if(!head||!body)return;

    const headers=[...head.querySelectorAll('th')];
    const skuIndex=headers.findIndex(th=>String(th.textContent||'').trim().toLowerCase()==='артикул');
    if(skuIndex<0)return;

    let linkIndex=headers.findIndex(th=>String(th.textContent||'').trim().toLowerCase()==='ссылка wb');

    if(linkIndex>=0){
      const linkHead=headers[linkIndex];
      linkHead.classList.add('gb-wb-link-head');
      const skuHead=headers[skuIndex];
      if(linkHead!==skuHead.nextElementSibling)skuHead.after(linkHead);

      const map=skuMap();
      for(const tr of body.querySelectorAll(':scope > tr')){
        const cells=[...tr.querySelectorAll(':scope > td')];
        if(cells.length<=Math.max(skuIndex,linkIndex))continue;
        const linkCell=cells[linkIndex];
        const skuCell=cells[skuIndex];
        linkCell.classList.add('gb-wb-link-cell');
        if(linkCell!==skuCell.nextElementSibling)skuCell.after(linkCell);

        const sku=cleanSkuFromCell(skuCell);
        const url=map.get(sku)||'';
        renderLinkCell(linkCell,url);
      }
      return;
    }

    const th=document.createElement('th');
    th.className='gb-wb-link-head';
    th.dataset.gbWbLinkColumn='1';
    th.textContent='Ссылка WB';
    headers[skuIndex].after(th);

    const map=skuMap();
    for(const tr of body.querySelectorAll(':scope > tr')){
      const cells=[...tr.querySelectorAll(':scope > td')];
      if(cells.length<=skuIndex)continue;
      const skuCell=cells[skuIndex];
      const sku=cleanSkuFromCell(skuCell);
      const td=document.createElement('td');
      td.className='gb-wb-link-cell';
      td.dataset.gbWbLinkColumn='1';

      const url=map.get(sku)||'';
      renderLinkCell(td,url);
      skuCell.after(td);
    }
  }

  let queued=false;
  function schedule(){
    if(queued)return;
    queued=true;
    requestAnimationFrame(()=>{queued=false;ensure()});
  }

  let observersReady=false;

  async function boot(){
    const head=document.getElementById('orderHead');
    const body=document.getElementById('ot');
    if(!head||!body){setTimeout(boot,250);return}

    // Do not render "Нет ссылки" before the A→T map is loaded.
    await loadLiveMap(true);
    ensure();

    if(!observersReady){
      observersReady=true;
      new MutationObserver(schedule).observe(head,{childList:true,subtree:true,characterData:true});
      new MutationObserver(schedule).observe(body,{childList:true,subtree:true});
      document.querySelectorAll('#groups button').forEach(b=>b.addEventListener('click',()=>{
        loadLiveMap(true).finally(()=>setTimeout(ensure,0));
      }));
    }
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>boot(),{once:true});
  else boot();
})();