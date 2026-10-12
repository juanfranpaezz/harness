#!/usr/bin/env node
// ConfigChange audit, 2026-08-28, CEO-authorized (point 16).
// HONEST SCOPE: this is an AUDIT TRAIL, not a lock. A lock the AI can unlock is not a lock, and
// anything this hook could enforce, the AI could also disable, because it edits the same files.
// What it DOES buy: every change to settings.json or a hook file leaves a timestamped, append-only
// record naming WHAT changed. A change made without a matching CEO authorization in the conversation
// becomes detectable AFTER THE FACT, by anyone reading this log. That is the honest ceiling.
import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const LOG = process.env.HARNESS_LOG_DIR ? join(process.env.HARNESS_LOG_DIR, '_config-change-audit.log') : join(here, '_config-change-audit.log'); // HARNESS_LOG_DIR = plugin data dir (runner-provided); unset = beside this file, as before
let raw = '';
process.stdin.on('data', c => { raw += c; });
process.stdin.on('end', () => {
  let p = {};
  try { p = JSON.parse(raw || '{}'); } catch { p = { _parse_error: true }; }
  const row = {
    ts: new Date().toISOString(),
    event: p.hook_event_name ?? null,
    changed: p.changed_files ?? p.file_path ?? p.path ?? null,
    session_id: p.session_id ?? null,
    keys: Object.keys(p).sort(),
  };
  try { appendFileSync(LOG, JSON.stringify(row) + '\n'); } catch {}
  process.stdout.write('');
  process.exit(0);
});
