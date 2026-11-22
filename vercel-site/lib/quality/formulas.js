'use strict';

// Pure formulas for the «Показатели качества» section. No I/O here: every
// function is deterministic and covered by tests/quality-formulas.test.js.

const DAY_MS = 86_400_000;
const EPS = 1e-9;

// Default zones as in the Kaspi seller cabinet. `lowerIsBetter` metrics are
// rates (bad / total), rating is the only "higher is better" metric.
const DEFAULT_THRESHOLDS = Object.freeze({
  rating: { good: 4.6, bad: 4.0, lowerIsBetter: false, unit: 'score', windowDays: 90 },
  delays: { good: 0.05, bad: 0.10, lowerIsBetter: true, unit: 'rate', windowDays: 30 },
  returns: { good: 0.01, bad: 0.02, lowerIsBetter: true, unit: 'rate', windowDays: 30 },
  cancels: { good: 0.01, bad: 0.03, lowerIsBetter: true, unit: 'rate', windowDays: 30 },
  chats: { good: null, bad: null, lowerIsBetter: false, unit: 'rate', windowDays: 30 },
  chatTime: { good: null, bad: null, lowerIsBetter: true, unit: 'minutes', windowDays: 30 },
});

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function rate(bad, total) {
  bad = num(bad);
  total = num(total);
  return total > 0 ? bad / total : null;
}

// Zone of a value. Rates: < good → good, > bad → bad, otherwise normal
// (boundaries belong to «normal», as «4.0–4.6» / «1–3%» in the cabinet).
function zone(value, threshold) {
  if (value == null || !Number.isFinite(Number(value)) || !threshold) return 'nodata';
  if (threshold.good == null || threshold.bad == null) return 'manual';
  const v = Number(value);
  if (threshold.lowerIsBetter) {
    if (v < threshold.good - EPS) return 'good';
    if (v > threshold.bad + EPS) return 'bad';
    return 'normal';
  }
  if (v > threshold.good + EPS) return 'good';
  if (v < threshold.bad - EPS) return 'bad';
  return 'normal';
}

// How many orders without bad events are needed so that bad / (total + N)
// reaches the target T.
//   strict=false: rate ≤ T (formula from the spec: ceil(bad/T − total)),
//   strict=true:  rate < T (one more order when the division is exact).
// 40 / 2111, T = 1% → 1889 (exactly 1.00%), strict → 1890.
function cleanOrdersNeeded(bad, total, target, { strict = false } = {}) {
  bad = Math.max(0, num(bad));
  total = Math.max(0, num(total));
  target = num(target);
  if (target <= 0) return bad > 0 ? Infinity : 0;
  if (bad === 0) return 0;
  const x = bad / target - total;
  if (strict) return Math.max(0, Math.floor(x + EPS) + 1);
  return Math.max(0, Math.ceil(x - EPS));
}

// Max bad events allowed at the current volume to stay strictly below T.
// 2111 × 1% = 21.11 → 21. If total × T is an integer (2000 × 1% = 20)
// 20 / 2000 = 1% is not «below 1%», so 19.
function maxBadAllowed(total, target, { strict = true } = {}) {
  total = Math.max(0, num(total));
  target = num(target);
  if (total === 0 || target <= 0) return 0;
  const raw = total * target;
  const rounded = Math.round(raw);
  const isInteger = Math.abs(raw - rounded) < EPS;
  if (isInteger) return Math.max(0, strict ? rounded - 1 : rounded);
  return Math.max(0, Math.floor(raw));
}

function perDay(value, days = 30) {
  days = num(days);
  return days > 0 ? num(value) / days : 0;
}

// Calculator for one rate metric.
function rateCalculator({ bad, total, target, windowDays = 30 }) {
  bad = Math.max(0, num(bad));
  total = Math.max(0, num(total));
  const current = rate(bad, total);
  const badMax = maxBadAllowed(total, target, { strict: true });
  return {
    bad,
    total,
    target,
    current,
    reached: current != null && current < target - EPS,
    cleanNeeded: cleanOrdersNeeded(bad, total, target),
    cleanNeededStrict: cleanOrdersNeeded(bad, total, target, { strict: true }),
    badMax,
    toRemove: Math.max(0, bad - badMax),
    ordersPerDay: perDay(total, windowDays),
    badPerDayAllowed: perDay(badMax, windowDays),
  };
}

// Rating: how many 5★ are needed to reach the average R:
// (sum + 5k) / (n + k) ≥ R  →  k = ceil((R·n − sum) / (5 − R)).
// If already ≥ R: «reserve» = how many 1★ keep the average ≥ R:
// (sum + k) / (n + k) ≥ R  →  k = floor((sum − R·n) / (R − 1)).
function ratingCalculator({ average, count, sum, target }) {
  const n = Math.max(0, Math.round(num(count)));
  const total = sum != null && Number.isFinite(Number(sum)) ? Number(sum) : num(average) * n;
  const R = num(target);
  const approximate = sum == null;
  const avg = n > 0 ? total / n : null;
  if (R >= 5) return { average: avg, count: n, target: R, fivesNeeded: Infinity, reserveOnes: 0, approximate };
  if (n === 0) return { average: null, count: 0, target: R, fivesNeeded: R > 0 ? 1 : 0, reserveOnes: 0, approximate };
  const deficit = R * n - total;
  if (deficit > EPS) {
    return { average: avg, count: n, target: R, fivesNeeded: Math.ceil(deficit / (5 - R) - EPS), reserveOnes: 0, approximate };
  }
  const reserveOnes = R <= 1 ? Infinity : Math.max(0, Math.floor((total - R * n) / (R - 1) + EPS));
  return { average: avg, count: n, target: R, fivesNeeded: 0, reserveOnes, approximate };
}

// Chats: answered chats needed to reach the share T.
function chatsNeeded({ answered, total, target }) {
  return Math.max(0, Math.ceil(num(target) * num(total) - num(answered) - EPS));
}

// «If this group had no bad events, the store rate would be X».
function whatIfWithout({ bad, total, groupBad }) {
  return rate(Math.max(0, num(bad) - num(groupBad)), total);
}

// Forecast for a rolling window with zero new bad events.
//   events:  timestamps (ms) of bad events in the current window
//   orders:  timestamps (ms) of counted orders in the current window
//   dailyOrders: expected new counted orders per day (current pace)
// Day d: window = (now + d − windowDays, now + d]; old events/orders drop
// out, new orders are added at the current pace.
function forecast({ events = [], orders = [], dailyOrders = 0, now, windowDays = 30, target, horizonDays = 30 }) {
  const windowMs = windowDays * DAY_MS;
  const ev = events.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const od = orders.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const series = [];
  let reachDay = null;
  for (let d = 0; d <= horizonDays; d += 1) {
    const end = now + d * DAY_MS;
    const start = end - windowMs;
    const bad = ev.filter((t) => t > start && t <= end).length;
    const kept = od.filter((t) => t > start && t <= end).length;
    const added = Math.min(d, windowDays) * num(dailyOrders);
    const total = kept + added;
    const value = total > 0 ? bad / total : null;
    series.push({ day: d, at: end, bad, total: Math.round(total), value });
    if (reachDay == null && value != null && value < target - EPS) reachDay = d;
  }
  const dropouts = ev
    .map((t) => ({ eventAt: t, leavesAt: t + windowMs }))
    .filter((x) => x.leavesAt > now)
    .sort((a, b) => a.leavesAt - b.leavesAt);
  return {
    series,
    reachDay,
    reachAt: reachDay == null ? null : now + reachDay * DAY_MS,
    alreadyReached: reachDay === 0,
    dropouts,
  };
}

// Overall seller status from the zones of the official metrics.
const STATUS_LEVELS = ['Очень плохо', 'Плохо', 'Нормально', 'Хорошо', 'Отлично'];
function overallStatus(zones, { veryBad = false } = {}) {
  const list = zones.filter((z) => ['good', 'normal', 'bad'].includes(z));
  if (!list.length) return { level: null, label: 'Нет данных' };
  const bads = list.filter((z) => z === 'bad').length;
  const normals = list.filter((z) => z === 'normal').length;
  let level;
  if (veryBad || bads >= 2) level = 0;
  else if (bads === 1) level = 1;
  else if (normals >= 2) level = 2;
  else if (normals === 1) level = 3;
  else level = 4;
  return { level, label: STATUS_LEVELS[level] };
}

module.exports = {
  DAY_MS,
  DEFAULT_THRESHOLDS,
  STATUS_LEVELS,
  chatsNeeded,
  cleanOrdersNeeded,
  forecast,
  maxBadAllowed,
  overallStatus,
  perDay,
  rate,
  rateCalculator,
  ratingCalculator,
  whatIfWithout,
  zone,
};
