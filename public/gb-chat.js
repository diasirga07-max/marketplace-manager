(()=>{
'use strict';
if(window.GB_CHAT_LOADED)return;
window.GB_CHAT_LOADED=true;

const CHAT_API='https://grants-book-kaspi-assistant-aex41sn9x-dias10.vercel.app/api/data?op=orders';
const REPLIES_KEY='gbChatReplies1';
const DEFAULT_REPLIES=[
  {id:'ru-thanks',label:'Спасибо за заказ',lang:'RU',text:'Здравствуйте! Благодарим за заказ. Если у вас есть вопросы по товару, с удовольствием поможем.'},
  {id:'ru-processing',label:'Заказ в обработке',lang:'RU',text:'Здравствуйте! Ваш заказ уже в обработке. Мы постараемся подготовить его как можно быстрее.'},
  {id:'ru-ready',label:'Заказ готов',lang:'RU',text:'Здравствуйте! Ваш заказ готов. Пожалуйста, ориентируйтесь на актуальный статус заказа в приложении Kaspi.'},
  {id:'ru-delay',label:'Задержка',lang:'RU',text:'Здравствуйте! Приносим извинения за задержку. Проверяем информацию по вашему заказу и постараемся решить вопрос как можно быстрее.'},
  {id:'ru-return',label:'Возврат',lang:'RU',text:'Здравствуйте! Пожалуйста, оформите возврат через приложение Kaspi в деталях заказа. После оформления возврата мы увидим заявку и сможем продолжить обработку.'},
  {id:'kz-thanks',label:'Тапсырысқа рақмет',lang:'KZ',text:'Сәлеметсіз бе! Тапсырысыңызға рақмет. Тауар бойынша сұрақтарыңыз болса, көмектесуге дайынбыз.'},
  {id:'kz-processing',label:'Тапсырыс өңделуде',lang:'KZ',text:'Сәлеметсіз бе! Тапсырысыңыз өңделіп жатыр. Оны мүмкіндігінше тезірек дайындауға тырысамыз.'},
  {id:'kz-delay',label:'Кешігу',lang:'KZ',text:'Сәлеметсіз бе! Кешігу үшін кешірім сұраймыз. Тапсырысыңыз бойынша ақпаратты тексеріп жатырмыз.'}
];

const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const load=(k,d)=>{try{const v=JSON.parse(localStorage.getItem(k)||'');return Array.isArray(v)?v:d}catch{return d}};
const save=(k,v)=>localStorage.setItem(k,JSON.stringify(v));
let chatOrders=[];
let selectedCode='';
let loading=false;

function getReplies(){
  const a=load(REPLIES_KEY,DEFAULT_REPLIES);
  return a.length?a:DEFAULT_REPLIES;
}
function normalizeCodes(v){
  if(Array.isArray(v))return v.flat(4).map(x=>String(x??'').trim()).filter(Boolean);
  return String(v??'').split(/[\s,;|]+/).map(x=>x.trim()).filter(Boolean);
}
function parseOrders(rows){
  const map=new Map();
  for(const o of rows||[]){
    const group=String(o?.group||'').trim();
    const sku=String(o?.sku||o?.article||o?.vendorCode||'').trim();
    const name=String(o?.name||o?.productName||sku||'').trim();
    const qty=Math.max(1,Number(o?.orders||o?.quantity||o?.qty||1)||1);
    const days=Math.max(0,Number(o?.days||0)||0);
    let codes=normalizeCodes(o?.kaspiOrderCodes||o?.orderCodes||o?.codes||o?.code||'');
    if(!codes.length&&o?.orderCode)codes=normalizeCodes(o.orderCode);
    for(const code0 of codes){
      const code=String(code0).trim();if(!code)continue;
      let z=map.get(code);
      if(!z){z={code,groups:new Set(),items:new Map(),days:0,customer:''};map.set(code,z)}
      if(group)z.groups.add(group);
      z.days=Math.max(z.days,days);
      z.customer=String(o?.customerName||o?.buyerName||o?.customer||z.customer||'').trim();
      const key=(sku||'')+'|'+(name||'');
      if(sku||name){
        const cur=z.items.get(key)||{sku,name,quantity:0};
        cur.quantity+=qty;
        z.items.set(key,cur);
      }
    }
  }
  return [...map.values()].map(z=>({
    code:z.code,
    group:[...z.groups].join(', '),
    items:[...z.items.values()],
    days:z.days,
    customer:z.customer
  })).sort((a,b)=>String(b.code).localeCompare(String(a.code),'ru',{numeric:true}));
}

function css(){
  if($('#gbChatCss'))return;
  const s=document.createElement('style');s.id='gbChatCss';s.textContent=`
#gbChat{position:fixed;inset:58px 0 0;z-index:2147483400;background:#f5f7fa;display:none;overflow:hidden;font-family:Inter,Arial,sans-serif;color:#101828}
#gbChat *{box-sizing:border-box}.chhead{height:68px;background:#fff;border-bottom:1px solid #e4e7ec;padding:12px 18px;display:flex;gap:10px;align-items:center}.chtitle{font-size:25px;font-weight:900;margin-right:auto}.chsub{font-size:11px;color:#667085;margin-top:2px}.chbtn{border:1px solid #d0d5dd;background:#fff;border-radius:11px;padding:9px 12px;font-weight:850;cursor:pointer;color:#101828}.chbtn.dark{background:#111;color:#fff;border-color:#111}.chbtn.green{background:#067647;color:#fff;border-color:#067647}.chbtn:disabled{opacity:.5;cursor:not-allowed}
.chbody{height:calc(100% - 68px);display:grid;grid-template-columns:minmax(330px,38%) 1fr;gap:0}.chleft{background:#fff;border-right:1px solid #e4e7ec;display:flex;flex-direction:column;min-width:0}.chsearchbox{padding:13px;border-bottom:1px solid #e4e7ec}.chsearch{width:100%;border:1px solid #d0d5dd;border-radius:11px;padding:11px 12px;font-size:15px;outline:none}.chstatus{font-size:11px;color:#667085;margin-top:7px;min-height:15px}.chstatus.ok{color:#027a48}.chstatus.err{color:#b42318}.chlist{overflow:auto;flex:1}.chrow{padding:12px 14px;border-bottom:1px solid #f2f4f7;cursor:pointer}.chrow:hover{background:#f9fafb}.chrow.sel{background:#f0f9ff;border-left:4px solid #1570ef;padding-left:10px}.chrowtop{display:flex;align-items:center;gap:8px}.chcode{font-size:15px;font-weight:900}.chbadge{font-size:10px;font-weight:850;padding:3px 6px;background:#f2f4f7;border-radius:999px;color:#475467}.chdays{margin-left:auto;font-size:10px;color:#667085}.chproducts{font-size:12px;color:#475467;margin-top:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.chempty{padding:45px 18px;text-align:center;color:#667085;font-size:13px}
.chright{overflow:auto;padding:18px}.chcard{background:#fff;border:1px solid #e4e7ec;border-radius:17px;padding:16px;max-width:1050px;margin:0 auto 14px}.chorderhead{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.chorderlabel{font-size:11px;color:#667085;text-transform:uppercase;font-weight:850}.chordernum{font-size:25px;font-weight:950}.chmeta{font-size:12px;color:#667085;margin-top:4px}.chitems{display:grid;gap:7px;margin-top:13px}.chitem{display:grid;grid-template-columns:minmax(100px,170px) 1fr auto;gap:9px;border-top:1px solid #f2f4f7;padding-top:8px;font-size:12px}.chsku{font-family:ui-monospace,monospace;font-weight:850}.chqty{font-weight:900}.chsection{font-size:15px;font-weight:900;margin:0 0 10px}.chreplies{display:flex;flex-wrap:wrap;gap:7px}.chreply{border:1px solid #d0d5dd;background:#fff;border-radius:999px;padding:7px 10px;font-size:12px;font-weight:800;cursor:pointer}.chreply:hover{background:#f9fafb}.chlang{font-size:9px;color:#667085;margin-right:5px}.chtext{width:100%;min-height:145px;resize:vertical;border:1px solid #d0d5dd;border-radius:12px;padding:12px;font:inherit;font-size:14px;line-height:1.45;outline:none;margin-top:12px}.chactions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}.chnote{margin-top:10px;padding:10px 12px;border-radius:10px;background:#fffaeb;color:#7a2e0e;font-size:11px;line-height:1.4}.chhint{padding:55px 20px;text-align:center;color:#667085}.chhint b{display:block;color:#101828;font-size:18px;margin-bottom:6px}
@media(max-width:820px){#gbChat{inset:52px 0 0}.chhead{height:auto;min-height:64px;flex-wrap:wrap}.chtitle{font-size:21px}.chbody{height:calc(100% - 88px);grid-template-columns:1fr}.chleft{height:44%;border-right:0;border-bottom:1px solid #e4e7ec}.chright{height:56%;padding:10px}.chitem{grid-template-columns:1fr}.chbtn{padding:8px 10px}.chsub{display:none}}
`;
  document.head.appendChild(s);
}

function nav(){
  if($('#gbChatNav'))return true;
  const wh=$('#gbWhNav');
  const nodes=[...document.querySelectorAll('button,a')];
  const ref=wh||nodes.find(x=>/Динамика продаж/i.test(x.textContent||''))||nodes.find(x=>/Прайс Kaspi/i.test(x.textContent||''))||nodes.find(x=>/Настройки/i.test(x.textContent||''));
  if(!ref?.parentElement)return false;
  const b=document.createElement('button');b.id='gbChatNav';b.className=ref.className;b.textContent='💬 Чаты';b.onclick=openChat;
  if(wh?.nextSibling)wh.parentElement.insertBefore(b,wh.nextSibling);else ref.parentElement.appendChild(b);
  return true;
}

function build(){
  css();let o=$('#gbChat');if(o)return o;
  o=document.createElement('section');o.id='gbChat';
  o.innerHTML=`<div class="chhead"><div><div class="chtitle">Чаты с клиентами</div><div class="chsub">Активные заказы + готовые ответы для быстрой работы с Kaspi</div></div><button id="chrefresh" class="chbtn">↻ Обновить</button><button id="chclose" class="chbtn dark">Закрыть</button></div><div class="chbody"><aside class="chleft"><div class="chsearchbox"><input id="chsearch" class="chsearch" placeholder="Номер заказа, артикул или товар" autocomplete="off"><div id="chstatus" class="chstatus"></div></div><div id="chlist" class="chlist"><div class="chempty">Загрузка заказов…</div></div></aside><main class="chright"><div id="chdetail" class="chcard"><div class="chhint"><b>Выберите заказ</b>Слева найдите номер заказа или товар.</div></div><div class="chcard"><div class="chsection">Готовые ответы</div><div id="chreplies" class="chreplies"></div><textarea id="chtext" class="chtext" placeholder="Выберите готовый ответ или напишите свой текст…"></textarea><div class="chactions"><button id="chcopy" class="chbtn green">Копировать ответ</button><button id="chsave" class="chbtn">+ Сохранить как шаблон</button><button id="chreset" class="chbtn">Сбросить шаблоны</button></div><div id="chcopystatus" class="chstatus"></div><div class="chnote">Ответ подготавливается здесь. Для реальной отправки откройте чат выбранного заказа в Kaspi Pay и вставьте скопированный текст — Kaspi не предоставляет этому сайту официальный API отправки сообщений.</div></div></main></div>`;
  document.body.appendChild(o);
  $('#chclose').onclick=closeChat;
  $('#chrefresh').onclick=refresh;
  $('#chsearch').oninput=renderList;
  $('#chcopy').onclick=copyReply;
  $('#chsave').onclick=saveReply;
  $('#chreset').onclick=resetReplies;
  renderReplies();
  return o;
}

function setStatus(text,type=''){
  const e=$('#chstatus');if(!e)return;e.className='chstatus'+(type?' '+type:'');e.textContent=text;
}
function setCopyStatus(text,type='ok'){
  const e=$('#chcopystatus');if(!e)return;e.className='chstatus'+(type?' '+type:'');e.textContent=text;
}
async function fetchOrders(){
  const r=await fetch(CHAT_API,{cache:'no-store',headers:{accept:'application/json'}});
  if(!r.ok)throw Error('Не удалось загрузить заказы: HTTP '+r.status);
  const d=await r.json();
  if(!Array.isArray(d?.orders))throw Error('Сервер не вернул список заказов');
  return parseOrders(d.orders);
}
async function refresh(){
  if(loading)return;loading=true;
  const b=$('#chrefresh');if(b)b.disabled=true;
  setStatus('Обновляю активные заказы…');
  try{
    chatOrders=await fetchOrders();
    if(selectedCode&&!chatOrders.some(x=>x.code===selectedCode))selectedCode='';
    setStatus('Загружено заказов: '+chatOrders.length,'ok');
    renderList();renderDetail();
  }catch(e){
    console.error('Chat orders load failed',e);setStatus(e.message||String(e),'err');
    const l=$('#chlist');if(l)l.innerHTML='<div class="chempty">Не удалось загрузить заказы. Нажмите «Обновить».</div>';
  }finally{loading=false;if(b)b.disabled=false}
}
function filteredOrders(){
  const q=String($('#chsearch')?.value||'').trim().toLowerCase();
  if(!q)return chatOrders;
  return chatOrders.filter(o=>{
    const items=o.items.map(i=>(i.sku+' '+i.name)).join(' ');
    return (o.code+' '+o.group+' '+o.customer+' '+items).toLowerCase().includes(q);
  });
}
function renderList(){
  const l=$('#chlist');if(!l)return;
  const a=filteredOrders();
  if(!a.length){l.innerHTML='<div class="chempty">Заказы по этому запросу не найдены.</div>';return}
  l.innerHTML=a.map(o=>{
    const summary=o.items.slice(0,2).map(i=>i.name||i.sku).filter(Boolean).join(' · ')+(o.items.length>2?' · ещё '+(o.items.length-2):'');
    return `<div class="chrow${o.code===selectedCode?' sel':''}" data-code="${esc(o.code)}"><div class="chrowtop"><span class="chcode">№ ${esc(o.code)}</span>${o.group?`<span class="chbadge">${esc(o.group)}</span>`:''}${o.days?`<span class="chdays">${esc(o.days)} дн.</span>`:''}</div><div class="chproducts">${esc(summary||'Товары заказа')}</div></div>`;
  }).join('');
  l.querySelectorAll('[data-code]').forEach(x=>x.onclick=()=>selectOrder(x.dataset.code));
}
function selectOrder(code){
  selectedCode=String(code||'');renderList();renderDetail();
}
function renderDetail(){
  const d=$('#chdetail');if(!d)return;
  const o=chatOrders.find(x=>x.code===selectedCode);
  if(!o){d.innerHTML='<div class="chhint"><b>Выберите заказ</b>Слева найдите номер заказа или товар.</div>';return}
  const items=o.items.length?o.items.map(i=>`<div class="chitem"><span class="chsku">${esc(i.sku||'—')}</span><span>${esc(i.name||i.sku||'Товар')}</span><span class="chqty">${i.quantity>1?'× '+esc(i.quantity):''}</span></div>`).join(''):'<div class="chmeta">Состав заказа не передан источником.</div>';
  d.innerHTML=`<div class="chorderhead"><div><div class="chorderlabel">Заказ Kaspi</div><div class="chordernum">№ ${esc(o.code)}</div></div><button id="chcopycode" class="chbtn" style="margin-left:auto">Копировать № заказа</button></div>${o.customer?`<div class="chmeta">Клиент: <b>${esc(o.customer)}</b></div>`:''}${o.group?`<div class="chmeta">Раздел: ${esc(o.group)}</div>`:''}<div class="chitems">${items}</div>`;
  $('#chcopycode').onclick=()=>copyText(o.code,'Номер заказа скопирован');
}
function renderReplies(){
  const h=$('#chreplies');if(!h)return;
  const a=getReplies();
  h.innerHTML=a.map((r,i)=>`<button class="chreply" data-reply="${i}"><span class="chlang">${esc(r.lang||'')}</span>${esc(r.label||('Шаблон '+(i+1)))}</button>`).join('');
  h.querySelectorAll('[data-reply]').forEach(b=>b.onclick=()=>{
    const r=getReplies()[Number(b.dataset.reply)];if(!r)return;
    const t=$('#chtext');if(t){t.value=String(r.text||'').replace(/\{order\}/g,selectedCode||'');t.focus();t.setSelectionRange(t.value.length,t.value.length)}
    setCopyStatus('Шаблон вставлен. Можно отредактировать текст.','ok');
  });
}
async function copyText(text,okText){
  text=String(text||'');if(!text)return false;
  try{
    if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(text);
    else{const t=document.createElement('textarea');t.value=text;t.style.position='fixed';t.style.opacity='0';document.body.appendChild(t);t.select();document.execCommand('copy');t.remove()}
    setCopyStatus(okText||'Скопировано','ok');return true;
  }catch(e){setCopyStatus('Не удалось скопировать. Выделите текст вручную.','err');return false}
}
function copyReply(){
  const t=String($('#chtext')?.value||'').trim();
  if(!t){setCopyStatus('Сначала выберите готовый ответ или напишите текст.','err');return}
  copyText(t,'✓ Ответ скопирован. Откройте чат заказа в Kaspi Pay и вставьте сообщение.');
}
function saveReply(){
  const text=String($('#chtext')?.value||'').trim();
  if(!text){setCopyStatus('Нет текста для сохранения.','err');return}
  const a=[...getReplies()];
  if(a.some(x=>String(x.text||'').trim()===text)){setCopyStatus('Такой шаблон уже сохранён.','err');return}
  const label=(prompt('Название шаблона:','Мой ответ')||'').trim();if(!label)return;
  a.push({id:'custom-'+Date.now(),label:label.slice(0,40),lang:'',text:text.slice(0,3000)});
  if(a.length>24)a.splice(DEFAULT_REPLIES.length,1);
  save(REPLIES_KEY,a);renderReplies();setCopyStatus('Шаблон сохранён.','ok');
}
function resetReplies(){
  if(!confirm('Вернуть стандартные готовые ответы и удалить свои шаблоны?'))return;
  save(REPLIES_KEY,DEFAULT_REPLIES);renderReplies();setCopyStatus('Стандартные шаблоны восстановлены.','ok');
}
function openChat(){
  const o=build();o.style.display='block';document.body.style.overflow='hidden';
  if(!chatOrders.length)refresh();else{renderList();renderDetail()}
  setTimeout(()=>$('#chsearch')?.focus(),30);
}
function closeChat(){const o=$('#gbChat');if(o)o.style.display='none';document.body.style.overflow=''}

let tries=0,t=setInterval(()=>{if(nav()||++tries>80)clearInterval(t)},250);
window.addEventListener('keydown',e=>{if(e.key==='Escape'&&$('#gbChat')?.style.display==='block')closeChat()});
})();
