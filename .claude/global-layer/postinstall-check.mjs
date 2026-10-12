#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { shippedAgents } from './sync-harness-from-source.mjs';
import { checkServers } from './bootstrap/mcp/install-mcp-servers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const flatCommands = groups => Array.isArray(groups)
  ? groups.flatMap(group => Array.isArray(group?.hooks) ? group.hooks : [])
    .filter(hook => hook?.type === 'command' && typeof hook.command === 'string' && hook.command.trim()) : [];
const agentCount = root => fs.readdirSync(path.join(root, 'agents'), { withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name.endsWith('.md')).length;
const status = result => result.error ? `process error ${result.error.code || 'unknown'}`
  : result.signal ? `signal ${result.signal}` : `exit ${result.status}`;

export function parseMeterOutput(output) {
  const line = String(output).trim();
  // usage_meters.py cached_view/show emits exactly one Plan meters line. Ages alone are not meters.
  if (!/^Plan meters(?: \(cache [^\r\n()]+ old\))?: [^\r\n]+$/.test(line)) return false;
  const body = line.slice(line.indexOf(': ') + 2);
  return /\b(?:not-signed-in|UNKNOWN|stale|unavailable)\b/.test(body)
    || /\b\d+(?:\.\d+)?% used\b/.test(body)
    || /\blimit \$\d+(?:\.\d+)?\b/.test(body);
}

function declaredEvents(payload) {
  const manifest = path.join(payload, 'harness-MANIFEST.json');
  let events;
  if (fs.existsSync(manifest)) {
    const wiring = readJSON(manifest).wire_project;
    if (!wiring || typeof wiring !== 'object' || Array.isArray(wiring)) throw new Error('payload manifest has no wire_project event map');
    events = Object.keys(wiring);
  } else {
    // The source seed consumes the event list produced by sync's wireProject (not a separate hardcoded list).
    const seed = fs.readFileSync(path.join(payload, 'global-layer', 'harness-seed.mjs'), 'utf8');
    if (!seed.includes('wire_project')) throw new Error('payload seed event source is unsupported');
    const sync = fs.readFileSync(path.join(payload, 'global-layer', 'sync-harness-from-source.mjs'), 'utf8');
    const table = sync.match(/const WIRED = \[([\s\S]*?)\n\];/);
    if (!table) throw new Error('payload seed event list is missing');
    events = [...table[1].matchAll(/event:\s*'([^']+)'/g)].map(match => match[1]);
  }
  if (!events.length) throw new Error('payload declares no hook events');
  return [...new Set([...events, 'SessionStart'])];
}

// Use the installed launcher's discovery/dispatch function. Its injectable spawn lets --python
// select an executable without changing the launcher or relying on a broken platform py command.
const PYTHON_CHILD = `
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const [launcher, python, ...args] = process.argv.slice(2);
const { spawnPython } = await import(pathToFileURL(launcher).href);
const spawn = (bin, argv, options) => spawnSync(python || bin, argv, { ...options, timeout: 30000, windowsHide: true });
const result = spawnPython(args, { stdio: 'inherit' }, spawn);
process.exitCode = result.error || result.signal || result.status === null ? 1 : result.status;
`;

export function main(argv = process.argv.slice(2)) {
  const options = { '--payload': path.resolve(HERE, '..'), '--python': '' };
  let inputError = '';
  for (let i = 0; i < argv.length; i++) {
    if (!['--config-dir', '--payload', '--python', '--claude'].includes(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--')) {
      inputError = 'expected --config-dir <dir> [--payload <dir>] [--python <exe>] [--claude <cli>]';
      break;
    }
    options[argv[i]] = argv[++i];
  }
  if (!options['--config-dir']) inputError = '--config-dir is required';
  const config = path.resolve(options['--config-dir'] || '.');
  let payload = path.resolve(options['--payload']);
  if (fs.existsSync(path.join(payload, '.claude', 'agents'))) payload = path.join(payload, '.claude');
  const skips = new Set((process.env.POSTINSTALL_SKIP_LEGS || '').split(',').map(s => s.trim()).filter(Boolean));
  if ([...skips].some(leg => !['a', 'd', 'e'].includes(leg))) inputError = 'only fixture legs a,d,e may be skipped';
  const env = { ...process.env, CLAUDE_CONFIG_DIR: config, CLAUDE_PROJECT_DIR: config,
    HARNESS_GLOBAL_ROOT: config, PYTHONDONTWRITEBYTECODE: '1' };
  const run = (command, args, input) => spawnSync(command, args, {
    cwd: config, env, input, encoding: 'utf8', timeout: 30000, maxBuffer: 4 << 20, windowsHide: true,
  });
  const python = args => run(process.execPath, ['--input-type=module', '-e', PYTHON_CHILD, '--', 'postinstall-python-probe',
    path.join(config, 'tools', '_py.mjs'), options['--python'], ...args]);
  const failures = [];
  let elapsed = 0;
  const leg = (letter, check) => {
    if (!inputError && skips.has(letter)) { console.log(`leg ${letter}: SKIP`); return; }
    try {
      if (inputError) throw new Error(inputError);
      const reason = check();
      console.log(`leg ${letter}: PASS ${reason}`);
    } catch (error) {
      failures.push(letter);
      console.log(`leg ${letter}: FAIL ${String(error.message).replace(/[\r\n]+/g, ' ')}`);
    }
  };
  leg('a', () => {
    const r = run(process.execPath, [path.join(HERE, 'harness-install.mjs'), 'doctor', '--config-dir', config]);
    if (r.status !== 0 || r.error) throw new Error(`doctor ${status(r)}`);
    return 'doctor exit 0';
  });
  leg('b', () => {
    const events = declaredEvents(payload);
    const settings = readJSON(path.join(config, 'settings.json'));
    const missing = events.filter(event => !flatCommands(settings.hooks?.[event]).length);
    const entries = flatCommands(settings.hooks?.SessionStart);
    const seedFile = path.join(config, 'tools', 'harness-seed.mjs');
    const seedEntry = entries.find(entry => Array.isArray(entry.args)
      && entry.args.some(arg => typeof arg === 'string' && path.resolve(config, arg) === seedFile));
    if (!seedEntry) throw new Error(`SessionStart seed command is not wired${missing.length ? `; unwired events: ${missing.join(',')}` : ''}`);
    const log = path.join(config, 'hooks', 'harness-seed.log');
    const before = fs.existsSync(log) ? fs.statSync(log).size : 0;
    const input = JSON.stringify({ session_id: 'postinstall-check', hook_event_name: 'SessionStart', cwd: config });
    const start = performance.now();
    let r;
    try {
      // Execute the command actually wired by wireGlobal, including all its arguments, without a shell.
      r = run(seedEntry.command, seedEntry.args, input);
    } finally { elapsed = performance.now() - start; }
    if (r.status !== 0 || r.error) throw new Error(`SessionStart ${status(r)}`);
    if (!fs.existsSync(log) || fs.statSync(log).size <= before) throw new Error('SessionStart did not append its log marker');
    const fd = fs.openSync(log, 'r');
    let appended;
    try {
      const bytes = Buffer.alloc(fs.fstatSync(fd).size - before);
      const length = fs.readSync(fd, bytes, 0, bytes.length, before);
      appended = bytes.subarray(0, length).toString('utf8');
    } finally { fs.closeSync(fd); }
    const marked = appended.trim().split(/\r?\n/).some(line => {
      try {
        const row = JSON.parse(line);
        return row.hook === 'harness-seed.mjs' && row.cwd === config && row.scope === 'global'
          && ['skip', 'seeded'].includes(row.action);
      } catch { return false; }
    });
    if (!marked) throw new Error('SessionStart appended no valid marker for the synthetic cwd');
    if (missing.length) throw new Error(`unwired events: ${missing.join(',')}`);
    return `${events.length} events wired; fresh SessionStart log marker`;
  });
  leg('c', () => {
    if (fs.realpathSync(config) === fs.realpathSync(payload)) throw new Error('payload must be independent of config for agent counting');
    const expected = shippedAgents(path.join(payload, 'agents')).length;
    const actual = agentCount(config);
    if (!expected || actual !== expected) throw new Error(`agents ${actual}; payload ${expected}`);
    return `agents ${actual}; payload ${expected}`;
  });
  leg('d', () => {
    const results = ['plan_progress.py', 'dispatch_planner.py'].map(tool => {
      const r = python([path.join(config, 'tools', tool), '--help']);
      return { tool, r };
    });
    const failed = results.filter(({ r }) => r.status !== 0 || r.error);
    if (failed.length) throw new Error(failed.map(({ tool, r }) => `${tool} --help ${status(r)}`).join('; '));
    return 'both --help commands exit 0 via tools/_py.mjs';
  });
  leg('e', () => {
    const r = python([path.join(config, 'tools', 'usage_meters.py'), 'show', '--profile-dir', config]);
    if (r.status !== 0 || r.error) throw new Error(`usage_meters.py show ${status(r)}`);
    if (!parseMeterOutput(r.stdout)) throw new Error('usage_meters.py show output is empty or not a documented meter/status line');
    return r.stdout.trim();
  });
  console.log(`leg f: PASS ${elapsed.toFixed(3)} ms`);
  leg('g', () => {
    const results = checkServers({ configDir: config, claude: options['--claude'], env });
    const missing = results.filter(result => result.status !== 'Connected');
    if (missing.length) throw new Error(missing.map(result => `${result.name}: ${result.status}`).join('; '));
    return results.map(result => `${result.name}: Connected`).join('; ');
  });
  console.log(failures.length ? `POSTINSTALL FAIL ${failures.join(',')}` : 'POSTINSTALL PASS');
  return failures.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
