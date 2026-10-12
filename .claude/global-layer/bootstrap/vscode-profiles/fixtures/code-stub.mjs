// Offline stand-in for the VS Code CLI (`code`), faithful to the behaviours the harness depends on (VS Code 1.141.0):
// - `--profile <name>` for a profile absent from User/globalStorage/storage.json fails with
//   "Profile '<name>' not found." and exit 1 (the CLI cannot create profiles);
// - `--list-extensions` prints the ids in the profile's extensions.json (default profile: <extensions-dir>/extensions.json);
// - `--install-extension <id>` creates a versioned folder <id>-2.1.0-win32-x64 and records it, or reports it is
//   already installed. CODE_STUB_FAIL_INSTALL=1 makes an install fail; CODE_STUB_LOG records argv.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const value = flag => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
if (process.env.CODE_STUB_LOG) fs.appendFileSync(process.env.CODE_STUB_LOG, JSON.stringify(args) + '\n');
const userData = value('--user-data-dir') || path.join(process.env.APPDATA, 'Code');
const extensionsDir = value('--extensions-dir') || path.join(process.env.USERPROFILE, '.vscode', 'extensions');
const readJson = (file, fallback) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback);

let listFile = path.join(extensionsDir, 'extensions.json');
const name = value('--profile');
if (name !== undefined) {
  const storage = readJson(path.join(userData, 'User', 'globalStorage', 'storage.json'), {});
  const profile = (storage.userDataProfiles || []).find(p => p.name === name);
  if (!profile) { console.error(`Profile '${name}' not found.`); process.exit(1); }
  listFile = path.join(userData, 'User', 'profiles', profile.location, 'extensions.json');
}
const list = readJson(listFile, []);
if (args.includes('--list-extensions')) {
  for (const entry of list) console.log(entry.identifier.id);
} else if (args.includes('--install-extension')) {
  const id = value('--install-extension');
  if (process.env.CODE_STUB_FAIL_INSTALL) { console.error(`Failed Installing Extensions: ${id}`); process.exit(1); }
  if (list.some(entry => entry.identifier.id === id)) {
    console.log(`Extension '${id}' v2.1.0 is already installed.`);
  } else {
    const relativeLocation = `${id}-2.1.0-win32-x64`;
    fs.mkdirSync(path.join(extensionsDir, relativeLocation), { recursive: true });
    fs.mkdirSync(path.dirname(listFile), { recursive: true });
    fs.writeFileSync(listFile, JSON.stringify([...list, { identifier: { id }, version: '2.1.0', relativeLocation }]));
    console.log(`Extension '${id}' v2.1.0 was successfully installed.`);
  }
}
