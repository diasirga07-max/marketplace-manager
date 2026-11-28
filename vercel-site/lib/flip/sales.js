'use strict';

// Normalization of GET /statistics/sales — fitted to the real response (supplierType "fee"):
// {
//   errors: [], supplierType: "fee", period: { from, to },
//   summary: {                                   // act of realization
//     realization: { count, price, sellingPrice, commission, total },
//     refunds:     { count, price, sellingPrice, commission, total },
//     net:         { price, sellingPrice, commission, total },          // realization − refunds
//     deductions:  { delivery: { rate, count, cost, caption, ratePerKg, bets: [{ rate, kg, count, cost }] },
//                    canceled | refundProcessing | storage: { rate, count, cost },
//                    returnsToSupplier: { rate, count, cost, ratePerKg, bets: [] },
//                    total },
//     payout                                     // amount Flip pays out
//   },
//   items: { rows: [{ type: sale|refund|cancel, date, name, supplierCodes, barcode, order,
//                     cnt, sellingPrice, commissionPercent, commission, total, reason }],
//            counts: { sale, refund, cancel }, pagination: { total, limit, pages, currentPage } }
// }
// Without `include` the API returns summary + items; include=summary|items returns one part.
// Other supplier types get only the summary. Omitted fields mean "no value" (0).

const { num } = require('./client');

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const first = (v) => (Array.isArray(v) ? v[0] : v);
const obj = (v) => (isObject(first(v)) ? first(v) : {});

// Russian labels for every summary field (flattened key → label).
const SECTION = { realization: 'Реализация', refunds: 'Возвраты', net: 'Итого за вычетом возвратов', deductions: 'Удержания' };
const FIELD = { count: 'шт', price: 'по цене поставщика', sellingPrice: 'по цене продажи', commission: 'комиссия Flip', total: 'итого' };
const DEDUCTION = { delivery: 'Доставка', canceled: 'Отмены', refundProcessing: 'Обработка возвратов', returnsToSupplier: 'Возвраты поставщику', storage: 'Хранение' };
const DEDUCTION_FIELD = { rate: 'ставка', count: 'шт', cost: 'сумма', caption: 'описание', ratePerKg: 'ставка за кг' };
const ROW_TYPES = { sale: 'Продажа', refund: 'Возврат', cancel: 'Отмена' };

function supplierTypeOf(body) {
  return (isObject(body) && body.supplierType) ? String(body.supplierType) : null;
}

function part(section) {
  const s = obj(section);
  return { count: num(s.count), price: num(s.price), sellingPrice: num(s.sellingPrice), commission: num(s.commission), total: num(s.total) };
}

function deductionsOf(raw) {
  const d = obj(raw);
  const list = Object.keys(DEDUCTION).map((key) => {
    const x = obj(d[key]);
    return { key, label: DEDUCTION[key], rate: num(x.rate), count: num(x.count), cost: num(x.cost), caption: x.caption ? String(x.caption) : '', ratePerKg: Boolean(x.ratePerKg) };
  });
  // Unknown deduction kinds are kept too.
  for (const [key, value] of Object.entries(d)) {
    if (key === 'total' || DEDUCTION[key] || !isObject(value)) continue;
    list.push({ key, label: key, rate: num(value.rate), count: num(value.count), cost: num(value.cost), caption: value.caption ? String(value.caption) : '', ratePerKg: Boolean(value.ratePerKg) });
  }
  return { total: num(d.total), list };
}

function normalizeSummary(body) {
  const b = isObject(body) ? body : {};
  const s = obj(b.summary);
  const realization = part(s.realization);
  const refunds = part(s.refunds);
  const netRaw = obj(s.net);
  const net = Object.keys(netRaw).length
    ? part(netRaw)
    : { count: 0, price: realization.price - refunds.price, sellingPrice: realization.sellingPrice - refunds.sellingPrice, commission: realization.commission - refunds.commission, total: realization.total - refunds.total };
  net.count = realization.count - refunds.count; // the API has no net.count
  return {
    supplierType: supplierTypeOf(b),
    period: isObject(b.period) ? { from: b.period.from || null, to: b.period.to || null } : null,
    hasSummary: Object.keys(s).length > 0,
    summary: { realization, refunds, net, deductions: deductionsOf(s.deductions), payout: num(s.payout) },
    fields: fieldsOf(s),
  };
}

// Every summary field as a labelled row (for the "all fields" table).
function fieldsOf(summary) {
  const rows = [];
  for (const [section, value] of Object.entries(summary || {})) {
    if (section === 'payout') { rows.push({ key: 'payout', label: 'К выплате', value: num(value), kind: 'money' }); continue; }
    const v = obj(value);
    if (section === 'deductions') {
      for (const [kind, d] of Object.entries(v)) {
        if (kind === 'total') { rows.push({ key: 'deductions.total', label: 'Удержания — итого', value: num(d), kind: 'money' }); continue; }
        for (const [field, x] of Object.entries(obj(d))) {
          if (field === 'bets') continue;
          const label = `${DEDUCTION[kind] || kind} — ${DEDUCTION_FIELD[field] || field}`;
          const kindOf = field === 'count' ? 'count' : field === 'caption' ? 'text' : field === 'ratePerKg' ? 'bool' : 'money';
          rows.push({ key: `deductions.${kind}.${field}`, label, value: kindOf === 'text' ? String(x) : kindOf === 'bool' ? Boolean(x) : num(x), kind: kindOf });
        }
      }
      continue;
    }
    for (const [field, x] of Object.entries(v)) {
      rows.push({ key: `${section}.${field}`, label: `${SECTION[section] || section} — ${FIELD[field] || field}`, value: num(x), kind: field === 'count' ? 'count' : 'money' });
    }
  }
  return rows;
}

// Figures of one day for «Динамика»: revenue = net selling price (sales − refunds),
// units = sold − refunded, plus Flip's commission and the payout.
function dailyTotals(report) {
  const s = report.summary;
  return {
    revenue: s.net.sellingPrice,
    units: s.net.count,
    commission: s.net.commission,
    payout: s.payout,
    refunds: s.refunds.count,
  };
}

function normalizeItems(body) {
  const items = obj(isObject(body) ? body.items : null);
  const rows = (Array.isArray(items.rows) ? items.rows : []).filter(isObject).map((r) => ({
    type: r.type ? String(r.type) : '',
    typeLabel: ROW_TYPES[r.type] || (r.type ? String(r.type) : '—'),
    date: r.date ? String(r.date) : '',
    order: r.order ? String(r.order) : '',
    name: r.name ? String(r.name) : '',
    supplierCodes: r.supplierCodes == null ? '' : Array.isArray(r.supplierCodes) ? r.supplierCodes.join(', ') : String(r.supplierCodes),
    barcode: r.barcode ? String(r.barcode) : '',
    cnt: num(r.cnt),
    sellingPrice: num(r.sellingPrice),
    commissionPercent: num(r.commissionPercent),
    commission: num(r.commission),
    total: num(r.total),
    reason: r.reason ? String(r.reason) : '',
  }));
  const c = obj(items.counts);
  const p = obj(items.pagination);
  return {
    rows,
    counts: { sale: num(c.sale), refund: num(c.refund), cancel: num(c.cancel) },
    pagination: { page: num(p.currentPage) || 1, pages: num(p.pages) || 1, total: num(p.total) || rows.length, limit: num(p.limit) },
  };
}

module.exports = { dailyTotals, fieldsOf, normalizeItems, normalizeSummary, ROW_TYPES };
