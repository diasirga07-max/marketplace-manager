(()=>{
'use strict';
if(window.GB_GOODS_ACCEPTANCE_LOADED)return;
const OLD='https://raw.githubusercontent.com/diasirga07-max/marketplace-manager/d668d404642de4b4135d177612f0b10884d7d149/vercel-site/goods-acceptance.js';
fetch(OLD,{cache:'no-store'})
  .then(r=>{if(!r.ok)throw new Error('working acceptance '+r.status);return r.text()})
  .then(code=>{const s=document.createElement('script');s.id='gbAcceptanceKnownGoodRuntime';s.textContent=code;document.body.appendChild(s)})
  .catch(e=>console.error('Known-good goods acceptance load failed',e));
})();
