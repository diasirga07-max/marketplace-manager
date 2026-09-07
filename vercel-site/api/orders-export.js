const ORDERS_API = 'https://grants-book-kaspi-assistant-aex41sn9x-dias10.vercel.app/api/data?op=orders';

function normalizeGroup(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'almaty' || v === 'алматы') return 'almaty';
  if (v === 'kurdai' || v === 'kordai' || v === 'курдай' || v === 'кордай') return 'kurdai';
  if (v === 'wb' || v === 'wildberries' || v === 'вайлберис' || v === 'валберис') return 'wb';
  return '';
}

function csvCell(value) {
  const text = value == null ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function formatAlmatyTime(value) {
  const date = value ? new Date(value) : new Date();
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  const parts = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Asia/Almaty',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(safeDate);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.day}.${byType.month}.${byType.year} ${byType.hour}:${byType.minute}:${byType.second}`;
}

module.exports = async function handler(req, res) {
  try {
    const requestedGroup = normalizeGroup(req.query && req.query.group);
    if (!requestedGroup) {
      return res.status(400).json({ ok: false, error: 'group must be almaty, kurdai or wb' });
    }

    const upstreamResponse = await fetch(`${ORDERS_API}&_=${Date.now()}`, {
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });

    if (!upstreamResponse.ok) {
      throw new Error(`orders upstream returned HTTP ${upstreamResponse.status}`);
    }

    const payload = await upstreamResponse.json();
    const sourceRows = Array.isArray(payload && payload.rows) ? payload.rows : [];

    // One active order/SKU pair must be counted exactly once. This removes stale/exact
    // duplicates without collapsing different SKUs that legitimately belong to one order.
    const uniqueOrderSku = new Map();
    for (const raw of sourceRows) {
      if (normalizeGroup(raw && raw.group) !== requestedGroup) continue;

      const orderCode = String((raw && raw.orderCode) || '').trim();
      const sku = String((raw && raw.sku) || '').trim();
      const quantity = Math.max(0, Number(raw && raw.quantity) || 0);
      if (!orderCode || !sku || quantity <= 0) continue;

      const key = `${requestedGroup}\u0001${orderCode}\u0001${sku}`;
      const previous = uniqueOrderSku.get(key);
      if (!previous || quantity > previous.quantity) {
        uniqueOrderSku.set(key, {
          orderCode,
          sku,
          quantity,
          name: String((raw && raw.name) || '').trim(),
          photo: String((raw && raw.photo) || '').trim(),
          wholesale: raw && raw.wholesale,
          wbUrl: String((raw && raw.wbUrl) || '').trim(),
        });
      }
    }

    // Rebuild the export from scratch from only the current unique active rows.
    const grouped = new Map();
    for (const row of uniqueOrderSku.values()) {
      const key = `${requestedGroup}\u0001${row.sku}`;
      let item = grouped.get(key);
      if (!item) {
        item = {
          sku: row.sku,
          name: row.name,
          quantity: 0,
          orders: new Set(),
        };
        grouped.set(key, item);
      }

      item.quantity += row.quantity;
      item.orders.add(row.orderCode);
      if (!item.name && row.name) item.name = row.name;
    }

    const updatedAt = formatAlmatyTime(payload && payload.generatedAt);
    const rows = [...grouped.values()].sort((a, b) =>
      a.sku.localeCompare(b.sku, 'ru', { numeric: true, sensitivity: 'base' })
    );

    const csv = rows
      .map((row) => {
        const orderNumbers = [...row.orders]
          .sort((a, b) => b.localeCompare(a, 'ru', { numeric: true }))
          .join(', ');
        return [row.name, row.sku, row.quantity, orderNumbers, '✅ Принят', updatedAt]
          .map(csvCell)
          .join(',');
      })
      .join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Source-Generated-At', String((payload && payload.generatedAt) || ''));
    res.setHeader('X-Unique-Order-Sku-Count', String(uniqueOrderSku.size));
    res.setHeader('X-Grouped-Sku-Count', String(rows.length));
    return res.status(200).send(csv);
  } catch (error) {
    console.error('orders-export failed', error);
    return res.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
