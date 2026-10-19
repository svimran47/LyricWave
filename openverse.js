/**
 * LyricWave free music: openly licensed songs you can play in full, found through Openverse.
 *
 * Openverse (https://openverse.org, run by WordPress.org) indexes Creative Commons and public
 * domain audio from Jamendo, Freesound, Wikimedia Commons, ccMixter and others. Its API needs no
 * key; anonymous use is limited to 20 requests a minute and 200 a day, so searches are only sent
 * on demand and results are paged 20 at a time.
 *
 * Every track keeps its license, license URL, credit line, creator and host page (OpenTrackInfo in
 * types.js) so the credit can be shown wherever it plays. Audio streams from the host; nothing is
 * downloaded or cached for offline use.
 */

import { normalizeOpenTrackInfo } from './types.js';
import { isCommercialOk } from './library.js';

export const OPENVERSE_API = 'https://api.openverse.org/v1/audio/';
/** Largest page anonymous Openverse clients may ask for. */
export const OPENVERSE_PAGE_SIZE = 20;
export const OPENVERSE_MAX_QUERY = 100;

const PROVIDER_NAMES = {
  jamendo: 'Jamendo',
  freesound: 'Freesound',
  wikimedia_audio: 'Wikimedia Commons',
  wikimedia: 'Wikimedia Commons',
  ccmixter: 'ccMixter',
  europeana: 'Europeana',
  smithsonian: 'Smithsonian'
};

/** "jamendo" -> "Jamendo"; unknown hosts are title-cased. */
export function providerName(source) {
  const key = String(source || '').trim().toLowerCase();
  if (!key) return 'Openverse';
  return PROVIDER_NAMES[key] || key.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Openverse license + version as one code that isCommercialOk() understands:
 * cc0 -> CC0-1.0, pdm -> PDM, by-nc-sa 3.0 -> CC-BY-NC-SA-3.0, sampling+ -> CC-SAMPLING+-1.0.
 */
export function licenseCode(license, version) {
  const l = String(license || '').trim().toLowerCase();
  if (!l) return '';
  if (l === 'cc0') return 'CC0-1.0';
  if (l === 'pdm') return 'PDM';
  const v = String(version || '').trim();
  const cleanVersion = /^\d+(\.\d+)?$/.test(v) ? v : '';
  return `CC-${l.toUpperCase()}${cleanVersion ? `-${cleanVersion}` : ''}`;
}

/** Label for people: "CC0", "Public domain", "CC BY-SA 3.0". */
export function licenseLabel(license, version) {
  const l = String(license || '').trim().toLowerCase();
  if (!l) return 'Unknown license';
  if (l === 'cc0') return 'CC0';
  if (l === 'pdm') return 'Public domain';
  const v = String(version || '').trim();
  return `CC ${l.toUpperCase()}${/^\d+(\.\d+)?$/.test(v) ? ` ${v}` : ''}`;
}

const cleanText = (v, max = 200) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const httpsOnly = (v) => (/^https:\/\/[^\s"'<>]+$/i.test(String(v || '').trim()) ? String(v).trim() : '');

/**
 * One Openverse audio result as a track LyricWave can list, play and save, or null when it can't
 * be played (no https audio file, unknown license, or flagged mature).
 */
export function normalizeOpenverseResult(r) {
  if (!r || typeof r !== 'object' || r.mature === true) return null;
  const code = licenseCode(r.license, r.license_version);
  const label = licenseLabel(r.license, r.license_version);
  const creator = cleanText(r.creator) || 'Unknown artist';
  const title = cleanText(r.title) || 'Untitled';
  const provider = providerName(r.source || r.provider);
  const openTrack = normalizeOpenTrackInfo({
    openverseId: r.id,
    audioUrl: r.url,
    license: code,
    licenseLabel: label,
    licenseUrl: r.license_url,
    attribution: cleanText(r.attribution, 400) || `"${title}" by ${creator}, ${label}`,
    creator,
    creatorUrl: r.creator_url,
    landingUrl: r.foreign_landing_url,
    provider,
    commercialOk: isCommercialOk(code)
  });
  if (!openTrack) return null;
  const durationMs = Number(r.duration) > 0 ? Math.round(Number(r.duration)) : 0;
  return {
    id: `openverse_${openTrack.openverseId}`,
    title,
    artist: creator,
    album: cleanText(r.audio_set?.title),
    albumArt: httpsOnly(r.thumbnail),
    durationMs,
    genres: Array.isArray(r.genres) ? r.genres.map((g) => cleanText(g, 40)).filter(Boolean).slice(0, 4) : [],
    source: 'openverse',
    openTrack
  };
}

/** Search URL for openly licensed music. commercialOnly keeps licenses that allow commercial use. */
export function buildOpenverseSearchUrl(query, { page = 1, pageSize = OPENVERSE_PAGE_SIZE, commercialOnly = false, apiBase = OPENVERSE_API } = {}) {
  const params = new URLSearchParams({
    q: String(query || '').trim().slice(0, OPENVERSE_MAX_QUERY),
    category: 'music',
    mature: 'false',
    page: String(Math.max(1, Math.floor(Number(page) || 1))),
    page_size: String(Math.max(1, Math.min(OPENVERSE_PAGE_SIZE, Math.floor(Number(pageSize) || OPENVERSE_PAGE_SIZE))))
  });
  if (commercialOnly) params.set('license_type', 'commercial');
  return `${apiBase}?${params.toString()}`;
}

/** Track shape for SearchSource.selectTrack(): plays the full open audio file. */
export function playableOpenTrack(item) {
  const openTrack = normalizeOpenTrackInfo(item?.openTrack);
  if (!openTrack) return null;
  const durationMs = Number(item.durationMs) > 0
    ? Number(item.durationMs)
    : (Number(item.durationSec) > 0 ? Number(item.durationSec) * 1000 : 0);
  return {
    id: `openverse_${openTrack.openverseId}`,
    title: item.title,
    artist: item.artist,
    album: item.album || '',
    albumArt: item.albumArt || item.sourceArt || '',
    durationMs: durationMs || 180000,
    durationEstimated: !durationMs,
    previewUrl: openTrack.audioUrl,
    playPreview: true,
    lrclibId: item.lrclibId || null,
    source: 'openverse',
    openTrack
  };
}

/** "CC BY-SA 3.0 · Some Creator · Jamendo" for compact credit lines. */
export function openCreditLine(openTrack) {
  if (!openTrack) return '';
  return [openTrack.licenseLabel || openTrack.license, openTrack.creator, openTrack.provider].filter(Boolean).join(' · ');
}

export class OpenverseError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'OpenverseError';
    this.code = code;
  }
}

export class OpenverseClient {
  constructor({ fetchImpl = null, apiBase = OPENVERSE_API } = {}) {
    this.fetchImpl = fetchImpl;
    this.apiBase = apiBase;
  }

  /**
   * @returns {Promise<{results: object[], page: number, pageCount: number, total: number}>}
   * Throws OpenverseError with code 'rate_limited', 'http' or 'network'.
   */
  async search(query, { page = 1, commercialOnly = false, signal } = {}) {
    const q = String(query || '').trim();
    if (!q) return { results: [], page: 1, pageCount: 0, total: 0 };
    const doFetch = this.fetchImpl || ((...args) => fetch(...args));
    let res;
    try {
      res = await doFetch(buildOpenverseSearchUrl(q, { page, commercialOnly, apiBase: this.apiBase }), {
        headers: { Accept: 'application/json' },
        signal
      });
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      throw new OpenverseError('Openverse could not be reached.', 'network');
    }
    if (res.status === 429) throw new OpenverseError('Openverse is limiting searches right now. Try again in a minute.', 'rate_limited');
    if (!res.ok) throw new OpenverseError(`Openverse search failed (${res.status}).`, 'http');
    const data = await res.json().catch(() => null);
    const seen = new Set();
    const results = (Array.isArray(data?.results) ? data.results : [])
      .map(normalizeOpenverseResult)
      .filter((t) => t && !seen.has(t.openTrack.openverseId) && seen.add(t.openTrack.openverseId));
    return {
      results,
      page: Number(data?.page) || Number(page) || 1,
      pageCount: Number(data?.page_count) || 0,
      total: Number(data?.result_count) || results.length
    };
  }
}
