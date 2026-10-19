/**
 * LyricWave Microphone Recognition Source Module
 *
 * Implements the Now Playing input source contract.
 * - Requests mic permission strictly on explicit user gesture (or the opt-in auto re-listen timer).
 * - Captures raw PCM straight from the Web Audio graph (no MediaRecorder/WebM round trip), with a
 *   live level meter and countdown.
 * - Fingerprints the audio IN THE BROWSER (shazam-core.js) and sends only the few-KB Shazam
 *   signature. Raw audio is uploaded only if the user picked an audio-based provider
 *   (ACRCloud / AudD). Progressive attempts (4 s, 8 s, 12 s) answer most songs after 4 s.
 * - The desktop app queries Shazam from its main process (no CORS, no server hop); everything else
 *   goes through /api/recognize.
 * - Tracks are closed as soon as capture ends so the OS mic indicator turns off.
 */

import { normalizeNowPlaying } from './types.js';
import { CONFIG } from './config.js';
import {
  SAMPLE_RATE,
  MAX_SIGNATURE_SECONDS,
  createSignatureFromPcm,
  encode16kWav,
  floatToInt16,
  resampleTo16k,
  normalizeShazamResponse
} from './shazam-core.js';

/** Seconds of audio at which a recognition attempt is made. */
export const DEFAULT_ATTEMPT_SECONDS = [4, 8, 12];
const REQUEST_TIMEOUT_MS = 15000;
const SILENCE_LEVEL = 0.005;
const PROCESSOR_BUFFER = 4096;

/**
 * Song position (seconds) "now" for a recognition result.
 *
 * Shazam's offset is the song time at the START of the fingerprinted sample (offsetRef 'start');
 * ACRCloud/AudD report it at the END of the sample. Either way we then add the wall time that has
 * passed since that point of the sample was captured.
 *
 * @param {{offsetMs:number|null, offsetRef?:string}} result
 * @param {{sampleMs:number, captureEndAt:number, now:number}} timing  (ms, same clock)
 * @returns {number|null} seconds, or null when the provider gave no offset
 */
export function computeTrackPosition(result, timing) {
  if (!result || typeof result.offsetMs !== 'number' || !Number.isFinite(result.offsetMs)) return null;
  const sinceCaptureEnd = Math.max(0, timing.now - timing.captureEndAt);
  const sinceAnchor = result.offsetRef === 'start'
    ? sinceCaptureEnd + Math.max(0, timing.sampleMs)
    : sinceCaptureEnd;
  return Math.max(0, (result.offsetMs + sinceAnchor) / 1000);
}

function nowMs() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Resample captured float audio to 16 kHz Int16 (OfflineAudioContext when available). */
async function toPcm16k(float32, inputRate) {
  const Offline = typeof window !== 'undefined' && (window.OfflineAudioContext || window.webkitOfflineAudioContext);
  if (Offline && inputRate !== SAMPLE_RATE && float32.length > 0) {
    try {
      const frames = Math.max(1, Math.floor((float32.length * SAMPLE_RATE) / inputRate));
      const offline = new Offline(1, frames, SAMPLE_RATE);
      const buf = offline.createBuffer(1, float32.length, inputRate);
      buf.getChannelData(0).set(float32);
      const src = offline.createBufferSource();
      src.buffer = buf;
      src.connect(offline.destination);
      src.start(0);
      const rendered = await offline.startRendering();
      return floatToInt16(rendered.getChannelData(0));
    } catch {
      // fall through to the JS resampler
    }
  }
  return floatToInt16(resampleTo16k(float32, inputRate));
}

export class MicSource {
  /**
   * @param {Object} options
   * @param {Function} options.onStatusChange - (statusText, statusType) => void
   * @param {Function} options.onAudioLevel - (normalizedLevel 0-1) => void
   * @param {Function} options.onCountdown - (secondsRemaining, totalSeconds) => void
   * @param {Function} options.onTrackChange - (nowPlayingTrack) => void
   * @param {Function} options.onError - (errorMessage, errorType) => void
   * @param {Function} options.onListeningStateChange - (isListening: boolean) => void
   * @param {number[]} [options.attemptSeconds] - capture lengths at which to try recognition
   */
  constructor(options = {}) {
    this.name = 'mic';
    // Recording must only ever begin from an explicit user action (or the opt-in
    // auto re-listen timer). Never let the sync engine start the mic on connect.
    this.autoStartOnConnect = false;
    this.onStatusChange = options.onStatusChange || (() => {});
    this.onAudioLevel = options.onAudioLevel || (() => {});
    this.onCountdown = options.onCountdown || (() => {});
    this.onTrackChange = options.onTrackChange || (() => {});
    // UI hook fired before onTrackChange when a song is identified. Kept separate from
    // onTrackChange because the sync engine replaces onTrackChange when it connects.
    this.onIdentified = options.onIdentified || (() => {});
    this.onError = options.onError || (() => {});
    this.onListeningStateChange = options.onListeningStateChange || (() => {});
    this.onPlaybackUpdate = options.onPlaybackUpdate || (() => {});

    // State
    this.isListening = false;
    this.isCancelled = false;
    this.currentTrack = null;
    this.audioStream = null;
    this.audioContext = null;
    this.analyser = null;
    this.processor = null;
    this.sinkGain = null;
    this.mediaRecorder = null; // legacy capture path (no ScriptProcessor support)
    this.audioChunks = [];
    this.pcmChunks = [];
    this.pcmFrames = 0;
    this.captureRate = 48000;
    this.recognitionController = null; // AbortController for the in-flight recognition call
    this.rafId = null;
    this.countdownTimer = null;
    this.maxVolumeObserved = 0;
    this.session = 0; // bumps on every start/stop so stale async work can tell it is obsolete
    this.recordStartTime = 0;
    this.roundTripLatencyMs = 0;

    // Auto Re-listen every 2 minutes (120,000ms)
    this.autoRelistenEnabled = false;
    this.autoRelistenTimer = null;
    this.autoRelistenIntervalMs = 2 * 60 * 1000;
    // Recognition provider override ('shazam', 'acrcloud', 'audd')
    this.provider = options.provider || (typeof localStorage !== 'undefined' ? localStorage.getItem('lyricwave_recognition_provider') : null) || null;

    const attempts = Array.isArray(options.attemptSeconds) && options.attemptSeconds.length
      ? options.attemptSeconds
      : (Number(options.sampleDurationSec) > 0 ? [Number(options.sampleDurationSec)] : DEFAULT_ATTEMPT_SECONDS);
    this.attemptSeconds = [...attempts].map(Number).filter((s) => s > 0).sort((a, b) => a - b);
    /** Longest capture (seconds) before giving up. */
    this.sampleDurationSec = this.attemptSeconds[this.attemptSeconds.length - 1];
  }

  /**
   * Set and persist active recognition provider ('shazam', 'acrcloud', 'audd')
   * @param {string} providerName
   */
  setProvider(providerName) {
    this.provider = providerName || null;
    if (typeof localStorage !== 'undefined') {
      if (providerName) {
        localStorage.setItem('lyricwave_recognition_provider', providerName);
      } else {
        localStorage.removeItem('lyricwave_recognition_provider');
      }
    }
  }

  /**
   * Browser feature support check (Safari iOS, Chrome Android, Desktop)
   */
  static isSupported() {
    return Boolean(
      typeof navigator !== 'undefined' &&
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === 'function' &&
      (typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : true)
    );
  }

  /**
   * Check if consent has already been acknowledged this session or in localStorage
   */
  static hasConsent() {
    if (typeof localStorage === 'undefined') return true;
    return localStorage.getItem('lyricwave_mic_consent') === 'true';
  }

  static setConsent(granted) {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('lyricwave_mic_consent', granted ? 'true' : 'false');
    }
  }

  /**
   * Start a listening cycle: capture up to `sampleDurationSec` seconds, trying recognition at
   * every entry of `attemptSeconds`, and stop at the first match.
   */
  async start() {
    if (this.isListening) return;

    if (!MicSource.isSupported()) {
      this.onError('Microphone recording is not supported in this browser. Please try Chrome, Safari, or Firefox.', 'unsupported');
      return;
    }

    const session = ++this.session;
    this.isCancelled = false;
    try {
      this.onStatusChange('Requesting microphone access...', 'working');
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // Processing meant for voice calls smears music; keep the signal as raw as possible.
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: true,
          channelCount: 1
        }
      });
      if (session !== this.session || this.isCancelled) {
        stream.getTracks().forEach((t) => { try { t.stop(); } catch {} });
        return;
      }
      this.audioStream = stream;
      this.isListening = true;
      this.onListeningStateChange(true);
      this.maxVolumeObserved = 0;

      this.setupAudioGraph();
      this.runCapture(session);
    } catch (err) {
      this.stop();
      const errName = err.name || '';
      if (errName === 'NotAllowedError' || errName === 'PermissionDeniedError') {
        this.onError('Microphone permission was denied. Tap "Listen" and allow microphone access in your browser settings to identify songs.', 'denied');
      } else if (errName === 'NotFoundError' || errName === 'DevicesNotFoundError') {
        this.onError('No microphone was found on this device.', 'no_device');
      } else {
        this.onError(`Microphone error: ${err.message || 'Unable to access audio input.'}`, 'error');
      }
    }
  }

  /**
   * Web Audio graph: source -> analyser (level meter) and source -> ScriptProcessor (PCM capture)
   * -> muted gain -> destination (processors only run while connected to the destination).
   */
  setupAudioGraph() {
    this.pcmChunks = [];
    this.pcmFrames = 0;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    this.audioContext = new AudioCtx();
    if (this.audioContext.state === 'suspended') this.audioContext.resume().catch(() => {});
    this.captureRate = this.audioContext.sampleRate || 48000;

    const source = this.audioContext.createMediaStreamSource(this.audioStream);
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 64;
    this.analyser.smoothingTimeConstant = 0.75;
    source.connect(this.analyser);

    if (typeof this.audioContext.createScriptProcessor === 'function') {
      this.processor = this.audioContext.createScriptProcessor(PROCESSOR_BUFFER, 1, 1);
      this.sinkGain = this.audioContext.createGain();
      this.sinkGain.gain.value = 0;
      this.processor.onaudioprocess = (e) => {
        if (!this.isListening) return;
        const data = e.inputBuffer.getChannelData(0);
        this.pcmChunks.push(new Float32Array(data));
        this.pcmFrames += data.length;
      };
      source.connect(this.processor);
      this.processor.connect(this.sinkGain);
      this.sinkGain.connect(this.audioContext.destination);
    } else {
      this.startLegacyRecorder();
    }

    const bins = new Uint8Array(this.analyser.frequencyBinCount);
    const meterLoop = () => {
      if (!this.isListening || !this.analyser) return;
      this.analyser.getByteFrequencyData(bins);
      let sum = 0;
      for (let i = 0; i < bins.length; i++) sum += bins[i];
      const normalized = Math.min(1, sum / bins.length / 120);
      if (normalized > this.maxVolumeObserved) this.maxVolumeObserved = normalized;
      this.onAudioLevel(normalized);
      this.rafId = requestAnimationFrame(meterLoop);
    };
    this.rafId = requestAnimationFrame(meterLoop);
  }

  /** Browsers without ScriptProcessorNode: record with MediaRecorder and decode afterwards. */
  startLegacyRecorder() {
    if (typeof MediaRecorder === 'undefined') return;
    const mime = ['audio/webm', 'audio/mp4', 'audio/ogg'].find((m) => MediaRecorder.isTypeSupported?.(m)) || '';
    this.audioChunks = [];
    this.mediaRecorder = new MediaRecorder(this.audioStream, mime ? { mimeType: mime } : {});
    this.mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) this.audioChunks.push(e.data); };
    this.mediaRecorder.start(250);
  }

  /** Decode the legacy recorder's chunks into mono float PCM at the context rate. */
  async decodeLegacyRecording() {
    const rec = this.mediaRecorder;
    if (!rec) return;
    if (rec.state === 'recording') {
      await new Promise((resolve) => {
        rec.onstop = resolve;
        try { rec.stop(); } catch { resolve(); }
      });
    }
    const blob = new Blob(this.audioChunks, { type: rec.mimeType || 'audio/webm' });
    this.audioChunks = [];
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioCtx();
    try {
      const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
      const ch0 = decoded.getChannelData(0);
      this.pcmChunks = [new Float32Array(ch0)];
      this.pcmFrames = ch0.length;
      this.captureRate = decoded.sampleRate;
    } catch {
      // leave pcm empty: reported as a capture failure
    } finally {
      ctx.close().catch(() => {});
    }
  }

  /** Newest `seconds` of captured audio as one Float32Array. */
  snapshotPcm(seconds) {
    const want = Math.min(this.pcmFrames, Math.floor(seconds * this.captureRate));
    const out = new Float32Array(want);
    let write = want;
    for (let i = this.pcmChunks.length - 1; i >= 0 && write > 0; i--) {
      const chunk = this.pcmChunks[i];
      const take = Math.min(chunk.length, write);
      out.set(chunk.subarray(chunk.length - take), write - take);
      write -= take;
    }
    return out;
  }

  /**
   * Countdown + progressive recognition. Attempts never overlap: if one is still in flight when
   * the next checkpoint arrives, the next one runs as soon as it returns.
   */
  async runCapture(session) {
    const total = this.sampleDurationSec;
    const attempts = [...this.attemptSeconds];
    const legacy = !this.processor;
    this.recordStartTime = nowMs();
    let lastResult = null;
    let lastError = null;

    const alive = () => session === this.session && !this.isCancelled;
    const elapsedSec = () => (nowMs() - this.recordStartTime) / 1000;

    let shown = -1;
    const tick = () => {
      if (!alive()) return;
      const remaining = Math.max(0, Math.ceil(total - elapsedSec()));
      if (remaining !== shown) {
        shown = remaining;
        this.onCountdown(remaining, total);
        if (this.isListening && remaining > 0) this.onStatusChange(`Listening to room audio (${remaining}s)...`, 'working');
      }
    };
    tick();
    this.countdownTimer = setInterval(tick, 200);

    for (let a = 0; a < attempts.length; a++) {
      const isLast = a === attempts.length - 1;
      const waitMs = attempts[a] * 1000 - (nowMs() - this.recordStartTime);
      if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
      if (!alive()) return;

      if (legacy) {
        if (!isLast) continue; // the legacy recorder can only be decoded once, at the end
        await this.decodeLegacyRecording();
        if (!alive()) return;
      }

      if (isLast) this.finishCapture();
      if (this.pcmFrames === 0) {
        lastError = { message: 'No audio reached LyricWave from the microphone. Check that the right input device is selected.', type: 'error' };
        if (isLast) break;
        continue;
      }
      if (this.maxVolumeObserved > 0 && this.maxVolumeObserved < SILENCE_LEVEL) {
        if (!isLast) continue;
        this.failWith('The recorded audio was too quiet to detect music. Please bring your device closer to the music speaker and try again.', 'too_quiet');
        return;
      }

      const captureEndAt = nowMs() - (PROCESSOR_BUFFER / this.captureRate) * 1000;
      this.onStatusChange(isLast ? 'Analyzing audio fingerprint...' : `Matching (${attempts[a]}s sample)...`, 'working');
      try {
        const float = this.snapshotPcm(MAX_SIGNATURE_SECONDS);
        const pcm = await toPcm16k(float, this.captureRate);
        if (!alive()) return;
        const signature = createSignatureFromPcm(pcm);
        // Shazam needs only the fingerprint. Raw audio leaves the device only when the user
        // picked an audio-based provider (ACRCloud / AudD), and only with the last attempt.
        const sendAudio = isLast && Boolean(this.provider) && this.provider !== 'shazam';
        const result = await this.recognize(signature, sendAudio ? pcm : null);
        if (!alive()) return;
        if (result && result.success && result.title) {
          this.finishCapture();
          this.handleMatch(result, { sampleMs: signature.samplems, captureEndAt, now: nowMs() });
          return;
        }
        lastResult = result;
        lastError = null;
      } catch (err) {
        if (!alive()) return;
        lastError = err && err.isTimeout
          ? { message: 'Recognition request timed out. The server or connection took too long to respond.', type: 'timeout' }
          : { message: `Recognition failed: ${err && err.message ? err.message : err}`, type: 'network' };
      }
    }

    if (!alive()) return;
    this.finishCapture();
    if (lastError && !lastResult) {
      this.failWith(lastError.message, lastError.type);
    } else {
      this.failWith('No song match found. Make sure recognizable music is playing and try again.', 'no_match');
    }
  }

  /**
   * Identify a signature: desktop main process first (direct to Shazam), then /api/recognize.
   * @param {{uri:string, samplems:number}} signature
   * @param {Int16Array|null} pcm attached as WAV for audio-based providers (ACRCloud / AudD)
   */
  async recognize(signature, pcm) {
    const wantShazam = !this.provider || this.provider === 'shazam';
    const desktop = typeof window !== 'undefined' ? window.LyricWaveDesktop : null;
    if (wantShazam && desktop && typeof desktop.shazamRecognize === 'function') {
      try {
        const started = nowMs();
        const raw = await desktop.shazamRecognize({ uri: signature.uri, samplems: signature.samplems });
        this.roundTripLatencyMs = Math.round(nowMs() - started);
        const result = normalizeShazamResponse(raw);
        // A clean miss from Shazam is final: the server would ask the same Shazam again.
        return result;
      } catch (err) {
        console.warn('Desktop Shazam lookup failed, using the server:', err && err.message);
      }
    }
    return this.dispatchToBackend(signature, pcm);
  }

  /**
   * POST the signature (and optionally the audio) to /api/recognize.
   * @returns {Promise<Object|null>} normalized recognition result, or null once cancelled
   */
  async dispatchToBackend(signature, pcm = null) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    this.recognitionController = controller;
    let timedOut = false;
    const timeoutId = controller ? setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT_MS) : null;
    const started = nowMs();
    try {
      const formData = new FormData();
      formData.append('signature', signature.uri);
      formData.append('samplems', String(signature.samplems));
      if (pcm && pcm.length) {
        formData.append('sample', new Blob([encode16kWav(pcm)], { type: 'audio/wav' }), 'sample.wav');
      }
      const headers = {};
      if (this.provider) headers['X-Recognition-Provider'] = this.provider;
      const apiBase = (CONFIG && CONFIG.API_BASE_URL) ? CONFIG.API_BASE_URL : '';
      const response = await fetch(`${apiBase}/api/recognize`, {
        method: 'POST',
        headers,
        body: formData,
        signal: controller ? controller.signal : undefined
      });
      this.roundTripLatencyMs = Math.round(nowMs() - started);
      if (this.isCancelled) return null;
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.message || `Server returned HTTP ${response.status}`);
      }
      const result = await response.json();
      return this.isCancelled ? null : result;
    } catch (err) {
      // Cancelled by stop() / a source switch: not an error, and the result is dropped.
      if (this.isCancelled && !timedOut) return null;
      if (err && err.name === 'AbortError' && timedOut) {
        const e = new Error('timeout');
        e.isTimeout = true;
        throw e;
      }
      throw err;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (this.recognitionController === controller) this.recognitionController = null;
    }
  }

  handleMatch(result, timing) {
    const position = computeTrackPosition(result, timing);
    const hasOffset = position !== null;

    this.isListening = false;
    this.onListeningStateChange(false);

    const track = normalizeNowPlaying({
      id: result.raw?.shazamKey ? `shazam-${result.raw.shazamKey}` : (result.raw?.acrid || `mic-${Date.now()}`),
      title: result.title,
      artist: result.artist,
      album: result.album || '',
      albumArt: result.raw?.coverArt || null,
      duration: result.duration || 180,
      durationEstimated: !result.duration,
      position: hasOffset ? position : 0,
      isPlaying: true,
      source: 'mic',
      confidence: result.confidence,
      hasOffset,
      spotifyId: result.raw?.spotifyTrackId || null,
      // Shazam / AudD return an ISRC; ACRCloud nests it in external_ids. Feeds the Library's MusicBrainz match.
      isrc: result.raw?.isrc || result.raw?.externalIds?.isrc || null,
      // Canonical / alternative names from the recognizer, used if LRCLIB misses the main title.
      lookupCandidates: Array.isArray(result.lookupCandidates) ? result.lookupCandidates : []
    });

    this.currentTrack = track;
    this.onStatusChange(`Identified: ${track.title} by ${track.artist}`, 'success');
    this.onIdentified(track);
    this.onTrackChange(track);
    this.scheduleAutoRelisten();
  }

  /** End capture (mic off) but keep the session alive for an in-flight final request. */
  finishCapture() {
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
    this.stopHardware();
  }

  failWith(message, type) {
    this.finishCapture();
    this.isListening = false;
    this.onListeningStateChange(false);
    this.pcmChunks = [];
    this.pcmFrames = 0;
    this.onError(message, type);
  }

  /**
   * Close media tracks and audio contexts (turns off OS mic indicator)
   */
  stopHardware() {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.processor) {
      try { this.processor.onaudioprocess = null; this.processor.disconnect(); } catch {}
      this.processor = null;
    }
    if (this.sinkGain) {
      try { this.sinkGain.disconnect(); } catch {}
      this.sinkGain = null;
    }
    if (this.mediaRecorder && this.mediaRecorder.state === 'recording' && this.isCancelled) {
      try { this.mediaRecorder.onstop = null; this.mediaRecorder.stop(); } catch {}
    }
    if (this.audioStream) {
      this.audioStream.getTracks().forEach((track) => {
        try { track.stop(); } catch {}
      });
      this.audioStream = null;
    }
    if (this.audioContext) {
      try { this.audioContext.close().catch(() => {}); } catch {}
      this.audioContext = null;
    }
    this.analyser = null;
    this.onAudioLevel(0);
  }

  /**
   * Enable or disable periodic auto re-listening every 2 minutes
   * @param {boolean} enabled
   */
  setAutoRelisten(enabled) {
    this.autoRelistenEnabled = enabled;
    if (enabled && this.currentTrack) {
      this.scheduleAutoRelisten();
    } else {
      this.clearAutoRelisten();
    }
  }

  /**
   * Schedule next auto re-listen after 2 minutes
   */
  scheduleAutoRelisten() {
    this.clearAutoRelisten();
    if (!this.autoRelistenEnabled) return;
    this.autoRelistenTimer = setTimeout(() => {
      this.autoRelistenTimer = null;
      if (!this.isListening && this.currentTrack && this.autoRelistenEnabled) {
        this.onStatusChange('Auto re-checking music in room...', 'working');
        this.start();
      }
    }, this.autoRelistenIntervalMs);
  }

  /**
   * Clear any pending auto-relisten timer
   */
  clearAutoRelisten() {
    if (this.autoRelistenTimer) {
      clearTimeout(this.autoRelistenTimer);
      this.autoRelistenTimer = null;
    }
  }

  /**
   * Explicitly trigger a re-sync (records new sample to re-anchor position or detect song change)
   */
  async resync() {
    this.stop();
    await this.start();
  }

  /**
   * Cancel or stop listening immediately
   */
  stop() {
    this.session++;
    this.isListening = false;
    this.isCancelled = true;
    this.onListeningStateChange(false);

    // A stopped source must not wake the microphone up later on its own.
    this.clearAutoRelisten();

    if (this.recognitionController) {
      try { this.recognitionController.abort(); } catch {}
      this.recognitionController = null;
    }
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
    if (this.mediaRecorder) {
      try {
        this.mediaRecorder.onstop = null;
        if (this.mediaRecorder.state === 'recording') this.mediaRecorder.stop();
      } catch {}
    }
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.pcmChunks = [];
    this.pcmFrames = 0;

    this.stopHardware();
  }
}
