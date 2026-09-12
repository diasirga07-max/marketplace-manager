(()=>{
'use strict';
window.GB_GOODS_ACCEPTANCE_LOADED=true;
window.GB_GOODS_ACCEPTANCE_DISABLED=true;
function disableAcceptance(){
  try{
    const ids=['gbAcceptNav','gbAccept','gbGoodsAcceptanceRuntime'];
    for(const id of ids){const el=document.getElementById(id);if(el&&id!=='gbGoodsAcceptanceRuntime')el.remove()}
    for(const el of [...document.querySelectorAll('button,a')]){
      const t=String(el.textContent||'').trim();
      if(/Принятие товара|Принять заказы и сформировать накладные/i.test(t))el.remove();
    }
  }catch(e){console.warn('Acceptance disable guard failed',e)}
}
disableAcceptance();
new MutationObserver(disableAcceptance).observe(document.documentElement,{childList:true,subtree:true});
})();
