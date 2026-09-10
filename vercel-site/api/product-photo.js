const CACHE_SECONDS = 60 * 60 * 24;

function isAllowedKaspiUrl(value) {
  try {
    const u = new URL(String(value || ''));
    const host = u.hostname.toLowerCase();
    return u.protocol === 'https:' && (host === 'kaspi.kz' || host.endsWith('.kaspi.kz')) && u.pathname.startsWith('/shop/p/');
  } catch {
    return false;
  }
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\\u002F/g, '/')
    .replace(/\\\//g, '/');
}

function normalizeImage(value) {
  const raw = decodeHtml(value).trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return '';
    const host = u.hostname.toLowerCase();
    if (
      host === 'resources.cdn-kaspi.kz' ||
      host.endsWith('.cdn-kaspi.kz') ||
      host.endsWith('.kaspi.kz')
    ) return u.toString();
  } catch {}
  return '';
}

function extractImage(html) {
  const text = String(html || '');
  const patterns = [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image(?::src)?["']/i,
    /"(?:image|imageUrl|image_url|previewImage|galleryImages)"\s*:\s*"(https:\\/\\/[^"\\]+(?:\\.[^"\\]*)?)"/i,
    /(https:\\/\\/resources\.cdn-kaspi\.kz\\/img\\/m\\/p\\/[^"'<>\\ ]+)/i,
    /(https:\/\/resources\.cdn-kaspi\.kz\/img\/m\/p\/[^"'<> ]+)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    const img = normalizeImage(m[1]);
    if (img) return img;
  }
  return '';
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', `public, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=${CACHE_SECONDS}`);
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const url = String(req.query && req.query.url || '').trim();
  const sku = String(req.query && req.query.sku || '').trim();
  if (!isAllowedKaspiUrl(url)) {
    return res.status(400).json({ ok: false, sku, error: 'Некорректная ссылка карточки Kaspi' });
  }

  try {
    const response = await fetch(url, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/151 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.7',
      },
      cache: 'no-store',
    });
    const html = await response.text();
    if (!response.ok) {
      return res.status(502).json({ ok: false, sku, error: `Kaspi returned HTTP ${response.status}` });
    }
    const photo = extractImage(html);
    if (!photo) {
      return res.status(404).json({ ok: false, sku, error: 'Фотография в карточке Kaspi не найдена' });
    }
    return res.status(200).json({ ok: true, sku, photo, source: 'kaspi-card' });
  } catch (error) {
    return res.status(502).json({ ok: false, sku, error: error instanceof Error ? error.message : String(error) });
  }
};
