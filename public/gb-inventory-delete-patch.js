(()=>{
'use strict';
if(window.GB_WAREHOUSE_DELETE_PATCH_LOADED)return;
window.GB_WAREHOUSE_DELETE_PATCH_LOADED=true;
const STOCK_KEY='gbWhStock1';
const HIST_KEY='gbWhHist1';
const norm=s=>String(s||'').trim().toUpperCase();
function load(key,def){try{return JSON.parse(localStorage.getItem(key)||'')||def}catch{return def}}
function save(key,val){localStorage.setItem(key,JSON.stringify(val))}
function escSelector(v){return String(v).replace(/([\\"'])/g,'\\$1')}
function addHistory(sku,name,qty){
  const h=load(HIST_KEY,[]);
  h.unshift({label:'Удалён товар · '+sku+(name?' · '+name:''),units:-Math.abs(Number(qty)||0),at:new Date().toISOString()});
  h.splice(50);
  save(HIST_KEY,h);
}
function removeSku(sku,name){
  sku=norm(sku);if(!sku)return;
  const st=load(STOCK_KEY,{}),x=st[sku];
  if(!x)return;
  const qty=Number(x.quantity)||0;
  if(!confirm('Удалить товар со склада?\n\n'+(name||x.name||sku)+'\nАртикул: '+sku+'\nКоличество: '+qty))return;
  delete st[sku];
  save(STOCK_KEY,st);
  addHistory(sku,name||x.name||'',qty);
  const q=document.getElementById('whq');
  if(q)q.dispatchEvent(new Event('input',{bubbles:true}));
}
function enhance(){
  const body=document.getElementById('whrows');if(!body)return;
  for(const row of body.querySelectorAll('tr')){
    const step=row.querySelector('.whstep');if(!step||step.querySelector('.whdelete'))continue;
    const plus=step.querySelector('[data-p]'),minus=step.querySelector('[data-m]');
    const sku=norm((plus&&plus.dataset.p)||(minus&&minus.dataset.m)||'');
    if(!sku)continue;
    const name=(row.querySelector('.whname')?.textContent||'').trim();
    const b=document.createElement('button');
    b.type='button';b.className='whmini whdelete';b.title='Удалить товар со склада';b.textContent='🗑';
    b.style.color='#b42318';b.style.borderColor='#fda29b';b.style.background='#fff5f4';b.style.marginLeft='4px';
    b.onclick=()=>removeSku(sku,name);
    step.appendChild(b);
  }
}
function speakWarehouse(text){
  try{
    if(!('speechSynthesis' in window)||typeof SpeechSynthesisUtterance==='undefined')return;
    window.speechSynthesis.cancel();
    const u=new SpeechSynthesisUtterance(text);
    u.lang='ru-RU';
    u.rate=1.03;
    u.pitch=1;
    u.volume=1;
    const voices=window.speechSynthesis.getVoices();
    const ru=voices.find(v=>/^ru(?:-|_)/i.test(v.lang||''))||voices.find(v=>/russian|рус/i.test(v.name||''));
    if(ru)u.voice=ru;
    window.speechSynthesis.speak(u);
  }catch(e){console.warn('Warehouse voice confirmation failed',e)}
}
function speakAdded(){speakWarehouse('Добавлено')}
function speakNotFound(){speakWarehouse('Не найдено')}
let msgObserver=null,lastVoiceKey='',lastVoiceAt=0;
function voiceOnce(key,fn){
  const t=Date.now();
  if(key===lastVoiceKey&&t-lastVoiceAt<800)return;
  lastVoiceKey=key;lastVoiceAt=t;fn();
}
function watchSuccessMessage(){
  const m=document.getElementById('whmsg');
  if(!m){setTimeout(watchSuccessMessage,300);return}
  if(msgObserver)return;
  msgObserver=new MutationObserver(()=>{
    const text=String(m.textContent||'').trim();
    if(m.classList.contains('ok')&&text.startsWith('✓'))voiceOnce('added:'+text,speakAdded);
    else if(m.classList.contains('err')&&/не\s+найд/i.test(text))voiceOnce('notfound:'+text,speakNotFound);
  });
  msgObserver.observe(m,{childList:true,characterData:true,subtree:true,attributes:true,attributeFilter:['class']});
}
const mo=new MutationObserver(enhance);
function start(){
  enhance();
  watchSuccessMessage();
  const body=document.getElementById('whrows');
  if(body)mo.observe(body,{childList:true,subtree:true});
  else setTimeout(start,300);
}
start();
})();
