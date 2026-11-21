(()=>{
'use strict';
if(window.GB_SALES_DYNAMICS_LOADED)return;
window.GB_SALES_DYNAMICS_LOADED=true;

let overflow='',resizeTimer=null,current=null,inFlight=false,pendingRender=null;
const numberValue=value=>{if(value===null||value===undefined||value==='')return null;const n=Number(value);return Number.isFinite(n)?n:null};
const valueOf=(object,keys,fallback=null)=>{for(const key of keys){if(object&&object[key]!==undefined&&object[key]!==null)return object[key]}return fallback};
const money=value=>{const n=numberValue(value);return n==null?'\u2014':new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0}).format(Math.round(n))+' \u20b8'};
const count=value=>{const n=numberValue(value);return n==null?'\u2014':new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0}).format(Math.round(n))};
const percent=value=>{const n=numberValue(value);return n==null?'Не рассчитано':n.toLocaleString('ru-RU',{minimumFractionDigits:1,maximumFractionDigits:1})+'%'};
const pad=value=>String(value).padStart(2,'0');

function kzParts(){
  return Object.fromEntries(new Intl.DateTimeFormat('en',{timeZone:'Asia/Almaty',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).filter(item=>item.type!=='literal').map(item=>[item.type,item.value]));
}
function currentMonth(){const parts=kzParts();return parts.year+'-'+parts.month}
function monthRange(key){
  const [year,month]=String(key).split('-').map(Number),today=kzParts(),todayKey=today.year+'-'+today.month;
  if(!year||!month||key>todayKey)return null;
  const last=key===todayKey?Number(today.day):new Date(year,month,0).getDate();
  return {from:key+'-01',to:key+'-'+pad(last)};
}
function eachDate(from,to){
  const dates=[],cursor=new Date(from+'T00:00:00Z'),end=new Date(to+'T00:00:00Z');
  while(cursor<=end&&dates.length<62){dates.push(cursor.toISOString().slice(0,10));cursor.setUTCDate(cursor.getUTCDate()+1)}
  return dates;
}
function formatDate(date){const match=String(date).match(/^(\d{4})-(\d{2})-(\d{2})$/);return match?match[3]+'.'+match[2]:String(date||'\u2014')}
function formatTime(value){if(!value)return '\u2014';const date=new Date(value);return Number.isNaN(date.getTime())?String(value):date.toLocaleString('ru-RU',{timeZone:'Asia/Almaty'})}
function cacheAge(ms){const n=numberValue(ms);if(n==null||n<0)return '';const minutes=Math.round(n/60000);return minutes<1?'меньше минуты':minutes<60?minutes+' мин':Math.round(minutes/60)+' ч'}
function messageOf(value){if(typeof value==='string')return value;if(value&&typeof value==='object')return value.message||value.error||value.code||'';return ''}

function normalizeMetrics(source={}){
  const units=Math.max(0,numberValue(source.units)||0),missing=Math.max(0,numberValue(valueOf(source,['missingCostUnits','missingProfit'],0))||0);
  const knownUnits=Math.max(0,numberValue(valueOf(source,['knownCostUnits'],Math.max(0,units-missing)))||0);
  const complete=source.profitComplete!==undefined?!!source.profitComplete:missing===0&&numberValue(source.profit)!=null;
  const confirmedProfit=numberValue(valueOf(source,['confirmedProfit'],complete?source.profit:null));
  const profit=complete?numberValue(source.profit):confirmedProfit;
  const cogs=numberValue(valueOf(source,['cogs','knownCogs'],null)),delivery=numberValue(source.delivery),tax=numberValue(source.tax),kaspi=numberValue(source.kaspi),extra=numberValue(valueOf(source,['extraExpenses','extras'],0));
  const expenses=[cogs,delivery,tax,kaspi,extra].every(value=>value!=null)?cogs+delivery+tax+kaspi+extra:null;
  return {
    orders:numberValue(source.orders)||0,units,sales:numberValue(source.sales)||0,cogs,knownUnits,missing,
    delivery,tax,kaspi,extraExpenses:extra,expenses,profit,confirmedProfit,profitComplete:complete,
    unresolvedOrders:Math.max(0,numberValue(source.unresolvedOrders)||0)
  };
}
function normalizeDay(source={}){
  const metrics=normalizeMetrics(source.summary||source);
  return {...metrics,date:source.date||source.day||source.completionDate||'',day:Number(String(source.date||source.day||'').slice(-2))||0,error:source.error||''};
}
function emptyDay(date){return {...normalizeMetrics({orders:0,units:0,sales:0,cogs:0,knownCostUnits:0,missingCostUnits:0,delivery:0,tax:0,kaspi:0,extraExpenses:0,confirmedProfit:0,profit:0,profitComplete:true}),date,day:Number(date.slice(-2)),error:''}}
function normalizePayload(payload,range){
  const raw=Array.isArray(payload.daily)?payload.daily:Array.isArray(payload.days)?payload.days:[];
  const byDate=new Map(raw.map(item=>{const row=normalizeDay(item);return [row.date,row]}).filter(([date])=>date));
  let rows=eachDate(range.from,range.to).map(date=>byDate.get(date)||emptyDay(date));
  if(!rows.length&&range.from===range.to)rows=[normalizeDay({date:range.from,...(payload.summary||{})})];
  const total=normalizeMetrics(payload.summary||{}),sales=total.sales;
  total.average=total.orders?sales/total.orders:null;
  total.margin=total.profitComplete&&sales?total.profit/sales*100:total.profitComplete&&sales===0?0:null;
  total.coverage=total.units?total.knownUnits/total.units*100:100;
  return {payload,range:payload.range||range,rows,total};
}

function addStyle(){
  if(document.getElementById('gbDynStyle'))return;
  const style=document.createElement('style');style.id='gbDynStyle';style.textContent=`
#gbDyn{position:fixed;inset:58px 0 0;z-index:2147483200;background:#f5f7fa;display:none;flex-direction:column;font-family:Inter,Arial,sans-serif;color:#101828;overflow:auto}#gbDyn *{box-sizing:border-box}.gdy-head{position:sticky;top:0;z-index:20;background:#fff;border-bottom:1px solid #e4e7ec;padding:14px 20px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}.gdy-title{font-size:25px;font-weight:900;margin-right:auto}.gdy-sub{display:block;color:#667085;font-size:12px;margin-top:3px}.gdy-btn,.gdy-month{border:1px solid #d0d5dd;background:#fff;border-radius:11px;padding:9px 12px;font-weight:750;color:#101828}.gdy-btn{cursor:pointer}.gdy-btn.dark{background:#111;color:#fff;border-color:#111}.gdy-btn:disabled,.gdy-month:disabled{opacity:.55;cursor:wait}.gdy-body{padding:18px;max-width:1700px;width:100%;margin:auto}.gdy-progress{background:#eff8ff;border:1px solid #b2ddff;border-radius:14px;padding:13px;margin-bottom:14px;color:#175cd3;font-size:12px;font-weight:750}.gdy-bar{height:6px;background:#d1e9ff;border-radius:99px;overflow:hidden;margin-top:8px}.gdy-bar>i{display:block;height:100%;background:#1570ef;width:36%;border-radius:99px;animation:gdyLoading 1.25s ease-in-out infinite alternate}.gdy-kpis{display:grid;grid-template-columns:repeat(4,minmax(160px,1fr));gap:12px;margin-bottom:14px}.gdy-kpi{background:#fff;border:1px solid #e4e7ec;border-radius:16px;padding:14px;box-shadow:0 3px 12px rgba(16,24,40,.04)}.gdy-k{font-size:11px;font-weight:850;color:#667085;text-transform:uppercase;letter-spacing:.04em}.gdy-v{font-size:25px;font-weight:900;margin-top:7px}.gdy-v.partial{color:#b54708}.gdy-hint{font-size:11px;color:#98a2b3;margin-top:4px}.gdy-warn{background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;border-radius:12px;padding:10px 12px;font-size:12px;line-height:1.5;margin-bottom:14px;display:none}.gdy-warn.error{background:#fef3f2;border-color:#fecdca;color:#b42318}.gdy-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.gdy-card{background:#fff;border:1px solid #e4e7ec;border-radius:18px;padding:16px;box-shadow:0 3px 12px rgba(16,24,40,.04);min-width:0}.gdy-card.wide{grid-column:1/-1}.gdy-ct{font-size:15px;font-weight:850}.gdy-cs{font-size:11px;color:#667085;margin:4px 0 10px}.gdy-chart{width:100%;height:270px;display:block}.gdy-legend{display:flex;gap:14px;flex-wrap:wrap;font-size:11px;color:#475467;margin-top:7px}.gdy-dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px}.gdy-tablewrap{overflow:auto;max-height:390px}.gdy-table{width:100%;border-collapse:collapse;font-size:12px;min-width:1150px}.gdy-table th{position:sticky;top:0;background:#f9fafb;color:#667085;text-align:right;padding:8px;border-bottom:1px solid #e4e7ec}.gdy-table th:first-child,.gdy-table td:first-child{text-align:left}.gdy-table td{text-align:right;padding:8px;border-bottom:1px solid #f2f4f7}.gdy-foot{font-size:11px;color:#667085;margin-top:12px;line-height:1.6}.gdy-partial{color:#b54708;font-size:10px;font-weight:800;display:block}.gdy-error{color:#b42318;font-weight:700}@keyframes gdyLoading{from{transform:translateX(0)}to{transform:translateX(175%)}}
@media(max-width:1100px){.gdy-kpis{grid-template-columns:repeat(2,1fr)}}@media(max-width:760px){#gbDyn{inset:54px 0 0}.gdy-head{padding:10px}.gdy-body{padding:10px}.gdy-kpis{grid-template-columns:1fr 1fr}.gdy-grid{grid-template-columns:1fr}.gdy-card.wide{grid-column:auto}.gdy-chart{height:230px}.gdy-title{font-size:20px}.gdy-v{font-size:20px}}
  `;document.head.appendChild(style);
}
function ensureNav(){
  if(document.getElementById('gbDynNav'))return true;
  const all=[...document.querySelectorAll('button,a')],reference=all.find(element=>/Прайс Kaspi/i.test(element.textContent||''))||all.find(element=>/Настройки/i.test(element.textContent||''));
  if(!reference||!reference.parentElement)return false;
  const button=document.createElement('button');button.id='gbDynNav';button.type='button';button.className=reference.className;button.textContent='📈 Динамика продаж';button.onclick=open;reference.parentElement.insertBefore(button,reference);return true;
}
function build(){
  addStyle();let overlay=document.getElementById('gbDyn');if(overlay)return overlay;
  overlay=document.createElement('section');overlay.id='gbDyn';overlay.innerHTML=`<div class="gdy-head"><div><div class="gdy-title">Динамика продаж</div><span class="gdy-sub">Kaspi · один серверный запрос на выбранный месяц</span></div><input id="gdyMonth" class="gdy-month" type="month"><button id="gdyRefresh" class="gdy-btn">↻ Обновить из Kaspi</button><button id="gdyClose" class="gdy-btn dark">Закрыть</button></div><div class="gdy-body"><div id="gdyProgress" class="gdy-progress" role="status" aria-live="polite"><span id="gdyProgressText">Подготовка…</span><div class="gdy-bar"><i></i></div></div><div id="gdyWarn" class="gdy-warn" role="alert"></div><div id="gdyContent" style="display:none"><div class="gdy-kpis"><div class="gdy-kpi"><div class="gdy-k">Завершено заказов</div><div id="gdyOrders" class="gdy-v">—</div><div class="gdy-hint">COMPLETED</div></div><div class="gdy-kpi"><div class="gdy-k">Продано, шт</div><div id="gdyUnits" class="gdy-v">—</div><div class="gdy-hint">фактическое количество</div></div><div class="gdy-kpi"><div class="gdy-k">Выручка</div><div id="gdySales" class="gdy-v">—</div><div class="gdy-hint">завершённые продажи</div></div><div class="gdy-kpi"><div id="gdyProfitLabel" class="gdy-k">Чистая прибыль</div><div id="gdyProfit" class="gdy-v">—</div><div id="gdyProfitHint" class="gdy-hint">после всех учтённых расходов</div></div><div class="gdy-kpi"><div class="gdy-k">Учтённые расходы</div><div id="gdyExpenses" class="gdy-v">—</div><div id="gdyCoverage" class="gdy-hint">покрытие —</div></div><div class="gdy-kpi"><div class="gdy-k">Средний чек</div><div id="gdyAvg" class="gdy-v">—</div><div class="gdy-hint">выручка / заказы</div></div><div class="gdy-kpi"><div class="gdy-k">Маржа</div><div id="gdyMargin" class="gdy-v">—</div><div class="gdy-hint">только при полной себестоимости</div></div><div class="gdy-kpi"><div class="gdy-k">Без себестоимости</div><div id="gdyMissing" class="gdy-v">—</div><div class="gdy-hint">шт. товаров</div></div></div><div class="gdy-grid"><div class="gdy-card wide"><div class="gdy-ct">Выручка, прибыль и расходы по дням</div><div class="gdy-cs">При неполной себестоимости показывается только подтверждённая прибыль</div><canvas id="gdyMoney" class="gdy-chart"></canvas><div class="gdy-legend"><span><i class="gdy-dot" style="background:#1570ef"></i>Выручка</span><span><i class="gdy-dot" style="background:#12b76a"></i>Подтверждённая прибыль</span><span><i class="gdy-dot" style="background:#f79009"></i>Учтённые расходы</span></div></div><div class="gdy-card"><div class="gdy-ct">Количество продаж</div><div class="gdy-cs">Завершённые заказы по дням</div><canvas id="gdyOrdersChart" class="gdy-chart"></canvas></div><div class="gdy-card"><div class="gdy-ct">Продано товаров</div><div class="gdy-cs">Штук по дням</div><canvas id="gdyUnitsChart" class="gdy-chart"></canvas></div><div class="gdy-card wide"><div class="gdy-ct">Расходы по дням</div><div class="gdy-cs">Себестоимость, доставка, налог и комиссия Kaspi</div><canvas id="gdyCosts" class="gdy-chart"></canvas><div class="gdy-legend"><span><i class="gdy-dot" style="background:#344054"></i>Себестоимость</span><span><i class="gdy-dot" style="background:#7f56d9"></i>Доставка</span><span><i class="gdy-dot" style="background:#f04438"></i>Налог</span><span><i class="gdy-dot" style="background:#f79009"></i>Kaspi</span></div></div><div class="gdy-card wide"><div class="gdy-ct">Данные по дням</div><div class="gdy-cs">Расшифровка выбранного месяца</div><div class="gdy-tablewrap"><table class="gdy-table"><thead><tr><th>Дата</th><th>Заказы</th><th>Шт.</th><th>Выручка</th><th>Прибыль</th><th>Себестоимость</th><th>Доставка</th><th>Налог</th><th>Kaspi</th><th>Без себестоимости</th></tr></thead><tbody id="gdyRows"></tbody></table></div></div></div><div id="gdyFoot" class="gdy-foot"></div></div></div>`;
  document.body.appendChild(overlay);document.getElementById('gdyMonth').value=currentMonth();document.getElementById('gdyMonth').onchange=()=>render(false);document.getElementById('gdyRefresh').onclick=()=>render(true);document.getElementById('gdyClose').onclick=close;return overlay;
}

function prep(element){const rect=element.getBoundingClientRect(),density=Math.max(1,window.devicePixelRatio||1);element.width=Math.max(1,Math.round(rect.width*density));element.height=Math.max(1,Math.round(rect.height*density));const context=element.getContext('2d');context.setTransform(density,0,0,density,0,0);context.clearRect(0,0,rect.width,rect.height);return {context,width:rect.width,height:rect.height}}
function axes(context,width,height,max,formatter){const left=58,right=12,top=14,bottom=28,plotHeight=Math.max(10,height-top-bottom),plotWidth=Math.max(10,width-left-right);context.strokeStyle='#eaecf0';context.fillStyle='#98a2b3';context.font='10px Arial';context.textAlign='right';for(let i=0;i<=4;i++){const y=top+plotHeight*i/4,value=max*(1-i/4);context.beginPath();context.moveTo(left,y);context.lineTo(width-right,y);context.stroke();context.fillText(formatter(value),left-7,y+3)}return {left,right,top,bottom,plotHeight,plotWidth}}
function short(value){return value>=1000000?(value/1000000).toFixed(1)+'м':value>=1000?Math.round(value/1000)+'к':Math.round(value)}
function lineChart(id,rows,series){const element=document.getElementById(id);if(!element)return;const {context,width,height}=prep(element),values=[];rows.forEach(row=>series.forEach(item=>values.push(Math.max(0,numberValue(item.get(row))||0))));const max=Math.max(1,...values)*1.08,axis=axes(context,width,height,max,short);context.textAlign='center';context.fillStyle='#98a2b3';rows.forEach((row,index)=>{if(index%5&&index!==rows.length-1)return;const x=axis.left+axis.plotWidth*(rows.length<=1?0:index/(rows.length-1));context.fillText(String(row.day),x,height-9)});for(const item of series){context.strokeStyle=item.color;context.lineWidth=2.5;context.lineJoin='round';context.lineCap='round';context.beginPath();rows.forEach((row,index)=>{const x=axis.left+axis.plotWidth*(rows.length<=1?0:index/(rows.length-1)),y=axis.top+axis.plotHeight*(1-(Math.max(0,numberValue(item.get(row))||0))/max);index?context.lineTo(x,y):context.moveTo(x,y)});context.stroke()}}
function barChart(id,rows,get,color){const element=document.getElementById(id);if(!element)return;const {context,width,height}=prep(element),max=Math.max(1,...rows.map(row=>numberValue(get(row))||0)),axis=axes(context,width,height,max,value=>String(Math.round(value))),gap=2,barWidth=Math.max(2,axis.plotWidth/Math.max(1,rows.length)-gap);context.fillStyle=color;context.textAlign='center';rows.forEach((row,index)=>{const value=Math.max(0,numberValue(get(row))||0),barHeight=axis.plotHeight*value/max,x=axis.left+index*axis.plotWidth/rows.length+gap/2;context.fillRect(x,axis.top+axis.plotHeight-barHeight,barWidth,barHeight);if(index%5===0||index===rows.length-1){context.fillStyle='#98a2b3';context.fillText(String(row.day),x+barWidth/2,height-9);context.fillStyle=color}})}
function draw(data){lineChart('gdyMoney',data.rows,[{get:row=>row.sales,color:'#1570ef'},{get:row=>row.profit,color:'#12b76a'},{get:row=>row.expenses,color:'#f79009'}]);barChart('gdyOrdersChart',data.rows,row=>row.orders,'#1570ef');barChart('gdyUnitsChart',data.rows,row=>row.units,'#12b76a');lineChart('gdyCosts',data.rows,[{get:row=>row.cogs,color:'#344054'},{get:row=>row.delivery,color:'#7f56d9'},{get:row=>row.tax,color:'#f04438'},{get:row=>row.kaspi,color:'#f79009'}])}

function paint(data){
  current=data;const total=data.total,payload=data.payload;
  document.getElementById('gdyOrders').textContent=count(total.orders);document.getElementById('gdyUnits').textContent=count(total.units);document.getElementById('gdySales').textContent=money(total.sales);document.getElementById('gdyProfit').textContent=money(total.profit);document.getElementById('gdyExpenses').textContent=money(total.expenses);document.getElementById('gdyCoverage').textContent='покрытие себестоимости: '+percent(total.coverage);document.getElementById('gdyAvg').textContent=money(total.average);document.getElementById('gdyMargin').textContent=percent(total.margin);document.getElementById('gdyMissing').textContent=count(total.missing);
  document.getElementById('gdyProfitLabel').textContent=total.profitComplete?'Чистая прибыль':'Подтверждённая прибыль (частично)';document.getElementById('gdyProfit').classList.toggle('partial',!total.profitComplete);document.getElementById('gdyProfitHint').textContent=total.profitComplete?'после всех учтённых расходов':'нераcсчитанная часть не равна нулю';
  document.getElementById('gdyRows').innerHTML=data.rows.map(row=>`<tr><td>${formatDate(row.date)}${row.error?' <span class="gdy-error">ошибка</span>':''}</td><td>${count(row.orders)}</td><td>${count(row.units)}</td><td>${money(row.sales)}</td><td>${money(row.profit)}${row.profitComplete?'':'<span class="gdy-partial">только подтверждённая</span>'}</td><td>${money(row.cogs)}</td><td>${money(row.delivery)}</td><td>${money(row.tax)}</td><td>${money(row.kaspi)}</td><td>${count(row.missing)}</td></tr>`).join('');
  const flags=[];if(payload.cached)flags.push('кэш сервера');if(payload.stale)flags.push('устаревший');if(payload.refreshing)flags.push('обновляется в фоне');const age=cacheAge(payload.cacheAgeMs);if(age&&payload.cached)flags.push('возраст '+age);
  document.getElementById('gdyFoot').innerHTML='Источник: <b>текущий /api/data?op=sales</b>. Один запрос охватывает весь период; данные сгруппированы по фактической дате завершения. Последнее успешное обновление: <b>'+formatTime(payload.lastSuccessfulAt||payload.generatedAt)+'</b>'+(flags.length?'. Состояние: <b>'+flags.join(' · ')+'</b>':'')+'. Время сервера: <b>'+count(payload.ms)+' мс</b>.';
  const messages=[];if(!total.profitComplete)messages.push('⚠ Себестоимость не найдена для '+count(total.missing)+' шт. из '+count(total.units)+'. Показана только подтверждённая прибыль, а общая прибыль и маржа отмечены как не рассчитанные.');if(payload.stale)messages.push('Показан последний успешный кэш.');if(payload.refreshing)messages.push('Обновление уже выполняется в фоне.');if(total.unresolvedOrders)messages.push('Не полностью разобрано заказов: '+count(total.unresolvedOrders)+'.');for(const item of [...(Array.isArray(payload.catalog&&payload.catalog.warnings)?payload.catalog.warnings:[]),...(Array.isArray(payload.warnings)?payload.warnings:[]),...(Array.isArray(payload.errors)?payload.errors:[])]){const message=messageOf(item);if(message)messages.push(message)}showWarning(messages,'warn');requestAnimationFrame(()=>draw(data));
}
function showWarning(messages,kind='warn'){const warning=document.getElementById('gdyWarn');if(!warning)return;const text=(Array.isArray(messages)?messages:[messages]).filter(Boolean).join(' ');warning.style.display=text?'block':'none';warning.className='gdy-warn'+(kind==='error'?' error':'');warning.textContent=text}
function setBusy(value,text){document.getElementById('gdyRefresh').disabled=value;document.getElementById('gdyMonth').disabled=value;document.getElementById('gdyProgress').style.display=value?'block':'none';if(text)document.getElementById('gdyProgressText').textContent=text}
async function render(force=false){
  const overlay=build(),month=document.getElementById('gdyMonth').value||currentMonth(),range=monthRange(month);
  if(!range){document.getElementById('gdyContent').style.display='none';setBusy(false);showWarning('Для будущего месяца данных ещё нет.','warn');return}
  if(inFlight){pendingRender={force};return}
  inFlight=true;setBusy(true,(force?'Принудительно обновляю':'Загружаю')+' весь диапазон '+formatDate(range.from)+' — '+formatDate(range.to)+' одним запросом…');showWarning([]);
  try{
    const fn=typeof window.api==='function'?window.api:typeof api==='function'?api:null;if(!fn)throw new Error('API продаж не найден');
    const payload=await fn('sales',{force:force?1:0,timeout:285000,params:{from:range.from,to:range.to}}),data=normalizePayload(payload,range);
    document.getElementById('gdyContent').style.display='block';setBusy(false);paint(data);
  }catch(error){setBusy(false);showWarning('Не удалось загрузить диапазон: '+String(error&&error.message||error)+'. Уже показанные данные сохранены.','error')}
  finally{inFlight=false;if(pendingRender){const next=pendingRender;pendingRender=null;render(next.force)}}
}
function open(){const overlay=build();overflow=document.body.style.overflow;document.body.style.overflow='hidden';overlay.style.display='flex';render(false)}
function close(){const overlay=document.getElementById('gbDyn');if(overlay)overlay.style.display='none';document.body.style.overflow=overflow}

addStyle();if(!ensureNav()){let attempts=0,timer=setInterval(()=>{if(ensureNav()||++attempts>60)clearInterval(timer)},300)}
window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(document.getElementById('gbDyn')?.style.display==='flex'&&current)draw(current)},160)});
})();
