#!/usr/bin/env node
/*
 * Memory-index coherence gate — Claude Code Stop hook (mirrors decision-coherence.mjs).
 *
 * Principle: CA-07 (recurring drift -> durable automated check) + CA-06 (the durable record must stay
 * coherent). Closes the TP-03 gap (verification-gap-audit 2026-06-07): MEMORY.md — the auto-memory INDEX
 * loaded into EVERY session — was the only steering store with NO coherence linter, while decisions.md and
 * ceo-model.md each have one. A dangling pointer / orphan memory file / malformed frontmatter silently
 * steers every future session. This is the MECHANICAL slice: STRUCTURE drift is caught by an oracle
 * (memory_linter.py), never by judgement. It runs the deterministic linter over the memory dir once per turn.
 *
 * OBSERVE-ONLY BY DESIGN — there is NO block path in this hook (CEO default for this family; the memory
 * store is read-only context, so a blocking gate is not earned this slice). It LOGS drift and always allows.
 *
 * SAFETY contract: this hook NEVER writes MEMORY.md or any memory file. No hook writes the store.
 *
 * Loop safety: stop_hook_active===true -> allow (never trap the agent). Fail-OPEN: a broken/missing linter,
 * an absent store, or any error allows but LOGS why (so a dead robot is visible).
 *
 * MEMORY-DIR DERIVATION: the auto-memory store lives OUTSIDE the repo, beside the session transcript at
 * <projects>/<project>/memory/. We derive it from input.transcript_path (dirname -> /memory). An env
 * override MEMORY_DIR (used by the test) takes precedence. If neither resolves to an existing MEMORY.md,
 * the hook allows silently (fail-open) — it never guesses a path.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pyBin, PY_TIMEOUT_MS } from './_py-resolve.mjs';

const OBSERVE_ONLY = true; // This hook has NO block path; the flag documents the stance + matches the family.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 2026-10-08 (hook-paths fix): tools resolve to the tools/ dir BESIDE this hook's hooks/ dir, so every
// profile runs its OWN copy (~/.claude, ~/.claude-employer, ~/.claude-work, a project's .claude). The old
// <hooks>/../../.claude/tools only matched when the tree is literally named ".claude": from
// ~/.claude-employer/hooks it resolved to the PERSONAL ~/.claude/tools. Same dir as before for ~/.claude
// and for a repo/project .claude.
// (The old repo-root constant, <hooks>/../.., had no other reader and is removed.)
const LINTER = path.join(__dirname, '..', 'tools', 'memory_linter.py'); // <tree>/hooks -> <tree>/tools
// LOG_PATH: beside this hook in prod; MEMORY_COHERENCE_LOG is a TEST-ONLY override (never set in
// production, adds no behavior change) so the test can inspect what was logged without touching the real log.
const LOG_PATH = process.env.MEMORY_COHERENCE_LOG || (process.env.HARNESS_LOG_DIR ? `${process.env.HARNESS_LOG_DIR}/memory-coherence.log` : new URL('./memory-coherence.log', import.meta.url)); // HARNESS_LOG_DIR = plugin data dir (runner-provided)

function logLine(obj) { try { fs.appendFileSync(LOG_PATH, JSON.stringify(obj) + '\n'); } catch { /* never crash on logging */ } }
function readStdin() { try { return fs.readFileSync(0, 'utf8'); } catch { return ''; } }
function allow(extra) { logLine(extra); process.exit(0); }

// Derive the memory dir: env override (test) -> beside the transcript (prod) -> null.
function resolveMemoryDir(transcriptPath) {
  if (process.env.MEMORY_DIR) return process.env.MEMORY_DIR;
  try {
    const p = String(transcriptPath || '');
    if (!p) return null;
    return path.join(path.dirname(p), 'memory');
  } catch { return null; }
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
  hook: 'memory-coherence',
  mode: 'observe-only',
};

// Loop safety: already stopped once this turn -> let it through.
if (base.stop_hook_active) allow({ ...base, decision: 'allow', reason: 'stop_hook_active' });

const memoryDir = resolveMemoryDir(input.transcript_path);
const indexFp = memoryDir ? path.join(memoryDir, 'MEMORY.md') : null;

// No store to guard (path unknown or absent) -> allow silently (fail-open; never guess).
if (!indexFp || !fs.existsSync(indexFp)) allow({ ...base, decision: 'allow', reason: 'store_absent' });

let result;
try {
  const out = execFileSync(pyBin() ?? 'py', [LINTER, memoryDir], { encoding: 'utf8', timeout: PY_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
  result = JSON.parse(out);
} catch (e) {
  // Fail-OPEN: a broken/missing linter must not trap the agent — but LOG it so the dead robot is visible.
  allow({ ...base, decision: 'allow', reason: 'linter_error: ' + ((e && e.message) ? e.message.slice(0, 160) : 'unknown') });
}

const n = (result && result.n_drift) || 0;
if (n === 0) {
  allow({ ...base, decision: 'allow', n_drift: 0, n_files: result.n_files, n_index_rows: result.n_index_rows });
}

const list = (result.drift || []).map((d) => `${d.file || '?'} [${d.kind}] ${d.detail}`);
// OBSERVE-ONLY: log the drift, never block (no block path — the store is read-only context).
allow({ ...base, decision: 'allow', n_drift: n, drift: list, n_files: result.n_files, n_index_rows: result.n_index_rows });
