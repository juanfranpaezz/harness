import fs from 'node:fs';
import path from 'node:path';

const home = process.env.HOME;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(home, 'claude-calls.jsonl'), `${JSON.stringify(args)}\n`);
const modeFile = path.join(home, 'claude-mode.json');
const mode = fs.existsSync(modeFile) ? JSON.parse(fs.readFileSync(modeFile, 'utf8')) : {};
const config = process.env.CLAUDE_CONFIG_DIR;
if (config !== (process.env.CLAUDE_STUB_CONFIG || mode.configDir || path.join(home, '.claude')) ||
    ![home, config].includes(process.cwd())) throw new Error('Claude stub config routing failed');
fs.mkdirSync(config, { recursive: true });
if (args[0] !== 'mcp') process.exit(2);
if (args[1] === 'add') {
  if (mode.addFails) { console.error('Fixture registration failed'); process.exit(3); }
  const expected = ['mcp', 'add', args[2], '--scope', 'user', '--', 'node'];
  if (expected.some((part, i) => args[i] !== part) || !path.isAbsolute(args[7]) || !fs.existsSync(args[7])) process.exit(4);
  fs.appendFileSync(path.join(config, 'claude-registrations.jsonl'), `${JSON.stringify(args)}\n`);
} else if (args[1] === 'list') {
  if (mode.listFails) { console.error('Fixture list failed'); process.exit(5); }
  const records = path.join(config, 'claude-registrations.jsonl');
  const registered = fs.existsSync(records) ? fs.readFileSync(records, 'utf8').trim().split('\n').map(JSON.parse) : [];
  for (const record of registered) {
    if (!mode.missing) console.log(`${record[2]}: node ${record[7]} - ${mode.disconnected ? '✗ Failed to connect' : '✔ Connected'}`);
  }
} else process.exit(2);
