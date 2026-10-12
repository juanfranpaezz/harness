#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// harness-seed.mjs — the per-project SEEDER of the machine-wide harness layer (deploy plan §7).
//
// Wired at the GLOBAL SessionStart, DIRECTLY (not through _global-runner.mjs): it carries its own
// guard. In an UNSEEDED project folder it copies the generic hooks + their imported tools out of the
// global harness root into <PROJECT>/.claude/, merges the project-shaped hook wiring into
// <PROJECT>/.claude/settings.json, and records what it did in <PROJECT>/.claude/HARNESS-SEEDED.json.
//
// <G> (the global harness root) is derived from THIS FILE's location: it lives at <G>/tools/, so
// <G> is that dir's parent. The payload list and the wiring both come FROM THE MANIFEST
// (<G>/harness-MANIFEST.json, written by sync-harness-from-source.mjs) — this file hard-codes no
// file list, so "latest" is a mechanical version equality, not a claim.
//
// NEVER writes outside <PROJECT>/.claude/. NEVER deletes. Backs up every file it would overwrite.
// FAIL-OPEN: any error → log + exit 0.
//
// Honest limitation (plan §7, R1): Claude Code snapshots hook configuration at session start, so a
// settings.json written mid-session is expected to take effect only from the NEXT session. That is
// why the GLOBAL layer is primary and this seeder is secondary.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Denylist logic is DUPLICATED here on purpose: in the deployed layout the runner lives at
// <G>/hooks/ and this seeder at <G>/tools/, so a relative import between them would resolve
// differently in the build dir than after deploy. 15 lines of duplication beats a path that is
// only correct in one of the two layouts. Both copies are covered by the same unit test.
const BS = String.fromCharCode(92);
const DENY_FILE = 'harness-deny-roots.txt';
function normRoot(p) {
  let s = String(p).split(BS).join('/').trim().toLowerCase();
  while (s.length > 3 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}
/** The fixed floor (kept as before, so nothing is weakened when the file is absent) + <gRoot> itself + the lines of
 *  <gRoot>/harness-deny-roots.txt, the same per-machine file hooks/_global-runner.mjs denyRoots() reads (round 2,
 *  2026-10-03, verifier A5: before this the seeder ignored the file, so its `c:/work` line protected nothing here). */
export function denyRoots(gRoot = G_ROOT, fsi = fs) {
  const roots = [normRoot(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')), 'c:/windows', 'c:/program files', 'c:/program files (x86)'];
  if (gRoot) roots.push(normRoot(gRoot));
  try {
    for (const line of String(fsi.readFileSync(path.join(gRoot, DENY_FILE), 'utf8')).split(/\r?\n/)) {
      const t = line.trim();
      if (t && !t.startsWith('#')) roots.push(normRoot(t));
    }
  } catch { /* absent deny file = the floor only */ }
  return roots.filter(Boolean);
}
export function isDenied(projectDir, roots = denyRoots()) {
  if (typeof projectDir !== 'string' || !projectDir) return true;
  // Round 3 (2026-10-03, verifier A5 leftover): the check used to be lexical only, so a junction (or symlink) that
  // points INTO a denied root was seeded (measured: junction_path_denied=false). Both the path as given and its real
  // path are tested; either one at or under a denied root denies. A path that does not exist keeps its lexical form.
  // Round 4 (2026-10-03, verifier A4): a deny ROOT that is itself a junction/symlink is honoured too. Every absolute root is
  // also tested through its real path, so a project at the junction's real target is denied like one under the link.
  const all = [...new Set(roots.flatMap((r) => (r && path.isAbsolute(r) ? [r, realNorm(r)] : [r])))];
  const hit = (s) => /^[a-z]:\/?$/.test(s) || s === '/' || all.some((r) => s === r || s.startsWith(r + '/'));
  return hit(normRoot(projectDir)) || hit(realNorm(projectDir));
}

/** Real path, normalised. A path that does not exist (yet) is resolved through its longest EXISTING ancestor and the
 *  remainder re-appended (round 3: `<junction>/not-yet-created` used to keep its lexical form and slip past isDenied). */
function realNorm(p) {
  const abs = path.resolve(p);
  let head = abs; const tail = [];
  for (;;) {
    let r = null;
    try { r = fs.realpathSync.native(head); } catch { try { r = fs.realpathSync(head); } catch { /* climb */ } }
    if (r !== null) return normRoot(tail.length ? path.join(r, ...tail) : r);
    const parent = path.dirname(head);
    if (parent === head) return normRoot(abs);        // nothing on the path exists: keep the lexical path
    tail.unshift(path.basename(head)); head = parent;
  }
}
/** true when <dotClaude> is a Claude PROFILE dir, not a project's .claude: it resolves (real path, case-insensitive) to
 *  the harness root, CLAUDE_CONFIG_DIR or <home>/.claude; or the project dir is the home folder itself; or it carries
 *  a profile's own markers (a projects/ dir or .credentials.json, which no project .claude has). */
export function isProfileConfigDir(dotClaude, projectDir, env = process.env) {
  const home = os.homedir();
  const d = realNorm(dotClaude);
  const known = [G_ROOT, env.CLAUDE_CONFIG_DIR, path.join(home, '.claude')].filter((x) => typeof x === 'string' && x.trim());
  if (known.some((k) => realNorm(k.trim()) === d)) return true;
  if (projectDir && realNorm(projectDir) === realNorm(home)) return true;
  return fs.existsSync(path.join(dotClaude, 'projects')) || fs.existsSync(path.join(dotClaude, '.credentials.json'));
}

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));    // <G>/tools  (or the build dir)
const G_ROOT = process.env.HARNESS_GLOBAL_ROOT || path.resolve(SELF_DIR, '..');
const MANIFEST_PATH = path.join(G_ROOT, 'harness-MANIFEST.json');
const LOG_PATH = path.join(G_ROOT, 'hooks', 'harness-seed.log');

function logRow(row) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, JSON.stringify({ ...row, scope: 'global' }) + '\n', 'utf8');
  } catch { /* never crash on logging */ }
}

function readStdin() { try { return fs.readFileSync(0, 'utf8'); } catch { return ''; } }

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function backupPath(dst) {
  let cand = `${dst}.bak-${stamp()}`;
  if (!fs.existsSync(cand)) return cand;
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  cand = `${dst}.bak-${stamp()}-${p(d.getHours())}${p(d.getMinutes())}`;
  let i = 1;
  while (fs.existsSync(cand)) cand = `${dst}.bak-${stamp()}-${p(d.getHours())}${p(d.getMinutes())}-${i++}`;
  return cand;
}

/** Copy src→dst, backing up an existing dst first. Returns 'copied' | 'copied+backup' | 'same'. */
function copyWithBackup(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (fs.existsSync(dst)) {
    const a = fs.readFileSync(src); const b = fs.readFileSync(dst);
    if (a.equals(b)) return 'same';
    fs.copyFileSync(dst, backupPath(dst));
    fs.copyFileSync(src, dst);
    return 'copied+backup';
  }
  fs.copyFileSync(src, dst);
  return 'copied';
}

/** Merge wire entries into a settings object. Adds only entries whose args[0] is not already there.
 *  Preserves every existing key. Returns the number of entries added. */
export function mergeWiring(settings, wire) {
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
  let added = 0;
  for (const [event, groups] of Object.entries(wire)) {
    if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
    for (const group of groups) {
      const matcher = group.matcher;
      let target = settings.hooks[event].find((g) => (g && g.matcher) === matcher);
      if (!target) { target = matcher === undefined ? { hooks: [] } : { matcher, hooks: [] }; settings.hooks[event].push(target); }
      if (!Array.isArray(target.hooks)) target.hooks = [];
      for (const entry of group.hooks) {
        const key = Array.isArray(entry.args) ? entry.args[0] : entry.command;
        const present = target.hooks.some((h) => {
          const k = h && (Array.isArray(h.args) ? h.args[0] : h.command);
          return k === key;
        });
        if (!present) { target.hooks.push(JSON.parse(JSON.stringify(entry))); added++; }
      }
    }
  }
  return added;
}

function emitContext(line) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: line },
  }));
}

export function seed(projectDir, opts = {}) {
  const out = { project: projectDir, action: 'skip', reason: '', copied: 0, backups: 0, wired: 0, version: '' };
  if (process.env.HARNESS_GLOBAL_OFF === '1') { out.reason = 'kill-switch'; return out; }
  if (isDenied(projectDir)) { out.reason = 'denylisted-root'; return out; }

  const dotClaude = path.join(projectDir, '.claude');
  // Round 2 addendum (2026-10-03): the HOME folder is not a project. Opened there, <home>/.claude IS the global config
  // dir, so the seeder used to merge the project-shaped `${CLAUDE_PROJECT_DIR}/.claude/hooks/...` wiring into the
  // GLOBAL settings.json (13 direct entries found 2026-10-03, beside the runner-wrapped ones, bypassing its guards).
  if (isProfileConfigDir(dotClaude, projectDir)) { out.reason = 'profile-config-dir'; return out; }
  if (fs.existsSync(path.join(dotClaude, 'HARNESS-SOURCE'))) { out.reason = 'harness-source'; return out; }
  if (fs.existsSync(path.join(dotClaude, 'NO-HARNESS'))) { out.reason = 'opted-out'; return out; }
  if (!fs.existsSync(path.join(projectDir, '.git')) && !fs.existsSync(dotClaude)) { out.reason = 'not-a-project'; return out; }
  try { fs.accessSync(projectDir, fs.constants.W_OK); } catch { out.reason = 'not-writable'; return out; }

  if (!fs.existsSync(MANIFEST_PATH)) { out.reason = 'no-manifest'; return out; }
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')); } catch { out.reason = 'bad-manifest'; return out; }
  out.version = manifest.version || '';

  const seededPath = path.join(dotClaude, 'HARNESS-SEEDED.json');
  if (fs.existsSync(seededPath) && !opts.force) {
    try {
      const prev = JSON.parse(fs.readFileSync(seededPath, 'utf8'));
      if (prev && prev.version === manifest.version) { out.reason = 'up-to-date'; return out; }
    } catch { /* unreadable record ⇒ re-seed */ }
  }

  const seedList = Array.isArray(manifest.seed) ? manifest.seed : [];
  for (const item of seedList) {
    const src = path.join(G_ROOT, item.g);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(dotClaude, item.p);
    const r = copyWithBackup(src, dst);
    if (r !== 'same') out.copied++;
    if (r === 'copied+backup') out.backups++;
  }
  // the manifest itself travels, so a seeded project can report its own version
  try { fs.copyFileSync(MANIFEST_PATH, path.join(dotClaude, 'harness-MANIFEST.json')); } catch { /* non-fatal */ }

  const wire = manifest.wire_project && typeof manifest.wire_project === 'object' ? manifest.wire_project : {};
  const settingsPath = path.join(dotClaude, 'settings.json');
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) || {}; } catch { settings = {}; }
    fs.copyFileSync(settingsPath, backupPath(settingsPath));
    out.backups++;
  }
  out.wired = mergeWiring(settings, wire);
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');

  fs.writeFileSync(seededPath, JSON.stringify({
    version: manifest.version, seeded_at: new Date().toISOString(), source: manifest.source || '',
    files: seedList.map((i) => i.p), wired_entries: out.wired,
  }, null, 2) + '\n', 'utf8');

  out.action = 'seeded';
  out.reason = 'seeded';
  return out;
}

function main() {
  let projectDir = '';
  try {
    const argIdx = process.argv.indexOf('--project');
    let payload = {};
    if (argIdx === -1) { try { payload = JSON.parse(readStdin() || '{}') || {}; } catch { payload = {}; } }
    projectDir = argIdx !== -1 ? process.argv[argIdx + 1]
      : (process.env.CLAUDE_PROJECT_DIR || payload.cwd || process.cwd());
    const force = process.argv.includes('--force');
    const r = seed(projectDir, { force });
    logRow({ ts: new Date().toISOString(), hook: 'harness-seed.mjs', cwd: projectDir, action: r.action, reason: r.reason, copied: r.copied, wired: r.wired });
    if (r.action === 'seeded') {
      // MEASURED TRUTH (independent verifier, 2026-09-04). The previous wording claimed "meanwhile the
      // PC-wide harness layer is already active", which is FALSE for the hooks just seeded:
      // from this moment _global-runner.mjs skips them with reason "project-wires-it" (it text-matches
      // the hook name in the project settings.json), while the project copies are not loaded until the
      // next session. The honest statement is: seeded now, in force next session, down in between.
      emitContext(`The general harness (version ${r.version}) was installed in this project: ${r.copied} files and ${r.wired} new hooks in its settings. These checks start running in the NEXT session of this folder (the hook configuration is fixed when the session opens). For the rest of this session they do not run, and the general layer does not run them here either, because the folder already declares them.`);
    }
    process.exit(0);
  } catch (e) {
    logRow({ ts: new Date().toISOString(), hook: 'harness-seed.mjs', cwd: projectDir, action: 'error', reason: String((e && e.message) || e).slice(0, 200) });
    process.exit(0);   // fail-open
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
