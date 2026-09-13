(()=>{
'use strict';
window.GB_GOODS_ACCEPTANCE_LOADED=true;
window.GB_GOODS_ACCEPTANCE_DISABLED=false;
const STOP_KEY='gbGoodsAcceptanceEmergencyStop';
const NEW_ORDERS_LIVE='https://grants-book-kaspi-assistant-ohmkmzurm-dias10.vercel.app/api/new-orders';
window.GB_GOODS_ACCEPTANCE_STOPPED=false;
try{localStorage.removeItem(STOP_KEY)}catch(_){}

function enableAcceptance(){
  window.GB_GOODS_ACCEPTANCE_DISABLED=false;
  window.GB_GOODS_ACCEPTANCE_STOPPED=false;
  try{localStorage.removeItem(STOP_KEY)}catch(_){}
  const stop=document.getElementById('gbAcceptanceStop');
  if(stop)stop.remove();
}

if(!window.__GB_ACCEPTANCE_FETCH_GUARD__){
  window.__GB_ACCEPTANCE_FETCH_GUARD__=true;
  const originalFetch=window.fetch.bind(window);
  window.fetch=function(input,init){
    const url=typeof input==='string'?input:String(input&&input.url||'');
    const method=String((init&&init.method)||(input&&input.method)||'GET').toUpperCase();
    if(method==='GET'&&/^\/api\/new-orders(?:[/?#]|$)/i.test(url)){
      const q=url.includes('?')?url.slice(url.indexOf('?')):'';
      return originalFetch(NEW_ORDERS_LIVE+q,{...(init||{}),cache:'no-store'});
    }
    return originalFetch(input,init);
  };
}

function loadScript(id,url,flag,label){
  if((flag&&window[flag])||document.getElementById(id))return;
  fetch(url,{cache:'no-store'}).then(r=>{if(!r.ok)throw new Error(label+' '+r.status);return r.text()}).then(code=>{
    const s=document.createElement('script');s.id=id;s.textContent=code;document.body.appendChild(s);
  }).catch(e=>{console.error(label+' load failed',e);setTimeout(()=>loadScript(id,url,flag,label),3000)});
}
function loadNewOrdersModule(){
  loadScript('gbNewOrdersRuntime','https://raw.githubusercontent.com/diasirga07-max/marketplace-manager/main/public/gb-new-orders-v2.js?v=20260913-3','GB_NEW_ORDERS_LOADED','New orders LIVE module');
}

function guard(){enableAcceptance();loadNewOrdersModule()}
guard();
new MutationObserver(guard).observe(document.documentElement,{childList:true,subtree:true});
})();
