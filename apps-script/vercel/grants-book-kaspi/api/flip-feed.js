// Flip.kz XML-фид: проксирует Apps Script doGet?feed=flip (Flip.gs).
// Ссылка для кабинета Flip → Прайсы: https://grants-book-kaspi.vercel.app/api/flip-feed
const BASE = process.env.APPS_SCRIPT_URL || 'https://script.google.com/macros/s/AKfycbzyjZ1wzw4JE1tSRzng2ZwUfe0wcBKlWkMg4NE9v5zuSMOAOA4vqD23iHb8Z1XUBenOkA/exec';
const MIN_OFFERS = Number(process.env.FLIP_MIN_OFFERS || 200);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  try {
    const url = BASE + (BASE.includes('?') ? '&' : '?') + 'feed=flip';
    const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(50000) });
    if (!r.ok) throw new Error('Upstream HTTP ' + r.status);
    const xml = await r.text();
    const total = (xml.match(/<offer>/g) || []).length;
    if (!xml.trimStart().startsWith('<?xml') || !/<\/offers>\s*$/.test(xml) || total < MIN_OFFERS) {
      throw new Error('Invalid Flip XML, offers: ' + total);
    }
    res.setHeader('X-Flip-Offers', String(total));
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    return res.status(200).send(xml);
  } catch (e) {
    console.error('Flip XML:', e);
    return res.status(503).json({ ok: false, error: 'Cannot build complete Flip feed' });
  }
}
