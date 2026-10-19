/**
 * LyricWave Library view (Discover > Library): browse collected songs and artists, and search
 * Free music (openly licensed songs from Openverse) to play in full or save.
 *
 * DOM only at runtime (inside LibraryView methods). app.js passes in its shared helpers
 * (escapeHtml, icon, mediaThumbHtml, wireMediaThumbs) so rows match Charts and News.
 */

import { coverArtUrl } from './musicbrainz.js';

/** Starter searches for Free music. */
export const FREE_MUSIC_SUGGESTIONS = ['piano', 'acoustic', 'lofi', 'folk', 'electronic', 'jazz', 'classical', 'ambient'];

/** Art for a library row: Cover Art Archive first, the source app's artwork as fallback. */
export function rowArtUrl(row) {
  return row?.art?.url || coverArtUrl(row?.releaseGroupMbid) || row?.sourceArt || '';
}

/** Short label for a row's data license (never colour-only in the UI). */
export function licenseBadge(row) {
  if (row?.openTrack) return { text: row.openTrack.licenseLabel || row.openTrack.license, tone: 'free' };
  if (row?.license === 'CC0-1.0') return { text: 'Open data', tone: 'open' };
  if (row?.resolveStatus === 'pending') return { text: 'Matching…', tone: 'pending' };
  return { text: 'Not matched', tone: 'unverified' };
}

/** Commons photo URL for an artist row, or ''. */
export function artistPhotoUrl(artist) {
  const url = artist?.photo?.url || '';
  return /^https:\/\//i.test(url) ? url : '';
}

/** "Photo: Author, CC BY-SA 4.0" caption for an artist photo (link targets come from the row). */
export function artistPhotoCaption(photo) {
  if (!photo) return '';
  const license = photo.license === 'PDM' ? 'public domain' : (photo.licenseLabel || photo.license);
  return `Photo${photo.author ? `: ${photo.author}` : ''}, ${license}`;
}

/** Old artist rows were fetched before photos existed; fetch them once more. */
export function needsPhotoRefresh(artist) {
  return Boolean(artist?.mbid && artist.detailsFetchedAt && !('photo' in artist));
}

/**
 * A Free music search that matches an artist: their top MusicBrainz genre, else the most common
 * genre of their songs in the library (Openverse rows keep the host's genres). '' when unknown.
 */
export function freeMusicQueryFor(artist, tracks = []) {
  const own = (artist?.genres || []).map((g) => String(g).trim()).filter(Boolean);
  if (own.length) return own[0].slice(0, 40);
  const counts = new Map();
  for (const t of tracks) for (const g of t.genres || []) {
    const key = String(g).trim().toLowerCase();
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return best ? best[0].slice(0, 40) : '';
}

/** "Person · GB · 1946–2016" style facts line for an artist. */
export function artistFacts(artist) {
  const facts = [];
  if (artist?.type) facts.push(artist.type);
  if (artist?.area || artist?.country) facts.push(artist.area || artist.country);
  const begin = String(artist?.lifeBegin || '').slice(0, 4);
  const end = String(artist?.lifeEnd || '').slice(0, 4);
  if (begin || end) facts.push(end ? `${begin || '?'}–${end}` : `since ${begin}`);
  return facts.join(' · ');
}

export function formatCount(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/** 205000 -> "3:25"; '' when unknown. */
export function formatDurationMs(ms) {
  const total = Math.round(Number(ms) / 1000);
  if (!(total > 0)) return '';
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Message for a failed Free music search. */
export function freeSearchErrorText(err) {
  if (err?.code === 'rate_limited') return 'Openverse is limiting searches right now. Try again in a minute.';
  if (err?.code === 'network') return 'Free music search needs a connection. Check you’re online and try again.';
  return 'Free music search isn’t working right now. Try again later.';
}

/** "via Jamendo · 3:25" line under an open track. */
export function openTrackSubline(item) {
  const ms = Number(item?.durationMs) > 0 ? Number(item.durationMs) : Number(item?.durationSec) * 1000;
  return [item?.openTrack?.provider ? `via ${item.openTrack.provider}` : '', formatDurationMs(ms)].filter(Boolean).join(' · ');
}

const isHttps = (url) => /^https:\/\//i.test(String(url || ''));

export class LibraryView {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.container list container
   * @param {HTMLInputElement} [opts.filterInput]
   * @param {NodeListOf<HTMLElement>|HTMLElement[]} [opts.modeChips] chips with data-library-mode
   * @param {HTMLElement} [opts.countTag]
   * @param {import('./library.js').LibraryCollector} opts.collector
   * @param {(row: object, queue?: {items: object[], index: number, label: string}) => void} opts.onPlay
   *   library row or Free music result (has openTrack); free songs come with the list they were
   *   played from, so the app can queue the rest
   * @param {object} opts.helpers { escapeHtml, icon, mediaThumbHtml, wireMediaThumbs }
   * @param {import('./openverse.js').OpenverseClient} [opts.openverse] Free music search
   * @param {HTMLButtonElement} [opts.commercialToggle] "Commercial use OK" filter (Free music only)
   * @param {HTMLElement} [opts.subtitle] panel subtitle, reworded per mode
   * @param {(msg: string, type?: string) => void} [opts.notify] app toast
   * @param {(query: string) => void} [opts.onSearch] open the Search tab with a query (similar artists)
   * @param {import('./playlists.js').PlaylistsView} [opts.playlists] renders the Playlists mode
   * @param {(item: object) => void} [opts.onAddToPlaylist] open the Add to playlist dialog for a free song
   */
  constructor({ container, filterInput, modeChips = [], countTag, collector, onPlay, helpers, openverse = null, commercialToggle = null, subtitle = null, notify = () => {}, onSearch = null, playlists = null, onAddToPlaylist = null }) {
    this.container = container;
    this.filterInput = filterInput;
    this.modeChips = Array.from(modeChips);
    this.countTag = countTag;
    this.collector = collector;
    this.onPlay = onPlay;
    this.h = helpers;
    this.openverse = openverse;
    this.commercialToggle = commercialToggle;
    this.subtitle = subtitle;
    this.notify = notify;
    this.onSearch = onSearch;
    this.playlists = playlists;
    this.onAddToPlaylist = onAddToPlaylist;
    this.mode = 'songs';
    this.query = '';
    this.libraryQuery = '';
    this.artistId = null;
    this.renderToken = 0;
    this.visible = false;
    // Free music search state. Openverse allows 20 anonymous searches a minute (200 a day), so
    // typing waits for a pause (or Enter) and further pages load only on "More results".
    this.free = { query: '', commercialOnly: false, results: [], page: 0, pageCount: 0, total: 0, loading: false, error: '', token: 0 };

    this.modeChips.forEach((chip) => chip.addEventListener('click', () => this.setMode(chip.dataset.libraryMode)));
    if (this.filterInput) {
      let timer = null;
      this.filterInput.addEventListener('input', () => {
        clearTimeout(timer);
        if (this.mode === 'free') {
          timer = setTimeout(() => this.searchFree(this.filterInput.value), 700);
          return;
        }
        timer = setTimeout(() => {
          this.query = this.filterInput.value;
          if (this.playlists) this.playlists.query = this.mode === 'playlists' ? this.query : '';
          this.render();
        }, 120);
      });
      this.filterInput.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || this.mode !== 'free') return;
        e.preventDefault();
        clearTimeout(timer);
        this.searchFree(this.filterInput.value, { force: true });
      });
    }
    this.commercialToggle?.addEventListener('click', () => {
      this.free.commercialOnly = !this.free.commercialOnly;
      this.commercialToggle.setAttribute('aria-pressed', this.free.commercialOnly ? 'true' : 'false');
      this.commercialToggle.classList.toggle('active', this.free.commercialOnly);
      if (this.free.query) this.searchFree(this.free.query, { force: true });
    });
  }

  setMode(mode) {
    const prev = this.mode;
    this.mode = ['artists', 'free', 'playlists'].includes(mode) ? mode : 'songs';
    if (this.playlists) {
      this.playlists.openId = null;
      this.playlists.query = this.mode === 'playlists' ? this.query : '';
    }
    this.artistId = null;
    this.modeChips.forEach((chip) => {
      const on = chip.dataset.libraryMode === this.mode;
      chip.classList.toggle('active', on);
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    // The box filters the library in Songs / Artists and searches Openverse in Free music.
    if (this.filterInput && prev !== this.mode && (prev === 'free' || this.mode === 'free')) {
      if (prev !== 'free') this.libraryQuery = this.filterInput.value;
      this.filterInput.value = this.mode === 'free' ? this.free.query : this.libraryQuery;
      this.query = this.mode === 'free' ? '' : this.libraryQuery;
    }
    if (this.filterInput) {
      this.filterInput.placeholder = {
        artists: 'Filter artists…',
        free: 'Search free music, e.g. piano or folk…',
        playlists: 'Filter playlists…'
      }[this.mode] || 'Filter songs, artists or albums…';
      this.filterInput.setAttribute('aria-label', this.mode === 'free' ? 'Search free music on Openverse' : 'Filter your library');
      this.filterInput.setAttribute('enterkeyhint', this.mode === 'free' ? 'search' : 'done');
    }
    this.commercialToggle?.classList.toggle('hidden', this.mode !== 'free');
    if (this.subtitle) {
      this.subtitle.textContent = this.mode === 'free'
        ? 'Openly licensed songs you can play in full. Every song shows its license and credit.'
        : 'Every song you play, matched to open music data. Tap a song for synced lyrics.';
    }
    this.render();
  }

  show() {
    this.visible = true;
    this.render();
  }

  hide() {
    this.visible = false;
  }

  /** Called when the library changed; only redraws while the panel is on screen. */
  refresh() {
    if (this.visible) this.render();
  }

  async render() {
    if (!this.container) return;
    const token = ++this.renderToken;
    const store = this.collector.store;
    try {
      if (this.mode === 'free') {
        const total = (await store.allTracks()).length;
        if (token !== this.renderToken) return;
        if (this.countTag) this.countTag.textContent = formatCount(total, 'song', 'songs');
        await this.renderFree(token);
        return;
      }
      if (this.mode === 'playlists' && this.playlists) {
        const total = (await store.allTracks()).length;
        if (token !== this.renderToken) return;
        if (this.countTag) this.countTag.textContent = formatCount(total, 'song', 'songs');
        await this.playlists.render();
        return;
      }
      if (this.artistId) {
        const [artist, tracks, known] = await Promise.all([store.getArtist(this.artistId), store.tracksByArtist(this.artistId), store.allArtists()]);
        if (token !== this.renderToken) return;
        this.renderArtist(artist, tracks, new Set(known.map((a) => a.id)));
        return;
      }
      const [songs, artists] = await Promise.all([store.songs({ query: this.mode === 'songs' ? this.query : '' }), store.artists({ query: this.mode === 'artists' ? this.query : '' })]);
      if (token !== this.renderToken) return;
      const total = (await store.allTracks()).length;
      if (token !== this.renderToken) return;
      if (this.countTag) this.countTag.textContent = formatCount(total, 'song', 'songs');
      if (this.mode === 'artists') this.renderArtistList(artists, total);
      else this.renderSongList(songs, total);
    } catch (err) {
      console.warn('Library render failed:', err);
      this.container.innerHTML = `<div class="charts-empty-state" role="alert"><p>Your library could not be opened on this device.</p></div>`;
    }
  }

  emptyHtml(total) {
    const { escapeHtml } = this.h;
    if (total === 0) {
      return `<div class="charts-empty-state library-empty">
        <p><strong>Your library is empty.</strong></p>
        <p>Every song you play in LyricWave is added here and matched to MusicBrainz, the open music encyclopedia.</p>
        <p>Looking for songs to play? Try <strong>Free music</strong> for openly licensed tracks.</p>
      </div>`;
    }
    return `<div class="charts-empty-state"><p>Nothing matches “${escapeHtml(this.query.trim())}”.</p></div>`;
  }

  songRowHtml(row) {
    const { escapeHtml, icon, mediaThumbHtml } = this.h;
    const badge = licenseBadge(row);
    const year = String(row.firstReleaseDate || '').slice(0, 4);
    const sub = row.openTrack ? openTrackSubline(row) : [row.album, year].filter(Boolean).join(' · ');
    const playLabel = row.openTrack
      ? `Play song: ${row.title} by ${row.artist}, ${badge.text}`
      : `Play synced lyrics: ${row.title} by ${row.artist}`;
    return `
      ${mediaThumbHtml(rowArtUrl(row), 'chart', icon('music'), 48, 48)}
      <div class="chart-song-meta">
        <div class="chart-song-title" title="${escapeHtml(row.title)}">${escapeHtml(row.title)}</div>
        <div class="chart-song-artist" title="${escapeHtml(row.artist)}">${escapeHtml(row.artist)}</div>
        <div class="chart-song-tag-row">
          <span class="library-badge library-badge--${badge.tone}" title="${escapeHtml(row.attribution || '')}">${badge.tone === 'open' || badge.tone === 'free' ? icon('check', 'sm') : ''}${escapeHtml(badge.text)}</span>
          ${sub ? `<span class="library-sub">${escapeHtml(sub)}</span>` : ''}
        </div>
      </div>
      <div class="chart-song-action${row.openTrack && this.onAddToPlaylist ? ' free-actions' : ''}">
        ${row.openTrack && this.onAddToPlaylist ? this.addToPlaylistButtonHtml(row) : ''}
        <button class="btn-chart-play btn-chart-play--icon" type="button" aria-label="${escapeHtml(playLabel)}">
          ${icon('play', 'sm')}
          <span class="btn-label">Play</span>
        </button>
      </div>`;
  }

  addToPlaylistButtonHtml(item) {
    const { escapeHtml, icon } = this.h;
    return `<button class="btn-chart-play btn-chart-play--icon add-to-playlist" type="button"
      aria-label="${escapeHtml(`Add to playlist: ${item.title} by ${item.artist}`)}" title="Add to playlist">
      ${icon('list-plus', 'sm')}<span class="btn-label">Playlist</span></button>`;
  }

  /** Queue context for playing an open row out of `rows` (null for other songs). */
  queueFor(rows, row, label) {
    if (!row?.openTrack) return null;
    const items = rows.filter((r) => r.openTrack);
    return { items, index: Math.max(0, items.indexOf(row)), label };
  }

  appendSongRows(list, rows, label = 'Your free songs') {
    const fragment = document.createDocumentFragment();
    rows.forEach((row) => {
      const card = document.createElement('div');
      card.className = 'chart-song-card library-song-card';
      card.innerHTML = this.songRowHtml(row);
      this.h.wireMediaThumbs(card);
      const play = () => this.onPlay(row, this.queueFor(rows, row, label));
      card.addEventListener('click', play);
      card.querySelector('.btn-chart-play:not(.add-to-playlist)')?.addEventListener('click', (e) => {
        e.stopPropagation();
        play();
      });
      card.querySelector('.add-to-playlist')?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onAddToPlaylist?.(row);
      });
      fragment.appendChild(card);
    });
    list.appendChild(fragment);
  }

  renderSongList(songs, total) {
    if (!songs.length) {
      this.container.innerHTML = this.emptyHtml(total);
      return;
    }
    this.container.innerHTML = '';
    const playable = songs.filter((r) => r.openTrack);
    if (playable.length) this.container.appendChild(this.playAllButton(playable, `Play free songs (${playable.length})`, 'Your free songs'));
    const list = document.createElement('div');
    list.className = 'library-list';
    list.setAttribute('role', 'list');
    this.appendSongRows(list, songs);
    list.querySelectorAll('.library-song-card').forEach((el) => el.setAttribute('role', 'listitem'));
    this.container.appendChild(list);
  }

  renderArtistList(artists, total) {
    const { escapeHtml, icon, mediaThumbHtml, wireMediaThumbs } = this.h;
    if (!artists.length) {
      this.container.innerHTML = this.emptyHtml(total);
      return;
    }
    this.container.innerHTML = '';
    const list = document.createElement('div');
    list.className = 'library-list';
    list.setAttribute('role', 'list');
    artists.forEach((artist) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'library-artist-card';
      btn.setAttribute('role', 'listitem');
      const facts = [formatCount(artist.trackCount, 'song', 'songs'), artistFacts(artist)].filter(Boolean).join(' · ');
      btn.innerHTML = `
        ${mediaThumbHtml(artistPhotoUrl(artist), 'chart', `<span class="library-initial">${escapeHtml((artist.name || '?').trim().charAt(0).toUpperCase())}</span>`, 48, 48)}
        <span class="library-artist-meta">
          <span class="chart-song-title">${escapeHtml(artist.name)}</span>
          <span class="chart-song-artist">${escapeHtml(facts)}</span>
        </span>
        <span class="library-chevron" aria-hidden="true">${icon('chevron-right', 'sm')}</span>`;
      wireMediaThumbs(btn);
      btn.addEventListener('click', () => this.openArtist(artist.id));
      list.appendChild(btn);
    });
    this.container.appendChild(list);
  }

  async openArtist(artistId) {
    this.artistId = artistId;
    await this.render();
    this.container.querySelector('.library-back')?.focus();
    try {
      const before = await this.collector.store.getArtist(artistId);
      if (before?.mbid && (!before.detailsFetchedAt || needsPhotoRefresh(before))) {
        await this.collector.refreshArtist(artistId, { force: needsPhotoRefresh(before) });
        if (this.artistId === artistId) this.render();
      }
      // Similar artists after the details, so the two writes never race on the same row
      if (before?.mbid && typeof this.collector.refreshSimilar === 'function') {
        const fresh = await this.collector.store.getArtist(artistId);
        const updated = await this.collector.refreshSimilar(artistId);
        if (this.artistId === artistId && updated?.similarFetchedAt !== fresh?.similarFetchedAt) this.render();
      }
    } catch (err) {
      console.warn('Artist details failed:', err);
      if (this.artistId === artistId) {
        const note = this.container.querySelector('.library-artist-loading');
        if (note) note.textContent = 'Artist details are unavailable right now.';
      }
    }
  }

  /** "Play all" button that queues `items` from the first one. */
  playAllButton(items, text, label) {
    const { icon } = this.h;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-sm library-play-all';
    btn.innerHTML = `${icon('play', 'sm')}<span></span>`;
    btn.querySelector('span').textContent = text;
    btn.addEventListener('click', (e) => {
      // Like the row Play buttons: keep the tap from reaching outside-click handlers
      e.stopPropagation();
      this.onPlay(items[0], { items, index: 0, label });
    });
    return btn;
  }

  /** Similar artists (ListenBrainz) and a Free music search that fits this artist. */
  discoverHtml(artist, tracks, knownIds) {
    const { escapeHtml, icon } = this.h;
    const similar = Array.isArray(artist.similar) ? artist.similar : [];
    const freeQuery = this.openverse ? freeMusicQueryFor(artist, tracks) : '';
    let html = '';
    if (similar.length) {
      html += `<h4 class="library-section-title">Similar artists</h4>
        <div class="chip-row library-similar" role="list" aria-label="Similar artists">
          ${similar.map((s) => {
            const inLibrary = knownIds.has(`mb:${s.mbid}`);
            const label = inLibrary ? `${s.name}, in your library` : `Search ${s.name}`;
            return `<button type="button" class="chip library-similar-chip" role="listitem" data-similar-mbid="${escapeHtml(s.mbid)}"
              data-similar-name="${escapeHtml(s.name)}" ${inLibrary ? 'data-in-library="true"' : ''} aria-label="${escapeHtml(label)}"
              title="${escapeHtml(s.comment || label)}">${inLibrary ? icon('check', 'sm') : ''}${escapeHtml(s.name)}</button>`;
          }).join('')}
        </div>
        <p class="library-sub library-similar-credit">From <a href="https://listenbrainz.org/" target="_blank" rel="noopener noreferrer">ListenBrainz</a> listening data (CC0).</p>`;
    } else if (artist.mbid && !artist.similarFetchedAt) {
      html += '<p class="library-artist-loading library-similar-loading" role="status">Finding similar artists…</p>';
    }
    if (freeQuery) {
      html += `<button type="button" class="btn btn-sm library-free-like" data-free-query="${escapeHtml(freeQuery)}">
        ${icon('headphones', 'sm')}<span>Free ${escapeHtml(freeQuery)} music to play</span></button>`;
    }
    return html;
  }

  /** Free music search for a query, from an artist page. */
  openFreeMusic(query) {
    this.setMode('free');
    if (this.filterInput) this.filterInput.value = query;
    this.searchFree(query, { force: true });
    this.filterInput?.focus({ preventScroll: true });
  }

  renderArtist(artist, tracks, knownIds = new Set()) {
    const { escapeHtml, icon, mediaThumbHtml, wireMediaThumbs } = this.h;
    if (!artist) {
      this.artistId = null;
      this.render();
      return;
    }
    const photo = artistPhotoUrl(artist) ? artist.photo : null;
    const art = photo ? photo.url : rowArtUrl(tracks.find((t) => t.art?.url) || tracks[0]);
    const caption = artistPhotoCaption(photo);
    const photoCredit = photo
      ? `<p class="library-photo-credit">${/^https:\/\//.test(photo.pageUrl || '')
        ? `<a href="${escapeHtml(photo.pageUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(caption)}</a>`
        : escapeHtml(caption)}${/^https:\/\//.test(photo.licenseUrl || '')
        ? ` · <a href="${escapeHtml(photo.licenseUrl)}" target="_blank" rel="noopener noreferrer">License</a>` : ''} · Wikimedia Commons</p>`
      : '';
    const facts = artistFacts(artist);
    const links = [];
    if (artist.mbid) links.push(`<a href="https://musicbrainz.org/artist/${escapeHtml(artist.mbid)}" target="_blank" rel="noopener noreferrer">MusicBrainz ${icon('external-link', 'sm')}</a>`);
    if (/^https:\/\//.test(artist.wikipediaUrl || '')) links.push(`<a href="${escapeHtml(artist.wikipediaUrl)}" target="_blank" rel="noopener noreferrer">Wikipedia ${icon('external-link', 'sm')}</a>`);
    if (artist.wikidataId) links.push(`<a href="https://www.wikidata.org/wiki/${escapeHtml(artist.wikidataId)}" target="_blank" rel="noopener noreferrer">Wikidata ${icon('external-link', 'sm')}</a>`);
    if (!artist.mbid && artist.source === 'openverse' && isHttps(artist.sourceUrl)) {
      links.push(`<a href="${escapeHtml(artist.sourceUrl)}" target="_blank" rel="noopener noreferrer">Creator page ${icon('external-link', 'sm')}</a>`);
    }
    const loading = artist.mbid && !artist.detailsFetchedAt;
    let unmatchedNote = '';
    if (!artist.mbid) {
      unmatchedNote = artist.source === 'openverse'
        ? '<p class="library-artist-loading">Creator of openly licensed songs from Free music.</p>'
        : '<p class="library-artist-loading">This artist hasn’t been matched to MusicBrainz yet, so there are no open details to show.</p>';
    }

    this.container.innerHTML = `
      <article class="library-artist-detail" aria-labelledby="libraryArtistName">
        <button type="button" class="btn btn-sm btn-ghost library-back">${icon('chevron-right', 'sm')}<span>All artists</span></button>
        <header class="library-artist-head">
          ${mediaThumbHtml(art, 'chart', `<span class="library-initial">${escapeHtml((artist.name || '?').charAt(0).toUpperCase())}</span>`, 88, 88)}
          <div class="library-artist-head-text">
            <h3 id="libraryArtistName" class="library-artist-name">${escapeHtml(artist.name)}</h3>
            ${artist.disambiguation ? `<p class="library-artist-dis">${escapeHtml(artist.disambiguation)}</p>` : ''}
            ${facts ? `<p class="library-artist-facts">${escapeHtml(facts)}</p>` : ''}
          </div>
        </header>
        ${photoCredit}
        ${artist.description ? `<p class="library-artist-desc">${escapeHtml(artist.description)}</p>` : ''}
        ${loading ? '<p class="library-artist-loading" role="status">Loading artist details…</p>' : ''}
        ${unmatchedNote}
        ${artist.genres?.length ? `<div class="library-genres" aria-label="Genres">${artist.genres.map((g) => `<span class="chip library-genre">${escapeHtml(g)}</span>`).join('')}</div>` : ''}
        ${links.length ? `<p class="library-links">${links.join('')}</p>` : ''}
        ${this.discoverHtml(artist, tracks, knownIds)}
        <h4 class="library-section-title">${escapeHtml(formatCount(tracks.length, 'song', 'songs'))} in your library</h4>
        <div class="library-list" role="list"></div>
        <p class="library-credits">${escapeHtml(artist.attribution || '')}</p>
      </article>`;
    wireMediaThumbs(this.container);
    this.container.querySelector('.library-back')?.addEventListener('click', () => {
      this.artistId = null;
      this.render().then(() => this.container.querySelector('.library-artist-card')?.focus());
    });
    this.container.querySelectorAll('.library-similar-chip').forEach((chip) => chip.addEventListener('click', () => {
      if (chip.dataset.inLibrary === 'true') {
        this.openArtist(`mb:${chip.dataset.similarMbid}`);
      } else if (this.onSearch) {
        this.onSearch(chip.dataset.similarName);
      }
    }));
    this.container.querySelector('.library-free-like')?.addEventListener('click', (e) => {
      this.openFreeMusic(e.currentTarget.dataset.freeQuery);
    });
    const list = this.container.querySelector('.library-artist-detail > .library-list');
    this.appendSongRows(list, tracks, artist.name);
    list.querySelectorAll('.library-song-card').forEach((el) => el.setAttribute('role', 'listitem'));
  }

  // -------------------------------------------------------------------------
  // Free music (Openverse)
  // -------------------------------------------------------------------------

  /**
   * Run a Free music search. Repeats of the current search are skipped unless forced
   * (Enter, the commercial filter) so typing doesn't burn the Openverse rate limit.
   */
  async searchFree(rawQuery, { force = false, more = false } = {}) {
    const query = String(rawQuery || '').trim().slice(0, 100);
    const f = this.free;
    if (!this.openverse) return;
    if (!more && !force && query === f.query && (f.results.length || f.loading)) return;
    if (!more && query.length > 0 && query.length < 2 && !force) return;
    const token = ++f.token;
    if (!more) {
      f.query = query;
      f.results = [];
      f.page = 0;
      f.pageCount = 0;
      f.total = 0;
    }
    f.error = '';
    if (!query) {
      f.loading = false;
      this.render();
      return;
    }
    f.loading = true;
    this.render();
    try {
      const res = await this.openverse.search(query, { page: f.page + 1, commercialOnly: f.commercialOnly });
      if (token !== f.token) return;
      const seen = new Set(f.results.map((r) => r.openTrack.openverseId));
      f.results = f.results.concat(res.results.filter((r) => !seen.has(r.openTrack.openverseId)));
      f.page = res.page;
      f.pageCount = res.pageCount;
      f.total = Math.max(res.total, f.results.length);
    } catch (err) {
      if (token !== f.token) return;
      console.warn('Free music search failed:', err);
      f.error = freeSearchErrorText(err);
    } finally {
      if (token === f.token) {
        f.loading = false;
        if (this.mode === 'free') this.render();
      }
    }
  }

  async renderFree(token) {
    const { escapeHtml, icon } = this.h;
    const f = this.free;
    if (!this.openverse) {
      this.container.innerHTML = '<div class="charts-empty-state"><p>Free music isn’t available in this build.</p></div>';
      return;
    }
    const saved = new Set((await this.collector.store.allTracks()).filter((r) => r.openTrack).map((r) => r.openTrack.openverseId));
    if (token !== this.renderToken) return;

    const credits = `<p class="library-credits">Songs found with <a href="https://openverse.org/" target="_blank" rel="noopener noreferrer">Openverse</a>
      and streamed from the site that hosts them. Each song’s license and creator are shown with it; follow the license if you reuse it.</p>`;

    if (!f.query) {
      this.container.innerHTML = `
        <div class="charts-empty-state library-empty free-intro">
          <p><strong>Free music you can play in full.</strong></p>
          <p>Search Creative Commons and public domain songs from Jamendo, Wikimedia Commons, ccMixter and more. Save the ones you like to your library.</p>
          <div class="chip-row free-suggestions" role="group" aria-label="Try a search">
            ${FREE_MUSIC_SUGGESTIONS.map((s) => `<button type="button" class="chip" data-free-suggestion="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join('')}
          </div>
        </div>${credits}`;
      this.container.querySelectorAll('[data-free-suggestion]').forEach((btn) => btn.addEventListener('click', () => {
        if (this.filterInput) this.filterInput.value = btn.dataset.freeSuggestion;
        this.searchFree(btn.dataset.freeSuggestion, { force: true });
      }));
      return;
    }

    if (!f.results.length) {
      let body;
      if (f.loading) body = '<div class="charts-loading-state" role="status"><div class="spinner" aria-hidden="true"></div><p>Searching free music…</p></div>';
      else if (f.error) body = `<div class="charts-empty-state" role="alert"><p>${escapeHtml(f.error)}</p><button type="button" class="btn btn-sm free-retry">Try again</button></div>`;
      else body = `<div class="charts-empty-state"><p>No free songs match “${escapeHtml(f.query)}”${f.commercialOnly ? ' with commercial use allowed' : ''}. Try another word.</p></div>`;
      this.container.innerHTML = body + credits;
      this.container.querySelector('.free-retry')?.addEventListener('click', () => this.searchFree(f.query, { force: true }));
      return;
    }

    this.container.innerHTML = '';
    const status = document.createElement('p');
    status.className = 'library-sub free-count';
    status.setAttribute('role', 'status');
    status.textContent = `${f.results.length} of ${f.total} free songs for “${f.query}”${f.commercialOnly ? ', commercial use allowed' : ''}`;
    const head = document.createElement('div');
    head.className = 'free-head';
    head.append(status, this.playAllButton(f.results, 'Play all', `Free music: ${f.query}`));
    this.container.appendChild(head);

    const list = document.createElement('div');
    list.className = 'library-list';
    list.setAttribute('role', 'list');
    f.results.forEach((item, i) => list.appendChild(this.freeRow(item, saved.has(item.openTrack.openverseId), i)));
    this.container.appendChild(list);

    const footer = document.createElement('div');
    footer.className = 'free-footer';
    if (f.error) {
      footer.innerHTML = `<p role="alert">${escapeHtml(f.error)}</p>`;
    }
    if (f.page < f.pageCount) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'btn btn-sm free-more';
      more.disabled = f.loading;
      more.innerHTML = f.loading ? '<span>Loading…</span>' : `${icon('plus', 'sm')}<span>More results</span>`;
      more.addEventListener('click', () => this.searchFree(f.query, { more: true }));
      footer.appendChild(more);
    }
    this.container.appendChild(footer);
    this.container.insertAdjacentHTML('beforeend', credits);
  }

  freeRow(item, isSaved, index = 0) {
    const { escapeHtml, icon, mediaThumbHtml, wireMediaThumbs } = this.h;
    const ot = item.openTrack;
    const card = document.createElement('div');
    card.className = 'chart-song-card library-song-card free-song-card';
    card.setAttribute('role', 'listitem');
    const sub = openTrackSubline(item);
    const source = isHttps(ot.landingUrl)
      ? `<a class="free-source-link" href="${escapeHtml(ot.landingUrl)}" target="_blank" rel="noopener noreferrer" aria-label="Open ${escapeHtml(item.title)} on ${escapeHtml(ot.provider)}">${icon('external-link', 'sm')}</a>`
      : '';
    const license = isHttps(ot.licenseUrl)
      ? `<a class="library-badge library-badge--free" href="${escapeHtml(ot.licenseUrl)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(ot.attribution)}">${icon('check', 'sm')}${escapeHtml(ot.licenseLabel)}</a>`
      : `<span class="library-badge library-badge--free" title="${escapeHtml(ot.attribution)}">${icon('check', 'sm')}${escapeHtml(ot.licenseLabel)}</span>`;
    card.innerHTML = `
      ${mediaThumbHtml(item.albumArt, 'chart', icon('music'), 48, 48)}
      <div class="chart-song-meta">
        <div class="chart-song-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
        <div class="chart-song-artist" title="${escapeHtml(item.artist)}">${escapeHtml(item.artist)}</div>
        <div class="chart-song-tag-row">
          ${license}
          ${sub ? `<span class="library-sub">${escapeHtml(sub)}</span>` : ''}
          ${source}
        </div>
      </div>
      <div class="chart-song-action free-actions">
        ${this.onAddToPlaylist ? this.addToPlaylistButtonHtml(item) : ''}
        <button class="btn-chart-play btn-chart-play--icon free-save" type="button" aria-pressed="${isSaved ? 'true' : 'false'}"
          aria-label="${escapeHtml(`${isSaved ? 'Saved' : 'Save'} to library: ${item.title} by ${item.artist}`)}">
          ${icon(isSaved ? 'check' : 'plus', 'sm')}
          <span class="btn-label">${isSaved ? 'Saved' : 'Save'}</span>
        </button>
        <button class="btn-chart-play btn-chart-play--icon free-play" type="button"
          aria-label="${escapeHtml(`Play song: ${item.title} by ${item.artist}, ${ot.licenseLabel}`)}">
          ${icon('play', 'sm')}
          <span class="btn-label">Play</span>
        </button>
      </div>`;
    wireMediaThumbs(card);
    const queue = () => ({ items: this.free.results, index, label: `Free music: ${this.free.query}` });
    card.querySelector('.free-play')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onPlay(item, queue());
    });
    card.querySelector('.free-source-link')?.addEventListener('click', (e) => e.stopPropagation());
    card.querySelector('.add-to-playlist')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onAddToPlaylist?.(item);
    });
    card.querySelector('a.library-badge')?.addEventListener('click', (e) => e.stopPropagation());
    const saveBtn = card.querySelector('.free-save');
    saveBtn?.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (saveBtn.getAttribute('aria-pressed') === 'true') return;
      saveBtn.disabled = true;
      try {
        const row = await this.collector.collectOpen(item, { played: false });
        if (!row) throw new Error('not saved');
        this.notify(`Saved “${item.title}” to your library.`, 'info');
      } catch (err) {
        console.warn('Save free song failed:', err);
        saveBtn.disabled = false;
        this.notify('Couldn’t save that song on this device.', 'error');
      }
    });
    card.addEventListener('click', () => this.onPlay(item, queue()));
    return card;
  }
}
