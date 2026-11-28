const SRC = process.env.APPS_SCRIPT_URL || 'https://script.google.com/macros/s/AKfycbzyjZ1wzw4JE1tSRzng2ZwUfe0wcBKlWkMg4NE9v5zuSMOAOA4vqD23iHb8Z1XUBenOkA/exec';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  try {
    const r = await fetch(SRC, { cache: 'no-store', signal: AbortSignal.timeout(50000) });
    if (!r.ok) throw new Error('Upstream HTTP ' + r.status);
    const xml = await r.text();
    const total = (xml.match(/<offer /g) || []).length;
    if (!xml.includes('</kaspi_catalog>') || total < 4000) {
      throw new Error('Invalid XML, offers: ' + total);
    }
    res.setHeader('X-Kaspi-Offers', String(total));
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    return res.status(200).send(xml);
  } catch (e) {
    console.error('Kaspi XML:', e);
    return res.status(503).json({ ok: false, error: 'Cannot build complete feed' });
  }
}
