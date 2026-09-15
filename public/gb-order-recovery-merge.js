(()=>{
'use strict';
if(window.GB_ORDER_RECOVERY_MERGE_LOADED)return;
window.GB_ORDER_RECOVERY_MERGE_LOADED=true;
let timer=null;
function clean(v){return String(v==null?'':v).trim()}
function normSku(v){return clean(v).toUpperCase()}
function codeFromRow(tr){const t=clean(tr?.cells?.[4]?.textContent);const m=t.match(/\b\d{8,14}\b/);return m?m[0]:''}
function qtyFromCell(td){const n=Number((clean(td?.textContent).match(/\d+/)||['0'])[0]);return Number.isFinite(n)?n:0}
function setQty(td,n){const b=td?.querySelector('b');if(b)b.textContent=String(n);else if(td)td.textContent=String(n)}
function mergedKeys(tr){try{return new Set(JSON.parse(tr.dataset.gbRecoveredKeys||'[]'))}catch{return new Set()}}
function saveKeys(tr,s){tr.dataset.gbRecoveredKeys=JSON.stringify([...s])}
function appendOrder(td,code){if(!td||!code)return;if(clean(td.textContent).includes(code))return;const span=document.createElement('span');span.dataset.gbMergedOrder='1';span.textContent=(clean(td.textContent)?', ':'')+code;td.appendChild(span)}
function appendStage(td,label,qty){if(!td)return;const span=document.createElement('span');span.dataset.gbMergedStage='1';span.style.cssText='display:inline-block;margin:2px 0 2px 6px;padding:5px 8px;border-radius:999px;background:#fff1c2;font-size:11px;font-weight:800';span.textContent='+ '+label+(qty>1?' · '+qty:'');td.appendChild(span)}
function findBaseRows(ot){const m=new Map();for(const tr of ot.querySelectorAll('tr:not([data-gb-recovered])')){const skuTd=tr.querySelector('td.sku');if(!skuTd)continue;const sku=normSku(skuTd.textContent);if(sku&&!m.has(sku))m.set(sku,tr)}return m}
function merge(){
  const ot=document.getElementById('ot');if(!ot)return;
  const recovered=[...ot.querySelectorAll('tr[data-gb-recovered]')];if(!recovered.length)return;
  const base=findBaseRows(ot),firstRecovered=new Map();
  for(const tr of recovered){
    tr.style.display='';
    const skuTd=tr.querySelector('td.sku');const sku=normSku(skuTd?.textContent);const code=codeFromRow(tr);if(!sku||!code)continue;
    const qtyTd=skuTd?.nextElementSibling;const qty=Math.max(1,qtyFromCell(qtyTd));const stage=clean(tr.cells?.[tr.cells.length-1]?.textContent)||'Kaspi live';const key=code+'|'+sku;
    const target=base.get(sku);
    if(target){
      const keys=mergedKeys(target);
      if(!keys.has(key)){
        const tSku=target.querySelector('td.sku'),tQty=tSku?.nextElementSibling,tOrders=tQty?.nextElementSibling,tStage=target.cells?.[target.cells.length-1];
        setQty(tQty,qtyFromCell(tQty)+qty);appendOrder(tOrders,code);appendStage(tStage,stage,qty);keys.add(key);saveKeys(target,keys);
      }
      tr.style.display='none';
      continue;
    }
    const first=firstRecovered.get(sku);
    if(!first){firstRecovered.set(sku,tr);continue}
    const fSku=first.querySelector('td.sku'),fQty=fSku?.nextElementSibling,fOrders=fQty?.nextElementSibling,fStage=first.cells?.[first.cells.length-1];
    const keys=mergedKeys(first);
    if(!keys.has(key)){setQty(fQty,qtyFromCell(fQty)+qty);appendOrder(fOrders,code);appendStage(fStage,stage,qty);keys.add(key);saveKeys(first,keys)}
    tr.style.display='none';
  }
}
function schedule(){clearTimeout(timer);timer=setTimeout(merge,25)}
const mo=new MutationObserver(schedule);mo.observe(document.documentElement,{subtree:true,childList:true});
document.addEventListener('click',e=>{if(e.target?.closest?.('#groups button'))setTimeout(schedule,40)},true);
document.addEventListener('input',e=>{if(e.target?.id==='os')setTimeout(schedule,80)},true);
window.addEventListener('focus',schedule);schedule();
})();
