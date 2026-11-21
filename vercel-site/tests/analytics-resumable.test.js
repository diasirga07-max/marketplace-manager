'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
process.env.GB_ANALYTICS_WAIT_MS = '200';
process.env.GB_ANALYTICS_DEADLINE_MS = '50';
process.env.GB_ANALYTICS_MIN_NEW = '1';

const CSV = [
  'Название,Цена оптовая,ч',
  'Книга А,"1 000",KITA0001',
  'Книга Б,500,KITA0002',
  'Книга В,700,KITA0003',
  'Книга Г,800,KITA0004',
  'Книга Д,900,KITA0005',
].join('\n');

function at(iso, hour = 12) {
  return Date.parse(`${iso}T${String(hour).padStart(2, '0')}:00:00+05:00`);
}

const ORDERS = [
  { id: 'o1', status: 'COMPLETED', code: '111', totalPrice: 3000, creationDate: at('2026-11-01'), completionDate: at('2026-11-03', 10), deliveryCostForSeller: 299, deliveryMode: 'DELIVERY_LOCAL', paymentMode: 'PAY_WITH_CREDIT', customer: { id: 'c1', firstName: 'Асель', cellPhone: '77010001122' }, deliveryAddress: { town: 'Алматы' } },
  { id: 'o2', status: 'COMPLETED', code: '222', totalPrice: 1000, creationDate: at('2026-10-05'), completionDate: at('2026-10-07'), deliveryCostForSeller: 149, deliveryMode: 'DELIVERY_REGIONAL_TODOOR' },
  { id: 'o3', status: 'CANCELLED', code: '333', totalPrice: 500, creationDate: at('2026-11-04') },
];
const ENTRIES = {
  o1: [{ id: 'e1', attributes: { quantity: 2, totalPrice: 2000, category: { title: 'Книги' } } }, { id: 'e2', attributes: { quantity: 1, totalPrice: 1000, category: { title: 'Книги' } } }],
  o2: [{ id: 'e3', attributes: { quantity: 1, totalPrice: 1000, category: { title: 'Книги' } } }],
  o3: [{ id: 'e4', attributes: { quantity: 1, totalPrice: 500, category: { title: 'Книги' } } }],
};
const SKU_BY_ENTRY = { e1: 'KITA0001', e2: 'KITA0002', e3: 'KITA0001', e4: 'KITA0003' };

let kaspiCalls = 0;
global.fetch = async (url) => {
  const u = new URL(String(url));
  const json = (data) => ({ ok: true, status: 200, text: async () => JSON.stringify(data), json: async () => data });
  if (u.hostname === 'docs.google.com') return { ok: true, status: 200, text: async () => CSV };
  kaspiCalls += 1;
  await new Promise((r) => setTimeout(r, 120));
  let m;
  if (u.pathname.endsWith('/orders')) {
    const status = u.searchParams.get('filter[orders][status]');
    const ge = Number(u.searchParams.get('filter[orders][creationDate][$ge]'));
    const le = Number(u.searchParams.get('filter[orders][creationDate][$le]'));
    const data = ORDERS
      .filter((o) => o.status === status && o.creationDate >= ge && o.creationDate <= le)
      .map(({ id, ...attributes }) => ({ id, attributes }));
    return json({ data });
  }
  if ((m = u.pathname.match(/\/orders\/([^/]+)\/entries$/))) return json({ data: ENTRIES[m[1]] || [] });
  if ((m = u.pathname.match(/\/orderentries\/([^/]+)\/product$/))) return json({ data: { id: `mp-${m[1]}`, attributes: {} } });
  if ((m = u.pathname.match(/\/masterproducts\/mp-([^/]+)\/merchantProduct$/))) {
    return json({ data: { attributes: { code: SKU_BY_ENTRY[m[1]], name: `Kaspi ${m[1]}` } } });
  }
  if ((m = u.pathname.match(/\/orders\/([^/]+)$/))) return json({ data: { attributes: {} } });
  return { ok: false, status: 404, text: async () => '{}' };
};

const service = require('../lib/analytics/service');

test('resumable loading: months past the deadline are saved partially and finished on later calls', async () => {
  const realNow = Date.now;
  const base = at('2026-11-21', 15);
  const offset = realNow();
  Date.now = () => base + (realNow() - offset);
  try {
    let last = await service.dashboard({ token: 't', query: { preset: 'month' } });
    let sawPartial = false;
    for (let i = 0; i < 60 && last.pendingMonths.length; i += 1) {
      await new Promise((r) => setTimeout(r, 150));
      last = await service.dashboard({ token: 't', query: { preset: 'month' } });
      if (service.diagnostics().recentLoads.some((l) => l.partial)) sawPartial = true;
      if (!last.complete) assert.equal(last.summary.revenue, 0, 'partial months are not used in totals');
    }
    assert.ok(sawPartial, 'at least one load stopped at the deadline and was resumed');
    assert.deepEqual(last.pendingMonths, []);
    assert.equal(last.summary.revenue, 3000);
    assert.equal(last.summary.orders, 1);
    assert.equal(last.previous.revenue, 1000);
    assert.equal(last.summary.cancelOrders, 1);
  } finally {
    Date.now = realNow;
  }
});
