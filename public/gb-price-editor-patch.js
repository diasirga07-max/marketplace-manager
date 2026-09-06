(()=>{
  'use strict';
  if(window.GB_PRICE_EDITOR_PATCH_LOADED)return;
  window.GB_PRICE_EDITOR_PATCH_LOADED=true;

  const REPO_RAW='https://raw.githubusercontent.com/diasirga07-max/marketplace-manager/main/public/';
  const HIDDEN_KEY='gb_kaspi_price_hidden_columns_v1';
  const HEADERS=['Артикул WB','название','Цена оптовая','СПП / итоговая цена, ₸','Название товара','Продавец','Остаток','Дата обновления','маржа','Цена без доставки (₸) [расчет]','Доставка базовая KZ (₸) [расчет]','Доставка итог KZ (₸) [расчет]','Цена Kaspi (₸) [расчет]','Цена Kaspi округл. до 10 (₸)','Моя чистая прибыль (₸) [расчет]','Количество','Дни доставки','Ссылка товара КASPI','Категория','ВБ ссылка','Цена WB с наценкой','Продавец WB','Дней доставки','Дата доставки','Статус обновления','ФОТОГРАФИЯ ТОВАРОВ','Дни предзаказа база','Низкая цена Kaspi (₸)','Место GRANTS BOOK по цене','_PHOTO_URL_FOR_PRINT'];
  const LETTERS=Array.from({length:30},(_,i)=>{let n=i+1,s='';while(n){n--;s=String.fromCharCode(65+n%26)+s;n=Math.floor(n/26)}return s});
  let hidden=loadHidden();
  let photoPromise=null;
  let observer=null;

  function loadHidden(){
    try{
      const a=JSON.parse(localStorage.getItem(HIDDEN_KEY)||'[]');
      return new Set(Array.isArray(a)?a.map(Number).filter(n=>n>=0&&n<30):[]);
    }catch(_){return new Set()}
  }
  function saveHidden(){try{localStorage.setItem(HIDDEN_KEY,JSON.stringify([...hidden].sort((a,b)=>a-b)))}catch(_){}}
  function normSku(v){return String(v||'').trim().toUpperCase()}

  async function ensurePhotoMap(){
    const current=window.GB_PHOTOS;
    if(current&&typeof current==='object'&&Object.keys(current).length>1000)return current;
    if(photoPromise)return photoPromise;
    photoPromise=(async()=>{
      try{
        const parts=await Promise.all(Array.from({length:8},(_,i)=>fetch(REPO_RAW+'gb-photo-map-'+i+'.pack?v=price-photo-20260906',{cache:'no-store'}).then(r=>{if(!r.ok)throw new Error('photo map '+r.status);return r.text()})));
        const packed=parts.join('').replace(/\s+/g,'');
        const bytes=Uint8Array.from(atob(packed),c=>c.charCodeAt(0));
        const text=await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
        const map=JSON.parse(text);
        window.GB_PHOTOS=Object.assign({},window.GB_PHOTOS||{},map||{});
        return window.GB_PHOTOS;
      }catch(e){console.error('Price editor photo map load failed',e);return window.GB_PHOTOS||{}}
    })();
    return photoPromise;
  }

  function photoUrlForRow(tr,map){
    const skuEl=tr.querySelector('.gbpe-cell[data-c="0"]');
    const sku=normSku(skuEl&&skuEl.textContent);
    if(sku&&map&&map[sku])return String(map[sku]);
    const ad=tr.querySelector('.gbpe-cell[data-c="29"]');
    if(ad){
      const a=ad.querySelector('a[href]');
      const u=(a&&a.href)||ad.textContent.trim();
      if(/^https:\/\//i.test(u))return u;
    }
    return '';
  }

  async function repairPhotos(){
    const grid=document.getElementById('gbpeGrid');
    if(!grid)return;
    const map=await ensurePhotoMap();
    grid.querySelectorAll('tbody tr').forEach(tr=>{
      const cell=tr.querySelector('.gbpe-cell[data-c="25"]');
      if(!cell)return;
      const url=photoUrlForRow(tr,map);
      if(!url)return;
      let img=cell.querySelector('img.gbpe-photo');
      if(!img){
        cell.innerHTML='';
        img=document.createElement('img');
        img.className='gbpe-photo';
        img.loading='lazy';
        img.referrerPolicy='no-referrer';
        cell.appendChild(img);
      }
      if(img.src!==url)img.src=url;
      img.onerror=()=>{
        const empty=document.createElement('div');
        empty.className='gbpe-photoempty';
        empty.textContent='Нет фото';
        img.replaceWith(empty);
      };
    });
  }

  function ensurePatchStyle(){
    if(document.getElementById('gbpePatchStyle'))return;
    const st=document.createElement('style');
    st.id='gbpePatchStyle';
    st.textContent=`
#gbPriceOverlay .gbpe-grid{min-width:max-content!important}
#gbpeColumnsPanel{position:absolute;right:18px;top:62px;z-index:2147483646;width:390px;max-height:min(620px,calc(100vh - 150px));overflow:auto;background:#fff;border:1px solid #d0d5dd;border-radius:14px;box-shadow:0 18px 50px rgba(16,24,40,.22);padding:12px;display:none}
#gbpeColumnsPanel.open{display:block}
.gbpe-coltop{display:flex;align-items:center;gap:8px;padding:2px 2px 10px;position:sticky;top:0;background:#fff;z-index:2;border-bottom:1px solid #eaecf0}
.gbpe-coltitle{font-weight:850;font-size:14px;margin-right:auto}.gbpe-colactions{display:flex;gap:6px}.gbpe-colactions button{border:1px solid #d0d5dd;background:#fff;border-radius:8px;padding:6px 8px;font-weight:700;cursor:pointer;font-size:11px}
.gbpe-collist{display:grid;grid-template-columns:1fr;gap:2px;padding-top:8px}.gbpe-colitem{display:flex;gap:9px;align-items:flex-start;padding:7px 6px;border-radius:8px;cursor:pointer}.gbpe-colitem:hover{background:#f2f4f7}.gbpe-colitem input{margin-top:2px}.gbpe-colletter{min-width:28px;color:#667085;font-size:11px;font-weight:800}.gbpe-colname{font-size:12px;line-height:1.25;color:#101828}.gbpe-hidden-count{margin-left:6px;background:#fff3e0;color:#b54708;border-radius:999px;padding:2px 6px;font-size:10px;font-weight:800}
@media(max-width:700px){#gbpeColumnsPanel{left:10px;right:10px;width:auto;top:105px}}
`;
    document.head.appendChild(st);
  }

  function applyHiddenColumns(){
    const grid=document.getElementById('gbpeGrid');
    if(!grid)return;
    grid.querySelectorAll('table.gbpe-grid').forEach(table=>{
      table.querySelectorAll('tr').forEach(tr=>{
        [...tr.children].forEach((el,idx)=>{
          if(idx===0)return;
          const c=idx-1;
          el.style.display=hidden.has(c)?'none':'';
        });
      });
    });
    const btn=document.getElementById('gbpeColumnsBtn');
    if(btn){
      const n=hidden.size;
      btn.innerHTML='☷ Колонки'+(n?'<span class="gbpe-hidden-count">скрыто '+n+'</span>':'');
    }
  }

  function renderColumnList(){
    const list=document.getElementById('gbpeColumnList');if(!list)return;
    list.innerHTML=HEADERS.map((h,c)=>'<label class="gbpe-colitem"><input type="checkbox" data-c="'+c+'" '+(hidden.has(c)?'':'checked')+'><span class="gbpe-colletter">'+LETTERS[c]+'</span><span class="gbpe-colname">'+String(h).replace(/&/g,'&amp;').replace(/</g,'&lt;')+'</span></label>').join('');
    list.querySelectorAll('input[data-c]').forEach(cb=>cb.addEventListener('change',()=>{
      const c=Number(cb.dataset.c);
      if(cb.checked)hidden.delete(c);else hidden.add(c);
      saveHidden();applyHiddenColumns();
    }));
  }

  function ensureColumnControls(){
    const overlay=document.getElementById('gbPriceOverlay');
    if(!overlay)return false;
    ensurePatchStyle();
    let toolbar=overlay.querySelector('.gbpe-toolbar');
    if(!toolbar)return false;
    let btn=document.getElementById('gbpeColumnsBtn');
    if(!btn){
      btn=document.createElement('button');
      btn.id='gbpeColumnsBtn';
      btn.className='gbpe-btn';
      btn.type='button';
      btn.textContent='☷ Колонки';
      const spacer=[...toolbar.children].find(x=>x.tagName==='SPAN'&&x.style&&x.style.flex==='1');
      toolbar.insertBefore(btn,spacer||toolbar.lastChild);
      btn.addEventListener('click',e=>{e.stopPropagation();const p=document.getElementById('gbpeColumnsPanel');if(p)p.classList.toggle('open')});
    }
    let panel=document.getElementById('gbpeColumnsPanel');
    if(!panel){
      panel=document.createElement('div');
      panel.id='gbpeColumnsPanel';
      panel.innerHTML='<div class="gbpe-coltop"><div class="gbpe-coltitle">Показать / скрыть колонки</div><div class="gbpe-colactions"><button id="gbpeColsMain">Основные</button><button id="gbpeColsAll">Все</button></div></div><div id="gbpeColumnList" class="gbpe-collist"></div>';
      overlay.appendChild(panel);
      panel.addEventListener('click',e=>e.stopPropagation());
      document.getElementById('gbpeColsAll').onclick=()=>{hidden.clear();saveHidden();renderColumnList();applyHiddenColumns()};
      document.getElementById('gbpeColsMain').onclick=()=>{
        const keep=new Set([0,1,2,4,6,8,12,13,14,15,16,17,25,26,27,28]);
        hidden=new Set(Array.from({length:30},(_,i)=>i).filter(i=>!keep.has(i)));
        saveHidden();renderColumnList();applyHiddenColumns();
      };
      renderColumnList();
      document.addEventListener('click',()=>panel.classList.remove('open'));
    }
    applyHiddenColumns();
    return true;
  }

  function afterGridChange(){
    ensureColumnControls();
    applyHiddenColumns();
    repairPhotos();
  }

  function watch(){
    const overlay=document.getElementById('gbPriceOverlay');
    if(!overlay)return false;
    ensureColumnControls();
    const grid=document.getElementById('gbpeGrid');
    if(grid&&!observer){
      observer=new MutationObserver(()=>{clearTimeout(window.__gbpePatchTimer);window.__gbpePatchTimer=setTimeout(afterGridChange,30)});
      observer.observe(grid,{childList:true,subtree:true});
    }
    afterGridChange();
    return true;
  }

  let tries=0;
  const timer=setInterval(()=>{tries++;if(watch()||tries>120)clearInterval(timer)},250);
  document.addEventListener('click',e=>{
    if(e.target&&e.target.closest&&e.target.closest('#gbPriceNav'))setTimeout(watch,50);
  },true);
})();