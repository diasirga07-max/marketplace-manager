(()=>{
'use strict';
if(window.GB_ORDERS_EXCEL_SYNC_LOADED)return;
window.GB_ORDERS_EXCEL_SYNC_LOADED=true;

const API='/api/orders-sheets-sync';
const SHEET_ID='1543WyOY5gsP3i3rcxcmp1dtxYHy6uPUtdFj8Xs58Cr4';
const GIDS={'Курдай':2120001010,'WB':2120001011,'Алматы':2120001012};
const GROUPS=['Курдай','WB','Алматы'];
const LAST_KEY='gbOrdersExcelSyncV4';
let syncing=null;
let timer=null;
let lastExcelFingerprint='';

function normCode(v){return String(v||'').trim().replace(/-1$/,'')}
function normSku(v){return String(v||'').trim()}
function skuGroup(v){const s=normSku(v).toUpperCase();if(/^OPT/.test(s))return'Курдай';if(/^WB/.test(s))return'WB';return'Алматы'}
function currentGroup(){try{return GROUPS.includes(S.g)?S.g:'Алматы'}catch{return'Алматы'}}
function sheetUrl(group){return 'https://docs.google.com/spreadsheets/d/'+SHEET_ID+'/edit#gid='+(GIDS[group]||GIDS['Алматы'])}
function excelRecords(){try{return window.GB_ORDER_EXCEL?.getRecords?.()||[]}catch{return[]}}
function excelActive(){return window.GB_EXCEL_ORDER_MODE===true&&excelRecords().length>0}
function excelFingerprint(){
  const a=excelRecords();
  if(!a.length)return'';
  return a.map(r=>[normCode(r?.c),normSku(r?.s),Number(r?.q)||0,String(r?.n||'')].join('|')).join('~');
}
function sourceStamp(){
  if(excelActive())return 'EXCEL:'+excelFingerprint();
  try{return String(S.orders?.generatedAt||'')}catch{return''}
}
function htmlDecode(v){
  try{const t=document.createElement('textarea');t.innerHTML=String(v||'');return t.value}catch{return String(v||'')}
}
function photoUrl(x){
  const sku=String(x?.sku||'').trim().toUpperCase();
  const direct=[x?.photo,x?.photoUrl,x?.image,x?.imageUrl,x?.img,x?.picture].find(v=>/^https?:\/\//i.test(String(v||'').trim()));
  if(direct)return String(direct).trim();
  try{
    const mapped=window.GB_PHOTOS&&window.GB_PHOTOS[sku];
    if(/^https?:\/\//i.test(String(mapped||'').trim()))return String(mapped).trim();
  }catch{}
  try{
    if(typeof pic==='function'){
      const h=String(pic(x)||'');
      const m=h.match(/<img[^>]+src=["']([^"']+)["']/i)||h.match(/url\(["']?([^"')]+)["']?\)/i);
      if(m&&m[1]){
        const u=htmlDecode(m[1]).trim();
        if(/^https?:\/\//i.test(u))return u;
      }
    }
  }catch(e){console.warn('Order photo export failed for '+sku,e)}
  return '';
}

function serializeExcel(){
  const out={Курдай:[],WB:[],Алматы:[]};
  const maps={Курдай:new Map(),WB:new Map(),Алматы:new Map()};
  for(const r of excelRecords()){
    const sku=normSku(r?.s);const code=normCode(r?.c);const qty=Math.max(1,Number(r?.q)||1);
    if(!sku||!code)continue;
    const g=skuGroup(sku),key=sku.toUpperCase();
    let x=maps[g].get(key);
    if(!x){x={sku,name:String(r?.n||sku).trim(),photo:photoUrl({sku,name:r?.n}),qty:0,orders:new Set()};maps[g].set(key,x)}
    x.qty+=qty;x.orders.add(code);
    if(!x.name&&r?.n)x.name=String(r.n).trim();
  }
  for(const g of GROUPS){
    out[g]=[...maps[g].values()].map(x=>({sku:x.sku,name:x.name,photo:x.photo,qty:x.qty,orders:[...x.orders]}));
  }
  return out;
}

function serializeLive(){
  if(typeof S==='undefined'||!S.orders||typeof grouped!=='function')throw new Error('Актуальные заказы сайта ещё не загружены');
  const old=S.g;
  const out={};
  try{
    for(const g of GROUPS){
      S.g=g;
      const rows=grouped();
      out[g]=(Array.isArray(rows)?rows:[]).map(x=>({
        sku:String(x?.sku||'').trim(),
        name:String(x?.name||'').trim(),
        photo:photoUrl(x),
        qty:Number(x?.qty||0),
        orders:[...(x?.orders instanceof Set?x.orders:new Set(Array.isArray(x?.orders)?x.orders:[]))].map(normCode).filter(Boolean)
      })).filter(x=>x.sku&&x.qty>0&&x.orders.length);
    }
  }finally{S.g=old}
  return out;
}

function serializeAll(){
  if(excelActive())return serializeExcel();
  return serializeLive();
}

function counts(groups){
  const r={};
  for(const g of GROUPS){const a=groups[g]||[];r[g]={rows:a.length,units:a.reduce((s,x)=>s+(Number(x.qty)||0),0),photos:a.filter(x=>x.photo).length}}
  return r;
}

function button(){return document.getElementById('gbGoogleExcel')}
function setButton(text,busy=false){const b=button();if(!b)return;b.textContent=text;b.style.pointerEvents=busy?'none':'';b.style.opacity=busy?'.65':''}
function badge(text,type='ok'){
  let el=document.getElementById('gbExcelSyncStatus');
  if(!el){el=document.createElement('span');el.id='gbExcelSyncStatus';el.style.cssText='font-size:11px;font-weight:850;margin-left:8px;white-space:nowrap;';const b=button();if(b&&b.parentElement)b.parentElement.appendChild(el)}
  if(!el)return;
  el.textContent=text;
  el.style.color=type==='err'?'#b42318':type==='busy'?'#b54708':'#027a48';
}

function saveLast(stamp,result){try{localStorage.setItem(LAST_KEY,JSON.stringify({stamp,at:Date.now(),result}))}catch{}}
function readLast(){try{return JSON.parse(localStorage.getItem(LAST_KEY)||'{}')||{}}catch{return{}}}

async function sync(force=false){
  if(syncing)return syncing;
  const stamp=sourceStamp();
  if(!force){
    const last=readLast();
    if(stamp&&last.stamp===stamp&&Date.now()-Number(last.at||0)<110000)return last.result||null;
  }
  syncing=(async()=>{
    const groups=serializeAll();
    const c=counts(groups);
    const source=excelActive()?'Excel':'API';
    setButton('↻ Excel обновляется…',true);badge('Синхронизация '+source+'…','busy');
    const r=await fetch(API,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({groups,sourceGeneratedAt:stamp}),cache:'no-store'});
    const text=await r.text();let j={};try{j=text?JSON.parse(text):{}}catch{throw new Error('Vercel вернул не JSON: '+text.slice(0,120))}
    if(!r.ok||!j.ok)throw new Error(j.error||('HTTP '+r.status));
    saveLast(stamp,j);
    setButton('✓ Google Excel',false);
    badge(source+' → Google Excel: '+(j.updatedAt||'обновлён')+' · К '+c['Курдай'].units+' / WB '+c['WB'].units+' / А '+c['Алматы'].units,'ok');
    return j;
  })().catch(e=>{
    console.error('Google Excel live sync failed',e);
    setButton('↗ Google Excel',false);badge('Ошибка Excel: '+String(e?.message||e).slice(0,100),'err');throw e;
  }).finally(()=>{syncing=null});
  return syncing;
}

async function clickExcel(e){
  const b=e.target&&e.target.closest?e.target.closest('#gbGoogleExcel'):null;if(!b)return;
  e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();
  const g=currentGroup();
  if(!excelActive()&&window.GB_ORDER_API_AUTO_ENABLED!==true){window.open(sheetUrl(g),'_blank','noopener');return}
  try{await sync(true);window.open(sheetUrl(g),'_blank','noopener')}
  catch(err){alert('Не удалось обновить Google Excel:\n'+String(err?.message||err))}
}

function attach(){
  const b=button();if(!b)return false;
  b.href=sheetUrl(currentGroup());
  b.target='_blank';
  if(!document.getElementById('gbExcelSyncStatus'))badge('Google Excel готов','ok');
  return true;
}

function scheduleAuto(delay=500){
  clearTimeout(timer);
  timer=setTimeout(()=>{
    if(document.visibilityState!=='visible')return;
    if(excelActive()||window.GB_ORDER_API_AUTO_ENABLED===true)sync(false).catch(()=>{});
  },delay);
}

document.addEventListener('click',clickExcel,true);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')scheduleAuto(500)});
window.addEventListener('gb-orders-api-toggle',()=>scheduleAuto(250));

let lastFresh='';
const observer=new MutationObserver(()=>{
  attach();
  const fresh=document.getElementById('fresh');
  const t=String(fresh?.textContent||'');
  if(t&&t!==lastFresh){lastFresh=t;scheduleAuto(500)}
});
observer.observe(document.documentElement,{childList:true,subtree:true,characterData:true});

setInterval(()=>{
  const fp=excelActive()?excelFingerprint():'';
  if(fp&&fp!==lastExcelFingerprint){lastExcelFingerprint=fp;scheduleAuto(150)}
  if(!fp)lastExcelFingerprint='';
},1000);

let tries=0;const boot=setInterval(()=>{
  tries++;
  if(attach()&&typeof S!=='undefined'&&S.orders){clearInterval(boot);lastFresh=String(document.getElementById('fresh')?.textContent||'');scheduleAuto(700)}
  else if(tries>120)clearInterval(boot);
},250);
})();

(()=>{
  if(window.GB_ORDER_EXCEL_IMPORT_LOADER)return;
  window.GB_ORDER_EXCEL_IMPORT_LOADER=true;
  const base='https://raw.githubusercontent.com/diasirga07-max/marketplace-manager/main/public/';
  fetch(base+'gb-order-excel-import.js?v=20260919-7',{cache:'no-store'})
    .then(r=>{if(!r.ok)throw new Error('order excel import '+r.status);return r.text()})
    .then(code=>{
      const s=document.createElement('script');s.id='gbOrderExcelImportRuntime';s.textContent=code;document.body.appendChild(s);
      return fetch(base+'gb-orders-source-control.js?v=20260916-4',{cache:'no-store'});
    })
    .then(r=>{if(!r.ok)throw new Error('orders source control '+r.status);return r.text()})
    .then(code=>{const s=document.createElement('script');s.id='gbOrdersSourceControlRuntime';s.textContent=code;document.body.appendChild(s)})
    .catch(e=>console.error('Order Excel/source-control load failed',e));
})();
