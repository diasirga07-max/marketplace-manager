'use strict';
const crypto=require('node:crypto');
const { buildCatalog,normalizeSku,normalizeHeader,parseMoneyKz }=require('../lib/sales-core');
const { __test: { parseCsv } }=require('../lib/grants-data-service');
const core=require('../lib/dumping-core');
const storage=require('../lib/dumping-storage');
const SHEET_ID=storage.ID;
let cached=null,loading=null;
function catalogColumn(headers,label){return headers.findIndex(x=>normalizeHeader(x)===normalizeHeader(label));}
async function loadCatalog(){
  if(cached&&Date.now()-cached.time<300000)return cached;
  if(loading)return loading;
  loading=(async()=>{
    const url='https://docs.google.com/spreadsheets/d/'+encodeURIComponent(SHEET_ID)+'/gviz/tq?tqx=out:csv&sheet='+encodeURIComponent('Прайс KASPI');
    const response=await fetch(url,{signal:AbortSignal.timeout(20000),cache:'no-store'});
    if(!response.ok)throw new Error('Каталог недоступен');
    const rows=parseCsv(await response.text());
    const catalog=buildCatalog(rows);
    const headers=rows[0]||[];
    const categoryIdx=catalogColumn(headers,'Категория');
    const priceIdx=catalogColumn(headers,'Цена Kaspi округл. до 10 (₸)');
    const items=[...catalog.bySku.values()].map(record=>{
      const row=rows[record.sourceRow-1]||[];
      const money=priceIdx<0?null:parseMoneyKz(row[priceIdx]);
      return {sku:record.sku,name:record.name||'Без названия',photo:/^https:\/\//.test(record.photo)?record.photo:'',
        cost:record.cost,category:categoryIdx<0?'':String(row[categoryIdx]||'').trim(),
        currentPrice:money!=null&&money>0?money:null,priceSource:money!=null&&money>0?'Расчётная цена из прайса':'Нет данных',
        published:null,weightGrams:null};
    });
    cached={time:Date.now(),items,categories:[...new Set(items.map(x=>x.category).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ru'))};
    return cached;
  })().finally(()=>loading=null);
  return loading;
}
function send(res,status,payload){
  res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');
  return res.end(JSON.stringify(payload));
}
function input(req){if(typeof req.body==='string'){try{return JSON.parse(req.body);}catch{throw new Error('Неверный JSON');}}return req.body||{};}
function normalizeCity(value){
  const city=String(value||'Астана').trim();if(!core.CITY_CODES[city])throw new Error('Неизвестный город');return city;
}
function hashPreview(text,city){return crypto.createHash('sha256').update(city+'\n'+text).digest('hex');}
function settingsMap(rows){return new Map(rows.map(r=>[normalizeSku(r.sku)+'|'+r.city,r]));}
function csvCell(value){
  let v=String(value??'');
  if(/^[=+\-@]/.test(v))v="'"+v;
  return '"'+v.replace(/"/g,'""')+'"';
}
async function service(req,res,deps={loadCatalog,readRows:storage.readRows,commit:storage.commit,status:storage.status}){
  try{
    const method=String(req.method||'GET').toUpperCase(),op=String(req.query?.op||'list');
    if(method==='OPTIONS'){res.statusCode=204;return res.end();}
    if(!['list','save','import','export','changes','status'].includes(op))return send(res,404,{ok:false,error:'Неизвестная операция'});
    if((op==='list'||op==='export'||op==='changes'||op==='status')&&method!=='GET'||(op==='save'||op==='import')&&method!=='POST')return send(res,405,{ok:false,error:'Недопустимый метод'});
    if(op==='status'){
      const flags=await deps.status();
      return send(res,200,{ok:true,
        serviceAccountConfigured:!!flags.serviceAccountConfigured,
        sheetConfigured:!!flags.sheetConfigured,
        sheetExists:!!flags.sheetExists,
        canRead:!!flags.canRead});
    }
    const city=normalizeCity(req.query?.city|| (method==='POST'?input(req).city:null));
    const catalog=await deps.loadCatalog();
    const known=new Map(catalog.items.map(item=>[normalizeSku(item.sku),item]));
    const state=await deps.readRows();
    const byKey=settingsMap(state);
    if(op==='save'){
      const payload=input(req);
      const setting=core.validateSettings({...payload,city});
      const canonical=known.get(normalizeSku(setting.sku));
      if(!canonical)return send(res,404,{ok:false,error:'Артикул не найден в каталоге'});
      const old=byKey.get(normalizeSku(setting.sku)+'|'+city)||{};
      const stored={...old,...setting,sku:canonical.sku,updatedAt:old.updatedAt||''};
      await deps.commit([stored]);return send(res,200,{ok:true,sku:stored.sku,city,updatedAt:stored.updatedAt});
    }
    if(op==='import'){
      const payload=input(req);const text=payload.text;
      const entries=core.parseImport(text,{defaultCity:city});
      const found=entries.filter(r=>known.has(normalizeSku(r.sku)));
      const missing=entries.filter(r=>!known.has(normalizeSku(r.sku))).map(r=>r.sku);
      const cities={};
      for(const r of found){const rowCity=r.city||city;cities[rowCity]=(cities[rowCity]||0)+1;}
      const preview={willUpdate:found.length,notFound:missing.length,missingSkus:missing.slice(0,50),cities};
      if(payload.mode!=='commit')return send(res,200,{ok:true,mode:'preview',preview,previewToken:hashPreview(text,city)});
      if(payload.previewToken!==hashPreview(text,city))return send(res,400,{ok:false,error:'Сначала выполните предпросмотр импорта'});
      const now=new Date().toISOString();
      const updates=found.map(r=>{
        const product=known.get(normalizeSku(r.sku));
        const rowCity=r.city||city;
        const old=byKey.get(normalizeSku(product.sku)+'|'+rowCity)||{};
        return {...old,sku:product.sku,city:rowCity,enabled:!!old.enabled,min:old.min??null,step:old.step??null,max:old.max??null,note:old.note||'',
          firstPrice:r.firstPrice,position:r.position,sellers:r.sellers,...(r.myPrice!=null?{myPrice:r.myPrice}:{}),updatedAt:now};
      });
      if(updates.length)await deps.commit(updates);
      return send(res,200,{ok:true,mode:'committed',...preview});
    }
    if(op==='export'){
      const rows=state.filter(r=>r.city===city);
      const columns=core.HEADERS;
      const values=[columns,...rows.map(r=>core.storeRow(r))];
      const csv='\uFEFF'+values.map(row=>row.map(csvCell).join(';')).join('\r\n');
      res.statusCode=200;res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition','attachment; filename="gb-dumping.csv"');res.setHeader('Cache-Control','no-store');
      return res.end(csv);
    }
    const expanded=catalog.items.map(item=>{
      const row=byKey.get(normalizeSku(item.sku)+'|'+city)||{};
      const settings={enabled:false,min:null,step:null,max:null,note:'',firstPrice:null,position:null,sellers:null,updatedAt:'',...row};
      const calculation=core.calculate(item,settings,core.minProfitFromEnv(process.env.GB_DUMPING_MIN_PROFIT));
      const price=core.priceDetails(item,settings);
      const facts=core.competitorFacts(item,settings);
      return {...item,...settings,...price,...facts,city,calculation};
    });
    if(op==='changes'){
      const changes=expanded.filter(x=>x.calculation.recommendedPrice!=null)
        .map(x=>({sku:x.sku,price:x.calculation.recommendedPrice}));
      return send(res,200,{ok:true,city,count:changes.length,changes});
    }
    const published=String(req.query?.published||'');
    const page=core.pageCatalog(expanded,{page:req.query?.page,search:req.query?.search,city,
      published,category:String(req.query?.category||''),sort:req.query?.sort,placeFilter:String(req.query?.placeFilter||'')});
    return send(res,200,{ok:true,...page,city,cityCode:core.CITY_CODES[city],categories:catalog.categories,
      warnings:published==='published'?['Статус публикации в источнике отсутствует: отобрать опубликованные товары невозможно.']:[],
      sourceNote:'При отсутствии импортированной вашей цены отображается расчётная из прайса, не подтверждённая цена предложения Kaspi.'});
  }catch(error){
    const text=String(error.message||'Ошибка');
    const invalid=/^(Артикул|Мин |Заметка|Требуется|Укажите|Неизвестный город|Размер импорта|Нет данных|Нет строк|Строка |Повтор|Неверный JSON|Некорректные настройки|Сначала|Неоднозначн)/.test(text);
    if(!invalid)console.error('Dumping API failure:',text.replace(/(?:Bearer\s+|private_key|access_token).*/gi,'[redacted]'));
    return send(res,invalid?400:503,{ok:false,error:invalid?text:'Сервис демпинга временно недоступен'});
  }
}
const handler=(req,res)=>service(req,res);
module.exports=handler;
module.exports = require('../lib/access-guard').protect(module.exports);
module.exports.__test={service,loadCatalog,hashPreview};
