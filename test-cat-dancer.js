/**
 * Unit tests for the dancing cat (cat-dancer.js) and its shipped sprite assets.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import {
  CatDancer, chooseMove, beatMotion, frameAt, loopDurationMs, DEFAULT_BPM, LOOP_BEATS, MANIFEST_URL, STORAGE_CAT_DANCER_KEY
} from './cat-dancer.js';

let passed = 0;
let failed = 0;

function assert(condition, desc) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${desc}`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${desc}`);
  }
}

console.log('--- Testing CatDancer ---');

// loopDurationMs: LOOP_BEATS beats at the bpm, default when unknown, clamped
assert(loopDurationMs(120) === (60000 / 120) * LOOP_BEATS, '120 bpm -> 4 beats = 2000 ms');
assert(loopDurationMs(0) === loopDurationMs(DEFAULT_BPM), 'bpm 0 falls back to the default tempo');
assert(loopDurationMs(NaN) === loopDurationMs(DEFAULT_BPM), 'NaN bpm falls back to the default tempo');
assert(loopDurationMs(200) < loopDurationMs(90), 'faster songs dance faster');
assert(loopDurationMs(1000) === loopDurationMs(DEFAULT_BPM), 'absurd bpm is ignored');
assert(loopDurationMs(55) <= 4200 && loopDurationMs(219) >= 900, 'loop length stays within 0.9-4.2 s');

// frameAt: covers 0..frames-1 across one loop, wraps, never out of range
assert(frameAt(0, 2000, 10) === 0, 'loop starts on frame 0');
assert(frameAt(1999, 2000, 10) === 9, 'loop ends on the last frame');
assert(frameAt(2000, 2000, 10) === 0, 'wraps to frame 0');
assert(frameAt(-50, 2000, 10) >= 0, 'negative elapsed stays in range');
assert(frameAt(500, 2000, 0) === 0, 'zero frames -> 0');

// chooseMove
const all = ['hub', 'sway', 'arms', 'lean', 'step'];
assert(chooseMove({ energy: 0.9 }, 'hello', all, 0, false) === 'hub', 'paused -> hub pose');
assert(chooseMove({ energy: 0 }, '', all, 1) !== 'hub', 'a silent gap between lines still dances (no standing around)');
assert(chooseMove({ energy: 0.5, vocal: 0.9 }, '', all, 0) === 'step', 'vocal peak -> a vocal move');
assert(chooseMove({ energy: 0.5 }, 'Oh yeah!', all, 0) === 'step', 'shouted lyric -> a vocal move');
const grooves = new Set([0, 1, 2, 3].map((n) => chooseMove({ energy: 0.5 }, 'walking down the street', all, n)));
assert(grooves.size === 4 && !grooves.has('hub'), 'groove moves rotate through sway/arms/lean/step');
assert(chooseMove({ energy: 0.5 }, 'x', ['hub'], 7) === 'hub', 'only the hub pose -> hub');
assert(chooseMove({ energy: 0.5 }, 'x', [], 0) === null, 'no moves -> null, never throws');
assert(all.includes(chooseMove(null, null, all, 0)), 'missing frame/line -> a valid move, never throws');
assert(all.includes(chooseMove({ energy: 0.9, vocal: 0.9 }, 'hey', all, 0)), 'missing "climax" move falls back to an available one');

// Variety: never the same move twice in a row while dancing, even with a two-move set or shouty lyrics
let prev = null;
let repeats = 0;
const seen = new Set();
for (let n = 0; n < 40; n++) {
  const pick = chooseMove({ energy: 0.6, vocal: n % 3 === 0 ? 0.9 : 0.2 }, n % 4 === 0 ? 'oh yeah!' : 'la di da', all, n, true, prev);
  if (pick === prev) repeats++;
  seen.add(pick);
  prev = pick;
}
assert(repeats === 0, 'no move repeats back to back over 40 loops');
assert(seen.size >= 4, `uses at least 4 different moves over 40 loops (got ${seen.size})`);
const pair = [0, 1, 2, 3].reduce((acc, n) => acc.concat(chooseMove({ energy: 0.6 }, 'x', ['hub', 'lean'], n, true, acc[acc.length - 1] || null)), []);
assert(pair.every((m, i) => i === 0 || m !== pair[i - 1]), 'a two-move set alternates instead of repeating one step');

// beatMotion: hops on the beat, tilt alternates sides, bounded
const onBeat = beatMotion({ beat: 1, energy: 1 }, 0);
const offBeat = beatMotion({ beat: 0, energy: 1 }, 0);
assert(onBeat.hop > 0.05 && onBeat.hop <= 0.08 && offBeat.hop === 0, 'hops on the beat, rests between beats');
assert(Math.sign(beatMotion({ beat: 1, energy: 0.5 }, 0).tilt) === -Math.sign(beatMotion({ beat: 1, energy: 0.5 }, 1).tilt), 'tilt alternates side every beat');
assert(Math.abs(onBeat.tilt) <= 0.09, 'tilt stays small (about 5 degrees max)');
const junkMotion = beatMotion(null, NaN);
assert(Number.isFinite(junkMotion.hop) && Number.isFinite(junkMotion.tilt), 'bad input -> finite motion, never throws');

// CatDancer in Node (no DOM): construct, toggle and render without throwing
const dancer = new CatDancer(null, { fetchImpl: () => Promise.resolve({ ok: false }) });
let threw = false;
try {
  dancer.setLine('la la');
  dancer.reset();
  dancer.render({ energy: 1 }, true, 0);
} catch {
  threw = true;
}
assert(!threw, 'works without a DOM');
assert(!dancer.active, 'inactive until enabled and loaded');
assert(STORAGE_CAT_DANCER_KEY === 'lyricwave_cat_dancer', 'settings key is stable');

// App wiring: off by default, toggle in Settings, hooked to the beat frame, line changes and track changes
const app = readFileSync('app.js', 'utf8');
const html = readFileSync('index.html', 'utf8');
assert(/import \{[^}]*CatDancer[^}]*\} from '\.\/cat-dancer\.js'/.test(app), 'app.js imports cat-dancer.js');
assert(/id="settingCatDancer" type="checkbox">/.test(html), 'Settings toggle exists and is unchecked by default');
assert(/catDancer\.render\(frame, tick\.isPlaying/.test(app), 'cat renders from the audio-reactive frame');
assert(/catDancer\?\.setLine\(/.test(app), 'cat hears line changes');
assert(/catDancer\?\.reset\(\)/.test(app), 'cat resets on track change');
assert(/localStorage\.getItem\(STORAGE_CAT_DANCER_KEY\) === 'true'/.test(app), 'cat stays off unless the user turned it on');

// Packaging: offline cache + APK
const sw = readFileSync('sw.js', 'utf8');
const gradle = readFileSync('android/app/build.gradle', 'utf8');
assert(sw.includes("'./cat-dancer.js'"), 'service worker precaches cat-dancer.js');
assert(/include 'assets\/cat\/\*\*'/.test(gradle), 'APK packs assets/cat/**');

// Shipped assets: manifest + one sprite strip per move, within budget, no source video shipped
const manifestPath = MANIFEST_URL;
assert(existsSync(manifestPath), 'assets/cat/manifest.json exists');
if (existsSync(manifestPath)) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert(Array.isArray(manifest.moves) && manifest.moves.length >= 2, 'manifest lists at least two moves');
  assert(manifest.moves.some((m) => m.name === 'hub'), 'manifest has the hub pose');
  let total = statSync(manifestPath).size;
  for (const m of manifest.moves) {
    const file = `assets/cat/${m.file}`;
    const ok = existsSync(file);
    assert(ok && m.frames >= 2 && m.w > 0 && m.h > 0, `${m.file}: exists with ${m.frames} frames of ${m.w}x${m.h}`);
    if (ok) total += statSync(file).size;
  }
  assert(total <= 10 * 1024 * 1024, `cat assets total ${(total / 1024).toFixed(0)} KB (budget 10 MB)`);
}
assert(!existsSync('assets/cat/1000044843.mp4') && !/\.mp4/.test(gradle.match(/include 'assets\/cat[^']*'/)?.[0] || ''),
  'source video is not shipped');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
