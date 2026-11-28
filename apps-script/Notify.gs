/** Уведомления. Каналы включаются только через Script Properties. */

var KL_NOTIFY = Object.freeze({
  ERROR_STREAK_PROPERTY: 'KL_ERROR_STREAK',
  EMAIL_PROPERTY: 'KL_NOTIFY_EMAIL',
  TELEGRAM_TOKEN_PROPERTY: '***',
  TELEGRAM_CHAT_PROPERTY: 'KL_TELEGRAM_CHAT_ID',
  THRESHOLD_PROPERTY: 'KL_NOTIFY_ERROR_THRESHOLD',
  LAST_HASH_PROPERTY: 'KL_LAST_NOTICE_HASH'
});

function klNotifyProps_() {
  return PropertiesService.getScriptProperties();
}

function klNotifyThreshold_() {
  return Math.max(1, Number(klNotifyProps_().getProperty(
    KL_NOTIFY.THRESHOLD_PROPERTY
  )) || 3);
}

function klNotifyHash_(text) {
  var source = String(text || '');
  if (typeof Utilities === 'undefined') return source;
  var digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    source,
    Utilities.Charset.UTF_8
  );
  return digest.map(function (byte) {
    var value = (byte + 256) % 256;
    return ('0' + value.toString(16)).slice(-2);
  }).join('');
}

function klNotifySend_(subject, body, force) {
  var props = klNotifyProps_();
  var hash = klNotifyHash_(subject + '\n' + body);
  if (!force && props.getProperty(KL_NOTIFY.LAST_HASH_PROPERTY) === hash) {
    return {sent: false, duplicate: true};
  }
  var channels = [];
  var email = klStockText_(props.getProperty(KL_NOTIFY.EMAIL_PROPERTY));
  if (email) {
    try {
      MailApp.sendEmail({to: email, subject: subject, body: body});
      channels.push('email');
    } catch (emailError) {
      console.error('Не удалось отправить email: ' + emailError.message);
    }
  }
  var token = klStockText_(props.getProperty(KL_NOTIFY.TELEGRAM_TOKEN_PROPERTY));
  var chatId = klStockText_(props.getProperty(KL_NOTIFY.TELEGRAM_CHAT_PROPERTY));
  if (token && chatId) {
    try {
      var response = UrlFetchApp.fetch(
        'https://api.telegram.org/bot' + encodeURIComponent(token) + '/sendMessage',
        {
          method: 'post',
          contentType: 'application/json',
          payload: JSON.stringify({chat_id: chatId, text: subject + '\n\n' + body}),
          muteHttpExceptions: true
        }
      );
      if (response.getResponseCode() >= 200 && response.getResponseCode() < 300) {
        channels.push('telegram');
      } else {
        console.error('Telegram вернул HTTP ' + response.getResponseCode());
      }
    } catch (telegramError) {
      console.error('Не удалось отправить Telegram: ' + telegramError.message);
    }
  }
  if (channels.length) props.setProperty(KL_NOTIFY.LAST_HASH_PROPERTY, hash);
  else console.warn(subject + '\n' + body);
  return {sent: channels.length > 0, channels: channels};
}

function klNotifyIssues_(rows, context) {
  var lines = (rows || []).slice(0, 25).map(function (row) {
    return [row[1], row[2], row[3], row[8], row[9]].filter(Boolean).join(' | ');
  });
  if ((rows || []).length > 25) lines.push('…ещё ' + (rows.length - 25));
  return klNotifySend_(
    '[Kaspi] Требуется проверка: ' + (context || 'сверка'),
    lines.join('\n') || 'Подробности отсутствуют.',
    false
  );
}

function klNotifyFailure_(error, context) {
  var props = klNotifyProps_();
  var streak = Number(props.getProperty(KL_NOTIFY.ERROR_STREAK_PROPERTY)) || 0;
  streak++;
  props.setProperty(KL_NOTIFY.ERROR_STREAK_PROPERTY, String(streak));
  var threshold = klNotifyThreshold_();
  // Одно уведомление на начало серии, чтобы частый триггер не рассылал спам.
  if (streak !== threshold) return {sent: false, streak: streak};
  var message = error && error.stack ? error.stack : String(error);
  var result = klNotifySend_(
    '[Kaspi] Серия ошибок: ' + (context || 'синхронизация'),
    'Ошибок подряд: ' + streak + '\n' + message.slice(0, 3500),
    true
  );
  // Если отправка временно не удалась, следующая ошибка повторит попытку.
  if (!result.sent) props.setProperty(
    KL_NOTIFY.ERROR_STREAK_PROPERTY, String(threshold - 1)
  );
  result.streak = streak;
  return result;
}

function klNotifySuccess_(message) {
  var props = klNotifyProps_();
  var before = Number(props.getProperty(KL_NOTIFY.ERROR_STREAK_PROPERTY)) || 0;
  props.setProperty(KL_NOTIFY.ERROR_STREAK_PROPERTY, '0');
  if (before >= klNotifyThreshold_()) {
    return klNotifySend_(
      '[Kaspi] Синхронизация восстановлена',
      message || 'Очередной цикл завершился успешно.',
      true
    );
  }
  return {sent: false, resetFrom: before};
}
