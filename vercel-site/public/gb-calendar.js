(()=>{
'use strict';
// GRANTS BOOK · Календарь. Встраивает Google Календарь (iframe calendar.google.com/calendar/embed).
// ID календаря хранится только в браузере (localStorage), в коде его нет.
// Закрытый календарь виден, если в этом браузере выполнен вход в Google-аккаунт с доступом к нему;
// публичный календарь виден всем.
if(window.GB_CALENDAR_LOADED)return;
window.GB_CALENDAR_LOADED=true;

const KEY='gbCalendarIds';
const MODES=[['MONTH','Месяц'],['WEEK','Неделя'],['AGENDA','Список']];
const TZ='Asia/Almaty';
const S={open:false,mode:'MONTH',overflow:''};

const $=(sel,root=document)=>root.querySelector(sel);
const esc=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function load(){try{const v=JSON.parse(localStorage.getItem(KEY)||'[]');return Array.isArray(v)?v.filter(x=>typeof x==='string'&&x.trim()):[]}catch{return []}}
function save(ids){try{localStorage.setItem(KEY,JSON.stringify(ids))}catch{}}
function parseIds(text){return [...new Set(String(text||'').split(/[\s,;]+/).map(x=>x.trim()).filter(Boolean))]}

function embedUrl(ids,mode){
  const q=new URLSearchParams({ctz:TZ,mode,wkst:'2',hl:'ru',showTitle:'0',showPrint:'0',showTz:'0',bgcolor:'#ffffff'});
  let s='https://calendar.google.com/calendar/embed?'+q.toString();
  for(const id of ids)s+='&src='+encodeURIComponent(id);
  return s;
}

function style(){
  if($('#gbCalendarStyle'))return;
  const s=document.createElement('style');s.id='gbCalendarStyle';
  s.textContent=`
#gbCalendar{position:fixed;inset:0;z-index:2147483000;background:#f9fafb;display:none;flex-direction:column;font-family:Arial,sans-serif;color:#101828}
#gbCalendar *{box-sizing:border-box}
.gcal-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:12px 16px;background:#fff;border-bottom:1px solid #eaecf0}
.gcal-title{font-size:20px;font-weight:800}.gcal-sp{flex:1}
.gcal-btn{border:1px solid #d0d5dd;background:#fff;border-radius:10px;padding:8px 12px;font-weight:700;cursor:pointer;color:#101828;text-decoration:none;font-size:13px}
.gcal-btn.on,.gcal-btn.dark{background:#101828;color:#fff;border-color:#101828}
.gcal-body{flex:1;min-height:0;padding:12px 16px;display:flex;flex-direction:column}
.gcal-frame{flex:1;width:100%;min-height:420px;border:1px solid #eaecf0;border-radius:12px;background:#fff}
.gcal-setup{max-width:560px;margin:24px auto;background:#fff;border:1px solid #eaecf0;border-radius:14px;padding:18px;line-height:1.5}
.gcal-setup textarea{width:100%;min-height:70px;padding:9px;border:1px solid #d0d5dd;border-radius:10px;font:inherit}
.gcal-note{font-size:12px;color:#667085;margin-top:8px}
@media(max-width:760px){.gcal-head{padding:10px}.gcal-title{font-size:18px}.gcal-body{padding:8px}.gcal-btn{padding:6px 9px;font-size:12px}}
`;
  document.head.appendChild(s);
}

let root=null;
function build(){
  style();if(root)return root;
  root=document.createElement('section');root.id='gbCalendar';root.setAttribute('aria-label','Календарь');
  root.innerHTML=`<div class="gcal-head"><div class="gcal-title">📅 Календарь</div>
    <div id="gcalModes">${MODES.map(([k,l])=>`<button class="gcal-btn" type="button" data-m="${k}">${l}</button>`).join(' ')}</div>
    <div class="gcal-sp"></div>
    <a class="gcal-btn" href="https://calendar.google.com/calendar/r" target="_blank" rel="noopener">Открыть Google Календарь ↗</a>
    <button class="gcal-btn" id="gcalSettings" type="button">⚙ Календари</button>
    <button class="gcal-btn dark" id="gcalClose" type="button">Закрыть</button></div>
    <div class="gcal-body" id="gcalMain"></div>`;
  document.body.appendChild(root);
  $('#gcalClose',root).onclick=close;
  $('#gcalSettings',root).onclick=()=>render(true);
  root.querySelectorAll('[data-m]').forEach(b=>b.onclick=()=>{S.mode=b.dataset.m;render()});
  return root;
}

function render(setup){
  const main=$('#gcalMain',root),ids=load();
  root.querySelectorAll('[data-m]').forEach(b=>b.classList.toggle('on',b.dataset.m===S.mode));
  if(setup||!ids.length){
    main.innerHTML=`<div class="gcal-setup"><b>Какие календари показывать?</b>
      <div class="gcal-note" style="margin:6px 0 10px">Укажите ID календаря: для основного это адрес Gmail, для другого — «Идентификатор календаря» из настроек Google Календаря (Настройки → нужный календарь → Интеграция календаря). Несколько — через запятую или с новой строки.</div>
      <textarea id="gcalIds" placeholder="name@gmail.com">${esc(ids.join('\n'))}</textarea>
      <div style="margin-top:10px;display:flex;gap:8px"><button class="gcal-btn dark" id="gcalSave" type="button">Сохранить</button>${ids.length?'<button class="gcal-btn" id="gcalCancel" type="button">Отмена</button>':''}</div>
      <div class="gcal-note">Список хранится только в этом браузере. Закрытый календарь отображается, если в браузере выполнен вход в Google-аккаунт с доступом к нему.</div></div>`;
    $('#gcalSave',main).onclick=()=>{const v=parseIds($('#gcalIds',main).value);save(v);render(!v.length)};
    const c=$('#gcalCancel',main);if(c)c.onclick=()=>render();
    return;
  }
  main.innerHTML=`<iframe class="gcal-frame" title="Google Календарь" src="${esc(embedUrl(ids,S.mode))}" frameborder="0" scrolling="no"></iframe>`;
}

function setUrl(open){try{const q=new URLSearchParams(location.search);if(open)q.set('gcal','1');else q.delete('gcal');const s=q.toString();history.replaceState(history.state,'',location.pathname+(s?'?'+s:'')+location.hash)}catch{}}
function open(){build();if(!S.open)S.overflow=document.body.style.overflow;S.open=true;root.style.display='flex';document.body.style.overflow='hidden';setUrl(true);render()}
function close(){S.open=false;if(root)root.style.display='none';document.body.style.overflow=S.overflow||'';setUrl(false)}

// «📅 Календарь» goes right after «🧻 Расходники» (fallback: after «Динамика продаж»).
function nav(force){
  if($('#gbCalendarNav'))return true;
  const all=[...document.querySelectorAll('button,a')];
  const ref=$('#gbConsumablesNav')||(force?(all.find(x=>/Динамика продаж/i.test(x.textContent||''))||all.find(x=>/Прайс Kaspi/i.test(x.textContent||''))):null);
  if(!ref||!ref.parentElement)return false;
  const b=document.createElement('button');b.id='gbCalendarNav';b.type='button';b.className=ref.className;b.classList.remove('on','active');b.textContent='📅 Календарь';b.onclick=()=>open();
  ref.parentElement.insertBefore(b,ref.nextSibling);return true;
}

window.GBCalendar={open,close};
let tries=0;const boot=setInterval(()=>{tries++;if(nav(tries>40)||tries>240)clearInterval(boot)},250);
if(new URLSearchParams(location.search).get('gcal')==='1')setTimeout(()=>open(),700);
window.addEventListener('keydown',e=>{if(e.key==='Escape'&&S.open)close()});
})();
