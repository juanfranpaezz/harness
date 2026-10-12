// Read-only check of what setup-vscode-profiles.mjs is responsible for.
//   default mode: PASS when the Claude Code extension folder is in the default extensions dir; each harness profile
//                 is reported as present / missing / profile not created yet, for information only.
//   profiles mode: PASS only when each harness profile exists, lists the extension and carries its colours.
// VS Code names an installed extension folder <id>-<version>[-<platform>] (the extension id, a dash, a version such as 2.1.296, a dash, the platform),
// so the folder is matched by that pattern, never by the bare id.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { profiles, options, existingProfiles, profileDir, EXTENSION } from './setup-vscode-profiles.mjs';

export const FOLDER = new RegExp('^' + EXTENSION.replace(/[.]/g, '\\.') + '-\\d', 'i');

function isDir(path) { try { return statSync(path).isDirectory(); } catch { return false; } }

export function defaultFolder(extensionsDir) {
  try { return readdirSync(extensionsDir).find(name => FOLDER.test(name) && isDir(join(extensionsDir, name))); }
  catch { return undefined; }
}

function profileFolder(dir, location, extensionsDir) {
  let entries;
  try { entries = JSON.parse(readFileSync(join(profileDir(dir, location), 'extensions.json'), 'utf8')); }
  catch { return undefined; }
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (String(entry?.identifier?.id || '').toLowerCase() !== EXTENSION) continue;
    const folder = entry.relativeLocation ? join(extensionsDir, entry.relativeLocation) : entry.location?.fsPath;
    if (folder && FOLDER.test(basename(folder)) && isDir(folder)) return basename(folder);
  }
  return undefined;
}

function coloursApplied(dir, location, colours) {
  try {
    const current = JSON.parse(readFileSync(join(profileDir(dir, location), 'settings.json'), 'utf8'))['workbench.colorCustomizations'];
    return Object.entries(colours).every(([key, value]) => current?.[key] === value);
  } catch { return false; }
}

export function check({ dir, mode, extensionsDir }) {
  let passed = true;
  const folder = defaultFolder(extensionsDir);
  console.log(`default profile: extension ${folder ? `present (${folder})` : `missing (no ${EXTENSION}-<version> folder in ${extensionsDir})`}`);
  if (mode === 'default') passed = Boolean(folder);
  const existing = existingProfiles(dir);
  for (const profile of profiles) {
    const location = existing.get(profile.name);
    let state = 'profile not created yet';
    if (location) {
      const found = profileFolder(dir, location, extensionsDir);
      state = found ? `extension present (${found})` : 'extension missing';
      if (mode === 'profiles') {
        const colours = coloursApplied(dir, location, profile.colours);
        state += colours ? '; colours applied' : '; colours missing';
        if (!found || !colours) passed = false;
      }
    } else if (mode === 'profiles') passed = false;
    console.log(`profile ${profile.name}: ${state}`);
  }
  console.log(`VSCODE-PROFILES ${passed ? 'PASS' : 'FAIL'} (mode ${mode})`);
  return passed ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = check(options(process.argv.slice(2))); }
  catch (error) { console.error(error.message); console.log('VSCODE-PROFILES FAIL'); process.exitCode = 1; }
}
