#!/usr/bin/env python3
r"""
instrument_fitness.py - deterministic, read-only fitness-for-purpose checker for a SIGNAL-EMITTING
instrument (a detector / logger / gate / hook that appends a JSONL .log). Closes the dec-09 bug class:
an observe-only instrument trusted without proving its load-bearing signal can EVER fire a positive.
Sibling of gate_coherence.py (the verifier RUNS it, never eyeballs).

WHAT IT ANSWERS (no model judgment -> running it IS the verification):
  For a named load-bearing FIELD in the log, does it actually VARY across real lines, or is it PINNED
  (structurally single-valued = inert, the dec-09 failure: would_dispatch_verifier false 7/7)?

CLASSIFICATION per field (coverage = fraction of parsed rows in which the field is present):
  - FIELD-ABSENT : the field appears in no row.
  - VARIES       : >= 2 distinct values -> the signal CAN fire both outcomes (fit).
  - PINNED       : exactly 1 distinct value AND coverage >= 0.95 (present on ~every turn yet never
                   changes) -> the dec-09 bug class (inert per-turn signal). THIS is what to FAIL on.
  - ONE-SIDED    : exactly 1 distinct value AND coverage < 0.95 -> a field that only logs on a firing
                   SUBSET (e.g. a category logged only when the guard fires) -> benign, NOT the bug class.

DISTINCT vs PINNED nuance: the coverage split separates "always present, never varies" (PINNED, the bug)
from "rarely present, single-valued" (ONE-SIDED, normal for an event-only field). The report ALWAYS prints
the raw {coverage, distinct, counts} so a human can override the label.

NOT COVERED (honest scope-OUT, dec-10/contract-vs-reality): a SEMANTIC-PROPERTY deliverable (a transformer /
library / refactor whose fitness is "produces the right artifact") emits no log-readable binary signal -> this
check is N/A there; that fitness stays human/judgment.

Read-only: never writes the target log. Fail-soft: any error -> an honest status line, exit 0 (a reporter;
the verifier/human decides). Stdlib only.

Usage:  py instrument_fitness.py <log_path> [--field <name>]   (no --field => auto-scan every field)
Output: JSON {log, parsed_rows, status, results:[{field,coverage,distinct,counts,n_present,classification}]}; exit 0.
"""
from __future__ import annotations
import json
import os
import sys

PINNED_COVERAGE = 0.95   # distinct==1 at/above this coverage = PINNED (per-turn inert); below = ONE-SIDED


def analyze_field(rows: list, field: str) -> dict:
    present = [r[field] for r in rows if isinstance(r, dict) and field in r]
    total = len(rows)
    coverage = (len(present) / total) if total else 0.0
    counts: dict[str, int] = {}
    for v in present:
        k = json.dumps(v, sort_keys=True)   # canonical key for bool/num/str/null/array
        counts[k] = counts.get(k, 0) + 1
    distinct = len(counts)
    if distinct == 0:
        cls = "FIELD-ABSENT"
    elif distinct >= 2:
        cls = "VARIES"
    elif coverage >= PINNED_COVERAGE:
        cls = "PINNED"
    else:
        cls = "ONE-SIDED"
    return {"field": field, "coverage": round(coverage, 4), "distinct": distinct,
            "counts": counts, "n_present": len(present), "classification": cls}


def main() -> None:
    args = sys.argv[1:]
    field = None
    positional = []
    i = 0
    while i < len(args):
        if args[i] == "--field" and i + 1 < len(args):
            field = args[i + 1]
            i += 2
        else:
            positional.append(args[i])
            i += 1

    if not positional:
        print(json.dumps({"log": None, "parsed_rows": 0, "status": "NO-LOG-ARG",
                          "results": []}, indent=2))
        sys.exit(0)

    log_path = os.path.abspath(positional[0])
    try:
        text = open(log_path, encoding="utf-8-sig").read()
    except OSError as e:
        print(json.dumps({"log": log_path, "parsed_rows": 0, "status": "UNREADABLE",
                          "detail": str(e), "results": []}, indent=2))
        sys.exit(0)

    rows = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            o = json.loads(line)
        except (ValueError, TypeError):
            continue          # non-JSON line -> skip, fail-soft
        if isinstance(o, dict):
            rows.append(o)

    if not rows:
        print(json.dumps({"log": log_path, "parsed_rows": 0, "status": "NO-DATA",
                          "results": []}, indent=2))
        sys.exit(0)

    if field is not None:
        fields = [field]
    else:
        seen: dict[str, None] = {}     # preserve first-seen order, dedup
        for r in rows:
            for k in r.keys():
                seen.setdefault(k, None)
        fields = list(seen.keys())

    results = [analyze_field(rows, f) for f in fields]
    print(json.dumps({"log": log_path, "parsed_rows": len(rows), "status": "OK",
                      "results": results}, indent=2))
    sys.exit(0)


if __name__ == "__main__":
    main()
