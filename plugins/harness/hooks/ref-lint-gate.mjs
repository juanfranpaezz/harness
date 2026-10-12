#!/usr/bin/env node
/*
 * Doc-reference linter — Claude Code Stop hook (self-governance robot #1).
 *
 * Principle: CA-07 (recurring mistake -> durable automated check) + the doc-drift class the
 * CEO flagged ("the AI should catch its own gaps, not be reminded"). This is the MECHANICAL
 * slice: a broken file reference is caught by an oracle, not by judgement.
 *
 * It runs the deterministic `.claude/tools/ref_linter.py` (MARKDOWN-LINKS ONLY in git-tracked
 * *.md — scope locked by independent review af8596: that rule measured 0 false positives, while
 * the broader extractors produced ~201) over the corpus, once per turn at Stop.
 *
 * PHASE 1 = OBSERVE-ONLY (OBSERVE_ONLY=true): logs broken links, does NOT block. Mirrors the
 * evidence-gate phased rollout. Flip to false (Phase 2) only after firing is confirmed and the
 * 0-FP calibration holds on the live corpus. Then it blocks "stop with broken refs".
 *
 * Composes with evidence-gate.mjs as a SECOND hook in the SAME Stop entry (both fire; a block by
 * either blocks). Mirrors the proven evidence-gate contract:
 *   - stdin: JSON { session_id, transcript_path, cwd, hook_event_name, stop_hook_active }
 *   - block (Phase 2): print {"decision":"block","reason":"..."} on stdout, exit 0
 *   - loop safety: stop_hook_active===true -> allow (never trap the agent)
 *   - fail-OPEN: if the linter cannot run/parse, allow but LOG why (so a dead robot is visible)
 * NOTE (v2 optimisation, deliberately omitted): gate the scan on "did this turn edit .md" to skip
 *   chat-only Stops. v1 always scans (~0.4s, silent when the corpus is clean) for simplicity.
 *
 * ── TRANSIENT_TOLERANCE (future PHASE-B gate — DOCUMENTED here, only the side-effect-free HALF is
 *    implemented this slice; NO block is added) ───────────────────────────────────────────────────
 *    The eventual hard-block flip (a SEPARATE measured build — see meta/wave3-phase1-slice0-ramp.md)
 *    must block ONLY when BOTH hold: (i) this turn actually TOUCHED the guarded artifact (here: any
 *    *.md), AND (ii) the SAME drift signature persisted from the immediately-prior turn of the session
 *    (the agent already had one turn to fix it). A single-turn transient must be TOLERATED.
 *    THE TRANSIENT THIS HOOK MUST TOLERATE: `ref_linter.py` enumerates files via `git ls-files *.md`
 *    (.claude/tools/ref_linter.py:35), which INCLUDES STAGED files. So a STAGED .md whose link target
 *    is not yet created reports `n_broken=1` mid-edit — a legitimate transient, not a finished defect.
 *    (Compare the live dormant block branch in ceo-model-coherence.mjs:~91, which WOULD halt on its
 *    analogous transient.) PHASE B does not flip until the pre-registered transient-false-block bar is
 *    met. This slice only LOGS the turn-touch + prior-drift signature (no behavior change, no block).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rampAlarmRecord, rampAlarmNotice } from './_ramp-alarm.mjs';
import { turnTouch, MATCH } from './_turn-touch.mjs'; // Wave-3 turn-touch derivation (observe-only; PHASE-B precondition)
import { pyBin, PY_TIMEOUT_MS } from './_py-resolve.mjs';

const OBSERVE_ONLY = true; // Phase 1. Flip to false only after firing + 0-FP calibration are confirmed.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK_HOME = path.resolve(__dirname, '..', '..');            // .claude/hooks -> the tree THIS file lives in
// P1 (2026-09-04, global-harness deploy): the lint ROOT resolves CLAUDE_PROJECT_DIR -> cwd (when it
// looks like a repo) -> HOOK_HOME (the original expression, unchanged as the last leg). The LINTER
// path is pinned to THIS hook's own tree on purpose: a tool imported by a hook resolves NEXT TO THE HOOK.
const REPO_REAL = (() => {
  try {
    const envRoot = process.env.CLAUDE_PROJECT_DIR;
    if (envRoot && fs.existsSync(envRoot)) return path.resolve(envRoot);
    const cwdRoot = process.cwd();
    if (fs.existsSync(path.join(cwdRoot, '.git')) || fs.existsSync(path.join(cwdRoot, '.claude'))) return path.resolve(cwdRoot);
    return HOOK_HOME;
  } catch { return HOOK_HOME; }
})();
// REPO is the lint ROOT passed to the linter. RAMP_TEST_REPO is a TEST-ONLY override (ramp-alarm.test.mjs
// points it at a throwaway fixture repo); it NEVER changes behavior in production and adds NO block path.
const REPO = process.env.RAMP_TEST_REPO || REPO_REAL;
// 2026-10-08 (hook-paths fix): tools resolve to the tools/ dir BESIDE this hook's hooks/ dir, so every
// profile runs its OWN copy (~/.claude, ~/.claude-employer, ~/.claude-work, a project's .claude). The old
// <hooks>/../../.claude/tools only matched when the tree is literally named ".claude": from
// ~/.claude-employer/hooks it resolved to the PERSONAL ~/.claude/tools. Same dir as before for ~/.claude
// and for a repo/project .claude.
const LINTER = path.join(__dirname, '..', 'tools', 'ref_linter.py'); // <tree>/hooks -> <tree>/tools
// LOG_PATH: beside this hook in prod; REF_LINT_GATE_LOG is a TEST-ONLY override (ramp-alarm.test.mjs points it at a
// temp file so the live log never receives fixture rows - PENDING-FIXES S9; same seam memory-coherence.mjs
// has as MEMORY_COHERENCE_LOG). Unset in production -> the path below, byte-identical to before.
const LOG_PATH = process.env.REF_LINT_GATE_LOG || (process.env.HARNESS_LOG_DIR ? `${process.env.HARNESS_LOG_DIR}/ref-lint-gate.log` : new URL('./ref-lint-gate.log', import.meta.url)); // HARNESS_LOG_DIR = plugin data dir (runner-provided)

function logLine(obj) { try { fs.appendFileSync(LOG_PATH, JSON.stringify(obj) + '\n'); } catch { /* never crash on logging */ } }
function readStdin() { try { return fs.readFileSync(0, 'utf8'); } catch { return ''; } }
function allow(extra) { logLine(extra); process.exit(0); }
function block(reason, extra) {
  logLine({ ...extra, decision: 'block', reason });
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
}

let input = {};
try {
  const parsed = JSON.parse(readStdin() || '{}');
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed;
} catch { /* malformed stdin -> {} */ }

const base = {
  ts: new Date().toISOString(),
  event: input.hook_event_name || 'Stop',
  session: input.session_id || null,
  stop_hook_active: input.stop_hook_active === true,
  hook: 'ref-lint-gate',
};

// Loop safety: already blocked once this turn -> let it through.
if (base.stop_hook_active) allow({ ...base, decision: 'allow', reason: 'stop_hook_active' });

let result;
try {
  const out = execFileSync(pyBin() ?? 'py', [LINTER, REPO], { encoding: 'utf8', timeout: PY_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
  result = JSON.parse(out);
} catch (e) {
  // Fail-OPEN is DELIBERATE and stays: a broken linter must never trap the agent, and this hook is
  // observe-only. What was wrong is that the row was INDISTINGUISHABLE from a clean pass.
  // Measured 2026-09-23 over the full log: 308 of 3,320 rows (9.3%) are this branch. Every one
  // carried decision:"allow" with no field saying the corpus was never examined, so a consumer
  // counting `decision` scored a DEAD gate as protection. `check_status` ends that.
  // NO behaviour change: decision stays "allow", nothing blocks, OBSERVE_ONLY is untouched.
  const msg = (e && e.message) ? String(e.message) : 'unknown';
  allow({
    ...base,
    decision: 'allow',
    mode: 'observe-only',
    check_status: 'error',            // <- the ONLY field a consumer should trust for "was it checked"
    checked: false,                   //    the corpus was NOT examined on this turn
    error_kind: /ETIMEDOUT/.test(msg) ? 'timeout'
      : (/ENOENT/.test(msg) ? 'interpreter_or_script_missing' : 'linter_failure'),
    linter_timeout_ms: PY_TIMEOUT_MS,
    reason: 'linter_error: ' + msg.slice(0, 160),
  });
}

const n = (result && result.n_broken) || 0;
// 2026-10-08 (vacuous-clean fix): a run that enumerated ZERO markdown files examined nothing (the lint root is
// not a git repo, or tracks no *.md; measured with cwd C:\work\employer). It used to fall into the branch below and
// log check_status "clean", checked:true with files_read 0 / links_checked 0: a pass that checked nothing. It now
// logs its own status. NO behaviour change: decision stays "allow", nothing blocks, OBSERVE_ONLY is untouched.
// Only a linter that REPORTS scanned_md === 0 lands here; a missing field falls through exactly as before.
const scannedMd = (result && typeof result.scanned_md === 'number') ? result.scanned_md : null;
if (n === 0 && scannedMd === 0) allow({
  ...base, decision: 'allow', mode: 'observe-only',
  check_status: 'no-input', checked: false,      // nothing was examined: never report this as "clean"
  n_broken: 0, scanned_md: 0, links_checked: result.links_checked ?? 0,
  files_read: result.files_read ?? null, lint_root: REPO,
});
if (n === 0) allow({
  ...base, decision: 'allow', mode: 'observe-only',
  check_status: 'clean', checked: true,          // examined, and the live corpus is clean
  n_broken: 0, links_checked: result.links_checked,
  // reported, never hidden: what the linter deliberately did not alarm on (ref_linter.py 2026-09-23)
  n_broken_archival: result.n_broken_archival ?? null,
  skipped_out_of_repo: result.skipped_out_of_repo ?? null,
  files_read: result.files_read ?? null,
});

const list = (result.broken || []).map((b) => `${b.file}:${b.line} -> ${b.target}`);
if (OBSERVE_ONLY) {
  // TRANSIENT_TOLERANCE (side-effect-free HALF): record a stable drift signature so a FUTURE phase
  // can compare it against the prior turn's. LOG-ONLY — no block, no behavior change this slice.
  const driftSignature = list.slice().sort().join('|');
  rampAlarmNotice('ref-lint-gate', n);   // louder, non-blocking stderr notice (does NOT block the turn)
  allow({
    ...base, decision: 'allow', mode: 'observe-only', n_broken: n, broken: list,
    ...rampAlarmRecord('ref-lint-gate', n, list),
    drift_signature: driftSignature,
    turn_touched_artifact: turnTouch(input.transcript_path, MATCH.anyMarkdown).touched, // derived from transcript (null on parse-fail)
  });
}
block('Doc-reference linter (robot #1): ' + n + ' broken markdown link(s) in the corpus — fix before finishing:\n- '
      + list.join('\n- '), { ...base, n_broken: n, broken: list });
