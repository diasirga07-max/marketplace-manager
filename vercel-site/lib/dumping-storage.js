'use strict';
const crypto=require('node:crypto');
const { HEADERS, decodeRow,storeRow }=require('./dumping-core');
const ID=String(process.env.KASPI_SHEET_ID||process.env.GOOGLE_SHEET_ID||'1dLU5KOi3WBLy3uNEiqGv5rf9ka0OwcEw_RjhDQW3H1E').trim();
const TAB='ДЕМПИНГ';
const SCOPE='https://www.googleapis.com/auth/spreadsheets';
let tokenCache=null;
let lock=Promise.resolve();
function serial(job){const work=lock.then(job);lock=work.catch(()=>{});return work;}
function serviceAccount(){
  const raw=String(process.env.GOOGLE_SERVICE_ACCOUNT_JSON||'').trim();
  if(raw){const j=JSON.parse(raw);if(!j.client_email||!j.private_key)throw new Error('Google Service Account не настроен');return {email:j.client_email,key:String(j.private_key).replace(/\\n/g,'\n')};}
  const email=process.env.GOOGLE_SHEETS_CLIENT_EMAIL,key=process.env.GOOGLE_SHEETS_PRIVATE_KEY;
  if(!email||!key)throw new Error('Сервисный аккаунт Google Sheets не настроен');
  return {email,key:String(key).replace(/\\n/g,'\n')};
}
const b64=v=>Buffer.from(v).toString('base64url');
async function token(){
  if(tokenCache&&tokenCache.until>Date.now()+60000)return tokenCache.value;
  const sa=serviceAccount(),now=Math.floor(Date.now()/1000);
  const body=b64(JSON.stringify({iss:sa.email,scope:SCOPE,aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600}));
  const header=b64(JSON.stringify({alg:'RS256',typ:'JWT'}));const signing=header+'.'+body;
  const signature=crypto.sign('RSA-SHA256',Buffer.from(signing),sa.key);
  const assertion=signing+'.'+b64(signature);
  const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion}),signal:AbortSignal.timeout(12000)});
  if(!response.ok)throw new Error('Ошибка Google OAuth '+response.status);
  const j=await response.json();if(!j.access_token)throw new Error('Google OAuth не вернул токен');
  tokenCache={value:j.access_token,until:Date.now()+Number(j.expires_in||3600)*1000};return tokenCache.value;
}
async function request(path,method='GET',body=null){
  const key=await token();
  const r=await fetch('https://sheets.googleapis.com/v4/spreadsheets/'+encodeURIComponent(ID)+path,{method,headers:{Authorization:'Bearer '+key,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000),cache:'no-store'});
  if(!r.ok){console.error('Демпинг Google Sheets response status',r.status);throw new Error('Google Sheets недоступен ('+r.status+')');}
  return r.json();
}
function quoted(name){return "'"+name.replace(/'/g,"''")+"'";}
async function ensureSheet(){
  const metadata=await request('?fields=sheets(properties(title,sheetId))');
  if(metadata.sheets?.some(s=>s.properties?.title===TAB))return;
  try{
    await request(':batchUpdate','POST',{requests:[{addSheet:{properties:{title:TAB,gridProperties:{columnCount:11,rowCount:30000}}}}]});
  }catch(e){
    const fresh=await request('?fields=sheets(properties(title,sheetId))');
    if(!fresh.sheets?.some(s=>s.properties?.title===TAB))throw e;
  }
  await request('/values/'+encodeURIComponent(quoted(TAB)+'!A1:K1')+'?valueInputOption=RAW','PUT',{values:[HEADERS]});
}
async function readRows(){
  await ensureSheet();
  const body=await request('/values/'+encodeURIComponent(quoted(TAB)+'!A1:K30000'));
  const rows=Array.isArray(body.values)?body.values:[];
  if(rows.length&&rows[0].some((v,i)=>v!==HEADERS[i]))throw new Error('Заголовки листа ДЕМПИНГ отличаются от ожидаемых');
  return rows.slice(1).map((row,i)=>({index:i+2,...decodeRow(row)})).filter(r=>r.sku);
}
async function commit(updates){
  return serial(async()=>{
    const existing=await readRows();
    const mapped=new Map(existing.map(r=>[r.sku.normalize('NFKC').trim().toUpperCase()+'|'+r.city,r]));
    let index=existing.reduce((m,r)=>Math.max(m,r.index),1);
    const requests=[];
    for(const row of updates){
      const key=row.sku.normalize('NFKC').trim().toUpperCase()+'|'+row.city;
      const old=mapped.get(key);
      const target=old?.index || ++index;
      requests.push({range:quoted(TAB)+'!A'+target+':K'+target,values:[storeRow(row)]});
      mapped.set(key,{...row,index:target});
    }
    for(let i=0;i<requests.length;i+=400){
      await request('/values:batchUpdate','POST',{valueInputOption:'RAW',data:requests.slice(i,i+400)});
    }
    return {updated:updates.length};
  });
}
module.exports={ID,TAB,readRows,commit};

