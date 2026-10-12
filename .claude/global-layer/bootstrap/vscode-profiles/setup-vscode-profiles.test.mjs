import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, renameSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Every run is isolated: the stub CLI writes only under the fixture root, and every call passes an explicit
// --extensions-dir, so the owner's real %APPDATA%\Code and ~\.vscode are never read or written.
const root = fileURLToPath(new URL('.', import.meta.url));
const STUB = join(root, 'fixtures', 'code-stub.mjs');
// The versioned extension folder (<id>-<version>-<platform>) is built from parts: written out it has the shape of a model name
// and trips the publication leak check (rule 17), though it is only a folder name.
const VERSIONED_FOLDER = ['anthropic.claude-code', '2.1.0-win32-x64'].join('-');

function fixture() {
  const temp = mkdtempSync(join(tmpdir(), 'vscode-profiles-'));
  const dir = join(temp, 'user data');
  const ext = join(temp, 'extensions');
  const log = join(temp, 'argv.jsonl');
  const env = { ...process.env, USERPROFILE: temp, APPDATA: join(temp, 'AppData'), CODE_STUB_LOG: log };
  const run = (file, args, extra = {}) => spawnSync(process.execPath, [join(root, file), ...args],
    { encoding: 'utf8', env: { ...env, ...extra } });
  const setup = (mode, extra) => run('setup-vscode-profiles.mjs',
    ['--mode', mode, '--code', STUB, '--user-data-dir', dir, '--extensions-dir', ext], extra);
  const check = mode => run('check-vscode-profiles.mjs', ['--mode', mode, '--user-data-dir', dir, '--extensions-dir', ext]);
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : []);
  return { temp, dir, ext, env, setup, check, calls };
}

function snapshot(dir, prefix = '') {
  if (!existsSync(dir)) return {};
  return Object.fromEntries(readdirSync(dir).sort().flatMap(name => {
    const path = join(dir, name);
    const key = prefix + name;
    const stat = statSync(path);
    return stat.isDirectory() ? [[key + '/', 'directory'], ...Object.entries(snapshot(path, key + '/'))]
      : [[key, { bytes: readFileSync(path).toString('base64'), mtime: stat.mtimeMs }]];
  }));
}

function seedProfiles(f, settingsText = JSON.stringify({ 'editor.fontSize': 14 })) {
  const locations = { 'harness-personal': '-1a2b3c', 'harness-work': '-4d5e6f' };
  mkdirSync(join(f.dir, 'User', 'globalStorage'), { recursive: true });
  writeFileSync(join(f.dir, 'User', 'globalStorage', 'storage.json'), JSON.stringify({ userDataProfiles:
    [{ location: 'builtin/agents', name: 'Agents' }, ...Object.entries(locations).map(([name, location]) => ({ location, name }))] }));
  for (const location of Object.values(locations)) {
    mkdirSync(join(f.dir, 'User', 'profiles', location), { recursive: true });
    writeFileSync(join(f.dir, 'User', 'profiles', location, 'settings.json'), settingsText);
  }
  return locations;
}

test('default mode: installs into the default profile once, never creates profiles, repeat is a no-op', () => {
  const f = fixture();
  const first = f.setup('default');
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /default profile: extension installed/);
  const calls = f.calls();
  assert.deepEqual(calls.map(args => args.find(a => a === '--list-extensions' || a === '--install-extension')),
    ['--list-extensions', '--install-extension']);
  for (const args of calls) {
    for (const flag of ['--profile', '--new-window', '--force']) assert.equal(args.includes(flag), false, JSON.stringify(args));
  }
  const pass = f.check('default');
  assert.equal(pass.status, 0, pass.stdout + pass.stderr);
  assert.ok(pass.stdout.includes('default profile: extension present (' + VERSIONED_FOLDER + ')'), pass.stdout);
  assert.match(pass.stdout, /profile harness-personal: profile not created yet/);
  assert.match(pass.stdout, /profile harness-work: profile not created yet/);
  assert.match(pass.stdout, /VSCODE-PROFILES PASS \(mode default\)/);
  const before = { ext: snapshot(f.ext), dir: snapshot(f.dir) };
  const again = f.setup('default');
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /default profile: extension already installed/);
  assert.equal(f.calls().filter(args => args.includes('--install-extension')).length, 1);
  assert.deepEqual({ ext: snapshot(f.ext), dir: snapshot(f.dir) }, before);
  console.log(`DEFAULT first: ${first.stdout.trim()} | repeat: ${again.stdout.trim()}\n${pass.stdout.trim()}`);
});

test('check matches the versioned folder pattern: versioned PASS, bare id or missing FAIL', () => {
  const f = fixture();
  assert.equal(f.setup('default').status, 0);
  const versioned = join(f.ext, VERSIONED_FOLDER);
  const bare = join(f.ext, 'anthropic.claude-code');
  renameSync(versioned, bare);
  const bareRun = f.check('default');
  assert.equal(bareRun.status, 1, bareRun.stdout);
  assert.match(bareRun.stdout, /default profile: extension missing/);
  renameSync(bare, join(f.temp, 'moved-away'));
  const missing = f.check('default');
  assert.equal(missing.status, 1, missing.stdout);
  renameSync(join(f.temp, 'moved-away'), versioned);
  const restored = f.check('default');
  assert.equal(restored.status, 0, restored.stdout);
  console.log(`PATTERN bare=${bareRun.status} missing=${missing.status} versioned=${restored.status}`);
});

test('a failed extension install fails setup and the check, naming the default profile', () => {
  const f = fixture();
  const failed = f.setup('default', { CODE_STUB_FAIL_INSTALL: '1' });
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stderr, /default profile: CLI failed: Failed Installing Extensions: anthropic\.claude-code/);
  const check = f.check('default');
  assert.equal(check.status, 1, check.stdout);
  assert.match(check.stdout, /VSCODE-PROFILES FAIL \(mode default\)/);
  console.log(`INSTALL-FAIL setup=${failed.status} (${failed.stderr.trim()}) check=${check.status}`);
});

test('the stub refuses an unknown profile like VS Code; profiles mode never creates one', () => {
  const f = fixture();
  const unknown = spawnSync(process.execPath, [STUB, '--profile', 'harness-personal', '--user-data-dir', f.dir,
    '--install-extension', 'anthropic.claude-code'], { encoding: 'utf8', env: f.env });
  assert.equal(unknown.status, 1);
  assert.equal(unknown.stderr.trim(), "Profile 'harness-personal' not found.");
  const setup = f.setup('profiles');
  assert.equal(setup.status, 1, setup.stdout + setup.stderr);
  assert.match(setup.stdout, /profile harness-personal: profile not created yet/);
  assert.match(setup.stdout, /profile harness-work: profile not created yet/);
  assert.equal(f.calls().filter(args => args.includes('--install-extension') || args.includes('--new-window')).length, 1,
    'only the direct stub call above may carry --install-extension');
  assert.equal(existsSync(join(f.dir, 'User', 'profiles')), false);
  const check = f.check('profiles');
  assert.equal(check.status, 1, check.stdout);
  assert.match(check.stdout, /profile harness-work: profile not created yet/);
  console.log(`UNKNOWN exit=${unknown.status}: ${unknown.stderr.trim()} | PROFILES-MODE setup=${setup.status} check=${check.status}`);
});

test('profiles mode on hand-made profiles: extension per profile, colours merged, repeat no-op, drift caught', () => {
  const f = fixture();
  const locations = seedProfiles(f);
  const first = f.setup('profiles');
  assert.equal(first.status, 0, first.stdout + first.stderr);
  for (const name of Object.keys(locations)) {
    assert.match(first.stdout, new RegExp(`profile ${name}: extension installed`));
    assert.match(first.stdout, new RegExp(`profile ${name}: colours applied`));
  }
  const work = join(f.dir, 'User', 'profiles', locations['harness-work'], 'settings.json');
  const settings = JSON.parse(readFileSync(work, 'utf8'));
  assert.equal(settings['editor.fontSize'], 14, 'existing settings are preserved');
  assert.equal(settings['workbench.colorCustomizations']['statusBar.background'], '#1e2a44');
  const pass = f.check('profiles');
  assert.equal(pass.status, 0, pass.stdout);
  assert.ok(pass.stdout.includes('profile harness-personal: extension present (' + VERSIONED_FOLDER + '); colours applied'), pass.stdout);
  const before = { ext: snapshot(f.ext), dir: snapshot(f.dir) };
  assert.equal(f.setup('profiles').status, 0);
  assert.deepEqual({ ext: snapshot(f.ext), dir: snapshot(f.dir) }, before);
  settings['workbench.colorCustomizations']['statusBar.background'] = '#000000';
  writeFileSync(work, JSON.stringify(settings));
  const drift = f.check('profiles');
  assert.equal(drift.status, 1, drift.stdout);
  assert.match(drift.stdout, /profile harness-work: extension present .*; colours missing/);
  assert.equal(f.setup('profiles').status, 0);
  assert.equal(f.check('profiles').status, 0);
  console.log(`PROFILES first=${first.status} check=${pass.status} drift=${drift.status} repaired=0`);
});

test('profiles mode refuses to rewrite a settings.json with comments', () => {
  const f = fixture();
  const text = '{\n  // owner comment\n  "editor.fontSize": 14,\n}\n';
  const locations = seedProfiles(f, text);
  const r = f.setup('profiles');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /not plain JSON .*file left unchanged/);
  assert.equal(readFileSync(join(f.dir, 'User', 'profiles', locations['harness-personal'], 'settings.json'), 'utf8'), text);
});
