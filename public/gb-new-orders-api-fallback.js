(()=>{
'use strict';
if(window.GB_NEW_ORDERS_API_FALLBACK_LOADED)return;
window.GB_NEW_ORDERS_API_FALLBACK_LOADED=true;

const SHEET_ID='1dLU5KOi3WBLy3uNEiqGv5rf9ka0OwcEw_RjhDQW3H1E';
const SHEET='KASPI_ЗАКАЗЫ';
const originalFetch=window.fetch.bind(window);
let pending=null;

function isNewOrdersUrl(input){
  const u=typeof input==='string'?input:String(input&&input.url||'');
  try{return new URL(u,location.href).pathname==='/api/new-orders'}catch{return /(?:^|\/)api\/new-orders(?:[?#]|$)/.test(u)}
}
function val(c){
  if(!c)return'';
  if(c.f!=null&&String(c.f).trim())return String(c.f).trim();
  if(c.v!=null)return String(c.v).trim();
  return'';
}
function todayKey(){
  const p=new Intl.DateTimeFormat('ru-RU',{timeZone:'Asia/Almaty',day:'2-digit',month:'2-digit',year:'numeric'}).formatToParts(new Date());
  const o={};for(const x of p)o[x.type]=x.value;
  return `${o.day}.${o.month}.${o.year}`;
}
function parseSheetDate(v){
  const s=String(v||'').trim();
  let m=s.match(/(\d{2})[.\/-](\d{2})[.\/-](\d{4})(?:[^\d]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if(m){
    const dd=m[1],mm=m[2],yyyy=m[3],hh=m[4]||'00',mi=m[5]||'00',ss=m[6]||'00';
    return {key:`${dd}.${mm}.${yyyy}`,time:`${String(hh).padStart(2,'0')}:${mi}:${ss}`,stamp:Date.parse(`${yyyy}-${mm}-${dd}T${String(hh).padStart(2,'0')}:${mi}:${ss}+05:00`)||0};
  }
  m=s.match(/Date\((\d{4}),(\d{1,2}),(\d{1,2})(?:,(\d{1,2}),(\d{1,2}),(\d{1,2}))?\)/);
  if(m){
    const yyyy=m[1],mm=String(Number(m[2])+1).padStart(2,'0'),dd=String(m[3]).padStart(2,'0'),hh=String(m[4]||0).padStart(2,'0'),mi=String(m[5]||0).padStart(2,'0'),ss=String(m[6]||0).padStart(2,'0');
    return {key:`${dd}.${mm}.${yyyy}`,time:`${hh}:${mi}:${ss}`,stamp:Date.parse(`${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}+05:00`)||0};
  }
  return {key:'',time:'',stamp:0};
}
function stageOf(state,status,label,pre){
  const t=`${state} ${status} ${label}`.toUpperCase();
  if(/COMPLETED|CANCEL|RETURN/.test(t))return'';
  if(/ASSEMBLE|TRANSFER|TRANSMISSION|ПЕРЕДАЧ/.test(t))return'transfer';
  const isPre=/^(ДА|YES|TRUE|1)$/i.test(String(pre||'').trim())||/ПРЕДЗАКАЗ/.test(t);
  if(isPre)return'preorder';
  if(/ACCEPTED_BY_MERCHANT|ARRIVED|KASPI_DELIVERY|УПАКОВ/.test(t))return'packing';
  return'';
}
function gviz(){return new Promise((resolve,reject)=>{
  const cb='__gbNewOrdersFallback'+Date.now()+Math.random().toString(36).slice(2),s=document.createElement('script');let done=false;
  const finish=(fn,x)=>{if(done)return;done=true;clearTimeout(tm);try{delete window[cb]}catch{};s.remove();fn(x)};
  window[cb]=r=>finish(resolve,r||{});
  const tm=setTimeout(()=>finish(reject,new Error('Google Sheets timeout')),18000);
  s.onerror=()=>finish(reject,new Error('Google Sheets load failed'));
  const q='select A,B,C,F,G,H,I where A is not null';
  s.src='https://docs.google.com/spreadsheets/d/'+SHEET_ID+'/gviz/tq?sheet='+encodeURIComponent(SHEET)+'&headers=1&tqx='+encodeURIComponent('out:json;responseHandler:'+cb)+'&tq='+encodeURIComponent(q)+'&_='+Date.now();
  document.head.appendChild(s);
})}
async function fallbackPayload(){
  if(pending)return pending;
  pending=(async()=>{
    const r=await gviz(),src=r&&r.table&&Array.isArray(r.table.rows)?r.table.rows:[],today=todayKey(),by=new Map();
    for(const row of src){
      const c=row.c||[],code=val(c[0]).replace(/-1$/,''),sku=val(c[1]).toUpperCase(),dt=parseSheetDate(val(c[2])),state=val(c[3]),status=val(c[4]),label=val(c[5]),pre=val(c[6]);
      if(!code||!sku||dt.key!==today)continue;
      const stage=stageOf(state,status,label,pre);if(!stage)continue;
      const key=code+'|'+sku,z=by.get(key)||{code,creationDate:dt.stamp,time:dt.time,status,state,preorder:stage==='preorder',stage,sku,qty:0};
      z.qty+=1;if(dt.stamp>z.creationDate){z.creationDate=dt.stamp;z.time=dt.time}by.set(key,z);
    }
    const orderMap=new Map();
    for(const x of by.values()){
      let o=orderMap.get(x.code);if(!o){o={code:x.code,creationDate:x.creationDate,time:x.time,status:x.status,state:x.state,preorder:x.preorder,stage:x.stage,items:[]};orderMap.set(x.code,o)}
      if(x.creationDate>o.creationDate){o.creationDate=x.creationDate;o.time=x.time}o.items.push({sku:x.sku,name:'',qty:x.qty});
    }
    const orders=[...orderMap.values()].sort((a,b)=>b.creationDate-a.creationDate);
    return {ok:true,fallback:true,source:'KASPI_ЗАКАЗЫ',generatedAt:new Date().toISOString(),count:orders.length,orders,durationMs:0};
  })().finally(()=>{setTimeout(()=>{pending=null},1000)});
  return pending;
}
window.fetch=async function(input,init){
  if(!isNewOrdersUrl(input))return originalFetch(input,init);
  let live=null,liveError=null;
  try{
    live=await originalFetch(input,init);
    const ct=String(live.headers&&live.headers.get('content-type')||'');
    if(live.ok&&/application\/json/i.test(ct))return live;
    liveError=new Error('LIVE HTTP '+live.status);
  }catch(e){liveError=e}
  try{
    const data=await fallbackPayload();
    return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
  }catch(e){
    console.error('New Orders fallback failed',e,liveError);
    if(live)return live;
    throw liveError||e;
  }
};
})();
