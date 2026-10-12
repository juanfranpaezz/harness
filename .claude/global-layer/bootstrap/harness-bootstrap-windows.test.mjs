import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const script = path.join(here, 'harness-bootstrap.ps1');
const manifest = path.join(here, 'prereqs-windows.tsv');
const ids = ['git', 'node', 'python', 'claude', 'gh', 'codex', 'vscode', 'vscode-ext-claude-code', 'vscode-ext-codex'];
const required = ids.slice(0, 5);
const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const windows = process.platform === 'win32';
const text = (p) => fs.existsSync(p) ? fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '') : '';
const qps = (s) => `'${s.replaceAll("'", "''")}'`;
const cmd = (s) => `@echo off\r\n${s.replaceAll('\n', '\r\n')}\r\n`;

function fixture(t, options = {}) {
  // Every test owns one direct child of the worktree, including all process scratch files.
  const dir = fs.mkdtempSync(path.join(root, '.tmp-bootstrap-windows-tests with spaces-'));
  t.after(() => {
    const resolved = path.resolve(dir);
    assert.equal(path.dirname(resolved), root);
    assert.ok(path.basename(resolved).startsWith('.tmp-bootstrap-windows-tests with spaces-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const bin = path.join(dir, 'stub tools');
  fs.mkdirSync(bin);
  const templates = path.join(dir, 'templates');
  fs.mkdirSync(templates);
  const log = path.join(dir, 'winget.log');
  const probeLog = path.join(dir, 'probes.log');
  const pathLog = path.join(dir, 'paths.log');
  const extensionLog = path.join(dir, 'extensions.log');
  const toolNames = { git: 'git', node: 'node', python: 'py', claude: 'claude', gh: 'gh', codex: 'codex', vscode: 'code' };
  for (const [id, name] of Object.entries(toolNames)) {
    let body = `echo ${id}>>"%BOOTSTRAP_PROBE_LOG%"\necho %PATH%>>"%BOOTSTRAP_PATH_LOG%"\n`;
    if (id === 'node') {
      body += 'if "%~1"=="--version" (echo v%BOOTSTRAP_NODE_VERSION%& exit /b 0)\n';
      body += 'if not "%~1"=="--experimental-vm-modules" exit /b 8\nif not "%~2"=="-e" exit /b 9\necho %BOOTSTRAP_ADMISSION%\nexit /b 0';
    } else if (id === 'python') {
      body += 'if not "%~1"=="-c" exit /b 8\necho 3.13.2\necho %BOOTSTRAP_PYTHON_MARKER%\nexit /b 0';
    } else if (id === 'vscode') {
      body += 'if "%~1"=="--version" (echo 1.100.0& exit /b 0)\n';
      body += options.extensionVersions
        ? 'if "%~1"=="--list-extensions" (\nif not "%~2"=="--show-versions" exit /b 8\nfor /f "usebackq delims=" %%E in ("%BOOTSTRAP_EXTENSIONS%") do echo %%E@1.2.3\nexit /b 0\n)\n'
        : 'if "%~1"=="--list-extensions" (type "%BOOTSTRAP_EXTENSIONS%"& exit /b 0)\n';
      body += 'if not "%~1"=="--install-extension" exit /b 8\necho %~2>>"%BOOTSTRAP_EXTENSIONS%"\necho %~2>>"%BOOTSTRAP_EXTENSION_LOG%"\nexit /b 0';
    } else {
      body += `if not "%~1"=="--version" exit /b 8\necho ${id} 2.50.0\nexit /b 0`;
    }
    if (id === 'node' && options.realNode) body = `"${process.execPath}" %*\nexit /b %errorlevel%`;
    if (id === options.hang) body = ':hang\ngoto hang';
    fs.writeFileSync(path.join(templates, `${id}.cmd`), cmd(body));
    fs.writeFileSync(path.join(bin, `${name}.cmd`), options.missing?.includes(id) ? cmd('exit /b 9009') : cmd(body));
  }
  // Prevent Python fallback from reaching anything installed on the machine.
  fs.writeFileSync(path.join(bin, 'python.cmd'), cmd('exit /b 9009'));
  fs.writeFileSync(path.join(bin, 'winget.cmd'), cmd(
    'echo %*>>"%BOOTSTRAP_WINGET_LOG%"\n' +
    'if not "%BOOTSTRAP_INSTALL_EXIT%"=="0" exit /b %BOOTSTRAP_INSTALL_EXIT%\n' +
    'if "%BOOTSTRAP_NO_CREATE%"=="yes" exit /b 0\n' +
    'set "target=%~2"\nif "%~2"=="python" set "target=py"\nif "%~2"=="vscode" set "target=code"\n' +
    'copy /y "%BOOTSTRAP_TEMPLATES%\\%~2.cmd" "%BOOTSTRAP_BIN%\\%target%.cmd" >nul\nexit /b 0'
  ));
  const rows = text(manifest).trimEnd().split(/\r?\n/).map((line, index) => {
    if (!index) return line;
    const fields = line.split('\t');
    if (!fields[0].startsWith('vscode-ext-')) fields[3] = `winget install ${fields[0]}`;
    if (options.pending?.includes(fields[0])) fields[3] = 'ROUTE-PENDING';
    fields[6] = 'test-fixture';
    return fields.join('\t');
  });
  if (options.reorder) rows.splice(1, rows.length - 1, ...options.reorder.map(id => rows.slice(1).find(row => row.startsWith(`${id}\t`))));
  const manifestPath = path.join(dir, 'fixture manifest.tsv');
  fs.writeFileSync(manifestPath, rows.join('\n') + '\n');
  const answersPath = path.join(dir, 'answers.txt');
  fs.writeFileSync(answersPath, Object.entries(options.answers || {}).map(([id, answer]) => `${id}=${answer}`).join('\n'));
  const extensions = path.join(dir, 'extensions.txt');
  fs.writeFileSync(extensions, options.extensions ?? 'anthropic.claude-code\nopenai.chatgpt\n');
  const summaryPath = path.join(dir, 'summary.json');
  const env = {
    SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot,
    ComSpec: path.join(process.env.SystemRoot, 'System32/cmd.exe'),
    PATH: `${bin};${process.env.SystemRoot}\\System32;${path.dirname(shell)}`,
    PATHEXT: '.COM;.EXE;.BAT;.CMD', TEMP: dir, TMP: dir,
    BOOTSTRAP_BIN: bin, BOOTSTRAP_TEMPLATES: templates,
    BOOTSTRAP_WINGET_LOG: log, BOOTSTRAP_PROBE_LOG: probeLog, BOOTSTRAP_PATH_LOG: pathLog,
    BOOTSTRAP_EXTENSIONS: extensions, BOOTSTRAP_EXTENSION_LOG: extensionLog,
    BOOTSTRAP_INSTALL_EXIT: String(options.installExit ?? 0), BOOTSTRAP_NO_CREATE: options.noCreate ? 'yes' : 'no',
    BOOTSTRAP_NODE_VERSION: options.nodeVersion || '22.15.0',
    BOOTSTRAP_ADMISSION: options.admission ?? 'ADMISSION-OK', BOOTSTRAP_PYTHON_MARKER: options.pythonMarker ?? 'PYTHON-OK',
    ...(options.ci ? { CI: 'true' } : {}),
  };
  const run = (extra = []) => {
    let target = script;
    if (options.interactive || options.unicodeSummary) {
      // Substitute only the terminal detector for optional-row tests. Production
      // redirection detection is exercised separately against real redirected handles.
      const detector = '$interactive = -not ($consoleType::IsInputRedirected -or $consoleType::IsOutputRedirected)';
      const original = text(script);
      assert.equal(original.split(detector).length, 2);
      target = path.join(dir, 'interactive bootstrap.ps1');
      let adapted = options.interactive ? original.replace(detector, '$interactive = $true') : original;
      if (options.unicodeSummary) adapted = adapted.replace('$deferred = @(',
        '$items[0].version = "Git $([char]0x00e9)$([char]0xd83d)$([char]0xde80)"; $deferred = @(');
      fs.writeFileSync(target, adapted);
    }
    if (options.constrained || options.interactive || options.hang) {
      const bootstrap = target;
      target = path.join(dir, 'test host.ps1');
      // This adapter supplies no consent: every run still uses AnswersFile/Unattended.
      fs.writeFileSync(target, [
        options.hang ? `
$script:waitCount = 0
function Wait-Process {
    param([Parameter(ValueFromPipeline=$true)]$InputObject, $Timeout)
    process {
        $script:waitCount++
        if ($script:waitCount -eq 1) {
            # Model deadline expiry immediately; the real process must be killed.
            Set-Content -LiteralPath ${qps(path.join(dir, 'wait-timeout.txt'))} -Value $Timeout
        } else {
            $InputObject | Microsoft.PowerShell.Management\\Wait-Process -Timeout $Timeout -ErrorAction SilentlyContinue
        }
    }
}` : '',
        options.constrained ? "$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'" : '',
        `& ${qps(bootstrap)} @args`, 'exit $LASTEXITCODE',
      ].join('\n'));
    }
    const result = spawnSync(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', target,
      '-ManifestPath', manifestPath, '-SummaryJson', summaryPath,
      ...(options.interactive || options.noTty ? ['-AnswersFile', answersPath] : ['-Unattended', '-AnswersFile', answersPath]), ...extra],
    { cwd: root, env, encoding: 'utf8', timeout: 60_000 });
    assert.ifError(result.error);
    const raw = fs.existsSync(summaryPath)
      ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(summaryPath)) : '';
    const summary = raw ? JSON.parse(raw) : null;
    if (summary) {
      assert.equal(summary.schema, 'harness-bootstrap-summary/1');
      assert.equal(summary.os, 'windows');
      assert.deepEqual(summary.items.map(i => i.id).sort(), [...ids].sort());
      for (const item of summary.items) {
        assert.deepEqual(Object.keys(item).sort(), ['exit_code', 'id', 'status', 'version']);
        assert.ok(item.exit_code === null || Number.isInteger(item.exit_code));
      }
    }
    return { ...result, summary, statuses: Object.fromEntries(summary?.items.map(i => [i.id, i.status]) || []) };
  };
  return { dir, bin, log, probeLog, pathLog, extensionLog, manifestPath, run };
}

function check(result, exit, expected) {
  assert.equal(result.status, exit, result.stdout + result.stderr);
  assert.ok(result.summary, result.stdout + result.stderr);
  for (const [id, status] of Object.entries(expected)) assert.equal(result.statuses[id], status, `${id}: ${result.stdout}`);
}
function scenario(name, fn) { test(name, { skip: !windows }, fn); }

scenario('all required present: optional declined, exit 0, startup banner first', t => {
  const f = fixture(t); const r = f.run();
  check(r, 0, Object.fromEntries(ids.map(id => [id, required.includes(id) ? 'present' : 'declined'])));
  assert.match(r.stdout, /^BOOTSTRAP STARTED\r?\nLanguageMode: FullLanguage/);
  assert.deepEqual(r.summary.deferred, []); assert.match(r.summary.next, /^node .*harness-install.mjs install /);
  assert.equal(text(f.log), '');
});
scenario('BOM-free summary preserves Unicode in ConstrainedLanguage', t => {
  const r = fixture(t, { constrained: true, unicodeSummary: true }).run();
  check(r, 0, { git: 'present' });
  assert.equal(r.summary.items[0].version, 'Git \u00e9\u{1f680}');
});
scenario('git missing: yes installs, rechecks, and retains stub PATH first', t => {
  const f = fixture(t, { missing: ['git'], answers: { git: 'yes' } });
  check(f.run(), 0, { git: 'installed' });
  assert.equal(text(f.log).trim(), 'install git');
  for (const observed of text(f.pathLog).trim().split(/\r?\n/)) assert.equal(observed.split(';')[0], f.bin);
  assert.ok(text(f.probeLog).includes('git'));
});
scenario('node missing: no declines, defers node, and never installs', t => {
  const f = fixture(t, { missing: ['node'], answers: { node: 'no' } }); const r = f.run();
  check(r, 3, { node: 'declined' }); assert.equal(r.summary.next, null); assert.deepEqual(r.summary.deferred, ['node']); assert.equal(text(f.log), '');
});
scenario('declined gh leaves the core handoff available', t => {
  const f = fixture(t, { missing: ['gh'], answers: { gh: 'no' } }); const r = f.run();
  check(r, 3, { gh: 'declined' }); assert.equal(text(f.log), '');
  assert.deepEqual(r.summary.deferred, []); assert.ok(r.summary.next);
  assert.match(r.stdout, /GitHub CLI \(gh\) prerequisite/);
});
scenario('gh cancellation 1223 preserves full code and processes later required rows', t => {
  const f = fixture(t, { missing: ['gh'], answers: { gh: 'yes' }, installExit: 1223, reorder: ['gh', ...ids.filter(id => id !== 'gh')] }); const r = f.run();
  check(r, 3, { gh: 'cancelled', git: 'present', node: 'present', python: 'present', claude: 'present' });
  assert.equal(r.summary.items.find(i => i.id === 'gh').exit_code, 1223);
});
scenario('installer exit 1 is install-failed', t => {
  const f = fixture(t, { missing: ['git'], answers: { git: 'yes' }, installExit: 1 }); const r = f.run();
  check(r, 3, { git: 'install-failed', gh: 'present' }); assert.equal(r.summary.items[0].exit_code, 1);
});
scenario('node 20 fails admission and is offered', t => {
  const f = fixture(t, { nodeVersion: '20.0.0', answers: { node: 'no' } }); const r = f.run();
  check(r, 3, { node: 'declined' }); assert.match(r.stdout, /Node\.js \(node\) prerequisite; scope:/); assert.equal(text(f.log), '');
});
scenario('node 26 with admission marker is present', t => {
  const f = fixture(t, { nodeVersion: '26.7.0' }); const r = f.run(); check(r, 0, { node: 'present' });
  assert.equal(r.summary.items.find(i => i.id === 'node').version, 'v26.7.0'); assert.equal(text(f.log), '');
});
scenario('node exit zero without admission marker fails', t => {
  const f = fixture(t, { admission: 'wrong marker' }); check(f.run(), 3, { node: 'declined' });
});
scenario('Unattended unanswered missing rows all decline without winget', t => {
  const f = fixture(t, { missing: ids }); check(f.run(), 3, Object.fromEntries(ids.map(id => [id, 'declined']))); assert.equal(text(f.log), '');
});
scenario('DryRun yes is would-install and does not call winget', t => {
  const f = fixture(t, { missing: ['git'], answers: { git: 'yes' } }); const r = f.run(['-DryRun']);
  check(r, 3, { git: 'would-install' }); assert.equal(r.summary.dry_run, true); assert.match(r.stdout, /winget install git/); assert.equal(text(f.log), '');
});
scenario('paths containing spaces preserve answers, manifest and summary', t => {
  const f = fixture(t, { missing: ['git'], answers: { git: 'y' } }); assert.match(f.dir, /with spaces/); check(f.run(), 0, { git: 'installed' });
});
scenario('ROUTE-PENDING is manual even with yes, and never executes', t => {
  const f = fixture(t, { missing: ['git'], answers: { git: 'yes' }, pending: ['git'] }); const r = f.run();
  check(r, 3, { git: 'manual' }); assert.match(r.stdout, /docs\/harness\/INSTALL.md/); assert.equal(text(f.log), '');
});
scenario('successful installer without capability is installed-unverified', t => {
  const f = fixture(t, { missing: ['git'], answers: { git: 'yes' }, noCreate: true }); const r = f.run();
  check(r, 3, { git: 'installed-unverified' }); assert.equal(r.summary.items[0].exit_code, 0);
});
scenario('python requires stdlib marker', t => {
  const f = fixture(t, { pythonMarker: 'missing stdlib' }); check(f.run(), 3, { python: 'declined' });
});
scenario('invalid answer does not authorize install', t => {
  const f = fixture(t, { missing: ['git'], answers: { git: 'sure' } }); check(f.run(), 3, { git: 'declined' }); assert.equal(text(f.log), '');
});
scenario('optional present tools and extensions are skipped with no install calls', t => {
  const f = fixture(t, { interactive: true, answers: Object.fromEntries(ids.map(id => [id, 'yes'])) });
  check(f.run(), 0, Object.fromEntries(ids.map(id => [id, 'present']))); assert.equal(text(f.log), ''); assert.equal(text(f.extensionLog), '');
});
scenario('missing optional tools and extensions are offered and installed only on yes', t => {
  const f = fixture(t, { interactive: true, missing: ['codex', 'vscode'], extensions: '', answers: Object.fromEntries(ids.slice(5).map(id => [id, 'yes'])) }); const r = f.run();
  check(r, 0, Object.fromEntries(ids.slice(5).map(id => [id, 'installed'])));
  for (const id of ids.slice(5)) assert.match(r.stdout, new RegExp(`[^\\n]+ \\(${id}\\) prerequisite; scope:`));
  assert.deepEqual(text(f.extensionLog).trim().split(/\r?\n/), ['anthropic.claude-code', 'openai.chatgpt']);
});
scenario('optional failures do not affect required exit code', t => {
  const f = fixture(t, { interactive: true, missing: ['codex'], answers: { codex: 'yes' }, installExit: 1 }); check(f.run(), 0, { codex: 'install-failed' });
});
for (const flags of [['-NoEditor', '-NoCodex'], ['--no-editor', '--no-codex']]) {
  scenario(`skip switches ${flags.join(' ')} suppress optional installs`, t => {
    const f = fixture(t, { interactive: true, missing: ids.slice(5), extensions: '', answers: Object.fromEntries(ids.map(id => [id, 'yes'])) });
    check(f.run(flags), 0, Object.fromEntries(ids.slice(5).map(id => [id, 'declined']))); assert.equal(text(f.log), ''); assert.equal(text(f.extensionLog), '');
  });
}
scenario('CI skips optional rows even with explicit yes', t => {
  const f = fixture(t, { interactive: true, ci: true, missing: ['codex'], answers: { codex: 'yes' } }); check(f.run(), 0, { codex: 'declined' }); assert.equal(text(f.log), '');
});
scenario('optional manual and declined rows allow exit zero', t => {
  const f = fixture(t, { interactive: true, missing: ['codex', 'vscode'], pending: ['vscode'] }); check(f.run(), 0, { codex: 'declined', vscode: 'manual' });
});
scenario('ConstrainedLanguage detects and installs through registry PATH refresh', t => {
  const f = fixture(t, { constrained: true, missing: ['git'], answers: { git: 'yes' } }); const r = f.run();
  check(r, 0, { git: 'installed', node: 'present' }); assert.match(r.stdout, /LanguageMode: ConstrainedLanguage/);
  for (const observed of text(f.pathLog).trim().split(/\r?\n/)) assert.equal(observed.split(';')[0], f.bin);
});
scenario('invalid parameters return 2', t => {
  const f = fixture(t); const r = f.run(['-Unknown']); assert.equal(r.status, 2, r.stdout + r.stderr); assert.equal(text(f.log), '');
});
scenario('invalid manifest returns 2 before any probes', t => {
  const f = fixture(t); fs.appendFileSync(f.manifestPath, 'bad\n'); const r = f.run(); assert.equal(r.status, 2, r.stdout + r.stderr); assert.equal(text(f.probeLog), ''); assert.equal(text(f.log), '');
});
scenario('full-width Windows installer failure code is not truncated', t => {
  const f = fixture(t, { missing: ['git'], answers: { git: 'yes' }, installExit: -1978335183 }); const r = f.run();
  check(r, 3, { git: 'install-failed' }); assert.equal(r.summary.items[0].exit_code, -1978335183);
});
scenario('probe timeout is bounded and later rows continue', t => {
  const f = fixture(t, { hang: 'git' }); const r = f.run();
  check(r, 3, { git: 'declined', gh: 'present' }); assert.match(r.stdout, /Probe timed out/);
  assert.equal(text(path.join(f.dir, 'wait-timeout.txt')).trim(), '20');
  assert.equal(r.summary.items[0].exit_code, null);
});
scenario('real local Node executes the exact admission probe', t => {
  const f = fixture(t, { realNode: true }); check(f.run(), 0, { node: 'present' });
});
scenario('no TTY skips optional rows despite yes answers', t => {
  const f = fixture(t, { noTty: true, missing: ['codex'], answers: { codex: 'yes' } });
  check(f.run(), 0, { codex: 'declined' }); assert.equal(text(f.log), '');
});
scenario('ConstrainedLanguage detects redirected input without prompting', t => {
  const f = fixture(t, { constrained: true, noTty: true, missing: ['codex'], answers: { codex: 'yes' } });
  check(f.run(), 0, { codex: 'declined' }); assert.equal(text(f.log), '');
});
scenario('extensions without code on PATH are manual with a reason', t => {
  const f = fixture(t, { interactive: true, missing: ['vscode'], pending: ['vscode'], answers: { 'vscode-ext-claude-code': 'yes', 'vscode-ext-codex': 'yes' } });
  fs.renameSync(path.join(f.bin, 'code.cmd'), path.join(f.bin, 'code.unavailable'));
  const r = f.run(); check(r, 0, { vscode: 'manual', 'vscode-ext-claude-code': 'manual', 'vscode-ext-codex': 'manual' });
  assert.match(r.stdout, /needs code on PATH/); assert.equal(text(f.extensionLog), '');
});
scenario('python falls back only when py is unavailable', t => {
  const f = fixture(t);
  fs.renameSync(path.join(f.bin, 'py.cmd'), path.join(f.bin, 'py.unavailable'));
  fs.copyFileSync(path.join(f.dir, 'templates/python.cmd'), path.join(f.bin, 'python.cmd'));
  check(f.run(), 0, { python: 'present' });
});

for (const flag of ['-Yes', '-NonInteractive']) {
  scenario(`${flag} installs missing prerequisites without answers and leaves Codex optional`, t => {
    const f = fixture(t, { missing: ['gh', 'python', 'codex', 'vscode'], extensions: '' });
    const r = f.run([flag]);
    check(r, 0, { gh: 'installed', python: 'installed', codex: 'declined', vscode: 'installed',
      'vscode-ext-claude-code': 'installed', 'vscode-ext-codex': 'declined' });
    for (const argv of text(f.log).trim().split(/\r?\n/)) {
      for (const option of ['--silent', '--accept-package-agreements', '--accept-source-agreements']) assert.ok(argv.includes(option), argv);
    }
    assert.match(r.stdout, /PREREQ gh: installed gh 2\.50\.0/);
    assert.match(r.stdout, /PREREQ python: installed 3\.13\.2/);
  });
}
scenario('-Yes reports required install failure and lists the missing prerequisite', t => {
  const f = fixture(t, { missing: ['gh'], installExit: 42 });
  const r = f.run(['-Yes', '-NoEditor']);
  check(r, 3, { gh: 'install-failed' });
  assert.match(r.stdout, /PREREQ gh: FAILED .*42/);
  assert.match(r.stdout, /REQUIRED PREREQUISITES FAILED: gh/);
  assert.match(text(f.log), /install gh/);
});
scenario('-Yes -WithCodex opts into Codex while -NoCodex still wins', t => {
  const f = fixture(t, { missing: ['codex'] });
  check(f.run(['-Yes', '-WithCodex']), 0, { codex: 'installed' });
  const excluded = fixture(t, { missing: ['codex'] });
  check(excluded.run(['-Yes', '-WithCodex', '-NoCodex']), 0, { codex: 'declined' });
});
scenario('-Yes rejects a successful installer that leaves the tool unusable', t => {
  const f = fixture(t, { missing: ['gh'], noCreate: true });
  const r = f.run(['-Yes', '-NoEditor']);
  check(r, 3, { gh: 'installed-unverified' });
  assert.match(r.stdout, /PREREQ gh: FAILED recheck/);
});
scenario('-Yes reports the installed extension version', t => {
  const f = fixture(t, { extensions: '', extensionVersions: true });
  const r = f.run(['-Yes']);
  check(r, 0, { 'vscode-ext-claude-code': 'installed' });
  assert.match(r.stdout, /PREREQ vscode-ext-claude-code: installed 1\.2\.3/);
});

test('PowerShell forbidden-token detector rejects realistic planted tokens', () => {
  const forbidden = /\[(?:Math|Environment|System\.[^\]]+)\]|\b(?:Add-Type|Invoke-Expression|iex|Set-ExecutionPolicy|Unblock-File|RunAs)\b/i;
  assert.equal(forbidden.test(text(script)), false);
  for (const bad of ['[Math]::Min(1,2)', '[Environment]::GetEnvironmentVariable("PATH")', '[System.Console]::WriteLine("x")', 'Add-Type x', 'Invoke-Expression $route', 'iex $route', 'Set-ExecutionPolicy Bypass', 'Unblock-File script.ps1', 'Start-Process powershell -Verb RunAs']) assert.equal(forbidden.test(bad), true, bad);
});
test('shipped TSV has nine ids and only sourced or pending routes', () => {
  const lines = text(manifest).trimEnd().split(/\r?\n/); assert.equal(lines[0], 'id\tprobe\tmin_version\troute\tscope\televation\tsource');
  const rows = lines.slice(1).map(l => l.split('\t')); assert.deepEqual(rows.map(r => r[0]), ids);
  for (const row of rows) { assert.equal(row.length, 7); assert.equal(row[6] === 'none', row[3] === 'ROUTE-PENDING'); }
});
