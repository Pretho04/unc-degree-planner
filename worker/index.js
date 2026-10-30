// UNC Degree Planner - Cloudflare Worker.
// Same API as server.ps1, so public/app.js runs unchanged. Static files in ./public are served by
// Workers Static Assets; only /api/* requests reach this code. It proxies three public UNC sources
// the browser can't reach directly (no CORS):
//   catalog.unc.edu          program pages, IDEAs lists, subject course lists
//   catalog.unc.edu/ribbit   course descriptions + requisites
//   reports.unc.edu          Class Search (sections + available seats)

const CATALOG = 'https://catalog.unc.edu';
const CLASS_SEARCH = 'https://reports.unc.edu/class-search/';
const UA = 'UNC-Degree-Planner/1.0 (unofficial student tool; +https://github.com/Pretho04/unc-degree-planner)';
const CATALOG_TTL = 7 * 24 * 3600;   // requirements and prereqs rarely change
const SEAT_TTL = 120;                // seats change constantly
const META_TTL = 6 * 3600;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case '/api/catalog': return await catalog(url);
        case '/api/course': return await course(url);
        case '/api/seats': return await seats(url);
        case '/api/meta': return reply(200, (await classSearchSession()).meta, 'application/json');
      }
      return env.ASSETS.fetch(request);
    } catch (e) {
      return reply(502, e.message || String(e));
    }
  },
};

const reply = (status, body, type = 'text/plain') =>
  new Response(body, { status, headers: { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' } });

// GET through Cloudflare's edge cache, so each catalog page is fetched from UNC about once a week.
// Retries (with a short pause) cover UNC's occasional dropped connection during a burst of requests.
async function cachedGet(target) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 400 * attempt));
    try {
      const res = await fetch(target, {
        headers: { 'user-agent': UA },
        cf: { cacheTtl: CATALOG_TTL, cacheEverything: true },
      });
      if (res.ok) return res.text();
      last = new Error(`${new URL(target).host} returned HTTP ${res.status}`);
      if (res.status < 500) break;
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

async function catalog(url) {
  const p = url.searchParams.get('path') || '';
  if (!/^\/undergraduate\/(programs-study|ideas-in-action)\/([a-z0-9-]+\/)?$/.test(p) && !/^\/courses\/[a-z]{2,5}\/$/.test(p)) {
    return reply(400, 'Bad catalog path');
  }
  return reply(200, await cachedGet(CATALOG + p), 'text/html');
}

async function course(url) {
  const code = (url.searchParams.get('code') || '').toUpperCase();
  if (!/^[A-Z]{2,5} \d{2,3}[A-Z]{0,2}$/.test(code)) return reply(400, 'Bad course code');
  return reply(200, await cachedGet(`${CATALOG}/ribbit/index.cgi?page=getcourse.rjs&code=${encodeURIComponent(code)}`), 'text/xml');
}

// Class Search is a Django form: GET it for a CSRF token + cookie, then POST the search with both.
// Kept per Worker instance and refreshed when it expires or a POST is rejected.
let session = null;
async function classSearchSession(force = false) {
  if (session && !force && Date.now() - session.time < META_TTL * 1000) return session;
  const res = await fetch(CLASS_SEARCH, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`Class Search returned HTTP ${res.status}`);
  const html = await res.text();
  const cookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') || '').split(/,(?=\s*\w+=)/);
  const json = id => html.match(new RegExp(`<script id="${id}"[^>]*>([\\s\\S]*?)</script>`))?.[1] || '[]';
  session = {
    token: html.match(/name="csrfmiddlewaretoken" value="([^"]+)"/)?.[1] || '',
    cookie: cookies.map(c => c.split(';')[0].trim()).filter(Boolean).join('; '),
    meta: `{"terms":${json('json_terms')},"subjects":${json('json_subjects')}}`,
    time: Date.now(),
  };
  return session;
}

const seatCache = new Map();
async function seats(url) {
  const subject = (url.searchParams.get('subject') || '').toUpperCase();
  const number = (url.searchParams.get('number') || '').toUpperCase();   // empty = the whole subject
  const term = url.searchParams.get('term') || '';
  if (!/^[A-Z]{2,5}$/.test(subject) || !/^(\d{2,3}[A-Z]{0,2})?$/.test(number) || !/^(\d{4} (Spring|Summer I|Summer II|Fall))?$/.test(term)) {
    return reply(400, 'Bad seat query');
  }
  const key = `${subject}|${number}|${term}`;
  const hit = seatCache.get(key);
  if (hit && Date.now() - hit.time < SEAT_TTL * 1000) return reply(200, hit.body, 'text/html');

  let res;
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = await classSearchSession(attempt > 0);   // token/cookie expired -> refresh and retry once
    res = await fetch(CLASS_SEARCH, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: s.cookie,
        referer: CLASS_SEARCH,
        'user-agent': UA,
      },
      body: new URLSearchParams({ csrfmiddlewaretoken: s.token, term, subject, catalog_number: number }),
    });
    if (res.ok) break;
  }
  if (!res.ok) throw new Error(`Class Search returned HTTP ${res.status}`);

  // Only the results table matters; drop the rest of the page.
  const html = await res.text();
  const start = html.indexOf('<table'), end = html.indexOf('</table>');
  const body = start >= 0 && end > start ? html.slice(start, end + 8) : '<table></table>';
  if (seatCache.size > 500) seatCache.clear();
  seatCache.set(key, { time: Date.now(), body });
  return reply(200, body, 'text/html');
}
