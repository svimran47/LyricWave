/**
 * AudD Recognition Provider
 * 
 * Implements the RecognitionProvider interface using AudD's
 * HTTP REST Audio Identification API (https://api.audd.io/).
 * 
 * Supports both custom user API tokens and AudD's public test token ('test').
 * Handles song metadata normalization including Apple Music and Spotify external IDs,
 * as well as timecode / playback offset parsing.
 * 
 * Never logs or stores raw audio.
 */

import { RecognitionProvider } from './base.js';

export class AudDProvider extends RecognitionProvider {
  /**
   * @param {Object} options
   * @param {string} [options.apiToken] - AudD API Token (or 'test' for development)
   * @param {string} [options.endpoint] - Optional custom endpoint (default: https://api.audd.io/)
   */
  constructor(options = {}) {
    super(options);
    this.name = 'audd';
    this.apiToken = (options.apiToken || 'test').trim();
    this.endpoint = (options.endpoint || 'https://api.audd.io/').trim();
  }

  /** The shared 'test' token allows ~10 requests a day, so it doesn't count as configured. */
  isConfigured() {
    return Boolean(this.apiToken) && this.apiToken !== 'test';
  }

  /**
   * Parse AudD timecode string (e.g. "01:23" or "00:45.50" or "01:12:05") into milliseconds
   * @param {string|number|null} timecode
   * @returns {number|null} Offset in milliseconds or null if not available
   */
  static parseTimecodeToMs(timecode) {
    if (typeof timecode === 'number') {
      return Math.round(timecode * 1000);
    }
    if (!timecode || typeof timecode !== 'string') {
      return null;
    }

    const clean = timecode.trim();
    const parts = clean.split(':');
    
    if (parts.length === 2) {
      // MM:SS or MM:SS.mmm
      const mins = parseFloat(parts[0]);
      const secs = parseFloat(parts[1]);
      if (!isNaN(mins) && !isNaN(secs)) {
        return Math.round((mins * 60 + secs) * 1000);
      }
    } else if (parts.length === 3) {
      // HH:MM:SS or HH:MM:SS.mmm
      const hours = parseFloat(parts[0]);
      const mins = parseFloat(parts[1]);
      const secs = parseFloat(parts[2]);
      if (!isNaN(hours) && !isNaN(mins) && !isNaN(secs)) {
        return Math.round((hours * 3600 + mins * 60 + secs) * 1000);
      }
    }

    const directSec = parseFloat(clean);
    if (!isNaN(directSec)) {
      return Math.round(directSec * 1000);
    }

    return null;
  }

  /**
   * Recognize an audio sample via AudD REST API
   * @param {Uint8Array|ArrayBuffer} audioBuffer
   * @returns {Promise<import('./base.js').NormalizedRecognitionResult>}
   */
  async recognize(audioBuffer) {
    if (!this.apiToken) {
      throw new Error('AudD API token is not configured. Please supply AUDD_API_TOKEN or use "test".');
    }

    const uint8 = audioBuffer instanceof Uint8Array ? audioBuffer : new Uint8Array(audioBuffer);
    if (uint8.byteLength === 0) {
      throw new Error('Audio sample is empty.');
    }

    // Construct multipart/form-data payload with audio file
    const formData = new FormData();
    const audioBlob = new Blob([uint8], { type: 'audio/webm' });

    formData.append('file', audioBlob, 'sample.bin');
    formData.append('api_token', this.apiToken);
    formData.append('return', 'apple_music,spotify,deezer');

    const response = await fetch(this.endpoint, {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`AudD request failed with HTTP ${response.status}: ${errText.slice(0, 200)}`);
    }

    const data = await response.json();
    return this.normalizeResponse(data);
  }

  /**
   * Normalize AudD JSON response into standard NormalizedRecognitionResult format
   * 
   * @param {Object} rawData
   * @returns {import('./base.js').NormalizedRecognitionResult}
   */
  normalizeResponse(rawData) {
    if (!rawData) {
      return {
        success: false,
        title: null,
        artist: null,
        album: null,
        duration: 0,
        offsetMs: null,
        confidence: 0,
        provider: this.name,
        raw: null
      };
    }

    // Handle AudD API error payload: { status: 'error', error: { error_code, error_message } }
    if (rawData.status === 'error' && rawData.error) {
      const { error_code, error_message } = rawData.error;
      throw new Error(`AudD API Error [${error_code || 'unknown'}]: ${error_message || 'Unspecified error'}`);
    }

    // Match found: { status: 'success', result: { ... } }
    // If no match found: AudD returns { status: 'success', result: null }
    const match = rawData.result;
    if (!match || (Array.isArray(match) && match.length === 0)) {
      return {
        success: false,
        title: null,
        artist: null,
        album: null,
        duration: 0,
        offsetMs: null,
        confidence: 0,
        provider: this.name,
        raw: null
      };
    }

    // In case result is an array of matches (e.g. enterprise / stream API), take the first item
    const target = Array.isArray(match) ? match[0] : match;

    const title = target.title || 'Unknown Title';
    const artist = target.artist || 'Unknown Artist';
    const album = target.album || '';

    // Duration extraction: check duration in seconds or spotify/apple_music duration_ms
    let duration = 0;
    if (typeof target.duration === 'number') {
      duration = Math.round(target.duration);
    } else if (typeof target.duration === 'string') {
      const parsedDur = parseFloat(target.duration);
      if (!isNaN(parsedDur)) duration = Math.round(parsedDur);
    } else if (target.spotify?.duration_ms) {
      duration = Math.round(target.spotify.duration_ms / 1000);
    } else if (target.apple_music?.durationInMillis) {
      duration = Math.round(target.apple_music.durationInMillis / 1000);
    }

    // Timecode offset (e.g. "01:23")
    const offsetMs = AudDProvider.parseTimecodeToMs(target.timecode);

    // Confidence / Score: AudD returns match score or 100 on verified match
    let confidence = 100;
    if (typeof target.score === 'number') {
      confidence = target.score;
    }

    // Extract Spotify track ID if available
    const spotifyTrackId = target.spotify?.id || null;

    // Canonical names from linked catalogs help lyric lookup (see acrcloud.js).
    const lookupCandidates = [];
    const addCand = (t, a) => {
      if (t && !lookupCandidates.some(c => c.title === t && c.artist === (a || ''))) {
        lookupCandidates.push({ title: String(t), artist: String(a || ''), duration });
      }
    };
    addCand(target.spotify?.name, (target.spotify?.artists || []).map(x => x?.name).filter(Boolean).join(', '));
    addCand(target.apple_music?.name, target.apple_music?.artistName);
    addCand(title, artist);

    return {
      success: true,
      title,
      artist,
      album,
      duration,
      offsetMs,
      confidence,
      provider: this.name,
      lookupCandidates,
      raw: {
        songLink: target.song_link || null,
        releaseDate: target.release_date || null,
        label: target.label || null,
        timecode: target.timecode || null,
        spotifyTrackId,
        appleMusicId: target.apple_music?.id || null,
        isrc: target.apple_music?.isrc || target.spotify?.external_ids?.isrc || target.deezer?.isrc || null,
        deezerId: target.deezer?.id || null
      }
    };
  }
}
