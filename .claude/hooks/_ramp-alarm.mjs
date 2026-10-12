/*
 * _ramp-alarm.mjs — shared ENFORCEMENT-RAMP alarm helper for the 3 oracle-backed Stop hooks
 * (ref-lint-gate, ceo-model-coherence, decision-coherence). Wave-3 phase-1 slice 0.
 *
 * PURPOSE (observe-only, NON-BLOCKING): when a hook's oracle reports drift but the hook is in
 * OBSERVE mode, this makes the existing observe-mode signal LOUDER without ever blocking. It:
 *   1. returns a severity-tagged, greppable `alarm` record to merge into the hook's allow() log line, and
 *   2. writes a one-line, non-blocking notice to stderr.
 * It NEVER writes stdout, NEVER emits {"decision":"block"}, NEVER calls process.exit. The caller still
 * decides allow/(dormant)block — this helper only enriches the OBSERVE branch the caller already takes.
 *
 * Dependencies: node built-ins only (none imported here — pure string/object work). No new dependency.
 *
 * Revert path: delete this file and drop the `ramp` field + the one stderr.write line from each hook's
 * observe branch (the hooks fall back to their prior plain observe log).
 */

// Severity tag for the alarm record. Mechanical-oracle drift is HIGH (it is exactly what would block
// once enforcement is on); kept as a constant so the future PHASE-B gate can branch on it.
export const RAMP_SEVERITY = 'high';

/**
 * Build the structured, greppable alarm record to spread into a hook's observe-mode allow() log line.
 * @param {string} hook   - the hook name (e.g. 'ref-lint-gate')
 * @param {number} count  - how many issues the oracle reported (n_broken / n_drift)
 * @param {string[]} items - the human-readable issue list (already formatted by the caller)
 * @returns {object} a flat record: { alarm:true, ramp_phase, severity, ramp_issue_count, ramp_grep }
 */
export function rampAlarmRecord(hook, count, items) {
  return {
    alarm: true,
    ramp_phase: 'A-observe',                 // PHASE A = alarm-now; PHASE B (block) is a separate future build
    severity: RAMP_SEVERITY,
    ramp_issue_count: count,
    // single greppable token so the whole observe window can be swept: `grep RAMP-ALARM *.log`
    ramp_grep: `RAMP-ALARM:${hook}`,
    ramp_would_block: Array.isArray(items) ? items : [],
  };
}

/**
 * Write the one-line, non-blocking stderr notice. stderr does NOT block the turn (only a stdout
 * {"decision":"block"} blocks); this is purely a louder human/log-visible signal.
 * @param {string} hook
 * @param {number} count
 * @param {(s:string)=>void} [write] - injection seam for tests; defaults to process.stderr.write
 */
export function rampAlarmNotice(hook, count, write) {
  const w = write || ((s) => process.stderr.write(s));
  w(`[RAMP-ALARM ${hook}] ${count} issue(s) would block once enforcement is on (observe phase)\n`);
}
