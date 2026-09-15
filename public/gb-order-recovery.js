(()=>{
'use strict';
if(window.GB_ORDER_RECOVERY_LOADED)return;
window.GB_ORDER_RECOVERY_LOADED=true;

const LOOKUP_API='/api/warehouse-scan';
const STORAGE_KEY='gbRecoveredOrderCodesV3';
const ACTUAL_SNAPSHOT='15.09.2026 08:42';
const ACTUAL_URLS=[1,2,3,4,5].map(i=>'https://raw.githubusercontent.com/diasirga07-max/marketplace-manager/main/public/actual-orders-20260915-'+i+'.txt');
const TERMINAL=new Set(['COMPLETED','CANCELLED','CANCELLING','RETURNED','KASPI_DELIVERY_RETURN_REQUESTED']);
const cache=new Map(),loading=new Map();
let actualPromise=null,injectBusy=false,suppressObserverUntil=0,searchTimer=null,bulkPromise=null,bulkTimer=null,lastBulkAt=0,bulkStatus='';

function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function cleanCode(v){return String(v||'').trim().replace(/-1$/,'').replace(/\s+/g,'')}
function isOrderCode(v){return /^\d{8,14}$/.test(cleanCode(v))}
function readCodes(){let a=[];try{a=JSON.parse(localStorage.getItem(STORAGE_KEY)||'[]')}catch{}return [...new Set((Array.isArray(a)?a:[]).map(cleanCode).filter(isOrderCode))].slice(0,1400)}
function writeCodes(a){try{localStorage.setItem(STORAGE_KEY,JSON.stringify([...new Set(a.map(cleanCode).filter(isOrderCode))].slice(0,1400)))}catch{}}
function saveCode(code){const c=cleanCode(code);if(isOrderCode(c))writeCodes([c,...readCodes().filter(x=>x!==c)])}
function removeCode(code){const c=cleanCode(code);writeCodes(readCodes().filter(x=>x!==c))}
function stage(order){const s=String(order?.status||'').toUpperCase();if(s==='ASSEMBLE'||order?.assembled)return 'Передача';if(s==='APPROVED_BY_BANK'||String(order?.state||'').toUpperCase()==='NEW')return 'Новый';if(s==='ARRIVED')return 'Прибыл';if(s==='ACCEPTED_BY_MERCHANT')return 'Упаковка';return s||String(order?.state||'Kaspi live')}
function active(result){return !!(result?.ok&&result?.order?.code&&!TERMINAL.has(String(result.order.status||'').toUpperCase()))}
function normalize(result){if(!result||typeof result!=='object')return result;if(!Array.isArray(result.rows))result.rows=Array.isArray(result.items)?result.items:[];return result}

async function loadActualCodes(){
  if(actualPromise)return actualPromise;
  actualPromise=(async()=>{
    const texts=await Promise.all(ACTUAL_URLS.map(async u=>{
      const r=await fetch(u+'?v=20260915-2',{cache:'no-store'});
      if(!r.ok)throw new Error('список актуальных заказов HTTP '+r.status);
      return r.text();
    }));
    const a=texts.flatMap(t=>t.split(/[\s,;]+/).map(cleanCode).filter(isOrderCode));
    const all=[...new Set(a)];
    if(all.length<1000)throw new Error('список актуальных заказов неполный: '+all.length);
    return all;
  })().catch(e=>{actualPromise=null;throw e});
  return actualPromise;
}

async function lookup(code,{persist=true}={}){
  const c=cleanCode(code);if(!isOrderCode(c))return null;if(loading.has(c))return loading.get(c);
  const p=(async()=>{try{
    const r=await fetch(LOOKUP_API+'?scan='+encodeURIComponent(c)+'&_='+Date.now(),{cache:'no-store'});
    const j=normalize(await r.json().catch(()=>null));
    if(!r.ok||!j?.ok)throw new Error(j?.error||('HTTP '+r.status));
    if(active(j)){cache.set(c,j);if(persist)saveCode(c)}else{cache.delete(c);removeCode(c)}
    scheduleInject();return j;
  }catch(e){console.warn('Kaspi live order lookup failed',c,e);return null}finally{loading.delete(c)}})();
  loading.set(c,p);return p;
}

function currentGroup(){try{return String(S?.g||'Алматы')}catch{return'Алматы'}}
function skuGroup(sku){const s=String(sku||'').trim();if(/^OPT/i.test(s))return 'Курдай';if(/^WB/i.test(s))return 'WB';return 'Алматы'}
function rowsForGroup(result){const g=currentGroup();return (result?.rows||[]).filter(r=>skuGroup(r?.sku||r?.productCode)===g)}

/* Important: only orders that are actually available to grouped()/rendered table count as existing.
   Do NOT walk raw S.orders recursively: old/hidden IDs there caused false positives and skipped recovery. */
function collectExistingCodes(){
  const set=new Set();
  try{
    if(typeof grouped==='function'&&typeof S!=='undefined'){
      const old=S.g;
      try{
        for(const g of ['Курдай','WB','Алматы']){
          S.g=g;
          for(const x of (grouped()||[])){
            const a=x?.orders instanceof Set?[...x.orders]:(Array.isArray(x?.orders)?x.orders:[]);
            for(const v of a){const c=cleanCode(v);if(isOrderCode(c))set.add(c)}
          }
        }
      }finally{S.g=old}
    }
  }catch(e){console.warn('Kaspi live grouped order scan failed',e)}
  const ot=document.getElementById('ot');
  if(ot)for(const tr of ot.querySelectorAll('tr:not([data-gb-recovered])'))for(const x of (String(tr.textContent||'').match(/\b\d{8,14}\b/g)||[]))set.add(cleanCode(x));
  return set;
}

function rowHtml(result,row){
  const code=cleanCode(result.order.code),sku=String(row?.sku||row?.productCode||'—'),name=String(row?.name||'Товар Kaspi'),qty=Math.max(1,Number(row?.quantity)||1),st=stage(result.order);
  return '<tr data-gb-recovered="'+esc(code)+'" style="background:#fffdf2">'+
    '<td><div style="width:70px;height:70px;border-radius:12px;background:#f3f4f6;display:grid;place-items:center;font-size:11px;font-weight:800;color:#667085">KASPI<br>LIVE</div></td>'+
    '<td><b>'+esc(name)+'</b><div class="muted" style="font-size:11px;margin-top:4px">Восстановлено массовой сверкой с актуальным списком</div></td>'+
    '<td class="sku">'+esc(sku)+'</td>'+
    '<td><b style="font-size:20px">'+qty+'</b></td>'+
    '<td><b>'+esc(code)+'</b></td>'+
    '<td><span style="display:inline-block;padding:5px 9px;border-radius:999px;background:#fff1c2;font-weight:800;font-size:12px">'+esc(st)+'</span></td>'+
  '</tr>';
}
function ensureNotice(){
  const ot=document.getElementById('ot'),table=ot?.closest('table');if(!table)return null;
  let box=document.getElementById('gbOrderRecoveryNotice');
  if(!box){box=document.createElement('div');box.id='gbOrderRecoveryNotice';box.style.cssText='margin:10px 0;padding:10px 14px;border:1px solid #f0d36a;border-radius:14px;background:#fffdf2;font-size:13px;font-weight:750;';table.parentElement?.insertBefore(box,table)}
  return box;
}
function inject(){
  if(injectBusy)return;injectBusy=true;suppressObserverUntil=Date.now()+350;
  try{
    const ot=document.getElementById('ot');if(!ot)return;
    ot.querySelectorAll('tr[data-gb-recovered]').forEach(n=>n.remove());
    const original=String(ot.textContent||''),q=cleanCode(document.getElementById('os')?.value||'');
    const results=[...cache.values()].filter(active);
    const wanted=isOrderCode(q)?results.filter(x=>cleanCode(x.order.code)===q):results;
    let html='',orders=0,items=0;
    for(const r of wanted){
      const code=cleanCode(r.order.code);if(original.includes(code))continue;
      const rows=rowsForGroup(r);if(!rows.length)continue;orders++;
      for(const item of rows){html+=rowHtml(r,item);items++}
    }
    if(html)ot.insertAdjacentHTML('afterbegin',html);
    const box=ensureNotice();
    if(box){
      if(bulkStatus)box.textContent=bulkStatus+(orders?' · На экране восстановлено: '+orders+' заказов / '+items+' позиций':'');
      else if(orders)box.textContent='Kaspi live: восстановлено пропущенных заказов — '+orders+', товарных позиций — '+items+'.';
      else box.textContent='Kaspi live: массовая сверка активна.';
    }
  }finally{injectBusy=false}
}
function scheduleInject(){setTimeout(inject,0)}
async function mapLimit(items,limit,fn){const out=new Array(items.length);let cur=0;async function run(){while(true){const i=cur++;if(i>=items.length)return;out[i]=await fn(items[i],i)}}await Promise.all(Array.from({length:Math.min(limit,items.length)},run));return out}

async function reconcileBulk(force=false){
  if(bulkPromise)return bulkPromise;
  if(!force&&Date.now()-lastBulkAt<90000)return;
  bulkPromise=(async()=>{
    lastBulkAt=Date.now();
    bulkStatus='Kaspi live: массовая сверка с актуальными заказами от '+ACTUAL_SNAPSHOT+'…';scheduleInject();
    const all=await loadActualCodes();
    const existing=collectExistingCodes();
    const missing=all.filter(c=>!existing.has(c));
    if(!missing.length){bulkStatus='Kaspi live: сверка завершена — все '+all.length+' актуальных заказов присутствуют';scheduleInject();return{ok:true,count:all.length,missing:0}}
    bulkStatus='Kaspi live: найдено '+missing.length+' пропущенных заказов. Восстанавливаю напрямую из Kaspi…';scheduleInject();
    let done=0,found=0,failed=0;
    await mapLimit(missing,8,async c=>{const x=await lookup(c,{persist:true});done++;if(active(x))found++;else failed++;if(done===missing.length||done%10===0){bulkStatus='Kaspi live: проверено '+done+' из '+missing.length+', восстановлено '+found+(failed?' · не найдено '+failed:'');scheduleInject()}return x});
    bulkStatus='Kaspi live: массовая сверка завершена. Восстановлено '+found+' из '+missing.length+' пропущенных заказов'+(failed?' · не найдено/неактивно '+failed:'');
    scheduleInject();return{ok:true,count:all.length,missing:missing.length,found,failed};
  })().catch(e=>{console.error('Bulk Kaspi reconcile failed',e);bulkStatus='Kaspi live: ошибка массовой сверки — '+String(e?.message||e).slice(0,120);scheduleInject()}).finally(()=>{bulkPromise=null});
  return bulkPromise;
}
function scheduleBulk(delay=700){clearTimeout(bulkTimer);bulkTimer=setTimeout(()=>{if(document.visibilityState==='visible')reconcileBulk(false)},delay)}

function bind(){
  const ot=document.getElementById('ot');if(ot&&!ot.__gbRecoveryObserver){ot.__gbRecoveryObserver=true;new MutationObserver(()=>{if(!injectBusy&&Date.now()>suppressObserverUntil)scheduleInject()}).observe(ot,{childList:true})}
  const os=document.getElementById('os');if(os&&!os.__gbRecoveryBound){os.__gbRecoveryBound=true;os.addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{const c=cleanCode(os.value);if(isOrderCode(c))lookup(c);else scheduleInject()},250)})}
  document.querySelectorAll('#groups button').forEach(b=>{if(!b.__gbRecoveryBound){b.__gbRecoveryBound=true;b.addEventListener('click',()=>setTimeout(inject,30))}});
}
async function boot(){
  bind();
  const saved=readCodes().slice(0,180);
  if(saved.length)await mapLimit(saved,8,c=>lookup(c,{persist:false}));
  inject();scheduleBulk(300);
}
let tries=0;const timer=setInterval(()=>{tries++;bind();if(document.getElementById('ot')){clearInterval(timer);boot()}else if(tries>160)clearInterval(timer)},250);
window.addEventListener('focus',()=>scheduleBulk(250));
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')scheduleBulk(250)});
setInterval(()=>{if(document.visibilityState==='visible')reconcileBulk(false)},180000);
window.GB_RECONCILE_ORDERS=()=>reconcileBulk(true);
})();
