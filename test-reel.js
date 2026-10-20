/**
 * Unit Test for ReelVisualizer Logic & Word-by-Word Timing
 */

import { ReelVisualizer } from './reel.js';

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

console.log('--- Testing ReelVisualizer ---');

// Mock canvas and 2D context for Node.js test environment
const mockCtx = {
  setTransform: () => {},
  scale: () => {},
  clearRect: () => {},
  beginPath: () => {},
  moveTo: () => {},
  lineTo: () => {},
  stroke: () => {}
};

const mockCanvas = {
  getContext: () => mockCtx,
  getBoundingClientRect: () => ({ width: 800, height: 400 }),
  width: 800,
  height: 400
};

// Polyfill window / matchMedia if missing in Node
if (typeof window === 'undefined') {
  globalThis.window = {
    innerWidth: 800,
    innerHeight: 400,
    devicePixelRatio: 1,
    addEventListener: () => {},
    matchMedia: () => ({ matches: false, addEventListener: () => {} })
  };
}

const reel = new ReelVisualizer(mockCanvas, null, { theme: 'pixel', wordByWordMode: true });

assert(reel.theme === 'pixel', 'Initial theme is pixel');
assert(reel.wordByWordMode === true, 'Initial word-by-word mode is true');

// 1. Line Word Timing Allocation
const sampleLine = {
  timeMs: 10000,
  text: 'Hello world this is LyricWave' // 5 words
};
const nextLineTime = 15000; // 5000ms duration -> 1000ms per word

reel.setActiveLine(sampleLine, 0, nextLineTime);

assert(reel.activeWords.length === 5, 'Line split into 5 words');
assert(reel.activeWords[0].text === 'Hello', 'First word is Hello');
assert(reel.activeWords[0].startMs === 10000, 'Word 0 starts at 10000ms');
assert(reel.activeWords[0].endMs === 11000, 'Word 0 ends at 11000ms');
assert(reel.activeWords[1].startMs === 11000, 'Word 1 starts at 11000ms');
assert(reel.activeWords[4].endMs === 15000, 'Word 4 ends at 15000ms');

// 2. Word-by-Word State Evaluation
// At 9500ms (before line starts): word index should be -1
let state = reel.render(9500, true);
assert(state.currentWordIndex === -1, 'At 9500ms, word index is -1');

// At 10500ms (during word 0 "Hello"): word index should be 0
state = reel.render(10500, true);
assert(state.currentWordIndex === 0, 'At 10500ms, word index is 0 ("Hello")');

// At 12500ms (during word 2 "this"): word index should be 2
state = reel.render(12500, true);
assert(state.currentWordIndex === 2, 'At 12500ms, word index is 2 ("this")');

// At 14800ms (during word 4 "LyricWave"): word index should be 4
state = reel.render(14800, true);
assert(state.currentWordIndex === 4, 'At 14800ms, word index is 4 ("LyricWave")');

// 3. Theme Switching
reel.setTheme('neon');
assert(reel.theme === 'neon', 'Theme switched to neon');
reel.setTheme('minimal');
assert(reel.theme === 'minimal', 'Theme switched to minimal');
reel.setTheme('aurora');
assert(reel.theme === 'aurora', 'Theme switched to aurora');
reel.setTheme('vinyl');
assert(reel.theme === 'vinyl', 'Theme switched to vinyl');
reel.setTheme('paper');
assert(reel.theme === 'paper', 'Theme switched to paper');
reel.setTheme('adaptive');
assert(reel.theme === 'adaptive', 'Theme switched to adaptive');

// 4. Word Mode Toggle
reel.setWordByWordMode(false);
state = reel.render(12500, true);
assert(state.wordByWordMode === false, 'Word-by-word mode can be disabled');

// 5. Adaptive frame rate: full rate by default, 30fps only while drawing is slow
assert(reel.minFrameIntervalMs === 0, 'Reel draws at the full display rate by default');
for (let i = 0; i < 80; i++) reel._governFrameRate(15);
assert(reel.minFrameIntervalMs === 33, 'Sustained slow drawing falls back to 30fps');
for (let i = 0; i < 700; i++) reel._governFrameRate(1);
assert(reel.minFrameIntervalMs === 0, 'Cheap drawing returns to the full rate');

console.log(`\nReel tests completed: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
