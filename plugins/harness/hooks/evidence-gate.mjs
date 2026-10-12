#!/usr/bin/env node
/*
 * CA-02 Evidence Gate — Claude Code Stop hook (the project's FIRST real "robot").
 *
 * Principle (corpus): CA-02 "Proven Done" — "done" exists only with re-runnable
 * evidence; prose like "I verified it" is never enough. This hook is the enforcement
 * half of that anchor (see ../../enforcement/README.md).
 *
 * PHASE 1 (firing proof) = DONE: a hook fires on this Windows machine + records a TIMESTAMPED line
 *   per stop (the CEO's "log the time, not just the date" + §16 external-measurement telemetry).
 *
 * PHASE 2 (this build) = the done-claim-without-evidence DETECTOR, **still OBSERVE-ONLY**. It now
 *   evaluates the final assistant text and LOGS a `would_block:true` when it sees a clear, unhedged
 *   completion claim (EN+ES) with NO re-runnable evidence (command / output / file path / N/N tally /
 *   verdict / git hash) anywhere in that text. It does NOT actually block — block() stays reserved for
 *   the transcript-read-error path. Design priority is HIGH PRECISION / LOW FALSE-POSITIVES (dec-34
 *   denylist + F2 anti-injection both died on FP); when in doubt it ALLOWS.
 *   Flipping OBSERVE_ONLY=false (real blocking) is a SEPARATE deliberate CEO gate, taken only after the
 *   logged false-positive rate is measured on real turns. The flag here is `would_block`, not a block.
 *
 * Contract (verified by running, not trusted from prose):
 *   - stdin: JSON { session_id, transcript_path, cwd, hook_event_name, stop_hook_active }
 *   - transcript_path: JSONL; an assistant line is { type:"assistant",
 *     message:{ role, model, content:[{type:"text",text},...] }, timestamp, ... }
 *   - to block (Phase 2): print {"decision":"block","reason":"..."} on stdout, exit 0.
 *   - loop safety: if stop_hook_active===true we already blocked once this turn -> allow.
 */
import fs from 'node:fs';
// fixes-f round 2 (2026-10-10, verifier R2/R3): loaded with a fallback, so a missing sibling (a test that copies this
// hook alone, a clone or profile without the file) gives the pre-fixes-f plain cut instead of an ERR_MODULE_NOT_FOUND
// crash. wired-hooks-tracked.test.mjs and the sync's import-closure leg still report the missing file.
const { redactExcerpt } = await import('./_log-redact.mjs').catch(() => ({ redactExcerpt: (s, n) => String(s ?? '').slice(0, n) }));

const OBSERVE_ONLY = true; // Phase 1. Flip to false (Phase 2) only after firing is proven + detector tuned.
const LOG_PATH = process.env.HARNESS_LOG_DIR ? `${process.env.HARNESS_LOG_DIR}/evidence-gate.log` : new URL('./evidence-gate.log', import.meta.url); // HARNESS_LOG_DIR = plugin data dir (runner-provided); unset = beside this file, as before

function logLine(obj) {
  try { fs.appendFileSync(LOG_PATH, JSON.stringify(obj) + '\n'); } catch { /* never let logging crash the gate */ }
}

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

// Find the last assistant message's text + model from a real Claude Code transcript.
function lastAssistant(transcriptPath) {
  const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i].trim();
    if (!ln) continue;
    let o; try { o = JSON.parse(ln); } catch { continue; }
    if (o.type !== 'assistant') continue;
    const content = o.message?.content;
    if (!Array.isArray(content)) continue;
    const text = content.filter(b => b && b.type === 'text').map(b => b.text).join('\n').trim();
    if (text) return { text, model: o.message?.model ?? null };
  }
  return { text: '', model: null };
}

// ── PHASE-2 DETECTION (OBSERVE-ONLY) ────────────────────────────────────────────────────────────────
// Design lesson (dec-34 denylist + F2 anti-injection both DIED on false-positives): HIGH PRECISION wins.
// When in doubt, ALLOW. A done-claim is flagged ONLY when it is unambiguous AND no evidence is present
// anywhere in the final assistant text. We are deliberately GENEROUS about what counts as evidence
// (to avoid false-flagging an evidenced turn) and CONSERVATIVE about what counts as a done-claim.

// DONE-CLAIM: an explicit assertion that work is finished / succeeded / verified. EN + ES.
// Anchored to whole words + common phrasings. Deliberately does NOT match weak/hedged language
// ("should work", "I think it's done", "almost done", "trying to fix") — those are not done-claims.
const DONE_CLAIM = new RegExp(
  [
    // — English, single strong completion words (word-boundary anchored) —
    '\\b(done|finished|complete|completed|implemented|fixed|resolved|verified|passing|passed|merged|shipped|succeeded)\\b',
    // — English completion phrases —
    "\\bit works\\b", '\\bworks now\\b', '\\bnow works\\b', '\\bworking now\\b',
    '\\btests? pass(?:ed|ing|es)?\\b', '\\ball (?:tests|checks) pass', '\\bbuild (?:passes|succeeded|is green)\\b',
    '\\b(?:successfully|now) (?:built|created|added|fixed|implemented|configured|set up|wired)\\b',
    // — Spanish completion words/phrases —
    '\\blisto\\b', '\\bhecho\\b', '\\bterminad[oa]\\b', '\\bcompletad[oa]\\b', '\\bresuelto\\b',
    '\\barreglad[oa]\\b', '\\bsolucionad[oa]\\b', '\\bverificad[oa]\\b', '\\bfuncion[ao]\\b', '\\bfuncion[óo]\\b',
    '\\banda (?:bien|ya|perfecto)\\b', '\\bqued[óo] (?:listo|hecho|bien|funcionando)\\b', 'ya (?:est[áa]|qued[óo]|funciona)',
    // — explicit success glyphs paired with a done word —
    '[\\u2705\\u2714]\\s*(?:done|listo|hecho|fixed|complete)',
  ].join('|'),
  'i'
);

// HEDGE: if the claim sentence is hedged/negated/future/interrogative, it is NOT a confident done-claim.
// Presence of any of these near the claim => do NOT flag (precision guard).
const HEDGE = new RegExp(
  [
    '\\b(should|would|could|might|may|will|going to|gonna|try(?:ing)? to|attempt|hopefully|probably|i think|i believe|not (?:yet|done|working|finished)|almost|nearly|still (?:need|have to|working)|once (?:i|we)|after (?:i|we)|before (?:i|we)|if (?:it|this|that))\\b',
    '\\b(deber[ií]a|podr[ií]a|intentar|tratar de|todav[ií]a|a[uú]n no|casi|falta|faltan|creo que|quiz[áa]s?|tal vez|cuando (?:lo|la|termine)|despu[ée]s de|antes de|no (?:funciona|anda|qued[óo]|est[áa] listo))\\b',
    '\\?\\s*$', // a trailing question mark on the claim's line
  ].join('|'),
  'i'
);

// EVIDENCE — split into a case-INSENSITIVE leg (structural/path/tally/command signals) and a
// case-SENSITIVE leg (UPPERCASE verdict LABELS only). The split is deliberate: "verified" is ALSO a
// done-claim word, so prose like "I verified it" must NOT self-evidence — only an UPPERCASE verdict
// label ("VERIFIED", "PASSED", "ALL CHECKS PASSED") counts as a verdict-token evidence.
// GENEROUS otherwise — any one of these present anywhere in the text means "do NOT flag" (low-FP bias).
const EVIDENCE_I = new RegExp(
  [
    '```',                                   // a fenced code/output block (command or captured output)
    '`[^`]+`',                               // any inline code span (a command, a path, a symbol)
    '\\b\\d+\\s*/\\s*\\d+\\b',                // a test tally like 47/47, 12 / 12
    '\\bexit(?:\\s+code)?\\s*=?\\s*\\d+\\b',  // an exit-code citation (exit 0 / exit code 1 / exit=0)
    '\\[exit\\s*=?\\s*\\d+\\]',              // a bracketed exit marker [exit=0] / [exit 0]
    '\\b[0-9a-f]{7,40}\\b',                  // a git hash / sha (7-40 hex)
    '[A-Za-z]:\\\\[\\w .\\\\-]+\\.\\w+',      // a Windows absolute file path with extension
    '(?:^|\\s)/[\\w./-]+\\.\\w+',            // a POSIX-ish file path with extension
    '\\b[\\w./-]+\\.(?:mjs|cjs|js|ts|tsx|jsx|py|go|rs|java|rb|php|c|cc|cpp|h|hpp|sh|sql|json|yaml|yml|toml|md|log|txt)\\b', // a filename.ext token
    '\\b(?:passed|failed),?\\s*\\d+\\b', '\\b\\d+\\s+(?:passed|failed|tests?|checks?)\\b', // "3 passed", "passed, 3"
    '\\$\\s+\\S', '^\\s*>\\s+\\S', '^PS\\s', // a shell-prompt-style command line ("$ ...", "> ...", "PS ...")
    '\\b(?:git (?:log|show|status|diff|rev-parse)|node\\b|npm\\b|py\\b|python\\b|pytest\\b|cargo\\b)\\s', // a named re-runnable cmd
  ].join('|'),
  'im'
);
// UPPERCASE verdict labels only (NO `i` flag) — a deliberate, capitalized verdict, not prose.
const EVIDENCE_VERDICT = /\bVERIFIED\b|\bPASSED\b|\bFAILED\b|\bALL CHECKS PASSED\b|\bOK\b/m;
function hasEvidence(t) { return EVIDENCE_I.test(t) || EVIDENCE_VERDICT.test(t); }

// Decide whether to would-flag the turn's final text. Returns a structured result (never throws on bad input).
// Precision policy: flag ONLY (done-claim present) AND (no hedge near the claim) AND (no evidence anywhere).
function evaluateText(text) {
  const t = String(text || '');
  if (!t.trim()) return { would_block: false, reason: 'empty_text', claim: null };

  const m = DONE_CLAIM.exec(t);
  if (!m) return { would_block: false, reason: 'no_done_claim', claim: null };
  const claim = m[0];

  // Locate the claim's sentence/line to scope the hedge check (a hedge ANYWHERE in a short claim
  // line means it isn't a confident assertion). We check the line containing the match.
  const lineStart = t.lastIndexOf('\n', m.index) + 1;
  let lineEnd = t.indexOf('\n', m.index); if (lineEnd === -1) lineEnd = t.length;
  const claimLine = t.slice(lineStart, lineEnd);
  if (HEDGE.test(claimLine)) return { would_block: false, reason: 'hedged_claim', claim };
  // Interrogative guard: a '?' ANYWHERE on the claim line means it's a question ("is the migration done?"),
  // not an assertion -> not a confident done-claim (precision bias).
  if (claimLine.includes('?')) return { would_block: false, reason: 'interrogative_claim', claim };

  // Evidence is searched across the WHOLE final text (generous): a command, output, path, tally, hash, verdict.
  if (hasEvidence(t)) return { would_block: false, reason: 'evidence_present', claim };

  // Unambiguous, unhedged done-claim with NO evidence anywhere -> the would-flag (OBSERVE-ONLY).
  return { would_block: true, reason: 'done-claim without re-runnable evidence', claim };
}

function allow(extra) { logLine(extra); process.exit(0); }
function block(reason, extra) {
  logLine({ ...extra, decision: 'block', reason });
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
}

let input = {};
try {
  const parsed = JSON.parse(readStdin() || '{}');
  // Accept only a real object; null / array / primitive (e.g. stdin "null") -> {} (Verifier-found crash).
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed;
} catch { /* malformed stdin -> input stays {} */ }

const base = {
  ts: new Date().toISOString(),                 // wall-clock TIME, not just date (CEO request)
  event: input.hook_event_name || 'Stop',
  mode: 'observe-only',                         // STRUCTURAL: stamped on EVERY log line (incl. early exits)
  session: input.session_id || null,
  stop_hook_active: input.stop_hook_active === true,
};

// Loop safety: already blocked once this turn -> let it through (never trap the agent).
if (base.stop_hook_active) allow({ ...base, decision: 'allow', reason: 'stop_hook_active' });

let text = '', model = null;
try {
  if (input.transcript_path) ({ text, model } = lastAssistant(input.transcript_path));
} catch (e) {
  // Fail-closed-but-loop-safe (CA-12): surface the breakage, but stop_hook_active guard
  // above guarantees we can only block ONCE, so a broken gate cannot trap the agent.
  if (OBSERVE_ONLY) allow({ ...base, decision: 'allow', reason: 'transcript_read_error: ' + e.message });
  block('Evidence gate could not read the transcript to check your completion claim. Re-state the result with a re-runnable command/output as evidence.', base);
}

// ---- Phase 2 evaluates `text` here for done-without-evidence (OBSERVE-ONLY: it never blocks). ----
// HIGH-PRECISION done-claim-without-evidence detection. On a would-flag we LOG the candidate but still
// allow() — the block() path remains reserved for the transcript-read-error case above. Flipping
// OBSERVE_ONLY off (real blocking) is a SEPARATE, deliberate CEO gate, made only after the logged
// false-positive rate is measured on real turns.
let verdict;
try { verdict = evaluateText(text); }
catch (e) { verdict = { would_block: false, reason: 'evaluate_error: ' + (e && e.message ? e.message : String(e)), claim: null }; }

if (verdict.would_block) {
  // OBSERVE-ONLY would-flag: a clear done-claim with NO re-runnable evidence in the turn's final text.
  // We do NOT call block() — that stays only for the transcript-read-error path (fail-closed-but-loop-safe).
  allow({
    ...base, model, decision: 'allow', mode: 'observe-only',
    would_block: true,
    reason: 'done-claim without re-runnable evidence',
    claim: verdict.claim,
    textHead: redactExcerpt(text, 140),
  });
}
allow({
  ...base, model, decision: 'allow', mode: 'observe-only',
  would_block: false,
  reason: verdict.reason,
  claim: verdict.claim,
  textHead: redactExcerpt(text, 140),
});
