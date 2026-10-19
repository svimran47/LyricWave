/**
 * Unit tests for Free music: the Openverse client and result normalizer (openverse.js), the
 * OpenTrackInfo contract (types.js), open rows in the library (library.js), the Library view
 * helpers and the lyrics card quote limits for openly licensed songs (card.js).
 * All network calls are stubbed; titles and creators are placeholders.
 */

import {
  licenseCode, licenseLabel, providerName, normalizeOpenverseResult, buildOpenverseSearchUrl,
  OpenverseClient, playableOpenTrack, openCreditLine, OPENVERSE_PAGE_SIZE
} from './openverse.js';
import { normalizeNowPlaying, normalizeOpenTrackInfo, openLicenseAllowsFullLyrics, stableTrackId } from './types.js';
import { LibraryCollector, LibraryStore, MemoryBackend, isCommercialOk, buildOpenTrackRow } from './library.js';
import { licenseBadge, openTrackSubline, formatDurationMs, freeSearchErrorText } from './library-view.js';
import {
  quoteLimitsFor, clampQuote, toggleLineSelection, cardLicenseCredit, MAX_QUOTE_LINES, OPEN_QUOTE_LINES,
  OPEN_QUOTE_CHARS
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

const OV_ID = '2c51e4eb-dbe7-468c-ba6c-d1c85a1b71ae';
const OV_ID_2 = '5d029c9d-1ab7-4f58-a90e-73d58eb03a28';

function ovResult(overrides = {}) {
  return {
    id: OV_ID.toUpperCase(),
    title: '  Placeholder   Tune ',
    foreign_landing_url: 'https://www.jamendo.com/track/000001',
    url: 'https://prod-1.storage.jamendo.com/?trackid=000001&format=mp32',
    creator: 'Test Creator',
    creator_url: 'https://www.jamendo.com/artist/000001',
    license: 'by-sa',
    license_version: '3.0',
    license_url: 'https://creativecommons.org/licenses/by-sa/3.0/',
    provider: 'jamendo',
    source: 'jamendo',
    genres: ['folk', 'acoustic'],
    attribution: '"Placeholder Tune" by Test Creator is licensed under CC BY-SA 3.0.',
    mature: false,
    audio_set: { title: 'Placeholder Album' },
    duration: 129000,
    thumbnail: `https://api.openverse.org/v1/audio/${OV_ID}/thumb/`,
    ...overrides
  };
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

async function run() {
  console.log('\n🎵 Openverse licenses');
  assert(licenseCode('cc0', '1.0') === 'CC0-1.0', 'cc0 -> CC0-1.0');
  assert(licenseCode('pdm', '') === 'PDM', 'pdm -> PDM');
  assert(licenseCode('by-nc-sa', '3.0') === 'CC-BY-NC-SA-3.0', 'by-nc-sa 3.0 -> CC-BY-NC-SA-3.0');
  assert(licenseCode('by', 'x') === 'CC-BY', 'Bad version is dropped');
  assert(licenseCode('', '4.0') === '', 'No license -> empty code');
  assert(licenseLabel('by-sa', '3.0') === 'CC BY-SA 3.0', 'Label: CC BY-SA 3.0');
  assert(licenseLabel('pdm') === 'Public domain', 'Label: Public domain');
  assert(licenseLabel('cc0', '1.0') === 'CC0', 'Label: CC0');
  assert(isCommercialOk('CC-BY-4.0') && isCommercialOk('CC-BY-SA-3.0') && isCommercialOk('PDM') && isCommercialOk('CC0-1.0'), 'BY, BY-SA, PDM and CC0 are commercial-OK');
  assert(!isCommercialOk('CC-BY-NC-3.0') && !isCommercialOk('CC-BY-ND-4.0') && !isCommercialOk('CC-SAMPLING+-1.0'), 'NC, ND and sampling are not commercial-OK');
  assert(providerName('wikimedia_audio') === 'Wikimedia Commons' && providerName('some_host') === 'Some Host', 'Provider names');

  console.log('\n🎵 Result normalizer');
  const item = normalizeOpenverseResult(ovResult());
  assert(item && item.id === `openverse_${OV_ID}`, 'Id is lower-cased and prefixed');
  assert(item.title === 'Placeholder Tune' && item.artist === 'Test Creator', 'Title / creator are cleaned');
  assert(item.album === 'Placeholder Album' && item.durationMs === 129000, 'Album from audio_set, duration in ms');
  assert(item.openTrack.license === 'CC-BY-SA-3.0' && item.openTrack.licenseLabel === 'CC BY-SA 3.0', 'License code and label');
  assert(item.openTrack.commercialOk === true, 'BY-SA is commercial-OK');
  assert(item.openTrack.provider === 'Jamendo' && item.openTrack.landingUrl.startsWith('https://www.jamendo.com/'), 'Host name and page');
  assert(item.openTrack.attribution.includes('CC BY-SA 3.0'), 'Openverse credit line kept');
  assert(normalizeOpenverseResult(ovResult({ mature: true })) === null, 'Mature results are dropped');
  assert(normalizeOpenverseResult(ovResult({ url: 'http://insecure.example/a.mp3' })) === null, 'Non-https audio is dropped');
  assert(normalizeOpenverseResult(ovResult({ license: '' })) === null, 'Results without a license are dropped');
  assert(normalizeOpenverseResult(ovResult({ id: 'not-a-uuid' })) === null, 'Results without a valid id are dropped');
  const nc = normalizeOpenverseResult(ovResult({ license: 'by-nc-nd', creator_url: 'javascript:alert(1)' }));
  assert(nc.openTrack.commercialOk === false, 'BY-NC-ND is not commercial-OK');
  assert(nc.openTrack.creatorUrl === '', 'Non-https creator links are dropped');
  const noCredit = normalizeOpenverseResult(ovResult({ attribution: '', title: '' }));
  assert(noCredit.title === 'Untitled' && noCredit.openTrack.attribution.includes('by Test Creator'), 'Missing credit is built from title, creator and license');
  assert(openCreditLine(item.openTrack) === 'CC BY-SA 3.0 · Test Creator · Jamendo', 'Compact credit line');

  console.log('\n🎵 Search URL and client');
  const url = new URL(buildOpenverseSearchUrl('  piano  ', { page: 2, pageSize: 99 }));
  assert(url.origin + url.pathname === 'https://api.openverse.org/v1/audio/', 'Openverse audio endpoint');
  assert(url.searchParams.get('q') === 'piano' && url.searchParams.get('page') === '2', 'Query trimmed, page set');
  assert(url.searchParams.get('page_size') === String(OPENVERSE_PAGE_SIZE), 'Page size clamped to the anonymous maximum');
  assert(url.searchParams.get('category') === 'music' && url.searchParams.get('mature') === 'false', 'Music only, no mature results');
  assert(!url.searchParams.has('license_type'), 'All open licenses by default');
  assert(new URL(buildOpenverseSearchUrl('piano', { commercialOnly: true })).searchParams.get('license_type') === 'commercial', 'Commercial filter');
  assert(new URL(buildOpenverseSearchUrl('x'.repeat(300))).searchParams.get('q').length === 100, 'Query capped at 100 characters');

  const calls = [];
  const client = new OpenverseClient({
    fetchImpl: async (u) => {
      calls.push(u);
      return jsonResponse({ result_count: 2, page_count: 1, page: 1, results: [ovResult(), ovResult(), ovResult({ id: OV_ID_2 }), ovResult({ mature: true, id: OV_ID_2 })] });
    }
  });
  const res = await client.search('folk');
  assert(res.results.length === 2, 'Duplicates and mature results are filtered');
  assert(res.total === 2 && res.pageCount === 1, 'Paging numbers passed through');
  assert(calls.length === 1 && calls[0].includes('q=folk'), 'One request per search');
  const empty = await client.search('   ');
  assert(empty.results.length === 0 && calls.length === 1, 'Blank search sends nothing');

  const limited = new OpenverseClient({ fetchImpl: async () => jsonResponse({}, 429) });
  let code = '';
  try { await limited.search('folk'); } catch (err) { code = err.code; }
  assert(code === 'rate_limited', '429 -> rate_limited');
  const offline = new OpenverseClient({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  try { await offline.search('folk'); } catch (err) { code = err.code; }
  assert(code === 'network', 'Network failure -> network');
  assert(freeSearchErrorText({ code: 'rate_limited' }).includes('minute'), 'Rate-limit message');
  assert(freeSearchErrorText({ code: 'network' }).includes('online'), 'Offline message');

  console.log('\n🎵 Playback and the track contract');
  const playable = playableOpenTrack(item);
  assert(playable.previewUrl === item.openTrack.audioUrl && playable.playPreview === true, 'Plays the full open audio file');
  assert(playable.source === 'openverse' && playable.durationMs === 129000 && !playable.durationEstimated, 'Source and real duration');
  assert(playableOpenTrack({ title: 'x' }) === null, 'No openTrack -> not playable');
  const np = normalizeNowPlaying({ ...playable, isPlaying: true });
  assert(np.openTrack && np.openTrack.license === 'CC-BY-SA-3.0', 'normalizeNowPlaying keeps the license info');
  assert(np.stableId === `ov:${OV_ID}`, 'Stable id is the Openverse id');
  assert(stableTrackId({ title: 'A', artist: 'B' }).startsWith('key:'), 'Other tracks keep their usual stable id');
  assert(normalizeOpenTrackInfo({ openverseId: OV_ID, audioUrl: 'https://a.example/x.mp3' }) === null, 'OpenTrackInfo needs a license');
  assert(normalizeOpenTrackInfo({ ...item.openTrack, commercialOk: 'yes' }).commercialOk === false, 'commercialOk must be a real true');

  console.log('\n🎵 Library rows');
  const row = buildOpenTrackRow(playable, { now: 1000, played: false });
  assert(row.id === `ov:${OV_ID}` && row.playable === true && row.resolveStatus === 'open', 'Open row id, playable, never matched');
  assert(row.license === 'CC-BY-SA-3.0' && row.licenseUrl.includes('by-sa/3.0') && row.commercialOk === true, 'License fields on the row');
  assert(row.attribution.includes('Test Creator') && row.sourceUrl === item.openTrack.landingUrl && row.source === 'openverse', 'Credit and source page on the row');
  assert(row.playCount === 0 && row.durationSec === 129, 'A save has no plays; duration in seconds');

  let mbCalls = 0;
  const mb = { resolveRecording: async () => { mbCalls++; return null; }, getArtist: async () => null };
  let changes = 0;
  const collector = new LibraryCollector({ store: new LibraryStore(new MemoryBackend()), mb, now: () => 5000, onChange: () => { changes++; } });
  const saved = await collector.collectOpen(item, { played: false });
  assert(saved.playCount === 0 && changes === 1, 'Save stores the row without a play');
  const played = await collector.collect(normalizeNowPlaying({ ...playable, isPlaying: true }));
  assert(played.id === `ov:${OV_ID}` && played.playCount === 1, 'Playing the saved song adds a play to the same row');
  assert(played.openTrack.audioUrl === item.openTrack.audioUrl, 'Row keeps the audio URL for replay');
  assert(mbCalls === 0, 'Open tracks are never sent to MusicBrainz');
  const artist = await collector.store.getArtist(played.artistIds[0]);
  assert(artist && artist.source === 'openverse' && artist.sourceUrl === item.openTrack.creatorUrl, 'Creator row links to the creator page');
  assert(artist.commercialOk === false, 'Creator row is not marked commercial-OK');

  // A copyrighted song with the same title and artist must not take on the open license.
  const other = await collector.collect(normalizeNowPlaying({ id: 's1', title: 'Placeholder Tune', artist: 'Test Creator', source: 'search', duration: 129 }));
  assert(other.id !== played.id && !other.openTrack, 'Same-named non-open play gets its own row');
  const all = await collector.store.allTracks();
  assert(all.length === 2 && all.find((r) => r.id === played.id).playCount === 1, 'Open row is untouched');

  console.log('\n🎵 Library view helpers');
  assert(licenseBadge(row).text === 'CC BY-SA 3.0' && licenseBadge(row).tone === 'free', 'Open rows show their license');
  assert(openTrackSubline(item) === 'via Jamendo · 2:09', 'Host and duration line');
  assert(openTrackSubline(row) === 'via Jamendo · 2:09', 'Same line for a stored row');
  assert(formatDurationMs(0) === '' && formatDurationMs(61000) === '1:01', 'Duration format');

  console.log('\n🎵 Lyrics card limits');
  assert(openLicenseAllowsFullLyrics('CC-BY-4.0') && openLicenseAllowsFullLyrics('CC-BY-NC-SA-3.0') && openLicenseAllowsFullLyrics('PDM') && openLicenseAllowsFullLyrics('CC0-1.0'), 'Adaptable licenses allow longer quotes');
  assert(!openLicenseAllowsFullLyrics('CC-BY-ND-4.0') && !openLicenseAllowsFullLyrics('CC-BY-NC-ND-3.0') && !openLicenseAllowsFullLyrics('CC-SAMPLING+-1.0') && !openLicenseAllowsFullLyrics(''), 'ND, sampling and unknown keep the short quote');
  const openLimits = quoteLimitsFor(np);
  assert(openLimits.open && openLimits.lines === OPEN_QUOTE_LINES && openLimits.chars === OPEN_QUOTE_CHARS, 'Open song gets the longer limits');
  assert(quoteLimitsFor({ title: 'x', artist: 'y' }).lines === MAX_QUOTE_LINES, 'Other songs keep 4 lines');
  assert(quoteLimitsFor({ openTrack: { license: 'CC-BY-ND-4.0' } }).open === false, 'ND open song keeps 4 lines');
  const lines = Array.from({ length: 16 }, (_, i) => ({ text: `Placeholder line ${i + 1}` }));
  const texts = lines.map((l) => l.text);
  assert(clampQuote(texts).length === MAX_QUOTE_LINES, 'Default clamp: 4 lines');
  assert(clampQuote(texts, openLimits).length === OPEN_QUOTE_LINES, 'Open clamp: 12 lines');
  let sel = toggleLineSelection(null, 0, lines, openLimits);
  for (let i = 1; i < OPEN_QUOTE_LINES; i++) sel = toggleLineSelection(sel, i, lines, openLimits);
  assert(sel.end - sel.start + 1 === OPEN_QUOTE_LINES, 'Selection extends to 12 lines for open songs');
  assert(toggleLineSelection(sel, OPEN_QUOTE_LINES, lines, openLimits).limited === true, 'A 13th line is refused');
  assert(toggleLineSelection({ start: 0, end: 3 }, 4, lines).limited === true, 'Default selection still stops at 4');
  assert(cardLicenseCredit(np) === 'CC BY-SA 3.0 · “Placeholder Tune” by Test Creator · Jamendo', 'Card credit line');
  assert(cardLicenseCredit({ title: 'x' }) === '', 'No credit line for other songs');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
