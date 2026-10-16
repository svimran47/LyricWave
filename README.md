# LyricWave 🌊

**LyricWave** is a real-time, synchronized lyrics companion web application that visualizes animated lyrics for whatever music you are listening to, across any player or platform.

Designed with an **OLED Lyrics Reel** aesthetic featuring a centered, bordered lyric box and flowing, audio-phase-locked sine waves.

---

## 🌟 Key Features & Input Sources

LyricWave features a source-agnostic architecture coordinating 4 input methods:

1. **🎙️ Microphone Acoustic Recognition**:
   - Tap "Listen": recognition is tried after 4, 8 and 12 seconds of room audio and stops at the first match.
   - The **Shazam fingerprint is computed on the device** (`shazam-core.js`, byte-identical to SongRec/shazamio, pinned by `test-shazam.js`). Only the few-KB signature is sent; the desktop app asks Shazam directly from its main process, everything else goes through `/api/recognize`, which only proxies it.
   - `/api/recognize` walks a provider chain: Shazam (no keys), then ACRCloud / AudD when their credentials are configured. A clean "no match" is a normal 200 answer.
   - Automatic delay & RTT compensation calculates the exact playback position in the song.
   - Optional 2-minute auto re-listen and Re-sync button to catch song changes.
   - Complete hardware privacy: in-memory analysis only, audio is never logged or stored, and microphone streams are immediately closed.

2. **🔍 Manual Song Search**:
   - Instant search across LRCLIB and Apple iTunes.
   - One-tap "▶ Start" kicks off the playback clock with play, pause, resume, and scrubber seek controls.

3. **📻 Last.fm Live Scrobble Sync**:
   - Syncs Apple Music, YouTube Music, Tidal, Deezer, foobar2000, or any scrobbler-enabled player.
   - Enter your public username only (no password required).
   - **Approximate Mode**: Automatically anchors position to 0s upon scrobble change and advances using high-precision local time.

4. **🟢 Spotify Live Sync (Private Beta)**:
   - Direct Spotify Connect integration via browser-side OAuth 2.0 PKCE.
   - Sub-second drift detection and latency compensation.

5. **🖥️ This PC (desktop app)**: follows whatever the OS media controls show (Windows SMTC, Spotify/Music on macOS, MPRIS via `playerctl` on Linux) with the exact position, like the Android "Phone" tab.

6. **🌌 projectM fullscreen visualizer**: the real libprojectM 4 (MilkDrop engine) compiled to WebAssembly + WebGL 2 (`vendor/projectm/`, rebuilt by `scripts/projectm/build.sh`) with a curated "Cream of the Crop" preset pack. It follows the beat by default, or live audio (desktop system audio / microphone) when enabled. `N` skips to the next preset.

7. **📼 OLED Lyrics Reel Visualizer**:
   - 60fps canvas sine waves following song position with amplitude pulse on line changes.
   - Bordered line box that scales and fades in on line change.
   - Progressive **Word-by-Word Reveal** mode.
   - Three visual themes: **Pixel OLED** (Monochrome), **Neon**, and **Minimal**.
   - Respects `prefers-reduced-motion` and supports full-screen presentation mode.

8. **🖼️ Lyrics Card Maker**:
   - Pick 1–4 consecutive lines of the current song (it starts on the line playing now) from **More → Lyrics card** or the `C` key.
   - Four styles (**Spotlight** highlighted lines on the blurred cover, **Aurora**, **Paper**, **Neon**) in **Square** (1080×1080) or **Story** (1080×1920).
   - Shares through the system share sheet where the browser supports it, or downloads a PNG. Every card credits the song title and artist.
   - Cards quote short excerpts only (4 lines / 220 characters), since lyrics stay their songwriters' copyright.

9. **📱 Progressive Web App (PWA)**:
   - Installable on iOS, Android, macOS, and Windows.
   - Offline shell caching with service worker fallback and cache management.

---

## 🛠️ Complete Setup & Configuration Guide

### 1. Spotify Live Tracking Setup (OAuth PKCE)
Spotify authentication runs 100% in the browser using Proof Key for Code Exchange (no client secret or backend required).

1. Open the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and create an app.
2. In app settings, add your **Redirect URIs**:
   - Local: `http://127.0.0.1:8080/` (or `http://localhost:8080/`)
   - Production: `https://<your-project>.pages.dev/`
3. Edit `config.js` and set your `CLIENT_ID`:
   ```javascript
   export const CONFIG = {
     CLIENT_ID: "your_spotify_client_id_here",
     REDIRECT_URI: window.location.origin + window.location.pathname.replace(/\/index\.html$/, "/"),
     SCOPES: [
       "user-read-currently-playing",
       "user-read-playback-state",
       "user-read-private"
     ]
   };
   ```
4. In your Spotify Developer Dashboard under **Settings > User Management**, add your Spotify account email to the allowlist while the app is in Development Mode.
5. See [`SPOTIFY_SETUP.md`](SPOTIFY_SETUP.md) for full troubleshooting steps.

---

### 2. Last.fm Setup
No API key or password is required from end users:
1. Users enter their public Last.fm username directly in the app.
2. LyricWave uses public API calls (`user.getrecenttracks`) with 4-second polling.
3. The username and per-source calibration offset are remembered in local storage.

---

### 3. Audio Recognition Provider (AudD & ACRCloud)
The acoustic recognition endpoint lives at `functions/api/recognize.js` and uses a modular provider architecture in `functions/api/providers/`.

By default, **AudD** (`audd.io`) is configured as the primary recognition engine. You can also switch between AudD and ACRCloud anytime in the **Settings dialog** or via the `X-Recognition-Provider` header.

#### AudD Setup:
1. AudD works out of the box using the public test token (`test`) for local development (up to 10 requests/day).
2. For production, create an account at [dashboard.audd.io](https://dashboard.audd.io/) to get your personal API token.
3. Add your token to `.env` or your Cloudflare Pages Environment Variables:
   ```ini
   RECOGNITION_PROVIDER=audd
   AUDD_API_TOKEN=your_audd_api_token
   ```

#### ACRCloud Setup (Alternative Provider):
1. Sign up at [ACRCloud](https://www.acrcloud.com/) and navigate to the Console.
2. Under **Audio Recognition**, create an **Audio & Video Recognition** project with the **ACRCloud Music** bucket enabled.
3. Add your credentials to `.env`:
   ```ini
   ACR_HOST=identify-ap-southeast-1.acrcloud.com
   ACR_ACCESS_KEY=your_acrcloud_access_key
   ACR_ACCESS_SECRET=your_acrcloud_access_secret
   ```

#### Local Development:
Run locally using Wrangler:
```bash
npm install -g wrangler
wrangler pages dev .
```

Visit `http://127.0.0.1:8788/` or your assigned local port.

---

## 🚀 Deploying to Cloudflare Pages

LyricWave deploys as a static PWA with Cloudflare Pages Functions for the `/api/recognize` backend:

1. Push your repository to **GitHub** or **GitLab**.
2. Log into the [Cloudflare Dashboard](https://dash.cloudflare.com/) and go to **Compute (Workers) > Pages**.
3. Click **Connect to Git** and choose the repository.
4. Set the build configuration:
   - **Framework preset**: `None`
   - **Build command**: *(leave empty)*
   - **Build output directory**: `.`
5. Under **Settings > Environment Variables**, add your production secrets:
   - `ACR_HOST`: your ACRCloud endpoint host (e.g. `identify-ap-southeast-1.acrcloud.com`)
   - `ACR_ACCESS_KEY`: your project access key
   - `ACR_ACCESS_SECRET`: your project access secret
6. Click **Save and Deploy**.
7. Once deployed, copy your production Pages URL (e.g., `https://lyricwave.pages.dev`) and add it to your **Spotify Developer Dashboard** as an authorized Redirect URI.

---

## 🛡️ Privacy & Security Features

LyricWave includes a transparent **Privacy & Data Security** page (`privacy.html`):
- **In-Memory Audio**: Audio is processed purely in memory, never saved to disk or persistent logs.
- **Microphone Stream Closure**: Immediately stops all media tracks upon sampling.
- **Delete All My Data**: One-click action in `privacy.html` that removes all local preferences, cached lyrics, and PKCE tokens.
- **Logout**: Instantly disconnects Spotify and clears Last.fm usernames.

---

## 🧪 Testing & Verification

Run the test suite with Node.js:
```bash
node test-architecture.js
node test-player.js
node test-lyrics.js
node test-mic.js
node test-providers.js
node test-reel.js
node test-sources.js
```
All **153+ unit and integration tests** verify offset retention, error states, virtual clocks, and audio providers.
