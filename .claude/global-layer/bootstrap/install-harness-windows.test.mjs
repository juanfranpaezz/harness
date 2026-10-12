import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.resolve(HERE, '../../..');
const SCRIPT = path.join(HERE, 'install-harness-windows.ps1');
const SHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const windows = process.platform === 'win32';
const run = (command, args, env, cwd) => spawnSync(command, args, {
  env, cwd, encoding: 'utf8', timeout: 180000, maxBuffer: 16 << 20, windowsHide: true,
});
const output = r => `${r.stdout || ''}${r.stderr || ''}`;
const lastLine = r => r.stdout.trimEnd().split(/\r?\n/).at(-1);
function write(file, content) {
  assert.equal(fs.existsSync(file), false, `Fixture must be new: ${file}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { flag: 'wx' });
}

function fixture(terms = true) {
  const root = fs.mkdtempSync(path.join(process.env.HARNESS_TEST_TMP || os.tmpdir(), 'fresh install tests '));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'tools');
  const noGit = path.join(root, 'no git');
  const data = path.join(root, 'data origin');
  const config = path.join(root, 'config');
  const sourceDir = path.join(root, 'source clone');
  const dataDir = path.join(root, 'data clone');
  for (const dir of [home, bin, noGit, data]) fs.mkdirSync(dir);
  const gitLookup = run(path.join(process.env.SystemRoot, 'System32/where.exe'), ['git.exe'], process.env);
  assert.equal(gitLookup.status, 0, output(gitLookup));
  const git = gitLookup.stdout.trim().split(/\r?\n/)[0];
  const env = {
    SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot,
    ComSpec: path.join(process.env.SystemRoot, 'System32/cmd.exe'),
    // The router shim logs script calls, but the checker spawns the wired `node` command without a shell,
    // which only finds a node.exe; keep the real one last on PATH so the shim still wins for PowerShell.
    PATH: [bin, path.dirname(git), path.join(process.env.SystemRoot, 'System32'), path.dirname(process.execPath)].join(';'),
    PATHEXT: '.COM;.EXE;.BAT;.CMD', HOME: home, USERPROFILE: home,
    APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
    TEMP: root, TMP: root, PYTHONDONTWRITEBYTECODE: '1',
    PYTHON: path.join(process.env.LOCALAPPDATA, 'Programs/Python/Python313/python.exe'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL', GIT_TERMINAL_PROMPT: '0',
    HARNESS_TEST_REAL_NODE: process.execPath, HARNESS_TEST_LOG: path.join(root, 'calls.jsonl'),
    HARNESS_TEST_SOURCE: SOURCE, CLAUDE_STUB_CONFIG: config,
  };
  // Offline MCP registry: the generator writes beside itself, so run a copy inside this fixture's root.
  const registryDir = path.join(root, 'mcp registry');
  fs.mkdirSync(registryDir);
  fs.copyFileSync(path.join(HERE, 'mcp/fixtures/build-registry.mjs'), path.join(registryDir, 'build-registry.mjs'));
  const built = run(process.execPath, [path.join(registryDir, 'build-registry.mjs')], process.env);
  assert.equal(built.status, 0, output(built));
  const claudeStub = path.join(HERE, 'mcp/fixtures/claude-stub.mjs');
  const router = path.join(root, 'node router.mjs');
  write(router, `import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
const name = path.basename(args[0]);
if (name === '--version') {
  console.log(process.version);
  process.exit(0);
}
fs.appendFileSync(process.env.HARNESS_TEST_LOG, JSON.stringify(args) + '\\n');
// Local clones contain committed files; overlay the implementation under test without committing.
if (name === 'harness-install.mjs') {
  const layer = path.dirname(args[0]);
  for (const relative of ['bootstrap/mcp/install-mcp-servers.mjs', 'postinstall-check.mjs',
    'data-repo-template/data-whitelist.json', '../tools/data_repo_gate.py']) {
    fs.copyFileSync(path.join(process.env.HARNESS_TEST_SOURCE, '.claude/global-layer', relative), path.join(layer, relative));
  }
}
if (name === process.env.HARNESS_TEST_FAIL_AT) process.exit(19);
if (name === 'postinstall-check.mjs' && process.env.HARNESS_TEST_FINAL) {
  console.log(process.env.HARNESS_TEST_FINAL);
  process.exit(Number(process.env.HARNESS_TEST_FINAL_EXIT || 0));
}
const r = spawnSync(process.env.HARNESS_TEST_REAL_NODE, args, { stdio: 'inherit', windowsHide: true });
process.exit(r.status ?? 1);
`);
  write(path.join(bin, 'node.cmd'), `@echo off\r\n"%HARNESS_TEST_REAL_NODE%" "${router}" %*\r\nexit /b %errorlevel%\r\n`);
  write(path.join(data, 'ceo-model/ceo-model.md'), '# Fixture personal model\n');
  write(path.join(data, 'memory/README.md'), '# Fixture memory\n');
  if (terms) write(path.join(data, 'personal-terms.txt'), 'FreshFixturePrivateTerm\n');
  for (const args of [
    ['init', data], ['-C', data, 'add', '.'],
    ['-C', data, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=' + noGit, 'commit', '-m', 'Local install fixture'],
  ]) {
    const r = run(git, args, env);
    assert.equal(r.status, 0, output(r));
  }
  // Public package (2026-10-12): the package folder is published by copying, so it may not be a git checkout yet, and
  // STEP 2 would then fail on `git clone` for a reason unrelated to the installer (round 1: 9 of 10 tests). In that
  // case the fixture snapshots the working tree into a local git origin and the installer clones the snapshot.
  let origin = SOURCE;
  if (!fs.existsSync(path.join(SOURCE, '.git'))) {
    origin = path.join(root, 'source origin');
    fs.cpSync(SOURCE, origin, { recursive: true,
      filter: src => !/(^|[\\/])(\.git|node_modules)$/.test(path.relative(SOURCE, src)) });
    for (const args of [
      ['init', origin], ['-C', origin, 'add', '-A'],
      ['-C', origin, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
        '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=' + noGit, 'commit', '-q', '-m', 'Package snapshot fixture'],
    ]) {
      const r = run(git, args, env);
      assert.equal(r.status, 0, output(r));
    }
  }
  // withData=false is the public route: no -DataRepo and no -DataDir at all.
  const invoke = (overrides = {}, python = env.PYTHON, prereqFlags = ['-SkipPrereqs'], withData = true) => run(SHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT,
    '-SourceRepo', origin, ...(withData ? ['-DataRepo', data] : []), '-ConfigDir', config, '-SourceDir', sourceDir,
    ...(withData ? ['-DataDir', dataDir] : []), ...(python ? ['-Python', python] : []), '-McpRegistry', registryDir, '-McpClaude', claudeStub,
    ...prereqFlags, '-SkipVsCode'], { ...env, ...overrides }, root);
  const calls = () => fs.existsSync(env.HARNESS_TEST_LOG)
    ? fs.readFileSync(env.HARNESS_TEST_LOG, 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { root, home, bin, noGit, data, origin, config, sourceDir, dataDir, env, git, registryDir, claudeStub, invoke, calls };
}

function prerequisiteFixture(installExit = 0) {
  const f = fixture();
  write(path.join(f.bin, 'py.cmd'), '@echo off\r\n"%PYTHON%" %*\r\nexit /b %errorlevel%\r\n');
  write(path.join(f.bin, 'claude.cmd'), '@echo off\r\necho claude 2.1.0\r\n');
  write(path.join(f.bin, 'codex.cmd'), '@echo off\r\nexit /b 9009\r\n');
  write(path.join(f.bin, 'gh.cmd'), '@echo off\r\nexit /b 9009\r\n');
  const template = path.join(f.root, 'installed gh.cmd');
  write(template, '@echo off\r\necho gh version 2.50.0\r\n');
  f.wingetLog = path.join(f.root, 'winget argv.txt');
  write(path.join(f.bin, 'winget.cmd'), `@echo off\r\necho %*>>"${f.wingetLog}"\r\n` +
    `if not "${installExit}"=="0" exit /b ${installExit}\r\n` +
    `if not "%~3"=="GitHub.cli" exit /b 91\r\ncopy /y "${template}" "${path.join(f.bin, 'gh.cmd')}" >nul\r\nexit /b 0\r\n`);
  return f;
}

test('STEP 1 installs a missing required tool unattended and completes all seven steps', { skip: !windows }, () => {
  const f = prerequisiteFixture();
  const r = f.invoke({}, f.env.PYTHON, []);
  assert.equal(r.status, 0, output(r));
  assert.equal(lastLine(r), 'POSTINSTALL PASS');
  assert.match(r.stdout, /PREREQ gh: installed gh version 2\.50\.0/);
  assert.match(r.stdout, /STEP 1\/7 prerequisites: OK installed: .*gh/);
  const argv = fs.readFileSync(f.wingetLog, 'utf8').trim().split(/\r?\n/);
  assert.equal(argv.length, 1);
  assert.match(argv[0], /install --id GitHub\.cli/);
  for (const flag of ['--silent', '--accept-package-agreements', '--accept-source-agreements']) assert.ok(argv[0].includes(flag), argv[0]);
});

test('STEP 1 names a failed required install and returns 3; SkipPrereqs still bypasses installation', { skip: !windows }, () => {
  const f = prerequisiteFixture(42);
  const r = f.invoke({}, f.env.PYTHON, []);
  assert.equal(r.status, 3, output(r));
  assert.match(r.stdout, /PREREQ gh: FAILED .*42/);
  assert.match(r.stdout, /STEP 1\/7 prerequisites: FAIL .*gh/);
  assert.doesNotMatch(r.stdout, /STEP 2\/7/);
  assert.match(fs.readFileSync(f.wingetLog, 'utf8'), /GitHub\.cli/);
  const skipped = prerequisiteFixture(42);
  const skipResult = skipped.invoke();
  assert.equal(skipResult.status, 0, output(skipResult));
  assert.equal(fs.existsSync(skipped.wingetLog), false);
  assert.match(skipResult.stdout, /STEP 1\/7 prerequisites: OK installation skipped/);
});

test('empty clone targets are accepted and nonempty non-git targets refused', { skip: !windows }, () => {
  const f = fixture();
  fs.mkdirSync(f.sourceDir);
  fs.mkdirSync(f.dataDir);
  const accepted = f.invoke({ HARNESS_TEST_FAIL_AT: 'harness-install.mjs' });
  assert.match(accepted.stdout, /STEP 2\/7 source: OK cloned/);
  assert.match(accepted.stdout, /STEP 3\/7 data: OK/);
  const bad = fixture();
  fs.mkdirSync(bad.sourceDir);
  write(path.join(bad.sourceDir, 'keep.txt'), 'keep');
  const refused = bad.invoke();
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /SourceDir.*non-empty.*not a git checkout/);
  assert.equal(fs.readFileSync(path.join(bad.sourceDir, 'keep.txt'), 'utf8'), 'keep');
});

test('successful install output is clean and update carries explicit options', { skip: !windows }, () => {
  const f = fixture();
  const result = f.invoke();
  assert.equal(result.status, 0, output(result));
  const command = result.stdout.split(/\r?\n/).find(line => line.startsWith('UPDATE-COMMAND: '));
  for (const [flag, value] of [['Python', f.env.PYTHON], ['McpRegistry', f.registryDir], ['McpClaude', f.claudeStub]]) {
    assert.ok(command.includes(`-${flag} '${value}'`), command);
  }
  assert.match(command, /-SkipVsCode/);
  assert.doesNotMatch(result.stdout, /Failed/);
});

test('local install and update pass; downstream failures cannot become PASS', { skip: !windows }, () => {
  const f = fixture();
  const r = f.invoke();
  console.log(`INSTALL exit=${r.status}\n${output(r)}`);
  assert.equal(r.status, 0, output(r));
  assert.equal(lastLine(r), 'POSTINSTALL PASS');
  for (let n = 1; n <= 7; n++) assert.match(r.stdout, new RegExp(`STEP ${n}/7 [^\\r\\n]+: OK`));
  const calls = f.calls();
  assert.deepEqual(calls.map(args => path.basename(args[0])), [
    'harness-install.mjs', 'bootstrap.mjs', 'data-repo-hooks.mjs', 'install-mcp-servers.mjs', 'install-mcp-servers.mjs',
    'postinstall-check.mjs',
  ]);
  assert.deepEqual(calls[0].slice(1), ['install', '--config-dir', f.config, '--profile', 'full',
    '--with-hooks', '--personal-terms', path.join(f.dataDir, 'personal-terms.txt')]);
  assert.deepEqual(calls[1].slice(1), ['--personal', path.join(f.dataDir, 'ceo-model/ceo-model.md'), '--config-dir', f.config]);
  assert.deepEqual(calls[2].slice(1), ['install', '--data-repo', f.dataDir, '--python', f.env.PYTHON]);
  // Step 6 runs --check first; --ensure follows only because the fresh install has no Connected server yet.
  assert.deepEqual(calls[3].slice(1), ['--home', f.home, '--config-dir', f.config, '--registry', f.registryDir, '--claude', f.claudeStub, '--check']);
  assert.deepEqual(calls[4].slice(1), ['--home', f.home, '--config-dir', f.config, '--registry', f.registryDir, '--claude', f.claudeStub, '--ensure']);
  assert.deepEqual(calls[5].slice(1), ['--config-dir', f.config, '--python', f.env.PYTHON, '--claude', f.claudeStub]);
  // The real data-repo hooks and the real MCP installer ran offline; -SkipVsCode kept the editor step out entirely.
  for (const hook of ['pre-commit', 'pre-push']) assert.ok(fs.existsSync(path.join(f.dataDir, '.git/hooks', hook)), hook);
  assert.ok(fs.existsSync(path.join(f.home, '.mcp-servers/playwright/cli.js')));
  const registrations = fs.readFileSync(path.join(f.config, 'claude-registrations.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(registrations.map(args => args[2]), ['playwright']);
  assert.equal(fs.readFileSync(path.join(f.config, 'ceo-model/ceo-model.md'), 'utf8'), '# Fixture personal model\n');
  const update = f.invoke();
  assert.equal(update.status, 0, output(update));
  assert.equal(lastLine(update), 'POSTINSTALL PASS');
  assert.match(update.stdout, /STEP 2\/7 source: OK updated/);
  assert.match(update.stdout, /MCP servers already present/);
  // Install ran --check then --ensure; the update ran only --check, so the MCP repair happened exactly once.
  assert.deepEqual(f.calls().filter(args => path.basename(args[0]) === 'install-mcp-servers.mjs').map(args => args.at(-1)),
    ['--check', '--ensure', '--check']);
  const command = r.stdout.split(/\r?\n/).find(line => line.startsWith('UPDATE-COMMAND: '));
  for (const value of [f.origin, f.data, f.config, f.sourceDir, f.dataDir]) assert.ok(command.includes(value), command);
  assert.match(command, /-SkipPrereqs.*-SkipVsCode/);
  // install-mcp-servers.mjs is not in this list: the update runs above find the server already present and skip it.
  for (const name of ['harness-install.mjs', 'bootstrap.mjs', 'data-repo-hooks.mjs']) {
    const failed = f.invoke({ HARNESS_TEST_FAIL_AT: name });
    assert.notEqual(failed.status, 0, output(failed));
    assert.match(failed.stdout, /STEP [456]\/7 [^\r\n]+: FAIL/);
    assert.doesNotMatch(failed.stdout, /STEP 7\/7|POSTINSTALL PASS/);
  }
  for (const [line, code] of [['POSTINSTALL FAIL b', '1'], ['POSTINSTALL PASS', '7'], ['unexpected output', '0']]) {
    const failed = f.invoke({ HARNESS_TEST_FINAL: line, HARNESS_TEST_FINAL_EXIT: code });
    assert.notEqual(failed.status, 0, output(failed));
    assert.match(failed.stdout, /STEP 7\/7 postinstall: FAIL/);
    assert.equal(lastLine(failed), line);
  }
  console.log('CASE 1 PASS: real install/personal/data hooks/offline MCP/postinstall; update and planted failures');
});

test('git present succeeds at prerequisite gate; filtered PATH without git fails there', { skip: !windows }, () => {
  const f = fixture();
  const control = f.invoke({ HARNESS_TEST_FAIL_AT: 'harness-install.mjs' });
  assert.match(control.stdout, /STEP 1\/7 prerequisites: OK/);
  const before = f.calls().length;
  const r = f.invoke({ PATH: [f.noGit, f.bin, path.join(process.env.SystemRoot, 'System32')].join(';') });
  console.log(`NO-GIT exit=${r.status}\n${output(r)}`);
  assert.notEqual(r.status, 0, output(r));
  assert.match(r.stdout, /STEP 1\/7 prerequisites: FAIL .*git/i);
  assert.doesNotMatch(r.stdout, /STEP 2\/7/);
  assert.equal(f.calls().length, before);
  console.log('CASE 2 PASS: git gate accepts present and rejects absent');
});

test('existing MCP packages are checked in ConfigDir and missing registration is repaired', { skip: !windows }, () => {
  const f = fixture();
  const first = f.invoke();
  assert.equal(first.status, 0, output(first));
  const registration = path.join(f.config, 'claude-registrations.jsonl');
  assert.equal(fs.existsSync(registration), true);
  const entry = path.join(f.home, '.mcp-servers/playwright/cli.js');
  const before = fs.readFileSync(entry);
  fs.renameSync(registration, registration + '.withheld');
  const repaired = f.invoke();
  assert.equal(repaired.status, 0, output(repaired));
  assert.equal(lastLine(repaired), 'POSTINSTALL PASS');
  assert.deepEqual(fs.readFileSync(entry), before);
  assert.equal(fs.existsSync(registration), true);
  const mcpCalls = f.calls().filter(args => path.basename(args[0]) === 'install-mcp-servers.mjs');
  assert.ok(mcpCalls.some(args => args.includes('--check')));
  for (const args of mcpCalls) assert.equal(args[args.indexOf('--config-dir') + 1], f.config);
  const checked = run(f.env.PYTHON, ['-I', path.join(f.sourceDir, '.claude/tools/data_repo_gate.py'),
    'check-staged', f.dataDir], f.env);
  assert.equal(checked.status, 0, output(checked));
  write(path.join(f.home, 'claude-mode.json'), JSON.stringify({ disconnected: true }));
  const failed = f.invoke();
  assert.equal(failed.status, 1, output(failed));
  assert.match(failed.stdout, /STEP 6\/7 tools: FAIL/);
});

test('data repository without personal-terms.txt fails before harness installation', { skip: !windows }, () => {
  const f = fixture(false);
  const r = f.invoke();
  console.log(`NO-TERMS exit=${r.status}\n${output(r)}`);
  assert.notEqual(r.status, 0, output(r));
  assert.match(r.stdout, /STEP 3\/7 data: FAIL .*personal-terms\.txt/);
  assert.doesNotMatch(r.stdout, /STEP 4\/7/);
  assert.equal(f.calls().length, 0);
  console.log('CASE 3 PASS: missing terms stop at step 3');
});

test('install passes when git treats every repository as owned by another user; no gitconfig is written', { skip: !windows }, () => {
  const f = fixture();
  // The user's real global gitconfig stands in as a sentinel file: the script must never write to it.
  const sentinel = path.join(f.root, 'sentinel global gitconfig');
  const sentinelText = '[user]\n\tname = Sentinel\n';
  write(sentinel, sentinelText);
  // GIT_TEST_ASSUME_DIFFERENT_OWNER makes git apply its ownership check as if another account owned every repository.
  const foreign = { GIT_TEST_ASSUME_DIFFERENT_OWNER: '1', GIT_CONFIG_GLOBAL: sentinel };
  const probe = extra => run(f.git, [...extra, '-C', f.data, 'rev-parse', '--git-dir'], { ...f.env, ...foreign });
  const refused = probe([]);
  console.log(`OWNERSHIP CONTROL exit=${refused.status}\n${output(refused)}`);
  assert.notEqual(refused.status, 0, 'the simulation must make plain git refuse, or this test proves nothing');
  assert.match(output(refused), /dubious ownership/);
  const lifted = probe(['-c', 'safe.directory=*']);
  assert.equal(lifted.status, 0, output(lifted));
  const r = f.invoke(foreign);
  console.log(`FOREIGN-OWNER INSTALL exit=${r.status}\n${output(r).split(/\r?\n/).filter(l => !/Updating files/.test(l)).join('\n')}`);
  assert.equal(r.status, 0, output(r));
  assert.equal(lastLine(r), 'POSTINSTALL PASS');
  assert.doesNotMatch(output(r), /dubious ownership/);
  const update = f.invoke(foreign);
  assert.equal(update.status, 0, output(update));
  assert.match(update.stdout, /STEP 2\/7 source: OK updated/);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), sentinelText);
  assert.equal(fs.existsSync(path.join(f.home, '.gitconfig')), false);
  console.log('CASE 4 PASS: foreign-owned repositories install and update; no gitconfig file touched');
});

test('an unusable Python stops at step 5 and a failing MCP installer stops at step 6, never reaching the checker', { skip: !windows }, () => {
  const f = fixture();
  const notPython = path.join(process.env.SystemRoot, 'System32/where.exe');
  const noPython = f.invoke({}, notPython);
  console.log(`BAD-PYTHON exit=${noPython.status}\n${output(noPython).split(/\r?\n/).filter(l => /STEP|Python/.test(l)).join('\n')}`);
  assert.notEqual(noPython.status, 0, output(noPython));
  assert.match(noPython.stdout, /STEP 5\/7 personal: FAIL Python 3 is required/);
  assert.doesNotMatch(noPython.stdout, /STEP 6\/7|STEP 7\/7|POSTINSTALL PASS/);
  assert.equal(f.calls().filter(args => path.basename(args[0]) === 'data-repo-hooks.mjs').length, 0);
  assert.equal(fs.existsSync(path.join(f.dataDir, '.git/hooks/pre-commit')), false);
  const mcp = f.invoke({ HARNESS_TEST_FAIL_AT: 'install-mcp-servers.mjs' });
  assert.notEqual(mcp.status, 0, output(mcp));
  assert.match(mcp.stdout, /STEP 6\/7 tools: FAIL/);
  assert.doesNotMatch(mcp.stdout, /STEP 7\/7|POSTINSTALL PASS/);
  assert.equal(fs.existsSync(path.join(f.home, '.mcp-servers')), false);
  // Default discovery (no -Python): the Microsoft Store python/python3 aliases must be rejected, the py launcher accepted.
  const pyLauncher = path.join(process.env.SystemRoot, 'py.exe');
  const stubDir = path.join(process.env.LOCALAPPDATA, 'Microsoft/WindowsApps');
  if (fs.existsSync(pyLauncher)) {
    const stubsOnly = f.invoke({ PATH: `${f.env.PATH};${stubDir}` }, null);
    console.log(`STUBS-ONLY exit=${stubsOnly.status}\n${output(stubsOnly).split(/\r?\n/).filter(l => /STEP [567]/.test(l)).join('\n')}`);
    assert.notEqual(stubsOnly.status, 0, output(stubsOnly));
    assert.match(stubsOnly.stdout, /STEP 5\/7 personal: FAIL Python 3 is required .*tried: py, python3, python/);
    const discovered = f.invoke({ PATH: `${f.env.PATH};${stubDir};${process.env.SystemRoot}` }, null);
    assert.equal(discovered.status, 0, output(discovered));
    assert.equal(lastLine(discovered), 'POSTINSTALL PASS');
    const hooks = f.calls().filter(args => path.basename(args[0]) === 'data-repo-hooks.mjs').at(-1);
    assert.equal(hooks.at(-1).toLowerCase(), pyLauncher.toLowerCase());
  }
  console.log('CASE 5 PASS: unusable Python fails closed at step 5; MCP installer failure fails closed at step 6; default discovery skips Store stubs');
});

test('public route: no data repository skips the personal layer, installs the harness layer and passes; update stays data-free', { skip: !windows }, () => {
  const f = fixture();
  const r = f.invoke({}, f.env.PYTHON, ['-SkipPrereqs'], false);
  console.log(`PUBLIC INSTALL exit=${r.status}\n${output(r).split(/\r?\n/).filter(l => /STEP|NOTICE|POSTINSTALL|UPDATE-COMMAND/.test(l)).join('\n')}`);
  assert.equal(r.status, 0, output(r));
  assert.equal(lastLine(r), 'POSTINSTALL PASS');
  assert.match(r.stdout, /STEP 3\/7 data: SKIPPED \(no data repository: the personal layer is optional\)/);
  assert.match(r.stdout, /NOTICE: no personal-terms list \(no data repository\); the leak check runs with an empty term list\./);
  assert.match(r.stdout, /STEP 4\/7 harness: OK/);
  assert.match(r.stdout, /STEP 5\/7 personal: OK harness layer only/);
  for (let n = 1; n <= 7; n++) assert.match(r.stdout, new RegExp(`STEP ${n}/7 [^\r\n]+: (OK|SKIPPED)`));
  const calls = f.calls();
  assert.deepEqual(calls.map(args => path.basename(args[0])), [
    'harness-install.mjs', 'install-mcp-servers.mjs', 'install-mcp-servers.mjs', 'postinstall-check.mjs',
  ]);
  assert.deepEqual(calls[0].slice(1), ['install', '--config-dir', f.config, '--profile', 'full', '--with-hooks', '--no-personal-terms']);
  // No personal layer, no data clone, no data gate: nothing from the private data route was touched.
  assert.equal(fs.existsSync(path.join(f.config, 'ceo-model')), false);
  assert.equal(fs.existsSync(f.dataDir), false);
  // The harness layer itself is there: the 13 agents and the credential-isolation standard.
  assert.equal(fs.readdirSync(path.join(f.config, 'agents')).filter(n => n.endsWith('.md')).length, 13);
  assert.ok(fs.existsSync(path.join(f.config, 'standards/credential-isolation.md')));
  const command = r.stdout.split(/\r?\n/).find(line => line.startsWith('UPDATE-COMMAND: '));
  assert.ok(command.includes(`-SourceRepo '${f.origin}'`), command);
  assert.doesNotMatch(command, /-DataRepo|-DataDir/);
  const update = f.invoke({}, f.env.PYTHON, ['-SkipPrereqs'], false);
  assert.equal(update.status, 0, output(update));
  assert.equal(lastLine(update), 'POSTINSTALL PASS');
  assert.match(update.stdout, /STEP 2\/7 source: OK updated/);
  assert.match(update.stdout, /STEP 3\/7 data: SKIPPED/);
  console.log('CASE 6 PASS: public install and update without a data repository');
});

test('public route still fails closed: a failing harness install stops at step 4, an unusable Python at step 5', { skip: !windows }, () => {
  const f = fixture();
  const failed = f.invoke({ HARNESS_TEST_FAIL_AT: 'harness-install.mjs' }, f.env.PYTHON, ['-SkipPrereqs'], false);
  assert.notEqual(failed.status, 0, output(failed));
  assert.match(failed.stdout, /STEP 3\/7 data: SKIPPED/);
  assert.match(failed.stdout, /STEP 4\/7 harness: FAIL/);
  assert.doesNotMatch(failed.stdout, /STEP 5\/7|POSTINSTALL PASS/);
  const noPython = f.invoke({}, path.join(process.env.SystemRoot, 'System32/where.exe'), ['-SkipPrereqs'], false);
  assert.notEqual(noPython.status, 0, output(noPython));
  assert.match(noPython.stdout, /STEP 5\/7 personal: FAIL Python 3 is required/);
  assert.doesNotMatch(noPython.stdout, /STEP 6\/7|STEP 7\/7|POSTINSTALL PASS/);
  console.log('CASE 7 PASS: the public route fails closed at steps 4 and 5');
});
