#!/usr/bin/env node
/*
 * _discipline-meter-observe.mjs — the L5 "DISCIPLINE METER", an OBSERVE-ONLY telemetry Stop hook.
 *
 * WHAT THIS IS: a Claude Code **Stop** hook that, per turn, LOGS one weak proxy signal and NOTHING else:
 * did the orchestrator ship a SOURCE deliverable THIS turn WITHOUT delegating it (no builder/coder/verifier
 * subagent dispatched this turn)? It MEASURES a rate. It NEVER acts. It is the BUILD-NARROW deliverable from
 * meta/discipline-meter/ANALYSIS.md, corrected by meta/discipline-meter/VERIFY-analysis.md.
 *
 * ┌─ PRE-REGISTERED MEASUREMENT (dec-05; the verifier's #1 correction — read MEASUREMENT-PREREG.md) ─────────┐
 * │ The real question this meter exists to answer is NOT "is would_flag high?" but:                          │
 * │   "Of the would_flag fires, what fraction are GENUINE SKIPS (a source deliverable never verified         │
 * │    ANYWHERE in the session) vs LEGIT direct edits (light edit / same-turn inline test / verified later)?"│
 * │ HONEST EXPECTED ANSWER, stated up front (measured on the real population by the verifier):               │
 * │   L5 fires on ~4% of turns; ~59-100% of those fires are LEGIT direct edits, NOT skips.                   │
 * │   => the expected finding is "MOSTLY LEGIT -> stays observe-only-FOREVER; NO enforcer warranted."        │
 * │ This meter EXISTS TO MEASURE THAT, not to act on it. Classifying any single fire as skip-vs-legit is a   │
 * │ LATER INDEPENDENT analysis step (partly forward-looking: a "verified-in-a-later-turn" edit can only be   │
 * │ classified after the session). So this hook does NOT auto-judge skip-vs-legit — it logs ENOUGH context   │
 * │ (paths, sizes, the session-wide verifier-presence hint) for a human/independent agent to classify later. │
 * │ Do NOT inherit the analysis's un-measured "~52% FP" number. The MEASURED reality is the line above.      │
 * └─────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ CONTRACT (same shape as _verify-trigger-observe.mjs; we eat our own dog food) ─────────────────────────┐
 * │ 1. NEVER BLOCKS. No block path exists. Writes EMPTY stdout + exits 0 on EVERY path. Never gates.         │
 * │ 2. ALWAYS EXITS 0 / FAIL-OPEN. Any error anywhere (bad stdin / unreadable / malformed transcript / fs)   │
 * │    is swallowed -> still allow + exit 0. It can only ever ALLOW.                                         │
 * │ 3. LOOP-SAFETY. stop_hook_active===true -> allow immediately (reason 'stop_hook_active'), before work.   │
 * │ 4. OBSERVE-ONLY. `const OBSERVE_ONLY = true;` is STRUCTURAL — there is no enforcement branch to flip.    │
 * │    `mode:'observe-only'` is stamped on every logged line. would_flag GATES NOTHING.                      │
 * │ 5. WRITES NOTHING BUT ITS OWN LOG. Only side effect: appending JSON lines to                             │
 * │    ./_discipline-meter-observe.log (beside this file). Reads transcript READ-ONLY. Logging is in         │
 * │    try/catch — it can never crash the hook.                                                              │
 * └─────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * THE SIGNAL (per-turn, windowed by the last GENUINE user prompt — the dec-09 fix; NOT cumulative):
 *   - src_edit_this_turn  = THIS turn had an Edit/Write/NotebookEdit on a SOURCE file.
 *       SOURCE = CODE ONLY (.mjs/.js/.ts/.py/.go/.rs/...) — DELIBERATELY EXCLUDING .md/.json/.yaml/.yml/.toml
 *       (docs + config are not "deliverables" for this meter). Plus a SIZE FLOOR: trivial 1-line-ish edits are
 *       flagged (`trivial:true` per edit + n_nontrivial_source_edits) so analysis can filter them out — the
 *       hook does NOT itself drop them (it can't always tell; it LOGS the size and lets analysis decide).
 *   - delegated_this_turn = THIS turn dispatched an Agent/Task (a builder/coder/verifier subagent).
 *   - would_flag = src_edit_this_turn AND NOT delegated_this_turn  (the L5 candidate — LOGGED, gates nothing).
 *
 * Per-turn windowing is what makes L5 VARY where the old _verify-trigger-observe trigger PINNED (dec-09): that
 * hook scanned the whole transcript cumulatively, so verifier_present was almost always true session-wide and
 * the candidate never fired both ways. This hook reuses the tested `turnTouch` boundary primitive instead.
 *
 * TRANSCRIPT-FORMAT ASSUMPTIONS (best-effort / fail-open if they drift):
 *   - stdin: JSON { session_id, transcript_path, stop_hook_active, hook_event_name, ... }.
 *   - transcript_path: JSONL; assistant line = { type:"assistant", message:{ content:[ ... ] } }; a tool_use
 *     block = { type:"tool_use", name, input:{...} }. Edit/Write/NotebookEdit -> input.file_path |
 *     input.notebook_path | input.path. Agent/Task -> a dispatch.
 *   - A `user` line is a TURN BOUNDARY only if it is a GENUINE prompt (text, no tool_result) — see _turn-touch.
 *   Anything missing / shaped differently => the affected signal is false, never a crash.
 */
import fs from 'node:fs';
import { isGenuineUserPrompt } from './_turn-touch.mjs';

const OBSERVE_ONLY = true; // STRUCTURAL: there is no enforcement branch in this file to flip on.
const LOG_PATH = process.env.HARNESS_LOG_DIR ? `${process.env.HARNESS_LOG_DIR}/_discipline-meter-observe.log` : new URL('./_discipline-meter-observe.log', import.meta.url); // HARNESS_LOG_DIR = plugin data dir (runner-provided); unset = beside this file, as before

// SOURCE = CODE ONLY. EXCLUDES .md/.json/.yaml/.yml/.toml on purpose (docs+config are not deliverables here).
// This is the TIGHTENED set from VERIFY-analysis.md (the proposed tightening "genuinely helps").
const SOURCE_EXT =
  /\.(mjs|cjs|js|jsx|ts|tsx|py|go|rs|java|kt|scala|rb|php|c|cc|cpp|cxx|h|hpp|hh|cs|swift|m|mm|sh|bash|zsh|ps1|pl|lua|r|jl|dart|sql)$/i;
// Trivial-edit size floor: an edit whose changed text is <= this many chars AND <= 1 newline counts as
// "trivial" (logged, NOT dropped) so a later analysis can filter the CA-08 light-edit pattern out of fires.
const TRIVIAL_CHARS = 40;

// ── logging (the ONLY side effect; never allowed to crash the hook) ──────────────────────────────
function logLine(obj) {
  try { fs.appendFileSync(LOG_PATH, JSON.stringify(obj) + '\n'); } catch { /* never crash on logging */ }
}
function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}
// Single exit shape: log, write EMPTY stdout (= allow), exit 0. No other exit shape exists.
function allow(extra) { logLine(extra); process.exit(0); }

// ── per-edit size estimate (for the trivial floor; fail-soft to 0/unknown) ───────────────────────
// We can't always know the true diff size, so we estimate from the tool input we DO have:
//   Edit          -> length of new_string (the inserted text)
//   Write         -> length of content
//   NotebookEdit  -> length of new_source
// Returns { size, lines } — both best-effort, 0 when unknown.
function editSize(name, inp) {
  try {
    let s = '';
    if (name === 'Edit') s = String(inp.new_string != null ? inp.new_string : '');
    else if (name === 'Write') s = String(inp.content != null ? inp.content : '');
    else if (name === 'NotebookEdit') s = String(inp.new_source != null ? inp.new_source : '');
    const size = s.length;
    const lines = s === '' ? 0 : s.split('\n').length;
    return { size, lines };
  } catch { return { size: 0, lines: 0 }; }
}

// ── per-turn scan → the L5 signals (window = since the last GENUINE user prompt; walk tail BACKWARD) ─
// Mirrors _turn-touch.mjs's boundary logic exactly (reuse isGenuineUserPrompt) so the windowing is the
// tested one, NOT a re-implementation. Returns the source edits + whether a dispatch happened THIS turn.
function scanThisTurn(transcriptPath) {
  const out = { source_edits: [], delegated: false, parse_ok: true };
  let text;
  try { text = fs.readFileSync(transcriptPath, 'utf8'); }
  catch { out.parse_ok = false; return out; } // unreadable transcript -> fail-open (no edits, no dispatch)
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i];
    if (!ln || !ln.trim()) continue;
    let o;
    try { o = JSON.parse(ln); } catch { continue; }      // non-JSON line -> skip, never crash
    if (!o || typeof o !== 'object') continue;            // bare null / primitive line -> skip
    const role = o.type || o.role;
    const content = (o.message && o.message.content) || o.content;
    if (role === 'user') {
      if (isGenuineUserPrompt(content)) break;            // turn boundary reached — stop walking
      continue;                                            // tool_result user message — still this turn
    }
    if (role === 'assistant' && Array.isArray(content)) {
      for (const c of content) {
        if (!c || c.type !== 'tool_use') continue;
        const name = c.name || '';
        const inp = (c.input && typeof c.input === 'object') ? c.input : {};
        if (name === 'Edit' || name === 'Write' || name === 'NotebookEdit') {
          const fp = String(inp.file_path || inp.notebook_path || inp.path || '');
          if (fp && SOURCE_EXT.test(fp)) {
            const { size, lines: nlines } = editSize(name, inp);
            const trivial = size > 0 ? (size <= TRIVIAL_CHARS && nlines <= 1) : false; // unknown size -> not trivial (conservative)
            out.source_edits.push({ path: fp, tool: name, size, lines: nlines, trivial });
          }
        } else if (name === 'Agent' || name === 'Task') {
          out.delegated = true;                            // a builder/coder/verifier subagent was dispatched THIS turn
        }
      }
    }
  }
  return out;
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────────
let input = {};
try {
  const parsed = JSON.parse(readStdin() || '{}');
  // Accept ONLY a real object; null / array / primitive (stdin "null"/"[]"/"42") -> {} (evidence-gate guard).
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed;
} catch { /* malformed stdin -> input stays {} */ }

const base = {
  ts: new Date().toISOString(),                 // wall-clock TIME (not just date)
  event: input.hook_event_name || 'Stop',
  hook: 'discipline-meter-observe',
  meter: 'L5',
  mode: 'observe-only',
  session_id: input.session_id || null,
  stop_hook_active: input.stop_hook_active === true,
};

// (3) Loop-safety: already stopped once this turn -> allow immediately, do no work.
if (base.stop_hook_active) allow({ ...base, decision: 'allow', reason: 'stop_hook_active' });

// (2/5) Derive the L5 signals — fail-open; any throw lands in the catch -> allow with a reason.
try {
  let scan = { source_edits: [], delegated: false, parse_ok: false };
  if (input.transcript_path) scan = scanThisTurn(String(input.transcript_path));

  const source_paths = scan.source_edits.map((e) => e.path);
  const n_source_edits = scan.source_edits.length;
  const n_nontrivial_source_edits = scan.source_edits.filter((e) => !e.trivial).length;

  const src_edit_this_turn = n_source_edits > 0;
  const delegated_this_turn = scan.delegated === true;
  // THE L5 CANDIDATE SIGNAL — LOGGED FOR ANALYSIS ONLY. Gates nothing.
  const would_flag = src_edit_this_turn && !delegated_this_turn;

  allow({
    ...base,
    decision: 'allow',
    // L5 signals:
    src_edit_this_turn,
    delegated_this_turn,
    would_flag,
    // forensic context for the LATER skip-vs-legit classification (NOT auto-judged here):
    source_paths,
    n_source_edits,
    n_nontrivial_source_edits,           // size-floor: fires with 0 here are CA-08 light edits -> filter in analysis
    source_edits: scan.source_edits,     // per-edit {path,tool,size,lines,trivial}
    transcript_read_ok: scan.parse_ok,
  });
} catch (e) {
  // (2) Fail-open: ANY error anywhere -> still allow + exit 0. Log the reason for the audit trail.
  allow({ ...base, decision: 'allow', reason: 'error_fail_open: ' + (e && e.message ? e.message : String(e)) });
}

// Unreachable belt-and-suspenders: every path above already exited via allow().
allow({ ...base, decision: 'allow', reason: 'fallthrough' });
