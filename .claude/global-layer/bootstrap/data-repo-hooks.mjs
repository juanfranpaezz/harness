import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const marker = '# harness-data-repo-hooks-v1 ';
const names = ['pre-commit', 'pre-push'];
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const shellPath = value => process.platform === 'win32' ? value.replaceAll('\\', '/') : value;

function run(exe, args) {
  const result = spawnSync(exe, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error('command unavailable or failed: ' + exe);
  return result.stdout.trim();
}

function hook(name, config) {
  const prefix = `#!/bin/bash\n${marker}${JSON.stringify(config)}\nset -eu\n`;
  const invoke = `${quote(shellPath(config.python))} ${quote(shellPath(config.gate))}`;
  const repo = quote(shellPath(config.repo));
  if (name === 'pre-commit') return prefix + `exec ${invoke} check-staged ${repo}\n`;
  return prefix + `while read -r local_ref local_sha remote_ref remote_sha; do
  case "$local_sha" in
    0000000000000000000000000000000000000000|0000000000000000000000000000000000000000000000000000000000000000) continue ;;
  esac
  ${invoke} check-outgoing ${repo} "$1" "$local_sha" "$remote_sha" || exit $?
done
`;
}

function regular(file) {
  if (!fs.lstatSync(file).isFile()) throw new Error('not a regular file: ' + file);
}

function readOwned(file, name, repo) {
  regular(file);
  const text = fs.readFileSync(file, 'utf8');
  const line = text.split('\n')[1];
  if (!line?.startsWith(marker)) throw new Error('unmanaged hook: ' + name);
  const config = JSON.parse(line.slice(marker.length));
  if (config.repo !== repo || text !== hook(name, config)) throw new Error('modified hook: ' + name);
  return config;
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!['install', 'check', 'uninstall'].includes(command)) throw new Error('expected install, check, or uninstall');
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!['--data-repo', '--gate', '--python'].includes(key) || !args[i + 1] || key in options) throw new Error('invalid options');
    options[key] = args[i + 1];
  }
  if (!options['--data-repo']) throw new Error('--data-repo is required');
  const repo = fs.realpathSync(options['--data-repo']);
  const gitDir = path.join(repo, '.git');
  if (!fs.lstatSync(gitDir).isDirectory()) throw new Error('a standalone Git repository is required');
  if (fs.realpathSync(run('git', ['-C', repo, 'rev-parse', '--show-toplevel'])) !== repo) throw new Error('repository root required');
  const configured = spawnSync('git', ['-C', repo, 'config', '--get', 'core.hooksPath'], { encoding: 'utf8' });
  if (configured.status !== 1) throw new Error('core.hooksPath must be unset');
  const directory = path.join(gitDir, 'hooks');
  if (fs.existsSync(directory) && !fs.lstatSync(directory).isDirectory()) throw new Error('hooks must be a real directory');
  if (command === 'install') {
    const gate = fs.realpathSync(options['--gate'] || fileURLToPath(new URL('../../tools/data_repo_gate.py', import.meta.url)));
    regular(gate);
    const python = fs.realpathSync(run(options['--python'] || 'python', ['-c', 'import sys; print(sys.executable)']));
    regular(python);
    const config = { repo, gate, python };
    for (const name of names) {
      const file = path.join(directory, name);
      if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') !== hook(name, config)) throw new Error('existing hook: ' + name);
    }
    fs.mkdirSync(directory, { recursive: true });
    for (const name of names) {
      const file = path.join(directory, name);
      if (!fs.existsSync(file)) fs.writeFileSync(file, hook(name, config), { flag: 'wx', mode: 0o755 });
      regular(file);
      fs.chmodSync(file, 0o755);
    }
  } else if (command === 'uninstall') {
    const existing = names.filter(name => fs.existsSync(path.join(directory, name)));
    for (const name of existing) readOwned(path.join(directory, name), name, repo);
    for (const name of existing) fs.unlinkSync(path.join(directory, name));
    console.log('DATA-HOOKS PASS uninstalled');
    return;
  }
  for (const name of names) {
    const file = path.join(directory, name);
    const config = readOwned(file, name, repo);
    fs.accessSync(file, fs.constants.X_OK);
    if (process.platform !== 'win32' && !(fs.statSync(file).mode & 0o111)) throw new Error('hook is not executable: ' + name);
    regular(config.gate);
    regular(config.python);
    run(config.python, ['-c', 'pass']);
  }
  console.log('DATA-HOOKS PASS both hooks installed and dependencies available');
}

try { main(); } catch (error) {
  console.log('DATA-HOOKS FAIL ' + error.message);
  process.exitCode = 1;
}
