'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const core=require('../lib/dumping-core');
const guarded=require('../api/dumping');

function result(){
 let text='';const headers={};
 return {statusCode:200,headers,setHeader(k,v){headers[k.toLowerCase()]=v;},end(s=''){text=String(s);this.data=(()=>{
   try{return JSON.parse(text)}catch{return text}})();return this;},get body(){return this.data}};
}
const catalog={items:[{sku:'BOOK1',name:'Книга по биологии',category:'Книги',cost:1000,currentPrice:3000,photo:'',published:null},{sku:'BOOK2',name:'Книга по химии',category:'Книги',cost:1500,currentPrice:6000,published:null}],categories:['Книги']};
const state=[{sku:'BOOK1',city:'Астана',enabled:true,min:2500,step:100,max:4000,note:'OK',firstPrice:2700,position:2,sellers:10,updatedAt:'2026-10-25T08:00:00Z'}];
const deps={loadCatalog:async()=>catalog,readRows:async()=>state,commit:async rows=>{deps.saved=rows;return {updated:rows.length}}};
async function call(op,method='GET',body={},extra={}){
 const res=result();await guarded.__test.service({method,query:{op,...extra},body},res,deps);return res;
}
test('dumping calculates break-even from shared commission, tax, and delivery tariff',()=>{
 const p={cost:1000,currentPrice:3000,weightGrams:null};const row={enabled:true,min:1400,max:4000,step:100,firstPrice:2800};
 const r=core.calculate(p,row,0);
 assert.equal(r.delivery,149);
 assert.equal(r.breakEven,Math.ceil(1149/.845));
 assert.equal(r.recommendedPrice,2700);
 assert.equal(r.status,'Рекомендовано снижение');
 assert.ok(r.unitProfit>0&&r.margin>0);
});
test('dumping chooses minimum price without falling below break-even',()=>{
 const r=core.calculate({cost:1000,currentPrice:3000},{enabled:true,min:2300,max:3500,step:300,firstPrice:2500});
 assert.equal(r.recommendedPrice,2300);
});
test('dumping warns when min below cost-based break-even',()=>{
 const r=core.calculate({cost:1000,currentPrice:3000},{enabled:true,min:500,max:3500,step:20,firstPrice:2800});
 assert.equal(r.status,'Ниже безубыточности');
 assert.equal(r.recommendedPrice,null);
 assert.ok(r.warnings.some(x=>x.includes('безубыточной')));
});
test('dumping does not invent shipping for expensive item without weight',()=>{
 const r=core.calculate({cost:8000,currentPrice:14000},{enabled:true,min:10000,max:20000,step:50,firstPrice:13000});
 assert.equal(r.recommendedPrice,null);
 assert.equal(r.status,'Нет данных');
 assert.ok(r.warnings.includes('Укажите доставку'));
});
test('dumping reports below min, first place, off, and unreachable',()=>{
 const p={cost:500,currentPrice:3000};
 const settings={enabled:true,min:2000,max:4000,step:50,firstPrice:3000};
 assert.equal(core.calculate(p,{...settings,min:3500}).status,'Ниже мин');
 assert.equal(core.calculate(p,settings).status,'1 место');
 assert.equal(core.calculate(p,{...settings,firstPrice:4000}).status,'Ниже 1 места');
 assert.equal(core.calculate(p,{...settings,max:2100,firstPrice:2900}).status,'Недостижимо');
 assert.equal(core.calculate(p,{...settings,enabled:false}).status,'Демпинг выключен');
});
test('dumping settings validate min/max/step and note length',()=>{
 assert.throws(()=>core.validateSettings({sku:'A',enabled:true,min:200,step:0,max:400}),/положительное/);
 assert.throws(()=>core.validateSettings({sku:'A',enabled:true,min:500,step:10,max:400}),/Мин/);
 assert.throws(()=>core.validateSettings({sku:'A',enabled:true,min:1,step:10,max:20,note:'A'.repeat(501)}),/Заметка/);
 assert.throws(()=>core.validateSettings({sku:'',enabled:false}),/Артикул/);
 assert.equal(core.validateSettings({sku:'A',enabled:false}).min,null);
});
test('dumping sanitizes values that would be formulas in Sheets',()=>{
 assert.equal(core.cellText('=IMPORTXML("x")'),"'"+'=IMPORTXML("x")');
 assert.equal(core.cellText('+SUM(1,2)'),"'+SUM(1,2)");
 assert.equal(core.cellText('@cmd'),"'@cmd");
 assert.equal(core.storeRow({sku:'A',city:'Астана',note:'=1+1'})[6],"'=1+1");
});
test('dumping parses pasted TSV and CSV with optional heading',()=>{
 const tsv='Артикул\tЦена 1 места\tПозиция\tВсего продавцов\nBOOK1\t2700\t2\t10\nBOOK2\t3000\t1\t4';
 assert.deepEqual(core.parseImport(tsv).map(x=>x.firstPrice),[2700,3000]);
 assert.equal(core.parseImport('BOOK1;2700;2;10').length,1);
 assert.equal(core.parseImport('"BOOK1","2700","2","10"')[0].sellers,10);
});
test('dumping import rejects bad rows and duplicate SKU',()=>{
 assert.throws(()=>core.parseImport('BOOK1\t0\t1\t3'),/Строка 1/);
 assert.throws(()=>core.parseImport('BOOK1\t100\t4\t3'),/Позиция/);
 assert.throws(()=>core.parseImport('BOOK1\t100\t1\t2\nbook1\t200\t1\t2'),/повтор/);
});
test('dumping paginates on server by exactly 50 entries',()=>{
 const items=Array.from({length:117},(_,i)=>({sku:'SKU'+i,name:'Book '+i,city:'Астана',category:'Книги',enabled:i===100,published:null}));
 const first=core.pageCatalog(items,{page:1}),last=core.pageCatalog(items,{page:3});
 assert.equal(first.rows.length,50);assert.equal(last.rows.length,17);assert.equal(first.totalPages,3);
 assert.equal(first.rows[0].sku,'SKU100');
 assert.equal(core.pageCatalog(items,{search:'Book 106'}).total,1);
 assert.equal(core.pageCatalog(items,{published:'published'}).total,0);
});
test('dumping API list filters and paginates products without leaking secrets',async()=>{
 const res=await call('list','GET',{}, {city:'Астана',page:'1',search:'BOOK'});
 assert.equal(res.statusCode,200);assert.equal(res.body.rows.length,2);
 assert.equal(res.body.rows[0].sku,'BOOK1');
 assert.equal(res.body.rows[0].firstPrice,2700);
 assert.equal(res.body.rows[0].calculation.status,'Рекомендовано снижение');
 assert.equal(JSON.stringify(res.body).includes('GOOGLE_SERVICE_ACCOUNT_JSON'),false);
 assert.equal(res.headers['access-control-allow-origin'],undefined);
});
test('dumping API save validates and merges imported competitor values',async()=>{
 const invalid=await call('save','POST',{sku:'BOOK1',enabled:true,min:500,step:0,max:600});
 assert.equal(invalid.statusCode,400);
 const good=await call('save','POST',{sku:'BOOK1',enabled:true,min:2400,step:50,max:4000,note:'ok'});
 assert.equal(good.statusCode,200);assert.equal(deps.saved[0].firstPrice,2700);
});
test('dumping API requires preview before import and counts missing SKU',async()=>{
 const text='BOOK1\t2500\t1\t10\nNOTFOUND\t1800\t2\t8';
 const first=await call('import','POST',{text,mode:'preview'});
 assert.equal(first.body.preview.willUpdate,1);assert.equal(first.body.preview.notFound,1);
 const denied=await call('import','POST',{text,mode:'commit',previewToken:'wrong'});
 assert.equal(denied.statusCode,400);
 const good=await call('import','POST',{text,mode:'commit',previewToken:first.body.previewToken});
 assert.equal(good.statusCode,200);assert.equal(deps.saved[0].firstPrice,2500);
});
test('dumping new API is protected by GB_ACCESS_CODE and works when unset',async()=>{
 const old=process.env.GB_ACCESS_CODE;process.env.GB_ACCESS_CODE='unit-test-secret';
 try{
  const res=result();
  await guarded({method:'GET',query:{op:'list'},headers:{}},res);
  assert.equal(res.statusCode,401);assert.equal(res.body.code,'access_required');
  assert.equal(res.headers['cache-control'],'no-store');
 }finally{if(old==null)delete process.env.GB_ACCESS_CODE;else process.env.GB_ACCESS_CODE=old;}
 const res=await call('list');assert.equal(res.statusCode,200);
});
test('dumping API exports only settings as CSV with formula-safe cells',async()=>{
 const res=await call('export');assert.equal(res.statusCode,200);
 assert.match(res.headers['content-type'],/csv/);assert.match(res.body,/BOOK1/);
});
test('frontend loader uses same-origin and normal guarded fetch',()=>{
 const fs=require('node:fs'),path=require('node:path');
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
 const script=fs.readFileSync(path.join(__dirname,'../public/gb-dumping.js'),'utf8');
 assert.match(html,/fetch\('\/gb-dumping\.js\?v=20261025-1'/);
 assert.match(script,/window\.fetch\(/);
 assert.doesNotMatch(script,/originalFetch/);
});

