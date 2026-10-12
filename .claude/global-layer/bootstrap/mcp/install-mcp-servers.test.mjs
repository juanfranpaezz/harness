import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkAge, connectionStatus, minimumAgeMs, validateServers } from './install-mcp-servers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures');
const script = path.join(here, 'install-mcp-servers.mjs');
const stub = path.join(fixtures, 'claude-stub.mjs');
const servers = JSON.parse(fs.readFileSync(path.join(here, 'servers.json'), 'utf8'));
test('ensure reinstalls partial directories and preserves marked installations', () => {
  for (const partial of ['empty', 'unpacked']) {
    const home = scenario(`partial ${partial}`);
    const target = path.join(home, '.mcp-servers/playwright');
    fs.mkdirSync(target, { recursive: true });
    if (partial === 'unpacked') write(path.join(target, 'package.json'), JSON.stringify({ name: '@playwright/mcp', version: '0.0.82' }));
    const invoke = () => spawnSync(process.execPath, [script, '--home', home, '--registry', fixtures, '--claude', stub, '--ensure'], { encoding: 'utf8' });
    const repaired = invoke();
    assert.equal(repaired.status, 0, repaired.stdout + repaired.stderr);
    assert.match(repaired.stdout, /partial.*reinstall/i);
    assert.ok(fs.statSync(path.join(target, '.install-complete')).isFile());
    write(path.join(target, 'keep.txt'), 'keep');
    const kept = invoke();
    assert.equal(kept.status, 0, kept.stdout + kept.stderr);
    assert.equal(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'keep');
    assert.doesNotMatch(kept.stdout, /partial.*reinstall/i);
  }
});
// The offline registry and tarballs are generated here, never committed: the npm integrity strings
// look like secrets to the pre-commit scan. The generator is deterministic and refuses to overwrite,
// so it runs only when one of the three generated files is missing.
const generated = ['registry.json', 'playwright-mcp-0.0.82.tgz', 'playwright-mcp-0.0.83.tgz'];
if (!generated.every(name => fs.existsSync(path.join(fixtures, name)))) {
  const built = spawnSync(process.execPath, [path.join(fixtures, 'build-registry.mjs')], {
    encoding: 'utf8', timeout: 60_000, windowsHide: true,
  });
  assert.equal(built.status, 0, built.stderr || built.error?.message);
}
const registry = JSON.parse(fs.readFileSync(path.join(fixtures, 'registry.json'), 'utf8'));
// Retain evidence under the explicitly allowed fixture tree; do not delete files.
const runs = path.join(fixtures, 'runs');
fs.mkdirSync(runs, { recursive: true });
const runRoot = fs.mkdtempSync(path.join(runs, 'offline-'));
function write(file, contents) {
  assert.equal(fs.existsSync(file), false, 'test fixtures must never overwrite existing files');
  fs.writeFileSync(file, contents, { flag: 'wx' });
}
function scenario(name, mode) {
  const home = path.join(runRoot, name);
  fs.mkdirSync(home);
  if (mode) write(path.join(home, 'claude-mode.json'), JSON.stringify(mode));
  return home;
}
function cli(home, options = {}) {
  return spawnSync(process.execPath, [options.script || script, '--home', home,
    '--registry', options.registry || fixtures, '--claude', stub], {
    encoding: 'utf8', timeout: 60_000, windowsHide: true,
  });
}
function calls(home) {
  const file = path.join(home, 'claude-calls.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse) : [];
}
function alternateManifest(name, mutate) {
  const dir = scenario(name);
  const manifest = structuredClone(servers);
  mutate(manifest);
  write(path.join(dir, 'servers.json'), JSON.stringify(manifest));
  const alternate = path.join(dir, 'install-mcp-servers.mjs');
  write(alternate, fs.readFileSync(script));
  return alternate;
}
function alternateRegistry(name, mutate) {
  const dir = scenario(name);
  const metadata = structuredClone(registry);
  mutate(metadata);
  write(path.join(dir, 'registry.json'), JSON.stringify(metadata));
  for (const release of Object.values(registry.packages['@playwright/mcp'].versions)) {
    write(path.join(dir, release.tarball), fs.readFileSync(path.join(fixtures, release.tarball)));
  }
  return dir;
}

test('pinned CLI installs the package and records the exact absolute node registration, then list', () => {
  const home = scenario('home with spaces');
  const result = cli(home);
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(result.stdout.trim(), 'playwright: Connected');
  const installed = path.join(home, '.mcp-servers/playwright');
  const pkg = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'));
  assert.equal(pkg.name, '@playwright/mcp');
  assert.equal(pkg.version, '0.0.82');
  assert.deepEqual(calls(home), [
    ['mcp', 'add', 'playwright', '--scope', 'user', '--', 'node', path.join(installed, 'cli.js'), '--isolated'],
    ['mcp', 'list'],
  ]);
  const entry = spawnSync(process.execPath, [path.join(installed, 'cli.js')], { encoding: 'utf8' });
  assert.equal(entry.status, 0);
  assert.match(entry.stdout, /Synthetic offline MCP fixture 0\.0\.82/);
});

test('an npx form planted in servers.json is rejected before installation or Claude calls', () => {
  const alternate = alternateManifest('npx manifest', manifest => {
    manifest[0].claudeAdd = ['mcp', 'add', 'playwright', '--', 'npx', '-y', '@playwright/mcp@0.0.82'];
  });
  const home = scenario('npx rejected');
  const result = cli(home, { script: alternate });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /npx is rejected/);
  assert.deepEqual(calls(home), []);
  assert.equal(fs.existsSync(path.join(home, '.mcp-servers')), false);
});

test('fixture young release is refused, using the publication date from registry metadata', () => {
  const alternate = alternateManifest('young manifest', manifest => { manifest[0].version = '0.0.83'; });
  // The fixed fixture is seven days old at the task date. Move only the clock-relative
  // registry copy for this CLI test so reruns keep exercising the same refusal.
  const young = alternateRegistry('young registry', metadata => {
    metadata.packages['@playwright/mcp'].time['0.0.83'] = new Date(Date.now() - minimumAgeMs / 2).toISOString();
  });
  const home = scenario('young rejected');
  const result = cli(home, { script: alternate, registry: young });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /0\.0\.83 must be at least 14 days old/);
  assert.deepEqual(calls(home), []);
  assert.equal(fs.existsSync(path.join(home, '.mcp-servers')), false);
});

test('age gate accepts exactly 14 days and rejects one millisecond younger, future and missing dates', () => {
  const now = Date.parse('2026-10-11T00:00:00Z');
  const server = servers[0];
  const metadata = timestamp => ({ time: { [server.version]: timestamp } });
  assert.doesNotThrow(() => checkAge(metadata(new Date(now - minimumAgeMs).toISOString()), server, now));
  for (const timestamp of [new Date(now - minimumAgeMs + 1).toISOString(), new Date(now + 1).toISOString()]) {
    assert.throws(() => checkAge(metadata(timestamp), server, now), /at least 14 days/);
  }
  assert.throws(() => checkAge({}, server, now), /missing or invalid/);
  assert.throws(() => checkAge(metadata('invalid'), server, now), /missing or invalid/);
  assert.throws(() => checkAge(registry.packages['@playwright/mcp'], { ...server, version: '0.0.83' }, now), /at least 14 days/);
});

test('manifest validation accepts the pin and refuses floating versions and escaping entrypoints', () => {
  assert.doesNotThrow(() => validateServers(servers));
  for (const version of ['latest', '^0.0.82', '0.0.82-beta.1']) {
    assert.throws(() => validateServers([{ ...servers[0], version }]), /exact stable pinned version/);
  }
  assert.throws(() => validateServers([{ ...servers[0], entrypoint: '../outside.js' }]), /Unsafe relative path/);
});

for (const [name, mode, message] of [
  ['disconnected', { disconnected: true }, /Failed to connect/],
  ['missing', { missing: true }, /server missing or ambiguous/],
  ['add failure', { addFails: true }, /Fixture registration failed/],
  ['list failure', { listFails: true }, /Fixture list failed/],
]) {
  test(`CLI reports ${name} per server and exits nonzero`, () => {
    const home = scenario(name, mode);
    const result = cli(home);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /playwright: Failed:/);
    assert.match(result.stdout, message);
    assert.deepEqual(calls(home).at(-1), ['mcp', 'list']);
  });
}

test('existing installation is preserved and rerun refuses to overwrite it', () => {
  const home = scenario('existing installation');
  const target = path.join(home, '.mcp-servers/playwright');
  fs.mkdirSync(target, { recursive: true });
  write(path.join(target, 'sentinel.txt'), 'preserve this installation');
  const result = cli(home);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /target already exists; refusing to overwrite/);
  assert.equal(fs.readFileSync(path.join(target, 'sentinel.txt'), 'utf8'), 'preserve this installation');
  assert.deepEqual(calls(home), []);
});

test('a planted integrity mismatch prevents unpacking and registration', () => {
  const altered = alternateRegistry('bad integrity registry', metadata => {
    metadata.packages['@playwright/mcp'].versions['0.0.82'].integrity = `sha512-${Buffer.alloc(64).toString('base64')}`;
  });
  const home = scenario('integrity rejected');
  const result = cli(home, { registry: altered });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /registry integrity mismatch/);
  assert.deepEqual(calls(home), [['mcp', 'list']]);
  assert.equal(fs.existsSync(path.join(home, '.mcp-servers/playwright/cli.js')), false);
});

test('a tarball with the wrong version is rejected even with valid registry integrity', () => {
  const altered = alternateRegistry('wrong package registry', metadata => {
    metadata.packages['@playwright/mcp'].versions['0.0.82'] = metadata.packages['@playwright/mcp'].versions['0.0.83'];
  });
  const home = scenario('wrong package rejected');
  const result = cli(home, { registry: altered });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Unpacked package does not match pin/);
  assert.deepEqual(calls(home), [['mcp', 'list']]);
});

test('connection check requires the exact server line and final Connected status', () => {
  assert.equal(connectionStatus('playwright: node /fixture/cli.js - ✓ Connected', 'playwright'), 'Connected');
  for (const output of ['other: node /fixture/cli.js - ✓ Connected',
    'playwright: node /fixture/cli.js - Not Connected',
    'playwright: node /Connected/cli.js - Failed to connect',
    'playwright: node /fixture/cli.js - Disconnected',
    'playwright: node /fixture/cli.js - ✓ Connected\nplaywright: duplicate - ✓ Connected']) {
    assert.match(connectionStatus(output, 'playwright'), /^Failed:/);
  }
});

test('CLI requires an explicit home and rejects unknown options', () => {
  for (const args of [[], ['--unknown', 'value']]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--home is required|Usage:/);
  }
});

test('real CLI status glyphs pass and negative status markers always fail', () => {
  for (const status of ['✔ Connected', '✓ Connected', 'Connected', '\x1b[32m✔ Connected\x1b[0m']) {
    assert.equal(connectionStatus(`playwright: node fixture.js - ${status}`, 'playwright'), 'Connected');
  }
  for (const status of ['✗ Failed to connect', '✗ Connected', 'Error: ✔ Connected', 'Failed: Connected']) {
    assert.match(connectionStatus(`playwright: node fixture.js - ${status}`, 'playwright'), /^Failed:/);
  }
});

test('config routing, check-only mode and repair preserve installed packages', () => {
  const home = scenario('registration repair');
  const config = path.join(home, 'separate config');
  write(path.join(home, 'claude-mode.json'), JSON.stringify({ configDir: config }));
  const invoke = extra => spawnSync(process.execPath, [script, '--home', home, '--config-dir', config,
    '--registry', fixtures, '--claude', stub, ...extra], { encoding: 'utf8' });
  const missing = invoke(['--check']);
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(missing.stdout, /playwright: Failed: server missing/);
  assert.deepEqual(calls(home), [['mcp', 'list']]);
  const installed = invoke(['--ensure']);
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  const target = path.join(home, '.mcp-servers/playwright');
  const before = fs.readFileSync(path.join(target, 'cli.js'));
  fs.renameSync(path.join(config, 'claude-registrations.jsonl'), path.join(config, 'registration.withheld'));
  const repaired = invoke(['--ensure']);
  assert.equal(repaired.status, 0, repaired.stdout + repaired.stderr);
  assert.deepEqual(fs.readFileSync(path.join(target, 'cli.js')), before);
  assert.equal(invoke(['--check']).status, 0);
  const adds = calls(home).filter(args => args[1] === 'add').length;
  assert.equal(invoke(['--ensure']).status, 0);
  assert.equal(calls(home).filter(args => args[1] === 'add').length, adds);
  fs.writeFileSync(path.join(home, 'claude-mode.json'), JSON.stringify({ configDir: config, disconnected: true }));
  assert.equal(invoke(['--ensure']).status, 1);
  assert.equal(calls(home).filter(args => args[1] === 'add').length, adds);
});

test('Windows resolves a bare claude.cmd and honors an explicit shim path containing spaces', { skip: process.platform !== 'win32' }, () => {
  for (const explicit of [false, true]) {
    const home = scenario(`windows shim ${explicit}`);
    const bin = path.join(home, 'bin with spaces');
    fs.mkdirSync(bin);
    const shim = path.join(bin, 'claude.cmd');
    write(shim, `@echo off\r\n"${process.execPath}" "${stub}" %*\r\nexit /b %errorlevel%\r\n`);
    const result = spawnSync(process.execPath, [script, '--home', home, '--registry', fixtures,
      ...(explicit ? ['--claude', shim] : [])], {
      encoding: 'utf8', env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(calls(home).at(-1), ['mcp', 'list']);
    assert.equal(calls(home)[0][7], path.join(home, '.mcp-servers/playwright/cli.js'));
  }
});
