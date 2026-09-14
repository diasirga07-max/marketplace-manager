(()=>{
'use strict';
if(window.GB_NEW_ORDERS_BOOTSTRAP_LOADED)return;
window.GB_NEW_ORDERS_BOOTSTRAP_LOADED=true;
const RAW='https://raw.githubusercontent.com/diasirga07-max/marketplace-manager/';
const ORIGINAL='0a04615ea85f61f8ca21f09f5b60fb5e55624a40/public/gb-new-orders-v2.js';
function inject(id,code){
  if(document.getElementById(id))return;
  const s=document.createElement('script');s.id=id;s.textContent=code;document.body.appendChild(s);
}
(async()=>{
  try{
    const fr=await fetch(RAW+'main/public/gb-new-orders-api-fallback.js?v=20260914-1',{cache:'no-store'});
    if(!fr.ok)throw new Error('fallback '+fr.status);
    inject('gbNewOrdersApiFallbackRuntime',await fr.text());
    const mr=await fetch(RAW+ORIGINAL+'?v=20260914-1',{cache:'no-store'});
    if(!mr.ok)throw new Error('new orders '+mr.status);
    inject('gbNewOrdersOriginalRuntime',await mr.text());
  }catch(e){
    console.error('New Orders bootstrap failed',e);
    const n=document.getElementById('gbNewOrdersNav');if(n)n.title='Ошибка загрузки новых заказов: '+String(e&&e.message||e);
  }
})();
})();
