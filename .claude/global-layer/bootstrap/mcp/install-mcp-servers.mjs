import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
export const minimumAgeMs = 14 * 24 * 60 * 60 * 1000;

export function run(command, args, options = {}) {
  // JS entrypoints let the offline Claude stub run identically on Windows and POSIX.
  if (/\.(?:mjs|cjs|js)$/i.test(command)) {
    args = [command, ...args];
    command = process.execPath;
  }
  const result = spawnSync(command, args, {
    encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
    windowsHide: true, shell: false, ...options,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${path.basename(command)} failed (exit ${result.status}): ${result.error?.message || result.stderr?.trim() || result.stdout?.trim()}`);
  }
  return result.stdout;
}

export function runClaude(claude = 'claude', args, options = {}) {
  if (process.platform === 'win32') {
    if (!path.isAbsolute(claude) && !/[\\/]/.test(claude)) {
      const where = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe');
      const candidates = run(where, [claude], options).trim().split(/\r?\n/);
      claude = candidates.find(candidate => /\.(?:exe|cmd|bat)$/i.test(candidate)) || candidates[0];
    }
    if (/\.(?:cmd|bat)$/i.test(claude)) {
      // cmd.exe expands percent variables even inside quotes. Reject expansion/control
      // characters and quote each argument so paths containing spaces retain their boundaries.
      const quote = value => {
        if (/["%!\r\n\0]/.test(value)) throw new Error('Unsupported character in Claude shim argument');
        return `"${value}"`;
      };
      return run(quote(claude), args.map(quote), { ...options, shell: true });
    }
  }
  return run(claude, args, options);
}

function npm(args, options) {
  if (process.platform === 'win32') {
    const cli = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
    if (!fs.existsSync(cli)) throw new Error('Cannot locate npm-cli.js beside Node; install npm with Node.');
    return run(cli, args, options);
  }
  return run('npm', args, options);
}

function inside(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') ||
      path.posix.isAbsolute(relative) || relative.includes(':') ||
      relative.split('/').some(part => part === '..' || part === '.')) {
    throw new Error(`Unsafe relative path: ${relative}`);
  }
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(path.resolve(root) + path.sep)) throw new Error(`Path escapes root: ${relative}`);
  return resolved;
}

export function validateServers(servers) {
  if (!Array.isArray(servers) || !servers.length) throw new Error('servers.json must be a nonempty array');
  const names = new Set();
  for (const server of servers) {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(server.name) || names.has(server.name)) throw new Error('Invalid or duplicate server name');
    names.add(server.name);
    if (!/^(?:@[a-z0-9_-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(server.package)) throw new Error('Invalid npm package');
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(server.version)) throw new Error('An exact stable pinned version is required');
    inside(here, server.entrypoint);
    const prefix = ['mcp', 'add', '{name}', '--scope', 'user', '--', 'node', '{entrypoint}'];
    if (!Array.isArray(server.claudeAdd) ||
        prefix.some((part, i) => server.claudeAdd[i] !== part) ||
        server.claudeAdd.some(part => typeof part !== 'string' || /[\r\n\0]/.test(part)) ||
        server.claudeAdd.slice(prefix.length).some(part => /[{}]/.test(part))) {
      throw new Error(`${server.name}: only the pinned node registration form is allowed; npx is rejected`);
    }
  }
  return servers;
}

export function checkAge(metadata, server, now = Date.now()) {
  const published = metadata.time?.[server.version];
  const timestamp = typeof published === 'string' ? Date.parse(published) : NaN;
  if (!Number.isFinite(timestamp) || !Number.isFinite(now)) throw new Error(`${server.name}: missing or invalid publication date`);
  if (now - timestamp < minimumAgeMs) throw new Error(`${server.name}: ${server.version} must be at least 14 days old (published ${published})`);
}

function unpack(tarball, target, integrity) {
  if (typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) throw new Error('Missing SHA-512 registry integrity');
  const actual = `sha512-${createHash('sha512').update(fs.readFileSync(tarball)).digest('base64')}`;
  if (actual !== integrity) throw new Error('Tarball registry integrity mismatch');
  // GNU tar (Git for Windows, first on PATH) reads "C:" as a remote host and rejects backslash -C paths.
  // Pass the archive by bare name from its own directory, and the target with forward slashes.
  const entries = run('tar', ['-tzf', path.basename(tarball)], { cwd: path.dirname(tarball) }).trim().split(/\r?\n/);
  for (const entry of entries) {
    if (entry === 'package/' || entry === 'package') continue;
    if (!entry.startsWith('package/')) throw new Error('Tarball must contain only package/ entries');
    inside(target, entry.slice(8).replace(/\/$/, ''));
  }
  // Reject links and special files before extracting anything.
  const details = run('tar', ['-tvzf', path.basename(tarball)], { cwd: path.dirname(tarball) }).trim().split(/\r?\n/);
  if (details.some(line => !/^[-d]/.test(line))) throw new Error('Tarball links and special files are not supported');
  run('tar', ['-xzf', path.basename(tarball), '--strip-components=1', '-C', target.split(path.sep).join('/')], { cwd: path.dirname(tarball) });
}

export function connectionStatus(output, name) {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, '');
  const lines = clean.split(/\r?\n/).map(line => line.trim()).filter(line => line.startsWith(`${name}:`));
  if (lines.length !== 1) return 'Failed: server missing or ambiguous in claude mcp list';
  return !/✗|\b(?:Failed|Error)\b/i.test(lines[0]) && / - (?:[✔✓]\s*)?Connected\s*$/.test(lines[0])
    ? 'Connected' : `Failed: ${lines[0]}`;
}

export function checkServers({ configDir, claude = 'claude', servers, cwd = configDir, env = process.env }) {
  servers = validateServers(servers ?? JSON.parse(fs.readFileSync(path.join(here, 'servers.json'), 'utf8')));
  let listing;
  try {
    listing = runClaude(claude, ['mcp', 'list'], { cwd, env: { ...env, CLAUDE_CONFIG_DIR: path.resolve(configDir) } });
  } catch (error) {
    return servers.map(server => ({ name: server.name, status: `Failed: ${error.message}` }));
  }
  return servers.map(server => ({ name: server.name, status: connectionStatus(listing, server.name) }));
}

export function installServers({ home, configDir, registry, claude = 'claude', servers, check = false, ensure = false,
  now = Date.now(), report = console.log } = {}) {
  if (typeof home !== 'string' || !home) throw new Error('--home is required');
  servers = validateServers(servers ?? JSON.parse(fs.readFileSync(path.join(here, 'servers.json'), 'utf8')));
  home = path.resolve(home);
  configDir = path.resolve(configDir || path.join(home, '.claude'));
  const cliOptions = { cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home,
    CLAUDE_CONFIG_DIR: configDir } };
  if (check) {
    const results = checkServers({ configDir, claude, servers, cwd: home, env: cliOptions.env });
    for (const result of results) report(`${result.name}: ${result.status}`);
    return results;
  }
  registry = registry ? path.resolve(registry) : undefined;
  const root = path.join(home, '.mcp-servers');
  const fixture = registry ? JSON.parse(fs.readFileSync(path.join(registry, 'registry.json'), 'utf8')) : null;
  // All metadata and age checks precede installation and Claude calls.
  const plans = servers.map(server => {
    const target = path.join(root, server.name);
    if (fs.existsSync(target)) {
      if (ensure && fs.existsSync(path.join(target, '.install-complete'))) return { server, target, existing: true };
      if (!ensure) throw new Error(`${server.name}: target already exists; refusing to overwrite ${target}`);
    }
    const metadata = fixture ? fixture.packages?.[server.package] : JSON.parse(npm(['view', server.package, 'time', '--json']));
    if (!metadata) throw new Error(`${server.name}: package missing from fixture registry`);
    checkAge(fixture ? metadata : { time: metadata }, server, now);
    const release = fixture ? metadata.versions?.[server.version] : JSON.parse(npm(['view', `${server.package}@${server.version}`, 'dist', '--json']));
    if (!release) throw new Error(`${server.name}: version missing from registry`);
    return { server, target, release };
  });
  fs.mkdirSync(root, { recursive: true });
  // A failed list is not evidence of missing registration; do not add blindly.
  const prior = ensure ? runClaude(claude, ['mcp', 'list'], cliOptions).replace(/\x1b\[[0-9;]*m/g, '') : '';
  const failures = new Map();
  for (const { server, target, release, existing } of plans) {
    try {
      if (!existing) {
        if (fs.existsSync(target)) {
          // target is an immediate child of root with a validated server name.
          report(`${server.name}: partial installation found; removing and reinstalling ${target}`);
          fs.rmSync(target, { recursive: true });
        }
        fs.mkdirSync(target);
        let tarball;
        if (fixture) {
          tarball = inside(registry, release.tarball);
        } else {
          const packed = JSON.parse(npm(['pack', `${server.package}@${server.version}`,
            '--ignore-scripts', '--json', '--pack-destination', target], { cwd: target }));
          if (!Array.isArray(packed) || packed.length !== 1) throw new Error('Unexpected npm pack output');
          tarball = inside(target, packed[0].filename);
        }
        unpack(tarball, target, release.integrity);
      }
      const pkg = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'));
      if (pkg.name !== server.package || pkg.version !== server.version) throw new Error('Unpacked package does not match pin');
      if (!existing && !fixture) npm(['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: target });
      // Fixture archives are self-contained; they never invoke npm or fetch dependencies.
      const entrypoint = inside(target, server.entrypoint);
      if (!fs.lstatSync(entrypoint).isFile()) throw new Error('Entrypoint must be a regular file');
      if (!existing) fs.writeFileSync(path.join(target, '.install-complete'), `${server.package}@${server.version}\n`, { flag: 'wx' });
      const args = server.claudeAdd.map(arg => arg === '{name}' ? server.name : arg === '{entrypoint}' ? entrypoint : arg);
      if (!ensure || !prior.split(/\r?\n/).some(line => line.trim().startsWith(`${server.name}:`))) {
        runClaude(claude, args, cliOptions);
      }
    } catch (error) {
      failures.set(server.name, `Failed: ${error.message}`);
    }
  }
  let listing = '';
  let listFailure;
  try { listing = runClaude(claude, ['mcp', 'list'], cliOptions); }
  catch (error) { listFailure = `Failed: ${error.message}`; }
  const results = plans.map(({ server }) => ({ name: server.name,
    status: failures.get(server.name) || listFailure || connectionStatus(listing, server.name) }));
  for (const result of results) report(`${result.name}: ${result.status}`);
  return results;
}

function main(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i] === '--config-dir' ? 'configDir' : args[i].slice(2);
    if (['--check', '--ensure'].includes(args[i]) && !options[key]) { options[key] = true; continue; }
    if (!['--home', '--config-dir', '--registry', '--claude'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') ||
        Object.hasOwn(options, key)) throw new Error('Usage: node install-mcp-servers.mjs --home <dir> [--config-dir <dir>] [--registry <dir>] [--claude <cli>] [--check | --ensure]');
    options[key] = args[++i];
  }
  if (options.check && options.ensure) throw new Error('--check and --ensure are mutually exclusive');
  const results = installServers(options);
  return results.every(result => result.status === 'Connected') ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
