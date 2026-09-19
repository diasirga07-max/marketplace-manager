const crypto = require('node:crypto');

const SPREADSHEET_ID = process.env.GOOGLE_WB_SPREADSHEET_ID || '1dLU5KOi3WBLy3uNEiqGv5rf9ka0OwcEw_RjhDQW3H1E';
const SHEET_NAME = 'Ссылки на товары ВБ';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const VERSION = 'GB WB links v1';
let tokenCache = null;
let dataCache = { exp: 0, map: {} };

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
}
function send(res,status,body){cors(res);return res.status(status).json(body)}
function b64url(value){return Buffer.from(value).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_')}
function getServiceAccount(){
  const raw=String(process.env.GOOGLE_SERVICE_ACCOUNT_JSON||'').trim();
  if(raw){
    const p=JSON.parse(raw);
    if(!p.client_email||!p.private_key)throw new Error('Service Account JSON missing client_email/private_key');
    return{email:p.client_email,key:String(p.private_key).replace(/\\n/g,'\n')};
  }
  const email=String(process.env.GOOGLE_SHEETS_CLIENT_EMAIL||'').trim();
  const key=String(process.env.GOOGLE_SHEETS_PRIVATE_KEY||'').replace(/\\n/g,'\n').trim();
  if(!email||!key)throw new Error('Google Sheets service account is not configured');
  return{email,key};
}
async function googleToken(){
  if(tokenCache&&tokenCache.exp>Date.now()+60000)return tokenCache.token;
  const sa=getServiceAccount(),now=Math.floor(Date.now()/1000);
  const head=b64url(JSON.stringify({alg:'RS256',typ:'JWT'}));
  const claims=b64url(JSON.stringify({iss:sa.email,scope:GOOGLE_SCOPE,aud:GOOGLE_TOKEN_URL,iat:now,exp:now+3600}));
  const unsigned=`${head}.${claims}`;
  const signer=crypto.createSign('RSA-SHA256');signer.update(unsigned);signer.end();
  const assertion=`${unsigned}.${b64url(signer.sign(sa.key))}`;
  const r=await fetch(GOOGLE_TOKEN_URL,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion}),cache:'no-store'});
  const j=await r.json().catch(()=>({}));
  if(!r.ok||!j.access_token)throw new Error(`Google OAuth ${r.status}: ${j.error_description||j.error||'token error'}`);
  tokenCache={token:j.access_token,exp:Date.now()+Number(j.expires_in||3600)*1000};return tokenCache.token;
}
async function loadMap(){
  if(dataCache.exp>Date.now())return dataCache.map;
  const token=await googleToken();
  const range=`'${SHEET_NAME.replace(/'/g,"''")}'!A:B`;
  const url=`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(SPREADSHEET_ID)}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`;
  const r=await fetch(url,{headers:{Authorization:`Bearer ${token}`},cache:'no-store'});
  const j=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(`Google Sheets ${r.status}: ${j?.error?.message||'read error'}`);
  const map={};
  for(const row of (j.values||[])){
    const sku=String(row?.[0]??'').trim().toUpperCase();
    const link=String(row?.[1]??'').trim();
    if(!sku||!/^https?:\/\/(?:www\.)?wildberries\.ru\//i.test(link))continue;
    map[sku]=link;
  }
  dataCache={map,exp:Date.now()+5*60*1000};
  return map;
}

module.exports=async function handler(req,res){
  cors(res);
  if(req.method==='OPTIONS')return res.status(204).end();
  if(req.method!=='GET'){res.setHeader('Allow','GET, OPTIONS');return send(res,405,{ok:false,error:'Method not allowed'});}
  try{
    const map=await loadMap();
    const sku=String(req.query?.sku||'').trim().toUpperCase();
    if(sku)return send(res,200,{ok:true,version:VERSION,sku,url:map[sku]||''});
    return send(res,200,{ok:true,version:VERSION,count:Object.keys(map).length,links:map});
  }catch(error){
    console.error('wb-links failed',error);
    return send(res,500,{ok:false,version:VERSION,error:error instanceof Error?error.message:String(error)});
  }
};
