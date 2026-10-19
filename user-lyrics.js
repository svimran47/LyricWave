/**
 * LyricWave "Your lyrics": lyrics people add themselves, with the rights they hold.
 *
 * Lyrics are a separate copyright from the recording, and LRCLIB's community lyrics don't come
 * with a license. So LyricWave lets people paste lyrics they have the right to use (their own
 * songs, public domain songs, Creative Commons lyrics, or a personal copy) and records those
 * rights with the text. Saved lyrics stay on the device (LyricWaveDB `userLyrics`, see db.js) and
 * are used before LRCLIB for that song (see setUserLyricsProvider in lyrics.js).
 *
 * Rights decide what a lyrics card may quote: writer, public domain and CC lyrics may fill a card,
 * a personal copy keeps the short-quote limit, like LRCLIB lyrics.
 *
 *  - Pure helpers (ids, rights, row building, lyricsData) run in Node for tests.
 *  - UserLyricsStore works on any backend from library.js (IndexedDB, or memory in tests).
 *  - UserLyricsDialog drives the #userLyricsBackdrop dialog in index.html.
 */

import { USER_LYRICS_STORE } from './db.js';
import { IdbBackend } from './library.js';
import { parseLRC } from './lyrics.js';
import { trackMatchKey, normalizeOpenverseId, openLicenseAllowsFullLyrics } from './types.js';

export const MAX_USER_LYRICS_CHARS = 20000;

/**
 * The rights someone can declare for lyrics they add. `song` is only offered for openly licensed
 * songs (Free music): the lyrics are part of the song and share its license.
 */
export const LYRICS_RIGHTS = {
  personal: {
    label: 'Personal copy',
    desc: 'Just for me. Cards keep the short quote.',
    license: 'personal',
    licenseUrl: '',
    allowsFull: false
  },
  own: {
    label: 'I wrote them',
    desc: 'My own song. Cards can quote more.',
    license: 'writer',
    licenseUrl: '',
    allowsFull: true
  },
  'public-domain': {
    label: 'Public domain',
    desc: 'Traditional or out of copyright.',
    license: 'PDM',
    licenseUrl: 'https://creativecommons.org/publicdomain/mark/1.0/',
    allowsFull: true
  },
  'cc-by-4.0': {
    label: 'CC BY 4.0',
    desc: 'Shared under Creative Commons BY.',
    license: 'CC-BY-4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    allowsFull: true
  },
  'cc-by-sa-4.0': {
    label: 'CC BY-SA 4.0',
    desc: 'Shared under Creative Commons BY-SA.',
    license: 'CC-BY-SA-4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    allowsFull: true
  },
  song: {
    label: 'Song’s license',
    desc: 'Part of this openly licensed song.',
    license: 'song',
    licenseUrl: '',
    allowsFull: true,
    openOnly: true
  }
};

export const DEFAULT_LYRICS_RIGHTS = 'personal';

/** Rights choices for a track, in display order (`song` only for open tracks). */
export function rightsChoicesFor(track) {
  return Object.entries(LYRICS_RIGHTS)
    .filter(([, r]) => !r.openOnly || Boolean(track?.openTrack?.license))
    .map(([key, r]) => ({ key, ...r }));
}

/**
 * Id that finds the same song's lyrics again: the Openverse id for open tracks, otherwise the
 * artist + title key (it stays the same when MusicBrainz later gives the song an MBID).
 */
export function userLyricsId(track) {
  const ov = normalizeOpenverseId(track?.openTrack?.openverseId);
  if (ov) return `ov:${ov}`;
  if (!track?.title) return '';
  return `key:${trackMatchKey(track.artist || track.artists, track.title)}`;
}

const cleanCredit = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);

/** Normalize pasted lyrics: unify line breaks, trim each line's end, drop leading/trailing blank lines. */
export function cleanLyricsText(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/^\n+|\n+$/g, '')
    .slice(0, MAX_USER_LYRICS_CHARS);
}

/** 'synced' when the text is LRC with at least two timed lines, else 'plain'. */
export function detectLyricsType(text) {
  return parseLRC(String(text || '')).filter((l) => l.text).length >= 2 ? 'synced' : 'plain';
}

/**
 * Row to store, or throws Error with a message for people when it can't be saved.
 * @param {object} p
 * @param {object} p.track the song (engine.track)
 * @param {string} p.text pasted lyrics
 * @param {string} p.rights key of LYRICS_RIGHTS
 * @param {string} [p.credit] lyricist / source, shown with the lyrics
 */
export function buildUserLyricsRow({ track, text, rights, credit = '', now = Date.now(), existing = null }) {
  const id = userLyricsId(track);
  if (!id) throw new Error('Play a song first, then add its lyrics.');
  const clean = cleanLyricsText(text);
  if (!clean.trim()) throw new Error('Paste or type the lyrics first.');
  const choice = LYRICS_RIGHTS[rights];
  if (!choice || (choice.openOnly && !track?.openTrack?.license)) throw new Error('Choose what rights you have to these lyrics.');
  return {
    id,
    title: String(track.title || ''),
    artist: String(track.artist || track.artists || ''),
    text: clean,
    type: detectLyricsType(clean),
    rights,
    credit: cleanCredit(credit),
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
}

/**
 * What a stored row's rights mean for a given track: label, license, whether cards may quote more,
 * and the credit line shown under the lyrics.
 */
export function userLyricsRights(row, track) {
  const choice = LYRICS_RIGHTS[row?.rights] || LYRICS_RIGHTS[DEFAULT_LYRICS_RIGHTS];
  let { license, licenseUrl, allowsFull, label } = choice;
  if (row?.rights === 'song') {
    const ot = track?.openTrack;
    license = ot?.license || 'unknown';
    licenseUrl = ot?.licenseUrl || '';
    label = ot?.licenseLabel || license;
    allowsFull = openLicenseAllowsFullLyrics(license);
  }
  const who = row?.credit ? ` by ${row.credit}` : '';
  let credit;
  if (row?.rights === 'own') credit = `Lyrics added by their writer${who}`;
  else if (row?.rights === 'personal') credit = `Your lyrics${who}, personal copy`;
  else credit = `Lyrics${who}, ${label}`;
  return { source: 'user', rights: row?.rights || DEFAULT_LYRICS_RIGHTS, license, licenseUrl, label, allowsFull, credit };
}

/** lyricsData (the shape fetchLyrics returns) for a stored row. */
export function userLyricsToLyricsData(row, track) {
  const rights = userLyricsRights(row, track);
  if (row.type === 'synced') {
    const syncedLines = parseLRC(row.text);
    if (syncedLines.length) {
      return {
        status: 'synced',
        type: 'synced',
        syncedLines,
        // Plain text without the timestamps, for anything that shows the whole text
        plainLyrics: syncedLines.map((l) => l.text).filter(Boolean).join('\n'),
        rights,
        userLyrics: true
      };
    }
  }
  return { status: 'plain', type: 'plain', syncedLines: [], plainLyrics: row.text, rights, userLyrics: true, message: 'Your lyrics' };
}

export class UserLyricsStore {
  constructor(backend = new IdbBackend()) {
    this.backend = backend;
  }
  get(id) { return id ? this.backend.get(USER_LYRICS_STORE, id) : Promise.resolve(null); }
  put(row) { return this.backend.put(USER_LYRICS_STORE, row); }
  delete(id) { return this.backend.delete(USER_LYRICS_STORE, id); }
  async all() { return this.backend.all(USER_LYRICS_STORE); }
  forTrack(track) { return this.get(userLyricsId(track)); }

  /** Provider for setUserLyricsProvider(): lyricsData for the track, or null to fall back to LRCLIB. */
  async lyricsFor(track) {
    const row = await this.forTrack(track);
    return row ? userLyricsToLyricsData(row, track) : null;
  }
}

// ---------------------------------------------------------------------------
// Dialog controller
// ---------------------------------------------------------------------------

export class UserLyricsDialog {
  /**
   * @param {object} deps
   * @param {HTMLElement} deps.backdrop #userLyricsBackdrop
   * @param {UserLyricsStore} deps.store
   * @param {(msg: string, type?: string) => void} deps.notify
   * @param {(track: object) => void} deps.onSaved called after a save or delete (reload lyrics)
   * @param {() => void} [deps.onClose]
   */
  constructor({ backdrop, store, notify, onSaved, onClose }) {
    this.backdrop = backdrop;
    this.store = store;
    this.notify = notify || (() => {});
    this.onSaved = onSaved || (() => {});
    this.onClose = onClose || (() => {});
    const q = (id) => document.getElementById(id);
    this.subtitleEl = q('userLyricsSubtitle');
    this.textEl = q('userLyricsText');
    this.typeEl = q('userLyricsType');
    this.rightsEl = q('userLyricsRights');
    this.creditEl = q('userLyricsCredit');
    this.errorEl = q('userLyricsError');
    this.btnSave = q('btnUserLyricsSave');
    this.btnDelete = q('btnUserLyricsDelete');
    this.btnCancel = q('btnUserLyricsCancel');
    this.btnClose = q('btnCloseUserLyrics');
    this.track = null;
    this.existing = null;
    this.rights = DEFAULT_LYRICS_RIGHTS;
    this._busy = false;

    this.btnSave?.addEventListener('click', () => this.save());
    this.btnDelete?.addEventListener('click', () => this.remove());
    this.btnCancel?.addEventListener('click', () => this.close());
    this.btnClose?.addEventListener('click', () => this.close());
    this.backdrop?.addEventListener('click', (e) => { if (e.target === this.backdrop) this.close(); });
    this.textEl?.addEventListener('input', () => this._syncType());
    this.rightsEl?.addEventListener('click', (e) => {
      const btn = e.target instanceof Element ? e.target.closest('[data-value]') : null;
      if (btn) this._pickRights(btn.dataset.value);
    });
    // radiogroup arrow-key navigation (same as the card maker's pickers)
    this.rightsEl?.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
      const items = [...this.rightsEl.children];
      const idx = items.indexOf(document.activeElement);
      if (idx < 0) return;
      e.preventDefault();
      const step = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
      const next = items[(idx + step + items.length) % items.length];
      next.focus();
      this._pickRights(next.dataset.value);
    });
  }

  get isOpen() {
    return Boolean(this.backdrop && !this.backdrop.classList.contains('hidden'));
  }

  /** Opens the editor for a song, filled with its saved lyrics if there are any. */
  async open(track) {
    if (!track?.title) {
      this.notify('Play a song first, then add its lyrics.', 'warning');
      return false;
    }
    this.track = track;
    let existing = null;
    try { existing = await this.store.forTrack(track); } catch { existing = null; }
    this.existing = existing;
    this.rights = existing?.rights && LYRICS_RIGHTS[existing.rights] ? existing.rights : (track.openTrack?.license ? 'song' : DEFAULT_LYRICS_RIGHTS);
    if (this.subtitleEl) this.subtitleEl.textContent = [track.title, track.artist].filter(Boolean).join(' · ');
    if (this.textEl) this.textEl.value = existing?.text || '';
    if (this.creditEl) this.creditEl.value = existing?.credit || '';
    this._setError('');
    this._buildRights();
    this._syncType();
    this.btnDelete?.classList.toggle('hidden', !existing);
    this.backdrop.classList.remove('hidden');
    this.backdrop.setAttribute('aria-hidden', 'false');
    this.textEl?.focus({ preventScroll: true });
    return true;
  }

  close() {
    if (!this.isOpen) return;
    this.backdrop.classList.add('hidden');
    this.backdrop.setAttribute('aria-hidden', 'true');
    this.onClose();
  }

  async save() {
    if (this._busy) return;
    let row;
    try {
      row = buildUserLyricsRow({
        track: this.track,
        text: this.textEl?.value,
        rights: this.rights,
        credit: this.creditEl?.value,
        existing: this.existing
      });
    } catch (err) {
      this._setError(err.message);
      return;
    }
    this._busy = true;
    try {
      await this.store.put(row);
      this.notify(row.type === 'synced' ? 'Your synced lyrics are saved on this device.' : 'Your lyrics are saved on this device.', 'info');
      const track = this.track;
      this.close();
      this.onSaved(track);
    } catch (err) {
      console.warn('[UserLyrics] save failed', err);
      this._setError('Couldn’t save the lyrics on this device.');
    } finally {
      this._busy = false;
    }
  }

  async remove() {
    if (this._busy || !this.existing) return;
    this._busy = true;
    try {
      await this.store.delete(this.existing.id);
      this.notify('Your lyrics were removed. LyricWave will look them up on LRCLIB again.', 'info');
      const track = this.track;
      this.close();
      this.onSaved(track);
    } catch (err) {
      console.warn('[UserLyrics] delete failed', err);
      this._setError('Couldn’t remove the lyrics on this device.');
    } finally {
      this._busy = false;
    }
  }

  _setError(msg) {
    if (!this.errorEl) return;
    this.errorEl.textContent = msg;
    this.errorEl.classList.toggle('hidden', !msg);
  }

  _syncType() {
    if (!this.typeEl) return;
    const text = this.textEl?.value || '';
    if (!text.trim()) {
      this.typeEl.textContent = 'Paste plain lyrics, or LRC lines like [01:23.45] for synced lyrics.';
      return;
    }
    const synced = detectLyricsType(text) === 'synced';
    this.typeEl.textContent = synced
      ? `Synced lyrics: ${parseLRC(text).filter((l) => l.text).length} timed lines.`
      : 'Plain lyrics (no timestamps found).';
  }

  _pickRights(value) {
    if (!LYRICS_RIGHTS[value]) return;
    this.rights = value;
    this._syncRights();
  }

  _buildRights() {
    if (!this.rightsEl) return;
    this.rightsEl.replaceChildren(...rightsChoicesFor(this.track).map((choice) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'anim-style-btn';
      btn.setAttribute('role', 'radio');
      btn.dataset.value = choice.key;
      const name = document.createElement('span');
      name.className = 'anim-style-name';
      name.textContent = choice.label;
      const desc = document.createElement('span');
      desc.className = 'anim-style-desc';
      desc.textContent = choice.key === 'song' && this.track?.openTrack?.licenseLabel
        ? `${this.track.openTrack.licenseLabel}, part of this open song.`
        : choice.desc;
      btn.append(name, desc);
      return btn;
    }));
    this._syncRights();
  }

  _syncRights() {
    if (!this.rightsEl) return;
    for (const btn of this.rightsEl.children) {
      const on = btn.dataset.value === this.rights;
      btn.setAttribute('aria-checked', on ? 'true' : 'false');
      btn.classList.toggle('active', on);
      btn.tabIndex = on ? 0 : -1;
    }
  }
}
