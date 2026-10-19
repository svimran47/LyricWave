/**
 * Unit tests for the library backup (backup.js): building, parsing hostile files, cleaning rows,
 * merging into a device and the round trip through the real stores. Titles are placeholders.
 */

import {
  buildBackup, parseBackup, sanitizeTrack, sanitizeArtist, sanitizePlaylist, sanitizeUserLyrics, mergeTrack,
  describeCounts, describeRestore, backupFileName, LibraryBackup, BACKUP_FORMAT, BACKUP_VERSION, MAX_BACKUP_BYTES, MAX_BACKUP_ROWS,
  isTrackId, isArtistId, isUserLyricsId
} from './backup.js';
import { LibraryStore, MemoryBackend, buildOpenTrackRow, buildProvisionalTrackRow, buildArtistStubs, buildOpenArtistStub } from './library.js';
import { PlaylistStore, addToPlaylist, createPlaylist, MAX_PLAYLISTS } from './playlists.js';
import { UserLyricsStore, buildUserLyricsRow } from './user-lyrics.js';

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

const OV = '2c51e4eb-dbe7-468c-ba6c-d1c85a1b71ae';
const MB = '11111111-2222-4333-8444-555555555555';
const openRow = buildOpenTrackRow({
  title: 'Placeholder Tune', artist: 'Test Creator', durationMs: 120000, genres: ['folk'],
  openTrack: { openverseId: OV, audioUrl: 'https://a.example/x.mp3', license: 'CC-BY-SA-3.0', licenseLabel: 'CC BY-SA 3.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0/', attribution: '"Placeholder Tune" by Test Creator, CC BY-SA 3.0', creator: 'Test Creator', landingUrl: 'https://www.jamendo.com/track/1', provider: 'Jamendo', commercialOk: true }
}, { now: 1000, played: true });
const mbRow = {
  id: `mb:${MB}`, key: 'test artist__placeholder song', mbid: MB, isrc: 'USAAA0100001', title: 'Placeholder Song', artist: 'Test Artist',
  artistIds: ['mb:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'], artistCredit: [{ id: 'mb:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', mbid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Test Artist' }],
  album: 'Placeholder Album', durationSec: 200, sourceArt: 'https://example.org/a.jpg', playCount: 3, firstSeenAt: 500, lastSeenAt: 900,
  resolveStatus: 'resolved', license: 'CC0-1.0', licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/', attribution: 'Metadata from MusicBrainz (CC0)', commercialOk: true, source: 'musicbrainz', sourceUrl: `https://musicbrainz.org/recording/${MB}`
};
const artist = { id: 'mb:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', mbid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Test Artist', genres: ['rock'], photo: null, license: 'CC0-1.0', attribution: 'Metadata from MusicBrainz (CC0)', commercialOk: true, source: 'musicbrainz' };

async function run() {
  console.log('\n💾 Build');
  const backup = buildBackup({ tracks: [openRow, mbRow], artists: [artist], playlists: [], userLyrics: [], now: Date.UTC(2026, 9, 17) });
  assert(backup.format === BACKUP_FORMAT && backup.version === BACKUP_VERSION && backup.exportedAt.startsWith('2026-10-17'), 'Format, version and date');
  assert(backup.counts.tracks === 2 && backup.counts.artists === 1, 'Counts');
  assert(backup.credits.length === 1 && backup.credits[0].includes('CC BY-SA 3.0') && backup.credits[0].includes('jamendo.com'), 'Credits list the Free music songs with their pages');
  assert(backupFileName(new Date(2026, 9, 17, 0, 30).getTime()) === 'lyricwave-library-2026-10-17.json', 'File name, dated in local time');
  assert(describeCounts({ tracks: 2, artists: 1, playlists: 0, userLyrics: 1 }) === '2 songs, 1 artist, 1 set of your lyrics', 'Count wording');
  assert(describeCounts({}) === '', 'No counts, no words');

  console.log('\n💾 Parse: refusing files that are not backups');
  const expectThrow = (text, re, desc) => {
    let msg = '';
    try { parseBackup(text); } catch (e) { msg = e.message; }
    assert(re.test(msg), desc);
  };
  expectThrow('not json', /valid JSON/, 'Not JSON');
  expectThrow(JSON.stringify({ format: 'something-else' }), /isn’t a LyricWave backup/, 'Wrong format');
  expectThrow(JSON.stringify({ format: BACKUP_FORMAT, version: 99 }), /newer LyricWave/, 'Newer version');
  expectThrow('x'.repeat(MAX_BACKUP_BYTES + 1), /too large/, 'Too large');

  console.log('\n💾 Parse: cleaning rows');
  const parsed = parseBackup(JSON.stringify(backup));
  assert(parsed.tracks.length === 2 && parsed.artists.length === 1 && parsed.skipped === 0, 'A real backup parses fully');
  const ot = parsed.tracks.find((t) => t.id === `ov:${OV}`);
  assert(ot.openTrack.audioUrl === 'https://a.example/x.mp3' && ot.playable && ot.resolveStatus === 'open' && ot.license === 'CC-BY-SA-3.0', 'Free music rows keep their license and stay playable');
  assert(ot.genres[0] === 'folk', 'Genres kept');

  const evil = sanitizeTrack({ ...mbRow, title: '<img src=x onerror=alert(1)>', sourceArt: 'javascript:alert(1)', sourceUrl: 'http://insecure.example', extra: 'dropped', art: { url: 'data:image/png;base64,xx' }, playCount: -5, durationSec: 1e12 });
  assert(evil.sourceArt === '' && evil.sourceUrl === '' && evil.art === null, 'Non-https links are dropped');
  assert(!('extra' in evil), 'Unknown fields are dropped');
  assert(evil.playCount === 0 && evil.durationSec === 24 * 3600, 'Numbers are clamped');
  assert(evil.title === '<img src=x onerror=alert(1)>', 'Text is kept as text (views escape it)');
  assert(sanitizeTrack({ ...mbRow, id: 'evil id' }) === null && sanitizeTrack({ ...mbRow, title: '' }) === null, 'Rows without a valid id or title are skipped');
  assert(sanitizeTrack({ ...openRow, openTrack: { ...openRow.openTrack, audioUrl: 'http://insecure.example/x.mp3' } }) === null, 'Free music rows with a bad audio link are skipped');
  assert(sanitizeTrack({ ...openRow, id: 'ov:66666666-7777-4888-9999-aaaaaaaaaaaa' }) === null, 'Free music row ids must match their Openverse id');
  const notOpen = sanitizeTrack({ ...mbRow, license: 'CC0-1.0', commercialOk: 'yes' });
  assert(notOpen.commercialOk === false, 'commercialOk must be a real true');
  assert(sanitizeArtist({ ...artist, wikidataId: 'javascript:1', photo: { url: 'https://upload.wikimedia.org/p.jpg', license: 'CC-BY-4.0' } }).wikidataId === '', 'Bad Wikidata ids are dropped');
  assert(!('photo' in sanitizeArtist({ id: artist.id, name: 'Old Row' })), 'Artists saved before photos get one on their next visit');
  assert(sanitizeArtist({ id: 'nope', name: 'x' }) === null, 'Artists need a valid id');
  const pl = sanitizePlaylist({ id: 'pl:abc123', name: '  Road   trip ', trackIds: [`ov:${OV}`, `ov:${OV}`, `mb:${MB}`, 'ov:bad'], createdAt: 1, updatedAt: 2 });
  assert(pl.name === 'Road trip' && pl.trackIds.length === 1, 'Playlists keep only free songs, once');
  assert(sanitizePlaylist({ id: 'pl:<x>', name: 'x' }) === null && sanitizePlaylist({ id: 'pl:abc', name: ' ' }) === null, 'Bad playlists are skipped');
  const ul = sanitizeUserLyrics({ id: `ov:${OV}`, text: '[00:01.00] Placeholder one\n[00:02.00] Placeholder two', rights: 'own', updatedAt: 5 });
  assert(ul.type === 'synced' && ul.rights === 'own', 'Your lyrics are re-checked');
  assert(sanitizeUserLyrics({ id: `ov:${OV}`, text: 'x', rights: 'stolen' }) === null, 'Unknown lyrics rights are skipped');
  const mixed = parseBackup(JSON.stringify({ format: BACKUP_FORMAT, version: 1, tracks: [mbRow, { id: 'bad' }, null, 7], artists: 'nope' }));
  assert(mixed.tracks.length === 1 && mixed.skipped === 3 && mixed.artists.length === 0, 'Unusable entries are counted as skipped');
  const tooMany = parseBackup(JSON.stringify({ format: BACKUP_FORMAT, version: 1, tracks: [...Array(MAX_BACKUP_ROWS).fill(null), mbRow] }));
  assert(tooMany.tracks.length === 0 && tooMany.skipped === MAX_BACKUP_ROWS + 1, 'Rows past the limit count as skipped too');

  console.log('\n💾 Ids the library makes');
  const provisional = buildProvisionalTrackRow({ title: 'Placeholder Song (Live)', artist: 'Test Artist feat. Someone', source: 'search' }, 400);
  const keyArtist = buildArtistStubs(provisional, 400)[0];
  assert(provisional.id.includes(' ') && isTrackId(provisional.id) && isArtistId(keyArtist.id), 'Artist + title keys with spaces are valid ids');
  assert(isTrackId('key:тестовый артист__песня') && isTrackId('key:テスト__歌') && isArtistId('key:unknown'), 'Keys in any script are valid');
  assert(isTrackId(`mb:${MB}`) && isTrackId('isrc:USAAA0100001') && isTrackId(`ov:${OV}`), 'MusicBrainz, ISRC and Openverse ids are valid');
  assert(!isTrackId('mb:AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE') && !isTrackId('isrc:us-aaa-01-00001') && !isTrackId('ov:not-a-uuid') && !isTrackId('mb:') && !isTrackId('key:'), 'Ids must be stored normalized');
  assert(!isTrackId('key:<img src=x>') && !isTrackId('key:a\nb') && !isTrackId('pl:abc') && !isTrackId(42) && !isTrackId(null), 'Anything else is not an id');
  assert(!isArtistId(`ov:${OV}`) && !isArtistId('isrc:USAAA0100001') && !isUserLyricsId(`mb:${MB}`) && isUserLyricsId(`ov:${OV}`), 'Each store keeps its own id kinds');
  const keptProvisional = sanitizeTrack(provisional);
  assert(keptProvisional && keptProvisional.id === provisional.id && keptProvisional.artistIds[0] === keyArtist.id, 'Songs not matched to MusicBrainz yet are kept with their artist');
  assert(sanitizeArtist(keyArtist)?.id === keyArtist.id, 'Artists not matched to MusicBrainz are kept');
  const openKept = sanitizeTrack(openRow);
  assert(openKept.artistIds.length === 1 && openKept.artistIds[0] === openRow.artistIds[0] && openKept.artistCredit[0].id === openRow.artistIds[0], 'Free music songs keep their creator link');
  assert(sanitizeArtist(buildOpenArtistStub(openRow, 1000))?.id === openRow.artistIds[0], 'Free music creators are kept');

  console.log('\n💾 Rows stay what the library would make');
  const notOpenRow = sanitizeTrack({ ...mbRow, openTrack: openRow.openTrack, playable: true, resolveStatus: 'open' });
  assert(!notOpenRow.openTrack && !notOpenRow.playable && notOpenRow.resolveStatus === 'pending', 'Only Free music ids can carry an open track');
  const openWithIds = sanitizeTrack({ ...openRow, mbid: MB, isrc: 'USAAA0100001', source: 'spotify', sourceUrl: 'https://example.org/elsewhere' });
  assert(openWithIds.mbid === '' && openWithIds.isrc === '' && openWithIds.source === 'openverse' && openWithIds.sourceUrl === 'https://www.jamendo.com/track/1', 'Free music rows have no MBID or ISRC and keep their host page');
  assert(sanitizeTrack({ ...openRow, attribution: '' }).attribution.includes('CC BY-SA 3.0'), 'Free music rows always keep a credit');
  const mbIds = sanitizeTrack({ ...mbRow, mbid: '66666666-7777-4888-9999-aaaaaaaaaaaa' });
  assert(mbIds.mbid === MB, 'An MBID field always matches the row id');
  assert(sanitizeTrack({ ...provisional, resolveStatus: 'resolved' }).resolveStatus === 'pending', 'Only MusicBrainz rows count as matched');
  assert(sanitizeTrack({ ...mbRow, license: 'CC-BY-NC-4.0', commercialOk: true }).commercialOk === false, 'commercialOk must agree with the license');
  const ncOpen = sanitizeTrack({ ...openRow, openTrack: { ...openRow.openTrack, license: 'CC-BY-NC-4.0', commercialOk: true } });
  assert(ncOpen.commercialOk === false && ncOpen.openTrack.commercialOk === false, 'An open song’s commercialOk follows its license');
  assert(sanitizeArtist({ id: `mb:${MB}`, mbid: '66666666-7777-4888-9999-aaaaaaaaaaaa', name: 'x' }).mbid === MB && sanitizeArtist(keyArtist).mbid === '', 'Artist MBIDs match their ids');
  const songRights = sanitizeUserLyrics({ id: provisional.id, text: 'Placeholder line', rights: 'song', updatedAt: 1 });
  assert(songRights.rights === 'personal', '“The song’s license” falls back to a personal copy for non-free songs');
  assert(sanitizeUserLyrics({ id: `ov:${OV}`, text: 'Placeholder line', rights: 'song' }).rights === 'song', 'Free music lyrics can keep the song’s license');
  assert(sanitizeUserLyrics({ id: `ov:${OV}`, text: 'x', rights: 'constructor' }) === null && sanitizeUserLyrics({ id: `ov:${OV}`, text: 'x', rights: '__proto__' }) === null, 'Built-in object names are not lyrics rights');

  console.log('\n💾 Merge');
  const merged = mergeTrack({ ...mbRow, playCount: 5, firstSeenAt: 700, lastSeenAt: 800, sources: ['search'] }, { ...mbRow, playCount: 3, firstSeenAt: 500, lastSeenAt: 900, sources: ['chart'] });
  assert(merged.playCount === 5 && merged.firstSeenAt === 500 && merged.lastSeenAt === 900, 'Plays keep the larger count; dates widen');
  assert(merged.sources.join() === 'search,chart', 'Sources combine');
  assert(mergeTrack(null, mbRow) === mbRow, 'New songs are added as they are');
  const device = { ...mbRow, playCount: 9, sources: ['search'] };
  assert(mergeTrack(device, { ...mbRow, playCount: 2, sources: ['search'] }) === device, 'A backup that adds nothing leaves the song alone');
  assert(mergeTrack({ ...mbRow, firstSeenAt: 0 }, { ...mbRow, firstSeenAt: 500 }).firstSeenAt === 500, 'A missing first-played time is filled in');

  console.log('\n💾 Round trip through the stores');
  const make = () => {
    const library = new LibraryStore(new MemoryBackend());
    return { library, playlists: new PlaylistStore(new MemoryBackend()), userLyrics: new UserLyricsStore(new MemoryBackend()) };
  };
  const a = make();
  await a.library.putTrack(openRow);
  await a.library.putTrack(mbRow);
  await a.library.putTrack(provisional);
  await a.library.putArtist(artist);
  await a.library.putArtist(keyArtist);
  await a.library.putArtist(buildOpenArtistStub(openRow, 1000));
  const created = await a.playlists.create('Morning', 100);
  await a.playlists.update(created.id, (p) => addToPlaylist(p, `ov:${OV}`, 200).playlist);
  await a.userLyrics.put(buildUserLyricsRow({ track: { title: 'Placeholder Tune', artist: 'Test Creator', openTrack: openRow.openTrack }, text: 'Placeholder line', rights: 'song', now: 300 }));
  await a.userLyrics.put(buildUserLyricsRow({ track: { title: provisional.title, artist: provisional.artist }, text: 'Placeholder verse', rights: 'personal', now: 310 }));
  const text = await new LibraryBackup(a).exportText();

  const b = make();
  await b.library.putTrack({ ...mbRow, playCount: 10, firstSeenAt: 800, lastSeenAt: 950 });
  const locks = [];
  const restorer = new LibraryBackup({ ...b, exclusive: (fn) => { locks.push('library'); return fn(); } });
  const result = await restorer.restore(text);
  assert(result.found.tracks === 3 && result.found.artists === 3 && result.found.userLyrics === 2 && result.skipped === 0, 'Every row in the backup is readable');
  assert(result.added.tracks === 2 && result.updated.tracks === 1, 'Restore adds new songs and updates existing ones');
  assert(result.added.artists === 3 && result.added.playlists === 1 && result.added.userLyrics === 2, 'Artists, playlists and your lyrics come across');
  assert(locks.length === 1, 'Songs and artists are written inside the library lock');
  const restoredMb = await b.library.getTrack(`mb:${MB}`);
  assert(restoredMb.playCount === 10 && restoredMb.firstSeenAt === 500 && restoredMb.lastSeenAt === 950, 'An existing song keeps its larger play count and widens its dates');
  assert((await b.library.getTrack(provisional.id))?.artistIds[0] === keyArtist.id && (await b.library.getArtist(keyArtist.id))?.name === keyArtist.name, 'Unmatched songs and their artists come across');
  assert((await b.library.tracksByArtist(openRow.artistIds[0])).length === 1, 'A Free music creator still lists their song');
  assert((await b.playlists.all())[0].trackIds[0] === `ov:${OV}` && (await b.userLyrics.get(`ov:${OV}`)).rights === 'song', 'Playlist and lyrics contents survive');
  assert((await b.userLyrics.get(`key:${provisional.key}`))?.text === 'Placeholder verse', 'Your lyrics for songs outside Free music come across');
  assert(describeRestore(result) === 'Restored: added 2 songs, 3 artists, 1 playlist, 2 sets of your lyrics; updated 1 song.', 'The restore message lists what changed');
  const again = await restorer.restore(text);
  const nothing = (c) => !c.tracks && !c.artists && !c.playlists && !c.userLyrics;
  assert(nothing(again.added) && nothing(again.updated), 'Restoring the same file twice changes nothing');
  assert(describeRestore(again) === 'Everything in that backup is already on this device.', 'A second restore says nothing was new');
  assert(describeRestore({ ...again, skipped: 2 }).endsWith(' 2 unreadable entries were skipped.'), 'Skipped entries are mentioned');

  console.log('\n💾 Restore limits and empty files');
  const full = make();
  for (let i = 0; i < MAX_PLAYLISTS; i++) await full.playlists.put(createPlaylist(`List ${i}`, { now: i, id: `pl:full${i}` }));
  const fullResult = await new LibraryBackup(full).restore(text);
  assert(fullResult.added.playlists === 0 && fullResult.playlistsFull === 1 && (await full.playlists.all()).length === MAX_PLAYLISTS, 'New playlists stop at the playlist limit');
  assert(describeRestore(fullResult).endsWith(` 1 playlist didn’t fit; LyricWave keeps up to ${MAX_PLAYLISTS}.`), 'The message says which playlists didn’t fit');
  const empty = await new LibraryBackup(make()).restore(JSON.stringify(buildBackup({ now: 1 })));
  assert(describeCounts(empty.found) === '' && empty.skipped === 0, 'An empty backup reports nothing found');
  assert(describeRestore(empty) === 'That backup has nothing in it to restore.', 'An empty backup says so');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
