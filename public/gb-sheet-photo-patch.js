(()=>{
'use strict';
if(window.GB_SHEET_PHOTO_PATCH_LOADED)return;
window.GB_SHEET_PHOTO_PATCH_LOADED=true;
const SID='1dLU5KOi3WBLy3uNEiqGv5rf9ka0OwcEw_RjhDQW3H1E';
const OLD_SID='1qNILk0sLSVExmeIG3_ER8oeBMibSK4NtmXrG8BNpCiM';
const SHEET='Прайс KASPI';
const STOCK_KEY='gbWhStock1';
const norm=s=>String(s||'').trim().toUpperCase();
let req=0;
function jsonp(sid,tq){return new Promise((ok,no)=>{const cb='__gbph'+Date.now()+'_'+(++req),s=document.createElement('script'),tm=setTimeout(()=>{delete window[cb];s.remove();no(Error('Таймаут фото Google Sheets'))},25000);window[cb]=r=>{clearTimeout(tm);delete window[cb];s.remove();ok(r)};s.onerror=()=>{clearTimeout(tm);delete window[cb];s.remove();no(Error('Не удалось загрузить фото Google Sheets'))};s.src='https://docs.google.com/spreadsheets/d/'+sid+'/gviz/tq?sheet='+encodeURIComponent(SHEET)+'&headers=1&tqx='+encodeURIComponent('out:json;responseHandler:'+cb)+'&tq='+encodeURIComponent(tq)+'&_='+Date.now();document.head.appendChild(s)})}
const rows=r=>r?.table?.rows?.map(x=>(x.c||[]).map(c=>c?.v==null?'':String(c.v).trim()))||[];
function mergeRows(result,map){if(result.status!=='fulfilled')return;for(const x of rows(result.value)){const sku=norm(x[0]),name=String(x[1]||'').trim(),photo=String(x[2]||'').trim();if(!sku)continue;const old=map[sku]||{};map[sku]={name:name||old.name||'',photo:photo||old.photo||''}}}
function updateStock(map){let st={};try{st=JSON.parse(localStorage.getItem(STOCK_KEY)||'{}')||{}}catch{}let changed=0;for(const [key,item] of Object.entries(st)){const sku=norm(item?.sku||key),src=map[sku];if(!src)continue;const next=String(src.photo||'').trim();if(next&&item.photo!==next){item.photo=next;changed++}if(src.name&&!item.name)item.name=src.name}if(changed)localStorage.setItem(STOCK_KEY,JSON.stringify(st));return changed}
function refresh(){const q=document.getElementById('whq');if(q)q.dispatchEvent(new Event('input',{bubbles:true}));document.dispatchEvent(new CustomEvent('gb:photos-updated'))}
async function load(){try{const [cur,old]=await Promise.allSettled([jsonp(SID,'select A,B,AE where A is not null'),jsonp(OLD_SID,'select A,B,AE where A is not null')]),map={};mergeRows(old,map);mergeRows(cur,map);window.GB_PHOTOS=window.GB_PHOTOS||{};let count=0;for(const [sku,x] of Object.entries(map)){if(x.photo){window.GB_PHOTOS[sku]=x.photo;count++}}const changed=updateStock(map);console.info('GB photos from Sheets AE:',count,'stock updated:',changed);refresh()}catch(e){console.error('GB Sheet photo patch failed',e)}}
load();
})();
