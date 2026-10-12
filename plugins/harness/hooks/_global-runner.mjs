#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// _global-runner.mjs — the DOUBLE-FIRE GUARD of the machine-wide harness layer (deploy plan §6).
//
// Usage (from the GLOBAL settings.json, exec-form, absolute path):
//   {"type":"command","command":"node","args":["<G>/hooks/_global-runner.mjs","<hookFileName>"],...}
// Usage (plugin form, hooks/hooks.json; plan manifest 2026-09-25 §2.4):
//   node "${CLAUDE_PLUGIN_ROOT}/hooks/_global-runner.mjs" --data "${CLAUDE_PLUGIN_DATA}" <hookFileName>
//
// It reads the hook payload on stdin, decides whether the GLOBAL copy of <hookFileName> should run
// for the CURRENT project, and if so spawns it with CLAUDE_PROJECT_DIR + HARNESS_SCOPE=global,
// forwarding stdout/stderr and the child's exit code verbatim.
//
// <G> (the global harness root) is derived from THIS FILE's own location — dirname(import.meta.url)
// is "<G>/hooks", so <G> = that dir's parent. Nothing is hard-coded, so the identical file works
// from the real global dir, from a plugin cache dir, or from a test fixture dir.
//
// LOG DESTINATION. `--data <dir>` (optional, leading) sends rows to <dir>/logs/_global-runner.log and
// exports HARNESS_LOG_DIR=<dir>/logs to the child. Without it (legacy wiring) rows go to
// <G>/hooks/_global-runner.log exactly as before. A literal, unsubstituted "${...}" value is treated
// as absent (legacy path) and the row is stamped data_dir_unresolved:true.
//
// DENYLIST. No personal literal lives in this file: the denied roots are OS system dirs + the
// resolved Claude config dir (CLAUDE_CONFIG_DIR, else <home>/.claude) + every line of
// <configDir>/harness-deny-roots.txt (per-machine file; absent = no extra roots).
//
// FAIL-OPEN: any internal error → log action:"error", exit 0, empty stdout. A guard for other
// people's folders must never be able to break a session it does not understand.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BS = String.fromCharCode(92); // a literal backslash, built without an escape sequence
const HOOKS_DIR = path.dirname(fileURLToPath(import.meta.url));   // <G>/hooks
const G_ROOT = path.resolve(HOOKS_DIR, '..');                     // <G>
const LEGACY_LOG_PATH = path.join(HOOKS_DIR, '_global-runner.log');
let LOG_PATH = LEGACY_LOG_PATH;

// OS roots that are never a project. The config dir and the per-machine deny file are added at runtime.
const SYSTEM_DENY_ROOTS = ['c:/windows', 'c:/program files', 'c:/program files (x86)'];
const DENY_FILE = 'harness-deny-roots.txt';

export function norm(p) {
  if (typeof p !== 'string' || !p) return '';
  let s = p.split(BS).join('/').trim().toLowerCase();
  while (s.length > 3 && s.endsWith('/')) s = s.slice(0, -1);   // keep "c:/", strip trailing "/" elsewhere
  return s;
}

/** The Claude config dir this session runs under: CLAUDE_CONFIG_DIR, else <home>/.claude. */
export function configDir(env = process.env) {
  const c = env && typeof env.CLAUDE_CONFIG_DIR === 'string' ? env.CLAUDE_CONFIG_DIR.trim() : '';
  return c || path.join(os.homedir(), '.claude');
}

/** System roots + the config dir + the lines of <configDir>/harness-deny-roots.txt ('#' = comment). */
export function denyRoots(env = process.env, fsi = fs) {
  const cfg = configDir(env);
  const roots = [...SYSTEM_DENY_ROOTS, norm(cfg)];
  try {
    const txt = fsi.readFileSync(path.join(cfg, DENY_FILE), 'utf8');
    for (const line of String(txt).split(/\r?\n/)) {
      const t = line.trim();
      if (t && !t.startsWith('#')) roots.push(norm(t));
    }
  } catch { /* absent deny file = no extra roots */ }
  return roots.filter(Boolean);
}

/** true ⇒ this project dir must never be operated on. String logic over the given root list. */
export function isDenied(projectDir, roots = denyRoots()) {
  const s = norm(projectDir);
  if (!s) return true;
  if (/^[a-z]:\/?$/.test(s)) return true;                    // a bare drive root
  if (s === '/') return true;
  for (const root of roots) {
    if (s === root || s.startsWith(root + '/')) return true;
  }
  return false;
}

/** Parse argv after the script path: [--data <dir>] <hookFile>. Returns { hookFile, dataDir, unresolved }. */
export function parseRunnerArgs(args) {
  let i = 0; let dataDir = ''; let unresolved = false;
  if (args[0] === '--data') {
    const v = typeof args[1] === 'string' ? args[1].trim() : '';
    i = 2;
    if (!v || v.includes('${')) unresolved = true; else dataDir = v;
  }
  return { hookFile: args[i] || '', dataDir, unresolved };
}

let ROW_EXTRA = {};
function logRow(row) {
  try { fs.appendFileSync(LOG_PATH, JSON.stringify({ ...row, ...ROW_EXTRA, scope: 'global' }) + '\n'); } catch { /* never crash on logging */ }
}

function readStdin() {
  // Synchronous read to EOF. A closed/absent stdin (TTY) throws → empty buffer, which is the
  // degenerate case of the 2-second cap: we never block a session waiting for bytes.
  try { return fs.readFileSync(0); } catch { return Buffer.alloc(0); }
}

/** Skip decision. Returns null to RUN, or a string reason to SKIP. Rules (e) and (d) are evaluated
 *  FIRST and never read the project dir, so a kill-switched or denylisted path is never touched. */
export function skipReason(projectDir, hookFile, env, fsi = fs) {
  if (env.HARNESS_GLOBAL_OFF === '1') return 'kill-switch';                                            // (e)
  if (isDenied(projectDir, denyRoots(env, fsi))) return 'denylisted-root';                             // (d)
  const dotClaude = path.join(projectDir, '.claude');
  try { if (fsi.existsSync(path.join(dotClaude, 'HARNESS-SOURCE'))) return 'harness-source'; } catch { /* ignore */ }  // (a)
  try { if (fsi.existsSync(path.join(dotClaude, 'NO-HARNESS'))) return 'opted-out'; } catch { /* ignore */ }           // (c)
  try {                                                                                                // (b)
    const sp = path.join(dotClaude, 'settings.json');
    if (fsi.existsSync(sp)) {
      const txt = fsi.readFileSync(sp, 'utf8');
      if (typeof txt === 'string' && txt.includes(hookFile)) return 'project-wires-it';
    }
  } catch { /* unreadable settings ⇒ do not skip on this leg */ }
  return null;
}

function main() {
  const { hookFile, dataDir, unresolved } = parseRunnerArgs(process.argv.slice(2));
  let logDir = '';
  if (dataDir) {
    try { logDir = path.join(dataDir, 'logs'); fs.mkdirSync(logDir, { recursive: true }); LOG_PATH = path.join(logDir, '_global-runner.log'); }
    catch { logDir = ''; LOG_PATH = LEGACY_LOG_PATH; }
  }
  // A1 (P9 gate, 2026-09-25): inside a plugin (CLAUDE_PLUGIN_ROOT set) never log beside the script. No usable --data ⇒ fall back
  // to ${CLAUDE_PLUGIN_DATA}/logs from the environment, then to <os tmpdir>/claude-harness-plugin-logs. Legacy wiring is unchanged.
  if (!logDir && process.env.CLAUDE_PLUGIN_ROOT) {
    const envData = String(process.env.CLAUDE_PLUGIN_DATA || '');
    for (const cand of [envData && !envData.includes('${') ? path.join(envData, 'logs') : '', path.join(os.tmpdir(), 'claude-harness-plugin-logs')]) {
      if (!cand) continue;
      try { fs.mkdirSync(cand, { recursive: true }); logDir = cand; LOG_PATH = path.join(cand, '_global-runner.log'); break; } catch { /* try the next candidate */ }
    }
  }
  ROW_EXTRA = { root: G_ROOT };
  if (unresolved) ROW_EXTRA.data_dir_unresolved = true;
  let stdinBuf = Buffer.alloc(0);
  let projectDir = '';
  try {
    stdinBuf = readStdin();
    let payload = {};
    try { payload = JSON.parse(stdinBuf.toString('utf8') || '{}') || {}; } catch { payload = {}; }
    projectDir = process.env.CLAUDE_PROJECT_DIR || payload.cwd || process.cwd();
    ROW_EXTRA = { event: typeof payload.hook_event_name === 'string' ? payload.hook_event_name : '', ...ROW_EXTRA };

    if (!hookFile || hookFile.includes('/') || hookFile.includes(BS)) {
      logRow({ ts: new Date().toISOString(), hook: hookFile, cwd: projectDir, action: 'error', reason: 'bad-hook-arg' });
      process.exit(0);
    }

    const reason = skipReason(projectDir, hookFile, process.env);
    if (reason) {
      logRow({ ts: new Date().toISOString(), hook: hookFile, cwd: projectDir, action: 'skip', reason });
      process.exit(0);
    }

    const target = path.join(HOOKS_DIR, hookFile);
    if (!fs.existsSync(target)) {
      logRow({ ts: new Date().toISOString(), hook: hookFile, cwd: projectDir, action: 'error', reason: 'hook-file-missing' });
      process.exit(0);
    }

    const childEnv = { ...process.env, CLAUDE_PROJECT_DIR: projectDir, HARNESS_SCOPE: 'global', HARNESS_GLOBAL_ROOT: G_ROOT };
    if (logDir) childEnv.HARNESS_LOG_DIR = logDir;
    const res = spawnSync(process.execPath, [target], { input: stdinBuf, env: childEnv, windowsHide: true });
    if (res.stdout && res.stdout.length) process.stdout.write(res.stdout);
    if (res.stderr && res.stderr.length) process.stderr.write(res.stderr);
    const code = typeof res.status === 'number' ? res.status : 0;
    logRow({ ts: new Date().toISOString(), hook: hookFile, cwd: projectDir, action: 'ran', exit: code });
    process.exit(code);
  } catch (e) {
    logRow({ ts: new Date().toISOString(), hook: hookFile, cwd: projectDir, action: 'error', reason: String((e && e.message) || e).slice(0, 200) });
    process.exit(0);   // fail-open
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
