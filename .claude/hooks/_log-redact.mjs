/*
 * _log-redact.mjs - the ONE shared redactor for hook log rows (added 2026-10-08, fixes-f; verifier F2/F2b, actions
 * A4/A5 of meta/cache/_verifier-codex-audit-i9-i24-2026-10-08.md).
 *
 * Every hook that writes an excerpt of a message, prompt, command or tool text into its log passes that excerpt
 * through redactSecrets(), or through redactExcerpt(), which redacts BEFORE it cuts, so a cut can never hide the
 * tail a pattern needs. redactDeep() walks a whole log row (nested objects and arrays included).
 * Library module: no I/O, no side effects on import, never throws (any internal error returns a fixed marker).
 *
 * Coverage: the union of the two redactors it replaces (reversibility-guard.mjs, _subagent-lifecycle-probe.mjs; their
 * markers are kept) plus the five shapes the 2026-10-08 audit saw survive (github_pat_, Google AIza, a password in a
 * URL, a PEM body, a Telegram bot token), plus GOCSPX-, ya29., glpat-, hf_, Slack webhooks and a generic rule for
 * long high-entropy tokens.
 *
 * HONEST LIMITS: pattern-based, so it is a net, not a proof. The generic rule skips a token that is shorter than 24
 * chars, hex-only, missing one of upper/lower/digit, low-entropy, rarely switching character class (CamelCase), or
 * shaped like a path (most "/" segments are words). Anthropic ids (toolu_, srvtoolu_, msg_, req_, call_) are exempt.
 */

// Round 2 (2026-10-10, verifier A5): named so the profile sync's secret guard (rule 8: a credential word, '=' and a
// quoted value) does not read this marker as an inline credential. Under the old name it refused this whole file,
// the profile copy then lacked it, and `harness-install --apply --scrub` exited 2.
const TOKEN_MARK = '<REDACTED-TOKEN>';

// Specific shapes first (order matters: PEM and URL userinfo before the generic rules eat their parts).
const RULES = [
  // PEM private key block; also a block cut before its END line (the excerpt ends inside the body).
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g, '<REDACTED-PEM>'],
  // password inside a URL: scheme://user:password@host -> scheme://user:<REDACTED>@host
  // (scheme length bounded: an unbounded scheme class backtracks quadratically on a long "a-a-a-" run)
  [/\b([a-z][a-z0-9+.\-]{0,30}:\/\/)([^\s:@\/?#]*):([^\s@\/?#]+)@/gi, '$1$2:<REDACTED>@'],
  // Slack incoming-webhook path
  [/\bhooks\.slack\.com\/services\/[A-Za-z0-9\/_\-]+/g, 'hooks.slack.com/services/<REDACTED>'],
  // --- reversibility-guard rules (markers kept) ---
  [/\b(?:Bearer|Authorization:?\s*Bearer)\s+[A-Za-z0-9._~+\/\-]+=*/gi, 'Bearer <REDACTED>'],
  [/\b(_?auth[_-]?token|api[_-]?key|secret|password|passwd|pwd)\s*[=:]\s*\S+/gi, '$1=<REDACTED>'],
  // name=value where the name ENDS in a credential word (CLIENT_SECRET, GITHUB_TOKEN, PGPASSWORD, x-api-key ...).
  // No name-prefix group and no leading \b: the prefix simply stays in the text. (A lazy prefix group measured 5.8 s
  // on a 240 KB "a-a-a-" input; this form is linear.)
  [/(auth[_-]?token|access[_-]?token|refresh[_-]?token|api[_-]?key|secret|passw(?:or)?d|token)(["']?\s*[=:]\s*["']?)([A-Za-z0-9_\-.\/+=~]{8,})/gi, '$1$2<REDACTED>'],
  [/\bgithub_pat_[A-Za-z0-9_]{10,}/g, TOKEN_MARK],
  [/\b(?:sk|pk|rk|npm|ghp|gho|ghs|ghu|ghr|xox[baprs]|AKIA|ASIA)[-_][A-Za-z0-9_\-]{6,}/g, TOKEN_MARK],
  [/\bAKIA[0-9A-Z]{16}\b/g, '<REDACTED-AWS>'],
  // JWT. Round 2 (verifier R4/A3): the first two segments are bounded. Unbounded, every "eyJ" inside one long
  // "eyJ-eyJ-..." run re-scanned the rest of the run: 2.6 s at 60K chars, 49.7 s at 240K. A longer segment is
  // still caught by the generic high-entropy rule below.
  [/\beyJ[A-Za-z0-9_\-]{1,512}\.[A-Za-z0-9_\-]{1,16384}\.[A-Za-z0-9_\-]+/g, '<REDACTED-JWT>'],
  // --- new prefixed shapes ---
  [/\bAIza[0-9A-Za-z_\-]{20,}/g, '<REDACTED-GOOGLE-KEY>'],
  [/\bGOCSPX-[A-Za-z0-9_\-]{10,}/g, TOKEN_MARK],
  [/\bya29\.[A-Za-z0-9_\-]{20,}/g, TOKEN_MARK],
  [/\bglpat-[A-Za-z0-9_\-]{16,}/g, TOKEN_MARK],
  [/\bhf_[A-Za-z0-9]{30,}/g, TOKEN_MARK],
  // Telegram bot token: <6-12 digit bot id>:<secret>, bare or after "bot" in an API URL. The id is kept.
  [/\b(bot)?(\d{6,12}):[A-Za-z0-9_\-]{20,}/g, '$1$2:<REDACTED-BOT-TOKEN>'],
];

const EXEMPT_ID = /^(?:toolu|srvtoolu|msg|req|call)_[A-Za-z0-9]+$/;
const CANDIDATE = /[A-Za-z0-9+\/_\-]{24,}={0,2}/g;
const cls = (c) => (c >= 'A' && c <= 'Z') ? 1 : (c >= 'a' && c <= 'z') ? 2 : (c >= '0' && c <= '9') ? 3 : 4;

function entropy(s) {
  const f = new Map();
  for (const c of s) f.set(c, (f.get(c) || 0) + 1);
  let h = 0;
  for (const n of f.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}
function transitionRatio(s) {
  let t = 0;
  for (let i = 1; i < s.length; i++) if (cls(s[i]) !== cls(s[i - 1])) t++;
  return t / (s.length - 1);
}
function pathLike(s) {
  if (!s.includes('/')) return false;
  const parts = s.split('/').filter(Boolean);
  if (parts.length < 2) return false;
  const wordish = parts.filter((p) => p.length >= 3 && /^(?:[A-Za-z][a-z]+|[a-z0-9]+(?:[-_.][a-z0-9]+)*)$/.test(p)).length;
  return wordish * 2 >= parts.length;
}
/** True when one candidate token looks like a random secret (the generic rule). Exported for the tests. */
export function looksHighEntropy(tok) {
  const t = String(tok).replace(/=+$/, '');
  if (t.length < 24 || EXEMPT_ID.test(t)) return false;
  if (!/[A-Z]/.test(t) || !/[a-z]/.test(t) || !/[0-9]/.test(t)) return false;
  if (pathLike(t)) return false;
  return entropy(t) >= 3.5 && transitionRatio(t) >= 0.4;
}

/** Redact every credential shape in one string. Non-strings are stringified. Never throws. */
export function redactSecrets(s) {
  try {
    let out = String(s ?? '');
    for (const [re, rep] of RULES) out = out.replace(re, rep);
    return out.replace(CANDIDATE, (m) => (looksHighEntropy(m) ? '<REDACTED-HIGH-ENTROPY>' : m));
  } catch {
    return '<REDACTION-ERROR>';
  }
}

/** Redact, THEN cut to n chars (so a cut never hides a key from the patterns). Reads at most n + window chars. */
export function redactExcerpt(s, n, window = 4096) {
  const t = String(s ?? '');
  return redactSecrets(t.length > n + window ? t.slice(0, n + window) : t).slice(0, n);
}

/** Redact every string inside a log row: nested objects and arrays too (verifier F2b). Keys are left as they are. */
export function redactDeep(v, depth = 0) {
  if (typeof v === 'string') return redactSecrets(v);
  if (v === null || typeof v !== 'object' || depth > 12) return v;
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, depth + 1));
  const o = {};
  for (const k of Object.keys(v)) o[k] = redactDeep(v[k], depth + 1);
  return o;
}
