(()=>{
'use strict';
if(window.GB_ORDERS_SOURCE_CONTROL_LOADED)return;
window.GB_ORDERS_SOURCE_CONTROL_LOADED=true;

const API_KEY='gbOrdersApiAutoEnabledV1';
const $=s=>document.querySelector(s);
let apiEnabled=false;
let originalLoadOrders=null;
let originalRenderOrders=null;
let patchTimer=null;
let uiTimer=null;
let recoveryLoading=null;
let recoveryLoaded=false;
let renderGuard=false;

function readApiState(){
  try{return localStorage.getItem(API_KEY)==='1'}catch{return false}
}
function saveApiState(v){
  try{localStorage.setItem(API_KEY,v?'1':'0')}catch{}
}
function records(){
  try{return window.GB_ORDER_EXCEL?.getRecords?.()||[]}catch{return[]}
}
function hasExcel(){return records().length>0}
function setExcelMode(v){window.GB_EXCEL_ORDER_MODE=!!v}
function currentSource(){return apiEnabled?'API':(hasExcel()?'Excel':'Нет данных')}

function renderNoExcel(){
  const ot=$('#ot');
  if(ot){
    const head=$('#orderHead');
    if(head)head.innerHTML='<th>Фото</th><th>Товар</th><th>Артикул</th><th>Кол-во</th><th>Заказы</th><th>Этапы</th>';
    ot.innerHTML='<tr><td colspan="6" style="padding:28px;text-align:center;color:#667085"><b>API автообновление выключено.</b><br>Загрузите выгрузку Excel, чтобы сформировать раздел «Заказы».</td></tr>';
  }
  ['#all','#pre','#pack','#trans','#ck','#cw','#ca'].forEach(id=>{const e=$(id);if(e)e.textContent='0'});
  const fresh=$('#fresh');if(fresh)fresh.textContent='Источник заказов: Excel · файл ещё не загружен';
}

function renderExcel(){
  if(!hasExcel()){renderNoExcel();return}
  setExcelMode(true);
  try{window.GB_ORDER_EXCEL?.render?.()}catch(e){console.warn('Excel orders render failed',e)}
}

function updateUI(){
  const b=$('#gbApiAutoToggle');
  if(b){
    b.textContent=apiEnabled?'🟢 API автообновление: ВКЛ':'⚪ API автообновление: ВЫКЛ';
    b.style.background=apiEnabled?'#ecfdf3':'#f2f4f7';
    b.style.color=apiEnabled?'#027a48':'#344054';
    b.style.borderColor=apiEnabled?'#abefc6':'#d0d5dd';
  }
  const s=$('#gbOrdersSourceStatus');
  if(s){
    s.textContent='Источник: '+currentSource();
    s.style.color=apiEnabled?'#027a48':(hasExcel()?'#175cd3':'#b54708');
  }
}

function ensureUI(){
  const fresh=$('#fresh');if(!fresh||!fresh.parentElement)return false;
  const host=fresh.parentElement;
  if(!$('#gbApiAutoToggle')){
    const b=document.createElement('button');
    b.id='gbApiAutoToggle';b.type='button';b.className='btn alt';
    b.style.cssText='margin-left:8px;border-width:1px;';
    b.addEventListener('click',()=>setApiEnabled(!apiEnabled,true));
    host.appendChild(b);
  }
  if(!$('#gbOrdersSourceStatus')){
    const s=document.createElement('span');s.id='gbOrdersSourceStatus';
    s.style.cssText='display:inline-block;margin-left:8px;font-size:11px;font-weight:900;white-space:nowrap';
    host.appendChild(s);
  }
  updateUI();return true;
}

function patchCore(){
  if(originalLoadOrders||typeof loadOrders!=='function'||typeof renderOrders!=='function')return false;
  originalLoadOrders=loadOrders;
  originalRenderOrders=renderOrders;

  loadOrders=async function(force=0){
    if(!apiEnabled){
      renderExcel();updateUI();
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
    if(!apiEnabled){renderGuard=true;try{return renderExcel()}finally{renderGuard=false}}
    setExcelMode(false);
    return originalRenderOrders.apply(this,args);
  };
  return true;
}

function cleanupRecoveryView(){
  if(apiEnabled)return;
  const ot=$('#ot');
  if(ot&&ot.querySelector('[data-gb-recovered], [data-gb-merged-order], [data-gb-merged-stage]'))renderExcel();
  $('#gbOrderRecoveryNotice')?.remove();
}

async function loadGuardedRecovery(){
  if(recoveryLoaded||recoveryLoading)return recoveryLoading;
  recoveryLoading=(async()=>{
    const base='https://raw.githubusercontent.com/diasirga07-max/marketplace-manager/main/public/';
    const load=async(name,id,transform)=>{
      if(document.getElementById(id))return;
      const r=await fetch(base+name+'?v=20260916-2',{cache:'no-store'});
      if(!r.ok)throw new Error(name+' '+r.status);
      let code=await r.text();
      if(transform)code=transform(code);
      const s=document.createElement('script');s.id=id;s.textContent=code;document.body.appendChild(s);
    };
    await load('gb-order-recovery.js','gbOrderRecoveryRuntimeGuarded',code=>{
      code=code.replace("'use strict';","'use strict';\nconst GB_API_ON=()=>window.GB_ORDER_API_AUTO_ENABLED===true;");
      code=code.replace('async function lookup(code,{persist=true}={}){','async function lookup(code,{persist=true}={}){if(!GB_API_ON())return null;');
      code=code.replace('function inject(){','function inject(){if(!GB_API_ON()){document.querySelectorAll(\'[data-gb-recovered]\').forEach(n=>n.remove());document.getElementById(\'gbOrderRecoveryNotice\')?.remove();return;}');
      code=code.replace('async function reconcileBulk(force=false){','async function reconcileBulk(force=false){if(!GB_API_ON())return {ok:false,disabled:true};');
      code=code.replace('function scheduleBulk(delay=700){','function scheduleBulk(delay=700){if(!GB_API_ON())return;');
      return code;
    });
    await load('gb-order-recovery-merge.js','gbOrderRecoveryMergeRuntimeGuarded',code=>{
      code=code.replace("'use strict';","'use strict';\nconst GB_API_ON=()=>window.GB_ORDER_API_AUTO_ENABLED===true;");
      code=code.replace('function merge(){','function merge(){if(!GB_API_ON())return;');
      return code;
    });
    recoveryLoaded=true;
  })().catch(e=>console.error('Guarded order recovery load failed',e)).finally(()=>{recoveryLoading=null});
  return recoveryLoading;
}

async function setApiEnabled(v,userAction=false){
  apiEnabled=!!v;
  window.GB_ORDER_API_AUTO_ENABLED=apiEnabled;
  saveApiState(apiEnabled);
  ensureUI();
  window.dispatchEvent(new CustomEvent('gb-orders-api-toggle',{detail:{enabled:apiEnabled}}));

  if(apiEnabled){
    setExcelMode(false);
    const s=$('#gbOrdersSourceStatus');if(s)s.textContent='Источник: API · обновляю…';
    await loadGuardedRecovery();
    if(originalLoadOrders){
      try{await originalLoadOrders(1);originalRenderOrders?.();}
      catch(e){console.error('API orders refresh failed',e);if(userAction)alert('Не удалось обновить заказы через API:\n'+String(e?.message||e))}
    }
    try{window.GB_RECONCILE_ORDERS?.()}catch{}
  }else{
    cleanupRecoveryView();
    renderExcel();
  }
  updateUI();
}

function watchExcelImport(){
  const st=$('#gbExcelImportStatus');
  if(st&&!st.__gbSourceWatch){
    st.__gbSourceWatch=true;
    new MutationObserver(()=>{
      const t=String(st.textContent||'');
      if(/^Готово:/.test(t)||/^Excel активен:/.test(t)){
        if(apiEnabled)setApiEnabled(false,false);else{setExcelMode(true);renderExcel();updateUI()}
      }
    }).observe(st,{childList:true,subtree:true,characterData:true});
  }
}

apiEnabled=readApiState();
window.GB_ORDER_API_AUTO_ENABLED=apiEnabled;

let tries=0;
patchTimer=setInterval(()=>{
  tries++;
  ensureUI();watchExcelImport();
  if(patchCore()){
    clearInterval(patchTimer);
    if(apiEnabled)setApiEnabled(true,false);else{setExcelMode(hasExcel());renderExcel();updateUI()}
  }else if(tries>240)clearInterval(patchTimer);
},250);

const mo=new MutationObserver(()=>{
  ensureUI();watchExcelImport();cleanupRecoveryView();
});
mo.observe(document.documentElement,{subtree:true,childList:true});

uiTimer=setInterval(()=>{ensureUI();cleanupRecoveryView()},2500);
window.GB_ORDER_SOURCE={
  isApiEnabled:()=>apiEnabled,
  setApiEnabled:v=>setApiEnabled(!!v,true),
  source:()=>currentSource(),
  renderExcel
};
})();
