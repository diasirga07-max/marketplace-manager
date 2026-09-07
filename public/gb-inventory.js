(()=>{
'use strict';
if(window.GB_WAREHOUSE_LOADED)return;window.GB_WAREHOUSE_LOADED=true;
const SID='1dLU5KOi3WBLy3uNEiqGv5rf9ka0OwcEw_RjhDQW3H1E';
const OLD_SID='1qNILk0sLSVExmeIG3_ER8oeBMibSK4NtmXrG8BNpCiM';
const SK='gbWhStock1',DK='gbWhDocs1',HK='gbWhHist1',SEED='gbWhSeed1';
let cat=null,req=0;
const $=s=>document.querySelector(s),norm=s=>String(s||'').trim().toUpperCase(),esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])),nf=n=>new Intl.NumberFormat('ru-RU').format(Number(n)||0),now=()=>new Date().toISOString(),fmt=v=>v?new Date(v).toLocaleString('ru-RU',{timeZone:'Asia/Almaty'}):'—';
const load=(k,d)=>{try{return JSON.parse(localStorage.getItem(k)||'')||d}catch{return d}},save=(k,v)=>localStorage.setItem(k,JSON.stringify(v));
function stock(){return load(SK,{})}
function docs(){return load(DK,{})}
function hist(){return load(HK,[])}
function jsonp(sid,sheet,tq){return new Promise((ok,no)=>{const cb='__wh'+Date.now()+'_'+(++req),s=document.createElement('script'),tm=setTimeout(()=>{delete window[cb];s.remove();no(Error('Таймаут Google Sheets'))},25000);window[cb]=r=>{clearTimeout(tm);delete window[cb];s.remove();ok(r)};s.onerror=()=>{clearTimeout(tm);delete window[cb];s.remove();no(Error('Не удалось загрузить '+sheet))};s.src='https://docs.google.com/spreadsheets/d/'+sid+'/gviz/tq?sheet='+encodeURIComponent(sheet)+'&headers=1&tqx='+encodeURIComponent('out:json;responseHandler:'+cb)+'&tq='+encodeURIComponent(tq)+'&_='+Date.now();document.head.appendChild(s)})}
const rows=r=>r?.table?.rows?.map(x=>(x.c||[]).map(c=>c?.v==null?'':String(c.v).trim()))||[];
function globalPhoto(sku){return String((window.GB_PHOTOS||{})[norm(sku)]||'').trim()}
async function catalog(){
  if(cat)return cat;
  const m=new Map();
  const [cur,old]=await Promise.allSettled([
    jsonp(SID,'Прайс KASPI','select A,B,AD where A is not null'),
    jsonp(OLD_SID,'Прайс KASPI','select A,B,AD where A is not null')
  ]);
  if(cur.status==='fulfilled')for(const x of rows(cur.value)){
    const sku=norm(x[0]);if(!sku)continue;
    m.set(sku,{sku,name:String(x[1]||sku).trim(),photo:String(x[2]||'').trim()});
  }
  if(old.status==='fulfilled')for(const x of rows(old.value)){
    const sku=norm(x[0]);if(!sku)continue;
    const z=m.get(sku)||{sku,name:'',photo:''};
    if(!z.name)z.name=String(x[1]||sku).trim();
    if(!z.photo)z.photo=String(x[2]||'').trim();
    m.set(sku,z);
  }
  for(const [sku,z] of m){if(!z.photo)z.photo=globalPhoto(sku);if(!z.name)z.name=sku}
  cat=m;
  return m;
}
function photo(sku){const k=norm(sku),c=cat?.get(k);return String(c?.photo||globalPhoto(k)||'').trim()}
function addHistory(label,units){const h=hist();h.unshift({label,units,at:now()});h.splice(50);save(HK,h)}
function docKey(v){return String(v||'').trim().toUpperCase().replace(/-R-1$/,'').replace(/-1$/,'')}
function repairStock(){
  const st=stock(),out={};let changed=false;
  for(const [key,val] of Object.entries(st)){
    const sku=norm(val?.sku||key);if(!sku)continue;
    const c=cat?.get(sku)||{},z=out[sku]||{sku,name:'',photo:'',quantity:0,lastAt:''};
    z.quantity+=(+val.quantity||0);
    z.lastAt=[z.lastAt,val.lastAt].filter(Boolean).sort().at(-1)||'';
    z.name=String(c.name||val.name||z.name||sku).trim();
    z.photo=String(c.photo||globalPhoto(sku)||val.photo||z.photo||'').trim();
    out[sku]=z;
    if(sku!==key||z.name!==val.name||z.photo!==val.photo)changed=true;
  }
  if(changed||Object.keys(out).length!==Object.keys(st).length)save(SK,out);
  return out;
}
function addItems(items,label){
  const g=new Map;
  for(const x of items||[]){
    const sku=norm(x.sku||x.article||x.vendorCode||x.code);if(!sku)continue;
    const q=Math.max(1,+x.quantity||+x.qty||1),z=g.get(sku)||{sku,quantity:0,name:'',photo:''};
    z.quantity+=q;z.name=String(x.name||z.name||'').trim();z.photo=String(x.photo||z.photo||'').trim();g.set(sku,z);
  }
  const st=repairStock();let units=0;
  for(const x of g.values()){
    const c=cat?.get(x.sku)||{},z=st[x.sku]||{sku:x.sku,name:'',photo:'',quantity:0,lastAt:''};
    z.quantity=(+z.quantity||0)+x.quantity;
    z.name=String(c.name||x.name||z.name||x.sku).trim();
    z.photo=String(c.photo||globalPhoto(x.sku)||x.photo||z.photo||'').trim();
    z.lastAt=now();st[x.sku]=z;units+=x.quantity;
  }
  save(SK,st);addHistory(label,units);render();return units;
}
async function seed(){
  if(localStorage.getItem(SEED)==='1')return;
  try{
    await catalog();
    const r=await jsonp(SID,'мой склад','select A where A is not null'),st=repairStock();let n=0;
    for(const x of rows(r)){
      const sku=norm(x[0]);if(!sku||/АРТИКУЛ|SKU/i.test(sku))continue;
      const c=cat.get(sku)||{},z=st[sku]||{sku,name:c.name||sku,photo:c.photo||globalPhoto(sku),quantity:0,lastAt:''};
      z.quantity=(+z.quantity||0)+1;z.name=c.name||z.name||sku;z.photo=c.photo||globalPhoto(sku)||z.photo||'';z.lastAt=now();st[sku]=z;n++;
    }
    if(n){save(SK,st);addHistory('Импорт старого листа «мой склад»',n)}
  }catch(e){console.warn(e)}finally{localStorage.setItem(SEED,'1')}
}
function css(){
  if($('#gbWhCss'))return;
  const s=document.createElement('style');s.id='gbWhCss';s.textContent=`#gbWh{position:fixed;inset:58px 0 0;z-index:2147483300;background:#f5f7fa;display:none;overflow:auto;font-family:Inter,Arial,sans-serif;color:#101828}#gbWh *{box-sizing:border-box}.whh{position:sticky;top:0;z-index:20;background:#fff;border-bottom:1px solid #e4e7ec;padding:13px 18px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}.wht{font-size:25px;font-weight:900;margin-right:auto}.whbtn{border:1px solid #d0d5dd;background:#fff;border-radius:11px;padding:9px 12px;font-weight:800;cursor:pointer;color:#101828}.whbtn.dark{background:#111;color:#fff;border-color:#111}.whbody{padding:16px;max-width:1600px;margin:auto}.whscanbox{background:#111;border-radius:18px;padding:16px;margin-bottom:14px}.whscanrow{display:grid;grid-template-columns:1fr 120px;gap:9px}.whscan{border:0;border-radius:12px;padding:15px;font-size:21px;font-weight:850;outline:none}.whadd{border:0;border-radius:12px;background:#fff;font-weight:900;cursor:pointer}.whhelp{color:#d0d5dd;font-size:12px;margin-top:8px}.whmsg{display:none;margin-top:9px;padding:9px 11px;border-radius:10px;font-weight:800}.whmsg.ok{display:block;background:#ecfdf3;color:#027a48}.whmsg.warn{display:block;background:#fffaeb;color:#b54708}.whmsg.err{display:block;background:#fef3f2;color:#b42318}.whkpis{display:grid;grid-template-columns:repeat(4,1fr);gap:11px;margin-bottom:12px}.whk{background:#fff;border:1px solid #e4e7ec;border-radius:15px;padding:12px}.whkl{font-size:11px;color:#667085;font-weight:850;text-transform:uppercase}.whkv{font-size:25px;font-weight:900;margin-top:5px}.whtools{display:flex;gap:8px;margin-bottom:9px;flex-wrap:wrap}.whsearch{flex:1;min-width:240px;border:1px solid #d0d5dd;border-radius:10px;padding:10px}.whtablebox{background:#fff;border:1px solid #e4e7ec;border-radius:17px;overflow:auto}.whtable{width:100%;border-collapse:collapse;min-width:820px}.whtable th{position:sticky;top:0;background:#f9fafb;padding:9px;text-align:left;color:#667085;font-size:11px;text-transform:uppercase}.whtable td{padding:9px;border-top:1px solid #f2f4f7}.whpic{width:76px;height:76px;object-fit:contain;background:#fff;border:1px solid #e4e7ec;border-radius:10px}.whnop{width:76px;height:76px;background:#f2f4f7;border:1px solid #e4e7ec;border-radius:10px;display:flex;align-items:center;justify-content:center;color:#98a2b3;font-size:9px}.whname{font-weight:850}.whsku{font-family:ui-monospace,monospace;font-weight:800}.whqty{font-size:22px;font-weight:900}.whstep{display:flex;gap:6px;align-items:center}.whmini{height:32px;min-width:34px;border:1px solid #d0d5dd;background:#fff;border-radius:8px;font-weight:900;cursor:pointer}.whhist{margin-top:13px;background:#fff;border:1px solid #e4e7ec;border-radius:16px;padding:13px}.whhist h3{margin:0 0 8px}.whhr{display:grid;grid-template-columns:180px 1fr auto;gap:8px;padding:7px 0;border-top:1px solid #f2f4f7;font-size:12px}.whfoot{margin-top:9px;font-size:11px;color:#667085}@media(max-width:850px){.whkpis{grid-template-columns:repeat(2,1fr)}.whscanrow{grid-template-columns:1fr 90px}.whscan{font-size:17px}.wht{font-size:21px}}`;document.head.appendChild(s);
}
function nav(){if($('#gbWhNav'))return true;const e=[...document.querySelectorAll('button,a')],ref=e.find(x=>/Динамика продаж/i.test(x.textContent||''))||e.find(x=>/Прайс Kaspi/i.test(x.textContent||''))||e.find(x=>/Настройки/i.test(x.textContent||''));if(!ref?.parentElement)return false;const b=document.createElement('button');b.id='gbWhNav';b.className=ref.className;b.textContent='📦 Мой склад';b.onclick=open;ref.parentElement.insertBefore(b,ref);return true}
function build(){
  css();let o=$('#gbWh');if(o)return o;
  o=document.createElement('section');o.id='gbWh';o.innerHTML=`<div class="whh"><div><div class="wht">Мой склад</div><div style="font-size:12px;color:#667085">Сканирование поступлений и автоматическое объединение одинаковых товаров</div></div><a class="whbtn" target="_blank" href="https://docs.google.com/spreadsheets/d/${SID}/edit#gid=137402850">Google Sheet ↗</a><button id="whcsv" class="whbtn">↓ CSV</button><button id="whclose" class="whbtn dark">Закрыть</button></div><div class="whbody"><div class="whscanbox"><div class="whscanrow"><input id="whscan" class="whscan" placeholder="Штрихкод товара или номер накладной" autocomplete="off"><button id="whdo" class="whadd">Добавить</button></div><div class="whhelp">Штрихкод товара = +1 шт. · накладная = все товары и количества · одинаковые товары суммируются · повторное сканирование добавляет количество ещё раз</div><div id="whmsg" class="whmsg"></div></div><div class="whkpis"><div class="whk"><div class="whkl">Всего единиц</div><div id="whunits" class="whkv">0</div></div><div class="whk"><div class="whkl">Позиций SKU</div><div id="whpos" class="whkv">0</div></div><div class="whk"><div class="whkl">Накладных (уник.)</div><div id="whdocs" class="whkv">0</div></div><div class="whk"><div class="whkl">Последнее поступление</div><div id="whlast" class="whkv" style="font-size:16px">—</div></div></div><div class="whtools"><input id="whq" class="whsearch" placeholder="Поиск по названию или артикулу"><button id="whsort" class="whbtn">Количество ↓</button></div><div class="whtablebox"><table class="whtable"><thead><tr><th>Фото</th><th>Товар</th><th>Артикул</th><th>Количество</th><th>Последнее поступление</th><th>Изменить</th></tr></thead><tbody id="whrows"></tbody></table></div><div class="whhist"><h3>Последние поступления</h3><div id="whhist"></div></div><div class="whfoot">Название берётся из «Прайс KASPI» (колонка B). Фото: текущий прайс → общая карта → историческая база. Повторный штрихкод и повторная накладная увеличивают количество, одинаковые SKU остаются в одной строке.</div></div>`;
  document.body.appendChild(o);
  $('#whclose').onclick=close;$('#whdo').onclick=scan;$('#whscan').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();scan()}};$('#whq').oninput=render;$('#whsort').onclick=()=>{o.dataset.sort=o.dataset.sort==='qty'?'sku':'qty';render()};$('#whcsv').onclick=csv;return o;
}
function msg(t,c='ok'){const m=$('#whmsg');m.className='whmsg '+c;m.textContent=t}
function focus(){setTimeout(()=>$('#whscan')?.focus(),30)}
async function scan(){
  const i=$('#whscan'),raw=String(i.value||'').trim();if(!raw)return;
  i.value='';msg('Распознаю…','warn');
  try{
    await catalog();
    const sku=norm(raw);
    if(cat.has(sku)){
      const p=cat.get(sku),n=addItems([{...p,quantity:1}],'Товар '+sku);
      msg('✓ '+p.name+' · +'+n+' шт. · новое количество: '+nf(stock()[sku]?.quantity||0));focus();return;
    }
    if(typeof api!=='function')throw Error('Kaspi API недоступен');
    const d=await api('scan',{method:'POST',body:{scan:raw},timeout:18000});
    if(!d?.order||!d.items?.length)throw Error('Товар или накладная не найдены');
    const code=docKey(d.order.code||raw),ds=docs(),prev=ds[code]||null;
    const n=addItems(d.items,'Накладная '+code+(prev?' · повтор '+((+prev.scans||1)+1):''));
    const scans=(+prev?.scans||0)+1;
    ds[code]={at:prev?.at||now(),lastAt:now(),units:(+prev?.units||0)+n,lastUnits:n,scans};
    save(DK,ds);
    msg(prev?('✓ Накладная '+code+' отсканирована повторно ×'+scans+': ещё +'+nf(n)+' шт. Количество товаров увеличено.'):('✓ Накладная '+code+': добавлено '+nf(n)+' шт., одинаковые товары объединены'));
    render();focus();
  }catch(e){msg('Ошибка: '+(e.message||e),'err');focus()}
}
function change(sku,d){const st=repairStock(),x=st[sku];if(!x)return;x.quantity=Math.max(0,(+x.quantity||0)+d);x.lastAt=now();save(SK,st);addHistory('Ручное '+(d>0?'+1':'−1')+' · '+sku,d);render()}
function render(){
  const st=repairStock(),ds=docs(),h=hist(),q=String($('#whq')?.value||'').toLowerCase();let a=Object.values(st);
  if(q)a=a.filter(x=>(x.sku+' '+x.name).toLowerCase().includes(q));
  if($('#gbWh')?.dataset.sort==='qty')a.sort((x,y)=>(+y.quantity||0)-(+x.quantity||0));else a.sort((x,y)=>String(x.sku).localeCompare(String(y.sku),'ru',{numeric:true}));
  const all=Object.values(st),units=all.reduce((s,x)=>s+(+x.quantity||0),0),last=all.map(x=>x.lastAt).filter(Boolean).sort().at(-1);
  $('#whunits').textContent=nf(units);$('#whpos').textContent=nf(all.filter(x=>(+x.quantity||0)>0).length);$('#whdocs').textContent=nf(Object.keys(ds).length);$('#whlast').textContent=fmt(last);
  const b=$('#whrows');
  b.innerHTML=a.length?a.map(x=>{const c=cat?.get(x.sku)||{},p=String(c.photo||globalPhoto(x.sku)||x.photo||'').trim(),name=String(c.name||x.name||x.sku).trim();return `<tr><td>${p?`<img class="whpic" src="${esc(p)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="whnop" style="display:none">Нет фото</div>`:'<div class="whnop">Нет фото</div>'}</td><td class="whname">${esc(name)}</td><td class="whsku">${esc(x.sku)}</td><td><span class="whqty">${nf(x.quantity)}</span></td><td>${esc(fmt(x.lastAt))}</td><td><div class="whstep"><button class="whmini" data-m="${esc(x.sku)}">−</button><button class="whmini" data-p="${esc(x.sku)}">+</button></div></td></tr>`}).join(''):'<tr><td colspan="6" style="padding:45px;text-align:center;color:#667085">Склад пуст. Отсканируйте товар или накладную.</td></tr>';
  b.querySelectorAll('[data-p]').forEach(x=>x.onclick=()=>change(x.dataset.p,1));b.querySelectorAll('[data-m]').forEach(x=>x.onclick=()=>change(x.dataset.m,-1));
  $('#whhist').innerHTML=h.length?h.slice(0,12).map(x=>`<div class="whhr"><span>${esc(fmt(x.at))}</span><b>${esc(x.label)}</b><span>${x.units>0?'+':''}${nf(x.units)} шт.</span></div>`).join(''):'<span style="color:#667085;font-size:12px">История пока пустая</span>';
}
function csv(){
  const a=Object.values(repairStock()),q=v=>'"'+String(v??'').replace(/"/g,'""')+'"';
  let s='Артикул;Название;Фото;Количество;Последнее поступление\n'+a.map(x=>[x.sku,x.name,x.photo||photo(x.sku),x.quantity,fmt(x.lastAt)].map(q).join(';')).join('\n'),b=new Blob(['\ufeff'+s],{type:'text/csv;charset=utf-8'}),u=URL.createObjectURL(b),l=document.createElement('a');l.href=u;l.download='Мой_склад_'+new Date().toISOString().slice(0,10)+'.csv';l.click();setTimeout(()=>URL.revokeObjectURL(u),500);
}
async function open(){const o=build();o.style.display='block';document.body.style.overflow='hidden';msg('Загружаю названия и фотографии…','warn');try{await catalog();repairStock();await seed();repairStock();msg('Готово. Повторное сканирование увеличивает количество.')}catch(e){msg('Ошибка загрузки каталога: '+(e.message||e),'err')}render();if(window.GB_PHOTO_READY&&typeof window.GB_PHOTO_READY.then==='function')window.GB_PHOTO_READY.then(()=>{repairStock();render()}).catch(()=>{});focus()}
function close(){const o=$('#gbWh');if(o)o.style.display='none';document.body.style.overflow=''}
let tries=0,t=setInterval(()=>{if(nav()||++tries>40)clearInterval(t)},250);window.addEventListener('keydown',e=>{if(e.key==='Escape'&&$('#gbWh')?.style.display==='block')close()});
})();