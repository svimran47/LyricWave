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
const BODY_FRACTION = 0.9; // the cat fills 90% of the canvas height; the rest is room for the beat hop
const VOCAL_WORDS = /\b(oh+|ooh+|yeah|hey|woah|whoa)\b|!/i;
const VOCAL_MOVES = new Set(['climax', 'step', 'arms']);

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
 * @param {string|null} prev the move that just played; never repeated back to back while dancing
 */
export function chooseMove(frame, lineText, available, counter = 0, playing = true, prev = null) {
  const has = (m) => available.includes(m);
  const first = (...ms) => ms.find(has);
  const idle = first('hub', 'idle') || available[0] || null;
  if (!playing || !available.length) return idle;
  const energy = Number(frame?.energy) || 0;
  const vocal = Number(frame?.vocal) || 0;
  const text = typeof lineText === 'string' ? lineText.trim() : '';
  // No "quiet -> stand still" rule: the lyric-rhythm signal drops to 0 between lines, and a loop
  // boundary landing in that gap made the cat stand around. While music plays, it dances.
  // Every move joins the rotation (the hub pose too, as a "bounce"), so a short set still varies.
  const groove = ['sway', 'arms', 'lean', 'step', 'hub'].filter(has);
  if (!groove.length) return idle;
  let pick = groove[Math.abs(counter) % groove.length];
  // A shout gets a vocal move, but never two loops running: many lines say "oh" or "yeah".
  if ((vocal > 0.75 || (text && VOCAL_WORDS.test(text))) && !VOCAL_MOVES.has(prev)) {
    pick = first(energy > 0.7 ? 'climax' : 'step', 'arms', 'lean') || pick;
  }
  if (pick === prev && groove.length > 1) {
    pick = groove[(groove.indexOf(pick) + 1) % groove.length];
  }
  return pick;
}

/**
 * Per-tick body motion on top of the frames: a hop on each beat, a small tilt that alternates
 * beat to beat, scaled by energy. Pure, so it can be tested.
 * @returns {{hop:number, tilt:number}} hop as a fraction of height (0..0.08), tilt in radians
 */
export function beatMotion(frame, beatCount) {
  const beat = Math.max(0, Math.min(1, Number(frame?.beat) || 0));
  const energy = Math.max(0, Math.min(1, Number(frame?.energy) || 0));
  const hop = beat * (0.035 + 0.045 * energy);
  const side = beatCount % 2 === 0 ? 1 : -1;
  const tilt = side * (0.02 + 0.06 * energy) * (0.4 + 0.6 * beat);
  return { hop, tilt };
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
    this.mirror = false;
    this.beatCount = 0;
    this._lastBeat = 0;
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
    // Extra width so the beat tilt never clips the paws.
    const w = Math.round(h * BODY_FRACTION * (move.w / move.h) * 1.25);
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
        : chooseMove(frame, this.lineText, names, this.counter++, playing, prev);
      // Mirror every other loop so even a repeated move reads as a new step.
      this.mirror = reduce ? false : !this.mirror;
      // Each move starts from its own pose, so blend out of the previous move's end frame briefly.
      this.fade = prev && prev !== this.current && !reduce && this.moves[prev]
        ? { move: this.moves[prev], until: now + FADE_MS, mirror: !this.mirror } : null;
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
    // Count beats on the rising edge of the beat envelope (drives the alternating tilt).
    const beat = Number(frame?.beat) || 0;
    if (beat > 0.6 && this._lastBeat <= 0.3) this.beatCount++;
    this._lastBeat = beat;
    const moving = playing && !reduce;
    if (idx === this.lastFrameIdx && !fading && !moving) return;
    this.lastFrameIdx = idx;
    const { hop, tilt } = moving ? beatMotion(frame, this.beatCount) : { hop: 0, tilt: 0 };
    const ctx = this.ctx;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    ctx.clearRect(0, 0, cw, ch);
    const draw = (m, frameIdx, mirror, alpha) => {
      const bh = ch * BODY_FRACTION;              // headroom above the body for the hop
      const bw = bh * (m.w / m.h);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(cw / 2, ch);                   // pivot at the feet
      ctx.rotate(tilt);
      ctx.translate(0, -hop * ch);
      if (mirror) ctx.scale(-1, 1);
      ctx.drawImage(m.img, frameIdx * m.w, 0, m.w, m.h, -bw / 2, -bh, bw, bh);
      ctx.restore();
    };
    if (fading) {
      const k = 1 - (this.fade.until - now) / FADE_MS;
      draw(this.fade.move, 0, this.fade.mirror, 1 - k);
      draw(move, idx, this.mirror, k);
    } else {
      draw(move, idx, this.mirror, 1);
    }
  }
}

export default CatDancer;
