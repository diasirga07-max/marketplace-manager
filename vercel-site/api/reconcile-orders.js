const KASPI_BASE=String(process.env.KASPI_API_BASE_URL||'https://kaspi.kz/shop/api/v2').replace(/\/$/,'');
const DAY=86400000;
const PAGE_SIZE=100;
const MAX_PAGES=30;
const STATES=['KASPI_DELIVERY','PICKUP','DELIVERY','NEW','SIGN_REQUIRED'];
const TERMINAL=new Set(['COMPLETED','CANCELLED','CANCELLING','RETURNED','KASPI_DELIVERY_RETURN_REQUESTED']);

function token(){return String(process.env.KASPI_API_TOKEN||process.env.KASPI_TOKEN||process.env.KASPI_API_KEY||'').trim()}
function clean(v){return String(v==null?'':v).trim().replace(/-1$/,'').replace(/\s+/g,'')}
function errText(e){return (e instanceof Error?e.message:String(e||'Ошибка')).slice(0,700)}
function sleep(ms){return new Promise(r=>setTimeout(r,ms))}

async function kfetch(path){
  const t=token();if(!t)throw Error('KASPI_API_TOKEN не настроен');
  let last;
  for(let attempt=0;attempt<3;attempt++){
    const ctrl=new AbortController();const tm=setTimeout(()=>ctrl.abort(),12000);
    try{
      const r=await fetch(KASPI_BASE+path,{headers:{Accept:'application/vnd.api+json','Content-Type':'application/vnd.api+json','X-Auth-Token':t},cache:'no-store',signal:ctrl.signal});
      clearTimeout(tm);
      const text=await r.text();let j={};try{j=text?JSON.parse(text):{}}catch{j={raw:text.slice(0,300)}}
      if(!r.ok){const d=j?.errors?.[0]?.detail||j?.errors?.[0]?.title||j?.message||j?.error||'';const e=Error('Kaspi API '+r.status+(d?': '+d:''));e.status=r.status;throw e}
      return j;
    }catch(e){clearTimeout(tm);last=e;const s=Number(e?.status)||0;if(attempt===2||(s&&s!==429&&s<500))break;await sleep(300*(attempt+1))}
  }
  throw last||Error('Kaspi API недоступен');
}

function stage(a){
  const status=String(a?.status||'').toUpperCase(),state=String(a?.state||'').toUpperCase();
  if(TERMINAL.has(status))return'';
  if(status==='ASSEMBLE'||a?.assembled===true)return'transfer';
  if(status==='APPROVED_BY_BANK'||state==='NEW'||state==='SIGN_REQUIRED')return'new';
  if(a?.preOrder===true&&status==='ACCEPTED_BY_MERCHANT')return'preorder';
  if(status==='ACCEPTED_BY_MERCHANT'||status==='ARRIVED')return'packing';
  return'active';
}

function snap(o){const a=o?.attributes||{};return{id:String(o?.id||''),code:clean(a.code),status:String(a.status||''),state:String(a.state||''),preOrder:a.preOrder===true,assembled:a.assembled===true,creationDate:Number(a.creationDate)||0,plannedDeliveryDate:Number(a.plannedDeliveryDate)||0,reservationDate:Number(a.reservationDate)||0,stage:stage(a)}}

async function listStateWindow(state,from,to){
  const out=[];let pages=0,totalCount=0;
  for(let page=0;page<MAX_PAGES;page++){
    const q=new URLSearchParams();
    q.set('page[number]',String(page));q.set('page[size]',String(PAGE_SIZE));
    q.set('filter[orders][state]',state);
    q.set('filter[orders][creationDate][$ge]',String(from));
    q.set('filter[orders][creationDate][$le]',String(to));
    const j=await kfetch('/orders?'+q.toString());
    const rows=Array.isArray(j?.data)?j.data:[];out.push(...rows);pages++;
    totalCount=Math.max(totalCount,Number(j?.meta?.totalCount)||0);
    const pc=Math.max(1,Number(j?.meta?.pageCount)||1);
    if(page+1>=pc||rows.length<PAGE_SIZE)break;
  }
  return{state,rows:out,pages,totalCount};
}

async function scan(days){
  const now=Date.now();const windows=[];let to=now;let remain=days;
  while(remain>0){const span=Math.min(13,remain);const from=to-span*DAY+1;windows.push({from,to});to=from-1;remain-=span}
  const map=new Map();const diagnostics=[];
  for(const w of windows){
    const results=await Promise.allSettled(STATES.map(s=>listStateWindow(s,w.from,w.to)));
    for(const r of results){
      if(r.status==='rejected'){diagnostics.push({ok:false,error:errText(r.reason),from:w.from,to:w.to});continue}
      diagnostics.push({ok:true,state:r.value.state,rows:r.value.rows.length,pages:r.value.pages,totalCount:r.value.totalCount,from:w.from,to:w.to});
      for(const o of r.value.rows){const s=snap(o);if(!s.code||!s.stage)continue;const prev=map.get(s.code);if(!prev||s.creationDate>prev.creationDate)map.set(s.code,s)}
    }
  }
  return{orders:[...map.values()].sort((a,b)=>b.creationDate-a.creationDate),diagnostics};
}

module.exports=async function handler(req,res){
  res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');
  if(req.method==='OPTIONS')return res.status(204).end();
  if(req.method!=='GET'){res.setHeader('Allow','GET, OPTIONS');return res.status(405).json({ok:false,error:'Method not allowed'})}
  if(!token())return res.status(503).json({ok:false,error:'KASPI_API_TOKEN не настроен'});
  const days=Math.max(13,Math.min(78,Number.parseInt(req.query?.days,10)||52));
  const started=Date.now();
  try{
    const result=await scan(days);
    return res.status(200).json({ok:true,generatedAt:new Date().toISOString(),days,count:result.orders.length,orders:result.orders,diagnostics:result.diagnostics,durationMs:Date.now()-started});
  }catch(e){console.error('reconcile-orders',e);return res.status(502).json({ok:false,error:errText(e),durationMs:Date.now()-started})}
};
