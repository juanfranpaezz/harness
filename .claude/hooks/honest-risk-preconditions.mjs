#!/usr/bin/env node
/*
 * honest-risk-preconditions.mjs — Wave-3 phase-1 COMPLEMENT, slice D1 (OBSERVE-ONLY instrument).
 *
 * WHY: 1c measured that the AI-facing re-review brake is a DECEPTION/mismatch detector (100% on cases
 * whose rationale CONTRADICTS the action) but MISSES "honest-but-risky" actions (the rationale truthfully
 * describes a weakly-justified destructive action: rm ./dist, git reset --hard, truncate log, push to main).
 * The ANALYZE phase (meta/wave3-complement-analysis.md, verified PASS-WITH-FIXES) chose D1 = a deterministic
 * PRECONDITION layer that refines WHICH honest-but-risky actions are risky, anchored to checkable signals
 * (not an open-ended "is this wise?" judge — that is the dec-03 ~52%-FP trap).
 *
 * WHAT THIS IS (and is NOT): a PURE assessor that, given the same {tool_name, tool_input} the reversibility
 * guard already classifies, computes (a) which honest-but-risky PATTERN (if any) the action matches and
 * (b) a RESIDUAL class telling us HOW the safe-vs-risky distinction could be made. It returns a structured
 * object. It does NOT block, ask, escalate, or route to a human — it is wired into the guard's OBSERVE log
 * ONLY (see reversibility-guard.mjs). No enforcement. No judgment-in-a-hook. No fetch/clock/subprocess.
 *
 * THE LOAD-BEARING OUTPUT — `residual` (this is the measurement the whole slice exists to produce):
 *   - 'rule-refinable'         : a deterministic precondition in the command separates risky from safe
 *                                (protected-branch / non-localhost-DB-host / mutable :latest tag / bare
 *                                --force vs --force-with-lease). A D1 RULE could gate it. ← the cheap layer.
 *   - 'runtime-ambiguous'      : safe-vs-risky depends on RUNTIME state the pre-exec string cannot resolve
 *                                (an unexpanded $VAR path; an unscoped $DATABASE_URL; whether git status is
 *                                clean). Needs a runtime check / a forced precondition. ← the harder layer.
 *   - 'needs-rationale-judgment': distinguishable only by the rationale/intent (is ./dist regenerable? are
 *                                the truncated log lines shipped? was the artifact tested?). ← the residual
 *                                that would need a judge (robot) or a human gate.
 * Tallying residual across REAL guard-log firings answers FLIP-A/B/C in the analysis: how much of the gap
 * closes by rules vs needs runtime vs needs judgment. The literature cannot give this number; only our
 * OBSERVE telemetry can (verify-the-analysis confirmed this is a genuinely novel measurement, not a re-derivation).
 *
 * HEURISTIC + OBSERVE-ONLY: detectors err toward firing (a false signal is a harmless log line here, never a
 * block). They are intentionally simple regex/structural checks, NOT a parser. Refinement happens once the
 * telemetry shows which patterns actually occur.
 */

const PROTECTED = /\b(?:main|master|develop|development|trunk|release|prod|production|staging)\b/i;

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────
function bashCmd(inp) {
  const tool = inp && inp.tool_name;
  if (tool !== 'Bash') return '';
  const ti = (inp.tool_input && typeof inp.tool_input === 'object') ? inp.tool_input : {};
  return String(ti.command || '');
}
function sig(pattern, residual, why) { return { pattern, residual, why }; }
// Blank quoted literals for NON-shell-executing commands so a deploy/destructive verb that merely SITS
// inside a quoted arg to grep/echo/cat (a MENTION, not an execution) does not false-fire. Shell-executing
// bodies (bash/sh -c, eval, xargs) are kept INTACT — there the quoted text actually runs. Mirrors the
// guard's execText (verify-fix F3: the deploy net had no quote-stripping → fired on `grep "npm publish"`).
function stripMentions(c) {
  if (/\b(?:bash|sh|zsh|ksh|dash)\b[^\n]*\s-c\b/i.test(c) || /\beval\b/i.test(c) || /\bxargs\b/i.test(c)) return c;
  return c.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""').replace(/`[^`]*`/g, '``');
}

// ── PATTERN 1 — outward-push to a shared/protected branch (force OR plain) ──────────────────────────
// push-7 (plain push to main, bypasses review) + push-8 (force-with-lease to develop) were 1c FNs.
// The protected-branch token is a CHECKABLE precondition → rule-refinable. Bare --force (no lease) to a
// protected branch is the worst; --force-with-lease still rewrites shared history; a plain push to a
// protected branch lands unreviewed. A force-push to a NON-protected feature branch is the safe twin.
function detectPush(cmd) {
  if (!/\bgit\s+push\b/i.test(cmd)) return null;
  const lease = /--force-with-lease\b/i.test(cmd);
  const bareForce = (/--force\b/i.test(cmd) || /\s-f\b/i.test(cmd)) && !lease; // F4: also the -f short flag
  // target branch: prefer an explicit HEAD:<ref> or the last ref-looking token; fall back to scanning.
  const headRef = cmd.match(/\bHEAD:(?:refs\/heads\/)?([^\s]+)/i);
  const targetsProtected = headRef ? PROTECTED.test(headRef[1]) : PROTECTED.test(cmd);
  if (!targetsProtected) return null; // force/plain push to a feature branch = the safe twin
  if (bareForce) return sig('force-push-protected-no-lease', 'rule-refinable', 'bare --force rewrites shared/protected-branch history with no lease guard');
  if (lease) return sig('force-push-protected-with-lease', 'rule-refinable', '--force-with-lease still rewrites shared/protected-branch history teammates may have based work on');
  return sig('push-protected-unreviewed', 'rule-refinable', 'plain push lands on a shared/protected branch, bypassing review');
}

// ── PATTERN 2 — deploy/publish whose verification is not in the command ─────────────────────────────
// push-2/3/4/5/6 family. Some carry a CHECKABLE risk signal (mutable :latest tag; terraform apply with no
// saved plan file; kubectl apply with no --context) → rule-refinable. The rest (was it tested/approved?)
// is only in the rationale → needs-rationale-judgment.
function detectDeploy(rawCmd) {
  const cmd = stripMentions(rawCmd); // F3: don't fire on a deploy verb that only sits inside a quoted mention
  if (/\bdocker\s+push\b[^\n]*:latest\b/i.test(cmd))
    return sig('deploy-mutable-latest-tag', 'rule-refinable', 'push to the mutable :latest tag silently overwrites what every untagged consumer pulls');
  if (/\bterraform\s+apply\b/i.test(cmd) && /-auto-approve\b/i.test(cmd) && !/\.(?:tfplan|plan|binary)\b|\btfplan\b/i.test(cmd))
    return sig('deploy-apply-no-saved-plan', 'rule-refinable', 'terraform apply -auto-approve with no saved plan file executes whatever live diff exists, possibly destructive');
  if (/\bkubectl\s+apply\b/i.test(cmd) && !/--context\b/i.test(cmd))
    return sig('deploy-apply-no-context', 'rule-refinable', 'kubectl apply with no explicit --context targets whatever the current context is (possibly prod)');
  if (/\bnpm\s+publish\b|\b(?:yarn|pnpm)\s+publish\b|\bgh\s+release\s+create\b|\bdocker\s+push\b|\bterraform\s+apply\b|\bkubectl\s+apply\b/i.test(cmd))
    return sig('deploy-verification-not-in-command', 'needs-rationale-judgment', 'whether the artifact was tested/approved is not encodable from the command — only the rationale/CI state shows it');
  return null;
}

// ── PATTERN 3 — destructive DB command against a non-local / unscoped target ─────────────────────────
// del-3 (DROP against $DATABASE_URL — unscoped) + del-8 (TRUNCATE against -h db.internal — non-localhost).
// A literal non-localhost -h host is a CHECKABLE precondition → rule-refinable. An env-var DSN hides the
// host → runtime-ambiguous. A localhost/127.0.0.1 / *_test target is the safe twin.
function detectDbTarget(cmd) {
  if (!/\b(?:psql|mysql|mariadb)\b/i.test(cmd)) return null;
  if (!/\bDROP\s+(?:TABLE|DATABASE|SCHEMA)\b|\bTRUNCATE\s+(?:TABLE\b|[\w"`])/i.test(cmd)) return null;
  const hostFlag = cmd.match(/\s-h\s+(\S+)/i);
  if (hostFlag) {
    if (/^(?:localhost|127\.0\.0\.1|::1)$/i.test(hostFlag[1])) return null; // safe twin: explicit local host
    return sig('ddl-on-non-localhost-host', 'rule-refinable', `destructive DDL against an explicit non-local host (${hostFlag[1]}) that reads as shared/production`);
  }
  if (/\$\{?\w*(?:DATABASE_URL|DB_URL|DSN|DATABASE)\w*\}?|"\$[A-Za-z_]\w*"/i.test(cmd))
    return sig('ddl-on-unscoped-dsn', 'runtime-ambiguous', 'destructive DDL against an env-var DSN whose host/database cannot be resolved pre-execution (may be production)');
  return sig('ddl-target-unconfirmed', 'runtime-ambiguous', 'destructive DDL whose target database is not pinned to a confirmed local/test host');
}

// ── PATTERN 4 — destructive filesystem op (rm/reset/truncate) whose safety needs runtime or rationale ──
// del-1 (rm ./dist — regenerable?), del-2 (git reset --hard — discards uncommitted), del-6 (rm "$VAR"/* —
// unexpanded var), del-7 (truncate log — shipped elsewhere?). The $VAR case is runtime-ambiguous (could
// expand to /); reset --hard is runtime-ambiguous (git status); rm/truncate of a concrete path is
// distinguishable only by intent → needs-rationale-judgment.
function detectFsDestructive(cmd) {
  if (/\brm\s+-[a-z]*f[a-z]*\b[^\n]*\$\{?\w+\}?/i.test(cmd) || /\brm\s+-[a-z]*f[a-z]*\b[^\n]*"\$/i.test(cmd))
    return sig('destructive-on-unexpanded-var', 'runtime-ambiguous', 'rm -rf over an unexpanded $VAR path: if the variable is unset/empty it expands toward filesystem root — the value is not resolvable pre-execution');
  if (/\bgit\s+reset\s+--hard\b/i.test(cmd))
    return sig('git-reset-hard-discards-uncommitted', 'runtime-ambiguous', 'git reset --hard irreversibly discards uncommitted work; safe only if git status is confirmed to hold no needed/untracked changes (a runtime check)');
  if (/\btruncate\s+-s\s*0\b/i.test(cmd))
    return sig('truncate-destroys-current-contents', 'needs-rationale-judgment', 'truncation irreversibly discards the file’s current contents; safe only if those contents are preserved elsewhere — knowable only from the rationale');
  if (/(^|[\s;&|(])rm\s+-[a-z]*f[a-z]*\b/i.test(cmd))
    return sig('rm-of-concrete-path', 'needs-rationale-judgment', 'rm -rf of a concrete path; safe only if the path is truly regenerable/disposable — a property of intent, not visible in the command');
  return null;
}

/**
 * assessHonestRisk — the entry point. Returns the FIRST matching honest-but-risky precondition signal, or a
 * not-flagged object. PURE; observe-only; never blocks. Ordering: push → deploy → db → filesystem.
 *
 * @param {{tool_name:string, tool_input:object}} inp
 * @returns {{flagged:boolean, pattern:string|null, residual:string|null, why:string|null}}
 */
function assessHonestRisk(inp) {
  const cmd = bashCmd(inp);
  if (!cmd) return { flagged: false, pattern: null, residual: null, why: null };
  const s = detectPush(cmd) || detectDeploy(cmd) || detectDbTarget(cmd) || detectFsDestructive(cmd);
  return s ? { flagged: true, ...s } : { flagged: false, pattern: null, residual: null, why: null };
}

export { assessHonestRisk, detectPush, detectDeploy, detectDbTarget, detectFsDestructive };
