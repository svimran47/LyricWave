/**
 * Unit tests for Free music playlists (playlists.js): names, ids, add / remove / move, resolving
 * against library rows, summaries and credits, and the store. Titles are placeholders.
 */

import {
  cleanPlaylistName, createPlaylist, renamePlaylist, newPlaylistId, isPlaylistTrackId, playlistTrackIdFor,
  addToPlaylist, removeFromPlaylist, moveInPlaylist, resolvePlaylist, playlistSummary, playlistCredits,
  PlaylistStore, MAX_PLAYLIST_NAME, MAX_PLAYLIST_TRACKS
} from './playlists.js';
import { MemoryBackend } from './library.js';

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

const uuid = (n) => `${String(n).padStart(8, '0')}-aaaa-4bbb-8ccc-dddddddddddd`;
const ov = (n) => `ov:${uuid(n)}`;
const row = (n, durationSec = 120) => ({
  id: ov(n), title: `Placeholder ${n}`, artist: 'Test Creator', durationSec,
  attribution: `"Placeholder ${n}" by Test Creator, CC BY 4.0`,
  openTrack: { openverseId: uuid(n), audioUrl: `https://a.example/${n}.mp3`, license: 'CC-BY-4.0', licenseLabel: 'CC BY 4.0' }
});

async function run() {
  console.log('\n📃 Names and ids');
  assert(cleanPlaylistName('  Morning   run  ') === 'Morning run', 'Names are trimmed and collapsed');
  assert(cleanPlaylistName('x'.repeat(100)).length === MAX_PLAYLIST_NAME, 'Names are capped');
  let threw = '';
  try { cleanPlaylistName('   '); } catch (e) { threw = e.message; }
  assert(/name/.test(threw), 'Empty names are refused');
  assert(/^pl:[0-9a-z]+$/.test(newPlaylistId(() => 0.5, 1000)), 'Ids look like pl:<base36>');
  assert(newPlaylistId(() => 0.1, 1) !== newPlaylistId(() => 0.2, 1), 'Ids differ');
  const p0 = createPlaylist('Focus', { now: 10, id: 'pl:test' });
  assert(p0.id === 'pl:test' && p0.name === 'Focus' && p0.trackIds.length === 0 && p0.createdAt === 10, 'New playlist is empty');
  assert(renamePlaylist(p0, ' Deep focus ', 20).name === 'Deep focus' && renamePlaylist(p0, 'x', 20).updatedAt === 20, 'Rename');
  assert(isPlaylistTrackId(ov(1)) && !isPlaylistTrackId('mb:' + uuid(1)) && !isPlaylistTrackId('ov:nope'), 'Only Free music rows can be added');
  assert(playlistTrackIdFor(row(1)) === ov(1) && playlistTrackIdFor({ title: 'x' }) === '', 'Track id from a result or row');

  console.log('\n📃 Add, remove, move');
  let p = p0;
  for (const n of [1, 2, 3]) p = addToPlaylist(p, ov(n), 30).playlist;
  assert(p.trackIds.join() === [ov(1), ov(2), ov(3)].join() && p.updatedAt === 30, 'Songs are added in order');
  assert(p0.trackIds.length === 0, 'Changes never mutate the original');
  const dup = addToPlaylist(p, ov(2));
  assert(!dup.added && dup.reason === 'duplicate' && dup.playlist === p, 'A song is only added once');
  assert(addToPlaylist(p, 'key:x').reason === 'invalid', 'Non-free songs are refused');
  const full = { ...p, trackIds: Array.from({ length: MAX_PLAYLIST_TRACKS }, (_, i) => ov(1000 + i)) };
  assert(addToPlaylist(full, ov(9)).reason === 'full', 'Full playlists refuse more songs');
  assert(moveInPlaylist(p, 2, 0).trackIds.join() === [ov(3), ov(1), ov(2)].join(), 'Move to the top');
  assert(moveInPlaylist(p, 0, 9).trackIds.join() === [ov(2), ov(3), ov(1)].join(), 'Moves are clamped');
  assert(moveInPlaylist(p, 1, 1) === p && moveInPlaylist(p, 7, 0) === p, 'No-op moves return the same playlist');
  assert(removeFromPlaylist(p, 1).trackIds.join() === [ov(1), ov(3)].join(), 'Remove by position');
  assert(removeFromPlaylist(p, 5) === p, 'Removing a bad position does nothing');

  console.log('\n📃 Resolve, summary, credits');
  const entries = resolvePlaylist({ ...p, trackIds: [ov(1), ov(9), ov(2)] }, [row(1, 200), row(2, 100)]);
  assert(entries.length === 3 && entries[1].row === null && entries[2].row.title === 'Placeholder 2', 'Missing songs stay as empty entries');
  assert(playlistSummary(entries) === '2 songs · 5 min', 'Summary counts playable songs and minutes');
  assert(playlistSummary(resolvePlaylist({ trackIds: [ov(1)] }, [row(1, 30)])) === '1 song', 'Short summary');
  const credits = playlistCredits(entries);
  assert(credits.length === 2 && credits[0].includes('CC BY 4.0'), 'Credits list every song once');

  console.log('\n📃 Store');
  let clock = 100;
  const store = new PlaylistStore(new MemoryBackend());
  const a = await store.create('First', clock);
  clock += 10;
  const b = await store.create('Second', clock);
  assert((await store.all()).map((x) => x.name).join() === 'Second,First', 'Most recently changed first');
  await store.update(a.id, (x) => addToPlaylist(x, ov(1), 500).playlist);
  assert((await store.all())[0].id === a.id && (await store.get(a.id)).trackIds[0] === ov(1), 'Updating moves a playlist to the top');
  assert(await store.update('pl:missing', (x) => x) === null, 'Updating a missing playlist returns null');
  await store.delete(b.id);
  assert((await store.all()).length === 1, 'Delete');
  let createErr = '';
  try { await store.create('  '); } catch (e) { createErr = e.message; }
  assert(/name/.test(createErr), 'Store refuses unnamed playlists');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
