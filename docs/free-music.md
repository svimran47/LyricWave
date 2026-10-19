# Free music (open track collector)

LyricWave's Free music view (Discover > Library > Free music) finds songs people can play in full,
for free and legally: Creative Commons and public domain audio indexed by
[Openverse](https://openverse.org).

## How it works

- `openverse.js` calls `https://api.openverse.org/v1/audio/` (no API key; CORS open) with
  `category=music&mature=false`, 20 results a page. "Commercial use OK" adds `license_type=commercial`.
- Each result becomes a track with an `openTrack` (OpenTrackInfo in `types.js`): Openverse id, the
  audio file URL, license code (`CC-BY-SA-3.0`, `CC0-1.0`, `PDM`), label, license URL, Openverse's
  credit line, creator, creator page, host page and host name, and `commercialOk`.
- Playing hands the full audio URL to `SearchSource` (`playPreview: true`), so the audio drives the
  lyric clock. Open tracks never fall back to an iTunes preview of a same-named song.
- Plays and saves are stored in LyricWaveDB `tracks` as `ov:<Openverse id>` rows with
  `resolveStatus: 'open'`, `playable: true`, the license fields and `sourceUrl` = host page. They are
  never sent to MusicBrainz, and a copyrighted play never merges into an open row.
- The credit shows in the result list, Library rows, the now-playing header (`#trackLicense`), the
  lock screen (Media Session album line) and lyrics cards.
- Audio streams from the host. The service worker bypasses cross-origin audio, so nothing is cached
  for offline use.

## Lyrics cards

Cards for open tracks whose license allows adaptations (CC0, PDM, CC BY, BY-SA, BY-NC, BY-NC-SA) may
quote up to 12 lines / 480 characters (what stays readable on a card) and always draw the license
credit. No-derivatives, sampling and unknown licenses, and every non-open song, keep the
4-line / 220-character cap. Lyrics still come from LRCLIB, matched by title and artist.

## Limits

- Anonymous Openverse use: 20 requests a minute, 200 a day per IP. Searches run after a 700 ms
  pause in typing or on Enter, and further pages only on "More results".
- Openverse metadata quality varies by host; titles and creators are shown as supplied.

## Follow-ups

- **Jamendo API**: needs a client id, is non-commercial only, and its terms forbid offline caching.
  Openverse already indexes Jamendo's CC catalogue, so a direct integration only adds value for
  Jamendo-specific features (playlists, radios). If added, put it behind a client-id setting and keep
  `commercialOk: false` on every row.
- **Openverse API key** (free registration) raises the rate limit; it would need to go through a
  Cloudflare function so the key isn't shipped in the app.

## Your lyrics (lyrics rights)

- `user-lyrics.js` stores lyrics people add (LyricWaveDB v3 store `userLyrics`, id
  `ov:<Openverse id>` or `key:<artist>__<title>`), with the rights they chose: personal copy,
  written by me, public domain, CC BY 4.0, CC BY-SA 4.0, or the song's license (Free music only).
- `lyrics.js` asks the user lyrics store first (`setUserLyricsProvider`); LRCLIB results carry
  `LRCLIB_RIGHTS` (community lyrics, rights stay with the songwriters, short quotes only).
- `#lyricsCredit` under the lyrics shows where they come from, with Add / Edit your lyrics.
- Cards: lyrics with open rights (anything but a personal copy, and not a no-derivatives song
  license) may quote up to 12 lines and draw their credit; LRCLIB lyrics keep 4 lines / 220 chars.
- `engine.reloadLyrics()` reloads after a save or removal without counting a new play.

## Artist photos

- `WikidataClient.getPhoto(qid)` reads the artist's image (Wikidata P18, preferred rank first) and
  asks Commons for a 320px thumbnail plus `LicenseShortName`, `LicenseUrl`, `Artist`, `NonFree`.
- A photo is kept only with a license LyricWave can credit (CC0, public domain, CC BY family);
  non-free files and unknown licenses are skipped. The artist row stores `photo` with url, file
  page, license, author, attribution and its own `commercialOk`.
- The artist page shows the photo with "Photo: author, license" linked to the Commons file page and
  the license; artist rows fetched before photos existed are refreshed once when opened.

## Similar artists

- `ListenBrainzClient.getSimilarArtists(mbid)` (Labs API, CC0 data); stored on the artist as
  `similar` and refreshed every 30 days. "Free … music to play" searches the artist's top genre.

## Queue and playlists

- `queue.js`: Play all, auto-advance on `ended`, skip on unplayable audio, Next / Previous /
  Shuffle (More sheet, Media Session, `>` / `<`). Playing any other song ends the queue.
- `playlists.js`: LyricWaveDB v4 store `playlists` (`pl:<id>`, ordered `ov:` row ids). Adding a
  search result saves it to the library first.

## Backup and restore

- `backup.js`: Settings > Back up writes `lyricwave-library-YYYY-MM-DD.json` (local date; songs,
  artists, playlists, your lyrics, credits). Restore merges and never deletes; every row is rebuilt
  from known fields (https links only, numbers clamped).
- Ids must have the shapes the library makes: `mb:` / `isrc:` / `ov:` normalized, or
  `key:<artist__title>` (letters, digits, spaces). Only `ov:` rows keep an `openTrack` (and never an
  MBID or ISRC), `commercialOk` must agree with the row's license, and "the song's license" lyrics
  rights fall back to a personal copy outside Free music.
- Songs keep the larger play count and the widest first / last played times; artists are only
  added; playlists and your lyrics take the newer copy. New playlists stop at 200. Songs and
  artists are written in one transaction each, inside the collector's lock.
- Android 1.3.0 (versionCode 5) adds `saveFile` (Download/LyricWave, Android 10+), `shareFile`
  (cache/exports via FileProvider) and `onShowFileChooser` for the restore file picker (app origin
  only; lists `application/json`, `text/plain` and `application/octet-stream`, the labels other apps
  give .json files). These need the new APK; in-app web updates alone can't deliver them, and older
  apps say "Update the LyricWave app" instead of failing silently.

## Next ideas

- An Openverse API key through a Cloudflare function for higher search limits.
