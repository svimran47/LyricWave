/**
 * LyricWave playlists: named lists of Free music songs, played through the queue (queue.js).
 *
 * Playlists hold Library row ids (`ov:<Openverse id>`), so every song keeps its license, credit and
 * source page in one place (library.js). Adding a song from Free music search saves it to the
 * library first. Playlists stay on the device (LyricWaveDB `playlists`, see db.js).
 *
 *  - Pure helpers (create, rename, add, remove, move, resolve, credits) run in Node for tests.
 *  - PlaylistStore works on any backend from library.js (IndexedDB, or memory in tests).
 *  - PlaylistsView renders Discover > Library > Playlists; PlaylistPicker drives the
 *    #playlistPickerBackdrop "Add to playlist" dialog in index.html.
 */

import { PLAYLISTS_STORE } from './db.js';
import { IdbBackend } from './library.js';
import { normalizeOpenverseId } from './types.js';

export const MAX_PLAYLIST_NAME = 60;
export const MAX_PLAYLIST_TRACKS = 500;
export const MAX_PLAYLISTS = 200;

/** Collapse whitespace and cap the length; throws when nothing is left. */
export function cleanPlaylistName(name) {
  const clean = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_PLAYLIST_NAME);
  if (!clean) throw new Error('Give the playlist a name.');
  return clean;
}

export function newPlaylistId(random = Math.random, now = Date.now()) {
  return `pl:${now.toString(36)}${Math.floor(random() * 36 ** 6).toString(36).padStart(6, '0')}`;
}

export function createPlaylist(name, { now = Date.now(), id = newPlaylistId(Math.random, now) } = {}) {
  return { id, name: cleanPlaylistName(name), trackIds: [], createdAt: now, updatedAt: now };
}

export function renamePlaylist(playlist, name, now = Date.now()) {
  return { ...playlist, name: cleanPlaylistName(name), updatedAt: now };
}

/** Only playable Free music rows can go in a playlist. */
export function isPlaylistTrackId(id) {
  const m = String(id || '').match(/^ov:(.+)$/);
  return Boolean(m && normalizeOpenverseId(m[1]));
}

/** Library row id for a Free music result or row (`ov:<id>`), or ''. */
export function playlistTrackIdFor(item) {
  const id = normalizeOpenverseId(item?.openTrack?.openverseId);
  return id ? `ov:${id}` : '';
}

/**
 * @returns {{playlist: object, added: boolean, reason?: string}} reason: 'duplicate' | 'full' | 'invalid'
 */
export function addToPlaylist(playlist, trackId, now = Date.now()) {
  if (!isPlaylistTrackId(trackId)) return { playlist, added: false, reason: 'invalid' };
  if (playlist.trackIds.includes(trackId)) return { playlist, added: false, reason: 'duplicate' };
  if (playlist.trackIds.length >= MAX_PLAYLIST_TRACKS) return { playlist, added: false, reason: 'full' };
  return { playlist: { ...playlist, trackIds: [...playlist.trackIds, trackId], updatedAt: now }, added: true };
}

export function removeFromPlaylist(playlist, index, now = Date.now()) {
  if (!Number.isInteger(index) || index < 0 || index >= playlist.trackIds.length) return playlist;
  const trackIds = playlist.trackIds.filter((_, i) => i !== index);
  return { ...playlist, trackIds, updatedAt: now };
}

/** Move the song at `from` to `to` (clamped). */
export function moveInPlaylist(playlist, from, to, now = Date.now()) {
  const n = playlist.trackIds.length;
  if (!Number.isInteger(from) || from < 0 || from >= n) return playlist;
  const target = Math.max(0, Math.min(n - 1, Number(to) | 0));
  if (target === from) return playlist;
  const trackIds = [...playlist.trackIds];
  const [id] = trackIds.splice(from, 1);
  trackIds.splice(target, 0, id);
  return { ...playlist, trackIds, updatedAt: now };
}

/**
 * Playlist entries with their library rows, in playlist order. Songs removed from the library
 * show as missing ({ index, id, row: null }) so they can still be taken out of the playlist.
 */
export function resolvePlaylist(playlist, rows) {
  const byId = new Map((rows || []).map((r) => [r.id, r]));
  return (playlist?.trackIds || []).map((id, index) => ({ index, id, row: byId.get(id) || null }));
}

/** "3 songs · 9 min" */
export function playlistSummary(entries) {
  const rows = entries.filter((e) => e.row);
  const totalSec = rows.reduce((n, e) => n + (Number(e.row.durationSec) || 0), 0);
  const songs = `${rows.length} ${rows.length === 1 ? 'song' : 'songs'}`;
  return totalSec >= 60 ? `${songs} · ${Math.round(totalSec / 60)} min` : songs;
}

/** One credit line per song (license and creator), for the playlist page and sharing. */
export function playlistCredits(entries) {
  return entries.filter((e) => e.row).map((e) => e.row.attribution || `“${e.row.title}” by ${e.row.artist}`);
}

export class PlaylistStore {
  constructor(backend = new IdbBackend()) {
    this.backend = backend;
  }
  get(id) { return this.backend.get(PLAYLISTS_STORE, id); }
  put(playlist) { return this.backend.put(PLAYLISTS_STORE, playlist); }
  delete(id) { return this.backend.delete(PLAYLISTS_STORE, id); }
  /** Most recently changed first. */
  async all() {
    const rows = await this.backend.all(PLAYLISTS_STORE);
    return rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  async create(name, now = Date.now()) {
    if ((await this.backend.all(PLAYLISTS_STORE)).length >= MAX_PLAYLISTS) throw new Error('You have the most playlists LyricWave keeps. Delete one first.');
    const playlist = createPlaylist(name, { now });
    await this.put(playlist);
    return playlist;
  }

  /** Apply a pure change (e.g. p => removeFromPlaylist(p, 2)) to a stored playlist. */
  async update(id, change) {
    const current = await this.get(id);
    if (!current) return null;
    const next = change(current);
    if (next !== current) await this.put(next);
    return next;
  }
}

// ---------------------------------------------------------------------------
// Views (DOM only at runtime)
// ---------------------------------------------------------------------------

export class PlaylistsView {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.container
   * @param {PlaylistStore} opts.store
   * @param {import('./library.js').LibraryCollector} opts.collector library rows live in collector.store
   * @param {object} opts.helpers { escapeHtml, icon, mediaThumbHtml, wireMediaThumbs }
   * @param {(row: object, queue: {items: object[], index: number, label: string}) => void} opts.onPlay
   * @param {(msg: string, type?: string) => void} [opts.notify]
   */
  constructor({ container, store, collector, helpers, onPlay, notify = () => {} }) {
    this.container = container;
    this.store = store;
    this.collector = collector;
    this.h = helpers;
    this.onPlay = onPlay;
    this.notify = notify;
    this.openId = null;
    this.query = '';
    this.confirmDelete = false;
    this.token = 0;
  }

  async render() {
    if (!this.container) return;
    const token = ++this.token;
    try {
      const [playlists, rows] = await Promise.all([this.store.all(), this.collector.store.allTracks()]);
      if (token !== this.token) return;
      const open = this.openId ? playlists.find((p) => p.id === this.openId) : null;
      if (open) this.renderPlaylist(open, rows);
      else {
        this.openId = null;
        this.renderList(playlists, rows);
      }
    } catch (err) {
      console.warn('Playlists render failed:', err);
      this.container.innerHTML = '<div class="charts-empty-state" role="alert"><p>Your playlists could not be opened on this device.</p></div>';
    }
  }

  renderList(playlists, rows) {
    const { escapeHtml, icon } = this.h;
    const q = this.query.trim().toLowerCase();
    const shown = q ? playlists.filter((p) => p.name.toLowerCase().includes(q)) : playlists;
    this.container.innerHTML = `
      <form class="playlist-new" novalidate>
        <label class="sr-only" for="playlistNewName">New playlist name</label>
        <input id="playlistNewName" class="search-input playlist-new-name" type="text" maxlength="${MAX_PLAYLIST_NAME}" placeholder="New playlist name" autocomplete="off" enterkeyhint="done">
        <button type="submit" class="btn btn-sm">${icon('plus', 'sm')}<span>Create</span></button>
      </form>
      ${shown.length ? '' : `<div class="charts-empty-state library-empty"><p>${playlists.length
        ? `No playlists match “${escapeHtml(this.query.trim())}”.`
        : '<strong>No playlists yet.</strong></p><p>Create one above, then add songs from Free music with the add-to-playlist button.'}</p></div>`}
      <div class="library-list" role="list"></div>`;
    const list = this.container.querySelector('.library-list');
    for (const p of shown) {
      const entries = resolvePlaylist(p, rows);
      const card = document.createElement('div');
      card.className = 'chart-song-card library-song-card playlist-card';
      card.setAttribute('role', 'listitem');
      card.innerHTML = `
        <div class="media-thumb media-thumb--chart is-error playlist-thumb" aria-hidden="true"><span class="media-thumb-fallback">${icon('list-plus')}</span></div>
        <div class="chart-song-meta">
          <div class="chart-song-title">${escapeHtml(p.name)}</div>
          <div class="chart-song-artist">${escapeHtml(playlistSummary(entries))}</div>
        </div>
        <div class="chart-song-action">
          <button class="btn-chart-play btn-chart-play--icon playlist-play" type="button" aria-label="${escapeHtml(`Play playlist ${p.name}`)}" ${entries.some((e) => e.row) ? '' : 'disabled'}>
            ${icon('play', 'sm')}<span class="btn-label">Play</span>
          </button>
        </div>`;
      // The whole card opens the playlist (keyboard too); its Play button plays it
      card.tabIndex = 0;
      card.setAttribute('aria-label', `${p.name}, ${playlistSummary(entries)}. Open playlist`);
      card.addEventListener('click', () => this.open(p.id));
      card.addEventListener('keydown', (e) => {
        if (e.target !== card || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        this.open(p.id);
      });
      card.querySelector('.playlist-play')?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.play(p, rows, 0);
      });
      list.appendChild(card);
    }
    const form = this.container.querySelector('.playlist-new');
    form?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = form.querySelector('input');
      try {
        const created = await this.store.create(input.value);
        this.notify(`Created “${created.name}”.`, 'info');
        this.open(created.id);
      } catch (err) {
        this.notify(err.message, 'warning');
        input.focus();
      }
    });
  }

  play(playlist, rows, index) {
    const entries = resolvePlaylist(playlist, rows);
    const items = entries.filter((e) => e.row?.openTrack).map((e) => e.row);
    if (!items.length) {
      this.notify('This playlist has no songs to play yet.', 'info');
      return;
    }
    const startRow = entries[index]?.row;
    const start = Math.max(0, items.indexOf(startRow));
    this.onPlay(items[start], { items, index: start, label: `Playlist: ${playlist.name}` });
  }

  async open(id) {
    this.openId = id;
    this.confirmDelete = false;
    await this.render();
    this.container.querySelector('.library-back')?.focus();
  }

  renderPlaylist(playlist, rows) {
    const { escapeHtml, icon, mediaThumbHtml, wireMediaThumbs } = this.h;
    const entries = resolvePlaylist(playlist, rows);
    const credits = playlistCredits(entries);
    this.container.innerHTML = `
      <article class="playlist-detail" aria-labelledby="playlistName">
        <button type="button" class="btn btn-sm btn-ghost library-back">${icon('chevron-right', 'sm')}<span>All playlists</span></button>
        <header class="playlist-head">
          <h3 id="playlistName" class="library-artist-name">${escapeHtml(playlist.name)}</h3>
          <p class="library-artist-facts">${escapeHtml(playlistSummary(entries))}</p>
        </header>
        <div class="playlist-actions">
          <button type="button" class="btn btn-sm btn-primary playlist-play-all" ${entries.some((e) => e.row) ? '' : 'disabled'}>${icon('play', 'sm')}<span>Play</span></button>
          <button type="button" class="btn btn-sm btn-ghost playlist-rename">${icon('file-text', 'sm')}<span>Rename</span></button>
          <button type="button" class="btn btn-sm btn-ghost playlist-delete">${icon('trash', 'sm')}<span>${this.confirmDelete ? 'Tap again to delete' : 'Delete'}</span></button>
        </div>
        <form class="playlist-rename-form hidden" novalidate>
          <label class="sr-only" for="playlistRenameInput">Playlist name</label>
          <input id="playlistRenameInput" class="search-input" type="text" maxlength="${MAX_PLAYLIST_NAME}" value="${escapeHtml(playlist.name)}" autocomplete="off" enterkeyhint="done">
          <button type="submit" class="btn btn-sm">Save</button>
        </form>
        ${entries.length ? '' : '<div class="charts-empty-state"><p>No songs yet. Add songs from Free music with the add-to-playlist button.</p></div>'}
        <ol class="library-list playlist-tracks"></ol>
        ${credits.length ? `<details class="playlist-credits"><summary>Credits (${credits.length})</summary><ul>${credits.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul></details>` : ''}
      </article>`;
    const list = this.container.querySelector('.playlist-tracks');
    entries.forEach((entry, i) => {
      const li = document.createElement('li');
      li.className = 'chart-song-card library-song-card playlist-track';
      const row = entry.row;
      const title = row ? row.title : 'Song no longer in your library';
      li.innerHTML = `
        ${mediaThumbHtml(row?.sourceArt || '', 'chart', icon('music'), 48, 48)}
        <div class="chart-song-meta">
          <div class="chart-song-title">${escapeHtml(title)}</div>
          <div class="chart-song-artist">${escapeHtml(row ? `${row.artist} · ${row.openTrack?.licenseLabel || row.license}` : 'Remove it, or find it again in Free music')}</div>
        </div>
        <div class="chart-song-action playlist-track-actions">
          <button type="button" class="btn-chart-play btn-chart-play--icon playlist-up" aria-label="${escapeHtml(`Move ${title} up`)}" ${i === 0 ? 'disabled' : ''}>${icon('arrow-up', 'sm')}</button>
          <button type="button" class="btn-chart-play btn-chart-play--icon playlist-down" aria-label="${escapeHtml(`Move ${title} down`)}" ${i === entries.length - 1 ? 'disabled' : ''}>${icon('arrow-down', 'sm')}</button>
          <button type="button" class="btn-chart-play btn-chart-play--icon playlist-remove" aria-label="${escapeHtml(`Remove ${title} from the playlist`)}">${icon('close', 'sm')}</button>
          ${row ? `<button type="button" class="btn-chart-play btn-chart-play--icon playlist-track-play" aria-label="${escapeHtml(`Play ${title}`)}">${icon('play', 'sm')}</button>` : ''}
        </div>`;
      wireMediaThumbs(li);
      const change = async (fn, focusSel) => {
        await this.store.update(playlist.id, fn);
        await this.render();
        const target = this.container.querySelectorAll('.playlist-track')[focusSel.index]?.querySelector(focusSel.sel);
        (target && !target.disabled ? target : this.container.querySelector('.playlist-play-all'))?.focus();
      };
      li.querySelector('.playlist-up')?.addEventListener('click', () => change((p) => moveInPlaylist(p, i, i - 1), { index: i - 1, sel: '.playlist-up' }));
      li.querySelector('.playlist-down')?.addEventListener('click', () => change((p) => moveInPlaylist(p, i, i + 1), { index: i + 1, sel: '.playlist-down' }));
      li.querySelector('.playlist-remove')?.addEventListener('click', () => change((p) => removeFromPlaylist(p, i), { index: Math.min(i, entries.length - 2), sel: '.playlist-remove' }));
      li.querySelector('.playlist-track-play')?.addEventListener('click', () => this.play(playlist, rows, i));
      list.appendChild(li);
    });

    this.container.querySelector('.library-back')?.addEventListener('click', async () => {
      this.openId = null;
      await this.render();
      this.container.querySelector('.playlist-card')?.focus?.();
    });
    this.container.querySelector('.playlist-play-all')?.addEventListener('click', () => this.play(playlist, rows, 0));
    const renameForm = this.container.querySelector('.playlist-rename-form');
    this.container.querySelector('.playlist-rename')?.addEventListener('click', () => {
      renameForm?.classList.toggle('hidden');
      renameForm?.querySelector('input')?.focus();
    });
    renameForm?.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const name = cleanPlaylistName(renameForm.querySelector('input').value);
        await this.store.update(playlist.id, (p) => renamePlaylist(p, name));
        await this.render();
      } catch (err) {
        this.notify(err.message, 'warning');
      }
    });
    this.container.querySelector('.playlist-delete')?.addEventListener('click', async () => {
      if (!this.confirmDelete) {
        this.confirmDelete = true;
        await this.render();
        this.container.querySelector('.playlist-delete')?.focus();
        return;
      }
      await this.store.delete(playlist.id);
      this.notify(`Deleted “${playlist.name}”. Its songs stay in your library.`, 'info');
      this.openId = null;
      this.confirmDelete = false;
      await this.render();
    });
  }
}

export class PlaylistPicker {
  /**
   * @param {object} deps
   * @param {HTMLElement} deps.backdrop #playlistPickerBackdrop
   * @param {PlaylistStore} deps.store
   * @param {import('./library.js').LibraryCollector} deps.collector saves search results first
   * @param {(msg: string, type?: string) => void} deps.notify
   * @param {() => void} [deps.onChange] after a song was added (refresh views)
   * @param {() => void} [deps.onClose]
   */
  constructor({ backdrop, store, collector, notify, onChange, onClose }) {
    this.backdrop = backdrop;
    this.store = store;
    this.collector = collector;
    this.notify = notify || (() => {});
    this.onChange = onChange || (() => {});
    this.onClose = onClose || (() => {});
    const q = (id) => document.getElementById(id);
    this.subtitleEl = q('playlistPickerSubtitle');
    this.listEl = q('playlistPickerList');
    this.form = q('playlistPickerNew');
    this.input = q('playlistPickerName');
    this.btnClose = q('btnClosePlaylistPicker');
    this.item = null;
    this._busy = false;
    this.btnClose?.addEventListener('click', () => this.close());
    this.backdrop?.addEventListener('click', (e) => { if (e.target === this.backdrop) this.close(); });
    this.listEl?.addEventListener('click', (e) => {
      const btn = e.target instanceof Element ? e.target.closest('[data-playlist-id]') : null;
      if (btn && !btn.disabled) this.addTo(btn.dataset.playlistId);
    });
    this.form?.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (this._busy) return;
      try {
        const created = await this.store.create(this.input?.value);
        await this.addTo(created.id);
      } catch (err) {
        this.notify(err.message, 'warning');
        this.input?.focus();
      }
    });
  }

  get isOpen() {
    return Boolean(this.backdrop && !this.backdrop.classList.contains('hidden'));
  }

  async open(item) {
    if (!playlistTrackIdFor(item)) {
      this.notify('Only Free music songs can go in a playlist.', 'info');
      return false;
    }
    this.item = item;
    if (this.subtitleEl) this.subtitleEl.textContent = [item.title, item.artist].filter(Boolean).join(' · ');
    if (this.input) this.input.value = '';
    await this.renderList();
    this.backdrop.classList.remove('hidden');
    this.backdrop.setAttribute('aria-hidden', 'false');
    (this.listEl?.querySelector('button:not([disabled])') || this.input)?.focus({ preventScroll: true });
    return true;
  }

  close() {
    if (!this.isOpen) return;
    this.backdrop.classList.add('hidden');
    this.backdrop.setAttribute('aria-hidden', 'true');
    this.onClose();
  }

  async renderList() {
    if (!this.listEl) return;
    const id = playlistTrackIdFor(this.item);
    const playlists = await this.store.all();
    this.listEl.replaceChildren(...playlists.map((p) => {
      const has = p.trackIds.includes(id);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sheet-row playlist-pick';
      btn.dataset.playlistId = p.id;
      btn.disabled = has;
      const name = document.createElement('span');
      name.className = 'sheet-row-label';
      name.textContent = p.name;
      const hint = document.createElement('span');
      hint.className = 'sheet-row-hint';
      hint.textContent = has ? 'Already in this playlist' : `${p.trackIds.length} ${p.trackIds.length === 1 ? 'song' : 'songs'}`;
      btn.append(name, hint);
      return btn;
    }));
    if (!playlists.length) {
      const p = document.createElement('p');
      p.className = 'lyric-card-hint';
      p.textContent = 'No playlists yet. Name your first one below.';
      this.listEl.replaceChildren(p);
    }
  }

  /** Save the song to the library if needed, then add it to the playlist. */
  async addTo(playlistId) {
    if (this._busy || !this.item) return;
    this._busy = true;
    try {
      const trackId = playlistTrackIdFor(this.item);
      if (!(await this.collector.store.getTrack(trackId))) {
        const row = await this.collector.collectOpen(this.item, { played: false });
        if (!row) throw new Error('Couldn’t save that song on this device.');
      }
      let result = null;
      const updated = await this.store.update(playlistId, (p) => {
        result = addToPlaylist(p, trackId);
        return result.playlist;
      });
      if (!updated) throw new Error('That playlist no longer exists.');
      if (result.added) this.notify(`Added to “${updated.name}”.`, 'info');
      else if (result.reason === 'full') this.notify(`“${updated.name}” is full (${MAX_PLAYLIST_TRACKS} songs).`, 'warning');
      else this.notify(`Already in “${updated.name}”.`, 'info');
      this.close();
      this.onChange();
    } catch (err) {
      this.notify(err.message || 'Couldn’t add the song.', 'error');
    } finally {
      this._busy = false;
    }
  }
}
