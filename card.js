/**
 * LyricWave Lyrics Card Maker
 *
 * Turns a short lyric excerpt into a shareable PNG: pick 1-4 consecutive lines, choose a style
 * and a size, and the card is drawn on a <canvas> with the song title, artist and album art.
 *
 *  - Pure helpers (line picking, selection, wrapping, fitting, file names) run in Node for tests.
 *  - renderLyricCard() draws onto any 2D context.
 *  - LyricCardMaker drives the #lyricCardBackdrop dialog in index.html.
 *
 * Lyrics stay their songwriters' copyright, so a card is a short quote with credit, never a whole
 * song: MAX_QUOTE_LINES / MAX_QUOTE_CHARS cap the excerpt and the footer always names the song.
 * The exceptions are lyrics LyricWave has the rights to show: a song that is itself openly licensed
 * (an Openverse track whose license allows adaptations, see openLicenseAllowsFullLyrics), or
 * lyrics the user added as their own, public domain or Creative Commons (user-lyrics.js). Those
 * cards may quote up to OPEN_QUOTE_LINES / OPEN_QUOTE_CHARS, as much as stays readable, and always
 * carry the license credit line.
 */

import { openLicenseAllowsFullLyrics } from './types.js';

export const MAX_QUOTE_LINES = 4;
export const MAX_QUOTE_CHARS = 220;
export const OPEN_QUOTE_LINES = 12;
export const OPEN_QUOTE_CHARS = 480;

export const DEFAULT_QUOTE_LIMITS = Object.freeze({ lines: MAX_QUOTE_LINES, chars: MAX_QUOTE_CHARS, open: false });
export const OPEN_QUOTE_LIMITS = Object.freeze({ lines: OPEN_QUOTE_LINES, chars: OPEN_QUOTE_CHARS, open: true });

/**
 * Quote caps for a track: longer quotes only when the song's own license allows them, or when the
 * lyrics on screen are the user's own with open rights (lyricsData.rights.allowsFull).
 */
export function quoteLimitsFor(track, lyricsData = null) {
  if (lyricsData?.rights?.allowsFull === true) return OPEN_QUOTE_LIMITS;
  return openLicenseAllowsFullLyrics(track?.openTrack?.license) ? OPEN_QUOTE_LIMITS : DEFAULT_QUOTE_LIMITS;
}

/**
 * Credit drawn under the footer: the open song's license ("CC BY-SA 3.0 · "Song" by Creator ·
 * Jamendo") and/or the rights of the user's own lyrics when a card quotes more because of them.
 */
export function cardLicenseCredit(track, lyricsData = null) {
  const parts = [];
  const ot = track?.openTrack;
  if (ot?.license) {
    const work = [track.title ? `“${track.title}”` : '', ot.creator ? `by ${ot.creator}` : ''].filter(Boolean).join(' ');
    parts.push([ot.licenseLabel || ot.license, work, ot.provider].filter(Boolean).join(' · '));
  }
  const rights = lyricsData?.rights;
  if (rights?.source === 'user' && rights.allowsFull && rights.rights !== 'song' && rights.credit) {
    parts.push(rights.credit);
  }
  return parts.join(' · ');
}

export const CARD_FORMATS = {
  square: { width: 1080, height: 1080, label: 'Square' },
  story: { width: 1080, height: 1920, label: 'Story' }
};

const FONT_FAMILY = "'Switzer', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

/**
 * Card styles. `art` means the album art (when present) fills the background.
 * Colours are fixed per style so a shared card looks the same whatever theme the app is in.
 */
export const CARD_STYLES = {
  spotlight: {
    label: 'Spotlight', desc: 'Highlighted lines on the cover',
    art: true, bg: ['#1a1024', '#0b0712'], text: '#0b0b0f', bar: '#ffffff',
    meta: '#ffffff', metaMuted: 'rgba(255,255,255,0.72)', accent: '#ffffff'
  },
  glass: {
    label: 'Glass', desc: 'Liquid glass on blurred cover',
    art: true, bg: ['#0f1424', '#070a14'], text: '#ffffff', glass: true,
    meta: '#ffffff', metaMuted: 'rgba(255,255,255,0.78)', accent: '#60a5fa'
  },
  aurora: {
    label: 'Aurora', desc: 'LyricWave purple glow',
    art: false, bg: ['#1b1033', '#0b1430'], glow: ['rgba(172,88,233,0.55)', 'rgba(99,102,241,0.45)'],
    text: '#ffffff', meta: '#ffffff', metaMuted: 'rgba(255,255,255,0.7)', accent: '#c58cf2'
  },
  paper: {
    label: 'Paper', desc: 'Warm print look',
    art: false, bg: ['#f6f1e7', '#efe7d8'], text: '#1a1714',
    meta: '#1a1714', metaMuted: 'rgba(26,23,20,0.62)', accent: '#c2410c'
  },
  neon: {
    label: 'Neon', desc: 'Glowing club lights',
    art: false, bg: ['#07010d', '#05030a'], text: '#ffffff', glowText: '#ff2bd6',
    meta: '#ffffff', metaMuted: 'rgba(255,255,255,0.7)', accent: '#22d3ee'
  }
};

export const DEFAULT_CARD_STYLE = 'spotlight';
export const DEFAULT_CARD_FORMAT = 'square';

// Section markers and filler that make no sense on a card
const NON_LYRIC_RE = /^\s*(?:[♪♫♬♩🎵🎶\s.…-]*|\[[^\]]*\]|\([^)]*instrumental[^)]*\))\s*$/iu;

/**
 * The lines a user can pick from, in song order: synced lines when present, else plain lyrics.
 * @param {object|null} lyricsData engine.lyricsData
 * @returns {{text: string, timeMs: number|null}[]}
 */
export function getSelectableLines(lyricsData) {
  if (!lyricsData) return [];
  let raw = [];
  if (Array.isArray(lyricsData.syncedLines) && lyricsData.syncedLines.length > 0) {
    raw = lyricsData.syncedLines.map((l) => ({ text: String(l?.text ?? ''), timeMs: Number.isFinite(l?.timeMs) ? l.timeMs : null }));
  } else if (typeof lyricsData.plainLyrics === 'string' && lyricsData.plainLyrics.trim()) {
    raw = lyricsData.plainLyrics.split(/\r?\n/).map((text) => ({ text, timeMs: null }));
  }
  return raw
    .map((l) => ({ ...l, text: l.text.replace(/\s+/g, ' ').trim() }))
    .filter((l) => l.text && !NON_LYRIC_RE.test(l.text));
}

/**
 * Index (into getSelectableLines) of the line to start on: the one playing now, else the first.
 * @param {{timeMs: number|null}[]} lines
 * @param {number} positionMs current playback position, or NaN when unknown
 */
export function defaultLineIndex(lines, positionMs) {
  if (!lines.length) return -1;
  if (!Number.isFinite(positionMs)) return 0;
  let idx = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].timeMs != null && lines[i].timeMs <= positionMs) idx = i;
  }
  return idx;
}

/**
 * Tap handling for the line picker. A selection is a contiguous range {start, end} (inclusive).
 *  - tap the line just before/after the range: extend it (up to the quote limits)
 *  - tap an end of a multi-line range: drop that line
 *  - tap anything else: start over with that line
 * @returns {{start: number, end: number, limited: boolean}} limited = the tap was refused by a cap
 */
export function toggleLineSelection(selection, index, lines, limits = DEFAULT_QUOTE_LIMITS) {
  const fresh = { start: index, end: index, limited: false };
  if (!selection || selection.start < 0) return fresh;
  const { start, end } = selection;
  if (index >= start && index <= end) {
    if (start === end) return { start, end, limited: false };
    if (index === start) return { start: start + 1, end, limited: false };
    if (index === end) return { start, end: end - 1, limited: false };
    return fresh;
  }
  if (index === start - 1 || index === end + 1) {
    const next = { start: Math.min(start, index), end: Math.max(end, index) };
    const count = next.end - next.start + 1;
    const chars = lines.slice(next.start, next.end + 1).reduce((n, l) => n + l.text.length, 0);
    if (count > limits.lines || chars > limits.chars) return { start, end, limited: true };
    return { ...next, limited: false };
  }
  return fresh;
}

/**
 * Greedy word wrap. Words wider than maxWidth are split by characters.
 * @param {string} text
 * @param {number} maxWidth
 * @param {(s: string) => number} measure width of a string in the current font
 */
export function wrapText(text, maxWidth, measure) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const rows = [];
  let row = '';
  const pushLongWord = (word) => {
    let chunk = '';
    for (const ch of word) {
      if (chunk && measure(chunk + ch) > maxWidth) { rows.push(chunk); chunk = ''; }
      chunk += ch;
    }
    return chunk;
  };
  for (const word of words) {
    const candidate = row ? `${row} ${word}` : word;
    if (measure(candidate) <= maxWidth) { row = candidate; continue; }
    if (row) rows.push(row);
    row = measure(word) > maxWidth ? pushLongWord(word) : word;
  }
  if (row) rows.push(row);
  return rows;
}

/**
 * Largest font size at which every lyric line wraps into the box.
 * @param {string[]} texts the selected lyric lines
 * @param {{maxWidth: number, maxHeight: number, maxSize: number, minSize: number, lineHeight: number, gap: number}} box
 *   lineHeight and gap are multiples of the font size (gap = extra space between lyric lines)
 * @param {(size: number) => (s: string) => number} measureAt returns a measurer for a font size
 * @returns {{fontSize: number, blocks: string[][], height: number}}
 */
export function fitLyricLayout(texts, box, measureAt) {
  const layoutAt = (size) => {
    const measure = measureAt(size);
    const blocks = texts.map((t) => wrapText(t, box.maxWidth, measure));
    const rowCount = blocks.reduce((n, b) => n + b.length, 0);
    const height = rowCount * size * box.lineHeight + Math.max(0, blocks.length - 1) * size * box.gap;
    return { fontSize: size, blocks, height };
  };
  for (let size = box.maxSize; size > box.minSize; size -= 2) {
    const layout = layoutAt(size);
    if (layout.height <= box.maxHeight) return layout;
  }
  return layoutAt(box.minSize);
}

/** Cuts a string with an ellipsis so it fits maxWidth. */
export function ellipsize(text, maxWidth, measure) {
  const s = String(text || '');
  if (measure(s) <= maxWidth) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(s.slice(0, mid).trimEnd() + '…') <= maxWidth) lo = mid; else hi = mid - 1;
  }
  return s.slice(0, lo).trimEnd() + '…';
}

/** "lyricwave-some-artist-some-song.png" */
export function cardFileName(track) {
  const slug = (s) => String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const parts = [slug(track?.artist), slug(track?.title)].filter(Boolean);
  return `lyricwave-${parts.join('-').slice(0, 80) || 'card'}.png`;
}

/** "Song by Artist" for the share sheet, or just whichever of the two is known. */
export function shareTitle(track) {
  const title = String(track?.title ?? '').trim();
  const artist = String(track?.artist ?? '').trim();
  if (title && artist) return `${title} by ${artist}`;
  return title || artist;
}

/**
 * Enforces the quote caps on whatever lines reach the renderer: at most MAX_QUOTE_LINES non-empty
 * lines and MAX_QUOTE_CHARS characters, cutting the last line with an ellipsis when it overflows
 * (a single very long lyric line can be picked on its own).
 * @param {string[]} texts
 * @returns {string[]}
 */
export function clampQuote(texts, limits = DEFAULT_QUOTE_LIMITS) {
  const out = [];
  let used = 0;
  for (const raw of texts || []) {
    const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const room = limits.chars - used;
    if (out.length >= limits.lines || room <= 0) break;
    if (text.length > room) {
      out.push(text.slice(0, Math.max(1, room - 1)).trimEnd() + '…');
      break;
    }
    out.push(text);
    used += text.length;
  }
  return out;
}

/**
 * How a card can be shared here: 'native' (Android app bridge), 'web' (Web Share with files)
 * or 'none' (desktop browsers: Download only).
 */
export function cardShareMode({ hasNativeBridge, canShareFiles }) {
  if (hasNativeBridge) return 'native';
  return canShareFiles ? 'web' : 'none';
}

/** window.LyricWaveNative when the Android app exposes the image share bridge, else null. */
function nativeCardBridge() {
  try {
    const bridge = typeof window !== 'undefined' ? window.LyricWaveNative : null;
    return bridge && typeof bridge.shareImage === 'function' ? bridge : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

function font(weight, size) {
  return `${weight} ${size}px ${FONT_FAMILY}`;
}

function measurerFor(ctx, weight) {
  return (size) => {
    ctx.font = font(weight, size);
    return (s) => ctx.measureText(s).width;
  };
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Draws an image to cover the rect (like CSS object-fit: cover). */
function drawCover(ctx, img, x, y, w, h) {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  if (!iw || !ih) return;
  const scale = Math.max(w / iw, h / ih);
  const sw = w / scale;
  const sh = h / scale;
  ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, w, h);
}

/**
 * Soft blurred cover background. Downscales then upscales through a small canvas, which blurs
 * in every browser (ctx.filter is missing in Safari).
 */
function drawBlurredCover(ctx, img, w, h, makeCanvas) {
  const small = makeCanvas?.(24, Math.max(1, Math.round(24 * h / w)));
  if (!small) { drawCover(ctx, img, 0, 0, w, h); return; }
  const sctx = small.getContext('2d');
  drawCover(sctx, img, 0, 0, small.width, small.height);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(small, -w * 0.05, -h * 0.05, w * 1.1, h * 1.1);
  ctx.restore();
}

function drawBackground(ctx, style, w, h, art, makeCanvas) {
  const grad = ctx.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, style.bg[0]);
  grad.addColorStop(1, style.bg[1]);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  if (style.art && art) {
    drawBlurredCover(ctx, art, w, h, makeCanvas);
    const shade = ctx.createLinearGradient(0, 0, 0, h);
    shade.addColorStop(0, 'rgba(0,0,0,0.38)');
    shade.addColorStop(1, 'rgba(0,0,0,0.62)');
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, w, h);
  }

  if (style.glow) {
    const spots = [[w * 0.15, h * 0.12, style.glow[0]], [w * 0.9, h * 0.85, style.glow[1]]];
    for (const [x, y, color] of spots) {
      const r = Math.max(w, h) * 0.65;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, color);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
  }
}

/**
 * Draws a lyrics card.
 * @param {CanvasRenderingContext2D} ctx context of a canvas already sized to the format
 * @param {object} opts
 * @param {string[]} opts.lines selected lyric lines
 * @param {string} opts.title
 * @param {string} opts.artist
 * @param {CanvasImageSource|null} [opts.art] loaded, CORS-clean album art
 * @param {string} [opts.style]
 * @param {string} [opts.format]
 * @param {(w: number, h: number) => HTMLCanvasElement} [opts.makeCanvas] for the blur pass
 * @param {{lines: number, chars: number}} [opts.limits] quote caps (quoteLimitsFor(track))
 * @param {string} [opts.credit] license credit drawn under the footer (open tracks)
 */
export function renderLyricCard(ctx, opts) {
  const style = CARD_STYLES[opts.style] || CARD_STYLES[DEFAULT_CARD_STYLE];
  const format = CARD_FORMATS[opts.format] || CARD_FORMATS[DEFAULT_CARD_FORMAT];
  const { width: w, height: h } = format;
  const art = opts.art || null;
  const pad = 96;
  const isStory = h > w;

  ctx.save();
  ctx.clearRect(0, 0, w, h);
  drawBackground(ctx, style, w, h, art, opts.makeCanvas);

  // Footer: album art thumbnail + title / artist, brand mark on the right
  const thumb = art ? (isStory ? 136 : 112) : 0;
  const footerH = Math.max(thumb, 96);
  const footerY = h - pad - footerH;
  let textX = pad;
  if (art) {
    ctx.save();
    roundRectPath(ctx, pad, footerY + (footerH - thumb) / 2, thumb, thumb, 16);
    ctx.clip();
    drawCover(ctx, art, pad, footerY + (footerH - thumb) / 2, thumb, thumb);
    ctx.restore();
    textX = pad + thumb + 32;
  }
  const brand = 'LyricWave';
  ctx.font = font(700, 30);
  const brandW = ctx.measureText(brand).width;
  const metaMax = w - pad - textX - brandW - 40;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillStyle = style.meta;
  ctx.font = font(700, 40);
  const measureTitle = (s) => ctx.measureText(s).width;
  ctx.fillText(ellipsize(opts.title || 'Unknown song', metaMax, measureTitle), textX, footerY + footerH / 2 - 6);
  ctx.fillStyle = style.metaMuted;
  ctx.font = font(500, 32);
  const measureArtist = (s) => ctx.measureText(s).width;
  ctx.fillText(ellipsize(opts.artist || 'Unknown artist', metaMax, measureArtist), textX, footerY + footerH / 2 + 38);
  ctx.fillStyle = style.metaMuted;
  ctx.font = font(700, 30);
  ctx.textAlign = 'right';
  ctx.fillText(brand, w - pad, footerY + footerH / 2 + 38);
  ctx.textAlign = 'left';

  // Lyric block, sized to fill the space between the quote mark and the footer
  const quoteSize = isStory ? 220 : 180;
  const quoteH = quoteSize * 0.62;
  const lyricTop = pad + quoteH;
  const lyricBottom = footerY - (isStory ? 120 : 64);
  const barPadX = style.bar ? 22 : (style.glass ? 20 : 0);
  const box = {
    maxWidth: w - pad * 2 - barPadX * 2,
    maxHeight: lyricBottom - lyricTop,
    maxSize: isStory ? 96 : 84,
    minSize: 36,
    lineHeight: (style.bar || style.glass) ? 1.38 : 1.2,
    gap: (style.bar || style.glass) ? 0.18 : 0.35
  };
  const texts = clampQuote(opts.lines, opts.limits || DEFAULT_QUOTE_LIMITS);
  const layout = fitLyricLayout(texts.length ? texts : [' '], box, measurerFor(ctx, 800));
  const size = layout.fontSize;
  const rowH = size * box.lineHeight;
  // centre the quote (and its opening quote mark) in the space above the footer
  let y = lyricTop + Math.max(0, (box.maxHeight - layout.height) / 2);

  ctx.fillStyle = style.accent;
  ctx.globalAlpha = style.bar ? 0.9 : 1;
  ctx.font = font(800, quoteSize);
  ctx.textBaseline = 'top';
  ctx.fillText('“', pad - 8, y - quoteH - quoteSize * 0.12);
  ctx.globalAlpha = 1;

  ctx.font = font(800, size);
  ctx.textBaseline = 'middle';
  for (let b = 0; b < layout.blocks.length; b++) {
    for (const row of layout.blocks[b]) {
      const mid = y + rowH / 2;
      if (style.bar) {
        const tw = ctx.measureText(row).width;
        ctx.fillStyle = style.bar;
        ctx.fillRect(pad, y + rowH * 0.06, tw + barPadX * 2, rowH * 0.88);
        ctx.fillStyle = style.text;
        ctx.fillText(row, pad + barPadX, mid);
      } else if (style.glass) {
        const tw = ctx.measureText(row).width;
        const pillW = tw + barPadX * 2;
        const pillH = rowH * 0.9;
        const pillX = pad;
        const pillY = y + rowH * 0.05;
        const r = Math.min(18, pillH / 2);

        ctx.save();
        ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
        if (typeof ctx.fill === 'function') {
          roundRectPath(ctx, pillX, pillY, pillW, pillH, r);
          ctx.fill();
        } else {
          ctx.fillRect(pillX, pillY, pillW, pillH);
        }

        // Specular rim reflection
        if (typeof ctx.stroke === 'function') {
          const borderGrad = ctx.createLinearGradient(pillX, pillY, pillX + pillW, pillY + pillH);
          borderGrad.addColorStop(0, 'rgba(255, 255, 255, 0.7)');
          borderGrad.addColorStop(0.4, 'rgba(255, 255, 255, 0.15)');
          borderGrad.addColorStop(1, 'rgba(255, 255, 255, 0.45)');
          ctx.strokeStyle = borderGrad;
          ctx.lineWidth = 1.5;
          roundRectPath(ctx, pillX, pillY, pillW, pillH, r);
          ctx.stroke();
        }
        ctx.restore();

        ctx.fillStyle = style.text;
        ctx.fillText(row, pad + barPadX, mid);
      } else if (style.glowText) {
        ctx.save();
        ctx.shadowColor = style.glowText;
        ctx.shadowBlur = size * 0.45;
        ctx.fillStyle = style.text;
        ctx.fillText(row, pad, mid);
        ctx.shadowBlur = size * 0.15;
        ctx.fillText(row, pad, mid);
        ctx.restore();
      } else {
        ctx.fillStyle = style.text;
        ctx.fillText(row, pad, mid);
      }
      y += rowH;
    }
    y += size * box.gap;
  }

  // Thin accent rule above the footer
  ctx.fillStyle = style.accent;
  ctx.globalAlpha = 0.85;
  ctx.fillRect(pad, footerY - 40, 72, 6);
  ctx.globalAlpha = 1;

  // License credit for openly licensed songs (CC BY etc. require it on anything shared)
  if (opts.credit) {
    ctx.fillStyle = style.metaMuted;
    ctx.font = font(500, 24);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const measureCredit = (s) => ctx.measureText(s).width;
    ctx.fillText(ellipsize(String(opts.credit), w - pad * 2, measureCredit), pad, h - pad / 2);
  }

  ctx.restore();
  return layout;
}

// ---------------------------------------------------------------------------
// Dialog controller
// ---------------------------------------------------------------------------

/**
 * Loads album art so it can be drawn and exported. Resolves null when the image is missing,
 * fails, or would taint the canvas (no CORS headers).
 */
export function loadCardArt(url) {
  return new Promise((resolve) => {
    if (!url || typeof Image === 'undefined') { resolve(null); return; }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => {
      try {
        const probe = document.createElement('canvas');
        probe.width = probe.height = 1;
        const pctx = probe.getContext('2d');
        pctx.drawImage(img, 0, 0, 1, 1);
        pctx.getImageData(0, 0, 1, 1);
        resolve(img);
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** Bigger artwork for the card: iTunes URLs carry their size in the path (…/100x100bb.jpg). */
export function upscaleArtUrl(url) {
  if (!url) return '';
  return String(url).replace(/\/(\d{2,4})x(\d{2,4})(bb|cc|-\d+)?\.(jpg|jpeg|png|webp)(\?.*)?$/i, (m, _w, _h, suffix = 'bb', ext) => `/600x600${suffix}.${ext}`);
}

const STORAGE_STYLE_KEY = 'lyricwave_card_style';
const STORAGE_FORMAT_KEY = 'lyricwave_card_format';

function readPref(key, allowed, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v && Object.prototype.hasOwnProperty.call(allowed, v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function writePref(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}

export class LyricCardMaker {
  /**
   * @param {object} deps
   * @param {HTMLElement} deps.backdrop #lyricCardBackdrop
   * @param {(msg: string, type?: string) => void} deps.notify app toast (showAlert)
   * @param {(kind?: string) => void} [deps.haptic]
   * @param {() => void} [deps.onClose] focus restore etc.
   */
  constructor({ backdrop, notify, haptic, onClose }) {
    this.backdrop = backdrop;
    this.notify = notify || (() => {});
    this.haptic = haptic || (() => {});
    this.onClose = onClose || (() => {});
    const q = (id) => document.getElementById(id);
    this.canvas = q('lyricCardCanvas');
    this.linesEl = q('lyricCardLines');
    this.hintEl = q('lyricCardHint');
    this.subtitleEl = q('lyricCardSubtitle');
    this.stylesEl = q('lyricCardStyles');
    this.formatsEl = q('lyricCardFormats');
    this.btnShare = q('btnLyricCardShare');
    this.btnDownload = q('btnLyricCardDownload');
    this.btnClose = q('btnCloseLyricCard');

    this.style = readPref(STORAGE_STYLE_KEY, CARD_STYLES, DEFAULT_CARD_STYLE);
    this.format = readPref(STORAGE_FORMAT_KEY, CARD_FORMATS, DEFAULT_CARD_FORMAT);
    this.track = null;
    this.limits = DEFAULT_QUOTE_LIMITS;
    this.lines = [];
    this.selection = { start: -1, end: -1 };
    this.art = null;
    this._artToken = 0;
    this._busy = false;
    // PNG of the current preview, encoded shortly after each change (see _scheduleBlob)
    this._blob = null;
    this._blobToken = 0;
    this._blobTimer = 0;

    this._buildOptionButtons();
    this.linesEl?.addEventListener('click', (e) => {
      const btn = e.target instanceof Element ? e.target.closest('[data-line-index]') : null;
      if (btn) this._onLineTap(Number(btn.dataset.lineIndex));
    });
    this.btnShare?.addEventListener('click', () => this.share());
    this.btnDownload?.addEventListener('click', () => this.download());
    this.btnClose?.addEventListener('click', () => this.close());
    this.backdrop?.addEventListener('click', (e) => { if (e.target === this.backdrop) this.close(); });

    // The Android app shares through its native bridge (its WebView has no Web Share API).
    // Elsewhere Web Share with files is the share sheet on phones; desktops without it get Download only.
    this.native = nativeCardBridge();
    const canShareFiles = typeof navigator !== 'undefined' && typeof navigator.canShare === 'function'
      && typeof File !== 'undefined'
      && (() => { try { return navigator.canShare({ files: [new File([''], 'x.png', { type: 'image/png' })] }); } catch { return false; } })();
    this.shareMode = cardShareMode({ hasNativeBridge: Boolean(this.native), canShareFiles });
    if (this.shareMode === 'none' && this.btnShare) {
      this.btnShare.classList.add('hidden');
      this.btnShare.disabled = true;
    }
  }

  get isOpen() {
    return Boolean(this.backdrop && !this.backdrop.classList.contains('hidden'));
  }

  /**
   * @param {object} track engine.track
   * @param {object} lyricsData engine.lyricsData
   * @param {number} positionMs current playback position (NaN if unknown)
   * @returns {boolean} false when there is nothing to put on a card
   */
  open(track, lyricsData, positionMs) {
    if (!track?.title) {
      this.notify('Play a song first to make a lyrics card.', 'warning');
      return false;
    }
    const lines = getSelectableLines(lyricsData);
    if (!lines.length) {
      this.notify('This song has no lyrics to put on a card.', 'warning');
      return false;
    }
    this.track = track;
    this.lyricsData = lyricsData;
    this.limits = quoteLimitsFor(track, lyricsData);
    this.lines = lines;
    const start = defaultLineIndex(lines, positionMs);
    this.selection = { start, end: start };
    if (this.subtitleEl) this.subtitleEl.textContent = [track.title, track.artist].filter(Boolean).join(' · ');

    this._renderLineList();
    this.art = null;
    this.render();
    this._loadArt(track.albumArt);

    this.backdrop.classList.remove('hidden');
    this.backdrop.setAttribute('aria-hidden', 'false');
    // scroll the starting line into view, then focus it so arrow/Tab navigation starts there
    const startBtn = this.linesEl?.querySelector(`[data-line-index="${start}"]`);
    // scroll the list only: scrollIntoView would also scroll the dialog past the preview
    if (startBtn && this.linesEl) {
      this.linesEl.scrollTop = Math.max(0, startBtn.offsetTop - (this.linesEl.clientHeight - startBtn.offsetHeight) / 2);
    }
    startBtn?.focus({ preventScroll: true });
    if (typeof document !== 'undefined' && document.fonts?.load) {
      Promise.all([document.fonts.load(font(800, 64)), document.fonts.load(font(700, 40)), document.fonts.load(font(500, 32))])
        .then(() => { if (this.isOpen) this.render(); })
        .catch(() => {});
    }
    return true;
  }

  close() {
    if (!this.isOpen) return;
    this.backdrop.classList.add('hidden');
    this.backdrop.setAttribute('aria-hidden', 'true');
    clearTimeout(this._blobTimer);
    this._blobToken++;
    this._blob = null;
    this.onClose();
  }

  selectedTexts() {
    const { start, end } = this.selection;
    if (start < 0) return [];
    return this.lines.slice(start, end + 1).map((l) => l.text);
  }

  render() {
    if (!this.canvas) return;
    const { width, height } = CARD_FORMATS[this.format];
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    this.canvas.dataset.format = this.format;
    const ctx = this.canvas.getContext('2d');
    renderLyricCard(ctx, {
      lines: this.selectedTexts(),
      title: this.track?.title,
      artist: this.track?.artist,
      art: this.art,
      style: this.style,
      format: this.format,
      limits: this.limits,
      credit: cardLicenseCredit(this.track, this.lyricsData),
      makeCanvas: (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
    });
    const count = this.selection.end - this.selection.start + 1;
    this.canvas.setAttribute('aria-label', `Lyrics card preview: ${this.selectedTexts().join(' / ')}`);
    if (this.hintEl) {
      const max = this.limits.lines;
      const openNote = this.limits.open ? ' These lyrics are openly licensed, so their credit goes on the card.' : '';
      this.hintEl.textContent = (count >= max
        ? `${count} lines, the most a card can quote.`
        : `${count} of up to ${max} lines. Tap a neighbouring line to add it.`) + openNote;
    }
    this._scheduleBlob();
  }

  /**
   * Safari only lets navigator.share() run during the tap itself; awaiting canvas.toBlob() inside
   * the click handler uses up that permission. So for Web Share, encode the PNG shortly after each
   * change and let share() hand over the ready blob without awaiting anything first.
   */
  _scheduleBlob() {
    this._blob = null;
    clearTimeout(this._blobTimer);
    const token = ++this._blobToken;
    if (this.shareMode !== 'web' || !this.canvas) return;
    this._blobTimer = setTimeout(() => {
      try {
        this.canvas.toBlob((blob) => {
          if (blob && token === this._blobToken && this.isOpen) this._blob = blob;
        }, 'image/png');
      } catch {
        // tainted or unsupported canvas: share() falls back to encoding on demand
      }
    }, 150);
  }

  /** The current card as base64 PNG (no data: prefix) for the Android bridge. */
  _toBase64() {
    this.render();
    const url = this.canvas.toDataURL('image/png');
    return url.slice(url.indexOf(',') + 1);
  }

  async toBlob() {
    this.render();
    return new Promise((resolve, reject) => {
      try {
        this.canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not create the image.'))), 'image/png');
      } catch (err) {
        reject(err);
      }
    });
  }

  async share() {
    if (this._busy) return;
    this._busy = true;
    this.haptic('light');
    try {
      if (this.shareMode === 'native') {
        if (!this._shareNative()) this.notify('Couldn’t open the share sheet. Try Download instead.', 'error');
        return;
      }
      // Use the pre-rendered blob when it is ready so nothing is awaited before navigator.share
      const blob = this._blob || await this.toBlob();
      const file = new File([blob], cardFileName(this.track), { type: 'image/png' });
      const title = shareTitle(this.track);
      await navigator.share({ files: [file], title, text: title });
    } catch (err) {
      if (err?.name !== 'AbortError') {
        console.warn('[LyricCard] share failed', err);
        this.notify('Sharing didn’t work here, so the card was downloaded instead.', 'warning');
        await this._downloadNow();
      }
    } finally {
      this._busy = false;
    }
  }

  async download() {
    if (this._busy) return;
    this._busy = true;
    this.haptic('light');
    try {
      await this._downloadNow();
    } finally {
      this._busy = false;
    }
  }

  /** Android app: hands the PNG to the system share sheet. Returns false if the bridge refused it. */
  _shareNative() {
    try {
      return this.native.shareImage(this._toBase64(), cardFileName(this.track), shareTitle(this.track)) === true;
    } catch (err) {
      console.warn('[LyricCard] native share failed', err);
      return false;
    }
  }

  /** Android app: saves to Pictures/LyricWave, or opens the share sheet (Save to Files...) on old Android. */
  _saveNative() {
    let saved = false;
    try {
      if (typeof this.native.saveImage === 'function' && this.native.canSaveImage?.() !== false) {
        saved = this.native.saveImage(this._toBase64(), cardFileName(this.track)) === true;
      }
    } catch (err) {
      console.warn('[LyricCard] native save failed', err);
    }
    if (saved) {
      this.notify('Lyrics card saved to Pictures/LyricWave.', 'info');
    } else if (this._shareNative()) {
      this.notify('Pick where to save the card.', 'info');
    } else {
      this.notify('Couldn’t save the card on this device.', 'error');
    }
  }

  async _downloadNow() {
    if (this.native) {
      this._saveNative();
      return;
    }
    try {
      const blob = await this.toBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = cardFileName(this.track);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      this.notify('Lyrics card saved.', 'info');
    } catch (err) {
      console.warn('[LyricCard] download failed', err);
      this.notify('Couldn’t save the card on this device.', 'error');
    }
  }

  async _loadArt(url) {
    const token = ++this._artToken;
    const big = upscaleArtUrl(url);
    let img = await loadCardArt(big);
    if (!img && big !== url) img = await loadCardArt(url);
    if (token !== this._artToken || !this.isOpen) return;
    this.art = img;
    this.render();
  }

  _onLineTap(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.lines.length) return;
    const next = toggleLineSelection(this.selection, index, this.lines, this.limits);
    if (next.limited) {
      this.notify(this.limits.open
        ? `A card fits up to ${this.limits.lines} lines, with the song and its license credited.`
        : `A card quotes up to ${MAX_QUOTE_LINES} short lines, with the song credited.`, 'info');
      return;
    }
    this.haptic('light');
    this.selection = { start: next.start, end: next.end };
    this._syncLineStates();
    this.render();
  }

  _renderLineList() {
    if (!this.linesEl) return;
    const frag = document.createDocumentFragment();
    this.lines.forEach((line, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lyric-card-line';
      btn.dataset.lineIndex = String(i);
      btn.textContent = line.text;
      frag.appendChild(btn);
    });
    this.linesEl.replaceChildren(frag);
    this._syncLineStates();
  }

  _syncLineStates() {
    if (!this.linesEl) return;
    const { start, end } = this.selection;
    for (const btn of this.linesEl.children) {
      const i = Number(btn.dataset.lineIndex);
      const on = i >= start && i <= end;
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.classList.toggle('is-selected', on);
    }
  }

  _buildOptionButtons() {
    const build = (container, options, current, onPick) => {
      if (!container) return;
      container.replaceChildren(...Object.entries(options).map(([key, opt]) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'anim-style-btn';
        btn.setAttribute('role', 'radio');
        btn.dataset.value = key;
        const name = document.createElement('span');
        name.className = 'anim-style-name';
        name.textContent = opt.label;
        btn.appendChild(name);
        const desc = document.createElement('span');
        desc.className = 'anim-style-desc';
        desc.textContent = opt.desc || `${opt.width} × ${opt.height}`;
        btn.appendChild(desc);
        return btn;
      }));
      const sync = (value) => {
        for (const btn of container.children) {
          const on = btn.dataset.value === value;
          btn.setAttribute('aria-checked', on ? 'true' : 'false');
          btn.classList.toggle('active', on);
          btn.tabIndex = on ? 0 : -1;
        }
      };
      sync(current);
      container.addEventListener('click', (e) => {
        const btn = e.target instanceof Element ? e.target.closest('[data-value]') : null;
        if (!btn) return;
        this.haptic('light');
        onPick(btn.dataset.value);
        sync(btn.dataset.value);
        this.render();
      });
      // radiogroup arrow-key navigation
      container.addEventListener('keydown', (e) => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
        const items = [...container.children];
        const idx = items.indexOf(document.activeElement);
        if (idx < 0) return;
        e.preventDefault();
        const step = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
        const next = items[(idx + step + items.length) % items.length];
        next.focus();
        next.click();
      });
    };
    build(this.stylesEl, CARD_STYLES, this.style, (v) => { this.style = v; writePref(STORAGE_STYLE_KEY, v); });
    build(this.formatsEl, CARD_FORMATS, this.format, (v) => { this.format = v; writePref(STORAGE_FORMAT_KEY, v); });
  }
}
