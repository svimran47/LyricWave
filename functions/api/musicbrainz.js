/**
 * Cloudflare Pages Function - MusicBrainz proxy
 * Endpoint: GET /api/musicbrainz?path=<ws/2 path>&<MusicBrainz params>
 *
 * Browsers can't set User-Agent, and MusicBrainz asks every client to identify itself.
 * This function forwards a small allowlist of read-only lookups with LyricWave's
 * User-Agent, caches answers at the edge for a day, and spaces calls from each isolate
 * at least 1.1 s apart (MusicBrainz allows 1 request per second).
 */

const MB_BASE_URL = 'https://musicbrainz.org/ws/2';
const USER_AGENT = 'LyricWave/1.0 ( https://lyricwave.pages.dev )';
const CACHE_TTL_SECONDS = 86400;
const MIN_INTERVAL_MS = 1100;
const MBID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ALLOWED_PATHS = [
  /^recording$/,
  new RegExp(`^recording/${MBID}$`, 'i'),
  new RegExp(`^artist/${MBID}$`, 'i'),
  /^isrc\/[A-Z]{2}[A-Z0-9]{3}\d{7}$/i
];
const ALLOWED_PARAMS = ['query', 'inc', 'limit', 'offset'];

let lastCallAt = 0;
let queue = Promise.resolve();

function isAllowedOrigin(origin) {
  if (!origin) return false;
  try {
    const host = new URL(origin).hostname;
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === 'appassets.androidplatform.net' ||
      host === 'lyricwave.pages.dev' ||
      host.endsWith('.lyricwave.pages.dev')
    );
  } catch {
    return false;
  }
}

function corsHeaders(request) {
  const origin = request.headers.get('Origin');
  return {
    'Access-Control-Allow-Origin': isAllowedOrigin(origin) ? origin : '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept',
    'Vary': 'Origin'
  };
}

function json(body, status, request, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(request), ...extra }
  });
}

/** Wait for this isolate's turn so it never calls MusicBrainz faster than once per 1.1 s. */
function throttled(task) {
  const run = queue.then(async () => {
    const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallAt = Date.now();
    return task();
  });
  queue = run.catch(() => {});
  return run;
}

export async function onRequestOptions({ request }) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const path = url.searchParams.get('path') || '';
  if (!ALLOWED_PATHS.some((re) => re.test(path))) {
    return json({ error: 'Unsupported MusicBrainz path' }, 400, request);
  }

  const upstream = new URL(`${MB_BASE_URL}/${path}`);
  for (const key of ALLOWED_PARAMS) {
    const value = url.searchParams.get(key);
    if (value) upstream.searchParams.set(key, value.slice(0, 300));
  }
  upstream.searchParams.set('fmt', 'json');

  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const cacheKey = new Request(upstream.toString(), { method: 'GET' });
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      return new Response(hit.body, { status: hit.status, headers: { ...Object.fromEntries(hit.headers), ...corsHeaders(request) } });
    }
  }

  let res;
  try {
    res = await throttled(() => fetch(upstream.toString(), {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }
    }));
  } catch {
    return json({ error: 'MusicBrainz unreachable' }, 502, request);
  }

  const body = await res.text();
  const okToCache = res.status === 200 || res.status === 404;
  const response = new Response(body, {
    status: res.status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': okToCache ? `public, max-age=${CACHE_TTL_SECONDS}, s-maxage=${CACHE_TTL_SECONDS}` : 'no-store',
      ...corsHeaders(request)
    }
  });
  if (cache && okToCache) {
    const stored = new Response(body, {
      status: res.status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}` }
    });
    try { await cache.put(cacheKey, stored); } catch {}
  }
  return response;
}
