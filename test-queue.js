/**
 * Unit tests for the Free music play queue (queue.js) and SearchSource's onEnded hook that drives
 * auto-advance (search.js). Track titles are placeholders.
 */

import { PlayQueue, shuffledOrder, queueItemId, queueTrackId } from './queue.js';
import { SearchSource } from './search.js';

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

const id = (n) => `0000000${n}-aaaa-4bbb-8ccc-dddddddddddd`;
const item = (n) => ({ title: `Placeholder ${n}`, artist: 'Test Creator', openTrack: { openverseId: id(n), audioUrl: `https://a.example/${n}.mp3`, license: 'CC-BY-4.0' } });
const items = [1, 2, 3, 4, 5].map(item);

console.log('\n🎶 Ids');
assert(queueItemId(items[0]) === id(1) && queueTrackId(items[0]) === `openverse_${id(1)}`, 'Queue ids match the engine track id');
assert(queueItemId({ title: 'x' }) === '', 'Items without an Openverse id have no queue id');

console.log('\n🎶 Play all and next / previous');
const q = new PlayQueue();
assert(!q.active && q.current === null && !q.hasNext, 'Empty queue is inactive');
const first = q.setItems([...items, items[1], { title: 'not playable' }], 2, { label: 'Free music: test' });
assert(first === items[2] && q.position === 3 && q.length === 5, 'Starts at the tapped song; duplicates and unplayable items dropped');
assert(q.label === 'Free music: test', 'Label kept');
assert(q.isCurrent(`openverse_${id(3)}`) && !q.isCurrent(`openverse_${id(1)}`), 'isCurrent matches the playing track');
assert(q.upNext === items[3], 'Up next is the following song');
assert(q.next() === items[3] && q.next() === items[4], 'Next walks forward');
assert(!q.hasNext && q.next() === null && q.position === 5, 'Stops at the last song');
assert(q.previous() === items[3], 'Previous walks back');
q.setItems(items, 0);
assert(q.previous() === null && q.position === 1, 'No previous before the first song');
assert(q.setItems([{ title: 'x' }]) === null && !q.active, 'A list with nothing playable clears the queue');

console.log('\n🎶 Shuffle');
const order = shuffledOrder(6, 4, () => 0.3);
assert(order[0] === 4 && order.length === 6 && new Set(order).size === 6, 'Shuffled order keeps the first song and every index once');
assert(shuffledOrder(0, 0).length === 0, 'Empty shuffle');
let r = 0;
const seq = [0.9, 0.1, 0.5, 0.7, 0.2, 0.4];
const sq = new PlayQueue({ random: () => seq[r++ % seq.length] });
sq.setItems(items, 1);
sq.setShuffle(true);
assert(sq.current === items[1] && sq.position === 1, 'Turning shuffle on keeps the current song and puts it first');
const visited = [sq.current];
while (sq.hasNext) visited.push(sq.next());
assert(visited.length === 5 && new Set(visited).size === 5, 'Shuffle plays every song once');
sq.setShuffle(false);
assert(sq.current === visited[4] && sq.position === items.indexOf(visited[4]) + 1, 'Turning shuffle off continues in list order from the current song');
const sq2 = new PlayQueue({ random: () => 0 });
sq2.setShuffle(true);
assert(sq2.setItems(items, 3) === items[3] && sq2.position === 1, 'Play all with shuffle on starts with the tapped song');
q.clear();
assert(!q.active && q.length === 0, 'clear() empties the queue');

console.log('\n🎶 SearchSource onEnded');
{
  const ended = [];
  const errors = [];
  const src = new SearchSource({ onEnded: (e) => ended.push(e), onError: (m) => errors.push(m) });
  // A minimal stand-in for an <audio> element
  const fakeAudio = {
    play: () => Promise.resolve(), pause() {}, load() {}, removeAttribute() {},
    set src(v) { this._src = v; }, get src() { return this._src; }
  };
  globalThis.window = globalThis.window || {};
  globalThis.Audio = function () { return fakeAudio; };
  globalThis.performance = globalThis.performance || { now: () => Date.now() };
  src.selectTrack({ id: 'openverse_x', title: 'Placeholder 1', artist: 'Test Creator', durationMs: 1000, previewUrl: 'https://a.example/1.mp3', playPreview: true, openTrack: items[0].openTrack }, false);
  assert(src.audio === fakeAudio && fakeAudio.src === 'https://a.example/1.mp3', 'Open track plays its own audio file');
  fakeAudio.onended();
  assert(ended.length === 1 && ended[0].failed === false && ended[0].track.title === 'Placeholder 1', 'onEnded fires when the song finishes');
  fakeAudio.onerror(new Error('load failed'));
  await Promise.resolve();
  assert(ended.length === 2 && ended[1].failed === true, 'An open track that cannot play reports a failed end');
  assert(errors.length === 1 && /couldn’t be played/.test(errors[0]), 'and tells the user');
  src.cleanupAudio?.();
  delete globalThis.Audio;
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
