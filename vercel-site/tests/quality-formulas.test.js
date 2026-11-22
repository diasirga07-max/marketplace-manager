'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../lib/quality/formulas');

const DAY = 86_400_000;

test('cleanOrdersNeeded: 40/2111 at 1% → 1889 (spec example), strict → 1890', () => {
  assert.equal(F.cleanOrdersNeeded(40, 2111, 0.01), 1889);
  assert.equal(F.cleanOrdersNeeded(40, 2111, 0.01, { strict: true }), 1890);
  assert.equal(40 / (2111 + 1889), 0.01);
  assert.ok(40 / (2111 + 1890) < 0.01);
});

test('cleanOrdersNeeded: already below target or no bad → 0', () => {
  assert.equal(F.cleanOrdersNeeded(0, 100, 0.01), 0);
  assert.equal(F.cleanOrdersNeeded(5, 1000, 0.01), 0);
  assert.equal(F.cleanOrdersNeeded(33, 1434, 0.05), 0);
  assert.equal(F.cleanOrdersNeeded(9, 1356, 0.01), 0);
});

test('cleanOrdersNeeded: cabinet numbers 21.11', () => {
  // delays 33/1434 → good (<5%) already; to 2%: ceil(33/0.02 − 1434) = 216
  assert.equal(F.cleanOrdersNeeded(33, 1434, 0.02), 216);
  // cancels 40/2111 to 3%: 40/0.03 − 2111 < 0 → 0
  assert.equal(F.cleanOrdersNeeded(40, 2111, 0.03), 0);
});

test('maxBadAllowed: 2111 × 1% → 21 (strictly below), integer boundary', () => {
  assert.equal(F.maxBadAllowed(2111, 0.01), 21);
  assert.ok(21 / 2111 < 0.01);
  assert.equal(F.maxBadAllowed(2000, 0.01), 19); // 20/2000 = 1% is not < 1%
  assert.equal(F.maxBadAllowed(2000, 0.01, { strict: false }), 20);
  assert.equal(F.maxBadAllowed(0, 0.01), 0);
  assert.equal(F.maxBadAllowed(1434, 0.05), 71); // 71.7 → 71
});

test('rateCalculator: cancels 40/2111, target 1%', () => {
  const c = F.rateCalculator({ bad: 40, total: 2111, target: 0.01, windowDays: 30 });
  assert.equal(c.cleanNeeded, 1889);
  assert.equal(c.badMax, 21);
  assert.equal(c.toRemove, 19);
  assert.equal(c.reached, false);
  assert.ok(Math.abs(c.ordersPerDay - 2111 / 30) < 1e-9);
  assert.ok(Math.abs(c.badPerDayAllowed - 0.7) < 1e-9);
});

test('zone: boundaries belong to «normal»', () => {
  const t = F.DEFAULT_THRESHOLDS;
  assert.equal(F.zone(0.0099, t.cancels), 'good');
  assert.equal(F.zone(0.01, t.cancels), 'normal');
  assert.equal(F.zone(0.019, t.cancels), 'normal');
  assert.equal(F.zone(0.03, t.cancels), 'normal');
  assert.equal(F.zone(0.0301, t.cancels), 'bad');
  assert.equal(F.zone(0.023, t.delays), 'good');
  assert.equal(F.zone(0.05, t.delays), 'normal');
  assert.equal(F.zone(0.11, t.delays), 'bad');
  assert.equal(F.zone(0.007, t.returns), 'good');
  assert.equal(F.zone(0.021, t.returns), 'bad');
  assert.equal(F.zone(4.9, t.rating), 'good');
  assert.equal(F.zone(4.6, t.rating), 'normal');
  assert.equal(F.zone(4.0, t.rating), 'normal');
  assert.equal(F.zone(3.99, t.rating), 'bad');
  assert.equal(F.zone(null, t.rating), 'nodata');
  assert.equal(F.zone(0.05, t.chats), 'manual');
});

test('ratingCalculator: fives needed and reserve of ones', () => {
  // avg 4.0 of 10 → to 4.5: ceil((45 − 40)/(5 − 4.5)) = 10
  assert.equal(F.ratingCalculator({ sum: 40, count: 10, target: 4.5 }).fivesNeeded, 10);
  // avg 4.9 of 1342, target 4.6: reserve = floor((6575.8 − 6173.2)/3.6) = 111
  const r = F.ratingCalculator({ average: 4.9, count: 1342, target: 4.6 });
  assert.equal(r.fivesNeeded, 0);
  assert.equal(r.reserveOnes, 111);
  assert.equal(r.approximate, true);
  const check = (4.9 * 1342 + 111) / (1342 + 111);
  assert.ok(check >= 4.6);
  assert.ok((4.9 * 1342 + 112) / (1342 + 112) < 4.6);
});

test('chatsNeeded: 12/244 to 50% → 110', () => {
  assert.equal(F.chatsNeeded({ answered: 12, total: 244, target: 0.5 }), 110);
  assert.equal(F.chatsNeeded({ answered: 200, total: 244, target: 0.5 }), 0);
});

test('whatIfWithout: removing a SKU with 12 of 40 cancels', () => {
  assert.ok(Math.abs(F.whatIfWithout({ bad: 40, total: 2111, groupBad: 12 }) - 28 / 2111) < 1e-12);
});

test('forecast: events drop out of the 30-day window, reach date found', () => {
  const now = Date.UTC(2026, 10, 21, 12);
  // 3 bad events 29, 28 and 5 days ago; 100 orders evenly in the window.
  const events = [now - 29 * DAY, now - 28 * DAY, now - 5 * DAY];
  const orders = Array.from({ length: 100 }, (_, i) => now - (i * 0.3 + 0.1) * DAY);
  const f = F.forecast({ events, orders, dailyOrders: 100 / 30, now, windowDays: 30, target: 0.015, horizonDays: 30 });
  assert.equal(f.series[0].bad, 3);
  assert.equal(f.series[0].total, 100);
  assert.equal(f.alreadyReached, false);
  // Day 1: 2/≈100 ≥ 1.5%; day 2: both old events left → 1/≈100 < 1.5%
  assert.equal(f.reachDay, 2);
  assert.equal(f.dropouts.length, 3);
  assert.equal(f.dropouts[0].leavesAt, events[0] + 30 * DAY);
  assert.equal(f.series[30].bad, 0);
});

test('overallStatus', () => {
  assert.equal(F.overallStatus(['good', 'good', 'good', 'good']).label, 'Отлично');
  assert.equal(F.overallStatus(['good', 'normal', 'good']).label, 'Хорошо');
  assert.equal(F.overallStatus(['normal', 'normal', 'good']).label, 'Нормально');
  assert.equal(F.overallStatus(['bad', 'good']).label, 'Плохо');
  assert.equal(F.overallStatus(['bad', 'bad']).label, 'Очень плохо');
  assert.equal(F.overallStatus(['nodata']).label, 'Нет данных');
});
