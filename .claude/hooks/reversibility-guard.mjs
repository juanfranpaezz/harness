#!/usr/bin/env node
/*
 * reversibility-guard.mjs — Robot #6 (CA-11): PreToolUse reversibility hard-list guard.
 * CURRENTLY BRAKE_MODE='deny-shadow' (measure-only: logs would_deny/would_clear, blocks NOTHING —
 * see the authoritative BRAKE_MODE const block ~line 32); the fail-CLOSED escalation described below
 * is built but dormant behind that flag. (The old boolean OBSERVE_ONLY was replaced by the 3-rung
 * BRAKE_MODE in revbrake-silent-v1, 2026-06-08; OBSERVE_ONLY now survives only as a back-compat alias.)
 *
 * Principle: CA-11 [IMMUTABLE] — a never-auto-applied action (delete / outward push / external send /
 * immutable-core write) must escalate to the human, not fire automatically. PreToolUse is the boundary;
 * the guard returns permissionDecision:"ask" → the CEO permission dialog (the CA-11 "ask the human").
 *
 * Feasibility CONFIRMED: PreToolUse fires live on this harness (probe wf, marker-call logged). The
 * throwaway observe probe also caught a real FP (`2>/dev/null` mis-read as delete) → fixed below.
 *
 * PHASED ROLLOUT (revbrake-silent-v1): SHIPPED rung = BRAKE_MODE='deny-shadow' → LOGS would_deny/
 * would_clear and ALLOWS everything (blocks nothing), so the deny FP surface can be measured on real
 * calls BEFORE any active flip. The 'active' rung (it ENFORCES via permissionDecision:'deny', no human
 * dialog — DR-1) is a SEPARATE later CEO gate. See the BRAKE_MODE const block (~line 32) for the
 * authoritative 3-rung description; this banner is a summary, not the source of truth.
 *
 * FAIL-CLOSED (the inversion of the Stop robots): when ACTIVE, an internal error on a call that COULD be
 * hard-list escalates to "ask", never silently allows. (Observe phase logs + allows.) PreToolUse has no
 * stop_hook_active loop field — "ask" is a single per-call escalation, so no trap.
 *
 * Contract: stdin JSON { tool_name, tool_input{...}, hook_event_name, ... }; to escalate (Phase 2):
 * print {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"..."}}, exit 0.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
// fixes-f round 2 (2026-10-10, verifier R3): THE BRAKE must never crash on a missing sibling (a crashed PreToolUse
// hook does not block). If _log-redact.mjs is absent, log() falls back to legacyScrub() below.
const { redactDeep } = await import('./_log-redact.mjs').catch(() => ({ redactDeep: legacyScrub }));
import { assessHonestRisk } from './honest-risk-preconditions.mjs'; // Wave-3 complement D1: OBSERVE telemetry only

// ── STAGED BRAKE FLAG (revbrake-silent-v1, 2026-06-08) — replaces the old boolean OBSERVE_ONLY ──
// Three rungs, least-aggressive default. SHIPPED value = 'deny-shadow' (the whole point of this slice):
//   'observe'     → byte-identical to the pre-2026-06-08 OBSERVE_ONLY=true behaviour. LOGS the would-ask
//                   decision, ALLOWS everything (exit 0), blocks NOTHING. Revert target (AC-6).
//   'deny-shadow' → MEASURE-ONLY. Still ALLOWS everything (exit 0, blocks NOTHING), but LOGS what it
//                   WOULD do once active (would_deny / would_clear) so the deny FP surface can be
//                   measured on real calls BEFORE any active flip. ← SHIPPED DEFAULT. Blocks nothing.
//   'active'      → ENFORCES: a hard-list action emits permissionDecision:'deny' (returns to the MODEL,
//                   no human dialog — DR-1) UNLESS a valid cleared marker exists. The active flip is a
//                   SEPARATE later CEO gate (REVBRAKE-SILENT-PLAN.md STEP 6); do NOT set it here.
// Env override REVGUARD_BRAKE_MODE is honoured ONLY for tests (so a single source can drive all three
// rungs); it never changes the shipped default. Any unrecognised value falls back to the shipped const.
const BRAKE_MODE = (() => {
  const allowed = ['observe', 'deny-shadow', 'active'];
  const env = process.env.REVGUARD_BRAKE_MODE;
  if (env && allowed.includes(env)) return env;
  return 'deny-shadow'; // ← SHIPPED DEFAULT. Blocks nothing; measures only. (active flip = separate CEO gate.)
})();
const OBSERVE_ONLY = (BRAKE_MODE === 'observe'); // back-compat alias so the existing observe-path reads still work.
const LOG = process.env.HARNESS_LOG_DIR ? `${process.env.HARNESS_LOG_DIR}/reversibility-guard.log` : new URL('./reversibility-guard.log', import.meta.url); // HARNESS_LOG_DIR = plugin data dir (runner-provided); unset = beside this file, as before
// finding #5 — scrub credential-shaped tokens from EVERY logged subject before it hits disk, at the single log()
// chokepoint. fixes-f 2026-10-08: the patterns now live in the ONE shared redactor (_log-redact.mjs: it adds
// github_pat_, AIza, URL passwords, PEM, bot tokens and high-entropy strings, verifier F2/A4) and the scrub recurses
// into nested values, so honest_risk is really covered (verifier F2b). Keys and non-string values stay intact.
// The pre-fixes-f scrub, kept ONLY as the fallback above: the same five rules, strings only, other values unchanged.
// One difference: the JWT rule's segments are bounded, so it stays linear on a long "eyJ-" run (verifier R4).
function legacyScrub(v) {
  if (typeof v !== 'string') return v;
  return v
    .replace(/\b(?:Bearer|Authorization:?\s*Bearer)\s+[A-Za-z0-9._\-]+/gi, 'Bearer <REDACTED>')
    .replace(/\b(_?auth[_-]?token|api[_-]?key|secret|password|passwd|pwd)\s*[=:]\s*\S+/gi, '$1=<REDACTED>')
    .replace(/\b(?:sk|pk|rk|npm|ghp|gho|ghs|xox[baprs]|AKIA|ASIA)[-_][A-Za-z0-9_\-]{6,}/g, '<REDACTED-TOKEN>')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '<REDACTED-AWS>')
    .replace(/\beyJ[A-Za-z0-9_\-]{1,512}\.[A-Za-z0-9_\-]{1,16384}\.[A-Za-z0-9_\-]+/g, '<REDACTED-JWT>');
}
function log(o) {
  try {
    const safe = {};
    for (const k of Object.keys(o)) safe[k] = redactDeep(o[k]);
    fs.appendFileSync(LOG, JSON.stringify(safe) + '\n');
  } catch { /* never crash on logging */ }
}
function readStdin() { try { return fs.readFileSync(0, 'utf8'); } catch { return ''; } }
function allow(extra) { log(extra); process.exit(0); }                       // empty stdout = allow
function ask(reason, extra) {
  log({ ...extra, decision: 'ask', reason });
  process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason } }));
  process.exit(0);
}
// deny() — the ACTIVE-mode silent block (same shape as ask(), but permissionDecision:'deny'). DR-1: a
// PreToolUse 'deny' returns the reason to the MODEL with NO human dialog (the brake re-reviews, the human
// is not the verifier — ceo-pref-14). Reached ONLY when BRAKE_MODE === 'active'.
function deny(reason, extra) {
  log({ ...extra, decision: 'deny', reason });
  process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
  process.exit(0);
}

// Module-level `input` is the CLI-path fallback that classify() reads when called WITHOUT an explicit
// arg. On import (tests) it stays {} and nothing runs; the live stdin read happens only inside main().
let input = {};

// CA-11 hard-list classifier (FP-tuned: NO `>/dev/null`, NO bare "deploy").
// v1.1 (wave1-review cheap win): + dd/aws-rb/gcloud-delete/truncate/shred/SQL-DROP (delete),
// + curl POST/--data (external-send), + settings.json/allowlists (immutable-core — was constitution/ only).
// v1.2 (2026-06-04 FP-tuning, CEO-authorized): strip string/regex literals passed to NON-shell
// consumers (node -e, grep, echo, a regex literal) before scanning, so a hard-list TOKEN that merely
// SITS INSIDE a quoted body does not false-match (observed FP: read-only analysis scripts that only
// MENTION "rm"/"DROP"; S2 measured FP=0.17%, all fail-safe). Shell-EXECUTING bodies (bash/sh/zsh/ksh/
// dash -c, eval, xargs) are kept INTACT — there the quoted text is itself run, so a destructive token
// inside it is a REAL action and must still escalate.
// KNOWN LIMITATION (v1.2) — NOW CLOSED for the documented DB-client class (v1.3, 2026-06-05, slice-1a):
// The v1.2 quote-stripping above means a destructive token inside a quoted arg to a NON-shell consumer is
// missed. v1.3 closes that recall gap for the documented DB-client family: a known DB client
// (`psql`/`mysql`/`mariadb`) invoked with `-c`/`-e`/`--command`/`--command=` has its quoted command body
// scanned SEPARATELY (via dbClientBody) for a KEYWORD-ANCHORED destructive command
// (`DROP (TABLE|DATABASE|SCHEMA)` / `TRUNCATE` as a command) — so `psql -c "DROP TABLE users"` now fires `delete`.
// FP carve-out BOUNDARY (kept tight, token-level — NOT full quote-parsing): the body is scanned ONLY for those
// anchored destructive COMMANDS, so a destructive token that ACTUALLY EXECUTES in a DB-client body fires, while a
// mere MENTION in a non-shell consumer does NOT (`node -e "...DROP TABLE..."`, `grep "DROP TABLE" file`,
// `echo "rm -rf /"`, `mysql --help`). The general non-shell quote-stripping (v1.2 FP fix protecting
// node -e/grep/echo) is UNCHANGED — only the named DB family is carved out.
// v1.4 (2026-06-05, slice-1c precondition — NARROW the SQL-string-literal FP that v1.3 left open): the
// extracted body now has SQL string literals (`... VALUES ('DROP TABLE x')`) and SQL comments (`-- DROP …`)
// emptied before the anchor runs, and TRUNCATE is anchored as a COMMAND (`TRUNCATE TABLE`/`TRUNCATE x`) so the
// numeric `TRUNCATE(x,d)` function no longer fires. A real DROP/TRUNCATE COMMAND is unaffected (it is not a
// literal/comment), so this removes false alarms with ZERO new FN on the genuine destructive set (Layer-A FN=0 holds).
// RESIDUAL (NOT closed by 1a/1c, logged as known residual FN — do NOT overclaim global FN=0): un-named clients/shapes
// such as `sqlite3`, `mongo`, `psql -f script.sql`, heredoc-fed bodies, and env-var-built commands are still missed.
// 1c's adversarial measurement probes beyond this documented class. Bare `mysql -e DROP` and `bash -c "DROP ..."`
// continue to fire via the normal paths. Moot while OBSERVE_ONLY (the guard blocks nothing).
// DA-1c FP-fix (2026-06-07): inert NON-SHELL bodies leak `>` into the scan and get mis-read as shell
// redirects (the 24-friction audit: heredoc markdown blockquotes `> …`, JS arrows `=>`, `>=` inside a
// `node -e` body). Two pre-passes blank such inert text BEFORE the quote-strip so a `>` that is DATA, not
// a shell redirect operator, never reaches extractFsTargets(). Fail-SAFE preserving: only NON-shell bodies
// are blanked — a shell-fed heredoc (`bash <<EOF`) or `bash -c` body is left INTACT (its text IS code).
//
// (1) stripHeredocs: a `<<[-]TAG … \nTAG` body is stdin DATA for the heredoc's command. Blank the body
//     ONLY when the command on the heredoc-open line is NOT a shell interpreter (node/cat/tee/python read
//     it as data; bash/sh/zsh/ksh/dash would EXECUTE it → keep). The open line + closing tag are kept so
//     the real command (e.g. `node writer.js`) still classifies.
function stripHeredocs(c) {
  return c.replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n([\s\S]*?)\n[ \t]*\2\b/g, (full, _q, tag, _body, off, str) => {
    const pre = str.slice(0, off);
    const cmdLine = pre.slice(pre.lastIndexOf('\n') + 1);
    if (/\b(?:bash|sh|zsh|ksh|dash)\b/i.test(cmdLine)) return full; // shell heredoc body = CODE → keep, scan it
    return '<<' + tag + '\n' + tag;                                  // non-shell heredoc body = DATA → drop
  });
}
// (2) blankInterpreterBodies: an inline interpreter ARG (`node -e <BODY>`, `python -c <BODY>`, `node -p`,
//     `--eval`/`--print`/`--command`) is interpreter SOURCE, never shell. Blank the whole quoted arg as a
//     UNIT so a mixed/nested-quote body (a `"…'…'…"` shape the plain quote-strip leaves unbalanced) cannot
//     leak a `>` / `rm` token. Note: the SEND classifier (inlineExecSend) reads the RAW cmd, NOT this scan,
//     so blanking here costs ZERO outward-send recall (TASK-3 path is unaffected).
function blankInterpreterBodies(c) {
  return c.replace(/\b((?:node|deno|bun|python3?|ruby|perl|php)\b(?:\s+\S+)*?\s+(?:-e|-p|-c|--eval|--print|--command)=?\s*)(['"])([\s\S]*?)\2/gi,
    (full, head, q) => head + q + q);
}
function execText(c0) {
  const c = blankInterpreterBodies(stripHeredocs(c0));   // blank inert non-shell bodies (DATA/source) first
  if (/\b(?:bash|sh|zsh|ksh|dash)\b[^\n]*\s-c\b/i.test(c) || /\beval\b/i.test(c) || /\bxargs\b/i.test(c)) return c;
  return c.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""').replace(/`[^`]*`/g, '``');
}
// DB-client carve-out (v1.4 — slice-1c precondition: NARROW the SQL-string-literal FP). For a known DB
// client (psql/mysql/mariadb) carrying a command flag (-c | -e | --command | --command=), EXTRACT just the
// SQL the client actually executes — the flag's argument with the shell quotes removed (the quoted body if
// quoted, else the rest of the line) — then REMOVE SQL string literals and SQL comments from it. A
// destructive keyword that is mere DATA (a quoted value) or sits in a COMMENT is therefore no longer
// mistaken for an executed command. Token-level / keyword-anchored downstream — NOT a full SQL parser.
// Returns the cleaned SQL body when the client+flag shape is present, else '' (no carve-out).
// v1.4 over v1.3: v1.3 returned the RAW whole command, so a DROP/TRUNCATE keyword living inside a SQL string
// value (`... VALUES ('DROP TABLE x')`), a SQL comment (`-- DROP TABLE x`), or the numeric TRUNCATE(x,d)
// function was wrongly read as an executed command (the Layer-A FP the 1a post-verify note flagged). The
// bare/unquoted destructive forms (`psql -c DROP TABLE x`) are STILL caught by the general scan in classify()
// (no shell quotes there to strip), so extracting only the executed body here loses no recall on those.
function dbClientBody(c) {
  // Require a known DB client (named family only). The command flag is matched during extraction below.
  // finding #4: + sqlite3 / mongo / mongosh.
  if (!/\b(?:psql|mysql|mariadb|sqlite3|mongo|mongosh)\b/i.test(c)) return '';
  let m, body;
  // -c | -e | --command | --eval (mongo) carrying a quoted or bare command body.
  if ((m = c.match(/(?:\s-c\b|\s-e\b|\s--command\b|\s--eval\b)=?\s*"([^"]*)"/i))) body = m[1];        // …flag "..."  (double-quoted body)
  else if ((m = c.match(/(?:\s-c\b|\s-e\b|\s--command\b|\s--eval\b)=?\s*'([^']*)'/i))) body = m[1];    // …flag '...'  (single-quoted body)
  // sqlite3 bare-SQL fallback: `sqlite3 db.sqlite "DROP TABLE x"` puts the SQL as a positional quoted arg
  // AFTER the database-file argument, with no command flag. Extract the last quoted run on the line.
  else if (/\bsqlite3\b/i.test(c) && (m = c.match(/.*["']([^"']*)["']\s*$/))) body = m[1];             // sqlite3 db "SQL"
  else if ((m = c.match(/(?:\s-c\b|\s-e\b|\s--command\b|\s--eval\b)=?\s*(\S.*)$/i))) body = m[1];       // …flag DROP…  (bare → rest of line)
  else return '';                                                                            // DB client present but no command flag
  return body
    .replace(/'[^']*'/g, "''")           // SQL single-quoted string literals (DATA) → emptied
    .replace(/--[^\n]*/g, ' ')           // -- line comments → removed
    .replace(/\/\*[\s\S]*?\*\//g, ' ');  // /* block comments */ → removed
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// DA-1c — fail-SAFE ALLOWLIST on the irreversible axis (observe-only build; PLAN.md v1, base c7ab812).
// The classifier below is INVERTED from a denylist-of-known-bad to an allowlist-of-provably-safe on the
// irreversible axis {fs-destructive, out-of-tree write, outward-send, spend, immutable-core}: such an
// action ESCALATES (would_ask) UNLESS its target is PROVABLY in-tree-and-git-tracked. Reversible in-tree
// work NEVER escalates. Everything stays observe-only (OBSERVE_ONLY===true) — this only changes the
// would_ask DECISION that is LOGGED, never any block. FAIL-SAFE everywhere: an unresolvable / opaque /
// $VAR / relative-.. / symlink / script-bodied target ⇒ ESCALATE (never silently ALLOW a novel encoding).
// ══════════════════════════════════════════════════════════════════════════════════════════════════

// Repo root = two dirs up from .claude/hooks/ (this file). Mechanical, no git call needed for the prefix
// check (the git ls-files membership check below is the authority on tracked-ness).
// P1 (2026-09-04, global-harness deploy): the root this hook OPERATES ON resolves in the order
// CLAUDE_PROJECT_DIR -> cwd (when it looks like a repo) -> the original dirname(thisfile)/../..
// expression, kept UNCHANGED as the last leg. Inside this repo all three agree, so behavior here is
// unchanged; a GLOBAL copy now operates on the CURRENT project, not on the dir it happens to live in.
const REPO_ROOT = (() => {
  try {
    const envRoot = process.env.CLAUDE_PROJECT_DIR;
    if (envRoot && fs.existsSync(envRoot)) return path.resolve(envRoot);
    const cwdRoot = process.cwd();
    if (fs.existsSync(path.join(cwdRoot, '.git')) || fs.existsSync(path.join(cwdRoot, '.claude'))) return path.resolve(cwdRoot);
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  } catch { return ''; }
})();

// Per-process cache of the tracked-file set (R4 pre-mortem: don't shell git on every hot-path call).
// Lazily populated on first need; on ANY git error → null sentinel ⇒ treat NOTHING as provably-tracked
// (fail-SAFE: unknown tracked-ness ⇒ ESCALATE, never ALLOW). The set holds repo-root-relative POSIX paths.
let _trackedSet; // undefined = not yet loaded; null = git unavailable/errored; Set = loaded
function trackedSet() {
  if (_trackedSet !== undefined) return _trackedSet;
  try {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const s = new Set();
    for (const p of out.split('\0')) { if (p) s.add(p); } // git ls-files emits POSIX-separated, repo-relative
    _trackedSet = s;
  } catch { _trackedSet = null; } // git missing / not a repo / spawn error ⇒ fail-SAFE (nothing provably tracked)
  return _trackedSet;
}

// A target token is STATICALLY RESOLVABLE only if it is a plain literal path: no $VAR / ${..} / `..` /
// $(..) command-sub, no glob metachars (* ? [ ]), no '..' parent traversal, no ~ home, not a flag, and
// not empty. Anything else ⇒ NOT statically resolvable ⇒ caller ESCALATES (fail-safe). We intentionally
// do NOT resolve symlinks (resolvable only at runtime) — a literal path that happens to be a symlink is
// still escalated downstream because we never prove its *real* target is in-tree.
function isStaticallyResolvable(target) {
  if (typeof target !== 'string' || target === '') return false;
  if (target.startsWith('-')) return false;                          // a flag, not a path
  if (/[$`*?\[\]~]|\$\(|\$\{/.test(target)) return false;           // var/cmd-sub/glob/home metachars
  if (/(^|[\\/])\.\.([\\/]|$)/.test(target)) return false;          // parent traversal — runtime-cwd dependent
  return true;
}

// THE NET-NEW path-boolean (PLAN WBS 1 / D1). Returns true ONLY if all three pass:
//   (1) statically resolvable literal,  (2) resolves UNDER the repo root,  (3) git-tracked (ls-files member).
// Any failure (incl. git unavailable, out-of-root, untracked-in-tree) ⇒ false ⇒ caller ESCALATES.
function isProvablyInTreeTracked(target) {
  try {
    if (!isStaticallyResolvable(target)) return false;
    if (!REPO_ROOT) return false;
    // Resolve relative to repo root (the agent's cwd is the repo root for our work). An absolute path
    // resolves to itself; a relative one is joined under the root.
    const abs = path.resolve(REPO_ROOT, target);
    const rootWithSep = REPO_ROOT.endsWith(path.sep) ? REPO_ROOT : REPO_ROOT + path.sep;
    if (abs !== REPO_ROOT && !abs.startsWith(rootWithSep)) return false;   // (2) escaped the repo root
    const set = trackedSet();
    if (!set) return false;                                                // git unavailable ⇒ fail-safe
    const rel = path.relative(REPO_ROOT, abs).split(path.sep).join('/');   // → repo-relative POSIX
    return set.has(rel);                                                   // (3) tracked membership
  } catch { return false; } // any error ⇒ NOT proven safe ⇒ escalate
}

// FP-FIX (brake-newfile-v1, 2026-06-21 — PROPOSED, NOT YET WIRED): the original fs allowlist demanded
// every target be git-TRACKED, which escalated the single most common reversible op — CREATING a NEW
// in-tree file (rename/copy/redirect/tee into a path that does not exist yet). Creating a new file is
// reversible (just delete it), it simply is not git-RESTORABLE. So the per-target predicate is widened
// from "provably git-tracked" to "provably REVERSIBLE-TO-AFFECT", which holds when the target:
//   (1) is statically resolvable AND resolves UNDER the repo root, AND
//   (2) EITHER is git-tracked (losing/overwriting it ⇒ `git restore` undoes it)
//          OR does NOT currently exist on disk (creating it ⇒ deleting it undoes it; "destroying" a
//             path that has no content is a no-op).
// The ONE case this deliberately still ESCALATES is the dangerous one the recall set pins: a target that
// exists in-tree but is UNTRACKED — real, un-restorable data (e.g. `rm meta/_session-coverage-RAW-asst.txt`).
// Losing that is NOT reversible (no git copy, content gone), so it stays on the hard-list. This is the
// exact axis that separates FP #4 (`rm <absent scratch path>` = reversible) from the recall case
// (`rm <existing untracked file>` = data loss). FAIL-SAFE everywhere: an unresolvable / out-of-root /
// git-unavailable / fs-stat-error target ⇒ false ⇒ caller ESCALATES (never silently ALLOW a novel shape).
// Existence is read with fs.existsSync on the repo-root-resolved absolute path (a symlink that exists
// counts as existing → escalate, never silently allow clobbering its target).
function isReversibleToAffect(target) {
  try {
    if (!isStaticallyResolvable(target)) return false;
    if (!REPO_ROOT) return false;
    const abs = path.resolve(REPO_ROOT, target);
    const rootWithSep = REPO_ROOT.endsWith(path.sep) ? REPO_ROOT : REPO_ROOT + path.sep;
    if (abs !== REPO_ROOT && !abs.startsWith(rootWithSep)) return false;   // escaped the repo root ⇒ escalate
    if (isProvablyInTreeTracked(target)) return true;                      // tracked ⇒ git-restorable ⇒ reversible
    // not tracked: reversible ONLY if the path does not yet exist (creating it = deletable; nothing to lose).
    // An existing untracked path = real un-restorable content ⇒ NOT reversible ⇒ escalate (recall case).
    let exists;
    try { exists = fs.existsSync(abs); } catch { return false; }           // stat error ⇒ fail-safe escalate
    return exists === false;                                               // absent ⇒ reversible (new file)
  } catch { return false; } // any error ⇒ NOT proven reversible ⇒ escalate
}

// Bash target extraction for the irreversible fs verbs (PLAN WBS 2): rm/rmdir/mv/cp/ln/dd/`>`/`>>`/tee.
// Returns { verb, targets:[...] } when a destructive fs op is present, else null. The classifier feeds
// each target to isProvablyInTreeTracked(); if ANY target is not provably in-tree-tracked (incl. zero
// extractable targets ⇒ opaque), the op ESCALATES. This is deliberately conservative: when in doubt,
// emit no/partial targets so the all-must-pass rule fails → escalate (fail-safe).
function extractFsTargets(scan) {
  // Split on shell separators so a `cd /tmp && rm x` (cd prefix) does not hide the rm, and each simple
  // command is examined on its own (R5: the cd prefix must not mask a later rm).
  const segments = scan.split(/(?:&&|\|\||[;\n|])/);
  // R5/VERIFY(d): a `cd` ANYWHERE makes the effective cwd runtime-ambiguous (`cd /tmp && rm x` deletes
  // /tmp/x, NOT the in-tree x). We cannot statically resolve the target → force ESCALATE: if a destructive
  // verb is present, return zero targets so the all-targets-tracked rule fails. Fail-safe over false-ALLOW.
  const cwdAmbiguous = /(^|[\s;&|(])cd\s/i.test(scan);
  for (const segRaw of segments) {
    const seg = segRaw.trim();
    if (!seg) continue;
    // redirect-to-file writes: `> path`, `>> path`, `… >path` (out-of-tree write vector). Capture target.
    const redir = seg.match(/>>?\s*("[^"]*"|'[^']*'|\S+)/);
    if (redir && !/^\s*>>?\s*&?\d?\s*$/.test(redir[0]) && !/\/dev\/null/.test(redir[1])) {
      return { verb: 'redirect', targets: cwdAmbiguous ? [] : [unquote(redir[1])] };
    }
    const m = seg.match(/(?:^|\s)(rm|rmdir|del|Remove-Item|mv|cp|ln|dd|tee|shred)\b/i);
    if (!m) continue;
    const verb = m[1].toLowerCase();
    if (cwdAmbiguous) return { verb, targets: [] };     // cwd unknown ⇒ zero targets ⇒ escalate
    // dd uses of=<path>; everything else takes positional path args (after dropping flags).
    if (verb === 'dd') {
      const of = seg.match(/\bof=("[^"]*"|'[^']*'|\S+)/i);
      return { verb, targets: of ? [unquote(of[1])] : [] }; // no `of=` ⇒ no target ⇒ escalate
    }
    // tokenize: keep quoted runs intact, drop flag tokens (leading '-'); the rest are path targets.
    const toks = seg.match(/"[^"]*"|'[^']*'|\S+/g) || [];
    const targets = [];
    for (let i = 1; i < toks.length; i++) {              // skip toks[0] (the verb)
      const t = toks[i];
      if (t.startsWith('-')) continue;                  // a flag (e.g. -rf, -sf, --recursive)
      if (verb === 'tee' && /^>>?$/.test(t)) continue;  // stray redirect token
      if (isRedirectToken(t)) continue;                 // DA-1c FP-fix: `2>/dev/null`/`2>&1`/`&>x`/`1>f` etc.
      targets.push(unquote(t));                          //   are stderr/stdout redirects, NOT delete targets
    }
    return { verb, targets };
  }
  return null;
}
function unquote(s) { return (typeof s === 'string') ? s.replace(/^["']|["']$/g, '') : s; }
// DA-1c FP-fix: a token that is a shell REDIRECT operator (not a path arg) — `2>/dev/null`, `2>&1`, `&>x`,
// `1>file`, `>out`, `<in` — must NOT be counted as a delete/move target. Such a token starts with an
// optional fd number then a `<`/`>` (optionally `&`). A plain path like `2024.log` or `a>b` (no leading
// fd+redirect shape with a separating operator at the start) is NOT matched. Pure, mechanical.
function isRedirectToken(t) {
  if (typeof t !== 'string') return false;
  return /^&?[0-9]*[<>]&?[0-9]*/.test(t); // [fd]< / [fd]> / >> / &> / 2>&1 / 2>/dev/null …
}

// SPEND detector (PLAN WBS 3 / D2) — billable outward calls. Fail-SAFE: an opaque script body that we
// cannot read is NOT exempted here (it falls through to outward-send / stays escalate if it shows a host).
const PAID_API_HOST = /\b(?:api\.openai\.com|generativelanguage\.googleapis\.com|api\.anthropic\.com|email\.[a-z0-9-]+\.amazonaws\.com|api\.stripe\.com|api\.twilio\.com|api\.sendgrid\.com)\b/i;
const PAY_CLI = /\bstripe\b|\bopenai\s+api\b|\baws\s+ses\s+send-email\b|\baws\s+ses\s+send-raw-email\b|\bsendgrid\b|\btwilio\b/i;
function isSpend(scan) {
  if (PAY_CLI.test(scan)) return true;
  // a network client (curl/wget/http/httpie) hitting a paid-API host — even GET-shaped (the D2 GET miss).
  if (/\b(?:curl|wget|http|https|xh)\b/i.test(scan) && PAID_API_HOST.test(scan)) return true;
  return false;
}

// Widened OUTWARD-SEND shapes (PLAN WBS 4 / D3) — extends today's git-push + curl-POST. Covers
// script-sends (python/node bodies that POST/fetch/send), wget --post-data, httpie `http POST`, scp,
// rsync egress (host:path), curl -T/--upload-file, and a node -e fetch with method POST.
function isOutwardSend(scan) {
  // scp/rsync to a remote (user@host:path or host:path) = egress. Local scp/rsync (no remote spec) is not.
  if (/\bscp\b[^\n]*\s[\w.-]+@[\w.-]+:/i.test(scan)) return true;
  if (/\brsync\b[^\n]*\s[\w.-]+@?[\w.-]+:/i.test(scan) && /@|:\S/.test(scan.replace(/^[^]*\brsync\b/i, ''))) return true;
  // curl upload without -X POST/--data: -T / --upload-file.
  if (/\bcurl\b[^\n]*(-T\b|--upload-file\b)/i.test(scan)) return true;
  // wget POST.
  if (/\bwget\b[^\n]*--post(-data|-file)?\b/i.test(scan)) return true;
  // httpie POST (http POST / https POST / xh POST).
  if (/\b(?:http|https|xh)\b\s+POST\b/i.test(scan)) return true;
  // node -e / node inline with a fetch(... method POST ...) or .post( .
  if (/\bnode\b[^\n]*\bfetch\b[^\n]*POST/i.test(scan)) return true;
  // script-send: a python/node script whose NAME advertises an outward send (opaque body ⇒ fail-safe escalate).
  if (/\b(?:python3?|node)\b\s+\S*(?:send|notif|mail|email|post|upload|exfil|webhook|slack|telegram)\S*\.(?:py|js|mjs|cjs|ts)\b/i.test(scan)) return true;
  // finding #2 — PowerShell-native web clients (Invoke-WebRequest/Invoke-RestMethod and their aliases iwr/irm)
  // to an EXTERNAL host. The shared NET_CLIENT external-host / secret-in-query tells below also cover these.
  const PS_WEB = /\bInvoke-WebRequest\b|\bInvoke-RestMethod\b|\biwr\b|\birm\b/i;
  // finding #3 — GET-shaped exfil. A network client to an EXTERNAL host is egress regardless of HTTP verb.
  // Two escalation tells, either suffices:
  //   (a) the URL carries a shell-variable or command-substitution in its query (the exfil signature), or
  //   (b) a curl/wget/http client targets an http(s) URL whose host is not on the local/allow set.
  const NET_CLIENT = /\b(?:curl|wget|http|https|xh|httpie)\b/i;
  if (NET_CLIENT.test(scan) || PS_WEB.test(scan)) {
    // (a) secret-in-query tell: a $VAR / ${..} / $(..) / backtick inside an http(s) URL or its query
    if (/https?:\/\/[^\s'"]*(?:\$\{?\w|\$\(|`)/i.test(scan)) return true;
    // (b) external host (exclude localhost / loopback / RFC1918 / link-local). CODE-COHERENCE FIX
    //     (brake-deep-hole-v1, 2026-06-21): the old comment claimed link-local-metadata (169.254.) is
    //     "caught as SSRF at the tool layer, finding #6" — that detector NEVER EXISTED (grep-confirmed).
    //     169.254. is excluded here as isLocal, so IMDS egress was SILENTLY ALLOWED. The real SSRF/IMDS
    //     escalation now lives in classify()'s R4 branch (IMDS_HOST), which runs independent of this exclusion.
    const url = scan.match(/https?:\/\/([^\s'"\/?#]+)/i);
    if (url) {
      const host = url[1];
      const isLocal = /^(?:localhost|127\.|::1|169\.254\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/i.test(host);
      if (!isLocal) return true;
    }
  }
  return false;
}

// finding #3 (companion to the scan-side tells in isOutwardSend) — the GET-exfil signature lives INSIDE the
// URL, which execText() quote-strips before isOutwardSend sees it (`curl "https://h/?x=$S"` → `curl ""`).
// So we re-run the same two tells against a URL-PRESERVING view of the command. To keep the existing FP
// carve-out (a mere MENTION of a url inside echo/grep/node -e must NOT fire), we only blank the NON-shell
// inert bodies (heredoc + inline-interpreter args, exactly as execText does) but DO NOT strip ordinary
// argument quotes — and we require a real net-client verb to still be present after that blanking. A curl
// URL mentioned inside `echo "..."` / `node -e "..."` is gone after blankInterpreterBodies/the echo arg is
// itself a quoted string the verb-presence gate excludes; a genuine `curl "url"` survives.
function getExfilRaw(cmd) {
  if (typeof cmd !== 'string' || cmd === '') return false;
  const pre = blankInterpreterBodies(stripHeredocs(cmd));   // blank inert non-shell DATA/source bodies only
  // require a real network-client command verb (curl/wget/http/xh/httpie or a PS web cmdlet/alias) present.
  if (!/\b(?:curl|wget|http|https|xh|httpie|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b/i.test(pre)) return false;
  // FP guard: if the net-client token only appears INSIDE a quoted echo/print argument (no bare verb), skip.
  // We approximate "real command" by checking the verb appears at a command position (line/segment start or
  // after a shell separator), not solely as quoted text following echo/printf/print.
  const segs = pre.split(/(?:&&|\|\||[;\n|])/);
  const verbIsCommand = segs.some((s) => /^\s*(?:sudo\s+|env\s+\S+=\S+\s+)*(?:curl|wget|http|https|xh|httpie|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b/i.test(s.trim())
    && !/^\s*(?:echo|printf|print|cat)\b/i.test(s.trim()));
  if (!verbIsCommand) return false;
  // (a) secret-in-query tell: $VAR / ${..} / $(..) / backtick inside an http(s) URL.
  if (/https?:\/\/[^\s'"]*(?:\$\{?\w|\$\(|`)/i.test(pre)) return true;
  // (b) external host (exclude localhost / loopback / RFC1918 / link-local-metadata).
  const url = pre.match(/https?:\/\/([^\s'"\/?#]+)/i);
  if (url) {
    const isLocal = /^(?:localhost|127\.|::1|169\.254\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/i.test(url[1]);
    if (!isLocal) return true;
  }
  return false;
}

// DA-1c FN-fix — inline-interpreter network-send detector (closes the 2 known FN gaps). An INLINE
// interpreter (node/bun/deno/python/ruby/perl/php with -e/-p/-c/--eval/--print/eval) whose RAW body shows
// any network-send shape. Broadened beyond the literal `axios.post` token so an ALIASED / require'd client
// (`const a=require('axios'); a.post(…)`) and `bun -e "fetch(…POST)"` no longer slip through. Reads the RAW
// command (the interpreter body), NOT the quote-blanked scan, so the body is visible here.
const INLINE_INTERP = /\b(?:node\s+(?:-e|-p|--eval|--print)|bun\s+(?:-e|-p|--eval|--print|run\b[^\n]*\s-e\b)|deno\s+(?:eval|-e|--eval)|python3?\s+-c|ruby\s+-e|perl\s+-e|php\s+-r)\b/i;
function inlineInterpNetworkSend(cmd) {
  if (typeof cmd !== 'string' || !INLINE_INTERP.test(cmd)) return false;
  // a send-shaped method call on ANY receiver (covers aliased/require'd clients): .post( .put( .patch( .request( .upload(
  if (/\.(?:post|put|patch|request|upload)\s*\(/i.test(cmd)) return true;
  if (/\bfetch\s*\(/i.test(cmd)) return true;                                  // fetch( (any method = egress)
  // a require()/import of a known HTTP client/module (the aliased-client root cause).
  if (/\b(?:require\s*\(\s*|from\s+)['"](?:axios|node-fetch|got|superagent|undici|request|needle|ky|phin|https?|urllib\.?request)['"]/i.test(cmd)) return true;
  if (/\b(?:requests|httpx|aiohttp|http\.client|urllib)\b/i.test(cmd)) return true;   // python network clients
  if (/\burlopen\s*\(|\bHTTPSConnection\b|\bXMLHttpRequest\b/i.test(cmd)) return true; // low-level send shapes
  return false;
}

function classify(arg) {
  // Accept an explicit {tool_name, tool_input} (test/direct call) OR fall back to module-level input (CLI path).
  const inp = (arg && typeof arg === 'object') ? arg : input;
  const tool = inp.tool_name || '';
  const ti = (inp.tool_input && typeof inp.tool_input === 'object') ? inp.tool_input : {};
  const cmd = String(ti.command || '');
  const fpath = String(ti.file_path || ti.path || '');

  const isShell = (tool === 'Bash' || tool === 'PowerShell');   // finding #2: PS is the primary live shell
  const scan = isShell ? execText(cmd) : cmd;
  // R5 pre-mortem: widen the logged subject so a later rm behind a `cd …` prefix is not hidden by the old
  // 100-char truncation. We log up to 400 chars (still bounded), and prefer the whole command for Bash.
  const subj = (s) => String(s).slice(0, 400);

  // ── A1 DEEP-HOLE PATCH (brake-deep-hole-v1, 2026-06-21 — staged behind the deliberate safety gate) ──
  // Make the brake RECOGNIZE the destructive command families it was blind to (disk/partition wipe,
  // service/firewall disrupt, SSRF-to-IMDS, machine shutdown/reboot, crontab wipe, immutable-lock, infra
  // destroy) and ESCALATE them (fail-CLOSED for when active), instead of returning null (silent allow).
  // All branches are OR-added BEFORE the existing lanes, fail-safe, reusing the existing scan pipeline.
  // Helper FP-fix: execText() strips quotes/heredocs/interp-bodies but does NOT remove `#` comments or
  //   prose, so a common-word verb (`shutdown`/`stop`/`reboot`) inside a comment or prose would false-match.
  //   scanNoComments blanks `#…`-to-EOL; CMD_START anchors common-word verbs to COMMAND POSITION (segment
  //   start, after optional sudo/env prefix), so a filename arg (`cat poweroff.log`) — which has a command
  //   token BEFORE it — is NOT in command position and does not match. Applied ONLY to the common-word
  //   families (R2/R3/R5); the specific-binary families (R1/R4) test plain `scan`.
  const scanNoComments = scan.replace(/(?:^|\s)#[^\n]*/g, ' ');
  const CMD_START = String.raw`(?:^|[;&|\n(]|&&|\|\|)\s*(?:sudo\s+|env\s+\S+=\S+\s+)*`;
  const atCmd = (rest) => new RegExp(CMD_START + rest, 'i').test(scanNoComments);

  // DB-client carve-out: scan the UN-stripped body for keyword-anchored destructive COMMANDS only (no full parse).
  const dbBody = isShell ? dbClientBody(cmd) : '';
  // TRUNCATE is anchored as a COMMAND (`TRUNCATE TABLE x` / `TRUNCATE x`), NOT the numeric function
  // `TRUNCATE(x,d)` — the function is followed immediately by `(`, the command by whitespace + an identifier.
  const dbDestructive = dbBody !== '' && (/\bDROP\s+(?:TABLE|DATABASE|SCHEMA)\b|\bTRUNCATE\s+(?:TABLE\b|[\w"`])/i.test(dbBody)
      || /\bdb\.dropDatabase\b|\bdrop(?:Database|Collection)?\s*\(/i.test(dbBody));   // finding #4: mongo

  // ── immutable-core write via SHELL (CRITICAL self-disable closure, finding #1) ──────────────────
  // The git-tracked-equals-reversible ALLOW shortcut (below) must NEVER apply to the guard's OWN config
  // or code: a Bash write/redirect/move/copy/chmod/sed/perl/tee/node-fs that TARGETS the guard's control
  // surface escalates REGARDLESS of git-tracked status (a "git restore" does not undo running with the
  // guard disabled in between). This is intentionally a STRING match on the protected path appearing as a
  // write/redirect target — broad on purpose; these paths are never a routine reversible edit.
  // KEYSTONE ITER-4 (BENIGN-WORD FP, 2026-06-16 ratify-verifier confirmed): `allowlist` was a BARE,
  // UNBOUNDED substring in the alternation, so the AND-gated common-English verbs added in ITER-3
  // (`copy`/`move`/`ren`) made benign prose FALSE-POSITIVE as immutable-core-write (`copy the allowlist
  // to the client`, `ren the allowlist section heading`, `move a.txt allowlist-notes.txt` — 5/5 fired).
  // Root cause: `allowlist` matched the bare English word ANYWHERE, with no path/word boundary. Bound it
  // to a PATH component: a leading separator (`[\\/]allowlist`, the `.claude/.../allowlist...` form) OR an
  // extension (`allowlist\.\w`, the bare `allowlist.json` form). A bare prose `allowlist` (no separator,
  // no dot+ext — incl. `allowlist-notes.txt` where `allowlist` is followed by `-`) no longer matches.
  // The REAL core paths are PRESERVED: `.claude/hooks/allowlist.json` (leading `/`), `allowlist.json`
  // (dot+ext), any `path/allowlist` (leading sep). The other tokens (`settings(.local).json` word-/sep-
  // bounded, sep-bounded `\.claude/hooks/`, `constitution/`, `reversibility-markers/`) were ALREADY
  // bounded and are unchanged. STRENGTHEN-ONLY everywhere else; this edit ONLY removes false matches on
  // the bare English word — it removes ZERO real-core-path match (all real forms have a sep or an ext).
  // KEYSTONE ITER-5 (BENIGN `<word>-allowlist.<ext>` FP, 2026-06-16 ratify-verifier confirmed): the ITER-4
  // token `\ballowlist\.\w` STILL matched `<word>-allowlist.<ext>` because a non-separator word-char before
  // `allowlist` still satisfies `\b` (`report-allowlist.md`, `user-allowlist.csv`, `team-allowlist.txt` →
  // FALSE-POSITIVE as immutable-core-write, while the live original returns null). FIX (verifier's exact
  // prescription): anchor the dot+ext allowlist alternative on start-of-string / whitespace / path-separator
  // — `(^|[\s\\/])allowlist\.\w` — NOT `\b`. `[\\/]allowlist` (the path-separator form) is kept as-is. This
  // ONLY removes false matches on a hyphen/word-prefixed `allowlist.<ext>`; every REAL core path is preserved
  // (`.claude/hooks/allowlist.json` via leading `/`, bare `allowlist.json` via `^`, any `dir/allowlist.json`
  // via the separator). STRENGTHEN-ONLY otherwise; nothing else changed.
  const CORE_PATH = /(^|[\\/])settings(\.local)?\.json\b|(^|[\s\\/])\.claude[\\/]hooks[\\/]|(^|[\s\\/])constitution[\\/]|[\\/]allowlist|(^|[\s\\/])allowlist\.\w|(^|[\s\\/])reversibility-markers[\\/]/i;
  // KEYSTONE FIX #3 (dec-46 self-protection leak #3): a core path hidden behind a shell variable
  // (`D=.claude/hooks; cp e.mjs $D/reversibility-guard.mjs`) keeps the literal `.claude/hooks/` out of the
  // raw scan, so CORE_PATH.test() never sees it and the op leaks into the `delete` lane (which HAS an
  // auto-clear path). Strengthen-only pre-pass: substitute simple, statically-known `VAR=value` assignments
  // made earlier ON THE SAME command line back into later `$VAR` / `${VAR}` references, then ALSO test
  // CORE_PATH against this expanded view. This can ONLY make MORE strings match CORE_PATH (it adds matches,
  // never removes), so no existing detection weakens and no benign call newly escalates unless it really
  // builds a core path from a literal assignment. Values themselves are kept literal (no recursion / no
  // command-substitution / no env-var resolution — fail-safe: an opaque `$VAR` simply stays unexpanded).
  const expandShellVars = (s) => {
    if (typeof s !== 'string' || s.indexOf('$') < 0) return s;
    const assigns = {};
    // collect `NAME=value` assignments (value: a bare token or a quoted run) at command/segment starts.
    const re = /(?:^|[;&|\n]|&&|\|\|)\s*([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s;&|]*)/g;
    let m;
    while ((m = re.exec(s)) !== null) assigns[m[1]] = unquote(m[2]);
    if (!Object.keys(assigns).length) return s;
    // substitute $NAME and ${NAME} with the captured literal (only for names we actually saw assigned).
    return s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
      (full, braced, bare) => { const n = braced || bare; return (n in assigns) ? assigns[n] : full; });
  };
  const scanX = isShell ? expandShellVars(scan) : scan;   // expanded view (adds matches only)
  const cmdX = isShell ? expandShellVars(cmd) : cmd;
  // KEYSTONE FIX #2 (companion): an inline `shutil.copy('e','.claude/hooks/guard.mjs')` carries the core
  // path INSIDE quotes — `'.claude/hooks/...'` — so the `(^|[\s\\/])` boundary in CORE_PATH never matches
  // (a `'` precedes `.claude`). Test CORE_PATH ALSO against a quote-/comma-/paren-/equals-normalized view of
  // the raw command (quotes & arg punctuation & `=` → spaces) so a quoted core path (`"…"`/`'…'`), a parened
  // arg, AND a `prefix=<path>` form (e.g. `dd of=.claude/hooks/…`, `--dest=…`) all become whitespace-anchored
  // and match. Strengthen-only: it only EXPOSES more path boundaries (adds matches, never removes one), and the
  // actual write-verb gate below still has to fire for the branch to escalate.
  // KEYSTONE ITER-2 (MF2): also added `=` to the normalization set — without it `of=.claude/…` had the core
  // path glued to `=` (neither `^`/space/`\`/`/` precedes `.claude`) so the CORE_PATH boundary never matched
  // and `dd of=<core>` leaked to null. Now used for the VERB leg too (not just the inline branch) so quoted /
  // backslashed / `prefix=`-glued core paths in cp/mv/dd/Copy-Item etc. are recognized.
  const coreInCmd = (s) => CORE_PATH.test(s) || CORE_PATH.test(String(s).replace(/['"(),=]/g, ' '));
  // ── CORE-DELETE branch (REDTEAM-2026-06-17 finding #1/#2/#3 — the rm/delete self-disable hole) ──────
  // HIGHEST PRIORITY, BEFORE both SHELL_WRITES_CORE and the in-tree-tracked allowlist: a DELETE verb that
  // TARGETS a core path must escalate as `immutable-core-write` REGARDLESS of git-tracked status. The
  // earlier patch closed cp/mv/Edit/copy core WRITES, but a bare `rm .claude/hooks/reversibility-guard.mjs`
  // fell through to the in-tree-tracked allowlist (the guard IS git-tracked) and was rescued as
  // "reversible by git restore" → null. But deleting the guard leaves it running DISABLED until the
  // restore; a `git restore` does NOT undo having operated WITHOUT the brake in between (same argument as
  // the banner). The other delete shapes (rmdir/del/Remove-Item/rd) fell to the auto-clear `delete` lane —
  // also a leak for a core target. So: a core-path delete is NEVER git-reversible for the brake's purpose.
  //   #1 bash bare delete verbs: rm / rmdir / del / unlink / shred  (rm of a tracked core path = the hole).
  //   #2 inline-interpreter deletes (mirror of the inline-send detector; reads the RAW cmd, body visible):
  //      node/bun/deno -e rmSync/unlinkSync/rmdirSync/rm(, python -c os.remove/os.unlink/os.rmdir/
  //      shutil.rmtree/Path(..).unlink — destructive fs calls the quote-blanking would otherwise hide.
  //   #3 PowerShell .NET / pipeline / Clear-Content deletes: Remove-Item / ri / rd / del / Clear-Content,
  //      the .NET methods [System.IO.File]::Delete / [System.IO.Directory]::Delete / a chained `.Delete(`,
  //      and a `… | Remove-Item` pipeline (the verb has no leading position after the pipe, so the existing
  //      `delete` lane's `\bRemove-Item\b` still matches it but routes it to auto-clear — caught here first).
  // AND-gated on a real core path (coreInCmd over the RAW cmd + the var-expanded views), so a benign
  // `rm meta/scratch.txt` / `rm meta/POSITION.md` (no core path) is NOT escalated here — it falls through to
  // the existing fs allowlist exactly as before. Strengthen-only: an OR-added branch ABOVE the allowlist; it
  // only ADDS escalations on core-target deletes, removes none, and never touches a non-core delete.
  const DELETE_VERB_SHELL = /(?:^|[\s;&|(])(?:rm|rmdir|del|unlink|shred|Remove-Item|Clear-Content|ri|rd)\b/i;
  const DELETE_DOTNET = /\[\s*(?:System\.)?IO\.(?:File|Directory)\s*\]\s*::\s*Delete\b|(?:^|[^\w.])(?:File|Directory)\.Delete\s*\(|\.Delete\s*\(/i;
  const DELETE_PIPE_REMOVE = /\|\s*(?:Remove-Item|ri|rm|del)\b/i;
  // inline-interpreter destructive fs call — combined into ONE test() FUNCTION (a `regex1 || regex2`
  // expression would evaluate to regex1 alone, since a RegExp object is truthy).
  // VERIFIER FIX (REDTEAM-DELETE, 2026-06-17): the JS leg had the SAME MF1 dead-code bug the WRITE path
  // already fixed — a SHARED leading `\b` before the whole alternation made the MEMBER-ACCESS / dotted-
  // receiver forms (`require('fs').rm(`, `.unlink(`) DEAD: `).rm(` has `)` (non-word) immediately before the
  // `.` (non-word), so `\b` cannot match there. Result: async `fs.rm(...)` / `fs.unlink(...)` / `bun -e`
  // dotted forms leaked to null, AND `Deno.remove`/`Deno.removeSync` were not even listed. Split, mirroring
  // the WRITE-path MF1 fix: (1) the WORD-INITIAL verbs keep the `\b`; (2) the MEMBER-ACCESS / leading-dot
  // forms (`.rm(`, `.unlink(`, `Deno.remove(`, `Deno.removeSync(`) match with NO `\b`, anchored on the
  // literal `.`/name + `(`. Same fix for the python/ruby/perl leg's `Path(..).unlink(` / `.unlink(` dotted
  // forms. Strengthen-only (the dotted forms could match NOTHING before — this only adds matches).
  const DELETE_INLINE_INTERP = (s) =>
    (/\b(?:node|deno|bun)\b/i.test(s)
      && (/\b(?:rmSync|unlinkSync|rmdirSync|removeSync)\s*\(/i.test(s)            // word-initial verbs
          || /(?:^|[^\w.])(?:fs|Deno|fsp|fsPromises)\.(?:rm|unlink|rmdir|remove)\s*\(/i.test(s)  // namespaced member call
          || /\.(?:rm|unlink|rmdir)\s*\(/i.test(s)))                              // any dotted receiver .rm(/.unlink(
    || (/\b(?:python3?|ruby|perl)\b/i.test(s)
      && (/\bos\.(?:remove|unlink|rmdir|removedirs)\s*\(|\bshutil\.rmtree\s*\(/i.test(s)
          || /\.unlink\s*\(/i.test(s)));                                          // Path(..).unlink() dotted form
  // CORE TARGET for a DELETE: the existing CORE_PATH requires a trailing separator after `hooks`
  // (`\.claude[\\/]hooks[\\/]`) so the bare core DIRECTORY (`rm -rf .claude/hooks`, `rd .claude`,
  // `[IO.Directory]::Delete(".claude/hooks")`) was NOT matched — it fell to the auto-clear `delete` lane.
  // Deleting the WHOLE hooks dir / the .claude tree / the constitution|reversibility-markers dir is
  // unambiguously a brake-disable; there is NO benign reason to delete these directories, so for the DELETE
  // branch ONLY we ALSO match the bare-directory forms (no trailing-separator requirement). This does NOT
  // widen CORE_PATH for the write/allowlist paths — it is scoped to this delete-target test. AND-gated on a
  // real delete verb above, so a benign `cat .claude/hooks/x` (no delete verb) is untouched.
  // The lookahead requires the core dir to be the TERMINAL path component (end-of-token: string end, or a
  // whitespace / closing quote-paren). It deliberately does NOT allow a trailing `/` to continue into a
  // DEEPER subpath — so `rm .claude/logs/old.log` (rotating the brake's own log, a benign non-code file NOT
  // under `.claude/hooks/`) does NOT escalate here; only deleting the WHOLE `.claude` or `.claude/hooks`
  // directory (or the constitution / reversibility-markers dir) matches. A core CODE FILE under hooks
  // (`.claude/hooks/x.mjs`) is still caught by CORE_PATH (the trailing-separator form), unaffected by this.
  const CORE_DEL_DIR = /(^|[\s'"(,=\\/])\.claude(?:[\\/]hooks)?(?=$|[\s'")])|(^|[\s'"(,=\\/])(?:constitution|reversibility-markers)(?=$|[\s'")])/i;
  const coreDelTarget = (s) =>
    coreInCmd(s) || CORE_PATH.test(s) || CORE_DEL_DIR.test(s) || CORE_DEL_DIR.test(String(s).replace(/['"(),=]/g, ' '));
  const SHELL_DELETES_CORE =
    // #1 + #3 (bash/PS delete verbs, the .NET delete methods, a Remove-Item pipeline) whose command line
    //    names a core path. Test the verb/method against scanX (quote-stripped, var-expanded) and the core
    //    path via coreDelTarget over the RAW cmd/cmdX too (a quoted/`$VAR`/backslash/bare-dir core path the
    //    quote-strip would erase is recovered exactly as the WRITE leg does, plus the bare-directory forms).
    (((DELETE_VERB_SHELL.test(scanX) || DELETE_VERB_SHELL.test(cmdX))
        || DELETE_DOTNET.test(cmdX) || DELETE_DOTNET.test(scanX)
        || DELETE_PIPE_REMOVE.test(cmdX) || DELETE_PIPE_REMOVE.test(scanX))
      && (coreDelTarget(scan) || coreDelTarget(scanX) || coreDelTarget(cmd) || coreDelTarget(cmdX))) ||
    // #2 inline-interpreter destructive fs call (reads the RAW cmd — the body is visible there) over a core path.
    (DELETE_INLINE_INTERP(cmdX) && (coreDelTarget(cmd) || coreDelTarget(cmdX)));
  if (isShell && SHELL_DELETES_CORE)
    return ['immutable-core-write', subj(cmd)];
  const SHELL_WRITES_CORE =
    // redirect into a core path:  > .claude/settings.json   |  >> .../hooks/x.mjs
    (/>>?\s*("[^"]*"|'[^']*'|\S+)/.test(scanX) && (CORE_PATH.test(scan) || CORE_PATH.test(scanX))) ||
    // a write/move/copy/perm/in-place-edit verb whose command line names a core path.
    // KEYSTONE ITER-2 (MF2 Windows siblings + quoted/backslash/of= core paths): (a) added the PowerShell
    // file-mutation cmdlets `Copy-Item`/`Move-Item`/`Rename-Item` (Set-Content/Out-File/Add-Content/New-Item
    // were already present) — PowerShell is the primary live shell, so a `Copy-Item e .claude/hooks/guard.mjs`
    // over the guard was leaking to null. (b) the CORE_PATH check now ALSO tests `coreInCmd` against the RAW
    // `cmd`/`cmdX` — the old check only looked at `scan`/`scanX`, the QUOTE-BLANKED views (execText() blanks
    // `"…"`/`'…'` to empty), so a quoted core path (`cp e "..core.."`) had its path erased before CORE_PATH
    // ever saw it and fell through to the `delete` lane. `coreInCmd` normalizes quotes/parens/commas/`=` →
    // spaces over the raw command, so quoted, `of=`-glued, and backslash-separated core paths are recognized.
    // Strengthen-only: every check is OR-added; no existing alternative removed; the verb gate still must fire.
    // KEYSTONE ITER-3 (PS-ALIAS LEAK, 2026-06-16 ratify-verifier residual): the ITER-2 fix added the FULL
    // cmdlet names (`Copy-Item`/`Move-Item`/`Rename-Item`/`Remove-Item`) but NOT their DEFAULT shorthand
    // aliases — the form an operator actually types. PowerShell aliases `copy`/`cpi` (Copy-Item),
    // `move`/`mi` (Move-Item), `ren`/`rni` (Rename-Item), `ri`/`rd` (Remove-Item) over the guard were
    // leaking to null (or, for `rd`, to the auto-clear `delete` lane — still a leak for a core target).
    // Added below as a SEPARATE alternation. `copy`/`move` are common English words, so this whole branch
    // is — and always was — AND-gated on a CORE path actually being the target (`CORE_PATH`/`coreInCmd`);
    // a benign `copy the report to the client` has no core path, so it still classifies null. `cp`/`mv` are
    // already present (those ARE the short PS aliases for Copy-Item/Move-Item AND the bash verbs). Note `ri`
    // is also caught here as immutable-core-write (it was `delete` = auto-clear before, a leak for core).
    // Strengthen-only: an OR-added alternation, still gated on the core-path check; nothing removed/widened.
    (/\b(?:tee|cp|mv|ln|dd|chmod|chown|truncate|sed\s+-i|perl\s+-i|Set-Content|Out-File|Add-Content|New-Item|Copy-Item|Move-Item|Rename-Item|copy|move|cpi|mi|ri|ren|rni|rd)\b/i.test(scanX)
      && (CORE_PATH.test(scan) || CORE_PATH.test(scanX) || coreInCmd(cmd) || coreInCmd(cmdX))) ||
    // node/python inline that writes a core path (writeFileSync / open(...,'w') / Out-File etc.)
    // KEYSTONE FIX #2 (dec-46 self-protection leak #2): the inline-write branch matched only the Node fs
    // verbs + python `open(...,'w')`; a `python -c "shutil.copy('e','.claude/hooks/guard.mjs')"` (and the
    // sibling copy/move/replace helpers) slipped through as null. Extend the inline-write verb set to cover
    // python's shutil.copy/copy2/copyfile/move + os.replace/os.rename + pathlib Path.write_text/write_bytes,
    // and Ruby/Perl/Node fs-copy/rename. Strengthen-only (an added alternation; existing verbs unchanged).
    // KEYSTONE ITER-2 (MF1 — DEAD-CODE FIX): the previous single regex put ONE leading `\b` before the WHOLE
    // alternation, but `Path('…').write_text(x)` has the `.` of `.write_text` preceded by `)` (a non-word
    // char) so `\b\.write_(text|bytes)` could NEVER match — `.write_text`/`.write_bytes`/leading-dot `File.`
    // forms were effectively DEAD. Split into TWO tests: (1) the WORD-INITIAL verbs keep the `\b` anchor;
    // (2) the MEMBER-ACCESS / leading-dot forms (`.write_text`, `.write_bytes`, `File.write/rename`) match
    // with NO `\b` (anchored instead on the literal `.` + name + `(`), so a chained call like
    // `Path('…').write_text(…)` now fires. Strengthen-only (the dotted forms could match nothing before).
    (/\b(?:node|deno|bun|python3?|ruby|perl)\b/i.test(cmdX)
      && (/\b(?:writeFileSync|appendFileSync|createWriteStream|copyFileSync|cpSync|renameSync|open\s*\([^)]*['"]w|shutil\.(?:copy2?|copyfile|move)|os\.(?:replace|rename)|copy_file|FileUtils\.(?:cp|mv))/i.test(cmdX)
          || /\.write_(?:text|bytes)\s*\(|\bFile\.(?:write|rename)\b|(?:^|[^\w.])(?:File|Path)\.[A-Za-z_]+\s*\(/i.test(cmdX))
      && (coreInCmd(cmd) || coreInCmd(cmdX)));
  if (isShell && SHELL_WRITES_CORE)
    return ['immutable-core-write', subj(cmd)];

  // ══ A1 DEEP-HOLE FAMILIES (brake-deep-hole-v1) — destructive cmd families the brake was blind to ══════
  // All OR-added, fail-CLOSED-when-active, observe/shadow today (no block). Each tested both-ways (the
  // real command escalates; the same word in a comment/prose/filename does NOT — see the staged test).
  //
  // R1 — disk / partition / filesystem destruction (no git-restore can undo). New category `destroy-infra`
  //   (shared with R5). VERIFIER FIX (INDEPENDENT verify, 2026-06-21): the bare-binary names (mkfs/wipefs/
  //   parted/...) are also plausible FILENAMES/doc-mentions in a software repo (`cat docs/wipefs.md`,
  //   `ls scripts/parted-helper.sh`, `# mkfs.ext4 would wipe it`). The first draft tested them as bare
  //   `\bword\b` on plain `scan`, which FALSE-escalated those. FIX: route the bare-binary verbs through the
  //   SAME CMD_START + scanNoComments anchoring as R2/R3/R5 (atCmd) — they only fire in COMMAND POSITION,
  //   not as an argument/filename/comment mention. The two already-shape-specific forms keep testing `scan`
  //   directly because their shape (`of=/dev/<disk>`, `format <drive>:`) cannot occur as a benign filename
  //   and `dd` may carry args before `of=` (so the simple command-start prefix would miss it).
  if (isShell && (
      atCmd(String.raw`(?:mkfs(?:\.\w+)?|mke2fs|mkswap|fdisk|parted|sgdisk|sfdisk|wipefs|blkdiscard|diskpart|Format-Volume|Clear-Disk|Initialize-Disk|bcdedit)\b`) ||
      atCmd(String.raw`badblocks\s+-w\b`) ||
      /\bdd\b[^\n]*\bof=\/dev\/(?:sd|nvme|vd|hd|mmcblk|disk)/i.test(scan) ||
      /\bformat\s+[a-zA-Z]:/i.test(scan)))
    return ['destroy-infra', subj(cmd)];

  // R2 + R3 — stop/disable a service OR tear down the firewall (machine left without net/security; out-of-band,
  //   not git-reversible). Common-word verbs (`stop`/`disable`/`net`/`service`) ⇒ anchored to CMD_START over
  //   scanNoComments so a `# stop the service` comment / "disable the cache" prose / `net-stop.log` filename
  //   does NOT fire. New category `service-disrupt`.
  if (isShell && (
      // R2 service stop/disable/mask
      atCmd(String.raw`systemctl\s+(?:--user\s+)?(?:stop|disable|mask)\b`) ||
      atCmd(String.raw`service\s+\S+\s+stop\b`) ||
      atCmd(String.raw`(?:Stop-Service|Set-Service\b[^\n]*-StartupType\s+Disabled|Suspend-Service)\b`) ||
      atCmd(String.raw`sc(?:\.exe)?\s+(?:stop|delete|config\b[^\n]*start=\s*disabled)\b`) ||
      atCmd(String.raw`net\s+stop\b`) ||
      atCmd(String.raw`launchctl\s+(?:unload|bootout|disable)\b`) ||
      // R3 firewall flush/disable
      atCmd(String.raw`ufw\s+(?:disable|reset)\b`) ||
      atCmd(String.raw`firewall-cmd\b[^\n]*--(?:remove|reload-and-flush)\b`) ||
      atCmd(String.raw`iptables\s+(?:-F\b|-X\b|-P\s+\w+\s+ACCEPT\b|--flush\b)`) ||
      atCmd(String.raw`ip6tables\s+(?:-F|-X|--flush)\b`) ||
      atCmd(String.raw`nft\s+flush\s+ruleset\b`) ||
      atCmd(String.raw`netsh\s+advfirewall\s+set\s+\w+\s+state\s+off\b`) ||
      atCmd(String.raw`Set-NetFirewallProfile\b[^\n]*-Enabled\s+False\b`) ||
      atCmd(String.raw`Disable-NetFirewallRule\b`) ||
      atCmd(String.raw`pfctl\s+-d\b`)))
    return ['service-disrupt', subj(cmd)];

  // R4 — SSRF / cloud-instance-metadata (IMDS) egress (exfiltrate instance credentials). Fires by HOST, not
  //   by the `curl` verb (covers python/node/etc.), incl. the decimal/hex-IP evasion. Reuses `external-send`.
  //   NOTE: `169.254.` is in isOutwardSend's isLocal exclusion (the false "tool-layer SSRF" the lying
  //   comments at lines 343-344/377 promised), so this independent host check is REQUIRED. Tested on `scan`.
  const IMDS_HOST = /\b(?:169\.254\.169\.254|metadata\.google\.internal|fd00:ec2::254|100\.100\.100\.200)\b|\[fd00:ec2::254\]/i;
  const IMDS_DECIMAL = /(?:https?:\/\/|@|\/\/)\s*0*2852039166\b|\b0x[Aa]9[Ff][Ee][Aa]9[Ff][Ee]\b|\bhttps?:\/\/0251\.0376\.0251\.0376\b/;
  const NET_CTX_ANY = /\b(?:curl|wget|http|https|xh|httpie|aria2c|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|nc|ncat|socat|python3?|node|ruby|perl|php|go\s+run|java|requests\.|urllib|fetch\(|http\.get|net\/http|HttpClient|axios|got\()\b/i;
  if (isShell && (
        (IMDS_HOST.test(scan) && (NET_CTX_ANY.test(scan) || /https?:\/\//i.test(scan))) ||
        IMDS_DECIMAL.test(scan)))
    return ['external-send', subj(cmd)];

  // R5 — shutdown/reboot the machine, wipe the task schedule, make a file immutable, destroy infra. (i)
  //   common-word verbs (`shutdown`/`reboot`/`poweroff`/`halt`) anchored to CMD_START over scanNoComments;
  //   (ii) `crontab -r` (silent, irreversible); (iii) `chattr +i`/`chflags uchg` (freeze — self-lock risk);
  //   (iv) swapoff / dd-to-virtual-disk / LVM removal / aws ec2 terminate (specific binaries, FP≈nil).
  //   New category `destroy-infra` (shared with R1). Families ALREADY covered in `delete` (kubectl delete,
  //   aws s3 rb) are NOT duplicated here.
  if (isShell && (
      atCmd(String.raw`(?:shutdown|reboot|poweroff|halt)\b`) ||
      atCmd(String.raw`systemctl\s+(?:poweroff|reboot|halt|kexec|suspend|hibernate)\b`) ||
      atCmd(String.raw`init\s+0\b`) ||
      atCmd(String.raw`telinit\s+0\b`) ||
      atCmd(String.raw`(?:Stop-Computer|Restart-Computer)\b`) ||
      atCmd(String.raw`swapoff\b`) ||
      atCmd(String.raw`crontab\s+(?:-i\s+)?-r\b`) ||
      atCmd(String.raw`chattr\s+[+]i\b`) ||
      atCmd(String.raw`chflags\s+(?:uchg|schg)\b`) ||
      atCmd(String.raw`dd\b[^\n]*\bof=/dev/(?:loop|dm-|mapper/)`) ||
      atCmd(String.raw`(?:vgremove|lvremove)\b`) ||
      atCmd(String.raw`aws\s+ec2\s+terminate-instances\b`)))
    return ['destroy-infra', subj(cmd)];
  // ══ END A1 DEEP-HOLE FAMILIES ════════════════════════════════════════════════════════════════════════

  // ── IRREVERSIBLE AXIS, fail-SAFE ALLOWLIST ────────────────────────────────────────────────────────
  // axis member 1: fs-destructive. The DB-destructive / remote-delete / git-history-rewrite forms have NO
  // in-tree-tracked allowlist (they are not git-reversible by a file restore) → ALWAYS escalate.
  if (isShell && (dbDestructive ||
      /git\s+clean\b|git\s+reset\s+--hard\b|\bdd\b[^\n]*\bof=\/dev\/|\baws\s+s3\s+rb\b|\bgcloud\b[^\n]*\bdelete\b|\bdropdb\b|\bkubectl\s+delete\b|\bhelm\s+uninstall\b|\btruncate\s+-s\b|\bfind\b[^\n]*(?:-delete\b|-exec\s+rm\b|-execdir\s+rm\b)|\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i.test(scan) ||
      // finding #4 — missed irreversible infra/data families:
      /\b(?:terraform|pulumi)\s+destroy\b|\b(?:flyctl|fly)\s+apps?\s+destroy\b|\bheroku\s+apps:destroy\b|\bdocker\s+system\s+prune\b[^\n]*--volumes\b|\bredis-cli\b[^\n]*\bFLUSH(?:ALL|DB)\b|\bgit\s+branch\s+-D\b|\bgit\s+update-ref\s+-d\b/i.test(scan) ||
      // finding #2 — PowerShell-native destructive verbs (Remove-Item -Recurse/-Force, rd, del):
      /\bRemove-Item\b[^\n]*(?:-Recurse|-Force)|\bRemove-Item\b|\brd\b|\bdel\b/i.test(scan)))
    return ['delete', subj(cmd)];
  // axis member 1+2: a destructive fs VERB (rm/rmdir/mv/cp/ln/dd/tee/shred) OR a write-redirect (>, >>).
  // ALLOWLIST: ALLOW (return null) ONLY if EVERY extracted target is provably in-tree-tracked; otherwise
  // ESCALATE. Zero extractable targets ⇒ opaque ⇒ escalate (fail-safe). This is the inversion.
  if (isShell) {
    const fs0 = extractFsTargets(scan);
    if (fs0) {
      // FP-FIX (brake-newfile-v1): ALLOW (return null) when EVERY extracted target is provably
      // REVERSIBLE-TO-AFFECT — i.e. in-tree AND (git-tracked OR not-yet-existing). This ALLOWS the common
      // reversible ops the original wrongly escalated: creating/renaming/copying/redirecting/tee-ing INTO a
      // NEW in-tree path (deletable ⇒ reversible), and overwriting a tracked file (git-restorable). It still
      // ESCALATES the dangerous shapes: a target out of the repo tree, an EXISTING-but-UNTRACKED path
      // (un-restorable data loss — the pinned recall case `rm <existing untracked file>`), an unresolvable /
      // $VAR / glob / `..` target, or zero extractable targets (opaque). Zero targets ⇒ escalate (fail-safe).
      const reversible = fs0.targets.length > 0 && fs0.targets.every((t) => isReversibleToAffect(t));
      if (!reversible) return [fs0.verb === 'redirect' ? 'out-of-tree-write' : 'delete', subj(cmd)];
      // provably reversible in-tree fs work (incl. new-file creation) → fall through (no would_ask on this axis).
    }
  }
  // axis member 4: SPEND (billable). Checked before outward-send so a paid-API call is labelled spend.
  if (isShell && isSpend(scan))
    return ['spend', subj(cmd)];
  // axis member 3: outward-send / outward-push (irreversible egress to a shared destination).
  if (isShell && /\bgit\s+push\b|\bgit\s+[^\n]*--force\b|\bnpm\s+publish\b|\b(yarn|pnpm)\s+publish\b|\bgh\s+release\b|\bgh\s+pr\s+merge\b|\bkubectl\s+apply\b|\bterraform\s+apply\b|\bdocker\s+push\b|\bfly\s+deploy\b|\bvercel\b[^\n]*--prod\b|\bwrangler\s+publish\b/i.test(scan))
    return ['outward-push', subj(cmd)];
  if (/__(send|post|create_event|update_event|delete_event|create_draft|create_file|copy_file|upload)/i.test(tool) || /\bsend\b/i.test(tool))
    return ['external-send', tool];
  // inline-exec sends (node -e / python -c …) run their quoted body, so execText() blanks them — check the
  // RAW command for an inline interpreter whose code makes a network call (a real executing send, not a
  // mere mention). Anchored to the interpreter + inline-flag so a quoted MENTION elsewhere won't fire.
  // DA-1c FN-fix (2026-06-07, the 2 known FN gaps from VERIFY-build §3):
  //   (a) ALIASED / require'd HTTP clients — `const a=require('axios'); a.post(url)` has no literal
  //       `axios.post` token, so we broaden to ANY `.post(`/`.put(`/`.patch(`/`.request(`/`.upload(` method
  //       call (any receiver, incl. an alias) OR any `fetch(` OR a require/import of a known HTTP module.
  //   (b) `bun -e`/`bun -p`/`deno eval`/`deno -e` (mainstream JS runtimes with inline eval) were absent from
  //       the interpreter list → their inline network sends silently passed. Added below.
  // FAIL-SAFE: a network-send shape inside any inline-interpreter body ESCALATES. The `.del/.send` verbs are
  // intentionally EXCLUDED (too ambiguous with local `Map.delete`/`res.send`) — the listed send verbs +
  // fetch + a required HTTP module are the proven-outward signals. The SEND classifier reads the RAW cmd,
  // so the (scan-side) interpreter-body blanking added for the FP-fix does not affect this branch.
  const inlineExecSend = isShell && inlineInterpNetworkSend(cmd);
  if (isShell && (isOutwardSend(scan) || getExfilRaw(cmd) || inlineExecSend || /\bcurl\b[^\n]*(-X\s*(POST|PUT|DELETE)|--data\b|--data-[\w]+\b|\s-d\s)/i.test(scan)))
    return ['external-send', subj(cmd)];
  // axis member 5: immutable-core write (constitution / settings / allowlist / reversibility-markers / hooks).
  // KEYSTONE FIX #1 (dec-46 self-protection leak #1): this Write/Edit/NotebookEdit regex OMITTED
  // `.claude/hooks/`, so an Edit/Write tool aimed DIRECTLY at the guard's own code
  // (`.claude/hooks/reversibility-guard.mjs`) returned null = ALLOWED — the single highest-value
  // self-disable vector. The SHELL path already special-cases `.claude/hooks/` via CORE_PATH; this brings the
  // tool-write path to parity by adding the `.claude/hooks/` alternation. Strengthen-only (an added
  // alternation: it can ONLY add escalations on core-hook writes, never remove any existing one).
  // KEYSTONE ITER-4 (companion): bound `allowlist` here too (same FP class) — a tool fpath of an actual
  // `allowlist.json` (bare or under a dir) is still caught via `[\\/]allowlist|(^|[\s\\/])allowlist\.\w`, but
  // the bare English word can no longer match. (`constitution/`, `settings.json$`, `reversibility-markers/`,
  // `.claude/hooks/` were already bounded.) STRENGTHEN-ONLY: removes only false-word matches.
  // KEYSTONE ITER-5 (companion to the CORE_PATH boundary fix above): apply the SAME `\b`→`(^|[\s\\/])`
  // anchoring to the dot+ext allowlist alternative here, so a tool fpath like `report-allowlist.md` /
  // `user-allowlist.csv` no longer FALSE-POSITIVEs as immutable-core-write. The path-separator form
  // (`[\\/]allowlist`) is kept as-is; a real `allowlist.json` (bare via `^`, or under a dir via the
  // separator) is still caught. Removes only false `<word>-allowlist.<ext>` matches; nothing else changed.
  if ((tool === 'Write' || tool === 'Edit' || tool === 'NotebookEdit') && /(^|[\\/])constitution[\\/]|[\\/]settings(\.local)?\.json$|[\\/]allowlist|(^|[\s\\/])allowlist\.\w|reversibility-markers[\\/]|(^|[\\/])\.claude[\\/]hooks[\\/]/i.test(fpath))
    return ['immutable-core-write', fpath.slice(-100)];
  // Reversible in-tree work (incl. ordinary Write/Edit to non-core files) → ALLOW, no would_ask.
  return [null, null];
}

// friction_flag (PLAN WBS 5) — "would this would_ask have bitten an IN-TREE op?". The operator's friction
// concern is the guard escalating ordinary in-tree work. This is true when an fs-axis escalation
// fired AND ≥1 extracted target resolves UNDER the repo root (in-tree but not provably tracked — e.g. an
// untracked build artifact, a `cd /tmp && rm` whose token still resolves in-root) i.e. exactly the cases
// MEASURE must count against the future false-ask bar. Outward/spend/out-of-root escalations are NOT
// friction (the human accepts an ask there). Pure + mechanical; logged in observe mode only.
function frictionFlag(arg) {
  try {
    const inp = (arg && typeof arg === 'object') ? arg : input;
    if ((inp.tool_name || '') !== 'Bash') return false;
    const scan = execText(String((inp.tool_input && inp.tool_input.command) || ''));
    const fs0 = extractFsTargets(scan);
    if (!fs0) return false;
    const [category] = classify(inp);
    if (category !== 'delete' && category !== 'out-of-tree-write') return false; // only an fs-axis ask
    if (!REPO_ROOT) return false;
    const rootWithSep = REPO_ROOT.endsWith(path.sep) ? REPO_ROOT : REPO_ROOT + path.sep;
    return fs0.targets.some((t) => {
      if (!isStaticallyResolvable(t)) return false;        // unresolvable ⇒ not provably in-tree ⇒ not "friction"
      const abs = path.resolve(REPO_ROOT, t);
      return abs === REPO_ROOT || abs.startsWith(rootWithSep); // resolves inside the repo = in-tree ask
    });
  } catch { return false; }
}

// ── deriveActionId — a deterministic, mechanical id for ONE dangerous action (slice 1b-ii) ──
// Pure: SHA-256 over a STABLE string of the exact fields classify() already reads
// ({tool_name, the command||file_path||path, category}) → first 12 hex chars. NO judgment, NO fetch,
// NO clock/random. Same action → same id; different hard-list actions → different ids. In OBSERVE
// mode it is logged so 1c/1d can round-trip a marker back to the Main-transcript logged dispatch.
function deriveActionId(arg) {
  const inp = (arg && typeof arg === 'object') ? arg : input;
  const tool = inp.tool_name || '';
  const ti = (inp.tool_input && typeof inp.tool_input === 'object') ? inp.tool_input : {};
  // Same precedence the classifier uses for the scanned subject: command first, then file_path/path.
  const subject = String(ti.command || ti.file_path || ti.path || '');
  const [category] = classify(inp);
  // JSON.stringify of a fixed-order tuple = a stable canonical string (no key-order ambiguity).
  const canonical = JSON.stringify([tool, subject, category]);
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

// ── DORMANT (slice 1b-ii): built + exported, but NEVER called on the runtime/main() path. ────────
// These activate only in 1d (gated on 1c). While OBSERVE_ONLY===true the guard NEVER reaches them.

// crossCheckMarker — the marker↔logged-dispatch anti-forgery cross-check (fail-CLOSED).
// The in-repo action-id MARKER is ATTACKER-controllable; the TRUTH is the Main-transcript logged
// dispatch. A marker clears ONLY when its action_id matches a logged dispatch that actually exists
// AND backs it AND the recorded ensemble verdict is exactly "safe". Any mismatch / missing logged
// dispatch / non-"safe" verdict ⇒ NOT cleared. The marker alone is never trusted.
function crossCheckMarker(marker, loggedDispatch) {
  const m = (marker && typeof marker === 'object') ? marker : {};
  const d = (loggedDispatch && typeof loggedDispatch === 'object') ? loggedDispatch : null;
  if (!d) return { cleared: false, reason: 'no backing logged dispatch (marker alone is never trusted)' };
  if (!m.action_id || !d.action_id) return { cleared: false, reason: 'missing action_id on marker or logged dispatch' };
  if (m.action_id !== d.action_id) return { cleared: false, reason: 'action_id mismatch (marker does not match the logged dispatch)' };
  if (m.ensemble_verdict !== 'safe') return { cleared: false, reason: `ensemble_verdict is not "safe" (got ${JSON.stringify(m.ensemble_verdict)}) — fail-CLOSED` };
  return { cleared: true, reason: 'action_id matches a backing logged dispatch and ensemble_verdict === "safe"' };
}

// denyWithDispatchReason — the block-until-dispatched deny SHAPE, as a VALUE only.
// Returns the PreToolUse deny-decision object naming the dispatch the orchestrator must run.
// It is NEVER printed by main() directly (main() calls deny() with its own reason); this value-builder is
// kept for the protocol's documented deny SHAPE. Repointed 'ask'→'deny' (revbrake-silent-v1) so the
// dormant shape matches the active-mode emitter.
function denyWithDispatchReason(actionId, category) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `CA-11 reversibility guard: this is a "${category}" hard-list action. Before it runs, ` +
        `dispatch the reversibility-reviewer for action_id=${actionId} (the blinded re-review ensemble); ` +
        `proceed only on an ensemble "safe" verdict whose marker cross-checks against the logged dispatch.`,
    },
  };
}

// ── readBackingDispatch — SAFE STUB (MF-4 DEFERRED) ───────────────────────────────────────────────
// The real non-agent-writable backing store (the Main-transcript logged dispatch the marker must
// cross-check against) is DEFERRED active-flip work (MF-4). Until it exists, this returns null so
// crossCheckMarker() ALWAYS fails-CLOSED ("no backing logged dispatch") and clearance never spuriously
// grants. MUST NEVER throw (MF-1 depends on this being total). Built but conservative-by-construction.
function readBackingDispatch(actionId) {
  void actionId; // (no backing store yet — DEFERRED MF-4)
  return null;
}

// ── checkClearedMarker — read the in-repo marker for actionId and cross-check it (fail-CLOSED) ─────
// Reads ./reversibility-markers/<action_id>.json (relative to THIS hook), parses it, and runs the
// authority cross-check crossCheckMarker(marker, readBackingDispatch(actionId)). With readBackingDispatch
// stubbed to null, .cleared is ALWAYS false (fail-CLOSED) — that is intended until MF-4 lands.
// MF-1 (binding): the ENTIRE body is wrapped in try/catch returning {cleared:false, …} on ANY error, so a
// missing file / parse error / a throwing readBackingDispatch can NEVER crash the hook (the verifier
// reproduced a ReferenceError here — it must not happen).
function checkClearedMarker(actionId) {
  try {
    const markerPath = new URL(`./reversibility-markers/${actionId}.json`, import.meta.url);
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    return crossCheckMarker(marker, readBackingDispatch(actionId));
  } catch {
    return { cleared: false, reason: 'marker/backing read error (fail-CLOSED)' };
  }
}

export { classify, deriveActionId, crossCheckMarker, denyWithDispatchReason,
  readBackingDispatch, checkClearedMarker,
  isProvablyInTreeTracked, isReversibleToAffect, isStaticallyResolvable, extractFsTargets, isSpend, isOutwardSend, frictionFlag,
  inlineInterpNetworkSend, isRedirectToken, execText };

// ── Runtime (only when invoked as the PreToolUse hook script; NOT on import, so tests can import classify) ──
// main() = a thin top-level fail-CLOSED wrapper around runGuardBody(): any UNEXPECTED throw inside the body
// (a classifier/extractor bug, an fs surprise) is caught here so it can NEVER fail-OPEN-by-crash. ACTIVE →
// deny(); deny-shadow/observe → allow()+log (blocks nothing, never crashes — MF, AC-5). The body's normal
// terminals (allow/ask/deny) call process.exit(0), so this catch only runs on a genuine unexpected error.
function main() {
  try {
    runGuardBody();
  } catch (err) {
    const base = { ts: new Date().toISOString(), event: 'PreToolUse', hook: 'reversibility-guard',
      ...(process.env.REVGUARD_TEST === '1' ? { test: true } : {}) };
    const why = `Reversibility guard hit an unexpected internal error (${err && err.message ? err.message : 'unknown'}).`;
    if (BRAKE_MODE === 'active') deny(`${why} Failing closed (deny) per CA-11.`, { ...base, reason: 'internal_error' });
    if (BRAKE_MODE === 'deny-shadow')
      allow({ ...base, decision: 'allow', mode: 'deny-shadow', verdict: 'ESCALATE', would_deny: true, reason: 'internal_error', error: why });
    allow({ ...base, decision: 'allow', mode: 'observe-only', reason: 'internal_error', error: why }); // observe
  }
}
function runGuardBody() {
  let parseOk = true;
  try {
    const p = JSON.parse(readStdin() || '{}');
    if (p && typeof p === 'object' && !Array.isArray(p)) input = p; else parseOk = false;
  } catch { parseOk = false; }

  const tool = input.tool_name || '';
  // F2 (verify-fix): stamp test:true when invoked by a test harness (env REVGUARD_TEST=1) so self-test
  // firings are filterable from the honest-risk telemetry tally (the log is otherwise polluted by the
  // orchestrator's own dev/test commands — a clean FLIP measurement must exclude them).
  const base = { ts: new Date().toISOString(), event: input.hook_event_name || 'PreToolUse', tool, hook: 'reversibility-guard',
    ...(process.env.REVGUARD_TEST === '1' ? { test: true } : {}) };

  // Fail-CLOSED on a parse failure (MF / AC-5): only ACTIVE blocks. In deny-shadow & observe we ALLOW
  // (blocks nothing) and LOG would_deny so the unparseable-call surface is still measured. NEVER crash.
  if (!parseOk) {
    if (BRAKE_MODE === 'active')
      deny('Reversibility guard could not parse the tool call; failing closed (deny) per CA-11.', { ...base, reason: 'unparseable_stdin' });
    if (BRAKE_MODE === 'deny-shadow')
      allow({ ...base, decision: 'allow', mode: 'deny-shadow', verdict: 'ESCALATE', would_deny: true, reason: 'unparseable_stdin' });
    allow({ ...base, decision: 'allow', mode: 'observe-only', reason: 'unparseable_stdin' }); // observe
  }

  const [category, matched] = classify();
  // Wave-3 COMPLEMENT slice D1 (OBSERVE-ONLY telemetry, never enforcement): assess the honest-but-risky
  // PRECONDITION + RESIDUAL bucket (rule-refinable / runtime-ambiguous / needs-rationale-judgment) the 1c
  // measurement needs. Attached to the log ONLY when flagged (keeps the line lean). On the not-classified
  // path a flagged result is an OUT-OF-CLASS honest-but-risky signal — but the out-of-class tally is a
  // LOWER BOUND (verify-fix F1): whole destructive families (dropdb / sqlite3 / mongo / helm / fly / vercel)
  // are joint blind spots of BOTH classify() AND assessHonestRisk and are NOT counted. The snippet is logged
  // so the firing is traceable (verify-fix F2: out-of-class lines were previously command-less / untraceable).
  const hr = assessHonestRisk(input);
  const hrSubject = String((input.tool_input && (input.tool_input.command || input.tool_input.file_path || input.tool_input.path)) || '').slice(0, 100);
  // DA-1c: verdict is the load-bearing observe-signal — it MUST vary (instrument-fitness (d)(i)): an
  // allowed (reversible-in-tree) call logs verdict:"ALLOW"; an irreversible-axis call logs "ESCALATE".
  // friction_flag tags an ESCALATE that bit an in-tree fs op (the future false-ask bar measures these).
  if (!category) allow({ ...base, decision: 'allow', verdict: 'ALLOW', category: null, would_ask: null, friction_flag: false,
    ...(hr.flagged ? { honest_risk: hr, matched: hrSubject } : {}) });

  const reason = `CA-11 reversibility guard: this is a "${category}" action (${matched}). It is on the never-auto-apply hard-list — confirm before it runs.`;
  // ── STAGED BRAKE branch (revbrake-silent-v1) ──────────────────────────────────────────────────────
  // A hard-list action was matched. The derived id is the deterministic handle for its marker/clearance.
  const actionId = deriveActionId(input);
  if (BRAKE_MODE === 'active') {
    // ACTIVE: a VALID cleared marker (id-match + ensemble "safe" + backing logged dispatch) lets the
    // authorized action proceed; otherwise DENY silently (no human dialog — DR-1). With readBackingDispatch
    // stubbed to null (MF-4 deferred), clr.cleared is ALWAYS false → active conservatively DENIES every
    // hard-list action (the intended fail-CLOSED behaviour; the real clearance lane is deferred).
    const clr = checkClearedMarker(actionId);
    if (clr.cleared)
      allow({ ...base, decision: 'allow', verdict: 'CLEARED', category, action_id: actionId, cleared_reason: clr.reason });
    deny(reason, { ...base, category, matched, action_id: actionId });
  }
  if (BRAKE_MODE === 'deny-shadow') {
    // DENY-SHADOW (SHIPPED): ALLOWS (exit 0, blocks NOTHING); only LOGS what active WOULD do — would_deny
    // + would_clear — so the deny FP surface is measured on real calls BEFORE any active flip. The
    // checkClearedMarker probe is itself wrapped (MF-1) so a throwing backing read can never crash shadow.
    let wc = false;
    try { wc = checkClearedMarker(actionId).cleared; } catch { /* MF-1: never crash in shadow */ }
    allow({ ...base, decision: 'allow', mode: 'deny-shadow', verdict: 'ESCALATE',
      would_deny: true, would_clear: wc, action_id: actionId, matched, friction_flag: frictionFlag(input),
      ...(hr.flagged ? { honest_risk: hr } : {}) });
  }
  // OBSERVE (BRAKE_MODE==='observe'): fall through to the EXISTING observe-only terminal (UNCHANGED, AC-6).
  // Still ALLOW (exit 0); only ENRICH the audit log with what the guard WOULD do once active (1d) —
  // verdict + would_ask + friction_flag (DA-1c) plus would_block + would_dispatch_rereview + the derived
  // action_id that 1c/1d round-trips, plus the D1 honest-risk precondition/residual (telemetry only).
  if (OBSERVE_ONLY) allow({ ...base, decision: 'allow', mode: 'observe-only', verdict: 'ESCALATE',
    would_ask: category, matched, friction_flag: frictionFlag(input),
    would_block: true, would_dispatch_rereview: true, action_id: deriveActionId(input),
    ...(hr.flagged ? { honest_risk: hr } : {}) });
  ask(reason, { ...base, category, matched });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
