#!/usr/bin/env node
/**
 * One-command publish of the web part of the Android app (no new APK needed).
 *
 *   npm run publish:web         stable channel (release tag web-latest); runs the tests first
 *   npm run publish:web:test    test channel (release tag web-test); skips the tests
 *
 * It copies the web files into the Android assets, builds + signs the bundle with
 * web-update-private.pem, and uploads it to the GitHub Release of the repo the app follows.
 * Installed apps (1.4.0 and newer) find it within about 30 minutes, or straight away through
 * Settings > App updates > Check, and show an "update ready" notification.
 *
 * Needs the GitHub CLI signed in as an account that can write to the repo (`gh auth status`).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'svimran47/LyricWave';
const CHANNELS = { stable: 'web-latest', test: 'web-test' };
const KEY_PATH = join(ROOT, 'web-update-private.pem');
const OUT = join(ROOT, 'dist', 'web-update');

const channel = process.argv[2] || 'stable';
const tag = CHANNELS[channel];
if (!tag) {
  console.error('usage: node scripts/publish-web.mjs [stable|test]');
  process.exit(2);
}

function run(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' && cmd === 'npm', ...options });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed`);
}

try {
  if (!existsSync(KEY_PATH)) {
    throw new Error('web-update-private.pem is missing. Run: node scripts/web-update.mjs keygen (then rebuild the APK once).');
  }
  if (channel === 'stable') {
    console.log('Running the tests before publishing to stable...');
    run('npm', ['test']);
  }

  console.log('Syncing the Android assets...');
  run('node', ['scripts/web-update.mjs', 'sync']);

  // Seconds since 1970: always newer than the last publish and than the version baked into the APK.
  const version = String(Math.floor(Date.now() / 1000));
  console.log(`Building the signed bundle (version ${version})...`);
  run('node', ['scripts/web-update.mjs', 'build', '--require-signature'], {
    env: { ...process.env, WEB_VERSION: version, WEB_UPDATE_PRIVATE_KEY: readFileSync(KEY_PATH, 'utf8') }
  });

  const gh = (args) => execFileSync('gh', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] }).toString();
  let exists = true;
  try {
    gh(['release', 'view', tag, '-R', REPO]);
  } catch {
    exists = false;
  }
  if (!exists) {
    const label = channel === 'stable' ? 'LyricWave in-app web update (stable)' : 'LyricWave in-app web update (test)';
    gh(['release', 'create', tag, '-R', REPO, '--prerelease', '--title', label,
      '--notes', 'Signed web bundle downloaded by the LyricWave Android app. Not meant to be installed by hand.']);
  }

  // The manifest goes last: the app reads it first and checks the zip against it.
  for (const file of ['web-bundle.zip', 'web-update.sig', 'web-update.properties']) {
    gh(['release', 'upload', tag, join(OUT, file), '-R', REPO, '--clobber']);
  }
  console.log(`\nPublished ${channel} update v${version} to https://github.com/${REPO}/releases/tag/${tag}`);
  console.log('Open the app: Settings > App updates > Check, or wait for the notification.');
} catch (e) {
  console.error(`\nerror: ${e.message}`);
  process.exit(1);
}
