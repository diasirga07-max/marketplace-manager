function TMP_ENABLE_PRODUCTION() {
  PropertiesService.getScriptProperties().setProperties({
    KL_DRY_RUN: 'FALSE',
    KL_CUTOVER_READY: 'YES'
  }, false);
  Logger.log(JSON.stringify(PropertiesService.getScriptProperties().getProperties()).replace(/"(KASPI[^"]*TOKEN[^"]*)":"[^"]*"/gi, '"$1":"***"'));
}function TMP_INSTALL() {
  KL_INSTALL_PRODUCTION_TRIGGERS();
}function TMP_CHECK_XML() {
  var id = PropertiesService.getScriptProperties().getProperty('XML_FILE_ID');
  var xml = DriveApp.getFileById(id).getBlob().getDataAsString('UTF-8');
  var inStock = xml.match(/<offer sku="[^"]*">(?:(?!<\/offer>)[\s\S])*?preOrder="0"/g) || [];
  var skus = inStock.map(function (s) { return s.match(/sku="([^"]*)"/)[1]; });
  var dist = {};
  (xml.match(/preOrder="\d+"/g) || []).forEach(function (m) { dist[m] = (dist[m] || 0) + 1; });
  Logger.log('В наличии (preOrder=0): ' + skus.length + ' → ' + skus.join(', '));
  Logger.log('Распределение сроков: ' + JSON.stringify(dist));
}function TMP_CHECK_SKU() {
  var ss = SpreadsheetApp.openById(GB.SPREADSHEET_ID);
  var sh = ss.getSheetByName(GB.PRICE_SHEET);
  var n = sh.getLastRow() - 1;
  var a = sh.getRange(2, 1, n, 1).getDisplayValues();
  var b = sh.getRange(2, 2, n, 1).getDisplayValues();
  var q = sh.getRange(2, 17, n, 1).getDisplayValues();
  var u = sh.getRange(2, 21, n, 1).getDisplayValues();
  var xml = DriveApp.getFileById(PropertiesService.getScriptProperties().getProperty('XML_FILE_ID')).getBlob().getDataAsString('UTF-8');
  ['993899507', '387017139', 'KITAPENT00016'].forEach(function (s) {
    var rows = [];
    for (var i = 0; i < n; i++) {
      if (a[i][0].replace(/\s+/g, '').indexOf(s) >= 0) {
        rows.push('строка ' + (i + 2) + ': A=[' + a[i][0] + '] B=[' + b[i][0].slice(0, 30) + '] Q=[' + q[i][0] + '] U=[' + u[i][0] + ']');
      }
    }
    var m = xml.match(new RegExp('<offer sku="[^"]*' + s + '[^"]*">[\\s\\S]*?</offer>'));
    Logger.log(s + ' → в прайсе: ' + (rows.join(' | ') || 'НЕ НАЙДЕН') + ' → в XML: ' + (m ? m[0].replace(/\s+/g, ' ').slice(0, 300) : 'НЕТ'));
  });
}
