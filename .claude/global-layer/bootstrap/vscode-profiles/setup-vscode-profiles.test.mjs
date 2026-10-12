import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('.', import.meta.url));
function run(file, args) {
  return spawnSync(process.execPath, [join(root, file), ...args], { encoding: 'utf8' });
}
function snapshot(dir, prefix = '') {
  return Object.fromEntries(readdirSync(dir).sort().flatMap(name => {
    const path = join(dir, name);
    const key = prefix + name;
    const stat = statSync(path);
    return stat.isDirectory() ? [[key + '/', 'directory'], ...Object.entries(snapshot(path, key + '/'))]
      : [[key, { bytes: readFileSync(path).toString('base64'), mtime: stat.mtimeMs }]];
  }));
}

test('stub setup, unchanged repeat, missing extension fails and setup repairs it', () => {
  const temp = mkdtempSync(join(tmpdir(), 'vscode-profiles-'));
  const dir = join(temp, 'user data');
  const stub = join(temp, 'code stub.mjs');
  const log = join(temp, 'argv.jsonl');
  writeFileSync(stub, `import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const value = flag => args[args.indexOf(flag) + 1];
mkdirSync(join(value('--extensions-dir'), value('--install-extension')), { recursive: true });
`);
  const setupArgs = ['--code', stub, '--user-data-dir', dir];
  const checkArgs = ['--user-data-dir', dir];
  const first = run('setup-vscode-profiles.mjs', setupArgs);
  assert.equal(first.status, 0, first.stderr);
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls, ['harness-personal', 'harness-work'].map(name => [
    '--profile', name, '--install-extension', 'anthropic.claude-code', '--force',
    '--user-data-dir', dir, '--extensions-dir', join(dir, `extensions-${name}`)
  ]));
  const pass = run('check-vscode-profiles.mjs', checkArgs);
  assert.equal(pass.status, 0, pass.stdout + pass.stderr);
  assert.match(pass.stdout, /profile harness-personal: PASS/);
  assert.match(pass.stdout, /profile harness-work: PASS/);
  assert.match(pass.stdout, /VSCODE-PROFILES PASS/);
  const before = snapshot(dir);
  assert.equal(run('setup-vscode-profiles.mjs', setupArgs).status, 0);
  assert.deepEqual(snapshot(dir), before);
  // Reversibly remove the folder from the checked location; retain all files.
  const extension = join(dir, 'extensions-harness-work', 'anthropic.claude-code');
  renameSync(extension, join(temp, 'removed-work-extension'));
  const fail = run('check-vscode-profiles.mjs', checkArgs);
  assert.equal(fail.status, 1, fail.stdout + fail.stderr);
  assert.match(fail.stdout, /profile harness-personal: PASS/);
  assert.match(fail.stdout, /profile harness-work: FAIL extension folder missing/);
  assert.match(fail.stdout, /VSCODE-PROFILES FAIL/);
  assert.equal(run('setup-vscode-profiles.mjs', setupArgs).status, 0);
  assert.deepEqual(snapshot(dir), before);
  assert.equal(run('check-vscode-profiles.mjs', checkArgs).status, 0);
});
