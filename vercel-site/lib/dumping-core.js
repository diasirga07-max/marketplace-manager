'use strict';
const { DEFAULT_KASPI_RATE, DEFAULT_TAX_RATE, normalizeSku, parseMoneyKz } = require('./sales-core');
const { __test: { deliveryTariff } } = require('./grants-data-service');
const CITY_CODES = Object.freeze({ 'Астана': '710000000', 'Алматы': '750000000', 'Шымкент': '511010000' });
const HEADERS = Object.freeze(['Артикул','Город','Демпинг','Мин','Шаг','Макс','Заметка','Цена 1 места','Позиция','Всего продавцов','Обновлено']);
const PAGE_SIZE = 50;
const MAX_IMPORT_ROWS = 5000;
function text(value,max=500){return String(value??'').replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max);}
function cellText(value){const v=text(value,500);return /^[=+\-@]/.test(v)?"'"+v:v;}
function number(value,{integer=false,allowBlank=false}={}){
  if ((value===null||value===undefined||String(value).trim()==='') && allowBlank)return null;
  if(value===null||value===undefined||String(value).trim()==='')throw new Error('Укажите положительное число');
  const n=Number(String(value).replace(/\s/g,'').replace(',','.'));
  if(!Number.isFinite(n)||n<=0||(integer&&!Number.isSafeInteger(n)))throw new Error('Требуется положительное '+(integer?'целое ':'')+'число');
  return n;
}
function boolean(value){return value===true||value==='TRUE'||value==='true'||value===1;}
function validateSettings(raw){
  if(!raw||typeof raw!=='object')throw new Error('Некорректные настройки');
  const sku=text(raw.sku,120),city=text(raw.city||'Астана',60);
  if(!sku)throw new Error('Артикул обязателен');
  if(!CITY_CODES[city])throw new Error('Неизвестный город');
  const enabled=boolean(raw.enabled);
  const min=number(raw.min,{allowBlank:!enabled});
  const step=number(raw.step,{allowBlank:!enabled});
  const max=number(raw.max,{allowBlank:!enabled});
  if(min!=null&&max!=null&&min>max)throw new Error('Мин не может быть больше Макс');
  if(String(raw.note??'').length>500)throw new Error('Заметка длиннее 500 символов');
  return {sku,city,enabled,min,step,max,note:text(raw.note,500)};
}
function decodeRow(row){
  return {sku:String(row[0]||'').replace(/^'(?=[=+\-@])/,'') ,city:String(row[1]||'Астана'),enabled:boolean(row[2]),
    min:validNum(row[3]),step:validNum(row[4]),max:validNum(row[5]),note:String(row[6]||''),
    firstPrice:validNum(row[7]),position:validNum(row[8]),sellers:validNum(row[9]),updatedAt:String(row[10]||'')};
}
function validNum(x){const n=Number(x);return x!==''&&x!=null&&Number.isFinite(n)&&n>0?n:null;}
function storeRow(s){return [cellText(s.sku),cellText(s.city),s.enabled?'TRUE':'FALSE',s.min??'',s.step??'',s.max??'',cellText(s.note),s.firstPrice??'',s.position??'',s.sellers??'',s.updatedAt||''];}
function parseDelimited(line,delim){
  const result=[];let value='',quoted=false;
  for(let i=0;i<line.length;i++){const ch=line[i];if(ch==='"'&&quoted&&line[i+1]==='"'){value+='"';i++;}
    else if(ch==='"'){quoted=!quoted;}else if(ch===delim&&!quoted){result.push(value.trim());value='';}else value+=ch;}
  if(quoted)throw new Error('Незакрытая кавычка');
  result.push(value.trim());return result;
}
function parseImport(source){
  if(typeof source!=='string'||source.length>800000)throw new Error('Размер импорта превышен');
  const lines=source.replace(/^\uFEFF/,'').split(/\r?\n/).filter(x=>x.trim());
  if(!lines.length||lines.length>MAX_IMPORT_ROWS+1)throw new Error('Нет данных или слишком много строк');
  const delim=lines[0].includes('\t')?'\t':lines[0].includes(';')?';':',';
  let start=0;
  if(/^(артикул|sku|код товара)/i.test(parseDelimited(lines[0],delim)[0]))start=1;
  const values=[],seen=new Set();
  for(let i=start;i<lines.length;i++){
    const fields=parseDelimited(lines[i],delim);
    if(fields.length!==4)throw new Error('Строка '+(i+1)+': требуется 4 столбца');
    const sku=text(fields[0],120);if(!sku)throw new Error('Строка '+(i+1)+': пустой артикул');
    const key=normalizeSku(sku);if(seen.has(key))throw new Error('Строка '+(i+1)+': повтор артикула');
    seen.add(key);
    try{
      const firstPrice=number(fields[1]),position=number(fields[2],{integer:true}),sellers=number(fields[3],{integer:true});
      if(position>sellers)throw new Error('Позиция больше числа продавцов');
      values.push({sku,firstPrice,position,sellers});
    }catch(e){throw new Error('Строка '+(i+1)+': '+e.message);}
  }
  if(!values.length)throw new Error('Нет строк для импорта');
  return values;
}
function minProfitFromEnv(raw){
  if(raw==null||String(raw).trim()==='')return 0;
  const v=Number(raw);return Number.isFinite(v)&&v>=0?v:0;
}
function calculate(product={},setting={},minProfit=0){
  const warnings=[];const currentPrice=validNum(product.currentPrice);
  const firstPrice=validNum(setting.firstPrice);
  const cost=validNum(product.cost);
  const min=validNum(setting.min),step=validNum(setting.step),max=validNum(setting.max);
  const active=!!setting.enabled;
  const base={recommendedPrice:null,breakEven:null,unitProfit:null,margin:null,delivery:null,warnings,status:'Нет данных'};
  if(!active)return {...base,status:'Демпинг выключен'};
  if(cost==null){warnings.push('Нет закупочной цены');return {...base,warnings};}
  const priceForTariff=currentPrice??firstPrice;
  if(priceForTariff==null){warnings.push('Нет вашей цены или цены конкурента');return {...base,warnings};}
  if(priceForTariff>=10000 && !validNum(product.weightGrams) && !validNum(product.delivery)){
    warnings.push('Укажите доставку');return {...base,warnings};
  }
  const delivery=validNum(product.delivery)??deliveryTariff(priceForTariff,product.weightGrams||0,'kz',product.category||'');
  const denominator=1-DEFAULT_KASPI_RATE-DEFAULT_TAX_RATE;
  const breakEven=Math.ceil((cost+delivery+minProfitFromEnv(minProfit))/denominator);
  let result={...base,delivery,breakEven,warnings};
  if(min!=null&&min<breakEven)warnings.push('Мин ниже безубыточной цены');
  if(currentPrice==null||firstPrice==null||min==null||step==null||max==null)
    return {...result,status:min!=null&&min<breakEven?'Ниже безубыточности':'Нет данных'};
  if(currentPrice<min)return {...result,status:'Ниже мин'};
  if(min<breakEven)return {...result,status:'Ниже безубыточности'};
  if(currentPrice<firstPrice)return {...result,status:'Ниже 1 места'};
  if(currentPrice===firstPrice)return {...result,status:'1 место'};
  const target=Math.max(min,firstPrice-step,breakEven);
  if(target>max||target>=currentPrice||target>=firstPrice)return {...result,status:'Недостижимо'};
  const recommendedPrice=Math.ceil(target);
  if(recommendedPrice>max||recommendedPrice>=firstPrice||recommendedPrice>=currentPrice)
    return {...result,status:'Недостижимо'};
  const unitProfit=Math.round((recommendedPrice*denominator-cost-delivery)*100)/100;
  return {...result,recommendedPrice,unitProfit,margin:Math.round(unitProfit/recommendedPrice*10000)/100,status:'Рекомендовано снижение'};
}
function pageCatalog(items,{page=1,search='',city='Астана',published='',category='',sort='dumping'}={}){
  const num=Math.max(1,Math.min(99999,parseInt(page,10)||1));
  const q=text(search,120).toLocaleLowerCase('ru-RU');
  let filtered=items.filter(r=>(!q||String(r.name||'').toLocaleLowerCase('ru-RU').includes(q)||String(r.sku||'').toLocaleLowerCase('ru-RU').includes(q))&&(!category||r.category===category)&&(!city||r.city===city));
  if(published==='published')filtered=filtered.filter(r=>r.published===true);
  if(sort==='dumping')filtered.sort((a,b)=>Number(!!b.enabled)-Number(!!a.enabled)||String(a.sku).localeCompare(String(b.sku),'ru'));
  else filtered.sort((a,b)=>String(a.sku).localeCompare(String(b.sku),'ru'));
  return {rows:filtered.slice((num-1)*PAGE_SIZE,num*PAGE_SIZE),total:filtered.length,page:num,pageSize:PAGE_SIZE,totalPages:Math.max(1,Math.ceil(filtered.length/PAGE_SIZE))};
}
module.exports={CITY_CODES,HEADERS,PAGE_SIZE,number,cellText,validateSettings,decodeRow,storeRow,parseImport,calculate,pageCatalog,minProfitFromEnv};
