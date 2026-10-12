#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// harness-install.mjs — ONE command installs the harness into a Claude config dir, ONE updates it, one checks it
// (I5 + I2, 2026-10-03). Windows-first: it spawns git and node directly (never a shell), so it behaves the same from
// PowerShell, cmd and Git Bash.
//
//   node harness-install.mjs install [--repo <git url|path>] [--clone-dir <dir>] [--config-dir <dir>]
//                                    [--personal-terms <file>]... [--no-personal-terms] [--force] [--json]
//   node harness-install.mjs update  [--config-dir <dir>] [--force]
//   node harness-install.mjs doctor  [--config-dir <dir>] [--json]
//
// --config-dir  default $CLAUDE_CONFIG_DIR, else <home>/.claude. A second profile (work) is just another dir.
// install       with --repo and a --clone-dir that does not exist yet: `git clone` it (a local path clones offline).
//               Without --repo: the clone this script lives in. Then, from THAT clone,
//               `sync-harness-from-source.mjs --apply --scrub` into the config dir (payload safety pre-flight, client
//               scrub, install ledger, settings wiring) and the doctor. Re-running it changes nothing but dated backups.
// update        `git pull --ff-only` in the clone recorded in the ledger (dirty or diverged clone: REFUSED, nothing
//               applied), re-apply the RECORDED install request with the pulled sync script, print the ledger diff,
//               then the doctor. A file edited in the config dir is reported and KEPT (--force overwrites, backup kept).
// doctor        read-only: OK / MODIFIED-BY-USER / MISSING per ledger file, EXTRA for unknown files in managed dirs.
// Exit: 0 ok | 1 doctor found MISSING or MODIFIED-BY-USER | 2 payload refused (safety/secret/personal) |
//       3 refused input (no ledger, not a harness clone, no terms list) | 4 git refused (clone/dirty/diverged).
// Never deletes, never prints a secret, never commits or pushes.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertSeparateSourceConfig } from './sync-harness-from-source.mjs';

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const SELF_REPO = path.resolve(SELF_DIR, '..', '..');
const SYNC_REL = path.join('.claude', 'global-layer', 'sync-harness-from-source.mjs');
export const LEDGER_FILE = 'harness-install-ledger.json';

export function parseArgs(argv) {
  const a = { cmd: argv[0] || '', repo: '', cloneDir: '', configDir: '', terms: [], noTerms: false, force: false, json: false, bad: '' };
  for (let i = 1; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--repo') a.repo = argv[++i] || '';
    else if (v === '--clone-dir') a.cloneDir = argv[++i] || '';
    else if (v === '--config-dir') a.configDir = argv[++i] || '';
    else if (v === '--personal-terms') a.terms.push(argv[++i] || '');
    else if (v === '--no-personal-terms') a.noTerms = true;
    else if (v === '--force') a.force = true;
    else if (v === '--json') a.json = true;
    else if (v === '--profile') a.profile = argv[++i] || '--missing-profile';
    else if (v === '--with-hooks') a.withHooks = true;
    else if (v === '--check' || v === '--dry-run') a.check = true;
    else a.bad = v;
  }
  return a;
}
export function configDir(a, env = process.env) {
  return path.resolve(a.configDir || (env.CLAUDE_CONFIG_DIR || '').trim() || path.join(os.homedir(), '.claude'));
}
const lastLine = (s) => String(s || '').trim().split(/\r?\n/).pop();
function git(args, cwd) { return spawnSync('git', args, { cwd, encoding: 'utf8' }); }
export function readLedger(G) { try { return JSON.parse(fs.readFileSync(path.join(G, LEDGER_FILE), 'utf8')); } catch { return null; } }

export function syncArgs(clone, G, req, force, check = false) {
  const args = [path.join(clone, SYNC_REL), check ? '--check' : '--apply', '--source', clone, '--global', G];
  if (req.profile) args.push('--profile', req.profile);
  if (req.with_hooks) args.push('--with-hooks');
  if (req.scrub !== false) args.push('--scrub');
  for (const t of req.personal_terms || []) args.push('--personal-terms', t);
  if (req.no_personal_terms) args.push('--no-personal-terms');
  if (force) args.push('--force');
  return args;
}
function applyFrom(clone, G, req, force, check = false) {
  const r = spawnSync(process.execPath, syncArgs(clone, G, req, force, check), { encoding: 'utf8', maxBuffer: 1 << 26 });
  process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || '');
  return r.status === null ? 1 : r.status;
}
async function doctorOf(clone, G) { return (await import(pathToFileURL(path.join(clone, SYNC_REL)).href)).doctor(G); }
function printDoctor(d, json) {
  if (json) { console.log(JSON.stringify(d, null, 2)); return; }
  if (d.code === 3) { console.log(`DOCTOR: ${d.reason}`); return; }
  for (const r of d.rows) if (r.status !== 'OK') console.log(`  ${r.status.padEnd(16)} ${r.path}${r.note ? ` (${r.note})` : ''}`);
  console.log(`DOCTOR ${d.code === 0 ? 'OK' : 'PROBLEMS'}: ${Object.entries(d.counts).map(([k, v]) => `${k}=${v}`).join(' ') || 'no files'}  version=${d.version}`);
}
/** Per path: added / updated (installed sha changed) / removed / kept_user_modified; unchanged is a count. */
export function ledgerDiff(before, after) {
  const b = new Map(((before && before.files) || []).map((f) => [f.path, f]));
  const a = new Map(((after && after.files) || []).map((f) => [f.path, f]));
  const out = { added: [], updated: [], removed: [], kept_user_modified: [], unchanged: 0 };
  for (const [p, f] of a) {
    const o = b.get(p);
    if (f.owner === 'user-modified') out.kept_user_modified.push(p);
    else if (!o) out.added.push(p);
    else if (o.installed_sha256 !== f.installed_sha256) out.updated.push(p);
    else out.unchanged++;
  }
  for (const p of b.keys()) if (!a.has(p)) out.removed.push(p);
  return out;
}

async function install(a) {
  const G = configDir(a);
  const clone = path.resolve(a.cloneDir || (a.repo ? path.join(os.homedir(), 'harness-source') : SELF_REPO));
  try { assertSeparateSourceConfig(clone, G); }
  catch (e) { console.error(`REFUSED: ${e.message}`); return 3; }
  if (a.repo && !fs.existsSync(clone)) {
    if (a.check) { console.error('REFUSED: --check/--dry-run needs an existing source clone; nothing was cloned'); return 3; }
    console.log(`cloning ${a.repo} -> ${clone}`);
    const r = git(['clone', '--quiet', a.repo, clone]);
    if (r.status !== 0) { console.error(`REFUSED: git clone failed (exit ${r.status}): ${lastLine(r.stderr)}`); return 4; }
  }
  if (!fs.existsSync(path.join(clone, '.claude', 'HARNESS-SOURCE')) || !fs.existsSync(path.join(clone, SYNC_REL))) {
    console.error(`REFUSED: ${clone} is not a harness source clone (.claude/HARNESS-SOURCE or the sync script is missing)`); return 3;
  }
  // I5 residue (2026-10-06, installer verifier A4): no mkdir here. The sync creates the config dir only when --apply
  // actually writes, so a refused install (exit 2/3) leaves no empty folder behind.
  console.log(`install: source ${clone} -> config dir ${G}`);
  const code = applyFrom(clone, G, { scrub: true, personal_terms: a.terms.map((t) => path.resolve(t)), no_personal_terms: a.noTerms, profile: a.profile, with_hooks: a.withHooks }, a.force, a.check);
  if (a.check) return code;
  if (code !== 0) { console.error(`install: apply exited ${code}; see above`); return code; }
  const d = await doctorOf(clone, G); printDoctor(d, a.json);
  return d.code;
}

async function update(a) {
  const G = configDir(a); const before = readLedger(G);
  if (!before || !before.request || !before.request.source) { console.error(`REFUSED: no ${LEDGER_FILE} with an install request in ${G}; run install first`); return 3; }
  const clone = before.request.source;
  try { assertSeparateSourceConfig(clone, G); }
  catch (e) { console.error(`REFUSED: ${e.message}`); return 3; }
  const st = git(['status', '--porcelain', '--untracked-files=no'], clone);
  if (st.status !== 0) { console.error(`REFUSED: ${clone} is not a usable git clone: ${lastLine(st.stderr)}`); return 4; }
  if (st.stdout.trim()) { console.error(`REFUSED: the source clone ${clone} has uncommitted changes to tracked files; update only pulls into a clean clone. Nothing was applied.`); return 4; }
  const head0 = git(['rev-parse', 'HEAD'], clone).stdout.trim();
  const p = git(['pull', '--ff-only', '--quiet'], clone);
  if (p.status !== 0) { console.error(`REFUSED: git pull --ff-only failed (diverged clone, no upstream or offline): ${lastLine(p.stderr)}. Nothing was applied.`); return 4; }
  const head1 = git(['rev-parse', 'HEAD'], clone).stdout.trim();
  console.log(`update: source ${clone} ${head0.slice(0, 12)} -> ${head1.slice(0, 12)}${head0 === head1 ? ' (already up to date)' : ''}; config dir ${G}`);
  const code = applyFrom(clone, G, before.request, a.force);
  if (code !== 0) { console.error(`update: apply exited ${code}; see above`); return code; }
  const diff = ledgerDiff(before, readLedger(G));
  console.log(`LEDGER DIFF added=${diff.added.length} updated=${diff.updated.length} removed=${diff.removed.length} kept_user_modified=${diff.kept_user_modified.length} unchanged=${diff.unchanged}`);
  for (const k of ['added', 'updated', 'removed', 'kept_user_modified']) for (const x of diff[k]) console.log(`  ${k.toUpperCase()} ${x}`);
  printDoctor(await doctorOf(clone, G), false);
  return 0;
}

async function doctorCmd(a) { const d = await doctorOf(SELF_REPO, configDir(a)); printDoctor(d, a.json); return d.code; }

export async function main(argv) {
  const a = parseArgs(argv);
  if (a.bad) { console.error(`unknown argument: ${a.bad}`); return 3; }
  if (a.cmd !== 'install' && (a.profile || a.withHooks || a.check)) {
    console.error('REFUSED: --profile, --with-hooks and --check/--dry-run are install options; update replays the recorded request'); return 3;
  }
  if (a.cmd === 'install') return install(a);
  if (a.cmd === 'update') return update(a);
  if (a.cmd === 'doctor') return doctorCmd(a);
  console.error('usage: node harness-install.mjs install|update|doctor [--config-dir <dir>] [--repo <url|path> --clone-dir <dir>] [--personal-terms <file>] [--no-personal-terms] [--force] [--json] [--profile <core|developer|security|full>] [--with-hooks] [--check|--dry-run]');
  return 3;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
