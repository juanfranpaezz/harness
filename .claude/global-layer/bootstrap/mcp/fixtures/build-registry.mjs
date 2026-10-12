// Synthetic registry and dependency-free packages, not copies of the real releases.
// Run once to create deterministic fixture tarballs. Existing paths are never overwritten.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
function archive(files) {
  const chunks = [];
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(`package/${name}`, 0, 100);
    for (const [offset, size, number] of [[100, 8, 0o644], [108, 8, 0], [116, 8, 0], [124, 12, data.length], [136, 12, 0]]) {
      header.write(`${number.toString(8).padStart(size - 1, '0')}\0`, offset, size);
    }
    header.fill(32, 148, 156);
    header.write('0', 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
    chunks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}
const metadata = { synthetic: true, packages: { '@playwright/mcp': {
  time: { '0.0.82': '2020-01-01T00:00:00.000Z', '0.0.83': '2026-10-04T00:00:00.000Z' },
  versions: {},
} } };
const outputs = [];
for (const version of ['0.0.82', '0.0.83']) {
  const tarball = `playwright-mcp-${version}.tgz`;
  const bytes = archive({
    'package.json': JSON.stringify({ name: '@playwright/mcp', version, type: 'module', bin: { 'playwright-mcp': 'cli.js' } }),
    'cli.js': `console.log('Synthetic offline MCP fixture ${version}');\n`,
  });
  metadata.packages['@playwright/mcp'].versions[version] = {
    tarball, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
  };
  outputs.push([tarball, bytes]);
}
outputs.push(['registry.json', `${JSON.stringify(metadata, null, 2)}\n`]);
for (const [name] of outputs) {
  if (fs.existsSync(path.join(here, name))) throw new Error(`Refusing to overwrite ${name}`);
}
for (const [name, data] of outputs) fs.writeFileSync(path.join(here, name), data, { flag: 'wx' });
console.log('Created 2 synthetic package tarballs and registry.json');
