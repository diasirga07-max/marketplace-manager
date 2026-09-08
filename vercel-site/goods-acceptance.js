(()=>{
'use strict';
if(window.GB_GOODS_ACCEPTANCE_LOADED)return;window.GB_GOODS_ACCEPTANCE_LOADED=true;
const $=s=>document.querySelector(s);
const esc=v=>String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
let lastResults=[];

function css(){
  if($('#gbAcceptCss'))return;
  const s=document.createElement('style');s.id='gbAcceptCss';s.textContent=`
#gbAccept{position:fixed;inset:58px 0 0;z-index:2147483400;background:#f5f7fa;display:none;overflow:auto;font-family:Inter,Arial,sans-serif;color:#101828}#gbAccept *{box-sizing:border-box}
.gaHead{position:sticky;top:0;z-index:20;background:#fff;border-bottom:1px solid #e4e7ec;padding:13px 18px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}.gaTitle{font-size:25px;font-weight:900}.gaSub{font-size:12px;color:#667085;margin-top:2px}.gaHeadLeft{margin-right:auto}.gaBtn{border:1px solid #d0d5dd;background:#fff;border-radius:11px;padding:10px 13px;font-weight:850;cursor:pointer;color:#101828}.gaBtn.dark{background:#111;color:#fff;border-color:#111}.gaBtn.primary{background:#12b76a;color:#fff;border-color:#12b76a}.gaBtn:disabled{opacity:.55;cursor:not-allowed}
.gaBody{padding:16px;max-width:1500px;margin:auto}.gaGrid{display:grid;grid-template-columns:minmax(360px,1fr) minmax(320px,.78fr);gap:14px}.gaCard{background:#fff;border:1px solid #e4e7ec;border-radius:18px;padding:15px}.gaCard h3{margin:0 0 10px;font-size:17px}.gaArea{width:100%;min-height:235px;border:1px solid #d0d5dd;border-radius:13px;padding:13px;font:700 16px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;resize:vertical;outline:none}.gaArea:focus{border-color:#667085;box-shadow:0 0 0 3px rgba(16,24,40,.06)}.gaRow{display:flex;gap:9px;align-items:center;flex-wrap:wrap;margin-top:10px}.gaFile{display:none}.gaHint{font-size:12px;color:#667085;line-height:1.45}.gaSpaces{width:84px;border:1px solid #d0d5dd;border-radius:10px;padding:9px;font-weight:800}.gaStatus{display:flex;align-items:center;gap:8px;padding:10px 12px;border-radius:12px;background:#f2f4f7;font-size:13px;font-weight:800}.gaDot{width:9px;height:9px;border-radius:50%;background:#98a2b3}.gaDot.ok{background:#12b76a}.gaDot.err{background:#f04438}.gaKpis{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin-top:12px}.gaKpi{background:#f9fafb;border:1px solid #eaecf0;border-radius:13px;padding:10px}.gaKpiL{font-size:10px;font-weight:850;text-transform:uppercase;color:#667085}.gaKpiV{font-size:24px;font-weight:950;margin-top:4px}.gaProgress{height:10px;background:#eaecf0;border-radius:999px;overflow:hidden;margin-top:12px}.gaProgress>i{display:block;height:100%;width:0;background:#12b76a;transition:width .2s}.gaMsg{display:none;margin-top:10px;border-radius:11px;padding:10px 12px;font-size:13px;font-weight:800}.gaMsg.show{display:block}.gaMsg.ok{background:#ecfdf3;color:#027a48}.gaMsg.warn{background:#fffaeb;color:#b54708}.gaMsg.err{background:#fef3f2;color:#b42318}
.gaTableBox{margin-top:14px;background:#fff;border:1px solid #e4e7ec;border-radius:18px;overflow:auto}.gaTable{width:100%;border-collapse:collapse;min-width:970px}.gaTable th{position:sticky;top:0;background:#f9fafb;text-align:left;padding:10px;font-size:11px;text-transform:uppercase;color:#667085}.gaTable td{padding:10px;border-top:1px solid #f2f4f7;font-size:13px;vertical-align:middle}.gaCode{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:900}.gaBadge{display:inline-flex;padding:5px 8px;border-radius:999px;font-size:11px;font-weight:900}.gaBadge.ok{background:#ecfdf3;color:#027a48}.gaBadge.warn{background:#fffaeb;color:#b54708}.gaBadge.err{background:#fef3f2;color:#b42318}.gaLink{display:inline-block;border:1px solid #d0d5dd;border-radius:9px;padding:7px 9px;font-weight:850;text-decoration:none;color:#101828;background:#fff}.gaFoot{font-size:11px;color:#667085;margin-top:10px}.gaDanger{font-size:11px;color:#b42318;font-weight:750;margin-top:8px}
@media(max-width:850px){#gbAccept{inset:52px 0 0}.gaGrid{grid-template-columns:1fr}.gaTitle{font-size:21px}.gaKpis{grid-template-columns:repeat(2,1fr)}.gaArea{min-height:180px}}
`;document.head.appendChild(s);
}

function nav(){
  if($('#gbAcceptNav'))return true;
  const e=[...document.querySelectorAll('button,a')];
  const ref=e.find(x=>/Мой склад/i.test(x.textContent||''))||e.find(x=>/Динамика продаж/i.test(x.textContent||''))||e.find(x=>/Прайс Kaspi/i.test(x.textContent||''))||e.find(x=>/Настройки/i.test(x.textContent||''));
  if(!ref?.parentElement)return false;
  const b=document.createElement('button');b.id='gbAcceptNav';b.className=ref.className;b.textContent='✅ Принятие товара';b.onclick=open;ref.parentElement.insertBefore(b,ref);return true;
}

function parseCodes(text){
  const src=String(text||'');
  const numeric=src.match(/\b\d{6,15}(?:-1)?\b/g)||[];
  const fallback=src.split(/[\n,;\t ]+/).map(x=>x.trim().replace(/^['"`]+|['"`,;]+$/g,'')).filter(Boolean);
  const list=numeric.length?numeric:fallback;
  return [...new Set(list.map(x=>String(x).trim()).filter(Boolean))];
}

function build(){
  css();let o=$('#gbAccept');if(o)return o;
  o=document.createElement('section');o.id='gbAccept';
  o.innerHTML=`<div class="gaHead"><div class="gaHeadLeft"><div class="gaTitle">Принятие товара</div><div class="gaSub">Список заказов → поиск в Kaspi → принятие → «Передача» → готовая накладная</div></div><button id="gaClose" class="gaBtn dark">Закрыть</button></div>
  <div class="gaBody"><div class="gaGrid"><div class="gaCard"><h3>1. Вставьте номера заказов</h3><textarea id="gaCodes" class="gaArea" placeholder="Например:\n1062047059-1\n1063163059-1\n1063688003-1"></textarea><div class="gaRow"><label class="gaBtn" for="gaFile">↑ Загрузить TXT / CSV</label><input id="gaFile" class="gaFile" type="file" accept=".txt,.csv,text/plain,text/csv"><button id="gaClear" class="gaBtn">Очистить</button><span id="gaCount" class="gaHint">0 заказов</span></div><div class="gaHint" style="margin-top:9px">Можно вставлять список из Excel одной колонкой. Дубли удаляются автоматически. Суффикс <b>-1</b> распознаётся: если Kaspi хранит номер без него, система попробует оба варианта.</div></div>
  <div class="gaCard"><h3>2. Принять и сформировать</h3><div id="gaApi" class="gaStatus"><span id="gaApiDot" class="gaDot"></span><span id="gaApiText">Проверяю подключение Kaspi API…</span></div><div class="gaRow"><label class="gaHint"><b>Количество мест / накладных:</b></label><input id="gaSpaces" class="gaSpaces" type="number" min="1" max="20" value="1"></div><button id="gaRun" class="gaBtn primary" style="width:100%;margin-top:12px;padding:14px">Принять заказы и сформировать накладные</button><div class="gaDanger">Кнопка реально меняет статусы заказов в Kaspi. Перед запуском будет подтверждение.</div><div id="gaMsg" class="gaMsg"></div><div class="gaProgress"><i id="gaBar"></i></div><div class="gaKpis"><div class="gaKpi"><div class="gaKpiL">Всего</div><div id="gaTotal" class="gaKpiV">0</div></div><div class="gaKpi"><div class="gaKpiL">Принято</div><div id="gaAccepted" class="gaKpiV">0</div></div><div class="gaKpi"><div class="gaKpiL">Накладных</div><div id="gaWaybills" class="gaKpiV">0</div></div><div class="gaKpi"><div class="gaKpiL">Ошибок</div><div id="gaFailed" class="gaKpiV">0</div></div><div class="gaKpi"><div class="gaKpiL">Обработано</div><div id="gaDone" class="gaKpiV">0</div></div><div class="gaKpi"><div class="gaKpiL">Осталось</div><div id="gaLeft" class="gaKpiV">0</div></div></div></div></div>
  <div class="gaRow" style="margin-top:14px"><button id="gaRetry" class="gaBtn" disabled>Повторить ошибки</button><button id="gaCopyLinks" class="gaBtn" disabled>Копировать ссылки на накладные</button></div><div class="gaTableBox"><table class="gaTable"><thead><tr><th>Заказ</th><th>Статус до</th><th>Принят</th><th>Передача</th><th>Накладная</th><th>Результат</th></tr></thead><tbody id="gaRows"><tr><td colspan="6" style="color:#667085">Результаты появятся после запуска.</td></tr></tbody></table></div><div class="gaFoot">Токен Kaspi хранится только в переменных окружения Vercel и не передаётся в браузер. Для каждого номера сервер сначала получает уникальный ID заказа через Kaspi Shop API v2.</div></div>`;
  document.body.appendChild(o);
  $('#gaClose').onclick=close;$('#gaCodes').oninput=updateCount;$('#gaClear').onclick=()=>{$('#gaCodes').value='';lastResults=[];updateCount();render([]);summary(0,0)};$('#gaFile').onchange=loadFile;$('#gaRun').onclick=run;$('#gaRetry').onclick=retry;$('#gaCopyLinks').onclick=copyLinks;
  health();updateCount();return o;
}

function showMsg(text,type='warn'){const m=$('#gaMsg');m.textContent=text;m.className='gaMsg show '+type}
function clearMsg(){const m=$('#gaMsg');m.className='gaMsg';m.textContent=''}
function updateCount(){const n=parseCodes($('#gaCodes')?.value).length;if($('#gaCount'))$('#gaCount').textContent=`${n} заказ${n===1?'':(n<5?'а':'ов')}`}
async function loadFile(e){const f=e.target.files&&e.target.files[0];if(!f)return;try{const t=await f.text();$('#gaCodes').value=[$('#gaCodes').value,t].filter(Boolean).join('\n');updateCount()}catch(err){showMsg('Не удалось прочитать файл: '+err.message,'err')}finally{e.target.value=''}}

async function health(){
  try{const r=await fetch('/api/accept-orders?_='+Date.now(),{cache:'no-store'}),j=await r.json();const ok=r.ok&&j.configured;$('#gaApiDot').className='gaDot '+(ok?'ok':'err');$('#gaApiText').textContent=ok?'Kaspi API подключен · токен на сервере':'Kaspi API: токен на Vercel не найден';$('#gaRun').disabled=!ok}
  catch(e){$('#gaApiDot').className='gaDot err';$('#gaApiText').textContent='Не удалось проверить Kaspi API';$('#gaRun').disabled=true}
}

function summary(total,done){
  const a=lastResults.filter(x=>x.accepted).length,w=lastResults.filter(x=>x.waybill).length,f=lastResults.filter(x=>!x.ok).length;
  $('#gaTotal').textContent=total;$('#gaAccepted').textContent=a;$('#gaWaybills').textContent=w;$('#gaFailed').textContent=f;$('#gaDone').textContent=done;$('#gaLeft').textContent=Math.max(0,total-done);$('#gaBar').style.width=(total?Math.round(done/total*100):0)+'%';
  $('#gaRetry').disabled=!lastResults.some(x=>!x.ok);$('#gaCopyLinks').disabled=!lastResults.some(x=>x.waybill);
}
function badge(text,type){return `<span class="gaBadge ${type}">${esc(text)}</span>`}
function render(results){
  const body=$('#gaRows');if(!body)return;
  if(!results.length){body.innerHTML='<tr><td colspan="6" style="color:#667085">Результаты появятся после запуска.</td></tr>';return}
  body.innerHTML=results.map(x=>{
    const accepted=x.accepted?badge('Да','ok'):badge('Нет',x.ok?'warn':'err');
    const assembled=x.assembled?badge('Да','ok'):badge('Нет',x.accepted?'warn':'err');
    const way=x.waybill?`<a class="gaLink" href="${esc(x.waybill)}" target="_blank" rel="noopener">↓ PDF${x.waybillNumber?' · '+esc(x.waybillNumber):''}</a>`:badge('Нет ссылки',x.ok?'warn':'err');
    const state=x.ok?badge(x.message||'Готово',x.waybill?'ok':'warn'):badge(x.message||x.error||'Ошибка','err');
    return `<tr><td class="gaCode">${esc(x.code||x.rawCode)}</td><td>${esc([x.statusBefore,x.stateBefore].filter(Boolean).join(' / ')||'—')}</td><td>${accepted}</td><td>${assembled}</td><td>${way}</td><td>${state}</td></tr>`;
  }).join('');
}

async function run(){
  const codes=parseCodes($('#gaCodes').value);if(!codes.length){showMsg('Вставьте номера заказов.','err');return}
  const spaces=Math.max(1,Math.min(20,parseInt($('#gaSpaces').value,10)||1));
  const yes=confirm(`Принять ${codes.length} заказ(ов) в Kaspi и сразу сформировать накладные?\n\nКоличество мест для каждого заказа: ${spaces}\n\nДействие изменит реальные статусы заказов.`);if(!yes)return;
  clearMsg();lastResults=[];render([]);summary(codes.length,0);$('#gaRun').disabled=true;$('#gaRun').textContent='Обрабатываю…';
  let done=0;
  try{
    for(let i=0;i<codes.length;i+=10){
      const chunk=codes.slice(i,i+10);
      const r=await fetch('/api/accept-orders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({codes:chunk,numberOfSpace:spaces,formWaybill:true})});
      let j={};try{j=await r.json()}catch{}
      if(!r.ok){const msg=j.error||`HTTP ${r.status}`;lastResults.push(...chunk.map(c=>({rawCode:c,code:c,ok:false,accepted:false,assembled:false,message:msg,error:msg})));}
      else lastResults.push(...(Array.isArray(j.results)?j.results:[]));
      done=Math.min(codes.length,i+chunk.length);render(lastResults);summary(codes.length,done);
    }
    const good=lastResults.filter(x=>x.waybill).length,accepted=lastResults.filter(x=>x.accepted).length,failed=lastResults.filter(x=>!x.ok).length;
    showMsg(`Готово: принято ${accepted} из ${codes.length}; накладных готово ${good}; ошибок ${failed}.`,failed?'warn':'ok');
  }catch(e){showMsg('Ошибка обработки: '+(e?.message||e),'err')}
  finally{$('#gaRun').disabled=false;$('#gaRun').textContent='Принять заказы и сформировать накладные';health()}
}
function retry(){const bad=lastResults.filter(x=>!x.ok).map(x=>x.rawCode||x.code).filter(Boolean);if(!bad.length)return;$('#gaCodes').value=bad.join('\n');updateCount();showMsg(`В список оставлено ${bad.length} заказ(ов) с ошибками. Нажмите кнопку запуска ещё раз.`,'warn')}
async function copyLinks(){const links=lastResults.filter(x=>x.waybill).map(x=>`${x.code||x.rawCode}\t${x.waybill}`).join('\n');if(!links)return;try{await navigator.clipboard.writeText(links);showMsg('Ссылки на накладные скопированы.','ok')}catch{showMsg('Не удалось скопировать ссылки.','err')}}
function open(){const o=build();o.style.display='block';health();setTimeout(()=>$('#gaCodes')?.focus(),30)}
function close(){$('#gbAccept')?.style.setProperty('display','none')}

build();nav();let tries=0;const timer=setInterval(()=>{if(nav()||++tries>30)clearInterval(timer)},700);
})();
