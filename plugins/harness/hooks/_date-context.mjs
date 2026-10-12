#!/usr/bin/env node
// _date-context.mjs — Node port of the global UserPromptSubmit date entry (plan manifest 2026-09-25, P3 / F-4).
// The old entry was a bash one-liner (printf + `date '+%a %Y-%m-%d %H:%M %z'`): not portable to a
// shell-less Windows or to PowerShell. This emits the SAME JSON shape:
//   {"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"Current local date/time: Fri 2026-09-25 10:05 -0300"}}
// `format(date, offsetMinutes)` is pure: offsetMinutes is minutes EAST of UTC (-180 = UTC-3).
import { pathToFileURL } from 'node:url';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const p2 = (n) => String(n).padStart(2, '0');

export function format(date, offsetMinutes) {
  const off = Number.isFinite(offsetMinutes) ? Math.trunc(offsetMinutes) : 0;
  const d = new Date(date.getTime() + off * 60000);   // shifted so the UTC getters read local wall time
  const sign = off < 0 ? '-' : '+';
  const a = Math.abs(off);
  const z = `${sign}${p2(Math.floor(a / 60))}${p2(a % 60)}`;
  return `Current local date/time: ${DAYS[d.getUTCDay()]} ${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())} ${z}`;
}

export function payload(date = new Date()) {
  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: format(date, -date.getTimezoneOffset()) } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(JSON.stringify(payload())); } catch { /* fail-open: no context, no error */ }
  process.exit(0);
}
