/*
 * _reminder-state.mjs - locked, atomic read-modify-write of the CEO format-reminder state file (added 2026-10-08,
 * fixes-f; verifier F1/F2, actions A1/A2/A4 of meta/cache/_verifier-format-gate-no-resend-2026-10-08.md).
 *
 * Used by _ceo-format-gate.mjs (Stop: records a reminder) and correction-detector-gate.mjs (UserPromptSubmit:
 * delivers it). The state stays ONE JSON file with the same shape as before ({ <session_id>: { rules, turns, ts,
 * text } }), so every existing reader and test reads it unchanged. What changes:
 *   1. every read-modify-write runs under an exclusive lock file (<state>.lock, created with O_EXCL), so two sessions
 *      writing at once can no longer overwrite each other's entry (the stress test lost 22 of 96 without it);
 *   2. a write goes to a temp file that is renamed over the state, so a reader never sees a half-written file;
 *   3. a lock older than LOCK_STALE_MS belongs to a dead holder (a hook killed mid-write) and is broken; ctx.broke
 *      says so. If the lock cannot be had within LOCK_WAIT_MS, ctx.locked is false and the CALLER decides what is
 *      safe. Both callers log those cases, so any remaining chance of a loss is visible in their log.
 * Library module: no side effects on import. Never throws out of withStateLock except what fn itself throws.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const LOCK_WAIT_MS = 2000;   // the critical section is a few ms; 2 s of waiting means something is wrong
export const LOCK_STALE_MS = 5000;  // no live holder keeps the lock this long

const asPath = (p) => (p instanceof URL ? fileURLToPath(p) : String(p));
const RETRY_CODES = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY']); // Windows: a lock being deleted gives EPERM

function sleep(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { const t = Date.now(); while (Date.now() - t < ms) { /* spin */ } }
}

/** Run fn(ctx) while holding <statePath>.lock. ctx = { locked, timedOut, broke, lockError }. fn ALWAYS runs; when
 *  the lock was not obtained ctx.locked is false. The lock is released (closed + removed) after fn returns. */
export function withStateLock(statePath, fn, { waitMs = LOCK_WAIT_MS, staleMs = LOCK_STALE_MS } = {}) {
  const lock = asPath(statePath) + '.lock';
  const t0 = Date.now();
  let fd = null, broke = false, lockError = null, timedOut = false;
  for (;;) {
    try { fd = fs.openSync(lock, 'wx'); break; }
    catch (e) {
      const code = (e && e.code) || 'error';
      if (!RETRY_CODES.has(code)) { lockError = code; break; }
    }
    if (Date.now() - t0 >= waitMs) { timedOut = true; break; }
    let age = 0;
    try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { age = 0; }
    if (age > staleMs) { try { fs.rmSync(lock, { force: true }); broke = true; } catch { /* next round */ } }
    else sleep(4 + Math.floor(Math.random() * 8));
  }
  const ctx = { locked: fd !== null, timedOut, broke, lockError };
  try { return fn(ctx); }
  finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
      try { fs.rmSync(lock, { force: true }); } catch { /* a leftover lock is broken as stale later */ }
    }
  }
}

/** Read the state object. status: ok | absent | unreadable | unparseable (the last three return an empty state). */
export function readState(statePath) {
  let raw;
  try { raw = fs.readFileSync(statePath, 'utf8'); }
  catch (e) { return { state: {}, status: e && e.code === 'ENOENT' ? 'absent' : 'unreadable' }; }
  try {
    const o = JSON.parse(raw);
    if (o && typeof o === 'object' && !Array.isArray(o)) return { state: o, status: 'ok' };
  } catch { /* fall through */ }
  return { state: {}, status: 'unparseable' };
}

/** Write the state via temp file + rename. Falls back to a plain write if the rename is refused (Windows can refuse a
 *  rename over a file another process holds open); under the lock that still cannot drop an update. true = written. */
export function writeStateAtomic(statePath, state) {
  const p = asPath(statePath);
  const data = JSON.stringify(state) + '\n';
  const tmp = `${p}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    try { fs.renameSync(tmp, p); return true; } catch { /* fall back below */ }
  } catch { /* fall back below */ }
  try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
  try { fs.writeFileSync(p, data); return true; } catch { return false; }
}
