#!/usr/bin/env node
// bootstrap.mjs — the THIN per-config-dir installer of the harness plugin (plan manifest 2026-09-25, P7).
//
//   node bootstrap/bootstrap.mjs [--config-dir <d>] [--personal <path to ceo-model.md>] [--deny-root <p>]... [--check]
//
// Target config dir = --config-dir, else CLAUDE_CONFIG_DIR, else <home>/.claude.
// Copies, from the folders NEXT TO this file: rules/CLAUDE.md -> <d>/CLAUDE.md, standards/*.md -> <d>/standards/,
// lenses/*.md -> <d>/lenses/. An existing destination that differs is backed up (<file>.bak-<stamp>) first; an equal
// one is left alone. NEVER writes settings*.json, plugins/, or credentials (a guard refuses those names).
// --personal copies ONLY the given file to <d>/ceo-model/ceo-model.md, and refuses a file inside this export.
// --deny-root merges each path into <d>/harness-deny-roots.txt (read by hooks/_global-runner.mjs), no duplicates.
// --check reports drift and writes nothing (exit 1 on drift). Deletes nothing, ever.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXPORT_ROOT = path.resolve(HERE, '..');
const BS = String.fromCharCode(92);
const norm = (p) => String(p).split(BS).join('/').trim().toLowerCase().replace(/\/+$/, '');

const args = process.argv.slice(2);
let cfgArg = ''; let personal = ''; let check = false; const denyRoots = [];
for (let i = 0; i < args.length; i++) {
  const v = args[i];
  if (v === '--config-dir') cfgArg = args[++i] || '';
  else if (v === '--personal') personal = args[++i] || '';
  else if (v === '--deny-root') denyRoots.push(args[++i] || '');
  else if (v === '--check') check = true;
  else { console.error(`BOOTSTRAP_REFUSED unknown-arg=${v}`); process.exit(3); }
}
const cfg = path.resolve(cfgArg || (process.env.CLAUDE_CONFIG_DIR || '').trim() || path.join(os.homedir(), '.claude'));

function forbidden(dst) {
  const rel = norm(path.relative(cfg, dst));
  const base = rel.split('/').pop();
  return /^settings[^/]*\.json$/.test(base) || rel.startsWith('plugins/') || rel === 'plugins' || base.startsWith('.credentials');
}
function stamp() {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function backupPath(dst) { let c = `${dst}.bak-${stamp()}`; for (let i = 2; fs.existsSync(c); i++) c = `${dst}.bak-${stamp()}-${i}`; return c; }

const plan = [];
const rulesSrc = path.join(HERE, 'rules', 'CLAUDE.md');
if (fs.existsSync(rulesSrc)) plan.push([rulesSrc, path.join(cfg, 'CLAUDE.md')]);
for (const sub of ['standards', 'lenses']) {
  const dir = path.join(HERE, sub);
  if (!fs.existsSync(dir)) continue;
  for (const n of fs.readdirSync(dir).filter((x) => x.endsWith('.md')).sort()) plan.push([path.join(dir, n), path.join(cfg, sub, n)]);
}
if (personal) {
  const pAbs = path.resolve(personal);
  if (!fs.existsSync(pAbs)) { console.error('BOOTSTRAP_REFUSED personal-file-missing'); process.exit(3); }
  if (norm(pAbs).startsWith(norm(EXPORT_ROOT) + '/')) { console.error('BOOTSTRAP_REFUSED personal-file-inside-export'); process.exit(3); }
  plan.push([pAbs, path.join(cfg, 'ceo-model', 'ceo-model.md')]);
}

let copied = 0; let same = 0; let backups = 0; let drift = 0; let personalCopied = 0; let denyAdded = 0;
for (const [src, dst] of plan) {
  if (forbidden(dst)) { console.error('BOOTSTRAP_REFUSED forbidden-destination'); process.exit(3); }
  const buf = fs.readFileSync(src);
  const exists = fs.existsSync(dst);
  if (exists && Buffer.compare(fs.readFileSync(dst), buf) === 0) { same++; continue; }
  drift++;
  if (check) continue;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (exists) { fs.copyFileSync(dst, backupPath(dst)); backups++; }
  fs.writeFileSync(dst, buf);
  copied++;
  if (personal && dst === path.join(cfg, 'ceo-model', 'ceo-model.md')) personalCopied++;
}

if (denyRoots.length) {
  const df = path.join(cfg, 'harness-deny-roots.txt');
  const cur = fs.existsSync(df) ? fs.readFileSync(df, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];
  const have = new Set(cur.map(norm));
  const add = [];
  for (const r of denyRoots) { const t = String(r).trim(); if (t && !have.has(norm(t))) { have.add(norm(t)); add.push(t); } }
  denyAdded = add.length;
  if (add.length) {
    drift++;
    if (!check) { fs.mkdirSync(cfg, { recursive: true }); fs.writeFileSync(df, cur.concat(add).join('\n') + '\n'); }
  }
}

console.log(`BOOTSTRAP copied=${copied} same=${same} backups=${backups} drift=${drift} personal=${personalCopied} deny_roots_added=${denyAdded} check=${check ? 1 : 0}`);
process.exit(check && drift ? 1 : 0);
