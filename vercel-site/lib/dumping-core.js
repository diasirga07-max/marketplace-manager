'use strict';
const { DEFAULT_KASPI_RATE, DEFAULT_TAX_RATE, normalizeSku, normalizeHeader, parseMoneyKz } = require('./sales-core');
const { __test: { deliveryTariff } } = require('./grants-data-service');
const CITY_CODES = Object.freeze({ 'Астана': '710000000', 'Алматы': '750000000', 'Шымкент': '511010000' });
const HEADERS = Object.freeze(['Артикул','Город','Демпинг','Мин','Шаг','Макс','Заметка','Цена 1 места','Позиция','Всего продавцов','Обновлено','Моя цена']);
const PAGE_SIZE = 50;
const MAX_IMPORT_ROWS = 5000;
function text(value,max=500){return String(value??'').replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max);}
function cellText(value){const v=text(value,500);return /^[=+\-@]/.test(v)?"'"+v:v;}
function number(value,{integer=false,allowBlank=false}={}){
  if ((value===null||value===undefined||String(value).trim()==='') && allowBlank)return null;
  if(value===null||value===undefined||String(value).trim()==='')throw new Error('Укажите положительное число');
  const raw=String(value).trim().replace(/(?:₸|KZT|ТГ)/giu,'').replace(/[\s\u00a0\u202f]/g,'');
  if(!/^\d+(?:[.,]\d+)*$/.test(raw))throw new Error('Требуется положительное '+(integer?'целое ':'')+'число');
  const n=parseMoneyKz(raw);
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
    firstPrice:validNum(row[7]),position:validNum(row[8]),sellers:validNum(row[9]),updatedAt:String(row[10]||''),myPrice:validNum(row[11])};
}
function validNum(x){const n=Number(x);return x!==''&&x!=null&&Number.isFinite(n)&&n>0?n:null;}
function storeRow(s){return [cellText(s.sku),cellText(s.city),s.enabled?'TRUE':'FALSE',s.min??'',s.step??'',s.max??'',cellText(s.note),s.firstPrice??'',s.position??'',s.sellers??'',s.updatedAt||'',s.myPrice??''];}
function parseDelimited(line,delim){
  const result=[];let value='',quoted=false;
  for(let i=0;i<line.length;i++){const ch=line[i];if(ch==='"'&&quoted&&line[i+1]==='"'){value+='"';i++;}
    else if(ch==='"'){quoted=!quoted;}else if(ch===delim&&!quoted){result.push(value.trim());value='';}else value+=ch;}
  if(quoted)throw new Error('Незакрытая кавычка');
  result.push(value.trim());return result;
}

const IMPORT_ALIASES = Object.freeze({
  sku:['артикул','sku','артикул товара','код товара','артикул продавца','код продавца'],
  firstPrice:['цена 1 места','цена первого места','цена 1-го места','цена 1 место','самая низкая цена','минимальная цена'],
  position:['позиция','место','мое место','моё место','моя позиция','место по цене','позиция по цене'],
  sellers:['всего продавцов','количество продавцов','число продавцов','продавцов','всего предложений'],
  myPrice:['моя цена','ваша цена','цена продавца','цена магазина','цена grants book','цена моего магазина'],
  city:['город','регион','город продажи','город kaspi','город каспи'],
});
function importHeaderName(value){
  return normalizeHeader(value).replace(/\([^)]*\)/g,'').replace(/«[^»]*»/g,'').replace(/№/g,'').replace(/\s+/g,' ').trim();
}
function mapImportHeaders(values){
  const mapping={},seen=[];
  for(let i=0;i<values.length;i++){
    const h=importHeaderName(values[i]);
    for(const [field,names] of Object.entries(IMPORT_ALIASES)){
      if(names.includes(h)){
        if(mapping[field]!=null)throw new Error('Неоднозначный заголовок: '+values[i]);
        mapping[field]=i;seen.push(field);
      }
    }
  }
  if(!seen.length)return null;
  if(!['sku','firstPrice','position'].every(x=>mapping[x]!=null))
    throw new Error('Неоднозначные заголовки: нужны Артикул, Цена 1 места, Позиция');
  return mapping;
}
function importCity(value,defaultCity){
  const raw=String(value??'').trim();
  const input=raw||defaultCity;
  const city=Object.keys(CITY_CODES).find(x=>x.toLocaleLowerCase('ru-RU')===String(input).toLocaleLowerCase('ru-RU')||CITY_CODES[x]===input);
  if(!city)throw new Error('Неизвестный город: '+input);
  return city;
}
function parseImport(source,{defaultCity='Астана'}={}){
  if(typeof source!=='string'||source.length>800000)throw new Error('Размер импорта превышен');
  const lines=source.replace(/^\uFEFF/,'').split(/\r?\n/).filter(x=>x.trim());
  if(!lines.length||lines.length>MAX_IMPORT_ROWS+1)throw new Error('Нет данных или слишком много строк');
  const delim=lines[0].includes('\t')?'\t':lines[0].includes(';')?';':',';
  const first=parseDelimited(lines[0],delim);
  const headers=mapImportHeaders(first);
  const legacyHeader=!headers&&/^(артикул|sku|код товара)/i.test(first[0]);
  const start=headers||legacyHeader?1:0;
  const values=[],seen=new Set();
  for(let i=start;i<lines.length;i++){
    const fields=parseDelimited(lines[i],delim);
    if(!headers&&fields.length!==4&&fields.length!==5)
      throw new Error('Строка '+(i+1)+': требуется 4 или 5 столбцов');
    if(headers&&fields.length!==first.length)throw new Error('Строка '+(i+1)+': число столбцов отличается от заголовка');
    const get=field=>fields[headers?headers[field]:({sku:0,firstPrice:1,position:2,sellers:3,myPrice:4}[field])]??'';
    const sku=text(get('sku'),120);
    if(!sku)throw new Error('Строка '+(i+1)+': пустой артикул');
    try{
      const city=importCity(headers&&headers.city!=null?get('city'):'',defaultCity);
      const key=normalizeSku(sku)+'|'+city;
      if(seen.has(key))throw new Error('повтор артикула для города '+city);
      const firstPrice=number(get('firstPrice'));
      const positionRaw=String(get('position')).trim();
      const fraction=positionRaw.match(/^(\d+)\s*[/／]\s*(\d+)$/);
      const position=number(fraction?fraction[1]:positionRaw,{integer:true});
      const sellersField=headers&&headers.sellers==null?'':get('sellers');
      const sellers=fraction?number(fraction[2],{integer:true}):number(sellersField,{integer:true});
      if(fraction&&String(sellersField).trim()&&sellers!==number(sellersField,{integer:true}))
        throw new Error('количество продавцов не совпадает с позицией');
      if(position>sellers)throw new Error('Позиция больше числа продавцов');
      const hasPrice=(headers?headers.myPrice!=null:fields.length===5)&&String(get('myPrice')).trim()!=='';
      const row={sku,firstPrice,position,sellers,...(hasPrice?{myPrice:number(get('myPrice'))}:{})};
      if(headers&&headers.city!=null)row.city=city;
      values.push(row);seen.add(key);
    }catch(e){throw new Error('Строка '+(i+1)+': '+e.message);}
  }
  if(!values.length)throw new Error('Нет строк для импорта');
  return values;
}
function minProfitFromEnv(raw){
  if(raw==null||String(raw).trim()==='')return 0;
  const v=Number(raw);return Number.isFinite(v)&&v>=0?v:0;
}
function priceDetails(product={},setting={}){
  const imported=validNum(setting.myPrice);
  if(imported!=null)return {currentPrice:imported,priceSource:'из импорта',priceConfirmed:true};
  const calculated=validNum(product.currentPrice);
  return {currentPrice:calculated,priceSource:calculated!=null?'расчётная':'нет данных',priceConfirmed:false};
}
function calculate(product={},setting={},minProfit=0){
  const effective=priceDetails(product,setting);
  const warnings=[];const currentPrice=effective.currentPrice;
  if(!effective.priceConfirmed)warnings.push('цена не подтверждена');
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

function competitorFacts(product={},setting={},now=Date.now()){
  const imported=validNum(setting.myPrice);
  const fallback=validNum(product.currentPrice);
  const myPrice=imported??fallback;
  const lowestPrice=validNum(setting.firstPrice);
  const myPlace=Number.isSafeInteger(setting.position)&&setting.position>0?setting.position:null;
  const totalSellers=Number.isSafeInteger(setting.sellers)&&setting.sellers>=myPlace&&myPlace!=null?setting.sellers:null;
  const time=Date.parse(String(setting.updatedAt||''));
  const dataUpdatedAt=Number.isFinite(time)&&time<=now+60000?new Date(time).toISOString():null;
  const ageMinutes=dataUpdatedAt?Math.max(0,Math.floor((now-time)/60000)):null;
  const isStale=ageMinutes!=null&&ageMinutes>1440;
  // A calculated catalogue price is not a verified own offer: no factual gap until imported.
  const diffAbs=imported!=null&&lowestPrice!=null?Math.round((imported-lowestPrice)*100)/100:null;
  const diffPercent=diffAbs!=null?Math.round(diffAbs/lowestPrice*10000)/100:null;
  return {myPlace,totalSellers,lowestPrice,myPrice,diffAbs,diffPercent,
    dataUpdatedAt,dataSource:lowestPrice!=null&&myPlace!=null?'импорт':null,
    ageMinutes,isStale,comparisonWarning:imported==null?'моя цена не подтверждена':null};
}
function pageCatalog(items,{page=1,search='',city='Астана',published='',category='',sort='dumping',placeFilter=''}={}){
  const num=Math.max(1,Math.min(99999,parseInt(page,10)||1));
  const q=text(search,120).toLocaleLowerCase('ru-RU');
  let filtered=items.filter(r=>(!q||String(r.name||'').toLocaleLowerCase('ru-RU').includes(q)||String(r.sku||'').toLocaleLowerCase('ru-RU').includes(q))&&(!category||r.category===category)&&(!city||r.city===city));
  if(published==='published')filtered=filtered.filter(r=>r.published===true);
  if(placeFilter==='first')filtered=filtered.filter(r=>r.myPlace===1);
  if(placeFilter==='not-first')filtered=filtered.filter(r=>r.myPlace>1);
  if(placeFilter==='missing')filtered=filtered.filter(r=>r.myPlace==null||r.lowestPrice==null);
  if(sort==='gap')filtered.sort((a,b)=>
    (b.diffPercent??-Infinity)-(a.diffPercent??-Infinity)||
    (b.diffAbs??-Infinity)-(a.diffAbs??-Infinity)||
    String(a.sku).localeCompare(String(b.sku),'ru'));
  else
  if(sort==='dumping')filtered.sort((a,b)=>Number(!!b.enabled)-Number(!!a.enabled)||String(a.sku).localeCompare(String(b.sku),'ru'));
  else filtered.sort((a,b)=>String(a.sku).localeCompare(String(b.sku),'ru'));
  return {rows:filtered.slice((num-1)*PAGE_SIZE,num*PAGE_SIZE),total:filtered.length,page:num,pageSize:PAGE_SIZE,totalPages:Math.max(1,Math.ceil(filtered.length/PAGE_SIZE))};
}
module.exports={CITY_CODES,HEADERS,PAGE_SIZE,number,cellText,validateSettings,decodeRow,storeRow,parseImport,calculate,priceDetails,competitorFacts,mapImportHeaders,pageCatalog,minProfitFromEnv};
