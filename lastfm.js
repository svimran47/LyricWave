/**
 * LyricWave Last.fm Live Scrobble Tracker
 * 
 * Tracks the user's currently playing track across Apple Music,
 * YouTube Music, Tidal, Deezer, foobar2000, and any scrobbler-enabled player.
 */

const LASTFM_API_URL = 'https://ws.audioscrobbler.com/2.0/';
const DEFAULT_LASTFM_KEY = 'bb89790d124ab6ab91be569d08e40481'; // LyricWave's own Last.fm API key

export class LastFmSource {
  constructor(options = {}) {
    this.name = 'lastfm';
    this.username = options.username || '';
    this.apiKey = options.apiKey || DEFAULT_LASTFM_KEY;
    this.pollInterval = options.pollInterval || 4000;

    this.onTrackChange = options.onTrackChange || (() => {});
    this.onPlaybackUpdate = options.onPlaybackUpdate || (() => {});
    this.onIdle = options.onIdle || (() => {});
    this.onError = options.onError || (() => {});

    this.timer = null;
    this.isRunning = false;
    this.currentTrackKey = null;
    this.currentTrack = null;
    this.trackStartTime = 0;
    this.consecutiveErrors = 0;
    this.durationCache = new Map(); // "title__artist" -> seconds (0 = unknown)
  }

  /**
   * Validate and format Last.fm username according to official Last.fm specifications:
   * 2-32 characters, starts with a letter, contains only alphanumeric, hyphen, and underscore.
   */
  static isValidUsername(username) {
    if (!username || typeof username !== 'string') return false;
    const trimmed = username.trim();
    return /^[a-zA-Z][a-zA-Z0-9_-]{1,31}$/.test(trimmed);
  }

  setUsername(username) {
    const trimmed = (username || '').trim();
    if (!trimmed) {
      this.username = '';
      return;
    }

    if (!LastFmSource.isValidUsername(trimmed)) {
      throw new Error('Invalid Last.fm username format. Usernames must be 2-32 characters, start with a letter, and contain only letters, numbers, hyphens, or underscores.');
    }

    this.username = trimmed;
    try {
      localStorage.setItem('lyricwave_lastfm_user', this.username);
    } catch (e) {}
  }

  getUsername() {
    try {
      return this.username || localStorage.getItem('lyricwave_lastfm_user') || '';
    } catch (e) {
      return this.username || '';
    }
  }

  start() {
    if (this.isRunning) return;
    this.username = this.getUsername();
    if (!this.username) {
      this.onError('Please enter a Last.fm username to start tracking.');
      return;
    }
    this.isRunning = true;
    this.poll();
  }

  stop() {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.currentTrackKey = null;
    this.currentTrack = null;
    this.onIdle();
  }

  async poll() {
    if (!this.isRunning) return;

    try {
      const track = await this.fetchRecentTrack();
      if (!this.isRunning) return;

      if (track && track.isNowPlaying) {
        const key = `${track.title}__${track.artist}`.toLowerCase();
        const now = performance.now();

        if (key !== this.currentTrackKey) {
          // New track scrobble detected!
          // In Approximate Mode, treat the moment the track changes as position 0
          this.currentTrackKey = key;
          this.trackStartTime = now;

          const providedSec = track.durationSec > 0 ? track.durationSec : 0;
          const durationSec = providedSec || 210; // 3.5m fallback until the real length is known

          this.currentTrack = {
            id: `lastfm_${Date.now()}`,
            title: track.title,
            artist: track.artist,
            album: track.album || '',
            albumArt: track.albumArt || '',
            duration: durationSec,
            position: 0,
            isPlaying: true,
            source: 'lastfm',
            // Last.fm carries MusicBrainz ids for many scrobbles.
            mbid: track.mbid || null,
            artistMbid: track.artistMbid || null,
            isApproximate: true,
            // Lets the engine adopt LRCLIB's real length if Last.fm has none.
            durationEstimated: !providedSec
          };

          this.onTrackChange({ ...this.currentTrack });

          // recenttracks never includes a length, so look it up in the background — otherwise
          // every song "ended" at the 3.5 min fallback and lyrics froze on longer tracks.
          if (!providedSec) {
            this.fetchTrackDuration(track.title, track.artist).then((sec) => {
              if (sec > 0 && this.isRunning && this.currentTrackKey === key && this.currentTrack) {
                this.currentTrack.duration = sec;
                this.currentTrack.durationEstimated = false;
                this.currentTrack.position = Math.min(sec, (performance.now() - this.trackStartTime) / 1000);
                this.onPlaybackUpdate({ ...this.currentTrack });
              }
            });
          }
        } else if (this.currentTrack) {
          // Same track still scrobbling now-playing: emit position update
          const elapsedSec = (now - this.trackStartTime) / 1000;
          this.currentTrack.position = Math.min(this.currentTrack.duration, elapsedSec);
          this.onPlaybackUpdate({ ...this.currentTrack });
        }
      } else {
        if (this.currentTrackKey !== null) {
          this.currentTrackKey = null;
          this.currentTrack = null;
          this.onIdle();
        }
      }
      this.consecutiveErrors = 0;
    } catch (err) {
      this.consecutiveErrors++;
      // Report the first failure only; repeated failures back off quietly instead of
      // showing an alert every 4 seconds while offline.
      if (this.consecutiveErrors === 1) {
        this.onError(err.message);
      }
    }

    if (this.isRunning) {
      const backoff = this.consecutiveErrors > 0
        ? Math.min(60000, this.pollInterval * Math.pow(2, this.consecutiveErrors - 1))
        : this.pollInterval;
      this.timer = setTimeout(() => this.poll(), backoff);
    }
  }

  /**
   * Look up a track's length in seconds via track.getInfo (0 if unknown). Never throws.
   */
  async fetchTrackDuration(title, artist) {
    const cacheKey = `${title}__${artist}`.toLowerCase();
    if (this.durationCache.has(cacheKey)) return this.durationCache.get(cacheKey);
    let sec = 0;
    try {
      const params = new URLSearchParams({
        method: 'track.getInfo',
        track: title,
        artist,
        api_key: this.apiKey,
        autocorrect: '1',
        format: 'json'
      });
      const res = await fetch(`${LASTFM_API_URL}?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        const ms = parseInt(data?.track?.duration, 10);
        if (ms > 0) sec = ms / 1000;
      }
    } catch {}
    this.durationCache.set(cacheKey, sec);
    return sec;
  }

  async fetchRecentTrack() {
    const params = new URLSearchParams({
      method: 'user.getrecenttracks',
      user: this.username,
      api_key: this.apiKey,
      format: 'json',
      limit: '2'
    });

    const res = await fetch(`${LASTFM_API_URL}?${params.toString()}`);
    if (!res.ok) {
      throw new Error(`Last.fm request failed: ${res.status}`);
    }

    const data = await res.json();
    const tracks = data?.recenttracks?.track;
    if (!tracks) return null;

    const trackList = Array.isArray(tracks) ? tracks : [tracks];
    if (trackList.length === 0) return null;

    const latest = trackList[0];
    const isNowPlaying = latest['@attr']?.nowplaying === 'true';

    // Get highest resolution image available
    let art = '';
    if (Array.isArray(latest.image)) {
      const extraLarge = latest.image.find(img => img.size === 'extralarge') || latest.image[latest.image.length - 1];
      art = extraLarge?.['#text'] || '';
    }

    return {
      title: latest.name,
      artist: latest.artist?.['#text'] || latest.artist?.name || '',
      album: latest.album?.['#text'] || '',
      albumArt: art,
      mbid: latest.mbid || '',
      artistMbid: latest.artist?.mbid || '',
      durationSec: 0,
      isNowPlaying
    };
  }
}

// Backward compatibility alias
export const LastFmTracker = LastFmSource;
