#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// sync-harness-from-source.mjs — copy the harness from the SOURCE repo into a global harness root,
// report drift mechanically, and wire the global settings.json (deploy plan §8.2).
//
//   node sync-harness-from-source.mjs [--check|--apply] [--source <dir>] [--global <dir>]
//                                     [--reseed <dir>] [--unseed <dir>] [--json]
//
//   --check   (DEFAULT)  dry-run. Writes nothing. Exits 0 iff n_drift == 0 and nothing was blocked.
//   --apply              the ONLY writing mode. Backs up every overwritten destination, deletes
//                        nothing, and then wires <G>/settings.json. Exits 2 if the secret guard
//                        blocked anything.
//   --global  <dir>      the destination harness root. Default <home>/.claude (os.homedir()). Tests point
//                        it at a throwaway fixture dir; the wiring it writes uses the <dir> given,
//                        so a fixture dir gets fixture paths.
//   --scrub              client scrub (item 5, 2026-10-03): see the client-scrub block. Needs
//                        --personal-terms <file> (repeatable) or a default list, or --no-personal-terms.
//   --force              overwrite a USER-MODIFIED destination (I2 ledger; backup kept). Without it,
//                        a hand-edited destination is reported and skipped.
// Every run first passes the payload-safety pre-flight (I7; exit 2, nothing written) and every
// --apply writes <G>/harness-install-ledger.json; harness-install.mjs wraps install/update/doctor.
//
// FAIL-CLOSED on identity: refuses to run unless <source>/.claude/HARNESS-SOURCE exists, and
// refuses any source or destination under <denylisted-root>.
// The payload table below IS the copy set: adding a file to the deploy is a reviewable diff. Its
// IMPORT CLOSURE is computed mechanically on top of it (see importClosure): a sibling module that a
// payload script imports is part of the deploy whether or not a human remembered to list it.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnPython } from '../tools/_py.mjs';

// realpath.native resolves Windows junctions and 8.3 names. For a destination
// not created yet, resolve its deepest existing ancestor and retain the suffix.
function physicalPath(value) {
  let current = path.resolve(value);
  const suffix = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(current), ...suffix); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // A dangling link is not a missing directory: do not guess its target.
      try { fs.lstatSync(current); throw error; }
      catch (statError) { if (statError === error || statError.code !== 'ENOENT') throw statError; }
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

function inside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

// Names under which THIS machine can be reached in a UNC path.
function localHostNames() {
  const names = new Set(['localhost', '127.0.0.1', '0-0-0-0-0-0-0-1.ipv6-literal.net', os.hostname(), process.env.COMPUTERNAME || '']);
  for (const nic of Object.values(os.networkInterfaces())) for (const a of nic || []) names.add(a.address);
  return new Set([...names].filter(Boolean).map((n) => n.toLowerCase()));
}

// A UNC spelling of this machine's own administrative share (\\localhost\C$\x, \\127.0.0.1\C$\x, \\<hostname>\C$\x,
// \\?\UNC\...) is just another way to write C:\x. realpath.native keeps the UNC spelling, so the containment tests
// below never saw the overlap, and a write through \\localhost\C$\<source> landed in the source (verifier A4,
// 2026-10-10). Fold it back to the drive-letter form before comparing. NOT covered: a custom (non-X$) share of this
// machine, which cannot be resolved by spelling alone.
function foldAdminShare(value) {
  if (process.platform !== 'win32') return value;
  const m = /^\\\\(?:\?\\UNC\\)?([^\\/]+)\\([A-Za-z])\$(?:\\(.*))?$/i.exec(path.resolve(value));
  if (!m || !localHostNames().has(m[1].toLowerCase())) return value;
  return m[2].toUpperCase() + ':\\' + (m[3] || '');
}

export function assertSeparateSourceConfig(sourceInput, configInput) {
  for (const value of [sourceInput, configInput]) {
    if (/^\/\/(?:\?\/UNC\/)?(?:\[::1\]|127\.0\.0\.1|localhost)\/[a-z]\$(?:\/|$)/i.test(String(value).replace(/\\/g, '/'))) {
      throw new Error('loopback UNC alias refused; use a plain drive path for the source and config dir');
    }
  }
  const source = foldAdminShare(sourceInput);
  const config = foldAdminShare(configInput);
  const realSource = foldAdminShare(physicalPath(source));
  const realConfig = foldAdminShare(physicalPath(config));
  if (inside(config, source) || inside(source, config)
      || inside(realConfig, realSource) || inside(realSource, realConfig)) {
    throw new Error('the config dir and the source clone must not contain each other');
  }
}

const BS = String.fromCharCode(92);
const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_GLOBAL = path.resolve((process.env.CLAUDE_CONFIG_DIR || '').trim() || path.join(os.homedir(), '.claude')).split(BS).join('/');
const pythonError = (r) => r.error?.message
  || `Python command '${r.command}' failed (${r.status}); check the Python 3 installation.`;
// Payload-schema epoch. BUMPED to v2 on 2026-09-04, when the import closure entered the payload:
// harness-seed.mjs re-seeds a project only when the manifest version differs from the recorded one,
// so a scheme change is what makes every already-seeded project pick the repaired payload up.
const MANIFEST_SCHEMA = 'v2';
const PINNED_CLAUDE_MD = '936669739a0d5fa3';
const PINNED_CRED_ISO = 'e1a530afe989a4db';

const norm = (p) => (typeof p === 'string' ? p.split(BS).join('/').trim().toLowerCase().replace(/\/+$/, '') : '');
const underTrading = (p) => { const s = norm(p); return s === '<denylisted-root>' || s.startsWith('<denylisted-root>/'); };

// ── payload table (deploy plan §3) ───────────────────────────────────────────────────────────────
const HOOKS = [
  'evidence-gate.mjs', 'ref-lint-gate.mjs', 'memory-coherence.mjs', '_discipline-meter-observe.mjs',
  'reversibility-guard.mjs', 'injection-tripwire-observe.mjs', '_subagent-lifecycle-probe.mjs', '_config-change-audit.mjs',
];   // public package (2026-10-12): the 5 owner-communication hook rows are removed; those files are not exported
// + 4 generic, stdlib-only tools the shipped agents call (portability fix 2026-10-01: coder/planner/verifier/selfcert-guard
// named them but only this repo had them). test_adequacy.py imports selfcert_harness.py, so both ship (pythonRefs leg).
// Round 2 (2026-10-03, verifier A2/A3): TOOLS are what the seeded project hooks call, so they keep a `seed`. AGENT_TOOLS
// are called only by the shipped AGENTS, which find them in the config dir (GLOBAL_PROLOGUE): copy rows with NO `seed`,
// so harness-seed.mjs never drops them into a user's git project. secret_scan.py (stdlib-only) ships because the coder
// agent's secret scan is mandatory; an installed copy without it would skip a safety step.
const TOOLS = ['_py.mjs', 'ref_linter.py', 'memory_linter.py'];
const AGENT_TOOLS = [
  'instrument_fitness.py', 'gate_coherence.py', 'selfcert_harness.py', 'test_adequacy.py', 'secret_scan.py',
  'plan_progress.py', 'dispatch_planner.py', 'usage_meters.py',
  'dispatch_lint.py', 'verifier_actions_ledger.py',   // public package: unreported_work.py (owner transcripts) not exported
];

// Both the installer and post-install check use this roster. Only frontmatter can retire a role;
// mentioning DORMANT in an agent's instructions does not remove it from the payload.
export function shippedAgents(agentsDir) {
  return fs.readdirSync(agentsDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
    .filter(entry => {
      const text = fs.readFileSync(path.join(agentsDir, entry.name), 'utf8');
      const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] || '';
      return !/\bDORMANT\b/i.test(frontmatter);
    }).map(entry => entry.name).sort();
}
const LENSES = ['lens-format.md', 'quant-validation.md'];
const AUTHORED = [
  { src: '.claude/global-layer/_global-runner.mjs', dst: 'hooks/_global-runner.mjs' },
  { src: '.claude/global-layer/harness-seed.mjs', dst: 'tools/harness-seed.mjs' },
  { src: '.claude/global-layer/sync-harness-from-source.mjs', dst: 'tools/sync-harness-from-source.mjs' },
];   // public package (2026-10-12): the work-profile-lessons.md row (owner's two-profile setup) is removed
// GLOBAL-ONLY files (owner ask 2026-10-01: the harness fully versioned and updatable). Until then they lived ONLY
// in the global dir, which no repo tracks. Copy rows WITHOUT `seed` (never copied into a project) and kept out of
// the plugin export (PLUGIN_NOT_SHIPPED_TOOLS; the .txt has no plugin home): they are per-machine, and
// work_profile_sync.py / statusline_meters.mjs carry this machine's home paths. harness-deny-roots.txt is read by
// hooks/_global-runner.mjs denyRoots() and tools/harness-seed.mjs denyRoots(); it is PER-MACHINE, so its row is
// SEED-IF-ABSENT (round 2, 2026-10-03, verifier A3): --apply writes it only where the destination has none; an existing
// list that differs is reported as `machine-local` (never counted as drift, never overwritten, never merged).
const GLOBAL_ONLY = [
  // public package (2026-10-12): the work_profile_sync.py and statusline_meters(.test).mjs rows are removed (not exported)
  { src: '.claude/global-layer/harness-deny-roots.txt', dst: 'harness-deny-roots.txt', mode: 'seed-if-absent' },
];

export function payloadTable(S = path.resolve(SELF_DIR, '..', '..')) {
  const rows = [];
  for (const h of HOOKS) rows.push({ src: `.claude/hooks/${h}`, dst: `hooks/${h}`, mode: 'copy', seed: `hooks/${h}` });
  for (const t of TOOLS) rows.push({ src: `.claude/tools/${t}`, dst: `tools/${t}`, mode: 'copy', seed: `tools/${t}` });
  for (const t of AGENT_TOOLS) rows.push({ src: `.claude/tools/${t}`, dst: `tools/${t}`, mode: 'copy' });
  for (const a of shippedAgents(path.join(S, '.claude', 'agents'))) rows.push({ src: `.claude/agents/${a}`, dst: `agents/${a}`, mode: 'copy' });
  for (const l of LENSES) rows.push({ src: `.claude/lenses/${l}`, dst: `lenses/${l}`, mode: 'copy' });
  for (const a of AUTHORED) rows.push({ src: a.src, dst: a.dst, mode: 'copy' });
  for (const g of GLOBAL_ONLY) rows.push({ src: g.src, dst: g.dst, mode: g.mode || 'copy' });
  rows.push({ dst: 'lenses/general-review.md', mode: 'retire' });
  // Public package (2026-10-12): the ceo-model/ceo-model.md row and the report-only root CLAUDE.md row (the owner's pinned
  // rules port) are removed: neither file ships. credential-isolation.md is seeded the way --scrub always seeded it
  // (rules-seed: written when absent, a user's own copy is kept), because no CLAUDE.md port here pins its hash.
  rows.push({ src: '.claude/standards/credential-isolation.md', dst: 'standards/credential-isolation.md', mode: 'rules-seed' });
  // verifier-creation.md is a normal COPY row since 2026-10-01 (report-only 2026-09-25..09-30). Report-only is for a
  // global file that is deliberately NOT a byte copy: the CLAUDE.md port, and credential-isolation.md, whose hash that
  // port pins in its own text. This standard is byte-identical in both places and pinned by nothing else, so the repo
  // owns it: edit the repo copy, then --apply; a home-only edit now shows as drift.
  rows.push({ src: '.claude/standards/verifier-creation.md', dst: 'standards/verifier-creation.md', mode: 'copy' }); rows.push({ src: '.claude/global-layer/client-profile/client-interaction-profile.md', dst: 'standards/client-interaction-profile.md', mode: 'copy' }); // H-44: scrubbed default client profile (same physical line on purpose: a new line would shift the registered source-line anchors in docs/harness/source-line-tokens.json)
  return rows;
}

// ── import closure (repair 2026-09-04) ────────────────────────────────────────────────
// WHY THIS EXISTS. The table above listed the 13 wired hooks but NOT the sibling modules they import.
// MEASURED by an independent fresh-folder verifier on 2026-09-04: in a fresh project 5 of 9 wired
// global hooks died with ERR_MODULE_NOT_FOUND — reversibility-guard (THE BRAKE), ref-lint-gate,
// memory-coherence, _discipline-meter-observe — in the global copy AND in the seeded project copy,
// because honest-risk-preconditions.mjs, _ramp-alarm.mjs, _turn-touch.mjs and _py-resolve.mjs were
// never copied. `--check` said n_drift 0 throughout: it compared the files it was TOLD about and was
// structurally blind to an incomplete SET. Both legs below close that hole.
// The specifier regex is ported verbatim from .claude/hooks/wired-hooks-tracked.test.mjs, where it is
// already proven to catch the static, side-effect-only, dynamic and require forms.
// Round 2 (2026-10-03, verifier A4): also a back-quoted (template) literal specifier and require.resolve(<spec>).
// A template WITH an interpolation (`./${n}.mjs`) cannot be resolved statically: importClosure records it as
// unresolved `dynamic-specifier` instead of dropping it.
const SPEC_RE = /(?:from\s*|import\s*\(\s*|import\s+|require(?:\.resolve)?\s*\(\s*)(['"`])(\.[^'"`]+)\1/g;

/** Destination inside <G> for a repo-relative source path, or null when the payload has no home for
 *  it. A null is never a silent drop: the caller records an `unresolved-import` row. */
export function dstForSource(rel) {
  const m = /^\.claude\/(hooks|tools)\/([^/]+)$/.exec(rel);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Walk the relative-import graph of `seeds` (repo-relative paths under S), transitively.
 *  Returns { extra, edges, unresolved }:
 *    extra      repo-relative modules to ADD to the payload (in discovery order);
 *    edges      { from, dep } for every RESOLVED relative dependency, used by the
 *               destination-presence leg;
 *    unresolved { from, spec, rel, why } for a dependency the payload cannot carry. */
export function importClosure(S, seeds) {
  const seen = new Set(seeds);
  const queue = [...seeds];
  const extra = []; const edges = []; const unresolved = [];
  while (queue.length) {
    const rel = queue.shift();
    if (!/\.(mjs|js|cjs)$/.test(rel)) continue;      // .py dependencies are handled by pythonRefs()
    const abs = path.join(S, rel);
    let src;
    try { src = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    for (const m of src.matchAll(SPEC_RE)) {
      if (m[2].includes('${')) { unresolved.push({ from: rel, spec: m[2], rel: m[2], why: 'dynamic-specifier' }); continue; }
      const depAbs = path.resolve(path.dirname(abs), m[2]);
      const dep = path.relative(S, depAbs).split(path.sep).join('/');
      const rec = { from: rel, spec: m[2], rel: dep };
      if (dep.startsWith('..')) { unresolved.push({ ...rec, why: 'outside-source-root' }); continue; }
      if (!dstForSource(dep)) { unresolved.push({ ...rec, why: 'no-payload-home' }); continue; }
      if (!fs.existsSync(depAbs)) { unresolved.push({ ...rec, why: 'missing-in-source' }); continue; }
      edges.push({ from: rel, dep });
      if (seen.has(dep)) continue;
      seen.add(dep); extra.push(dep); queue.push(dep);
    }
  }
  return { extra, edges, unresolved };
}

/** The PYTHON leg. ref-lint-gate.mjs and memory-coherence.mjs shell out to .py tools by path, which
 *  no ESM specifier scan can see. Two mechanical checks: (1) every `"<name>.py"` literal inside a
 *  payload .mjs must be a payload tool; (2) every module a payload .py imports that EXISTS as
 *  .claude/tools/<name>.py must be a payload tool too (a stdlib name has no such sibling, so
 *  `import json` can never false-positive). */
/** Every top-level module name a Python source imports, at ANY indentation (round 2, 2026-10-03, verifier A4: an
 *  import inside a function or try-block was missed), plus the dynamic forms importlib.import_module('x') and
 *  __import__('x'). `import a, b as c` yields a and b. Only the first dotted segment counts (a sibling tool is flat). */
export function pyImportNames(src) {
  const names = [];
  const s = String(src);
  for (const m of s.matchAll(/^[ \t]*from[ \t]+([A-Za-z_][A-Za-z0-9_]*)[\w.]*[ \t]+import\b/gm)) names.push(m[1]);
  for (const m of s.matchAll(/^[ \t]*import[ \t]+([^\n#;]+)/gm)) {
    for (const part of m[1].split(',')) { const n = /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(part); if (n) names.push(n[1]); }
  }
  for (const m of s.matchAll(/\b(?:importlib\s*\.\s*import_module|__import__)\s*\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)/g)) names.push(m[1]);
  return [...new Set(names)];
}

export function pythonRefs(S, rows) {
  const tools = new Set(rows.filter((r) => r.dst && r.dst.startsWith('tools/')).map((r) => r.dst.slice(6)));
  const unresolved = [];
  for (const r of rows) {
    if (!r.src || r.mode !== 'copy') continue;
    let src;
    try { src = fs.readFileSync(path.join(S, r.src), 'utf8'); } catch { continue; }
    if (/\.mjs$/.test(r.src)) {
      for (const m of src.matchAll(/['"]([A-Za-z0-9_.-]+\.py)['"]/g)) {
        if (!tools.has(m[1])) unresolved.push({ from: r.src, spec: m[1], rel: `.claude/tools/${m[1]}`, why: 'py-tool-not-in-payload' });
      }
    } else if (/\.py$/.test(r.src)) {
      for (const name of pyImportNames(src)) {
        if (tools.has(`${name}.py`)) continue;
        if (fs.existsSync(path.join(S, '.claude', 'tools', `${name}.py`))) {
          unresolved.push({ from: r.src, spec: name, rel: `.claude/tools/${name}.py`, why: 'py-sibling-not-in-payload' });
        }
      }
    }
  }
  return { unresolved };
}

// ── inventory (round 2, 2026-10-03; handoff 02-10 item 2: "everything works the same" includes MCP servers and the
// per-profile browser folders). REPORT rows only: server NAMES and browser-folder BASENAMES + existence. No command, arg,
// env value or token is ever copied into the output. Never written, never drift, never changes the exit code.
function mcpNamesFrom(file) {
  let j;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  const servers = j && typeof j.mcpServers === 'object' && j.mcpServers ? j.mcpServers : {};
  const browserDirs = [];
  for (const v of Object.values(servers)) {
    const args = v && Array.isArray(v.args) ? v.args.map(String) : [];
    args.forEach((x, i) => {
      const d = x.startsWith('--user-data-dir=') ? x.slice(16) : (x === '--user-data-dir' ? args[i + 1] : '');
      if (d) browserDirs.push({ name: path.basename(norm0(d)), exists: fs.existsSync(d) });
    });
  }
  return { names: Object.keys(servers).sort(), browserDirs };
}
/** The user-level Claude config file of profile <G>: <G>/.claude.json when CLAUDE_CONFIG_DIR points there, else (the
 *  default ~/.claude layout) the .claude.json next to it. The first that exists. */
export function userConfigFile(G) {
  const c = [path.join(G, '.claude.json')];
  if (path.basename(G).toLowerCase() === '.claude') c.push(path.join(path.dirname(G), '.claude.json'));
  return c.find((f) => fs.existsSync(f)) || '';
}
export function inventory(S, G) {
  const rows = [];
  const add = (scope, file, where) => {
    const r = file ? mcpNamesFrom(file) : null;
    rows.push({ kind: 'mcp-servers', scope, where, present: !!r, names: r ? r.names : [] });
    rows.push({ kind: 'browser-dirs', scope, where, present: !!r, names: r ? r.browserDirs.map((b) => `${b.name}${b.exists ? '' : ' (missing)'}`) : [] });
  };
  const proj = path.join(S, '.mcp.json');
  add('source-project', fs.existsSync(proj) ? proj : '', '.mcp.json');
  const uf = userConfigFile(G);
  add('global-user', uf, uf ? path.basename(uf) : '');
  return rows;
}

export function installProfiles(S) {
  return JSON.parse(fs.readFileSync(path.join(S, '.claude', 'global-layer', 'install-profiles.json'), 'utf8'));
}

export function selectInstallProfile(S, name = '', withHooks = false) {
  if (!name) return null; // No profile preserves the legacy table and wiring exactly.
  const data = installProfiles(S);
  if (!Object.hasOwn(data.profiles, name)) throw new Error(`unknown profile: ${name}`);
  const profile = data.profiles[name];
  if (profile.legacy) return null;
  const groups = profile.groups.map(g => data.capability_groups[g]).filter(g => !g.hooks || withHooks);
  return { groups, hooks: groups.flatMap(g => g.hooks || []) };
}

function profileRow(row, selection) {
  if (!selection) return true;
  if (row.dst === 'hooks/_global-runner.mjs') return selection.hooks.length > 0;
  return selection.groups.some(g => !(g.exclude || []).includes(row.dst) && (
    (g.prefixes || []).some(p => row.dst.startsWith(p)) ||
    (g.paths || []).includes(row.dst) ||
    (g.hooks || []).some(h => row.dst === `hooks/${h}`)));
}

/** Compute import closure after profile selection, so omitted hooks cannot pull in dependencies. */
export function fullTable(S, selection = null) {
  const rows = payloadTable(S).filter(row => profileRow(row, selection));
  const seeds = rows.filter((r) => r.mode === 'copy' && r.src && /\.(mjs|js|cjs)$/.test(r.src)).map((r) => r.src);
  const closure = importClosure(S, seeds);
  const extraRows = closure.extra.map((rel) => {
    const dst = dstForSource(rel);
    return { src: rel, dst, mode: 'copy', seed: dst, via: 'import-closure' };
  });
  const table = rows.filter((r) => r.mode === 'copy').concat(extraRows, rows.filter((r) => r.mode !== 'copy'));
  return { table, closure, unresolved: closure.unresolved.concat(pythonRefs(S, table).unresolved) };
}

// ── secret / PII guard (plan §8.2), run on the SOURCE bytes BEFORE any write ─────────────────────
// Rules 1-4 carry a length-class suffix that the plan's bare prefixes do not. REASON (documented
// deviation): `.claude/hooks/_subagent-lifecycle-probe.mjs` legitimately contains those prefixes as
// REDACTION-REGEX SOURCE (its lines 47-48 are /\bghp_[A-Za-z0-9]{20,}/g etc.). A bare-prefix rule
// blocks that payload hook forever while catching nothing extra: a real key always has the tail.
const RULES = [
  { n: 1, re: /sk-ant-[A-Za-z0-9_-]{20,}/, what: 'anthropic-key-shape' },
  { n: 2, re: /ghp_[A-Za-z0-9]{20,}/, what: 'github-token-shape' },
  { n: 3, re: /github_pat_[A-Za-z0-9_]{20,}/, what: 'github-pat-shape' },
  { n: 4, re: /xox[baprs]-[A-Za-z0-9-]{10,}/, what: 'slack-token-shape' },
  { n: 5, re: /AKIA[0-9A-Z]{16}/, what: 'aws-key-shape' },
  { n: 6, re: /AIza[0-9A-Za-z_-]{35}/, what: 'google-key-shape' },
  { n: 7, re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: 'private-key-block' },
  { n: 8, re: /(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*['"][^'"]{8,}/i, what: 'inline-credential-assignment' },
  { n: 9, re: new RegExp(['maintainer', 'example\\.invalid'].join('@')), what: 'ceo-email-literal' },
  // rule 10 has THREE alternatives, one per real phone form (verify 2026-09-04 found the old single
  // separator-requiring branch missed both international forms). (a) the original punctuated local
  // form; (b) '+' followed by 9-15 digits with OPTIONAL separators -- covers both the contiguous
  // (+549XXXXXXXXXX) and the space/dash/dot-separated international forms; (c) a bare 10-digit local
  // run bounded by NON-WORD chars, so a hex sha prefix (digits adjacent to a-f) can never match.
  // Deliberately NOT matched: ISO timestamps (':' is not a separator, and 2026-09-04 has a 2-digit
  // group), port numbers (too short), and 13-digit epoch millis (exact-length + digit boundaries).
  // Branch (c) boundaries are PROSE/JSON delimiters, not merely non-word chars. MEASURED
  // 2026-09-04: a plain non-word boundary false-positived on .claude/hooks/reversibility-guard.mjs,
  // which carries an IP-as-integer literal (0* followed by a 10-digit run) inside a detector
  // pattern; n_copied fell 38 -> 37 and a live payload hook was blocked. Pattern source next to a
  // regex metacharacter is not a phone number; a phone in prose/JSON/parens still matches.
  { n: 10, re: /(?<!\d)(\+\d{1,3}[ .-]?)?\(?\d{2,4}\)?[ .-]\d{3,4}[ .-]\d{3,4}(?!\d)|\+(?:\d[ .-]?){8,14}\d(?!\d)|(?<=^|[\s"'`:,;=>(\[])\d{10}(?=$|[\s"'`,.;:)<\]])/, what: 'phone-shaped-digits' },
];

/** Returns the array of VIOLATED rule numbers. The matched text is never captured, printed,
 *  returned or written — only the rule number travels. */
export function guardViolations(buf) {
  const txt = buf.toString('utf8');
  const hits = [];
  for (const r of RULES) { if (r.re.test(txt)) hits.push(r.n); }
  return hits;
}

const FILENAME_DENY = [
  /\.log$/i, /\.bak/i, /^\.credentials/i, /^\.env/i, /^settings\.local\.json$/i,
  /(^|\/)reversibility-markers\//i, /\.key$/i, /\.pem$/i, /(^|\/)node_modules\//i,
];
export function filenameDenied(relPath) {
  const base = relPath.split('/').pop();
  return FILENAME_DENY.some((re) => re.test(relPath) || re.test(base));
}

// ── payload safety pre-flight (I7, 2026-10-03) ───────────────────────────────────────────────────────
// EXTENDS the guard above, it does not replace it (verifier A2, 2026-10-03). Whole-payload checks on the bytes that
// would be WRITTEN, run BEFORE any write in --check and --apply alike. Any finding refuses the run (exit 2, nothing
// written) and is reported as path + kind (+ line / module name) only, never the matched text.
//   symlink           a payload source file, or a directory between <S> and it, is a symlink or a junction (Node's
//                     lstat reports a Windows junction as a symbolic link): the bytes could come from outside the tree.
//   duplicate-target  two rows write one destination; case-insensitive and slash-normalised, because NTFS is.
//   pipe-to-shell     download-and-execute in one step: a downloader (curl, wget, iwr, irm) piped straight into a
//                     shell or interpreter, Invoke-Expression over a web request, or a shell fed by a process/command
//                     substitution of a downloader (patterns below; this comment avoids the literal forms because the
//                     file is itself payload). A match inside a JS/PY regex literal is detector source, not an
//                     instruction, and is skipped (regexSpansFor).
//   offline-load      the payload loads with no network and no package install. JS: every STATIC import as parsed by
//                     V8 itself (vm.SourceTextModule in a child node) is relative or a Node builtin; a parse error is a
//                     finding. A text regex gave 4 false positives on strings/prose at the base SHA (measured
//                     2026-10-03), so the parser is the oracle. PY: every imported top-level module is stdlib
//                     (sys.stdlib_module_names via `py`) or a payload tool, and the file parses (ast). Without `py` the
//                     python leg is reported `unverified`, never passed. Dynamic import()/require() are NOT covered.
//   personal          only with --scrub: see scrubBytes / personalFindings below.
export const PIPE_TO_SHELL_RES = [
  /\b(?:curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^|\n]*\|\s*(?:sudo\s+(?:-\S+\s+)*)?(?:sh|bash|zsh|dash|ksh|fish|pwsh|powershell|iex|Invoke-Expression|python[0-9.]*|py|node|perl|ruby)\b/gi,
  /\b(?:iex|Invoke-Expression)\b\s*[(&]?\s*\(?\s*(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod|New-Object\s+(?:System\.)?Net\.WebClient)\b/gi,
  /\b(?:sh|bash|zsh)\s+<\(\s*(?:curl|wget)\b/gi,
  /\b(?:sh|bash|zsh)\s+-c\s+["']?\$\(\s*(?:curl|wget)\b/gi,
];
export function pipeToShellLines(file, txt) {
  const s = String(txt); const spans = regexSpansFor(file, s); const lines = new Set();
  for (const re of PIPE_TO_SHELL_RES) for (const m of s.matchAll(re)) {
    if (spans.some(([a, b]) => m.index >= a && m.index < b)) continue;
    lines.add(s.slice(0, m.index).split('\n').length);
  }
  return [...lines].sort((x, y) => x - y);
}
/** The first component (repo-relative) between <S> and <rel> that is a symlink or a junction, else null. */
export function symlinkedComponent(S, rel) {
  let cur = S;
  for (const part of String(rel).split('/')) {
    cur = path.join(cur, part);
    let st; try { st = fs.lstatSync(cur); } catch { return null; }
    if (st.isSymbolicLink()) return path.relative(S, cur).split(path.sep).join('/');
  }
  return null;
}
export function duplicateTargets(table) {
  const by = new Map();
  for (const r of table) {
    if (!r.dst) continue;
    const k = norm0(r.dst).replace(/^\.\//, '').toLowerCase();
    by.set(k, (by.get(k) || []).concat(r.src || `(${r.mode})`));
  }
  return [...by].filter(([, v]) => v.length > 1).map(([dst, srcs]) => ({ dst, srcs }));
}
const asciiJson = (v) => JSON.stringify(v).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const V8_SPECS_CHILD = [
  "const vm = require('node:vm'); const { isBuiltin } = require('node:module');",
  "let d = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { d += c; }).on('end', () => {",
  "  const out = [];",
  "  for (const f of JSON.parse(d)) {",
  "    try { const m = new vm.SourceTextModule(f.text, { identifier: 'payload:' + f.file });",
  "      const specs = Array.isArray(m.moduleRequests) ? m.moduleRequests.map((r) => r.specifier) : [...m.dependencySpecifiers];",
  "      out.push({ file: f.file, n: specs.length, bad: specs.filter((s) => !s.startsWith('.') && !isBuiltin(s)) }); }",
  "    catch (e) { out.push({ file: f.file, error: String((e && e.name) || 'Error') }); }",
  "  }",
  "  process.stdout.write(JSON.stringify(out));",
  "});",
].join('\n');
const PY_CHILD = "import sys, json, ast\nd = json.load(sys.stdin)\nbad = []\nfor f in d:\n    try:\n        ast.parse(f['text'])\n    except Exception:\n        bad.append(f['file'])\nprint(json.dumps({'stdlib': sorted(sys.stdlib_module_names), 'parse_errors': bad}))";
/** files: [{ file, text }] -> { findings[], py_leg: 'checked'|'unverified'|'not-needed', n_js_specs } */
export function offlineLoadFindings(files, { toolNames = new Set() } = {}) {
  const findings = []; const out = { findings, py_leg: 'not-needed', n_js_specs: 0 };
  const js = files.filter((f) => /\.(mjs|js|cjs)$/.test(f.file));
  if (js.length) {
    const r = spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', '-e', V8_SPECS_CHILD], { input: asciiJson(js), encoding: 'utf8', maxBuffer: 1 << 28 });
    let res = null; try { res = JSON.parse(r.stdout); } catch { /* reported below */ }
    if (!Array.isArray(res)) findings.push({ kind: 'offline-load', file: '(js payload)', why: 'v8-parse-child-failed' });
    else for (const x of res) {
      if (x.error) { findings.push({ kind: 'offline-load', file: x.file, why: `parse-error:${x.error}` }); continue; }
      out.n_js_specs += x.n;
      for (const s of x.bad) findings.push({ kind: 'offline-load', file: x.file, why: /^[a-z][a-z0-9+.-]*:/i.test(s) ? 'url-import' : 'package-import', spec: s });
    }
  }
  const py = files.filter((f) => /\.py$/.test(f.file));
  if (py.length) {
    const r = spawnPython(['-c', PY_CHILD], { input: asciiJson(py), encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }, maxBuffer: 1 << 26 }, undefined, true);
    let res = null; try { res = JSON.parse(r.stdout); } catch { /* reported below */ }
    if (r.status !== 0 || !res || !Array.isArray(res.stdlib)) { out.py_leg = 'unverified'; out.py_error = pythonError(r); }
    else {
      out.py_leg = 'checked';
      const std = new Set(res.stdlib);
      for (const f of res.parse_errors) findings.push({ kind: 'offline-load', file: f, why: 'py-parse-error' });
      for (const f of py) for (const n of pyImportNames(f.text)) if (!std.has(n) && !toolNames.has(n)) findings.push({ kind: 'offline-load', file: f.file, why: 'py-package-import', spec: n });
    }
  }
  return out;
}

// ── client scrub (--scrub; item 5, owner decision 01-10 16:04: the installed profile carries the client-interaction
// rules, never personal data). REUSES the export scrub (personalPath, shipRules, rulesTail, redactTerms, leak rules) on
// the bytes an install WRITES:
//   excluded   personalPath() rows (ceo-model/...) and the per-machine GLOBAL_ONLY rows (they carry this machine's home
//              paths): status `personal-excluded`, never written, never in the ledger.
//   rules      the report-only rows (the repo's travelling CLAUDE.md rules, the credential-isolation standard) become
//              `rules-seed` rows: written where the destination has none, refreshed only while the ledger says the
//              harness owns an unmodified copy, NEVER written over a file the ledger does not know (a hand-made CLAUDE.md).
//   redaction  personal terms -> [personal-term] in every written row (regex-aware, as the exporter); in PROSE rows
//              (.md/.txt) machine paths -> <machine-path>, and the agent prologue drops the source machine's paths.
//   gate       after redaction: rule 21 (term) and 24 (money) in ANY row, 11-14/23 (machine path, user, origin
//              metadata) in PROSE rows refuse the run. Paths left in CODE rows are functional (defaults, deny strings):
//              reported per file as RESIDUAL, not refused -- a source fix is owed.
//   terms      --personal-terms <file> (repeatable) replaces the defaults <S>/meta/harness-plugin/personal-terms.local.txt
//              and <G>/harness-personal-terms.txt. NO list -> REFUSED (exit 3) unless --no-personal-terms says so: a
//              silent no-op scrub is exactly the failure this refuses.
export const MACHINE_SPECIFIC = new Set(GLOBAL_ONLY.map((g) => g.dst));
export const MONEY_RE = /\b(?:USD|ARS|EUR|GBP|U\$S|US\$)\s?\d[\d.,]*|[$€£]\s?\d{1,3}(?:[.,]\d{3})+\b|[$€£]\s?\d+(?:[.,]\d+)?\s?(?:k|mil)\b|\b\d[\d.,]*\s?(?:USD|ARS|EUR|d[oó]lares|dollars|pesos)\b/i;
export const MACHINE_PATH_RES = [/\b[A-Za-z]:[\\/]+(?:Users|dev|me)[\\/][^\s`'"<>|)\]]*/gi, /(?<![\w.~:])\/(?:home|Users)\/[A-Za-z0-9._-]+[^\s`'"<>|)\]]*/g];
export const MACHINE_PATH_PLACEHOLDER = '<machine-path>';
const PROSE_RE = /\.(md|txt)$/i;
export const INSTALL_RULES_HEADER = '# Service rules (harness install copy)\n\n'
  + '> Installed by `harness-install.mjs` from the harness source. Edit the source and run `update`: a local edit\n'
  + '> here is detected, reported and KEPT (overwritten only with --force).\n\n';
export function rulesSeedBytes(srcTxt) { const t = rulesTail(srcTxt); return t == null ? null : Buffer.from(INSTALL_RULES_HEADER + shipRules(t), 'utf8'); }
export function scrubBytes(file, buf, terms) {
  const red = redactTerms(buf.toString('utf8'), terms, { file }); let txt = red.text; let nMachine = 0;
  if (PROSE_RE.test(file)) for (const re of MACHINE_PATH_RES) txt = txt.replace(re, () => { nMachine++; return MACHINE_PATH_PLACEHOLDER; });
  return { buf: Buffer.from(txt, 'utf8'), n_terms: red.n, n_machine: nMachine };
}
export function personalFindings(file, txt, terms) {
  const termRes = (terms || []).map((t) => new RegExp(termRe(t).source, 'i'));
  const prose = PROSE_RE.test(file); const refuse = new Set(); const residual = new Set();
  for (const l of String(txt).split(/\r?\n/)) {
    const hits = leakRulesForLine(l, { termRes });
    if (MONEY_RE.test(l)) hits.push(24);
    for (const n of hits) {
      if (n === 21 || n === 24) refuse.add(n);
      else if ([11, 12, 13, 14, 23].includes(n)) (prose ? refuse : residual).add(n);
    }
  }
  return { refuse: [...refuse].sort((a, b) => a - b), residual: [...residual].sort((a, b) => a - b) };
}
/** All pre-flight checks. files: [{ file, buf }] = the bytes each writing row would write. */
export function payloadSafety(S, table, files, { toolNames = new Set(), scrub = false, terms = [], G = '' } = {}) {
  const findings = []; const residual = [];
  for (const r of table) {
    if (!r.src || r.mode === 'personal-excluded') continue;
    const at = symlinkedComponent(S, r.src);
    if (at) findings.push({ kind: 'symlink', file: r.src, why: `link-at:${at}` });
  }
  // I2 residue (2026-10-06, installer verifier A1): a junction/symlink INSIDE the destination (a managed folder or file)
  // would make every write and retire land in its target, outside what the harness owns. One finding per link. The
  // config folder itself is not checked: pointing ~/.claude at a dotfiles folder is a legitimate user choice.
  const seenDest = new Set();
  if (G) for (const r of table) {
    if (!r.dst || !['copy', 'seed-if-absent', 'rules-seed', 'retire'].includes(r.mode)) continue;
    const at = symlinkedComponent(G, r.dst);
    if (at && !seenDest.has(at)) { seenDest.add(at); findings.push({ kind: 'dest-link', file: r.dst, why: `link-at:${at}` }); }
  }
  for (const d of duplicateTargets(table)) findings.push({ kind: 'duplicate-target', file: d.dst, why: `rows:${d.srcs.length}` });
  for (const f of files) for (const ln of pipeToShellLines(f.file, f.buf.toString('utf8'))) findings.push({ kind: 'pipe-to-shell', file: f.file, line: ln });
  const off = offlineLoadFindings(files.map((f) => ({ file: f.file, text: f.buf.toString('utf8') })), { toolNames });
  findings.push(...off.findings);
  if (scrub) for (const f of files) {
    const p = personalFindings(f.file, f.buf.toString('utf8'), terms);
    if (p.refuse.length) findings.push({ kind: 'personal', file: f.file, rules: p.refuse });
    if (p.residual.length) residual.push({ file: f.file, rules: p.residual });
  }
  return { findings, residual, py_leg: off.py_leg, n_js_specs: off.n_js_specs };
}

// ── install ledger + doctor (I2, 2026-10-03) ─────────────────────────────────────────────────────────
// <G>/harness-install-ledger.json, written by every --apply: per installed file the sha256 of the bytes the harness
// WROTE there (raw + CRLF-normalised), the source sha, and the owner: harness | user-modified | machine-local, plus the
// install request (source, scrub, terms files) that `harness-install.mjs update` re-applies. On --apply an existing
// destination that differs from what the LEDGER says the harness last wrote is USER-MODIFIED: reported and SKIPPED,
// overwritten only with --force (backup kept). A destination with no ledger record keeps the old behaviour (backup, then
// overwrite), except rules-seed rows, which are never written over an unknown file.
export const LEDGER_FILE = 'harness-install-ledger.json';
export const LEDGER_SCHEMA = 'install-ledger-v1';
export function lfSha(buf) { return sha256(Buffer.from(Buffer.from(buf).toString('utf8').replace(/\r\n/g, '\n'), 'utf8')); }
export function readLedger(G) {
  try { const l = JSON.parse(fs.readFileSync(path.join(G, LEDGER_FILE), 'utf8')); return l && Array.isArray(l.files) ? l : null; } catch { return null; }
}
// The LEDGER is the only record of what the harness wrote in <G>. NOT the manifest: measured 2026-10-03, a read-only
// --check against the work profile (whose files are written by work_profile_sync.py, not by --apply) classified 6 files
// USER-MODIFIED from its copied manifest -- false. So protection starts at the first ledger-writing --apply; before
// that, a differing destination keeps the old behaviour (backup, then overwrite).
export function priorInstalled(G) {
  const map = new Map();
  const l = readLedger(G);
  if (l) for (const f of l.files) if (f && f.path && f.installed_sha256) map.set(f.path, { sha256: f.installed_sha256, sha256_lf: f.installed_sha256_lf || null, via: 'ledger', owner: f.owner });
  return map;
}
export function userModified(prior, dstBuf) {
  if (!prior) return false;
  if (sha256(dstBuf) === prior.sha256) return false;
  if (prior.sha256_lf && lfSha(dstBuf) === prior.sha256_lf) return false;   // a line-ending-only change is not an edit
  return true;
}
const DOCTOR_SKIP = /(^|\/)(__pycache__|node_modules)(\/|$)|\.bak-|\.retired-|\.removed-|\.(log|jsonl|pyc)$/i;
/** OK / MODIFIED-BY-USER / MISSING per ledger entry, EXTRA for unknown files in the managed sub-directories. Read-only. */
export function doctor(G) {
  const l = readLedger(G);
  if (!l) return { code: 3, reason: `no ${LEDGER_FILE} in ${G} (not installed by the installer?)`, rows: [], counts: {} };
  const rows = []; const known = new Set();
  for (const f of l.files) {
    known.add(String(f.path).toLowerCase());
    const abs = path.join(G, f.path);
    if (!fs.existsSync(abs)) { rows.push({ path: f.path, status: 'MISSING' }); continue; }
    if (f.owner === 'machine-local') { rows.push({ path: f.path, status: 'OK', note: 'machine-local' }); continue; }
    const b = fs.readFileSync(abs);
    const ok = sha256(b) === f.installed_sha256 || (!!f.installed_sha256_lf && lfSha(b) === f.installed_sha256_lf);
    rows.push({ path: f.path, status: ok ? 'OK' : 'MODIFIED-BY-USER', note: f.owner === 'user-modified' ? 'kept by an update' : '' });
  }
  const dirs = [...new Set(l.files.map((f) => String(f.path).split('/')).filter((p) => p.length > 1).map((p) => p[0]))];
  for (const d of dirs) for (const rel of walkFiles(path.join(G, d))) {
    const p = `${d}/${rel}`;
    if (!DOCTOR_SKIP.test(p) && !known.has(p.toLowerCase())) rows.push({ path: p, status: 'EXTRA' });
  }
  const counts = {}; for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
  return { code: (counts.MISSING || counts['MODIFIED-BY-USER']) ? 1 : 0, version: l.version, request: l.request, rows, counts };
}

// ── wiring (plan §8.1) ───────────────────────────────────────────────────────────────────────────
// The 10 generic hook entries (public package; 14 in the private source), in the shape a PROJECT gets them (portable, ${CLAUDE_PROJECT_DIR}).
const WIRED = [
  { event: 'Stop', file: 'evidence-gate.mjs', t: 10 },
  { event: 'Stop', file: 'ref-lint-gate.mjs', t: 15 },
  { event: 'Stop', file: 'memory-coherence.mjs', t: 15 },
  { event: 'Stop', file: '_discipline-meter-observe.mjs', t: 15 },
  { event: 'PreToolUse', matcher: '*', file: 'reversibility-guard.mjs', t: 10 },
  { event: 'PostToolUse', matcher: 'Read|Bash|Grep|Glob', file: 'injection-tripwire-observe.mjs', t: 10 },
  { event: 'SubagentStart', file: '_subagent-lifecycle-probe.mjs', t: 5 },
  { event: 'SubagentStop', file: '_subagent-lifecycle-probe.mjs', t: 5 },
  { event: 'StopFailure', file: '_subagent-lifecycle-probe.mjs', t: 5 },
  { event: 'ConfigChange', file: '_config-change-audit.mjs', t: 5 },
];
const INLINE_DATE = 'printf \'{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"Current local date/time: %s"}}\' "$(date \'+%a %Y-%m-%d %H:%M %z\')"';

function addEntry(map, event, matcher, entry) {
  if (!map[event]) map[event] = [];
  let g = map[event].find((x) => x.matcher === matcher);
  if (!g) { g = matcher === undefined ? { hooks: [] } : { matcher, hooks: [] }; map[event].push(g); }
  g.hooks.push(entry);
}

/** Project-shaped wiring (10 entries): portable exec-form, no runner, source timeouts. */
export function wireProject(selection = null) {
  const m = {};
  for (const w of WIRED.filter(w => !selection || selection.hooks.includes(w.file))) {
    addEntry(m, w.event, w.matcher, {
      type: 'command', command: 'node',
      args: ['${CLAUDE_PROJECT_DIR}/.claude/hooks/' + w.file], timeout: w.t,
    });
  }
  return m;
}

/** Global wiring (16 entries): absolute paths into <G>, every hook behind _global-runner.mjs,
 *  the seeder wired DIRECTLY at SessionStart, plus the byte-identical inline date entry.
 *  Timeouts = source timeout + 2 s for the runner's extra process. */
export function wireGlobal(G, selection = null) {
  const g = norm0(G);
  const m = {};
  if (!selection) {
    addEntry(m, 'SessionStart', undefined, { type: 'command', command: 'node', args: [`${g}/tools/harness-seed.mjs`], timeout: 20 });
    addEntry(m, 'UserPromptSubmit', undefined, { type: 'command', command: INLINE_DATE, timeout: 5 });
  }
  for (const w of WIRED.filter(w => !selection || selection.hooks.includes(w.file))) {
    addEntry(m, w.event, w.matcher, {
      type: 'command', command: 'node',
      args: [`${g}/hooks/_global-runner.mjs`, w.file], timeout: w.t + 2,
    });
  }
  return m;
}
function norm0(p) { return String(p).split(BS).join('/').replace(/\/+$/, ''); }

const README_NOTE = 'HOOKS NOTE (harness deploy): these hooks were installed by the harness deploy script; see docs/harness/INSTALL.md. Hooks are wired here with ABSOLUTE paths, every one behind hooks/_global-runner.mjs, which SKIPS the global copy in the source repo, in any project that already wires the same hook, in an opted-out folder (.claude/NO-HARNESS), under a denylisted root, and whenever HARNESS_GLOBAL_OFF=1 — so nothing double-fires. Re-sync with tools/sync-harness-from-source.mjs.';

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function stamp() { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
function backupPath(dst) {
  let cand = `${dst}.bak-${stamp()}`;
  if (!fs.existsSync(cand)) return cand;
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  let i = 0; let c = `${dst}.bak-${stamp()}-${p(d.getHours())}${p(d.getMinutes())}`;
  while (fs.existsSync(c)) c = `${dst}.bak-${stamp()}-${p(d.getHours())}${p(d.getMinutes())}-${++i}`;
  return c;
}

// ── plugin export + leak check (plan manifest 2026-09-25, steps P1 / P4 / P5 / P6) ─────────────────
// EXTENDS the payload table above: the plugin payload is DERIVED from HOOKS / TOOLS / AGENTS / LENSES /
// WIRED + the import closure. The only hand-named rows are the four files that exist only in plugin
// form (the Node date hook, the bootstrap, the credential-isolation and verifier-creation standards copied by the bootstrap).
const PLUGIN_NAME = 'harness';
const PLUGIN_VERSION = '0.1.0';
const MARKETPLACE_NAME = 'claude-harness';
const PLUGIN_DIR = `plugins/${PLUGIN_NAME}`;
const PLUGIN_NOT_SHIPPED_TOOLS = new Set(['tools/harness-seed.mjs', 'tools/sync-harness-from-source.mjs',
  'tools/work_profile_sync.py', 'tools/statusline_meters.mjs', 'tools/statusline_meters.test.mjs', 'tools/usage_meters.py']);   // GLOBAL_ONLY tools
export const PLUGIN_WIRED = WIRED.concat([{ event: 'UserPromptSubmit', file: '_date-context.mjs', t: 5 }]);
const PERSONAL_PATH_RES = [
  /(^|\/)ceo-model\//i, /(^|\/)memory\//i, /(^|\/)projects\//i, /(^|\/)\.credentials/i, /(^|\/)settings[^/]*\.json$/i,
  /\.log$/i, /(^|\/)MEMORY\.md$/i, /(^|\/)decisions\.md$/i, /(^|\/)harness-MANIFEST\.json$/i, /(^|\/)HARNESS-SEEDED\.json$/i,
];
export function personalPath(rel) { const s = String(rel || '').split(BS).join('/'); return PERSONAL_PATH_RES.some((re) => re.test(s)); }

// PLUGIN prologue. Round 3 (2026-10-03, verifier A3): it used to say "skip it silently", so a plugin install skipped the
// secret scan (coder.md `py .claude/tools/secret_scan.py`) without a word in 16/16 agents. Same report wording as the
// GLOBAL_PROLOGUE below, and it points at the plugin's own tools/ dir (the plugin ships tools/secret_scan.py).
export const AGENT_PROLOGUE = '\n> Portability note (harness plugin): paths under `meta/`, `../meta/`, `ceo-model/` and `.claude/tools/` belong to the harness-source project. In any other project treat each such path as IF PRESENT: check that it exists first and never create it; when it is absent, skip that step and NAME the skipped step in your report (SIN-PROBAR); never skip a step without saying so. A SAFETY tool is never skipped quietly: if a mandatory safety step cannot run because its tool (for example the secret scan `secret_scan.py`) is missing both in the project and in this plugin, REPORT it at the top of your output as `SAFETY TOOL MISSING: <name>` and treat that work as unverified. A file named under `.claude/tools/` that the project lacks ships with this plugin instead, under `tools/` in the plugin install dir (the folder that holds this agent file\'s `agents/`, `hooks/` and `tools/`; hook commands name it `${CLAUDE_PLUGIN_ROOT}`): use that copy when it is there.\n\n';
export function splitFrontmatter(txt) {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(String(txt));
  return m ? { fm: m[0], body: String(txt).slice(m[0].length) } : null;
}
export function injectPrologue(txt) { const s = splitFrontmatter(txt); return s ? s.fm + AGENT_PROLOGUE + s.body : null; }
// GLOBAL-COPY prologue (portability fix 2026-10-01). The user-level copies of the agents, lenses and the copied
// standard are read in projects that do not hold this repo; measured 2026-10-01 in the work profile: investigator.md
// pointed at .claude/tools/sci_source.py, which exists only here. The repo copies stay byte-unchanged (behaviour in
// this repo is identical); only the bytes the sync deploys carry this note, inserted after the frontmatter (or at the
// top when there is none), and --check compares those deployed bytes. Report-only rows are never written, so the
// pinned credential-isolation.md is untouched by construction.
export const GLOBAL_PROLOGUE = '\n> Portability note (harness global copy): paths under `meta/`, `../meta/`, `ceo-model/`, `.claude/tools/`, `.claude/hooks/`, `.claude/lenses/`, `<harness-source>\\` and `c:\\work-root\\` come from the harness-source project and its machine and may not exist here. In any other project treat each such path as IF PRESENT: check that it exists first and never create it; when it is absent, skip that step and NAME the skipped step in your report (SIN-PROBAR); never skip a step without saying so. A SAFETY tool is never skipped quietly: if a mandatory safety step cannot run because its tool (for example the secret scan `secret_scan.py`) is missing both here and in the harness config dir, REPORT it at the top of your output as `SAFETY TOOL MISSING: <name>` and treat that work as unverified. A file named under `.claude/tools/`, `.claude/lenses/` or `ceo-model/` that the project lacks may sit next to this agent instead, in the harness config dir (`$CLAUDE_CONFIG_DIR`, default `~/.claude`) under `tools/`, `lenses/` or `ceo-model/`: use that copy when it is there.\n\n';
// --scrub (installer) prologue: the same note without the source machine's two paths (item 5, 2026-10-03).
export const CLIENT_PROLOGUE = GLOBAL_PROLOGUE.replace(/, `<harness-source>\\` and `c:\\work-root\\`/, '').replace(' and its machine', '');
export function deployBytes(row, buf, prologue = GLOBAL_PROLOGUE) {
  if (!row || row.mode !== 'copy' || !/^(agents|lenses|standards)\/[^/]+\.md$/.test(row.dst)) return buf;
  const txt = buf.toString('utf8'); const s = splitFrontmatter(txt);
  return Buffer.from(s ? s.fm + prologue + s.body : prologue.slice(1) + txt, 'utf8');
}
/** P4 checker leg: an exported agent vs its source text. The tail (body after the prologue) must hash equal. */
export function agentExportCheck(exported, source) {
  const e = splitFrontmatter(exported); const s = splitFrontmatter(source);
  if (!e || !s) return { prologue_ok: false, tail_hash_ok: false };
  const prologue_ok = e.fm === s.fm && e.body.startsWith(AGENT_PROLOGUE);
  const tail = e.body.startsWith(AGENT_PROLOGUE) ? e.body.slice(AGENT_PROLOGUE.length) : e.body;
  return { prologue_ok, tail_hash_ok: sha256(Buffer.from(tail, 'utf8')) === sha256(Buffer.from(s.body, 'utf8')) };
}

export const RULES_HEADER = '# Service rules (global) - harness plugin copy\n\n'
  + '> Installed into the Claude config dir by `bootstrap/bootstrap.mjs` of the harness plugin repository.\n'
  + '> Source of truth: the harness-source project. Edit there, re-export, re-run the bootstrap; a local edit\n'
  + '> is overwritten (the bootstrap keeps a backup). Rules on HOW to work and answer, nothing machine-specific.\n\n';
/** The rules tail = from the first "## " heading to the end (the origin blockquote above it is dropped). */
export function rulesTail(txt) { const s = String(txt); const i = s.search(/^## /m); return i < 0 ? null : s.slice(i); }
// Round 4 (coordinator ruling 2026-09-25): the shipped rules copy never carries the source machine's sync metadata. A contiguous
// blockquote that starts at a 'INSTALLED copy' line, and any line naming a C:/dev, C:/me or C:/Users path, collapse into ONE line.
export const RULES_ORIGIN_REPLACEMENT = "> Installed from the owner's harness plugin; the sync metadata of the source machine is not shipped.";
export function shipRules(tail) {
  if (tail == null) return tail;
  const out = []; let inOrigin = false; let replaced = false;
  const once = () => { if (!replaced) { out.push(RULES_ORIGIN_REPLACEMENT); replaced = true; } };
  for (const l of String(tail).split('\n')) {
    if (inOrigin) { if (/^\s*>/.test(l)) continue; inOrigin = false; }
    if (/^\s*>/.test(l) && /INSTALLED copy/.test(l)) { inOrigin = true; once(); continue; }
    if (/\b[A-Za-z]:[/\x5c]+(?:dev|me|Users)[/\x5c]/i.test(l)) { once(); continue; }
    out.push(l);
  }
  return out.join('\n');
}

// ── personal-terms redaction + strict YAML (Round 2, 2026-09-25) ────────────────────────────────────
// A per-machine terms file (NEVER shipped, NEVER printed) drives (1) export-time redaction of the SHIPPED copy and
// (2) leak rule 21. Default: <S>/meta/harness-plugin/personal-terms.local.txt (gitignored), else
// <configDir>/harness-personal-terms.txt. Whole-word, case-insensitive; whitespace in a term matches any whitespace run.
export function loadPersonalTerms(p) {
  if (!p || !fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).sort((a, b) => b.length - a.length);
}
export function termRe(t) { return new RegExp('(?<![A-Za-z0-9])' + String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+') + '(?![A-Za-z0-9])', 'gi'); }
export const REDACTION_PLACEHOLDER = '[personal-term]';
// Round 5 (re-gate A1, 2026-09-25): inside a REGEX the bracket placeholder becomes a character class and changes behaviour
// (measured: 5 of 6 polite prompts flagged by the shipped detector). There a term becomes the 6-char escape : one
// private-use code point, valid in every JS/PY regex (literal or string form), never present in real text.
export const REGEX_INERT = '\\uE000';
const RE_CALL_JS = /(?:^|[^\w$.])(?:new\s+)?RegExp\s*$/;
const RE_CALL_PY = /\bre\s*\.\s*(?:compile|search|match|fullmatch|sub|subn|split|findall|finditer)\s*$/;
const JS_RE_AFTER_WORD = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await', 'instanceof']);
/** [start,end) spans of a JS source that are REGEX text: regex literals, and string/template chunks inside the arguments of a RegExp( call. */
export function jsRegexSpans(src) {
  const s = String(src); const n = s.length; const spans = []; const stack = [];
  let i = 0; let last = '';   // last significant token: '' | a word | a punctuation char | 'lit'
  const inCall = () => stack.some((e) => e.re);
  const tmpl = (from) => {     // scan template text from `from` to the closing backtick or a `${`
    let j = from;
    while (j < n && s[j] !== '`') { if (s[j] === '\\') { j += 2; continue; } if (s[j] === '$' && s[j + 1] === '{') break; j++; }
    return j;
  };
  const afterTmpl = (start, j) => {
    if (inCall()) spans.push([start, Math.min(j + 1, n)]);
    if (j < n && s[j] === '$') { stack.push({ ch: '${', re: false }); i = j + 2; last = '{'; } else { i = j + 1; last = 'lit'; }
  };
  while (i < n) {
    const c = s[i]; const d = s[i + 1];
    if (c === '/' && d === '/') { const e = s.indexOf('\n', i); i = e < 0 ? n : e; continue; }
    if (c === '/' && d === '*') { const e = s.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === "'" || c === '"') {
      let j = i + 1; while (j < n && s[j] !== c && s[j] !== '\n') j += s[j] === '\\' ? 2 : 1;
      if (inCall()) spans.push([i, Math.min(j + 1, n)]);
      i = j + 1; last = 'lit'; continue;
    }
    if (c === '`') { afterTmpl(i, tmpl(i + 1)); continue; }
    if (c === '}' && stack.length && stack[stack.length - 1].ch === '${') { stack.pop(); afterTmpl(i, tmpl(i + 1)); continue; }
    if (c === '/') {
      const isRe = last === '' || JS_RE_AFTER_WORD.has(last) || (last.length === 1 && '(,=:[!&|?{};+-*%<>~^'.includes(last));
      if (!isRe) { last = '/'; i++; continue; }
      let j = i + 1; let cls = false;
      while (j < n && s[j] !== '\n') { const x = s[j]; if (x === '\\') { j += 2; continue; } if (cls) { if (x === ']') cls = false; } else if (x === '[') cls = true; else if (x === '/') break; j++; }
      j++; while (j < n && /[a-z]/i.test(s[j])) j++;
      spans.push([i, j]); i = j; last = 'lit'; continue;
    }
    if (/[\w$]/.test(c)) { let j = i; while (j < n && /[\w$]/.test(s[j])) j++; last = s.slice(i, j); i = j; continue; }
    if (c === '(' || c === '[' || c === '{') stack.push({ ch: c, re: c === '(' && RE_CALL_JS.test(s.slice(Math.max(0, i - 40), i)) });
    else if ((c === ')' || c === ']' || c === '}') && stack.length) stack.pop();
    last = c; i++;
  }
  return spans;
}
/** [start,end) spans of a Python source that are REGEX text: raw strings, and any string inside the arguments of a re.<fn>( call. */
export function pyRegexSpans(src) {
  const s = String(src); const n = s.length; const spans = []; const stack = [];
  let i = 0;
  while (i < n) {
    const c = s[i];
    if (c === '#') { const e = s.indexOf('\n', i); i = e < 0 ? n : e; continue; }
    if (c === "'" || c === '"') {
      const pre = /([rRbBuUfF]{1,2})$/.exec(s.slice(Math.max(0, i - 2), i)); const raw = !!(pre && /r/i.test(pre[1]) && !/[\w]/.test(s[i - pre[1].length - 1] || ''));
      const q3 = s.startsWith(c.repeat(3), i); const q = q3 ? c.repeat(3) : c;
      let j = i + q.length; while (j < n && !s.startsWith(q, j) && (q3 || s[j] !== '\n')) j += s[j] === '\\' ? 2 : 1;
      const e = Math.min(j + q.length, n);
      if (raw || stack.some((x) => x.re)) spans.push([i, e]);
      i = e; continue;
    }
    if (c === '(' || c === '[' || c === '{') stack.push({ re: c === '(' && RE_CALL_PY.test(s.slice(Math.max(0, i - 40), i)) });
    else if ((c === ')' || c === ']' || c === '}') && stack.length) stack.pop();
    i++;
  }
  return spans;
}
export function regexSpansFor(file, txt) {
  if (/\.(mjs|js|cjs)$/i.test(String(file || ''))) return jsRegexSpans(txt);
  if (/\.py$/i.test(String(file || ''))) return pyRegexSpans(txt);
  return [];
}
/** One pass, longest term first. `file` picks the context lexer: in a regex span -> REGEX_INERT, elsewhere -> REDACTION_PLACEHOLDER. */
export function redactTerms(txt, terms, { file = '' } = {}) {
  const s = String(txt);
  if (!terms || !terms.length) return { text: s, n: 0, n_regex: 0 };
  const alt = [...terms].sort((a, b) => b.length - a.length).map((t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')).join('|');
  const re = new RegExp('(?<![A-Za-z0-9])(?:' + alt + ')(?![A-Za-z0-9])', 'gi');
  const spans = regexSpansFor(file, s); let n = 0; let nRe = 0;
  const text = s.replace(re, (m, off) => { n++; const inRe = spans.some(([a, b]) => off >= a && off < b); if (inRe) nRe++; return inRe ? REGEX_INERT : REDACTION_PLACEHOLDER; });
  return { text, n, n_regex: nRe };
}
export function defaultPersonalTermsPath(S) {
  const a = path.join(S, 'meta', 'harness-plugin', 'personal-terms.local.txt');
  if (fs.existsSync(a)) return a;
  const c = path.join(resolvedConfigDir(), 'harness-personal-terms.txt');
  return fs.existsSync(c) ? c : '';
}
/** Strict YAML parse (PyYAML safe_load via the Python resolver) of agent frontmatters: [{name, yaml}] -> { ok, bad[] }. */
export function strictYamlCheck(list) {
  const code = 'import sys,json,yaml\nd=json.load(sys.stdin)\nbad=[]\nfor x in d:\n  try:\n    v=yaml.safe_load(x["yaml"])\n    assert isinstance(v,dict)\n  except Exception:\n    bad.append(x["name"])\nprint(json.dumps(bad))';
  const r = spawnPython(['-c', code], { input: JSON.stringify(list), encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } }, undefined, true);
  if (r.status !== 0) return { ok: false, bad: list.map((x) => x.name), error: `${pythonError(r)} PyYAML is also required.` };
  return { ok: true, bad: JSON.parse(r.stdout) };
}
export const fmYaml = (fm) => String(fm).replace(/^---\r?\n/, '').replace(/\r?\n---\r?\n$/, '');

export function pluginPayload(S, { inject = [] } = {}) {
  const { table, unresolved } = fullTable(S);
  const rows = []; const excluded = [];
  for (const r of table) {
    if (r.mode !== 'copy') { if (r.src) excluded.push({ path: r.src, why: `sync-${r.mode}` }); continue; }
    if (r.dst.startsWith('hooks/')) rows.push({ src: r.src, dst: `${PLUGIN_DIR}/${r.dst}`, kind: 'hook' });
    else if (r.dst.startsWith('tools/')) {
      if (PLUGIN_NOT_SHIPPED_TOOLS.has(r.dst)) excluded.push({ path: r.src, why: 'per-machine-tool' });
      else rows.push({ src: r.src, dst: `${PLUGIN_DIR}/${r.dst}`, kind: 'tool' });
    } else if (r.dst.startsWith('agents/')) rows.push({ src: r.src, dst: `${PLUGIN_DIR}/${r.dst}`, kind: 'agent' });
    else if (r.dst.startsWith('lenses/')) rows.push({ src: r.src, dst: `bootstrap/${r.dst}`, kind: 'lens' });
    else excluded.push({ path: r.src, why: 'personal-or-not-shipped' });
  }
  rows.push({ src: '.claude/global-layer/_date-context.mjs', dst: `${PLUGIN_DIR}/hooks/_date-context.mjs`, kind: 'hook' });
  rows.push({ src: '.claude/standards/credential-isolation.md', dst: 'bootstrap/standards/credential-isolation.md', kind: 'standard' });
  rows.push({ src: '.claude/standards/verifier-creation.md', dst: 'bootstrap/standards/verifier-creation.md', kind: 'standard' });
  rows.push({ src: '.claude/global-layer/bootstrap.mjs', dst: 'bootstrap/bootstrap.mjs', kind: 'bootstrap' });
  for (const x of inject) rows.push(x);
  return { rows, excluded, unresolved };
}

export function payloadStats(rows) {
  const hookFiles = new Set(rows.filter((r) => r.kind === 'hook').map((r) => r.dst.split('/').pop()));
  const wired = [...new Set(PLUGIN_WIRED.map((w) => w.file))];
  return {
    agents: rows.filter((r) => r.kind === 'agent').length,
    wired_hook_files: wired.filter((f) => hookFiles.has(f)).length,
    wired_hook_files_missing: wired.filter((f) => !hookFiles.has(f)),
    personal_paths_included: rows.filter((r) => personalPath(r.src) || personalPath(r.dst)).length,
  };
}

export function runnerCommand(file) { return 'node "${CLAUDE_PLUGIN_ROOT}/hooks/_global-runner.mjs" --data "${CLAUDE_PLUGIN_DATA}" ' + file; }
export function pluginHooksJson() {
  const m = {};
  for (const w of PLUGIN_WIRED) addEntry(m, w.event, w.matcher, { type: 'command', command: runnerCommand(w.file), timeout: w.t + 2 });
  return { hooks: m };
}

const EXPORT_README = [
  '# claude-harness', '',
  'A Claude Code plugin marketplace with one plugin, `harness` (version ' + PLUGIN_VERSION + '): 16 agents (listed as `harness:<name>`)',
  'and the harness hooks. Every hook is routed through `hooks/_global-runner.mjs`, the double-fire guard: a project that is the',
  'harness source, opts out (`.claude/NO-HARNESS`), or wires the same hook itself is skipped. `HARNESS_GLOBAL_OFF=1` turns all hooks off.', '',
  '## Install (2 commands + bootstrap)', '',
  '```', 'claude plugin marketplace add <path or git URL of this repository>', 'claude plugin install harness@claude-harness --scope user',
  'node bootstrap/bootstrap.mjs', '```', '',
  'The bootstrap copies the global rules file, the credential-isolation standard and two review lenses into the Claude config dir',
  '(`CLAUDE_CONFIG_DIR`, else `~/.claude`) and backs up anything it overwrites. It never writes settings, plugins or credentials.',
  'Options: `--config-dir <dir>`, `--personal <path to a ceo-model.md>`, `--deny-root <dir>` (repeatable: a folder the hooks must',
  'never touch), `--check` (report only, no writes).', '',
  '## Uninstall', '',
  '```', 'claude plugin uninstall harness@claude-harness --scope user', 'claude plugin marketplace remove claude-harness', '```', '',
  'The bootstrap files stay in the config dir; remove them by hand if wanted (their backups sit next to them).', '',
].join('\n');

function walkFiles(root, rel = '') {
  const out = [];
  let ents = [];
  try { ents = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (e.name !== '.git') out.push(...walkFiles(root, r)); } else if (e.isFile()) out.push(r);
  }
  return out.sort();
}
export function treeSha(files) {
  const lines = Object.keys(files).filter((p) => p !== 'EXPORT-MANIFEST.json').sort().map((p) => `${sha256(files[p])}  ${p}\n`);
  return sha256(Buffer.from(lines.join(''), 'utf8'));
}
function insideDir(child, parent) { const c = norm(path.resolve(child)); const p = norm(path.resolve(parent)); return c === p || c.startsWith(p + '/'); }
function resolvedConfigDir() { const c = (process.env.CLAUDE_CONFIG_DIR || '').trim(); return c || path.join(os.homedir(), '.claude'); }

export const DETECTOR_DST = `${PLUGIN_DIR}/hooks/correction-detector.mjs`;
/** Runs <S>/.claude/global-layer/detector-parity.mjs on (source detector, shipped bytes). Fail-closed: any error -> detector_parity_ok 0. */
export function detectorParity(srcAbs, shippedBuf, S) {
  const tool = path.join(S, '.claude', 'global-layer', 'detector-parity.mjs');
  if (!fs.existsSync(tool)) return { detector_parity_ok: 0, error: 'parity-tool-missing' };
  const tf = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'harness detector parity ')), 'correction-detector.mjs');
  fs.writeFileSync(tf, shippedBuf);
  const r = spawnSync(process.execPath, [tool, srcAbs, tf], { encoding: 'utf8' });
  try { const j = JSON.parse(String(r.stdout).trim().split('\n').pop()); if (r.status !== 0) j.detector_parity_ok = 0; return j; } catch { return { detector_parity_ok: 0, error: `parity-exit-${r.status}` }; }
}

/** Build the export in memory; write it only when !dryRun and nothing was blocked. Never deletes. */
export function exportPlugin(S, target, { dryRun = false, rulesSrc = '', inject = [], personalTerms = null } = {}) {
  const T = path.resolve(target);
  const out = { mode: 'export-plugin', target: T, dry_run: dryRun, agents: 0, wired_hook_files: 0, personal_paths_included: 0,
    hooks_entries: 0, prologue_ok: 0, tail_hash_ok: 0, rules_tail_hash_ok: 0, yaml_strict_ok: 0, yaml_bad: [], personal_terms_rules: 0, redactions: 0, redactions_regex: 0, redacted_files: [], redaction_syntax_fail: 0, detector_parity_ok: 0, detector_parity: null, n_files: 0, tree_sha256: '', blocked: [], missing: [],
    unresolved: [], stale: [], excluded: [], refused: '' };
  if (insideDir(T, S)) out.refused = 'target-inside-source-repo';
  else if (insideDir(T, resolvedConfigDir())) out.refused = 'target-inside-config-dir';
  else if (underTrading(T)) out.refused = 'target-under-denylisted-root';
  else if (!dryRun && fs.existsSync(T) && !fs.existsSync(path.join(T, 'EXPORT-MANIFEST.json'))
    && fs.readdirSync(T).some((n) => n !== '.git')) out.refused = 'target-not-empty-and-not-an-export';
  if (out.refused) return { out, code: 3 };

  const { rows, excluded, unresolved } = pluginPayload(S, { inject });
  Object.assign(out, payloadStats(rows));
  out.excluded = excluded; out.unresolved = unresolved;
  const files = {};
  const terms = personalTerms ?? loadPersonalTerms(defaultPersonalTermsPath(S));
  out.personal_terms_rules = terms.length;
  // Round 5 (re-gate A3): FAIL-CLOSED. Without the per-machine terms file (missing or 0 rules) an export would ship the raw terms
  // and the leak check would be blind to them, so the export refuses and writes nothing.
  if (!terms.length) { out.refused = 'TERMS_MISSING'; return { out, code: 4 }; }
  const yamlList = [];
  const redact = (dst, text) => { const rr = redactTerms(text, terms, { file: dst }); if (rr.n) { out.redactions += rr.n; out.redactions_regex += rr.n_regex; out.redacted_files.push(dst); } return rr.text; };
  for (const r of rows) {
    const abs = path.join(S, r.src);
    if (filenameDenied(r.src)) { out.blocked.push({ path: r.src, rules: ['filename-denylist'] }); continue; }
    if (!fs.existsSync(abs)) { out.missing.push(r.src); continue; }
    const buf = fs.readFileSync(abs);
    const v = guardViolations(buf);
    if (v.length) { out.blocked.push({ path: r.src, rules: v }); continue; }
    if (r.kind === 'agent') {
      const sp = splitFrontmatter(buf.toString('utf8'));
      if (sp) yamlList.push({ name: r.dst.split('/').pop(), yaml: fmYaml(sp.fm) });
      const txt = injectPrologue(redact(r.dst, buf.toString('utf8')));
      if (txt === null) { out.blocked.push({ path: r.src, rules: ['no-frontmatter'] }); continue; }
      const c = agentExportCheck(txt, buf.toString('utf8'));
      if (c.prologue_ok) out.prologue_ok++;
      if (c.tail_hash_ok) out.tail_hash_ok++;
      files[r.dst] = Buffer.from(txt, 'utf8');
    } else if (/\.(mjs|js|cjs|py|md|json|txt)$/i.test(r.dst)) {
      const red = redact(r.dst, buf.toString('utf8'));
      if (red !== buf.toString('utf8')) {
        if (/\.(mjs|js|cjs)$/i.test(r.dst)) {
          const tf = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'harness redaction check ')), path.basename(r.dst));
          fs.writeFileSync(tf, red, 'utf8');
          if (spawnSync(process.execPath, ['--check', tf], { encoding: 'utf8' }).status !== 0) out.redaction_syntax_fail++;
        }
        files[r.dst] = Buffer.from(red, 'utf8');
      } else files[r.dst] = buf;
    } else files[r.dst] = buf;
  }
  const rsPath = rulesSrc || path.join(os.homedir(), '.claude', 'CLAUDE.md');
  let rulesSrcTxt = '';
  try { rulesSrcTxt = fs.readFileSync(rsPath, 'utf8'); } catch { out.missing.push('rules-source:CLAUDE.md'); }
  const tail = rulesTail(rulesSrcTxt);
  if (tail !== null) {
    const shippedTail = redact('bootstrap/rules/CLAUDE.md', shipRules(tail)); const rb = Buffer.from(RULES_HEADER + shippedTail, 'utf8');
    const v = guardViolations(rb);
    if (v.length) out.blocked.push({ path: 'rules-source:CLAUDE.md', rules: v });
    else {
      files['bootstrap/rules/CLAUDE.md'] = rb;
      out.rules_tail_hash_ok = sha256(Buffer.from(rulesTail(rb.toString('utf8')), 'utf8')) === sha256(Buffer.from(shippedTail, 'utf8')) ? 1 : 0;
    }
  }
  // Round 5 (re-gate A2): BEHAVIOUR parity of the shipped correction detector vs its source on the fixed neutral corpus.
  { const row = rows.find((r) => r.dst === DETECTOR_DST); const pr = row && files[DETECTOR_DST] ? detectorParity(path.join(S, row.src), files[DETECTOR_DST], S) : { detector_parity_ok: 0, error: 'detector-not-in-payload' };
    out.detector_parity = pr; out.detector_parity_ok = pr.detector_parity_ok === 1 ? 1 : 0; }
  const yc = strictYamlCheck(yamlList);
  out.yaml_strict_ok = yamlList.length - yc.bad.length; out.yaml_bad = yc.bad; if (!yc.ok) out.yaml_error = yc.error;
  const hj = pluginHooksJson();
  out.hooks_entries = Object.values(hj.hooks).flat().reduce((n, g) => n + g.hooks.length, 0);
  const j = (o) => Buffer.from(JSON.stringify(o, null, 2) + '\n', 'utf8');
  files[`${PLUGIN_DIR}/hooks/hooks.json`] = j(hj);
  files[`${PLUGIN_DIR}/.claude-plugin/plugin.json`] = j({ name: PLUGIN_NAME, version: PLUGIN_VERSION,
    description: 'The harness: 16 review/build/verify agents and the guard and observe hooks, every hook routed through one runner with a double-fire guard.',
    author: { name: 'harness-maintainer' } });
  files['.claude-plugin/marketplace.json'] = j({ name: MARKETPLACE_NAME, owner: { name: 'harness-maintainer' }, description: 'The harness as one Claude Code plugin: agents plus runner-routed guard and observe hooks.',
    plugins: [{ name: PLUGIN_NAME, source: `./${PLUGIN_DIR}`, description: 'The harness agents and runner-routed hooks.' }] });
  files['README.md'] = Buffer.from(EXPORT_README, 'utf8');
  // A3 (P9 gate, 2026-09-25): runtime logs must never enter the export repo. Hooks log under ${CLAUDE_PLUGIN_DATA}/logs (the runner
  // exports HARNESS_LOG_DIR); this file keeps any stray log or data dir out of git if one ever lands in the tree.
  files['.gitignore'] = Buffer.from(['# runtime artefacts of the installed plugin: never commit', '*.log', 'logs/', 'data/', ''].join('\n'), 'utf8');
  const head = spawnSync('git', ['-C', S, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  const dirty = spawnSync('git', ['-C', S, 'status', '--porcelain', '--', '.claude/global-layer', '.claude/agents', '.claude/hooks', '.claude/tools', '.claude/lenses', '.claude/standards'], { encoding: 'utf8' });
  out.tree_sha256 = treeSha(files);
  files['EXPORT-MANIFEST.json'] = j({ schema: 'harness-export-v1', plugin: PLUGIN_NAME, plugin_version: PLUGIN_VERSION,
    source_head: String(head.stdout || '').trim(), source_payload_dirty: String(dirty.stdout || '').trim().length > 0,
    tree_sha256: out.tree_sha256,
    files: Object.keys(files).filter((p) => p !== 'EXPORT-MANIFEST.json').sort().map((p) => ({ path: p, sha256: sha256(files[p]) })),
    excluded: excluded.map((e) => e.path) });
  out.n_files = Object.keys(files).length;
  if (fs.existsSync(T)) out.stale = walkFiles(T).filter((p) => !(p in files));
  const bad = out.personal_paths_included > 0 || out.missing.length > 0 || out.unresolved.length > 0
    || out.prologue_ok !== out.agents || out.tail_hash_ok !== out.agents || out.rules_tail_hash_ok !== 1
    || out.yaml_strict_ok !== out.agents || out.redaction_syntax_fail > 0 || out.detector_parity_ok !== 1;
  if (out.blocked.length) return { out, code: 2 };
  if (!dryRun && !bad) {
    for (const [p, b] of Object.entries(files)) { const d = path.join(T, p); fs.mkdirSync(path.dirname(d), { recursive: true }); fs.writeFileSync(d, b); }
  }
  return { out, code: bad ? 1 : 0 };
}

// ── leak check (P6): RULES 1-10 unchanged + rules 11-20. Prints path + line + rule only, never the text. ─
export function publicIPv4(line) {
  for (const m of String(line).matchAll(/(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?!\.?\d)/g)) {
    const o = m.slice(1, 5).map(Number);
    if (o.some((x) => x > 255)) continue;
    const [a, b, c] = o;
    if (a === 0 || a === 10 || a === 127 || a >= 224) continue;
    if ((a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)) continue;
    if ((a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) continue;
    return true;
  }
  return false;
}
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function osUser() { try { return os.userInfo().username || ''; } catch { return ''; } }
export function leakRulesForLine(l, { isJson = false, userRe = null, termRes = [] } = {}) {
  const hits = [];
  for (const r of RULES) if (r.re.test(l)) hits.push(r.n);
  if (/\b[A-Za-z]:[\\/]+Users[\\/]+(?![<%${])(?!(?:Public|Default|All Users)\b)[^\\/\s"'`<>|]+/i.test(l)) hits.push(11);
  if (/(?<![\w.~:])\/(?:home|Users)\/(?![<%${])[A-Za-z0-9._-]+/.test(l)) hits.push(12);
  if (/\b[A-Za-z]:[\\/]+(?:dev|me)[\\/]/i.test(l)) hits.push(13);
  if (userRe && userRe.test(l)) hits.push(14);
  if (/\bssh\b.*\broot@|\broot@\d{1,3}(?:\.\d{1,3}){3}\b/.test(l)) hits.push(15);
  if (publicIPv4(l)) hits.push(16);
  if ((isJson && /"model"\s*:/.test(l)) || /^\s*model:\s*["']?claude-/.test(l) || /\bclaude-(?:[a-z]+-\d+|\d+(?:-\d+)?-[a-z]+)\b/i.test(l)) hits.push(17);
  if (isJson && /"permissions"\s*:/.test(l)) hits.push(18);
  if (/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(l)) hits.push(19);
  if (termRes.some((re) => re.test(l))) hits.push(21);   // per-machine personal terms (never printed)
  if (/\.claude[\\/]+projects\b/i.test(l)) hits.push(22);   // any reference into the per-user transcript/memory store
  if (/INSTALLED copy|Origin of this copy|Drift check/i.test(l)) hits.push(23);   // source-machine origin metadata of the rules copy
  return hits;
}
/** Allowlist rows in a markdown table: | <file> | <rule> | <line sha256, first 16 hex> | <justification> | */
export function loadAllowlist(p) {
  const keys = new Set();
  if (!p || !fs.existsSync(p)) return keys;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^\|\s*([^|]+?)\s*\|\s*(\d+)\s*\|\s*([0-9a-f]{16})\s*\|\s*\S/.exec(line);
    if (m) keys.add(`${m[1]}|${m[2]}|${m[3]}`);
  }
  return keys;
}
export function leakCheck(dir, { allowlistPath = '', user = osUser(), terms = [] } = {}) {
  const termRes = terms.map((t) => new RegExp(termRe(t).source, 'i'));
  const allow = loadAllowlist(allowlistPath);
  const userRe = user ? new RegExp(`\\b${escRe(user)}\\b`, 'i') : null;
  const res = { personal_terms_rules: terms.length, n_files: 0, n_findings: 0, n_allowlisted: 0, allowlist_entries: allow.size, by_rule: {}, findings: [] };
  for (const rel of walkFiles(dir)) {
    res.n_files++;
    const add = (line, rule, lsha) => { res.findings.push({ file: rel, line, rule, line_sha16: lsha }); res.by_rule[rule] = (res.by_rule[rule] || 0) + 1; };
    if (personalPath(rel)) add(0, 20, '');
    let txt; try { txt = fs.readFileSync(path.join(dir, rel), 'utf8'); } catch { continue; }
    const isJson = /\.json$/i.test(rel);
    // Round 5 (v3 3.3 (a)): the shipped rules file must start with EXACTLY the portable header; any other pre-'## ' region fires 23.
    if (rel === 'bootstrap/rules/CLAUDE.md') { const hi = txt.search(/^## /m); const pre = hi < 0 ? txt : txt.slice(0, hi);
      if (pre !== RULES_HEADER) { const lsha = sha256(Buffer.from(pre.trim(), 'utf8')).slice(0, 16); if (allow.has(`${rel}|23|${lsha}`)) res.n_allowlisted++; else add(1, 23, lsha); } }
    txt.split(/\r?\n/).forEach((l, i) => {
      const hits = leakRulesForLine(l, { isJson, userRe, termRes });
      if (!hits.length) return;
      const lsha = sha256(Buffer.from(l.trim(), 'utf8')).slice(0, 16);
      for (const n of hits) { if (allow.has(`${rel}|${n}|${lsha}`)) res.n_allowlisted++; else add(i + 1, n, lsha); }
    });
  }
  res.n_findings = res.findings.length;
  return res;
}
function runLeakCheck(argv) {
  const i = argv.indexOf('--leak-check'); const dir = argv[i + 1] || '';
  const ai = argv.indexOf('--allowlist');
  const allowlistPath = ai >= 0 ? argv[ai + 1] : path.resolve(SELF_DIR, '..', '..', 'meta', 'harness-plugin', 'leak-allowlist.md');
  if (!dir || !fs.existsSync(dir)) { console.error('LEAK_FAIL reason=dir-missing'); return 3; }
  const pi = argv.indexOf('--personal-terms');
  const termsPath = pi >= 0 ? argv[pi + 1] : defaultPersonalTermsPath(path.resolve(SELF_DIR, '..', '..'));
  const r = leakCheck(dir, { allowlistPath, terms: loadPersonalTerms(termsPath) });
  if (argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else {
    for (const f of r.findings) console.log(`  finding ${f.file}:${f.line} rule=${f.rule} line_sha16=${f.line_sha16}`);
    console.log(`${r.n_findings === 0 ? 'LEAK_OK' : 'LEAK_FAIL'} n_files=${r.n_files} n_findings=${r.n_findings} n_allowlisted=${r.n_allowlisted} by_rule=${JSON.stringify(r.by_rule)} personal_terms_rules=${r.personal_terms_rules}`);
  }
  return r.n_findings === 0 ? 0 : 1;
}

function parseArgs(argv) {
  const a = { mode: 'check', source: '', global: DEFAULT_GLOBAL, json: false, reseed: '', unseed: '', exportPlugin: '', dryRun: false, rulesSrc: '', personalTerms: '', personalTermsList: [], noPersonalTerms: false, scrub: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--export-plugin') a.exportPlugin = argv[++i] || '';
    else if (v === '--dry-run') a.dryRun = true;
    else if (v === '--profile') a.profile = argv[++i] || '--missing-profile';
    else if (v === '--with-hooks') a.withHooks = true;
    else if (v === '--rules-src') a.rulesSrc = argv[++i] || '';
    else if (v === '--personal-terms') { a.personalTerms = argv[++i] || ''; a.personalTermsList.push(a.personalTerms); }
    else if (v === '--no-personal-terms') a.noPersonalTerms = true;
    else if (v === '--scrub') a.scrub = true;
    else if (v === '--force') a.force = true;
    else if (v === '--apply') a.mode = 'apply';
    else if (v === '--check') a.mode = 'check';
    else if (v === '--json') a.json = true;
    else if (v === '--source') a.source = argv[++i] || '';
    else if (v === '--global') a.global = argv[++i] || DEFAULT_GLOBAL;
    else if (v === '--reseed') a.reseed = argv[++i] || '';
    else if (v === '--unseed') a.unseed = argv[++i] || '';
  }
  if (!a.source) a.source = path.resolve(SELF_DIR, '..', '..');   // build layout: S/.claude/global-layer
  if (a.dryRun && !a.exportPlugin) a.mode = 'check';
  return a;
}

export function run(argv) {
  if (argv.includes('--leak-check')) return runLeakCheck(argv);   // read-only on any dir; no source identity needed
  const a = parseArgs(argv);
  const S = path.resolve(a.source);
  const G = norm0(path.resolve(a.global));
  try { assertSeparateSourceConfig(S, G); }
  catch (e) { console.error(`REFUSED: ${e.message}`); return 3; }
  const out = { mode: a.mode, source: S, global: G, rows: [], blocked: [], n_drift: 0, n_report_only_drift: 0, n_unresolved_import: 0, n_payload: 0, n_copied: 0, n_backups: 0, n_deleted: 0, wired: 0 };
  let selection;
  try { selection = selectInstallProfile(S, a.profile, a.withHooks); }
  catch (e) { console.error(`REFUSED: ${e.message}`); return 3; }
  if (!a.exportPlugin && !a.reseed && !a.unseed && (a.mode === 'check' || a.profile) && fs.existsSync(path.join(S, '.claude', 'HARNESS-SOURCE'))) {
    const data = installProfiles(S);
    out.profiles = Object.fromEntries(Object.entries(data.profiles).map(([name, p]) => [name, p.groups]));
    out.profile = a.profile || 'full';
    out.hooks_consent = !!a.withHooks;
    out.capability_groups = data.profiles[out.profile].groups.filter(g => !selection || !data.capability_groups[g].hooks || a.withHooks);
    if (selection && !a.withHooks && data.profiles[out.profile].groups.some(g => data.capability_groups[g].hooks)) {
      out.profile_message = `Profile ${out.profile}: hooks are not installed; pass --with-hooks to consent.`;
    }
    if (!a.json) {
      for (const [name, groups] of Object.entries(out.profiles)) console.log(`PROFILE ${name}: ${groups.join(', ')}${name === 'full' ? ' (legacy hooks; existing scrub exclusions apply)' : ' (hook groups require --with-hooks)'}`);
      console.log(`SELECTED ${out.profile}: ${out.capability_groups.join(', ')}`);
      if (out.profile_message) console.log(out.profile_message);
    }
  }

  if (underTrading(S) || underTrading(G)) { console.error('REFUSED: source or destination is under the denylisted root <denylisted-root>'); return 3; }
  if (!fs.existsSync(path.join(S, '.claude', 'HARNESS-SOURCE'))) {
    console.error(`REFUSED: ${S}/.claude/HARNESS-SOURCE is absent — this is not the harness source repo (fail-closed).`);
    return 3;
  }

  if (a.unseed) return unseed(a.unseed);
  if (a.reseed) return reseed(a.reseed, G);
  if (a.exportPlugin) {
    const { out: eo, code } = exportPlugin(S, a.exportPlugin, { dryRun: a.dryRun, rulesSrc: a.rulesSrc, personalTerms: a.personalTerms ? loadPersonalTerms(a.personalTerms) : null });
    if (a.json) console.log(JSON.stringify(eo, null, 2));
    else console.log(`export-plugin code=${code} refused=${eo.refused || '-'} agents=${eo.agents} wired_hook_files=${eo.wired_hook_files} personal_paths_included=${eo.personal_paths_included} hooks_entries=${eo.hooks_entries} prologue_ok=${eo.prologue_ok} tail_hash_ok=${eo.tail_hash_ok} rules_tail_hash_ok=${eo.rules_tail_hash_ok} n_files=${eo.n_files} blocked=${JSON.stringify(eo.blocked)} missing=${eo.missing.length} stale=${eo.stale.length} personal_terms_rules=${eo.personal_terms_rules} redactions=${eo.redactions} redactions_regex=${eo.redactions_regex} detector_parity_ok=${eo.detector_parity_ok}`);
    return code;
  }

  if (a.mode === 'apply') {   // round 4 pre-flight: refuse BEFORE any payload write, so a bad settings.json never half-applies
    const bad = settingsUnparseable(path.join(G, 'settings.json'));
    if (bad) { console.error(`REFUSED: ${path.join(G, 'settings.json')} is ${bad}; --apply wrote nothing (settings.json is never rebuilt from {}). Fix or restore it, then re-run.`); return 3; }
  }

  const ft = fullTable(S, selection);
  const { closure, unresolved } = ft;
  let table = ft.table;
  let terms = [];
  if (a.scrub) {   // item 5 (2026-10-03): see the client-scrub block above
    const tp = a.personalTermsList.length ? a.personalTermsList
      : [path.join(S, 'meta', 'harness-plugin', 'personal-terms.local.txt'), path.join(G, 'harness-personal-terms.txt')].filter((p) => fs.existsSync(p));
    for (const p of tp) {
      if (!fs.existsSync(p)) { console.error(`REFUSED: --personal-terms file not found: ${p}`); return 3; }
      terms.push(...loadPersonalTerms(p));
    }
    terms = [...new Set(terms)].sort((x, y) => y.length - x.length);
    if (!terms.length && !a.noPersonalTerms) {
      console.error(`REFUSED: --scrub found no personal-terms list (looked for ${a.personalTermsList.length ? 'the --personal-terms files' : '<source>/meta/harness-plugin/personal-terms.local.txt and <config-dir>/harness-personal-terms.txt'}). Names would ship unredacted. Pass --personal-terms <file>, put one at <config-dir>/harness-personal-terms.txt, or pass --no-personal-terms to accept that explicitly. Nothing was written.`);
      return 3;
    }
    out.scrub = { personal_terms: terms.length, term_files: tp.length, excluded: [], no_personal_terms: !!a.noPersonalTerms };
    table = table.map((row) => {
      if (row.mode === 'report-only') return { ...row, mode: 'rules-seed' };
      if (row.mode !== 'retire' && (personalPath(row.dst) || MACHINE_SPECIFIC.has(row.dst))) return { ...row, mode: 'personal-excluded' };
      return row;
    });
  }
  out.n_payload = table.filter((r) => r.mode === 'copy' || r.mode === 'seed-if-absent' || r.mode === 'rules-seed').length;
  out.inventory = inventory(S, G);    // REPORT rows only (task 8, 2026-10-03): names, never values; never drift
  const manifestFiles = []; const ledgerFiles = [];
  out.n_user_modified = 0;
  // The bytes each writing row would write, computed ONCE: the pre-flight and the copy loop below use the same bytes.
  const bytesCache = new Map();
  const bytesFor = (row) => {
    if (bytesCache.has(row)) return bytesCache.get(row);
    let b = null;
    try {
      const raw = fs.readFileSync(path.join(S, row.src));
      if (row.mode === 'rules-seed') b = row.dst === 'CLAUDE.md' ? rulesSeedBytes(raw.toString('utf8')) : raw;
      else b = deployBytes(row, raw, a.scrub ? CLIENT_PROLOGUE : GLOBAL_PROLOGUE);
      if (b && a.scrub) b = scrubBytes(row.src, b, terms).buf;
    } catch { b = null; }
    bytesCache.set(row, b); return b;
  };
  const writing = table.filter((r) => r.src && ['copy', 'seed-if-absent', 'rules-seed'].includes(r.mode) && !filenameDenied(r.src));
  const files = writing.map((r) => ({ file: r.src, buf: bytesFor(r) })).filter((f) => f.buf);
  const toolNames = new Set(table.filter((r) => r.dst && /^tools\/[^/]+\.py$/.test(r.dst)).map((r) => r.dst.slice(6, -3)));
  const safety = payloadSafety(S, table, files, { toolNames, scrub: a.scrub, terms, G });
  out.safety = { n_findings: safety.findings.length, py_leg: safety.py_leg, n_js_specs: safety.n_js_specs, findings: safety.findings };
  out.residual = safety.residual;
  if (safety.findings.length) {   // I7: refuse BEFORE any write, in both modes
    if (a.json) console.log(JSON.stringify(out, null, 2));
    else {
      console.log(`sync-harness-from-source  mode=${a.mode}  source=${S}  global=${G}`);
      for (const f of safety.findings) console.log(`  PAYLOAD-SAFETY REFUSED ${f.kind} ${f.file}${f.line ? `:${f.line}` : ''}${f.why ? ` why=${f.why}` : ''}${f.spec ? ` spec=${f.spec}` : ''}${f.rules ? ` rules=[${f.rules.join(',')}]` : ''}`);
      console.log(`n_safety_findings = ${safety.findings.length}  (refused: nothing was written)`);
    }
    return 2;
  }
  const prior = priorInstalled(G);

  for (const row of table) {
    const srcAbs = row.src ? path.join(S, row.src) : '';
    const dstAbs = path.join(G, row.dst);
    const r = { src: row.src || '', dst: row.dst, mode: row.mode, status: '', src_sha: '', dst_sha: '' };

    if (row.mode === 'retire') {
      r.status = fs.existsSync(dstAbs) ? 'retire-pending' : 'absent';
      if (a.mode === 'apply' && r.status === 'retire-pending') {
        fs.renameSync(dstAbs, `${dstAbs}.retired-${stamp()}`);
        r.status = 'retired';
      }
      out.rows.push(r); continue;
    }

    if (row.mode === 'personal-excluded') { r.status = 'personal-excluded'; out.scrub.excluded.push(row.dst); out.rows.push(r); continue; }
    if (row.src && filenameDenied(row.src)) { r.status = 'filename-denied'; out.blocked.push({ path: row.src, rules: ['filename-denylist'] }); out.rows.push(r); continue; }
    if (!fs.existsSync(srcAbs)) { r.status = 'missing-src'; out.rows.push(r); continue; }

    const buf = bytesFor(row);   // the exact bytes the pre-flight checked: source bytes, prologue on prose rows, scrubbed under --scrub
    if (!buf) { r.status = 'missing-src'; out.rows.push(r); continue; }
    const violations = guardViolations(buf);
    if (violations.length) {
      r.status = 'BLOCKED-secret-guard';
      r.rules = violations;
      out.blocked.push({ path: row.src, rules: violations });
      out.rows.push(r);
      continue;                       // never written, never hashed into the manifest
    }

    r.src_sha = sha256(buf);
    const dstExists = fs.existsSync(dstAbs);
    r.dst_sha = dstExists ? sha256(fs.readFileSync(dstAbs)) : '';
    r.status = !dstExists ? 'missing-dst' : (r.src_sha === r.dst_sha ? 'same' : 'drift');

    if (row.mode === 'report-only') {
      if (r.status !== 'same') out.n_report_only_drift++;
      r.pin = row.pin;
      r.pin_match_src = r.src_sha.slice(0, 16) === row.pin;
      r.pin_match_dst = r.dst_sha.slice(0, 16) === row.pin;
      out.rows.push(r);
      continue;                       // NEVER written (curated port, plan §3 / R7)
    }

    if (row.mode === 'seed-if-absent' && dstExists) {
      // Per-machine file (round 2, verifier A3): an existing destination is never overwritten and never counted as drift.
      if (r.status !== 'same') {
        const lines = (b) => new Set(String(b).split(/\r?\n/).map((x) => x.trim()).filter((x) => x && !x.startsWith('#')));
        const have = lines(fs.readFileSync(dstAbs, 'utf8'));
        r.status = 'machine-local';
        r.src_lines_absent_at_dst = [...lines(buf)].filter((x) => !have.has(x)).length;   // a count, never the lines
      }
      ledgerFiles.push({ path: row.dst, mode: row.mode, owner: r.status === 'same' ? 'harness' : 'machine-local', installed_sha256: r.dst_sha, installed_sha256_lf: null, source_sha256: r.src_sha });
      out.rows.push(r); continue;
    }

    const pr = prior.get(row.dst);
    if (row.mode === 'rules-seed' && dstExists && !pr) {
      // a CLAUDE.md / standard the ledger does not know is the user's own: never written, never drift (item 5)
      if (r.status !== 'same') r.status = 'kept-existing';
      out.rows.push(r); continue;
    }
    if (r.status === 'drift' && userModified(pr, fs.readFileSync(dstAbs))) {   // I2: never clobber a hand edit
      r.user_modified = true; out.n_user_modified++;
      if (!a.force) {
        out.n_drift++;   // it still differs from the source: --check keeps counting it
        if (a.mode === 'apply') r.status = 'user-modified-skipped';
        ledgerFiles.push({ path: row.dst, mode: row.mode, owner: 'user-modified', installed_sha256: pr.sha256, installed_sha256_lf: pr.sha256_lf, source_sha256: r.src_sha });
        manifestFiles.push({ path: row.dst, sha256: r.src_sha, mode: row.mode, seed: row.seed || null });
        out.rows.push(r); continue;
      }
      r.forced = true;
    }
    // I2 residue (verifier A3): a differing file the ledger does not know (first install, or a same-named user file) is
    // still backed up and overwritten as before, but now SAID so per file instead of a bare `drift`.
    if (r.status === 'drift' && !pr) { r.pre_existing = true; out.n_pre_existing = (out.n_pre_existing || 0) + 1; }
    if (r.status !== 'same') out.n_drift++;
    if (a.mode === 'apply' && r.status !== 'same') {
      fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
      if (dstExists) { fs.copyFileSync(dstAbs, backupPath(dstAbs)); out.n_backups++; }
      fs.writeFileSync(dstAbs, buf);   // buf: the exact bytes hashed above (source bytes, plus the prologue on prose rows)
      out.n_copied++;
    }
    manifestFiles.push({ path: row.dst, sha256: r.src_sha, mode: row.mode, seed: row.seed || null });
    ledgerFiles.push({ path: row.dst, mode: row.mode, owner: 'harness', installed_sha256: r.src_sha, installed_sha256_lf: lfSha(buf), source_sha256: r.src_sha });
    out.rows.push(r);
  }

  // ── unresolved-import legs (repair 2026-09-04) ──────────────────────────────────
  // Leg 1: a relative import a payload script makes that the payload cannot carry.
  for (const u of unresolved) {
    out.rows.push({ src: u.from, dst: u.rel, mode: 'import', status: 'unresolved-import', why: u.why, spec: u.spec, src_sha: '', dst_sha: '' });
    out.n_unresolved_import++;
  }
  // Leg 2: a RESOLVED dependency that is not present at the destination. In apply mode this runs
  // after the copy loop, so a successful apply zeroes it; in check mode it is exactly the "the
  // global dir would ERR_MODULE_NOT_FOUND" signal that n_drift alone never carried.
  const missingAtDst = new Set();
  for (const e of closure.edges) {
    const d = dstForSource(e.dep);
    if (!d || missingAtDst.has(d)) continue;
    if (!fs.existsSync(path.join(G, d))) {
      missingAtDst.add(d);
      out.rows.push({ src: e.from, dst: d, mode: 'import', status: 'unresolved-import', why: 'missing-at-destination', spec: e.dep, src_sha: '', dst_sha: '' });
      out.n_unresolved_import++;
    }
  }

  if (a.mode === 'apply') {
    // manifest
    const prevPath = path.join(G, 'harness-MANIFEST.json');
    let n = 1;
    let prev;
    try {
      prev = JSON.parse(fs.readFileSync(prevPath, 'utf8'));
      const pfx = `${MANIFEST_SCHEMA}-${stamp()}.`;
      const v = String(prev.version || '');
      if (v.startsWith(pfx)) { const k = Number(v.slice(pfx.length)); if (Number.isFinite(k)) n = k + 1; }
    } catch { /* first manifest */ }
    const manifest = {
      version: `${MANIFEST_SCHEMA}-${stamp()}.${n}`, schema: MANIFEST_SCHEMA, source: S, generated_at: new Date().toISOString(),
      files: manifestFiles,
      seed: manifestFiles.filter((f) => f.seed).map((f) => ({ g: f.path, p: f.seed })),
      wire_project: wireProject(selection),
    };
    fs.mkdirSync(G, { recursive: true });
    // Version and generation time describe content changes, not invocations.
    if (prev && ['schema', 'source', 'files', 'seed', 'wire_project'].every(key => JSON.stringify(prev[key]) === JSON.stringify(manifest[key]))) {
      manifest.version = prev.version;
      manifest.generated_at = prev.generated_at;
    }
    if (writeStateIfChanged(prevPath, manifest)) out.n_backups++;
    // I2 ledger (backed up like the manifest, but not counted in n_backups: it is install state, not a payload file)
    const lp = path.join(G, LEDGER_FILE);
    const request = { source: S, global: G, scrub: !!a.scrub, personal_terms: a.personalTermsList, no_personal_terms: !!a.noPersonalTerms };
    if (a.profile) { request.profile = a.profile; request.with_hooks = !!a.withHooks; }
    writeStateIfChanged(lp, { schema: LEDGER_SCHEMA, version: manifest.version, generated_at: manifest.generated_at, request, files: ledgerFiles });
    out.ledger = { path: LEDGER_FILE, n_files: ledgerFiles.length };
    out.version = manifest.version;
    out.wired = wire(G, selection);
  }

  // ── report ────────────────────────────────────────────────────────────────────────────────────
  if (a.json) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(`sync-harness-from-source  mode=${a.mode}  source=${S}  global=${G}`);
    for (const r of out.rows) {
      if (r.status === 'same') continue;
      const shas = r.src_sha || r.dst_sha ? ` src=${r.src_sha.slice(0, 16) || '-'} dst=${r.dst_sha.slice(0, 16) || '-'}` : '';
      const rules = r.rules ? ` rules=[${r.rules.join(',')}]` : '';
      const why = r.why ? ` why=${r.why} from=${r.src} spec=${r.spec}` : '';
      console.log(`  ${r.status.padEnd(22)} ${r.dst}${shas}${rules}${why}`);
    }
    for (const r of out.rows) if (r.status === 'machine-local') console.log(`  MACHINE-LOCAL ${r.dst}: differs from the source list (${r.src_lines_absent_at_dst} source line(s) absent here); seed-if-absent: NEVER overwritten, not drift`);
    for (const i of out.inventory) console.log(`  INVENTORY ${i.kind} ${i.scope}: ${i.present ? `[${i.names.join(', ')}]` : '(no file)'}${i.where ? ` in ${i.where}` : ''} (report-only, names only)`);
    for (const r of out.rows) {
      if (r.mode === 'report-only') console.log(`  REPORT-ONLY ${r.dst}: src=${r.src_sha.slice(0, 16)} dst=${r.dst_sha.slice(0, 16) || '-'} pinned=${r.pin} pin_match_src=${r.pin_match_src} pin_match_dst=${r.pin_match_dst} (report-only: NEVER written; a human port pass is owed when neither matches)`);
    }
    if (out.blocked.length) {
      console.log('  SECRET/PII GUARD BLOCKED (path + rule number only, never the matched text):');
      for (const b of out.blocked) console.log(`    BLOCKED ${b.path} rules=[${b.rules.join(',')}]`);
    }
    for (const r of out.rows) if (r.user_modified) console.log(`  USER-MODIFIED ${r.dst}: differs from what the harness last wrote${r.forced ? ' -- OVERWRITTEN (--force; backup kept)' : (a.mode === 'apply' ? ' -- SKIPPED, kept as is (--force overwrites it)' : '')}`);
    for (const r of out.rows) if (r.pre_existing) console.log(`  PRE-EXISTING ${r.dst}: the install ledger does not know this file -- ${a.mode === 'apply' ? 'backed up and overwritten' : 'would be backed up and overwritten by --apply'}`);
    if (out.scrub) console.log(`  SCRUB personal_terms=${out.scrub.personal_terms} term_files=${out.scrub.term_files}${out.scrub.no_personal_terms ? ' (--no-personal-terms: names NOT scrubbed)' : ''} excluded=[${out.scrub.excluded.join(', ')}]`);
    for (const x of out.residual) console.log(`  RESIDUAL-PERSONAL ${x.file} rules=[${x.rules.join(',')}] (code row: reported, not refused; a source fix is owed)`);
    console.log(`n_safety_findings = 0  py_leg = ${out.safety.py_leg}  js_static_imports_checked = ${out.safety.n_js_specs}`);
    console.log(`n_user_modified = ${out.n_user_modified}`);
    if (out.ledger) console.log(`ledger = ${out.ledger.path} (${out.ledger.n_files} files)`);
    console.log(`n_payload = ${out.n_payload}`);
    console.log(`n_drift = ${out.n_drift}`);
    console.log(`n_unresolved_import = ${out.n_unresolved_import}`);
    console.log(`n_report_only_drift = ${out.n_report_only_drift}`);
    console.log(`n_blocked = ${out.blocked.length}`);
    if (a.mode === 'apply') console.log(`n_copied = ${out.n_copied}  n_backups = ${out.n_backups}  n_deleted = ${out.n_deleted}  n_wired = ${out.wired}  version = ${out.version}`);
  }

  if (out.blocked.length) return 2;
  // An unresolved import is a HARD failure in BOTH modes: an applied-but-incomplete payload is the
  // exact defect this repair exists for, and it must never exit 0 and look done.
  if (a.mode === 'check') return (out.n_drift === 0 && out.n_unresolved_import === 0) ? 0 : 1;
  return out.n_unresolved_import === 0 ? 0 : 1;
}

/** null when <sp> is absent or parses to a JSON object; else a short reason (never the file's text: it may hold a secret).
 *  Round 4 (2026-10-03, verifier A2): wire() used to rebuild an unparseable settings.json from {} (measured: a truncated
 *  file came back holding only hooks + _comment_README). wire() and the --apply pre-flight now REFUSE it instead. */
export function settingsUnparseable(sp) {
  if (!fs.existsSync(sp)) return null;
  let j;
  try { j = JSON.parse(fs.readFileSync(sp, 'utf8')); } catch { return 'not valid JSON'; }
  return j && typeof j === 'object' && !Array.isArray(j) ? null : 'not a JSON object';
}

/** Write a JSON state file only when its bytes differ, backing up the previous version only then.
 *  Returns true when an existing file was replaced. */
function writeStateIfChanged(file, value) {
  const bytes = JSON.stringify(value, null, 2) + '\n';
  const exists = fs.existsSync(file);
  if (exists && fs.readFileSync(file, 'utf8') === bytes) return false;
  if (exists) fs.copyFileSync(file, backupPath(file));
  fs.writeFileSync(file, bytes, 'utf8');
  return exists;
}

/** Merge the 12 global hook entries into <G>/settings.json. Backs the file up first (only when its bytes change), preserves every
 *  existing key, appends the README note. Returns the number of entries added. */
export function wire(G, selection = null) {
  const want = wireGlobal(G, selection);
  if (!Object.keys(want).length) return 0;
  const sp = path.join(G, 'settings.json');
  let settings = {};
  if (fs.existsSync(sp)) {
    const bad = settingsUnparseable(sp);
    if (bad) throw new Error(`REFUSED: ${sp} is ${bad}; it is never rebuilt from {} (fix or restore it, then re-run)`);
    settings = JSON.parse(fs.readFileSync(sp, 'utf8'));
  }
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
  let added = 0;
  for (const [event, groups] of Object.entries(want)) {
    if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
    for (const group of groups) {
      let target = settings.hooks[event].find((g) => (g && g.matcher) === group.matcher);
      if (!target) { target = group.matcher === undefined ? { hooks: [] } : { matcher: group.matcher, hooks: [] }; settings.hooks[event].push(target); }
      if (!Array.isArray(target.hooks)) target.hooks = [];
      for (const entry of group.hooks) {
        const key = Array.isArray(entry.args) ? entry.args.join(' ') : entry.command;
        const present = target.hooks.some((h) => {
          const k = h && (Array.isArray(h.args) ? h.args.join(' ') : h.command);
          return k === key;
        });
        if (!present) { target.hooks.push(JSON.parse(JSON.stringify(entry))); added++; }
      }
    }
  }
  const prevNote = typeof settings._comment_README === 'string' ? settings._comment_README : '';
  if (!prevNote.includes('HOOKS NOTE (harness deploy)')) {
    settings._comment_README = (prevNote ? prevNote.trim() + ' ' : '') + README_NOTE;
  }
  fs.mkdirSync(G, { recursive: true });
  writeStateIfChanged(sp, settings);
  return added;
}

/** Revert helper. Two paths, because a project the SEEDER created has no backup to restore:
 *  (1) a settings.json.bak-* exists -> restore the newest one (unchanged behaviour);
 *  (2) no backup -> remove EXACTLY the entries the seeder added, identified by args[0] resolving
 *      under <dir>/.claude/hooks/ (the ${CLAUDE_PROJECT_DIR} placeholder is expanded first), so the
 *      project is not left wired to files that the hooks-dir move below is about to relocate.
 *  Either way settings.json is backed up first and the hooks dir is MOVED, never deleted. */
function unseed(dir) {
  const projRoot = path.resolve(dir);
  const dc = path.join(projRoot, '.claude');
  if (!fs.existsSync(dc)) { console.error(`nothing to unseed: ${dc} does not exist`); return 1; }
  const sp = path.join(dc, 'settings.json');
  const baks = fs.readdirSync(dc).filter((f) => f.startsWith('settings.json.bak-')).sort();
  if (baks.length) {
    fs.copyFileSync(sp, backupPath(sp));
    fs.copyFileSync(path.join(dc, baks[baks.length - 1]), sp);
    console.log(`restored settings.json from ${baks[baks.length - 1]}`);
    console.log('n_unwired = 0 (backup-restore path)');
  } else if (fs.existsSync(sp)) {
    fs.copyFileSync(sp, backupPath(sp));
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(sp, 'utf8')) || {}; } catch { settings = {}; }
    const hooksPrefix = norm(path.join(dc, 'hooks')) + '/';
    const seededEntry = (h) => {
      const a0 = h && Array.isArray(h.args) ? h.args[0] : null;
      if (typeof a0 !== 'string') return false;
      return norm(a0.split('${CLAUDE_PROJECT_DIR}').join(projRoot)).startsWith(hooksPrefix);
    };
    let removed = 0;
    if (settings.hooks && typeof settings.hooks === 'object') {
      for (const [event, groups] of Object.entries(settings.hooks)) {
        if (!Array.isArray(groups)) continue;
        for (const g of groups) {
          if (!g || !Array.isArray(g.hooks)) continue;
          const before = g.hooks.length;
          g.hooks = g.hooks.filter((h) => !seededEntry(h));
          removed += before - g.hooks.length;
        }
        const kept = groups.filter((g) => g && Array.isArray(g.hooks) && g.hooks.length);
        if (kept.length) settings.hooks[event] = kept; else delete settings.hooks[event];
      }
      if (!Object.keys(settings.hooks).length) delete settings.hooks;
    }
    fs.writeFileSync(sp, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    console.log(`no settings.json.bak-* found -> unwired ${removed} seeded hook entries (args[0] under ${dc}/hooks/)`);
    console.log(`n_unwired = ${removed}`);
  }
  const hooksDir = path.join(dc, 'hooks');
  if (fs.existsSync(hooksDir)) {
    // A SECOND unseed of the same project on the same day used to CRASH here: renaming onto an
    // EXISTING hooks.removed-<date> directory throws EPERM on Windows, and the throw escaped
    // uncaught AFTER settings.json had already been restored — i.e. a half-applied revert with a
    // stack trace instead of a report. Measured 2026-09-04 running the documented revert twice.
    // Pick a free name instead (same discipline as backupPath): still a MOVE, still nothing deleted.
    let moved = path.join(dc, `hooks.removed-${stamp()}`);
    for (let i = 2; fs.existsSync(moved); i++) moved = path.join(dc, `hooks.removed-${stamp()}-${i}`);
    fs.renameSync(hooksDir, moved);
    console.log(`moved hooks -> ${moved} (nothing deleted)`);
  }
  console.log('n_deleted = 0');
  return 0;
}

/** Revert/force helper: re-run the seeder against one project at the current manifest. */
function reseed(dir, G) {
  const r = spawnSync(process.execPath, [path.join(G, 'tools', 'harness-seed.mjs'), '--project', path.resolve(dir), '--force'], { encoding: 'utf8' });
  process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || '');
  return typeof r.status === 'number' ? r.status : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(run(process.argv.slice(2)));
}
