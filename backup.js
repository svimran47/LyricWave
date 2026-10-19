/**
 * LyricWave library backup: one JSON file with your songs, artists, playlists and your own lyrics,
 * each row with its license, credit and source, so the library can move to another device.
 *
 * Restoring merges into what is already on the device (nothing is deleted):
 *  - songs: new ones are added; for ones you have, plays add up to the larger count and the
 *    first / last played times widen
 *  - artists: new ones are added
 *  - playlists and your lyrics: the newer copy of each wins (new playlists only while there is room)
 * Every row from a file is rebuilt from known fields only (strings capped, links must be https,
 * ids checked against the shapes the library makes), because a backup file is untrusted input.
 *
 * Pure helpers run in Node for tests; LibraryBackup works on the app's stores.
 */

import { normalizeOpenTrackInfo, normalizeMbid, normalizeIsrc, normalizeOpenverseId } from './types.js';
import { isCommercialOk } from './library.js';
import { LYRICS_RIGHTS, DEFAULT_LYRICS_RIGHTS, cleanLyricsText, detectLyricsType } from './user-lyrics.js';
import { isPlaylistTrackId, MAX_PLAYLIST_NAME, MAX_PLAYLIST_TRACKS, MAX_PLAYLISTS } from './playlists.js';

export const BACKUP_FORMAT = 'lyricwave-library';
export const BACKUP_VERSION = 1;
/** Refuse files larger than this before parsing. */
export const MAX_BACKUP_BYTES = 15 * 1024 * 1024;
export const MAX_BACKUP_ROWS = 20000;

const str = (v, max = 300) => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/\s+/g, ' ').trim().slice(0, max) : '');
const https = (v) => (/^https:\/\/[^\s"'<>]+$/i.test(String(v || '').trim()) ? String(v).trim().slice(0, 2000) : '');
const num = (v, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : 0;
};
const strList = (v, maxItems = 20, maxLen = 120) => (Array.isArray(v) ? v.map((x) => str(x, maxLen)).filter(Boolean).slice(0, maxItems) : []);
/** commercialOk only when the row says so and its license agrees (as the library sets it). */
const commercial = (flag, license) => flag === true && isCommercialOk(license);

/** "key:" ids hold a trackMatchKey / artistKeyId: letters, digits, spaces and the "__" separator. */
const KEY_ID = /^key:[\p{L}\p{N} _]{1,600}$/u;
/** `prefix` + an id its normalizer leaves as it is (the library stores MBIDs, ISRCs and Openverse ids normalized). */
const hasId = (id, prefix, normalize) => id.startsWith(prefix) && id.length > prefix.length && normalize(id.slice(prefix.length)) === id.slice(prefix.length);

/** A library song id: mb:<recording MBID>, isrc:<ISRC>, ov:<Openverse id> or key:<artist__title>. */
export function isTrackId(id) {
  const s = typeof id === 'string' ? id : '';
  return hasId(s, 'mb:', normalizeMbid) || hasId(s, 'isrc:', normalizeIsrc) || hasId(s, 'ov:', normalizeOpenverseId) || KEY_ID.test(s);
}

/** A library artist id: mb:<artist MBID> or key:<name key>. */
export function isArtistId(id) {
  const s = typeof id === 'string' ? id : '';
  return hasId(s, 'mb:', normalizeMbid) || KEY_ID.test(s);
}

/** Your-lyrics id: ov:<Openverse id> for Free music, otherwise key:<artist__title>. */
export function isUserLyricsId(id) {
  const s = typeof id === 'string' ? id : '';
  return hasId(s, 'ov:', normalizeOpenverseId) || KEY_ID.test(s);
}

/** Ids from a list that pass `test`, once each, in order. */
const idList = (v, test, maxItems = 20) => (Array.isArray(v) ? [...new Set(v.filter(test))].slice(0, maxItems) : []);

/** License / credit fields every row carries. */
function licenseFields(r) {
  const license = str(r.license, 60) || 'unverified';
  return {
    license,
    licenseUrl: https(r.licenseUrl),
    attribution: str(r.attribution, 500),
    commercialOk: commercial(r.commercialOk, license),
    source: str(r.source, 40),
    sourceUrl: https(r.sourceUrl)
  };
}

function imageInfo(v) {
  if (!v || typeof v !== 'object' || !https(v.url)) return null;
  const license = str(v.license, 60);
  return {
    url: https(v.url),
    pageUrl: https(v.pageUrl),
    sourceUrl: https(v.sourceUrl),
    fileName: str(v.fileName, 240),
    source: str(v.source, 40),
    license,
    licenseLabel: str(v.licenseLabel, 60),
    licenseUrl: https(v.licenseUrl),
    author: str(v.author, 160),
    attribution: str(v.attribution, 400),
    attributionRequired: v.attributionRequired !== false,
    commercialOk: commercial(v.commercialOk, license)
  };
}

/** mb:<MBID> ids carry their MBID; every other artist has none (as buildArtistStubs makes them). */
const artistMbid = (id) => (id.startsWith('mb:') ? id.slice(3) : '');

/** A song row from a backup, or null when it isn't usable. */
export function sanitizeTrack(r) {
  if (!r || typeof r !== 'object' || !isTrackId(r.id) || !str(r.title)) return null;
  const id = r.id;
  // Only Free music rows (ov: ids) carry an openTrack, and it must name the same Openverse id
  const open = id.startsWith('ov:');
  const openTrack = open ? normalizeOpenTrackInfo(r.openTrack) : null;
  if (open && (!openTrack || `ov:${openTrack.openverseId}` !== id)) return null;
  const artistCredit = (Array.isArray(r.artistCredit) ? r.artistCredit : [])
    .filter((c) => c && isArtistId(c.id))
    .slice(0, 20)
    .map((c) => ({ id: c.id, mbid: artistMbid(c.id), name: str(c.name) }));
  const status = ['pending', 'resolved', 'not_found', 'error'].includes(r.resolveStatus) ? r.resolveStatus : 'pending';
  const row = {
    id,
    key: str(r.key, 700),
    // The MBID / ISRC fields agree with the id. Open rows have neither, so findTrack never
    // matches a copyrighted play to an open row by MBID or ISRC.
    mbid: id.startsWith('mb:') ? id.slice(3) : '',
    isrc: open ? '' : (id.startsWith('isrc:') ? id.slice(5) : normalizeIsrc(r.isrc)),
    title: str(r.title),
    artist: str(r.artist) || 'Unknown Artist',
    artistIds: idList(r.artistIds, isArtistId),
    artistCredit,
    album: str(r.album),
    releaseMbid: normalizeMbid(r.releaseMbid),
    releaseGroupMbid: normalizeMbid(r.releaseGroupMbid),
    durationSec: Math.round(num(r.durationSec, 0, 24 * 3600)),
    firstReleaseDate: str(r.firstReleaseDate, 20),
    sourceArt: https(r.sourceArt),
    art: imageInfo(r.art),
    lrclibId: Number.isInteger(Number(r.lrclibId)) && Number(r.lrclibId) > 0 ? Number(r.lrclibId) : null,
    sources: strList(r.sources, 10, 40),
    genres: strList(r.genres, 8, 40),
    playCount: Math.round(num(r.playCount, 0, 1e7)),
    firstSeenAt: num(r.firstSeenAt),
    lastSeenAt: num(r.lastSeenAt),
    // Only MusicBrainz rows are "resolved"; anything else claiming it is matched again on its next play
    resolveStatus: status === 'resolved' && !id.startsWith('mb:') ? 'pending' : status,
    resolvedAt: num(r.resolvedAt),
    ...licenseFields(r)
  };
  if (openTrack) {
    const commercialOk = commercial(openTrack.commercialOk, openTrack.license);
    row.openTrack = { ...openTrack, commercialOk };
    row.playable = true;
    // An open row's license fields always describe the recording itself
    row.license = openTrack.license;
    row.licenseUrl = openTrack.licenseUrl;
    row.commercialOk = commercialOk;
    row.attribution = row.attribution || openTrack.attribution || `"${row.title}" by ${row.artist}, ${openTrack.licenseLabel}`;
    row.source = 'openverse';
    row.sourceUrl = openTrack.landingUrl;
    row.resolveStatus = 'open';
  }
  if (!row.artistIds.length) row.artistIds = row.artistCredit.map((c) => c.id);
  return row;
}

/** An artist row from a backup, or null. */
export function sanitizeArtist(a) {
  if (!a || typeof a !== 'object' || !isArtistId(a.id) || !str(a.name)) return null;
  const row = {
    id: a.id,
    mbid: artistMbid(a.id),
    name: str(a.name),
    sortName: str(a.sortName),
    type: str(a.type, 40),
    country: str(a.country, 10),
    area: str(a.area, 120),
    disambiguation: str(a.disambiguation),
    lifeBegin: str(a.lifeBegin, 20),
    lifeEnd: str(a.lifeEnd, 20),
    genres: strList(a.genres, 8, 60),
    wikidataId: /^Q\d+$/i.test(String(a.wikidataId || '')) ? String(a.wikidataId).toUpperCase() : '',
    description: str(a.description, 500),
    wikipediaUrl: https(a.wikipediaUrl),
    photo: imageInfo(a.photo),
    similar: (Array.isArray(a.similar) ? a.similar : [])
      .filter((s) => s && normalizeMbid(s.mbid) && str(s.name))
      .slice(0, 20)
      .map((s) => ({ mbid: normalizeMbid(s.mbid), name: str(s.name, 120), comment: str(s.comment, 120), type: str(s.type, 40), score: num(s.score) })),
    similarFetchedAt: num(a.similarFetchedAt),
    detailsFetchedAt: num(a.detailsFetchedAt),
    createdAt: num(a.createdAt),
    ...licenseFields(a)
  };
  // Rows without a photo field get refreshed once on open (library-view needsPhotoRefresh)
  if (!('photo' in a)) delete row.photo;
  return row;
}

export function sanitizePlaylist(p) {
  if (!p || typeof p !== 'object' || !/^pl:[0-9a-z]{1,40}$/.test(String(p.id || ''))) return null;
  const name = str(p.name, MAX_PLAYLIST_NAME);
  if (!name) return null;
  const trackIds = [...new Set((Array.isArray(p.trackIds) ? p.trackIds : []).map(String).filter(isPlaylistTrackId))].slice(0, MAX_PLAYLIST_TRACKS);
  return { id: String(p.id), name, trackIds, createdAt: num(p.createdAt), updatedAt: num(p.updatedAt) };
}

export function sanitizeUserLyrics(l) {
  if (!l || typeof l !== 'object' || !isUserLyricsId(l.id)) return null;
  const text = cleanLyricsText(l.text);
  const known = typeof l.rights === 'string' && Object.prototype.hasOwnProperty.call(LYRICS_RIGHTS, l.rights);
  if (!text.trim() || !known) return null;
  // "The song's license" only exists for Free music songs (ov: ids); others keep a personal copy
  const rights = LYRICS_RIGHTS[l.rights].openOnly && !l.id.startsWith('ov:') ? DEFAULT_LYRICS_RIGHTS : l.rights;
  return {
    id: l.id,
    title: str(l.title),
    artist: str(l.artist),
    text,
    type: detectLyricsType(text),
    rights,
    credit: str(l.credit, 120),
    createdAt: num(l.createdAt),
    updatedAt: num(l.updatedAt)
  };
}

/** The backup object (JSON-ready). credits: one line per openly licensed song, for reuse. */
export function buildBackup({ tracks = [], artists = [], playlists = [], userLyrics = [], now = Date.now(), appVersion = '' } = {}) {
  const credits = tracks
    .filter((t) => t.openTrack)
    .map((t) => [t.attribution || `“${t.title}” by ${t.artist}`, t.openTrack.landingUrl].filter(Boolean).join(' · '));
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date(now).toISOString(),
    app: appVersion ? `LyricWave ${appVersion}` : 'LyricWave',
    note: 'Song and artist details keep their own license and credit fields. Free music songs are Creative Commons or public domain; follow each license if you reuse them. Lyrics marked "personal" are a personal copy.',
    counts: { tracks: tracks.length, artists: artists.length, playlists: playlists.length, userLyrics: userLyrics.length },
    tracks,
    artists,
    playlists,
    userLyrics,
    credits
  };
}

/** "lyricwave-library-2026-10-17.json", dated in the device's own time zone. */
export function backupFileName(now = Date.now()) {
  const d = new Date(now);
  const pad = (n) => String(n).padStart(2, '0');
  return `lyricwave-library-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`;
}

/** A file that can't be restored; its message is written for people. */
export class BackupFileError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BackupFileError';
  }
}

/**
 * Parse and clean a backup file's text. Throws BackupFileError (a message for people) when it
 * isn't a LyricWave backup. Returns the cleaned rows and how many were skipped as unusable.
 */
export function parseBackup(text) {
  const raw = String(text ?? '');
  if (raw.length > MAX_BACKUP_BYTES) throw new BackupFileError('That file is too large to be a LyricWave backup.');
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new BackupFileError('That file isn’t a LyricWave backup (it isn’t valid JSON).');
  }
  if (!data || data.format !== BACKUP_FORMAT) throw new BackupFileError('That file isn’t a LyricWave backup.');
  if (Number(data.version) > BACKUP_VERSION) throw new BackupFileError('That backup comes from a newer LyricWave. Update the app, then try again.');
  let skipped = 0;
  const clean = (list, fn) => {
    const rows = Array.isArray(list) ? list.slice(0, MAX_BACKUP_ROWS) : [];
    if (Array.isArray(list)) skipped += list.length - rows.length;
    const out = [];
    for (const r of rows) {
      const c = fn(r);
      if (c) out.push(c);
      else skipped++;
    }
    return out;
  };
  return {
    tracks: clean(data.tracks, sanitizeTrack),
    artists: clean(data.artists, sanitizeArtist),
    playlists: clean(data.playlists, sanitizePlaylist),
    userLyrics: clean(data.userLyrics, sanitizeUserLyrics),
    skipped,
    exportedAt: str(data.exportedAt, 40)
  };
}

/**
 * Merge a backed-up song into the one on this device: plays keep the larger count, first / last
 * played times widen, sources combine and missing genres are filled in; other details stay.
 * Returns `existing` itself when the backup adds nothing to it.
 */
export function mergeTrack(existing, incoming) {
  if (!existing) return incoming;
  const firsts = [existing.firstSeenAt, incoming.firstSeenAt].filter((n) => n > 0);
  const merged = {
    ...existing,
    playCount: Math.max(existing.playCount || 0, incoming.playCount || 0),
    firstSeenAt: firsts.length ? Math.min(...firsts) : 0,
    lastSeenAt: Math.max(existing.lastSeenAt || 0, incoming.lastSeenAt || 0),
    sources: [...new Set([...(existing.sources || []), ...(incoming.sources || [])])],
    genres: existing.genres?.length ? existing.genres : (incoming.genres || [])
  };
  const same = merged.playCount === (existing.playCount || 0) &&
    merged.firstSeenAt === (existing.firstSeenAt || 0) &&
    merged.lastSeenAt === (existing.lastSeenAt || 0) &&
    merged.sources.length === new Set(existing.sources || []).size &&
    merged.genres.length === (existing.genres || []).length;
  return same ? existing : merged;
}

/** "12 songs, 3 artists, 1 playlist" from counts; '' when all zero. */
export function describeCounts({ tracks = 0, artists = 0, playlists = 0, userLyrics = 0 }) {
  const part = (n, one, many) => (n ? `${n} ${n === 1 ? one : many}` : '');
  return [part(tracks, 'song', 'songs'), part(artists, 'artist', 'artists'), part(playlists, 'playlist', 'playlists'), part(userLyrics, 'set of your lyrics', 'sets of your lyrics')]
    .filter(Boolean).join(', ');
}

/** What LibraryBackup.restore() did, as the sentence(s) Settings shows. */
export function describeRestore({ found = {}, added = {}, updated = {}, skipped = 0, playlistsFull = 0 } = {}) {
  const addedText = describeCounts(added);
  const updatedText = describeCounts(updated);
  let text;
  if (!describeCounts(found)) text = 'That backup has nothing in it to restore.';
  else if (!addedText && !updatedText) text = playlistsFull ? 'Nothing was added from that backup.' : 'Everything in that backup is already on this device.';
  else text = `Restored: ${[addedText && `added ${addedText}`, updatedText && `updated ${updatedText}`].filter(Boolean).join('; ')}.`;
  if (playlistsFull) text += ` ${playlistsFull} ${playlistsFull === 1 ? 'playlist' : 'playlists'} didn’t fit; LyricWave keeps up to ${MAX_PLAYLISTS}.`;
  if (skipped) text += ` ${skipped} unreadable ${skipped === 1 ? 'entry was' : 'entries were'} skipped.`;
  return text;
}

export class LibraryBackup {
  /**
   * @param {object} stores
   * @param {import('./library.js').LibraryStore} stores.library
   * @param {import('./playlists.js').PlaylistStore} stores.playlists
   * @param {import('./user-lyrics.js').UserLyricsStore} stores.userLyrics
   * @param {(fn: () => Promise<any>) => Promise<any>} [stores.exclusive] the library collector's
   *   lock (LibraryCollector.exclusive), so a song playing during a restore keeps its new play
   */
  constructor({ library, playlists, userLyrics, exclusive = (fn) => fn(), now = () => Date.now(), appVersion = '' }) {
    this.library = library;
    this.playlists = playlists;
    this.userLyrics = userLyrics;
    this.exclusive = exclusive;
    this.now = now;
    this.appVersion = appVersion;
  }

  async export() {
    const [tracks, artists, playlists, userLyrics] = await Promise.all([
      this.library.allTracks(), this.library.allArtists(), this.playlists.all(), this.userLyrics.all()
    ]);
    return buildBackup({ tracks, artists, playlists, userLyrics, now: this.now(), appVersion: this.appVersion });
  }

  async exportText() {
    return JSON.stringify(await this.export(), null, 2);
  }

  /**
   * Merge a backup file's text into this device. Returns counts: `found` (usable rows in the file),
   * `added`, `updated`, `skipped` (unreadable entries) and `playlistsFull` (new playlists that
   * didn't fit under MAX_PLAYLISTS).
   */
  async restore(text) {
    const data = parseBackup(text);
    const found = { tracks: data.tracks.length, artists: data.artists.length, playlists: data.playlists.length, userLyrics: data.userLyrics.length };
    const added = { tracks: 0, artists: 0, playlists: 0, userLyrics: 0 };
    const updated = { tracks: 0, artists: 0, playlists: 0, userLyrics: 0 };

    await this.exclusive(async () => {
      // One read of each store and one write per store, so large libraries restore quickly
      const tracks = new Map((await this.library.allTracks()).map((t) => [t.id, t]));
      const had = new Set(tracks.keys());
      const changed = new Map();
      for (const t of data.tracks) {
        const existing = tracks.get(t.id);
        const next = mergeTrack(existing, t);
        if (next === existing) continue;
        tracks.set(t.id, next);
        changed.set(t.id, next);
      }
      for (const id of changed.keys()) {
        if (had.has(id)) updated.tracks++;
        else added.tracks++;
      }
      await this.library.putTracks([...changed.values()]);

      const artists = new Set((await this.library.allArtists()).map((a) => a.id));
      const fresh = new Map();
      for (const a of data.artists) if (!artists.has(a.id) && !fresh.has(a.id)) fresh.set(a.id, a);
      await this.library.putArtists([...fresh.values()]);
      added.artists = fresh.size;
    });

    let playlistCount = (await this.playlists.all()).length;
    let playlistsFull = 0;
    for (const p of data.playlists) {
      const existing = await this.playlists.get(p.id);
      if (existing && (existing.updatedAt || 0) >= (p.updatedAt || 0)) continue;
      if (!existing && playlistCount >= MAX_PLAYLISTS) {
        playlistsFull++;
        continue;
      }
      await this.playlists.put(p);
      if (existing) {
        updated.playlists++;
      } else {
        added.playlists++;
        playlistCount++;
      }
    }
    for (const l of data.userLyrics) {
      const existing = await this.userLyrics.get(l.id);
      if (existing && (existing.updatedAt || 0) >= (l.updatedAt || 0)) continue;
      await this.userLyrics.put(l);
      if (existing) updated.userLyrics++;
      else added.userLyrics++;
    }
    return { found, added, updated, skipped: data.skipped, playlistsFull };
  }
}
