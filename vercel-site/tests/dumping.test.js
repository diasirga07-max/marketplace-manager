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

test('dumping price source uses imported myPrice in calculations, with fallback warning', () => {
  const product={cost:1000,currentPrice:2800};
  const settings={enabled:true,min:2200,max:4000,step:100,firstPrice:3000};
  const fallback=core.priceDetails(product,settings);
  assert.deepEqual(fallback,{currentPrice:2800,priceSource:'расчётная',priceConfirmed:false});
  const calculated=core.calculate(product,settings);
  assert.equal(calculated.recommendedPrice,null);
  assert.ok(calculated.warnings.includes('цена не подтверждена'));
  const withImport={...settings,myPrice:3500};
  const price=core.priceDetails(product,withImport);
  assert.deepEqual(price,{currentPrice:3500,priceSource:'из импорта',priceConfirmed:true});
  const after=core.calculate(product,withImport);
  assert.equal(after.recommendedPrice,2900);
  assert.ok(!after.warnings.includes('цена не подтверждена'));
  assert.equal(core.priceDetails({...product,currentPrice:null},{}).priceSource,'нет данных');
});

test('dumping import supports optional fifth myPrice and preserves original four-column files', () => {
  const four=core.parseImport('BOOK1\t2700\t2\t10');
  assert.deepEqual(four,[{sku:'BOOK1',firstPrice:2700,position:2,sellers:10}]);
  const five=core.parseImport('Артикул\tЦена 1 места\tПозиция\tВсего продавцов\tМоя цена\nBOOK1\t2700\t2\t10\t3200');
  assert.deepEqual(five,[{sku:'BOOK1',firstPrice:2700,position:2,sellers:10,myPrice:3200}]);
  assert.deepEqual(core.parseImport('BOOK1\t2700\t2\t10\t'),four);
  assert.throws(()=>core.parseImport('BOOK1\t2700\t2\t10\t-1'),/положительное/);
  assert.equal(core.HEADERS.at(-1),'Моя цена');
  assert.equal(core.decodeRow(core.storeRow({sku:'BOOK1',city:'Астана',enabled:false,myPrice:3200})).myPrice,3200);
});

test('dumping import stores fifth-column price and keeps it on four-column updates', async () => {
  const oldRows=[{...state[0],myPrice:3500}];
  let saved=[];
  const mock={loadCatalog:async()=>catalog,readRows:async()=>oldRows,commit:async rows=>{saved=rows}};
  const invoke=async(text,mode,previewToken)=>{
    const res=result();
    await guarded.__test.service({method:'POST',query:{op:'import',city:'Астана'},body:{text,mode,previewToken}},res,mock);
    return res;
  };
  const withPrice='BOOK1\t2700\t2\t10\t3200';
  const preview=await invoke(withPrice,'preview');
  assert.equal(preview.statusCode,200);
  assert.equal((await invoke(withPrice,'commit',preview.body.previewToken)).statusCode,200);
  assert.equal(saved[0].myPrice,3200);
  const legacy='BOOK1\t2600\t2\t10';
  const previous=await invoke(legacy,'preview');
  assert.equal((await invoke(legacy,'commit',previous.body.previewToken)).statusCode,200);
  assert.equal(saved[0].myPrice,3500,'four-column updates preserve an existing imported price');
});

test('dumping list exposes imported source and effective current price', async () => {
  const mock={...deps,readRows:async()=>[{...state[0],myPrice:3500}]};
  const res=result();
  await guarded.__test.service({method:'GET',query:{op:'list',city:'Астана'}},res,mock);
  assert.equal(res.statusCode,200);
  assert.equal(res.body.rows[0].currentPrice,3500);
  assert.equal(res.body.rows[0].priceSource,'из импорта');
  assert.equal(res.body.rows[0].calculation.recommendedPrice,2600);
  assert.ok(!res.body.rows[0].calculation.warnings.includes('цена не подтверждена'));
  assert.equal(res.body.rows[1].priceSource,'расчётная');
});

test('dumping status is a protected read-only operation without leaking IDs or credentials',async()=>{
  let reads=0,writes=0,catalogReads=0;
  const mock={
    status:async()=>{reads++;return {serviceAccountConfigured:true,sheetConfigured:true,sheetExists:false,canRead:true,private_key:'DO-NOT-EXPOSE',email:'HIDDEN'};},
    loadCatalog:async()=>{catalogReads++;throw Error('Must not read price catalog');},
    readRows:async()=>{catalogReads++;throw Error('Must not create or read settings list');},
    commit:async()=>{writes++;throw Error('Must not write');},
  };
  const res=result();
  await guarded.__test.service({method:'GET',query:{op:'status'}},res,mock);
  assert.equal(res.statusCode,200);
  assert.deepEqual(res.body,{ok:true,serviceAccountConfigured:true,sheetConfigured:true,sheetExists:false,canRead:true});
  assert.equal(reads,1);assert.equal(writes,0);assert.equal(catalogReads,0);
  assert.ok(!JSON.stringify(res.body).includes('DO-NOT-EXPOSE'));
  assert.ok(!JSON.stringify(res.body).includes('email'));
  const denied=result();
  await guarded.__test.service({method:'POST',query:{op:'status'}},denied,mock);
  assert.equal(denied.statusCode,405);
});

test('dumping Sheets status inspects metadata and catalogue via GET only', async()=>{
  const storage=require('../lib/dumping-storage');
  const previous=process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON=JSON.stringify({client_email:'fake@example.invalid',private_key:'never-write-or-return'});
  const requests=[];
  try{
    const status=await storage.status(async path=>{
      requests.push(path);
      if(path.startsWith('?fields='))return {sheets:[{properties:{title:'Прайс KASPI'}}]};
      return {values:[['ч']]};
    });
    assert.deepEqual(status,{serviceAccountConfigured:true,sheetConfigured:true,sheetExists:false,canRead:true});
    assert.equal(requests.length,2);
    assert.ok(requests.every(path=>!path.includes(':batchUpdate')&&!path.includes('ДЕМПИНГ!A1')));
  }finally{
    if(previous===undefined)delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    else process.env.GOOGLE_SERVICE_ACCOUNT_JSON=previous;
  }
});

test('dumping UI defaults to All products, disables unpublished filter, and shows setup status',()=>{
  const fs=require('node:fs'),path=require('node:path');
  const source=fs.readFileSync(path.join(__dirname,'../public/gb-dumping.js'),'utf8');
  assert.match(source,/id="gdpPublished"[^>]*><option value="">Все товары<\/option>/);
  assert.match(source,/<option value="published" disabled title="нет данных о публикации">/);
  assert.match(source,/id="gdpStatus"/);
  assert.match(source,/Лист ДЕМПИНГ будет создан при первом сохранении/);
  assert.match(source,/node\('div','muted',r\.priceSource\|\|'нет данных'\)/);
  assert.match(source,/5-я колонка: Моя цена/);
});

test('dumping import matches service-export headers in arbitrary order including position 7/10 and city',()=>{
 const sample='Город\tПозиция\tМоя цена\tАртикул\tЦена 1 места\nАстана\t7/10\t3500\tBK-001\t3000\nАлматы\t1/4\t2200\tBK-001\t2200';
 const rows=core.parseImport(sample);
 assert.deepEqual(rows,[
  {sku:'BK-001',firstPrice:3000,position:7,sellers:10,myPrice:3500,city:'Астана'},
  {sku:'BK-001',firstPrice:2200,position:1,sellers:4,myPrice:2200,city:'Алматы'},
 ]);
 assert.deepEqual(core.parseImport('Артикул;Цена 1 места;Позиция;Город;Моя цена\nA;2900;7/10;Астана;3300'),[
  {sku:'A',firstPrice:2900,position:7,sellers:10,myPrice:3300,city:'Астана'},
 ]);
});

test('dumping importer refuses ambiguous or incomplete headers and mismatching seller totals',()=>{
 assert.throws(()=>core.parseImport('Артикул;Артикул;Цена 1 места;Позиция\nA;B;100;1/2'),/Неоднозначный/);
 assert.throws(()=>core.parseImport('Артикул;Моя цена;Город\nA;100;Астана'),/Неоднозначные заголовки/);
 assert.throws(()=>core.parseImport('Артикул;Цена 1 места;Позиция;Всего продавцов;Город\nA;100;7/10;9;Астана'),/не совпадает/);
 assert.throws(()=>core.parseImport('Артикул;Цена 1 места;Позиция;Город\nA;100;7;Астана'),/положительное/);
 assert.throws(()=>core.parseImport('Артикул;Цена 1 места;Позиция;Город\nA;100;7/10;Неизвестно'),/Неизвестный город/);
});

test('dumping comparison returns factual imported place and signed price gap, not guessed catalogue gap',()=>{
 const imported=core.competitorFacts({currentPrice:4500},{myPrice:3500,firstPrice:3000,position:7,sellers:10,updatedAt:'2026-10-25T10:00:00.000Z'},Date.parse('2026-10-25T10:21:00.000Z'));
 assert.equal(imported.myPlace,7);
 assert.equal(imported.totalSellers,10);
 assert.equal(imported.lowestPrice,3000);
 assert.equal(imported.myPrice,3500);
 assert.equal(imported.diffAbs,500);
 assert.equal(imported.diffPercent,16.67);
 assert.equal(imported.ageMinutes,21);
 assert.equal(imported.isStale,false);
 assert.equal(imported.dataSource,'импорт');
 const baseline=core.competitorFacts({currentPrice:4500},{firstPrice:3000,position:7,sellers:10,updatedAt:''});
 assert.equal(baseline.diffAbs,null);
 assert.equal(baseline.diffPercent,null);
 assert.equal(baseline.dataUpdatedAt,null);
 assert.equal(baseline.comparisonWarning,'моя цена не подтверждена');
 const below=core.competitorFacts({}, {myPrice:2800,firstPrice:3000,position:1,sellers:3});
 assert.equal(below.diffAbs,-200);
 assert.equal(below.diffPercent,-6.67);
});

test('dumping freshness marks older than 24 hours and unknown age separately',()=>{
 const ref=Date.parse('2026-10-25T20:00:00.000Z');
 const base={myPrice:4500,firstPrice:4000,position:2,sellers:10};
 assert.equal(core.competitorFacts({}, {...base,updatedAt:new Date(ref-25*3600000).toISOString()},ref).isStale,true);
 assert.equal(core.competitorFacts({}, {...base,updatedAt:new Date(ref-24*3600000).toISOString()},ref).isStale,false);
 assert.equal(core.competitorFacts({}, {...base,updatedAt:'unknown'},ref).ageMinutes,null);
 assert.equal(core.competitorFacts({}, {},ref).myPlace,null);
 assert.equal(core.competitorFacts({}, {},ref).lowestPrice,null);
});

test('dumping position filters and largest-gap-first sort use only confirmed imported values',()=>{
 const rows=[
  {sku:'a',city:'Астана',myPlace:1,lowestPrice:3000,diffPercent:0,diffAbs:0,enabled:false},
  {sku:'b',city:'Астана',myPlace:7,lowestPrice:3000,diffPercent:16.67,diffAbs:500,enabled:true},
  {sku:'c',city:'Астана',myPlace:2,lowestPrice:3000,diffPercent:40,diffAbs:1200,enabled:false},
  {sku:'d',city:'Астана',myPlace:null,lowestPrice:null,diffPercent:null,diffAbs:null,enabled:true},
 ];
 assert.deepEqual(core.pageCatalog(rows,{placeFilter:'first'}).rows.map(x=>x.sku),['a']);
 assert.deepEqual(core.pageCatalog(rows,{placeFilter:'not-first'}).rows.map(x=>x.sku),['b','c']);
 assert.deepEqual(core.pageCatalog(rows,{placeFilter:'missing'}).rows.map(x=>x.sku),['d']);
 assert.deepEqual(core.pageCatalog(rows,{sort:'gap'}).rows.map(x=>x.sku),['c','b','a','d']);
});

test('dumping API import preserves a per-row city and timestamps source without changing Kaspi price table',async()=>{
 const {__test}=guarded;
 const changes=[];
 const fake={
  loadCatalog:async()=>catalog,
  readRows:async()=>[],
  commit:async updates=>{changes.push(...updates);},
 };
 const inputText='Город\tАртикул\tМоя цена\tЦена 1 места\tПозиция\nАстана\tBOOK1\t3500\t2700\t7/10\nАлматы\tBOOK2\t6200\t5600\t1/5';
 const invoke=async(mode,previewToken)=>{
  const res=result();
  await __test.service({method:'POST',query:{op:'import',city:'Астана'},body:{text:inputText,mode,previewToken}},res,fake);
  return res;
 };
 const preview=await invoke('preview');
 assert.equal(preview.statusCode,200);
 assert.deepEqual(preview.body.preview.cities,{'Астана':1,'Алматы':1});
 const actual=await invoke('commit',preview.body.previewToken);
 assert.equal(actual.statusCode,200);
 assert.equal(changes.length,2);
 assert.deepEqual(changes.map(x=>x.city),['Астана','Алматы']);
 assert.deepEqual(changes.map(x=>x.position),[7,1]);
 assert.deepEqual(changes.map(x=>x.sellers),[10,5]);
 assert.equal(changes[0].myPrice,3500);
 assert.ok(Number.isFinite(Date.parse(changes[0].updatedAt)));
});

test('dumping savings settings must not overwrite competitor import timestamp',async()=>{
 const now='2026-10-24T15:00:00.000Z';
 let saved;
 const dummy={loadCatalog:async()=>catalog,readRows:async()=>[{...state[0],updatedAt:now}],commit:async rows=>{saved=rows[0]}};
 const res=result();
 await guarded.__test.service({method:'POST',query:{op:'save',city:'Астана'},body:{sku:'BOOK1',enabled:true,min:2200,max:3300,step:20,note:'updated'}},res,dummy);
 assert.equal(res.statusCode,200);
 assert.equal(saved.updatedAt,now);
});

test('dumping frontend prioritizes position and minimum price before min step max on both screens',()=>{
 const fs=require('node:fs'),path=require('node:path');
 const script=fs.readFileSync(path.join(__dirname,'../public/gb-dumping.js'),'utf8');
 assert.ok(script.indexOf('<th>Моё место</th>')<script.indexOf('<th>Демпинг · Мин'));
 assert.match(script,/primary\.append\(position\(item\),lowest\(item\)\)/);
 assert.match(script,/gbd-highlight/);
 assert.match(script,/Данные старше 24 часов/);
 assert.match(script,/placeFilter:st\.placeFilter/);
 assert.match(script,/input id="gdpFile" type="file"/);
 assert.doesNotMatch(script,/raw\.githubusercontent.*kaspi/i);
});

test('dumping importer accepts service-like currency prices and quoted header annotations',()=>{
 const example='Артикул;Моя цена;Цена 1 места;Позиция («7/10»);Город\n00123;3.500 ₸;2.670 ₸;7/10;Астана';
 const rows=core.parseImport(example);
 assert.deepEqual(rows,[{sku:'00123',firstPrice:2670,position:7,sellers:10,myPrice:3500,city:'Астана'}]);
});

test('dumping list returns dominant rank gap import city and freshness fields from stored settings',async()=>{
 const timestamp='2026-10-25T10:30:00.000Z';
 const stateRow={sku:'BOOK1',city:'Астана',enabled:false,min:null,step:null,max:null,note:'',
  myPrice:3500,firstPrice:3000,position:7,sellers:10,updatedAt:timestamp};
 const custom={loadCatalog:async()=>catalog,readRows:async()=>[stateRow],commit:async()=>{throw Error('Read must never write')}};
 const res=result();
 await guarded.__test.service({method:'GET',query:{op:'list',city:'Астана'}},res,custom);
 assert.equal(res.statusCode,200);
 const row=res.body.rows.find(r=>r.sku==='BOOK1');
 assert.equal(row.myPlace,7);
 assert.equal(row.totalSellers,10);
 assert.equal(row.lowestPrice,3000);
 assert.equal(row.myPrice,3500);
 assert.equal(row.diffAbs,500);
 assert.equal(row.diffPercent,16.67);
 assert.equal(row.dataUpdatedAt,timestamp);
 assert.equal(row.dataSource,'импорт');
 assert.equal(row.city,'Астана');
 assert.equal(row.priceSource,'из импорта');
 assert.ok(!Object.keys(row).includes('AB')&&!Object.keys(row).includes('AC')&&!Object.keys(row).includes('AD'));
});
