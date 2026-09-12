(()=>{
'use strict';
window.GB_GOODS_ACCEPTANCE_LOADED=true;
window.GB_GOODS_ACCEPTANCE_DISABLED=true;
const STOP_KEY='gbGoodsAcceptanceEmergencyStop';
window.GB_GOODS_ACCEPTANCE_STOPPED=true;
try{localStorage.setItem(STOP_KEY,'1')}catch(_){}

function disableAcceptance(){
  try{
    const ids=['gbAcceptNav','gbAccept'];
    for(const id of ids){const el=document.getElementById(id);if(el)el.remove()}
    for(const el of [...document.querySelectorAll('button,a')]){
      const t=String(el.textContent||'').trim();
      if(/Принятие товара|Принять заказы и сформировать накладные/i.test(t))el.remove();
    }
  }catch(e){console.warn('Acceptance disable guard failed',e)}
}

function stopAcceptance(){
  window.GB_GOODS_ACCEPTANCE_STOPPED=true;
  try{localStorage.setItem(STOP_KEY,'1')}catch(_){}
  disableAcceptance();
  const b=document.getElementById('gbAcceptanceStop');
  if(b){
    b.textContent='⛔ Принятие остановлено';
    b.style.background='#fef3f2';b.style.color='#b42318';b.style.borderColor='#fda29b';
    setTimeout(()=>{if(document.getElementById('gbAcceptanceStop'))b.textContent='⛔ Остановить принятие'},1800);
  }
}

function ensureStopButton(){
  if(document.getElementById('gbAcceptanceStop'))return true;
  const items=[...document.querySelectorAll('button,a')];
  const ref=items.find(x=>/Мой склад/i.test(x.textContent||''))||items.find(x=>/Динамика продаж/i.test(x.textContent||''))||items.find(x=>/Прайс Kaspi/i.test(x.textContent||''))||items.find(x=>/Настройки/i.test(x.textContent||''));
  if(!ref||!ref.parentElement)return false;
  const b=document.createElement('button');b.id='gbAcceptanceStop';b.type='button';b.className=ref.className;b.textContent='⛔ Остановить принятие';
  b.title='Аварийно остановить принятие заказов. Уже отправленный в Kaspi запрос может завершиться, следующие запросы будут заблокированы.';
  b.style.color='#b42318';b.style.borderColor='#fda29b';b.style.background='#fff5f4';b.onclick=stopAcceptance;
  ref.parentElement.insertBefore(b,ref);return true;
}

if(!window.__GB_ACCEPTANCE_FETCH_GUARD__){
  window.__GB_ACCEPTANCE_FETCH_GUARD__=true;
  const originalFetch=window.fetch.bind(window);
  window.fetch=function(input,init){
    const url=typeof input==='string'?input:String(input&&input.url||'');
    const method=String((init&&init.method)||(input&&input.method)||'GET').toUpperCase();
    if(window.GB_GOODS_ACCEPTANCE_STOPPED&&method==='POST'&&/\/api\/accept-orders(?:[/?#]|$)/i.test(url)){
      return Promise.resolve(new Response(JSON.stringify({ok:false,stopped:true,error:'Принятие заказов остановлено'}),{status:423,headers:{'Content-Type':'application/json'}}));
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
  loadScript('gbNewOrdersRuntime','https://raw.githubusercontent.com/diasirga07-max/marketplace-manager/main/public/gb-new-orders.js?v=20260912-2','GB_NEW_ORDERS_LOADED','New orders module');
  loadScript('gbNewOrdersPhotoFixRuntime','https://raw.githubusercontent.com/diasirga07-max/marketplace-manager/main/public/gb-new-orders-photo-fix.js?v=20260912-2','GB_NEW_ORDERS_PHOTO_FIX_LOADED','New orders photo fix');
}

function guard(){disableAcceptance();ensureStopButton();loadNewOrdersModule()}
guard();
new MutationObserver(guard).observe(document.documentElement,{childList:true,subtree:true});
})();
