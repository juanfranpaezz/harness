#!/usr/bin/env node
// SUB-AGENT LIFECYCLE PROBE. Log-only. Blocks nothing, denies nothing, decides nothing.
//
// ORIGIN (2026-08-28): a falsifier for "does this platform build deliver SubagentStart/SubagentStop/
// StopFailure?". ANSWERED YES on build 2.1.251 — 148 rows, 73 real Start/Stop pairs, matched by agent_id.
//
// EXTENSION (2026-08-29): the probe recorded THAT an agent ran but not WHAT IT CONCLUDED, which made the
// corpus useless for the only question worth asking of a dispatch log — did the dispatch change any
// decision? The concluding message is now captured (see CONCLUSION CAPTURE below).
//
// SOURCE-KEY EVIDENCE (mandatory before adding any field; the bug class this file already shipped once was
// a field read from a key that does not exist, giving null forever):
//   `last_assistant_message` is VERIFIED PRESENT in real SubagentStop payloads on this build. Evidence is
//   in this hook's OWN log history, field `keys` (the sorted key list of the raw payload), which reads:
//     ["agent_id","agent_transcript_path","agent_type","background_tasks","cwd","effort",
//      "hook_event_name","last_assistant_message","permission_mode","prompt_id","session_crons",
//      "session_id","stop_hook_active","transcript_path"]
//   on all 73 real SubagentStop rows. It is ABSENT from every SubagentStart payload (7 keys only) — so
//   the conclusion fields are expected empty on Start and filled on Stop. That asymmetry IS the both-ways
//   test for this field.
//
// CONCLUSION CAPTURE — cap and why:
//   Kept as HEAD 1200 chars + TAIL 600 chars (1800 + marker) rather than a single leading slice, because
//   agent digests in this project put the verdict in the first lines AND the recommendation/caveat in the
//   last lines; a head-only truncation silently drops the half that changes a decision. Full length and a
//   sha1-8 of the FULL message are recorded alongside, so a truncated row can still be (a) told apart from
//   another truncated row and (b) matched against the full text in agent_transcript_path.
//   Budget: ~2 KB per Stop row. The observed peak was 73 stops in ~21 h of heavy use, so ~150 KB/day worst
//   case. A 25 MB guard degrades to metadata-only rather than growing without bound.
//
// SECRET HYGIENE: the concluding message is arbitrary agent output landing in a plaintext file, so an
// obvious-secret redactor runs over it first. Conservative by design (known key prefixes + labelled
// assignments); it is a hygiene net, not a claim of completeness.
import { appendFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// fixes-f round 2 (2026-10-10, verifier R2/R3): loaded with a fallback, so a missing sibling gives the pre-fixes-f
// behaviour (no shared redaction) instead of an ERR_MODULE_NOT_FOUND crash; the import-closure checks still report it.
const { redactSecrets } = await import('./_log-redact.mjs').catch(() => ({ redactSecrets: (s) => String(s ?? '') }));

const here = dirname(fileURLToPath(import.meta.url));
const LOG = process.env.HARNESS_LOG_DIR ? join(process.env.HARNESS_LOG_DIR, '_subagent-lifecycle-probe.log') : join(here, '_subagent-lifecycle-probe.log'); // HARNESS_LOG_DIR = plugin data dir (runner-provided); unset = beside this file, as before
const HEAD = 1200;
const TAIL = 600;
const MAX_LOG_BYTES = 25_000_000;

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bghp_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\b(?:api[_-]?key|secret|token|password|passwd|pwd)\s*[=:]\s*["']?[A-Za-z0-9_\-./+]{12,}["']?/gi,
];

function redact(s) {
  let out = s;
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[REDACTED-SECRET]');
  return redactSecrets(out); // the shared redactor covers what this local list misses
}

function clip(s) {
  if (s.length <= HEAD + TAIL) return s;
  return s.slice(0, HEAD) + `\n…[CLIPPED ${s.length - HEAD - TAIL} chars]…\n` + s.slice(-TAIL);
}

let raw = '';
process.stdin.on('data', c => { raw += c; });
process.stdin.on('end', () => {
  let payload = {};
  try { payload = JSON.parse(raw || '{}'); } catch { payload = { _parse_error: true, _raw_len: raw.length }; }

  // --- conclusion capture -------------------------------------------------------------------------
  // Read ONLY the key proven present above. No speculative aliases: an alias that never exists is exactly
  // the always-null bug this file is meant to avoid.
  const lam = payload.last_assistant_message;
  const msg = (typeof lam === 'string') ? lam : (lam == null ? '' : JSON.stringify(lam));
  const clean = redact(msg);

  let overBudget = false;
  try { overBudget = statSync(LOG).size > MAX_LOG_BYTES; } catch { overBudget = false; }

  const row = {
    // ---- pre-existing fields, unchanged ----
    ts: new Date().toISOString(),
    event: payload.hook_event_name ?? null,
    agent_id: payload.agent_id ?? null,
    agent_type: payload.agent_type ?? payload.subagent_type ?? null,
    effort: payload.effort ?? null,
    permission_mode: payload.permission_mode ?? null,
    has_transcript_path: Boolean(payload.agent_transcript_path),
    has_last_message: Boolean(payload.last_assistant_message),
    // ---- new: what the agent CONCLUDED ----
    concl_len: msg.length,
    concl_sha1_8: msg ? createHash('sha1').update(msg).digest('hex').slice(0, 8) : null,
    concl_redacted: clean !== msg,
    concl: msg ? (overBudget ? '[LOG-OVER-BUDGET: metadata only]' : clip(clean)) : null,
    // ---- pre-existing field, unchanged (kept last: it is the source-key evidence trail) ----
    keys: Object.keys(payload).sort(),
  };

  try { appendFileSync(LOG, JSON.stringify(row) + '\n'); } catch {}
  process.stdout.write('');
  process.exit(0);
});
