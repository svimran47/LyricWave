/**
 * LyricWave Reel Visualizer (Phase 4)
 * 
 * Full-screen canvas animated sine waves,
 * OLED-style bordered current line box,
 * word-by-word reveal timing,
 * multi-theme rendering (Pixel OLED, Neon, Vinyl, Paper + token-based themes),
 * and (Sprint 2) animation styles driven by an AudioReactive source:
 *   'pulse' (beat/vocal synced, default) | 'reveal' (word-by-word) | 'karaoke' (smooth fill) |
 *   'kinetic' (bold motion type, word by word) | 'minimal' (static).
 */

const ANIMATION_STYLES = ['pulse', 'reveal', 'karaoke', 'kinetic', 'minimal'];
const STATIC_REDRAW_MS = 500; // static styles only repaint this often (follows theme / adaptive palette changes)

export class ReelVisualizer {
  constructor(canvas, container, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.container = container;

    // Configuration & State
    this.theme = options.theme || 'pixel'; // 'pixel' | 'neon' | 'minimal'
    this.wordByWordMode = options.wordByWordMode ?? true;
    this.animationStyle = ANIMATION_STYLES.includes(options.animationStyle) ? options.animationStyle : 'pulse';
    this.audioReactive = null;
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Animation & Wave metrics
    this.pulseAmplitude = 1.0;
    this.targetPulse = 1.0;
    this.currentPositionMs = 0;
    this.isPlaying = false;
    this.lastRenderTime = performance.now();
    this.lastDrawTime = 0;

    // Audio-reactive drawing state (set per render(); read by the wave drawers, no per-frame allocation)
    this._beat = 0;
    this._vocal = 0;
    this._energy = 0;
    this._ampMul = 1;     // amplitude multiplier (pulse style: <= 1 + 0.08 beat + 0.10 energy)
    this._alphaMul = 1;   // brightness multiplier (pulse style: vocal / beat glow, capped per stroke at 1)
    this._lwMul = 1;      // line-width multiplier
    this._staticDirty = true;
    this._lastStaticDraw = 0;
    this._wordProgress = 0;
    this._reactive = false; // true while drawing in the beat-synced 'pulse' style
    this._audioPlaying = null;

    // Visibility & Offscreen Tracking
    this.isDocumentVisible = typeof document !== 'undefined' ? !document.hidden : true;
    this.isStageVisible = true;

    // Frame rate throttle: Cap to 30fps (~33.3ms) on mobile or low-power devices
    const isMobileDevice = typeof window !== 'undefined' && (
      (window.matchMedia && window.matchMedia('(max-width: 768px)').matches) ||
      (typeof navigator !== 'undefined' && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent))
    );
    const isLowPowerHardware = typeof navigator !== 'undefined' && (
      (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4) ||
      (navigator.deviceMemory && navigator.deviceMemory <= 4)
    );
    this.isThrottled30fps = isMobileDevice || isLowPowerHardware;
    this.minFrameIntervalMs = this.isThrottled30fps ? 33 : 0;

    // Visibility change listener
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        this.isDocumentVisible = !document.hidden;
      });
    }

    // IntersectionObserver to pause wave drawing when stage is off-screen
    if (typeof IntersectionObserver !== 'undefined' && this.canvas) {
      try {
        const io = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            this.isStageVisible = entry.isIntersecting;
          }
        }, { threshold: 0.05 });
        io.observe(this.canvas);
      } catch {}
    }

    // Line & Word tracking
    this.activeLine = null;
    this.activeLineIndex = -1;
    this.nextLineTimeMs = 0;
    this.activeWords = [];
    this.currentWordIndex = -1;

    // Listen for reduced motion changes with addEventListener / addListener fallback
    if (typeof window !== 'undefined' && window.matchMedia) {
      const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
      this.reducedMotion = motionQuery.matches;
      const motionHandler = (e) => { this.reducedMotion = e.matches; };
      if (typeof motionQuery.addEventListener === 'function') {
        motionQuery.addEventListener('change', motionHandler);
      } else if (typeof motionQuery.addListener === 'function') {
        motionQuery.addListener(motionHandler);
      }
    }

    // Resize handling (Window resize, orientation change, and container ResizeObserver)
    this.resizeCanvas();
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', () => this.resizeCanvas());
      window.addEventListener('orientationchange', () => {
        setTimeout(() => this.resizeCanvas(), 100);
      });
    }

    if (typeof ResizeObserver !== 'undefined' && this.container) {
      try {
        const ro = new ResizeObserver(() => this.resizeCanvas());
        ro.observe(this.container);
      } catch {}
    }
  }

  resizeCanvas() {
    if (!this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = rect.width || window.innerWidth;
    this.height = rect.height || 400;

    this.canvas.width = Math.floor(this.width * dpr);
    this.canvas.height = Math.floor(this.height * dpr);
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.scale(dpr, dpr);
    this._staticDirty = true;
  }

  setTheme(newTheme) {
    this.theme = newTheme;
    this._staticDirty = true;
  }

  /**
   * 'pulse' (beat/vocal synced waves, default) | 'reveal' (word-by-word, previous behaviour) |
   * 'karaoke' (smooth word fill, exposes wordProgress) | 'minimal' (subtle static waves). Unknown values ignored.
   */
  setAnimationStyle(style) {
    if (!ANIMATION_STYLES.includes(style)) return;
    this.animationStyle = style;
    this._staticDirty = true;
  }

  /**
   * Attach an AudioReactive instance (audio-reactive.js) or null to detach. The reel only calls
   * getFrame(positionMs) (pulse style) and, optionally, setActiveLine(); it never enables/disables it.
   */
  setAudioReactive(instance) {
    this.audioReactive = instance && typeof instance.getFrame === 'function' ? instance : null;
    this._audioPlaying = null; // force a setPlaying() sync on the next render
    if (this.audioReactive && this.activeLine && typeof this.audioReactive.setActiveLine === 'function') {
      try { this.audioReactive.setActiveLine(this.activeLine, this.nextLineTimeMs); } catch { /* ignore */ }
    }
  }

  setWordByWordMode(enabled) {
    this.wordByWordMode = enabled;
  }

  /**
   * Called when active line changes: triggers amplitude pulse and resets word timing
   */
  setActiveLine(line, index, nextLineTimeMs = 0) {
    if (this.activeLineIndex !== index) {
      this.activeLine = line;
      this.activeLineIndex = index;
      this.nextLineTimeMs = nextLineTimeMs;

      // Pulse wave amplitude gently at each line change (softer swell in beat-synced 'pulse'; none in 'minimal')
      if (!this.reducedMotion && this.animationStyle !== 'minimal') {
        this.pulseAmplitude = this.animationStyle === 'pulse' ? 1.35 : 2.2;
      }

      if (this.audioReactive && typeof this.audioReactive.setActiveLine === 'function') {
        try { this.audioReactive.setActiveLine(line, nextLineTimeMs); } catch { /* ignore */ }
      }

      // Pre-compute word chunks for word-by-word reveal
      if (line && line.text) {
        const words = line.text.trim().split(/\s+/).filter(Boolean);
        const lineStart = line.timeMs;
        // Estimate line duration: either difference to next line or fallback based on word count
        const lineEnd = nextLineTimeMs > lineStart ? Math.min(nextLineTimeMs, lineStart + 9000) : lineStart + Math.max(2500, words.length * 450);
        const duration = Math.max(1000, lineEnd - lineStart);
        const wordInterval = duration / Math.max(1, words.length);

        this.activeWords = words.map((w, idx) => ({
          text: w,
          startMs: lineStart + (idx * wordInterval),
          endMs: lineStart + ((idx + 1) * wordInterval)
        }));
      } else {
        this.activeWords = [];
      }
    }
  }

  /**
   * Main render tick: updates the reactive signals, draws the waves and returns the word state.
   * Returns { words, currentWordIndex, wordByWordMode, wordProgress (0..1 inside the current word),
   *           beat, vocal, energy (0..1), bpm, mode ('audio'|'lyrics'|'off'), animationStyle }.
   */
  render(positionMs, isPlaying) {
    this.currentPositionMs = positionMs;
    this.isPlaying = isPlaying;

    const now = performance.now();
    const dt = (now - this.lastRenderTime) / 1000;
    this.lastRenderTime = now;

    // Decay amplitude pulse smoothly back to 1.0
    if (this.pulseAmplitude > 1.0) {
      this.pulseAmplitude = Math.max(1.0, this.pulseAmplitude - (dt * 3.2));
    }

    // Reactive signals (only the 'pulse' style consumes them; reduced motion never pulses)
    const style = this.animationStyle;
    const audio = this.audioReactive;
    let beat = 0;
    let vocal = 0;
    let energy = 0;
    let bpm = 0;
    let mode = 'off';
    if (audio) {
      try {
        mode = audio.mode || 'off';
        if (style === 'pulse' && !this.reducedMotion) {
          const playing = Boolean(isPlaying);
          if (playing !== this._audioPlaying && typeof audio.setPlaying === 'function') {
            this._audioPlaying = playing;
            audio.setPlaying(playing);
          }
          const f = audio.getFrame(positionMs);
          if (f) {
            beat = f.beat > 0 ? Math.min(1, f.beat) : 0;
            vocal = f.vocal > 0 ? Math.min(1, f.vocal) : 0;
            energy = f.energy > 0 ? Math.min(1, f.energy) : 0;
            bpm = f.bpm > 0 ? f.bpm : 0;
            mode = f.mode || mode;
          }
        }
      } catch { /* a misbehaving source must never break the reel */ }
    }
    this._beat = beat;
    this._vocal = vocal;
    this._energy = energy;
    this._updateDrawMultipliers();

    this.drawSineWaves(positionMs);

    // Compute word-by-word reveal index (karaoke always needs word tracking)
    let wordIndex = -1;
    let wordProgress = 0;
    const trackWords = this.wordByWordMode || style === 'karaoke' || style === 'kinetic';
    if (trackWords && this.activeWords.length > 0) {
      for (let i = 0; i < this.activeWords.length; i++) {
        if (positionMs >= this.activeWords[i].startMs) {
          wordIndex = i;
        } else {
          break;
        }
      }
      if (wordIndex >= 0) {
        const w = this.activeWords[wordIndex];
        const span = w.endMs - w.startMs;
        const p = span > 0 ? (positionMs - w.startMs) / span : 1;
        wordProgress = p > 1 ? 1 : p > 0 ? p : 0;
        if (this.reducedMotion) wordProgress = 1; // stepped highlight, no continuous fill
      }
    }
    this.currentWordIndex = wordIndex;
    this._wordProgress = wordProgress;

    return {
      words: this.activeWords,
      currentWordIndex: this.currentWordIndex,
      wordByWordMode: this.wordByWordMode,
      wordProgress,
      beat,
      vocal,
      energy,
      bpm,
      mode,
      animationStyle: style
    };
  }

  /**
   * Per-render drawing multipliers. In 'pulse' the beat adds <= 8% amplitude and the (slow) energy <= 10%;
   * vocal / beat add a mild brightness lift (each stroke's alpha is still capped at 1). No pulsing otherwise.
   */
  _updateDrawMultipliers() {
    const style = this.animationStyle;
    this._reactive = style === 'pulse' && !this.reducedMotion;
    if (style === 'minimal') {
      this._ampMul = 1;
      this._alphaMul = 0.6;
      this._lwMul = 0.6;
    } else if (this._reactive) {
      this._ampMul = 1 + 0.08 * this._beat + 0.10 * this._energy;
      this._alphaMul = 1 + 0.30 * this._vocal + 0.15 * this._beat;
      this._lwMul = 1;
    } else {
      this._ampMul = 1;
      this._alphaMul = 1;
      this._lwMul = 1;
    }
  }

  /**
   * Draw multi-layer sine waves flowing behind and beside the box
   */
  drawSineWaves(positionMs) {
    if (!this.ctx) return;

    // Pause canvas wave drawing if tab/window is hidden or stage is offscreen
    if (!this.isDocumentVisible || !this.isStageVisible) {
      return;
    }

    // Frame rate throttle: Cap to 30fps on mobile / low-power hardware
    const now = performance.now();
    const style = this.animationStyle;
    const isStatic = this.reducedMotion || style === 'minimal';

    if (isStatic) {
      // Nothing moves: repaint only when something changed (resize / theme / style) or to follow palette changes.
      if (!this._staticDirty && now - this._lastStaticDraw < STATIC_REDRAW_MS) return;
      this._staticDirty = false;
      this._lastStaticDraw = now;
    } else if (this.minFrameIntervalMs > 0 && (now - this.lastDrawTime < this.minFrameIntervalMs)) {
      return;
    }
    this.lastDrawTime = now;

    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;

    ctx.clearRect(0, 0, w, h);

    if (this.reducedMotion) {
      // Draw gentle minimal static grid or flat guides
      this.drawReducedMotionGuide(w, h);
      return;
    }

    const centerY = h / 2;
    let basePhase;
    let pulse;
    if (style === 'minimal') {
      // subtle, thin, dim, frozen waves
      basePhase = 0.6;
      pulse = 0.7;
    } else {
      // Base phase derived from song playback position so waves move in sync with music
      basePhase = (positionMs / 1000) * 2.2;
      pulse = this.pulseAmplitude;
    }
    pulse *= this._ampMul;

    switch (this.theme) {
      case 'pixel':
        this.drawPixelWaves(ctx, w, h, centerY, basePhase, pulse);
        break;
      case 'neon':
        this.drawNeonWaves(ctx, w, h, centerY, basePhase, pulse);
        break;
      case 'vinyl':
        this.drawVinylWaves(ctx, w, h, centerY, basePhase, pulse);
        break;
      case 'paper':
        this.drawPaperWaves(ctx, w, h, centerY, basePhase, pulse);
        break;
      case 'synthwave':
        this.drawSynthwaveWaves(ctx, w, h, centerY, basePhase, pulse);
        break;
      case 'mono':
        this.drawMonoWaves(ctx, w, h, centerY, basePhase, pulse);
        break;
      default:
        // aurora, adaptive, minimal, sunset, ocean, sakura, forest and any future token-based theme
        this.drawDynamicWaveTokens(ctx, w, h, centerY, basePhase, pulse);
    }
    ctx.globalAlpha = 1.0;
  }

  /**
   * Reads a computed CSS variable token from the document root with fallback
   */
  getCssToken(name, fallback) {
    if (typeof window === 'undefined' || !window.getComputedStyle) return fallback;
    // Called every animation frame: getComputedStyle forces a style recalc, so re-read at
    // most every 500ms (fast enough to follow theme / album-adaptive palette changes).
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (!this._cssTokenCache) this._cssTokenCache = new Map();
    const cached = this._cssTokenCache.get(name);
    if (cached && now - cached.at < 500) return cached.value || fallback;
    try {
      const val = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      this._cssTokenCache.set(name, { value: val, at: now });
      return val || fallback;
    } catch {
      return fallback;
    }
  }

  /** alpha helper: base alpha scaled by the reactive brightness, never above 1 */
  _a(base) {
    const v = base * this._alphaMul;
    return v > 1 ? 1 : v;
  }

  /**
   * Token-based waves (--wave-1 / --wave-2) for Aurora, Album Adaptive, Minimal, Sunset, Ocean, Sakura, Forest
   */
  drawDynamicWaveTokens(ctx, w, h, centerY, basePhase, pulse) {
    const wave1Color = this.getCssToken('--wave-1', '#6366f1');
    const wave2Color = this.getCssToken('--wave-2', '#c084fc');

    ctx.lineWidth = 2.5 * this._lwMul;
    ctx.lineCap = 'round';

    // Primary wave
    ctx.strokeStyle = wave1Color;
    ctx.globalAlpha = this._a(0.55);
    ctx.beginPath();
    for (let x = 0; x <= w; x += 8) {
      const angle = (x * 0.009) + basePhase;
      const y = centerY + Math.sin(angle) * (26 * pulse) + Math.cos(angle * 1.5) * 6;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Secondary wave
    ctx.strokeStyle = wave2Color;
    ctx.globalAlpha = this._a(0.35);
    ctx.beginPath();
    for (let x = 0; x <= w; x += 8) {
      const angle = (x * 0.013) - (basePhase * 0.85) + 1.2;
      const y = centerY + Math.sin(angle) * (20 * pulse);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1.0;
  }

  /**
   * Synthwave: token waves plus a retro perspective grid scrolling toward the viewer below the horizon.
   * One path / one stroke for the whole grid, no allocations.
   */
  drawSynthwaveWaves(ctx, w, h, centerY, basePhase, pulse) {
    const wave1Color = this.getCssToken('--wave-1', '#ff2bd6');
    const wave2Color = this.getCssToken('--wave-2', '#22d3ee');

    const horizon = centerY + h * 0.14;
    const floorH = h - horizon;
    if (floorH > 12) {
      const rows = 7;
      const scroll = (basePhase * 0.06) % 1; // 0..1, loops seamlessly
      ctx.strokeStyle = wave2Color;
      ctx.lineWidth = 1 * this._lwMul;
      ctx.lineCap = 'butt';
      ctx.globalAlpha = this._a(0.16);
      ctx.beginPath();
      for (let i = 0; i < rows; i++) {
        const tt = (i + scroll) / rows;
        const y = horizon + floorH * tt * tt;
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
      }
      const cols = 9;
      const vx = w / 2;
      for (let j = 0; j < cols; j++) {
        const bx = vx + (j - (cols - 1) / 2) * (w / 4);
        ctx.moveTo(vx + (bx - vx) * 0.04, horizon);
        ctx.lineTo(bx, h);
      }
      ctx.stroke();
    }

    ctx.lineWidth = 2.2 * this._lwMul;
    ctx.lineCap = 'round';
    ctx.strokeStyle = wave1Color;
    ctx.shadowColor = wave1Color;
    ctx.shadowBlur = this._lwMul < 1 ? 0 : 8;
    ctx.globalAlpha = this._a(0.6);
    ctx.beginPath();
    for (let x = 0; x <= w; x += 8) {
      const angle = (x * 0.01) + basePhase;
      const y = centerY + Math.sin(angle) * (24 * pulse) + Math.cos(angle * 1.7) * 5;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.strokeStyle = wave2Color;
    ctx.shadowColor = wave2Color;
    ctx.globalAlpha = this._a(0.4);
    ctx.beginPath();
    for (let x = 0; x <= w; x += 8) {
      const angle = (x * 0.014) - (basePhase * 0.9) + 0.9;
      const y = centerY + Math.sin(angle) * (18 * pulse);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1.0;
  }

  /**
   * Mono (pure-black OLED): crisp, thin, white lines. No glow, no colour.
   */
  drawMonoWaves(ctx, w, h, centerY, basePhase, pulse) {
    ctx.lineWidth = 1 * this._lwMul;
    ctx.lineCap = 'butt';
    ctx.strokeStyle = '#ffffff';

    ctx.globalAlpha = this._a(0.8);
    ctx.beginPath();
    for (let x = 0; x <= w; x += 6) {
      const angle = (x * 0.009) + basePhase;
      const y = centerY + Math.sin(angle) * (22 * pulse);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.globalAlpha = this._a(0.32);
    ctx.beginPath();
    for (let x = 0; x <= w; x += 6) {
      const angle = (x * 0.014) - (basePhase * 0.8) + 1.1;
      const y = centerY + Math.sin(angle) * (15 * pulse);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1.0;
  }

  /**
   * Vinyl Theme Waves: Gentle warm analog grooves
   */
  drawVinylWaves(ctx, w, h, centerY, basePhase, pulse) {
    ctx.lineWidth = 1.8 * this._lwMul;
    ctx.lineCap = 'round';

    ctx.strokeStyle = '#d97706';
    ctx.globalAlpha = this._a(0.45);
    ctx.beginPath();
    for (let x = 0; x <= w; x += 8) {
      const angle = (x * 0.007) + (basePhase * 0.7);
      const y = centerY + Math.sin(angle) * (18 * pulse);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.strokeStyle = '#92400e';
    ctx.globalAlpha = this._a(0.25);
    ctx.beginPath();
    for (let x = 0; x <= w; x += 8) {
      const angle = (x * 0.011) - (basePhase * 0.6) + 0.8;
      const y = centerY + Math.sin(angle) * (12 * pulse);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1.0;
  }

  /**
   * Paper Theme Waves: Crisp monochrome ink contour line
   */
  drawPaperWaves(ctx, w, h, centerY, basePhase, pulse) {
    ctx.lineWidth = 1.5 * this._lwMul;
    ctx.lineCap = 'round';

    ctx.strokeStyle = '#2563eb';
    ctx.globalAlpha = this._a(0.35);
    ctx.beginPath();
    for (let x = 0; x <= w; x += 8) {
      const angle = (x * 0.009) + basePhase;
      const y = centerY + Math.sin(angle) * (20 * pulse);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1.0;
  }

  /**
   * Pixel OLED Theme Waves: Stepped, crisp monochrome phosphor lines
   */
  drawPixelWaves(ctx, w, h, centerY, basePhase, pulse) {
    const stepSize = 4; // Pixelated stepping
    ctx.lineWidth = 2 * this._lwMul;
    ctx.lineCap = 'square';
    ctx.strokeStyle = '#ffffff';

    // Wave 1: Primary phosphor wave
    ctx.globalAlpha = this._a(0.45);
    ctx.beginPath();
    for (let x = 0; x < w; x += stepSize) {
      const angle = (x * 0.012) + basePhase;
      const y = centerY + Math.sin(angle) * (24 * pulse) + Math.cos(angle * 0.5) * 10;
      // Step to nearest 2px for retro pixel feel
      const steppedY = Math.round(y / 2) * 2;
      if (x === 0) ctx.moveTo(x, steppedY);
      else ctx.lineTo(x, steppedY);
    }
    ctx.stroke();

    // Wave 2: Harmonic secondary wave
    ctx.globalAlpha = this._a(0.2);
    ctx.beginPath();
    for (let x = 0; x < w; x += stepSize) {
      const angle = (x * 0.018) - (basePhase * 0.8);
      const y = centerY + Math.sin(angle) * (18 * pulse);
      const steppedY = Math.round(y / 2) * 2;
      if (x === 0) ctx.moveTo(x, steppedY);
      else ctx.lineTo(x, steppedY);
    }
    ctx.stroke();

    // Wave 3: Background pulse ripple
    ctx.globalAlpha = this._a(0.08);
    ctx.beginPath();
    for (let x = 0; x < w; x += stepSize) {
      const angle = (x * 0.007) + (basePhase * 1.4);
      const y = centerY + Math.sin(angle) * (38 * pulse);
      const steppedY = Math.round(y / 2) * 2;
      if (x === 0) ctx.moveTo(x, steppedY);
      else ctx.lineTo(x, steppedY);
    }
    ctx.stroke();
    ctx.globalAlpha = 1.0;
  }

  /**
   * Neon Theme Waves: Glowing cyan and magenta flowing bezier curves
   */
  drawNeonWaves(ctx, w, h, centerY, basePhase, pulse) {
    ctx.lineWidth = 3 * this._lwMul;
    ctx.lineCap = 'round';
    ctx.globalAlpha = this._reactive ? this._a(0.75) : Math.min(1, this._alphaMul);
    const glow = this._lwMul < 1 ? 0 : 14;

    // Cyan Neon Wave
    ctx.strokeStyle = '#00f0ff';
    ctx.shadowColor = '#00f0ff';
    ctx.shadowBlur = glow;
    ctx.beginPath();
    for (let x = 0; x <= w; x += 10) {
      const angle = (x * 0.01) + basePhase;
      const y = centerY + Math.sin(angle) * (30 * pulse) + Math.sin(angle * 2) * 8;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Magenta Neon Wave
    ctx.strokeStyle = '#ff007f';
    ctx.shadowColor = '#ff007f';
    ctx.shadowBlur = glow * 0.85;
    ctx.beginPath();
    for (let x = 0; x <= w; x += 10) {
      const angle = (x * 0.014) - (basePhase * 1.1) + 1.2;
      const y = centerY + Math.cos(angle) * (26 * pulse) + Math.cos(angle * 1.8) * 6;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Reset shadow blur
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1.0;
  }

  /**
   * Minimal Theme Waves: Sleek, translucent monochromatic ribbons
   */
  drawMinimalWaves(ctx, w, h, centerY, basePhase, pulse) {
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';

    // Wave 1
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
    ctx.beginPath();
    for (let x = 0; x <= w; x += 8) {
      const angle = (x * 0.009) + (basePhase * 0.9);
      const y = centerY + Math.sin(angle) * (20 * pulse);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Wave 2
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.beginPath();
    for (let x = 0; x <= w; x += 8) {
      const angle = (x * 0.014) - (basePhase * 0.7) + 0.8;
      const y = centerY + Math.cos(angle) * (14 * pulse);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  drawReducedMotionGuide(w, h) {
    const ctx = this.ctx;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();
  }
}
