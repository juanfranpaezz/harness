// H-78 owner step: copy each staged workbench.colorCustomizations object into
// its real VS Code profile settings (User/profiles/<assigned-id>/settings.json).
// The CLI installs extensions; staging colours does not apply them in VS Code.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

export const profiles = JSON.parse(readFileSync(new URL('./profiles.json', import.meta.url), 'utf8'));

export function options(args, setup = false) {
  const { values } = parseArgs({ args, options: {
    'user-data-dir': { type: 'string' }, ...(setup ? { code: { type: 'string' } } : {})
  } });
  if (!values['user-data-dir'] || (setup && !values.code)) {
    throw new Error('Required: --user-data-dir <dir>' + (setup ? ' --code <CLI path>' : ''));
  }
  return { dir: resolve(values['user-data-dir']), code: values.code };
}

function writeIfChanged(path, value) {
  const text = JSON.stringify(value, null, 2) + '\n';
  try { if (readFileSync(path, 'utf8') === text) return; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  writeFileSync(path, text);
}

export function setup({ dir, code }) {
  const manifest = {};
  for (const profile of profiles) {
    const args = ['--profile', profile.name, '--install-extension', profile.extension, '--force',
      '--user-data-dir', dir, '--extensions-dir', join(dir, `extensions-${profile.name}`)];
    // JavaScript CLI entrypoints also allow a portable recording stub in tests.
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
    const result = spawnSync(command, cliArgs, { encoding: 'utf8', shell: batch, windowsHide: true });
    if (result.error || result.status !== 0) {
      throw new Error(`profile ${profile.name}: CLI failed: ${result.error?.message || result.stderr || result.status}`);
    }
    const destination = join(dir, 'harness-profiles', profile.name);
    mkdirSync(destination, { recursive: true });
    writeIfChanged(join(destination, 'settings.json'), { 'workbench.colorCustomizations': profile.colours });
    manifest[profile.name] = { extension: profile.extension, colours: profile.colours };
  }
  writeIfChanged(join(dir, 'harness-profiles', 'manifest.json'), manifest);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { setup(options(process.argv.slice(2), true)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
