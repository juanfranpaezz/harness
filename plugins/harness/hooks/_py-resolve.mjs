// Resolve a working Python interpreter once, cache it, and expose it to hooks.
// WHY THIS EXISTS: four coherence hooks hardcoded execFileSync('py', ...). `py` is the Windows
// Python Launcher and does not exist on Linux, so every one of them dies silently in an unattended
// cloud run - measured as a live portability defect on 2026-08-29.
import { spawnSync } from 'node:child_process';
let cached = null;
// PROBE BUDGET (TOTAL, all candidates): a candidate whose `--version` never returns would
// otherwise hang the whole Stop hook with no internal escape. Arithmetic: probe budget
// 2000 + PY_TIMEOUT_MS 12000 = 14000 < the 15 s runtime budget in settings.json, so the
// probe can never eat the linter's budget. A hanging FIRST candidate therefore leaves the
// later ones ~0 ms and pyBin() returns null = the existing fail-open branch (logged row),
// which is the designed degradation, never a hang.
const PY_PROBE_BUDGET_MS = 2000;
export function pyBin() {
  if (cached) return cached;
  const deadline = Date.now() + PY_PROBE_BUDGET_MS;
  for (const bin of ['py', 'python3', 'python']) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    const r = spawnSync(bin, ['--version'], { stdio: 'ignore', timeout: left });
    if (r.status === 0 && !r.error) { cached = bin; return cached; }
  }
  cached = null;   // fail-open: the caller must treat null as "skip", never as "block"
  return cached;
}
// INVARIANT: PY_TIMEOUT_MS < the hook's `timeout` in .claude/settings.json (SECONDS).
// The four consumers (ref-lint-gate, ceo-model-coherence, decision-coherence, memory-coherence)
// are each granted 15 s there. The internal timeout MUST stay strictly under that budget, because
// only an internal ETIMEDOUT is catchable: the hook catches it and still writes its fail-open log
// row. If the runtime budget expires first the process is killed outright and NOTHING is logged -
// a logged failure silently becomes an invisible one. 30000 broke this (2x the budget); 12000 is
// the pre-migration value and leaves ~3 s of headroom. Raising this REQUIRES first raising the
// settings.json timeout, which is brake-adjacent and CEO-gated.
export const PY_TIMEOUT_MS = 12000;
