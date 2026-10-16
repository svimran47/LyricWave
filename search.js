/**
 * LyricWave Track Search Service
 * 
 * Provides instant music search with high-resolution album artwork,
 * accurate song durations, artist names, and album metadata.
 */

const ITUNES_SEARCH_URL = 'https://itunes.apple.com/search';
const LRCLIB_SEARCH_URL = 'https://lrclib.net/api/search';

/**
 * Searches for tracks matching a user query across iTunes and LRCLIB.
 * Returns Array<{ id, title, artist, album, albumArt, durationMs, source }>
 */
export async function searchTracks(query, limit = 8) {
  if (!query || typeof query !== 'string' || !query.trim()) {
    return [];
  }

  // Validate and clamp search query length (prevent oversized or malformed payloads)
  const cleanQuery = query.trim().slice(0, 100);
  if (cleanQuery.length === 0) {
    return [];
  }

  const clampedLimit = Math.max(1, Math.min(25, Number(limit) || 8));
  const results = [];
  const seenKeys = new Set();

  const normalizeKey = (t, a) => `${(t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()}__${(a || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()}`;

  const LRCLIB_HEADERS = {
    'Lrclib-Client': 'LyricWave/1.0.0 (https://github.com/lyricwave)'
  };

  // 1. Concurrently query iTunes (for high-res artwork & audio preview) and LRCLIB (for confirmed lyrics)
  const itunesParams = new URLSearchParams({
    term: cleanQuery,
    entity: 'song',
    limit: clampedLimit.toString()
  });

  const lrcParams = new URLSearchParams({ q: cleanQuery });

  const itunesPromise = fetch(`${ITUNES_SEARCH_URL}?${itunesParams.toString()}`)
    .then(r => r.ok ? r.json() : null)
    .catch(err => {
      console.warn('iTunes search error:', err);
      return null;
    });

  const lrcPromise = fetch(`${LRCLIB_SEARCH_URL}?${lrcParams.toString()}`, { headers: LRCLIB_HEADERS })
    .then(r => r.ok ? r.json() : null)
    .catch(err => {
      console.warn('LRCLIB search error:', err);
      return null;
    });

  const [itunesData, lrcData] = await Promise.all([itunesPromise, lrcPromise]);

  // Index iTunes artwork and audio preview metadata
  const artMap = new Map();
  if (itunesData && Array.isArray(itunesData.results)) {
    for (const item of itunesData.results) {
      const k = normalizeKey(item.trackName, item.artistName);
      const highResArt = (item.artworkUrl100 || '').replace('100x100bb', '600x600bb');
      if (!artMap.has(k)) {
        artMap.set(k, {
          albumArt: highResArt || item.artworkUrl100 || '',
          previewUrl: item.previewUrl || null,
          collectionName: item.collectionName || ''
        });
      }
    }
  }

  // 2. Prioritize LRCLIB tracks (guaranteed to have lyrics available)
  if (Array.isArray(lrcData)) {
    for (const item of lrcData) {
      const key = `${item.trackName}__${item.artistName}`.toLowerCase();
      if (!seenKeys.has(key) && results.length < clampedLimit) {
        seenKeys.add(key);
        const normK = normalizeKey(item.trackName, item.artistName);
        const matchedItunes = artMap.get(normK) || null;
        results.push({
          id: `lrclib_${item.id}`,
          lrclibId: item.id,
          title: item.trackName,
          artist: item.artistName,
          album: item.albumName || matchedItunes?.collectionName || '',
          albumArt: matchedItunes?.albumArt || '',
          durationMs: (item.duration || 0) * 1000,
          previewUrl: matchedItunes?.previewUrl || null,
          syncedLyrics: item.syncedLyrics || null,
          plainLyrics: item.plainLyrics || null,
          instrumental: item.instrumental || false,
          hasSynced: Boolean(item.syncedLyrics),
          source: 'search'
        });
      }
    }
  }

  // 3. Augment with remaining iTunes tracks that weren't in LRCLIB results
  if (itunesData && Array.isArray(itunesData.results)) {
    for (const item of itunesData.results) {
      const key = `${item.trackName}__${item.artistName}`.toLowerCase();
      if (!seenKeys.has(key) && results.length < clampedLimit) {
        seenKeys.add(key);
        const highResArt = (item.artworkUrl100 || '').replace('100x100bb', '600x600bb');
        results.push({
          id: `itunes_${item.trackId}`,
          title: item.trackName,
          artist: item.artistName,
          album: item.collectionName || '',
          albumArt: highResArt || item.artworkUrl100 || '',
          durationMs: item.trackTimeMillis || 0,
          previewUrl: item.previewUrl || null,
          source: 'search'
        });
      }
    }
  }

  return results;
}

/**
  * SearchSource class implementing the unified NowPlaying source contract.
  * Allows the user to pick an LRCLIB/iTunes search result and control
  * playback (Start, Pause, Resume, Seek) directly driving the UnifiedSyncEngine.
  */
export class SearchSource {
  constructor(options = {}) {
    this.name = 'search';
    this.onTrackChange = options.onTrackChange || (() => {});
    this.onPlaybackUpdate = options.onPlaybackUpdate || (() => {});
    this.onIdle = options.onIdle || (() => {});
    this.onError = options.onError || (() => {});

    this.currentTrack = null;
    this.isPlaying = false;
    this.positionSec = 0;
    this.durationSec = 0;
    this.lastAnchorTime = 0;
    this.timer = null;
    this.audio = null;
  }

  /**
   * Set and select track from search/charts results, ready for Start or auto-play.
   */
  selectTrack(track, autoStart = false) {
    if (!track) return;

    this.cleanupAudio();

    const duration = (track.durationMs ? track.durationMs / 1000 : track.duration) || 180;
    this.durationSec = duration;
    this.positionSec = 0;
    this.isPlaying = autoStart;
    this.lastAnchorTime = performance.now();

    this.currentTrack = {
      id: track.id || `search_${Date.now()}`,
      durationEstimated: Boolean(track.durationEstimated),
      title: track.title,
      artist: track.artist,
      album: track.album || '',
      albumArt: track.albumArt || '',
      previewUrl: track.previewUrl || null,
      duration: this.durationSec,
      durationMs: Math.round(this.durationSec * 1000),
      position: 0,
      isPlaying: this.isPlaying,
      source: track.source || 'search',
      syncedLyrics: track.syncedLyrics || null,
      plainLyrics: track.plainLyrics || null,
      lrclibId: track.lrclibId || null,
      // Stable ids (Library rows, Spotify-derived lookups) so the same song keeps the same stableId.
      mbid: track.mbid || null,
      isrc: track.isrc || null
    };

    this.onTrackChange(this.currentTrack);

    // Preview audio is opt-in (track.playPreview === true). iTunes previews are ~30s clips
    // taken from somewhere in the middle of the song, so they can't drive a lyric clock that
    // starts at 0:00 — letting them do so showed the wrong lyrics and cut songs off at 30s.
    // By default lyrics run on the full-length clock instead.
    if (track.playPreview === true && typeof Audio !== 'undefined') {
      if (track.previewUrl) {
        this.initAudio(track.previewUrl, autoStart);
      } else if (track.title && track.artist) {
        // Asynchronously discover preview URL if not yet resolved
        const selectedId = this.currentTrack.id;
        this.discoverPreviewUrl(track.artist, track.title).then(purl => {
          if (purl && this.currentTrack && this.currentTrack.id === selectedId) {
            this.currentTrack.previewUrl = purl;
            this.initAudio(purl, this.isPlaying);
          }
        });
      }
    }

    if (autoStart) {
      if (!this.audio) {
        this.startClock();
      }
    }
  }

  initAudio(url, autoPlay = true) {
    if (typeof window === 'undefined' || !url) return;
    this.cleanupAudio();

    try {
      // Prioritize the dedicated DOM audio element to ensure the OS/browser routes audio to the device speaker
      const domAudio = typeof document !== 'undefined' ? document.getElementById('speakerAudioPlayer') : null;
      this.audio = domAudio || (typeof Audio !== 'undefined' ? new Audio() : null);
      if (!this.audio) return;

      // Do NOT set crossOrigin = 'anonymous' because external media CDNs without explicit CORS headers
      // will fail to decode even though simple speaker playback does not require CORS.
      this.audio.preload = 'auto';
      this.audio.volume = 1.0;
      this.audio.muted = false;
      this.audio.src = url;

      this.audio.onplay = () => {
        this.isPlaying = true;
        this.stopClock();
        if (this.currentTrack) {
          this.currentTrack.isPlaying = true;
          this.onPlaybackUpdate(this.currentTrack);
        }
      };

      this.audio.onpause = () => {
        this.isPlaying = false;
        if (this.currentTrack) {
          this.currentTrack.isPlaying = false;
          this.onPlaybackUpdate(this.currentTrack);
        }
      };

      this.audio.ontimeupdate = () => {
        if (!this.audio || !this.currentTrack) return;
        this.positionSec = this.audio.currentTime;
        this.currentTrack.position = this.positionSec;
        this.onPlaybackUpdate(this.currentTrack);
      };

      this.audio.onloadedmetadata = () => {
        if (!this.audio || !this.currentTrack) return;
        if (this.audio.duration && isFinite(this.audio.duration)) {
          this.durationSec = this.audio.duration;
          this.currentTrack.duration = this.durationSec;
          this.currentTrack.durationMs = Math.round(this.durationSec * 1000);
          this.onPlaybackUpdate(this.currentTrack);
        }
      };

      this.audio.onended = () => {
        this.pause();
        if (this.currentTrack) {
          this.positionSec = 0;
          this.currentTrack.position = 0;
          this.onPlaybackUpdate(this.currentTrack);
        }
      };

      this.audio.onerror = async (e) => {
        console.warn('Audio preview playback error, attempting fallback stream:', e);
        if (this.currentTrack && !this.currentTrack._triedFallback && this.currentTrack.title && this.currentTrack.artist) {
          this.currentTrack._triedFallback = true;
          try {
            const fallbackUrl = await this.discoverPreviewUrl(this.currentTrack.artist, this.currentTrack.title);
            if (fallbackUrl && fallbackUrl !== url) {
              console.log('Switching to discovered Apple audio preview stream:', fallbackUrl);
              this.currentTrack.previewUrl = fallbackUrl;
              this.initAudio(fallbackUrl, this.isPlaying);
              return;
            }
          } catch {}
        }
        if (this.isPlaying) {
          this.startClock();
        }
      };

      if (autoPlay) {
        const p = this.audio.play();
        if (p !== undefined) {
          p.catch(err => {
            console.warn('Audio play prevented by browser policy (gesture required):', err);
            this.startClock();
          });
        }
      }
    } catch (err) {
      console.warn('Failed to initialize Audio element:', err);
      if (autoPlay) {
        this.startClock();
      }
    }
  }

  async discoverPreviewUrl(artist, title) {
    try {
      const q = `${artist} ${title}`.trim().slice(0, 100);
      const res = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=song&limit=1`);
      if (res.ok) {
        const data = await res.json();
        if (data.results && data.results[0] && data.results[0].previewUrl) {
          return data.results[0].previewUrl;
        }
      }
    } catch {}
    return null;
  }

  cleanupAudio() {
    if (this.audio) {
      try {
        this.audio.pause();
        this.audio.onplay = null;
        this.audio.onpause = null;
        this.audio.ontimeupdate = null;
        this.audio.onloadedmetadata = null;
        this.audio.onended = null;
        this.audio.onerror = null;
        this.audio.removeAttribute('src');
        this.audio.load();
      } catch {}
      this.audio = null;
    }
  }

  /**
   * Update the track length once the real duration is known (e.g. from LRCLIB).
   */
  setDuration(sec) {
    const d = Number(sec);
    if (!Number.isFinite(d) || d <= 0 || !this.currentTrack) return;
    this.durationSec = d;
    this.currentTrack.duration = d;
    this.currentTrack.durationMs = Math.round(d * 1000);
    this.currentTrack.durationEstimated = false;
  }

  /**
   * Starts or resumes playback
   */
  play() {
    if (!this.currentTrack) return;
    this.isPlaying = true;
    this.lastAnchorTime = performance.now();
    this.currentTrack.isPlaying = true;
    this.currentTrack.position = this.positionSec;

    if (this.audio) {
      const p = this.audio.play();
      if (p !== undefined) {
        p.catch(err => {
          console.warn('Play error:', err);
          this.startClock();
        });
      }
    } else {
      this.startClock();
    }

    this.onPlaybackUpdate(this.currentTrack);
  }

  /**
   * Pauses the playback clock & audio
   */
  pause() {
    if (!this.currentTrack) return;
    this.isPlaying = false;
    if (this.audio) {
      try { this.audio.pause(); } catch {}
    }
    this.stopClock();
    this.currentTrack.isPlaying = false;
    this.currentTrack.position = this.positionSec;
    this.onPlaybackUpdate(this.currentTrack);
  }

  /**
   * Seeks to a specific second
   */
  seek(targetSec) {
    if (!this.currentTrack) return;
    this.positionSec = Math.max(0, Math.min(this.durationSec, targetSec));
    this.lastAnchorTime = performance.now();
    if (this.audio && isFinite(this.positionSec)) {
      try {
        this.audio.currentTime = this.positionSec;
      } catch (err) {
        console.warn('Audio seek error:', err);
      }
    }
    this.currentTrack.position = this.positionSec;
    this.onPlaybackUpdate(this.currentTrack);
  }

  updatePosition() {
    if (!this.isPlaying) return;
    if (this.audio) {
      this.positionSec = this.audio.currentTime;
      return;
    }
    const now = performance.now();
    const elapsed = (now - this.lastAnchorTime) / 1000;
    this.positionSec = Math.min(this.durationSec, this.positionSec + elapsed);
    this.lastAnchorTime = now;
  }

  startClock() {
    this.stopClock();
    this.timer = setInterval(() => {
      if (!this.isPlaying || !this.currentTrack) return;
      this.updatePosition();
      this.currentTrack.position = this.positionSec;
      this.onPlaybackUpdate(this.currentTrack);

      if (this.positionSec >= this.durationSec) {
        this.pause();
      }
    }, 1000);
  }

  stopClock() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  stop() {
    this.cleanupAudio();
    this.stopClock();
    this.isPlaying = false;
    this.currentTrack = null;
    this.positionSec = 0;
    this.onIdle();
  }
}
