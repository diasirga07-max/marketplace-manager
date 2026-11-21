'use strict';

// Single source of truth for spreadsheet/Excel column names.
// Every lookup goes through normalizeHeader(), so headers are matched
// regardless of case, extra spaces, invisible characters, currency signs,
// brackets or other punctuation ("Цена оптовая (₸)" === "цена оптовая").

const COLUMN_MAP = Object.freeze({
  // Google Sheet «Прайс KASPI» (себестоимость)
  catalog: Object.freeze({
    sku: ['Артикул', 'Артикул Kaspi', 'Артикул WB', 'SKU', 'Код товара', 'Код', 'Артикул продавца'],
    name: ['Название', 'Наименование', 'Товар', 'Название товара'],
    cost: ['Цена оптовая', 'Оптовая цена', 'Закупочная цена', 'Закупка', 'Себестоимость', 'Опт'],
    price: ['Цена Kaspi', 'Цена продажи', 'Цена', 'Цена KASPI'],
    category: ['Категория', 'Категория Kaspi'],
    photo: ['_PHOTO_URL_FOR_PRINT', 'Фото', 'Ссылка на фото', 'Фото URL'],
    wbUrl: ['ВБ ссылка', 'WB ссылка', 'Ссылка WB', 'Wildberries ссылка'],
  }),
  // Excel ActiveOrders (выгрузка активных заказов Kaspi)
  activeOrders: Object.freeze({
    orderCode: ['Номер заказа', '№ заказа', 'Заказ'],
    sku: ['Артикул', 'SKU', 'Код товара'],
    name: ['Название в системе продавца', 'Название товара', 'Товар', 'Наименование'],
    quantity: ['Количество', 'Кол-во', 'Шт'],
    price: ['Сумма', 'Стоимость', 'Цена'],
    status: ['Статус'],
    warehouse: ['Склад передачи', 'Склад', 'Пункт выдачи'],
    date: ['Дата поступления заказа', 'Дата заказа', 'Дата'],
  }),
});

function normalizeHeader(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f​-‏⁠﻿]/g, ' ')
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const NORMALIZED = Object.freeze(Object.fromEntries(
  Object.entries(COLUMN_MAP).map(([group, fields]) => [
    group,
    Object.freeze(Object.fromEntries(
      Object.entries(fields).map(([field, aliases]) => [field, new Set(aliases.map(normalizeHeader))]),
    )),
  ]),
));

function findColumn(headers, group, field, exclude = []) {
  const aliases = NORMALIZED[group] && NORMALIZED[group][field];
  if (!aliases) throw new Error(`Неизвестная колонка ${group}.${field}`);
  const normalized = (Array.isArray(headers) ? headers : []).map(normalizeHeader);
  const skip = new Set(exclude.filter((index) => index >= 0));
  // Exact alias first, then "header starts with alias" (e.g. «Цена оптовая, ₸ (июль)»).
  let index = normalized.findIndex((header, i) => !skip.has(i) && aliases.has(header));
  if (index >= 0) return index;
  index = normalized.findIndex((header, i) =>
    !skip.has(i) && header && [...aliases].some((alias) => alias.length >= 4 && header.startsWith(`${alias} `)),
  );
  return index;
}

function resolveColumns(headers, group) {
  const fields = Object.keys(COLUMN_MAP[group] || {});
  const result = {};
  const used = [];
  for (const field of fields) {
    result[field] = findColumn(headers, group, field, used);
    if (result[field] >= 0) used.push(result[field]);
  }
  return result;
}

module.exports = {
  COLUMN_MAP,
  findColumn,
  normalizeHeader,
  resolveColumns,
};
