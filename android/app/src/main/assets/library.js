/**
 * LyricWave Library: the open track collector.
 *
 * Every song LyricWave plays is collected into IndexedDB (LyricWaveDB, stores `tracks` and
 * `artists`, see db.js). The collector then matches it to a MusicBrainz recording, so each row
 * gets a stable id (`mb:<recording MBID>`, plus the ISRC when MusicBrainz has one) and
 * CC0 metadata. Rows that could not be matched yet keep the details from the source app
 * and are flagged as not openly licensed.
 *
 * Every track and artist row carries: license, licenseUrl, attribution, commercialOk,
 * source, sourceUrl.
 *
 * Free music found through Openverse (openverse.js) is stored too, as playable rows
 * (`ov:<Openverse id>`, resolveStatus 'open', playable: true, openTrack = OpenTrackInfo). Their
 * license fields describe the recording itself, and they are never re-matched to MusicBrainz. Lyrics are never stored here (only the LRCLIB id); cover art is
 * referenced by Cover Art Archive URL and is not redistributable.
 */

import { openAppDB, TRACKS_STORE, ARTISTS_STORE } from './db.js';
import { normalizeMbid, normalizeIsrc, trackMatchKey, stableTrackId, normalizeOpenTrackInfo } from './types.js';
import {
  MusicBrainzClient, WikidataClient, ListenBrainzClient, pickRelease, coverArtUrl, artistCreditName,
  wikidataIdFromRelations, primaryArtistName
} from './musicbrainz.js';

export const CC0 = {
  license: 'CC0-1.0',
  licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/'
};

/** Retry a failed or unmatched lookup after this long. */
export const RESOLVE_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
/** Refresh artist details (MusicBrainz + Wikidata) after this long. */
export const ARTIST_REFRESH_MS = 30 * 24 * 60 * 60 * 1000;
/** Refresh similar artists (ListenBrainz) after this long. */
export const SIMILAR_REFRESH_MS = 30 * 24 * 60 * 60 * 1000;

const SOURCE_NAMES = {
  mic: 'song recognition', search: 'iTunes Search', chart: 'Apple Music charts', spotify: 'Spotify',
  lastfm: 'Last.fm', phone: 'your music app', library: 'your library', openverse: 'Openverse'
};

/**
 * Whether a license allows commercial use. NC / ND and anything unknown is false, so a future
 * paid build can filter with one flag.
 */
export function isCommercialOk(license) {
  const l = String(license || '').toUpperCase().replace(/\s+/g, '-');
  if (!l) return false;
  if (/\bNC\b|-NC-|-NC$|NONCOMMERCIAL|\bND\b|-ND-|-ND$|NODERIV/.test(l)) return false;
  return l === 'CC0-1.0' || l === 'CC0' || l === 'PUBLIC-DOMAIN' || l === 'PDM' ||
    /^CC-BY(-SA)?(-\d(\.\d)?)?$/.test(l);
}

/** License fields for data copied from a provider whose terms don't allow redistribution. */
export function unverifiedLicense(source) {
  const name = SOURCE_NAMES[source] || source || 'the source app';
  return {
    license: 'unverified',
    licenseUrl: '',
    attribution: `Details from ${name}; not openly licensed`,
    commercialOk: false
  };
}

export function musicBrainzLicense(kind, mbid) {
  return {
    ...CC0,
    attribution: 'Metadata from MusicBrainz (CC0)',
    commercialOk: isCommercialOk(CC0.license),
    source: 'musicbrainz',
    sourceUrl: mbid ? `https://musicbrainz.org/${kind}/${mbid}` : 'https://musicbrainz.org/'
  };
}

/** Cover Art Archive art: credit it, never mark it commercial-OK (images keep their owners' rights). */
export function coverArtInfo(releaseGroupMbid, releaseMbid) {
  const url = coverArtUrl(releaseGroupMbid) || coverArtUrl(releaseMbid, { kind: 'release' });
  if (!url) return null;
  return {
    url,
    source: 'coverartarchive',
    sourceUrl: releaseGroupMbid ? `https://musicbrainz.org/release-group/${releaseGroupMbid}` : `https://musicbrainz.org/release/${releaseMbid}`,
    license: 'copyright-owner',
    attribution: 'Cover art via Cover Art Archive; rights belong to the owner',
    commercialOk: false
  };
}

export function artistKeyId(name) {
  const key = trackMatchKey(primaryArtistName(name) || name, '').replace(/__$/, '');
  return `key:${key || 'unknown'}`;
}

/** Should this now-playing item be collected at all? */
export function isCollectable(track) {
  if (!track || !track.title) return false;
  if (track.playbackType && track.playbackType !== 'track') return false;
  const title = String(track.title).trim().toLowerCase();
  if (!title || title === 'unknown title' || title === 'advertisement') return false;
  return true;
}

/** Row for a track that hasn't been matched to MusicBrainz (yet). */
export function buildProvisionalTrackRow(track, now = Date.now()) {
  const artist = String(track.artist || 'Unknown Artist');
  return {
    id: stableTrackId(track),
    key: trackMatchKey(track.artist, track.title),
    mbid: normalizeMbid(track.mbid) || '',
    isrc: normalizeIsrc(track.isrc) || '',
    title: String(track.title),
    artist,
    artistIds: [artistKeyId(artist)],
    artistCredit: [{ id: artistKeyId(artist), mbid: '', name: primaryArtistName(artist) || artist }],
    album: String(track.album || ''),
    releaseMbid: '',
    releaseGroupMbid: '',
    durationSec: track.durationEstimated ? 0 : Math.round(Number(track.duration) || 0),
    firstReleaseDate: '',
    // Provider artwork is shown on this device only and never treated as library data.
    sourceArt: String(track.albumArt || ''),
    art: null,
    lrclibId: track.lrclibId || null,
    sources: track.source ? [String(track.source)] : [],
    playCount: 1,
    firstSeenAt: now,
    lastSeenAt: now,
    resolveStatus: 'pending',
    resolvedAt: 0,
    ...unverifiedLicense(track.source),
    source: String(track.source || 'unknown'),
    sourceUrl: ''
  };
}

/**
 * Row for an openly licensed, playable track (Openverse). playCount starts at 1 for a play and 0
 * for a save. The license, credit and host page come from the track's OpenTrackInfo.
 */
export function buildOpenTrackRow(track, { now = Date.now(), played = true } = {}) {
  const info = normalizeOpenTrackInfo(track?.openTrack);
  if (!info) return null;
  const artist = String(info.creator || track.artist || 'Unknown Artist');
  const title = String(track.title || 'Untitled');
  const durationMs = Number(track.durationMs) > 0 ? Number(track.durationMs) : (Number(track.duration) > 0 ? Number(track.duration) * 1000 : 0);
  return {
    id: `ov:${info.openverseId}`,
    key: trackMatchKey(artist, title),
    mbid: '',
    isrc: '',
    title,
    artist,
    artistIds: [artistKeyId(artist)],
    artistCredit: [{ id: artistKeyId(artist), mbid: '', name: artist }],
    album: String(track.album || ''),
    releaseMbid: '',
    releaseGroupMbid: '',
    durationSec: track.durationEstimated ? 0 : Math.round(durationMs / 1000),
    firstReleaseDate: '',
    sourceArt: String(track.albumArt || ''),
    art: null,
    lrclibId: track.lrclibId || null,
    sources: ['openverse'],
    genres: Array.isArray(track.genres) ? track.genres.map((g) => String(g).trim()).filter(Boolean).slice(0, 4) : [],
    playCount: played ? 1 : 0,
    firstSeenAt: now,
    lastSeenAt: now,
    resolveStatus: 'open',
    resolvedAt: now,
    playable: true,
    openTrack: info,
    license: info.license,
    licenseUrl: info.licenseUrl,
    attribution: info.attribution || `"${title}" by ${artist}, ${info.licenseLabel}`,
    commercialOk: info.commercialOk,
    source: 'openverse',
    sourceUrl: info.landingUrl
  };
}

/** Artist row for an Openverse creator: just the name and their page at the host. */
export function buildOpenArtistStub(row, now = Date.now()) {
  const credit = row.artistCredit?.[0];
  if (!credit) return null;
  return {
    id: credit.id,
    mbid: '',
    name: credit.name,
    detailsFetchedAt: 0,
    createdAt: now,
    license: 'unverified',
    licenseUrl: '',
    attribution: `Creator listed on ${row.openTrack?.provider || 'Openverse'} via Openverse`,
    commercialOk: false,
    source: 'openverse',
    sourceUrl: row.openTrack?.creatorUrl || ''
  };
}

/** Merge a MusicBrainz recording into a (provisional or older) row. */
export function buildResolvedTrackRow(row, recording, now = Date.now()) {
  const mbid = normalizeMbid(recording.id);
  const release = pickRelease(recording);
  const releaseGroupMbid = normalizeMbid(release?.['release-group']?.id);
  const releaseMbid = normalizeMbid(release?.id);
  const credits = Array.isArray(recording['artist-credit']) ? recording['artist-credit'] : [];
  const artistCredit = credits
    .filter((c) => normalizeMbid(c?.artist?.id))
    .map((c) => ({ id: `mb:${normalizeMbid(c.artist.id)}`, mbid: normalizeMbid(c.artist.id), name: c.artist.name || c.name || '' }));
  const isrcs = Array.isArray(recording.isrcs) ? recording.isrcs.map(normalizeIsrc).filter(Boolean) : [];
  const isrc = normalizeIsrc(row.isrc) && (!isrcs.length || isrcs.includes(normalizeIsrc(row.isrc)))
    ? normalizeIsrc(row.isrc)
    : (isrcs[0] || '');
  return {
    ...row,
    id: `mb:${mbid}`,
    mbid,
    isrc,
    title: recording.title || row.title,
    artist: artistCreditName(credits) || row.artist,
    artistIds: artistCredit.length ? artistCredit.map((c) => c.id) : row.artistIds,
    artistCredit: artistCredit.length ? artistCredit : row.artistCredit,
    album: release?.title || row.album,
    releaseMbid,
    releaseGroupMbid,
    durationSec: recording.length > 0 ? Math.round(recording.length / 1000) : row.durationSec,
    firstReleaseDate: recording['first-release-date'] || release?.date || '',
    art: coverArtInfo(releaseGroupMbid, releaseMbid),
    resolveStatus: 'resolved',
    resolvedAt: now,
    ...musicBrainzLicense('recording', mbid)
  };
}

/** Artist rows from a resolved track row (details are filled in later by refreshArtist). */
export function buildArtistStubs(row, now = Date.now()) {
  return (row.artistCredit || []).map((c) => (c.mbid
    ? { id: c.id, mbid: c.mbid, name: c.name, detailsFetchedAt: 0, createdAt: now, ...musicBrainzLicense('artist', c.mbid) }
    : { id: c.id, mbid: '', name: c.name, detailsFetchedAt: 0, createdAt: now, ...unverifiedLicense(row.source), source: row.source, sourceUrl: '' }));
}

/** Artist row merged with a MusicBrainz artist (and an optional Wikidata summary). */
export function buildArtistDetails(stub, mbArtist, wiki, now = Date.now()) {
  const life = mbArtist?.['life-span'] || {};
  const genres = Array.isArray(mbArtist?.genres)
    ? [...mbArtist.genres].sort((a, b) => (b.count || 0) - (a.count || 0)).slice(0, 5).map((g) => g.name).filter(Boolean)
    : [];
  return {
    ...stub,
    name: mbArtist?.name || stub.name,
    sortName: mbArtist?.['sort-name'] || stub.sortName || '',
    type: mbArtist?.type || '',
    country: mbArtist?.country || '',
    area: mbArtist?.area?.name || '',
    disambiguation: mbArtist?.disambiguation || '',
    lifeBegin: life.begin || '',
    lifeEnd: life.end || '',
    genres,
    wikidataId: wiki?.wikidataId || wikidataIdFromRelations(mbArtist?.relations) || '',
    description: wiki?.description || '',
    wikipediaUrl: wiki?.wikipediaUrl || '',
    // Commons photo with its own license, author and file page (commercialOk from that license)
    photo: wiki?.photo ? { ...wiki.photo, commercialOk: isCommercialOk(wiki.photo.license) } : null,
    detailsFetchedAt: now,
    ...musicBrainzLicense('artist', stub.mbid),
    attribution: [
      wiki?.description ? 'Metadata from MusicBrainz (CC0); description from Wikidata (CC0)' : 'Metadata from MusicBrainz (CC0)',
      wiki?.photo?.attribution || ''
    ].filter(Boolean).join('. ')
  };
}

/** Case-insensitive filter over title / artist / album. */
export function filterTracks(rows, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) => `${r.title} ${r.artist} ${r.album}`.toLowerCase().includes(q));
}

export function sortTracks(rows, by = 'recent') {
  const copy = [...rows];
  if (by === 'title') copy.sort((a, b) => a.title.localeCompare(b.title));
  else if (by === 'plays') copy.sort((a, b) => (b.playCount - a.playCount) || (b.lastSeenAt - a.lastSeenAt));
  else copy.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  return copy;
}

/** Artists that at least one track still credits, with their track counts, sorted by name. */
export function artistsWithCounts(artists, tracks) {
  const counts = new Map();
  for (const t of tracks) for (const id of t.artistIds || []) counts.set(id, (counts.get(id) || 0) + 1);
  return artists
    .filter((a) => counts.has(a.id))
    .map((a) => ({ ...a, trackCount: counts.get(a.id) }))
    .sort((a, b) => (a.sortName || a.name).localeCompare(b.sortName || b.name));
}

// ---------------------------------------------------------------------------
// Storage backends (same async API). IndexedDB in the app, memory in tests / private mode.
// ---------------------------------------------------------------------------

export class MemoryBackend {
  constructor() {
    this.stores = { [TRACKS_STORE]: new Map(), [ARTISTS_STORE]: new Map() };
  }
  map(store) { return this.stores[store] || (this.stores[store] = new Map()); }
  async get(store, id) { const v = this.map(store).get(id); return v ? structuredClone(v) : null; }
  async put(store, row) { this.map(store).set(row.id, structuredClone(row)); }
  async putAll(store, rows) { for (const row of rows) this.map(store).set(row.id, structuredClone(row)); }
  async delete(store, id) { this.map(store).delete(id); }
  async all(store) { return [...this.map(store).values()].map((v) => structuredClone(v)); }
  async clear() { Object.values(this.stores).forEach((m) => m.clear()); }
}

export class IdbBackend {
  constructor(open = openAppDB) {
    this.open = open;
    this.fallback = new MemoryBackend();
  }

  async run(store, mode, fn) {
    const db = await this.open();
    if (!db) return null;
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(store, mode);
        const req = fn(tx.objectStore(store));
        let result = null;
        if (req) req.onsuccess = () => { result = req.result; };
        tx.oncomplete = () => resolve(result ?? null);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  async withFallback(store, mode, fn, memoryCall) {
    try {
      const db = await this.open();
      if (!db) return memoryCall();
      return await this.run(store, mode, fn);
    } catch {
      return memoryCall();
    }
  }

  get(store, id) { return this.withFallback(store, 'readonly', (s) => s.get(id), () => this.fallback.get(store, id)); }
  put(store, row) { return this.withFallback(store, 'readwrite', (s) => s.put(row), () => this.fallback.put(store, row)); }
  /** Many rows in one transaction (a library restore); far quicker than one put each. */
  async putAll(store, rows) {
    if (!rows.length) return;
    await this.withFallback(store, 'readwrite', (s) => { for (const row of rows) s.put(row); return null; }, () => this.fallback.putAll(store, rows));
  }
  delete(store, id) { return this.withFallback(store, 'readwrite', (s) => s.delete(id), () => this.fallback.delete(store, id)); }
  async all(store) {
    const rows = await this.withFallback(store, 'readonly', (s) => s.getAll(), () => this.fallback.all(store));
    return Array.isArray(rows) ? rows : [];
  }
}

/** Track + artist storage on top of a backend. */
export class LibraryStore {
  constructor(backend = new IdbBackend()) {
    this.backend = backend;
  }
  getTrack(id) { return this.backend.get(TRACKS_STORE, id); }
  putTrack(row) { return this.backend.put(TRACKS_STORE, row); }
  putTracks(rows) { return this.backend.putAll(TRACKS_STORE, rows); }
  deleteTrack(id) { return this.backend.delete(TRACKS_STORE, id); }
  allTracks() { return this.backend.all(TRACKS_STORE); }
  getArtist(id) { return this.backend.get(ARTISTS_STORE, id); }
  putArtist(row) { return this.backend.put(ARTISTS_STORE, row); }
  putArtists(rows) { return this.backend.putAll(ARTISTS_STORE, rows); }
  deleteArtist(id) { return this.backend.delete(ARTISTS_STORE, id); }
  allArtists() { return this.backend.all(ARTISTS_STORE); }

  /** Existing row for a track: by stable id, then MBID, ISRC, or the artist + title key. */
  async findTrack(track) {
    const direct = await this.getTrack(stableTrackId(track));
    if (direct) return direct;
    const mbid = normalizeMbid(track.mbid);
    const isrc = normalizeIsrc(track.isrc);
    const key = trackMatchKey(track.artist, track.title);
    const rows = await this.allTracks();
    // Open (Openverse) rows only match by their own id, so a copyrighted play never takes on an open license.
    return rows.find((r) => mbid && r.mbid === mbid) ||
      rows.find((r) => isrc && r.isrc === isrc) ||
      rows.find((r) => r.key === key && !r.openTrack) || null;
  }

  async songs({ query = '', sort = 'recent' } = {}) {
    return sortTracks(filterTracks(await this.allTracks(), query), sort);
  }

  async artists({ query = '' } = {}) {
    const [artists, tracks] = await Promise.all([this.allArtists(), this.allTracks()]);
    const q = String(query || '').trim().toLowerCase();
    return artistsWithCounts(artists, tracks).filter((a) => !q || a.name.toLowerCase().includes(q));
  }

  async tracksByArtist(artistId) {
    return sortTracks((await this.allTracks()).filter((t) => (t.artistIds || []).includes(artistId)), 'title');
  }
}

/**
 * Fills the library on every track change and matches rows to MusicBrainz in the background.
 * `onChange()` fires after any write; `onResolved(track, row)` fires when a playing track gets ids.
 */
export class LibraryCollector {
  constructor({
    store = new LibraryStore(),
    mb = new MusicBrainzClient(),
    wikidata = new WikidataClient(),
    listenbrainz = new ListenBrainzClient(),
    now = () => Date.now(),
    onChange = () => {},
    onResolved = () => {}
  } = {}) {
    this.store = store;
    this.mb = mb;
    this.wikidata = wikidata;
    this.listenbrainz = listenbrainz;
    this.similarPending = new Map();
    this.now = now;
    this.onChange = onChange;
    this.onResolved = onResolved;
    this.pending = new Map();
    this.artistPending = new Map();
    this.writeChain = Promise.resolve();
  }

  /** Serialize read-modify-write cycles so quick track changes can't overwrite each other. */
  exclusive(fn) {
    const run = this.writeChain.then(fn);
    this.writeChain = run.catch(() => {});
    return run;
  }

  /** Record a play. Resolves the stored row (after MusicBrainz matching when it was needed). */
  async collect(track) {
    if (!isCollectable(track)) return null;
    if (track.openTrack) return this.collectOpen(track, { played: true });
    const row = await this.exclusive(async () => {
      const now = this.now();
      const existing = await this.store.findTrack(track);
      let next;
      if (existing) {
        next = {
          ...existing,
          playCount: (existing.playCount || 0) + 1,
          lastSeenAt: now,
          sources: [...new Set([...(existing.sources || []), track.source].filter(Boolean))],
          sourceArt: existing.sourceArt || String(track.albumArt || ''),
          lrclibId: existing.lrclibId || track.lrclibId || null,
          isrc: existing.isrc || normalizeIsrc(track.isrc) || ''
        };
      } else {
        next = buildProvisionalTrackRow(track, now);
      }
      await this.store.putTrack(next);
      if (next.resolveStatus !== 'resolved') {
        for (const stub of buildArtistStubs(next, now)) {
          if (!(await this.store.getArtist(stub.id))) await this.store.putArtist(stub);
        }
      }
      return next;
    });
    this.onChange();

    const due = row.resolveStatus === 'pending' ||
      (this.now() - (row.resolvedAt || 0) > RESOLVE_RETRY_MS && row.resolveStatus !== 'resolved' && row.resolveStatus !== 'open');
    if (!due) {
      this.onResolved(track, row);
      return row;
    }
    return this.resolve(row, track);
  }

  /**
   * Store an openly licensed track (a play, or a save from Free music search when played is false).
   * Updates the license details on an existing row and never sends it to MusicBrainz.
   */
  async collectOpen(track, { played = true } = {}) {
    const row = await this.exclusive(async () => {
      const now = this.now();
      const fresh = buildOpenTrackRow(track, { now, played });
      if (!fresh) return null;
      const existing = await this.store.getTrack(fresh.id);
      const next = existing
        ? {
            ...existing,
            ...fresh,
            playCount: (existing.playCount || 0) + (played ? 1 : 0),
            firstSeenAt: existing.firstSeenAt || now,
            lastSeenAt: played ? now : (existing.lastSeenAt || now),
            sourceArt: fresh.sourceArt || existing.sourceArt || '',
            lrclibId: existing.lrclibId || fresh.lrclibId || null,
            durationSec: fresh.durationSec || existing.durationSec || 0,
            genres: fresh.genres.length ? fresh.genres : (existing.genres || [])
          }
        : fresh;
      await this.store.putTrack(next);
      const stub = buildOpenArtistStub(next, now);
      if (stub && !(await this.store.getArtist(stub.id))) await this.store.putArtist(stub);
      return next;
    });
    if (!row) return null;
    this.onChange();
    this.onResolved(track, row);
    return row;
  }

  /** Match one row to MusicBrainz (deduplicated per row). */
  resolve(row, track = row) {
    if (this.pending.has(row.id)) return this.pending.get(row.id);
    const job = (async () => {
      let recording = null;
      let status = 'not_found';
      try {
        recording = await this.mb.resolveRecording({
          title: track.title || row.title,
          artist: track.artist || row.artist,
          duration: track.duration || row.durationSec,
          durationEstimated: track.durationEstimated,
          isrc: normalizeIsrc(track.isrc) || row.isrc,
          mbid: normalizeMbid(track.mbid) || row.mbid
        });
        if (recording) status = 'resolved';
      } catch {
        status = 'error';
      }

      const saved = await this.exclusive(async () => {
        const current = (await this.store.getTrack(row.id)) || row;
        const now = this.now();
        if (!recording) {
          const failed = { ...current, resolveStatus: status, resolvedAt: now };
          await this.store.putTrack(failed);
          return failed;
        }
        let resolved = buildResolvedTrackRow(current, recording, now);
        // The same recording may already be in the library (heard through another app): merge plays.
        const twin = resolved.id !== current.id ? await this.store.getTrack(resolved.id) : null;
        if (twin) {
          resolved = {
            ...resolved,
            playCount: (twin.playCount || 0) + (current.playCount || 0),
            firstSeenAt: Math.min(twin.firstSeenAt || now, current.firstSeenAt || now),
            sources: [...new Set([...(twin.sources || []), ...(current.sources || [])])]
          };
        }
        await this.store.putTrack(resolved);
        if (resolved.id !== current.id) await this.store.deleteTrack(current.id);
        for (const stub of buildArtistStubs(resolved, now)) {
          if (!(await this.store.getArtist(stub.id))) await this.store.putArtist(stub);
        }
        // Drop placeholder artists ("key:" ids) that no song credits any more.
        const dropped = (current.artistIds || []).filter((id) => id.startsWith('key:') && !resolved.artistIds.includes(id));
        if (dropped.length) {
          const tracks = await this.store.allTracks();
          for (const id of dropped) {
            if (!tracks.some((t) => (t.artistIds || []).includes(id))) await this.store.deleteArtist(id);
          }
        }
        return resolved;
      });
      this.onChange();
      this.onResolved(track, saved);
      return saved;
    })().finally(() => this.pending.delete(row.id));
    this.pending.set(row.id, job);
    return job;
  }

  /**
   * Artist row with `similar` (ListenBrainz, CC0) filled in when missing or stale. A failed lookup
   * keeps the row as it is so the next visit tries again.
   */
  async refreshSimilar(artistId, { force = false } = {}) {
    const artist = await this.store.getArtist(artistId);
    if (!artist || !artist.mbid || !this.listenbrainz) return artist;
    if (!force && artist.similarFetchedAt && this.now() - artist.similarFetchedAt < SIMILAR_REFRESH_MS) return artist;
    if (this.similarPending.has(artistId)) return this.similarPending.get(artistId);
    const job = (async () => {
      let similar;
      try {
        similar = await this.listenbrainz.getSimilarArtists(artist.mbid);
      } catch {
        return artist;
      }
      return this.exclusive(async () => {
        const current = (await this.store.getArtist(artistId)) || artist;
        const row = { ...current, similar, similarFetchedAt: this.now() };
        await this.store.putArtist(row);
        return row;
      });
    })().finally(() => this.similarPending.delete(artistId));
    this.similarPending.set(artistId, job);
    return job;
  }

  /** Artist row with MusicBrainz + Wikidata details, fetched when missing or stale. */
  async refreshArtist(artistId, { force = false } = {}) {
    const stub = await this.store.getArtist(artistId);
    if (!stub || !stub.mbid) return stub;
    if (!force && stub.detailsFetchedAt && this.now() - stub.detailsFetchedAt < ARTIST_REFRESH_MS) return stub;
    if (this.artistPending.has(artistId)) return this.artistPending.get(artistId);
    const job = (async () => {
      const mbArtist = await this.mb.getArtist(stub.mbid);
      if (!mbArtist) return stub;
      let wiki = null;
      const qid = wikidataIdFromRelations(mbArtist.relations);
      if (qid) {
        try { wiki = await this.wikidata.getSummary(qid); } catch { wiki = null; }
        // Photo from Wikimedia Commons (Wikidata P18), kept only with a license we can credit
        if (typeof this.wikidata.getPhoto === 'function') {
          let photo = null;
          try { photo = await this.wikidata.getPhoto(qid); } catch { photo = null; }
          if (photo) wiki = { ...(wiki || { wikidataId: qid }), photo };
        }
      }
      const row = buildArtistDetails(stub, mbArtist, wiki, this.now());
      await this.store.putArtist(row);
      this.onChange();
      return row;
    })().finally(() => this.artistPending.delete(artistId));
    this.artistPending.set(artistId, job);
    return job;
  }
}
