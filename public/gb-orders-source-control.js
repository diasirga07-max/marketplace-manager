(()=>{
'use strict';
if(window.GB_ORDERS_SOURCE_CONTROL_LOADED)return;
window.GB_ORDERS_SOURCE_CONTROL_LOADED=true;

const API_KEY='gbOrdersApiAutoEnabledV1';
const $=s=>document.querySelector(s);
let apiEnabled=false;
let originalLoadOrders=null;
let originalRenderOrders=null;
let renderGuard=false;
let patchTimer=null;
let lastExcelCount=-1;

function readApiState(){
  try{return localStorage.getItem(API_KEY)==='1'}catch{return false}
}
function saveApiState(v){
  try{localStorage.setItem(API_KEY,v?'1':'0')}catch{}
}
function excelRecords(){
  try{return window.GB_ORDER_EXCEL?.getRecords?.()||[]}catch{return[]}
}
function hasExcel(){return excelRecords().length>0}
function setExcelMode(v){window.GB_EXCEL_ORDER_MODE=!!v}
function sourceName(){return apiEnabled?'API':(hasExcel()?'Excel':'Excel — файл не загружен')}
function setText(el,text){if(el&&el.textContent!==text)el.textContent=text}

function renderEmptyExcel(){
  const ot=$('#ot');
  if(ot){
    const head=$('#orderHead');
    const wantedHead='<th>Фото</th><th>Товар</th><th>Артикул</th><th>Кол-во</th><th>Заказы</th><th>Этапы</th>';
    if(head&&head.innerHTML!==wantedHead)head.innerHTML=wantedHead;
    if(!ot.querySelector('[data-gb-excel-empty="1"]')||ot.children.length!==1){
      ot.innerHTML='<tr data-gb-excel-empty="1"><td colspan="6" style="padding:28px;text-align:center;color:#667085"><b>API автообновление выключено.</b><br>Загрузите выгрузку Excel, чтобы сформировать раздел «Заказы».</td></tr>';
    }
  }
  ['#all','#pre','#pack','#trans','#ck','#cw','#ca'].forEach(id=>setText($(id),'0'));
  setText($('#fresh'),'Источник заказов: Excel · файл ещё не загружен');
}

function renderExcel(){
  setExcelMode(true);
  if(!hasExcel()){renderEmptyExcel();return}
  try{window.GB_ORDER_EXCEL?.render?.()}catch(e){console.warn('Excel orders render failed',e)}
}

function updateUI(){
  const b=$('#gbApiAutoToggle');
  if(b){
    setText(b,apiEnabled?'🟢 API автообновление: ВКЛ':'⚪ API автообновление: ВЫКЛ');
    const bg=apiEnabled?'#ecfdf3':'#f2f4f7';
    const fg=apiEnabled?'#027a48':'#344054';
    const border=apiEnabled?'#abefc6':'#d0d5dd';
    if(b.style.background!==bg)b.style.background=bg;
    if(b.style.color!==fg)b.style.color=fg;
    if(b.style.borderColor!==border)b.style.borderColor=border;
  }
  const s=$('#gbOrdersSourceStatus');
  if(s){
    setText(s,'Источник: '+sourceName());
    const c=apiEnabled?'#027a48':(hasExcel()?'#175cd3':'#b54708');
    if(s.style.color!==c)s.style.color=c;
  }
}

function ensureUI(){
  const fresh=$('#fresh');
  if(!fresh||!fresh.parentElement)return false;
  const host=fresh.parentElement;
  if(!$('#gbApiAutoToggle')){
    const b=document.createElement('button');
    b.id='gbApiAutoToggle';
    b.type='button';
    b.className='btn alt';
    b.style.cssText='margin-left:8px;border-width:1px;';
    b.addEventListener('click',()=>setApiEnabled(!apiEnabled,true));
    host.appendChild(b);
  }
  if(!$('#gbOrdersSourceStatus')){
    const s=document.createElement('span');
    s.id='gbOrdersSourceStatus';
    s.style.cssText='display:inline-block;margin-left:8px;font-size:11px;font-weight:900;white-space:nowrap';
    host.appendChild(s);
  }
  updateUI();
  return true;
}

function patchCore(){
  if(originalLoadOrders||typeof loadOrders!=='function'||typeof renderOrders!=='function')return false;
  originalLoadOrders=loadOrders;
  originalRenderOrders=renderOrders;

  loadOrders=async function(force=0){
    if(!apiEnabled){
      renderExcel();
      updateUI();
      return {ok:true,source:hasExcel()?'excel':'none',apiSkipped:true};
    }
    setExcelMode(false);
    const r=await originalLoadOrders(force);
    try{originalRenderOrders()}catch{}
    updateUI();
    return r;
  };

  renderOrders=function(...args){
    if(renderGuard)return;
    if(!apiEnabled){
      renderGuard=true;
      try{return renderExcel()}finally{renderGuard=false}
    }
    setExcelMode(false);
    return originalRenderOrders.apply(this,args);
  };
  return true;
}

async function setApiEnabled(v,userAction=false){
  apiEnabled=!!v;
  window.GB_ORDER_API_AUTO_ENABLED=apiEnabled;
  saveApiState(apiEnabled);
  ensureUI();

  if(apiEnabled){
    setExcelMode(false);
    setText($('#gbOrdersSourceStatus'),'Источник: API · обновляю…');
    if(originalLoadOrders){
      try{
        await originalLoadOrders(1);
        originalRenderOrders?.();
      }catch(e){
        console.error('API orders refresh failed',e);
        if(userAction)alert('Не удалось обновить заказы через API:\n'+String(e?.message||e));
      }
    }
  }else{
    renderExcel();
  }
  updateUI();
}

function pollExcelState(){
  ensureUI();
  const count=excelRecords().length;
  if(count!==lastExcelCount){
    const had=lastExcelCount;
    lastExcelCount=count;
    if(count>0&&had!==count){
      if(apiEnabled){
        setApiEnabled(false,false);
        return;
      }
      setExcelMode(true);
      renderExcel();
    }else if(count===0&&!apiEnabled){
      renderEmptyExcel();
    }
  }
  updateUI();
}

apiEnabled=readApiState();
window.GB_ORDER_API_AUTO_ENABLED=apiEnabled;

let tries=0;
patchTimer=setInterval(()=>{
  tries++;
  ensureUI();
  if(patchCore()){
    clearInterval(patchTimer);
    lastExcelCount=excelRecords().length;
    if(apiEnabled)setApiEnabled(true,false);else renderExcel();
    updateUI();
  }else if(tries>240){
    clearInterval(patchTimer);
  }
},250);

setInterval(pollExcelState,1500);
window.addEventListener('focus',pollExcelState);
document.addEventListener('click',e=>{
  if(e.target?.closest?.('#groups button')&&!apiEnabled)setTimeout(renderExcel,30);
},true);

window.GB_ORDER_SOURCE={
  isApiEnabled:()=>apiEnabled,
  setApiEnabled:v=>setApiEnabled(!!v,true),
  source:()=>sourceName(),
  renderExcel
};
})();
