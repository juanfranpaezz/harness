#!/usr/bin/env python3
r"""verifier_actions_ledger.py - one ledger for every row of the `## ACTIONS` table of the verifier reports.

WHY (2026-10-08 audit of 330 verifier reports since 09-24, meta/cache/_audit-verifier-track-record-2026-10-08.md):
findings are almost never wrong (0.2% refuted) but 18.7% of the ACTIONS rows had no recorded action or were still
open. The weak link is what happens AFTER the report. This tool keeps the rows in one file with a state.

States: open | done (needs --evidence: a commit, report or command that shows it) | dropped (needs --reason).

Commands (all paths default to this repo; exit codes are part of the contract):
  sync [--since YYYY-MM-DD]        import new rows from meta/cache/_verifier-*.md; never changes a recorded state.
                                   Exit 0, or 1 when a report has an ACTIONS section it could not parse (named).
  mark KEY.. --done --evidence T | --dropped --reason T | --reopen --reason T
                                   Exit 0; 2 = refused (unknown key, short reason, or evidence that names no commit,
                                   path/report or command). KEY = <report>#<id>, or <report>#* = all its open rows.
  snooze KEY.. --until YYYY-MM-DD --reason T
                                   Hide open rows from `check` until that date (close-topic still blocks on them).
  check [--older-than N] [--today YYYY-MM-DD] [--brief] [--json]
                                   ADVISORY. Lists OPEN rows whose report is older than N days (default 3).
                                   Exit 0 none stale, 1 some stale, 2 ledger missing (never read as "0 open").
  close-topic TOPIC                Gate for marking a topic closed. TOPIC is a case-insensitive substring of the
                                   report file name. Exit 0 = every matching row is done/dropped; 1 = a matching row
                                   is open OR a matching report was never synced; 3 = nothing matched (not vouched).
Age is counted from the report date in the file name, so nothing needs marking daily: re-gates close a whole report
with `mark <old report>#* --done --evidence <new report>`, and rows that can wait are snoozed.
Round 2 (verifier AMEND 84): prefixed ACTIONS headings, several tables and `- A1: ...` bullets per section, fenced code
ignored, ACTIONS-shaped tables outside a section imported with a WARN, close-topic refuses on an unparsed sibling.
The row parser: the header row is mapped by name (id / change / owner / reversible / file), so column order does not
matter; a `|` inside a code span or escaped as `\|` does not split a cell; a row whose cell count does not fit the
header is KEPT (malformed=true, raw line stored), never dropped. Observe-only: wires nothing, edits no report.
"""
import argparse, datetime as dt, glob, hashlib, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
DEFAULT_CACHE = os.path.join(ROOT, "meta", "cache")
DEFAULT_LEDGER = os.path.join(ROOT, "meta", "verifier-actions-ledger.json")
REPORT_GLOB = "_verifier-*.md"
DATE_RE = re.compile(r"(\d{4}-\d{2}-\d{2})")
# Round 2 (verifier D3): an optional numbering prefix ("## 7. ACTIONS", "### A.5 ACTIONS (Artifact A)").
HEADING_RE = re.compile(r"^#{1,6}\s+(?:\*\*)?(?:[A-Za-z]?\d+(?:\.\d+)*[.)]?\s+|[A-Za-z](?:\.\d+)*[.)]?\s+)?"
                        r"(?:\*\*)?ACTIONS\b(.*)$", re.I)
ANY_HEADING_RE = re.compile(r"^#{1,6}\s")
FENCE_RE = re.compile(r"^\s*(```|~~~)")
NONE_RE = re.compile(r"^\W*(none|no actions?|nothing (?:to do|open))\b", re.I)
BULLET_RE = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+(?:\*\*|`)?(?P<id>[A-Z]{1,3}\d+[a-z]?)(?:\*\*|`)?\s*[:.)|\u2013\u2014-]\s*"
                       r"(?P<rest>\S.*)$")
SEP_RE = re.compile(r"^\s*\|[\s:|-]+\|?\s*$")
EVIDENCE_RE = re.compile(r"\b[0-9a-f]{7,40}\b|[/\\]|\.(?:md|py|mjs|js|json|txt|log)\b|^(?:py|node|git|npm)\s", re.I)
COLS = {"id": ("id",), "change": ("change",), "owner": ("owner",), "reversible": ("revers",), "file_line": ("file",)}


def split_row(line, code_aware=True):
    s = line.strip()
    if s.startswith("|"):
        s = s[1:]
    if s.endswith("|") and not s.endswith("\\|"):
        s = s[:-1]
    cells, cur, in_code, i = [], [], False, 0
    while i < len(s):
        ch = s[i]
        if ch == "\\" and i + 1 < len(s) and s[i + 1] == "|":
            cur.append("|"); i += 2; continue
        if ch == "`" and code_aware:
            in_code = not in_code
        if ch == "|" and not in_code:
            cells.append("".join(cur).strip()); cur = []
        else:
            cur.append(ch)
        i += 1
    cells.append("".join(cur).strip())
    return cells


def map_header(cells):
    low = [c.lower() for c in cells]
    out = {}
    for field, keys in COLS.items():
        for idx, c in enumerate(low):
            if any(c == k or c.startswith(k) for k in keys) and idx not in out.values():
                out[field] = idx
                break
    return out


def unfenced(lines):
    """Lines with fenced code blocks blanked out (round 2, verifier D6: a quoted template is not a report section)."""
    out, fence = [], None
    for line in lines:
        m = FENCE_RE.match(line)
        if fence is None and m:
            fence = m.group(1); out.append(""); continue
        if fence is not None:
            if line.strip().startswith(fence):
                fence = None
            out.append(""); continue
        out.append(line)
    return out


def read_table(lines, j, hmap, header):
    """Rows of the table whose header is lines[j]. -> (rows, index after the table)."""
    rows, k = [], j + 1
    if k < len(lines) and SEP_RE.match(lines[k]):
        k += 1
    while k < len(lines) and lines[k].lstrip().startswith("|"):
        raw = lines[k].strip()
        cells = split_row(raw)
        if len(cells) != len(header):
            plain = split_row(raw, code_aware=False)
            cells = plain if len(plain) == len(header) else cells
        row = {"raw": raw, "malformed": len(cells) != len(header), "form": "table"}
        for field, idx in hmap.items():
            row[field] = cells[idx] if idx < len(cells) else ""
        if row["malformed"]:
            row["change"] = raw
        rows.append(row)
        k += 1
    return rows, k


def bullet_row(m, raw):
    rest = m.group("rest").strip()
    own = re.search(r"\bowner\W{0,3}\s*\**([A-Za-z][\w-]*)", rest, re.I)
    rev = re.search(r"\breversible\W{0,3}\s*\**(yes|no)\b", rest, re.I)
    return {"raw": raw.strip(), "malformed": False, "form": "bullet", "id": m.group("id"), "change": rest,
            "owner": own.group(1) if own else "", "reversible": rev.group(1).lower() if rev else "", "file_line": ""}


def parse_actions(text):
    """-> (status, rows, error, warnings). status: table | none | no-section | unparsed.
    Round 2: prefixed headings; every table and every `- A1: ...` bullet under an ACTIONS heading; fenced code ignored;
    a section whose content parses to nothing is unparsed; an ACTIONS-shaped table (id + change + owner columns) under
    another heading is imported with outside_section=true and a warning."""
    lines = unfenced(text.splitlines())
    rows, errors, warnings = [], [], []
    saw_section = saw_none = False
    in_section, sec_rows, sec_text, heading = False, 0, False, ""
    i = 0

    def close_section():
        if in_section and sec_rows == 0 and sec_text and not sec_none:
            errors.append("ACTIONS section '%s' has content but no table or `- A1:` row was read" % heading[:80])

    sec_none = False
    while i < len(lines):
        line = lines[i]
        if ANY_HEADING_RE.match(line):
            close_section()
            m = HEADING_RE.match(line)
            in_section, sec_rows, sec_text, sec_none, heading = bool(m), 0, False, False, line.strip()
            if m:
                saw_section = True
                if NONE_RE.match(m.group(1).strip(" :-")):
                    saw_none = sec_none = True
            i += 1; continue
        if line.lstrip().startswith("|"):
            header = split_row(line)
            hmap = map_header(header)
            looks_actions = "id" in hmap and "change" in hmap
            if in_section and not looks_actions:
                errors.append("ACTIONS table header lacks an id or change column: " + line.strip()[:160])
                _, i = read_table(lines, i, {}, header); sec_text = True; continue
            if in_section or (looks_actions and "owner" in hmap):
                got, i = read_table(lines, i, hmap, header)
                if not in_section and got:
                    for r in got:
                        r["outside_section"] = True
                    warnings.append("ACTIONS-shaped table under '%s' (outside an ACTIONS section): %d row(s) imported"
                                    % (heading[:80] or "(no heading)", len(got)))
                rows.extend(got); sec_rows += len(got) if in_section else 0
                continue
            i += 1; continue
        if in_section and line.strip():
            b = BULLET_RE.match(line)
            if b:
                rows.append(bullet_row(b, line)); sec_rows += 1
            elif NONE_RE.match(line.strip()):
                saw_none = sec_none = True
            else:
                sec_text = True
        i += 1
    close_section()
    error = "; ".join(errors) if errors else None
    if error:
        return "unparsed", rows, error, warnings
    if rows:
        return "table", rows, None, warnings
    if saw_none:
        return "none", [], None, warnings
    return ("no-table" if saw_section else "no-section"), [], None, warnings


def report_date(path):
    m = DATE_RE.search(os.path.basename(path))
    if m:
        return m.group(1)
    return dt.date.fromtimestamp(os.path.getmtime(path)).isoformat()


def load(ledger_path):
    if not os.path.isfile(ledger_path):
        return None
    with open(ledger_path, encoding="utf-8") as fh:
        return json.load(fh)


def save(ledger_path, data):
    tmp = ledger_path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(data, fh, indent=1, ensure_ascii=False, sort_keys=True)
        fh.write("\n")
    os.replace(tmp, ledger_path)


def now_iso():
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


def cmd_sync(a):
    data = load(a.ledger) or {"schema": 1, "tracking_since": a.since or "", "rows": {}, "reports": {}}
    since = a.since or data.get("tracking_since") or ""
    added = changed = vanished = 0
    unparsed = []
    for path in sorted(glob.glob(os.path.join(a.cache, REPORT_GLOB))):
        rdate = report_date(path)
        if since and rdate < since:
            continue
        name = os.path.basename(path)
        with open(path, encoding="utf-8", errors="replace") as fh:
            status, rows, err, warns = parse_actions(fh.read())
        data["reports"][name] = {"status": status, "rows": len(rows), "date": rdate}
        if err:
            unparsed.append((name, err))
        for w in warns:
            print("WARN %s: %s" % (name, w))
        seen, keys_now = {}, set()
        for r in rows:
            rid = (r.get("id") or "").strip() or "row"
            seen[rid] = seen.get(rid, 0) + 1
            key = name + "#" + rid + ("" if seen[rid] == 1 else "#%d" % seen[rid])
            keys_now.add(key)
            tsha = hashlib.sha256(r["raw"].encode("utf-8")).hexdigest()[:16]
            old = data["rows"].get(key)
            fields = {f: r.get(f, "") for f in COLS}
            fields.update(report=name, report_date=rdate, malformed=r["malformed"], text_sha=tsha,
                          form=r.get("form", "table"), outside_section=bool(r.get("outside_section")))
            if old is None:
                fields.update(state="open", evidence="", reason="", first_seen=now_iso(), state_at="")
                data["rows"][key] = fields; added += 1
            elif old.get("text_sha") != tsha:
                old.update(fields); old["text_changed_at"] = now_iso(); changed += 1
                print("TEXT-CHANGED %s (state kept: %s)" % (key, old.get("state")))
        for key, row in data["rows"].items():
            if row.get("report") == name and key not in keys_now and not row.get("vanished"):
                row["vanished"] = True; vanished += 1
                print("VANISHED %s (row no longer in its report; state kept: %s)" % (key, row.get("state")))
    if a.since and not data.get("tracking_since"):
        data["tracking_since"] = a.since
    save(a.ledger, data)
    st = counts(data)
    print("sync: +%d new, %d text-changed, %d vanished; ledger %d rows (open %d, done %d, dropped %d); %d reports tracked"
          % (added, changed, vanished, len(data["rows"]), st["open"], st["done"], st["dropped"], len(data["reports"])))
    for name, err in unparsed:
        print("UNPARSED %s: %s" % (name, err))
    return 1 if unparsed else 0


def counts(data):
    c = {"open": 0, "done": 0, "dropped": 0}
    for r in data["rows"].values():
        c[r.get("state", "open")] = c.get(r.get("state", "open"), 0) + 1
    return c


def resolve_keys(data, key):
    """KEY, or <report>#* for every row of that report. -> list of keys ([] = unknown)."""
    if key.endswith("#*"):
        rep_name = key[:-2] if key[:-2].endswith(".md") else key[:-2] + ".md"
        return sorted(k for k, r in data["rows"].items() if r.get("report") == rep_name)
    one = resolve_key(data, key)
    return [one] if one else []


def resolve_key(data, key):
    if key in data["rows"]:
        return key
    if "#" in key:
        rep, rid = key.split("#", 1)
        if not rep.endswith(".md"):
            cand = rep + ".md#" + rid
            if cand in data["rows"]:
                return cand
    return None


def cmd_mark(a):
    data = load(a.ledger)
    if data is None:
        print("REFUSED: ledger missing (%s); run sync first" % a.ledger); return 2
    if a.done:
        state, text, label = "done", (a.evidence or "").strip(), "evidence"
    elif a.dropped:
        state, text, label = "dropped", (a.reason or "").strip(), "reason"
    else:
        state, text, label = "open", (a.reason or "").strip(), "reason"
    if len(text) < 10:
        print("REFUSED: --%s must say what shows it (a commit, report path or command; >= 10 chars)" % label); return 2
    if state == "done" and not EVIDENCE_RE.search(text):
        print("REFUSED: --evidence must name a commit (7+ hex), a file/report path or a command (py/node/git ...)")
        return 2
    keys = []
    for k in a.keys:
        rks = resolve_keys(data, k)
        if not rks:
            print("REFUSED: unknown key %s (nothing changed)" % k); return 2
        keys.extend(rk for rk in rks if not (k.endswith("#*") and state != "open"
                                             and data["rows"][rk].get("state") != "open"))
    for rk in keys:
        row = data["rows"][rk]
        row["state"], row["state_at"] = state, now_iso()
        if state == "done":
            row["evidence"] = text
        else:
            row["reason"] = text
        print("%s -> %s" % (rk, state))
    save(a.ledger, data)
    return 0


def cmd_snooze(a):
    data = load(a.ledger)
    if data is None:
        print("REFUSED: ledger missing (%s); run sync first" % a.ledger); return 2
    try:
        until = dt.date.fromisoformat(a.until)
    except ValueError:
        print("REFUSED: --until must be YYYY-MM-DD"); return 2
    if len((a.reason or "").strip()) < 10:
        print("REFUSED: --reason must say why it can wait (>= 10 chars)"); return 2
    keys = []
    for k in a.keys:
        rks = resolve_keys(data, k)
        if not rks:
            print("REFUSED: unknown key %s (nothing changed)" % k); return 2
        keys.extend(rks)
    for rk in keys:
        row = data["rows"][rk]
        if row.get("state", "open") == "open":
            row["snooze_until"], row["snooze_reason"] = until.isoformat(), a.reason.strip()
            print("%s snoozed until %s" % (rk, until.isoformat()))
    save(a.ledger, data)
    return 0


def age_days(row, today):
    try:
        return (today - dt.date.fromisoformat(row.get("report_date", ""))).days
    except ValueError:
        return 10 ** 6


def cmd_check(a):
    data = load(a.ledger)
    if data is None:
        print("verifier ACTIONS ledger: MISSING (%s) - open rows UNKNOWN, not zero; run sync" % a.ledger); return 2
    today = dt.date.fromisoformat(a.today) if a.today else dt.date.today()
    stale, snoozed = [], 0
    for key, r in sorted(data["rows"].items()):
        if r.get("state", "open") == "open":
            if r.get("snooze_until", "") >= today.isoformat():
                snoozed += 1; continue
            d = age_days(r, today)
            if d > a.older_than:
                stale.append((d, key, r))
    stale.sort(key=lambda t: (-t[0], t[1]))
    c = counts(data)
    summary = ("verifier ACTIONS ledger: %d open (%d older than %d d, %d snoozed), %d done, %d dropped"
               % (c["open"], len(stale), a.older_than, snoozed, c["done"], c["dropped"]))
    if a.json:
        print(json.dumps({"summary": summary, "stale": [{"key": k, "age_days": d, "owner": r.get("owner", ""),
                          "change": r.get("change", "")} for d, k, r in stale]}, ensure_ascii=False))
    elif a.brief:
        reps = sorted({r.get("report", "") for _, _, r in stale})
        print(summary + ("; in %d report(s), oldest: %s (%d d)" % (len(reps), stale[0][1], stale[0][0]) if stale else ""))
    else:
        print(summary)
        for d, key, r in stale:
            print("OPEN-STALE %dd %s owner=%s | %s" % (d, key, r.get("owner", ""), r.get("change", "")[:140]))
    return 1 if stale else 0


def cmd_close_topic(a):
    data = load(a.ledger)
    if data is None:
        print("CLOSE REFUSED: ledger missing (%s); run sync" % a.ledger); return 1
    t = a.topic.lower()
    matched = [(k, r) for k, r in sorted(data["rows"].items()) if t in r.get("report", "").lower()]
    since = data.get("tracking_since") or ""
    unsynced = []
    for p in sorted(glob.glob(os.path.join(a.cache, REPORT_GLOB))):
        n = os.path.basename(p)
        if t in n.lower() and n not in data.get("reports", {}) and (not since or report_date(p) >= since):
            unsynced.append(n)
    open_rows = [(k, r) for k, r in matched if r.get("state", "open") == "open"]
    bad_reports = sorted(n for n, v in data.get("reports", {}).items()
                         if t in n.lower() and v.get("status") in ("unparsed", "no-table"))
    for n in unsynced:
        print("UNSYNCED report %s (run sync before closing)" % n)
    for n in bad_reports:
        print("UNPARSED report %s (its ACTIONS section was not read; fix the report or the parser)" % n)
    for k, r in open_rows:
        print("OPEN %s owner=%s | %s" % (k, r.get("owner", ""), r.get("change", "")[:140]))
    if open_rows or unsynced or bad_reports:
        print("CLOSE REFUSED: topic '%s' has %d open verifier row(s), %d unsynced report(s), %d unparsed report(s)"
              % (a.topic, len(open_rows), len(unsynced), len(bad_reports)))
        return 1
    if not matched:
        rep = [n for n in data.get("reports", {}) if t in n.lower()]
        print("CLOSE NOT VOUCHED: no ledger row matches '%s' (%d tracked report(s) match with no ACTIONS rows)"
              % (a.topic, len(rep)))
        return 3
    print("CLOSE OK: topic '%s': %d verifier row(s), all done or dropped" % (a.topic, len(matched)))
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--ledger", default=DEFAULT_LEDGER)
    ap.add_argument("--cache", default=DEFAULT_CACHE)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("sync"); s.add_argument("--since")
    m = sub.add_parser("mark"); m.add_argument("keys", nargs="+")
    g = m.add_mutually_exclusive_group(required=True)
    g.add_argument("--done", action="store_true"); g.add_argument("--dropped", action="store_true")
    g.add_argument("--reopen", action="store_true")
    m.add_argument("--evidence"); m.add_argument("--reason")
    c = sub.add_parser("check"); c.add_argument("--older-than", type=int, default=3); c.add_argument("--today")
    c.add_argument("--brief", action="store_true"); c.add_argument("--json", action="store_true")
    z = sub.add_parser("snooze"); z.add_argument("keys", nargs="+"); z.add_argument("--until", required=True)
    z.add_argument("--reason")
    t = sub.add_parser("close-topic"); t.add_argument("topic")
    a = ap.parse_args(argv)
    return {"sync": cmd_sync, "mark": cmd_mark, "check": cmd_check, "close-topic": cmd_close_topic,
            "snooze": cmd_snooze}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
