/**
 * Kinetic lyric style ("Katana" motion type): each word of the current line slams in as it is sung,
 * heavy uppercase, with one key word picked out in the theme accent and an emphatic word set in an
 * accent box. A short filler word that opens the line sits above it in a small italic script.
 *
 * This module only decides each word's role (pure, testable); styles.css draws the motion under
 * .reel-container[data-anim="kinetic"], and app.js puts the role on each word span (data-k).
 *
 * Roles:
 *   'lead'  - opening filler word on its own row, small italic script ("just", "and", "oh")
 *   'hero'  - the one big word of a one- or two-word line
 *   'box'   - an emphatic word ("not", "never", "every"...), white on an accent box
 *   'accent'- the key word: the longest content word, in the accent colour
 *   'plain' - everything else, white
 */

const FILLERS = new Set([
  'a', 'an', 'the', 'and', 'but', 'or', 'so', 'just', 'oh', 'ooh', 'yeah', 'i', "i'm", 'im', 'you', 'we',
  'to', 'of', 'in', 'on', 'at', 'is', 'it', "it's", 'my', 'me', 'be', 'if', 'for', 'with', 'like', 'now',
  'all', 'this', 'that', 'your', 'our', 'they', 'he', 'she', 'when', 'then', 'got', 'get', 'was', 'are', 'do'
]);

const EMPHATIC = new Set([
  'not', 'no', 'never', 'nothing', 'every', 'everything', 'only', 'one', 'forever', 'always', 'love', 'stop',
  "don't", 'dont', "can't", 'cant', "won't", 'wont', 'nobody', 'all', 'more', 'last', 'first', 'fire'
]);

/** Lower-case word with surrounding punctuation stripped (keeps inner apostrophes). */
export function cleanWord(word) {
  return String(word || '').toLowerCase().replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '');
}

/**
 * @param {string[]} words the line's words in order
 * @returns {string[]} one role per word
 */
export function kineticRoles(words) {
  const list = Array.isArray(words) ? words : [];
  const roles = list.map(() => 'plain');
  if (!list.length) return roles;
  const clean = list.map(cleanWord);
  const content = clean.map((w, i) => (w && !FILLERS.has(w) ? i : -1)).filter((i) => i >= 0);

  if (list.length <= 2) {
    // One- or two-word line: the strongest word becomes the hero.
    const pick = content.length ? content.reduce((a, b) => (clean[b].length >= clean[a].length ? b : a)) : list.length - 1;
    roles[pick] = 'hero';
    return roles;
  }

  if (FILLERS.has(clean[0]) && clean[0].length <= 5) roles[0] = 'lead';

  const boxIdx = clean.findIndex((w, i) => roles[i] === 'plain' && EMPHATIC.has(w));
  if (boxIdx >= 0) roles[boxIdx] = 'box';

  const candidates = content.filter((i) => roles[i] === 'plain');
  if (candidates.length) {
    // Longest content word; on a tie the later one (lines tend to land on their key word).
    const accent = candidates.reduce((a, b) => (clean[b].length >= clean[a].length ? b : a));
    roles[accent] = 'accent';
  }
  return roles;
}

export default kineticRoles;
