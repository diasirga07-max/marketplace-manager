(()=>{
'use strict';
if(window.GB_GOODS_ACCEPTANCE_LOADED)return;
const OLD='https://raw.githubusercontent.com/diasirga07-max/marketplace-manager/d668d404642de4b4135d177612f0b10884d7d149/vercel-site/goods-acceptance.js';
const API='/api/accept-orders';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const esc=v=>String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
let safeResults=[];
let safeStop=false;

function parseCodes(text){
  const m=String(text||'').match(/\b\d{6,15}(?:-1)?\b/g)||[];
  return [...new Set(m.map(x=>x.trim()).filter(Boolean))];
}
function hashCodes(){
  const m=String(location.hash||'').match(/^#gbwaybills=(.*)$/i);
  if(!m)return [];
  try{return parseCodes(decodeURIComponent(m[1]).replace(/[,+]/g,'\n'))}catch{return []}
}
async function inspect(code){
  const r=await fetch(API+'?code='+encodeURIComponent(code)+'&_='+Date.now(),{cache:'no-store'});
  const j=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(j.error||('HTTP '+r.status));
  return j.order||null;
}
async function mutate(code,formWaybill,spaces){
  const r=await fetch(API,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({codes:[code],numberOfSpace:spaces,formWaybill}),cache:'no-store'});
  const j=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(j.error||('HTTP '+r.status));
  const x=Array.isArray(j.results)&&j.results[0]?j.results[0]:null;
  if(!x)throw new Error('Kaspi не вернул результат по заказу');
  return x;
}
function fromOrder(code,o,msg){
  return {rawCode:code,code:o?.code||code,statusBefore:o?.status||'',stateBefore:o?.state||'',preorder:!!(o?.preOrder||o?.preorder),accepted:true,arrived:o?.status==='ARRIVED',assembled:!!(o?.waybill||o?.status==='ASSEMBLE'),waybill:o?.waybill||'',waybillNumber:o?.waybillNumber||'',ok:!!o?.waybill,message:msg||''};
}
async function pollWaybill(code,tries=7){
  let last=null;
  for(let i=0;i<tries;i++){
    if(i)await sleep(1200);
    last=await inspect(code);
    if(last?.waybill)return last;
  }
  return last;
}
async function processOne(code,spaces){
  let o;
  try{o=await inspect(code)}catch(e){return {rawCode:code,code,ok:false,accepted:false,assembled:false,waybill:'',message:e.message,error:e.message}}
  if(!o)return {rawCode:code,code,ok:false,accepted:false,assembled:false,waybill:'',message:'Заказ не найден в Kaspi',error:'NOT_FOUND'};
  if(o.waybill)return fromOrder(code,o,'Накладная уже сформирована');
  const preorder=!!(o.preOrder||o.preorder);
  let last=null;

  // Для предзаказа сначала ставим «Прибыл» отдельным запросом и ждём,
  // чтобы Kaspi успел закрепить статус до запроса ASSEMBLE.
  if(preorder && String(o.status)==='ACCEPTED_BY_MERCHANT'){
    let arrived=false;
    let lastErr='';
    for(let a=0;a<3 && !safeStop;a++){
      try{
        last=await mutate(code,false,spaces);
        arrived=!!(last.arrived||last.ok);
        if(arrived)break;
        lastErr=last.message||last.error||'Kaspi не подтвердил «Прибыл»';
      }catch(e){lastErr=e.message}
      await sleep(2500+a*1200);
      try{o=await inspect(code);if(o?.status==='ARRIVED'){arrived=true;break}}catch{}
    }
    try{o=await inspect(code)}catch{}
    if(o?.waybill)return fromOrder(code,o,'Накладная сформирована');
    if(o?.status==='ARRIVED')arrived=true;
    if(!arrived){
      return {rawCode:code,code:o?.code||code,statusBefore:o?.status||'',stateBefore:o?.state||'',preorder:true,accepted:true,arrived:false,assembled:false,waybill:'',waybillNumber:'',ok:false,message:lastErr||'Kaspi не разрешил поставить «Прибыл»',error:lastErr||'ARRIVAL_NOT_ALLOWED'};
    }
    await sleep(2200);
  }

  for(let a=0;a<3 && !safeStop;a++){
    try{
      last=await mutate(code,true,spaces);
      if(last.waybill)return last;
      if(last.assembled){
        const p=await pollWaybill(code,7);
        if(p?.waybill)return fromOrder(code,p,'Передача → накладная сформирована');
        return {...last,ok:true,message:last.message||'Заказ в «Передача», Kaspi ещё готовит ссылку на накладную'};
      }
      if(last.ok){
        const p=await pollWaybill(code,5);
        if(p?.waybill)return fromOrder(code,p,'Накладная сформирована');
      }
    }catch(e){last={rawCode:code,code,ok:false,accepted:true,assembled:false,waybill:'',message:e.message,error:e.message}}
    await sleep(2500+a*1200);
    try{o=await inspect(code);if(o?.waybill)return fromOrder(code,o,'Накладная сформирована после повторной проверки')}catch{}
  }
  return last||{rawCode:code,code,ok:false,accepted:true,assembled:false,waybill:'',message:'Не удалось сформировать накладную',error:'WAYBILL_FAILED'};
}

function badge(text,type){return `<span class="gaBadge ${type}">${esc(text)}</span>`}
function renderSafe(){
  const b=document.querySelector('#gaRows');if(!b)return;
  if(!safeResults.length){b.innerHTML='<tr><td colspan="6" style="color:#667085">Результаты появятся после запуска.</td></tr>';return}
  b.innerHTML=safeResults.map(x=>{
    const accepted=x.accepted?badge('Да','ok'):badge('Нет',x.ok?'warn':'err');
    const transfer=x.assembled?badge('Да','ok'):badge('Нет',x.accepted?'warn':'err');
    const way=x.waybill?`<a class="gaLink" href="${esc(x.waybill)}" target="_blank" rel="noopener">↓ PDF${x.waybillNumber?' · '+esc(x.waybillNumber):''}</a>`:badge('Нет ссылки',x.ok?'warn':'err');
    const state=x.ok?badge(x.message||'Готово',x.waybill?'ok':'warn'):badge(x.message||x.error||'Ошибка','err');
    return `<tr><td class="gaCode">${esc(x.code||x.rawCode)}</td><td>${esc([x.statusBefore,x.stateBefore].filter(Boolean).join(' / ')||'—')}</td><td>${accepted}</td><td>${transfer}</td><td>${way}</td><td>${state}</td></tr>`;
  }).join('');
}
function summarySafe(total,done){
  const a=safeResults.filter(x=>x.accepted).length,w=safeResults.filter(x=>x.waybill).length,f=safeResults.filter(x=>!x.ok).length;
  const set=(id,v)=>{const e=document.querySelector(id);if(e)e.textContent=v};
  set('#gaTotal',total);set('#gaAccepted',a);set('#gaWaybills',w);set('#gaFailed',f);set('#gaDone',done);set('#gaLeft',Math.max(0,total-done));
  const bar=document.querySelector('#gaBar');if(bar)bar.style.width=(total?Math.round(done/total*100):0)+'%';
  const retry=document.querySelector('#gaRetry');if(retry)retry.disabled=!safeResults.some(x=>!x.ok);
  const copy=document.querySelector('#gaCopyLinks');if(copy)copy.disabled=!safeResults.some(x=>x.waybill);
}
function showSafe(text,type='warn'){
  const e=document.querySelector('#gaMsg');if(!e)return;e.textContent=text;e.className='gaMsg show '+type;
}
async function safeRun(){
  const area=document.querySelector('#gaCodes');
  const codes=parseCodes(area?.value);
  if(!codes.length){showSafe('Вставьте номера заказов.','err');return}
  const spaces=Math.max(1,Math.min(20,parseInt(document.querySelector('#gaSpaces')?.value,10)||1));
  if(!confirm(`Сформировать накладные для ${codes.length} заказов?\n\nПредзаказы будут обрабатываться последовательно: «Прибыл» → ожидание подтверждения → «Передача» → накладная.`))return;
  safeStop=false;safeResults=[];renderSafe();summarySafe(codes.length,0);
  const run=document.querySelector('#gaRun');if(run){run.disabled=true;run.textContent='Формирую накладные…'}
  const stop=document.querySelector('#gaStop');if(stop){stop.disabled=false;stop.textContent='⛔ Остановить'}
  let done=0;
  for(const code of codes){
    if(safeStop)break;
    const r=await processOne(code,spaces);
    safeResults.push(r);done++;renderSafe();summarySafe(codes.length,done);
    await sleep(900);
  }
  const w=safeResults.filter(x=>x.waybill).length,f=safeResults.filter(x=>!x.ok).length;
  showSafe(safeStop?`Остановлено: обработано ${done} из ${codes.length}.`:`Готово: накладных ${w}; требуют проверки ${f}; обработано ${done} из ${codes.length}.`,f?'warn':'ok');
  if(run){run.disabled=false;run.textContent='Принять заказы и сформировать накладные'}
}
function installSafe(){
  const run=document.querySelector('#gaRun');if(!run)return false;
  run.onclick=safeRun;
  const stop=document.querySelector('#gaStop');if(stop)stop.onclick=()=>{safeStop=true;showSafe('Остановка включена. Следующий заказ не будет отправлен.','warn');stop.disabled=true;stop.textContent='⛔ Остановлено'};
  const retry=document.querySelector('#gaRetry');if(retry)retry.onclick=()=>{const bad=safeResults.filter(x=>!x.ok).map(x=>x.rawCode||x.code).filter(Boolean);const a=document.querySelector('#gaCodes');if(a&&bad.length){a.value=bad.join('\n');a.dispatchEvent(new Event('input',{bubbles:true}));showSafe(`Оставлено ${bad.length} заказов для повторной попытки.`,'warn')}};
  const copy=document.querySelector('#gaCopyLinks');if(copy)copy.onclick=async()=>{const t=safeResults.filter(x=>x.waybill).map(x=>(x.code||x.rawCode)+'\t'+x.waybill).join('\n');if(!t)return;try{await navigator.clipboard.writeText(t);showSafe('Ссылки на накладные скопированы.','ok')}catch{showSafe('Не удалось скопировать ссылки.','err')}};
  return true;
}
function applyHashBatch(){
  const codes=hashCodes();if(!codes.length)return;
  try{history.replaceState(null,'',location.pathname+location.search)}catch{}
  const o=document.querySelector('#gbAccept');if(o)o.style.display='block';
  const a=document.querySelector('#gaCodes');if(a){a.value=codes.join('\n');a.dispatchEvent(new Event('input',{bubbles:true}))}
  showSafe(`Загружено ${codes.length} заказов. Подтвердите запуск — обработка пойдёт по одному заказу, чтобы Kaspi успевал фиксировать «Прибыл».`,'warn');
  setTimeout(()=>document.querySelector('#gaRun')?.click(),500);
}

fetch(OLD,{cache:'no-store'})
  .then(r=>{if(!r.ok)throw new Error('working acceptance '+r.status);return r.text()})
  .then(code=>{const s=document.createElement('script');s.id='gbAcceptanceKnownGoodRuntime';s.textContent=code;document.body.appendChild(s);let n=0;const t=setInterval(()=>{if(installSafe()||++n>40){clearInterval(t);if(n<=40)applyHashBatch()}},100)})
  .catch(e=>console.error('Known-good goods acceptance load failed',e));
})();
