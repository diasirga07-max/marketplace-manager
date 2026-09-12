(()=>{
'use strict';
if(window.GB_NEW_ORDERS_LOADED)return;
window.GB_NEW_ORDERS_LOADED=true;

const SHEET_ID='1dLU5KOi3WBLy3uNEiqGv5rf9ka0OwcEw_RjhDQW3H1E';
const ORDERS_SHEET='KASPI_ЗАКАЗЫ';
const PRICE_SHEET='Прайс KASPI';
const LIVE_URLS=['/api/data?op=orders','https://grants-book-kaspi-assistant-aex41sn9x-dias10.vercel.app/api/data?op=orders'];
const PHOTO_RAW='https://raw.githubusercontent.com/diasirga07-max/marketplace-manager/main/public/';
const PHOTO_PACK_VERSION='price-map-5803-20260906b';
const $=s=>document.querySelector(s);
const esc=v=>String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const normSku=v=>String(v||'').trim().toUpperCase();
const cleanCode=v=>String(v||'').trim().replace(/-1$/,'');
let rows=[];
let productMap=new Map();
let liveByOrder=new Map();
let photoMap={};
let loading=false;
let filter='all';
let query='';
let autoTimer=null;
let lastUpdated='';

function todayKey(){
  const p=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Almaty',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  const x=Object.fromEntries(p.map(v=>[v.type,v.value]));
  return `${x.year}-${x.month}-${x.day}`;
}
function todayRu(){
  return new Intl.DateTimeFormat('ru-RU',{timeZone:'Asia/Almaty',day:'numeric',month:'long',year:'numeric'}).format(new Date());
}
function cell(c){
  if(!c)return'';
  if(c.f!=null&&String(c.f).trim())return String(c.f).trim();
  if(c.v!=null)return String(c.v).trim();
  return'';
}
function dateParts(raw){
  const s=String(raw||'').trim();
  let m=s.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if(m)return{key:`${m[3]}-${String(+m[2]).padStart(2,'0')}-${String(+m[1]).padStart(2,'0')}`,time:`${String(+(m[4]||0)).padStart(2,'0')}:${String(+(m[5]||0)).padStart(2,'0')}`,sort:+m[3]*1e10+(+m[2])*1e8+(+m[1])*1e6+(+(m[4]||0))*1e4+(+(m[5]||0))*1e2+(+(m[6]||0))};
  m=s.match(/^Date\((\d{4}),(\d{1,2}),(\d{1,2})(?:,(\d{1,2}),(\d{1,2}),(\d{1,2}))?\)$/);
  if(m){const mo=+m[2]+1;return{key:`${m[1]}-${String(mo).padStart(2,'0')}-${String(+m[3]).padStart(2,'0')}`,time:`${String(+(m[4]||0)).padStart(2,'0')}:${String(+(m[5]||0)).padStart(2,'0')}`,sort:+m[1]*1e10+mo*1e8+(+m[3])*1e6+(+(m[4]||0))*1e4+(+(m[5]||0))*1e2+(+(m[6]||0))};}
  return{key:'',time:'',sort:0};
}
function isYes(v){return /^(да|yes|true|1)$/i.test(String(v||'').trim())}
function stageOf(o){
  const status=String(o.status||'').toUpperCase();
  const state=String(o.state||'').toUpperCase();
  const text=String(o.statusText||'').toLowerCase();
  if(/COMPLETED|CANCELLED|CANCELLING|RETURNED|RETURN_REQUESTED/.test(status+' '+state)||/отмен|возврат|заверш/.test(text))return'';
  if(/ASSEMBLE|TRANSFER|TRANSMIT|READY_FOR_DELIVERY/.test(status+' '+state)||/передач/.test(text))return'transfer';
  if(o.preorder&&/ACCEPTED_BY_MERCHANT/.test(status)&&!/упаков|передач/.test(text))return'preorder';
  if(/ACCEPTED_BY_MERCHANT|ARRIVED/.test(status)||/принят|упаков/.test(text))return'packing';
  return'';
}
function stageLabel(s){return s==='preorder'?'Предзаказ':s==='packing'?'Упаковка':s==='transfer'?'Передача':'—'}
function stageClass(s){return s==='preorder'?'pre':s==='packing'?'pack':'trans'}

function gviz(sheet,query){
  return new Promise((resolve,reject)=>{
    const cb='__gbNewOrdersCb'+Date.now()+Math.random().toString(36).slice(2);
    const script=document.createElement('script');
    let done=false;
    const finish=(fn,v)=>{if(done)return;done=true;clearTimeout(timer);try{delete window[cb]}catch{}script.remove();fn(v)};
    window[cb]=resp=>finish(resolve,resp||{});
    const timer=setTimeout(()=>finish(reject,new Error('Google Sheets не ответил')),18000);
    script.onerror=()=>finish(reject,new Error('Не удалось загрузить Google Sheets'));
    script.src='https://docs.google.com/spreadsheets/d/'+SHEET_ID+'/gviz/tq?sheet='+encodeURIComponent(sheet)+'&headers=1&tqx='+encodeURIComponent('out:json;responseHandler:'+cb)+'&tq='+encodeURIComponent(query)+'&_='+Date.now();
    document.head.appendChild(script);
  });
}

async function loadPhotoMap(){
  if(Object.keys(photoMap).length>100)return photoMap;
  try{
    const existing=window.GB_PHOTOS||{};
    if(Object.keys(existing).length>100){photoMap=existing;return photoMap}
    const parts=await Promise.all(Array.from({length:8},(_,i)=>fetch(PHOTO_RAW+'gb-photo-map-'+i+'.pack?v='+PHOTO_PACK_VERSION,{cache:'no-store'}).then(r=>{if(!r.ok)throw Error('photo map '+r.status);return r.text()})));
    const packed=parts.join('').replace(/\s+/g,'');
    const bytes=Uint8Array.from(atob(packed),c=>c.charCodeAt(0));
    const txt=await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    photoMap=JSON.parse(txt)||{};
    window.GB_PHOTOS=Object.assign({},window.GB_PHOTOS||{},photoMap);
  }catch(e){
    console.warn('New orders photo map failed',e);
    photoMap=window.GB_PHOTOS||{};
  }
  return photoMap;
}

async function loadProducts(){
  const resp=await gviz(PRICE_SHEET,'select A,B,T,AE where A is not null');
  const list=resp&&resp.table&&Array.isArray(resp.table.rows)?resp.table.rows:[];
  const map=new Map();
  for(const r of list){
    const c=r.c||[];
    const sku=normSku(cell(c[0]));
    if(!sku)continue;
    const name=cell(c[1]);
    const wbUrl=cell(c[2]);
    const photo=cell(c[3]);
    map.set(sku,{sku,name,wbUrl:/^https?:\/\//i.test(wbUrl)?wbUrl:'',photo:/^https?:\/\//i.test(photo)?photo:''});
  }
  productMap=map;
  return map;
}

async function loadLive(){
  let data=[];
  for(const url of LIVE_URLS){
    try{
      const r=await fetch(url+(url.includes('?')?'&':'?')+'_='+Date.now(),{cache:'no-store'});
      const t=await r.text();let j={};try{j=t?JSON.parse(t):{}}catch{continue}
      if(r.ok&&Array.isArray(j.rows)){data=j.rows;break}
    }catch(e){console.warn('New orders live source failed',url,e)}
  }
  const map=new Map();
  for(const r of data){
    const code=cleanCode(r?.orderCode||r?.code);
    const sku=normSku(r?.sku||r?.article);
    if(!code||!sku)continue;
    const item={sku,qty:Math.max(1,Number(r?.quantity||r?.qty)||1),name:String(r?.name||r?.title||'').trim(),photo:String(r?.photo||r?.photoUrl||r?.image||'').trim(),wbUrl:String(r?.wbUrl||r?.wildberriesUrl||'').trim()};
    if(!map.has(code))map.set(code,[]);
    const a=map.get(code),old=a.find(x=>x.sku===sku);
    if(old){old.qty=Math.max(old.qty,item.qty);if(!old.name&&item.name)old.name=item.name;if(!old.photo&&item.photo)old.photo=item.photo;if(!old.wbUrl&&item.wbUrl)old.wbUrl=item.wbUrl}else a.push(item);
  }
  liveByOrder=map;
}

function parseItems(raw){
  return String(raw||'').split(/;|\n/).map(part=>{
    const s=String(part||'').trim();if(!s)return null;
    const m=s.match(/^(.*?)(?:\s+x(\d+))?$/i);
    const sku=normSku(m&&m[1]?m[1]:s),qty=Math.max(1,Number(m&&m[2]?m[2]:1)||1);
    return sku?{sku,qty}:null;
  }).filter(Boolean);
}
function productFor(sku){return productMap.get(normSku(sku))||{sku:normSku(sku),name:'',wbUrl:'',photo:''}}
function photoFor(item){
  const p=productFor(item.sku),m=window.GB_PHOTOS||photoMap||{};
  return String(item.photo||p.photo||m[normSku(item.sku)]||'').trim();
}
function wbFor(item){
  if(!normSku(item.sku).startsWith('WB'))return'';
  const p=productFor(item.sku),u=String(item.wbUrl||p.wbUrl||'').trim();
  return /^https?:\/\//i.test(u)?u:'';
}
function nameFor(item){const p=productFor(item.sku);return String(item.name||p.name||item.sku||'Товар').trim()}

async function loadOrders(){
  const resp=await gviz(ORDERS_SHEET,'select A,B,C,F,G,H,I where A is not null order by C desc limit 2000');
  const list=resp&&resp.table&&Array.isArray(resp.table.rows)?resp.table.rows:[];
  const today=todayKey(),out=[];
  for(const r of list){
    const c=r.c||[],code=cleanCode(cell(c[0])),rawItems=cell(c[1]),d=dateParts(cell(c[2]));
    if(!code||d.key!==today)continue;
    const order={code,rawItems,dateRaw:cell(c[2]),dateKey:d.key,time:d.time,sort:d.sort,state:cell(c[3]),status:cell(c[4]),statusText:cell(c[5]),preorder:isYes(cell(c[6]))};
    order.stage=stageOf(order);
    if(!order.stage)continue;
    let items=liveByOrder.get(code)||[];
    if(!items.length)items=parseItems(rawItems);
    if(!items.length)items=[{sku:rawItems||'—',qty:1}];
    for(const item of items){
      const sku=normSku(item.sku),qty=Math.max(1,Number(item.qty)||1);
      out.push({...order,sku,qty,name:nameFor(item),photo:photoFor(item),wbUrl:wbFor(item)});
    }
  }
  rows=out.sort((a,b)=>b.sort-a.sort||a.code.localeCompare(b.code,'ru',{numeric:true}));
  return rows;
}

function css(){
  if($('#gbNewOrdersCss'))return;
  const s=document.createElement('style');s.id='gbNewOrdersCss';s.textContent=`
#gbNewOrders{position:fixed;inset:58px 0 0;z-index:2147483460;background:#f5f7fa;display:none;overflow:auto;font-family:Inter,Arial,sans-serif;color:#101828}#gbNewOrders *{box-sizing:border-box}
.nwoh{position:sticky;top:0;z-index:30;background:#fff;border-bottom:1px solid #e4e7ec;padding:13px 18px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}.nwotitle{font-size:25px;font-weight:950;margin-right:auto}.nwosub{font-size:12px;color:#667085;margin-top:2px}.nwobtn{border:1px solid #d0d5dd;background:#fff;border-radius:11px;padding:9px 12px;font-weight:850;cursor:pointer;color:#101828}.nwobtn.dark{background:#111;color:#fff;border-color:#111}.nwobtn:disabled{opacity:.55;cursor:not-allowed}
.nwobody{padding:16px;max-width:1600px;margin:auto}.nwokpis{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:13px}.nwokpi{background:#fff;border:1px solid #e4e7ec;border-radius:15px;padding:12px}.nwokl{font-size:10px;text-transform:uppercase;color:#667085;font-weight:900}.nwokv{font-size:28px;font-weight:950;margin-top:5px}
.nwotools{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:13px}.nwochip{border:1px solid #d0d5dd;background:#fff;border-radius:999px;padding:8px 11px;font-weight:850;cursor:pointer}.nwochip.on{background:#111;color:#fff;border-color:#111}.nwosearch{flex:1;min-width:240px;border:1px solid #d0d5dd;border-radius:11px;padding:10px 12px;font-weight:700}.nwostamp{font-size:11px;color:#667085;font-weight:750}
.nwotablebox{background:#fff;border:1px solid #e4e7ec;border-radius:18px;overflow:auto}.nwotable{width:100%;border-collapse:collapse;min-width:1000px}.nwotable th{position:sticky;top:0;background:#f9fafb;text-align:left;padding:10px;font-size:11px;text-transform:uppercase;color:#667085;z-index:2}.nwotable td{padding:11px;border-top:1px solid #f2f4f7;vertical-align:middle;font-size:13px}.nwopic{width:76px;height:92px;border:1px solid #e4e7ec;border-radius:10px;background:#fff;display:flex;align-items:center;justify-content:center;overflow:hidden;color:#98a2b3;font-size:10px;text-align:center}.nwopic img{width:100%;height:100%;object-fit:contain;background:#fff}.nwoname{font-weight:850;line-height:1.35;max-width:420px}.nwosku{font:900 12px ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}.nwocode{font:900 14px ui-monospace,SFMono-Regular,Menlo,monospace}.nwoqty{font-size:20px;font-weight:950}.nwobadge{display:inline-flex;align-items:center;padding:6px 9px;border-radius:999px;font-size:11px;font-weight:900;white-space:nowrap}.nwobadge.pre{background:#eef4ff;color:#3538cd}.nwobadge.pack{background:#fffaeb;color:#b54708}.nwobadge.trans{background:#ecfdf3;color:#027a48}.nwolink{display:inline-flex;align-items:center;padding:8px 10px;border:1px solid #7f56d9;border-radius:9px;color:#6941c6;text-decoration:none;font-weight:900;background:#f9f5ff;white-space:nowrap}.nwoempty,.nwoload{padding:38px;text-align:center;color:#667085;font-weight:800}.nwoerr{margin-bottom:12px;padding:10px 12px;border-radius:11px;background:#fef3f2;color:#b42318;font-weight:850;display:none}.nwoerr.show{display:block}
@media(max-width:850px){#gbNewOrders{inset:52px 0 0}.nwotitle{font-size:21px}.nwokpis{grid-template-columns:repeat(2,1fr)}.nwobody{padding:10px}.nwotable{min-width:900px}}
`;document.head.appendChild(s);
}
function nav(){
  if($('#gbNewOrdersNav'))return true;
  const all=[...document.querySelectorAll('button,a')];
  const ref=all.find(x=>/^Заказы$/i.test(String(x.textContent||'').trim()))||all.find(x=>/Сканер/i.test(x.textContent||''))||all.find(x=>/Продажи/i.test(x.textContent||''))||all.find(x=>/Мой склад/i.test(x.textContent||''));
  if(!ref?.parentElement)return false;
  const b=document.createElement('button');b.id='gbNewOrdersNav';b.type='button';b.className=ref.className;b.textContent='🆕 Новые заказы';b.onclick=openPanel;
  ref.parentElement.insertBefore(b,ref.nextSibling);
  return true;
}
function build(){
  css();let o=$('#gbNewOrders');if(o)return o;
  o=document.createElement('section');o.id='gbNewOrders';
  o.innerHTML=`<div class="nwoh"><div><div class="nwotitle">Новые заказы</div><div class="nwosub">Заказы, поступившие сегодня · Предзаказ / Упаковка / Передача</div></div><button id="nwoRefresh" class="nwobtn">↻ Обновить</button><button id="nwoClose" class="nwobtn dark">Закрыть</button></div><div class="nwobody"><div id="nwoErr" class="nwoerr"></div><div class="nwokpis"><div class="nwokpi"><div class="nwokl">Всего сегодня</div><div id="nwoAll" class="nwokv">0</div></div><div class="nwokpi"><div class="nwokl">Предзаказ</div><div id="nwoPre" class="nwokv">0</div></div><div class="nwokpi"><div class="nwokl">Упаковка</div><div id="nwoPack" class="nwokv">0</div></div><div class="nwokpi"><div class="nwokl">Передача</div><div id="nwoTrans" class="nwokv">0</div></div></div><div class="nwotools"><button class="nwochip on" data-nwo="all">Все</button><button class="nwochip" data-nwo="preorder">Предзаказ</button><button class="nwochip" data-nwo="packing">Упаковка</button><button class="nwochip" data-nwo="transfer">Передача</button><input id="nwoSearch" class="nwosearch" placeholder="Поиск по заказу, названию или артикулу"><span id="nwoStamp" class="nwostamp"></span></div><div id="nwoContent"><div class="nwoload">Загрузка новых заказов…</div></div></div>`;
  document.body.appendChild(o);
  $('#nwoClose').onclick=closePanel;$('#nwoRefresh').onclick=()=>load(true);$('#nwoSearch').oninput=e=>{query=String(e.target.value||'').trim().toLowerCase();render()};
  o.querySelectorAll('[data-nwo]').forEach(b=>b.onclick=()=>{filter=b.dataset.nwo;o.querySelectorAll('[data-nwo]').forEach(x=>x.classList.toggle('on',x===b));render()});
  return o;
}
function counts(){
  const by=s=>new Set(rows.filter(x=>x.stage===s).map(x=>x.code)).size;
  return{all:new Set(rows.map(x=>x.code)).size,pre:by('preorder'),pack:by('packing'),trans:by('transfer')};
}
function filtered(){
  return rows.filter(x=>{
    if(filter!=='all'&&x.stage!==filter)return false;
    if(query&&!`${x.code} ${x.sku} ${x.name} ${stageLabel(x.stage)}`.toLowerCase().includes(query))return false;
    return true;
  });
}
function render(){
  const o=build(),c=counts();
  $('#nwoAll').textContent=c.all;$('#nwoPre').textContent=c.pre;$('#nwoPack').textContent=c.pack;$('#nwoTrans').textContent=c.trans;
  const navBtn=$('#gbNewOrdersNav');if(navBtn)navBtn.textContent='🆕 Новые заказы'+(c.all?' · '+c.all:'');
  $('#nwoStamp').textContent=lastUpdated?`Сегодня: ${todayRu()} · обновлено ${lastUpdated}`:`Сегодня: ${todayRu()}`;
  const a=filtered(),box=$('#nwoContent');
  if(!a.length){box.innerHTML='<div class="nwoempty">Сегодня в выбранном разделе новых заказов нет.</div>';return}
  box.innerHTML=`<div class="nwotablebox"><table class="nwotable"><thead><tr><th>Фото</th><th>Товар</th><th>Артикул</th><th>Кол-во</th><th>Заказ</th><th>Время</th><th>Раздел Kaspi</th><th>WB</th></tr></thead><tbody>${a.map(x=>`<tr><td><div class="nwopic">${/^https?:\/\//i.test(x.photo)?`<img src="${esc(x.photo)}" alt="" loading="lazy" onerror="this.remove();this.parentElement.textContent='Нет фото'">`:'Нет фото'}</div></td><td><div class="nwoname">${esc(x.name)}</div></td><td class="nwosku">${esc(x.sku)}</td><td><span class="nwoqty">${x.qty}</span></td><td class="nwocode">${esc(x.code)}</td><td><b>${esc(x.time||'—')}</b></td><td><span class="nwobadge ${stageClass(x.stage)}">${esc(stageLabel(x.stage))}</span></td><td>${x.wbUrl?`<a class="nwolink" href="${esc(x.wbUrl)}" target="_blank" rel="noopener">Открыть WB ↗</a>`:'—'}</td></tr>`).join('')}</tbody></table></div>`;
}
function showError(t){const e=$('#nwoErr');if(!e)return;e.textContent=t;e.className='nwoerr '+(t?'show':'')}
async function load(force=false){
  if(loading)return;
  loading=true;build();showError('');const b=$('#nwoRefresh');if(b){b.disabled=true;b.textContent='Обновляю…'};
  if(!rows.length)$('#nwoContent').innerHTML='<div class="nwoload">Загрузка новых заказов…</div>';
  try{
    await Promise.allSettled([loadPhotoMap(),productMap.size?Promise.resolve():loadProducts(),loadLive()]);
    await loadOrders();
    lastUpdated=new Intl.DateTimeFormat('ru-RU',{timeZone:'Asia/Almaty',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date());
    render();
  }catch(e){console.error('New orders load failed',e);showError('Не удалось обновить новые заказы: '+String(e?.message||e));render()}
  finally{loading=false;if(b){b.disabled=false;b.textContent='↻ Обновить'}}
}
function openPanel(){const o=build();o.style.display='block';document.body.style.overflow='hidden';load(true)}
function closePanel(){const o=$('#gbNewOrders');if(o)o.style.display='none';document.body.style.overflow=''}

function schedule(){clearInterval(autoTimer);autoTimer=setInterval(()=>{const o=$('#gbNewOrders');if(o&&o.style.display!=='none'&&document.visibilityState==='visible')load(false)},60000)}
let tries=0;const boot=setInterval(()=>{tries++;if(nav()){clearInterval(boot);build();load(false).catch(()=>{});schedule()}else if(tries>160)clearInterval(boot)},250);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){nav();const o=$('#gbNewOrders');if(o&&o.style.display!=='none')load(false)}});
})();
