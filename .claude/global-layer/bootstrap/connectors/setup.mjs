#!/usr/bin/env node
import fs from 'node:fs';

// Account-level setup: print the catalog; OAuth remains an installer action.
const connectors = JSON.parse(fs.readFileSync(new URL('./connectors.json', import.meta.url), 'utf8'));
console.log('claude.ai > Connectors: select these entries');
for (const { name, pick_in_claude_ai } of connectors) console.log(`${name}\t${pick_in_claude_ai}`);
console.log('Feed connector_guard_rules.py MAIN-session transcripts; subagent transcripts never carry the structured load.');
