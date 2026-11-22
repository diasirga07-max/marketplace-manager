'use strict';

// «Расходники»: pure calculations shared by the sales report («Продажи Kaspi»),
// «Динамика продаж» and the «Расходники» section. No I/O here.
//
// Item keys and base units (stock, consumption, unit prices):
//   label          — шт (термоэтикетка)
//   bag:<id>       — шт (курьерский пакет)
//   stretch        — см (стрейч-плёнка)
//   tape:<id>      — см, если скотч «см на заказ»; рулоны, если «рулонов в месяц»
//
// Формат товара (A5, A4…): пакет по умолчанию и см стрейча на 1 единицу.
// Порядок выбора: переопределение по артикулу → формат артикула (или формат
// по умолчанию) → общие значения по умолчанию.

const { normalizeSku, almatyDateIso } = require('../sales-core');

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[a-z0-9_-]{1,40}$/i;
const MAX_BAGS = 20;
const MAX_FORMATS = 20;
const MAX_TAPES = 10;
const MAX_SKU_RULES = 2000;
const MAX_SKU_FORMATS = 15000;
const DAY_MS = 86_400_000;

const DEFAULT_CONFIG = Object.freeze({
  label: { name: 'Термоэтикетка 75×120 мм', packPrice: 0, packQty: 500, mode: 'order' },
  bags: [
    { id: 'bag-a5', name: 'Пакет курьерский A5', width: 20, height: 40, flap: 0, packPrice: 0, packQty: 100 },
    { id: 'bag-a4', name: 'Пакет курьерский A4', width: 30, height: 40, flap: 0, packPrice: 0, packQty: 100 },
  ],
  defaultBag: 'bag-a5',
  bagBySku: {},
  bagRule: { minUnits: 3, bagId: 'bag-a4' },
  formats: [
    { id: 'A5', name: 'A5', bagId: 'bag-a5', cmPerUnit: 70 },
    { id: 'A4', name: 'A4', bagId: 'bag-a4', cmPerUnit: 170 },
  ],
  defaultFormat: 'A5',
  skuFormat: {},
  stretch: { packPrice: 800, lengthM: 300, widthCm: 30, cmPerUnit: 70, bySku: {} },
  tapes: [
    { id: 'tape-glass', name: 'Скотч «Осторожно стекло»', packPrice: 400, lengthM: 100, mode: 'month', cmPerOrder: 50, rollsPerMonth: 1 },
    { id: 'tape-clear', name: 'Скотч прозрачный', packPrice: 500, lengthM: 100, mode: 'month', cmPerOrder: 50, rollsPerMonth: 1 },
  ],
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
  const n = value === undefined || value === null || value === '' ? NaN : num(value);
  if (!Number.isFinite(n) || n <= 0) {
    errors.push(`${label}: нужно число > 0`);
    return fallback;
  }
  return round(n, 4);
}

// Empty → null («не задано, взять общее значение»).
function optionalNonNegative(value, label, errors) {
  if (value === undefined || value === null || value === '') return null;
  return nonNegative(value, label, errors, null);
}

function skuMap(input, label, errors, valueOf, limit = MAX_SKU_RULES) {
  const out = {};
  const entries = input && typeof input === 'object' && !Array.isArray(input) ? Object.entries(input) : [];
  if (entries.length > limit) errors.push(`${label}: не больше ${limit} артикулов`);
  for (const [rawSku, rawValue] of entries.slice(0, limit)) {
    const sku = normalizeSku(rawSku);
    if (!sku) continue;
    const value = valueOf(rawValue, `${label} ${sku}`);
    if (value !== undefined) out[sku] = value;
  }
  return out;
}

function uniqueId(raw, prefix, index, seen) {
  let id = String(raw || '').trim();
  if (!ID_RE.test(id) || seen.has(id)) id = `${prefix}-${index + 1}-${Math.random().toString(36).slice(2, 6)}`;
  seen.add(id);
  return id;
}

function normalizeStock(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [key, value] of Object.entries(input)) {
    if (!value || typeof value !== 'object') continue;
    const qty = num(value.qty);
    const at = Number(value.at);
    if (!Number.isFinite(qty) || !Number.isFinite(at) || at <= 0) continue;
    out[key] = { qty: round(qty, 4), at };
  }
  return out;
}

// Older drafts had a single `tape` object; it becomes the first kind of tape.
function tapesInput(src) {
  if (Array.isArray(src.tapes)) return src.tapes;
  if (src.tape && typeof src.tape === 'object') return [{ id: 'tape', name: 'Скотч', mode: 'order', ...src.tape }];
  return DEFAULT_CONFIG.tapes;
}

// Returns { config, errors }. With strict=true invalid input throws (status 400).
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

  const bags = [];
  const seenBags = new Set();
  (Array.isArray(src.bags) ? src.bags : d.bags).slice(0, MAX_BAGS).forEach((bag, index) => {
    if (!bag || typeof bag !== 'object') return;
    const id = uniqueId(bag.id, 'bag', index, seenBags);
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
  const bagRule = {
    minUnits: Math.floor(nonNegative(ruleIn.minUnits, 'Правило пакета — N единиц', errors, 0)),
    bagId: bagIds.has(String(ruleIn.bagId || '')) ? String(ruleIn.bagId) : '',
  };

  const formats = [];
  const seenFormats = new Set();
  (Array.isArray(src.formats) ? src.formats : d.formats).slice(0, MAX_FORMATS).forEach((format, index) => {
    if (!format || typeof format !== 'object') return;
    const name = String(format.name || format.id || '').trim().slice(0, 30) || `Формат ${index + 1}`;
    const id = uniqueId(format.id || name.replace(/[^a-z0-9_-]/gi, ''), 'fmt', index, seenFormats);
    formats.push({
      id,
      name,
      bagId: bagIds.has(String(format.bagId || '')) ? String(format.bagId) : '',
      cmPerUnit: optionalNonNegative(format.cmPerUnit, `Формат ${name} — см стрейча на единицу`, errors),
    });
  });
  const formatIds = new Set(formats.map((f) => f.id));
  const defaultFormat = src.defaultFormat === '' ? '' : formatIds.has(src.defaultFormat) ? src.defaultFormat : formatIds.has(d.defaultFormat) ? d.defaultFormat : '';
  const skuFormat = skuMap(src.skuFormat, 'Формат артикула', errors, (value, label2) => {
    if (formatIds.has(String(value))) return String(value);
    if (value) errors.push(`${label2}: неизвестный формат`);
    return undefined;
  }, MAX_SKU_FORMATS);

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

  const tapes = [];
  const seenTapes = new Set();
  tapesInput(src).slice(0, MAX_TAPES).forEach((tape, index) => {
    if (!tape || typeof tape !== 'object') return;
    const id = uniqueId(tape.id, 'tape', index, seenTapes);
    const name = String(tape.name || '').trim().slice(0, 60) || `Скотч ${index + 1}`;
    const mode = tape.mode === 'month' ? 'month' : 'order';
    tapes.push({
      id,
      name,
      packPrice: nonNegative(tape.packPrice, `${name} — цена за рулон`, errors, 0),
      lengthM: mode === 'order'
        ? positive(tape.lengthM ?? 100, `${name} — длина рулона`, errors, 100)
        : nonNegative(tape.lengthM ?? 100, `${name} — длина рулона`, errors, 100) || 100,
      mode,
      cmPerOrder: nonNegative(tape.cmPerOrder ?? 50, `${name} — см на заказ`, errors, 50),
      rollsPerMonth: nonNegative(tape.rollsPerMonth ?? 1, `${name} — рулонов в месяц`, errors, 1),
    });
  });

  const config = {
    label, bags, defaultBag, bagBySku, bagRule,
    formats, defaultFormat, skuFormat,
    stretch, tapes,
    stock: normalizeStock(src.stock),
    planDays: Math.min(365, Math.max(1, Math.round(num(src.planDays) || d.planDays))),
    warnDays: Math.min(90, Math.max(1, Math.round(num(src.warnDays) || d.warnDays))),
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

function findTape(config, key) {
  return config.tapes.find((t) => `tape:${t.id}` === key) || null;
}

function findBag(config, key) {
  return config.bags.find((b) => `bag:${b.id}` === key) || null;
}

function itemKeys(config) {
  return ['label', ...config.bags.map((b) => `bag:${b.id}`), 'stretch', ...config.tapes.map((t) => `tape:${t.id}`)];
}

// 'pcs' | 'cm' | 'roll'
function unitKind(config, key) {
  if (key === 'stretch') return 'cm';
  const tape = findTape(config, key);
  if (tape) return tape.mode === 'month' ? 'roll' : 'cm';
  return 'pcs';
}

function itemTitle(config, key) {
  if (key === 'label') return config.label.name;
  if (key === 'stretch') return 'Стрейч-плёнка';
  const tape = findTape(config, key);
  if (tape) return tape.name;
  const bag = findBag(config, key);
  if (bag) return `${bag.name} ${bag.width}×${bag.height}${bag.flap ? `+${bag.flap}` : ''} см`;
  return key.replace(/^bag:/, 'Пакет ').replace(/^tape:/, 'Скотч ');
}

// Units in one purchased pack/roll, in base units.
function packUnits(config, key) {
  if (key === 'label') return config.label.packQty;
  if (key === 'stretch') return config.stretch.lengthM * 100;
  const tape = findTape(config, key);
  if (tape) return tape.mode === 'month' ? 1 : tape.lengthM * 100;
  const bag = findBag(config, key);
  return bag ? bag.packQty : 0;
}

function packPrice(config, key) {
  if (key === 'label') return config.label.packPrice;
  if (key === 'stretch') return config.stretch.packPrice;
  const tape = findTape(config, key);
  if (tape) return tape.packPrice;
  const bag = findBag(config, key);
  return bag ? bag.packPrice : 0;
}

function currentPrices(config) {
  const out = {};
  for (const key of itemKeys(config)) {
    const units = packUnits(config, key);
    const price = packPrice(config, key);
    out[key] = { packPrice: price, packUnits: units, unitPrice: units > 0 ? price / units : 0, unit: unitKind(config, key) };
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

// Price index: item -> sorted records (the latest record for the same date wins).
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
  const changes = [];
  for (const [item, price] of Object.entries(currentPrices(config))) {
    const from = ISO_DATE_RE.test(String(effectiveFrom[item] || '')) ? effectiveFrom[item] : today;
    const inForce = priceAt(index, item, from);
    const same = inForce
      && Math.abs(inForce.packPrice - price.packPrice) < 1e-9
      && Math.abs(inForce.packUnits - price.packUnits) < 1e-9;
    if (same) continue;
    if (!inForce && !(index.get(item) || []).length && price.packPrice === 0) continue;
    changes.push({ id: `${item}@${from}`, item, from, packPrice: price.packPrice, packUnits: price.packUnits, unitPrice: price.unitPrice, createdAt: now });
  }
  return changes;
}

function mergeHistory(history, changes) {
  const map = new Map(normalizeHistory(history).map((r) => [`${r.item}@${r.from}`, r]));
  for (const change of changes) map.set(`${change.item}@${change.from}`, change);
  return normalizeHistory([...map.values()]);
}

// ---------- formats ----------

// Format of an article: explicit assignment, else the default format.
function formatOf(config, sku) {
  const id = config.skuFormat[normalizeSku(sku)] || config.defaultFormat;
  return config.formats.find((f) => f.id === id) || null;
}

function hasOwnFormat(config, sku) {
  return Boolean(config.skuFormat[normalizeSku(sku)]);
}

// ---------- per-order consumption & cost ----------

function bagArea(bag) {
  return (Number(bag && bag.width) || 0) * (Number(bag && bag.height) || 0);
}

// Bag of one article: артикул → пакет, иначе пакет формата, иначе пакет по умолчанию.
function itemBag(config, sku, byId) {
  const override = byId.get(config.bagBySku[normalizeSku(sku)]);
  if (override) return { bag: override, source: 'sku' };
  const format = formatOf(config, sku);
  const formatBag = format ? byId.get(format.bagId) : null;
  if (formatBag) return { bag: formatBag, source: 'format', format: format.name };
  const fallback = byId.get(config.defaultBag) || config.bags[0] || null;
  return { bag: fallback, source: 'default' };
}

// Order bag: the largest of the items' bags (orders with different formats get
// the biggest one); if the order has more than N units — the rule bag, when it
// is not smaller.
function chooseBag(config, items, units) {
  const byId = new Map(config.bags.map((bag) => [bag.id, bag]));
  let chosen = null;
  let reason = 'default';
  for (const item of items) {
    const candidate = itemBag(config, item.sku, byId);
    if (!candidate.bag) continue;
    if (!chosen || bagArea(candidate.bag) > bagArea(chosen)) {
      chosen = candidate.bag;
      reason = candidate.source;
    }
  }
  if (!chosen) chosen = byId.get(config.defaultBag) || config.bags[0] || null;
  const rule = config.bagRule;
  if (rule && rule.minUnits > 0 && rule.bagId && units > rule.minUnits) {
    const ruleBag = byId.get(rule.bagId);
    if (ruleBag && (!chosen || bagArea(ruleBag) > bagArea(chosen))) {
      chosen = ruleBag;
      reason = 'rule';
    }
  }
  return { bag: chosen, reason };
}

// See per-article stretch: артикул → см, иначе см формата, иначе общее значение.
function itemStretch(config, sku) {
  const own = config.stretch.bySku[normalizeSku(sku)];
  if (own != null) return { cmPerUnit: own, source: 'sku' };
  const format = formatOf(config, sku);
  if (format && format.cmPerUnit != null) return { cmPerUnit: format.cmPerUnit, source: 'format', format: format.name };
  return { cmPerUnit: config.stretch.cmPerUnit, source: 'default' };
}

// Physical consumption of one order (no money). Monthly tapes are not
// consumed per order — they appear in the cost only.
function orderUsage(config, items) {
  const list = (Array.isArray(items) ? items : []).map((item) => ({
    sku: String(item.sku || ''),
    qty: Math.max(0, Number(item.qty ?? item.quantity) || 0),
  }));
  const units = list.reduce((sum, item) => sum + item.qty, 0);
  const orderTapes = config.tapes.filter((t) => t.mode === 'order');
  if (units <= 0) {
    return { units: 0, labels: 0, bag: null, bagReason: '', stretchCm: 0, tapes: [], items: list.map((item) => ({ ...item, stretchCm: 0, cmPerUnit: 0 })) };
  }
  const { bag, reason } = chooseBag(config, list, units);
  const withStretch = list.map((item) => {
    const s = itemStretch(config, item.sku);
    const format = formatOf(config, item.sku);
    return { ...item, format: format ? format.name : '', ownFormat: hasOwnFormat(config, item.sku), cmPerUnit: s.cmPerUnit, cmSource: s.source, stretchCm: item.qty * s.cmPerUnit };
  });
  return {
    units,
    labels: config.label.mode === 'unit' ? units : 1,
    bag,
    bagReason: reason,
    stretchCm: withStretch.reduce((sum, item) => sum + item.stretchCm, 0),
    tapes: orderTapes.map((t) => ({ id: t.id, cm: t.cmPerOrder })),
    items: withStretch,
  };
}

// Per-order usage in base units keyed by item key.
function usageByKey(usage) {
  const out = {};
  if (!usage || usage.units <= 0) return out;
  out.label = usage.labels;
  if (usage.bag) out[`bag:${usage.bag.id}`] = 1;
  out.stretch = usage.stretchCm;
  for (const tape of usage.tapes) out[`tape:${tape.id}`] = (out[`tape:${tape.id}`] || 0) + tape.cm;
  return out;
}

function monthOf(dateIso) {
  return String(dateIso).slice(0, 7);
}

// Unit price of an order-mode tape (per cm) from a history record.
function tapeCmPrice(record, tape) {
  if (record.packUnits > 1) return record.unitPrice;
  return tape.lengthM > 0 ? record.packPrice / (tape.lengthM * 100) : 0;
}

// Cost of one order on `dateIso` (Asia/Almaty date of completion).
// ctx.monthOrders(monthKey) -> number of (не отменённых) orders in that calendar month,
// used by «рулонов в месяц» tapes. Stretch goes to its own item; label + bag +
// tapes are split between items by quantity.
function orderCost(config, index, items, dateIso, ctx = {}) {
  const usage = orderUsage(config, items);
  const tapeLines = [];
  const zero = { total: 0, label: 0, bag: 0, stretch: 0, tape: 0, shared: 0, tapes: tapeLines, usage, missing: [], items: usage.items.map((item) => ({ ...item, stretch: 0, shared: 0, total: 0 })) };
  if (usage.units <= 0) return zero;
  const missing = [];
  const record = (key) => {
    const found = priceAt(index, key, dateIso);
    if (!found) missing.push(key);
    return found;
  };
  const labelRec = record('label');
  const labelPrice = labelRec ? labelRec.unitPrice : 0;
  const bagRec = usage.bag ? record(`bag:${usage.bag.id}`) : null;
  const bagPrice = bagRec ? bagRec.unitPrice : 0;
  const stretchRec = usage.stretchCm > 0 ? record('stretch') : null;
  const stretchPrice = stretchRec ? stretchRec.unitPrice : 0;

  for (const tape of config.tapes) {
    const key = `tape:${tape.id}`;
    if (tape.mode === 'order') {
      if (!(tape.cmPerOrder > 0)) continue;
      const rec = record(key);
      const price = rec ? tapeCmPrice(rec, tape) : 0;
      tapeLines.push({ key, name: tape.name, mode: 'order', cm: tape.cmPerOrder, unitPrice: price, cost: tape.cmPerOrder * price });
    } else {
      if (!(tape.rollsPerMonth > 0)) continue;
      const rec = record(key);
      const month = monthOf(dateIso);
      const info = typeof ctx.monthOrders === 'function' ? ctx.monthOrders(month) : null;
      const orders = info && typeof info === 'object' ? Number(info.count) : Number(info);
      const projected = Boolean(info && typeof info === 'object' && info.projected);
      if (!(orders > 0)) missing.push(`${key}:orders`);
      const monthly = rec ? tape.rollsPerMonth * rec.packPrice : 0;
      tapeLines.push({ key, name: tape.name, mode: 'month', rollsPerMonth: tape.rollsPerMonth, rollPrice: rec ? rec.packPrice : 0, month, monthOrders: orders > 0 ? orders : 0, projected, cost: orders > 0 ? monthly / orders : 0 });
    }
  }

  const label = usage.labels * labelPrice;
  const bag = usage.bag ? bagPrice : 0;
  const tape = tapeLines.reduce((sum, line) => sum + line.cost, 0);
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
    tapes: tapeLines,
    shared,
    prices: { label: labelPrice, bag: bagPrice, stretch: stretchPrice },
    usage,
    missing,
    items: perItem,
  };
}

// «Расходники не настроены» — every price in force today is zero / absent.
function configStatus(config, history, today = almatyDateIso()) {
  const index = priceIndex(history);
  const zero = [];
  const required = ['label', config.defaultBag ? `bag:${config.defaultBag}` : null, 'stretch', ...config.tapes.map((t) => `tape:${t.id}`)].filter(Boolean);
  for (const key of required) {
    const record = priceAt(index, key, today);
    if (!record || !(record.packPrice > 0)) zero.push(itemTitle(config, key));
  }
  const firstFrom = [...index.values()].map((list) => list[0] && list[0].from).filter(Boolean).sort()[0] || '';
  return {
    configured: zero.length < required.length,
    complete: zero.length === 0,
    zero,
    firstPriceFrom: firstFrom,
    monthlyTapes: config.tapes.some((t) => t.mode === 'month' && t.rollsPerMonth > 0),
  };
}

// ---------- monthly order counts («рулонов в месяц») ----------

function daysInMonthKey(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// counts: Map|object monthKey -> orders so far. For the current month the
// count is projected to the whole month (so far / прошедшие дни × дней в месяце).
function monthOrdersProvider(counts, today = almatyDateIso()) {
  const get = (key) => (counts instanceof Map ? counts.get(key) : counts && counts[key]);
  const currentMonth = monthOf(today);
  const elapsed = Number(today.slice(8, 10));
  return (key) => {
    const raw = Number(get(key));
    if (!(raw > 0)) return null;
    if (key === currentMonth && elapsed < daysInMonthKey(key)) {
      return { count: (raw / elapsed) * daysInMonthKey(key), actual: raw, projected: true };
    }
    return { count: raw, actual: raw, projected: false };
  };
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

// Completed («выданные», не отменённые) orders in a raw «Динамика продаж» month.
function rawMonthCount(orders, excludeTenTenge = true) {
  return (Array.isArray(orders) ? orders : []).filter((order) => order.kind === 'sale'
    && Array.isArray(order.items) && order.items.length
    && !(excludeTenTenge && Number(order.total) === 10)).length;
}

function monthsBetween(fromIso, toIso) {
  const out = [];
  let [y, m] = fromIso.slice(0, 7).split('-').map(Number);
  const end = toIso.slice(0, 7);
  for (let guard = 0; guard < 400; guard += 1) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    if (key > end) break;
    out.push(key);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

// Orders per calendar month in the basis (Asia/Almaty completion date).
function basisMonthCounts(basis) {
  const counts = new Map();
  for (const order of Array.isArray(basis) ? basis : []) {
    const key = monthOf(almatyDateIso(order.t));
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function emptyMeta(state, extra = {}) {
  return {
    configured: false,
    complete: false,
    zero: [],
    missingPriceOrders: 0,
    missingMonthOrders: 0,
    firstPriceFrom: '',
    updatedAt: state && state.config ? state.config.updatedAt : '',
    ...extra,
  };
}

// Returns a new report object: summary/top/daily get `consumables` and profit
// reduced by them. The input (often a cached object) is not mutated.
// options.monthCounts: Map monthKey -> orders in that month (for monthly tapes).
function applyToSales(report, state, options = {}) {
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
  const counts = new Map(basisMonthCounts(consumableBasis));
  for (const [key, value] of (options.monthCounts instanceof Map ? options.monthCounts : new Map())) counts.set(key, value);
  const ctx = { monthOrders: monthOrdersProvider(counts, options.today) };
  out.consumables.monthOrders = Object.fromEntries([...counts.keys()].sort().map((key) => [key, ctx.monthOrders(key)]));
  const index = priceIndex(state.history);
  const topBySku = new Map(out.top.map((row) => [normalizeSku(row.sku), row]));
  const dailyByDate = new Map(out.daily.map((row) => [row.date, row]));
  const summary = out.summary;
  let missingOrders = 0;
  let missingMonth = 0;

  for (const order of consumableBasis) {
    const date = almatyDateIso(order.t);
    const items = order.i.map(([sku, qty, known]) => ({ sku, qty, known }));
    const cost = orderCost(state.config, index, items, date, ctx);
    if (cost.missing.some((k) => !k.endsWith(':orders'))) missingOrders += 1;
    if (cost.missing.some((k) => k.endsWith(':orders'))) missingMonth += 1;
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
  out.consumables.missingMonthOrders = missingMonth;
  return out;
}

// ---------- stock («Сейчас») ----------

function addUsage(target, usage) {
  for (const [key, value] of Object.entries(usageByKey(usage))) target[key] = (target[key] || 0) + value;
  return target;
}

function needsFor(config, orders) {
  const totals = {};
  for (const order of orders) addUsage(totals, orderUsage(config, order.items));
  return totals;
}

// Rolls of a monthly tape used between two moments, proportional to the days
// of each calendar month (Asia/Almaty).
function monthlyRollsBetween(rollsPerMonth, fromMs, toMs) {
  if (!(rollsPerMonth > 0) || !(toMs > fromMs)) return 0;
  const offset = 5 * 3_600_000;
  let total = 0;
  let cursor = fromMs;
  while (cursor < toMs) {
    const local = new Date(cursor + offset);
    const y = local.getUTCFullYear();
    const m = local.getUTCMonth();
    const monthEnd = Date.UTC(y, m + 1, 1) - offset;
    const end = Math.min(toMs, monthEnd);
    const days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    total += rollsPerMonth * ((end - cursor) / DAY_MS) / days;
    cursor = end;
  }
  return total;
}

// receipts: [{ item, qty(base units), at(ms) }] — приходы после последней инвентаризации.
function stockOverview(config, { active = [], shipped = [], receipts = [], now = Date.now(), avgWindowDays = 30 } = {}) {
  const need = needsFor(config, active);
  const windowFrom = now - avgWindowDays * DAY_MS;
  const recent = shipped.filter((order) => order.at >= windowFrom && order.at <= now);
  const recentUse = needsFor(config, recent);
  const rows = itemKeys(config).map((key) => {
    const units = packUnits(config, key);
    const tape = findTape(config, key);
    const monthly = Boolean(tape && tape.mode === 'month');
    const stock = config.stock[key] || null;
    let current = null;
    let usedSince = 0;
    let receivedSince = 0;
    let lastReceiptAt = null;
    if (stock) {
      if (monthly) usedSince = monthlyRollsBetween(tape.rollsPerMonth, stock.at, now);
      else for (const order of shipped) if (order.at > stock.at) usedSince += usageByKey(orderUsage(config, order.items))[key] || 0;
      for (const receipt of receipts) {
        if (receipt.item === key && receipt.at > stock.at) {
          receivedSince += Number(receipt.qty) || 0;
          lastReceiptAt = Math.max(lastReceiptAt || 0, receipt.at);
        }
      }
      current = stock.qty + receivedSince - usedSince;
    }
    const needNow = monthly ? 0 : need[key] || 0;
    const avgDaily = monthly ? (tape.rollsPerMonth * 12) / 365 : (recentUse[key] || 0) / avgWindowDays;
    const short = current == null ? null : Math.max(0, needNow - current);
    const enough = current == null ? null : monthly ? current > 0 : current >= needNow;
    const daysLeft = current == null ? null : avgDaily > 0 ? Math.max(0, current - needNow) / avgDaily : (enough ? Infinity : 0);
    const target = needNow + avgDaily * config.planDays;
    const buyUnits = current == null ? target : Math.max(0, target - current);
    const buyPacks = units > 0 && buyUnits > 1e-9 ? Math.ceil(buyUnits / units - 1e-9) : 0;
    let status = 'unknown';
    if (current != null) status = !enough ? 'red' : daysLeft < config.warnDays ? 'yellow' : 'green';
    return {
      key,
      title: itemTitle(config, key),
      unit: unitKind(config, key),
      monthly,
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

  // Articles of active orders without an explicit format (default format is used).
  const withoutFormat = new Map();
  for (const order of active) {
    for (const item of order.items || []) {
      const sku = normalizeSku(item.sku);
      if (!sku || hasOwnFormat(config, sku)) continue;
      const row = withoutFormat.get(sku) || { sku, name: item.name || '', qty: 0, orders: 0 };
      row.qty += Number(item.qty) || 0;
      row.orders += 1;
      withoutFormat.set(sku, row);
    }
  }

  return {
    activeOrders: active.length,
    activeUnits: active.reduce((s, o) => s + o.items.reduce((a, i) => a + (Number(i.qty) || 0), 0), 0),
    shippedRecent: recent.length,
    avgOrdersPerDay: recent.length / avgWindowDays,
    defaultFormat: (config.formats.find((f) => f.id === config.defaultFormat) || {}).name || '',
    withoutFormat: [...withoutFormat.values()].sort((a, b) => b.qty - a.qty),
    rows,
  };
}

// Converts stock of a tape when its mode changes (см ↔ рулоны).
function convertTapeStock(prevConfig, nextConfig) {
  const stock = { ...nextConfig.stock };
  for (const tape of nextConfig.tapes) {
    const key = `tape:${tape.id}`;
    const before = prevConfig.tapes.find((t) => t.id === tape.id);
    if (!before || before.mode === tape.mode || !stock[key]) continue;
    const cmPerRoll = (before.mode === 'order' ? before.lengthM : tape.lengthM) * 100;
    if (!(cmPerRoll > 0)) continue;
    stock[key] = { ...stock[key], qty: round(before.mode === 'order' ? stock[key].qty / cmPerRoll : stock[key].qty * cmPerRoll, 4) };
  }
  return stock;
}

module.exports = {
  DEFAULT_CONFIG,
  applyToSales,
  basisMonthCounts,
  chooseBag,
  configStatus,
  convertTapeStock,
  currentPrices,
  formatOf,
  itemKeys,
  itemTitle,
  mergeHistory,
  daysInMonthKey,
  monthOrdersProvider,
  monthlyRollsBetween,
  monthsBetween,
  rawMonthCount,
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
  unitKind,
  usageByKey,
};
