/**
 * LyricWave shared IndexedDB (LyricWaveDB)
 *
 * One place opens the database so every module agrees on the version and the stores.
 *   v1: lyrics   (lyrics.js cache, keyPath 'key')
 *   v2: tracks   (library.js songs, keyPath 'id' = stable track id)
 *       artists  (library.js artists, keyPath 'id' = stable artist id)
 *   v3: userLyrics (user-lyrics.js, lyrics people added themselves, keyPath 'id' = userLyricsId)
 *   v4: playlists  (playlists.js, Free music playlists, keyPath 'id' = 'pl:<random>')
 * "Clear All Data" in app.js deletes the whole database.
 */

export const DB_NAME = 'LyricWaveDB';
export const DB_VERSION = 4;
export const LYRICS_STORE = 'lyrics';
export const TRACKS_STORE = 'tracks';
export const ARTISTS_STORE = 'artists';
export const USER_LYRICS_STORE = 'userLyrics';
export const PLAYLISTS_STORE = 'playlists';

/** Create any store or index that is missing. Safe to run on every upgrade. */
export function upgradeAppDB(db, tx) {
  if (!db.objectStoreNames.contains(LYRICS_STORE)) {
    db.createObjectStore(LYRICS_STORE, { keyPath: 'key' });
  }
  const tracks = db.objectStoreNames.contains(TRACKS_STORE)
    ? tx.objectStore(TRACKS_STORE)
    : db.createObjectStore(TRACKS_STORE, { keyPath: 'id' });
  for (const [name, path] of [['key', 'key'], ['mbid', 'mbid'], ['isrc', 'isrc'], ['lastSeenAt', 'lastSeenAt']]) {
    if (!tracks.indexNames.contains(name)) tracks.createIndex(name, path, { unique: false });
  }
  if (!tracks.indexNames.contains('artistIds')) {
    tracks.createIndex('artistIds', 'artistIds', { unique: false, multiEntry: true });
  }
  const artists = db.objectStoreNames.contains(ARTISTS_STORE)
    ? tx.objectStore(ARTISTS_STORE)
    : db.createObjectStore(ARTISTS_STORE, { keyPath: 'id' });
  if (!artists.indexNames.contains('mbid')) artists.createIndex('mbid', 'mbid', { unique: false });
  if (!db.objectStoreNames.contains(USER_LYRICS_STORE)) {
    db.createObjectStore(USER_LYRICS_STORE, { keyPath: 'id' });
  }
  if (!db.objectStoreNames.contains(PLAYLISTS_STORE)) {
    db.createObjectStore(PLAYLISTS_STORE, { keyPath: 'id' });
  }
}

let dbPromise = null;

/** Open (and upgrade) LyricWaveDB. Resolves null when IndexedDB is unavailable or blocked. */
export function openAppDB() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (e) => upgradeAppDB(e.target.result, e.target.transaction);
      request.onsuccess = () => {
        const db = request.result;
        // Let "Clear All Data" (deleteDatabase) or a newer tab's upgrade proceed instead of being blocked.
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      // onblocked: an older tab still holds v1; its onversionchange closes it, then onsuccess fires.
      request.onerror = () => { dbPromise = null; resolve(null); };
    } catch {
      dbPromise = null;
      resolve(null);
    }
  });
  return dbPromise;
}
