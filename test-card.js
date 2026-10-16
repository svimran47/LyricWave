/**
 * Unit Test for the Lyrics Card Maker (card.js): line picking, selection limits,
 * wrapping / fitting, file names, art URLs, and a render pass on a mock 2D context.
 * Fixture lyrics are placeholders or public-domain nursery rhymes.
 */

import {
  getSelectableLines, defaultLineIndex, toggleLineSelection, wrapText, fitLyricLayout,
  ellipsize, cardFileName, upscaleArtUrl, renderLyricCard, shareTitle, clampQuote, cardShareMode,
  CARD_STYLES, CARD_FORMATS, MAX_QUOTE_LINES, MAX_QUOTE_CHARS
} from './card.js';

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

console.log('--- Testing lyric line picking ---');

const synced = {
  status: 'synced',
  syncedLines: [
    { timeMs: 0, text: '♪' },
    { timeMs: 1000, text: 'Twinkle, twinkle, little star' },
    { timeMs: 4000, text: '  How I   wonder what you are  ' },
    { timeMs: 7000, text: '' },
    { timeMs: 8000, text: '[Chorus]' },
    { timeMs: 9000, text: 'Up above the world so high' },
    { timeMs: 12000, text: 'Like a diamond in the sky' }
  ]
};
const lines = getSelectableLines(synced);
assert(lines.length === 4, 'Drops empty lines, note symbols and section markers');
assert(lines[1].text === 'How I wonder what you are', 'Collapses whitespace');
assert(lines[2].timeMs === 9000, 'Keeps line timestamps');

const plain = getSelectableLines({ status: 'plain', syncedLines: [], plainLyrics: 'Placeholder line one\n\nPlaceholder line two\r\n' });
assert(plain.length === 2 && plain[0].timeMs === null, 'Falls back to plain lyrics');
assert(getSelectableLines(null).length === 0, 'No lyrics -> no lines');
assert(getSelectableLines({ status: 'instrumental', syncedLines: [], plainLyrics: '' }).length === 0, 'Instrumental -> no lines');

assert(defaultLineIndex(lines, 10000) === 2, 'Starts on the line playing now');
assert(defaultLineIndex(lines, 0) === 0, 'Before the first line starts on the first line');
assert(defaultLineIndex(lines, NaN) === 0, 'Unknown position starts on the first line');
assert(defaultLineIndex(plain, 5000) === 0, 'Plain lyrics start on the first line');
assert(defaultLineIndex([], 0) === -1, 'Empty list has no default');

console.log('\n--- Testing line selection ---');

const many = Array.from({ length: 10 }, (_, i) => ({ text: `Placeholder line ${i}`, timeMs: i * 1000 }));
let sel = toggleLineSelection(null, 3, many);
assert(sel.start === 3 && sel.end === 3, 'First tap selects one line');
sel = toggleLineSelection(sel, 4, many);
assert(sel.start === 3 && sel.end === 4, 'Tapping the next line extends down');
sel = toggleLineSelection(sel, 2, many);
assert(sel.start === 2 && sel.end === 4, 'Tapping the previous line extends up');
sel = toggleLineSelection(sel, 5, many);
assert(sel.end - sel.start + 1 === MAX_QUOTE_LINES, `Extends up to ${MAX_QUOTE_LINES} lines`);
const capped = toggleLineSelection(sel, 6, many);
assert(capped.limited === true && capped.end === sel.end, 'Refuses a line past the quote limit');
sel = toggleLineSelection(sel, 5, many);
assert(sel.start === 2 && sel.end === 4, 'Tapping the last line drops it');
sel = toggleLineSelection(sel, 2, many);
assert(sel.start === 3 && sel.end === 4, 'Tapping the first line drops it');
sel = toggleLineSelection(sel, 8, many);
assert(sel.start === 8 && sel.end === 8, 'Tapping a far line starts over');
const single = toggleLineSelection(sel, 8, many);
assert(single.start === 8 && single.end === 8, 'A single selected line cannot be emptied');

const long = Array.from({ length: 4 }, () => ({ text: 'x'.repeat(100), timeMs: null }));
const longSel = toggleLineSelection(toggleLineSelection(null, 0, long), 1, long);
assert(longSel.end === 1, 'Two long lines fit the character cap');
assert(toggleLineSelection(longSel, 2, long).limited === true, 'A third long line breaks the character cap');

console.log('\n--- Testing wrapping & fitting ---');

const mono = (size) => (s) => s.length * size * 0.5; // fake monospace font: each char is half its size wide
const rows = wrapText('one two three four five six', 60, mono(10));
assert(rows.length === 3 && rows.every((r) => mono(10)(r) <= 60), 'Wraps at word boundaries within width');
assert(rows.join(' ') === 'one two three four five six', 'Wrapping keeps every word in order');
const broken = wrapText('supercalifragilistic', 50, mono(10));
assert(broken.length > 1 && broken.join('') === 'supercalifragilistic', 'Splits words wider than a row');
assert(wrapText('', 100, mono(10)).length === 0, 'Empty text wraps to no rows');

const box = { maxWidth: 400, maxHeight: 300, maxSize: 84, minSize: 36, lineHeight: 1.2, gap: 0.3 };
const short = fitLyricLayout(['Short line'], box, mono);
assert(short.fontSize === 84, 'Short quote uses the largest size');
const tall = fitLyricLayout(many.slice(0, 4).map((l) => `${l.text} with some extra words to wrap`), { ...box, maxHeight: 700 }, mono);
assert(tall.fontSize < 84 && tall.height <= 700, 'Long quote shrinks until it fits');
const huge = fitLyricLayout(['word '.repeat(200)], box, mono);
assert(huge.fontSize === 36, 'Never goes below the minimum size');

assert(ellipsize('Short', 500, mono(10)) === 'Short', 'Ellipsize leaves text that fits');
const cut = ellipsize('A very long placeholder song title that will not fit', 120, mono(10));
assert(cut.endsWith('…') && mono(10)(cut) <= 120, 'Ellipsize trims to width with an ellipsis');

console.log('\n--- Testing file names & art URLs ---');

assert(cardFileName({ title: 'Song Title!', artist: 'Bjørk & Friends' }) === 'lyricwave-bj-rk-friends-song-title.png', 'File name is a safe slug');
assert(cardFileName({ title: 'Café', artist: 'Noël' }) === 'lyricwave-noel-cafe.png', 'File name strips accents');
assert(cardFileName({}) === 'lyricwave-card.png', 'File name falls back when the track is blank');
assert(upscaleArtUrl('https://is1-ssl.mzstatic.com/image/thumb/a/b/100x100bb.jpg') === 'https://is1-ssl.mzstatic.com/image/thumb/a/b/600x600bb.jpg', 'iTunes art is requested at 600px');
assert(upscaleArtUrl('https://i.scdn.co/image/abc123') === 'https://i.scdn.co/image/abc123', 'Other art URLs are left alone');
assert(upscaleArtUrl('') === '', 'No art URL stays empty');

console.log('\n--- Testing share title, quote caps & share mode ---');

assert(shareTitle({ title: 'Song', artist: 'Artist' }) === 'Song by Artist', 'Share title credits song and artist');
assert(shareTitle({ title: ' Song ', artist: '' }) === 'Song', 'Share title without an artist is just the song');
assert(shareTitle({ title: 'Song' }) === 'Song', 'Share title never says "by undefined"');
assert(shareTitle({ artist: 'Artist' }) === 'Artist', 'Share title falls back to the artist');
assert(shareTitle(null) === '', 'Share title of no track is empty');

assert(clampQuote(['a', '', '  b  ', null]).join('|') === 'a|b', 'Quote drops blank lines and trims');
assert(clampQuote(many.map((l) => l.text)).length === MAX_QUOTE_LINES, `Quote keeps at most ${MAX_QUOTE_LINES} lines`);
const oneLong = clampQuote(['y'.repeat(500)]);
assert(oneLong.length === 1 && oneLong[0].length === MAX_QUOTE_CHARS && oneLong[0].endsWith('…'), 'A single over-long line is cut to the character cap');
const overflow = clampQuote(['z'.repeat(150), 'w'.repeat(150), 'never shown']);
assert(overflow.length === 2 && overflow.join('').length === MAX_QUOTE_CHARS && overflow[1].endsWith('…'), 'Lines past the character cap are cut with an ellipsis');
assert(clampQuote(undefined).length === 0, 'Quote of nothing is empty');

assert(cardShareMode({ hasNativeBridge: true, canShareFiles: false }) === 'native', 'Android app shares through the native bridge');
assert(cardShareMode({ hasNativeBridge: true, canShareFiles: true }) === 'native', 'Native bridge wins over Web Share');
assert(cardShareMode({ hasNativeBridge: false, canShareFiles: true }) === 'web', 'Phones with Web Share use it');
assert(cardShareMode({ hasNativeBridge: false, canShareFiles: false }) === 'none', 'Desktop without Web Share is Download only');

console.log('\n--- Testing card rendering ---');

function mockCtx() {
  const calls = { fillText: [], fillRect: 0, drawImage: 0 };
  const ctx = {
    calls,
    font: '10px sans-serif',
    save() {}, restore() {}, clearRect() {}, beginPath() {}, clip() {}, roundRect() {},
    fillRect() { calls.fillRect++; },
    drawImage() { calls.drawImage++; },
    fillText(text) { calls.fillText.push(text); },
    measureText(s) { const size = Number((/(\d+)px/.exec(this.font) || [0, 10])[1]); return { width: s.length * size * 0.5 }; },
    createLinearGradient() { return { addColorStop() {} }; },
    createRadialGradient() { return { addColorStop() {} }; }
  };
  return ctx;
}

const quote = ['Twinkle, twinkle, little star', 'How I wonder what you are'];
for (const style of Object.keys(CARD_STYLES)) {
  for (const format of Object.keys(CARD_FORMATS)) {
    const ctx = mockCtx();
    const layout = renderLyricCard(ctx, { lines: quote, title: 'Twinkle Twinkle', artist: 'Traditional', style, format });
    const drawn = ctx.calls.fillText.join(' ');
    assert(quote.every((l) => l.split(' ').every((w) => drawn.includes(w))) && drawn.includes('Twinkle Twinkle') && drawn.includes('Traditional'),
      `${style}/${format}: draws the quote, title and artist`);
    assert(layout.fontSize >= 36, `${style}/${format}: quote font size is readable (${layout.fontSize}px)`);
  }
}

const artCtx = mockCtx();
const fakeArt = { naturalWidth: 600, naturalHeight: 600 };
renderLyricCard(artCtx, {
  lines: quote, title: 'T', artist: 'A', art: fakeArt, style: 'spotlight', format: 'square',
  makeCanvas: (w, h) => ({ width: w, height: h, getContext: () => mockCtx() })
});
assert(artCtx.calls.drawImage >= 2, 'Spotlight draws the album art background and thumbnail');

const noArtCtx = mockCtx();
renderLyricCard(noArtCtx, { lines: quote, title: 'T', artist: 'A', art: null, style: 'spotlight', format: 'square' });
assert(noArtCtx.calls.drawImage === 0, 'Cards render without album art');

const fallbackCtx = mockCtx();
renderLyricCard(fallbackCtx, { lines: quote, title: '', artist: '', style: 'nope', format: 'nope' });
assert(fallbackCtx.calls.fillText.includes('Unknown song'), 'Unknown style/format and blank track still render');

const longCtx = mockCtx();
renderLyricCard(longCtx, { lines: ['q'.repeat(400), 'never drawn'], title: 'T', artist: 'A', style: 'aurora', format: 'square' });
const longDrawn = longCtx.calls.fillText.join('');
assert(!longDrawn.includes('never drawn') && (longDrawn.match(/q/g) || []).length < MAX_QUOTE_CHARS, 'Renderer enforces the quote caps itself');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
