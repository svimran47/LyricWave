/**
 * LyricWave play queue for Free music: "Play all" over search results or saved free songs,
 * auto-advance when a song ends, Next / Previous and shuffle.
 *
 * Pure and DOM-free so it runs under Node tests. Items are Free music results or Library rows
 * (anything with an `openTrack`); app.js turns the current item into a playable track.
 */

/** Openverse id of a queue item, or ''. */
export function queueItemId(item) {
  return String(item?.openTrack?.openverseId || '').toLowerCase();
}

/** The engine track id an item plays as (see playableOpenTrack in openverse.js). */
export function queueTrackId(item) {
  const id = queueItemId(item);
  return id ? `openverse_${id}` : '';
}

/** Fisher-Yates shuffle of 0..n-1 with `first` kept at the front. */
export function shuffledOrder(n, first = 0, random = Math.random) {
  const rest = [];
  for (let i = 0; i < n; i++) if (i !== first) rest.push(i);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return n > 0 ? [first, ...rest] : [];
}

/** Seconds into a song after which Previous restarts it instead of going back. */
export const RESTART_THRESHOLD_SEC = 3;

export class PlayQueue {
  constructor({ random = Math.random } = {}) {
    this.random = random;
    this.items = [];
    this.order = [];
    this.pos = -1;
    this.shuffle = false;
    this.label = '';
  }

  get length() { return this.items.length; }
  get active() { return this.pos >= 0 && this.items.length > 0; }
  get current() { return this.active ? this.items[this.order[this.pos]] : null; }
  /** 1-based position in play order. */
  get position() { return this.active ? this.pos + 1 : 0; }
  get hasNext() { return this.active && this.pos < this.order.length - 1; }
  get hasPrevious() { return this.active && this.pos > 0; }
  get upNext() { return this.hasNext ? this.items[this.order[this.pos + 1]] : null; }

  /**
   * Replace the queue with playable items (duplicates and items without an Openverse id are
   * dropped) and start at `startIndex`. Returns the item to play now, or null.
   */
  setItems(items, startIndex = 0, { label = '' } = {}) {
    const seen = new Set();
    const list = [];
    let start = 0;
    (Array.isArray(items) ? items : []).forEach((item, i) => {
      const id = queueItemId(item);
      if (!id || seen.has(id)) return;
      seen.add(id);
      if (i === startIndex) start = list.length;
      list.push(item);
    });
    this.items = list;
    this.label = String(label || '');
    if (!list.length) {
      this.clear();
      return null;
    }
    this.order = this.shuffle ? shuffledOrder(list.length, start, this.random) : list.map((_, i) => i);
    this.pos = this.shuffle ? 0 : start;
    return this.current;
  }

  next() {
    if (!this.hasNext) return null;
    this.pos++;
    return this.current;
  }

  previous() {
    if (!this.hasPrevious) return null;
    this.pos--;
    return this.current;
  }

  /** Turn shuffle on or off, keeping the current song where it is. */
  setShuffle(on) {
    this.shuffle = Boolean(on);
    if (!this.active) return;
    const currentIndex = this.order[this.pos];
    if (this.shuffle) {
      this.order = shuffledOrder(this.items.length, currentIndex, this.random);
      this.pos = 0;
    } else {
      this.order = this.items.map((_, i) => i);
      this.pos = currentIndex;
    }
  }

  /** Is this engine track the queue's current song? */
  isCurrent(trackId) {
    return this.active && Boolean(trackId) && queueTrackId(this.current) === String(trackId).toLowerCase();
  }

  clear() {
    this.items = [];
    this.order = [];
    this.pos = -1;
    this.label = '';
  }
}
