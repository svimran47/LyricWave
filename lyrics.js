/**
 * LyricWave Lyrics Service (Phase 3)
 * 
 * Fetches synced lyrics from LRCLIB API (lrclib.net),
 * parses LRC timestamp formats, handles caching,
 * provides fallbacks for plain/instrumental tracks,
 * and manages user offset calibration.
 */

import { openAppDB, LYRICS_STORE } from './db.js';

const LRCLIB_GET_URL = 'https://lrclib.net/api/get';
const LRCLIB_SEARCH_URL = 'https://lrclib.net/api/search';
const LRCLIB_HEADERS = {
  'Lrclib-Client': 'LyricWave/1.0.0 (https://github.com/lyricwave)'
};
const STORAGE_OFFSET_KEY = 'lyricwave_manual_offset_ms';
const STORAGE_CACHE_PREFIX = 'lyricwave_lrc_';

// 30 days expiry in milliseconds (30 * 24 * 60 * 60 * 1000)
const IDB_CACHE_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;
const STORE_NAME = LYRICS_STORE;

/**
 * Open LyricWaveDB (shared with the Library, see db.js)
 */
function openLyricsDB() {
  return openAppDB();
}

/**
 * Normalize artist and title into a robust cache key
 */
export function normalizeLyricCacheKey(artist, title) {
  const normArtist = String(artist || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  const normTitle = cleanTrackTitle(String(title || ''))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  return `${normArtist}__${normTitle}`.trim();
}

/**
 * Retrieve cached lyrics from IndexedDB (with 30-day expiry check)
 */
async function getIdbCachedLyrics(key) {
  const db = await openLyricsDB();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(key);
      req.onsuccess = () => {
        const entry = req.result;
        if (entry && entry.data && entry.data.status !== 'not_found' && entry.cachedAt && (Date.now() - entry.cachedAt < IDB_CACHE_EXPIRY_MS)) {
          resolve(entry.data);
        } else {
          // Expired, missing, or negative not_found entry
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/**
 * Save lyrics to IndexedDB with timestamp
 */
async function setIdbCachedLyrics(key, data) {
  const db = await openLyricsDB();
  if (!db) return;
  try {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put({
      key,
      data,
      cachedAt: Date.now()
    });
  } catch {
    // Fail silently on private browsing / storage quota restrictions
  }
}

// In-memory runtime cache for rapid track switching
const memoryCache = new Map();

/**
 * Clean track title by removing common suffixes that hurt API match rates
 */
export function cleanTrackTitle(title) {
  if (!title) return '';
  return title
    .replace(/^["'“‘]+|["'”’]+$/g, '')
    .replace(/\s*-\s*.*?(remaster(?:ed)?|deluxe|bonus|radio edit|live|mono|stereo|anniversary|edit|version|session(?:s)?|audio|video|visualizer|mix).*$/i, '')
    .replace(/\s*-\s*\d{4}\s+remaster.*$/i, '')
    .replace(/\s*\(feat\..*?\)/i, '')
    .replace(/\s*\(with.*?\)/i, '')
    .replace(/\s*\[feat\..*?\]/i, '')
    .replace(/\s*\[with.*?\]/i, '')
    .replace(/\s*(?:feat\.|ft\.|featuring)\s+.*$/i, '')
    .replace(/\s*\(.*?(remaster(?:ed)?|deluxe|bonus|anniversary|session(?:s)?|live|edit|acoustic|official|audio|video|visualizer|lyrics?).*?\)/i, '')
    .replace(/\s*\[.*?(remaster(?:ed)?|deluxe|bonus|anniversary|session(?:s)?|live|edit|acoustic|official|audio|video|visualizer|lyrics?).*?\]/i, '')
    .replace(/\s*-\s*(?:single|ep|single version).*$/i, '')
    .trim();
}

/**
 * Loose-but-safe artist comparison for LRCLIB search candidates.
 * Empty names never match, and containment only counts on word boundaries for
 * names of 3+ characters (so "" or "Ed" can't match every artist).
 */
export function artistsMatch(wanted, candidate) {
  const norm = (v) => String(v || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const a = norm(wanted);
  const b = norm(candidate);
  if (!a || !b) return false;
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length < 3) return false;
  return ` ${longer} `.includes(` ${shorter} `);
}

/**
 * Title comparison for search candidates: equal after cleanup, or one contains the other
 * on word boundaries (min 4 chars) — "Get Lucky" vs "Get Lucky (Radio Edit)".
 */
export function titlesMatch(wanted, candidate) {
  const norm = (v) => cleanTrackTitle(String(v || '')).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const a = norm(wanted);
  const b = norm(candidate);
  if (!a || !b) return false;
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length < 4) return false;
  return ` ${longer} `.includes(` ${shorter} `);
}

/**
 * Parse raw LRC string into a sorted array of timed lyric objects
 * Returns: Array<{ timeMs: number, text: string }>
 */
export function parseLRC(lrcText) {
  if (!lrcText || typeof lrcText !== 'string') return [];

  const lines = lrcText.split('\n');
  const parsed = [];
  const timestampRegex = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g;
  let fileOffsetMs = 0;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    // Check for [offset: +/- ms] metadata tag
    const offsetMatch = trimmed.match(/^\[offset:\s*([+-]?\d+)\s*\]/i);
    if (offsetMatch) {
      fileOffsetMs = parseInt(offsetMatch[1], 10) || 0;
      continue;
    }

    // Skip metadata tags (e.g. [ar:Artist], [ti:Title], [length:...])
    if (/^\[(ar|ti|al|by|length|re|ve):/i.test(trimmed)) {
      continue;
    }

    // Collect all timestamps in the line
    const timestamps = [];
    let match;
    while ((match = timestampRegex.exec(trimmed)) !== null) {
      const minutes = parseInt(match[1], 10);
      const seconds = parseInt(match[2], 10);
      let ms = 0;

      if (match[3]) {
        // Handle 1, 2, or 3 digit fractions of seconds
        const fraction = match[3];
        if (fraction.length === 1) ms = parseInt(fraction, 10) * 100;
        else if (fraction.length === 2) ms = parseInt(fraction, 10) * 10;
        else ms = parseInt(fraction.slice(0, 3), 10);
      }

      timestamps.push(minutes * 60 * 1000 + seconds * 1000 + ms);
    }

    // Extract text portion after stripping all timestamp tags
    const text = trimmed.replace(timestampRegex, '').trim();

    // Map each timestamp to this text, adjusting for file [offset: ms]
    for (const timeMs of timestamps) {
      const adjustedTimeMs = Math.max(0, timeMs + fileOffsetMs);
      parsed.push({ timeMs: adjustedTimeMs, text });
    }
  }

  // Sort chronologically
  parsed.sort((a, b) => a.timeMs - b.timeMs);

  return parsed;
}

/**
 * Fetch lyrics from LRCLIB with multi-tier fallback (Exact GET -> Cleaned GET -> Search API)
 */
export async function fetchLyrics(track) {
  if (!track || !track.title) {
    return { status: 'none', message: 'No track provided' };
  }

  const rawArtistStr = String(track.artists || track.artist || '').trim();
  const primaryArtist = rawArtistStr.split(/,|\bfeat\b\.?|\bft\b\.?|\bwith\b/i)[0].trim() || rawArtistStr;
  const idbKey = normalizeLyricCacheKey(primaryArtist, track.title);
  const cacheKey = `${track.id || track.title}__${track.artists || track.artist}`.toLowerCase();

  // 0. Fast-path: pre-attached lyrics on track object (e.g. from rich search results)
  if (track.syncedLyrics || track.plainLyrics) {
    const lines = track.syncedLyrics ? parseLRC(track.syncedLyrics) : [];
    const directResult = {
      status: lines.length > 0 ? 'synced' : (track.plainLyrics ? 'plain' : 'none'),
      type: lines.length > 0 ? 'synced' : (track.plainLyrics ? 'plain' : 'none'),
      syncedLines: lines,
      plainLyrics: track.plainLyrics || '',
      lrclibId: track.lrclibId || (typeof track.id === 'string' && track.id.startsWith('lrclib_') ? track.id.replace('lrclib_', '') : null)
    };
    memoryCache.set(cacheKey, directResult);
    memoryCache.set(idbKey, directResult);
    return directResult;
  }

  // 1. Check in-memory cache (ignore stale negative not_found entries)
  if (memoryCache.has(cacheKey)) {
    const mem = memoryCache.get(cacheKey);
    if (mem && mem.status !== 'not_found') return mem;
    memoryCache.delete(cacheKey);
  }
  if (memoryCache.has(idbKey)) {
    const mem = memoryCache.get(idbKey);
    if (mem && mem.status !== 'not_found') return mem;
    memoryCache.delete(idbKey);
  }

  // 2. Check IndexedDB 30-day cache
  try {
    const idbCached = await getIdbCachedLyrics(idbKey);
    if (idbCached && idbCached.status !== 'not_found') {
      memoryCache.set(cacheKey, idbCached);
      memoryCache.set(idbKey, idbCached);
      return idbCached;
    }
  } catch (err) {
    console.warn('IndexedDB read error:', err);
  }

  // 3. Check localStorage cache fallback
  if (typeof localStorage !== 'undefined') {
    try {
      const cachedItem = localStorage.getItem(`${STORAGE_CACHE_PREFIX}${cacheKey}`);
      if (cachedItem) {
        const data = JSON.parse(cachedItem);
        if (data && data.status !== 'not_found') {
          memoryCache.set(cacheKey, data);
          memoryCache.set(idbKey, data);
          return data;
        } else {
          localStorage.removeItem(`${STORAGE_CACHE_PREFIX}${cacheKey}`);
        }
      }
    } catch (err) {
      console.warn('LocalStorage read error:', err);
    }
  }

  // 4. Fetch from LRCLIB
  const durationSec = Math.round((track.durationMs || 0) / 1000);

  let lyricResult = null;
  let isQuotaError = false;

  try {
    const cleanedTitle = cleanTrackTitle(track.title);
    const fetchController = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const fetchTimer = fetchController ? setTimeout(() => fetchController.abort(), 12000) : null;
    const fetchSignal = fetchController ? fetchController.signal : undefined;

    // Fast Step 0: Direct ID lookup if LRCLIB ID is available
    const explicitLrcId = track.lrclibId || (typeof track.id === 'string' && track.id.startsWith('lrclib_') ? track.id.replace('lrclib_', '') : null);
    if (explicitLrcId) {
      try {
        const idRes = await fetch(`${LRCLIB_GET_URL}/${explicitLrcId}`, { headers: LRCLIB_HEADERS, signal: fetchSignal });
        if (idRes.status === 429) isQuotaError = true;
        if (idRes.ok) {
          const idData = await idRes.json();
          if (idData && (idData.syncedLyrics || idData.plainLyrics || idData.instrumental)) {
            lyricResult = idData;
          }
        }
      } catch {}
    }

    // Fast Step 1: Clean exact GET query via /api/get (resolves 90% of songs in ~150ms)
    if (!lyricResult) {
      try {
        const exactParams = new URLSearchParams({
          track_name: track.title,
          artist_name: primaryArtist
        });
        // LRCLIB matches duration within a couple of seconds; it disambiguates versions.
        // Skip it when our duration is only a guess (chart previews, mic/Last.fm fallbacks).
        if (durationSec > 0 && !track.durationEstimated) exactParams.set('duration', String(durationSec));
        const exactRes = await fetch(`${LRCLIB_GET_URL}?${exactParams.toString()}`, { headers: LRCLIB_HEADERS, signal: fetchSignal });
        if (exactRes.status === 429) isQuotaError = true;
        if (exactRes.ok) {
          const exactData = await exactRes.json();
          if (exactData && (exactData.syncedLyrics || exactData.instrumental)) {
            lyricResult = exactData;
          } else if (exactData && exactData.plainLyrics && !lyricResult) {
            lyricResult = exactData;
          }
        }
      } catch {}
    }

    // Step 2: Cleaned title query via /api/get (if title differs)
    if (!lyricResult && cleanedTitle && cleanedTitle !== track.title) {
      try {
        const cleanParams = new URLSearchParams({
          track_name: cleanedTitle,
          artist_name: primaryArtist
        });
        const cleanRes = await fetch(`${LRCLIB_GET_URL}?${cleanParams.toString()}`, { headers: LRCLIB_HEADERS, signal: fetchSignal });
        if (cleanRes.status === 429) isQuotaError = true;
        if (cleanRes.ok) {
          const cleanData = await cleanRes.json();
          if (cleanData && (cleanData.syncedLyrics || cleanData.instrumental)) {
            lyricResult = cleanData;
          } else if (cleanData && cleanData.plainLyrics && !lyricResult) {
            lyricResult = cleanData;
          }
        }
      } catch {}
    }

    // Step 3: Search fallback via /api/search
    if (!lyricResult) {
      try {
        const searchParams = new URLSearchParams({
          track_name: cleanedTitle || track.title,
          artist_name: primaryArtist
        });
        const generalParams = new URLSearchParams({
          q: `${primaryArtist} ${cleanedTitle || track.title}`.trim()
        });

        const [searchRes, generalRes] = await Promise.all([
          fetch(`${LRCLIB_SEARCH_URL}?${searchParams.toString()}`, { headers: LRCLIB_HEADERS, signal: fetchSignal }).then(r => r.ok ? r.json() : null).catch(() => null),
          fetch(`${LRCLIB_SEARCH_URL}?${generalParams.toString()}`, { headers: LRCLIB_HEADERS, signal: fetchSignal }).then(r => r.ok ? r.json() : null).catch(() => null)
        ]);

        const allCandidates = [
          ...(Array.isArray(searchRes) ? searchRes : []),
          ...(Array.isArray(generalRes) ? generalRes : [])
        ];

        if (allCandidates.length > 0) {
          // Filter candidates to ensure the artist actually matches the requested artist
          // ...and that it is the same song (the general "q" search also returns the artist's other songs).
          const wantedTitle = cleanedTitle || track.title;
          const artistMatches = allCandidates.filter(r =>
            (!primaryArtist || artistsMatch(primaryArtist, r.artistName)) && titlesMatch(wantedTitle, r.trackName));
          const pool = artistMatches.length > 0 ? artistMatches : [];
          if (pool.length > 0) {
            lyricResult = pool.find(r => r.syncedLyrics)
              || pool.find(r => r.plainLyrics)
              || pool[0];
          }
        }
      } catch {}
    }

    // Step 4: Broad title search fallback (STRICT artist match required)
    if (!lyricResult && cleanedTitle && primaryArtist) {
      try {
        const titleParams = new URLSearchParams({ track_name: cleanedTitle });
        const titleRes = await fetch(`${LRCLIB_SEARCH_URL}?${titleParams.toString()}`, { headers: LRCLIB_HEADERS, signal: fetchSignal });
        if (titleRes.ok) {
          const titleCandidates = await titleRes.json();
          if (Array.isArray(titleCandidates) && titleCandidates.length > 0) {
            const matched = titleCandidates.find(r => artistsMatch(primaryArtist, r.artistName));
            if (matched) {
              lyricResult = matched;
            }
          }
        }
      } catch {}
    }

    // Step 5: alternative names supplied by the recognizer (Spotify/Deezer canonical names,
    // other ACRCloud matches). Recognizer titles are sometimes localized, romanized or carry
    // release suffixes that LRCLIB doesn't use — this was the main cause of "No lyrics" after a
    // successful mic match.
    if (!lyricResult && Array.isArray(track.lookupCandidates)) {
      const splitArtist = (a) => String(a || '').split(/,|&|\bfeat\b\.?|\bft\b\.?|\bwith\b/i)[0].trim();
      for (const cand of track.lookupCandidates.slice(0, 4)) {
        if (lyricResult) break;
        const cTitle = cleanTrackTitle(cand?.title || '') || String(cand?.title || '').trim();
        const cArtist = splitArtist(cand?.artist);
        if (!cTitle) continue;
        const same = cTitle.toLowerCase() === (cleanedTitle || track.title).toLowerCase()
          && cArtist.toLowerCase() === primaryArtist.toLowerCase();
        if (same) continue;
        try {
          if (cArtist) {
            const p = new URLSearchParams({ track_name: cTitle, artist_name: cArtist });
            const r = await fetch(`${LRCLIB_GET_URL}?${p.toString()}`, { headers: LRCLIB_HEADERS, signal: fetchSignal });
            if (r.status === 429) isQuotaError = true;
            if (r.ok) {
              const d = await r.json();
              if (d && (d.syncedLyrics || d.plainLyrics || d.instrumental)) lyricResult = d;
            }
          }
          if (!lyricResult) {
            const q = new URLSearchParams({ q: `${cArtist} ${cTitle}`.trim() });
            const list = await fetch(`${LRCLIB_SEARCH_URL}?${q.toString()}`, { headers: LRCLIB_HEADERS, signal: fetchSignal })
              .then(res => (res.ok ? res.json() : [])).catch(() => []);
            const pool = (Array.isArray(list) ? list : []).filter(r =>
              titlesMatch(cTitle, r.trackName) && (!cArtist || artistsMatch(cArtist, r.artistName)));
            lyricResult = pool.find(r => r.syncedLyrics) || pool.find(r => r.plainLyrics) || null;
          }
        } catch {}
      }
    }

    // Step 6: title-only search confirmed by song length (±3s). Rescues songs whose artist
    // name is written differently on LRCLIB (another script, "The", collaborations...).
    if (!lyricResult && durationSec > 0 && !track.durationEstimated) {
      const titles = [cleanedTitle || track.title];
      for (const cand of (Array.isArray(track.lookupCandidates) ? track.lookupCandidates : [])) {
        const t = cleanTrackTitle(cand?.title || '');
        if (t && !titles.some(x => x.toLowerCase() === t.toLowerCase())) titles.push(t);
      }
      for (const t of titles.slice(0, 3)) {
        if (lyricResult) break;
        try {
          const q = new URLSearchParams({ track_name: t });
          const list = await fetch(`${LRCLIB_SEARCH_URL}?${q.toString()}`, { headers: LRCLIB_HEADERS, signal: fetchSignal })
            .then(res => (res.ok ? res.json() : [])).catch(() => []);
          const pool = (Array.isArray(list) ? list : []).filter(r =>
            titlesMatch(t, r.trackName) && Math.abs((Number(r.duration) || 0) - durationSec) <= 3);
          lyricResult = pool.find(r => r.syncedLyrics) || pool.find(r => r.plainLyrics) || null;
        } catch {}
      }
    }

    if (fetchTimer) clearTimeout(fetchTimer);

    if (isQuotaError && !lyricResult) {
      return {
        status: 'quota',
        type: 'none',
        message: 'LRCLIB API rate limit exceeded (HTTP 429). Please wait a moment.',
        syncedLines: [],
        plainLyrics: ''
      };
    }
  } catch (fetchErr) {
    console.warn('LRCLIB network error:', fetchErr);
    const isOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
    return {
      status: 'error',
      type: 'none',
      message: isOffline
        ? 'You are currently offline. Connect to the internet to load new lyrics.'
        : `Network error reaching lyrics provider (${fetchErr.message || 'connection failed'}).`,
      syncedLines: [],
      plainLyrics: ''
    };
  }

  // 4. Process and format final lyrics result
  let processed;

  if (!lyricResult) {
    processed = {
      status: 'not_found',
      type: 'none',
      message: 'No lyrics found for this song on LRCLIB.',
      syncedLines: [],
      plainLyrics: ''
    };
  } else if (lyricResult.instrumental) {
    processed = {
      status: 'instrumental',
      type: 'instrumental',
      message: '🎷 Instrumental track — no lyrics available.',
      syncedLines: [],
      plainLyrics: ''
    };
  } else if (lyricResult.syncedLyrics) {
    const lines = parseLRC(lyricResult.syncedLyrics);
    processed = {
      status: 'synced',
      type: 'synced',
      syncedLines: lines,
      plainLyrics: lyricResult.plainLyrics || '',
      lrclibId: lyricResult.id,
      durationSec: Number(lyricResult.duration) || 0
    };
  } else if (lyricResult.plainLyrics) {
    processed = {
      status: 'plain',
      type: 'plain',
      syncedLines: [],
      plainLyrics: lyricResult.plainLyrics,
      message: 'Plain lyrics available (unsynced).',
      lrclibId: lyricResult.id,
      durationSec: Number(lyricResult.duration) || 0
    };
  } else {
    processed = {
      status: 'not_found',
      type: 'none',
      message: 'No lyrics found for this song on LRCLIB.',
      syncedLines: [],
      plainLyrics: ''
    };
  }

  // 5. Store valid lyrics in memory, IndexedDB (30-day), and persistent localStorage cache (NEVER cache not_found)
  if (processed.status === 'synced' || processed.status === 'plain' || processed.status === 'instrumental') {
    memoryCache.set(cacheKey, processed);
    memoryCache.set(idbKey, processed);
    setIdbCachedLyrics(idbKey, processed).catch(() => {});
    try {
      localStorage.setItem(`${STORAGE_CACHE_PREFIX}${cacheKey}`, JSON.stringify(processed));
    } catch (err) {
      pruneOldCache();
    }
  }

  return processed;
}

/**
 * Prune old lyric cache items if storage is full
 */
function pruneOldCache() {
  try {
    const keys = Object.keys(localStorage).filter(k => k.startsWith(STORAGE_CACHE_PREFIX));
    for (let i = 0; i < Math.min(keys.length, 20); i++) {
      localStorage.removeItem(keys[i]);
    }
  } catch {
    // Ignore prune errors
  }
}

/**
 * Find index of active line for current playback position
 */
export function findActiveLineIndex(syncedLines, positionMs) {
  if (!syncedLines || syncedLines.length === 0) return -1;
  if (positionMs < syncedLines[0].timeMs) return -1; // Before first line

  // Binary search or linear scan for current line
  let activeIndex = 0;
  for (let i = 0; i < syncedLines.length; i++) {
    if (syncedLines[i].timeMs <= positionMs) {
      activeIndex = i;
    } else {
      break;
    }
  }
  return activeIndex;
}

/**
 * Manual Offset Management (-5000ms to +5000ms)
 * Supports global default and per-source offset retention (e.g. mic, lastfm, search, spotify).
 */
export function getStoredOffsetMs(source = null) {
  if (typeof localStorage === 'undefined') return 0;
  
  if (source) {
    const sourceKey = `${STORAGE_OFFSET_KEY}_${source.toLowerCase()}`;
    const sourceVal = localStorage.getItem(sourceKey);
    if (sourceVal !== null) {
      const num = parseInt(sourceVal, 10);
      return isNaN(num) ? 0 : Math.max(-5000, Math.min(5000, num));
    }
  }

  const val = localStorage.getItem(STORAGE_OFFSET_KEY);
  if (!val) return 0;
  const num = parseInt(val, 10);
  return isNaN(num) ? 0 : Math.max(-5000, Math.min(5000, num));
}

export function setStoredOffsetMs(offsetMs, source = null) {
  const clamped = Math.max(-5000, Math.min(5000, Math.round(offsetMs)));
  if (typeof localStorage !== 'undefined') {
    if (source) {
      localStorage.setItem(`${STORAGE_OFFSET_KEY}_${source.toLowerCase()}`, clamped.toString());
    }
    // Also keep global key synchronized as baseline
    localStorage.setItem(STORAGE_OFFSET_KEY, clamped.toString());
  }
  return clamped;
}
