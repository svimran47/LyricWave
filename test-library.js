/**
 * Unit tests for the open track collector: stable track ids (types.js), the MusicBrainz /
 * Wikidata clients and their 1 request/s queue (musicbrainz.js), the library store and
 * collector (library.js), the shared IndexedDB upgrade (db.js), the Library view helpers
 * and the /api/musicbrainz proxy. All network calls are stubbed; song names are placeholders.
 */

import { normalizeNowPlaying, normalizeMbid, normalizeIsrc, trackMatchKey, stableTrackId } from './types.js';
import {
  RateLimiter, MusicBrainzClient, WikidataClient, escapeLucene, buildRecordingQuery, simplifyTitle,
  primaryArtistName, pickRecording, pickRelease, coverArtUrl, wikidataIdFromRelations, MB_USER_AGENT,
  commonsLicenseCode, commonsPhotoFromImageInfo, stripHtml, ListenBrainzClient, normalizeSimilarArtists, LB_SIMILAR_URL,
  MB_MIN_INTERVAL_MS
} from './musicbrainz.js';
import {
  LibraryCollector, LibraryStore, MemoryBackend, isCommercialOk, buildProvisionalTrackRow,
  buildResolvedTrackRow, isCollectable, filterTracks, sortTracks, artistsWithCounts, buildOpenTrackRow, SIMILAR_REFRESH_MS
} from './library.js';
import { upgradeAppDB, DB_VERSION, TRACKS_STORE, ARTISTS_STORE, LYRICS_STORE, USER_LYRICS_STORE, PLAYLISTS_STORE } from './db.js';
import { licenseBadge, artistFacts, rowArtUrl, artistPhotoUrl, artistPhotoCaption, needsPhotoRefresh, freeMusicQueryFor } from './library-view.js';
import { onRequestGet as proxyGet } from './functions/api/musicbrainz.js';

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

const REC_ID = '11111111-2222-4333-8444-555555555555';
const REC_ID_2 = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const ARTIST_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const RG_ID = '12345678-90ab-4cde-8f01-234567890abc';
const REL_ID = 'fedcba98-7654-4321-8fed-cba987654321';

function recording(overrides = {}) {
  return {
    id: REC_ID,
    score: 100,
    title: 'Placeholder Song',
    length: 200000,
    'first-release-date': '2001-05-01',
    'artist-credit': [{ name: 'Test Artist', joinphrase: '', artist: { id: ARTIST_ID, name: 'Test Artist' } }],
    releases: [
      { id: REL_ID, title: 'Placeholder Album', status: 'Official', date: '2001-05-01', 'release-group': { id: RG_ID, 'primary-type': 'Album' } }
    ],
    isrcs: ['USAAA0100001'],
    ...overrides
  };
}

function jsonResponse(body, status = 200, type = 'application/json') {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? type : null) },
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

const instantLimiter = () => new RateLimiter(0, { sleep: async () => {} });

// ---------------------------------------------------------------------------
console.log('--- Testing stable track ids (types.js) ---');

assert(normalizeMbid(REC_ID.toUpperCase()) === REC_ID, 'normalizeMbid lower-cases a valid MBID');
assert(normalizeMbid('not-an-id') === '', 'normalizeMbid rejects junk');
assert(normalizeIsrc('us-aaa-01-00001') === 'USAAA0100001', 'normalizeIsrc strips dashes and upper-cases');
assert(normalizeIsrc('123') === '', 'normalizeIsrc rejects junk');
assert(trackMatchKey('Test Artist', 'Placeholder Song (feat. Guest)') === trackMatchKey('test artist', 'Placeholder Song'),
  'match key ignores case and (feat. X)');
assert(trackMatchKey('Test Artist', 'Placeholder Song - 2011 Remaster') === 'test artist__placeholder song', 'match key ignores "- Remaster" suffix');
assert(stableTrackId({ title: 'A', artist: 'B', mbid: REC_ID, isrc: 'USAAA0100001' }) === `mb:${REC_ID}`, 'stable id prefers the MBID');
assert(stableTrackId({ title: 'A', artist: 'B', isrc: 'USAAA0100001' }) === 'isrc:USAAA0100001', 'stable id falls back to the ISRC');
assert(stableTrackId({ title: 'A', artist: 'B' }) === 'key:b__a', 'stable id falls back to the artist + title key');

const normalized = normalizeNowPlaying({ id: 'x', title: 'Placeholder Song', artist: 'Test Artist', isrc: 'usaaa0100001', mbid: 'bad' });
assert(normalized.isrc === 'USAAA0100001' && !('mbid' in normalized), 'normalizeNowPlaying keeps a valid ISRC and drops a bad MBID');
assert(normalized.stableId === 'isrc:USAAA0100001', 'normalizeNowPlaying sets stableId');
assert(normalizeNowPlaying({ title: 'T', artist: 'A', mbid: REC_ID }).stableId === `mb:${REC_ID}`, 'normalizeNowPlaying stableId uses the MBID');
assert(normalizeNowPlaying({ title: 'T', artist: 'A' }).stableId === 'key:a__t', 'every normalized track has a stableId');

// ---------------------------------------------------------------------------
console.log('\n--- Testing MusicBrainz helpers ---');

assert(escapeLucene('AC/DC: "Live"') === 'AC\\/DC\\: \\"Live\\"', 'escapeLucene escapes query syntax');
assert(simplifyTitle('Placeholder Song (feat. Guest) - 2011 Remaster') === 'Placeholder Song', 'simplifyTitle drops feat. and remaster tags');
assert(primaryArtistName('Test Artist feat. Guest') === 'Test Artist', 'primaryArtistName drops feat.');
assert(primaryArtistName('Duo One & Duo Two') === 'Duo One', 'primaryArtistName takes the first of "A & B"');
assert(buildRecordingQuery('Placeholder Song (feat. Guest)', 'Test Artist, Other') === 'recording:"Placeholder Song" AND artist:"Test Artist"',
  'buildRecordingQuery uses the cleaned title and primary artist');

const want = { title: 'Placeholder Song', artist: 'Test Artist', durationSec: 201 };
assert(pickRecording([recording()], want)?.id === REC_ID, 'pickRecording accepts a matching recording');
assert(pickRecording([recording({ 'artist-credit': [{ name: 'Someone Else', artist: { id: ARTIST_ID, name: 'Someone Else' } }] })], want) === null,
  'pickRecording rejects a different artist');
assert(pickRecording([recording({ length: 320000 })], want) === null, 'pickRecording rejects a length 2 minutes off');
assert(pickRecording([recording({ length: 320000 })], { ...want, durationEstimated: true })?.id === REC_ID, 'pickRecording ignores length when it is only estimated');
assert(pickRecording([recording({ score: 60 })], want) === null, 'pickRecording rejects a low search score');
assert(pickRecording([recording({ title: 'Another Song' })], want) === null, 'pickRecording rejects a different title');
const bootleg = recording({ id: REC_ID_2, releases: [{ id: REL_ID, status: 'Bootleg', date: '1999' }] });
assert(pickRecording([bootleg, recording()], want)?.id === REC_ID, 'pickRecording prefers a recording with an official release');

const rel = pickRelease({ releases: [
  { id: 'a', status: 'Bootleg', date: '1990', 'release-group': { 'primary-type': 'Album' } },
  { id: 'b', status: 'Official', date: '2005', 'release-group': { 'primary-type': 'Compilation' } },
  { id: 'c', status: 'Official', date: '2001', 'release-group': { 'primary-type': 'Album' } }
] });
assert(rel?.id === 'c', 'pickRelease prefers an official album');
assert(coverArtUrl(RG_ID) === `https://coverartarchive.org/release-group/${RG_ID}/front-250`, 'coverArtUrl builds a release-group front image URL');
assert(coverArtUrl('junk') === '', 'coverArtUrl rejects a bad id');
assert(wikidataIdFromRelations([{ type: 'official homepage', url: { resource: 'https://example.org' } }, { type: 'wikidata', url: { resource: 'https://www.wikidata.org/wiki/Q42' } }]) === 'Q42',
  'wikidataIdFromRelations finds the Q-id');

// ---------------------------------------------------------------------------
console.log('\n--- Testing the 1 request/s queue ---');

{
  let clock = 0;
  const starts = [];
  const limiter = new RateLimiter(MB_MIN_INTERVAL_MS, { now: () => clock, sleep: async (ms) => { clock += ms; } });
  await Promise.all([1, 2, 3].map(() => limiter.schedule(async () => { starts.push(clock); })));
  assert(starts.length === 3, 'all queued tasks ran');
  assert(starts[1] - starts[0] >= 1000 && starts[2] - starts[1] >= 1000, `tasks start at least 1 s apart (${starts.join(', ')} ms)`);
  await limiter.schedule(async () => { throw new Error('boom'); }).catch(() => {});
  let ranAfterError = false;
  await limiter.schedule(async () => { ranAfterError = true; });
  assert(ranAfterError, 'queue keeps running after a failed task');
}
assert(MB_MIN_INTERVAL_MS >= 1000, 'MusicBrainz spacing is at least 1 second');

// ---------------------------------------------------------------------------
console.log('\n--- Testing MusicBrainzClient ---');

{
  const calls = [];
  const client = new MusicBrainzClient({
    useProxy: false,
    limiter: instantLimiter(),
    fetchImpl: async (url, init) => { calls.push({ url, init }); return jsonResponse({ recordings: [recording()] }); }
  });
  const rec = await client.resolveRecording({ title: 'Placeholder Song', artist: 'Test Artist', duration: 200 });
  assert(rec?.id === REC_ID, 'resolveRecording finds the recording by search');
  assert(calls[0].url.startsWith('https://musicbrainz.org/ws/2/recording?') && calls[0].url.includes('fmt=json'), 'direct call goes to musicbrainz.org/ws/2 with fmt=json');
  assert(calls[0].init.headers['User-Agent'] === MB_USER_AGENT, 'direct call outside a browser sends the LyricWave User-Agent');
  assert(/LyricWave\/\d/.test(MB_USER_AGENT) && /https?:\/\//.test(MB_USER_AGENT), 'User-Agent names the app, version and a contact URL');
}

{
  const calls = [];
  const client = new MusicBrainzClient({
    useProxy: false,
    limiter: instantLimiter(),
    fetchImpl: async (url) => { calls.push(url); return jsonResponse({ isrc: 'USAAA0100001', recordings: [recording()] }); }
  });
  const rec = await client.resolveRecording({ title: 'Placeholder Song', artist: 'Spelled Differently', isrc: 'USAAA0100001' });
  assert(rec?.id === REC_ID && calls[0].includes('/isrc/USAAA0100001'), 'resolveRecording uses the ISRC lookup first');
  assert(calls.length === 1, 'an ISRC hit needs no search request');
}

{
  const calls = [];
  const client = new MusicBrainzClient({
    useProxy: true,
    apiBase: 'https://app.example',
    limiter: instantLimiter(),
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.includes('/api/musicbrainz')) return jsonResponse('<html>', 404, 'text/html');
      return jsonResponse({ recordings: [] });
    }
  });
  await client.searchRecordings('Placeholder Song', 'Test Artist');
  await client.searchRecordings('Placeholder Song', 'Test Artist');
  assert(calls[0].startsWith('https://app.example/api/musicbrainz?path=recording'), 'browser builds try the /api/musicbrainz proxy first');
  assert(calls[1].startsWith('https://musicbrainz.org/'), 'no proxy (HTML 404) falls back to MusicBrainz directly');
  assert(calls.length === 3 && calls[2].startsWith('https://musicbrainz.org/'), 'after one miss the proxy is not retried');
}

{
  const client = new MusicBrainzClient({
    useProxy: true,
    limiter: instantLimiter(),
    fetchImpl: async () => jsonResponse({ error: 'Not Found' }, 404)
  });
  assert(await client.getArtist(ARTIST_ID) === null, 'a MusicBrainz 404 from the proxy resolves null');
  let threw = false;
  const busy = new MusicBrainzClient({ useProxy: true, limiter: instantLimiter(), fetchImpl: async () => jsonResponse({ error: 'busy' }, 503) });
  try { await busy.getArtist(ARTIST_ID); } catch { threw = true; }
  assert(threw && busy.useProxy === true, 'a 503 from the proxy throws instead of hammering MusicBrainz directly');
}

{
  const wd = new WikidataClient({
    fetchImpl: async (url) => {
      assert(url.includes('ids=Q42') && url.includes('origin=*'), 'Wikidata request asks for one entity with CORS origin=*');
      return jsonResponse({ entities: { Q42: { descriptions: { en: { value: 'placeholder band' } }, sitelinks: { enwiki: { title: 'Test Artist', url: 'https://en.wikipedia.org/wiki/Test_Artist' } } } } });
    }
  });
  const s = await wd.getSummary('q42');
  assert(s?.description === 'placeholder band' && s.wikipediaUrl === 'https://en.wikipedia.org/wiki/Test_Artist', 'WikidataClient returns description and Wikipedia link');
  assert(await wd.getSummary('nope') === null, 'WikidataClient ignores a bad Q-id');
}

// ---------------------------------------------------------------------------
console.log('\n--- Testing licenses ---');

assert(isCommercialOk('CC0-1.0') === true, 'CC0 is commercial-OK');
assert(isCommercialOk('CC-BY-4.0') === true && isCommercialOk('CC-BY-SA-4.0') === true, 'CC BY / BY-SA are commercial-OK');
assert(isCommercialOk('CC-BY-NC-4.0') === false, 'CC BY-NC is not commercial-OK');
assert(isCommercialOk('CC BY-ND 4.0') === false, 'CC BY-ND is not commercial-OK');
assert(isCommercialOk('unverified') === false && isCommercialOk('') === false, 'unknown licenses are not commercial-OK');

const provisional = buildProvisionalTrackRow({ title: 'Placeholder Song', artist: 'Test Artist', source: 'search', duration: 200, albumArt: 'https://example.org/a.jpg' }, 1000);
for (const field of ['license', 'licenseUrl', 'attribution', 'commercialOk', 'source', 'sourceUrl']) {
  assert(field in provisional, `provisional track row has ${field}`);
}
assert(provisional.license === 'unverified' && provisional.commercialOk === false, 'unmatched rows are flagged as not openly licensed');
assert(provisional.attribution.includes('iTunes'), 'unmatched rows credit where their details came from');

const resolvedRow = buildResolvedTrackRow(provisional, recording(), 2000);
assert(resolvedRow.id === `mb:${REC_ID}` && resolvedRow.mbid === REC_ID, 'resolved row id is the recording MBID');
assert(resolvedRow.isrc === 'USAAA0100001', 'resolved row takes the ISRC from MusicBrainz');
assert(resolvedRow.license === 'CC0-1.0' && resolvedRow.commercialOk === true, 'MusicBrainz metadata rows are CC0 and commercial-OK');
assert(resolvedRow.sourceUrl === `https://musicbrainz.org/recording/${REC_ID}`, 'resolved row links its MusicBrainz page');
assert(resolvedRow.art?.url.includes(RG_ID) && resolvedRow.art.commercialOk === false, 'cover art is credited and never marked commercial-OK');
assert(resolvedRow.artistIds[0] === `mb:${ARTIST_ID}`, 'resolved row points at the MusicBrainz artist');
assert(!('lyrics' in resolvedRow) && !('syncedLyrics' in resolvedRow), 'library rows never store lyrics');

assert(isCollectable({ title: 'Placeholder Song', playbackType: 'track' }), 'songs are collected');
assert(!isCollectable({ title: 'Advertisement', playbackType: 'ad' }) && !isCollectable({ title: 'Episode', playbackType: 'episode' }), 'ads and podcasts are skipped');

// ---------------------------------------------------------------------------
console.log('\n--- Testing LibraryCollector ---');

function fakeMb({ recordings = [recording()], artist = null } = {}) {
  const calls = { resolve: 0, artist: 0 };
  return {
    calls,
    async resolveRecording() { calls.resolve++; return recordings.shift() || null; },
    async getArtist() { calls.artist++; return artist; }
  };
}

{
  let clock = 10_000;
  let changes = 0;
  const resolvedFor = [];
  const store = new LibraryStore(new MemoryBackend());
  const mb = fakeMb();
  const collector = new LibraryCollector({
    store, mb, now: () => clock,
    wikidata: { getSummary: async () => ({ wikidataId: 'Q42', description: 'placeholder band', wikipediaUrl: 'https://en.wikipedia.org/wiki/Test_Artist' }) },
    onChange: () => { changes++; },
    onResolved: (track, row) => resolvedFor.push([track.id, row.id])
  });

  const track = normalizeNowPlaying({ id: 'search_1', title: 'Placeholder Song', artist: 'Test Artist', duration: 200, source: 'search' });
  const row = await collector.collect(track);
  assert(row.id === `mb:${REC_ID}`, 'first play is stored and matched to MusicBrainz');
  assert(changes >= 2, 'onChange fires for the new row and for the match');
  assert(resolvedFor[0][0] === 'search_1' && resolvedFor[0][1] === `mb:${REC_ID}`, 'onResolved reports the stable id for the playing track');
  const all = await store.allTracks();
  assert(all.length === 1, 'the provisional row is replaced, not duplicated');

  clock += 1000;
  const again = await collector.collect(normalizeNowPlaying({ id: 'chart_9', title: 'Placeholder Song (feat. Guest)', artist: 'Test Artist', source: 'chart' }));
  assert(again.playCount === 2, 'a second play of the same song bumps playCount');
  assert(mb.calls.resolve === 1, 'an already-matched song makes no new MusicBrainz request');
  assert(again.sources.includes('search') && again.sources.includes('chart'), 'row remembers every source it came from');

  const artists = await store.artists();
  assert(artists.length === 1 && artists[0].id === `mb:${ARTIST_ID}` && artists[0].trackCount === 2 - 1, 'artist list counts their songs');
  for (const field of ['license', 'licenseUrl', 'attribution', 'commercialOk', 'source', 'sourceUrl']) {
    assert(field in artists[0], `artist row has ${field}`);
  }

  mb.calls.artist = 0;
  const detailedMb = { ...mb, getArtist: async () => { mb.calls.artist++; return {
    id: ARTIST_ID, name: 'Test Artist', 'sort-name': 'Artist, Test', type: 'Group', country: 'GB', area: { name: 'United Kingdom' },
    'life-span': { begin: '1990' }, genres: [{ name: 'rock', count: 3 }, { name: 'pop', count: 5 }],
    relations: [{ type: 'wikidata', url: { resource: 'https://www.wikidata.org/wiki/Q42' } }]
  }; } };
  collector.mb = detailedMb;
  const details = await collector.refreshArtist(`mb:${ARTIST_ID}`);
  assert(details.description === 'placeholder band' && details.wikidataId === 'Q42', 'artist details include the Wikidata description');
  assert(details.genres[0] === 'pop' && details.type === 'Group' && details.area === 'United Kingdom', 'artist details include genres, type and area from MusicBrainz');
  assert(details.attribution.includes('Wikidata') && details.commercialOk === true, 'artist attribution credits MusicBrainz and Wikidata');
  await collector.refreshArtist(`mb:${ARTIST_ID}`);
  assert(mb.calls.artist === 1, 'fresh artist details are not fetched again');
}

{
  const store = new LibraryStore(new MemoryBackend());
  const collector = new LibraryCollector({ store, mb: fakeMb({ recordings: [] }), now: () => 5000 });
  const row = await collector.collect(normalizeNowPlaying({ id: 'mic_1', title: 'Unknown Placeholder', artist: 'Nobody', source: 'mic' }));
  assert(row.resolveStatus === 'not_found' && row.id.startsWith('key:'), 'an unmatched song stays in the library under its key id');
  assert(row.commercialOk === false, 'an unmatched song is not commercial-OK');
  const artists = await store.artists();
  assert(artists.length === 1 && artists[0].id.startsWith('key:') && artists[0].commercialOk === false, 'its artist is listed with an unverified license');
}

{
  const store = new LibraryStore(new MemoryBackend());
  const failing = { resolveRecording: async () => { throw new Error('offline'); } };
  const collector = new LibraryCollector({ store, mb: failing, now: () => 5000 });
  const row = await collector.collect(normalizeNowPlaying({ title: 'Placeholder Song', artist: 'Test Artist', source: 'search' }));
  assert(row.resolveStatus === 'error', 'a network failure is recorded and retried later, without throwing');
}

{
  // The same recording reached from two apps with different spellings merges into one row.
  const store = new LibraryStore(new MemoryBackend());
  const collector = new LibraryCollector({ store, mb: fakeMb({ recordings: [recording(), recording()] }), now: () => 5000 });
  await collector.collect(normalizeNowPlaying({ title: 'Placeholder Song', artist: 'Test Artist', source: 'search' }));
  await collector.collect(normalizeNowPlaying({ title: 'PLACEHOLDER SONG!', artist: 'Test Artist feat. Guest', source: 'phone', isrc: 'GBXXX0000009' }));
  const rows = await store.allTracks();
  assert(rows.length === 1 && rows[0].playCount === 2, 'two spellings of one recording merge into one row');
  const leftover = (await store.allArtists()).filter((a) => a.id.startsWith('key:'));
  assert(leftover.length === 0, 'placeholder artists are removed once their songs are matched');
}

{
  const rows = [
    { title: 'Bravo', artist: 'X', album: 'One', lastSeenAt: 1, playCount: 5, artistIds: ['a'] },
    { title: 'Alpha', artist: 'Y', album: 'Two', lastSeenAt: 3, playCount: 1, artistIds: ['b'] }
  ];
  assert(sortTracks(rows, 'recent')[0].title === 'Alpha' && sortTracks(rows, 'title')[0].title === 'Alpha' && sortTracks(rows, 'plays')[0].title === 'Bravo', 'sortTracks by recent, title and plays');
  assert(filterTracks(rows, 'two').length === 1, 'filterTracks matches album text');
  assert(artistsWithCounts([{ id: 'a', name: 'X' }, { id: 'z', name: 'Orphan' }], rows).length === 1, 'artists with no songs left are hidden');
}

// ---------------------------------------------------------------------------
console.log('\n--- Testing the shared IndexedDB upgrade (db.js) ---');

{
  function fakeStore() {
    const indexes = new Set();
    return { indexNames: { contains: (n) => indexes.has(n) }, createIndex: (n) => indexes.add(n), indexes };
  }
  const stores = new Map([[LYRICS_STORE, fakeStore()]]);
  const db = {
    objectStoreNames: { contains: (n) => stores.has(n) },
    createObjectStore: (n) => { const s = fakeStore(); stores.set(n, s); return s; }
  };
  const tx = { objectStore: (n) => stores.get(n) };
  upgradeAppDB(db, tx);
  assert(DB_VERSION === 4, 'LyricWaveDB is at version 4');
  assert(stores.has(TRACKS_STORE) && stores.has(ARTISTS_STORE) && stores.has(LYRICS_STORE), 'a v1 database keeps lyrics and gains tracks + artists');
  assert(stores.has(USER_LYRICS_STORE) && stores.has(PLAYLISTS_STORE), 'and gains the userLyrics and playlists stores');
  assert(['key', 'mbid', 'isrc', 'lastSeenAt', 'artistIds'].every((i) => stores.get(TRACKS_STORE).indexes.has(i)), 'tracks store has its lookup indexes');
  upgradeAppDB(db, tx);
  assert(stores.size === 5, 'running the upgrade twice is harmless');
}

// ---------------------------------------------------------------------------
console.log('\n--- Testing Library view helpers ---');

assert(licenseBadge({ license: 'CC0-1.0' }).text === 'Open data', 'matched rows show an "Open data" label');
assert(licenseBadge({ license: 'unverified', resolveStatus: 'pending' }).text === 'Matching…', 'rows being matched say so');
assert(licenseBadge({ license: 'unverified', resolveStatus: 'not_found' }).text === 'Not matched', 'unmatched rows say so in words');
assert(artistFacts({ type: 'Person', area: 'Somewhere', lifeBegin: '1946-01-08', lifeEnd: '2016-01-10' }) === 'Person · Somewhere · 1946–2016', 'artistFacts formats type, area and years');
assert(rowArtUrl({ art: null, releaseGroupMbid: '', sourceArt: 'https://example.org/a.jpg' }) === 'https://example.org/a.jpg', 'rows without Cover Art Archive art fall back to the source artwork');

// ---------------------------------------------------------------------------
console.log('\n--- Testing the /api/musicbrainz proxy ---');

{
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => { seen.push({ url, init }); return new Response('{"recordings":[]}', { status: 200 }); };
  try {
    const bad = await proxyGet({ request: new Request('https://app.example/api/musicbrainz?path=collection/abc') });
    assert(bad.status === 400, 'proxy rejects paths outside the allowlist');
    const res = await proxyGet({ request: new Request('https://app.example/api/musicbrainz?path=recording&query=recording%3A%22x%22&inc=artists&evil=1') });
    assert(res.status === 200 && res.headers.get('content-type').includes('json'), 'proxy answers JSON');
    const up = new URL(seen[0].url);
    assert(up.origin === 'https://musicbrainz.org' && up.pathname === '/ws/2/recording' && up.searchParams.get('fmt') === 'json', 'proxy forwards to musicbrainz.org/ws/2 with fmt=json');
    assert(!up.searchParams.has('evil'), 'proxy drops unknown parameters');
    assert(seen[0].init.headers['User-Agent'] === MB_USER_AGENT, 'proxy sends the LyricWave User-Agent');
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ---------------------------------------------------------------------------
console.log('\n--- Testing artist photos from Wikimedia Commons ---');

{
  assert(commonsLicenseCode('CC BY-SA 4.0') === 'CC-BY-SA-4.0' && commonsLicenseCode('CC BY 2.0') === 'CC-BY-2.0', 'Commons CC names become license codes');
  assert(commonsLicenseCode('CC0') === 'CC0-1.0' && commonsLicenseCode('Public domain') === 'PDM', 'CC0 and public domain codes');
  assert(commonsLicenseCode('GFDL') === '' && commonsLicenseCode('') === '', 'Licenses we cannot credit give no code');
  assert(stripHtml('<p>Test <a href="x">Photographer</a><br>&amp; Friend</p>') === 'Test Photographer & Friend', 'Author HTML becomes plain text');

  const info = (meta, extra = {}) => ({
    thumburl: 'https://upload.wikimedia.org/thumb/placeholder.jpg',
    url: 'https://upload.wikimedia.org/placeholder.jpg',
    descriptionurl: 'https://commons.wikimedia.org/wiki/File:Placeholder.jpg',
    extmetadata: Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, { value: v }])),
    ...extra
  });
  const photo = commonsPhotoFromImageInfo(info({ LicenseShortName: 'CC BY-SA 4.0', LicenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0', Artist: '<a href="#">Test Photographer</a>' }), 'File:Placeholder.jpg');
  assert(photo && photo.url.includes('/thumb/') && photo.pageUrl.includes('File:Placeholder.jpg'), 'Photo keeps the thumbnail and the Commons file page');
  assert(photo.license === 'CC-BY-SA-4.0' && photo.author === 'Test Photographer' && photo.fileName === 'Placeholder.jpg', 'Photo keeps license, author and file name');
  assert(photo.attribution === 'Photo: Test Photographer, CC BY-SA 4.0, via Wikimedia Commons', 'Photo credit line');
  assert(commonsPhotoFromImageInfo(info({ LicenseShortName: 'CC BY 4.0', NonFree: 'true' })) === null, 'Non-free files are skipped');
  assert(commonsPhotoFromImageInfo(info({ LicenseShortName: 'Some custom license' })) === null, 'Files with a license we cannot credit are skipped');
  assert(commonsPhotoFromImageInfo(info({ LicenseShortName: 'CC0' }, { descriptionurl: 'http://insecure.example' })) === null, 'Files without an https page are skipped');
  const pd = commonsPhotoFromImageInfo(info({ LicenseShortName: 'Public domain', AttributionRequired: 'false' }));
  assert(pd.licenseLabel === 'Public domain' && pd.attributionRequired === false, 'Public domain photo');

  const urls = [];
  const wd = new WikidataClient({
    fetchImpl: async (url) => {
      urls.push(url);
      if (url.includes('wbgetclaims')) {
        return jsonResponse({ claims: { P18: [{ rank: 'normal', mainsnak: { datavalue: { value: 'Other.jpg' } } }, { rank: 'preferred', mainsnak: { datavalue: { value: 'Placeholder.jpg' } } }] } });
      }
      return jsonResponse({ query: { pages: { 1: { imageinfo: [info({ LicenseShortName: 'CC BY 4.0', Artist: 'Test Photographer' })] } } } });
    }
  });
  const p = await wd.getPhoto('q42');
  assert(urls[0].includes('entity=Q42') && urls[0].includes('property=P18') && urls[0].includes('origin=*'), 'Asks Wikidata for the P18 image only');
  assert(urls[1].startsWith('https://commons.wikimedia.org/w/api.php') && urls[1].includes('Placeholder.jpg') && urls[1].includes('iiurlwidth=320'), 'Asks Commons for the preferred file at thumbnail size');
  assert(p && p.license === 'CC-BY-4.0', 'getPhoto returns the credited photo');
  const none = new WikidataClient({ fetchImpl: async () => jsonResponse({ claims: {} }) });
  assert(await none.getPhoto('Q42') === null, 'No P18 image, no photo');
  assert(await wd.getPhoto('nope') === null, 'Bad Q-id, no photo');

  // Collector stores the photo with the artist and credits it
  const store = new LibraryStore(new MemoryBackend());
  const collector = new LibraryCollector({
    store,
    now: () => 50_000,
    mb: { getArtist: async () => ({ id: ARTIST_ID, name: 'Test Artist', relations: [{ type: 'wikidata', url: { resource: 'https://www.wikidata.org/wiki/Q42' } }] }) },
    wikidata: { getSummary: async () => ({ wikidataId: 'Q42', description: 'placeholder band', wikipediaUrl: '' }), getPhoto: async () => p }
  });
  await store.putArtist({ id: `mb:${ARTIST_ID}`, mbid: ARTIST_ID, name: 'Test Artist', detailsFetchedAt: 0 });
  const withPhoto = await collector.refreshArtist(`mb:${ARTIST_ID}`);
  assert(withPhoto.photo?.url === p.url && withPhoto.photo.commercialOk === true, 'Artist row stores the photo with its own commercial-OK flag');
  assert(withPhoto.attribution.includes('Photo: Test Photographer, CC BY 4.0'), 'Artist attribution credits the photo');
  assert(artistPhotoUrl(withPhoto) === p.url && artistPhotoCaption(withPhoto.photo) === 'Photo: Test Photographer, CC BY 4.0', 'View shows the photo and its caption');
  assert(!needsPhotoRefresh(withPhoto) && needsPhotoRefresh({ mbid: ARTIST_ID, detailsFetchedAt: 1 }), 'Rows fetched before photos existed are refreshed once');

  const failing = new LibraryCollector({
    store,
    now: () => 60_000,
    mb: { getArtist: async () => ({ id: ARTIST_ID, name: 'Test Artist', relations: [{ type: 'wikidata', url: { resource: 'https://www.wikidata.org/wiki/Q42' } }] }) },
    wikidata: { getSummary: async () => ({ wikidataId: 'Q42', description: 'placeholder band' }), getPhoto: async () => { throw new Error('Commons down'); } }
  });
  const noPhoto = await failing.refreshArtist(`mb:${ARTIST_ID}`, { force: true });
  assert(noPhoto.photo === null && noPhoto.description === 'placeholder band', 'A Commons failure keeps the other artist details');
}

// ---------------------------------------------------------------------------
console.log('\n--- Testing similar artists (ListenBrainz) and Free music suggestions ---');

{
  const SIM_1 = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
  const SIM_2 = 'cccccccc-dddd-4eee-8fff-000000000000';
  const raw = [
    { artist_mbid: SIM_2, name: 'Second Placeholder', comment: '', type: 'Person', score: 50, reference_mbid: ARTIST_ID },
    { artist_mbid: SIM_1.toUpperCase(), name: '  First   Placeholder ', comment: 'test band', type: 'Group', score: 90 },
    { artist_mbid: SIM_1, name: 'Duplicate', score: 10 },
    { artist_mbid: ARTIST_ID, name: 'Test Artist', score: 99 },
    { artist_mbid: 'not-an-mbid', name: 'Broken', score: 80 },
    { artist_mbid: '', name: '' }
  ];
  const sim = normalizeSimilarArtists(raw, ARTIST_ID);
  assert(sim.length === 2 && sim[0].mbid === SIM_1 && sim[0].name === 'First Placeholder', 'Similar artists: best first, cleaned, lower-case ids');
  assert(!sim.some((s) => s.mbid === ARTIST_ID), 'The artist is not similar to itself');
  assert(normalizeSimilarArtists(raw, ARTIST_ID, 1).length === 1, 'Limit is respected');

  const seen = [];
  const lb = new ListenBrainzClient({ fetchImpl: async (url) => { seen.push(url); return jsonResponse(raw); } });
  const got = await lb.getSimilarArtists(ARTIST_ID.toUpperCase());
  assert(seen[0].startsWith(LB_SIMILAR_URL) && seen[0].includes(`artist_mbids=${ARTIST_ID}`) && seen[0].includes('algorithm='), 'Asks ListenBrainz Labs for one artist');
  assert(got.length === 2, 'Client returns the cleaned list');
  assert((await lb.getSimilarArtists('nope')).length === 0 && seen.length === 1, 'Bad MBID sends nothing');
  let threw = false;
  try { await new ListenBrainzClient({ fetchImpl: async () => jsonResponse({}, 500) }).getSimilarArtists(ARTIST_ID); } catch { threw = true; }
  assert(threw, 'HTTP errors are reported');

  let clock = 1_000;
  let calls = 0;
  const store = new LibraryStore(new MemoryBackend());
  await store.putArtist({ id: `mb:${ARTIST_ID}`, mbid: ARTIST_ID, name: 'Test Artist', detailsFetchedAt: 1, photo: null });
  const collector = new LibraryCollector({ store, now: () => clock, listenbrainz: { getSimilarArtists: async () => { calls++; return sim; } } });
  const row = await collector.refreshSimilar(`mb:${ARTIST_ID}`);
  assert(row.similar.length === 2 && row.similarFetchedAt === 1_000, 'Similar artists are stored with the artist');
  await collector.refreshSimilar(`mb:${ARTIST_ID}`);
  assert(calls === 1, 'Fresh similar artists are not fetched again');
  clock += SIMILAR_REFRESH_MS + 1;
  await collector.refreshSimilar(`mb:${ARTIST_ID}`);
  assert(calls === 2, 'Stale similar artists are fetched again');
  const broken = new LibraryCollector({ store, now: () => clock * 2, listenbrainz: { getSimilarArtists: async () => { throw new Error('down'); } } });
  const kept = await broken.refreshSimilar(`mb:${ARTIST_ID}`, { force: true });
  assert(kept.similar.length === 2, 'A ListenBrainz failure keeps what was stored');
  const noMbid = await collector.refreshSimilar('key:nobody');
  assert(noMbid === null, 'Unknown artists are ignored');

  assert(freeMusicQueryFor({ genres: ['folk rock', 'pop'] }) === 'folk rock', 'Free music query uses the top MusicBrainz genre');
  assert(freeMusicQueryFor({ genres: [] }, [{ genres: ['Jazz'] }, { genres: ['ambient', 'jazz'] }]) === 'jazz', 'Else the most common genre of their songs');
  assert(freeMusicQueryFor({}, [{}]) === '', 'No genres, no suggestion');

  const open = buildOpenTrackRow({ title: 'Placeholder Tune', artist: 'Test Creator', durationMs: 1000, genres: ['folk', ' ', 'acoustic'],
    openTrack: { openverseId: '2c51e4eb-dbe7-468c-ba6c-d1c85a1b71ae', audioUrl: 'https://a.example/x.mp3', license: 'CC-BY-4.0' } });
  assert(open.genres.join() === 'folk,acoustic', 'Free music rows keep their genres');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
