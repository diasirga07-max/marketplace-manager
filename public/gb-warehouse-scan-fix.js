(()=>{
'use strict';
if(window.GB_WAREHOUSE_SCAN_FIX_LOADED)return;
window.GB_WAREHOUSE_SCAN_FIX_LOADED=true;

const originalFetch=window.fetch.bind(window);
function parseBody(init){
  try{
    const raw=init&&init.body;
    if(!raw)return null;
    if(typeof raw==='string')return JSON.parse(raw);
  }catch(_){}
  return null;
}
function isDataUrl(url){
  return /\/api\/data(?:[/?#]|$)/i.test(String(url||''));
}
window.fetch=function(input,init){
  const url=typeof input==='string'?input:String(input&&input.url||'');
  const method=String((init&&init.method)||(input&&input.method)||'GET').toUpperCase();
  if(method==='POST'&&isDataUrl(url)){
    const body=parseBody(init);
    const scan=String(body&&body.scan||'').trim();
    if(scan){
      return originalFetch('/api/warehouse-scan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scan}),cache:'no-store'});
    }
  }
  return originalFetch(input,init);
};
})();
