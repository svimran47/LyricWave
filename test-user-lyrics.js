/**
 * Unit tests for Your lyrics: ids, rights and rows (user-lyrics.js), user lyrics winning over
 * LRCLIB and LRCLIB rights labelling (lyrics.js), and card limits / credits driven by lyrics rights
 * (card.js). LRCLIB is stubbed; all lyrics are placeholder text.
 */

import {
  userLyricsId, buildUserLyricsRow, detectLyricsType, cleanLyricsText, userLyricsRights,
  userLyricsToLyricsData, UserLyricsStore, rightsChoicesFor, LYRICS_RIGHTS, MAX_USER_LYRICS_CHARS
} from './user-lyrics.js';
import { fetchLyrics, setUserLyricsProvider, withLrclibRights, LRCLIB_RIGHTS } from './lyrics.js';
import { MemoryBackend } from './library.js';
import { quoteLimitsFor, cardLicenseCredit, MAX_QUOTE_LINES, OPEN_QUOTE_LINES } from './card.js';

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

const OV_ID = '2c51e4eb-dbe7-468c-ba6c-d1c85a1b71ae';
const song = { id: 's1', title: 'Placeholder Song (Remastered)', artist: 'Test Artist', source: 'search' };
const openSong = {
  id: `openverse_${OV_ID}`, title: 'Placeholder Tune', artist: 'Test Creator', source: 'openverse',
  openTrack: { openverseId: OV_ID, license: 'CC-BY-SA-3.0', licenseLabel: 'CC BY-SA 3.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0/', creator: 'Test Creator', provider: 'Jamendo' }
};
const PLAIN = 'Placeholder line one\nPlaceholder line two\nPlaceholder line three';
const LRC = '[00:01.00] Placeholder line one\n[00:04.50] Placeholder line two\n[00:08.00] Placeholder line three';

async function run() {
  console.log('\n📝 Ids and text');
  assert(userLyricsId(song) === userLyricsId({ ...song, title: 'Placeholder Song', mbid: '11111111-2222-4333-8444-555555555555' }),
    'Same song keeps its id when a tag is dropped or an MBID arrives later');
  assert(userLyricsId(song).startsWith('key:'), 'Ordinary songs use the artist + title key');
  assert(userLyricsId(openSong) === `ov:${OV_ID}`, 'Free music uses the Openverse id');
  assert(userLyricsId({}) === '', 'No title, no id');
  assert(cleanLyricsText('\r\n\r\nA  \r\nB\r\n\r\n') === 'A\nB', 'Line breaks unified, outer blank lines and trailing spaces dropped');
  assert(cleanLyricsText('x'.repeat(MAX_USER_LYRICS_CHARS + 50)).length === MAX_USER_LYRICS_CHARS, 'Text capped');
  assert(detectLyricsType(LRC) === 'synced' && detectLyricsType(PLAIN) === 'plain', 'LRC is detected as synced, text as plain');
  assert(detectLyricsType('[00:01.00] only one') === 'plain', 'A single timestamp is not enough to sync');

  console.log('\n📝 Rights');
  assert(rightsChoicesFor(song).every((c) => c.key !== 'song'), '"Same as the song" is not offered for ordinary songs');
  assert(rightsChoicesFor(openSong).some((c) => c.key === 'song'), '"Same as the song" is offered for Free music');
  assert(!LYRICS_RIGHTS.personal.allowsFull && LYRICS_RIGHTS.own.allowsFull, 'Personal copies keep the short quote; writers do not');
  let threw = '';
  try { buildUserLyricsRow({ track: song, text: '   ', rights: 'own' }); } catch (e) { threw = e.message; }
  assert(/lyrics first/.test(threw), 'Empty lyrics are refused');
  try { buildUserLyricsRow({ track: song, text: PLAIN, rights: 'song' }); } catch (e) { threw = e.message; }
  assert(/rights/.test(threw), '"Same as the song" is refused for ordinary songs');
  try { buildUserLyricsRow({ track: song, text: PLAIN, rights: 'made-up' }); } catch (e) { threw = e.message; }
  assert(/rights/.test(threw), 'Unknown rights are refused');

  const row = buildUserLyricsRow({ track: song, text: LRC, rights: 'cc-by-4.0', credit: '  Test   Lyricist ', now: 10 });
  assert(row.id === userLyricsId(song) && row.type === 'synced' && row.credit === 'Test Lyricist', 'Row keeps id, type and cleaned credit');
  const edited = buildUserLyricsRow({ track: song, text: PLAIN, rights: 'own', now: 20, existing: row });
  assert(edited.createdAt === 10 && edited.updatedAt === 20 && edited.type === 'plain', 'Editing keeps the creation time');

  const ccRights = userLyricsRights(row, song);
  assert(ccRights.allowsFull && ccRights.license === 'CC-BY-4.0' && ccRights.credit === 'Lyrics by Test Lyricist, CC BY 4.0', 'CC BY rights and credit');
  const personal = userLyricsRights({ rights: 'personal' }, song);
  assert(!personal.allowsFull && personal.credit === 'Your lyrics, personal copy', 'Personal copy credit');
  assert(userLyricsRights({ rights: 'own' }, song).credit === 'Lyrics added by their writer', 'Writer credit');
  const songRights = userLyricsRights({ rights: 'song' }, openSong);
  assert(songRights.allowsFull && songRights.license === 'CC-BY-SA-3.0' && songRights.label === 'CC BY-SA 3.0', '"Same as the song" takes the song license');
  const ndRights = userLyricsRights({ rights: 'song' }, { openTrack: { license: 'CC-BY-ND-4.0' } });
  assert(!ndRights.allowsFull, '"Same as the song" with a no-derivatives license keeps the short quote');

  console.log('\n📝 lyricsData');
  const synced = userLyricsToLyricsData(row, song);
  assert(synced.status === 'synced' && synced.syncedLines.length === 3 && synced.syncedLines[1].timeMs === 4500, 'Synced lyrics parse into timed lines');
  assert(synced.plainLyrics === PLAIN && synced.userLyrics === true && synced.rights.source === 'user', 'Plain text and rights included');
  const plain = userLyricsToLyricsData(edited, song);
  assert(plain.status === 'plain' && plain.plainLyrics === PLAIN && plain.syncedLines.length === 0, 'Plain lyrics stay plain');

  console.log('\n📝 Store and lookup order');
  const store = new UserLyricsStore(new MemoryBackend());
  assert((await store.lyricsFor(song)) === null, 'Nothing saved, nothing found');
  await store.put(row);
  const found = await store.lyricsFor({ ...song, title: 'Placeholder Song', id: 'other-source' });
  assert(found && found.status === 'synced', 'Saved lyrics are found for the same song from another source');

  // LRCLIB stub: any call means LyricWave went to LRCLIB.
  let lrclibCalls = 0;
  globalThis.fetch = async () => {
    lrclibCalls++;
    return { ok: true, status: 200, json: async () => ({ id: 42, syncedLyrics: '[00:01.00] Placeholder community line\n[00:03.00] Another placeholder line', plainLyrics: 'x', duration: 100 }) };
  };
  setUserLyricsProvider((track) => store.lyricsFor(track));
  const own = await fetchLyrics({ ...song, title: 'Placeholder Song' });
  assert(own.rights?.source === 'user' && lrclibCalls === 0, 'User lyrics win and LRCLIB is not asked');
  const community = await fetchLyrics({ id: 'x2', title: 'Unsaved Placeholder', artist: 'Another Artist', durationMs: 100000 });
  assert(lrclibCalls > 0 && community.status === 'synced', 'Songs without user lyrics still come from LRCLIB');
  assert(community.rights === LRCLIB_RIGHTS && community.rights.allowsFull === false, 'LRCLIB lyrics carry community rights');
  setUserLyricsProvider(() => { throw new Error('broken store'); });
  const fallback = await fetchLyrics({ id: 'x3', title: 'Unsaved Placeholder', artist: 'Another Artist', durationMs: 100000 });
  assert(fallback.status === 'synced', 'A failing user lyrics store falls back to LRCLIB');
  setUserLyricsProvider(null);
  assert(withLrclibRights({ status: 'not_found' }).rights === undefined, 'No rights on "not found" results');
  assert(withLrclibRights(synced).rights.source === 'user', 'Existing rights are kept');

  console.log('\n📝 Cards');
  assert(quoteLimitsFor(song, community).lines === MAX_QUOTE_LINES, 'LRCLIB lyrics keep the 4-line card limit');
  assert(quoteLimitsFor(song, userLyricsToLyricsData({ ...row, rights: 'personal' }, song)).lines === MAX_QUOTE_LINES, 'A personal copy keeps the 4-line limit');
  assert(quoteLimitsFor(song, synced).lines === OPEN_QUOTE_LINES, 'CC BY lyrics may fill a card');
  assert(cardLicenseCredit(song, synced) === 'Lyrics by Test Lyricist, CC BY 4.0', 'Card credits the lyrics rights');
  assert(cardLicenseCredit(song, community) === '', 'No extra credit line for LRCLIB lyrics');
  const songLyrics = userLyricsToLyricsData({ ...row, rights: 'song' }, openSong);
  assert(cardLicenseCredit(openSong, songLyrics) === 'CC BY-SA 3.0 · “Placeholder Tune” by Test Creator · Jamendo', '"Same as the song" lyrics reuse the song credit only');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
