// Старый экран «Контроль качества» (с зашитыми цифрами кабинета) заменён
// разделом «Показатели качества»: vercel-site/public/gb-quality.js (/quality).
// Этот файл оставлен как перенаправление для старых закешированных страниц.
(function(){
  if(window.GB_QUALITY_LOADED||document.getElementById('gbQualityRuntime'))return;
  var base='https://grants-book-kaspi-assistant.vercel.app';
  var url=(/grants-book-kaspi-assistant/.test(location.hostname)?'':base)+'/gb-quality.js?v=20261122-1';
  fetch(url,{cache:'no-store'}).then(function(r){if(!r.ok)throw new Error('quality '+r.status);return r.text()})
    .then(function(code){var s=document.createElement('script');s.id='gbQualityRuntime';s.textContent=code;document.body.appendChild(s)})
    .catch(function(e){console.error('Quality metrics load failed',e)});
})();
