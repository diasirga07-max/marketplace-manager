'use strict';

// Telegram notification about new Flip orders. TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID
// live only in Vercel env; the token is never logged.

const LIMIT = 3900; // Telegram allows 4096 characters per message

const nf = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const money = (v) => `${nf.format(Math.round(Number(v) || 0))} ₸`;
const esc = (v) => String(v == null ? '' : v).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

function configured() {
  return Boolean(String(process.env.TELEGRAM_BOT_TOKEN || '').trim() && String(process.env.TELEGRAM_CHAT_ID || '').trim());
}

// units: [{ article, partnerCodes[], price, store }]
function formatMessage(units) {
  const n = units.length;
  const head = `🛒 <b>Flip: ${n} ${plural(n, 'новый заказ', 'новых заказа', 'новых заказов')}</b>`;
  const total = units.reduce((sum, u) => sum + (Number(u.price) || 0), 0);
  const foot = `\n<b>Итого: ${money(total)}</b>`;
  const lines = units.map((u, i) => {
    const codes = u.partnerCodes && u.partnerCodes.length ? u.partnerCodes.join(', ') : '—';
    return `${i + 1}. <code>${esc(u.article || '—')}</code> · коды: ${esc(codes)} · ${money(u.price)} · ${esc(u.store || 'склад не указан')}`;
  });
  let body = '';
  let shown = 0;
  for (const line of lines) {
    const rest = n - shown - 1;
    const tail = rest > 0 ? `\n…и ещё ${rest}` : '';
    if ((head + '\n' + body + line + tail + foot).length > LIMIT) break;
    body += `${line}\n`;
    shown += 1;
  }
  const more = n - shown > 0 ? `…и ещё ${n - shown}\n` : '';
  return `${head}\n\n${body}${more}${foot}`;
}

async function send(text, { fetchImpl = fetch } = {}) {
  const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = String(process.env.TELEGRAM_CHAT_ID || '').trim();
  if (!token || !chatId) throw new Error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID не настроены');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: controller.signal,
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok || json.ok === false) throw new Error(`Telegram: ${json.description || `HTTP ${response.status}`}`);
    return true;
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('Telegram не ответил вовремя');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { configured, formatMessage, send };
