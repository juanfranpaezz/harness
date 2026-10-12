#!/usr/bin/env node
/*
 * _turn-touch.mjs — Wave-3 phase-1, the TURN-TOUCH derivation (slice-0 PHASE-B precondition).
 *
 * Derives `turn_touched_artifact` (today logged as a literal `null` in the 3 mechanical Stop hooks) from the
 * Stop payload's `transcript_path`. The transient-tolerance gate (slice-0 ramp) needs to know whether THIS
 * turn actually edited the guarded artifact; the Stop event does not enumerate the turn's edits, but the
 * transcript JSONL does (confirmed: tool calls live as `message.content[]` blocks of type "tool_use" with
 * `name` + `input`). OBSERVE-ONLY: this only computes a value the hooks LOG; it arms no block path.
 *
 * Design A (transcript-parse at Stop): walk the transcript tail BACKWARD, collecting Edit/Write/NotebookEdit
 * target paths from assistant `tool_use` blocks, STOPPING at the last GENUINE user prompt (a real text prompt,
 * not an injected tool_result `user` message). Edits seen before that boundary are THIS turn's. Fail-OPEN:
 * any read/parse failure → `touched: null` (the future gate must TOLERATE null — never a false halt on a parse miss).
 * No shared mutable state, no clear-races, transcript = ground truth. node-builtins only.
 */
import fs from 'node:fs';

// A `user` transcript line is either a GENUINE prompt (turn boundary) or an injected tool_result (part of the
// same turn). Genuine = a plain string, OR an array carrying ≥1 text block and ZERO tool_result blocks.
function isGenuineUserPrompt(content) {
  if (typeof content === 'string') return content.trim().length > 0;
  if (Array.isArray(content)) {
    const hasToolResult = content.some((c) => c && c.type === 'tool_result');
    const hasText = content.some((c) => c && c.type === 'text');
    return hasText && !hasToolResult;
  }
  return false;
}

/**
 * turnTouch — did THIS turn (since the last genuine user prompt) edit a path matching matchFn?
 * @param {string} transcriptPath  absolute path to the session transcript JSONL (from the Stop payload).
 * @param {(p:string)=>boolean} matchFn  predicate over an edited file path (the per-hook artifact test).
 * @returns {{touched: boolean|null, paths: string[]}}  touched=null on read/parse failure (fail-open).
 */
function turnTouch(transcriptPath, matchFn) {
  if (!transcriptPath || typeof transcriptPath !== 'string') return { touched: null, paths: [] };
  let text;
  try { text = fs.readFileSync(transcriptPath, 'utf8'); } catch { return { touched: null, paths: [] }; }
  const lines = text.split('\n');
  const paths = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i];
    if (!ln || !ln.trim()) continue;
    let o;
    try { o = JSON.parse(ln); } catch { continue; }
    if (!o || typeof o !== 'object') continue;  // valid-JSON-non-object (e.g. a bare `null` line) -> skip, never crash (fail-open contract)
    const role = o.type || o.role;
    const content = (o.message && o.message.content) || o.content;
    if (role === 'user') {
      if (isGenuineUserPrompt(content)) break;      // turn boundary reached — stop walking
      continue;                                      // tool_result user message — still this turn
    }
    if (role === 'assistant' && Array.isArray(content)) {
      for (const c of content) {
        if (c && c.type === 'tool_use' && /^(?:Edit|Write|NotebookEdit)$/.test(c.name || '')) {
          const fp = (c.input && (c.input.file_path || c.input.path || c.input.notebook_path)) || '';  // NotebookEdit's param is notebook_path (the contract names NotebookEdit)
          if (fp) paths.push(String(fp));
        }
      }
    }
  }
  let touched = false;
  for (const p of paths) { try { if (matchFn(p)) { touched = true; break; } } catch { /* ignore bad match */ } }
  return { touched, paths };
}

// Normalize Windows backslashes so per-hook predicates can match on forward-slash suffixes.
const norm = (p) => String(p).replace(/\\/g, '/');
// The per-hook artifact predicates (exported so the 3 hooks and the test share one definition).
const MATCH = {
  ceoModel: (p) => norm(p).toLowerCase().endsWith('ceo-model/ceo-model.md'),
  decisions: (p) => norm(p).toLowerCase().endsWith('memory/decisions.md') || norm(p).toLowerCase().endsWith('/decisions.md'),
  anyMarkdown: (p) => /\.md$/i.test(norm(p)),
};

export { turnTouch, isGenuineUserPrompt, MATCH };
