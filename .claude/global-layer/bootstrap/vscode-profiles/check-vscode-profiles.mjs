import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { profiles, options } from './setup-vscode-profiles.mjs';

function readJSON(path) { return JSON.parse(readFileSync(path, 'utf8')); }

function check(dir) {
  let manifest;
  let manifestError;
  try { manifest = readJSON(join(dir, 'harness-profiles', 'manifest.json')); }
  catch { manifestError = 'manifest missing or invalid'; }
  let passed = true;
  for (const profile of profiles) {
    const reasons = [];
    const entry = manifest?.[profile.name];
    if (manifestError) reasons.push(manifestError);
    else if (!entry) reasons.push('manifest entry missing');
    else if (entry.extension !== profile.extension ||
      Object.entries(profile.colours).some(([key, value]) => entry.colours?.[key] !== value)) {
      reasons.push('manifest entry mismatch');
    }
    try {
      const colours = readJSON(join(dir, 'harness-profiles', profile.name, 'settings.json'))['workbench.colorCustomizations'];
      if (Object.entries(profile.colours).some(([key, value]) => colours?.[key] !== value)) {
        reasons.push('settings colours missing or incorrect');
      }
    } catch { reasons.push('settings missing or invalid'); }
    try {
      if (!statSync(join(dir, `extensions-${profile.name}`, profile.extension)).isDirectory()) {
        reasons.push('extension folder missing');
      }
    } catch { reasons.push('extension folder missing'); }
    const ok = reasons.length === 0;
    passed &&= ok;
    console.log(`profile ${profile.name}: ${ok ? 'PASS manifest, settings and extension present' : `FAIL ${reasons.join('; ')}`}`);
  }
  console.log(`VSCODE-PROFILES ${passed ? 'PASS' : 'FAIL'}`);
  return passed ? 0 : 1;
}

try { process.exitCode = check(options(process.argv.slice(2)).dir); }
catch (error) { console.error(error.message); console.log('VSCODE-PROFILES FAIL'); process.exitCode = 1; }
