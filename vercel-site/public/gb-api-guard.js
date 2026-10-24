(()=>{
'use strict';
if (window.GB_SAME_ORIGIN_API_GUARD) return;
window.GB_SAME_ORIGIN_API_GUARD = true;

const originalFetch = window.fetch.bind(window);
const grantsBookHost = /^grants-book-kaspi-assistant(?:-[a-z0-9-]+)?\.vercel\.app$/i;
const accessKey = 'gb_access_code';
let promptInFlight = null;
let promptRevision = 0;
let lastPromptedCode = '';

function storedCode() {
  try { return window.localStorage.getItem(accessKey) || ''; } catch { return ''; }
}

function saveCode(code) {
  try { window.localStorage.setItem(accessKey, code); } catch {}
}

function clearCode() {
  try { window.localStorage.removeItem(accessKey); } catch {}
}

function requestCodeOnce() {
  if (!promptInFlight) {
    promptInFlight = Promise.resolve()
      .then(() => window.prompt('Введите код доступа GRANTS BOOK'))
      .then(value => {
        lastPromptedCode = typeof value === 'string' ? value.trim() : '';
        promptRevision += 1;
        if (lastPromptedCode) saveCode(lastPromptedCode);
        return lastPromptedCode;
      })
      .finally(() => { promptInFlight = null; });
  }
  return promptInFlight;
}

async function accessRequired(response) {
  if (response.status !== 401) return false;
  try {
    const json = await response.clone().json();
    return json && json.code === 'access_required';
  } catch {
    return false;
  }
}

window.fetch = async function(input, init) {
  const raw = typeof input === 'string' || input instanceof URL
    ? String(input)
    : String(input && input.url || '');
  let url;
  try { url = new URL(raw, location.href); }
  catch { return originalFetch(input, init); }

  const currentOrigin = new URL(location.href).origin;
  if (!url.pathname.startsWith('/api/') ||
      (url.origin !== currentOrigin && !grantsBookHost.test(url.hostname))) {
    return originalFetch(input, init);
  }

  const currentUrl = currentOrigin + url.pathname + url.search + url.hash;
  let request = input instanceof Request ? new Request(input, init) : new Request(url.toString(), init);
  if (url.origin !== currentOrigin) request = new Request(currentUrl, request);

  const retrySource = request.clone();
  const appliedCode = storedCode();
  const startedRevision = promptRevision;
  if (appliedCode) {
    const headers = new Headers(request.headers);
    headers.set('X-GB-Access', appliedCode);
    request = new Request(request, { headers });
  }

  const response = await originalFetch(request);
  if (!(await accessRequired(response))) return response;

  const latestCode = storedCode();
  let code;
  if (promptRevision > startedRevision) code = lastPromptedCode;
  else if (latestCode && latestCode !== appliedCode) code = latestCode;
  else code = await requestCodeOnce();

  if (!code) return response;

  const headers = new Headers(retrySource.headers);
  headers.set('X-GB-Access', code);
  const secondResponse = await originalFetch(new Request(retrySource.clone(), { headers }));
  if (await accessRequired(secondResponse)) clearCode();
  return secondResponse;
};
})();
