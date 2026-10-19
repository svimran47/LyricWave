/**
 * LyricWave Application Controller
 * 
 * Master controller unifying 4 music input sources:
 * 1. Microphone Recognition (Default hero view)
 * 2. Manual Search (Instant lookup across iTunes & LRCLIB)
 * 3. Last.fm (Live scrobbles from Apple Music, YouTube Music, Tidal, etc.)
 * 4. Spotify Live Tracking (Private Beta)
 * 
 * All sources feed one shared UnifiedSyncEngine, driving the
 * OLED Lyrics Reel Visualizer and Synced Lyrics View.
 */

import { CONFIG } from './config.js';
import {
  initiateLogin,
  handleRedirectCallback,
  fetchUserProfile,
  getStoredUserProfile,
  isAuthenticated,
  logout
} from './auth.js';
import { SpotifySource } from './spotify-source.js';
import { MicSource } from './mic.js';
import { searchTracks, SearchSource } from './search.js';
import { LastFmSource } from './lastfm.js';
import { PhoneMediaSource } from './phone-source.js';
import { UnifiedSyncEngine } from './engine.js';
import { ReelVisualizer } from './reel.js';
import { AudioReactive } from './audio-reactive.js';
import { translateLyrics, defaultTargetLang, TRANSLATE_LANGUAGES, TranslationQuotaError } from './translate.js';
import { BeatVisuals } from './visuals.js';
import { CatDancer, STORAGE_CAT_DANCER_KEY } from './cat-dancer.js';
import { ProjectMVisualizer, isProjectMSupported } from './projectm-visualizer.js';
import { LyricCardMaker } from './card.js';
import { LibraryCollector } from './library.js';
import { MusicBrainzClient } from './musicbrainz.js';
import { LibraryView, rowArtUrl } from './library-view.js';
import { OpenverseClient, playableOpenTrack } from './openverse.js';
import { setUserLyricsProvider } from './lyrics.js';
import { UserLyricsStore, UserLyricsDialog } from './user-lyrics.js';
import { PlayQueue, RESTART_THRESHOLD_SEC } from './queue.js';
import { PlaylistStore, PlaylistsView, PlaylistPicker } from './playlists.js';
import { LibraryBackup, BackupFileError, backupFileName, describeCounts, describeRestore, MAX_BACKUP_BYTES } from './backup.js';
import { signUp, logIn, logOut, getCurrentUser, updateUserPreferences, deleteCurrentAccount } from './user-auth.js';

// DOM Elements: Navigation Tabs
const sourceNav = document.getElementById('sourceNav');
const sourceTabs = document.querySelectorAll('.source-tab');
const tabCharts = document.getElementById('tabCharts');
const tabNews = document.getElementById('tabNews');
const tabPanels = {
  phone: document.getElementById('panelPhone'),
  mic: document.getElementById('panelMic'),
  search: document.getElementById('panelSearch'),
  charts: document.getElementById('panelCharts'),
  news: document.getElementById('panelNews'),
  library: document.getElementById('panelLibrary'),
  connect: document.getElementById('panelConnect'),
  lastfm: document.getElementById('panelLastfm'),
  spotify: document.getElementById('panelSpotify')
};

// DOM Elements: Connect Segmented Switcher
const panelConnect = document.getElementById('panelConnect');
const btnSubLastfm = document.getElementById('btnSubLastfm');
const btnSubSpotify = document.getElementById('btnSubSpotify');
const subPanels = {
  lastfm: document.getElementById('panelLastfm'),
  spotify: document.getElementById('panelSpotify')
};

// DOM Elements: Recent Songs
const appContainer = document.querySelector('.container');
const recentSongsList = document.getElementById('recentSongsList');
const btnClearRecent = document.getElementById('btnClearRecent');

// DOM Elements: On-Stage Live Sync Nudge
const btnNudgeMinus = document.getElementById('btnNudgeMinus');
const btnNudgePlus = document.getElementById('btnNudgePlus');
const btnNudgeReset = document.getElementById('btnNudgeReset');
const onStageOffsetLabel = document.getElementById('onStageOffsetLabel');

// DOM Elements: Keyboard Shortcuts Cheat-sheet Modal
const btnOpenShortcuts = document.getElementById('btnOpenShortcuts');
const shortcutsBackdrop = document.getElementById('shortcutsBackdrop');
const btnCloseShortcuts = document.getElementById('btnCloseShortcuts');
const btnDoneShortcuts = document.getElementById('btnDoneShortcuts');

// DOM Elements: Mobile Bottom Sheet Drag Handle
const settingsDialog = document.getElementById('settingsDialog');

// DOM Elements: Toasts & Header
const toastRegion = document.getElementById('toastRegion');
const offlineBanner = document.getElementById('offlineBanner');
const offlineBannerText = document.getElementById('offlineBannerText');
const btnInstallPwa = document.getElementById('btnInstallPwa');
const btnOpenSettings = document.getElementById('btnOpenSettings');

// DOM Elements: Developer Mode
const devModeBanner = document.getElementById('devModeBanner');
const devClientIdStatus = document.getElementById('devClientIdStatus');
const devRedirectStatus = document.getElementById('devRedirectStatus');
const devDbgRawMs = document.getElementById('devDbgRawMs');
const devDbgEstimatedMs = document.getElementById('devDbgEstimatedMs');
const devDbgDriftMs = document.getElementById('devDbgDriftMs');
const devDbgLatencyMs = document.getElementById('devDbgLatencyMs');
const devDbgPollStatus = document.getElementById('devDbgPollStatus');
const devDbgPlayState = document.getElementById('devDbgPlayState');

// DOM Elements: Microphone Input
const btnMicListen = document.getElementById('btnMicListen');
const micRingPulse = document.getElementById('micRingPulse');
const micStatusTitle = document.getElementById('micStatusTitle');
const micStatusSubtitle = document.getElementById('micStatusSubtitle');
const micCountdownWrap = document.getElementById('micCountdownWrap');
const micCountdownText = document.getElementById('micCountdownText');
const micCountdownCircle = document.getElementById('micCountdownCircle');
const micLevelMeterWrap = document.getElementById('micLevelMeterWrap');
const micLevelFill = document.getElementById('micLevelFill');
const micActionRow = document.getElementById('micActionRow');
const btnMicCancel = document.getElementById('btnMicCancel');
const btnShowMicConsent = document.getElementById('btnShowMicConsent');
const micConsentBackdrop = document.getElementById('micConsentBackdrop');
const btnCloseMicConsent = document.getElementById('btnCloseMicConsent');
const btnCancelMicConsent = document.getElementById('btnCancelMicConsent');
const btnAcceptMicConsent = document.getElementById('btnAcceptMicConsent');

// DOM Elements: Search Input
const searchInput = document.getElementById('searchInput');
const btnClearSearch = document.getElementById('btnClearSearch');
const searchResults = document.getElementById('searchResults');

// DOM Elements: Charts Panel
const panelCharts = document.getElementById('panelCharts');
const chartsListContainer = document.getElementById('chartsListContainer');
const btnRefreshCharts = document.getElementById('btnRefreshCharts');
const chartsUpdatedTag = document.getElementById('chartsUpdatedTag');
const genrePills = document.querySelectorAll('.genre-pill');

// DOM Elements: News Panel
const panelNews = document.getElementById('panelNews');
const newsListContainer = document.getElementById('newsListContainer');
const btnRefreshNews = document.getElementById('btnRefreshNews');
const newsUpdatedTag = document.getElementById('newsUpdatedTag');
const newsFilterPills = document.querySelectorAll('.news-filter-pill');

// DOM Elements: Last.fm Input
const lastfmUserInput = document.getElementById('lastfmUserInput');
const btnConnectLastfm = document.getElementById('btnConnectLastfm');
const lastfmStatusInfo = document.getElementById('lastfmStatusInfo');
const lastfmStatusMsg = document.getElementById('lastfmStatusMsg');
const btnDisconnectLastfm = document.getElementById('btnDisconnectLastfm');

// DOM Elements: Spotify Beta
const spotifyLoggedOut = document.getElementById('spotifyLoggedOut');
const spotifyLoggedIn = document.getElementById('spotifyLoggedIn');
const btnLoginSpotify = document.getElementById('btnLoginSpotify');
const btnLogoutSpotify = document.getElementById('btnLogoutSpotify');
const userName = document.getElementById('userName');
const userAvatar = document.getElementById('userAvatar');
const avatarFallback = document.getElementById('avatarFallback');

// DOM Elements: Stage (Now Playing), Mini player & More sheet
const activePlaybackView = document.getElementById('activePlaybackView');
const btnStageCollapse = document.getElementById('btnStageCollapse');
const btnMoreSheet = document.getElementById('btnMoreSheet');
const miniPlayer = document.getElementById('miniPlayer');
const btnMiniOpen = document.getElementById('btnMiniOpen');
const btnMiniPlay = document.getElementById('btnMiniPlay');
const miniPlayUse = document.getElementById('miniPlayUse');
const miniTitle = document.getElementById('miniTitle');
const miniArtist = document.getElementById('miniArtist');
const miniArt = document.getElementById('miniArt');
const phoneNowCard = document.getElementById('phoneNowCard');
const phoneNowArt = document.getElementById('phoneNowArt');
const phoneNowArtPlaceholder = document.getElementById('phoneNowArtPlaceholder');
const phoneNowTitle = document.getElementById('phoneNowTitle');
const phoneNowArtist = document.getElementById('phoneNowArtist');
const btnPhoneNowOpen = document.getElementById('btnPhoneNowOpen');
const miniArtPlaceholder = document.getElementById('miniArtPlaceholder');
const miniProgressFill = document.getElementById('miniProgressFill');
const moreSheetBackdrop = document.getElementById('moreSheetBackdrop');
const moreSheet = document.getElementById('moreSheet');
const moreSheetHandle = document.getElementById('moreSheetHandle');
const btnCloseMoreSheet = document.getElementById('btnCloseMoreSheet');
const btnMoreOpenSettings = document.getElementById('btnMoreOpenSettings');
const animStyleButtons = document.querySelectorAll('.anim-style-btn');
const beatSyncStatus = document.getElementById('beatSyncStatus');
const beatSyncHint = document.getElementById('beatSyncHint');
const btnEnableAudioMode = document.getElementById('btnEnableAudioMode');
const btnReelExitFs = document.getElementById('btnReelExitFs');
const wordModeValue = document.getElementById('wordModeValue');
const trackArt = document.getElementById('trackArt');
const artPlaceholder = document.getElementById('artPlaceholder');
const playStateDot = document.getElementById('playStateDot');
const playStateText = document.getElementById('playStateText');
const trackSourceBadge = document.getElementById('trackSourceBadge');
const trackTitle = document.getElementById('trackTitle');
const trackArtist = document.getElementById('trackArtist');
const trackAlbum = document.getElementById('trackAlbum');
const trackLicense = document.getElementById('trackLicense');
const btnPlayPause = document.getElementById('btnPlayPause');
const iconPlay = document.getElementById('iconPlay');
const iconPause = document.getElementById('iconPause');
const btnSeekBack = document.getElementById('btnSeekBack');
const btnSeekForward = document.getElementById('btnSeekForward');
const btnResync = document.getElementById('btnResync');
const btnListenAgain = document.getElementById('btnListenAgain');
const btnShareSong = document.getElementById('btnShareSong');
const btnMakeLyricCard = document.getElementById('btnMakeLyricCard');
const btnEditUserLyrics = document.getElementById('btnEditUserLyrics');
const userLyricsBackdrop = document.getElementById('userLyricsBackdrop');
const lyricsCredit = document.getElementById('lyricsCredit');
const lyricsCreditText = document.getElementById('lyricsCreditText');
const btnLyricsCreditEdit = document.getElementById('btnLyricsCreditEdit');
const lyricCardBackdrop = document.getElementById('lyricCardBackdrop');
const firstRunHint = document.getElementById('firstRunHint');
const btnDismissFirstRun = document.getElementById('btnDismissFirstRun');
const progressTrack = document.getElementById('progressTrack');
const progressBarFill = document.getElementById('progressBarFill');
const timeElapsed = document.getElementById('timeElapsed');
const timeDuration = document.getElementById('timeDuration');

// DOM Elements: Reel Visualizer
const reelContainer = document.getElementById('reelContainer');
const reelCanvas = document.getElementById('reelCanvas');
const reelLineBox = document.getElementById('reelLineBox');
const reelLineText = document.getElementById('reelLineText');
const reelPrevLine = document.getElementById('reelPrevLine');
const reelNextLine = document.getElementById('reelNextLine');
const btnToggleWordMode = document.getElementById('btnToggleWordMode');
const btnFullscreen = document.getElementById('btnFullscreen');
const fsLabel = document.getElementById('fsLabel');
const themePills = document.querySelectorAll('.btn-theme-pill'); // legacy pills (themes now live in the More sheet / Settings swatches)
const stageArtBackdrop = document.getElementById('stageArtBackdrop');

// DOM Elements: Synced Lyrics View
const lyricsStatusBadge = document.getElementById('lyricsStatusBadge');
const lyricsStatusText = document.getElementById('lyricsStatusText');
const lyricsContent = document.getElementById('lyricsContent');
const btnToggleOffset = document.getElementById('btnToggleOffset');
const offsetPreviewLabel = document.getElementById('offsetPreviewLabel');
const offsetDrawer = document.getElementById('offsetDrawer');
const offsetSlider = document.getElementById('offsetSlider');
const btnOffsetMinus = document.getElementById('btnOffsetMinus');
const btnOffsetPlus = document.getElementById('btnOffsetPlus');
const btnOffsetReset = document.getElementById('btnOffsetReset');
const offsetValueText = document.getElementById('offsetValueText');
const btnToggleAutoRelisten = document.getElementById('btnToggleAutoRelisten');
const autoRelistenDot = document.getElementById('autoRelistenDot');
const autoRelistenLabel = document.getElementById('autoRelistenLabel');
const tapLineBanner = document.getElementById('tapLineBanner');
const btnDismissTapBanner = document.getElementById('btnDismissTapBanner');

// DOM Elements: Preferences Modal
const settingsBackdrop = document.getElementById('settingsBackdrop');
const btnCloseSettings = document.getElementById('btnCloseSettings');
const btnDoneSettings = document.getElementById('btnDoneSettings');
const settingThemeSelect = document.getElementById('settingThemeSelect'); // optional <select>; swatch cards are the primary picker
const themeCards = document.querySelectorAll('.theme-swatch-card');
const settingFontSize = document.getElementById('settingFontSize');
const lblFontSize = document.getElementById('lblFontSize');
const settingWordMode = document.getElementById('settingWordMode');
const settingHaptics = document.getElementById('settingHaptics');
const settingTranslate = document.getElementById('settingTranslate');
const settingTranslateLang = document.getElementById('settingTranslateLang');
const btnToggleRomanize = document.getElementById('btnToggleRomanize');
const romToggleText = document.getElementById('romToggleText');
const reelLineTranslation = document.getElementById('reelLineTranslation');
const settingOffsetSlider = document.getElementById('settingOffsetSlider');
const settingRecognitionProvider = document.getElementById('settingRecognitionProvider');
const btnSettingsOffsetMinus = document.getElementById('btnSettingsOffsetMinus');
const btnSettingsOffsetPlus = document.getElementById('btnSettingsOffsetPlus');
const btnSettingsOffsetReset = document.getElementById('btnSettingsOffsetReset');
const lblSettingsOffset = document.getElementById('lblSettingsOffset');
const settingDebugMode = document.getElementById('settingDebugMode');
const diagnosticsDrawer = document.getElementById('diagnosticsDrawer');
const btnResetDefaults = document.getElementById('btnResetDefaults');
const dbgPositionMs = document.getElementById('dbgPositionMs');
const dbgEffectiveMs = document.getElementById('dbgEffectiveMs');
const dbgActiveLine = document.getElementById('dbgActiveLine');
const dbgSource = document.getElementById('dbgSource');

// Configuration & Storage Keys
const STORAGE_THEME_KEY = 'lyricwave_theme';
const STORAGE_WORD_MODE_KEY = 'lyricwave_word_mode';
const STORAGE_FONT_SCALE_KEY = 'lyricwave_font_scale';
const STORAGE_LAST_SOURCE_KEY = 'lyricwave_last_source';
const STORAGE_RECENT_SONGS_KEY = 'lyricwave_recent_songs';
const STORAGE_FIRST_RUN_DISMISSED_KEY = 'lyricwave_first_run_dismissed';
const STORAGE_DISCOVER_VIEW_KEY = 'lyricwave_discover_view';
const STORAGE_ANIM_KEY = 'lyricwave_lyric_anim';
const STORAGE_HAPTICS_KEY = 'lyricwave_haptics';
const MAX_RECENT_SONGS = 10;

/** Every theme the UI offers (order = swatch order). Light themes tell the system bars to use dark icons. */
const THEME_IDS = ['adaptive', 'aurora', 'vinyl', 'paper', 'neon', 'pixel', 'minimal', 'sunset', 'ocean', 'sakura', 'mono', 'synthwave', 'forest'];
const ANIM_STYLES = ['pulse', 'reveal', 'karaoke', 'minimal'];
const DEFAULT_ANIM_STYLE = 'pulse';

function getDefaultTheme() {
  if (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
    return 'paper';
  }
  return 'aurora';
}

function safeGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeSet(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}

// Application State
let activeTab = localStorage.getItem(STORAGE_LAST_SOURCE_KEY) || 'mic';
let isOffsetDrawerOpen = false;
let currentTheme = THEME_IDS.includes(localStorage.getItem(STORAGE_THEME_KEY)) ? localStorage.getItem(STORAGE_THEME_KEY) : getDefaultTheme();
let currentAnimStyle = ANIM_STYLES.includes(safeGet(STORAGE_ANIM_KEY)) ? safeGet(STORAGE_ANIM_KEY) : DEFAULT_ANIM_STYLE;
let hapticsEnabled = safeGet(STORAGE_HAPTICS_KEY) !== 'false';
let isWordMode = localStorage.getItem(STORAGE_WORD_MODE_KEY) !== 'false';
// Lyric letter conversion & romanization (see translate.js)
const STORAGE_TRANSLATE_KEY = 'lyricwave_translate';
const STORAGE_TRANSLATE_LANG_KEY = 'lyricwave_translate_lang';
let isTranslateOn = safeGet(STORAGE_TRANSLATE_KEY) !== 'false';
const storedLang = safeGet(STORAGE_TRANSLATE_LANG_KEY);
let translateLang = (storedLang && TRANSLATE_LANGUAGES.some(([code]) => code === storedLang)) ? storedLang : defaultTargetLang();
let currentTranslations = [];
let currentReelLineIndex = -1;
let translateRequestId = 0;
let translateAbort = null;
let currentFontScale = parseInt(localStorage.getItem(STORAGE_FONT_SCALE_KEY) || '100', 10);
let deferredInstallPrompt = null;
let searchDebounceTimer = null;
let searchRequestSeq = 0;
let lineElements = [];
let reelWordElements = [];
let cursorIdleTimeout = null;

/**
 * Check if Developer Mode is active (strictly when explicitly requested via ?dev=1)
 */
function isDevMode() {
  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.get('dev') === '1';
}

/**
 * True when running inside the bundled Android app (WebView served from appassets).
 */
const IS_NATIVE_APP = typeof window !== 'undefined' && (
  window.location.hostname === 'appassets.androidplatform.net' ||
  /LyricWaveNativeApp/.test(navigator.userAgent || '')
);

/** True inside the Electron desktop app (desktop/preload.cjs exposes this bridge). */
const IS_DESKTOP_APP = typeof window !== 'undefined' && Boolean(window.LyricWaveDesktop && window.LyricWaveDesktop.isDesktop);

/**
 * Keep-screen-on while lyrics play. The Screen Wake Lock API is unavailable in Android
 * WebView, so the native shell exposes a one-method bridge for it.
 */
function setNativeKeepScreenOn(on) {
  try {
    if (window.LyricWaveNative && typeof window.LyricWaveNative.setKeepScreenOn === 'function') {
      window.LyricWaveNative.setKeepScreenOn(Boolean(on));
    }
  } catch {}
}

// =====================================================================
// Icons (inline SVG sprite in index.html), haptics & system-bar colour
// =====================================================================

/** Markup for a sprite icon. `name` is always a trusted literal. */
function icon(name, size = '') {
  const px = size === 'sm' ? 18 : (size === 'lg' ? 28 : 24);
  return `<svg class="icon${size ? ` icon--${size}` : ''}" width="${px}" height="${px}" aria-hidden="true" focusable="false"><use href="#i-${name}"/></svg>`;
}

/** Swap the glyph of an existing <use> element. */
function setUseIcon(useEl, name) {
  if (useEl) useEl.setAttribute('href', `#i-${name}`);
}

/** Native haptic tick (Android app only; the bridge does not exist on the web). kind: light | confirm | success | reject */
function haptic(kind = 'light') {
  if (!hapticsEnabled) return;
  try { window.LyricWaveNative?.haptic?.(kind); } catch {}
}

let chromeProbe = null;
/** Resolve the current --bg token to an opaque #rrggbb (computed colours come back as rgb()/rgba()). */
function readThemeBackground() {
  try {
    if (!chromeProbe) {
      chromeProbe = document.createElement('i');
      chromeProbe.setAttribute('aria-hidden', 'true');
      chromeProbe.style.cssText = 'display:none;background-color:var(--bg)';
      document.body.appendChild(chromeProbe);
    }
    const m = getComputedStyle(chromeProbe).backgroundColor.match(/\d+(\.\d+)?/g);
    if (m && m.length >= 3) {
      const [r, g, b] = m.slice(0, 3).map(Number);
      const alpha = m.length > 3 ? Number(m[3]) : 1;
      if (alpha > 0.5) return { hex: rgbToHex(r, g, b), r, g, b };
    }
  } catch {}
  return { hex: '#0a0c10', r: 10, g: 12, b: 16 };
}

/** Tell the OS (Android system bars, browser theme-color) about the background behind them. */
function syncChromeColor() {
  const { hex, r, g, b } = readThemeBackground();
  const isLight = getLuminance(r, g, b) > 0.4;
  try { window.LyricWaveNative?.setChromeColor?.(hex, isLight); } catch {}
  try { document.querySelector('meta[name="theme-color"]')?.setAttribute('content', hex); } catch {}
}

// =====================================================================
// Recently Identified Tracks (Persistent Local Storage)
// =====================================================================

function getRecentSongs() {
  try {
    const raw = localStorage.getItem(STORAGE_RECENT_SONGS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveRecentSong(track) {
  if (!track || !track.title) return;
  const recent = getRecentSongs();
  // Filter out duplicate if same title and artist
  const normalizedTitle = (track.title || '').trim().toLowerCase();
  const normalizedArtist = (track.artist || track.artists || '').trim().toLowerCase();
  const filtered = recent.filter(item => {
    const itemTitle = (item.title || '').trim().toLowerCase();
    const itemArtist = (item.artist || item.artists || '').trim().toLowerCase();
    return !(itemTitle === normalizedTitle && itemArtist === normalizedArtist);
  });

  const entry = {
    title: track.title,
    artist: track.artist || track.artists || 'Unknown Artist',
    album: track.album || '',
    albumArt: track.albumArt || '',
    durationSec: track.durationSec || (track.durationMs ? Math.round(track.durationMs / 1000) : 0),
    durationMs: track.durationMs || (track.durationSec ? track.durationSec * 1000 : 0),
    source: track.source || 'identified',
    timestamp: Date.now()
  };

  filtered.unshift(entry);
  if (filtered.length > MAX_RECENT_SONGS) {
    filtered.length = MAX_RECENT_SONGS;
  }

  try {
    localStorage.setItem(STORAGE_RECENT_SONGS_KEY, JSON.stringify(filtered));
  } catch (err) {
    console.warn('Failed to save recent song:', err);
  }

  renderRecentSongs();
}

function renderRecentSongs() {
  if (!recentSongsList) return;
  const songs = getRecentSongs();
  if (songs.length === 0) {
    recentSongsList.innerHTML = `<p class="recent-empty-hint">Identified songs will appear here.</p>`;
    return;
  }

  recentSongsList.innerHTML = '';
  const fragment = document.createDocumentFragment();

  songs.forEach((song) => {
    const btn = document.createElement('button');
    btn.className = 'recent-song-item';
    btn.type = 'button';
    btn.setAttribute('aria-label', `Play lyrics for ${song.title} by ${song.artist}`);

    const cleanArt = sanitizeUrl(song.albumArt);
    const artHtml = cleanArt
      ? `<img class="recent-song-art" src="${cleanArt}" alt="" width="32" height="32" loading="lazy" decoding="async">`
      : `<div class="recent-song-art recent-song-art--empty" aria-hidden="true">${icon('music', 'sm')}</div>`;

    btn.innerHTML = `
      ${artHtml}
      <div class="recent-song-text">
        <span class="recent-song-title">${escapeHtml(song.title)}</span>
        <span class="recent-song-artist">${escapeHtml(song.artist)}</span>
      </div>
    `;
    hideImageOnError(btn.querySelector('img.recent-song-art'));

    btn.addEventListener('click', () => {
      // Load track into searchSource & engine for interactive lyrics playback
      engine.connectSource(searchSource);
      searchSource.selectTrack({
        title: song.title,
        artist: song.artist,
        album: song.album,
        albumArt: song.albumArt,
        durationSec: song.durationSec,
        durationMs: song.durationMs
      }, true);
      showAlert(`Loaded lyrics for "${song.title}"`, 'info');
    });

    fragment.appendChild(btn);
  });

  recentSongsList.appendChild(fragment);
}

if (btnClearRecent) {
  btnClearRecent.addEventListener('click', () => {
    localStorage.removeItem(STORAGE_RECENT_SONGS_KEY);
    renderRecentSongs();
    showAlert('Recently identified songs cleared.', 'info');
  });
}

// =====================================================================
// Screen Wake Lock API (Now Playing / Reel Mode)
// =====================================================================

let wakeLockSentinel = null;

async function requestWakeLock() {
  if (document.hidden || !engine.isPlaying) return;
  setNativeKeepScreenOn(true);
  if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return;
  // Only request if playing and document is visible
  if (wakeLockSentinel) return;
  try {
    wakeLockSentinel = await navigator.wakeLock.request('screen');
    wakeLockSentinel.addEventListener('release', () => {
      wakeLockSentinel = null;
    });
  } catch (err) {
    // Fail silently (low battery mode, permissions, or backgrounded)
    wakeLockSentinel = null;
  }
}

async function releaseWakeLock() {
  setNativeKeepScreenOn(false);
  if (wakeLockSentinel) {
    try {
      await wakeLockSentinel.release();
    } catch {}
    wakeLockSentinel = null;
  }
}

// Re-request wake lock when returning to tab if playing
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    releaseWakeLock();
  } else if (engine && engine.isPlaying) {
    requestWakeLock();
  }
});

// =====================================================================
// Media Session API (System & Lock Screen Controls)
// =====================================================================

function updateMediaSessionMetadata(track) {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
  if (!track || !track.title) {
    navigator.mediaSession.metadata = null;
    return;
  }

  try {
    const artwork = [];
    if (track.albumArt) {
      artwork.push(
        { src: track.albumArt, sizes: '96x96', type: 'image/jpeg' },
        { src: track.albumArt, sizes: '128x128', type: 'image/jpeg' },
        { src: track.albumArt, sizes: '256x256', type: 'image/jpeg' },
        { src: track.albumArt, sizes: '512x512', type: 'image/jpeg' }
      );
    }

    // Open tracks carry their license in the album line so the credit reaches the lock screen too.
    const openCredit = track.openTrack ? (track.openTrack.licenseLabel || track.openTrack.license) : '';
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist || track.artists || 'Unknown Artist',
      album: [track.album || '', openCredit].filter(Boolean).join(' · '),
      artwork
    });

    // Wire Play / Pause / Seek where source supports it
    setupMediaSessionActionHandlers();
  } catch (err) {
    // Fail silently on unsupported fields
  }
}

let mediaSessionHandlersAttached = false;
function setupMediaSessionActionHandlers() {
  if (mediaSessionHandlersAttached || typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
  mediaSessionHandlersAttached = true;

  try {
    navigator.mediaSession.setActionHandler('play', () => {
      engine.play();
    });
    navigator.mediaSession.setActionHandler('pause', () => {
      engine.pause();
    });
    navigator.mediaSession.setActionHandler('seekbackward', (details) => {
      const skipSec = details.seekOffset || 5;
      engine.seekBy(-skipSec);
    });
    navigator.mediaSession.setActionHandler('seekforward', (details) => {
      const skipSec = details.seekOffset || 5;
      engine.seekBy(skipSec);
    });
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (typeof details.seekTime === 'number') {
        engine.seek(details.seekTime);
      }
    });
  } catch {}
}

function updateMediaSessionPlaybackState(isPlaying) {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
  } catch {}
}

const reel = new ReelVisualizer(reelCanvas, reelContainer, {
  theme: currentTheme,
  wordByWordMode: isWordMode
});

// Beat / vocal sync: native audio analysis in the Android app, lyric-rhythm estimate everywhere else.
const audioReactive = new AudioReactive();
reel.setAnimationStyle(currentAnimStyle);
reel.setAudioReactive(audioReactive);
reelContainer.dataset.anim = currentAnimStyle;

// Fullscreen beat visuals (bloom / rings / particles + the laser border), active only while the reel is fullscreen.
const fsVisualsCanvas = document.getElementById('fsVisualsCanvas');
const beatVisuals = fsVisualsCanvas
  ? new BeatVisuals(fsVisualsCanvas, reelContainer, { minFrameIntervalMs: reel.minFrameIntervalMs })
  : null;

// Orange cat dancer in the stage corner (Settings toggle, off by default; assets load only once enabled).
const reelStageEl = document.getElementById('reelStage');
const catDancer = reelStageEl ? new CatDancer(reelStageEl, {
  lineBoxEl: document.getElementById('reelLineBox'),
  reducedMotion: () => prefersReducedMotion()
}) : null;

// Fullscreen projectM (MilkDrop) visualizer: WASM + WebGL 2, loaded the first time fullscreen opens.
const STORAGE_VISUALIZER_KEY = 'lyricwave_visualizer';
const STORAGE_VISUALIZER_LIVE_KEY = 'lyricwave_visualizer_live';
const projectmCanvas = document.getElementById('projectmCanvas');
const btnProjectMNext = document.getElementById('btnProjectMNext');
const projectmPresetName = document.getElementById('projectmPresetName');
let visualizerMode = localStorage.getItem(STORAGE_VISUALIZER_KEY) || 'projectm';
let visualizerLive = localStorage.getItem(STORAGE_VISUALIZER_LIVE_KEY) === 'true';
let projectmSupported = null; // probed lazily (creates a throwaway WebGL 2 context)
let projectmSession = 0;
let presetNameTimer = null;
const projectm = projectmCanvas ? new ProjectMVisualizer(projectmCanvas, {
  onPresetChange: (name) => {
    if (!projectmPresetName) return;
    projectmPresetName.textContent = name;
    btnProjectMNext?.classList.add('show-name');
    clearTimeout(presetNameTimer);
    presetNameTimer = setTimeout(() => btnProjectMNext?.classList.remove('show-name'), 3500);
  }
}) : null;

// Stage / mini player state
let stageOpen = false;          // the full-screen Now Playing stage is showing
let hasTrack = false;           // the engine has a current track (mini player or stage visible)
let stageDismissedByUser = false; // user collapsed the stage: background sources (phone/Last.fm/Spotify) won't re-open it
let sheetOpen = false;          // More sheet
let audioDesired = false;       // audioReactive.enable() has been requested for this stage session
let pseudoFullscreen = false;   // reel fills the window with CSS (no Fullscreen API), see toggleFullscreen()
let fullscreenFallbackTimer = null;
const FULLSCREEN_SETTLE_MS = 800;
let miniUpdatedAt = 0;
let miniRatio = -1;
let shownElapsedText = '';
let shownDurationText = '';
let shownProgressInt = -1;
let reelWordStates = [];        // per reel word: 0 upcoming, 1 current, 2 revealed (-1 = not applied yet)
let shownWordIdx = -2;
let shownWordProgress = -1;
const reelVarCache = { beat: -1, vocal: -1, energy: -1 };
const AUTONOMOUS_SOURCES = new Set(['phone', 'lastfm', 'spotify']);

const clamp01 = (n) => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);

/** Set a 0..1 CSS variable on the reel only when it moved by more than 0.01 (or settled to 0). */
function setReelVar(name, key, value) {
  const v = clamp01(value);
  if (Math.abs(v - reelVarCache[key]) > 0.01 || (v === 0 && reelVarCache[key] !== 0)) {
    reelVarCache[key] = v;
    reelContainer.style.setProperty(name, v.toFixed(2));
  }
}

/** Per-frame DOM work for the stage: word states plus the C4 CSS hooks (--beat/--vocal/--energy/--word-progress, data-anim). */
function applyReelState(state, effectiveMs) {
  const style = currentAnimStyle;
  if (reelContainer.dataset.anim !== style) reelContainer.dataset.anim = style;

  const wordMode = Boolean(state.wordByWordMode) && style !== 'minimal';
  const currentIdx = state.currentWordIndex;

  for (let i = 0; i < reelWordElements.length; i++) {
    const want = !wordMode ? 2 : (i < currentIdx ? 2 : (i === currentIdx ? 1 : 0));
    if (reelWordStates[i] === want) continue;
    reelWordStates[i] = want;
    const el = reelWordElements[i];
    el.className = want === 2 ? 'reel-word revealed' : (want === 1 ? 'reel-word current' : 'reel-word');
    el.style.setProperty('--word-progress', want === 2 ? '1' : '0');
    if (want === 1) shownWordProgress = -1;
  }

  if (wordMode && currentIdx >= 0 && reelWordElements[currentIdx]) {
    let wp = state.wordProgress;
    if (typeof wp !== 'number') {
      const w = reel.activeWords && reel.activeWords[currentIdx];
      wp = w && w.endMs > w.startMs ? (effectiveMs - w.startMs) / (w.endMs - w.startMs) : 0;
    }
    wp = clamp01(wp);
    if (currentIdx !== shownWordIdx || Math.abs(wp - shownWordProgress) > 0.01) {
      shownWordIdx = currentIdx;
      shownWordProgress = wp;
      reelWordElements[currentIdx].style.setProperty('--word-progress', wp.toFixed(2));
    }
  }

  const reactive = style === 'pulse' || style === 'karaoke';
  setReelVar('--beat', 'beat', reactive ? Number(state.beat) : 0);
  setReelVar('--vocal', 'vocal', reactive ? Number(state.vocal) : 0);
  setReelVar('--energy', 'energy', reactive ? Number(state.energy) : 0);
}

/** Stage-only tick work (skipped while the stage is collapsed to the mini player). */
function updateStageTick(tick) {
  const elapsedText = formatMs(tick.positionMs);
  const durationText = formatMs(tick.durationMs);
  if (elapsedText !== shownElapsedText) {
    shownElapsedText = elapsedText;
    timeElapsed.textContent = elapsedText;
  }
  if (durationText !== shownDurationText) {
    shownDurationText = durationText;
    timeDuration.textContent = durationText;
  }
  progressBarFill.style.width = `${tick.progressPercent.toFixed(2)}%`;
  const progressInt = Math.round(tick.progressPercent);
  if (progressInt !== shownProgressInt) {
    shownProgressInt = progressInt;
    progressTrack.setAttribute('aria-valuenow', progressInt);
    progressTrack.setAttribute('aria-valuetext', `${elapsedText} of ${durationText}`);
  }
  const reelState = reel.render(tick.effectiveMs, tick.isPlaying);
  applyReelState(reelState, tick.effectiveMs);
  const projectmOn = Boolean(projectm?.active && projectm.ready);
  const catOn = Boolean(catDancer?.active);
  if (beatVisuals?.active || projectmOn || catOn) {
    // 'pulse' already pulled this tick's beat frame; other styles don't read it, so pull it here.
    let frame = reelState;
    if (reelState.animationStyle !== 'pulse') {
      try { frame = audioReactive.getFrame(tick.effectiveMs); } catch { frame = null; }
    }
    if (beatVisuals?.active) beatVisuals.render(frame, performance.now());
    if (projectmOn) projectm.render(frame, tick.isPlaying);
    if (catOn) catDancer.render(frame, tick.isPlaying, performance.now());
  }
}

/** Artwork for the stage header and the mini player, with a glyph fallback when missing or broken. */
function setArtwork(url) {
  const clean = sanitizeUrl(url);
  [[trackArt, artPlaceholder], [miniArt, miniArtPlaceholder], [phoneNowArt, phoneNowArtPlaceholder]].forEach(([img, placeholder]) => {
    if (!img) return;
    if (clean) {
      img.onerror = () => {
        img.classList.add('hidden');
        placeholder?.classList.remove('hidden');
      };
      img.src = clean;
      img.classList.remove('hidden');
      placeholder?.classList.add('hidden');
    } else {
      img.onerror = null;
      img.removeAttribute('src');
      img.classList.add('hidden');
      placeholder?.classList.remove('hidden');
    }
  });
  return clean;
}

/**
 * Credit line for openly licensed songs (Free music): license, creator and host, linked to the
 * license and the song's page. CC licenses require it wherever the song plays; hidden otherwise.
 */
function renderTrackLicense(track) {
  if (!trackLicense) return;
  const ot = track?.openTrack;
  if (!ot) {
    trackLicense.replaceChildren();
    trackLicense.classList.add('hidden');
    return;
  }
  const link = (text, href) => {
    const clean = sanitizeUrl(href);
    if (!clean || !/^https:/i.test(clean)) {
      const span = document.createElement('span');
      span.textContent = text;
      return span;
    }
    const a = document.createElement('a');
    a.href = clean;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = text;
    return a;
  };
  const parts = [link(ot.licenseLabel || ot.license, ot.licenseUrl)];
  if (ot.creator) parts.push(link(ot.creator, ot.creatorUrl));
  if (ot.provider) parts.push(link(`via ${ot.provider}`, ot.landingUrl));
  const nodes = [];
  parts.forEach((el, i) => {
    if (i) nodes.push(document.createTextNode(' · '));
    nodes.push(el);
  });
  trackLicense.replaceChildren(...nodes);
  trackLicense.title = ot.attribution || '';
  trackLicense.classList.remove('hidden');
}

// Free music queue ("Play all", auto-advance, Next / Previous, shuffle). See queue.js.
const playQueue = new PlayQueue();
const sheetQueueSection = document.getElementById('sheetQueueSection');
const btnQueueNext = document.getElementById('btnQueueNext');
const btnQueuePrev = document.getElementById('btnQueuePrev');
const btnQueueShuffle = document.getElementById('btnQueueShuffle');
const queueNextHint = document.getElementById('queueNextHint');
const queueShuffleHint = document.getElementById('queueShuffleHint');

function playQueueItem(item) {
  const track = item ? playableOpenTrack(item) : null;
  if (!track) return false;
  // Reconnecting would stop the source and report it idle, which collapses the stage between songs
  if (engine.currentSource !== searchSource) engine.connectSource(searchSource);
  searchSource.selectTrack(track, true);
  return true;
}

function playNextInQueue() {
  if (!playQueue.hasNext) return false;
  return playQueueItem(playQueue.next());
}

/** Previous restarts the song after its first few seconds, like most players. */
function playPreviousInQueue() {
  if (!playQueue.active) return false;
  const positionSec = engine.track ? engine.getEffectivePositionMs() / 1000 : 0;
  if (positionSec > RESTART_THRESHOLD_SEC || !playQueue.hasPrevious) {
    engine.seek(0);
    return true;
  }
  return playQueueItem(playQueue.previous());
}

/** Show / hide the queue rows in the More sheet and the lock-screen Next / Previous buttons. */
function updateQueueControls() {
  const on = playQueue.active;
  sheetQueueSection?.classList.toggle('hidden', !on);
  btnQueueShuffle?.classList.toggle('hidden', playQueue.length < 3);
  if (btnQueueNext) btnQueueNext.disabled = !playQueue.hasNext;
  if (queueNextHint) {
    const next = playQueue.upNext;
    queueNextHint.textContent = on
      ? (next ? `${playQueue.position} of ${playQueue.length} · Up next: ${next.title}` : `${playQueue.position} of ${playQueue.length} · Last song`)
      : '';
  }
  btnQueueShuffle?.setAttribute('aria-pressed', playQueue.shuffle ? 'true' : 'false');
  if (queueShuffleHint) queueShuffleHint.textContent = playQueue.shuffle ? 'On' : 'Off';
  if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
    try {
      navigator.mediaSession.setActionHandler('nexttrack', on && playQueue.hasNext ? () => playNextInQueue() : null);
      navigator.mediaSession.setActionHandler('previoustrack', on ? () => playPreviousInQueue() : null);
    } catch {}
  }
}

btnQueueNext?.addEventListener('click', () => { playNextInQueue(); updateQueueControls(); });
btnQueuePrev?.addEventListener('click', () => { playPreviousInQueue(); updateQueueControls(); });
btnQueueShuffle?.addEventListener('click', () => {
  playQueue.setShuffle(!playQueue.shuffle);
  updateQueueControls();
});

// Your lyrics: lyrics the user saved for a song are used before LRCLIB (see user-lyrics.js).
const userLyricsStore = new UserLyricsStore();
setUserLyricsProvider((track) => userLyricsStore.lyricsFor(track));

// Library (open track collector): every played song is stored in IndexedDB and matched to MusicBrainz.
const libraryCollector = new LibraryCollector({
  mb: new MusicBrainzClient({ apiBase: (CONFIG && CONFIG.API_BASE_URL) ? CONFIG.API_BASE_URL : '' }),
  onChange: () => libraryView?.refresh(),
  onResolved: (track, row) => {
    // Hand the stable ids back to the song on screen so later lookups key on the same thing.
    const live = engine?.track;
    if (!live || live.id !== track.id || !row?.mbid) return;
    live.mbid = row.mbid;
    if (row.isrc) live.isrc = row.isrc;
    live.stableId = row.id;
  }
});
let libraryView = null;

const engine = new UnifiedSyncEngine({
  onTrackChange: (track) => {
    hasTrack = true;
    catDancer?.reset();
    // The welcome hint has done its job once lyrics are on screen.
    if (firstRunHint && !firstRunHint.classList.contains('hidden')) {
      firstRunHint.classList.add('hidden');
      try { localStorage.setItem(STORAGE_FIRST_RUN_DISMISSED_KEY, 'true'); } catch {}
    }
    // Re-sync / auto re-listen record a new mic sample: only meaningful for songs the mic identified.
    const fromMic = track.source === 'mic';
    btnResync?.classList.toggle('hidden', !fromMic);
    btnToggleAutoRelisten?.classList.toggle('hidden', !fromMic);

    const artistText = track.artists || track.artist || '';
    trackTitle.textContent = track.title;
    trackTitle.title = track.title;
    trackArtist.textContent = artistText;
    trackAlbum.textContent = track.album || '';
    trackAlbum.classList.toggle('hidden', !track.album);
    renderTrackLicense(track);
    if (miniTitle) miniTitle.textContent = track.title;
    if (miniArtist) miniArtist.textContent = artistText;
    if (phoneNowTitle) phoneNowTitle.textContent = track.title;
    if (phoneNowArtist) phoneNowArtist.textContent = artistText;
    btnMiniOpen?.setAttribute('aria-label', `Open now playing: ${track.title}${artistText ? ` by ${artistText}` : ''}`);

    if (track.isApproximate || track.source === 'lastfm') {
      trackSourceBadge.textContent = 'APPROXIMATE';
      trackSourceBadge.title = 'Last.fm sync starts at 0s on track change. Use the sync offset in the More sheet to calibrate.';
    } else if (track.openTrack) {
      trackSourceBadge.textContent = 'FREE MUSIC';
      trackSourceBadge.title = 'Openly licensed song from Openverse';
    } else {
      trackSourceBadge.textContent = track.source?.toUpperCase() || 'LIVE';
      trackSourceBadge.title = '';
    }

    const cleanArt = setArtwork(track.albumArt);
    // If user is on Album Adaptive theme, extract and apply palette immediately
    if (currentTheme === 'adaptive') {
      applyAlbumAdaptivePalette(cleanArt || null);
    }

    updateOffsetUI();
    miniRatio = -1;
    shownElapsedText = '';
    shownDurationText = '';
    shownProgressInt = -1;
    audioReactive.setPlaying(Boolean(engine.isPlaying));

    // A new track opens the stage. Background sources (phone / Last.fm / Spotify) only do so until the
    // user has collapsed it once, so the next song never yanks the UI back open.
    if (!stageOpen) {
      const userDriven = !AUTONOMOUS_SOURCES.has(track.source);
      if (userDriven) stageDismissedByUser = false;
      if (userDriven || !stageDismissedByUser) openStage({ auto: true });
      else updateStageChrome();
    }

    // Playing anything that isn't the queue's current song ends the Free music queue
    if (playQueue.active && !playQueue.isCurrent(track.id)) playQueue.clear();
    updateQueueControls();

    // Persist song to recently identified list
    saveRecentSong(track);
    // Collect it into the Library (matching to MusicBrainz runs in the background, 1 request/s)
    libraryCollector.collect(track).catch((err) => console.warn('Library collect failed:', err));

    // Update Media Session API metadata & Lock screen controls
    updateMediaSessionMetadata(track);

    // Request Screen Wake Lock if playing
    if (engine.isPlaying || track.isPlaying) {
      requestWakeLock();
    }

    requestAnimationFrame(() => reel.resizeCanvas());
  },

  onPlaybackChange: (isPlaying) => {
    if (isPlaying) {
      playStateDot.classList.remove('paused');
      playStateText.textContent = 'Playing';
      iconPlay.classList.add('hidden');
      iconPause.classList.remove('hidden');
      requestWakeLock();
    } else {
      playStateDot.classList.add('paused');
      playStateText.textContent = 'Paused';
      iconPlay.classList.remove('hidden');
      iconPause.classList.add('hidden');
      releaseWakeLock();
    }
    btnPlayPause?.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
    btnMiniPlay?.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
    setUseIcon(miniPlayUse, isPlaying ? 'pause' : 'play');
    audioReactive.setPlaying(isPlaying);

    updateMediaSessionPlaybackState(isPlaying);
  },

  onLyricsLoaded: (lyrics) => {
    renderLyricsState(lyrics);
    currentReelLineIndex = -1;
    requestTranslations(lyrics);
    audioReactive.setLyrics(lyrics && lyrics.status === 'synced' ? lyrics.syncedLines : []);
    updateBeatSyncUI();
  },

  onLineChange: (lineIndex, line) => {
    // 1. Highlight line in scrolling view
    for (let i = 0; i < lineElements.length; i++) {
      const el = lineElements[i];
      if (i < lineIndex) {
        el.className = 'lyric-line past-line';
      } else if (i === lineIndex) {
        el.className = 'lyric-line active-line';
      } else {
        el.className = 'lyric-line upcoming-line';
      }
    }

    if (stageOpen) centerActiveLine(prefersReducedMotion() ? 'auto' : 'smooth');

    // 2. Update OLED Reel Centered Box
    updateReelLine(lineIndex);
    catDancer?.setLine(line ? line.text : '');
  },

  onTick: (tick) => {
    // Mini player progress line: ~4 updates per second is plenty for a 2px bar.
    const now = performance.now();
    if (hasTrack && now - miniUpdatedAt >= 250) {
      miniUpdatedAt = now;
      const ratio = clamp01(tick.progressPercent / 100);
      if (Math.abs(ratio - miniRatio) > 0.0005) {
        miniRatio = ratio;
        miniProgressFill?.style.setProperty('--p', ratio.toFixed(4));
      }
    }

    if (stageOpen || isReelFullscreen()) {
      updateStageTick(tick);
    }

    // Developer Mode Diagnostics (localhost or ?dev=1)
    if (devDbgRawMs && isDevMode()) {
      devDbgRawMs.textContent = `${tick.rawMs.toLocaleString()} ms`;
      devDbgEstimatedMs.textContent = `${tick.positionMs.toLocaleString()} ms`;
      const driftSign = tick.driftMs >= 0 ? '+' : '';
      devDbgDriftMs.textContent = `${driftSign}${tick.driftMs} ms`;
      devDbgLatencyMs.textContent = `${spotifySource?.lastLatencyMs || 0} ms`;
      devDbgPollStatus.textContent = spotifySource?.lastPollStatus || 'Active';
      devDbgPlayState.textContent = tick.isPlaying ? 'PLAYING' : 'PAUSED';
    }

    // Diagnostics readout (if enabled in settings)
    if (settingDebugMode && settingDebugMode.checked) {
      dbgPositionMs.textContent = `${tick.positionMs.toLocaleString()} ms`;
      dbgEffectiveMs.textContent = `${tick.effectiveMs.toLocaleString()} ms`;
      dbgActiveLine.textContent = tick.activeLineIndex >= 0 ? `#${tick.activeLineIndex + 1}` : 'Intro';
      dbgSource.textContent = engine.track?.source?.toUpperCase() || 'Ready';
    }
  },

  onIdle: () => {
    hasTrack = false;
    miniRatio = -1;
    audioReactive.setPlaying(false);
    if (stageOpen) closeStage({ restoreFocus: false });
    else updateStageChrome();
    // Make sure the panel for the active tab is showing again.
    showActivePanels();
    releaseWakeLock();
    updateMediaSessionMetadata(null);
  },

  onSongEnd: (finishedTrack) => {
    // If user is on the Microphone source, auto re-listen to detect the next song
    // Only for songs the mic itself identified — never switch the mic on after a search,
    // chart or recent-song playback just because the Mic tab happens to be selected.
    if (activeTab === 'mic' && finishedTrack?.source === 'mic' && !mic.isListening && !document.hidden) {
      micStatusTitle.textContent = 'Song Finished — Listening for next song...';
      showAlert(`Finished "${finishedTrack.title}". Listening for the next song...`, 'info');
      mic.start();
    }
  },

  onError: (err) => {
    const msg = typeof err === 'string' ? err : (err?.message || 'Sync error occurred.');
    console.warn('Sync engine error:', msg);
    showAlert(msg, 'warning');
  }
});

// Start the engine loop
engine.start();

// =====================================================================
// Stage (Now Playing) / Mini player / More sheet
// =====================================================================

/** Scroll the full lyrics list so the active line is centred (inside the list only; the page never jumps). */
function centerActiveLine(behavior = 'auto') {
  const idx = engine.activeLineIndex;
  const el = idx >= 0 ? lineElements[idx] : null;
  if (!el || !lyricsViewport || !lyricsViewport.clientHeight) return;
  const targetScroll = el.offsetTop - (lyricsViewport.clientHeight / 2) + (el.clientHeight / 2);
  lyricsViewport.scrollTo({ top: Math.max(0, targetScroll), behavior });
}

/** Mirror stageOpen / hasTrack into the DOM: stage visibility, mini player, body hooks, background inertness. */
function updateStageChrome() {
  const showMini = hasTrack && !stageOpen;
  activePlaybackView.classList.toggle('hidden', !stageOpen);
  activePlaybackView.classList.toggle('is-open', stageOpen);
  miniPlayer?.classList.toggle('hidden', !showMini);
  phoneNowCard?.classList.toggle('hidden', !hasTrack);
  document.body.classList.toggle('stage-open', stageOpen);
  document.body.classList.toggle('has-mini-player', showMini);
  // Everything behind the stage is out of reach for keyboard and screen readers while it is open.
  if (appContainer && 'inert' in appContainer) appContainer.inert = stageOpen;
  btnMoreSheet?.setAttribute('aria-expanded', sheetOpen ? 'true' : 'false');
}

/** Show only the panel(s) that belong to the active tab (used when the stage collapses or playback ends). */
function showActivePanels() {
  if (stageOpen) return;
  Object.keys(tabPanels).forEach((key) => {
    const el = tabPanels[key];
    if (!el) return;
    let visible = key === activeTab;
    if (key === 'lastfm' || key === 'spotify') visible = activeTab === 'connect' && key === activeConnectSubTab;
    el.classList.toggle('hidden', !visible);
  });
}

// --- History integration: Android Back (WebView goBack) closes the sheet, then the stage, then leaves the app.
// Each history entry we push carries the full overlay stack in its state ({ lwNav: ['stage','sheet'] }), so
// popstate reconciles the UI with whatever entry the browser actually landed on — no counters to drift.
let navStack = [];
let navTraversalPending = false;
let navTraversalTimer = null;
const navPushQueue = [];

function pushNav(name) {
  if (navTraversalPending) {
    // A programmatic history.go() hasn't landed yet; pushing now would be undone by it.
    navPushQueue.push(name);
    return;
  }
  try {
    navStack = [...navStack, name];
    history.pushState({ lwNav: navStack }, '');
  } catch {}
}

function finishNavTraversal() {
  navTraversalPending = false;
  if (navTraversalTimer) { clearTimeout(navTraversalTimer); navTraversalTimer = null; }
  const queued = navPushQueue.splice(0);
  queued.forEach((name) => {
    // Only re-push overlays that are still open.
    if ((name === 'stage' && stageOpen) || (name === 'sheet' && sheetOpen) || (name === 'fs' && pseudoFullscreen)) pushNav(name);
  });
}

/** Remove the history entries from `name` upwards (used when closing programmatically). */
function unwindNav(name) {
  const idx = navStack.lastIndexOf(name);
  if (idx < 0) return;
  const n = navStack.length - idx;
  navStack = navStack.slice(0, idx);
  navTraversalPending = true;
  // If the browser never reports the traversal (entry gone after a reload/redirect), don't block forever.
  navTraversalTimer = setTimeout(finishNavTraversal, 600);
  try {
    history.go(-n);
  } catch {
    finishNavTraversal();
  }
}

window.addEventListener('popstate', (event) => {
  const landed = Array.isArray(event.state?.lwNav) ? event.state.lwNav : [];
  navStack = [...landed];
  // Close whatever is open but not part of the entry we landed on (closing is idempotent).
  // Fullscreen opened while a programmatic traversal was still landing (e.g. the More sheet closing as
  // Fullscreen is tapped) has its entry queued, not yet pushed: that landing is not a Back from fullscreen.
  if (pseudoFullscreen && !landed.includes('fs') && !navPushQueue.includes('fs')) {
    setPseudoFullscreen(false, { fromHistory: true });
  }
  if (sheetOpen && !landed.includes('sheet')) closeMoreSheet({ fromHistory: true });
  if (stageOpen && !landed.includes('stage')) closeStage({ fromHistory: true, userInitiated: !navTraversalPending });
  if (navTraversalPending) finishNavTraversal();
});

function openStage({ auto = false, focus = true } = {}) {
  if (!hasTrack || stageOpen) return;
  stageOpen = true;
  stageDismissedByUser = false;
  Object.values(tabPanels).forEach((el) => el?.classList.add('hidden'));
  updateStageChrome();
  pushNav('stage');
  shownElapsedText = '';
  shownDurationText = '';
  shownProgressInt = -1;
  reelWordStates.fill(-1);
  requestAnimationFrame(() => {
    reel.resizeCanvas();
    centerActiveLine('auto');
  });
  syncAudioReactive();
  if (focus) btnStageCollapse?.focus({ preventScroll: true });
}

function closeStage({ restoreFocus = true, fromHistory = false, userInitiated = false } = {}) {
  if (!stageOpen) return;
  if (sheetOpen) closeMoreSheet({ restoreFocus: false, skipHistory: true });
  clearFullscreenFallback();
  if (document.fullscreenElement) {
    try { document.exitFullscreen?.()?.catch?.(() => {}); } catch {}
  }
  // Leaving the stage also leaves fullscreen; its history entry sits above 'stage' and goes with it.
  setPseudoFullscreen(false, { skipHistory: true });
  stageOpen = false;
  if (userInitiated) stageDismissedByUser = true;
  showActivePanels();
  updateStageChrome();
  syncAudioReactive();
  if (!fromHistory) unwindNav('stage');
  if (restoreFocus && hasTrack) btnMiniOpen?.focus({ preventScroll: true });
}

btnStageCollapse?.addEventListener('click', () => {
  haptic('light');
  closeStage({ userInitiated: true });
});
btnPhoneNowOpen?.addEventListener('click', () => {
  haptic('light');
  openStage();
});
// Tapping anywhere on the mini player (art, text, empty space) opens the stage; Enter/Space work via #btnMiniOpen.
miniPlayer?.addEventListener('click', (e) => {
  if (e.target.closest('.mini-play')) return;
  openStage();
});
btnMiniPlay?.addEventListener('click', (e) => {
  e.stopPropagation();
  haptic('light');
  engine.togglePlay();
});

// --- Audio-reactive lifecycle: on while the stage is open (and the app visible) for beat-synced styles.
function wantAudioReactive() {
  if (!stageOpen || document.hidden) return false;
  // Fullscreen always runs the beat visuals, whatever the lyric animation style.
  return currentAnimStyle === 'pulse' || currentAnimStyle === 'karaoke' || isReelFullscreen();
}

/** Start/stop audio-reactive analysis to match the UI state. Resolves to the resulting mode. */
function syncAudioReactive({ requestPermission = false } = {}) {
  if (!wantAudioReactive()) {
    if (audioDesired) {
      audioDesired = false;
      audioReactive.disable();
    }
    updateBeatSyncUI();
    return Promise.resolve(audioReactive.mode);
  }
  if (audioDesired && !requestPermission) return Promise.resolve(audioReactive.mode);
  audioDesired = true;
  // Without requestPermission this only goes native when Android already granted RECORD_AUDIO (no prompt);
  // otherwise it runs on the lyric rhythm until the user taps "Enable audio mode".
  return audioReactive.enable({ requestPermission })
    .catch(() => audioReactive.mode)
    .then((mode) => {
      updateBeatSyncUI();
      return mode;
    });
}

audioReactive.onModeChange = () => updateBeatSyncUI();

document.addEventListener('visibilitychange', () => {
  syncAudioReactive();
});

function updateBeatSyncUI() {
  const mode = audioReactive.mode;
  const reactiveStyle = currentAnimStyle === 'pulse' || currentAnimStyle === 'karaoke';
  const nativeOk = AudioReactive.isNativeAvailable();
  if (beatSyncStatus) {
    beatSyncStatus.textContent = mode === 'audio' ? 'Following the music'
      : (mode === 'lyrics' ? 'Following lyric rhythm' : 'Off');
  }
  if (beatSyncHint) {
    let hint;
    if (!reactiveStyle) hint = 'Pulse and Karaoke follow the beat and the vocals. Pick one of them to turn beat sync on.';
    else if (mode === 'audio') hint = 'Reacting to the music playing on this phone. Audio is analysed live and never recorded.';
    else if (nativeOk) hint = 'Using the lyric timing as a stand-in. Enable audio mode to follow the real music.';
    else hint = 'Using the lyric timing to estimate the beat. Audio mode is available in the Android app.';
    beatSyncHint.textContent = hint;
  }
  btnEnableAudioMode?.classList.toggle('hidden', !(reactiveStyle && nativeOk && mode !== 'audio'));
}

// --- Lyric animation style
function setAnimStyle(style, { persist = true } = {}) {
  if (!ANIM_STYLES.includes(style)) style = DEFAULT_ANIM_STYLE;
  currentAnimStyle = style;
  if (persist) safeSet(STORAGE_ANIM_KEY, style);
  reel.setAnimationStyle(style);
  reelContainer.dataset.anim = style;
  animStyleButtons.forEach((btn) => {
    const on = btn.dataset.animStyle === style;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-checked', on ? 'true' : 'false');
  });
  reelWordStates.fill(-1); // re-apply word states (Minimal shows the whole line)
  syncAudioReactive();
  updateBeatSyncUI();
}

animStyleButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    haptic('light');
    setAnimStyle(btn.dataset.animStyle);
  });
});

btnEnableAudioMode?.addEventListener('click', async () => {
  haptic('light');
  btnEnableAudioMode.disabled = true;
  try {
    const mode = await syncAudioReactive({ requestPermission: true });
    if (mode === 'audio') showAlert('Audio mode is on. Lyrics now follow the music.', 'success');
    else showAlert('Audio mode is not available right now, so beat sync follows the lyric rhythm.', 'warning');
  } finally {
    btnEnableAudioMode.disabled = false;
    updateBeatSyncUI();
  }
});

// --- More sheet
function trapFocusVisible(container, event) {
  if (event.key !== 'Tab') return;
  const focusables = Array.from(container.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'))
    .filter((el) => el.offsetParent !== null);
  if (focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (!container.contains(document.activeElement)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function openMoreSheet() {
  if (sheetOpen || !stageOpen || !moreSheetBackdrop) return;
  sheetOpen = true;
  moreSheetBackdrop.classList.remove('hidden');
  moreSheetBackdrop.setAttribute('aria-hidden', 'false');
  btnMoreSheet?.setAttribute('aria-expanded', 'true');
  if ('inert' in activePlaybackView) activePlaybackView.inert = true;
  updateBeatSyncUI();
  updateOffsetUI();
  pushNav('sheet');
  setTimeout(() => { if (sheetOpen) btnCloseMoreSheet?.focus(); }, 50);
}

function closeMoreSheet({ restoreFocus = true, skipHistory = false, fromHistory = false } = {}) {
  if (!sheetOpen) return;
  sheetOpen = false;
  moreSheetBackdrop.classList.add('hidden');
  moreSheetBackdrop.setAttribute('aria-hidden', 'true');
  btnMoreSheet?.setAttribute('aria-expanded', 'false');
  if ('inert' in activePlaybackView) activePlaybackView.inert = false;
  if (!skipHistory && !fromHistory) unwindNav('sheet');
  if (restoreFocus && stageOpen) btnMoreSheet?.focus({ preventScroll: true });
}

btnMoreSheet?.addEventListener('click', openMoreSheet); // haptic tick comes from the dock listener
btnCloseMoreSheet?.addEventListener('click', () => closeMoreSheet());
moreSheetBackdrop?.addEventListener('click', (e) => {
  if (e.target === moreSheetBackdrop) closeMoreSheet();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && sheetOpen && moreSheet) trapFocusVisible(moreSheet, e);
});

// Swipe the sheet's handle down to dismiss it
if (moreSheetHandle && moreSheet) {
  let startY = 0;
  let currentY = 0;
  moreSheetHandle.addEventListener('touchstart', (e) => {
    startY = e.touches[0].clientY;
    currentY = startY;
  }, { passive: true });
  moreSheetHandle.addEventListener('touchmove', (e) => {
    currentY = e.touches[0].clientY;
    const deltaY = currentY - startY;
    if (deltaY > 0) moreSheet.style.transform = `translateY(${deltaY}px)`;
  }, { passive: true });
  moreSheetHandle.addEventListener('touchend', () => {
    const deltaY = currentY - startY;
    moreSheet.style.transform = '';
    if (deltaY > 60) closeMoreSheet();
    startY = 0;
    currentY = 0;
  });
}

// =====================================================================
// Input Source 1: Microphone Recognition
// =====================================================================

const mic = new MicSource({
  provider: localStorage.getItem('lyricwave_recognition_provider') || CONFIG.RECOGNITION_PROVIDER || 'shazam',
  onStatusChange: (statusText, statusType) => {


    micStatusSubtitle.textContent = statusText;
    if (statusType === 'success') {
      micStatusTitle.textContent = 'Found!';
    } else if (statusType === 'working') {
      if (statusText.toLowerCase().includes('analyz') || statusText.toLowerCase().includes('identif')) {
        micStatusTitle.textContent = 'Matching...';
      } else {
        micStatusTitle.textContent = 'Listening...';
      }
    }
  },

  onAudioLevel: (normalizedLevel) => {
    // 1. Scale microphone orb and drive dynamic outer ring ripple
    const scale = 1 + (normalizedLevel * 0.25);
    btnMicListen.style.transform = `scale(${scale})`;

    if (micRingPulse) {
      micRingPulse.style.transform = `scale(${1 + (normalizedLevel * 0.6)})`;
      micRingPulse.style.opacity = (0.2 + (normalizedLevel * 0.8)).toFixed(2);
      micRingPulse.style.borderColor = 'var(--accent)';
    }

    // 2. Drive live audio level meter width
    if (micLevelFill) {
      const pct = Math.min(100, Math.round(normalizedLevel * 100));
      micLevelFill.style.width = `${pct}%`;
    }
  },

  onCountdown: (secondsRemaining, totalSeconds = 5) => {
    if (micCountdownText) {
      micCountdownText.textContent = `Listening... ${secondsRemaining}s`;
    }
    if (micCountdownCircle) {
      const circumference = 314.16;
      // Countdown progress fraction
      const fraction = Math.max(0, Math.min(1, (totalSeconds - secondsRemaining) / totalSeconds));
      micCountdownCircle.style.strokeDashoffset = (circumference * fraction).toFixed(2);
    }
  },

  onListeningStateChange: (isListening) => {
    btnMicListen.classList.toggle('listening', isListening);
    const orbContainer = btnMicListen.closest('.mic-orb-container');
    if (orbContainer) orbContainer.classList.toggle('listening', isListening);

    micCountdownWrap.classList.toggle('hidden', !isListening);
    micLevelMeterWrap.classList.toggle('hidden', !isListening);
    micActionRow.classList.toggle('hidden', !isListening);

    if (!isListening) {
      btnMicListen.style.transform = '';
      if (micRingPulse) {
        micRingPulse.style.transform = '';
        micRingPulse.style.opacity = '';
      }
      if (micLevelFill) micLevelFill.style.width = '0%';
      if (micCountdownCircle) {
        micCountdownCircle.style.strokeDashoffset = '0';
      }
    }
  },

  // Fired by MicSource just before it hands the track to the engine via onTrackChange.
  onIdentified: (track) => {
    micStatusTitle.textContent = 'Found!';
    micStatusSubtitle.textContent = `Found: ${track.title} - ${track.artist || track.artists}`;
    haptic('success');

    // Route mic results into the sync engine. start:false — connecting must never
    // start another recording (that used to double-record every identification).
    if (engine.currentSource !== mic) {
      engine.connectSource(mic, { start: false, syncCurrent: false });
    }
    // The engine's onTrackChange opens the stage for the identified song.
  },

  onError: (errMsg, errorType) => {
    btnMicListen.classList.remove('listening');
    btnMicListen.style.transform = '';
    micStatusTitle.textContent = 'Tap to Listen';
    micStatusSubtitle.textContent = errMsg;

    // Helpful visual alert with actionable retry
    if (errorType === 'denied') {
      micStatusTitle.textContent = 'Microphone Blocked';
      if (IS_NATIVE_APP) {
        micStatusSubtitle.innerHTML = `Microphone access is off for LyricWave. Open <strong>Settings → Apps → LyricWave → Permissions</strong>, allow <strong>Microphone</strong>, then tap Retry.`;
        showAlert('Microphone permission is off. Allow it in Android Settings → Apps → LyricWave → Permissions, then tap Retry.', 'warning');
      } else {
        micStatusSubtitle.innerHTML = `Microphone access was blocked. Click the <strong>lock/tune icon</strong> in your browser address bar and set Microphone to <strong>Allow</strong>, then tap Retry.`;
        showAlert('Microphone permission blocked. Click the lock icon in the address bar to Allow, then tap Retry.', 'warning');
      }
      if (micActionRow) {
        micActionRow.classList.remove('hidden');
        micActionRow.innerHTML = `<button id="btnMicRetryPermission" class="btn btn-sm btn-spotify" type="button">${icon('refresh', 'sm')} Retry Mic</button>`;
        const btnRetry = document.getElementById('btnMicRetryPermission');
        if (btnRetry) {
          btnRetry.addEventListener('click', () => {
            micStatusTitle.textContent = 'Tap to Listen';
            micStatusSubtitle.textContent = 'Identifies any song playing from nearby speakers, radio, TV, or vinyl.';
            micActionRow.innerHTML = `<button id="btnMicCancel" class="btn btn-sm btn-ghost" type="button">Cancel</button>`;
            document.getElementById('btnMicCancel')?.addEventListener('click', () => mic.stop());
            mic.start();
          });
        }
      }
    } else if (errorType === 'too_quiet') {
      showAlert('Audio was too quiet to detect music. Move closer to the speaker and tap Listen.', 'warning');
    } else if (errorType === 'no_match') {
      showAlert('No song match found. Try again during the chorus or louder section.', 'warning');
    } else {
      showAlert(errMsg, 'warning');
    }
  }
});

// Explicit user gesture on "Listen"
btnMicListen.addEventListener('click', () => {
  if (mic.isListening) {
    mic.stop();
    micStatusTitle.textContent = 'Tap to Listen';
    micStatusSubtitle.textContent = 'Identifies any song playing from nearby speakers, radio, TV, or vinyl.';
    return;
  }

  // Clear any leftover blocked/error text immediately
  micStatusTitle.textContent = 'Tap to Listen';
  micStatusSubtitle.textContent = 'Identifies any song playing from nearby speakers, radio, TV, or vinyl.';
  micActionRow.innerHTML = `<button id="btnMicCancel" class="btn btn-sm btn-ghost" type="button">Cancel</button>`;
  document.getElementById('btnMicCancel')?.addEventListener('click', () => mic.stop());

  // If user hasn't seen the consent disclosure yet, show modal first
  if (!MicSource.hasConsent()) {
    micConsentBackdrop.classList.remove('hidden');
  } else {
    mic.start();
  }
});

// Cancel button while listening
btnMicCancel.addEventListener('click', () => {
  mic.stop();
  micStatusTitle.textContent = 'Tap to Listen';
  micStatusSubtitle.textContent = 'Listening canceled. Tap to try again.';
});

// Consent Modal Handlers
btnShowMicConsent.addEventListener('click', () => {
  micConsentBackdrop.classList.remove('hidden');
});

btnCloseMicConsent.addEventListener('click', () => {
  micConsentBackdrop.classList.add('hidden');
});

btnCancelMicConsent.addEventListener('click', () => {
  micConsentBackdrop.classList.add('hidden');
});

btnAcceptMicConsent.addEventListener('click', () => {
  MicSource.setConsent(true);
  micConsentBackdrop.classList.add('hidden');
  // Start recording immediately following the user tap
  mic.start();
});

micConsentBackdrop.addEventListener('click', (e) => {
  if (e.target === micConsentBackdrop) {
    micConsentBackdrop.classList.add('hidden');
  }
});

// Re-sync Button (Acoustic re-anchor / song change detection)
if (btnResync) {
  btnResync.addEventListener('click', async () => {
    haptic('light');
    closeMoreSheet();
    btnResync.classList.add('syncing');
    btnResync.disabled = true;
    showAlert('Re-listening to room audio to re-sync lyrics...', 'info');

    try {
      await mic.resync();
    } finally {
      setTimeout(() => {
        btnResync.classList.remove('syncing');
        btnResync.disabled = false;
      }, 1000);
    }
  });
}

// Auto Re-listen 2-Minute Toggle
let isAutoRelistenOn = localStorage.getItem('lyricwave_auto_relisten') === 'true';
function updateAutoRelistenUI(enabled) {
  isAutoRelistenOn = enabled;
  localStorage.setItem('lyricwave_auto_relisten', enabled.toString());
  mic.setAutoRelisten(enabled);

  if (autoRelistenLabel) autoRelistenLabel.textContent = enabled ? '2m Active' : 'Off';
  if (autoRelistenDot) {
    autoRelistenDot.classList.toggle('paused', !enabled);
  }
  if (btnToggleAutoRelisten) {
    btnToggleAutoRelisten.classList.toggle('active', enabled);
  }
}
updateAutoRelistenUI(isAutoRelistenOn);

if (btnToggleAutoRelisten) {
  btnToggleAutoRelisten.addEventListener('click', () => {
    updateAutoRelistenUI(!isAutoRelistenOn);
    showAlert(isAutoRelistenOn ? 'Auto re-listening enabled (checks room audio every 2 min).' : 'Auto re-listening turned off.', 'info');
  });
}

// Dismiss manual tap hint banner
if (btnDismissTapBanner) {
  btnDismissTapBanner.addEventListener('click', () => {
    if (tapLineBanner) tapLineBanner.classList.add('hidden');
  });
}

// =====================================================================
// Input Source 2: Manual Search (Direct LRCLIB & iTunes)
// =====================================================================

const searchSource = new SearchSource({
  onError: (errMsg) => {
    showAlert(errMsg, 'warning');
  },
  // Free music queue: move on when a song ends or its audio can't be played
  onEnded: ({ failed, track }) => {
    if (!track || !playQueue.isCurrent(track.id)) return;
    if (!playQueue.hasNext) {
      if (!failed) showAlert('That was the last song in the queue.', 'info');
      return;
    }
    playQueueItem(playQueue.next());
  }
});

searchInput.addEventListener('input', (e) => {
  const query = e.target.value.trim();
  btnClearSearch.classList.toggle('hidden', !query);

  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  if (!query) {
    searchRequestSeq++;
    searchResults.innerHTML = `
      <div class="search-prompt">
        <span class="search-prompt-icon" aria-hidden="true">${icon('search', 'lg')}</span>
        <p>Type any song name above to find synced lyrics directly on LRCLIB.</p>
      </div>
    `;
    return;
  }

  searchResults.innerHTML = `
    <div class="search-prompt" role="status">
      <div class="spinner" aria-hidden="true"></div>
      <p>Searching tracks on LRCLIB &amp; iTunes...</p>
    </div>
  `;

  const requestId = ++searchRequestSeq;
  searchDebounceTimer = setTimeout(async () => {
    try {
      const results = await searchTracks(query, 8);
      if (requestId !== searchRequestSeq) return; // a newer search superseded this one
      renderSearchResults(results);
    } catch (err) {
      if (requestId !== searchRequestSeq) return;
      searchResults.innerHTML = `
        <div class="search-prompt">
          <p>Search failed. Please check connection.</p>
        </div>
      `;
    }
  }, 350);
});

btnClearSearch.addEventListener('click', () => {
  searchRequestSeq++; // drop any in-flight results
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  searchInput.value = '';
  btnClearSearch.classList.add('hidden');
  searchResults.innerHTML = `
    <div class="search-prompt">
      <span class="search-prompt-icon" aria-hidden="true">${icon('search', 'lg')}</span>
      <p>Type any song name above to find synced lyrics directly on LRCLIB.</p>
    </div>
  `;
});

function renderSearchResults(tracks) {
  if (!tracks || tracks.length === 0) {
    searchResults.innerHTML = `
      <div class="search-prompt">
        <p>No tracks found with lyrics. Try another title or artist.</p>
      </div>
    `;
    return;
  }

  searchResults.innerHTML = '';
  const fragment = document.createDocumentFragment();

  tracks.forEach((track) => {
    const item = document.createElement('div');
    item.className = 'search-item';
    const cleanArt = sanitizeUrl(track.albumArt);
    item.innerHTML = `
      <img class="search-item-art" src="${cleanArt || 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22/>'}" alt="" width="48" height="48" loading="lazy" decoding="async">
      <div class="search-item-info">
        <div class="search-item-title">${escapeHtml(track.title)}</div>
        <div class="search-item-artist">${escapeHtml(track.artist)}</div>
        <div class="search-item-meta">${escapeHtml(track.album || '')} • ${formatMs(track.durationMs)}${track.hasSynced || track.syncedLyrics ? ' <span class="lyrics-badge lyrics-badge--sm synced">Synced</span>' : ''}</div>
      </div>
      <div class="search-item-action">
        <button class="btn-start-track" type="button" aria-label="Start lyrics playback for ${escapeHtml(track.title)}">
          ${icon('play', 'sm')}<span>Start</span>
        </button>
      </div>
    `;
    hideImageOnError(item.querySelector('img.search-item-art'));

    const startAction = () => {
      engine.connectSource(searchSource);
      searchSource.selectTrack(track, true);
    };

    item.addEventListener('click', (e) => {
      startAction();
    });

    const startBtn = item.querySelector('.btn-start-track');
    if (startBtn) {
      startBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        startAction();
      });
    }

    fragment.appendChild(item);
  });

  searchResults.appendChild(fragment);
}

// =====================================================================
// Shared UI helpers: thumbnails, chip scrollers, tablist keyboard support
// =====================================================================

function prefersReducedMotion() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Plain <img> (recent songs / search results): drop it from layout if the image fails to load. */
function hideImageOnError(img) {
  if (!img) return;
  img.addEventListener('error', () => img.classList.add('hidden'), { once: true });
}

/**
 * Markup for a cover/photo thumbnail. The <img> is lazy + sized (no layout shift); the wrapper starts in
 * the loading state (shimmer) and gets .is-loaded / .is-error from wireMediaThumbs().
 * Without a usable URL it renders straight in the error state so the fallback glyph shows.
 */
function mediaThumbHtml(url, variant, fallbackGlyph, width, height) {
  const clean = sanitizeUrl(url);
  const cls = `media-thumb media-thumb--${variant}`;
  const fallback = `<span class="media-thumb-fallback" aria-hidden="true">${fallbackGlyph}</span>`;
  if (!clean) return `<div class="${cls} is-error" aria-hidden="true">${fallback}</div>`;
  return `<div class="${cls}" aria-hidden="true"><img src="${escapeHtml(clean)}" alt="" width="${width}" height="${height}" loading="lazy" decoding="async">${fallback}</div>`;
}

/** Attach load/error listeners that drive the .is-loaded / .is-error thumbnail states. */
function wireMediaThumbs(root) {
  if (!root) return;
  root.querySelectorAll('.media-thumb').forEach((thumb) => {
    const img = thumb.querySelector('img');
    if (!img || thumb.classList.contains('is-error')) return;
    const markLoaded = () => { thumb.classList.remove('is-error'); thumb.classList.add('is-loaded'); };
    const markError = () => { thumb.classList.remove('is-loaded'); thumb.classList.add('is-error'); };
    img.addEventListener('load', markLoaded, { once: true });
    img.addEventListener('error', markError, { once: true });
    if (img.complete) {
      if (img.naturalWidth > 0) markLoaded();
      else markError();
    }
  });
}

/** Single-select chip group: updates .active + aria-pressed and centres the chosen chip in its scroller. */
function activateChip(chips, chip) {
  chips.forEach((c) => {
    const on = c === chip;
    c.classList.toggle('active', on);
    c.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  try {
    chip.scrollIntoView({ inline: 'center', block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  } catch {
    chip.scrollIntoView();
  }
}

/** Horizontal chip rows: flag whether more chips are hidden past either edge (drives the edge-fade mask). */
function initChipScrollers() {
  document.querySelectorAll('.chip-scroller').forEach((scroller) => {
    const row = scroller.querySelector('.chip-row');
    if (!row) return;
    const update = () => {
      const maxScroll = row.scrollWidth - row.clientWidth;
      const hasStart = row.scrollLeft > 2;
      const hasEnd = maxScroll > 2 && row.scrollLeft < maxScroll - 2;
      [scroller, row].forEach((el) => {
        el.classList.toggle('has-more-start', hasStart);
        el.classList.toggle('has-more-end', hasEnd);
      });
    };
    row.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update, { passive: true });
    // Panels start hidden (0 width); re-measure as soon as they become visible or fonts change sizes.
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(update).observe(row);
    update();
  });
}

/** Arrow / Home / End navigation for segmented controls and tab-like button groups. */
function enableTablistKeys(container) {
  if (!container) return;
  container.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const items = Array.from(container.querySelectorAll('[role="tab"]')).filter((b) => !b.classList.contains('hidden'));
    const index = items.indexOf(document.activeElement);
    if (index < 0) return;
    e.preventDefault();
    let next = index;
    if (e.key === 'ArrowRight') next = (index + 1) % items.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + items.length) % items.length;
    else if (e.key === 'Home') next = 0;
    else next = items.length - 1;
    items[next].focus();
    items[next].click();
  });
}

/** Loading / error / empty placeholders shared by the Discover lists. */
function loadingStateHtml(message) {
  return `
    <div class="charts-loading-state" role="status">
      <div class="spinner" aria-hidden="true"></div>
      <p>${escapeHtml(message)}</p>
    </div>
  `;
}

/** Empty / error state with one action button. `msgIcon` / `btnIcon` are optional sprite icon names. */
function stateWithActionHtml(message, buttonId, buttonLabel, role, msgIcon, btnIcon) {
  return `
    <div class="charts-empty-state"${role ? ` role="${role}"` : ''}>
      <p>${msgIcon ? `${icon(msgIcon, 'sm')} ` : ''}${escapeHtml(message)}</p>
      <button id="${buttonId}" class="btn btn-sm btn-ghost" type="button">${btnIcon ? `${icon(btnIcon, 'sm')} ` : ''}${escapeHtml(buttonLabel)}</button>
    </div>
  `;
}

// =====================================================================
// Genius-Themed Charts Section (Top Trending Songs)
// =====================================================================

let currentChartGenre = 'all';
let cachedChartData = null;
let isFetchingCharts = false;
let pendingChartGenre = null;

async function loadCharts(genre = 'all', forceRefresh = false) {
  if (!chartsListContainer) return;
  currentChartGenre = genre;
  if (isFetchingCharts) {
    // Don't drop a genre change made mid-load; reload once the current fetch finishes.
    pendingChartGenre = genre;
    return;
  }

  // Visual loading feedback
  if (btnRefreshCharts) {
    btnRefreshCharts.classList.add('loading');
  }

  chartsListContainer.setAttribute('aria-busy', 'true');
  chartsListContainer.innerHTML = loadingStateHtml('Loading hot chart songs...');

  const ITUNES_GENRES = {
    all: '',
    pop: '/genre=14',
    'hip-hop': '/genre=18',
    'r&b': '/genre=15',
    rock: '/genre=21',
    latin: '/genre=12',
    country: '/genre=6'
  };

  try {
    isFetchingCharts = true;

    // Strategy A: Direct client-side fetch to Apple Topsongs RSS (has CORS: *, 0 server latency, and unauthenticated permanent AAC audio streams)
    const genreSeg = ITUNES_GENRES[genre] || '';
    const directRes = await fetch(`https://itunes.apple.com/us/rss/topsongs/limit=25${genreSeg}/json`);
    if (directRes.ok) {
      const dData = await directRes.json();
      const entries = dData?.feed?.entry || [];
      if (entries.length > 0) {
        const clientSongs = entries.map((entry, index) => {
          const title = entry?.['im:name']?.label || 'Unknown Track';
          const artist = entry?.['im:artist']?.label || 'Unknown Artist';
          const album = entry?.['im:collection']?.['im:name']?.label || '';
          const images = entry?.['im:image'] || [];
          const rawArt = images.length > 0 ? images[images.length - 1]?.label || '' : '';
          const highResArt = rawArt.replace('170x170bb', '600x600bb');
          let previewUrl = null;
          const links = entry?.link || [];
          const linkList = Array.isArray(links) ? links : [links];
          for (const l of linkList) {
            const attrs = l?.attributes || {};
            if (attrs['im:assetType'] === 'preview' || attrs.rel === 'enclosure' || (attrs.type && attrs.type.includes('audio'))) {
              previewUrl = attrs.href || null;
              break;
            }
          }
          return {
            rank: index + 1,
            id: `chart_client_${index + 1}`,
            appleId: `${index + 1}`,
            title,
            artist,
            album,
            albumArt: highResArt || rawArt,
            previewUrl,
            durationMs: 30000,
            genre: genre === 'all' ? 'Hot' : genre.toUpperCase(),
            source: 'chart'
          };
        });

        if (chartsUpdatedTag) {
          chartsUpdatedTag.textContent = 'Live Today';
        }
        cachedChartData = { songs: clientSongs, genre };
        if (currentChartGenre === genre) renderCharts(clientSongs);
        return;
      }
    }
  } catch (directErr) {
    console.warn('Direct iTunes RSS client fetch error, falling back to /api/charts:', directErr);
  }

  // Strategy B: Backend Cloudflare Pages Function fallback (/api/charts)
  try {
    const query = new URLSearchParams({
      limit: '25',
      genre: genre,
      v: '3',
      _t: Date.now().toString()
    });

    const apiBase = (typeof CONFIG !== 'undefined' && CONFIG.API_BASE_URL) ? CONFIG.API_BASE_URL : '';
    const res = await fetch(`${apiBase}/api/charts?${query.toString()}`);
    if (!res.ok) {
      throw new Error(`Failed to load charts (HTTP ${res.status})`);
    }

    const data = await res.json();
    cachedChartData = data;

    if (chartsUpdatedTag && data.updated) {
      try {
        const d = new Date(data.updated);
        chartsUpdatedTag.textContent = `Updated ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      } catch {
        chartsUpdatedTag.textContent = 'Live Today';
      }
    }

    if (currentChartGenre === genre) renderCharts(data.songs || []);
  } catch (err) {
    console.warn('Charts backend load error:', err);

    chartsListContainer.innerHTML = stateWithActionHtml('Unable to load charts right now.', 'btnRetryCharts', 'Try Again', 'alert', 'alert', 'refresh');
    const btnRetry = document.getElementById('btnRetryCharts');
    if (btnRetry) {
      btnRetry.addEventListener('click', () => loadCharts(genre, true));
    }
  } finally {
    isFetchingCharts = false;
    chartsListContainer.removeAttribute('aria-busy');
    if (btnRefreshCharts) {
      btnRefreshCharts.classList.remove('loading');
    }
    if (pendingChartGenre !== null) {
      const next = pendingChartGenre;
      pendingChartGenre = null;
      if (next !== genre) loadCharts(next);
    }
  }
}

function renderCharts(songs) {
  if (!chartsListContainer) return;

  if (!songs || songs.length === 0) {
    const filtered = currentChartGenre !== 'all';
    chartsListContainer.innerHTML = stateWithActionHtml(
      filtered ? 'No tracks found for this genre. Check back shortly!' : 'No chart tracks right now. Check back shortly!',
      'btnChartsEmptyAction',
      filtered ? 'Show all genres' : 'Refresh',
      undefined,
      undefined,
      filtered ? undefined : 'refresh'
    );
    document.getElementById('btnChartsEmptyAction')?.addEventListener('click', () => {
      if (filtered) {
        const allChip = Array.from(genrePills).find((c) => (c.dataset.genre || 'all') === 'all');
        if (allChip) activateChip(genrePills, allChip);
        loadCharts('all');
      } else {
        loadCharts(currentChartGenre, true);
      }
    });
    return;
  }

  chartsListContainer.innerHTML = '';
  const fragment = document.createDocumentFragment();

  songs.forEach((song, idx) => {
    const card = document.createElement('div');
    const rank = song.rank || (idx + 1);
    card.className = `chart-song-card rank-${rank <= 3 ? rank : 'other'}`;

    const showGenreTag = Boolean(song.genre) && song.genre !== 'Hot';
    const tagRow = (showGenreTag || rank <= 5)
      ? `<div class="chart-song-tag-row">
          ${showGenreTag ? `<span class="chart-genre-tag">${escapeHtml(song.genre)}</span>` : ''}
          ${rank <= 5 ? `<span class="chart-fire-tag">${icon('flame', 'sm')} Trending</span>` : ''}
        </div>`
      : '';

    card.innerHTML = `
      <div class="chart-rank-number">#${rank}</div>
      ${mediaThumbHtml(song.albumArt, 'chart', icon('music'), 48, 48)}
      <div class="chart-song-meta">
        <div class="chart-song-title" title="${escapeHtml(song.title)}">${escapeHtml(song.title)}</div>
        <div class="chart-song-artist" title="${escapeHtml(song.artist)}">${escapeHtml(song.artist)}</div>
        ${tagRow}
      </div>
      <div class="chart-song-action">
        <button class="btn-chart-play btn-chart-play--icon" type="button" aria-label="Play synced lyrics for #${rank}: ${escapeHtml(song.title)} by ${escapeHtml(song.artist)}">
          ${icon('play', 'sm')}
          <span class="btn-label">Play</span>
        </button>
      </div>
    `;
    wireMediaThumbs(card);

    const startChartPlayback = () => {
      // Connect searchSource & select this track to launch unified synced lyrics with speaker audio
      engine.connectSource(searchSource);
      searchSource.selectTrack({
        id: song.id || `chart_${song.appleId || idx}`,
        title: song.title,
        artist: song.artist,
        album: song.album || '',
        albumArt: song.albumArt || '',
        previewUrl: song.previewUrl || null,
        durationMs: song.durationMs || 30000,
        // Chart feeds only carry the 30s preview length; the real length comes from LRCLIB.
        durationEstimated: true,
        source: 'chart'
      }, true);
      showAlert(`Lyrics for #${rank}: "${song.title}"`, 'success');
    };

    // Pointer users can tap anywhere on the row; keyboard / screen-reader users use the Play button
    // (one tab stop per row, no nested interactive controls).
    card.addEventListener('click', startChartPlayback);

    const playBtn = card.querySelector('.btn-chart-play');
    if (playBtn) {
      playBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        startChartPlayback();
      });
    }

    fragment.appendChild(card);
  });

  chartsListContainer.appendChild(fragment);
}

// Genre filter pills click listener
if (genrePills && genrePills.length > 0) {
  genrePills.forEach((pill) => {
    pill.addEventListener('click', () => {
      activateChip(genrePills, pill);
      const genre = pill.dataset.genre || 'all';
      loadCharts(genre);
    });
  });
}

// Refresh button listener
if (btnRefreshCharts) {
  btnRefreshCharts.addEventListener('click', () => {
    loadCharts(currentChartGenre, true);
  });
}

// =====================================================================
// Genius-Themed Music News Section (Rolling Stone & NME)
// =====================================================================

let currentNewsSource = 'all';
let cachedNewsData = null;
let isFetchingNews = false;

async function loadNews(sourceFilter = 'all', forceRefresh = false) {
  if (!newsListContainer) return;
  if (isFetchingNews) return;

  currentNewsSource = sourceFilter;

  if (btnRefreshNews) {
    btnRefreshNews.classList.add('loading');
  }

  newsListContainer.setAttribute('aria-busy', 'true');
  newsListContainer.innerHTML = loadingStateHtml('Loading fresh music headlines...');

  try {
    isFetchingNews = true;
    const query = new URLSearchParams({
      limit: '20'
    });
    if (forceRefresh) {
      query.set('t', Date.now().toString());
    }

    const apiBase = (typeof CONFIG !== 'undefined' && CONFIG.API_BASE_URL) ? CONFIG.API_BASE_URL : '';
    const res = await fetch(`${apiBase}/api/news?${query.toString()}`);
    if (!res.ok) {
      throw new Error(`Failed to load news (HTTP ${res.status})`);
    }

    const data = await res.json();
    cachedNewsData = data;

    if (newsUpdatedTag && data.updated) {
      try {
        const d = new Date(data.updated);
        newsUpdatedTag.textContent = `Updated ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      } catch {
        newsUpdatedTag.textContent = 'Live Today';
      }
    }

    renderNews(data.articles || [], sourceFilter);
  } catch (err) {
    console.warn('News load error:', err);
    newsListContainer.innerHTML = stateWithActionHtml('Unable to load music news right now.', 'btnRetryNews', 'Try Again', 'alert', 'alert', 'refresh');
    const btnRetry = document.getElementById('btnRetryNews');
    if (btnRetry) {
      btnRetry.addEventListener('click', () => loadNews(sourceFilter, true));
    }
  } finally {
    isFetchingNews = false;
    newsListContainer.removeAttribute('aria-busy');
    if (btnRefreshNews) {
      btnRefreshNews.classList.remove('loading');
    }
  }
}

function renderNews(articles, sourceFilter = 'all') {
  if (!newsListContainer) return;

  let filtered = articles;
  if (sourceFilter !== 'all') {
    const sLow = sourceFilter.toLowerCase();
    filtered = articles.filter(a => {
      const src = (a.source || '').toLowerCase().replace(/\s+/g, '-');
      return src.includes(sLow);
    });
  }

  if (!filtered || filtered.length === 0) {
    const narrowed = sourceFilter !== 'all';
    newsListContainer.innerHTML = stateWithActionHtml(
      narrowed ? 'No headlines found for this publication. Check back soon!' : 'No headlines right now. Check back soon!',
      'btnNewsEmptyAction',
      narrowed ? 'Show all stories' : 'Refresh',
      undefined,
      undefined,
      narrowed ? undefined : 'refresh'
    );
    document.getElementById('btnNewsEmptyAction')?.addEventListener('click', () => {
      if (narrowed) {
        const allChip = Array.from(newsFilterPills).find((c) => (c.dataset.source || 'all') === 'all');
        if (allChip) activateChip(newsFilterPills, allChip);
        currentNewsSource = 'all';
        renderNews(articles, 'all');
      } else {
        loadNews(currentNewsSource, true);
      }
    });
    return;
  }

  newsListContainer.innerHTML = '';
  const fragment = document.createDocumentFragment();

  filtered.forEach((article) => {
    const card = document.createElement('a');
    const cleanImg = sanitizeUrl(article.imageUrl);
    card.className = cleanImg ? 'news-article-card' : 'news-article-card no-image';
    card.href = /^https?:\/\//i.test(article.link || '') ? article.link : '#';
    card.target = '_blank';
    card.rel = 'noopener noreferrer';
    card.setAttribute('aria-label', `${article.title} - ${article.source}`);

    let timeAgo = '';
    if (article.pubDate) {
      try {
        const d = new Date(article.pubDate);
        timeAgo = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
      } catch {}
    }

    card.innerHTML = `
      ${cleanImg ? mediaThumbHtml(cleanImg, 'news', icon('newspaper'), 96, 60) : ''}
      <div class="news-article-content">
        <div>
          <div class="news-article-badge-row">
            <span class="news-source-tag">${escapeHtml(article.source || 'News')}</span>
            ${timeAgo ? `<span class="news-time-tag">• ${escapeHtml(timeAgo)}</span>` : ''}
          </div>
          <div class="news-article-title">${escapeHtml(article.title)}</div>
        </div>
        ${article.excerpt ? `<p class="news-article-excerpt">${escapeHtml(article.excerpt)}</p>` : ''}
      </div>
    `;

    wireMediaThumbs(card);
    fragment.appendChild(card);
  });

  newsListContainer.appendChild(fragment);
}

// News source filter pills click listener
if (newsFilterPills && newsFilterPills.length > 0) {
  newsFilterPills.forEach((pill) => {
    pill.addEventListener('click', () => {
      activateChip(newsFilterPills, pill);
      const src = pill.dataset.source || 'all';
      currentNewsSource = src;
      if (cachedNewsData && cachedNewsData.articles) {
        renderNews(cachedNewsData.articles, src);
      } else {
        loadNews(src);
      }
    });
  });
}

// News refresh button listener
if (btnRefreshNews) {
  btnRefreshNews.addEventListener('click', () => {
    loadNews(currentNewsSource, true);
  });
}

initChipScrollers();

// =====================================================================
// Input Source 3: Last.fm Live Scrobble (Approximate Mode)
// =====================================================================

const lastfm = new LastFmSource({
  apiKey: CONFIG.LASTFM_API_KEY || undefined,
  pollInterval: 4000,
  onError: (errMsg) => {
    lastfmStatusInfo.classList.remove('hidden');
    lastfmStatusMsg.textContent = errMsg;
    showAlert(errMsg, 'warning');
  }
});

btnConnectLastfm.addEventListener('click', () => {
  const user = lastfmUserInput.value.trim();
  if (!user) {
    showAlert('Please enter your Last.fm username.', 'warning');
    return;
  }
  try {
    lastfm.setUsername(user);
    engine.connectSource(lastfm);
    lastfmStatusInfo.classList.remove('hidden');
    lastfmStatusMsg.textContent = `Polling @${user} scrobbles every 4s...`;
    showAlert(`Connecting to Last.fm as @${user} in Approximate Mode.`, 'info');
  } catch (err) {
    showAlert(err.message, 'warning');
  }
});

if (btnDisconnectLastfm) {
  btnDisconnectLastfm.addEventListener('click', () => {
    lastfm.stop();
    lastfmStatusInfo.classList.add('hidden');
    showAlert('Disconnected from Last.fm.', 'info');
  });
}

// Restore previous Last.fm username if stored
const savedLastFm = lastfm.getUsername();
if (savedLastFm) {
  lastfmUserInput.value = savedLastFm;
}

// =====================================================================
// Input Source 5: Media sessions — Android app ("Phone") and desktop app ("This PC")
// Follows Spotify / YouTube Music / Apple Music etc. playing on this device.
// On desktop the OS media sessions are read by desktop/now-playing.cjs (Windows SMTC,
// macOS Spotify/Music, Linux MPRIS) through the same bridge contract.
// =====================================================================

const tabPhone = document.getElementById('tabPhone');
const phoneOnboarding = document.getElementById('phoneOnboarding');
const phoneStatusView = document.getElementById('phoneStatusView');
const phoneStatusTitle = document.getElementById('phoneStatusTitle');
const phoneStatusText = document.getElementById('phoneStatusText');
const phoneStatusDot = document.getElementById('phoneStatusDot');
const phoneRestrictedHint = document.getElementById('phoneRestrictedHint');
const PHONE_AVAILABLE = (IS_NATIVE_APP || IS_DESKTOP_APP) && PhoneMediaSource.isAvailable();
let phoneGrantRequested = false;

const phoneSource = new PhoneMediaSource({
  onStatus: (st) => updatePhoneStatus(st),
  onError: (msg) => showAlert(String(msg), 'warning')
});

function updatePhoneStatus(st = {}) {
  if (!phoneStatusTitle) return;
  if (st.active) {
    const app = st.appName || 'your music app';
    phoneStatusTitle.textContent = st.isPlaying ? `Following ${app}` : `${app} is paused`;
    phoneStatusText.textContent = `${st.title}${st.artist ? ' · ' + st.artist : ''}`;
    phoneStatusDot?.classList.toggle('paused', !st.isPlaying);
  } else {
    phoneStatusTitle.textContent = 'Waiting for music…';
    phoneStatusText.textContent = IS_DESKTOP_APP
      ? 'Play a song in Spotify, Apple Music, a browser or any media player.'
      : 'Play a song in any music app.';
    phoneStatusDot?.classList.add('paused');
  }
}

/** Show onboarding or status depending on access, and (dis)connect the source. */
function refreshPhonePanel() {
  if (!PHONE_AVAILABLE) return;
  const granted = phoneSource.hasAccess();
  phoneOnboarding?.classList.toggle('hidden', granted);
  phoneStatusView?.classList.toggle('hidden', !granted);
  if (granted) phoneRestrictedHint?.classList.add('hidden');
  if (activeTab !== 'phone') return;
  if (granted && engine.currentSource !== phoneSource) {
    engine.connectSource(phoneSource);
  } else if (!granted && engine.currentSource === phoneSource) {
    engine.connectSource(null);
  }
}

/** Desktop wording for the shared Phone panel: no Android permission involved. */
function adaptPhonePanelForDesktop() {
  const label = tabPhone?.querySelector('.tab-label');
  if (label) label.textContent = 'This PC';
  tabPhone?.querySelector('use')?.setAttribute('href', '#i-monitor');
  document.getElementById('panelPhone')?.setAttribute('aria-label', 'Music playing on this computer');
  const desc = phoneOnboarding?.querySelector('.lastfm-desc');
  if (desc) {
    desc.textContent = window.LyricWaveDesktop?.platform === 'linux'
      ? 'LyricWave follows desktop players through MPRIS. Install "playerctl" (e.g. sudo apt install playerctl), then come back to this tab.'
      : 'LyricWave could not read the media sessions of this computer.';
  }
  phoneOnboarding?.querySelector('.bullet-list')?.classList.add('hidden');
  document.getElementById('btnPhoneGrant')?.classList.add('hidden');
  const hint = phoneStatusView?.querySelector('.lastfm-desc');
  if (hint) {
    hint.textContent = 'Follows Spotify, Apple Music, YouTube or any player that shows up in your system media controls, with its exact position. Nothing is recorded.';
  }
}

if (PHONE_AVAILABLE) {
  tabPhone?.classList.remove('hidden');
  if (IS_DESKTOP_APP) {
    adaptPhonePanelForDesktop();
    // The first snapshot arrives asynchronously from the main process; re-check access then.
    setTimeout(refreshPhonePanel, 1500);
  }

  document.getElementById('btnPhoneGrant')?.addEventListener('click', () => {
    phoneGrantRequested = true;
    phoneSource.openAccessSettings();
  });
  document.getElementById('btnPhoneUseMic')?.addEventListener('click', () => {
    document.getElementById('tabMic')?.click();
  });

  // Coming back from Android settings: pick up a newly granted (or revoked) permission.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (phoneGrantRequested && !phoneSource.hasAccess()) {
      // Sideloaded builds on Android 13+ may block the toggle as a "restricted setting".
      phoneRestrictedHint?.classList.remove('hidden');
    }
    if (phoneGrantRequested && phoneSource.hasAccess()) {
      phoneGrantRequested = false;
      showAlert('Notification access is on. Play a song in any music app.', 'success');
    }
    refreshPhonePanel();
  });
}

// =====================================================================
// Input Source 4: Spotify Live Tracking (Private Beta)
// =====================================================================

const spotifySource = new SpotifySource({
  pollInterval: 3000,
  onError: (err) => {
    if (err.message.includes('expired') || err.message.includes('authenticated')) {
      spotifySource.stop();
      logout();
      showSpotifyLoggedOut();
      showAlert('Spotify session expired. Please reconnect.', 'warning');
    }
  }
});

function showSpotifyLoggedIn(profile) {
  spotifyLoggedOut.classList.add('hidden');
  spotifyLoggedIn.classList.remove('hidden');

  const name = profile?.display_name || profile?.id || 'Spotify User';
  userName.textContent = name;

  if (profile?.images && profile.images.length > 0) {
    userAvatar.src = profile.images[0].url;
    userAvatar.classList.remove('hidden');
    avatarFallback.classList.add('hidden');
  } else {
    userAvatar.classList.add('hidden');
    avatarFallback.textContent = name.charAt(0).toUpperCase();
    avatarFallback.classList.remove('hidden');
  }

  // Connect spotifySource to the unified sync engine
  engine.connectSource(spotifySource);
}

function showSpotifyLoggedOut() {
  spotifySource.stop();
  spotifyLoggedIn.classList.add('hidden');
  spotifyLoggedOut.classList.remove('hidden');
}

btnLoginSpotify.addEventListener('click', async () => {
  try {
    btnLoginSpotify.disabled = true;
    btnLoginSpotify.innerHTML = '<div class="spinner"></div><span>Connecting...</span>';
    await initiateLogin();
    if (IS_NATIVE_APP) {
      // Login continues in a Custom Tab; if the user backs out, the button must work again.
      setTimeout(() => {
        btnLoginSpotify.disabled = false;
        btnLoginSpotify.innerHTML = '<span>Connect Spotify</span>';
      }, 1500);
    }
  } catch (err) {
    btnLoginSpotify.disabled = false;
    btnLoginSpotify.innerHTML = '<span>Connect Spotify</span>';
    showAlert(err.message, 'danger');
  }
});

btnLogoutSpotify.addEventListener('click', () => {
  spotifySource.stop();
  logout();
  showSpotifyLoggedOut();
});

// =====================================================================
// Navigation Tab Switching
// =====================================================================

// Sub-tab state for Connect panel ('lastfm' or 'spotify'). The removed 'apple' sub-tab (and any
// other stale value) falls back to Last.fm.
const storedConnectSubTab = localStorage.getItem('lyricwave_connect_subtab');
let activeConnectSubTab = storedConnectSubTab === 'spotify' ? 'spotify' : 'lastfm';
if (storedConnectSubTab !== null && storedConnectSubTab !== activeConnectSubTab) {
  localStorage.setItem('lyricwave_connect_subtab', activeConnectSubTab);
}

function switchConnectSubTab(subTab) {
  if (subTab !== 'spotify') subTab = 'lastfm';
  activeConnectSubTab = subTab;
  localStorage.setItem('lyricwave_connect_subtab', subTab);

  if (btnSubLastfm) {
    const isLastfm = subTab === 'lastfm';
    btnSubLastfm.classList.toggle('active', isLastfm);
    btnSubLastfm.setAttribute('aria-selected', isLastfm ? 'true' : 'false');
  }
  if (btnSubSpotify) {
    const isSpotify = subTab === 'spotify';
    btnSubSpotify.classList.toggle('active', isSpotify);
    btnSubSpotify.setAttribute('aria-selected', isSpotify ? 'true' : 'false');
  }

  if (subPanels.lastfm) subPanels.lastfm.classList.toggle('hidden', subTab !== 'lastfm');
  if (subPanels.spotify) subPanels.spotify.classList.toggle('hidden', subTab !== 'spotify');

  // Tear down opposite source
  if (subTab === 'lastfm') {
    if (spotifySource.isRunning) spotifySource.stop();
    if (lastfm.getUsername()) engine.connectSource(lastfm);
    engine.loadOffsetForSource('lastfm');
  } else if (subTab === 'spotify') {
    if (lastfm.isRunning) lastfm.stop();
    if (isAuthenticated()) engine.connectSource(spotifySource);
    engine.loadOffsetForSource('spotify');
  }
  updateOffsetUI();
}

if (btnSubLastfm) {
  btnSubLastfm.addEventListener('click', () => switchConnectSubTab('lastfm'));
}
if (btnSubSpotify) {
  btnSubSpotify.addEventListener('click', () => switchConnectSubTab('spotify'));
}

// Discover = Charts | News | Library. All views live under the single "Discover" nav item (#tabCharts);
// #tabNews and #tabLibrary stay in the DOM (hidden) so persisted tabs and programmatic clicks keep working.
const discoverButtons = document.querySelectorAll('.segmented[data-segmented="discover"] .segmented-btn');
const DISCOVER_VIEWS = ['charts', 'news', 'library'];

function getDiscoverView() {
  try {
    const saved = localStorage.getItem(STORAGE_DISCOVER_VIEW_KEY);
    return DISCOVER_VIEWS.includes(saved) ? saved : 'charts';
  } catch {
    return 'charts';
  }
}

// Playlists of Free music songs (Library > Playlists, and the Add to playlist dialog)
const playlistStore = new PlaylistStore();
const libraryHelpers = { escapeHtml, icon, mediaThumbHtml, wireMediaThumbs };
const playlistPickerBackdrop = document.getElementById('playlistPickerBackdrop');
const playlistPicker = playlistPickerBackdrop ? new PlaylistPicker({
  backdrop: playlistPickerBackdrop,
  store: playlistStore,
  collector: libraryCollector,
  notify: (msg, type) => showAlert(msg, type),
  onChange: () => libraryView?.refresh(),
  onClose: () => {
    const back = playlistPickerReturnFocus;
    playlistPickerReturnFocus = null;
    if (back?.isConnected) back.focus({ preventScroll: true });
  }
}) : null;
let playlistPickerReturnFocus = null;
playlistPickerBackdrop?.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') trapFocus(playlistPickerBackdrop, e);
});

libraryView = new LibraryView({
  container: document.getElementById('libraryListContainer'),
  filterInput: document.getElementById('libraryFilter'),
  modeChips: document.querySelectorAll('.library-mode-bar .chip'),
  countTag: document.getElementById('libraryCountTag'),
  collector: libraryCollector,
  helpers: { escapeHtml, icon, mediaThumbHtml, wireMediaThumbs },
  openverse: new OpenverseClient(),
  commercialToggle: document.getElementById('libraryCommercialOnly'),
  subtitle: document.getElementById('librarySubtitle'),
  notify: (msg, type) => showAlert(msg, type),
  playlists: new PlaylistsView({
    container: document.getElementById('libraryListContainer'),
    store: playlistStore,
    collector: libraryCollector,
    helpers: libraryHelpers,
    notify: (msg, type) => showAlert(msg, type),
    onPlay: (row, queue) => libraryView?.onPlay(row, queue)
  }),
  onAddToPlaylist: (item) => {
    playlistPickerReturnFocus = document.activeElement;
    playlistPicker?.open(item);
  },
  // Similar artists that aren't in the library open Search, pre-filled with their name
  onSearch: (query) => {
    document.getElementById('tabSearch')?.click();
    if (searchInput && query) {
      searchInput.value = query;
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      searchInput.focus({ preventScroll: true });
    }
  },
  onPlay: (row, queue) => {
    engine.connectSource(searchSource);
    // Free music (saved row or search result): play the full openly licensed audio file, and
    // queue the rest of the list it was played from.
    if (row.openTrack && queue?.items?.length) {
      playQueueItem(playQueue.setItems(queue.items, queue.index, { label: queue.label }));
      return;
    }
    const open = row.openTrack ? playableOpenTrack(row) : null;
    if (open) {
      playQueue.clear();
      searchSource.selectTrack(open, true);
      return;
    }
    searchSource.selectTrack({
      id: `library_${row.id}`,
      title: row.title,
      artist: row.artist,
      album: row.album || '',
      albumArt: row.sourceArt || rowArtUrl(row),
      durationMs: row.durationSec > 0 ? row.durationSec * 1000 : 180000,
      durationEstimated: !(row.durationSec > 0),
      lrclibId: row.lrclibId || null,
      mbid: row.mbid || null,
      isrc: row.isrc || null,
      source: 'library'
    }, true);
  }
});

function setDiscoverView(view) {
  try { localStorage.setItem(STORAGE_DISCOVER_VIEW_KEY, view); } catch {}
  discoverButtons.forEach((btn) => {
    const on = btn.dataset.discover === view;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  });
}

setDiscoverView(getDiscoverView());

function activateTab(targetTab) {
  activeTab = targetTab;
  localStorage.setItem(STORAGE_LAST_SOURCE_KEY, targetTab);
  if (DISCOVER_VIEWS.includes(targetTab)) setDiscoverView(targetTab);
  if (targetTab === 'library') libraryView?.show();
  else libraryView?.hide();

  // News and Library are views inside the Discover nav item, so Discover is the highlighted nav tab for all three.
  const navTarget = DISCOVER_VIEWS.includes(targetTab) ? 'charts' : targetTab;
  sourceTabs.forEach(t => {
    const isCurrent = t.dataset.tab === navTarget;
    t.classList.toggle('active', isCurrent);
    t.setAttribute('aria-selected', isCurrent ? 'true' : 'false');
  });

  // While the stage is open the tab panels stay hidden underneath it; collapsing the stage shows them again.
  if (stageOpen) {
    Object.values(tabPanels).forEach((el) => el?.classList.add('hidden'));
  } else {
    Object.keys(tabPanels).forEach(key => {
      if (tabPanels[key]) {
        tabPanels[key].classList.toggle('hidden', key !== targetTab);
      }
    });
  }

  // Browsing (Listen / Search / Discover) must not end the song shown in the mini player: the source that
  // owns the live track keeps running. Phone and Connect tabs deliberately hand over to their own source.
  const browsing = ['mic', 'search', 'charts', 'news', 'library'].includes(targetTab);
  const keepLive = Boolean(engine.track) && browsing;
  const liveOwner = keepLive ? engine.currentSource : null;

  // Tear down previous sources
  if (targetTab !== 'mic') {
    // Also cancels a pending upload and the auto re-listen timer.
    mic.stop();
  }
  if (targetTab !== 'connect' && targetTab !== 'spotify' && spotifySource.isRunning && liveOwner !== spotifySource) {
    spotifySource.stop();
  }
  if (targetTab !== 'connect' && targetTab !== 'lastfm' && lastfm.isRunning && liveOwner !== lastfm) {
    lastfm.stop();
  }
  if (targetTab !== 'search' && searchSource.isPlaying && liveOwner !== searchSource) {
    searchSource.stop();
  }
  if (targetTab !== 'phone' && phoneSource.isRunning && liveOwner !== phoneSource) {
    phoneSource.stop();
  }

  // Connect appropriate active source
  if (targetTab === 'phone') {
    engine.loadOffsetForSource('phone');
    updateOffsetUI();
    refreshPhonePanel();
  } else if (targetTab === 'connect') {
    if (panelConnect) panelConnect.classList.remove('hidden');
    switchConnectSubTab(activeConnectSubTab);
  } else if (targetTab === 'spotify') {
    // Legacy compatibility if tabSpotify is clicked directly
    if (isAuthenticated()) engine.connectSource(spotifySource);
    engine.loadOffsetForSource('spotify');
    updateOffsetUI();
  } else if (targetTab === 'lastfm') {
    // Legacy compatibility if tabLastfm is clicked directly
    if (lastfm.getUsername()) engine.connectSource(lastfm);
    engine.loadOffsetForSource('lastfm');
    updateOffsetUI();
  } else if (targetTab === 'search') {
    // Every "play" action connects searchSource itself, so a live track on another source is left alone.
    if (!keepLive) {
      engine.connectSource(searchSource);
      engine.loadOffsetForSource('search');
      updateOffsetUI();
    }
  } else if (targetTab === 'charts') {
    if (!keepLive) {
      engine.connectSource(searchSource);
      engine.loadOffsetForSource('search');
      updateOffsetUI();
    }
    if (!cachedChartData) {
      loadCharts(currentChartGenre);
    }
  } else if (targetTab === 'news') {
    if (!keepLive) {
      engine.connectSource(searchSource);
      engine.loadOffsetForSource('search');
      updateOffsetUI();
    }
    if (!cachedNewsData) {
      loadNews(currentNewsSource);
    }
  } else if (targetTab === 'library') {
    if (!keepLive) {
      engine.connectSource(searchSource);
      engine.loadOffsetForSource('search');
      updateOffsetUI();
    }
  } else if (targetTab === 'mic') {
    if (!keepLive) {
      engine.connectSource(null);
      engine.loadOffsetForSource('mic');
      updateOffsetUI();
    }
  }
}

sourceTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    let targetTab = tab.dataset.tab;
    // Tapping the Discover nav item resumes the Discover view you last used (Charts, News or Library).
    if (tab === tabCharts) targetTab = getDiscoverView();
    activateTab(targetTab);
  });
});

discoverButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    const view = DISCOVER_VIEWS.includes(btn.dataset.discover) ? btn.dataset.discover : 'charts';
    if (activeTab !== view) activateTab(view);
  });
});

document.querySelectorAll('.segmented[role="tablist"]').forEach(enableTablistKeys);

// "Listen again" (More sheet): collapse the stage, go to the Listen tab and start the microphone immediately.
if (btnListenAgain) {
  btnListenAgain.addEventListener('click', () => {
    haptic('light');
    closeStage({ restoreFocus: false }); // also closes the sheet
    const micTab = document.getElementById('tabMic');
    if (micTab) micTab.click();
    if (!mic.isListening) {
      if (!MicSource.hasConsent()) {
        micConsentBackdrop?.classList.remove('hidden');
      } else {
        mic.start();
      }
    }
  });
}

// Restore saved source tab on launch. In the Android app, first launch opens the Phone
// tab (follows the user's music app); the Phone tab never shows on the website.
if (activeTab === 'phone' && !PHONE_AVAILABLE) activeTab = 'mic';
if (PHONE_AVAILABLE && localStorage.getItem(STORAGE_LAST_SOURCE_KEY) === null) activeTab = 'phone';
if (activeTab && activeTab !== 'mic') {
  const savedTabBtn = document.querySelector(`.source-tab[data-tab="${activeTab}"]`);
  if (savedTabBtn) {
    savedTabBtn.click();
  }
} else {
  engine.loadOffsetForSource('mic');
  updateOffsetUI();
}

// "Use Spotify Beta" buttons on coming soon panels
document.querySelectorAll('[data-switch-to="spotify"]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const connectTab = document.getElementById('tabConnect');
    if (connectTab) {
      connectTab.click();
      switchConnectSubTab('spotify');
    }
  });
});

// =====================================================================
// Shared Player Scrubber & Controls
// =====================================================================

btnPlayPause.addEventListener('click', () => {
  engine.togglePlay();
});

// Light haptic tick on every dock button (play/pause, seek, nudge, more)
document.querySelector('.control-dock')?.addEventListener('click', (e) => {
  if (e.target.closest('.dock-btn')) haptic('light');
});

btnSeekBack.addEventListener('click', () => {
  engine.seekBy(-5);
});

btnSeekForward.addEventListener('click', () => {
  engine.seekBy(5);
});

progressTrack.addEventListener('click', (e) => {
  const rect = progressTrack.getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  const ratio = Math.max(0, Math.min(1, clickX / rect.width));
  const targetMs = ratio * (engine.durationMs || engine.durationSec * 1000);
  engine.seekMs(targetMs);
});

progressTrack.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    engine.seekBy(-5);
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    engine.seekBy(5);
  } else if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault();
    engine.togglePlay();
  }
});

// =====================================================================
// Lyrics & OLED Reel Display Rendering
// =====================================================================

/** Lyrics status badge text with a sprite icon in front. */
function setLyricsStatus(iconName, text) {
  lyricsStatusText.innerHTML = `${icon(iconName, 'sm')} ${escapeHtml(text)}`;
}

/**
 * One line under the lyrics saying where they come from and what rights they carry (LRCLIB
 * community lyrics, or the user's own), with a button to add or edit the user's lyrics.
 */
function renderLyricsCredit(lyrics) {
  if (!lyricsCredit) return;
  const status = lyrics?.status;
  if (!engine.track || !status || status === 'loading') {
    lyricsCredit.classList.add('hidden');
    return;
  }
  const rights = lyrics.rights;
  if (lyricsCreditText) {
    lyricsCreditText.textContent = rights?.credit || '';
    lyricsCreditText.title = rights?.label ? `${rights.label}${rights.license && rights.license !== rights.label ? ` (${rights.license})` : ''}` : '';
  }
  if (btnLyricsCreditEdit) btnLyricsCreditEdit.textContent = rights?.source === 'user' ? 'Edit your lyrics' : 'Add your lyrics';
  lyricsCredit.classList.remove('hidden');
}

function renderLyricsState(lyrics) {
  renderLyricsCredit(lyrics);
  lineElements = [];
  reelWordElements = [];
  reelWordStates = [];
  lyricsContent.innerHTML = '';
  lyricsStatusBadge.className = 'lyrics-badge';

  if (!lyrics || lyrics.status === 'loading') {
    lyricsStatusText.textContent = 'Searching lyrics...';
    lyricsContent.innerHTML = `
      <div class="lyrics-skeleton-container" aria-label="Loading lyrics" role="status">
        <div class="skeleton-line" style="width: 78%;"></div>
        <div class="skeleton-line" style="width: 92%;"></div>
        <div class="skeleton-line" style="width: 65%;"></div>
        <div class="skeleton-line" style="width: 84%;"></div>
        <div class="skeleton-line" style="width: 70%;"></div>
      </div>
    `;
    reelLineText.innerHTML = '<span class="reel-placeholder-text">Searching lyrics...</span>';
    reelPrevLine.textContent = '';
    reelNextLine.textContent = '';
    return;
  }

  if (lyrics.status === 'synced' && lyrics.syncedLines.length > 0) {
    lyricsStatusBadge.classList.add('synced');
    setLyricsStatus('sparkles', 'Synced Lyrics');

    // If no offset was returned by provider, show "Tap the line you're hearing" banner
    if (tapLineBanner) {
      if (engine.track && engine.track.hasOffset === false) {
        tapLineBanner.classList.remove('hidden');
      } else {
        tapLineBanner.classList.add('hidden');
      }
    }

    const fragment = document.createDocumentFragment();
    lyrics.syncedLines.forEach((line, index) => {
      const el = document.createElement('div');
      el.className = 'lyric-line upcoming-line';
      el.id = `line-${index}`;
      const orig = line.text || '♪';
      const converted = currentTranslations[index] || '';
      const mainText = converted || orig;
      const subText = converted ? orig : '';
      el.textContent = mainText;
      if (subText) {
        const sub = document.createElement('span');
        sub.className = 'lyric-translation';
        sub.lang = translateLang;
        sub.textContent = subText;
        el.appendChild(sub);
      }

      // Tapping a line performs non-destructive sync alignment (seeks playback without clearing state)
      el.addEventListener('click', () => {
        engine.seekMs(line.timeMs);
        if (tapLineBanner) tapLineBanner.classList.add('hidden');
      });

      fragment.appendChild(el);
      lineElements.push(el);
    });
    lyricsContent.appendChild(fragment);

    reelLineText.innerHTML = '<span class="reel-placeholder-text">♫ Waiting for music...</span>';
    reelPrevLine.textContent = '';
    reelNextLine.textContent = currentTranslations[0] || lyrics.syncedLines[0]?.text || '';

  } else if (lyrics.status === 'plain' && lyrics.plainLyrics) {
    lyricsStatusBadge.classList.add('plain');
    setLyricsStatus('file-text', 'Plain Lyrics');
    lyricsContent.innerHTML = `<div class="plain-lyrics-wrap">${escapeHtml(lyrics.plainLyrics)}</div>`;
    reelLineText.innerHTML = '<span class="reel-placeholder-text">Plain lyrics (scroll below)</span>';
    reelPrevLine.textContent = '';
    reelNextLine.textContent = '';

  } else if (lyrics.status === 'instrumental') {
    lyricsStatusBadge.classList.add('instrumental');
    setLyricsStatus('music', 'Instrumental');
    lyricsContent.innerHTML = `
      <div class="lyrics-empty-state">
        <div class="lyrics-empty-icon">${icon('music', 'lg')}</div>
        <div class="lyrics-empty-msg">Instrumental Track</div>
        <p class="lyrics-empty-sub">This recording is registered as instrumental with no spoken lyrics. Enjoy the music!</p>
      </div>
    `;
    reelLineText.innerHTML = '<span class="reel-placeholder-text">♪ Instrumental</span>';
    reelPrevLine.textContent = '';
    reelNextLine.textContent = '';

  } else if (lyrics.status === 'error' || lyrics.status === 'quota') {
    lyricsStatusBadge.classList.add('plain');
    const isOffline = !navigator.onLine;
    const isQuota = lyrics.status === 'quota' || (lyrics.message && lyrics.message.includes('429'));
    if (isOffline) setLyricsStatus('wifi-off', 'Offline');
    else if (isQuota) setLyricsStatus('clock', 'Provider Busy');
    else setLyricsStatus('alert', 'Lyric Error');
    
    let errorTitle = 'Unable to Load Lyrics';
    let errorDesc = escapeHtml(lyrics.message || 'Check your internet connection or try searching again.');
    if (isOffline) {
      errorTitle = 'You are currently offline';
      errorDesc = 'Lyrics could not be retrieved from LRCLIB without an active internet connection.';
    } else if (isQuota) {
      errorTitle = 'Community Lyrics Provider Busy';
      errorDesc = 'LRCLIB is receiving high traffic right now. Please wait a few seconds and tap Retry below.';
    }

    lyricsContent.innerHTML = `
      <div class="lyrics-empty-state">
        <div class="lyrics-empty-icon">${icon(isOffline ? 'wifi-off' : (isQuota ? 'clock' : 'alert'), 'lg')}</div>
        <div class="lyrics-empty-msg">${errorTitle}</div>
        <p class="lyrics-empty-sub">${errorDesc}</p>
        <div class="lyrics-empty-actions">
          <button id="btnRetryLyrics" class="btn btn-sm btn-spotify" type="button">
            ${icon('refresh', 'sm')} Try Again
          </button>
        </div>
      </div>
    `;
    const retryBtn = document.getElementById('btnRetryLyrics');
    if (retryBtn) {
      retryBtn.addEventListener('click', () => {
        if (engine.track) {
          engine.setTrack(engine.track, engine.isPlaying, true);
        }
      });
    }
    reelLineText.innerHTML = '<span class="reel-placeholder-text">Lyrics temporarily unavailable</span>';
    reelPrevLine.textContent = '';
    reelNextLine.textContent = '';

  } else {
    lyricsStatusText.textContent = 'No Lyrics';
    const t = engine.track || {};
    const songLabel = t.title ? `${t.title}${t.artist ? ' — ' + t.artist : ''}` : '';
    const fromMic = t.source === 'mic';
    lyricsContent.innerHTML = `
      <div class="lyrics-empty-state">
        <div class="lyrics-empty-icon">${icon('file-text', 'lg')}</div>
        <div class="lyrics-empty-msg">No lyrics for this song yet</div>
        ${songLabel ? `<p class="lyrics-empty-song">${escapeHtml(songLabel)}</p>` : ''}
        <p class="lyrics-empty-sub">${fromMic
          ? 'Wrong song? Listen again near the speaker. Right song? Search other versions below.'
          : 'LRCLIB has no lyrics for this release. Try searching another version of the song.'}</p>
        <div class="lyrics-empty-actions">
          <button id="btnSearchLyricsManual" class="btn btn-sm btn-spotify" type="button">${icon('search', 'sm')} Search other versions</button>
          <button id="btnAddLyricsFromEmpty" class="btn btn-sm btn-ghost" type="button">${icon('file-text', 'sm')} Add your lyrics</button>
          ${fromMic ? `<button id="btnRelistenFromEmpty" class="btn btn-sm btn-ghost" type="button">${icon('mic', 'sm')} Listen again</button>` : ''}
        </div>
      </div>
    `;
    document.getElementById('btnAddLyricsFromEmpty')?.addEventListener('click', () => openUserLyrics());
    document.getElementById('btnSearchLyricsManual')?.addEventListener('click', () => {
      // Open Search pre-filled with the identified song and run it straight away.
      // The stage collapses to the mini player so the Search tab is actually visible.
      closeStage({ restoreFocus: false });
      const query = `${t.artist && t.artist !== 'Unknown Artist' ? t.artist + ' ' : ''}${cleanTitleForSearch(t.title || '')}`.trim();
      document.getElementById('tabSearch')?.click();
      if (searchInput && query) {
        searchInput.value = query;
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        searchInput.focus({ preventScroll: true });
      }
    });
    document.getElementById('btnRelistenFromEmpty')?.addEventListener('click', () => {
      btnListenAgain?.click();
    });
    reelLineText.innerHTML = '<span class="reel-placeholder-text">♪</span>';
    reelPrevLine.textContent = '';
    reelNextLine.textContent = '';
  }
}

// --- Lyric translation --------------------------------------------------------
function setReelTranslation(text) {
  if (!reelLineTranslation) return;
  reelLineTranslation.textContent = text;
  reelLineTranslation.classList.toggle('hidden', !text);
}

/** Paint letter conversion in primary lyrics position and original lyrics in sub-line position */
function applyTranslations() {
  const lyrics = engine.lyricsData;
  if (!lyrics) return;

  if (lyrics.status === 'synced' && lyrics.syncedLines) {
    lineElements.forEach((el, i) => {
      const orig = lyrics.syncedLines[i]?.text || '♪';
      const converted = currentTranslations[i] || '';
      const mainText = converted || orig;
      const subText = converted ? orig : '';

      let sub = el.querySelector('.lyric-translation');
      if (!subText) {
        sub?.remove();
        el.textContent = mainText;
      } else {
        if (!sub) {
          sub = document.createElement('span');
          sub.className = 'lyric-translation';
          sub.lang = translateLang;
          el.appendChild(sub);
        }
        sub.textContent = subText;
        let firstNode = el.firstChild;
        if (firstNode === sub) {
          el.insertBefore(document.createTextNode(mainText), sub);
        } else if (firstNode && firstNode.nodeType === Node.TEXT_NODE) {
          firstNode.nodeValue = mainText;
        } else {
          el.insertBefore(document.createTextNode(mainText), sub);
        }
      }
    });
  }

  const plainWrap = lyricsContent.querySelector('.plain-lyrics-wrap');
  if (plainWrap && lyrics.status === 'plain') {
    const original = String(lyrics.plainLyrics || '').split('\n');
    if (currentTranslations.some(Boolean)) {
      plainWrap.innerHTML = original.map((line, i) => {
        const converted = currentTranslations[i];
        const mainText = converted || line;
        const subText = converted ? line : '';
        return escapeHtml(mainText) + (subText ? `\n<span class="lyric-translation" lang="${escapeHtml(translateLang)}">${escapeHtml(subText)}</span>` : '');
      }).join('\n');
    } else {
      plainWrap.textContent = lyrics.plainLyrics;
    }
  }

  if (currentReelLineIndex >= 0 && lyrics.syncedLines && currentReelLineIndex < lyrics.syncedLines.length) {
    updateReelLine(currentReelLineIndex);
  } else if (lyrics.syncedLines) {
    reelNextLine.textContent = currentTranslations[0] || lyrics.syncedLines[0]?.text || '';
  }
}

async function requestTranslations(lyrics) {
  const requestId = ++translateRequestId;
  translateAbort?.abort();
  translateAbort = null;
  currentTranslations = [];
  applyTranslations();

  if (!isTranslateOn || !lyrics || (lyrics.status !== 'synced' && lyrics.status !== 'plain')) return;

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  translateAbort = controller;
  try {
    const translated = await translateLyrics(lyrics, translateLang, { signal: controller?.signal });
    if (requestId !== translateRequestId || engine.lyricsData !== lyrics) return;
    currentTranslations = translated;
    applyTranslations();
  } catch (err) {
    if (requestId !== translateRequestId || err?.name === 'AbortError') return;
    if (err instanceof TranslationQuotaError) {
      showAlert('Free translation limit reached for today. Lyrics stay in the original language.', 'warning');
    } else {
      console.warn('Lyric romanization failed:', err);
    }
  }
}

function updateRomanizeToggleUI() {
  if (!btnToggleRomanize) return;
  if (isTranslateOn) {
    btnToggleRomanize.classList.add('active');
    btnToggleRomanize.classList.remove('off');
    if (romToggleText) romToggleText.textContent = 'Romanize: On';
    btnToggleRomanize.setAttribute('aria-pressed', 'true');
  } else {
    btnToggleRomanize.classList.remove('active');
    btnToggleRomanize.classList.add('off');
    if (romToggleText) romToggleText.textContent = 'Romanize: Off';
    btnToggleRomanize.setAttribute('aria-pressed', 'false');
  }
}

function setTranslateOn(enabled) {
  isTranslateOn = enabled;
  safeSet(STORAGE_TRANSLATE_KEY, enabled.toString());
  if (settingTranslate) settingTranslate.checked = enabled;
  if (settingTranslateLang) settingTranslateLang.disabled = !enabled;
  updateRomanizeToggleUI();
  requestTranslations(engine.lyricsData);
}

function setTranslateLang(lang) {
  translateLang = lang;
  safeSet(STORAGE_TRANSLATE_LANG_KEY, lang);
  if (settingTranslateLang) settingTranslateLang.value = lang;
  requestTranslations(engine.lyricsData);
}

function updateReelLine(lineIndex) {
  const lyrics = engine.lyricsData;
  if (!lyrics || !lyrics.syncedLines) return;
  const lines = lyrics.syncedLines;

  currentReelLineIndex = lineIndex;

  if (lineIndex < 0 || lineIndex >= lines.length) {
    reelLineText.innerHTML = '<span class="reel-placeholder-text">♫ Prelude / Intro</span>';
    reelPrevLine.textContent = '';
    reelNextLine.textContent = currentTranslations[0] || lines[0]?.text || '';
    setReelTranslation('');
    reelWordElements = [];
    reelWordStates = [];
    reel.setActiveLine(null, -1);
    return;
  }

  const currentLine = lines[lineIndex];
  const nextLineTime = lines[lineIndex + 1]?.timeMs || 0;
  const converted = currentTranslations[lineIndex] || '';
  const mainDisplayText = converted || currentLine.text;
  const subDisplayText = converted ? currentLine.text : '';

  setReelTranslation(subDisplayText);

  // Subtle pulse animation on line box
  reelLineBox.classList.remove('line-pulse');
  // Trigger reflow to restart animation reliably
  void reelLineBox.offsetWidth;
  reelLineBox.classList.add('line-pulse');
  setTimeout(() => {
    reelLineBox.classList.remove('line-pulse');
  }, 220);

  const prevConverted = currentTranslations[lineIndex - 1] || lines[lineIndex - 1]?.text || '';
  const nextConverted = currentTranslations[lineIndex + 1] || lines[lineIndex + 1]?.text || '';
  reelPrevLine.textContent = prevConverted;
  reelNextLine.textContent = nextConverted;

  reel.setActiveLine(currentLine, lineIndex, nextLineTime);

  // Construct word spans for word reveal
  const rawWords = mainDisplayText.trim().split(/\s+/).filter(Boolean);
  reelLineText.innerHTML = '';
  reelWordElements = [];
  reelWordStates = [];
  shownWordIdx = -2;
  shownWordProgress = -1;

  if (rawWords.length === 0) {
    reelLineText.innerHTML = '<span class="reel-placeholder-text">♪</span>';
    return;
  }

  const fragment = document.createDocumentFragment();
  rawWords.forEach((word) => {
    const span = document.createElement('span');
    span.className = 'reel-word';
    span.textContent = word;
    fragment.appendChild(span);
    reelWordElements.push(span);
    reelWordStates.push(-1);
  });
  reelLineText.appendChild(fragment);
}

// =====================================================================
// Latency Offset Controls
// =====================================================================

function updateOffsetUI() {
  const ms = engine.getOffset();
  const sec = (ms / 1000).toFixed(1);
  const sign = ms > 0 ? '+' : '';
  const text = `${sign}${sec}s (${sign}${ms} ms)`;

  if (offsetPreviewLabel) offsetPreviewLabel.textContent = `${sign}${sec}s`;
  if (onStageOffsetLabel) onStageOffsetLabel.textContent = `${sign}${sec}s`;
  if (offsetValueText) offsetValueText.textContent = text;
  if (offsetSlider) offsetSlider.value = ms.toString();

  if (settingOffsetSlider) settingOffsetSlider.value = ms.toString();
  if (lblSettingsOffset) lblSettingsOffset.textContent = `${sign}${sec}s`;
}

function setOffset(newMs) {
  engine.setOffset(newMs);
  updateOffsetUI();
}

if (btnToggleOffset) {
  btnToggleOffset.addEventListener('click', () => {
    isOffsetDrawerOpen = !isOffsetDrawerOpen;
    offsetDrawer.classList.toggle('hidden', !isOffsetDrawerOpen);
    btnToggleOffset.setAttribute('aria-expanded', isOffsetDrawerOpen ? 'true' : 'false');
    btnToggleOffset.classList.toggle('active', isOffsetDrawerOpen);
  });
}

if (offsetSlider) offsetSlider.addEventListener('input', (e) => setOffset(parseInt(e.target.value, 10)));
if (btnOffsetMinus) btnOffsetMinus.addEventListener('click', () => setOffset(engine.getOffset() - 100));
if (btnOffsetPlus) btnOffsetPlus.addEventListener('click', () => setOffset(engine.getOffset() + 100));
if (btnOffsetReset) btnOffsetReset.addEventListener('click', () => setOffset(0));

// On-stage live sync nudge controls
if (btnNudgeMinus) btnNudgeMinus.addEventListener('click', () => setOffset(engine.getOffset() - 100));
if (btnNudgePlus) btnNudgePlus.addEventListener('click', () => setOffset(engine.getOffset() + 100));
if (btnNudgeReset) btnNudgeReset.addEventListener('click', () => setOffset(0));

// =====================================================================
// Preferences & Settings Modal
// =====================================================================

/**
 * Album Adaptive Theme Color Extractor
 * Uses an in-memory canvas sampler to extract dominant colors and guarantee WCAG AA contrast
 */
let lastExtractedArtUrl = null;
let currentAdaptivePalette = null;

function getLuminance(r, g, b) {
  const [rs, gs, bs] = [r, g, b].map(c => {
    c = c / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

function getContrastRatio(l1, l2) {
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(x => Math.round(x).toString(16).padStart(2, '0')).join('');
}

function extractAdaptiveColors(imgElement) {
  return new Promise((resolve) => {
    if (!imgElement || !imgElement.src || imgElement.naturalWidth === 0) {
      resolve(null);
      return;
    }

    try {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const size = 32;
      canvas.width = size;
      canvas.height = size;
      ctx.drawImage(imgElement, 0, 0, size, size);

      const imgData = ctx.getImageData(0, 0, size, size).data;
      const colorCounts = new Map();

      // Sample pixels
      for (let i = 0; i < imgData.length; i += 16) {
        const r = imgData[i];
        const g = imgData[i + 1];
        const b = imgData[i + 2];
        const a = imgData[i + 3];
        if (a < 128) continue;

        // Quantize colors to buckets of 32
        const qr = Math.round(r / 32) * 32;
        const qg = Math.round(g / 32) * 32;
        const qb = Math.round(b / 32) * 32;
        const key = `${qr},${qg},${qb}`;
        colorCounts.set(key, (colorCounts.get(key) || 0) + 1);
      }

      // Sort by frequency
      const sorted = [...colorCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(entry => entry[0].split(',').map(Number));

      if (sorted.length === 0) {
        resolve(null);
        return;
      }

      const primary = sorted[0];
      const secondary = sorted.length > 1 ? sorted[1] : [primary[1], primary[2], primary[0]];
      const accent = sorted.length > 2 ? sorted[2] : [255 - primary[0], 255 - primary[1], 255 - primary[2]];

      resolve({
        accent: rgbToHex(accent[0], accent[1], accent[2]),
        wave1: rgbToHex(primary[0], primary[1], primary[2]),
        wave2: rgbToHex(secondary[0], secondary[1], secondary[2]),
        bgDark: rgbToHex(Math.min(30, primary[0] * 0.15), Math.min(30, primary[1] * 0.15), Math.min(40, primary[2] * 0.2)),
        rawPrimary: primary
      });
    } catch {
      resolve(null); // Canvas security or cross-origin fallback
    }
  });
}

async function applyAlbumAdaptivePalette(imgSrc) {
  if (currentTheme !== 'adaptive') return;

  if (!imgSrc) {
    // Fall back to Aurora when no art exists
    document.documentElement.style.removeProperty('--accent');
    document.documentElement.style.removeProperty('--accent-contrast');
    document.documentElement.style.removeProperty('--wave-1');
    document.documentElement.style.removeProperty('--wave-2');
    document.documentElement.style.removeProperty('--adaptive-gradient');
    document.documentElement.style.removeProperty('--lyric-active');
    if (stageArtBackdrop) {
      stageArtBackdrop.classList.add('hidden');
      stageArtBackdrop.style.backgroundImage = 'none';
    }
    return;
  }

  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = imgSrc;

  img.onload = async () => {
    const palette = await extractAdaptiveColors(img);
    if (!palette) return;
    currentAdaptivePalette = palette;

    const bgLum = getLuminance(15, 18, 28);
    // Contrast check for active line against dark background
    let lyricActiveColor = '#ffffff';
    const whiteLum = getLuminance(255, 255, 255);
    if (getContrastRatio(whiteLum, bgLum) < 4.5) {
      lyricActiveColor = '#ffffff';
    }

    document.documentElement.style.setProperty('--accent', palette.accent);
    document.documentElement.style.setProperty('--accent-contrast', '#050714');
    document.documentElement.style.setProperty('--wave-1', palette.wave1);
    document.documentElement.style.setProperty('--wave-2', palette.wave2);
    document.documentElement.style.setProperty('--lyric-active', lyricActiveColor);
    document.documentElement.style.setProperty(
      '--adaptive-gradient',
      `radial-gradient(ellipse 90% 65% at 50% 0%, ${palette.wave1}44, ${palette.wave2}22 60%, transparent 80%)`
    );

    // Apply subtle blurred cover art behind the stage for Album Adaptive theme
    if (stageArtBackdrop) {
      stageArtBackdrop.style.backgroundImage = `url("${imgSrc}")`;
      stageArtBackdrop.classList.remove('hidden');
    }

    // The adaptive palette may have shifted the background tokens: refresh the system bars.
    syncChromeColor();
  };
}

function applyTheme(themeName) {
  if (!THEME_IDS.includes(themeName)) themeName = getDefaultTheme();
  currentTheme = themeName;
  document.documentElement.setAttribute('data-theme', themeName);
  safeSet(STORAGE_THEME_KEY, themeName);
  reel.setTheme(themeName);

  // Clear or apply adaptive properties
  if (themeName !== 'adaptive') {
    document.documentElement.style.removeProperty('--accent');
    document.documentElement.style.removeProperty('--accent-contrast');
    document.documentElement.style.removeProperty('--wave-1');
    document.documentElement.style.removeProperty('--wave-2');
    document.documentElement.style.removeProperty('--adaptive-gradient');
    document.documentElement.style.removeProperty('--lyric-active');
    if (stageArtBackdrop) {
      stageArtBackdrop.classList.add('hidden');
      stageArtBackdrop.style.backgroundImage = 'none';
    }
  } else {
    const currentTrack = engine?.track;
    if (currentTrack?.albumArt) {
      applyAlbumAdaptivePalette(currentTrack.albumArt);
    } else {
      applyAlbumAdaptivePalette(null);
    }
  }

  themePills.forEach((btn) => {
    const isActive = btn.dataset.theme === themeName;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-checked', isActive ? 'true' : 'false');
  });

  // Update theme swatch cards in settings
  if (themeCards && themeCards.length > 0) {
    themeCards.forEach((card) => {
      const isCardActive = card.dataset.themeCard === themeName;
      card.classList.toggle('active', isCardActive);
      card.setAttribute('aria-checked', isCardActive ? 'true' : 'false');
    });
  }

  if (settingThemeSelect) settingThemeSelect.value = themeName;

  // System bars / browser chrome follow the theme background (read after the new data-theme resolved).
  syncChromeColor();
}

function applyFontScale(percent) {
  currentFontScale = Math.max(50, Math.min(200, percent));
  localStorage.setItem(STORAGE_FONT_SCALE_KEY, currentFontScale.toString());
  document.documentElement.style.setProperty('--lyrics-font-scale', (currentFontScale / 100).toString());
  if (lblFontSize) lblFontSize.textContent = `${currentFontScale}%`;
  if (settingFontSize) settingFontSize.value = currentFontScale.toString();
}

function setWordMode(enabled) {
  isWordMode = enabled;
  localStorage.setItem(STORAGE_WORD_MODE_KEY, enabled.toString());
  reel.setWordByWordMode(enabled);
  btnToggleWordMode.classList.toggle('active', enabled);
  btnToggleWordMode.setAttribute('aria-pressed', enabled ? 'true' : 'false');
  if (wordModeValue) wordModeValue.textContent = enabled ? 'On' : 'Off';
  if (settingWordMode) settingWordMode.checked = enabled;
  reelWordStates.fill(-1);
}

// --- Reel fullscreen
// The beat visuals and laser border only run while the reel is fullscreen. The Android app's WebView has
// no Fullscreen API support (requestFullscreen is refused or never settles), and iPhone Safari has none
// for elements, so there the reel covers the window with CSS instead ("pseudo-fullscreen", .is-pseudo-fs).
// It runs the same visuals and gets its own history entry, so Android Back leaves fullscreen first.

function isReelFullscreen() {
  return Boolean(document.fullscreenElement) || pseudoFullscreen;
}

function setPseudoFullscreen(on, { fromHistory = false, skipHistory = false } = {}) {
  if (pseudoFullscreen === on) return;
  pseudoFullscreen = on;
  reelContainer.classList.toggle('is-pseudo-fs', on);
  if (on) pushNav('fs');
  else if (!fromHistory && !skipHistory) unwindNav('fs');
  onReelFullscreenChange();
}

function clearFullscreenFallback() {
  if (fullscreenFallbackTimer) {
    clearTimeout(fullscreenFallbackTimer);
    fullscreenFallbackTimer = null;
  }
}

function toggleFullscreen() {
  clearFullscreenFallback();
  if (pseudoFullscreen) {
    setPseudoFullscreen(false);
    return;
  }
  if (document.fullscreenElement) {
    try {
      const ex = document.exitFullscreen
        ? document.exitFullscreen()
        : (document.webkitExitFullscreen ? document.webkitExitFullscreen() : null);
      ex?.catch?.(() => {});
    } catch {}
    return;
  }
  if (!stageOpen) return; // the reel is only on screen while the stage is open

  const request = reelContainer.requestFullscreen || reelContainer.webkitRequestFullscreen;
  if (IS_NATIVE_APP || !request || document.fullscreenEnabled === false) {
    setPseudoFullscreen(true);
    return;
  }
  const fallback = () => {
    clearFullscreenFallback();
    if (stageOpen && !isReelFullscreen()) setPseudoFullscreen(true);
  };
  try {
    const req = request.call(reelContainer);
    req?.catch?.(fallback);
    // Some browsers neither enter fullscreen nor reject the request: don't leave the tap doing nothing.
    fullscreenFallbackTimer = setTimeout(fallback, FULLSCREEN_SETTLE_MS);
  } catch {
    fallback();
  }
}

function trapFocus(modalElement, event) {
  if (event.key !== 'Tab') return;
  const focusables = modalElement.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
  if (!focusables || focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];

  if (event.shiftKey) {
    if (document.activeElement === first) {
      event.preventDefault();
      last.focus();
    }
  } else {
    if (document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
}

let settingsOpener = null;

let settingsCloseTimer = null;

function openSettings() {
  settingsOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  clearTimeout(settingsCloseTimer);
  settingsBackdrop.classList.remove('hidden', 'is-closing');
  settingsBackdrop.setAttribute('aria-hidden', 'false');
  btnOpenSettings?.setAttribute('aria-expanded', 'true');
  syncDrawerNav();
  // Focus the close button or first actionable element
  setTimeout(() => {
    btnCloseSettings?.focus();
  }, 50);
}

function closeSettings() {
  if (settingsBackdrop.classList.contains('hidden')) return;
  btnOpenSettings?.setAttribute('aria-expanded', 'false');
  settingsBackdrop.setAttribute('aria-hidden', 'true');
  // Slide the sidebar out, then hide it (instant with reduced motion).
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  settingsBackdrop.classList.add('is-closing');
  settingsDialog.style.transform = '';
  clearTimeout(settingsCloseTimer);
  settingsCloseTimer = setTimeout(() => {
    settingsBackdrop.classList.add('hidden');
    settingsBackdrop.classList.remove('is-closing');
  }, reduce ? 0 : 200);
  // Return focus to whatever opened the dialog; the header gear when that is gone (or inert behind the stage).
  const opener = settingsOpener;
  settingsOpener = null;
  const usable = opener && opener.isConnected && opener.offsetParent !== null && !opener.closest('[inert]');
  if (usable) opener.focus();
  else if (stageOpen) btnMoreSheet?.focus({ preventScroll: true });
  else btnOpenSettings?.focus();
}

btnOpenSettings.addEventListener('click', openSettings);
btnCloseSettings.addEventListener('click', closeSettings);
btnDoneSettings.addEventListener('click', closeSettings);

settingsBackdrop.addEventListener('click', (e) => {
  if (e.target === settingsBackdrop) closeSettings();
});

// Focus trap for the settings dialog (document-level so focus on <body> is caught too)
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' || settingsBackdrop.classList.contains('hidden')) return;
  if (!settingsDialog.contains(document.activeElement)) {
    e.preventDefault();
    btnCloseSettings?.focus();
    return;
  }
  trapFocus(settingsDialog, e);
});

// Shortcuts Cheat-sheet Modal Controls
function openShortcuts() {
  if (shortcutsBackdrop) {
    shortcutsBackdrop.classList.remove('hidden');
    shortcutsBackdrop.setAttribute('aria-hidden', 'false');
    btnCloseShortcuts?.focus();
  }
}

function closeShortcuts() {
  if (shortcutsBackdrop) {
    shortcutsBackdrop.classList.add('hidden');
    shortcutsBackdrop.setAttribute('aria-hidden', 'true');
    if (stageOpen) btnMoreSheet?.focus({ preventScroll: true });
  }
}

if (btnOpenShortcuts) btnOpenShortcuts.addEventListener('click', () => {
  closeMoreSheet({ restoreFocus: false });
  openShortcuts();
});
btnMoreOpenSettings?.addEventListener('click', () => {
  closeMoreSheet({ restoreFocus: false });
  openSettings();
});

// Lyrics card maker: pick a few lines of the current song and export them as an image
const lyricCard = lyricCardBackdrop ? new LyricCardMaker({
  backdrop: lyricCardBackdrop,
  notify: (msg, type) => showAlert(msg, type),
  haptic,
  onClose: () => { if (stageOpen) btnMoreSheet?.focus({ preventScroll: true }); }
}) : null;

function openLyricCard() {
  if (!lyricCard) return;
  const positionMs = engine.track ? engine.getEffectivePositionMs() : NaN;
  lyricCard.open(engine.track, engine.lyricsData, positionMs);
}

btnMakeLyricCard?.addEventListener('click', () => {
  closeMoreSheet({ restoreFocus: false });
  openLyricCard();
});

// Your lyrics editor: save lyrics the user has rights to, then reload them for the song on screen
const userLyricsDialog = userLyricsBackdrop ? new UserLyricsDialog({
  backdrop: userLyricsBackdrop,
  store: userLyricsStore,
  notify: (msg, type) => showAlert(msg, type),
  onSaved: (track) => {
    if (engine.track && track && engine.track.id === track.id) engine.reloadLyrics();
  },
  onClose: () => { if (stageOpen) btnMoreSheet?.focus({ preventScroll: true }); }
}) : null;

function openUserLyrics() {
  if (!userLyricsDialog) return;
  userLyricsDialog.open(engine.track);
}

btnEditUserLyrics?.addEventListener('click', () => {
  closeMoreSheet({ restoreFocus: false });
  openUserLyrics();
});
btnLyricsCreditEdit?.addEventListener('click', () => openUserLyrics());
userLyricsBackdrop?.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') trapFocus(userLyricsBackdrop, e);
});

lyricCardBackdrop?.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') trapFocus(lyricCardBackdrop, e);
});
if (btnCloseShortcuts) btnCloseShortcuts.addEventListener('click', closeShortcuts);
if (btnDoneShortcuts) btnDoneShortcuts.addEventListener('click', closeShortcuts);
if (shortcutsBackdrop) {
  shortcutsBackdrop.addEventListener('click', (e) => {
    if (e.target === shortcutsBackdrop) closeShortcuts();
  });
}

// Sidebar navigation: jump to a source tab or the account dialog.
function syncDrawerNav() {
  document.querySelectorAll('.drawer-nav-item[data-drawer-tab]').forEach((item) => {
    const tab = document.querySelector(`.source-tab[data-tab="${item.dataset.drawerTab}"]`);
    const visible = Boolean(tab && !tab.classList.contains('hidden'));
    item.classList.toggle('hidden', !visible);
    item.classList.toggle('active', item.dataset.drawerTab === activeTab);
    item.setAttribute('aria-current', item.dataset.drawerTab === activeTab ? 'page' : 'false');
    const label = tab?.querySelector('.tab-label')?.textContent;
    const use = tab?.querySelector('use')?.getAttribute('href');
    if (label) item.querySelector('.drawer-nav-label').textContent = label;
    if (use) item.querySelector('use')?.setAttribute('href', use);
  });
}

document.getElementById('drawerNav')?.addEventListener('click', (e) => {
  const item = e.target.closest('.drawer-nav-item');
  if (!item) return;
  settingsOpener = null;
  closeSettings();
  if (item.dataset.drawerTab) {
    if (stageOpen) closeStage({ restoreFocus: false, userInitiated: true });
    document.querySelector(`.source-tab[data-tab="${item.dataset.drawerTab}"]`)?.click();
  } else if (item.dataset.drawerAction === 'account') {
    document.getElementById('btnOpenAuth')?.click();
  }
});

// Swipe the sidebar back to the left to dismiss it (touch).
if (settingsDialog) {
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let tracking = false;

  settingsDialog.addEventListener('touchstart', (e) => {
    // Sliders, selects and horizontally scrolling rows own their horizontal drags.
    tracking = !e.target.closest('input, select, textarea, [data-no-drawer-swipe]');
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    dx = 0;
    if (tracking) settingsDialog.style.transition = 'none';
  }, { passive: true });

  settingsDialog.addEventListener('touchmove', (e) => {
    if (!tracking) return;
    const moveX = e.touches[0].clientX - startX;
    const moveY = e.touches[0].clientY - startY;
    // Vertical scrolling wins; only a mostly-horizontal leftward drag moves the drawer.
    if (Math.abs(moveY) > Math.abs(moveX) && dx === 0) {
      tracking = false;
      settingsDialog.style.transition = '';
      return;
    }
    dx = Math.min(0, moveX);
    settingsDialog.style.transform = dx ? `translateX(${dx}px)` : '';
  }, { passive: true });

  settingsDialog.addEventListener('touchend', () => {
    settingsDialog.style.transition = '';
    if (!tracking) return;
    tracking = false;
    const width = settingsDialog.offsetWidth || 320;
    if (dx < -Math.min(90, width * 0.3)) {
      closeSettings();
    } else {
      settingsDialog.style.transform = '';
    }
    dx = 0;
  });
}

const isShown = (el) => Boolean(el && !el.classList.contains('hidden'));

/**
 * True while a dialog or sheet covers the app. Global shortcuts (play, seek, sync, font size...)
 * stay off then, so keys typed in a dialog never act on the song behind it.
 * @param {{ ignoreSheet?: boolean }} [opts]
 */
function isOverlayOpen({ ignoreSheet = false } = {}) {
  return (!ignoreSheet && sheetOpen)
    || isShown(settingsBackdrop)
    || isShown(shortcutsBackdrop)
    || Boolean(lyricCard?.isOpen)
    || Boolean(userLyricsDialog?.isOpen)
    || Boolean(playlistPicker?.isOpen)
    || isShown(micConsentBackdrop)
    || isShown(document.getElementById('authBackdrop'));
}

/**
 * Shortcut that toggles one dialog: closes it when open; opens it from the app or the More sheet
 * (closing the sheet, like its buttons do); does nothing while a different dialog is up.
 */
function toggleDialogShortcut(isOpenNow, open, close) {
  if (isOpenNow) { close(); return; }
  if (isOverlayOpen({ ignoreSheet: true })) return;
  if (sheetOpen) closeMoreSheet({ restoreFocus: false });
  open();
}

// Desktop Keyboard Shortcuts & Navigation
window.addEventListener('keydown', (e) => {
  // If user is currently focused on an editable input/textarea/select, don't trigger global hotkeys
  const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
  const isInputActive = activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select' || document.activeElement?.isContentEditable;
  const plainKey = !e.ctrlKey && !e.metaKey && !e.altKey;

  // Escape closes the topmost layer: a dialog, then the More sheet, then fullscreen, then the stage.
  // (The account dialog handles its own Escape and stops it before it gets here.)
  if (e.key === 'Escape') {
    if (isShown(settingsBackdrop)) {
      closeSettings();
    } else if (isShown(shortcutsBackdrop)) {
      closeShortcuts();
    } else if (lyricCard?.isOpen) {
      lyricCard.close();
    } else if (userLyricsDialog?.isOpen) {
      userLyricsDialog.close();
    } else if (playlistPicker?.isOpen) {
      playlistPicker.close();
    } else if (isShown(micConsentBackdrop)) {
      micConsentBackdrop.classList.add('hidden');
    } else if (sheetOpen) {
      closeMoreSheet();
    } else if (isReelFullscreen()) {
      toggleFullscreen();
    } else if (stageOpen) {
      closeStage({ userInitiated: true });
    } else {
      return;
    }
    e.preventDefault();
    return;
  }

  if (isInputActive) return;
  if (e.defaultPrevented) return; // a focused control (e.g. the seek slider) already handled this key

  // Dialog toggles: each closes its own dialog, and opens it unless a different dialog is up.
  // 'S': Settings
  if ((e.key === 's' || e.key === 'S') && plainKey) {
    e.preventDefault();
    toggleDialogShortcut(isShown(settingsBackdrop), openSettings, closeSettings);
    return;
  }

  // 'C': Lyrics card maker for the current song
  if ((e.key === 'c' || e.key === 'C') && plainKey) {
    e.preventDefault();
    toggleDialogShortcut(Boolean(lyricCard?.isOpen), openLyricCard, () => lyricCard?.close());
    return;
  }

  // '?' (Shift + '/'): keyboard shortcuts cheat-sheet
  if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
    e.preventDefault();
    toggleDialogShortcut(isShown(shortcutsBackdrop), openShortcuts, closeShortcuts);
    return;
  }

  // Everything below acts on the song, so it stays off while a dialog or the More sheet is open
  // (Space then keeps its native meaning: press the focused button).
  if (isOverlayOpen()) return;

  // 'Space': play / pause on the stage; otherwise toggle microphone listening (or play/pause a search track)
  if (e.code === 'Space' && plainKey) {
    // On the stage, real controls keep their native Space behaviour (except the collapse button, which has
    // focus right after the stage opens); elsewhere Space keeps meaning "listen" as before.
    if (stageOpen) {
      const control = e.target instanceof Element
        ? e.target.closest('button, a[href], [role="tab"], [role="radio"], [role="slider"], summary')
        : null;
      if (control && control !== btnStageCollapse) return;
    }
    e.preventDefault();
    if (stageOpen || searchSource.isPlaying) {
      haptic('light');
      engine.togglePlay();
    } else {
      btnMicListen?.click();
    }
    return;
  }

  // 'F' or 'f': Fullscreen reel mode toggle
  if ((e.key === 'f' || e.key === 'F') && plainKey) {
    e.preventDefault();
    toggleFullscreen();
    return;
  }

  // '>' / '<': next / previous song in the Free music queue
  if ((e.key === '>' || e.key === '<') && !e.ctrlKey && !e.metaKey && !e.altKey && playQueue.active) {
    e.preventDefault();
    if (e.key === '>') playNextInQueue();
    else playPreviousInQueue();
    updateQueueControls();
    return;
  }

  // 'N' or 'n': next projectM preset while it runs fullscreen
  if ((e.key === 'n' || e.key === 'N') && plainKey && projectm?.active && projectm.ready) {
    e.preventDefault();
    projectm.nextPreset(true);
    return;
  }

  // 'ArrowUp': Nudge sync offset later (+100ms)
  if (e.key === 'ArrowUp' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    setOffset(engine.getOffset() + 100);
    return;
  }

  // 'ArrowDown': Nudge sync offset earlier (-100ms)
  if (e.key === 'ArrowDown' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    setOffset(engine.getOffset() - 100);
    return;
  }

  // '[': Decrease lyrics font size by 10%
  if (e.key === '[' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    applyFontScale(Math.max(80, currentFontScale - 10));
    return;
  }

  // ']': Increase lyrics font size by 10%
  if (e.key === ']' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    applyFontScale(Math.min(140, currentFontScale + 10));
    return;
  }
});

// Fullscreen "Reel Mode": 3-second cursor auto-hide
function resetCursorIdleTimer() {
  document.body.classList.remove('cursor-idle');
  if (cursorIdleTimeout) clearTimeout(cursorIdleTimeout);
  if (isReelFullscreen()) {
    cursorIdleTimeout = setTimeout(() => {
      if (isReelFullscreen()) {
        document.body.classList.add('cursor-idle');
      }
    }, 3000);
  }
}

document.addEventListener('mousemove', resetCursorIdleTimer);
document.addEventListener('touchstart', resetCursorIdleTimer, { passive: true });

themePills.forEach((btn) => {
  btn.addEventListener('click', () => applyTheme(btn.dataset.theme));
});

btnToggleWordMode.addEventListener('click', () => {
  haptic('light');
  setWordMode(!isWordMode);
});
btnFullscreen.addEventListener('click', () => {
  closeMoreSheet({ restoreFocus: false });
  toggleFullscreen();
});
btnReelExitFs?.addEventListener('click', toggleFullscreen);

document.addEventListener('fullscreenchange', () => {
  if (document.fullscreenElement) clearFullscreenFallback();
  onReelFullscreenChange();
});

/**
 * Start/stop projectM with fullscreen. Shows its canvas only once the WASM module is running, so
 * the classic beat visuals stay up while it loads (or if this device can't run it).
 */
async function syncProjectM(isFs = isReelFullscreen()) {
  if (!projectm) return;
  const session = ++projectmSession;
  const want = isFs && visualizerMode === 'projectm';
  if (want && projectmSupported === null) projectmSupported = isProjectMSupported();
  if (!want || !projectmSupported) {
    projectm.setActive(false);
    projectm.releaseLiveStream();
    delete reelContainer.dataset.visualizer;
    btnProjectMNext?.classList.add('hidden');
    return;
  }
  const ok = await projectm.setActive(true);
  if (session !== projectmSession) return;
  if (!ok) {
    delete reelContainer.dataset.visualizer;
    return;
  }
  reelContainer.dataset.visualizer = 'projectm';
  btnProjectMNext?.classList.remove('hidden');
  if (visualizerLive && !projectm.hasLiveAudio) {
    const stream = await openVisualizerAudio();
    if (session !== projectmSession || !projectm.active) {
      stream?.getTracks().forEach((t) => t.stop());
      return;
    }
    if (stream) projectm.setLiveStream(stream);
  }
}

/**
 * Live audio for projectM: system audio in the desktop app (loopback, answered by the main
 * process), the microphone elsewhere. Resolves null when unavailable or refused.
 */
async function openVisualizerAudio() {
  try {
    if (IS_DESKTOP_APP && navigator.mediaDevices?.getDisplayMedia) {
      const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
      stream.getVideoTracks().forEach((t) => { t.stop(); stream.removeTrack(t); });
      if (stream.getAudioTracks().length) return stream;
    }
    if (navigator.mediaDevices?.getUserMedia) {
      return await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      });
    }
  } catch (err) {
    console.warn('Visualizer audio unavailable:', err);
    showAlert(IS_DESKTOP_APP
      ? 'Could not capture system audio; projectM follows the beat instead.'
      : 'Microphone unavailable; projectM follows the beat instead.', 'info');
  }
  return null;
}

btnProjectMNext?.addEventListener('click', (e) => {
  e.stopPropagation();
  projectm?.nextPreset(true);
});

function onReelFullscreenChange() {
  const isFs = isReelFullscreen();
  document.body.classList.toggle('fullscreen-reel-mode', isFs);
  fsLabel.textContent = isFs ? 'Exit fullscreen' : 'Fullscreen';
  btnReelExitFs?.classList.toggle('hidden', !isFs);
  resetCursorIdleTimer();
  reel.resizeCanvas();
  beatVisuals?.setActive(isFs);
  syncProjectM(isFs);
  syncAudioReactive();

  if (isFs || (engine && engine.isPlaying)) {
    requestWakeLock();
  } else {
    releaseWakeLock();
  }
}

// Theme swatch cards in preferences modal
if (themeCards && themeCards.length > 0) {
  themeCards.forEach((card) => {
    card.addEventListener('click', () => {
      const theme = card.dataset.themeCard;
      if (theme) {
        haptic('confirm');
        applyTheme(theme);
      }
    });
  });
}

if (settingThemeSelect) {
  settingThemeSelect.addEventListener('change', (e) => applyTheme(e.target.value));
}
if (settingFontSize) {
  settingFontSize.addEventListener('input', (e) => applyFontScale(parseInt(e.target.value, 10)));
}
if (settingTranslateLang) {
  settingTranslateLang.innerHTML = TRANSLATE_LANGUAGES
    .map(([code, name]) => `<option value="${code}">${name}</option>`).join('');
  settingTranslateLang.value = translateLang;
  settingTranslateLang.disabled = !isTranslateOn;
  settingTranslateLang.addEventListener('change', (e) => setTranslateLang(e.target.value));
}
if (settingTranslate) {
  settingTranslate.checked = isTranslateOn;
  settingTranslate.addEventListener('change', (e) => setTranslateOn(e.target.checked));
}
if (btnToggleRomanize) {
  btnToggleRomanize.addEventListener('click', () => setTranslateOn(!isTranslateOn));
}
updateRomanizeToggleUI();
if (settingWordMode) {
  settingWordMode.addEventListener('change', (e) => setWordMode(e.target.checked));
}
if (settingHaptics) {
  settingHaptics.checked = hapticsEnabled;
  settingHaptics.addEventListener('change', (e) => {
    hapticsEnabled = e.target.checked;
    safeSet(STORAGE_HAPTICS_KEY, hapticsEnabled ? 'true' : 'false');
    if (hapticsEnabled) haptic('confirm'); // let the user feel what they just turned on
  });
}
// Fullscreen visualizer: projectM (default) or the classic canvas beat visuals.
const settingVisualizer = document.getElementById('settingVisualizer');
const settingVisualizerLive = document.getElementById('settingVisualizerLive');
const lblVisualizerLive = document.getElementById('lblVisualizerLive');
function setVisualizerMode(mode) {
  visualizerMode = mode === 'classic' ? 'classic' : 'projectm';
  safeSet(STORAGE_VISUALIZER_KEY, visualizerMode);
  if (settingVisualizer) settingVisualizer.value = visualizerMode;
  document.getElementById('rowVisualizerLive')?.classList.toggle('hidden', visualizerMode !== 'projectm');
  syncProjectM();
}
function setVisualizerLive(on) {
  visualizerLive = Boolean(on);
  safeSet(STORAGE_VISUALIZER_LIVE_KEY, visualizerLive ? 'true' : 'false');
  if (settingVisualizerLive) settingVisualizerLive.checked = visualizerLive;
  if (!visualizerLive) projectm?.releaseLiveStream();
  syncProjectM();
}
if (lblVisualizerLive) {
  lblVisualizerLive.textContent = IS_DESKTOP_APP ? 'projectM reacts to system audio' : 'projectM listens through the mic';
}
if (settingVisualizer) {
  settingVisualizer.value = visualizerMode;
  document.getElementById('rowVisualizerLive')?.classList.toggle('hidden', visualizerMode !== 'projectm');
  settingVisualizer.addEventListener('change', (e) => setVisualizerMode(e.target.value));
}
if (settingVisualizerLive) {
  settingVisualizerLive.checked = visualizerLive;
  settingVisualizerLive.addEventListener('change', (e) => setVisualizerLive(e.target.checked));
}
// Dancing cat in the stage corner: off by default.
const settingCatDancer = document.getElementById('settingCatDancer');
function setCatDancerEnabled(on) {
  const enabled = Boolean(on);
  safeSet(STORAGE_CAT_DANCER_KEY, enabled ? 'true' : 'false');
  if (settingCatDancer) settingCatDancer.checked = enabled;
  catDancer?.setEnabled(enabled);
}
let catDancerOn = false;
try { catDancerOn = localStorage.getItem(STORAGE_CAT_DANCER_KEY) === 'true'; } catch {}
if (catDancerOn) catDancer?.setEnabled(true);
if (settingCatDancer) {
  settingCatDancer.checked = catDancerOn;
  settingCatDancer.addEventListener('change', (e) => setCatDancerEnabled(e.target.checked));
}

if (settingOffsetSlider) {
  settingOffsetSlider.addEventListener('input', (e) => setOffset(parseInt(e.target.value, 10)));
}
if (btnSettingsOffsetMinus) {
  btnSettingsOffsetMinus.addEventListener('click', () => setOffset(engine.getOffset() - 100));
}
if (btnSettingsOffsetPlus) {
  btnSettingsOffsetPlus.addEventListener('click', () => setOffset(engine.getOffset() + 100));
}
if (btnSettingsOffsetReset) {
  btnSettingsOffsetReset.addEventListener('click', () => setOffset(0));
}

if (settingRecognitionProvider) {
  const currentProvider = localStorage.getItem('lyricwave_recognition_provider') || CONFIG.RECOGNITION_PROVIDER || 'shazam';
  settingRecognitionProvider.value = currentProvider;

  settingRecognitionProvider.addEventListener('change', (e) => {
    const selected = e.target.value;
    mic.setProvider(selected);
    const providerLabel = selected === 'shazam' ? 'Shazam' : (selected === 'audd' ? 'AudD' : 'ACRCloud');
    showAlert(`Recognition engine switched to ${providerLabel}.`, 'info');
  });
}

if (settingDebugMode) {
  settingDebugMode.addEventListener('change', (e) => {
    diagnosticsDrawer?.classList.toggle('hidden', !e.target.checked);
  });
}


// Library backup: one JSON file with songs, artists, playlists and your lyrics (see backup.js).
// Android saves it to Download/LyricWave (or shares it); browsers download it.
const libraryBackup = new LibraryBackup({
  library: libraryCollector.store,
  playlists: playlistStore,
  userLyrics: userLyricsStore,
  exclusive: (fn) => libraryCollector.exclusive(fn)
});
const btnBackupLibrary = document.getElementById('btnBackupLibrary');
const btnRestoreLibrary = document.getElementById('btnRestoreLibrary');
const restoreLibraryFile = document.getElementById('restoreLibraryFile');

/** The Android app's file bridge (saveFile / shareFile, app 1.3.0+), or null elsewhere. */
function nativeFileBridge() {
  try {
    const bridge = window.LyricWaveNative;
    return bridge && typeof bridge.shareFile === 'function' ? bridge : null;
  } catch {
    return null;
  }
}

/** Disables a Settings button and shows `busyText` on it until the returned function is called. */
function markBusy(btn, busyText) {
  if (!btn) return () => {};
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = busyText;
  btn.setAttribute('aria-busy', 'true');
  return () => {
    btn.disabled = false;
    btn.textContent = label;
    btn.removeAttribute('aria-busy');
  };
}

/** UTF-8 text as base64, in chunks so large backups don't overflow the call stack. */
function textToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

async function backupLibrary() {
  if (!btnBackupLibrary || btnBackupLibrary.disabled) return;
  const native = nativeFileBridge();
  // The Android WebView ignores downloads; older app versions have no file bridge
  if (IS_NATIVE_APP && !native) {
    showAlert('Update the LyricWave app to back up your library.', 'warning');
    return;
  }
  const done = markBusy(btnBackupLibrary, 'Backing up…');
  try {
    const data = await libraryBackup.export();
    const counts = describeCounts(data.counts);
    if (!counts) {
      showAlert('Your library is empty, so there is nothing to back up yet.', 'info');
      return;
    }
    const text = JSON.stringify(data, null, 2);
    const name = backupFileName();
    if (native) {
      const b64 = textToBase64(text);
      let saved = false;
      try { saved = native.canSaveFile?.() !== false && native.saveFile?.(b64, name) === true; } catch { saved = false; }
      if (saved) {
        showAlert(`Backed up ${counts} to Download/LyricWave.`, 'success');
      } else {
        let shared = false;
        try { shared = native.shareFile(b64, name, 'LyricWave library backup') === true; } catch { shared = false; }
        showAlert(shared ? 'Pick where to keep your backup.' : 'Couldn’t save the backup on this device.', shared ? 'info' : 'warning');
      }
      return;
    }
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    showAlert(`Backed up ${counts}.`, 'success');
  } catch (err) {
    console.warn('Library backup failed:', err);
    showAlert('Couldn’t make the backup on this device.', 'warning');
  } finally {
    done();
  }
}

async function restoreLibrary(file) {
  if (!file) return;
  // Clearing the picker afterwards lets the same file be chosen again
  const clearPicker = () => { if (restoreLibraryFile) restoreLibraryFile.value = ''; };
  if (file.size > MAX_BACKUP_BYTES) {
    showAlert('That file is too large to be a LyricWave backup.', 'warning');
    clearPicker();
    return;
  }
  const done = markBusy(btnRestoreLibrary, 'Restoring…');
  try {
    const result = await libraryBackup.restore(await file.text());
    const changed = describeCounts(result.added) || describeCounts(result.updated);
    showAlert(describeRestore(result), changed ? 'success' : 'info');
    libraryView?.refresh();
  } catch (err) {
    console.warn('Library restore failed:', err);
    showAlert(err instanceof BackupFileError ? err.message : 'Couldn’t restore that backup on this device.', 'warning');
  } finally {
    done();
    clearPicker();
  }
}

btnBackupLibrary?.addEventListener('click', backupLibrary);
btnRestoreLibrary?.addEventListener('click', () => {
  // Android app versions before 1.3.0 (no file bridge) can't open the file picker either
  if (IS_NATIVE_APP && !nativeFileBridge()) {
    showAlert('Update the LyricWave app to restore a backup.', 'warning');
    return;
  }
  restoreLibraryFile?.click();
});
restoreLibraryFile?.addEventListener('change', () => restoreLibrary(restoreLibraryFile.files?.[0]));

// "Clear All Data" handler: wipes everything LyricWave keeps on this device.
async function clearAllLocalData() {
  try { mic.stop(); } catch {}
  try { engine.stop(); } catch {}
  try { logout(); } catch {}            // Spotify tokens
  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith('lyricwave_'))
      .forEach((k) => localStorage.removeItem(k));
  } catch {}
  try {
    Object.keys(sessionStorage)
      .filter((k) => k.startsWith('lyricwave_'))
      .forEach((k) => sessionStorage.removeItem(k));
  } catch {}
  const dropDb = (name) => new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    } catch { resolve(); }
  });
  if (typeof indexedDB !== 'undefined') {
    await Promise.all([dropDb('LyricWaveDB'), dropDb('LyricWaveAuthDB')]);
  }
  try {
    if (typeof caches !== 'undefined') {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('lyricwave')).map((k) => caches.delete(k)));
    }
  } catch {}
}

const btnClearAllData = document.getElementById('btnClearAllData');
if (btnClearAllData) {
  let clearArmedTimer = null;
  btnClearAllData.addEventListener('click', async () => {
    if (!clearArmedTimer) {
      btnClearAllData.textContent = 'Tap again';
      clearArmedTimer = setTimeout(() => {
        clearArmedTimer = null;
        btnClearAllData.textContent = 'Clear';
      }, 4000);
      return;
    }
    clearTimeout(clearArmedTimer);
    clearArmedTimer = null;
    btnClearAllData.disabled = true;
    await clearAllLocalData();
    window.location.reload();
  });
}

// "Reset to defaults" handler
if (btnResetDefaults) {
  btnResetDefaults.addEventListener('click', () => {
    // 1. Reset theme to default (prefers-color-scheme)
    const defTheme = getDefaultTheme();
    applyTheme(defTheme);

    // 2. Reset font scale to 100%
    applyFontScale(100);

    // 3. Reset word-by-word reveal to true
    setWordMode(true);

    // 4. Reset sync latency offset to 0
    setOffset(0);

    // 4b. Lyric animation back to Pulse, haptics back on
    setAnimStyle(DEFAULT_ANIM_STYLE);
    hapticsEnabled = true;
    safeSet(STORAGE_HAPTICS_KEY, 'true');
    if (settingHaptics) settingHaptics.checked = true;
    setVisualizerLive(false);
    setVisualizerMode('projectm');

    // 5. Turn off debug diagnostics
    if (settingDebugMode) {
      settingDebugMode.checked = false;
      diagnosticsDrawer?.classList.add('hidden');
    }

    showAlert('Settings reset to defaults.', 'info');
  });
}

// =====================================================================
// In-app updates (Android app)
// =====================================================================

/**
 * The Android shell downloads signed web updates in the background (WebUpdater.java) and
 * reports via window.__lyricwaveWebUpdate. Settings > About shows the version and a manual check.
 */
function setupNativeWebUpdates() {
  const bridge = window.LyricWaveNative;
  if (!IS_NATIVE_APP || !bridge || typeof bridge.getAppVersionInfo !== 'function') return;

  const section = document.getElementById('secAbout');
  const versionText = document.getElementById('appVersionText');
  const btnCheck = document.getElementById('btnCheckUpdates');

  const readInfo = () => {
    try { return JSON.parse(bridge.getAppVersionInfo() || '{}'); } catch { return {}; }
  };

  const formatBuild = (seconds) => {
    if (!seconds) return '';
    const d = new Date(seconds * 1000);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const applyUpdate = () => {
    try { bridge.applyWebUpdate(); } catch {}
  };

  const render = (state) => {
    const info = readInfo();
    if (versionText) {
      const build = formatBuild(info.webVersion);
      versionText.textContent = [info.versionName ? `v${info.versionName}` : '', build ? `updated ${build}` : '']
        .filter(Boolean).join(' · ') || '—';
    }
    if (!btnCheck) return;
    btnCheck.classList.toggle('hidden', !info.updatesEnabled);
    btnCheck.disabled = state === 'checking';
    btnCheck.textContent = info.updateReady ? 'Update' : (state === 'checking' ? 'Checking…' : 'Check');
  };

  const promptReload = () => {
    showAlert('A new version of LyricWave is ready.', 'success', {
      action: { label: 'Reload', onClick: applyUpdate },
      duration: 0
    });
  };

  let needsAppNoticeShown = false;
  window.__lyricwaveWebUpdate = ({ status, manual } = {}) => {
    render(status);
    if (status === 'ready') {
      promptReload();
    } else if (manual && status === 'up-to-date') {
      showAlert("You're on the latest version.", 'info');
    } else if (status === 'needs-app-update' && (manual || !needsAppNoticeShown)) {
      needsAppNoticeShown = true;
      showAlert('This update needs a newer app. Download the latest APK from GitHub.', 'warning');
    } else if (manual && status === 'error') {
      showAlert("Couldn't check for updates. Try again later.", 'warning');
    }
  };

  btnCheck?.addEventListener('click', () => {
    if (readInfo().updateReady) {
      applyUpdate();
      return;
    }
    render('checking');
    try { bridge.checkForWebUpdate(); } catch { render(); }
  });

  section?.classList.remove('hidden');
  render();
  // An update finished downloading before this page loaded (e.g. during a previous session).
  if (readInfo().updateReady) promptReload();
}

// =====================================================================
// PWA & Offline Support
// =====================================================================

function setupPWA() {
  if (IS_NATIVE_APP) {
    // Assets are bundled in the APK. A service worker here would bypass the native asset
    // loader and could serve stale files after an app update, so make sure none is active.
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations?.()
        .then((regs) => regs.forEach((r) => r.unregister()))
        .catch(() => {});
    }
    return;
  }
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').then((reg) => {
        // Check for service worker updates immediately on page load
        if (reg) {
          reg.update().catch(() => {});
        }
      }).catch(() => {});
    });

    // Auto refresh when a newly installed service worker takes control
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!refreshing) {
        refreshing = true;
        window.location.reload();
      }
    });
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    btnInstallPwa.classList.remove('hidden');
  });

  btnInstallPwa.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    const choice = await deferredInstallPrompt.userChoice;
    if (choice.outcome === 'accepted') btnInstallPwa.classList.add('hidden');
    deferredInstallPrompt = null;
  });

  window.addEventListener('appinstalled', () => {
    btnInstallPwa.classList.add('hidden');
    deferredInstallPrompt = null;
  });
}

function setupNetworkMonitoring() {
  const updateOnline = () => {
    if (!navigator.onLine) {
      offlineBanner.classList.remove('hidden', 'recovered');
      offlineBannerText.textContent = 'You are offline. Cached lyrics are available.';
    } else {
      if (!offlineBanner.classList.contains('hidden')) {
        offlineBanner.classList.add('recovered');
        offlineBannerText.textContent = 'Back online!';
        setTimeout(() => offlineBanner.classList.add('hidden'), 3000);
      }
    }
  };
  window.addEventListener('online', updateOnline);
  window.addEventListener('offline', updateOnline);
  if (!navigator.onLine) updateOnline();
}

/**
 * Transient toast notifications (replaces the old pinned alert banner).
 * One toast at a time: a new message replaces the visible one. info/success auto-dismiss after 3.5s,
 * warning after 6s, danger stays until closed. Timers pause while the toast is hovered or focused.
 */
const TOAST_ICONS = {
  info: icon('info'),
  success: icon('check'),
  warning: icon('alert'),
  danger: icon('alert')
};
const TOAST_DURATION_MS = { info: 3500, success: 3500, warning: 6000, danger: 0 };
const TOAST_EXIT_MS = 300;
let activeToast = null;
let toastDismissTimer = null;

function clearToastTimer() {
  if (toastDismissTimer) {
    clearTimeout(toastDismissTimer);
    toastDismissTimer = null;
  }
}

/** Remove a toast: animated (.is-out) by default, instantly when it is being replaced. */
function dismissToast(toast, immediate = false) {
  if (!toast) return;
  if (toast === activeToast) {
    activeToast = null;
    clearToastTimer();
  }
  if (immediate) {
    toast.remove();
    return;
  }
  toast.classList.remove('is-in');
  toast.classList.add('is-out');
  setTimeout(() => toast.remove(), TOAST_EXIT_MS);
}

function scheduleToastDismiss(toast, durationMs) {
  clearToastTimer();
  if (!durationMs) return;
  toastDismissTimer = setTimeout(() => dismissToast(toast), durationMs);
}

/**
 * @param {string} message
 * @param {'info'|'success'|'warning'|'danger'} [type]
 * @param {{ action?: { label: string, onClick: () => void }, duration?: number }} [options]
 *   action adds a button to the toast; duration (ms, 0 = stay until dismissed) overrides the default.
 */
function showAlert(message, type = 'info', options = {}) {
  if (!toastRegion) return;
  const kind = Object.prototype.hasOwnProperty.call(TOAST_DURATION_MS, type) ? type : 'info';
  const duration = typeof options.duration === 'number' ? options.duration : TOAST_DURATION_MS[kind];

  if (activeToast) dismissToast(activeToast, true);

  const toast = document.createElement('div');
  toast.className = `toast toast-${kind}`;
  toast.setAttribute('role', kind === 'danger' ? 'alert' : 'status');

  const icon = document.createElement('span');
  icon.className = 'toast-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = TOAST_ICONS[kind];

  const msg = document.createElement('span');
  msg.className = 'toast-msg';
  msg.textContent = String(message ?? '');

  const closeBtn = document.createElement('button');
  closeBtn.className = 'toast-close';
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Dismiss notification');
  closeBtn.innerHTML = '&times;';
  closeBtn.addEventListener('click', () => dismissToast(toast));

  toast.append(icon, msg);
  if (options.action) {
    const actionBtn = document.createElement('button');
    actionBtn.className = 'toast-action';
    actionBtn.type = 'button';
    actionBtn.textContent = options.action.label;
    actionBtn.addEventListener('click', () => {
      dismissToast(toast);
      options.action.onClick();
    });
    toast.append(actionBtn);
  }
  toast.append(closeBtn);

  // Keep the message on screen while the user is reading / interacting with it.
  // Resume only when neither the pointer nor keyboard focus is on it.
  let hovered = false;
  let focused = false;
  const update = () => {
    if (toast !== activeToast) return;
    if (hovered || focused) clearToastTimer();
    else scheduleToastDismiss(toast, duration);
  };
  toast.addEventListener('pointerenter', () => { hovered = true; update(); });
  toast.addEventListener('pointerleave', () => { hovered = false; update(); });
  toast.addEventListener('focusin', () => { focused = true; update(); });
  toast.addEventListener('focusout', (e) => { if (!toast.contains(e.relatedTarget)) { focused = false; update(); } });

  toastRegion.appendChild(toast);
  activeToast = toast;
  void toast.offsetWidth; // commit the start state so the enter transition runs
  toast.classList.add('is-in');
  scheduleToastDismiss(toast, duration);
}

function formatMs(ms) {
  if (!ms || isNaN(ms) || ms < 0) return '0:00';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/** Drop "(Remastered 2011)", "- Live", "feat. X" etc. so the search finds every version. */
function cleanTitleForSearch(title) {
  return String(title || '')
    .replace(/\s*[\(\[].*?[\)\]]/g, '')
    .replace(/\s+-\s+.*$/, '')
    .replace(/\s*(feat\.|ft\.|featuring)\s.*$/i, '')
    .trim() || String(title || '');
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeUrl(url) {
  if (!url || typeof url !== 'string') return '';
  const trimmed = url.trim();
  if (/^(https?:\/\/|data:image\/)/i.test(trimmed)) {
    return trimmed;
  }
  return '';
}

// =====================================================================
// Initialize App
// =====================================================================

async function init() {
  setupPWA();
  setupNativeWebUpdates();
  setupNetworkMonitoring();

  applyTheme(currentTheme);
  applyFontScale(currentFontScale);
  setWordMode(isWordMode);
  setAnimStyle(currentAnimStyle, { persist: false });
  updateOffsetUI();
  renderRecentSongs();

  // Setup Developer Mode Banner (Active ONLY on localhost or with ?dev=1)
  if (isDevMode()) {
    const isConfigured = Boolean(CONFIG.CLIENT_ID && CONFIG.CLIENT_ID !== 'YOUR_SPOTIFY_CLIENT_ID');
    devModeBanner.classList.remove('hidden');

    if (isConfigured) {
      devClientIdStatus.className = 'dev-status-row ok';
      devClientIdStatus.innerHTML = `<span>${icon('check', 'sm')} Client ID: Configured</span>`;
    } else {
      devClientIdStatus.className = 'dev-status-row warn';
      devClientIdStatus.innerHTML = `<span>${icon('alert', 'sm')} Client ID: Unconfigured in config.js</span>`;
    }

    devRedirectStatus.className = 'dev-status-row ok';
    devRedirectStatus.innerHTML = `<span>${icon('check', 'sm')} Redirect URI: ${escapeHtml(CONFIG.REDIRECT_URI)}</span>`;
  } else {
    devModeBanner.classList.add('hidden');
  }

  // Check Spotify callback & auth state
  try {
    const callbackResult = await handleRedirectCallback();
    if (callbackResult.status === 'success') {
      showAlert('Connected to Spotify successfully!', 'success');
      openConnectSpotify();
    } else if (callbackResult.status === 'error') {
      showAlert(callbackResult.error, 'danger');
      openConnectSpotify();
    }
  } catch (err) {
    console.warn('Callback error:', err);
  }

  if (isAuthenticated()) {
    try {
      let profile = getStoredUserProfile() || await fetchUserProfile();
      showSpotifyLoggedIn(profile);
    } catch {
      showSpotifyLoggedOut();
    }
  } else {
    showSpotifyLoggedOut();
  }

  // 6. First-Run Onboarding Hint
  if (firstRunHint && btnDismissFirstRun) {
    const isDismissed = localStorage.getItem(STORAGE_FIRST_RUN_DISMISSED_KEY) === 'true';
    if (!isDismissed) {
      firstRunHint.classList.remove('hidden');
    }
    btnDismissFirstRun.addEventListener('click', () => {
      firstRunHint.classList.add('hidden');
      localStorage.setItem(STORAGE_FIRST_RUN_DISMISSED_KEY, 'true');
    });
  }

  // 7. Share Button: Copies a deep link (?q=artist+title)
  if (btnShareSong) {
    btnShareSong.addEventListener('click', async () => {
      haptic('light');
      closeMoreSheet();
      const track = engine.track;
      if (!track || !track.title) {
        showAlert('No track is currently loaded to share.', 'warning');
        return;
      }
      const artist = track.artist || track.artists || '';
      const query = `${artist} ${track.title}`.trim();
      const shareBase = IS_NATIVE_APP
        ? (CONFIG.PUBLIC_WEB_URL || 'https://lyricwave.pages.dev/')
        : window.location.origin + window.location.pathname;
      const url = new URL(shareBase);
      url.searchParams.set('q', query);
      const shareUrl = url.toString();

      if (navigator.clipboard && navigator.clipboard.writeText) {
        try {
          await navigator.clipboard.writeText(shareUrl);
          showAlert(`Copied share link for "${track.title}"!`, 'info');
        } catch {
          prompt('Copy this share link:', shareUrl);
        }
      } else {
        prompt('Copy this share link:', shareUrl);
      }
    });
  }

  // 8. Deep-Link Query (?q=artist+title) support: opens app on Search with that song loaded
  const urlParams = new URLSearchParams(window.location.search);
  const deepQuery = urlParams.get('q');
  if (deepQuery && deepQuery.trim()) {
    const searchTab = document.getElementById('tabSearch');
    if (searchTab) searchTab.click();
    if (searchInput) {
      searchInput.value = deepQuery.trim();
      btnClearSearch?.classList.remove('hidden');
      searchResults.innerHTML = `
        <div class="search-prompt" role="status">
          <div class="spinner" aria-hidden="true"></div>
          <p>Loading shared song "${escapeHtml(deepQuery)}"...</p>
        </div>
      `;
      try {
        const results = await searchTracks(deepQuery.trim(), 8);
        renderSearchResults(results);
        if (results && results.length > 0) {
          // Select and auto-start first matched track
          engine.connectSource(searchSource);
          searchSource.selectTrack(results[0], true);
        }
      } catch (err) {
        console.warn('Deep query search failed:', err);
      }
    }
  }

  // 9. Restore previously selected tab if saved (e.g. charts, search, mic)
  if (!deepQuery && activeTab) {
    const tabToRestore = document.querySelector(`.source-tab[data-tab="${activeTab}"]`);
    if (tabToRestore && activeTab !== 'mic') {
      tabToRestore.click();
    }
  }

  // 10. User Account Management (Sign Up / Log In)
  setupUserAuth();
}

/** Jump to Connect > Spotify (there is no standalone Spotify tab any more). */
function openConnectSpotify() {
  document.getElementById('tabConnect')?.click();
  switchConnectSubTab('spotify');
}

function setupUserAuth() {
  const btnOpenAuth = document.getElementById('btnOpenAuth');
  const authBackdrop = document.getElementById('authBackdrop');
  const btnCloseAuth = document.getElementById('btnCloseAuth');
  const userAccountBtnLabel = document.getElementById('userAccountBtnLabel');
  
  const authLoggedOutView = document.getElementById('authLoggedOutView');
  const authLoggedInView = document.getElementById('authLoggedInView');
  const authTabLogin = document.getElementById('authTabLogin');
  const authTabSignup = document.getElementById('authTabSignup');
  const authNameGroup = document.getElementById('authNameGroup');
  const authModalTitle = document.getElementById('authHeaderLabel');
  const authErrorMsg = document.getElementById('authErrorMsg');
  const authForm = document.getElementById('authForm');
  const authInputName = document.getElementById('authInputName');
  const authInputEmail = document.getElementById('authInputEmail');
  const authInputPassword = document.getElementById('authInputPassword');
  const btnSubmitAuth = document.getElementById('btnSubmitAuth');
  
  const userProfileInitial = document.getElementById('userProfileInitial');
  const userProfileName = document.getElementById('userProfileName');
  const userProfileEmail = document.getElementById('userProfileEmail');
  const btnUserLogOut = document.getElementById('btnUserLogOut');

  let isSignUpMode = false;

  function updateAuthUI() {
    const user = getCurrentUser();
    if (user) {
      if (userAccountBtnLabel) userAccountBtnLabel.textContent = user.displayName || 'Account';
      authLoggedOutView?.classList.add('hidden');
      authLoggedInView?.classList.remove('hidden');
      if (userProfileInitial) userProfileInitial.textContent = (user.displayName || user.email || 'U')[0].toUpperCase();
      if (userProfileName) userProfileName.textContent = user.displayName || 'User';
      if (userProfileEmail) userProfileEmail.textContent = user.email || '';
    } else {
      if (userAccountBtnLabel) userAccountBtnLabel.textContent = 'Log In';
      authLoggedOutView?.classList.remove('hidden');
      authLoggedInView?.classList.add('hidden');
    }
  }

  function setMode(signUpMode) {
    isSignUpMode = signUpMode;
    authErrorMsg?.classList.add('hidden');
    // Tab look is driven by .active / aria-selected (styled via .auth-tab-btn.active), not inline styles.
    [[authTabLogin, !isSignUpMode], [authTabSignup, isSignUpMode]].forEach(([btn, on]) => {
      if (!btn) return;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    authNameGroup?.classList.toggle('hidden', !isSignUpMode);
    authInputPassword?.setAttribute('autocomplete', isSignUpMode ? 'new-password' : 'current-password');
    if (authModalTitle) authModalTitle.textContent = isSignUpMode ? 'Create LyricWave Account' : 'Log In to LyricWave';
    if (btnSubmitAuth) btnSubmitAuth.textContent = isSignUpMode ? 'Sign Up' : 'Log In';
  }

  const authDialog = authBackdrop?.querySelector('.modal-dialog');

  function openAuth() {
    updateAuthUI();
    authBackdrop?.classList.remove('hidden');
    // Move focus into the dialog: first form field when logged out, the close button otherwise.
    setTimeout(() => {
      const target = getCurrentUser() ? btnCloseAuth : authInputEmail;
      target?.focus();
    }, 50);
  }

  function closeAuth() {
    authBackdrop?.classList.add('hidden');
    btnOpenAuth?.focus();
  }

  btnOpenAuth?.addEventListener('click', openAuth);
  btnCloseAuth?.addEventListener('click', closeAuth);

  authBackdrop?.addEventListener('click', (e) => {
    if (e.target === authBackdrop) closeAuth();
  });

  // Escape closes the dialog even when focus fell back to <body> (e.g. after a disabled submit button).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && authBackdrop && !authBackdrop.classList.contains('hidden')) {
      e.stopPropagation();
      closeAuth();
    }
  });

  // Tab stays inside the dialog (only visible controls count).
  // Bound on document so it also catches Tab when focus has fallen back to <body>.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || !authDialog || !authBackdrop || authBackdrop.classList.contains('hidden')) return;
    const focusables = Array.from(authDialog.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled])'))
      .filter((el) => el.offsetParent !== null);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (!authDialog.contains(document.activeElement)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    } else if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });

  enableTablistKeys(document.querySelector('.auth-tabs'));

  authTabLogin?.addEventListener('click', () => setMode(false));
  authTabSignup?.addEventListener('click', () => setMode(true));

  btnSubmitAuth?.addEventListener('click', async (e) => {
    e.preventDefault();
    if (authErrorMsg) authErrorMsg.classList.add('hidden');
    const email = authInputEmail?.value.trim() || '';
    const password = authInputPassword?.value || '';
    const name = authInputName?.value.trim() || '';

    btnSubmitAuth.disabled = true;
    const origText = btnSubmitAuth.textContent;
    btnSubmitAuth.textContent = isSignUpMode ? 'Creating account...' : 'Logging in...';

    try {
      if (isSignUpMode) {
        const user = await signUp({ name, email, password });
        showAlert(`Welcome to LyricWave, ${user.displayName}!`, 'info');
      } else {
        const user = await logIn({ email, password });
        showAlert(`Welcome back, ${user.displayName}!`, 'info');
      }
      authInputPassword.value = '';
      updateAuthUI();
      closeAuth();
    } catch (err) {
      if (authErrorMsg) {
        authErrorMsg.textContent = err.message;
        authErrorMsg.classList.remove('hidden');
      }
    } finally {
      btnSubmitAuth.disabled = false;
      btnSubmitAuth.textContent = origText;
      // A disabled button drops focus to <body>; keep keyboard users inside the dialog after an error.
      if (!authBackdrop?.classList.contains('hidden')) btnSubmitAuth.focus();
    }
  });

  btnUserLogOut?.addEventListener('click', () => {
    logOut();
    updateAuthUI();
    showAlert('Logged out successfully.', 'info');
  });

  // Delete Account: two taps (no native confirm() dialog, which is unreliable in WebView).
  const btnDeleteAccount = document.getElementById('btnDeleteAccount');
  let deleteArmedTimer = null;
  btnDeleteAccount?.addEventListener('click', async () => {
    if (!deleteArmedTimer) {
      btnDeleteAccount.textContent = 'Tap again to permanently delete';
      deleteArmedTimer = setTimeout(() => {
        deleteArmedTimer = null;
        btnDeleteAccount.textContent = 'Delete Account';
      }, 4000);
      return;
    }
    clearTimeout(deleteArmedTimer);
    deleteArmedTimer = null;
    btnDeleteAccount.textContent = 'Delete Account';
    await deleteCurrentAccount();
    updateAuthUI();
    closeAuth();
    showAlert('Your LyricWave account was deleted from this device.', 'info');
  });

  // Initial check on load
  updateAuthUI();
}

document.addEventListener('DOMContentLoaded', init);

