/**
 * Wiring checks for in-app updates: the app follows this repo's releases, the publish script and
 * the update panel exist, and the notification path is declared in the manifest.
 */

import { readFileSync } from 'node:fs';

let passed = 0;
let failed = 0;
function assert(condition, desc) {
  if (condition) { passed++; console.log(`  ✓ ${desc}`); } else { failed++; console.error(`  ✗ FAIL: ${desc}`); }
}

console.log('--- Testing in-app update wiring ---');

const dir = 'android/app/src/main/';
const updater = readFileSync(`${dir}java/app/lyricwave/twa/WebUpdater.java`, 'utf8');
const job = readFileSync(`${dir}java/app/lyricwave/twa/UpdateCheckJobService.java`, 'utf8');
const main = readFileSync(`${dir}java/app/lyricwave/twa/MainActivity.java`, 'utf8');
const manifest = readFileSync(`${dir}AndroidManifest.xml`, 'utf8');
const publish = readFileSync('scripts/publish-web.mjs', 'utf8');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const html = readFileSync('index.html', 'utf8');
const app = readFileSync('app.js', 'utf8');
const gitignore = readFileSync('.gitignore', 'utf8');

const repo = /const REPO = '([^']+)'/.exec(publish)?.[1];
assert(Boolean(repo) && updater.includes(`github.com/${repo}/releases/download/`), 'the app downloads from the repo the publish script uploads to');
assert(updater.includes('"web-latest"') && updater.includes('"web-test"') && publish.includes("test: 'web-test'"), 'stable and test channels use matching release tags');
assert(pkg.scripts['publish:web'] && pkg.scripts['publish:web:test'], 'npm run publish:web and publish:web:test exist');
assert(gitignore.includes('web-update-private.pem'), 'the signing key is gitignored');
assert(/ACCESS_NETWORK_STATE/.test(manifest), 'manifest declares network state (the job needs it, or the app crashes on launch)');
assert(/POST_NOTIFICATIONS/.test(manifest) && /RECEIVE_BOOT_COMPLETED/.test(manifest), 'manifest allows notifications and boot-time scheduling');
assert(/UpdateCheckJobService[\s\S]*BIND_JOB_SERVICE/.test(manifest), 'background update job is declared');
assert(job.includes('EXTRA_APPLY_WEB_UPDATE') && main.includes('EXTRA_APPLY_WEB_UPDATE') && main.includes('applyUpdateFromNotification'), 'tapping the notification applies the update');
assert(/shouldNotify/.test(job) && /markNotified/.test(job), 'one notification per downloaded version');
assert(/rollbackToBuiltIn/.test(updater) && /rollbackWebUpdate/.test(main), 'roll back is available');
assert(html.includes('id="secUpdates"') && html.includes('id="updChannel"') && html.includes('id="btnUpdRollback"'), 'update admin panel markup exists');
assert(app.includes('function setupUpdateAdminPanel') && app.includes('getUpdateAdminInfo'), 'update admin panel logic exists');
const versionCode = Number(/versionCode\s+(\d+)/.exec(readFileSync('android/app/build.gradle', 'utf8'))?.[1]);
assert(versionCode >= 6, 'APK version was bumped for the new updater');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
