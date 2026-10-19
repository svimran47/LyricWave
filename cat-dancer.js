/**
 * LyricWave cat dancer: a small orange tabby that dances in the corner of the lyrics stage.
 *
 * Assets: assets/cat/manifest.json + one horizontal WebP sprite strip per move (transparent, ~360 px tall).
 * Every move is a boomerang (first frame == last frame, near the shared "hub" pose), so moves only change
 * at a loop boundary and never jump.
 *
 *  - Driven by the same signal as the reel: audioReactive.getFrame() -> { beat, vocal, energy, bpm }.
 *  - Lyric lines nudge the choice (shouts / "oh" / "yeah" -> the vocal moves, empty lines -> idle).
 *  - One loop lasts LOOP_BEATS beats at the current bpm (120 bpm when unknown), clamped to a sane speed.
 *  - prefers-reduced-motion: shows the still hub pose instead of animating.
 *  - Sized from the free space below the lyric line box, so it never covers the current line;
 *    hidden when there is not enough room.
 *  - Off by default (Settings toggle); nothing is fetched until it is enabled.
 *
 * The move choice and frame timing are pure functions (exported) so they are unit-testable in Node.
 */

export const STORAGE_CAT_DANCER_KEY = 'lyricwave_cat_dancer';
export const MANIFEST_URL = 'assets/cat/manifest.json';
export const DEFAULT_BPM = 120;
export const LOOP_BEATS = 4;
const MIN_LOOP_MS = 900;
const MAX_LOOP_MS = 4200;
const MIN_HEIGHT_PX = 72;
const MAX_STAGE_FRACTION = 0.34;
const FADE_MS = 160;
const VOCAL_WORDS = /\b(oh+|ooh+|yeah|hey|woah|whoa|baby|la|na)\b|!/i;

/** Duration of one boomerang loop in ms for a bpm (0 / bad values -> DEFAULT_BPM). */
export function loopDurationMs(bpm) {
  const b = Number.isFinite(bpm) && bpm >= 50 && bpm <= 220 ? bpm : DEFAULT_BPM;
  const ms = (60000 / b) * LOOP_BEATS;
  return Math.min(MAX_LOOP_MS, Math.max(MIN_LOOP_MS, ms));
}

/** Frame index (0..frames-1) at `elapsedMs` into a loop of `loopMs`. */
export function frameAt(elapsedMs, loopMs, frames) {
  if (!(frames > 0)) return 0;
  const t = ((elapsedMs % loopMs) + loopMs) % loopMs / loopMs;
  return Math.min(frames - 1, Math.floor(t * frames));
}

/**
 * Pick the next move from the available move names.
 * @param {{energy?:number, beat?:number, vocal?:number}} frame audio-reactive frame (0..1 values)
 * @param {string} lineText current lyric line ('' when none / instrumental)
 * @param {string[]} available move names present in the manifest
 * @param {number} counter increments every loop, rotates through the groove moves deterministically
 * @param {boolean} playing
 */
export function chooseMove(frame, lineText, available, counter = 0, playing = true) {
  const has = (m) => available.includes(m);
  const first = (...ms) => ms.find(has);
  const idle = first('hub', 'idle') || available[0] || null;
  if (!playing || !available.length) return idle;
  const energy = Number(frame?.energy) || 0;
  const vocal = Number(frame?.vocal) || 0;
  const text = typeof lineText === 'string' ? lineText.trim() : '';
  if (vocal > 0.75 || (text && VOCAL_WORDS.test(text))) {
    const v = first(energy > 0.7 ? 'climax' : 'step', 'arms', 'step');
    if (v) return v;
  }
  if (energy < 0.12 && !text) return idle;
  const groove = ['sway', 'arms', 'lean', 'step'].filter(has);
  if (!groove.length) return idle;
  return groove[Math.abs(counter) % groove.length];
}

export class CatDancer {
  /**
   * @param {HTMLElement} stageEl the element the canvas is placed in (position: relative)
   * @param {{lineBoxEl?: HTMLElement, reducedMotion?: () => boolean, fetchImpl?: Function}} opts
   */
  constructor(stageEl, opts = {}) {
    this.stage = stageEl;
    this.lineBox = opts.lineBoxEl || null;
    this.nextLine = opts.nextLineEl || null;
    this.reducedMotion = opts.reducedMotion || (() => false);
    this.fetchImpl = opts.fetchImpl || ((u) => fetch(u));
    this.enabled = false;
    this.moves = {};      // name -> { img, frames, w, h }
    this.loading = null;
    this.current = null;
    this.loopStart = 0;
    this.loopMs = loopDurationMs(DEFAULT_BPM);
    this.counter = 0;
    this.lineText = '';
    this.lastFrameIdx = -1;
    this.fade = null;
    this.canvas = null;
    this.ctx = null;
    this._lastLayout = 0;
  }

  get active() {
    return this.enabled && Object.keys(this.moves).length > 0;
  }

  setEnabled(on) {
    this.enabled = Boolean(on);
    if (this.enabled) {
      this._ensureCanvas();
      this.load();
    }
    if (this.canvas) this.canvas.classList.toggle('hidden', !this.enabled);
  }

  /** Current lyric line text (from engine.onLineChange). */
  setLine(text) {
    this.lineText = typeof text === 'string' ? text : '';
  }

  /** New track: start from the hub pose. */
  reset() {
    this.current = null;
    this.counter = 0;
    this.lineText = '';
  }

  load() {
    if (this.loading) return this.loading;
    this.loading = Promise.resolve()
      .then(() => this.fetchImpl(MANIFEST_URL))
      .then((r) => (r && r.ok ? r.json() : null))
      .then((manifest) => {
        if (!manifest || !Array.isArray(manifest.moves)) return;
        return Promise.all(manifest.moves.map((m) => new Promise((resolve) => {
          if (typeof Image === 'undefined') return resolve();
          const img = new Image();
          img.decoding = 'async';
          img.onload = () => {
            this.moves[m.name] = { img, frames: m.frames, w: m.w, h: m.h };
            resolve();
          };
          img.onerror = () => resolve();
          img.src = `assets/cat/${m.file}`;
        })));
      })
      .catch(() => {});
    return this.loading;
  }

  _ensureCanvas() {
    if (this.canvas || typeof document === 'undefined' || !this.stage) return;
    const c = document.createElement('canvas');
    c.className = 'cat-dancer-canvas hidden';
    c.setAttribute('aria-hidden', 'true');
    this.stage.appendChild(c);
    this.canvas = c;
    this.ctx = c.getContext('2d');
  }

  /** Size and place the canvas in the free space below the line box. Returns false when there's no room. */
  _layout(move) {
    const stageRect = this.stage.getBoundingClientRect();
    if (!stageRect.height) return false;
    let free = stageRect.height * MAX_STAGE_FRACTION;
    // Stay below the line box and the next-line hint under it (on phones the hint spans the width).
    for (const el of [this.lineBox, this.nextLine]) {
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.height > 0) free = Math.min(free, stageRect.bottom - r.bottom - 8);
    }
    const h = Math.floor(free);
    if (h < MIN_HEIGHT_PX) return false;
    const w = Math.round(h * (move.w / move.h));
    const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
      this.lastFrameIdx = -1;
    }
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    return true;
  }

  /**
   * Draw one tick. `frame` is the audio-reactive frame for this tick (may be null).
   * @param {object|null} frame
   * @param {boolean} playing
   * @param {number} now performance.now()
   */
  render(frame, playing, now) {
    if (!this.active || !this.canvas) return;
    const names = Object.keys(this.moves);
    const reduce = this.reducedMotion();
    if (!this.current || now - this.loopStart >= this.loopMs) {
      // Loop boundary: pick the next move and the tempo for this loop.
      const prev = this.current;
      this.current = reduce ? (names.includes('hub') ? 'hub' : names[0])
        : chooseMove(frame, this.lineText, names, this.counter++, playing);
      // Each move starts from its own pose, so blend out of the previous move's end frame briefly.
      this.fade = prev && prev !== this.current && !reduce && this.moves[prev]
        ? { move: this.moves[prev], until: now + FADE_MS } : null;
      this.loopMs = loopDurationMs(frame?.bpm);
      this.loopStart = now;
      this.lastFrameIdx = -1;
    }
    const move = this.moves[this.current];
    if (!move) return;
    if (now - this._lastLayout > 500 || this.lastFrameIdx < 0) {
      this._lastLayout = now;
      const fits = this._layout(move);
      this.canvas.classList.toggle('hidden', !fits);
      if (!fits) return;
    }
    const idx = reduce || !playing ? 0 : frameAt(now - this.loopStart, this.loopMs, move.frames);
    const fading = Boolean(this.fade && now < this.fade.until);
    if (!fading) this.fade = null;
    if (idx === this.lastFrameIdx && !fading) return;
    this.lastFrameIdx = idx;
    const ctx = this.ctx;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    ctx.clearRect(0, 0, cw, ch);
    if (fading) {
      const k = 1 - (this.fade.until - now) / FADE_MS;
      const pm = this.fade.move;
      const pw = Math.round(ch * (pm.w / pm.h));
      ctx.globalAlpha = 1 - k;
      ctx.drawImage(pm.img, 0, 0, pm.w, pm.h, (cw - pw) / 2, 0, pw, ch);
      ctx.globalAlpha = k;
    }
    ctx.drawImage(move.img, idx * move.w, 0, move.w, move.h, 0, 0, cw, ch);
    ctx.globalAlpha = 1;
  }
}

export default CatDancer;
