/**
 * Unit tests for the kinetic lyric style (kinetic.js) and its wiring.
 */

import { readFileSync } from 'node:fs';
import { kineticRoles, cleanWord } from './kinetic.js';

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

console.log('--- Testing kinetic lyric roles ---');

const words = (s) => s.split(/\s+/);
const roleOf = (line, word) => {
  const w = words(line);
  return kineticRoles(w)[w.findIndex((x) => cleanWord(x) === word)];
};

assert(cleanWord('"Lucky!"') === 'lucky' && cleanWord("don't,") === "don't", 'cleanWord strips punctuation, keeps apostrophes');

let r = kineticRoles(words("We're up all night to get lucky"));
assert(r.length === 7, 'one role per word');
assert(r.filter((x) => x === 'accent').length === 1, 'exactly one accent word');
assert(roleOf("We're up all night to get lucky", 'lucky') === 'accent', 'the longest content word is the accent');
assert(roleOf("We're up all night to get lucky", 'all') === 'box', 'an emphatic word gets the accent box');

r = kineticRoles(words('just one prompt'));
assert(r[0] === 'lead', 'an opening filler word becomes the italic lead');
assert(r.includes('accent') || r.includes('box'), 'the rest of the line still has a highlighted word');

assert(roleOf('This is not after effects', 'not') === 'box', '"not" is boxed like the reference');
assert(roleOf('This is not after effects', 'effects') === 'accent', 'key word after the box is the accent');

r = kineticRoles(['Type.']);
assert(r[0] === 'hero', 'a one-word line is the big hero word');
r = kineticRoles(['Hold', 'up']);
assert(r.filter((x) => x === 'hero').length === 1 && r[0] === 'hero', 'two-word line: the strongest word is the hero');

assert(kineticRoles([]).length === 0 && kineticRoles(null).length === 0, 'empty / missing line -> no roles, never throws');
r = kineticRoles(words('oh oh oh'));
assert(r.every((x) => ['lead', 'plain', 'accent', 'box', 'hero'].includes(x)), 'all-filler line still returns valid roles');

// Wiring
const app = readFileSync('app.js', 'utf8');
const reel = readFileSync('reel.js', 'utf8');
const html = readFileSync('index.html', 'utf8');
const css = readFileSync('styles.css', 'utf8');
const sw = readFileSync('sw.js', 'utf8');
const gradle = readFileSync('android/app/build.gradle', 'utf8');
assert(/import \{ kineticRoles \} from '\.\/kinetic\.js'/.test(app), 'app.js imports kinetic.js');
assert(/const ANIM_STYLES = \[[^\]]*'kinetic'/.test(app), 'kinetic is a selectable lyric animation');
assert(/span\.dataset\.k = roles\[i\]/.test(app), 'each reel word gets its kinetic role');
assert(/const ANIMATION_STYLES = \[[^\]]*'kinetic'/.test(reel) && /style === 'kinetic'/.test(reel), 'reel tracks words for kinetic');
assert(/data-anim-style="kinetic"/.test(html), 'Kinetic button in the Lyric animation menu');
assert(/\.reel-container\[data-anim="kinetic"\] \.reel-word\[data-k="accent"\]/.test(css), 'kinetic accent styles exist');
assert(/prefers-reduced-motion: reduce\)[\s\S]*data-anim="kinetic"/.test(css), 'kinetic respects reduced motion');
assert(sw.includes("'./kinetic.js'") && gradle.includes("'kinetic.js'"), 'kinetic.js ships offline and in the APK');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
