/**
 * LyricWave open-data clients: MusicBrainz, Wikidata and Cover Art Archive.
 *
 * - MusicBrainz metadata is CC0. Its API allows 1 request per second per client and asks for a
 *   meaningful User-Agent. Every MusicBrainz call goes through one shared queue spaced 1.1 s apart.
 * - Browsers do not let pages set User-Agent, so the client first goes through the
 *   /api/musicbrainz Pages Function (functions/api/musicbrainz.js), which sends LyricWave's
 *   User-Agent. Where that function isn't served (a plain static server), it calls
 *   musicbrainz.org directly; outside browsers (Node, tests) it sets the User-Agent itself.
 * - Wikidata (CC0) supplies short artist descriptions and the Wikipedia link. Wikipedia text is
 *   CC BY-SA, so LyricWave links to it instead of copying it.
 * - Cover Art Archive images stay their owners' copyright. They are shown by URL, never stored.
 *
 * Pure helpers are exported for tests; nothing touches the DOM.
 */

export const MB_BASE_URL = 'https://musicbrainz.org/ws/2';
export const MB_USER_AGENT = 'LyricWave/1.0 ( https://lyricwave.pages.dev )';
export const MB_MIN_INTERVAL_MS = 1100;
export const WIKIDATA_API_URL = 'https://www.wikidata.org/w/api.php';
export const COMMONS_API_URL = 'https://commons.wikimedia.org/w/api.php';
/** Width of the artist photo thumbnail asked from Wikimedia Commons. */
export const ARTIST_PHOTO_WIDTH = 320;
export const COVER_ART_BASE_URL = 'https://coverartarchive.org';

const MBID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IS_BROWSER = typeof window !== 'undefined' && typeof document !== 'undefined';

/**
 * Runs scheduled tasks one at a time, starting each at least `intervalMs` after the previous start.
 * `now` and `sleep` are injectable so tests can use a fake clock.
 */
export class RateLimiter {
  constructor(intervalMs = MB_MIN_INTERVAL_MS, {
    now = () => Date.now(),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  } = {}) {
    this.intervalMs = intervalMs;
    this.now = now;
    this.sleep = sleep;
    this.lastStart = -Infinity;
    this.chain = Promise.resolve();
  }

  schedule(task) {
    const run = this.chain.then(async () => {
      const wait = this.lastStart + this.intervalMs - this.now();
      if (wait > 0) await this.sleep(wait);
      this.lastStart = this.now();
      return task();
    });
    // Keep the queue alive after a failed task.
    this.chain = run.catch(() => {});
    return run;
  }
}

/** Escape Lucene query syntax used by MusicBrainz search. */
export function escapeLucene(value) {
  return String(value || '').replace(/([+\-&|!(){}[\]^"~*?:\\/])/g, '\\$1').trim();
}

/** Strip decorations that MusicBrainz titles don't carry ("(feat. X)", "- 2011 Remaster"...). */
export function simplifyTitle(title) {
  return String(title || '')
    .replace(/\s*[([](?:feat\.?|ft\.?|with|featuring)\s[^)\]]*[)\]]/gi, '')
    .replace(/\s*[([][^)\]]*(?:remaster(?:ed)?|deluxe|bonus|radio edit|version|mono|stereo|anniversary)[^)\]]*[)\]]/gi, '')
    .replace(/\s+-\s+.*(?:remaster(?:ed)?|radio edit|version|mono|stereo|live|edit)\b.*$/i, '')
    .replace(/\s+(?:feat\.?|ft\.?|featuring)\s.*$/i, '')
    .trim();
}

/** First credited artist from a display string ("A feat. B", "A & B", "A, B"). */
export function primaryArtistName(artist) {
  return String(artist || '')
    .split(/\s+(?:feat\.?|ft\.?|featuring|with|x|vs\.?)\s+|\s*[,;&]\s*/i)[0]
    .trim();
}

/** Lucene query for a recording search. */
export function buildRecordingQuery(title, artist) {
  const t = escapeLucene(simplifyTitle(title) || title);
  const a = escapeLucene(primaryArtistName(artist));
  const parts = [];
  if (t) parts.push(`recording:"${t}"`);
  if (a) parts.push(`artist:"${a}"`);
  return parts.join(' AND ');
}

function looseText(value) {
  return simplifyTitle(value).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function artistCreditName(credits) {
  if (!Array.isArray(credits)) return '';
  return credits.map((c) => `${c?.name || c?.artist?.name || ''}${c?.joinphrase || ''}`).join('').trim();
}

/**
 * Choose the recording that matches the track, or null when nothing is a confident match.
 * Rules: MusicBrainz score >= 80, title equal after cleanup, artist credit contains the
 * primary artist, and (when both lengths are real) within 15 s. Ties prefer an official
 * release, then the earliest release date.
 */
export function pickRecording(recordings, { title, artist, durationSec = 0, durationEstimated = false } = {}) {
  if (!Array.isArray(recordings) || !recordings.length) return null;
  const wantTitle = looseText(title);
  const wantArtist = looseText(primaryArtistName(artist));
  if (!wantTitle) return null;

  const candidates = recordings.filter((rec) => {
    if (!rec || !MBID_RE.test(rec.id || '')) return false;
    if (typeof rec.score === 'number' && rec.score < 80) return false;
    if (looseText(rec.title) !== wantTitle) return false;
    const credit = looseText(artistCreditName(rec['artist-credit']));
    if (wantArtist && !(` ${credit} `.includes(` ${wantArtist} `))) return false;
    if (!durationEstimated && durationSec > 0 && rec.length > 0) {
      if (Math.abs(rec.length / 1000 - durationSec) > 15) return false;
    }
    return true;
  });
  if (!candidates.length) return null;

  const rank = (rec) => {
    const releases = Array.isArray(rec.releases) ? rec.releases : [];
    const official = releases.some((r) => (r.status || '').toLowerCase() === 'official') ? 1 : 0;
    const date = rec['first-release-date'] || releases.map((r) => r.date).filter(Boolean).sort()[0] || '9999';
    return { official, date, score: typeof rec.score === 'number' ? rec.score : 100 };
  };
  return candidates
    .map((rec) => ({ rec, r: rank(rec) }))
    .sort((x, y) => (y.r.score - x.r.score) || (y.r.official - x.r.official) || x.r.date.localeCompare(y.r.date))[0].rec;
}

/** The release (and its release group) to use for cover art: official albums first. */
export function pickRelease(recording) {
  const releases = Array.isArray(recording?.releases) ? recording.releases : [];
  if (!releases.length) return null;
  const score = (r) => {
    const status = (r.status || '').toLowerCase() === 'official' ? 2 : 0;
    const type = (r['release-group']?.['primary-type'] || '').toLowerCase();
    const typeScore = type === 'album' ? 2 : (type === 'single' || type === 'ep' ? 1 : 0);
    return status + typeScore;
  };
  return [...releases].sort((a, b) => (score(b) - score(a)) || String(a.date || '9999').localeCompare(String(b.date || '9999')))[0];
}

/** Cover Art Archive front image for a release group (or release). Empty for a bad id. */
export function coverArtUrl(mbid, { size = 250, kind = 'release-group' } = {}) {
  if (!MBID_RE.test(mbid || '')) return '';
  const suffix = size ? `front-${size}` : 'front';
  return `${COVER_ART_BASE_URL}/${kind === 'release' ? 'release' : 'release-group'}/${mbid.toLowerCase()}/${suffix}`;
}

/** Wikidata Q-id from a MusicBrainz artist's url relations. */
export function wikidataIdFromRelations(relations) {
  if (!Array.isArray(relations)) return '';
  for (const rel of relations) {
    const url = rel?.url?.resource || '';
    const m = /wikidata\.org\/(?:wiki|entity)\/(Q\d+)/i.exec(url);
    if (rel?.type === 'wikidata' || m) {
      if (m) return m[1].toUpperCase();
    }
  }
  return '';
}

function buildQuery(params) {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') search.set(k, String(v));
  }
  return search.toString();
}

/**
 * MusicBrainz web service client. Every request (proxy or direct) waits its turn in one queue.
 */
export class MusicBrainzClient {
  constructor({
    fetchImpl = (typeof fetch === 'function' ? fetch.bind(globalThis) : null),
    apiBase = '',
    useProxy = IS_BROWSER,
    limiter = new RateLimiter(MB_MIN_INTERVAL_MS),
    timeoutMs = 12000
  } = {}) {
    this.fetchImpl = fetchImpl;
    this.apiBase = apiBase;
    this.useProxy = useProxy;
    this.limiter = limiter;
    this.timeoutMs = timeoutMs;
  }

  /** GET `${MB_BASE_URL}/${path}`. Resolves the parsed JSON, null on 404, throws on other failures. */
  async get(path, params = {}) {
    if (!this.fetchImpl) throw new Error('fetch unavailable');
    const query = buildQuery({ ...params, fmt: 'json' });
    return this.limiter.schedule(async () => {
      if (this.useProxy) {
        try {
          const res = await this.fetchWithTimeout(`${this.apiBase}/api/musicbrainz?${buildQuery({ path })}&${query}`, {
            headers: { Accept: 'application/json' }
          });
          const type = res.headers?.get?.('content-type') || '';
          // JSON means the proxy is there and answered for MusicBrainz (including MusicBrainz errors).
          if (type.includes('json')) {
            if (res.status === 404) return null;
            if (res.ok) return await res.json();
            const err = new Error(`MusicBrainz HTTP ${res.status}`);
            err.fromProxy = true;
            throw err;
          }
        } catch (err) {
          if (err?.fromProxy) throw err;
        }
        // No proxy here (static server, offline function): talk to MusicBrainz directly from now on.
        this.useProxy = false;
      }
      const headers = { Accept: 'application/json' };
      // Browsers forbid setting User-Agent; elsewhere identify LyricWave as MusicBrainz asks.
      if (!IS_BROWSER) headers['User-Agent'] = MB_USER_AGENT;
      const res = await this.fetchWithTimeout(`${MB_BASE_URL}/${path}?${query}`, { headers });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`MusicBrainz HTTP ${res.status}`);
      return res.json();
    });
  }

  async fetchWithTimeout(url, init) {
    if (typeof AbortController === 'undefined') return this.fetchImpl(url, init);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Recordings that carry this ISRC. */
  async lookupIsrc(isrc) {
    const data = await this.get(`isrc/${encodeURIComponent(isrc)}`, { inc: 'artists+releases+release-groups' });
    return Array.isArray(data?.recordings) ? data.recordings : [];
  }

  async getRecording(mbid) {
    if (!MBID_RE.test(mbid || '')) return null;
    return this.get(`recording/${mbid.toLowerCase()}`, { inc: 'artists+releases+release-groups+isrcs' });
  }

  async searchRecordings(title, artist, limit = 10) {
    const query = buildRecordingQuery(title, artist);
    if (!query) return [];
    const data = await this.get('recording', { query, limit });
    return Array.isArray(data?.recordings) ? data.recordings : [];
  }

  async getArtist(mbid) {
    if (!MBID_RE.test(mbid || '')) return null;
    return this.get(`artist/${mbid.toLowerCase()}`, { inc: 'url-rels+genres' });
  }

  /**
   * Best recording for a track: its MBID if known, then its ISRC, then a title + artist search.
   * Resolves null when nothing matches confidently.
   */
  async resolveRecording(track) {
    const want = {
      title: track.title,
      artist: track.artist,
      durationSec: track.duration || track.durationSec || 0,
      durationEstimated: Boolean(track.durationEstimated)
    };
    if (track.mbid) {
      const rec = await this.getRecording(track.mbid);
      if (rec) return rec;
    }
    if (track.isrc) {
      const byIsrc = await this.lookupIsrc(track.isrc);
      // An ISRC is an exact identifier, so only the title needs to agree (artist spellings vary).
      const match = pickRecording(byIsrc, { ...want, artist: '' }) || (byIsrc.length === 1 ? byIsrc[0] : null);
      if (match) return match;
    }
    return pickRecording(await this.searchRecordings(track.title, track.artist), want);
  }
}

/** Wikidata client for artist descriptions (CC0) and Wikipedia links. */
/** Plain text from a Commons metadata HTML snippet (author / credit fields). */
export function stripHtml(html) {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Commons "LicenseShortName" as a code isCommercialOk() understands:
 * "CC BY-SA 4.0" -> CC-BY-SA-4.0, "CC0" -> CC0-1.0, "Public domain" -> PDM; '' when unknown.
 */
export function commonsLicenseCode(shortName) {
  const s = String(shortName || '').trim();
  if (!s) return '';
  if (/^cc0/i.test(s)) return 'CC0-1.0';
  if (/^public domain|^pd\b|^pd-/i.test(s)) return 'PDM';
  const cc = s.match(/^CC[\s-]+(BY(?:[\s-]+(?:NC|ND|SA))*)(?:[\s-]+(\d+(?:\.\d+)?))?/i);
  if (cc) return `CC-${cc[1].toUpperCase().replace(/[\s-]+/g, '-')}${cc[2] ? `-${cc[2]}` : ''}`;
  return '';
}

const httpsUrl = (v) => (/^https:\/\/[^\s"'<>]+$/i.test(String(v || '').trim()) ? String(v).trim() : '');

/**
 * Artist photo from a Commons imageinfo entry, with its own license and credit; null when the
 * file is marked non-free or its license isn't one LyricWave can credit.
 */
export function commonsPhotoFromImageInfo(info, fileName = '') {
  const meta = info?.extmetadata || {};
  const val = (k) => meta[k]?.value;
  if (String(val('NonFree') || '').toLowerCase() === 'true') return null;
  const licenseLabel = stripHtml(val('LicenseShortName'));
  const license = commonsLicenseCode(licenseLabel);
  const url = httpsUrl(info?.thumburl) || httpsUrl(info?.url);
  const pageUrl = httpsUrl(info?.descriptionurl);
  if (!license || !url || !pageUrl) return null;
  const author = stripHtml(val('Artist')).slice(0, 160);
  const name = String(fileName || '').replace(/^File:/i, '').trim();
  return {
    url,
    pageUrl,
    fileName: name,
    license,
    licenseLabel: license === 'PDM' ? 'Public domain' : licenseLabel,
    licenseUrl: httpsUrl(val('LicenseUrl')),
    author,
    attributionRequired: String(val('AttributionRequired') || '').toLowerCase() !== 'false',
    attribution: `Photo${author ? `: ${author}` : ''}, ${license === 'PDM' ? 'public domain' : licenseLabel}, via Wikimedia Commons`,
    source: 'wikimedia-commons'
  };
}

export class WikidataClient {
  constructor({
    fetchImpl = (typeof fetch === 'function' ? fetch.bind(globalThis) : null),
    lang = 'en'
  } = {}) {
    this.fetchImpl = fetchImpl;
    this.lang = lang;
  }

  async getSummary(qid) {
    if (!/^Q\d+$/i.test(qid || '') || !this.fetchImpl) return null;
    const id = qid.toUpperCase();
    const wiki = `${this.lang}wiki`;
    const url = `${WIKIDATA_API_URL}?${buildQuery({
      action: 'wbgetentities', ids: id, props: 'descriptions|sitelinks/urls', languages: this.lang,
      sitefilter: wiki, format: 'json', origin: '*'
    })}`;
    const headers = IS_BROWSER ? {} : { 'User-Agent': MB_USER_AGENT };
    const res = await this.fetchImpl(url, { headers });
    if (!res.ok) throw new Error(`Wikidata HTTP ${res.status}`);
    const data = await res.json();
    const entity = data?.entities?.[id];
    if (!entity || entity.missing !== undefined) return null;
    const site = entity.sitelinks?.[wiki];
    return {
      wikidataId: id,
      description: entity.descriptions?.[this.lang]?.value || '',
      wikipediaUrl: site?.url || (site?.title ? `https://${this.lang}.wikipedia.org/wiki/${encodeURIComponent(site.title.replace(/ /g, '_'))}` : '')
    };
  }

  /** Commons file name of the entity's image (Wikidata property P18), or ''. */
  async getImageFile(qid) {
    if (!/^Q\d+$/i.test(qid || '') || !this.fetchImpl) return '';
    const url = `${WIKIDATA_API_URL}?${buildQuery({
      action: 'wbgetclaims', entity: qid.toUpperCase(), property: 'P18', format: 'json', origin: '*'
    })}`;
    const headers = IS_BROWSER ? {} : { 'User-Agent': MB_USER_AGENT };
    const res = await this.fetchImpl(url, { headers });
    if (!res.ok) throw new Error(`Wikidata HTTP ${res.status}`);
    const data = await res.json();
    const claim = (data?.claims?.P18 || []).find((c) => c?.rank === 'preferred') || data?.claims?.P18?.[0];
    const value = claim?.mainsnak?.datavalue?.value;
    return typeof value === 'string' ? value.slice(0, 240) : '';
  }

  /** Thumbnail, page, license and credit of a Commons file, or null when it can't be credited. */
  async getCommonsPhoto(fileName) {
    const name = String(fileName || '').replace(/^File:/i, '').trim();
    if (!name || !this.fetchImpl) return null;
    const url = `${COMMONS_API_URL}?${buildQuery({
      action: 'query', titles: `File:${name}`, prop: 'imageinfo', iiprop: 'url|extmetadata',
      iiurlwidth: ARTIST_PHOTO_WIDTH, iilimit: 1,
      iiextmetadatafilter: 'LicenseShortName|LicenseUrl|Artist|AttributionRequired|NonFree',
      format: 'json', origin: '*'
    })}`;
    const headers = IS_BROWSER ? {} : { 'User-Agent': MB_USER_AGENT };
    const res = await this.fetchImpl(url, { headers });
    if (!res.ok) throw new Error(`Commons HTTP ${res.status}`);
    const data = await res.json();
    const page = Object.values(data?.query?.pages || {})[0];
    return commonsPhotoFromImageInfo(page?.imageinfo?.[0], name);
  }

  /** The entity's Commons photo with its license, or null. */
  async getPhoto(qid) {
    const file = await this.getImageFile(qid);
    return file ? this.getCommonsPhoto(file) : null;
  }
}

// ---------------------------------------------------------------------------
// ListenBrainz similar artists (CC0 listening data from the MetaBrainz Foundation)
// ---------------------------------------------------------------------------

/** ListenBrainz Labs similar-artists endpoint (CORS open, no key). Labs APIs can change. */
export const LB_SIMILAR_URL = 'https://labs.api.listenbrainz.org/similar-artists/json';
/** The dataset ListenBrainz uses for its own similar-artist pages. */
export const LB_SIMILAR_ALGORITHM = 'session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30';
export const SIMILAR_ARTISTS_LIMIT = 8;

const MBID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Clean, de-duplicated similar artists (best first), without the artist itself. */
export function normalizeSimilarArtists(list, selfMbid = '', limit = SIMILAR_ARTISTS_LIMIT) {
  const self = String(selfMbid || '').toLowerCase();
  const seen = new Set();
  return (Array.isArray(list) ? list : [])
    .filter((a) => a && MBID_PATTERN.test(String(a.artist_mbid || '')))
    .map((a) => ({
      mbid: String(a.artist_mbid).toLowerCase(),
      name: String(a.name || '').replace(/\s+/g, ' ').trim().slice(0, 120),
      comment: String(a.comment || '').replace(/\s+/g, ' ').trim().slice(0, 120),
      type: String(a.type || ''),
      score: Number(a.score) || 0
    }))
    .filter((a) => a.name && a.mbid !== self && !seen.has(a.mbid) && seen.add(a.mbid))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export class ListenBrainzClient {
  constructor({ fetchImpl = (typeof fetch === 'function' ? fetch.bind(globalThis) : null) } = {}) {
    this.fetchImpl = fetchImpl;
  }

  /** Artists listeners also play, for a MusicBrainz artist MBID. [] when unknown. */
  async getSimilarArtists(mbid, { limit = SIMILAR_ARTISTS_LIMIT } = {}) {
    if (!MBID_PATTERN.test(String(mbid || '')) || !this.fetchImpl) return [];
    const url = `${LB_SIMILAR_URL}?${buildQuery({ artist_mbids: String(mbid).toLowerCase(), algorithm: LB_SIMILAR_ALGORITHM })}`;
    const res = await this.fetchImpl(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`ListenBrainz HTTP ${res.status}`);
    return normalizeSimilarArtists(await res.json(), mbid, limit);
  }
}
