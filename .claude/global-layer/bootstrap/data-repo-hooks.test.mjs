import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('./data-repo-hooks.mjs', import.meta.url));
const python = process.env.DATA_HOOKS_TEST_PYTHON || (process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA, 'Programs/Python/Python313/python.exe') : 'python3');

test('fresh repository hooks use a default policy without a whitelist file', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-data-hooks-'));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(repo, 'absent-config'),
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', GIT_TERMINAL_PROMPT: '0' };
  const invoke = (exe, args) => spawnSync(exe, args, { cwd: repo, env, encoding: 'utf8' });
  const ok = (exe, args) => {
    const r = invoke(exe, args);
    assert.equal(r.status, 0, r.stdout + r.stderr);
  };
  ok('git', ['init', '--quiet', '--template=']);
  ok(process.execPath, [script, 'install', '--data-repo', repo, '--python', python]);
  for (const file of ['personal-terms.txt', 'ceo-model/ceo-model.md', 'memory/note.md', 'README.md', '.gitignore']) {
    const target = path.join(repo, file);
    assert.equal(fs.existsSync(target), false);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'Synthetic fixture data\n', { flag: 'wx' });
  }
  ok('git', ['add', '--all']);
  ok('git', ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Fresh data fixture']);
  fs.mkdirSync(path.join(repo, 'tools'));
  fs.writeFileSync(path.join(repo, 'tools/x.py'), '# Synthetic script\n', { flag: 'wx' });
  ok('git', ['add', 'tools/x.py']);
  const blocked = invoke('git', ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Forbidden fixture']);
  assert.equal(blocked.status, 1, blocked.stdout + blocked.stderr);
  assert.match(blocked.stdout + blocked.stderr, /PATH-NOT-WHITELISTED.*tools\/x.py/);
});

test('installed hooks block forbidden commits and outgoing history; check detects either missing hook', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "data hooks ' fixture-"));
  const repo = path.join(root, 'data');
  fs.mkdirSync(repo);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'no-config'),
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', GIT_TERMINAL_PROMPT: '0' };
  function command(exe, args, expected = 0) {
    const result = spawnSync(exe, args, { cwd: repo, env, encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, expected, result.stdout + result.stderr);
    return result.stdout + result.stderr;
  }
  const git = (...args) => command('git', args);
  const installer = (action, expected = 0, extra = []) => command(process.execPath,
    [script, action, '--data-repo', repo, ...extra], expected);
  git('init', '--quiet', '--template=');
  git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(repo, 'data-whitelist.json'), JSON.stringify(['data-whitelist.json', 'preferences.json']));
  fs.writeFileSync(path.join(repo, 'preferences.json'), '{"language":"en"}\n');
  console.log(installer('install', 0, ['--python', python]).trim());
  assert.match(installer('check'), /DATA-HOOKS PASS/);
  const hooks = path.join(repo, '.git/hooks');
  for (const name of ['pre-commit', 'pre-push']) {
    assert.ok(!fs.readFileSync(path.join(hooks, name), 'utf8').includes('\r'));
  }
  // The non-whitelisted-path case comes from data_repo_gate.test.py.
  fs.writeFileSync(path.join(repo, 'unexpected.txt'), 'Synthetic data\n');
  git('add', '--all');
  const blocked = command('git', ['commit', '--quiet', '-m', 'Forbidden fixture'], 1);
  assert.match(blocked, /PATH-NOT-WHITELISTED "unexpected.txt"/);
  console.log('git commit forbidden exit=1: ' + blocked.trim());
  git('rm', '--cached', 'unexpected.txt');
  git('commit', '--quiet', '-m', 'Clean fixture');
  console.log('git commit clean exit=0');
  assert.deepEqual(git('ls-files').trim().split(/\r?\n/).sort(), ['data-whitelist.json', 'preferences.json']);
  const remote = path.join(root, 'remote.git');
  git('init', '--bare', '--quiet', '--template=', remote);
  git('push', remote, 'HEAD:refs/heads/fixture');
  console.log('git push clean exit=0');
  // Bypass only to plant forbidden outgoing history for the real pre-push hook.
  git('add', 'unexpected.txt');
  git('-c', 'core.hooksPath=' + path.join(root, 'disabled'), 'commit', '--quiet', '-m', 'Forbidden history');
  const push = command('git', ['push', remote, 'HEAD:refs/heads/fixture'], 1);
  assert.match(push, /PATH-NOT-WHITELISTED "unexpected.txt"/);
  console.log('git push forbidden exit=1: ' + push.split(/\r?\n/).find(line => line.includes('PATH-NOT-WHITELISTED')));
  for (const name of ['pre-commit', 'pre-push']) {
    fs.unlinkSync(path.join(hooks, name));
    const failure = installer('check', 1);
    assert.match(failure, /DATA-HOOKS FAIL/);
    console.log('check missing ' + name + ' exit=1: DATA-HOOKS FAIL');
    installer('install', 0, ['--python', python]);
    assert.match(installer('check'), /DATA-HOOKS PASS/);
    console.log('check restored ' + name + ' exit=0: DATA-HOOKS PASS');
  }
  assert.match(installer('uninstall'), /DATA-HOOKS PASS uninstalled/);
  assert.match(installer('check', 1), /DATA-HOOKS FAIL/);
  // Preserve fixtures for independent inspection; all are outside the data tree.
});
