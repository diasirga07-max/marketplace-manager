(()=>{
'use strict';
if(window.GB_ORDER_RECOVERY_LOADED)return;
window.GB_ORDER_RECOVERY_LOADED=true;

const LOOKUP_API='/api/warehouse-scan';
const BULK_API='/api/reconcile-orders';
const STORAGE_KEY='gbRecoveredOrderCodesV2';
const SEED_CODES=['1061732640'];
const TERMINAL=new Set(['COMPLETED','CANCELLED','CANCELLING','RETURNED','KASPI_DELIVERY_RETURN_REQUESTED']);
const cache=new Map();
const loading=new Map();
let injectBusy=false;
let suppressObserverUntil=0;
let searchTimer=null;
let bulkPromise=null;
let bulkTimer=null;
let lastBulkAt=0;
let bulkStatus='';

function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function cleanCode(v){return String(v||'').trim().replace(/-1$/,'').replace(/\s+/g,'')}
function isOrderCode(v){return /^\d{8,14}$/.test(cleanCode(v))}
function readCodes(){
  let a=[];try{a=JSON.parse(localStorage.getItem(STORAGE_KEY)||'[]')}catch{}
  return [...new Set([...SEED_CODES,...(Array.isArray(a)?a:[])].map(cleanCode).filter(isOrderCode))].slice(0,300);
}
function writeCodes(a){try{localStorage.setItem(STORAGE_KEY,JSON.stringify([...new Set(a.map(cleanCode).filter(isOrderCode))].slice(0,300)))}catch{}}
function saveCode(code){const c=cleanCode(code);if(!isOrderCode(c))return;writeCodes([c,...readCodes().filter(x=>x!==c&&!SEED_CODES.includes(x))])}
function removeCode(code){const c=cleanCode(code);if(SEED_CODES.includes(c))return;writeCodes(readCodes().filter(x=>x!==c))}
function stage(order){
  const s=String(order?.status||'').toUpperCase();
  if(s==='ASSEMBLE'||order?.assembled)return 'Передача';
  if(s==='APPROVED_BY_BANK'||String(order?.state||'').toUpperCase()==='NEW')return 'Новый';
  if(s==='ARRIVED')return 'Прибыл';
  if(s==='ACCEPTED_BY_MERCHANT')return 'Упаковка';
  return s||String(order?.state||'Kaspi live');
}
function active(result){return !!(result?.ok&&result?.order?.code&&!TERMINAL.has(String(result.order.status||'').toUpperCase()))}
function normalize(result){if(!result||typeof result!=='object')return result;if(!Array.isArray(result.rows))result.rows=Array.isArray(result.items)?result.items:[];return result}

async function lookup(code,{persist=true}={}){
  const c=cleanCode(code);if(!isOrderCode(c))return null;if(loading.has(c))return loading.get(c);
  const p=(async()=>{
    try{
      const r=await fetch(LOOKUP_API+'?scan='+encodeURIComponent(c)+'&_='+Date.now(),{cache:'no-store'});
      const j=normalize(await r.json().catch(()=>null));
      if(!r.ok||!j?.ok)throw new Error(j?.error||('HTTP '+r.status));
      if(active(j)){cache.set(c,j);if(persist)saveCode(c)}else{cache.delete(c);removeCode(c)}
      scheduleInject();return j;
    }catch(e){console.warn('Kaspi live order lookup failed',c,e);return null}
    finally{loading.delete(c)}
  })();
  loading.set(c,p);return p;
}

function currentGroup(){try{return String(S?.g||'')}catch{return''}}
function groupAllows(result){
  const g=currentGroup();if(!g||g==='Алматы')return true;
  if(g==='Курдай')return (result?.rows||[]).some(r=>/^OPT/i.test(String(r?.sku||'')));
  if(g==='WB')return (result?.rows||[]).some(r=>/^WB/i.test(String(r?.sku||'')));
  return true;
}
function existingText(){return String(document.getElementById('ot')?.textContent||'')}
function collectExistingCodes(){
  const set=new Set();
  const ot=document.getElementById('ot');
  if(ot){for(const tr of ot.querySelectorAll('tr:not([data-gb-recovered])')){const m=String(tr.textContent||'').match(/\b\d{8,14}\b/g)||[];for(const x of m)set.add(cleanCode(x))}}
  try{
    const seen=new WeakSet();
    const walk=(v,key='',depth=0)=>{
      if(depth>6||v==null)return;
      if(typeof v==='string'||typeof v==='number'){
        if(/order|заказ/i.test(key)&&isOrderCode(v))set.add(cleanCode(v));return;
      }
      if(typeof v!=='object'||seen.has(v))return;seen.add(v);
      if(Array.isArray(v)){for(const x of v.slice(0,10000))walk(x,key,depth+1);return}
      for(const [k,x] of Object.entries(v))walk(x,k,depth+1);
    };
    if(typeof S!=='undefined'&&S?.orders)walk(S.orders,'orders',0);
  }catch{}
  return set;
}
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
  if(!box){box=document.createElement('div');box.id='gbOrderRecoveryNotice';box.style.cssText='margin:10px 0;padding:10px 14px;border:1px solid #f0d36a;border-radius:14px;background:#fffdf2;font-size:13px;font-weight:750;';table.parentElement?.insertBefore(box,table)}
  return box;
}
function inject(){
  if(injectBusy)return;injectBusy=true;suppressObserverUntil=Date.now()+350;
  try{
    const ot=document.getElementById('ot');if(!ot)return;
    ot.querySelectorAll('tr[data-gb-recovered]').forEach(n=>n.remove());
    const original=existingText();const results=[...cache.values()].filter(active).filter(groupAllows);
    const q=cleanCode(document.getElementById('os')?.value||'');const wanted=isOrderCode(q)?results.filter(x=>cleanCode(x.order.code)===q):results;
    let rows='';let orders=0,items=0;
    for(const r of wanted){const code=cleanCode(r.order.code);if(original.includes(code))continue;orders++;for(const item of (r.rows||[])){rows+=rowHtml(r,item);items++}}
    if(rows)ot.insertAdjacentHTML('afterbegin',rows);
    const box=ensureNotice();if(box){
      if(bulkStatus)box.textContent=bulkStatus+(orders?' · Уже восстановлено: '+orders+' заказов / '+items+' позиций':'');
      else if(orders)box.textContent='Kaspi live: восстановлено пропущенных заказов — '+orders+', товарных позиций — '+items+'.';
      else box.textContent='Kaspi live: проверка пропущенных заказов активна.';
    }
  }finally{injectBusy=false}
}
function scheduleInject(){setTimeout(inject,0)}

async function mapLimit(items,limit,fn){const out=new Array(items.length);let cur=0;async function run(){while(true){const i=cur++;if(i>=items.length)return;out[i]=await fn(items[i],i)}}await Promise.all(Array.from({length:Math.min(limit,items.length)},run));return out}
async function reconcileBulk(force=false){
  if(bulkPromise)return bulkPromise;
  if(!force&&Date.now()-lastBulkAt<120000)return;
  bulkPromise=(async()=>{
    lastBulkAt=Date.now();bulkStatus='Kaspi live: ищу все пропущенные активные заказы…';scheduleInject();
    const r=await fetch(BULK_API+'?days=52&_='+Date.now(),{cache:'no-store'});
    const j=await r.json().catch(()=>null);if(!r.ok||!j?.ok)throw new Error(j?.error||('HTTP '+r.status));
    const existing=collectExistingCodes();for(const c of cache.keys())existing.add(c);
    const all=(Array.isArray(j.orders)?j.orders:[]).map(x=>cleanCode(x?.code)).filter(isOrderCode);
    const missing=[...new Set(all.filter(c=>!existing.has(c)))].slice(0,180);
    if(!missing.length){bulkStatus='Kaspi live: сверка завершена, новых пропусков не найдено';scheduleInject();return j}
    let done=0,found=0;
    await mapLimit(missing,6,async c=>{const x=await lookup(c,{persist:true});done++;if(active(x))found++;if(done===missing.length||done%10===0){bulkStatus='Kaspi live: проверено '+done+' из '+missing.length+', восстановлено '+found;scheduleInject()}return x});
    bulkStatus='Kaspi live: массовая сверка завершена. Восстановлено '+found+' из '+missing.length+' пропущенных заказов';scheduleInject();return j;
  })().catch(e=>{console.error('Bulk Kaspi reconcile failed',e);bulkStatus='Kaspi live: массовая сверка временно недоступна — '+String(e?.message||e).slice(0,120);scheduleInject()}).finally(()=>{bulkPromise=null});
  return bulkPromise;
}
function scheduleBulk(delay=1200){clearTimeout(bulkTimer);bulkTimer=setTimeout(()=>{if(document.visibilityState==='visible')reconcileBulk(false)},delay)}

function bind(){
  const ot=document.getElementById('ot');if(ot&&!ot.__gbRecoveryObserver){ot.__gbRecoveryObserver=true;new MutationObserver(()=>{if(!injectBusy&&Date.now()>suppressObserverUntil)scheduleInject()}).observe(ot,{childList:true})}
  const os=document.getElementById('os');if(os&&!os.__gbRecoveryBound){os.__gbRecoveryBound=true;os.addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{const c=cleanCode(os.value);if(isOrderCode(c))lookup(c);else scheduleInject()},300)})}
  document.querySelectorAll('#groups button').forEach(b=>{if(!b.__gbRecoveryBound){b.__gbRecoveryBound=true;b.addEventListener('click',()=>setTimeout(inject,30))}});
}
async function boot(){bind();for(const c of readCodes().slice(0,80))await lookup(c,{persist:false});inject();scheduleBulk(700)}
let tries=0;const timer=setInterval(()=>{tries++;bind();if(document.getElementById('ot')){clearInterval(timer);boot()}else if(tries>160)clearInterval(timer)},250);
window.addEventListener('focus',()=>{scheduleBulk(500);for(const c of readCodes().slice(0,30))lookup(c,{persist:false})});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')scheduleBulk(500)});
setInterval(()=>{if(document.visibilityState==='visible')reconcileBulk(false)},180000);
})();
