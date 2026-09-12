(()=>{
'use strict';
if(window.GB_NEW_ORDERS_LOADED)return;
window.GB_NEW_ORDERS_LOADED=true;

const API='/api/new-orders';
const SHEET_ID='1dLU5KOi3WBLy3uNEiqGv5rf9ka0OwcEw_RjhDQW3H1E';
const PRICE_SHEET='Прайс KASPI';
const PHOTO_RAW='https://raw.githubusercontent.com/diasirga07-max/marketplace-manager/main/public/';
const PHOTO_PACK_VERSION='price-map-5803-20260906b';
const $=s=>document.querySelector(s);
const esc=v=>String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const norm=v=>String(v||'').trim().toUpperCase();
let rows=[],productMap=new Map(),photoMap={},loading=false,filter='all',query='',timer=null,lastServerAt='',lastDuration=0;

function todayRu(){return new Intl.DateTimeFormat('ru-RU',{timeZone:'Asia/Almaty',day:'numeric',month:'long',year:'numeric'}).format(new Date())}
function stageLabel(s){return s==='preorder'?'Предзаказ':s==='packing'?'Упаковка':s==='transfer'?'Передача':'—'}
function stageClass(s){return s==='preorder'?'pre':s==='packing'?'pack':'trans'}
function fmtServer(iso){try{return new Intl.DateTimeFormat('ru-RU',{timeZone:'Asia/Almaty',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date(iso))}catch{return''}}
function cell(c){if(!c)return'';if(c.v!=null&&String(c.v).trim())return String(c.v).trim();if(c.f!=null)return String(c.f).trim();return''}

function gviz(sheet,query){return new Promise((resolve,reject)=>{
  const cb='__gbNwoV2'+Date.now()+Math.random().toString(36).slice(2),s=document.createElement('script');let done=false;
  const finish=(fn,v)=>{if(done)return;done=true;clearTimeout(to);try{delete window[cb]}catch{}s.remove();fn(v)};
  window[cb]=r=>finish(resolve,r||{});const to=setTimeout(()=>finish(reject,Error('Google Sheets timeout')),16000);
  s.onerror=()=>finish(reject,Error('Google Sheets load failed'));
  s.src='https://docs.google.com/spreadsheets/d/'+SHEET_ID+'/gviz/tq?sheet='+encodeURIComponent(sheet)+'&headers=1&tqx='+encodeURIComponent('out:json;responseHandler:'+cb)+'&tq='+encodeURIComponent(query)+'&_='+Date.now();
  document.head.appendChild(s);
})}
async function loadProducts(){
  try{
    const r=await gviz(PRICE_SHEET,'select A,B,T,AE where A is not null'),list=r?.table?.rows||[],m=new Map();
    for(const row of list){const c=row.c||[],sku=norm(cell(c[0]));if(!sku)continue;const name=cell(c[1]),wb=cell(c[2]),photo=cell(c[3]);m.set(sku,{name,wb:/^https?:\/\//i.test(wb)?wb:'',photo:/^https?:\/\//i.test(photo)?photo:''})}
    productMap=m;
  }catch(e){console.warn('New Orders product map',e)}
}
async function loadPhotoMap(){
  try{
    if(Object.keys(window.GB_PHOTOS||{}).length>100){photoMap=window.GB_PHOTOS;return}
    const parts=await Promise.all(Array.from({length:8},(_,i)=>fetch(PHOTO_RAW+'gb-photo-map-'+i+'.pack?v='+PHOTO_PACK_VERSION,{cache:'no-store'}).then(r=>{if(!r.ok)throw Error('photo '+r.status);return r.text()})));
    const packed=parts.join('').replace(/\s+/g,''),bytes=Uint8Array.from(atob(packed),c=>c.charCodeAt(0));
    const txt=await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    photoMap=JSON.parse(txt)||{};window.GB_PHOTOS=Object.assign({},window.GB_PHOTOS||{},photoMap);
  }catch(e){console.warn('New Orders photo map',e);photoMap=window.GB_PHOTOS||{}}
}
function product(sku){return productMap.get(norm(sku))||{name:'',wb:'',photo:''}}
function photo(sku){const p=product(sku),g=window.GB_PHOTOS||photoMap||{};return String(p.photo||g[norm(sku)]||'').trim()}
function wb(sku){if(!norm(sku).startsWith('WB'))return'';const u=String(product(sku).wb||'').trim();return /^https?:\/\//i.test(u)?u:''}
function name(item){return String(item?.name||product(item?.sku).name||item?.sku||'Товар').trim()}

function flatten(orders){
  const out=[];
  for(const o of Array.isArray(orders)?orders:[]){
    const items=Array.isArray(o?.items)&&o.items.length?o.items:[{sku:'—',name:'Товар',qty:1}];
    for(const it of items){const sku=norm(it?.sku)||'—';out.push({code:String(o?.code||''),creationDate:Number(o?.creationDate)||0,time:String(o?.time||''),status:String(o?.status||''),state:String(o?.state||''),preorder:!!o?.preorder,stage:String(o?.stage||''),sku,qty:Math.max(1,Number(it?.qty)||1),name:name(it),photo:photo(sku),wbUrl:wb(sku)})}
  }
  return out.sort((a,b)=>b.creationDate-a.creationDate||a.code.localeCompare(b.code,'ru',{numeric:true}));
}

function css(){if($('#gbNewOrdersCssV2'))return;const s=document.createElement('style');s.id='gbNewOrdersCssV2';s.textContent=`
#gbNewOrders{position:fixed;inset:58px 0 0;z-index:2147483460;background:#f5f7fa;display:none;overflow:auto;font-family:Inter,Arial,sans-serif;color:#101828}#gbNewOrders *{box-sizing:border-box}.nwoh{position:sticky;top:0;z-index:30;background:#fff;border-bottom:1px solid #e4e7ec;padding:13px 18px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}.nwotitle{font-size:25px;font-weight:950;margin-right:auto}.nwosub{font-size:12px;color:#667085;margin-top:2px}.nwobtn{border:1px solid #d0d5dd;background:#fff;border-radius:11px;padding:10px 14px;font-weight:900;cursor:pointer}.nwobtn.refresh{background:#12b76a;color:#fff;border-color:#12b76a}.nwobtn.dark{background:#111;color:#fff;border-color:#111}.nwobtn:disabled{opacity:.55;cursor:not-allowed}.nwobody{padding:16px;max-width:1600px;margin:auto}.nwokpis{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:13px}.nwokpi{background:#fff;border:1px solid #e4e7ec;border-radius:15px;padding:12px}.nwokl{font-size:10px;text-transform:uppercase;color:#667085;font-weight:900}.nwokv{font-size:28px;font-weight:950;margin-top:5px}.nwotools{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:13px}.nwochip{border:1px solid #d0d5dd;background:#fff;border-radius:999px;padding:8px 11px;font-weight:850;cursor:pointer}.nwochip.on{background:#111;color:#fff;border-color:#111}.nwosearch{flex:1;min-width:240px;border:1px solid #d0d5dd;border-radius:11px;padding:10px 12px;font-weight:700}.nwostamp{font-size:11px;color:#667085;font-weight:800}.nwolive{color:#027a48;background:#ecfdf3;border:1px solid #abefc6;border-radius:999px;padding:6px 9px}.nwotablebox{background:#fff;border:1px solid #e4e7ec;border-radius:18px;overflow:auto}.nwotable{width:100%;border-collapse:collapse;min-width:1000px}.nwotable th{position:sticky;top:0;background:#f9fafb;text-align:left;padding:10px;font-size:11px;text-transform:uppercase;color:#667085;z-index:2}.nwotable td{padding:11px;border-top:1px solid #f2f4f7;vertical-align:middle;font-size:13px}.nwopic{width:76px;height:92px;border:1px solid #e4e7ec;border-radius:10px;background:#fff;display:flex;align-items:center;justify-content:center;overflow:hidden;color:#98a2b3;font-size:10px;text-align:center}.nwopic img{width:100%;height:100%;object-fit:contain;background:#fff}.nwoname{font-weight:850;line-height:1.35;max-width:420px}.nwosku{font:900 12px ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}.nwocode{font:900 14px ui-monospace,SFMono-Regular,Menlo,monospace}.nwoqty{font-size:20px;font-weight:950}.nwobadge{display:inline-flex;padding:6px 9px;border-radius:999px;font-size:11px;font-weight:900}.nwobadge.pre{background:#eef4ff;color:#3538cd}.nwobadge.pack{background:#fffaeb;color:#b54708}.nwobadge.trans{background:#ecfdf3;color:#027a48}.nwolink{display:inline-flex;padding:8px 10px;border:1px solid #7f56d9;border-radius:9px;color:#6941c6;text-decoration:none;font-weight:900;background:#f9f5ff}.nwoempty,.nwoload{padding:38px;text-align:center;color:#667085;font-weight:800}.nwoerr{margin-bottom:12px;padding:10px 12px;border-radius:11px;background:#fef3f2;color:#b42318;font-weight:850;display:none}.nwoerr.show{display:block}@media(max-width:850px){#gbNewOrders{inset:52px 0 0}.nwotitle{font-size:21px}.nwokpis{grid-template-columns:repeat(2,1fr)}.nwobody{padding:10px}.nwotable{min-width:900px}}
`;document.head.appendChild(s)}
function nav(){if($('#gbNewOrdersNav'))return true;const all=[...document.querySelectorAll('button,a')],ref=all.find(x=>/^Заказы$/i.test(String(x.textContent||'').trim()))||all.find(x=>/Сканер/i.test(x.textContent||''))||all.find(x=>/Мой склад/i.test(x.textContent||''));if(!ref?.parentElement)return false;const b=document.createElement('button');b.id='gbNewOrdersNav';b.type='button';b.className=ref.className;b.textContent='🆕 Новые заказы';b.onclick=openPanel;ref.parentElement.insertBefore(b,ref.nextSibling);return true}
function build(){css();let o=$('#gbNewOrders');if(o)return o;o=document.createElement('section');o.id='gbNewOrders';o.innerHTML=`<div class="nwoh"><div><div class="nwotitle">Новые заказы</div><div class="nwosub">Только заказы, поступившие сегодня · LIVE Kaspi API</div></div><button id="nwoRefresh" class="nwobtn refresh">🔄 Обновить</button><button id="nwoClose" class="nwobtn dark">Закрыть</button></div><div class="nwobody"><div id="nwoErr" class="nwoerr"></div><div class="nwokpis"><div class="nwokpi"><div class="nwokl">Всего сегодня</div><div id="nwoAll" class="nwokv">0</div></div><div class="nwokpi"><div class="nwokl">Предзаказ</div><div id="nwoPre" class="nwokv">0</div></div><div class="nwokpi"><div class="nwokl">Упаковка</div><div id="nwoPack" class="nwokv">0</div></div><div class="nwokpi"><div class="nwokl">Передача</div><div id="nwoTrans" class="nwokv">0</div></div></div><div class="nwotools"><button class="nwochip on" data-nwo="all">Все</button><button class="nwochip" data-nwo="preorder">Предзаказ</button><button class="nwochip" data-nwo="packing">Упаковка</button><button class="nwochip" data-nwo="transfer">Передача</button><input id="nwoSearch" class="nwosearch" placeholder="Поиск по заказу, названию или артикулу"><span id="nwoStamp" class="nwostamp nwolive">LIVE</span></div><div id="nwoContent"><div class="nwoload">Загрузка заказов из Kaspi…</div></div></div>`;document.body.appendChild(o);$('#nwoClose').onclick=closePanel;$('#nwoRefresh').onclick=()=>refresh(true);$('#nwoSearch').oninput=e=>{query=String(e.target.value||'').trim().toLowerCase();render()};o.querySelectorAll('[data-nwo]').forEach(b=>b.onclick=()=>{filter=b.dataset.nwo;o.querySelectorAll('[data-nwo]').forEach(x=>x.classList.toggle('on',x===b));render()});return o}
function uniqueCount(stage){return new Set(rows.filter(x=>!stage||x.stage===stage).map(x=>x.code)).size}
function filtered(){return rows.filter(x=>(filter==='all'||x.stage===filter)&&(!query||`${x.code} ${x.sku} ${x.name} ${stageLabel(x.stage)}`.toLowerCase().includes(query)))}
function imgHtml(x){if(!/^https?:\/\//i.test(x.photo))return'Нет фото';const u=esc(x.photo);return `<img src="${u}" alt="" referrerpolicy="no-referrer" onerror="if(!this.dataset.p){this.dataset.p='1';this.src='https://images.weserv.nl/?url='+encodeURIComponent('${u}')+'&output=webp'}else{this.remove();this.parentElement.textContent='Нет фото'}">`}
function render(){build();$('#nwoAll').textContent=uniqueCount();$('#nwoPre').textContent=uniqueCount('preorder');$('#nwoPack').textContent=uniqueCount('packing');$('#nwoTrans').textContent=uniqueCount('transfer');const n=$('#gbNewOrdersNav');if(n)n.textContent='🆕 Новые заказы'+(uniqueCount()?' · '+uniqueCount():'');$('#nwoStamp').textContent=lastServerAt?`LIVE · ${lastServerAt}${lastDuration?' · '+lastDuration+' мс':''}`:'LIVE · '+todayRu();const a=filtered(),box=$('#nwoContent');if(!a.length){box.innerHTML='<div class="nwoempty">Сегодня в выбранном разделе новых заказов нет.</div>';return}box.innerHTML=`<div class="nwotablebox"><table class="nwotable"><thead><tr><th>Фото</th><th>Товар</th><th>Артикул</th><th>Кол-во</th><th>Заказ</th><th>Время</th><th>Раздел Kaspi</th><th>WB</th></tr></thead><tbody>${a.map(x=>`<tr><td><div class="nwopic">${imgHtml(x)}</div></td><td><div class="nwoname">${esc(x.name)}</div></td><td class="nwosku">${esc(x.sku)}</td><td><span class="nwoqty">${x.qty}</span></td><td class="nwocode">${esc(x.code)}</td><td><b>${esc(x.time||'—')}</b></td><td><span class="nwobadge ${stageClass(x.stage)}">${esc(stageLabel(x.stage))}</span></td><td>${x.wbUrl?`<a class="nwolink" href="${esc(x.wbUrl)}" target="_blank" rel="noopener">Открыть WB ↗</a>`:'—'}</td></tr>`).join('')}</tbody></table></div>`}
function error(t=''){const e=$('#nwoErr');if(e){e.textContent=t;e.className='nwoerr '+(t?'show':'')}}
async function refresh(force=false){if(loading)return;loading=true;build();error('');const b=$('#nwoRefresh');if(b){b.disabled=true;b.textContent='⏳ Обновляю…'};try{const prep=[];if(!productMap.size)prep.push(loadProducts());if(Object.keys(window.GB_PHOTOS||{}).length<100)prep.push(loadPhotoMap());await Promise.allSettled(prep);const r=await fetch(API+'?_='+Date.now(),{cache:'no-store',headers:{Accept:'application/json'}}),text=await r.text();let j={};try{j=text?JSON.parse(text):{}}catch{throw Error('Сервер вернул не JSON')};if(!r.ok||!j.ok)throw Error(j.error||'HTTP '+r.status);rows=flatten(j.orders);lastServerAt=fmtServer(j.generatedAt);lastDuration=Number(j.durationMs)||0;render();window.dispatchEvent(new CustomEvent('gb:new-orders-updated',{detail:{count:j.count||0,generatedAt:j.generatedAt}}));if(b){b.textContent='✓ Обновлено';setTimeout(()=>{if(b)b.textContent='🔄 Обновить'},1100)}}catch(e){console.error('New Orders LIVE',e);error('Не удалось получить свежие заказы из Kaspi: '+String(e?.message||e));if(!rows.length)$('#nwoContent').innerHTML='<div class="nwoempty">Свежие данные Kaspi недоступны. Старый список не показывается.</div>';if(b)b.textContent='🔄 Повторить'}finally{loading=false;if(b)b.disabled=false}}
function openPanel(){build().style.display='block';document.body.style.overflow='hidden';refresh(true)}
function closePanel(){const o=$('#gbNewOrders');if(o)o.style.display='none';document.body.style.overflow=''}
window.GB_NEW_ORDERS_REFRESH=()=>refresh(true);
let tries=0;const boot=setInterval(()=>{tries++;if(nav()){clearInterval(boot);build();refresh(false);clearInterval(timer);timer=setInterval(()=>{const o=$('#gbNewOrders');if(o&&o.style.display!=='none'&&document.visibilityState==='visible')refresh(false)},30000)}else if(tries>160)clearInterval(boot)},250);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){nav();const o=$('#gbNewOrders');if(o&&o.style.display!=='none')refresh(false)}});
})();
