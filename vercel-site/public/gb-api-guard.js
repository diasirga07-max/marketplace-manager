(()=>{
'use strict';
if(window.GB_SAME_ORIGIN_API_GUARD)return;
window.GB_SAME_ORIGIN_API_GUARD=true;

const originalFetch=window.fetch.bind(window);
const grantsBookHost=/^grants-book-kaspi-assistant(?:-[a-z0-9]+)?(?:-dias10)?\.vercel\.app$/i;

window.fetch=function(input,init){
  const raw=typeof input==='string'||input instanceof URL?String(input):String(input&&input.url||'');
  let url;
  try{url=new URL(raw,location.href)}catch{return originalFetch(input,init)}
  if(grantsBookHost.test(url.hostname)&&url.pathname.startsWith('/api/')){
    const local=url.pathname+url.search+url.hash;
    input=typeof input==='string'||input instanceof URL?local:new Request(local,input);
  }
  return originalFetch(input,init);
};
})();
