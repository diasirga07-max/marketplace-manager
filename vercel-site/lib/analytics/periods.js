'use strict';

// Period presets, comparison periods and chart granularity. All dates are
// Asia/Almaty calendar dates (UTC+5, no DST) in ISO form YYYY-MM-DD.

const { almatyDateIso, almatyDayStart } = require('../sales-core');

const DAY_MS = 86_400_000;
const ALMATY_OFFSET_MS = 5 * 3_600_000;
const MAX_DAYS = 366;

const PRESETS = Object.freeze({
  today: 'Сегодня',
  yesterday: 'Вчера',
  '7d': '7 дней',
  week: 'Неделя',
  month: 'Месяц',
  '3m': '3 месяца',
  '6m': '6 месяцев',
  year: 'Год',
  custom: 'Свой период',
});

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) && almatyDayStart(value) != null;
}

function parts(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return { y, m, d };
}

function fromUtc(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(iso, days) {
  const { y, m, d } = parts(iso);
  return fromUtc(new Date(Date.UTC(y, m - 1, d + days)));
}

function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function addMonths(iso, months) {
  const { y, m, d } = parts(iso);
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const ny = first.getUTCFullYear();
  const nm = first.getUTCMonth() + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(d, daysInMonth(ny, nm))).padStart(2, '0')}`;
}

function daysBetween(from, to) {
  return Math.round((almatyDayStart(to) - almatyDayStart(from)) / DAY_MS) + 1;
}

function monthKey(iso) {
  return String(iso).slice(0, 7);
}

function monthStart(key) {
  return `${key}-01`;
}

function monthEnd(key) {
  const [y, m] = key.split('-').map(Number);
  return `${key}-${String(daysInMonth(y, m)).padStart(2, '0')}`;
}

function monthsBetween(from, to) {
  const keys = [];
  let cursor = monthKey(from);
  const last = monthKey(to);
  while (cursor <= last && keys.length < 40) {
    keys.push(cursor);
    cursor = monthKey(addMonths(`${cursor}-01`, 1));
  }
  return keys;
}

function weekday(iso) {
  // 0 = Monday ... 6 = Sunday
  const { y, m, d } = parts(iso);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

function granularityFor(days, preset) {
  if (preset === 'year') return 'month';
  if (preset === '3m' || preset === '6m') return 'week';
  if (days <= 1) return 'hour';
  if (days <= 62) return 'day';
  if (days <= 200) return 'week';
  return 'month';
}

function resolvePeriod(input = {}, now = Date.now()) {
  const today = almatyDateIso(now);
  const preset = PRESETS[input.preset] ? input.preset : 'month';
  let from;
  let to = today;
  switch (preset) {
    case 'today': from = today; break;
    case 'yesterday': from = addDays(today, -1); to = from; break;
    case '7d': from = addDays(today, -6); break;
    case 'week': from = addDays(today, -weekday(today)); break;
    case 'month': from = `${monthKey(today)}-01`; break;
    case '3m': from = `${monthKey(addMonths(today, -2))}-01`; break;
    case '6m': from = `${monthKey(addMonths(today, -5))}-01`; break;
    case 'year': from = `${monthKey(addMonths(today, -11))}-01`; break;
    default: {
      from = isIsoDate(input.from) ? input.from : today;
      to = isIsoDate(input.to) ? input.to : from;
      if (to > today) to = today;
      if (from > to) throw new Error('Дата «С» не может быть позже даты «По»');
    }
  }
  const days = daysBetween(from, to);
  if (days > MAX_DAYS) throw new Error(`Максимальный период — ${MAX_DAYS} дней`);
  return {
    preset,
    label: PRESETS[preset],
    from,
    to,
    days,
    today,
    granularity: granularityFor(days, preset),
  };
}

function shiftRange(from, to, unit, amount) {
  if (unit === 'month') return { from: addMonths(from, amount), to: addMonths(to, amount) };
  return { from: addDays(from, amount), to: addDays(to, amount) };
}

// Previous period: calendar presets shift by their calendar unit (month-to-date
// is compared with the same days of the previous month), rolling presets by length.
function comparisonPeriods(period) {
  let previous;
  switch (period.preset) {
    case 'month': previous = shiftRange(period.from, period.to, 'month', -1); break;
    case '3m': previous = shiftRange(period.from, period.to, 'month', -3); break;
    case '6m': previous = shiftRange(period.from, period.to, 'month', -6); break;
    case 'year': previous = shiftRange(period.from, period.to, 'month', -12); break;
    default: previous = shiftRange(period.from, period.to, 'day', -period.days);
  }
  const yoy = shiftRange(period.from, period.to, 'month', -12);
  return { previous, yoy };
}

function rangeBounds(from, to) {
  return { ge: almatyDayStart(from), le: almatyDayStart(to) + DAY_MS - 1 };
}

function localIso(ms) {
  return fromUtc(new Date(ms + ALMATY_OFFSET_MS));
}

function localHour(ms) {
  return new Date(ms + ALMATY_OFFSET_MS).getUTCHours();
}

function bucketKey(ms, granularity) {
  const iso = localIso(ms);
  if (granularity === 'hour') return String(localHour(ms)).padStart(2, '0');
  if (granularity === 'day') return iso;
  if (granularity === 'week') return addDays(iso, -weekday(iso));
  return monthKey(iso);
}

const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

function ddmm(iso) {
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
}

function bucketList(from, to, granularity) {
  const buckets = [];
  if (granularity === 'hour') {
    for (let h = 0; h < 24; h += 1) {
      const key = String(h).padStart(2, '0');
      buckets.push({ key, label: `${key}:00` });
    }
    return buckets;
  }
  if (granularity === 'day') {
    for (let cursor = from; cursor <= to; cursor = addDays(cursor, 1)) {
      buckets.push({ key: cursor, label: ddmm(cursor), from: cursor, to: cursor });
    }
    return buckets;
  }
  if (granularity === 'week') {
    for (let cursor = addDays(from, -weekday(from)); cursor <= to; cursor = addDays(cursor, 7)) {
      const start = cursor < from ? from : cursor;
      const endRaw = addDays(cursor, 6);
      const end = endRaw > to ? to : endRaw;
      buckets.push({ key: cursor, label: `${ddmm(start)}–${ddmm(end)}`, from: start, to: end });
    }
    return buckets;
  }
  for (const key of monthsBetween(from, to)) {
    const [y, m] = key.split('-').map(Number);
    const start = monthStart(key) < from ? from : monthStart(key);
    const end = monthEnd(key) > to ? to : monthEnd(key);
    buckets.push({ key, label: `${MONTHS_SHORT[m - 1]} ${String(y).slice(2)}`, from: start, to: end });
  }
  return buckets;
}

module.exports = {
  DAY_MS,
  PRESETS,
  addDays,
  addMonths,
  bucketKey,
  bucketList,
  comparisonPeriods,
  daysBetween,
  daysInMonth,
  granularityFor,
  isIsoDate,
  localIso,
  monthEnd,
  monthKey,
  monthStart,
  monthsBetween,
  rangeBounds,
  resolvePeriod,
};
