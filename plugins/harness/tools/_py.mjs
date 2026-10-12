#!/usr/bin/env node
// Cross-platform Python launcher, 2026-08-28. Windows ships `py` and no `python3`;
// Linux (the cloud runner) ships `python3` and no `py`. Hardcoding either breaks the other,
// which is exactly what happened when `py` was blindly replaced with `python3` on this machine.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Strict Python 3 discovery is opt-in for callers that require Python 3 syntax.
// Preserve the existing generic launcher's probe and result contracts.
const commands = (python3Only) => python3Only && process.platform !== 'win32'
  ? ['python3', 'python'] : ['py', 'python3', 'python'];
export function resolvePython(spawn = spawnSync, python3Only = false) {
  for (const bin of commands(python3Only)) {
    const probe = spawn(bin, ['--version'], python3Only
      ? { encoding: 'utf8', timeout: 5000, windowsHide: true } : { stdio: 'ignore' });
    if (probe.status === 0 && (!python3Only || /^Python 3\./m.test(`${probe.stdout || ''}\n${probe.stderr || ''}`))) return bin;
  }
  return null;
}

export function spawnPython(args, options, spawn = spawnSync, python3Only = false) {
  const bin = resolvePython(spawn, python3Only);
  if (bin) {
    const result = spawn(bin, args, options);
    return python3Only ? { ...result, command: bin } : result;
  }
  return { status: null, stdout: '', stderr: '',
    error: new Error(python3Only
      ? `No usable Python 3 interpreter found; tried ${commands(true).join(', ')}. Install Python 3 and add it to PATH.`
      : 'no python interpreter found (tried py, python3, python)') };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = spawnPython(process.argv.slice(2), { stdio: 'inherit' });
  if (r.error) process.stderr.write(`[_py] ${r.error.message}\n`);
  process.exit(r.status ?? 0); // fail-open: a missing interpreter must not break the turn
}
