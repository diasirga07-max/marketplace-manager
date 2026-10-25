(()=>{
'use strict';
if(window.GB_DUMPING_LOADED)return;window.GB_DUMPING_LOADED=true;
const $=id=>document.getElementById(id);
const st={city:'Астана',page:1,size:50,search:'',published:'',category:'',sort:'dumping',total:0,rows:[],previewToken:''};
const money=v=>v==null?'Нет данных':new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(Number(v))+' ₸';
const node=(tag,cls,value)=>{const x=document.createElement(tag);if(cls)x.className=cls;if(value!=null)x.textContent=String(value);return x;};
async function api(op,method,body,query={}){
 const u=new URL('/api/dumping',location.origin);u.searchParams.set('op',op);u.searchParams.set('city',st.city);
 for(const [key,value] of Object.entries(query))if(value!=null&&value!=='')u.searchParams.set(key,value);
 const response=await window.fetch(u.toString(),{method:method||'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,cache:'no-store'});
 if(op==='export'&&response.ok)return response.blob();
 const result=await response.json().catch(()=>({ok:false,error:'Ответ сервера не является JSON'}));
 if(!response.ok||!result.ok)throw Error(result.error||'Ошибка '+response.status);
 return result;
}
let section,searchTimer,requestSeq=0;
function navigation(){
 if($('gbDumpingNav'))return true;
 const button=[...document.querySelectorAll('button,a')].find(x=>/Прайс Kaspi|Динамика продаж|Настройки/i.test(x.textContent||''));
 if(!button||!button.parentElement)return false;
 const item=node('button',button.className,'📉 Демпинг');item.id='gbDumpingNav';item.type='button';item.onclick=open;button.parentElement.insertBefore(item,button);return true;
}
function init(){
 if(section)return;
 const style=node('style');style.id='gbDumpingStyle';style.textContent="#gbDumping{position:fixed;inset:56px 0 0;z-index:2147483210;background:#f5f7fb;color:#192335;font:13px Inter,Arial,sans-serif;overflow:auto;display:none}#gbDumping *{box-sizing:border-box}#gbDumping header{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:17px 24px;background:white;border-bottom:1px solid #e4eaf3;position:sticky;top:0;z-index:10}#gbDumping h1{font-size:24px;margin:0}#gbDumping .sub{font-size:12px;color:#7b8ba0;margin-top:5px}#gbDumping button{cursor:pointer}#gbDumping button:disabled{opacity:.45;cursor:default}#gbDumping .btn{border:1px solid #d6deeb;background:#fff;color:#1c3150;font:inherit;font-weight:750;padding:9px 12px;border-radius:10px}#gbDumping .primary{background:#173b92;color:#fff;border-color:#173b92}#gbDumping .actions,#gbDumping .filters{display:flex;gap:8px;flex-wrap:wrap;align-items:center}#gbDumping .inner{max-width:1750px;padding:20px;margin:auto}#gbDumping .tabs{display:flex;gap:8px;margin-bottom:14px}#gbDumping .tabs button{border:0;border-radius:9px;padding:10px 16px;background:#e6eaf3;color:#536176;font:inherit;font-weight:800}#gbDumping .tabs .selected{background:#173b92;color:#fff}#gbDumping .panel{border:1px solid #e3e8f1;border-radius:16px;background:white;overflow:hidden;box-shadow:0 6px 20px #142d4908}#gbDumping .filters{padding:16px;border-bottom:1px solid #eaf0f7}#gbDumping input:not([type=checkbox]),#gbDumping select,#gbDumping textarea{font:inherit;border:1px solid #d8e0ec;border-radius:8px;padding:9px;max-width:100%;background:white;color:#1c2d47}#gbDumping input:focus,#gbDumping select:focus,#gbDumping textarea:focus{outline:2px solid #b4caf6}#gbDumping .search{min-width:190px;flex:1 1 240px}#gbDumping .muted{font-size:11px;color:#8390a2;margin-top:4px}#gbDumping .hint{padding:11px 16px;font-size:12px;color:#7f8ca0}#gbDumping .warn{display:none;margin:10px 15px;padding:11px;border:1px solid #eed18a;border-radius:9px;background:#fff7e5;color:#8c6200}#gbDumping .scroll{overflow-x:auto}#gbDumping table{width:100%;min-width:1430px;border-collapse:collapse}#gbDumping th{padding:12px 10px;background:#f9fafc;font-size:11px;color:#66788f;text-align:left;border-bottom:1px solid #e7edf5;white-space:nowrap}#gbDumping td{padding:13px 10px;vertical-align:middle;border-bottom:1px solid #eef1f6}#gbDumping .product{display:flex;gap:10px;min-width:235px;align-items:center}#gbDumping .product img{height:57px;width:47px;object-fit:contain;border-radius:7px;background:#f4f5f9;border:1px solid #e7eaf0}#gbDumping .name{font-weight:800;max-width:215px;line-height:1.3}#gbDumping .money{font-weight:800;white-space:nowrap}#gbDumping .first{font-weight:800;color:#177850;margin-top:5px}#gbDumping .fieldset{display:flex;gap:5px;margin-top:5px}#gbDumping .field{width:66px;font-size:10px;color:#6b7a8f}#gbDumping .field input{width:66px;padding:6px 5px!important}#gbDumping .pill{border-radius:90px;background:#eff2f7;color:#5a6b81;padding:5px 8px;font-size:11px;font-weight:800;white-space:nowrap}#gbDumping .pill.green{background:#e5f5e9;color:#197b48}#gbDumping .pill.red{background:#ffe9ea;color:#a53335}#gbDumping .pill.amber{background:#fff1d7;color:#946200}#gbDumping .notes{width:155px;min-height:44px;resize:vertical}#gbDumping .save{display:block;min-height:16px;font-size:10px;color:#8996a8}#gbDumping .save.ok{color:#118251}#gbDumping .save.err{color:#ba302b}#gbDumping .footer{padding:14px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}#gbDumping .pages{display:flex;gap:8px;align-items:center}#gbDumping .cards{display:none}#gbDumping .modal{position:fixed;inset:0;z-index:2147483260;background:#0b172c9e;display:none;align-items:center;justify-content:center;padding:12px}#gbDumping .dialog{width:min(620px,100%);max-height:92vh;overflow:auto;border-radius:16px;background:white;padding:22px;box-shadow:0 25px 80px #0004}#gbDumping .dialog textarea{width:100%;height:195px;font:12px ui-monospace,monospace}#gbDumping .preview{background:#f2f6fc;padding:12px;border-radius:9px;white-space:pre-wrap;margin:12px 0;max-height:130px;overflow:auto}@media(max-width:830px){#gbDumping{inset:0}#gbDumping header{position:relative;padding:12px;align-items:flex-start;flex-wrap:wrap}#gbDumping .inner{padding:10px}#gbDumping .scroll{display:none}#gbDumping .cards{display:grid;gap:10px;padding:10px;background:#f5f7fa;grid-template-columns:repeat(auto-fit,minmax(265px,1fr))}#gbDumping .card{border:1px solid #e2e9f1;border-radius:12px;background:white;padding:13px}#gbDumping .card .product{min-width:0}#gbDumping .card .line{display:flex;justify-content:space-between;align-items:center;gap:9px;margin:10px 0}#gbDumping .field{flex:1}#gbDumping .field input{width:100%}#gbDumping .notes{width:100%}#gbDumping h1{font-size:20px}}";document.head.appendChild(style);
 section=node('section');section.id='gbDumping';
 section.innerHTML='<header><div><h1>📉 Демпинг</h1><div class="sub">GRANTS BOOK · расчёт цен без автоприменения</div></div><div class="actions"><button class="btn" id="gdpCopy">Скопировать изменения</button><button class="btn" id="gdpExport">Экспорт CSV</button><button class="btn primary" id="gdpImport">Импорт / Экспорт</button><button class="btn" id="gdpClose">✕</button></div></header>'+
 '<main class="inner"><div class="tabs"><button class="selected">Демпинг</button><button id="gdpPreorder">Предзаказ</button><button id="gdpAccounting">Учет</button></div><div class="panel"><div class="filters"><input id="gdpSearch" class="search" placeholder="🔎 Товар или артикул"><select id="gdpCity"><option>Астана</option><option>Алматы</option><option>Шымкент</option></select><select id="gdpPublished"><option value="">Все статусы публикации</option><option value="published">Опубликованные</option></select><select id="gdpSort"><option value="dumping">Сначала демпингующиеся</option><option value="sku">По артикулу</option></select><select id="gdpCategory"><option value="">Все категории</option></select><button class="btn" id="gdpRefresh">↻ Обновить</button></div><div id="gdpHint" class="hint">Загрузка…</div><div class="warn" id="gdpWarning" role="alert"></div><div class="scroll"><table><thead><tr><th>Товар</th><th>Цена · Ваша / 1 место</th><th>Позиция</th><th>Демпинг · Мин / Шаг / Макс</th><th>Статус</th><th>Рекомендация</th><th>Закупочная цена</th><th>Заметки</th></tr></thead><tbody id="gdpTable"></tbody></table></div><div class="cards" id="gdpCards"></div><div class="footer"><span id="gdpTotal">—</span><div class="pages"><button class="btn" id="gdpPrev">←</button><span id="gdpPages">1 / 1</span><button class="btn" id="gdpNext">→</button></div></div></div></main>'+
 '<div class="modal" id="gdpModal"><div class="dialog"><h2>Импорт конкурентных цен</h2><p>Вставьте четыре колонки: Артикул, Цена 1 места, Позиция, Всего продавцов. Город: <strong id="gdpImportCity">Астана</strong>.</p><textarea id="gdpPaste" placeholder="Артикул&#9;Цена 1 места&#9;Позиция&#9;Всего продавцов&#10;BOOK001&#9;2900&#9;3&#9;10"></textarea><div class="preview" id="gdpPreview">Данные ещё не проверены</div><div class="actions"><button class="btn" id="gdpCheck">Проверить</button><button class="btn primary" id="gdpCommit" disabled>Записать</button><button class="btn" id="gdpCancel">Отмена</button></div></div></div>';
 document.body.append(section);
 $('gdpClose').onclick=close;$('gdpRefresh').onclick=load;
 for(const [id,key] of [['gdpCity','city'],['gdpPublished','published'],['gdpSort','sort'],['gdpCategory','category']])$(id).onchange=e=>{st[key]=e.target.value;st.page=1;load();};
 $('gdpSearch').oninput=e=>{st.search=e.target.value;st.page=1;clearTimeout(searchTimer);searchTimer=setTimeout(load,300)};
 $('gdpPrev').onclick=()=>{if(st.page>1){st.page--;load()}};
 $('gdpNext').onclick=()=>{if(st.page*st.size<st.total){st.page++;load()}};
 $('gdpImport').onclick=()=>{$('gdpImportCity').textContent=st.city;$('gdpModal').style.display='flex'};
 $('gdpCancel').onclick=()=>$('gdpModal').style.display='none';
 $('gdpPaste').oninput=()=>{st.previewToken='';$('gdpCommit').disabled=true;$('gdpPreview').textContent='Выполните предпросмотр'};
 $('gdpCheck').onclick=preview;$('gdpCommit').onclick=commit;
 $('gdpExport').onclick=exportCsv;$('gdpCopy').onclick=copyChanges;
 $('gdpPreorder').onclick=()=>jump(/Предзаказ/i);
 $('gdpAccounting').onclick=()=>jump(/Учет|Учёт|Склад/i);
}
function jump(regex){const found=[...document.querySelectorAll('button,a')].find(x=>!section.contains(x)&&regex.test(x.textContent||''));if(found){close();found.click()}else show('Раздел не найден в текущей версии сайта');}
function open(){init();section.style.display='block';document.body.style.overflow='hidden';load();}
function close(){section.style.display='none';document.body.style.overflow='';}
function show(message){const x=$('gdpWarning');x.textContent=message||'';x.style.display=message?'block':'none';}
async function load(){
 if(!section||section.style.display==='none')return;
 const seq=++requestSeq;show('');$('gdpHint').textContent='Загрузка страницы '+st.page+'…';
 try{
  const result=await api('list','GET',null,{page:st.page,search:st.search,published:st.published,sort:st.sort,category:st.category});
  if(seq!==requestSeq)return;
  st.total=result.total;st.size=result.pageSize||50;st.rows=result.rows||[];
  const select=$('gdpCategory'),chosen=st.category;select.replaceChildren(new Option('Все категории',''),...(result.categories||[]).map(x=>new Option(x,x)));select.value=chosen;
  $('gdpHint').textContent='Ваша цена — расчётная из прайса, не фактическое предложение Kaspi. Конкурентные цены — из ручного импорта. Город: '+result.city+' ('+result.cityCode+').';
  show((result.warnings||[]).join(' '));render();
 }catch(e){if(seq===requestSeq)show('Ошибка загрузки: '+e.message);}
}
function render(){
 const body=$('gdpTable'),cards=$('gdpCards');body.replaceChildren();cards.replaceChildren();
 for(const item of st.rows){
  const row=node('tr');for(let i=0;i<8;i++)row.append(node('td'));
  const cells=[product(item),price(item),position(item),settings(item),status(item),recommend(item),node('b','money',money(item.cost)),notes(item)];
  cells.forEach((x,i)=>row.children[i].append(x));body.append(row);
  const card=node('div','card');card.append(product(item));
  for(const [label,component] of [['Цена',price(item)],['Позиция',position(item)],['Статус',status(item)],['Рекомендация',recommend(item)],['Закупка',node('b','money',money(item.cost))]]){
   const line=node('div','line');line.append(node('span','muted',label),component);card.append(line);
  }
  card.append(settings(item),notes(item));cards.append(card);
 }
 $('gdpTotal').textContent='Товаров: '+st.total+' · на странице: '+st.rows.length;
 $('gdpPages').textContent=st.page+' / '+Math.max(1,Math.ceil(st.total/st.size));
 $('gdpPrev').disabled=st.page<=1;$('gdpNext').disabled=st.page*st.size>=st.total;
}
function product(r){
 const box=node('div','product'),img=node('img');
 img.loading='lazy';img.alt='';if(/^https:\/\//i.test(r.photo||''))img.src=r.photo;
 const meta=node('div');meta.append(node('div','name',r.name),node('div','muted','Артикул: '+r.sku),node('div','muted',r.category||'Категория: нет данных'));
 box.append(img,meta);return box;
}
function price(r){const x=node('div');x.append(node('div','money',money(r.currentPrice)),node('div','muted','Расчётная'),node('div','first','1 место: '+money(r.firstPrice)));return x;}
function position(r){
 const x=node('div');x.append(node('div','money',r.position&&r.sellers?r.position+'/'+r.sellers:'Нет данных'));
 const date=Date.parse(r.updatedAt||'');x.append(node('div','muted',Number.isFinite(date)?Date.now()-date<60000?'только что':new Date(date).toLocaleString('ru-RU'):'Нет данных'));return x;
}
function status(r){
 const x=node('div'),s=r.calculation?.status||'Нет данных';
 const kind=/^1 место$|^Ниже 1 места$/.test(s)?'green':/Недостижимо|безубыточности|Ниже мин/.test(s)?'red':s==='Нет данных'?'amber':'';
 x.append(node('span','pill '+kind,s));if(r.calculation?.warnings?.length)x.append(node('div','muted','⚠ '+r.calculation.warnings.join('; ')));return x;
}
function recommend(r){const x=node('div'),d=r.calculation||{};x.append(node('div','money',money(d.recommendedPrice)),node('div','muted',d.unitProfit==null?'Прибыль: нет данных':'Прибыль '+money(d.unitProfit)+' · маржа '+d.margin+'%'));if(d.breakEven!=null)x.append(node('div','muted','Безубыточность '+money(d.breakEven)));return x;}
function savePayload(r){return {city:st.city,sku:r.sku,enabled:!!r.enabled,min:r.min,step:r.step,max:r.max,note:r.note||''};}
function settings(r){
 const x=node('div'),top=node('label'),check=node('input');check.type='checkbox';check.checked=!!r.enabled;check.style.accentColor='#2464cb';
 top.append(check,node('b',null,' Демпинг'));x.append(top);
 const group=node('div','fieldset'),inputs={};
 for(const [key,label] of [['min','Мин'],['step','Шаг'],['max','Макс']]){
   const field=node('label','field',label),inp=node('input');inp.type='number';inp.min='0.01';inp.step='any';inp.placeholder='—';inp.value=r[key]??'';
   field.append(inp);group.append(field);inputs[key]=inp;
 }
 const message=node('span','save');x.append(group,message);
 const save=async()=>{const previous={enabled:r.enabled,min:r.min,step:r.step,max:r.max};r.enabled=check.checked;
   for(const key of Object.keys(inputs))r[key]=inputs[key].value===''?null:Number(inputs[key].value);
   message.textContent='Сохранение…';message.className='save';
   try{await api('save','POST',savePayload(r));message.textContent='✓ Сохранено';message.className='save ok';}
   catch(e){Object.assign(r,previous);message.textContent='Ошибка: '+e.message;message.className='save err';}
 };
 check.onchange=save;for(const inp of Object.values(inputs)){inp.onblur=save;inp.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();inp.blur();}}}
 return x;
}
function notes(r){
 const x=node('div'),area=node('textarea','notes'),msg=node('span','save');area.placeholder='Заметка (до 500)';area.maxLength=500;area.value=r.note||'';
 x.append(area,msg);
 const save=async()=>{msg.textContent='Сохранение…';try{await api('save','POST',{...savePayload(r),note:area.value});r.note=area.value;msg.textContent='✓ Сохранено';msg.className='save ok';}catch(e){msg.textContent='Ошибка: '+e.message;msg.className='save err';}};
 area.onblur=save;area.onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();area.blur();}};return x;
}
async function preview(){
 const box=$('gdpPreview');box.textContent='Проверка…';$('gdpCommit').disabled=true;
 try{const r=await api('import','POST',{city:st.city,text:$('gdpPaste').value,mode:'preview'});st.previewToken=r.previewToken;
   box.textContent='Будет обновлено: '+r.preview.willUpdate+' товаров\nНе найдено: '+r.preview.notFound+(r.preview.missingSkus.length?'\nАртикулы: '+r.preview.missingSkus.join(', '):'');
   $('gdpCommit').disabled=!r.preview.willUpdate;
 }catch(e){box.textContent='Ошибка: '+e.message;}
}
async function commit(){
 $('gdpCommit').disabled=true;
 try{const r=await api('import','POST',{city:st.city,text:$('gdpPaste').value,mode:'commit',previewToken:st.previewToken});$('gdpPreview').textContent='✓ Записано '+r.willUpdate+' товаров';st.previewToken='';load();}
 catch(e){$('gdpPreview').textContent='Ошибка: '+e.message;$('gdpCommit').disabled=false;}
}
async function exportCsv(){
 try{const blob=await api('export');const url=URL.createObjectURL(blob),a=node('a');a.href=url;a.download='GB-Демпинг-'+st.city+'.csv';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1500);}
 catch(e){show('Экспорт: '+e.message);}
}
async function copyChanges(){
 try{const r=await api('changes'),text=r.changes.map(x=>x.sku+'\t'+x.price).join('\n');if(!text){show('Нет доступных рекомендаций к экспорту');return;}
   if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(text);
   else{const field=node('textarea');field.value=text;document.body.append(field);field.select();document.execCommand('copy');field.remove();}
   show('Скопировано '+r.count+' изменений. Перенесите их в XML-прайс вручную.');
 }catch(e){show('Копирование: '+e.message);}
}
if(!navigation()){let n=0;const timer=setInterval(()=>{if(navigation()||++n>70)clearInterval(timer)},350);}
})();

