/**
 * LyricWave cat dancer: a small orange tabby that dances in the corner of the lyrics stage.
 *
 * Assets: assets/cat/manifest.json + one horizontal WebP sprite strip per move (transparent, ~360 px tall).
 * Every move is a boomerang (first frame == last frame, near the shared "hub" pose), so moves only change
 * at a loop boundary and never jump.
 *
 *  - Song choreography: when a song has synced lyrics, buildChoreography() turns them into a routine for
 *    that song: one move per lyric line, chosen from the line itself (shouts -> vocal moves, long held
 *    lines -> slow moves, instrumental gaps -> bounce) in an order seeded by the song, and every repeated
 *    line (the chorus) gets the same move and facing each time it comes back. Moves change on the line.
 *  - Without synced lyrics it improvises from the beat signal (chooseMove).
 *  - Driven by the same signal as the reel: audioReactive.getFrame() -> { beat, vocal, energy, bpm }.
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

/** Small stable string hash (FNV-1a) so a song always gets the same routine. */
export function songSeed(key) {
  let h = 0x811c9dc5;
  const s = String(key || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function normLine(text) {
  return String(text || '').toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, '').replace(/\s+/g, ' ').trim();
}

/**
 * Build a song's routine from its synced lyrics.
 * @param {Array<{timeMs:number, text:string}>} lines synced lyric lines
 * @param {string[]} available move names in the manifest
 * @param {string} songKey e.g. "title|artist"; seeds the move order so each song dances differently
 * @returns {Array<{startMs:number, endMs:number, move:string, mirror:boolean}>} [] when it can't build one
 */
export function buildChoreography(lines, available, songKey = '') {
  if (!Array.isArray(lines) || lines.length === 0 || !Array.isArray(available)) return [];
  const has = (m) => available.includes(m);
  const pool = ['sway', 'arms', 'lean', 'step', 'climax', 'hub'].filter(has);
  if (pool.length < 2) return [];
  const seed = songSeed(songKey);
  // Song-specific order of the groove moves (seeded Fisher-Yates).
  const order = pool.filter((m) => m !== 'hub');
  let r = seed || 1;
  for (let i = order.length - 1; i > 0; i--) {
    r = Math.imul(r ^ (r >>> 15), 2246822507) >>> 0;
    const j = r % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  if (!order.length) order.push(pool[0]);
  const idle = has('hub') ? 'hub' : order[0];
  const vocalMove = ['climax', 'arms', 'step'].find(has) || order[0];
  const slowMove = ['sway', 'lean'].find(has) || order[0];
  const remembered = new Map(); // normalized line -> { move, mirror }
  const steps = [];
  let prev = null;
  let prevMirror = false;
  let next = 0;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i] || {};
    const startMs = Number(ln.timeMs);
    if (!Number.isFinite(startMs)) continue;
    const nextStart = Number(lines[i + 1]?.timeMs);
    const endMs = Number.isFinite(nextStart) && nextStart > startMs ? nextStart : startMs + 4000;
    const text = typeof ln.text === 'string' ? ln.text.trim() : '';
    const key = normLine(text);
    let move;
    let mirror;
    if (!key) {
      move = idle;                                   // instrumental gap: bounce in place
      mirror = !prevMirror;
    } else if (remembered.has(key)) {
      ({ move, mirror } = remembered.get(key));      // chorus / repeated line: same move every time
    } else {
      if (VOCAL_WORDS.test(text)) move = vocalMove;
      else if (endMs - startMs > 6000) move = slowMove;
      else move = order[(next++ + (seed % order.length)) % order.length];
      if (move === prev && order.length > 1) move = order[(order.indexOf(move) + 1) % order.length];
      mirror = ((seed >>> 4) + i) % 2 === 1;
      remembered.set(key, { move, mirror });
    }
    if (move === prev && mirror === prevMirror) mirror = !mirror; // same move twice: face the other way
    steps.push({ startMs, endMs, move, mirror });
    prev = move;
    prevMirror = mirror;
  }
  return steps;
}

/** Index of the routine step playing at positionMs, or -1 (before the first line / no routine). */
export function stepIndexAt(steps, positionMs) {
  if (!Array.isArray(steps) || !steps.length || !Number.isFinite(positionMs)) return -1;
  let lo = 0;
  let hi = steps.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (steps[mid].startMs <= positionMs) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
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
    this.steps = [];
    this.stepIdx = -1;
    this._song = null;
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
    this.steps = [];
    this.stepIdx = -1;
    this._song = null;
  }

  /**
   * The song's synced lyrics (from the engine's track/lyrics callbacks). The routine is built on the
   * next render, once the move sheets are known; [] or unsynced lyrics -> improvise from the beat.
   */
  setSong(songKey, syncedLines) {
    this._song = { key: String(songKey || ''), lines: Array.isArray(syncedLines) ? syncedLines : [] };
    this.steps = [];
    this.stepIdx = -1;
  }

  /** The routine currently in use (for tests / diagnostics). */
  get routine() {
    return this.steps;
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
   * @param {number} [positionMs] song position (tick.effectiveMs), drives the song routine
   */
  render(frame, playing, now, positionMs) {
    if (!this.active || !this.canvas) return;
    const names = Object.keys(this.moves);
    const reduce = this.reducedMotion();
    if (this._song) {
      this.steps = buildChoreography(this._song.lines, names, this._song.key);
      this._song = null;
    }
    // Song routine: the move changes with the lyric line, right on the line's start.
    const stepIdx = playing && !reduce ? stepIndexAt(this.steps, positionMs) : -1;
    const newStep = stepIdx >= 0 && stepIdx !== this.stepIdx;
    if (newStep || !this.current || now - this.loopStart >= this.loopMs) {
      const prev = this.current;
      const prevMirror = this.mirror;
      if (reduce) {
        this.current = names.includes('hub') ? 'hub' : names[0];
        this.mirror = false;
      } else if (stepIdx >= 0) {
        const step = this.steps[stepIdx];
        // A new line starts its own move and facing; a line long enough to loop again flips facing.
        this.current = this.moves[step.move] ? step.move : this.current || names[0];
        this.mirror = newStep ? step.mirror : !this.mirror;
      } else {
        // No routine (no synced lyrics, or before the first line): improvise from the beat.
        this.current = chooseMove(frame, this.lineText, names, this.counter++, playing, prev);
        this.mirror = !this.mirror; // mirror every other loop so a repeated move reads as a new step
      }
      this.stepIdx = stepIdx;
      // Each move starts from its own pose, so blend out of the previous move's end frame briefly.
      this.fade = prev && (prev !== this.current || prevMirror !== this.mirror) && !reduce && this.moves[prev]
        ? { move: this.moves[prev], until: now + FADE_MS, mirror: prevMirror } : null;
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
