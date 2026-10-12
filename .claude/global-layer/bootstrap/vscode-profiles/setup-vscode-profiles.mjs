// VS Code setup for the harness (H-86 round 3).
//   --mode default   (the installer's STEP 6): install the Claude Code extension into VS Code's DEFAULT profile.
//   --mode profiles  (manual, after the owner created the profiles in the VS Code interface): install the
//                    extension into each EXISTING harness profile and merge its colours into that profile's real
//                    settings.json (User/profiles/<location>/settings.json).
// The VS Code CLI cannot create a profile: `--profile <unknown>` fails with "Profile '<name>' not found."
// (measured on VS Code 1.141.0), so this script never tries to create one. Every step is idempotent: an
// extension that is already listed is not reinstalled and a settings file is written only when a colour differs.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

export const profiles = JSON.parse(readFileSync(new URL('./profiles.json', import.meta.url), 'utf8'));
export const EXTENSION = 'anthropic.claude-code';
export const MODES = ['default', 'profiles'];

export function options(args, setup = false) {
  const { values } = parseArgs({ args, options: {
    'user-data-dir': { type: 'string' }, 'extensions-dir': { type: 'string' },
    mode: { type: 'string', default: 'default' }, ...(setup ? { code: { type: 'string' } } : {})
  } });
  if (!values['user-data-dir'] || (setup && !values.code)) {
    throw new Error('Required: --user-data-dir <dir>' + (setup ? ' --code <CLI path>' : '') +
      ' [--mode default|profiles] [--extensions-dir <dir>]');
  }
  if (!MODES.includes(values.mode)) throw new Error(`--mode must be one of: ${MODES.join(', ')}`);
  return {
    dir: resolve(values['user-data-dir']), code: values.code, mode: values.mode,
    // Only an explicit --extensions-dir is passed to the CLI; otherwise VS Code uses its own default.
    explicitExtensionsDir: values['extensions-dir'] ? resolve(values['extensions-dir']) : undefined,
    extensionsDir: resolve(values['extensions-dir'] || join(homedir(), '.vscode', 'extensions')),
  };
}

/** Profiles the owner created in VS Code: name -> location, from User/globalStorage/storage.json. */
export function existingProfiles(dir) {
  let text;
  try { text = readFileSync(join(dir, 'User', 'globalStorage', 'storage.json'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return new Map(); throw error; }
  const storage = JSON.parse(text);
  return new Map((storage.userDataProfiles || []).filter(p => p && p.name && p.location).map(p => [p.name, p.location]));
}

export function profileDir(dir, location) { return join(dir, 'User', 'profiles', location); }

function cli(code, args) {
  // JavaScript CLI entrypoints also allow a portable stub in tests.
  let command = code;
  let cliArgs = args;
  const batch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(code);
  if (/\.mjs$/i.test(code)) { command = process.execPath; cliArgs = [code, ...args]; }
  if (batch) {
    const quote = value => {
      if (/["%!^&|<>\r\n]/.test(value)) throw new Error('Unsupported batch CLI path character');
      return `"${value}"`;
    };
    command = quote(command);
    cliArgs = cliArgs.map(quote);
  }
  return spawnSync(command, cliArgs, { encoding: 'utf8', shell: batch, windowsHide: true, timeout: 300000 });
}

function required(result, what) {
  if (result.error || result.status !== 0) {
    throw new Error(`${what}: CLI failed: ${String(result.error?.message || result.stderr || `exit ${result.status}`).trim()}`);
  }
  return result.stdout || '';
}

function ensureExtension(code, base, what) {
  const listing = required(cli(code, [...base, '--list-extensions']), what);
  if (listing.split(/\r?\n/).some(line => line.trim().split('@')[0].toLowerCase() === EXTENSION)) {
    console.log(`${what}: extension already installed`);
    return;
  }
  required(cli(code, [...base, '--install-extension', EXTENSION]), what);
  console.log(`${what}: extension installed`);
}

function applyColours(file, colours, what) {
  let settings = {};
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (text.trim()) {
    try { settings = JSON.parse(text); }
    catch { throw new Error(`${what}: ${file} is not plain JSON (comments or trailing commas); colours not applied, file left unchanged`); }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error(`${what}: ${file} is not a JSON object`);
  }
  const current = settings['workbench.colorCustomizations'] || {};
  if (Object.entries(colours).every(([key, value]) => current[key] === value)) {
    console.log(`${what}: colours already applied`);
    return;
  }
  settings['workbench.colorCustomizations'] = { ...current, ...colours };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 4) + '\n');
  console.log(`${what}: colours applied`);
}

/** Returns the number of harness profiles that do not exist yet (always 0 in default mode). */
export function setup({ dir, code, mode, explicitExtensionsDir }) {
  const extra = ['--user-data-dir', dir, ...(explicitExtensionsDir ? ['--extensions-dir', explicitExtensionsDir] : [])];
  if (mode === 'default') { ensureExtension(code, extra, 'default profile'); return 0; }
  const existing = existingProfiles(dir);
  let notCreated = 0;
  for (const profile of profiles) {
    const what = `profile ${profile.name}`;
    const location = existing.get(profile.name);
    if (!location) {
      console.log(`${what}: profile not created yet (create it in VS Code, then run this again); nothing changed`);
      notCreated++;
      continue;
    }
    ensureExtension(code, ['--profile', profile.name, ...extra], what);
    applyColours(join(profileDir(dir, location), 'settings.json'), profile.colours, what);
  }
  return notCreated;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (setup(options(process.argv.slice(2), true)) > 0) process.exitCode = 1; }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
