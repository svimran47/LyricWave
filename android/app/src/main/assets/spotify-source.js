/**
 * Spotify Music Source Module
 * 
 * Implements the Now Playing interface for Spotify Connect.
 * Polls currently-playing endpoint every 3 seconds, handles rate limiting,
 * edge cases (ads, podcasts, private sessions, 204 idle), and emits
 * normalized NowPlaying events.
 */

import { getValidAccessToken } from './auth.js';
import { normalizeNowPlaying } from './types.js';

const SPOTIFY_CURRENTLY_PLAYING_ENDPOINT = 'https://api.spotify.com/v1/me/player/currently-playing';
const DEFAULT_POLL_INTERVAL_MS = 3000;

export class SpotifySource {
  constructor(options = {}) {
    this.pollInterval = options.pollInterval || DEFAULT_POLL_INTERVAL_MS;

    // Callbacks implementing source contract
    this.onTrackChange = options.onTrackChange || (() => {});
    this.onPlaybackUpdate = options.onPlaybackUpdate || (() => {});
    this.onIdle = options.onIdle || (() => {});
    this.onError = options.onError || (() => {});

    // State
    this.isRunning = false;
    this.pollTimer = null;
    this.currentTrackId = null;
    this.currentTrack = null;
    this.lastLatencyMs = 0;
    this.lastPollStatus = 'Idle';
    this.isRateLimited = false;
    this.rateLimitResetTime = 0;
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.pollNow();
  }

  stop() {
    this.isRunning = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.currentTrackId = null;
    this.currentTrack = null; // don't replay a stale track on the next connect
  }

  async pollNow() {
    if (!this.isRunning) return;

    if (this.isRateLimited) {
      const waitRemaining = this.rateLimitResetTime - Date.now();
      if (waitRemaining > 0) {
        this.scheduleNextPoll(waitRemaining);
        return;
      }
      this.isRateLimited = false;
    }

    await this.fetchCurrentlyPlaying();

    if (this.isRunning) {
      this.scheduleNextPoll(this.pollInterval);
    }
  }

  scheduleNextPoll(delayMs) {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      this.pollNow();
    }, Math.max(500, delayMs));
  }

  async fetchCurrentlyPlaying() {
    let token;
    try {
      token = await getValidAccessToken();
    } catch (err) {
      // Transient (network) refresh failure: stay connected and retry on the next poll.
      this.lastPollStatus = `Token refresh deferred (${err.message})`;
      return;
    }
    if (!this.isRunning) return;
    if (!token) {
      this.lastPollStatus = 'No valid token';
      this.onError(new Error('Spotify session expired or not authenticated.'));
      return;
    }

    const startTime = performance.now();

    try {
      const response = await fetch(SPOTIFY_CURRENTLY_PLAYING_ENDPOINT, {
        headers: {
          Authorization: `Bearer ${token}`
        }
      });

      const roundTripMs = performance.now() - startTime;
      this.lastLatencyMs = Math.round(roundTripMs / 2);

      if (!this.isRunning) return;

      // 204 No Content: Nothing playing
      if (response.status === 204) {
        this.lastPollStatus = '204 No Content (Idle)';
        this.handleNothingPlaying();
        return;
      }

      // 429 Too Many Requests: Rate Limited
      if (response.status === 429) {
        const retryAfterSeconds = parseInt(response.headers.get('Retry-After') || '5', 10);
        this.isRateLimited = true;
        this.rateLimitResetTime = Date.now() + (retryAfterSeconds * 1000);
        this.lastPollStatus = `429 Rate Limited (Wait ${retryAfterSeconds}s)`;
        console.warn(`Spotify API rate limit hit. Backing off for ${retryAfterSeconds}s.`);
        return;
      }

      if (!response.ok) {
        this.lastPollStatus = `HTTP ${response.status} ${response.statusText}`;
        console.warn('Spotify currently-playing error:', response.status);
        return;
      }

      const data = await response.json();
      // Source may have been stopped (user switched source) while this request was in flight.
      if (!this.isRunning) return;
      this.lastPollStatus = '200 OK';
      this.processPlaybackData(data, roundTripMs);

    } catch (err) {
      this.lastPollStatus = `Network Error (${err.message})`;
      console.warn('Polling network error:', err);
    }
  }

  processPlaybackData(data, roundTripMs) {
    const isPlaying = Boolean(data.is_playing);
    const currentlyPlayingType = data.currently_playing_type || 'unknown';
    const reportedProgressMs = data.progress_ms || 0;
    const latencyCompMs = isPlaying ? Math.round(roundTripMs / 2) : 0;
    const adjustedProgressMs = reportedProgressMs + latencyCompMs;

    // Edge Case: Advertisement
    if (currentlyPlayingType === 'ad' || (!data.item && isPlaying)) {
      const adTrack = normalizeNowPlaying({
        id: 'spotify-ad',
        title: 'Advertisement',
        artist: 'Spotify',
        album: 'Commercial Break',
        albumArt: '',
        duration: (data.item?.duration_ms || 30000) / 1000,
        position: reportedProgressMs / 1000,
        isPlaying,
        source: 'spotify',
        playbackType: 'ad'
      });

      this.emitTrack(adTrack);
      return;
    }

    // Edge Case: Episode / Podcast
    if (currentlyPlayingType === 'episode') {
      const item = data.item;
      const podcastTrack = normalizeNowPlaying({
        id: item?.id || 'podcast-episode',
        title: item?.name || 'Podcast Episode',
        artist: item?.show?.name || 'Podcast',
        album: item?.show?.publisher || 'Spotify Podcast',
        albumArt: item?.images?.[0]?.url || item?.show?.images?.[0]?.url || '',
        duration: (item?.duration_ms || 0) / 1000,
        position: Math.min(item?.duration_ms || 0, adjustedProgressMs) / 1000,
        isPlaying,
        source: 'spotify',
        playbackType: 'episode'
      });

      this.emitTrack(podcastTrack);
      return;
    }

    const item = data.item;
    if (!item) {
      this.handleNothingPlaying();
      return;
    }

    const trackId = item.id || `${item.name}-${item.artists?.[0]?.name}`;
    const durationMs = item.duration_ms || 0;

    const track = normalizeNowPlaying({
      id: trackId,
      title: item.name,
      artist: item.artists?.map(a => a.name).join(', ') || 'Unknown Artist',
      album: item.album?.name || '',
      albumArt: item.album?.images?.[0]?.url || item.album?.images?.[1]?.url || '',
      duration: durationMs / 1000,
      position: Math.min(durationMs, adjustedProgressMs) / 1000,
      isPlaying,
      source: 'spotify',
      playbackType: 'track',
      isrc: item.external_ids?.isrc || null
    });

    this.emitTrack(track);
  }

  emitTrack(nowPlayingTrack) {
    const isNew = nowPlayingTrack.id !== this.currentTrackId;
    this.currentTrackId = nowPlayingTrack.id;
    this.currentTrack = nowPlayingTrack;

    if (isNew) {
      this.onTrackChange(nowPlayingTrack);
    }
    this.onPlaybackUpdate(nowPlayingTrack);
  }

  handleNothingPlaying() {
    const wasPlaying = this.currentTrackId !== null;
    this.currentTrackId = null;
    this.currentTrack = null;

    if (wasPlaying) {
      this.onIdle();
    }
  }
}
