(()=>{
  'use strict';
  if(window.GB_PRICE_EDITOR_LOADED)return;
  window.GB_PRICE_EDITOR_LOADED=true;

  const SHEET_ID='1dLU5KOi3WBLy3uNEiqGv5rf9ka0OwcEw_RjhDQW3H1E';
  const SHEET_NAME='Прайс KASPI';
  const SHEET_GID='1009783767';
  const TOTAL_ROWS=6366;
  const PAGE_SIZE=100;
  const DRAFT_KEY='gb_kaspi_price_draft_v1';
  const HEADERS=['Артикул WB','название','Цена оптовая','СПП / итоговая цена, ₸','Название товара','Продавец','Остаток','Дата обновления','маржа','Цена без доставки (₸) [расчет]','Доставка базовая KZ (₸) [расчет]','Доставка итог KZ (₸) [расчет]','Цена Kaspi (₸) [расчет]','Цена Kaspi округл. до 10 (₸)','Моя чистая прибыль (₸) [расчет]','Количество','Дни доставки','Ссылка товара КASPI','Категория','ВБ ссылка','Цена WB с наценкой','Продавец WB','Дней доставки','Дата доставки','Статус обновления','ФОТОГРАФИЯ ТОВАРОВ','Дни предзаказа база','Низкая цена Kaspi (₸)','Место GRANTS BOOK по цене','_PHOTO_URL_FOR_PRINT'];
  const LETTERS=Array.from({length:30},(_,i)=>{let n=i+1,s='';while(n){n--;s=String.fromCharCode(65+n%26)+s;n=Math.floor(n/26)}return s});
  const READONLY=new Set([9,10,11,12,13,14,25,29]);
  let page=0;
  let draft=loadDraft();
  let searchIndex=null;
  let searchMatches=[];
  let searchPos=-1;
  let requestSeq=0;
  let bodyOverflow='';

  function esc(v){return String(v??'').replace(/[&<>\"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[m]))}
  function loadDraft(){try{return JSON.parse(localStorage.getItem(DRAFT_KEY)||'{}')||{}}catch(_){return {}}}
  function saveDraft(){try{localStorage.setItem(DRAFT_KEY,JSON.stringify(draft))}catch(_){}updateDraftBadge()}
  function updateDraftBadge(){const e=document.getElementById('gbpeDraft');if(e)e.textContent='Изменено ячеек: '+Object.keys(draft).length}
  function key(r,c){return r+':'+c}
  function money(n){return new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0}).format(n)+' ₸'}
  function numText(n,d=2){return new Intl.NumberFormat('ru-RU',{maximumFractionDigits:d}).format(n)}
  function rawCell(c){return c&&c.v!=null?c.v:''}
  function formattedCell(c){return c&&c.f!=null?c.f:rawCell(c)}
  function jsonpRange(range){
    return new Promise((resolve,reject)=>{
      const cb='__gbPriceCb'+Date.now()+'_'+(++requestSeq);
      const s=document.createElement('script');
      let done=false;
      const clean=()=>{try{delete window[cb]}catch(_){}s.remove()};
      const timer=setTimeout(()=>{if(done)return;done=true;clean();reject(new Error('Таймаут Google Sheets'))},15000);
      window[cb]=(resp)=>{if(done)return;done=true;clearTimeout(timer);clean();resolve(resp)};
      s.onerror=()=>{if(done)return;done=true;clearTimeout(timer);clean();reject(new Error('Не удалось загрузить Google Sheets'))};
      s.src='https://docs.google.com/spreadsheets/d/'+SHEET_ID+'/gviz/tq?sheet='+encodeURIComponent(SHEET_NAME)+'&headers=0&range='+encodeURIComponent(range)+'&tqx='+encodeURIComponent('out:json;responseHandler:'+cb)+'&_='+Date.now();
      document.head.appendChild(s);
    });
  }
  function ensureStyle(){
    if(document.getElementById('gbpeStyle'))return;
    const st=document.createElement('style');st.id='gbpeStyle';st.textContent=`
#gbPriceOverlay{position:fixed;inset:58px 0 0;z-index:2147483000;background:#f4f6f8;display:none;flex-direction:column;color:#111;font-family:Inter,Arial,sans-serif}
#gbPriceOverlay *{box-sizing:border-box}
.gbpe-top{background:#fff;border-bottom:1px solid #dfe3e8;padding:14px 18px;display:flex;gap:12px;align-items:center;flex-wrap:wrap;box-shadow:0 4px 18px rgba(15,23,42,.05)}
.gbpe-title{font-size:24px;font-weight:850;margin-right:auto}.gbpe-sub{font-size:12px;color:#667085;font-weight:600;display:block;margin-top:2px}
.gbpe-btn{border:1px solid #d0d5dd;background:#fff;border-radius:11px;padding:9px 12px;font-weight:750;cursor:pointer;color:#101828}.gbpe-btn:hover{background:#f2f4f7}.gbpe-btn.primary{background:#111;color:#fff;border-color:#111}.gbpe-btn.danger{color:#b42318}
.gbpe-toolbar{padding:10px 18px;background:#fff;border-bottom:1px solid #e4e7ec;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.gbpe-search{min-width:330px;flex:1;max-width:650px;border:1px solid #d0d5dd;border-radius:10px;padding:9px 11px;font-size:14px}.gbpe-note{font-size:12px;color:#667085}.gbpe-badge{background:#eef4ff;color:#3538cd;border-radius:999px;padding:6px 10px;font-size:12px;font-weight:800}
.gbpe-gridwrap{flex:1;overflow:auto;padding:0 0 18px;background:#f8fafc;overscroll-behavior:contain}.gbpe-grid{border-collapse:separate;border-spacing:0;min-width:4700px;background:#fff;font-size:12px}
.gbpe-grid th,.gbpe-grid td{border-right:1px solid #eaecf0;border-bottom:1px solid #eaecf0;vertical-align:top}.gbpe-grid th{position:sticky;top:0;z-index:8;background:#f2f4f7;color:#344054;text-align:left;padding:8px 9px;height:56px;min-width:135px;max-width:260px;font-weight:800}.gbpe-grid th .l{display:block;color:#98a2b3;font-size:10px;margin-bottom:2px}.gbpe-grid th:nth-child(2){min-width:155px}.gbpe-grid th:nth-child(3){min-width:310px}.gbpe-grid th:nth-child(19),.gbpe-grid th:nth-child(21),.gbpe-grid th:nth-child(31){min-width:330px}
.gbpe-rownum{position:sticky;left:0;z-index:6;background:#f9fafb!important;color:#667085;font-weight:800;text-align:right;min-width:54px!important;width:54px!important;padding:9px 8px!important}.gbpe-grid thead .gbpe-rownum{z-index:12;top:0}
.gbpe-cell{min-height:34px;padding:8px 9px;outline:none;white-space:pre-wrap;overflow-wrap:anywhere;min-width:135px;background:#fff}.gbpe-cell[contenteditable=true]:focus{box-shadow:inset 0 0 0 2px #111;background:#fff}.gbpe-cell.dirty{background:#fff4cc}.gbpe-cell.readonly{background:#f9fafb;color:#667085}.gbpe-cell.calc{font-weight:700;background:#f8fafc}.gbpe-photo{width:78px;height:78px;object-fit:contain;border-radius:9px;background:#fff;border:1px solid #e4e7ec;display:block;margin:auto}.gbpe-photoempty{height:78px;display:flex;align-items:center;justify-content:center;color:#98a2b3}.gbpe-link{color:#1570ef;text-decoration:none}.gbpe-link:hover{text-decoration:underline}
.gbpe-highlight td{animation:gbpeFlash 1.6s ease}@keyframes gbpeFlash{0%,60%{background:#d1fadf}100%{background:inherit}}
@media(max-width:900px){#gbPriceOverlay{inset:54px 0 0}.gbpe-title{font-size:19px}.gbpe-search{min-width:180px}.gbpe-top,.gbpe-toolbar{padding-left:10px;padding-right:10px}}
`;
    document.head.appendChild(st);
  }
  function ensureNav(){
    if(document.getElementById('gbPriceNav'))return true;
    const all=[...document.querySelectorAll('button,a')];
    const ref=all.find(e=>/Настройки/i.test((e.textContent||'').trim()))||all.find(e=>/Штрихкоды/i.test((e.textContent||'').trim()))||all.find(e=>/Сканер/i.test((e.textContent||'').trim()));
    if(!ref||!ref.parentElement)return false;
    const b=document.createElement('button');b.id='gbPriceNav';b.type='button';b.className=ref.className;b.textContent='▦ Прайс Kaspi';b.title='Редактируемая копия листа Прайс KASPI';
    b.addEventListener('click',openEditor);
    if(/Настройки/i.test((ref.textContent||'')))ref.parentElement.insertBefore(b,ref);else ref.parentElement.appendChild(b);
    return true;
  }
  function buildOverlay(){
    ensureStyle();
    let o=document.getElementById('gbPriceOverlay');if(o)return o;
    o=document.createElement('div');o.id='gbPriceOverlay';
    o.innerHTML='<div class="gbpe-top"><div><div class="gbpe-title">Прайс KASPI</div><span class="gbpe-sub">Копия структуры листа GRANTS BOOK · 30 колонок · 6 366 строк</span></div><span id="gbpeDraft" class="gbpe-badge"></span><button id="gbpeDownload" class="gbpe-btn">↓ Изменения CSV</button><a class="gbpe-btn" target="_blank" rel="noopener" href="https://docs.google.com/spreadsheets/d/'+SHEET_ID+'/edit#gid='+SHEET_GID+'">Оригинал Google Sheet ↗</a><button id="gbpeReset" class="gbpe-btn danger">Сбросить черновик</button><button id="gbpeClose" class="gbpe-btn primary">Закрыть</button></div><div class="gbpe-toolbar"><input id="gbpeSearch" class="gbpe-search" placeholder="Поиск по артикулу или названию…"><button id="gbpeFind" class="gbpe-btn">Найти</button><button id="gbpeNextMatch" class="gbpe-btn">Следующее</button><span id="gbpeSearchInfo" class="gbpe-note"></span><span style="flex:1"></span><button id="gbpePrev" class="gbpe-btn">←</button><span id="gbpePage" class="gbpe-badge"></span><button id="gbpeNext" class="gbpe-btn">→</button><span class="gbpe-note">Черновик автосохраняется в этом браузере</span></div><div id="gbpeGrid" class="gbpe-gridwrap"><div style="padding:30px;color:#667085">Загрузка прайса…</div></div>';
    document.body.appendChild(o);
    document.getElementById('gbpeClose').onclick=closeEditor;
    document.getElementById('gbpePrev').onclick=()=>{if(page>0){page--;loadPage()}};
    document.getElementById('gbpeNext').onclick=()=>{if((page+1)*PAGE_SIZE<TOTAL_ROWS-1){page++;loadPage()}};
    document.getElementById('gbpeFind').onclick=doSearch;
    document.getElementById('gbpeNextMatch').onclick=nextMatch;
    document.getElementById('gbpeSearch').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();doSearch()}});
    document.getElementById('gbpeReset').onclick=resetDraft;
    document.getElementById('gbpeDownload').onclick=downloadChanges;
    updateDraftBadge();
    return o;
  }
  function openEditor(){const o=buildOverlay();bodyOverflow=document.body.style.overflow;document.body.style.overflow='hidden';o.style.display='flex';loadPage()}
  function closeEditor(){const o=document.getElementById('gbPriceOverlay');if(o)o.style.display='none';document.body.style.overflow=bodyOverflow}
  function pageRange(){const start=2+page*PAGE_SIZE;const end=Math.min(TOTAL_ROWS,start+PAGE_SIZE-1);return {start,end}}
  async function loadPage(focusRow){
    const g=document.getElementById('gbpeGrid');if(!g)return;
    const {start,end}=pageRange();
    document.getElementById('gbpePage').textContent='Строки '+start+'–'+end+' из '+TOTAL_ROWS;
    g.innerHTML='<div style="padding:30px;color:#667085">Загрузка строк '+start+'–'+end+'…</div>';
    try{
      const resp=await jsonpRange('A'+start+':AD'+end);
      renderGrid(resp,start,focusRow);
    }catch(e){g.innerHTML='<div style="padding:30px;color:#b42318"><b>Ошибка загрузки прайса.</b><br>'+esc(e.message||e)+'</div>'}
  }
  function renderGrid(resp,start,focusRow){
    const g=document.getElementById('gbpeGrid');
    const rows=resp&&resp.table&&Array.isArray(resp.table.rows)?resp.table.rows:[];
    let h='<table class="gbpe-grid"><thead><tr><th class="gbpe-rownum">#</th>';
    for(let c=0;c<HEADERS.length;c++)h+='<th><span class="l">'+LETTERS[c]+'</span>'+esc(HEADERS[c])+(READONLY.has(c)?' 🔒':'')+'</th>';
    h+='</tr></thead><tbody>';
    for(let i=0;i<rows.length;i++){
      const rnum=start+i,row=rows[i]||{},cells=row.c||[];
      h+='<tr data-row="'+rnum+'"><td class="gbpe-rownum">'+rnum+'</td>';
      for(let c=0;c<HEADERS.length;c++){
        const cell=cells[c]||null,raw=rawCell(cell),base=formattedCell(cell),k=key(rnum,c),has=Object.prototype.hasOwnProperty.call(draft,k),disp=has?draft[k]:base,ro=READONLY.has(c);
        const rawAttr=typeof raw==='number'?String(raw):'';
        if(c===25){
          const adKey=key(rnum,29),url=Object.prototype.hasOwnProperty.call(draft,adKey)?draft[adKey]:String(rawCell(cells[29]||null)||'');
          h+='<td><div class="gbpe-cell readonly" data-r="'+rnum+'" data-c="'+c+'">'+(url?'<img class="gbpe-photo" loading="lazy" src="'+esc(url)+'" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement(\'div\'),{className:\'gbpe-photoempty\',textContent:\'Нет фото\'}))">':'<div class="gbpe-photoempty">Нет фото</div>')+'</div></td>';
        }else{
          let val=esc(disp);
          if((c===17||c===19||c===29)&&String(disp||'').startsWith('http'))val='<a class="gbpe-link" href="'+esc(disp)+'" target="_blank" rel="noopener">'+esc(disp)+'</a>';
          h+='<td><div class="gbpe-cell '+(ro?'readonly ':'')+(c>=9&&c<=14?'calc ':'')+(has?'dirty ':'')+'" data-r="'+rnum+'" data-c="'+c+'" data-base="'+esc(base)+'" data-raw="'+esc(rawAttr)+'" '+(ro?'':'contenteditable="true" spellcheck="false"')+'>'+val+'</div></td>';
        }
      }
      h+='</tr>';
    }
    h+='</tbody></table>';g.innerHTML=h;
    g.querySelectorAll('.gbpe-cell[contenteditable=true]').forEach(el=>{el.addEventListener('input',onEdit);el.addEventListener('paste',e=>{e.preventDefault();document.execCommand('insertText',false,(e.clipboardData||window.clipboardData).getData('text/plain'))})});
    g.querySelectorAll('tbody tr').forEach(recalcRow);
    if(focusRow){setTimeout(()=>{const tr=g.querySelector('tr[data-row="'+focusRow+'"]');if(tr){tr.classList.add('gbpe-highlight');tr.scrollIntoView({block:'center'})}},50)}
  }
  function valueFromCell(tr,c){
    const el=tr.querySelector('.gbpe-cell[data-c="'+c+'"]');if(!el)return null;
    const k=key(Number(el.dataset.r),c);
    if(Object.prototype.hasOwnProperty.call(draft,k))return parseNumber(draft[k],c===3||c===4||c===8);
    if(el.dataset.raw!=='')return Number(el.dataset.raw);
    return parseNumber(el.textContent,c===3||c===4||c===8);
  }
  function parseNumber(v,isPercent){
    if(typeof v==='number')return Number.isFinite(v)?v:null;
    let s=String(v??'').trim();if(!s||/не найден/i.test(s))return null;
    const hasPct=s.includes('%');s=s.replace(/[₸%\s]/g,'');
    if(s.includes(',')&&s.includes('.'))s=s.replace(/\./g,'').replace(',','.');else if(s.includes(','))s=s.replace(',','.');
    const n=Number(s);if(!Number.isFinite(n))return null;return (hasPct||isPercent&&Math.abs(n)>1)?n/100:n;
  }
  function setCalc(tr,c,v,kind){
    const el=tr.querySelector('.gbpe-cell[data-c="'+c+'"]');if(!el||!Number.isFinite(v))return;
    el.textContent=kind==='money'?money(v):numText(v,2);el.dataset.raw=String(v);
  }
  function recalcRow(tr){
    const C=valueFromCell(tr,2),D=valueFromCell(tr,3),E=valueFromCell(tr,4),F=valueFromCell(tr,5),G=valueFromCell(tr,6),H=valueFromCell(tr,7),I=valueFromCell(tr,8);
    if([C,D,E,F,G,H,I].some(v=>v===null))return;
    const den=1-(D+E+I);if(!Number.isFinite(den)||den<=0)return;
    const J=(C+F+G+H)/den;
    const K=J<=1000?49:J<=3000?149:J<=5000?199:J<=10000?799:1299;
    const L=J>10000?1299:(J+K<=1000?49:J+K<=3000?149:J+K<=5000?199:J+K<=10000?799:1299);
    const M=J+L,N=Math.ceil(M/10)*10,O=M*(1-D-E)-(C+F+G+H+L);
    setCalc(tr,9,J,'money');setCalc(tr,10,K,'money');setCalc(tr,11,L,'money');setCalc(tr,12,M,'money');setCalc(tr,13,N,'money');setCalc(tr,14,O,'money');
  }
  function onEdit(e){
    const el=e.currentTarget,r=Number(el.dataset.r),c=Number(el.dataset.c),k=key(r,c),txt=el.textContent.trim(),base=String(el.dataset.base||'').trim();
    if(txt===base)delete draft[k];else draft[k]=txt;
    el.classList.toggle('dirty',Object.prototype.hasOwnProperty.call(draft,k));saveDraft();
    const tr=el.closest('tr');if(tr)recalcRow(tr);
  }
  async function loadSearchIndex(){
    if(searchIndex)return searchIndex;
    const info=document.getElementById('gbpeSearchInfo');if(info)info.textContent='Строю индекс поиска…';
    const resp=await jsonpRange('A2:B'+TOTAL_ROWS),rows=resp&&resp.table&&resp.table.rows||[];
    searchIndex=rows.map((r,i)=>{const c=r.c||[];return {row:i+2,text:(String(rawCell(c[0]||null))+' '+String(rawCell(c[1]||null))).toLowerCase()}});
    if(info)info.textContent='';return searchIndex;
  }
  async function doSearch(){
    const q=(document.getElementById('gbpeSearch').value||'').trim().toLowerCase(),info=document.getElementById('gbpeSearchInfo');
    if(!q){if(info)info.textContent='Введите артикул или название';return}
    try{const idx=await loadSearchIndex();searchMatches=idx.filter(x=>x.text.includes(q)).map(x=>x.row);searchPos=searchMatches.length?0:-1;if(info)info.textContent=searchMatches.length?'Найдено: '+searchMatches.length:'Ничего не найдено';if(searchPos>=0)goToMatch()}catch(e){if(info)info.textContent='Ошибка поиска'}
  }
  function nextMatch(){if(!searchMatches.length)return;searchPos=(searchPos+1)%searchMatches.length;goToMatch()}
  function goToMatch(){const r=searchMatches[searchPos];page=Math.floor((r-2)/PAGE_SIZE);const info=document.getElementById('gbpeSearchInfo');if(info)info.textContent='Совпадение '+(searchPos+1)+' из '+searchMatches.length+' · строка '+r;loadPage(r)}
  function resetDraft(){
    if(!Object.keys(draft).length)return;
    if(!confirm('Удалить все изменения черновика Прайс KASPI в этом браузере?'))return;
    draft={};saveDraft();loadPage();
  }
  function downloadChanges(){
    const entries=Object.entries(draft);if(!entries.length){alert('Изменений пока нет');return}
    const rows=[['Ячейка','Новое значение']];
    entries.sort((a,b)=>{const [ra,ca]=a[0].split(':').map(Number),[rb,cb]=b[0].split(':').map(Number);return ra-rb||ca-cb}).forEach(([k,v])=>{const [r,c]=k.split(':').map(Number);rows.push([LETTERS[c]+r,v])});
    const csv='\uFEFF'+rows.map(row=>row.map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(';')).join('\r\n');
    const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));a.download='price-kaspi-changes.csv';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
  }

  ensureStyle();
  if(!ensureNav()){
    let tries=0;const t=setInterval(()=>{tries++;if(ensureNav()||tries>30)clearInterval(t)},500);
  }
})();