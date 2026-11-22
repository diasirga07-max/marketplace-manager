'use strict';

// «Расходники»: pure calculations shared by the sales report («Продажи Kaspi»),
// «Динамика продаж» and the «Расходники» section. No I/O here.
//
// Base units (stock, consumption, unit prices):
//   label       — шт (термоэтикетка), price per 1 label
//   bag:<id>    — шт (курьерский пакет), price per 1 bag
//   stretch     — см (стрейч-плёнка),  price per 1 cm
//   tape        — см (скотч),          price per 1 cm

const { normalizeSku, almatyDateIso } = require('../sales-core');

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const BAG_ID_RE = /^[a-z0-9_-]{1,40}$/i;
const MAX_BAGS = 20;
const MAX_SKU_RULES = 2000;

const DEFAULT_CONFIG = Object.freeze({
  label: { name: 'Термоэтикетка 75×120 мм', packPrice: 0, packQty: 500, mode: 'order' },
  bags: [
    { id: 'bag-s', name: 'Пакет S', width: 17.5, height: 25, flap: 4, packPrice: 0, packQty: 100 },
    { id: 'bag-m', name: 'Пакет M', width: 24, height: 32, flap: 4, packPrice: 0, packQty: 100 },
    { id: 'bag-l', name: 'Пакет L', width: 30, height: 40, flap: 4, packPrice: 0, packQty: 100 },
  ],
  defaultBag: 'bag-m',
  bagBySku: {},
  bagRule: { minUnits: 3, bagId: 'bag-l' },
  stretch: { packPrice: 0, lengthM: 300, widthCm: 50, cmPerUnit: 30, bySku: {} },
  tape: { packPrice: 0, lengthM: 100, cmPerOrder: 50 },
  stock: {},
  planDays: 30,
  warnDays: 7,
});

function num(value) {
  if (typeof value === 'string') value = value.replace(/[\s ₸]/g, '').replace(',', '.');
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

function round(value, digits = 6) {
  const k = 10 ** digits;
  return Math.round(value * k) / k;
}

// Validation: prices and quantities ≥ 0, quantity in a pack > 0.
function nonNegative(value, label, errors, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = num(value);
  if (!Number.isFinite(n) || n < 0) {
    errors.push(`${label}: нужно число ≥ 0`);
    return fallback;
  }
  return round(n, 4);
}

function positive(value, label, errors, fallback) {
  if (value === undefined || value === null || value === '') {
    errors.push(`${label}: нужно число > 0`);
    return fallback;
  }
  const n = num(value);
  if (!Number.isFinite(n) || n <= 0) {
    errors.push(`${label}: нужно число > 0`);
    return fallback;
  }
  return round(n, 4);
}

function skuMap(input, label, errors, valueOf) {
  const out = {};
  const entries = input && typeof input === 'object' && !Array.isArray(input) ? Object.entries(input) : [];
  for (const [rawSku, rawValue] of entries.slice(0, MAX_SKU_RULES)) {
    const sku = normalizeSku(rawSku);
    if (!sku) continue;
    const value = valueOf(rawValue, `${label} ${sku}`);
    if (value !== undefined) out[sku] = value;
  }
  return out;
}

function normalizeStock(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [key, value] of Object.entries(input)) {
    if (!value || typeof value !== 'object') continue;
    const qty = num(value.qty);
    const at = Number(value.at);
    if (!Number.isFinite(qty) || !Number.isFinite(at) || at <= 0) continue;
    out[key] = { qty: round(qty, 3), at };
  }
  return out;
}

// Returns { config, errors }. With strict=false invalid values fall back to defaults silently.
function normalizeConfig(input = {}, { strict = false } = {}) {
  const errors = [];
  const src = input && typeof input === 'object' ? input : {};
  const d = DEFAULT_CONFIG;

  const labelIn = src.label || {};
  const label = {
    name: String(labelIn.name || d.label.name).trim().slice(0, 80) || d.label.name,
    packPrice: nonNegative(labelIn.packPrice, 'Этикетка — цена за рулон', errors, d.label.packPrice),
    packQty: positive(labelIn.packQty ?? d.label.packQty, 'Этикетка — штук в рулоне', errors, d.label.packQty),
    mode: labelIn.mode === 'unit' ? 'unit' : 'order',
  };

  const bagsIn = Array.isArray(src.bags) ? src.bags : d.bags;
  const bags = [];
  const seen = new Set();
  bagsIn.slice(0, MAX_BAGS).forEach((bag, index) => {
    if (!bag || typeof bag !== 'object') return;
    let id = String(bag.id || '').trim();
    if (!BAG_ID_RE.test(id) || seen.has(id)) id = `bag-${index + 1}-${Math.random().toString(36).slice(2, 6)}`;
    seen.add(id);
    const name = String(bag.name || '').trim().slice(0, 60) || `Пакет ${index + 1}`;
    bags.push({
      id,
      name,
      width: nonNegative(bag.width, `${name} — ширина`, errors, 0),
      height: nonNegative(bag.height, `${name} — высота`, errors, 0),
      flap: nonNegative(bag.flap, `${name} — клапан`, errors, 0),
      packPrice: nonNegative(bag.packPrice, `${name} — цена за пачку`, errors, 0),
      packQty: positive(bag.packQty ?? 100, `${name} — штук в пачке`, errors, 100),
    });
  });
  const bagIds = new Set(bags.map((bag) => bag.id));
  const defaultBag = bagIds.has(src.defaultBag) ? src.defaultBag : bagIds.has(d.defaultBag) ? d.defaultBag : (bags[0] ? bags[0].id : '');

  const bagBySku = skuMap(src.bagBySku, 'Пакет для артикула', errors, (value, label2) => {
    if (bagIds.has(String(value))) return String(value);
    if (value) errors.push(`${label2}: неизвестный размер пакета`);
    return undefined;
  });

  const ruleIn = src.bagRule || d.bagRule;
  const minUnits = nonNegative(ruleIn.minUnits, 'Правило пакета — N единиц', errors, 0);
  const bagRule = {
    minUnits: Math.floor(minUnits),
    bagId: bagIds.has(String(ruleIn.bagId || '')) ? String(ruleIn.bagId) : '',
  };

  const stretchIn = src.stretch || {};
  const stretch = {
    packPrice: nonNegative(stretchIn.packPrice, 'Стрейч — цена за рулон', errors, d.stretch.packPrice),
    lengthM: positive(stretchIn.lengthM ?? d.stretch.lengthM, 'Стрейч — длина рулона', errors, d.stretch.lengthM),
    widthCm: nonNegative(stretchIn.widthCm ?? d.stretch.widthCm, 'Стрейч — ширина', errors, d.stretch.widthCm),
    cmPerUnit: nonNegative(stretchIn.cmPerUnit ?? d.stretch.cmPerUnit, 'Стрейч — см на единицу', errors, d.stretch.cmPerUnit),
    bySku: skuMap(stretchIn.bySku, 'Стрейч для артикула', errors, (value, label2) => {
      const n = num(value);
      if (Number.isFinite(n) && n >= 0) return round(n, 2);
      errors.push(`${label2}: нужно число ≥ 0`);
      return undefined;
    }),
  };

  const tapeIn = src.tape || {};
  const tape = {
    packPrice: nonNegative(tapeIn.packPrice, 'Скотч — цена за рулон', errors, d.tape.packPrice),
    lengthM: positive(tapeIn.lengthM ?? d.tape.lengthM, 'Скотч — длина рулона', errors, d.tape.lengthM),
    cmPerOrder: nonNegative(tapeIn.cmPerOrder ?? d.tape.cmPerOrder, 'Скотч — см на заказ', errors, d.tape.cmPerOrder),
  };

  const planDays = Math.min(365, Math.max(1, Math.round(num(src.planDays) || d.planDays)));
  const warnDays = Math.min(90, Math.max(1, Math.round(num(src.warnDays) || d.warnDays)));

  const config = {
    label, bags, defaultBag, bagBySku, bagRule, stretch, tape,
    stock: normalizeStock(src.stock),
    planDays,
    warnDays,
    updatedAt: String(src.updatedAt || ''),
  };
  if (strict && errors.length) {
    const error = new Error(errors.slice(0, 6).join('; '));
    error.status = 400;
    throw error;
  }
  return { config, errors };
}

// ---------- items & prices ----------

function itemKeys(config) {
  return ['label', ...config.bags.map((bag) => `bag:${bag.id}`), 'stretch', 'tape'];
}

function itemTitle(config, key) {
  if (key === 'label') return config.label.name;
  if (key === 'stretch') return 'Стрейч-плёнка';
  if (key === 'tape') return 'Скотч';
  const bag = config.bags.find((b) => `bag:${b.id}` === key);
  return bag ? `${bag.name} ${bag.width}×${bag.height}${bag.flap ? `+${bag.flap}` : ''} см` : key.replace(/^bag:/, 'Пакет ');
}

// Units in one purchased pack/roll, in base units (шт or см).
function packUnits(config, key) {
  if (key === 'label') return config.label.packQty;
  if (key === 'stretch') return config.stretch.lengthM * 100;
  if (key === 'tape') return config.tape.lengthM * 100;
  const bag = config.bags.find((b) => `bag:${b.id}` === key);
  return bag ? bag.packQty : 0;
}

function packPrice(config, key) {
  if (key === 'label') return config.label.packPrice;
  if (key === 'stretch') return config.stretch.packPrice;
  if (key === 'tape') return config.tape.packPrice;
  const bag = config.bags.find((b) => `bag:${b.id}` === key);
  return bag ? bag.packPrice : 0;
}

function currentPrices(config) {
  const out = {};
  for (const key of itemKeys(config)) {
    const units = packUnits(config, key);
    const price = packPrice(config, key);
    out[key] = { packPrice: price, packUnits: units, unitPrice: units > 0 ? price / units : 0 };
  }
  return out;
}

function normalizeHistory(list) {
  return (Array.isArray(list) ? list : [])
    .filter((r) => r && typeof r.item === 'string' && ISO_DATE_RE.test(String(r.from || '')))
    .map((r) => ({
      id: String(r.id || `${r.item}@${r.from}`),
      item: r.item,
      from: String(r.from),
      packPrice: Number(r.packPrice) || 0,
      packUnits: Number(r.packUnits) || 0,
      unitPrice: Number(r.unitPrice) || 0,
      createdAt: String(r.createdAt || ''),
    }))
    .sort((a, b) => a.item.localeCompare(b.item) || a.from.localeCompare(b.from) || a.createdAt.localeCompare(b.createdAt));
}

// Price index: item -> sorted [{from, unitPrice}] (later createdAt wins for the same date).
function priceIndex(history) {
  const index = new Map();
  for (const record of normalizeHistory(history)) {
    const list = index.get(record.item) || [];
    const last = list[list.length - 1];
    if (last && last.from === record.from) list[list.length - 1] = record;
    else list.push(record);
    index.set(record.item, list);
  }
  return index;
}

// Price that was in force on `dateIso` (YYYY-MM-DD, Asia/Almaty), or null.
function priceAt(index, item, dateIso) {
  const list = index.get(item);
  if (!list || !list.length) return null;
  let found = null;
  for (const record of list) {
    if (record.from <= dateIso) found = record;
    else break;
  }
  return found;
}

// Records to append when prices change. `effectiveFrom` maps item -> YYYY-MM-DD.
function priceChanges(config, history, { today, effectiveFrom = {}, now = new Date().toISOString() } = {}) {
  const index = priceIndex(history);
  const prices = currentPrices(config);
  const changes = [];
  for (const [item, price] of Object.entries(prices)) {
    const from = ISO_DATE_RE.test(String(effectiveFrom[item] || '')) ? effectiveFrom[item] : today;
    const inForce = priceAt(index, item, from);
    const same = inForce
      && Math.abs(inForce.packPrice - price.packPrice) < 1e-9
      && Math.abs(inForce.packUnits - price.packUnits) < 1e-9;
    if (same) continue;
    // A record without any price yet and a zero price is not worth storing.
    if (!inForce && !(index.get(item) || []).length && price.packPrice === 0) continue;
    changes.push({
      id: `${item}@${from}`,
      item,
      from,
      packPrice: price.packPrice,
      packUnits: price.packUnits,
      unitPrice: price.unitPrice,
      createdAt: now,
    });
  }
  return changes;
}

function mergeHistory(history, changes) {
  const map = new Map(normalizeHistory(history).map((r) => [`${r.item}@${r.from}`, r]));
  for (const change of changes) map.set(`${change.item}@${change.from}`, change);
  return normalizeHistory([...map.values()]);
}

// ---------- per-order consumption & cost ----------

function bagArea(bag) {
  return (Number(bag && bag.width) || 0) * (Number(bag && bag.height) || 0);
}

// Bag choice:
//   1. артикул → размер (если у нескольких товаров заказа разные пакеты — берётся самый большой);
//   2. иначе пакет по умолчанию;
//   3. если в заказе больше N единиц — пакет из правила (если он не меньше выбранного).
function chooseBag(config, items, units) {
  const byId = new Map(config.bags.map((bag) => [bag.id, bag]));
  const larger = (a, b) => (!a ? b : !b ? a : bagArea(b) > bagArea(a) ? b : a);
  let chosen = null;
  let reason = 'default';
  for (const item of items) {
    const override = byId.get(config.bagBySku[normalizeSku(item.sku)]);
    if (override) {
      chosen = larger(chosen, override);
      reason = 'sku';
    }
  }
  if (!chosen) chosen = byId.get(config.defaultBag) || config.bags[0] || null;
  const rule = config.bagRule;
  if (rule && rule.minUnits > 0 && rule.bagId && units > rule.minUnits) {
    const ruleBag = byId.get(rule.bagId);
    const next = larger(chosen, ruleBag);
    if (next !== chosen) {
      chosen = next;
      reason = 'rule';
    }
  }
  return { bag: chosen, reason };
}

// Physical consumption of one order (no money).
function orderUsage(config, items) {
  const list = (Array.isArray(items) ? items : []).map((item) => ({
    sku: String(item.sku || ''),
    qty: Math.max(0, Number(item.qty ?? item.quantity) || 0),
  }));
  const units = list.reduce((sum, item) => sum + item.qty, 0);
  if (units <= 0) {
    return { units: 0, labels: 0, bag: null, bagReason: '', stretchCm: 0, tapeCm: 0, items: list.map((item) => ({ ...item, stretchCm: 0, cmPerUnit: 0 })) };
  }
  const { bag, reason } = chooseBag(config, list, units);
  const withStretch = list.map((item) => {
    const own = config.stretch.bySku[normalizeSku(item.sku)];
    const cmPerUnit = own != null ? own : config.stretch.cmPerUnit;
    return { ...item, cmPerUnit, cmOverride: own != null, stretchCm: item.qty * cmPerUnit };
  });
  return {
    units,
    labels: config.label.mode === 'unit' ? units : 1,
    bag,
    bagReason: reason,
    stretchCm: withStretch.reduce((sum, item) => sum + item.stretchCm, 0),
    tapeCm: config.tape.cmPerOrder,
    items: withStretch,
  };
}

// Usage in base units keyed by item key.
function usageByKey(usage) {
  const out = {};
  if (!usage || usage.units <= 0) return out;
  out.label = usage.labels;
  if (usage.bag) out[`bag:${usage.bag.id}`] = 1;
  out.stretch = usage.stretchCm;
  out.tape = usage.tapeCm;
  return out;
}

// Cost of one order on `dateIso` (Asia/Almaty date of completion).
// Stretch is allocated to its own item; label + bag + tape are split by quantity.
function orderCost(config, index, items, dateIso) {
  const usage = orderUsage(config, items);
  const zero = { total: 0, label: 0, bag: 0, stretch: 0, tape: 0, shared: 0, usage, missing: [], items: usage.items.map((item) => ({ ...item, stretch: 0, shared: 0, total: 0 })) };
  if (usage.units <= 0) return zero;
  const missing = [];
  const unit = (key) => {
    const record = priceAt(index, key, dateIso);
    if (!record) {
      missing.push(key);
      return 0;
    }
    return record.unitPrice;
  };
  const labelPrice = unit('label');
  const bagPrice = usage.bag ? unit(`bag:${usage.bag.id}`) : 0;
  const stretchPrice = usage.stretchCm > 0 ? unit('stretch') : 0;
  const tapePrice = usage.tapeCm > 0 ? unit('tape') : 0;
  const label = usage.labels * labelPrice;
  const bag = usage.bag ? bagPrice : 0;
  const tape = usage.tapeCm * tapePrice;
  const shared = label + bag + tape;
  const perItem = usage.items.map((item) => {
    const stretch = item.stretchCm * stretchPrice;
    const share = usage.units > 0 ? (shared * item.qty) / usage.units : 0;
    return { ...item, stretch, shared: share, total: stretch + share };
  });
  const stretch = perItem.reduce((sum, item) => sum + item.stretch, 0);
  return {
    total: label + bag + stretch + tape,
    label,
    bag,
    stretch,
    tape,
    shared,
    prices: { label: labelPrice, bag: bagPrice, stretch: stretchPrice, tape: tapePrice },
    usage,
    missing,
    items: perItem,
  };
}

// «Расходники не настроены» — every price in force today is zero / absent.
function configStatus(config, history, today = almatyDateIso()) {
  const index = priceIndex(history);
  const zero = [];
  const required = ['label', config.defaultBag ? `bag:${config.defaultBag}` : null, 'stretch', 'tape'].filter(Boolean);
  for (const key of required) {
    const record = priceAt(index, key, today);
    if (!record || !(record.unitPrice > 0)) zero.push(itemTitle(config, key));
  }
  const firstFrom = [...index.values()].map((list) => list[0] && list[0].from).filter(Boolean).sort()[0] || '';
  return { configured: zero.length < required.length, complete: zero.length === 0, zero, firstPriceFrom: firstFrom };
}

// ---------- applying to the sales report («Продажи Kaspi») ----------

// Compact per-order basis stored with the cached sales report, so prices and
// rules can change without re-reading orders from Kaspi.
function salesBasis(processedOrders) {
  const out = [];
  for (const order of Array.isArray(processedOrders) ? processedOrders : []) {
    const items = Array.isArray(order.items) ? order.items : [];
    if (!items.length) continue;
    out.push({
      t: Number(order.completionDate) || 0,
      i: items.map((item) => [String(item.sku || ''), Number(item.quantity) || 0, item.cogs == null ? 0 : 1]),
    });
  }
  return out;
}

function emptyMeta(state, extra = {}) {
  return {
    configured: false,
    complete: false,
    zero: [],
    missingPriceOrders: 0,
    firstPriceFrom: '',
    updatedAt: state && state.config ? state.config.updatedAt : '',
    ...extra,
  };
}

// Returns a new report object: summary/top/daily get `consumables` and profit
// reduced by them. The input (often a cached object) is not mutated.
function applyToSales(report, state) {
  if (!report || typeof report !== 'object') return report;
  const { consumableBasis, ...rest } = report;
  const out = {
    ...rest,
    summary: { ...(report.summary || {}), consumables: 0 },
    top: (report.top || []).map((row) => ({ ...row, consumables: 0 })),
    daily: (report.daily || []).map((row) => ({ ...row, consumables: 0 })),
  };
  if (!state || !state.config) {
    out.consumables = emptyMeta(state, { error: state && state.error ? state.error : 'Расходники недоступны' });
    return out;
  }
  const status = configStatus(state.config, state.history);
  out.consumables = emptyMeta(state, status);
  if (!Array.isArray(consumableBasis)) {
    out.consumables.basisMissing = true;
    return out;
  }
  const index = priceIndex(state.history);
  const topBySku = new Map(out.top.map((row) => [normalizeSku(row.sku), row]));
  const dailyByDate = new Map(out.daily.map((row) => [row.date, row]));
  const summary = out.summary;
  let missingOrders = 0;

  for (const order of consumableBasis) {
    const date = almatyDateIso(order.t);
    const items = order.i.map(([sku, qty, known]) => ({ sku, qty, known }));
    const cost = orderCost(state.config, index, items, date);
    if (cost.missing.length) missingOrders += 1;
    summary.consumables += cost.total;
    const daily = dailyByDate.get(date);
    if (daily) daily.consumables += cost.total;
    cost.items.forEach((item, idx) => {
      const known = items[idx].known === 1;
      const top = topBySku.get(normalizeSku(item.sku));
      if (top) {
        top.consumables += item.total;
        if (known) top.confirmedProfit -= item.total;
      }
      if (known) {
        summary.confirmedProfit -= item.total;
        if (daily) daily.confirmedProfit -= item.total;
      }
    });
  }

  if (summary.profitComplete) summary.profit = summary.confirmedProfit;
  for (const top of out.top) top.profit = top.missingCostUnits > 0 ? null : top.confirmedProfit;
  for (const daily of out.daily) daily.profit = daily.profitComplete ? daily.confirmedProfit : null;
  out.consumables.missingPriceOrders = missingOrders;
  return out;
}

// ---------- stock («Сейчас») ----------

function addUsage(target, usage) {
  for (const [key, value] of Object.entries(usageByKey(usage))) target[key] = (target[key] || 0) + value;
  return target;
}

// orders: [{ items:[{sku, qty}] }] -> base-unit totals + bags by size.
function needsFor(config, orders) {
  const totals = {};
  for (const order of orders) addUsage(totals, orderUsage(config, order.items));
  return totals;
}

// shipped: [{ at(ms), items }]; returns per-item stock overview.
// receipts: [{ item, qty(base units), at(ms) }] — приходы после последней инвентаризации.
function stockOverview(config, { active = [], shipped = [], receipts = [], now = Date.now(), avgWindowDays = 30 } = {}) {
  const need = needsFor(config, active);
  const windowFrom = now - avgWindowDays * 86_400_000;
  const recent = shipped.filter((order) => order.at >= windowFrom && order.at <= now);
  const recentUse = needsFor(config, recent);
  const keys = itemKeys(config);
  const rows = keys.map((key) => {
    const units = packUnits(config, key);
    const stock = config.stock[key] || null;
    let current = null;
    let usedSince = 0;
    let receivedSince = 0;
    let lastReceiptAt = null;
    if (stock) {
      for (const order of shipped) {
        if (order.at > stock.at) usedSince += usageByKey(orderUsage(config, order.items))[key] || 0;
      }
      for (const receipt of receipts) {
        if (receipt.item === key && receipt.at > stock.at) {
          receivedSince += Number(receipt.qty) || 0;
          lastReceiptAt = Math.max(lastReceiptAt || 0, receipt.at);
        }
      }
      current = stock.qty + receivedSince - usedSince;
    }
    const needNow = need[key] || 0;
    const avgDaily = (recentUse[key] || 0) / avgWindowDays;
    const short = current == null ? null : Math.max(0, needNow - current);
    const enough = current == null ? null : current >= needNow;
    const daysLeft = current == null ? null : avgDaily > 0 ? Math.max(0, current - needNow) / avgDaily : (enough ? Infinity : 0);
    const target = needNow + avgDaily * config.planDays;
    const buyUnits = current == null ? target : Math.max(0, target - current);
    const buyPacks = units > 0 && buyUnits > 1e-9 ? Math.ceil(buyUnits / units - 1e-9) : 0;
    let status = 'unknown';
    if (current != null) status = !enough ? 'red' : daysLeft < config.warnDays ? 'yellow' : 'green';
    return {
      key,
      title: itemTitle(config, key),
      unit: key === 'stretch' || key === 'tape' ? 'cm' : 'pcs',
      packUnits: units,
      stockQty: stock ? stock.qty : null,
      stockAt: stock ? stock.at : null,
      lastMoveAt: stock ? Math.max(stock.at, lastReceiptAt || 0) : null,
      receivedSince: stock ? receivedSince : null,
      usedSince: stock ? usedSince : null,
      current,
      need: needNow,
      enough,
      short,
      avgDaily,
      daysLeft: daysLeft === Infinity ? null : daysLeft,
      daysLeftInfinite: daysLeft === Infinity,
      buyUnits,
      buyPacks,
      status,
    };
  });
  return {
    activeOrders: active.length,
    activeUnits: active.reduce((s, o) => s + o.items.reduce((a, i) => a + (Number(i.qty) || 0), 0), 0),
    shippedRecent: recent.length,
    avgOrdersPerDay: recent.length / avgWindowDays,
    rows,
  };
}

module.exports = {
  DEFAULT_CONFIG,
  applyToSales,
  chooseBag,
  configStatus,
  currentPrices,
  itemKeys,
  itemTitle,
  mergeHistory,
  needsFor,
  normalizeConfig,
  normalizeHistory,
  orderCost,
  orderUsage,
  packUnits,
  priceAt,
  priceChanges,
  priceIndex,
  salesBasis,
  stockOverview,
  usageByKey,
};
