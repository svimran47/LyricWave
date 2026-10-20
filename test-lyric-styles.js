/**
 * Wiring checks for the word-by-word lyric animation styles (typewriter, blur, wave, neon, flip):
 * every style is selectable, tracked word by word, styled, reduced-motion safe, and ships with the app.
 */

import { readFileSync } from 'node:fs';
import { WORD_STYLES } from './reel.js';

let passed = 0;
let failed = 0;
function assert(condition, desc) {
  if (condition) { passed++; console.log(`  ✓ ${desc}`); } else { failed++; console.error(`  ✗ FAIL: ${desc}`); }
}

console.log('--- Testing lyric animation styles ---');

const app = readFileSync('app.js', 'utf8');
const reel = readFileSync('reel.js', 'utf8');
const html = readFileSync('index.html', 'utf8');
const css = readFileSync('styles.css', 'utf8');
const sw = readFileSync('sw.js', 'utf8');

const declLine = (src, prefix) => src.split(String.fromCharCode(10)).find((x) => x.startsWith(prefix)) || '';
const NEW = ['typewriter', 'blur', 'wave', 'neon', 'flip'];
for (const s of NEW) {
  assert(WORD_STYLES.has(s), `${s} plays word by word`);
  assert(declLine(app, 'const ANIM_STYLES = ').includes(`'${s}'`), `${s} is selectable in app.js`);
  assert(declLine(reel, 'const ANIMATION_STYLES = ').includes(`'${s}'`), `${s} is accepted by the reel`);
  assert(html.includes(`data-anim-style="${s}"`), `${s} button is in the Lyric animation menu`);
  assert(css.includes(`.reel-container[data-anim="${s}"] .reel-word`), `${s} word styles exist`);
}
assert(/prefers-reduced-motion: reduce\)\s*\{[^@]*data-anim="typewriter"[\s\S]*data-anim="flip"/.test(css), 'new styles respect reduced motion');
assert(/REACTIVE_STYLES = new Set\(\[[^\]]*'neon'/.test(app), 'neon follows the beat');
assert(/lyricwave-v(3[6-9]|[4-9]\d)/.test(sw), 'service worker cache was bumped for the new styles');

assert(app.includes('applyLyricFont') && app.includes('applyLyricColor') && html.includes('data-lyric-font="serif"') && html.includes('data-lyric-color="gold"'), 'Lyric text font and colour pickers are wired');
assert(app.includes("classList.add('line-enter')") && css.includes('@keyframes lw-line-in'), 'line changes ease in');
assert(css.includes('transform: scaleX(0)') && app.includes('scaleX('), 'progress bar animates with transform');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
