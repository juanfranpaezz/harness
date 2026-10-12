import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const script = path.join(here, 'harness-bootstrap.sh');
const manifest = path.join(here, 'prereqs-posix.tsv');
const ids = ['git', 'node', 'python', 'claude', 'gh', 'codex', 'vscode',
  'vscode-ext-claude-code', 'vscode-ext-codex'];
const required = ids.slice(0, 5);
const posix = (p) => p.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;

function findShell(name) {
  const candidates = process.platform === 'win32'
    ? [path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git', 'usr', 'bin', `${name}.exe`),
      path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git', 'bin', `${name}.exe`)]
    : [name];
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['-c', 'exit 0'], { encoding: 'utf8', timeout: 60_000 });
    if (!result.error && result.status === 0) return candidate;
  }
  return null;
}
const sh = findShell('sh');
const dash = findShell('dash');
const bash = findShell('bash');
console.log(`POSIX shell: ${sh || 'sh not found'}`);
console.log(`Additional shell: ${dash || 'dash not found (not exercised)'}`);
const utilities = ['awk', 'sed', 'tr', 'dirname', 'uname', 'cp', 'mktemp', 'sha256sum', 'shasum', 'timeout'];
const located = new Map();
if (sh) {
  for (const utility of utilities) {
    const result = spawnSync(sh, ['-c', `command -v ${utility}`], { encoding: 'utf8', timeout: 60_000 });
    if (result.status === 0) located.set(utility, result.stdout.trim());
  }
}

function behavior(name, body) {
  test(name, { skip: !sh && process.env.BOOTSTRAP_POSIX_REQUIRED !== '1' ? 'sh not found' : false }, (t) => {
    assert.ok(sh, 'sh not found; BOOTSTRAP_POSIX_REQUIRED=1');
    body(t);
  });
}
function writeExecutable(file, contents) {
  fs.writeFileSync(file, `#!/bin/sh\n${contents}\n`, { flag: 'wx', mode: 0o755 });
}
function fixture(t, options = {}) {
  const parent = path.join(root, '.tmp-bootstrap-posix-tests');
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, options.spaces ? 'case with spaces-' : 'case-'));
  t.after(() => {
    // Only remove the exact directory created by this fixture, within our root.
    assert.equal(path.dirname(dir), parent);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const bin = path.join(dir, 'bin');
  const templates = path.join(dir, 'templates');
  fs.mkdirSync(bin);
  fs.mkdirSync(templates);
  for (const [name, executable] of located) {
    if (name === 'timeout' && options.noTimeout) continue;
    writeExecutable(path.join(bin, name), `exec ${quote(executable)} "$@"`);
  }
  writeExecutable(path.join(bin, 'sh'), `exec ${quote(posix(sh))} "$@"`);
  writeExecutable(path.join(bin, 'id'), `[ "$1" = -u ] || exit 2; printf '%s\\n' ${quote(String(options.uid ?? 1000))}`);
  const log = path.join(dir, 'pkg.log');
  const probeLog = path.join(dir, 'probe.log');
  const extensions = path.join(dir, 'extensions.txt');
  fs.writeFileSync(extensions, (options.extensions || ['anthropic.claude-code', 'openai.chatgpt']).join('\n') + '\n', { flag: 'wx' });
  fs.writeFileSync(log, '', { flag: 'wx' });
  fs.writeFileSync(probeLog, '', { flag: 'wx' });
  for (const id of ids.slice(0, 7)) {
    const command = id === 'python' ? 'python3' : id === 'vscode' ? 'code' : id;
    const version = id === 'node' ? (options.nodeVersion || 'v26.0.0') : `${id} 2.0.0`;
    const source = `printf '%s\\n' ${quote(id + ' ')}"$*" >> "$PROBE_LOG"
case "$1" in
  --version) printf '%s\\n' ${quote(version)} ;;
  --experimental-vm-modules) printf '%s\\n' ${quote(options.badNodeMarker ? 'WRONG-MARKER' : 'ADMISSION-OK')} ;;
  -c) ${options.badPython ? 'exit 1' : "echo ADMISSION-OK"} ;;
  --list-extensions) while IFS= read -r line; do printf '%s\\n' "$line"; done < "$EXTENSIONS_FILE" ;;
  --install-extension) printf '%s\\n' "extension $2" >> "$PKG_LOG"; printf '%s\\n' "$2" >> "$EXTENSIONS_FILE" ;;
  *) exit 99 ;;
esac`;
    writeExecutable(path.join(templates, command), source);
    if (!(options.missing || []).includes(id)) {
      fs.copyFileSync(path.join(templates, command), path.join(bin, command));
      fs.chmodSync(path.join(bin, command), 0o755);
    }
  }
  for (const manager of options.managers || ['apt-get']) {
    writeExecutable(path.join(bin, manager), 'echo "Unexpected package manager execution" >&2; exit 97');
  }
  writeExecutable(path.join(bin, 'sudo'), `printf '%s\\n' "sudo $*" >> "$PKG_LOG"; exec "$@"`);
  writeExecutable(path.join(bin, 'curl'), `printf '%s\\n' download >> "$PKG_LOG"
while [ "$#" -gt 0 ]; do
  if [ "$1" = --output ]; then cp "$TEMPLATES/downloaded.sh" "$2"; exit $?; fi
  shift
done
exit 1`);
  writeExecutable(path.join(templates, 'downloaded.sh'), 'printf "%s\\n" run-script >> "$PKG_LOG"; cp "$TEMPLATES/gh" "$FIXTURE_BIN/gh"');
  writeExecutable(path.join(bin, 'pkg'), `printf '%s\\n' "pkg $*" >> "$PKG_LOG"
[ "\${PKG_FAIL:-0}" = 0 ] || exit "$PKG_FAIL"
[ "\${PKG_UNVERIFIED:-0}" = 0 ] || exit 0
command=$1
case $command in python) command=python3 ;; vscode) command=code ;; esac
cp "$TEMPLATES/$command" "$FIXTURE_BIN/$command"`);
  const rows = fs.readFileSync(manifest, 'utf8').trimEnd().split('\n').map((line) => line.split('\t'));
  for (const row of rows.slice(1)) {
    row[3] = row[4] = row[5] = options.pending === row[0] ? 'ROUTE-PENDING' : `pkg ${row[0]}`;
    if (row[1].startsWith('code:') && options.pending !== row[0]) row[3] = row[4] = row[5] = `code --install-extension ${row[1].slice(5)}`;
    row[6] = options.sudo ? 'manager' : 'none';
    row[7] = 'fixture';
  }
  if (options.mutateManifest) options.mutateManifest(rows);
  const fixtureManifest = path.join(dir, 'prerequisites.tsv');
  fs.writeFileSync(fixtureManifest, rows.map((row) => row.join('\t')).join('\n') + '\n', { flag: 'wx' });
  const answerFile = path.join(dir, 'answers.txt');
  if (options.answers !== undefined) fs.writeFileSync(answerFile, options.answers, { flag: 'wx' });
  const summary = path.join(dir, 'summary.json');
  const env = {
    PATH: posix(bin),
    // Deliberately do not inherit login state or credential variables.
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } : {}),
    LC_ALL: 'C', TMPDIR: posix(dir),
    PKG_LOG: posix(log), PROBE_LOG: posix(probeLog), TEMPLATES: posix(templates), FIXTURE_BIN: posix(bin),
    EXTENSIONS_FILE: posix(extensions),
    PKG_FAIL: options.fail ? '1' : '0', PKG_UNVERIFIED: options.unverified ? '1' : '0',
  };
  const args = [posix(script), '--os', options.os || 'linux', '--manifest', posix(fixtureManifest),
    '--summary-json', posix(summary)];
  if (options.answers !== undefined) args.push('--answers', posix(answerFile));
  args.push(...(options.flags || []));
  // Exercise the unchanged script with only its terminal predicate stubbed.
  // This is simulated consent, not evidence of a real terminal or sudo prompt.
  const terminalShim = 'function [ { if test "$#" -eq 3 && test "$1" = -t && test "$2" = 0; then return 0; fi; builtin [ "$@"; }; . "$0"';
  if (options.interactive) assert.ok(bash, 'bash is required for the simulated terminal fixture');
  const result = spawnSync(options.interactive ? bash : options.shell || sh,
    options.interactive ? ['-c', terminalShim, ...args] : args,
    { cwd: root, env, encoding: 'utf8', timeout: 60_000, input: options.input || '' });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.stdout.split(/\r?\n/)[0], 'BOOTSTRAP STARTED');
  const data = fs.existsSync(summary) ? JSON.parse(fs.readFileSync(summary, 'utf8')) : null;
  return { ...result, data, log: fs.readFileSync(log, 'utf8'), probes: fs.readFileSync(probeLog, 'utf8') };
}
function check(result, expected = {}, exit = 0) {
  assert.equal(result.status, exit, result.stdout + result.stderr);
  assert.ok(result.data, result.stderr);
  assert.equal(result.data.schema, 'harness-bootstrap-summary/1');
  assert.deepEqual(result.data.items.map((row) => row.id), ids);
  assert.deepEqual(Object.keys(result.data).sort(), ['schema', 'os', 'dry_run', 'items', 'next', 'deferred'].sort());
  for (const row of result.data.items) {
    assert.equal(row.status, expected[row.id] || (required.includes(row.id) ? 'present' : 'declined'), `${row.id}: ${result.stdout}`);
    assert.deepEqual(Object.keys(row).sort(), ['id', 'status', 'exit_code', 'version'].sort());
    assert.ok(row.exit_code === null || Number.isInteger(row.exit_code));
    assert.ok(row.version === null || typeof row.version === 'string');
  }
}

behavior('root is refused before probes or installations', (t) => {
  const result = fixture(t, { uid: 0 });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /refusing to run as root; pass --allow-root/);
  assert.equal(result.data, null);
  assert.equal(result.probes, '');
  assert.equal(result.log, '');
});
behavior('non-root uid 1000 proceeds', (t) => {
  check(fixture(t, { uid: 1000 }));
});
behavior('root proceeds only with explicit --allow-root', (t) => {
  check(fixture(t, { uid: 0, flags: ['--allow-root'] }));
});

behavior('all required rows present; non-interactive optional rows declined; exit 0', (t) => {
  const result = fixture(t);
  check(result);
  assert.equal(result.log, '');
  assert.deepEqual(result.data.deferred, []);
  assert.match(result.data.next, /^node .claude\/global-layer\/harness-install.mjs install /);
  assert.match(result.probes, /claude --version/);
  assert.deepEqual(result.probes.split('\n').filter((line) => line.startsWith('claude ')), ['claude --version']);
  assert.match(result.probes, /^git --version/m); // Prove fixture PATH precedence.
});
behavior('missing python offered, yes installs and rechecks', (t) => {
  const result = fixture(t, { missing: ['python'], answers: 'python=yes\n' });
  check(result, { python: 'installed' });
  assert.equal(result.log, 'pkg python\n');
  assert.match(result.stdout, /Package: Python \(python\)/);
  assert.match(result.probes, /python -c/);
});
behavior('declined gh never installs; exit 3 but core handoff remains available', (t) => {
  const result = fixture(t, { missing: ['gh'], answers: 'gh=no\n' });
  check(result, { gh: 'declined' }, 3);
  assert.equal(result.log, '');
  assert.deepEqual(result.data.deferred, []);
  assert.ok(result.data.next);
});
behavior('install failure does not stop later rows', (t) => {
  const result = fixture(t, { missing: ['git', 'python'], answers: 'git=yes\npython=yes\n', fail: true });
  check(result, { git: 'install-failed', python: 'install-failed' }, 3);
  assert.equal(result.log, 'pkg git\npkg python\n');
  assert.equal(result.data.items[0].exit_code, 1);
  assert.deepEqual(result.data.deferred, ['git', 'python']);
  assert.equal(result.data.next, null);
});
behavior('node v20 fails admission and is offered', (t) => {
  const result = fixture(t, { nodeVersion: 'v20.19.0', answers: 'node=no\n' });
  check(result, { node: 'declined' }, 3);
  assert.match(result.stdout, /Package: Node\.js \(node\)/);
  assert.deepEqual(result.data.deferred, ['node']);
});
behavior('node v26 with the admission marker is present without downgrade', (t) => {
  const result = fixture(t, { nodeVersion: 'v26.1.0', answers: 'node=yes\n' });
  check(result);
  assert.equal(result.data.items[1].version, 'v26.1.0');
  assert.equal(result.log, '');
  assert.match(result.probes, /--experimental-vm-modules/);
});
behavior('node v26 without the admission marker is declined', (t) => {
  check(fixture(t, { badNodeMarker: true, flags: ['--unattended'] }), { node: 'declined' }, 3);
});
behavior('python must provide the stdlib capability', (t) => {
  check(fixture(t, { badPython: true, flags: ['--unattended'] }), { python: 'declined' }, 3);
});
behavior('unattended declines unanswered missing rows and never calls pkg', (t) => {
  const result = fixture(t, { missing: required, flags: ['--unattended'] });
  check(result, Object.fromEntries(required.map((id) => [id, 'declined'])), 3);
  assert.equal(result.log, '');
});
behavior('piped yes without an answers file is not consent', (t) => {
  const result = fixture(t, { missing: ['python'], input: 'yes\n' });
  check(result, { python: 'declined' }, 3);
  assert.equal(result.log, '');
});
behavior('dry-run yes prints the command and never calls pkg or sudo', (t) => {
  const result = fixture(t, { missing: ['python'], answers: 'python=yes\n', flags: ['--dry-run'], sudo: true });
  check(result, { python: 'would-install' }, 3);
  assert.equal(result.data.dry_run, true);
  assert.match(result.stdout, /COMMAND: sudo sh -c 'pkg python'/);
  assert.equal(result.log, '');
});
behavior('ROUTE-PENDING is manual even with yes', (t) => {
  const result = fixture(t, { missing: ['gh'], pending: 'gh', answers: 'gh=yes\n' });
  check(result, { gh: 'manual' }, 3);
  assert.match(result.stdout, /docs\/harness\/INSTALL.md/);
  assert.equal(result.log, '');
});
behavior('macos without brew reports missing required rows as manual', (t) => {
  const result = fixture(t, { missing: ['python', 'gh'], os: 'macos', managers: [], answers: 'python=yes\ngh=yes\n' });
  check(result, { python: 'manual', gh: 'manual' }, 3);
  assert.equal(result.data.os, 'macos');
  assert.equal(result.log, '');
});
behavior('fixture paths containing spaces work', (t) => {
  check(fixture(t, { spaces: true, missing: ['python'], answers: 'python=yes\n' }), { python: 'installed' });
});
behavior('successful installer without a passing recheck is installed-unverified', (t) => {
  const result = fixture(t, { missing: ['python'], answers: 'python=yes\n', unverified: true });
  check(result, { python: 'installed-unverified' }, 3);
  assert.equal(result.data.items[2].exit_code, 0);
});
behavior('sudo occurs only after explicit consent', (t) => {
  const no = fixture(t, { missing: ['python'], answers: 'python=no\n', sudo: true });
  check(no, { python: 'declined' }, 3);
  assert.equal(no.log, '');
  const yes = fixture(t, { missing: ['python'], answers: 'python=yes\n', sudo: true });
  check(yes, { python: 'installed' });
  assert.equal(yes.log, 'sudo sh -c pkg python\npkg python\n');
});
behavior('dnf fallback and brew routes can install via stubs', (t) => {
  check(fixture(t, { managers: ['dnf'], missing: ['gh'], answers: 'gh=yes\n' }), { gh: 'installed' });
  check(fixture(t, { managers: ['brew'], os: 'macos', missing: ['gh'], answers: 'gh=yes\n' }), { gh: 'installed' });
});
behavior('optional switches and non-interactive yes never install optional rows', (t) => {
  const result = fixture(t, { missing: ['codex', 'vscode'], answers: ids.slice(5).map((id) => `${id}=yes`).join('\n'), flags: ['--no-editor', '--no-codex'] });
  check(result);
  assert.equal(result.log, '');
});
behavior('missing timeout is disclosed and probes still run', (t) => {
  const result = fixture(t, { noTimeout: true });
  check(result);
  assert.match(result.stdout, /timeout unavailable; probes ran unbounded/);
});
behavior('manifest validation rejects a missing row before probes', (t) => {
  const result = fixture(t, { mutateManifest: (rows) => rows.pop() });
  assert.equal(result.status, 2);
  assert.equal(result.data, null);
  assert.equal(result.probes, '');
  assert.equal(result.log, '');
});
behavior('manifest validation rejects duplicate ids and empty routes', (t) => {
  for (const mutateManifest of [(rows) => { rows[2] = [...rows[1]]; }, (rows) => { rows[1][3] = ''; }]) {
    const result = fixture(t, { mutateManifest });
    assert.equal(result.status, 2);
    assert.equal(result.data, null);
    assert.equal(result.probes, '');
  }
});
behavior('bad flags and duplicate answers exit 2', (t) => {
  for (const options of [{ flags: ['--unknown'] }, { flags: ['--os', 'windows'] }, { answers: 'gh=yes\ngh=no\n' }]) {
    const result = fixture(t, options);
    assert.equal(result.status, 2);
    assert.equal(result.data, null);
    assert.equal(result.log, '');
  }
});
behavior('unreviewed piped download routes never execute', (t) => {
  const result = fixture(t, { missing: ['gh'], answers: 'gh=yes\n', mutateManifest: (rows) => { rows[5][3] = 'curl https://example.invalid/install | sh'; } });
  check(result, { gh: 'manual' }, 3);
  assert.equal(result.log, '');
});
behavior('downloaded script cannot reuse first consent without a terminal', (t) => {
  const result = fixture(t, { missing: ['gh'], answers: 'gh=yes\n', mutateManifest: (rows) => { rows[5][3] = 'download-script https://example.invalid/install.sh'; } });
  check(result, { gh: 'manual' }, 3);
  assert.match(result.stdout, /Second script consent requires a terminal/);
  assert.equal(result.log, '');
});
if (bash) {
  const allPresent = Object.fromEntries(ids.map((id) => [id, 'present']));
  behavior('simulated terminal: present optional tools and extensions are skipped', (t) => {
    const result = fixture(t, { interactive: true });
    check(result, allPresent);
    assert.equal(result.log, '');
    assert.match(result.probes, /vscode --list-extensions/);
  });
  behavior('simulated terminal: missing Codex and editor are offered and verified', (t) => {
    const result = fixture(t, { interactive: true, missing: ['codex', 'vscode'], input: 'yes\ny\n' });
    check(result, { ...allPresent, codex: 'installed', vscode: 'installed' });
    assert.match(result.stdout, /Install Codex CLI \(codex\)\? \[y\/N\]/);
    assert.match(result.stdout, /Install Visual Studio Code \(vscode\)\? \[y\/N\]/);
    assert.equal(result.log, 'pkg codex\npkg vscode\n');
  });
  behavior('simulated terminal: missing extensions use code and recheck without brew', (t) => {
    const result = fixture(t, { interactive: true, extensions: [], os: 'macos', managers: [], input: 'yes\nyes\n' });
    check(result, { ...allPresent, 'vscode-ext-claude-code': 'installed', 'vscode-ext-codex': 'installed' });
    assert.equal(result.log, 'extension anthropic.claude-code\nextension openai.chatgpt\n');
  });
  behavior('simulated terminal: declined editor leaves extensions manual and exit 0', (t) => {
    const result = fixture(t, { interactive: true, missing: ['vscode'], input: 'no\n' });
    check(result, { ...allPresent, vscode: 'declined', 'vscode-ext-claude-code': 'manual', 'vscode-ext-codex': 'manual' });
    assert.equal(result.log, '');
    assert.match(result.stdout, /VS Code command is unavailable/);
  });
  behavior('simulated terminal: optional switches skip their exact rows', (t) => {
    check(fixture(t, { interactive: true, flags: ['--no-editor'] }), { ...allPresent, vscode: 'declined', 'vscode-ext-claude-code': 'declined', 'vscode-ext-codex': 'declined' });
    check(fixture(t, { interactive: true, flags: ['--no-codex'] }), { ...allPresent, codex: 'declined', 'vscode-ext-codex': 'declined' });
  });
  behavior('simulated terminal: downloaded scripts require a second yes after SHA256', (t) => {
    const options = { interactive: true, missing: ['gh'], answers: 'gh=yes\n', mutateManifest: (rows) => { rows[5][3] = 'download-script https://example.invalid/install.sh'; } };
    const no = fixture(t, { ...options, input: 'no\n' });
    check(no, { ...allPresent, gh: 'declined' }, 3);
    assert.match(no.stdout, /SHA256: [a-f0-9]{64}/);
    assert.equal(no.log, 'download\n');
    const yes = fixture(t, { ...options, input: 'yes\n' });
    check(yes, { ...allPresent, gh: 'installed' });
    assert.match(yes.stdout, /SHA256: [a-f0-9]{64}/);
    assert.equal(yes.log, 'download\nrun-script\n');
  });
} else {
  console.log('Simulated terminal cases not registered: bash not found; real terminal consent remains untested.');
}
behavior('POSIX syntax and forbidden constructs; detector has a positive control', () => {
  const contents = fs.readFileSync(script, 'utf8');
  const forbidden = /\|\s*(?:sh|bash)\b|\beval |sudo -S/;
  assert.equal(forbidden.test(contents), false);
  for (const planted of ['curl url | sh', 'curl url | bash', 'eval command', 'sudo -S']) assert.equal(forbidden.test(planted), true);
  for (const shell of new Set([sh, dash].filter(Boolean))) {
    const result = spawnSync(shell, ['-n', posix(script)], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(result.status, 0, result.stderr);
    const invalid = spawnSync(shell, ['-n'], { input: 'if then\n', encoding: 'utf8', timeout: 60_000 });
    assert.notEqual(invalid.status, 0);
  }
});
behavior('dash executes present, install and decline cases when available', (t) => {
  // Absence is reported above, not misrepresented as exercised portability.
  if (!dash) return;
  check(fixture(t, { shell: dash }));
  check(fixture(t, { shell: dash, missing: ['python'], answers: 'python=yes\n' }), { python: 'installed' });
  const result = fixture(t, { shell: dash, missing: ['gh'], answers: 'gh=no\n' });
  check(result, { gh: 'declined' }, 3);
  assert.equal(result.log, '');
});
