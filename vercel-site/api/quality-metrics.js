const KASPI_BASE = String(process.env.KASPI_API_BASE_URL || 'https://kaspi.kz/shop/api/v2').replace(/\/$/, '');
const PAGE_SIZE = 100;
const MAX_PAGES = 80;

function token(){return String(process.env.KASPI_API_TOKEN||process.env.KASPI_TOKEN||process.env.KASPI_API_KEY||'').trim()}
function clean(v){return String(v==null?'':v).trim()}
function publicError(e){return (e instanceof Error?e.message:String(e||'Ошибка')).replace(/X-Auth-Token\s*[:=]\s*\S+/gi,'X-Auth-Token: ***').slice(0,700)}
function cors(req,res){
  const origin=String(req.headers?.origin||'');
  if(origin)res.setHeader('Access-Control-Allow-Origin',origin);
  res.setHeader('Vary','Origin');
  res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
}
async function kfetch(path){
  const r=await fetch(KASPI_BASE+path,{headers:{Accept:'application/vnd.api+json','Content-Type':'application/vnd.api+json','X-Auth-Token':token()},cache:'no-store'});
  const t=await r.text();let j={};try{j=t?JSON.parse(t):{}}catch{j={raw:t.slice(0,500)}}
  if(!r.ok)throw new Error('Kaspi API HTTP '+r.status+': '+(j?.message||j?.errors?.[0]?.detail||j?.errors?.[0]?.title||''));
  return j;
}
function dfltRange(){
  const now=new Date(Date.now()+5*3600000);
  const end=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()-1));
  const start=new Date(Date.UTC(end.getUTCFullYear(),end.getUTCMonth(),end.getUTCDate()-29));
  const f=d=>d.toISOString().slice(0,10);
  return {from:f(start),to:f(end)};
}
function msStart(d){return Date.parse(String(d)+'T00:00:00+05:00')}
function msEnd(d){return Date.parse(String(d)+'T23:59:59.999+05:00')}
async function listOrders(fromMs,toMs){
  const out=[];
  for(let p=0;p<MAX_PAGES;p++){
    const q=new URLSearchParams();
    q.set('page[number]',String(p));
    q.set('page[size]',String(PAGE_SIZE));
    q.set('filter[orders][creationDate][$ge]',String(fromMs));
    q.set('filter[orders][creationDate][$le]',String(toMs));
    const j=await kfetch('/orders?'+q.toString());
    const a=Array.isArray(j?.data)?j.data:[];
    out.push(...a);
    if(a.length<PAGE_SIZE)break;
  }
  return out;
}
function summarize(orders){
  const status={},state={},reason={},sellerReason={};
  for(const o of orders){
    const a=o?.attributes||{};
    const st=clean(a.status)||'—',ss=clean(a.state)||'—',rr=clean(a.cancellationReason)||'—';
    status[st]=(status[st]||0)+1;state[ss]=(state[ss]||0)+1;
    if(st==='CANCELLED'||ss==='ARCHIVE')reason[rr]=(reason[rr]||0)+1;
  }
  return {status,state,cancellationReasons:reason};
}
module.exports=async function handler(req,res){
  cors(req,res);res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, max-age=0');
  if(req.method==='OPTIONS')return res.status(204).end();
  if(req.method!=='GET')return res.status(405).json({ok:false,error:'Method not allowed'});
  if(!token())return res.status(503).json({ok:false,error:'KASPI_API_TOKEN is not configured'});
  try{
    const d=dfltRange(),from=clean(req.query?.from)||d.from,to=clean(req.query?.to)||d.to;
    const fromMs=msStart(from),toMs=msEnd(to);
    if(!Number.isFinite(fromMs)||!Number.isFinite(toMs)||fromMs>toMs)return res.status(400).json({ok:false,error:'Bad date range'});
    const orders=await listOrders(fromMs,toMs);
    const summary=summarize(orders);
    return res.status(200).json({ok:true,version:'quality-metrics-debug-v1',from,to,fromMs,toMs,totalOrders:orders.length,...summary});
  }catch(e){return res.status(502).json({ok:false,error:publicError(e)})}
};