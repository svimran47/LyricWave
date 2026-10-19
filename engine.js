/**
 * LyricWave Unified Sync Engine
 * 
 * Source-agnostic synchronization coordinator.
 * Accepts any music source adhering to the Now Playing interface
 * (title, artist, album, duration, position in seconds, isPlaying).
 * 
 * Handles:
 * - High-precision local clock with performance.now()
 * - Re-anchoring on incoming source updates
 * - Immediate seek and pause detection
 * - Latency calibration offset (-5s to +5s)
 * - LRCLIB synced lyrics fetching & parsing
 * - Active lyric line selection
 */

import { normalizeNowPlaying } from './types.js';
import { fetchLyrics, findActiveLineIndex, getStoredOffsetMs, setStoredOffsetMs } from './lyrics.js';

const SEEK_DRIFT_THRESHOLD_SEC = 1.8; // Drifts larger than 1.8s trigger an instant anchor snap
const DRIFT_NUDGE_FACTOR = 0.25;       // Nudge factor for micro-jitter

export class UnifiedSyncEngine {
  constructor(options = {}) {
    // Callbacks
    this.onTrackChange = options.onTrackChange || (() => {});
    this.onPlaybackChange = options.onPlaybackChange || (() => {});
    this.onLyricsLoaded = options.onLyricsLoaded || (() => {});
    this.onLineChange = options.onLineChange || (() => {});
    this.onTick = options.onTick || (() => {});
    this.onIdle = options.onIdle || (() => {});
    this.onSongEnd = options.onSongEnd || (() => {});
    this.onError = options.onError || (() => {});

    // Active track & playback state (Normalized NowPlaying)
    this.track = null;
    this.isPlaying = false;
    this.durationSec = 0;
    this.durationMs = 0;
    this.rawPositionSec = 0;

    // Local Clock Anchor
    this.anchorLocalTime = 0;  // performance.now() timestamp
    this.anchorPositionSec = 0; // progress in seconds at anchorLocalTime
    this.driftSec = 0;
    this.rafId = null;

    // Latency calibration & lyrics state
    this.offsetMs = getStoredOffsetMs();
    this.lyricsData = null;
    this.activeLineIndex = -1;
    this._lyricsReqId = 0;

    // Current source connection
    this.currentSource = null;

    // Resync clock when returning to foreground tab
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden && this.isPlaying && this.track) {
          this.anchorPositionSec = this.getPositionSeconds();
          this.anchorLocalTime = performance.now();
          if (!this.rafId) this.start();
        }
      });
    }
  }

  /**
   * Connect an external music source (e.g., SpotifySource)
   */
  /**
   * @param {Object|null} source
   * @param {Object} [opts]
   * @param {boolean} [opts.start=true]        Call source.start() after wiring (ignored when
   *                                           the source sets autoStartOnConnect = false, e.g. the mic).
   * @param {boolean} [opts.syncCurrent=true]  Immediately adopt source.currentTrack.
   */
  connectSource(source, { start = true, syncCurrent = true } = {}) {
    if (this.currentSource && typeof this.currentSource.stop === 'function') {
      this.currentSource.stop();
    }

    this.currentSource = source;

    if (!source) return;

    source.onTrackChange = (track) => this.setTrack(track);
    source.onPlaybackUpdate = (track) => this.updatePlayback(track);
    source.onIdle = () => this.handleIdle();

    // Remember the source's own (app-provided) error handler exactly once, so repeated
    // connects don't stack wrappers and fire the same error N times.
    if (!Object.prototype.hasOwnProperty.call(source, '_appOnError')) {
      source._appOnError = typeof source.onError === 'function' ? source.onError : null;
    }
    const appOnError = source._appOnError;
    source.onError = (...args) => {
      if (appOnError) {
        try { appOnError(...args); } catch {}
      }
      this.onError(...args);
    };

    // If source already has an active track, sync immediately
    if (syncCurrent && source.currentTrack) {
      this.setTrack(source.currentTrack, source.currentTrack.isPlaying);
    }

    if (start && source.autoStartOnConnect !== false && typeof source.start === 'function') {
      source.start();
    }
  }

  start() {
    if (!this.rafId && typeof requestAnimationFrame === 'function') {
      this.loop = this.loop.bind(this);
      this.rafId = requestAnimationFrame(this.loop);
    }
  }

  stop() {
    if (this.rafId) {
      if (typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(this.rafId);
      }
      this.rafId = null;
    }
    if (this.currentSource && typeof this.currentSource.stop === 'function') {
      this.currentSource.stop();
    }
  }

  /**
   * Set or change active track (Accepts any object conforming to NowPlaying interface)
   */
  async setTrack(trackData, autoPlay = true, forceReload = false) {
    if (!trackData) return;

    const normalized = normalizeNowPlaying(trackData);
    const hasValidLyrics = this.lyricsData && 
      (this.lyricsData.status === 'synced' || this.lyricsData.status === 'plain' || this.lyricsData.status === 'instrumental');
    const isNew = forceReload || !this.track || this.track.id !== normalized.id || !hasValidLyrics;

    this.track = normalized;
    this.durationSec = normalized.duration || 180;
    this.durationMs = Math.round(this.durationSec * 1000);
    this.rawPositionSec = normalized.position || 0;
    this.isPlaying = typeof normalized.isPlaying === 'boolean' ? normalized.isPlaying : autoPlay;

    // Anchor clock
    const now = performance.now();
    this.anchorPositionSec = this.rawPositionSec;
    this.anchorLocalTime = now;
    this.driftSec = 0;
    this.activeLineIndex = -1;

    // Ensure the animation & sync loop is running
    this.start();

    if (isNew) {
      if (normalized.source) {
        this.loadOffsetForSource(normalized.source);
      }
      this.lyricsData = null;
      try {
        this.onTrackChange(this.track);
      } catch (err) {
        console.error('UnifiedSyncEngine: onTrackChange callback error:', err);
      }
      try {
        this.onPlaybackChange(this.isPlaying);
      } catch (err) {
        console.error('UnifiedSyncEngine: onPlaybackChange callback error:', err);
      }

      // Track request monotonically so rapid track/playback updates cannot orphan or freeze lyrics
      const currentReqId = ++this._lyricsReqId;

      try {
        this.lyricsData = { status: 'loading' };
        try {
          this.onLyricsLoaded(this.lyricsData);
        } catch (cbErr) {
          console.error('UnifiedSyncEngine: onLyricsLoaded callback error:', cbErr);
        }

        const lyrics = await fetchLyrics(this.lyricsRequest());

        // Accept lyrics if this is still the active request OR track title/artist match
        if (currentReqId === this._lyricsReqId || 
            (this.track && this.track.title.toLowerCase() === normalized.title.toLowerCase() && 
             this.track.artist.toLowerCase() === normalized.artist.toLowerCase())) {
          this.lyricsData = lyrics || {
            status: 'not_found',
            message: 'No synced lyrics found on LRCLIB.'
          };
          this.adoptLyricsDuration(this.lyricsData);
          this.onLyricsLoaded(this.lyricsData);
        }
      } catch (err) {
        if (currentReqId === this._lyricsReqId || 
            (this.track && this.track.title.toLowerCase() === normalized.title.toLowerCase())) {
          this.lyricsData = { status: 'error', message: err?.message || 'Unable to load lyrics.' };
          this.onLyricsLoaded(this.lyricsData);
        }
      }
    } else {
      this.onPlaybackChange(this.isPlaying);
    }
  }

  /** What lyrics.js needs to find this track's lyrics (duration in ms). */
  lyricsRequest() {
    return {
      id: this.track.id,
      title: this.track.title,
      artist: this.track.artist,
      artists: this.track.artist,
      album: this.track.album,
      durationMs: this.durationSec * 1000,
      durationEstimated: Boolean(this.track.durationEstimated),
      lookupCandidates: this.track.lookupCandidates,
      syncedLyrics: this.track.syncedLyrics,
      plainLyrics: this.track.plainLyrics,
      lrclibId: this.track.lrclibId,
      stableId: this.track.stableId,
      openTrack: this.track.openTrack
    };
  }

  /**
   * Fetch the current track's lyrics again without treating it as a new song (no track-change
   * callbacks, no extra play in the library). Used after the user saves or removes their lyrics.
   */
  async reloadLyrics() {
    if (!this.track) return;
    const reqId = ++this._lyricsReqId;
    const trackId = this.track.id;
    try {
      const lyrics = await fetchLyrics(this.lyricsRequest());
      if (reqId !== this._lyricsReqId || !this.track || this.track.id !== trackId) return;
      this.lyricsData = lyrics || { status: 'not_found', message: 'No synced lyrics found on LRCLIB.' };
    } catch (err) {
      if (reqId !== this._lyricsReqId) return;
      this.lyricsData = { status: 'error', message: err?.message || 'Unable to load lyrics.' };
    }
    this.activeLineIndex = -1;
    this.adoptLyricsDuration(this.lyricsData);
    this.onLyricsLoaded(this.lyricsData);
  }

  /**
   * When the track's duration was only a guess (chart entries, mic results without a
   * length), use the real song length that LRCLIB reports so lyrics don't stop early.
   */
  adoptLyricsDuration(lyrics) {
    const realSec = Number(lyrics?.durationSec) || 0;
    if (!this.track || !this.track.durationEstimated || realSec <= 0) return;
    this.durationSec = realSec;
    this.durationMs = Math.round(realSec * 1000);
    this.track.duration = realSec;
    this.track.durationEstimated = false;
    if (this.currentSource && typeof this.currentSource.setDuration === 'function') {
      try { this.currentSource.setDuration(realSec); } catch {}
    }
  }

  /**
   * Receive continuous playback updates from source
   */
  updatePlayback(trackData) {
    if (!trackData) return;
    const normalized = normalizeNowPlaying(trackData);

    if (!this.track || 
        (this.track.id !== normalized.id && 
         (this.track.title.toLowerCase() !== normalized.title.toLowerCase() || 
          this.track.artist.toLowerCase() !== normalized.artist.toLowerCase()))) {
      this.setTrack(normalized, normalized.isPlaying);
      return;
    }

    const wasPlaying = this.isPlaying;
    const isPlaying = normalized.isPlaying;
    this.isPlaying = isPlaying;
    this.durationSec = normalized.duration || this.durationSec;
    this.durationMs = Math.round(this.durationSec * 1000);
    this.rawPositionSec = normalized.position;

    const now = performance.now();

    if (wasPlaying !== isPlaying) {
      // Pause/Resume state changed: re-anchor immediately
      this.anchorPositionSec = this.rawPositionSec;
      this.anchorLocalTime = now;
      this.driftSec = 0;
      this.onPlaybackChange(isPlaying);
    } else if (isPlaying) {
      // Re-anchor clock with drift checking
      const localPredictedSec = this.anchorPositionSec + ((now - this.anchorLocalTime) / 1000);
      const drift = this.rawPositionSec - localPredictedSec;
      this.driftSec = drift;

      if (Math.abs(drift) > SEEK_DRIFT_THRESHOLD_SEC) {
        // Intentional seek: snap clock instantly
        this.anchorPositionSec = this.rawPositionSec;
        this.anchorLocalTime = now;
      } else {
        // Gentle micro-nudge
        this.anchorPositionSec += (drift * DRIFT_NUDGE_FACTOR);
      }
    } else {
      // Paused: hold position firmly
      this.anchorPositionSec = this.rawPositionSec;
      this.anchorLocalTime = now;
      this.driftSec = 0;
    }
  }

  handleIdle() {
    this.track = null;
    this.isPlaying = false;
    this.durationSec = 0;
    this.durationMs = 0;
    this.anchorPositionSec = 0;
    this.rawPositionSec = 0;
    this.lyricsData = null;
    this.activeLineIndex = -1;
    this.onIdle();
  }

  play() {
    if (!this.track || this.isPlaying) return;
    this.isPlaying = true;
    this.anchorLocalTime = performance.now();
    this.start();
    if (this.currentSource && typeof this.currentSource.play === 'function') {
      try { this.currentSource.play(); } catch {}
    }
    this.onPlaybackChange(true);
  }

  pause() {
    if (!this.track || !this.isPlaying) return;
    this.anchorPositionSec = this.getPositionSeconds();
    this.anchorLocalTime = performance.now();
    this.isPlaying = false;
    if (this.currentSource && typeof this.currentSource.pause === 'function') {
      try { this.currentSource.pause(); } catch {}
    }
    this.onPlaybackChange(false);
  }

  togglePlay() {
    if (this.isPlaying) {
      this.pause();
    } else {
      this.play();
    }
  }

  /**
   * Seek to an absolute position in SECONDS. (Use seekMs() for milliseconds — units are
   * never guessed, because guessing sent sub-second lyric taps to the end of the song.)
   */
  seek(targetSec) {
    if (!this.track) return;
    const targetNum = Number(targetSec);
    if (!Number.isFinite(targetNum)) return;
    const clampedSec = Math.max(0, Math.min(this.durationSec, targetNum));
    this.anchorPositionSec = clampedSec;
    this.anchorLocalTime = performance.now();
    this.activeLineIndex = -1;
    if (this.currentSource && typeof this.currentSource.seek === 'function') {
      try { this.currentSource.seek(clampedSec); } catch {}
    }
  }

  /** Seek to an absolute position in MILLISECONDS. */
  seekMs(targetMs) {
    const ms = Number(targetMs);
    if (!Number.isFinite(ms)) return;
    this.seek(ms / 1000);
  }

  /** Relative seek in SECONDS (negative = backwards). */
  seekBy(deltaSec) {
    const deltaNum = Number(deltaSec);
    if (!Number.isFinite(deltaNum)) return;
    this.seek(this.getPositionSeconds() + deltaNum);
  }

  setOffset(newOffsetMs, source = null) {
    const src = source || this.track?.source || this.currentSource?.name || null;
    this.offsetMs = setStoredOffsetMs(newOffsetMs, src);
  }

  loadOffsetForSource(source) {
    if (!source) return;
    this.offsetMs = getStoredOffsetMs(source);
  }

  getOffset() {
    return this.offsetMs;
  }

  /**
   * Get estimated position in seconds using local clock
   */
  getPositionSeconds() {
    if (!this.track) return 0;
    if (!this.isPlaying) return Math.min(this.durationSec, this.anchorPositionSec);

    const elapsedSec = (performance.now() - this.anchorLocalTime) / 1000;
    const current = this.anchorPositionSec + elapsedSec;
    return Math.max(0, Math.min(this.durationSec, current));
  }

  getPositionMs() {
    return Math.round(this.getPositionSeconds() * 1000);
  }

  getEffectivePositionMs() {
    return this.getPositionMs() + this.offsetMs;
  }

  loop() {
    if (this.track && (typeof document === 'undefined' || !document.hidden)) {
      const positionSec = this.getPositionSeconds();
      const positionMs = Math.round(positionSec * 1000);
      const effectiveMs = positionMs + this.offsetMs;
      const durationMs = Math.round(this.durationSec * 1000);
      const progressPercent = durationMs > 0 ? Math.min(100, (positionMs / durationMs) * 100) : 0;

      // Handle song finish
      if (this.isPlaying && positionSec >= this.durationSec && this.durationSec > 0) {
        // Reset the lyric clock locally only. Telling the source to pause/seek here would
        // pause or restart the user's music app (Phone source) right as it moves on to the
        // next song; sources that own a clock (Search) already stop themselves at the end.
        this.isPlaying = false;
        this.anchorPositionSec = 0;
        this.anchorLocalTime = performance.now();
        this.activeLineIndex = -1;
        this.onPlaybackChange(false);
        this.onSongEnd(this.track);
      }

      // Check active lyric line
      if (this.lyricsData && this.lyricsData.status === 'synced' && this.lyricsData.syncedLines.length > 0) {
        const nextActiveIdx = findActiveLineIndex(this.lyricsData.syncedLines, effectiveMs);
        if (nextActiveIdx !== this.activeLineIndex) {
          this.activeLineIndex = nextActiveIdx;
          this.onLineChange(this.activeLineIndex, this.lyricsData.syncedLines[this.activeLineIndex] || null);
        }
      }

      // Tick notification
      this.onTick({
        positionSec,
        positionMs,
        rawMs: Math.round(this.rawPositionSec * 1000),
        effectiveMs,
        durationMs,
        durationSec: this.durationSec,
        progressPercent,
        isPlaying: this.isPlaying,
        driftMs: Math.round(this.driftSec * 1000),
        activeLineIndex: this.activeLineIndex
      });
    }

    if (this.rafId !== null) {
      // Idle (no track): let the loop sleep instead of waking 60x/second. setTrack() and
      // play() call start() again, which resumes it.
      this.rafId = this.track ? requestAnimationFrame(this.loop) : null;
    }
  }
}
