const KASPI_BASE=String(process.env.KASPI_API_BASE_URL||'https://kaspi.kz/shop/api/v2').replace(/\/$/,'');
const PAGE_SIZE=100;
const MAX_PAGES=10;
const CONCURRENCY=12;

function token(){return String(process.env.KASPI_API_TOKEN||process.env.KASPI_TOKEN||process.env.KASPI_API_KEY||'').trim()}
function clean(v){return String(v==null?'':v).trim().replace(/-1$/,'')}
function errText(e){return (e instanceof Error?e.message:String(e||'Ошибка')).slice(0,700)}
function sleep(ms){return new Promise(r=>setTimeout(r,ms))}

async function kfetch(path){
  const t=token();if(!t)throw Error('KASPI_API_TOKEN не настроен');
  let last;
  for(let attempt=0;attempt<3;attempt++){
    try{
      const r=await fetch(KASPI_BASE+path,{headers:{Accept:'application/vnd.api+json','Content-Type':'application/vnd.api+json','X-Auth-Token':t},cache:'no-store'});
      const text=await r.text();let j={};try{j=text?JSON.parse(text):{}}catch{j={raw:text.slice(0,300)}}
      if(!r.ok){const d=j?.errors?.[0]?.detail||j?.errors?.[0]?.title||j?.message||j?.error||'';const e=Error('Kaspi API '+r.status+(d?': '+d:''));e.status=r.status;throw e}
      return j;
    }catch(e){last=e;const s=Number(e?.status)||0;if(attempt===2||(s&&s!==429&&s<500))break;await sleep(300*(attempt+1))}
  }
  throw last||Error('Kaspi API недоступен');
}

function astanaDayBounds(now=Date.now()){
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Almaty',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(now));
  const p=Object.fromEntries(parts.map(x=>[x.type,x.value]));
  const y=+p.year,m=+p.month,d=+p.day;
  const start=Date.UTC(y,m-1,d,0,0,0)-5*3600000;
  return{key:`${p.year}-${p.month}-${p.day}`,start,end:Math.min(now,start+86400000-1)};
}
function timeAstana(ms){return new Intl.DateTimeFormat('ru-RU',{timeZone:'Asia/Almaty',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(Number(ms)||Date.now()))}
function stageOf(a){
  const status=String(a?.status||'').toUpperCase(),state=String(a?.state||'').toUpperCase();
  if(/COMPLETED|CANCELLED|CANCELLING|RETURNED|RETURN_REQUESTED/.test(status+' '+state))return'';
  if(/ASSEMBLE|TRANSFER|TRANSMIT|READY_FOR_DELIVERY/.test(status+' '+state))return'transfer';
  if(a?.preOrder===true&&/ACCEPTED_BY_MERCHANT/.test(status))return'preorder';
  if(/ACCEPTED_BY_MERCHANT|ARRIVED/.test(status))return'packing';
  return'';
}

async function listState(state,bounds){
  const all=[],included=new Map();
  for(let page=0;page<MAX_PAGES;page++){
    const q=new URLSearchParams();
    q.set('page[number]',String(page));q.set('page[size]',String(PAGE_SIZE));
    q.set('filter[orders][state]',state);
    q.set('filter[orders][creationDate][$ge]',String(bounds.start));
    q.set('filter[orders][creationDate][$le]',String(bounds.end));
    q.set('include[orders]','entries');
    let j;
    try{j=await kfetch('/orders?'+q.toString())}
    catch(e){
      if(page!==0)throw e;
      q.delete('include[orders]');
      j=await kfetch('/orders?'+q.toString());
    }
    const rows=Array.isArray(j?.data)?j.data:[];all.push(...rows);
    for(const x of Array.isArray(j?.included)?j.included:[])if(x?.type==='orderentries'&&x?.id)included.set(String(x.id),x);
    const pc=Math.max(1,Number(j?.meta?.pageCount)||1);if(page+1>=pc||rows.length<PAGE_SIZE)break;
  }
  return{orders:all,included};
}
async function listToday(bounds){
  const states=['KASPI_DELIVERY','NEW','PICKUP','DELIVERY'];
  const results=await Promise.allSettled(states.map(s=>listState(s,bounds)));
  const orderMap=new Map(),entryMap=new Map();let anyOk=false,lastErr=null;
  results.forEach(r=>{if(r.status==='fulfilled'){anyOk=true;for(const o of r.value.orders||[])if(o?.id)orderMap.set(String(o.id),o);for(const [id,e] of r.value.included||[])entryMap.set(id,e)}else lastErr=r.reason});
  if(!anyOk)throw lastErr||Error('Не удалось получить заказы Kaspi');
  return{orders:[...orderMap.values()],included:entryMap};
}

async function mapLimit(items,limit,fn){
  const out=new Array(items.length);let cur=0;
  async function run(){while(true){const i=cur++;if(i>=items.length)return;out[i]=await fn(items[i],i)}}
  await Promise.all(Array.from({length:Math.min(limit,items.length)},run));return out;
}

async function entriesFor(order,included){
  const refs=Array.isArray(order?.relationships?.entries?.data)?order.relationships.entries.data:[];
  const fromIncluded=refs.map(r=>included.get(String(r?.id||''))).filter(Boolean);
  if(refs.length&&fromIncluded.length===refs.length)return fromIncluded;
  const j=await kfetch('/orders/'+encodeURIComponent(String(order.id))+'/entries');
  return Array.isArray(j?.data)?j.data:[];
}

const merchantCache=new Map();
async function merchantForEntry(entry){
  const masterId=String(entry?.relationships?.product?.data?.id||'');
  if(!masterId)return{sku:'',name:''};
  if(!merchantCache.has(masterId))merchantCache.set(masterId,(async()=>{
    try{
      const j=await kfetch('/masterproducts/'+encodeURIComponent(masterId)+'/merchantProduct');
      const a=j?.data?.attributes||{};return{sku:clean(a.code),name:String(a.name||'').trim()};
    }catch(e){
      try{const j=await kfetch('/masterproducts/'+encodeURIComponent(masterId));const a=j?.data?.attributes||{};return{sku:clean(a.code),name:String(a.name||'').trim()}}catch{return{sku:'',name:''}}
    }
  })());
  return merchantCache.get(masterId);
}

async function enrichOrder(order,included){
  const a=order?.attributes||{},stage=stageOf(a);if(!stage)return null;
  let entries=[];try{entries=await entriesFor(order,included)}catch(e){console.warn('new-orders entries',clean(a.code),errText(e))}
  const items=await mapLimit(entries,CONCURRENCY,async e=>{
    const m=await merchantForEntry(e),ea=e?.attributes||{};
    return{sku:m.sku||String(e?.id||''),name:m.name||String(ea?.category?.title||'Товар'),qty:Math.max(1,Number(ea?.quantity)||1)};
  });
  return{id:String(order?.id||''),code:clean(a.code),creationDate:Number(a.creationDate)||0,time:timeAstana(a.creationDate),status:String(a.status||''),state:String(a.state||''),preorder:a.preOrder===true,stage,items:items.filter(x=>x.sku)};
}

module.exports=async function handler(req,res){
  res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Access-Control-Allow-Origin','*');
  if(req.method==='OPTIONS')return res.status(204).end();
  if(req.method!=='GET'){res.setHeader('Allow','GET, OPTIONS');return res.status(405).json({ok:false,error:'Method not allowed'})}
  if(!token())return res.status(503).json({ok:false,error:'KASPI_API_TOKEN не настроен'});
  const started=Date.now(),bounds=astanaDayBounds();
  try{
    const listed=await listToday(bounds);
    const active=listed.orders.filter(o=>stageOf(o?.attributes||{}));
    const enriched=(await mapLimit(active,CONCURRENCY,o=>enrichOrder(o,listed.included))).filter(Boolean).sort((a,b)=>b.creationDate-a.creationDate);
    return res.status(200).json({ok:true,date:bounds.key,generatedAt:new Date().toISOString(),count:enriched.length,orders:enriched,durationMs:Date.now()-started});
  }catch(e){console.error('new-orders',e);return res.status(502).json({ok:false,error:errText(e),date:bounds.key,durationMs:Date.now()-started})}
};
