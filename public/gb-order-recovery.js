(()=>{
'use strict';
if(window.GB_ORDER_RECOVERY_LOADED)return;
window.GB_ORDER_RECOVERY_LOADED=true;

const API='/api/warehouse-scan';
const STORAGE_KEY='gbRecoveredOrderCodesV1';
const SEED_CODES=['1061732640'];
const TERMINAL=new Set(['COMPLETED','CANCELLED','CANCELLING','RETURNED','KASPI_DELIVERY_RETURN_REQUESTED']);
const cache=new Map();
const loading=new Map();
let injectBusy=false;
let suppressObserverUntil=0;
let searchTimer=null;

function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function cleanCode(v){return String(v||'').trim().replace(/-1$/,'').replace(/\s+/g,'')}
function readCodes(){
  let a=[];
  try{a=JSON.parse(localStorage.getItem(STORAGE_KEY)||'[]')}catch{}
  return [...new Set([...SEED_CODES,...(Array.isArray(a)?a:[])].map(cleanCode).filter(c=>/^\d{6,14}$/.test(c)))].slice(0,50);
}
function saveCode(code){
  const c=cleanCode(code);if(!/^\d{6,14}$/.test(c))return;
  let a=[];try{a=JSON.parse(localStorage.getItem(STORAGE_KEY)||'[]')}catch{}
  a=[c,...(Array.isArray(a)?a:[])].map(cleanCode).filter(x=>x&&x!==SEED_CODES[0]);
  try{localStorage.setItem(STORAGE_KEY,JSON.stringify([...new Set(a)].slice(0,49)))}catch{}
}
function removeCode(code){
  const c=cleanCode(code);if(SEED_CODES.includes(c))return;
  let a=[];try{a=JSON.parse(localStorage.getItem(STORAGE_KEY)||'[]')}catch{}
  try{localStorage.setItem(STORAGE_KEY,JSON.stringify((Array.isArray(a)?a:[]).map(cleanCode).filter(x=>x&&x!==c).slice(0,49)))}catch{}
}
function stage(order){
  const s=String(order?.status||'');
  if(order?.state==='KASPI_DELIVERY'&&s==='ACCEPTED_BY_MERCHANT'&&!order?.assembled)return 'Упаковка';
  if(s==='ASSEMBLE'||order?.assembled)return 'Передача';
  if(s==='APPROVED_BY_BANK')return 'Новый';
  return s||String(order?.state||'Kaspi live');
}
function active(result){return !!(result?.ok&&result?.order?.code&&!TERMINAL.has(String(result.order.status||'')))}
function normalize(result){
  if(!result||typeof result!=='object')return result;
  if(!Array.isArray(result.rows))result.rows=Array.isArray(result.items)?result.items:[];
  return result;
}

async function lookup(code,{persist=true}={}){
  const c=cleanCode(code);
  if(!/^\d{6,14}$/.test(c))return null;
  if(loading.has(c))return loading.get(c);
  const p=(async()=>{
    try{
      const r=await fetch(API+'?scan='+encodeURIComponent(c)+'&_='+Date.now(),{cache:'no-store'});
      const j=normalize(await r.json().catch(()=>null));
      if(!r.ok||!j?.ok)throw new Error(j?.error||('HTTP '+r.status));
      if(active(j)){
        cache.set(c,j);
        if(persist)saveCode(c);
      }else{
        cache.delete(c);removeCode(c);
      }
      scheduleInject();
      return j;
    }catch(e){
      console.warn('Kaspi live order lookup failed',c,e);
      return null;
    }finally{loading.delete(c)}
  })();
  loading.set(c,p);return p;
}

function currentGroup(){try{return String(S?.g||'')}catch{return''}}
function groupAllows(result){
  const g=currentGroup();
  if(!g||g==='Алматы')return true;
  if(g==='Курдай')return (result?.rows||[]).some(r=>/^OPT/i.test(String(r?.sku||'')));
  if(g==='WB')return (result?.rows||[]).some(r=>/^WB/i.test(String(r?.sku||'')));
  return true;
}
function existingText(){return String(document.getElementById('ot')?.textContent||'')}
function rowHtml(result,row){
  const code=cleanCode(result.order.code),sku=String(row?.sku||row?.productCode||'—'),name=String(row?.name||'Товар Kaspi'),qty=Math.max(1,Number(row?.quantity)||1),st=stage(result.order);
  return '<tr data-gb-recovered="'+esc(code)+'" style="background:#fffdf2">'+
    '<td><div style="width:70px;height:70px;border-radius:12px;background:#f3f4f6;display:grid;place-items:center;font-size:11px;font-weight:800;color:#667085">KASPI<br>LIVE</div></td>'+
    '<td><b>'+esc(name)+'</b><div class="muted" style="font-size:11px;margin-top:4px">Восстановлено напрямую из Kaspi API</div></td>'+
    '<td class="sku">'+esc(sku)+'</td>'+
    '<td><b style="font-size:20px">'+qty+'</b></td>'+
    '<td><b>'+esc(code)+'</b></td>'+
    '<td><span style="display:inline-block;padding:5px 9px;border-radius:999px;background:#fff1c2;font-weight:800;font-size:12px">'+esc(st)+'</span></td>'+
  '</tr>';
}
function ensureNotice(){
  const ot=document.getElementById('ot');const table=ot?.closest('table');if(!table)return null;
  let box=document.getElementById('gbOrderRecoveryNotice');
  if(!box){
    box=document.createElement('div');box.id='gbOrderRecoveryNotice';
    box.style.cssText='display:none;margin:10px 0;padding:10px 14px;border:1px solid #f0d36a;border-radius:14px;background:#fffdf2;font-size:13px;font-weight:750;';
    table.parentElement?.insertBefore(box,table);
  }
  return box;
}
function inject(){
  if(injectBusy)return;injectBusy=true;suppressObserverUntil=Date.now()+300;
  try{
    const ot=document.getElementById('ot');if(!ot)return;
    ot.querySelectorAll('tr[data-gb-recovered]').forEach(n=>n.remove());
    const original=existingText();
    const results=[...cache.values()].filter(active).filter(groupAllows);
    const q=cleanCode(document.getElementById('os')?.value||'');
    const wanted=/^\d{6,14}$/.test(q)?results.filter(x=>cleanCode(x.order.code)===q):results;
    let rows='';let orders=0,items=0;
    for(const r of wanted){
      const code=cleanCode(r.order.code);
      if(original.includes(code))continue;
      orders++;for(const item of (r.rows||[])){rows+=rowHtml(r,item);items++}
    }
    if(rows)ot.insertAdjacentHTML('afterbegin',rows);
    const box=ensureNotice();
    if(box){
      if(orders){box.style.display='block';box.textContent='Kaspi live: восстановлено пропущенных заказов — '+orders+', товарных позиций — '+items+'. Данные получены напрямую из Kaspi.'}
      else box.style.display='none';
    }
  }finally{injectBusy=false}
}
function scheduleInject(){setTimeout(inject,0)}
function bind(){
  const ot=document.getElementById('ot');
  if(ot&&!ot.__gbRecoveryObserver){
    ot.__gbRecoveryObserver=true;
    new MutationObserver(()=>{if(!injectBusy&&Date.now()>suppressObserverUntil)scheduleInject()}).observe(ot,{childList:true});
  }
  const os=document.getElementById('os');
  if(os&&!os.__gbRecoveryBound){
    os.__gbRecoveryBound=true;
    os.addEventListener('input',()=>{
      clearTimeout(searchTimer);
      searchTimer=setTimeout(()=>{const c=cleanCode(os.value);if(/^\d{6,14}$/.test(c))lookup(c);else scheduleInject()},300);
    });
  }
  document.querySelectorAll('#groups button').forEach(b=>{if(!b.__gbRecoveryBound){b.__gbRecoveryBound=true;b.addEventListener('click',()=>setTimeout(inject,30))}});
}
async function boot(){
  bind();
  for(const c of readCodes())await lookup(c,{persist:false});
  inject();
}
let tries=0;const timer=setInterval(()=>{tries++;bind();if(document.getElementById('ot')){clearInterval(timer);boot()}else if(tries>160)clearInterval(timer)},250);
window.addEventListener('focus',()=>{for(const c of readCodes().slice(0,20))lookup(c,{persist:false})});
})();
