#!/usr/bin/env python3
r"""dispatch_lint.py - observe-only lint of a VERIFIER DISPATCH PROMPT against the mandatory clauses of
~/.claude/standards/verifier-creation.md (section "Dispatch contract").

WHY: the fresh-context line, the pinned artifact, the one output path that must not exist yet and the
report rules lived only in a copy-paste template; nothing read the Agent call's prompt (analyzer
meta/cache/_analyzer-verifier-creation-corpus-standard-2026-09-24.md, gap G1). A MISSING clause is
structural and detectable; that is all this tool claims. It does not judge whether a verifier obeyed.

MODES
  dispatch_lint.py PROMPT_FILE|-  [--subagent-type T] [--json]
      lint one prompt (file or stdin). Exit 0 = every clause PASS, 1 = at least one FAIL,
      2 = NEVER_LOOKED (input unreadable) -- never reported as clean.
  dispatch_lint.py --transcript SESSION.jsonl [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--all-roles] [--json]
      walk a Claude Code session transcript (port of the walk in .claude/hooks/_fork-vote-gate.mjs:79-104,
      whole file instead of one turn), lint every Agent/Task call whose subagent_type is a verification
      role, print a compliance table and the baseline %. Dates are LOCAL dates of the dispatch timestamp.
      Exit 0 = all compliant (or no verification dispatch in the window, printed as
      NO_VERIFICATION_DISPATCHES), 1 = at least one non-compliant, 2 = NEVER_LOOKED.
  dispatch_lint.py --tier-check --subagent-type T [--model M] [--agents-dir DIR] [--json]
      MODEL-TIER CHECK (observe-only; owner go 2026-10-08; design M2 in meta/cache/_analyzer-orchestrator-tool-
      mastery-2026-10-08.md). Given an Agent tool input, say whether the dispatched model costs MORE than the
      agent's own default and by how many tiers. The default is the `model:` line in the frontmatter of
      <agents dir>/T.md; no definition, no such line or `model: inherit` means "inherit": that is not a tier (the
      session model is unknown to a hook), so no comparison is claimed and the check stays silent. Cost order
      haiku < sonnet < opus < fable. Agents dir: --agents-dir, else env DISPATCH_LINT_AGENTS_DIR, else the
      .claude/agents beside this tool's .claude/tools, then ~/.claude/agents. Exit 0 = not above (silent),
      1 = above the default, 2 = NEVER_LOOKED (no agents directory exists). A separate function and CLI mode: the
      lint_prompt clauses and every mode above are untouched.

PROOF OF RUN: every run appends one JSON row to .claude/tools/verification_lints_runs.log (gitignored
*.log) unless VERIF_LINTS_NO_LOG=1 (tests). Observe-only: never blocks, never edits anything else.
Clause checks are regex heuristics on PRESENCE; a prompt can carry a clause and still be bad. Precision on
real prompts is unmeasured beyond the 2026-09-24 baseline in the coder notes.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
LOG_PATH = os.path.join(HERE, "verification_lints_runs.log")

# Eight roles whose job is to judge an artifact (scribe/secretary excluded: they write, they do not verify).
VERIFICATION_ROLES = {
    "verifier", "contract-checker", "grader", "memory-guard", "reversibility-reviewer",
    "selfcert-guard", "v1-coverage-checker", "arm-reviewer",
}

I = re.IGNORECASE
# Pin shapes in house use (A1, gate 2026-09-25): `path`@<git sha>, `path`@sha256:<hex16+>, bare path@sha256:<hex>,
# optionally `path` (short note)@..., optionally followed by " mtime <iso>" or " (...)". The quoted form allows spaces
# inside the quotes (Windows paths). "HEAD e9cbcd7 with uncommitted work" has no '@' and is NOT a pin.
_PATH_CH = r"[^\s@`'\"()<>\[\]]"
_QUOTED_PIN = r"[`'\"](?P<qpath>[^`'\"\n]{1,260}?)[`'\"](?:\s*\([^()\n]{0,120}\))?@"
# A bare "@<hex>" is classified by LENGTH (round 2, re-gate A3): 7-12 hex or exactly 40 = a git commit; 16-39 or 64
# hex = a CONTENT pin (sha256 prefix, the house `path@hex16` style), stored as path@sha256:<hex>; other lengths are
# not pins. `(?!\.[A-Za-z])` keeps an e-mail such as reviewer.bot@deadbeef1.com from reading as a pin.
PIN_GIT_RX = re.compile(r"(?:" + _QUOTED_PIN + r"|(?P<path>" + _PATH_CH + r"*[./\\]" + _PATH_CH + r"*)@)"
                        r"(?P<sha>[0-9a-f]{7,64})\b(?!\.[A-Za-z])")
PIN_SHA256_RX = re.compile(r"(?:" + _QUOTED_PIN + r"|(?P<path>" + _PATH_CH + r"+)@)sha256[:=]?(?P<sha>[0-9a-f]{16,64})\b"
                           r"(?!\.[A-Za-z])", I)
ABS_PATH_START_RX = re.compile(r"^(?:[A-Za-z]:[\\/]|[\\/]|~[\\/])")


def is_abs(p: str) -> bool:
    return bool(ABS_PATH_START_RX.match(p or ""))


def git_root(path: str) -> str | None:
    """The nearest folder at or above `path` that holds .git, or None."""
    d = path if os.path.isdir(path) else os.path.dirname(path)
    while d:
        if os.path.exists(os.path.join(d, ".git")):
            return d
        nd = os.path.dirname(d)
        if nd == d:
            return None
        d = nd
    return None
OUT_KW_RX = re.compile(r"\b(output|write|writes|written|save|saved)\b", I)
PATH_TOKEN_RX = re.compile(r"[^\s`'\"()<>\[\]*]+\.(?:md|jsonl|json|csv|txt)\b")
NEXT_LINE_PATH_RX = re.compile(r"^[\s>*\-`'\"]*(?P<p>[^\s`'\"()<>\[\]*]+\.(?:md|jsonl|json|csv|txt))\b")
_NEG = r"(?:never|do\s+not|don't|\bno\b|nunca)"
# A9 (gate 2026-09-25): each clause is anchored to its SENSE, not to a bare word anywhere in the prompt.
PC_SCOPE_RX = re.compile(r"(?:positive\s+control|control\s+positivo)[\s\S]{0,200}?\b(?:scope|alcance)\b|"
                         r"\b(?:scope|alcance)\b[\s\S]{0,200}?(?:positive\s+control|control\s+positivo)", I)
_RELAY = r"(?:relayed|second[- ]hand|de\s+segunda\s+mano|no\s+re-?derivad\w*)"
_NUMWORD = r"\b(?:numbers?|figures?|counts?|measured|metrics?|cifras?|n[uú]meros?|medid\w*)\b"
RELAY_NUM_RX = re.compile(_RELAY + r"[^\n]{0,120}?" + _NUMWORD + "|" + _NUMWORD + r"[^\n]{0,120}?" + _RELAY, I)  # same line
SECRET_RX = re.compile(_NEG + r"[^\n]{0,60}\b(?:print|emit|log|paste|echo|reveal|expose|leak|imprim|pegu|pegar|logue|"
                       r"devuelv|devolv|mostr)\w*[^\n]{0,60}\b(?:secret|credential|password|api[- ]?key|token|secreto|credencial|"
                       r"contrase[nñ]a)s?\b|\b(?:secret|credential|secreto)s?\b[^\n]{0,40}\b(?:values?|valor)\b|"
                       r"\bvalor\b[^\n]{0,30}\bsecret", I)
KILL_RX = re.compile(_NEG + r"[^\n]{0,80}(?:\bkill\w*|taskkill|pkill|killall|\bmat[aeá]\w*)[^\n]{0,80}?"
                     r"(?:image\s+name|by\s+(?:its\s+)?name|/IM\b|-Name\b|nombre)|"
                     + _NEG + r"[^\n]{0,20}(?:taskkill\s*/IM|pkill|killall)", I)
BOTH_WAYS_RX = re.compile(r"both\s+ways|both\s+(?:its\s+)?outcomes|both\s+directions|ambos\s+resultados|"
                          r"fires?\s+(?:and|/)\s+(?:one\s+where\s+it\s+)?(?:does\s+not|doesn't)|"
                          r"named\s+positive[\s\S]{0,120}?named\s+negative|red[- ]then[- ]green|"
                          r"\bfires?\b[^\n]{0,80}\b(?:silent|quiet|does\s+not\s+fire|doesn't\s+fire)", I)
FRESH_OPEN_RX = re.compile(r"^[\s#>*_\-\"'`]*(?:re-?deriv\w*\s+from\s+the\s+artifacts?|re-?deriv[aá]\s+desde\s+el\s+artefacto)", I)
GENERIC_STEM_RX = re.compile(r"^(?:(?:part|sec|chunk)\d*|output|out|temp|tmp|notes?|results?|report|summary|findings)$", I)


def _has(rx: str, text: str) -> bool:
    return re.search(rx, text, I) is not None


def extract_pins(text: str) -> list[str]:
    """Every pin in TEXT ORDER (round 3, A3: the registry's "first pin" is the textually first one)."""
    # Round 6 (C1): the same path rule for BOTH forms: an unquoted left side must contain ., / or \, so a Docker
    # digest such as ubuntu@sha256:<hex> or Makefile@sha256:<hex> in prose is not a pin; `Makefile`@sha256:<hex> is.
    found = [(m.start(), f"{m.group('qpath') or m.group('path')}@sha256:{m.group('sha')}")
             for m in PIN_SHA256_RX.finditer(text)
             if m.group("qpath") or re.search(r"[./\\]", m.group("path") or "")]
    for m in PIN_GIT_RX.finditer(text):
        p, sha = m.group("qpath") or m.group("path"), m.group("sha")
        # Round 5 (A1): a QUOTED path may be a bare word (`Makefile`@abc1234, `x`@abc1234 are pins); an UNQUOTED
        # token must look like a path (., / or \), so prose such as master@6ab1906 or word@abc1234 is not a pin.
        if not m.group("qpath") and not re.search(r"[./\\]", p):
            continue
        if 7 <= len(sha) <= 12 or len(sha) == 40:
            found.append((m.start(), f"{p}@{sha}"))
        elif 16 <= len(sha) <= 39 or len(sha) == 64:  # round 3, A2: exactly the spec; 13-15 and 41-63 are NOT pins
            found.append((m.start(), f"{p}@sha256:{sha}"))  # house content pin path@hex16 (sha256 prefix)
    return [pin for _, pin in sorted(found, key=lambda x: x[0])]


def normalize_path(tok: str) -> str:
    p = tok.replace("\\", "/").rstrip(".,;:")
    if is_abs(p):  # round 2 (re-gate A2): an absolute path stays absolute (~ expanded) in every leg
        return os.path.expanduser(p).replace("\\", "/")
    for anchor in ("meta/", ".claude/", "tests/"):
        k = p.find(anchor)
        if k > 0:
            return p[k:]
    return p


def extract_output_paths(text: str) -> list[str]:
    """Paths on a line that carries an output keyword (output/write/save), in order, de-duplicated. When that line
    names no path, the next non-blank line (within 2 lines) is read too if it OPENS with a path, e.g.
    "OUTPUT:" then "meta/cache/_coder-x.md" on the following line (A2, gate 2026-09-25)."""
    out: list[str] = []
    lines = text.splitlines()
    for i, line in enumerate(lines):
        m = OUT_KW_RX.search(line)
        if not m:
            continue
        toks = PATH_TOKEN_RX.findall(line[m.start():])
        if not toks:
            for nxt in lines[i + 1:i + 3]:
                if not nxt.strip():
                    continue
                head = NEXT_LINE_PATH_RX.match(nxt)
                if head:
                    toks = [head.group("p")]
                break
        for t in toks:
            p = normalize_path(t)
            if p not in out:
                out.append(p)
    return out


def pick_report_path(paths: list[str], role: str | None) -> str | None:
    if not paths:
        return None
    if role:
        for p in paths:
            if os.path.basename(p).startswith(f"_{role}-"):
                return p
    for p in paths:
        if os.path.basename(p).startswith("_"):
            return p
    return paths[0]


def resolve_pin(pin: str, abspath: str | None, root: str | None) -> str:
    """Informational: does the pin point at something real? Never changes a clause verdict. The caller locates the
    file (abspath) and its repo root; nothing here falls back to the harness repo (round 2, re-gate A1/A2)."""
    sha = pin.rpartition("@")[2]
    if not abspath:
        return "UNRESOLVED"
    try:
        if sha.startswith("sha256:"):
            import hashlib
            data = open(abspath, "rb").read()
            hs = (hashlib.sha256(data).hexdigest(), hashlib.sha256(data.replace(b"\r\n", b"\n")).hexdigest())
            return "sha256-match" if any(h.startswith(sha[7:]) for h in hs) else "sha256-mismatch"
        if not root:
            return "UNRESOLVED"
        rel = os.path.relpath(abspath, root).replace("\\", "/")
        r = subprocess.run(["git", "cat-file", "-e", f"{sha}:{rel}"], cwd=root, capture_output=True, timeout=20)
        if r.returncode == 0:
            return "path-at-sha"
        r = subprocess.run(["git", "cat-file", "-e", f"{sha}^{{commit}}"], cwd=root, capture_output=True, timeout=20)
        return "commit-only" if r.returncode == 0 else "unresolved"
    except (OSError, subprocess.SubprocessError, ValueError):
        return "unresolved"


def _clauses(text: str) -> list[tuple[str, str, bool, str]]:
    pins = extract_pins(text)
    outs = extract_output_paths(text)
    semantic = [p for p in outs if not GENERIC_STEM_RX.match(os.path.splitext(os.path.basename(p))[0])]
    # D01 = all three fragments of the literal line, and the line OPENS the prompt (first non-blank line).
    fresh_en = _has(r"re-?deriv\w*\s+from\s+the\s+artifacts?", text) and \
        _has(r"do\s+not\s+use\s+anything\s+from\s+the\s+conversation", text) and \
        _has(r"if\s+you\s+know\s+(?:an?|the)\s+expected\s+result", text)
    fresh_es = _has(r"re-?deriv[aá]\s+desde\s+el\s+artefacto", text) and \
        _has(r"no\s+uses\s+nada\s+de\s+la\s+conversaci[oó]n", text) and \
        _has(r"si\s+conoc[eé]s\s+el\s+resultado\s+esperado", text)
    first_line = next((ln for ln in text.splitlines() if ln.strip()), "")
    fresh_first = bool(FRESH_OPEN_RX.match(first_line))
    leak = re.search(r"expected\s+(?:result|verdict|outcome|answer)\s*(?:is|was|:|=)(?!\s*(?:never|not)\b)|"
                     r"the\s+answer\s+is\b|should\s+(?:come\s+back|return)\s+(?:PASS|ACCEPT|green)|"
                     r"resultado\s+esperado\s*(?:es|:)(?!\s*(?:nunca|no)\b)", text, I)
    pc = _has(r"positive\s+control|control\s+positivo", text)
    fresh_ok = (fresh_en or fresh_es) and fresh_first
    return [
        ("D01", "FRESH_CONTEXT_LITERAL", fresh_ok,
         "missing the literal fresh-context line ('Re-derive from the artifact ... Do NOT use anything from the conversation "
         "...; if you know an expected result, ignore it ...')" if not (fresh_en or fresh_es) else
         "the fresh-context line is present but is not the FIRST line of the prompt"),
        ("D02", "ARTIFACT_PINNED_PATH_AT_SHA", bool(pins),
         "no '<path>@<git sha>' or '<path>@sha256:<hex>' pin anywhere in the prompt"),
        ("D03", "CLAIMS_NOT_EVIDENCE_POINTER", _has(r"claims?\s*[,(:\-—]?\s*not\s+evidence|afirmaciones,?\s*\(?no\s+evidencia", text),
         "no 'Claims (not evidence)' pointer to the builder's report"),
        ("D04", "ONE_SEMANTIC_OUTPUT_PATH", bool(semantic),
         "no semantically named output path on an output/write line" + (f" (generic only: {outs})" if outs else "")),
        ("D05", "OUTPUT_MUST_NOT_EXIST", _has(r"must\s+not\s+(?:already\s+)?exist|does\s+not\s+exist\s+yet|"
                                            r"no\s+debe\s+existir|existence\s+check|not\s+exist\s+before", text),
         "no instruction that the output path must not exist yet"),
        ("D06", "VERDICT_FIRST_HEADING", _has(r"##\s*VERDICT:", text) and _has(r"confidence", text),
         "no '## VERDICT: <TOKEN> (confidence NN)' first-heading instruction"),
        ("D07", "BOTH_WAYS", BOTH_WAYS_RX.search(text) is not None,
         "no both-ways (fires / does-not-fire) requirement"),
        ("D08", "POSITIVE_CONTROL_WITH_SCOPE", PC_SCOPE_RX.search(text) is not None,
         "no positive-control requirement" if not pc else "positive control named but no declared scope within ~200 chars of it"),
        ("D09", "BIG_FILE_RULE", _has(r"10\s*MB|longest\s+line|large\s+file|big[- ]file|archivo\s+grande|"
                                      r"l[ií]nea\s+m[aá]s\s+larga", text),
         "no big-file rule (size + longest line before a text-search absence)"),
        ("D10", "NO_HEAD_TAIL_TRUNCATION", _has(r"truncat|head\s*/\s*tail|head\s+or\s+tail|head_limit", text),
         "no ban on head/tail truncation of an enumeration"),
        ("D11", "RELAYED_VS_MEASURED", RELAY_NUM_RX.search(text) is not None,
         "no instruction to mark numbers as relayed vs measured ('relayed' must sit within ~120 chars of number/measured)"),
        ("D12", "NOT_VERIFIED_SECTION", _has(r"not\s+verified|did\s+not\s+verify|no\s+verifiqu|unverified", text),
         "no 'Not verified' section requirement"),
        ("D13", "NO_SECRET_VALUES", SECRET_RX.search(text) is not None,
         "no 'never print/emit/log/paste a secret value' clause"),
        ("D14", "NO_KILL_BY_IMAGE_NAME", KILL_RX.search(text) is not None,
         "no 'never kill a process by image name' clause (a kill ban must name image name, /IM, -Name, pkill or killall)"),
        ("D15", "NO_LEAKED_EXPECTATION", leak is None,
         f"prompt leaks an expected result: '{leak.group(0)}'" if leak else ""),
    ]


def lint_prompt(text: str) -> list[dict]:
    return [{"id": cid, "name": name, "status": "PASS" if ok else "FAIL", "detail": "" if ok else why}
            for cid, name, ok, why in _clauses(text)]


def to_local(ts: str | None) -> datetime | None:
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone()
    except ValueError:
        return None


RAW_AGENT_RX = re.compile(r'"type"\s*:\s*"tool_use"[^\n]{0,400}?"name"\s*:\s*"(?:Agent|Task)"|'
                          r'"name"\s*:\s*"(?:Agent|Task)"[^\n]{0,400}?"type"\s*:\s*"tool_use"')


def iter_dispatches(path: str) -> tuple[list[dict], int, int]:
    """Every Agent/Task tool_use in a transcript, deduplicated by tool_use id. Raises OSError if unreadable.
    Returns (dispatches, number_of_json_object_lines, raw_agent_tool_use_lines). The raw count is a
    schema-independent regex over the unparsed lines: it feeds the SILENT-ZERO guard (0 parsed while raw > 0
    means the walker is mis-aimed, as a brace glob was twice on 2026-09-24). Non-JSON / non-object lines are
    skipped, as in the Node walker it ports."""
    seen: set[str] = set()
    out: list[dict] = []
    n_obj = 0
    n_raw = 0
    session = os.path.splitext(os.path.basename(path))[0]
    with open(path, encoding="utf-8", errors="replace") as fh:
        for ln in fh:
            if not ln.strip():
                continue
            if RAW_AGENT_RX.search(ln):
                n_raw += 1
            try:
                o = json.loads(ln)
            except ValueError:
                continue
            if not isinstance(o, dict):
                continue
            n_obj += 1
            role = o.get("type") or o.get("role")
            msg = o.get("message") if isinstance(o.get("message"), dict) else {}
            content = msg.get("content", o.get("content"))
            if role != "assistant" or not isinstance(content, list):
                continue
            for c in content:
                if not isinstance(c, dict) or c.get("type") != "tool_use" or c.get("name") not in ("Agent", "Task"):
                    continue
                tid = c.get("id") or f"{o.get('timestamp')}:{len(out)}"
                if tid in seen:
                    continue
                seen.add(tid)
                inp = c.get("input") if isinstance(c.get("input"), dict) else {}
                out.append({"tool_use_id": tid, "timestamp": o.get("timestamp"),
                            "session": o.get("sessionId") or session, "cwd": o.get("cwd") or "",
                            "subagent_type": inp.get("subagent_type") or "",
                            "description": inp.get("description") or "",
                            "prompt": inp.get("prompt") or ""})
    return out, n_obj, n_raw


def silent_zero(dispatches: list, n_raw: int) -> bool:
    return not dispatches and n_raw > 0


def in_window(ts: str | None, since: str | None, until: str | None) -> bool:
    d = to_local(ts)
    if d is None:
        return since is None and until is None
    day = d.date().isoformat()
    return (since is None or day >= since) and (until is None or day <= until)


def log_run(tool: str, mode: str, target: str, result: dict) -> None:
    if os.environ.get("VERIF_LINTS_NO_LOG") == "1":
        return
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as fh:
            fh.write(json.dumps({"ts": datetime.now(timezone.utc).isoformat(timespec="seconds"), "tool": tool,
                                 "mode": mode, "target": str(target)[:300], "result": result}) + "\n")
    except OSError:
        pass


# -- model-tier check (observe-only): its own functions and CLI mode, never inside lint_prompt ------------------
# Cost order fixed by the owner on 2026-10-08: haiku < sonnet < opus < fable. A model is "above" an agent's default
# when it ranks higher. 'inherit' (no definition, no `model:` line, or `model: inherit`) is NOT a tier: the session
# model is unknown to a hook, so nothing is claimed and the check stays silent.
TIER_ORDER = ("haiku", "sonnet", "opus", "fable")
TIER_RANK = {t: i for i, t in enumerate(TIER_ORDER)}
TIER_FAMILY_RX = re.compile("|".join(TIER_ORDER), I)
AGENT_NAME_RX = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")   # a plain file stem: no separator, no leading dot
MODEL_LINE_RX = re.compile(r"^model[ \t]*:[ \t]*(.*?)[ \t]*$")


def model_family(value) -> str | None:
    """'opus', 'OPUS', 'claude-opus-5-5', 'opus[1m]' -> 'opus'. 'inherit', '', None, a non-string, or text naming no
    family (or two) -> None: an unrecognised model is never claimed to be above anything."""
    if not isinstance(value, str):
        return None
    found = {m.lower() for m in TIER_FAMILY_RX.findall(value)}
    return next(iter(found)) if len(found) == 1 else None


def frontmatter_model(text: str) -> str | None:
    """Raw value of the `model:` key in the LEADING frontmatter block of an agent definition (quotes and a trailing
    ' # comment' removed), or None when there is no frontmatter or no such key at column 0. Only the block between
    the first two '---' lines is read: scribe.md carries a `name:` line further down in its body."""
    lines = text.lstrip("﻿").splitlines()
    if not lines or lines[0].strip() != "---":
        return None
    for ln in lines[1:]:
        if ln.strip() == "---":
            return None
        m = MODEL_LINE_RX.match(ln)
        if m:
            v = re.sub(r"\s+#.*$", "", m.group(1)).strip().strip("'\"").strip()
            return v or None
    return None


def default_agents_dirs() -> list[str]:
    """Agent-definition lookup when neither --agents-dir nor DISPATCH_LINT_AGENTS_DIR is given: the .claude/agents
    beside this tool's .claude/tools (project or global layout), then the user-level ~/.claude/agents."""
    return [os.path.join(os.path.dirname(HERE), "agents"), os.path.join(os.path.expanduser("~"), ".claude", "agents")]


def agent_default(name, agents_dirs: list[str]) -> tuple[str, str]:
    """(raw default model or 'inherit', source). The source is the definition file's path when a `model:` line was
    read, else the reason the answer is 'inherit' (no-definition, no-model-line, unreadable-definition)."""
    if not isinstance(name, str) or not AGENT_NAME_RX.match(name):
        return "inherit", "no-definition (not a plain agent name)"
    for d in agents_dirs:
        p = os.path.join(d, name + ".md")
        if not os.path.isfile(p):
            continue
        try:
            with open(p, encoding="utf-8", errors="replace") as fh:
                raw = frontmatter_model(fh.read())
        except OSError:
            return "inherit", "unreadable-definition"
        return (raw, p) if raw else ("inherit", "no-model-line")
    return "inherit", "no-definition"


def tier_check(subagent_type, model, agents_dirs: list[str] | None = None) -> dict:
    """Observe-only: does `model` cost MORE than the agent's own default? Judges nothing else.
    status: ABOVE_DEFAULT (the only one that warns) | SAME_AS_DEFAULT | BELOW_DEFAULT | NO_MODEL (omitted) |
    UNKNOWN_MODEL (names no known family) | NO_COMPARABLE_DEFAULT (default is inherit or unrecognised) |
    NEVER_LOOKED (no agents directory exists, so no default could be read: never reported as clean)."""
    dirs = list(agents_dirs) if agents_dirs is not None else default_agents_dirs()
    sub = subagent_type if isinstance(subagent_type, str) else ""
    mfam = model_family(model)
    res = {"subagent_type": sub, "model": model if isinstance(model, str) else None, "model_family": mfam,
           "default": None, "default_family": None, "default_source": None, "steps": None, "above": False,
           "status": "", "detail": "", "line": ""}
    if not isinstance(model, str) or not model.strip():
        res["status"] = "NO_MODEL"
        return res
    if mfam is None:
        res["status"] = "UNKNOWN_MODEL"
        res["detail"] = "dispatched model names none of " + "/".join(TIER_ORDER) + "; no comparison made"
        return res
    if not any(os.path.isdir(d) for d in dirs):
        res["status"] = "NEVER_LOOKED"
        res["detail"] = "no agents directory found (looked in: " + "; ".join(dirs) + ")"
        return res
    raw, src = agent_default(sub, dirs)
    dfam = model_family(raw)
    res.update(default=raw, default_family=dfam, default_source=src)
    if dfam is None:
        res["status"] = "NO_COMPARABLE_DEFAULT"
        res["detail"] = f"default is '{raw}' ({src}); the session model is unknown to a hook, no comparison made"
        return res
    steps = TIER_RANK[mfam] - TIER_RANK[dfam]
    res["steps"] = steps
    if steps > 0:
        res.update(status="ABOVE_DEFAULT", above=True,
                   line=f"[tier-check] {sub} dispatched on {mfam}; its default is {dfam} "
                        f"({steps} tier{'s' if steps != 1 else ''} above; cost order {' < '.join(TIER_ORDER)}). "
                        f"Observe-only, not a block.")
    else:
        res["status"] = "SAME_AS_DEFAULT" if steps == 0 else "BELOW_DEFAULT"
    return res


def run_tier_check(a) -> int:
    env_dir = os.environ.get("DISPATCH_LINT_AGENTS_DIR")
    dirs = [a.agents_dir] if a.agents_dir else ([env_dir] if env_dir else None)
    res = tier_check(a.subagent_type or "", a.model, dirs)
    if a.json:
        print(json.dumps(res, indent=1))
    elif res["status"] == "NEVER_LOOKED":
        print(f"NEVER_LOOKED: {res['detail']}")
    elif res["above"]:
        print(res["line"])
    else:
        print(f"tier-check {res['subagent_type'] or '-'} on {res['model_family'] or res['model'] or '-'}: {res['status']}"
              + (f" (default {res['default_family']})" if res["default_family"] else "")
              + (f" - {res['detail']}" if res["detail"] else ""))
    log_run("dispatch_lint", "tier", f"{res['subagent_type']}:{res['model']}",
            {"status": res["status"], "above": res["above"]})
    return 2 if res["status"] == "NEVER_LOOKED" else (1 if res["above"] else 0)


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):  # never crash on a non-cp1252 char in a description
        sys.stdout.reconfigure(errors="replace")
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("prompt", nargs="?", help="prompt file, or - for stdin")
    ap.add_argument("--subagent-type", default=None)
    ap.add_argument("--transcript", default=None)
    ap.add_argument("--since", default=None)
    ap.add_argument("--until", default=None)
    ap.add_argument("--all-roles", action="store_true")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--tier-check", action="store_true",
                    help="model-tier check of an Agent input (--subagent-type, --model); observe-only")
    ap.add_argument("--model", default=None, help="with --tier-check: the model the Agent call asked for")
    ap.add_argument("--agents-dir", default=None, help="with --tier-check: where <subagent_type>.md definitions live")
    a = ap.parse_args()

    if a.tier_check:
        if a.prompt or a.transcript:
            ap.error("--tier-check takes --subagent-type and --model, not a prompt file or --transcript")
        return run_tier_check(a)
    if a.model is not None or a.agents_dir is not None:
        ap.error("--model and --agents-dir only apply with --tier-check")

    if a.transcript:
        try:
            ds, n_obj, n_raw = iter_dispatches(a.transcript)
        except OSError as e:
            print(f"NEVER_LOOKED: transcript unreadable: {e}")
            log_run("dispatch_lint", "transcript", a.transcript, {"status": "NEVER_LOOKED"})
            return 2
        if n_obj == 0:
            print("NEVER_LOOKED: transcript has no JSON object lines")
            log_run("dispatch_lint", "transcript", a.transcript, {"status": "NEVER_LOOKED"})
            return 2
        if silent_zero(ds, n_raw):
            print(f"NEVER_LOOKED: SILENT_ZERO guard: walker parsed 0 Agent/Task calls but {n_raw} raw line(s) "
                  f"carry one; the transcript schema moved or the walker is mis-aimed")
            log_run("dispatch_lint", "transcript", a.transcript, {"status": "SILENT_ZERO", "raw": n_raw})
            return 2
        ds = [d for d in ds if (a.all_roles or d["subagent_type"] in VERIFICATION_ROLES)
              and in_window(d["timestamp"], a.since, a.until)]
        rows = []
        for d in ds:
            cl = lint_prompt(d["prompt"])
            rows.append({**{k: d[k] for k in ("tool_use_id", "timestamp", "subagent_type", "description")},
                         "failing": [c["id"] for c in cl if c["status"] == "FAIL"], "n_clauses": len(cl)})
        n = len(rows)
        full = sum(1 for r in rows if not r["failing"])
        ids = [c["id"] for c in lint_prompt("")]
        per_clause = {cid: (sum(1 for r in rows if cid not in r["failing"]) / n * 100 if n else None) for cid in ids}
        mean_clause = (sum(per_clause.values()) / len(ids)) if n else None
        summary = {"transcript": a.transcript, "since": a.since, "until": a.until, "n_dispatches": n,
                   "n_fully_compliant": full, "pct_fully_compliant": (full / n * 100 if n else None),
                   "mean_clause_pass_pct": mean_clause, "per_clause_pass_pct": per_clause,
                   "status": "LINTED" if n else "NO_VERIFICATION_DISPATCHES"}
        if a.json:
            print(json.dumps({**summary, "rows": rows}, indent=1))
        else:
            print(f"{'local time':16} {'role':22} {'pass':>5}  failing clauses | description")
            for r in rows:
                t = to_local(r["timestamp"])
                ts = t.strftime("%Y-%m-%d %H:%M") if t else "?"
                print(f"{ts:16} {r['subagent_type'][:22]:22} {r['n_clauses'] - len(r['failing']):>2}/{r['n_clauses']}  "
                      f"{','.join(r['failing']) or '-'} | {r['description'][:50]}")
            if not n:
                print("NO_VERIFICATION_DISPATCHES in the window (looked, found none; not the same as compliant)")
            else:
                print(f"\nBASELINE: {full}/{n} dispatches fully compliant ({full / n * 100:.1f} %); "
                      f"mean clause pass {mean_clause:.1f} %")
                print("per clause pass %: " + "  ".join(f"{k}={v:.0f}" for k, v in per_clause.items()))
        log_run("dispatch_lint", "transcript", a.transcript, {k: summary[k] for k in ("n_dispatches", "n_fully_compliant", "status")})
        return 0 if full == n else 1

    if not a.prompt:
        ap.error("give a prompt file, '-' for stdin, or --transcript")
    try:
        text = sys.stdin.read() if a.prompt == "-" else open(a.prompt, encoding="utf-8", errors="replace").read()
    except OSError as e:
        print(f"NEVER_LOOKED: prompt unreadable: {e}")
        log_run("dispatch_lint", "prompt", a.prompt, {"status": "NEVER_LOOKED"})
        return 2
    cl = lint_prompt(text)
    fails = [c for c in cl if c["status"] == "FAIL"]
    if a.json:
        print(json.dumps({"subagent_type": a.subagent_type, "clauses": cl,
                          "pins": extract_pins(text), "output_paths": extract_output_paths(text)}, indent=1))
    else:
        if a.subagent_type and a.subagent_type not in VERIFICATION_ROLES:
            print(f"note: subagent_type '{a.subagent_type}' is not a verification role; linted anyway")
        for c in cl:
            print(f"{c['id']} {c['name']:30} {c['status']}" + (f"  <- {c['detail']}" if c["detail"] else ""))
        print(f"\n{len(cl) - len(fails)}/{len(cl)} clauses PASS")
    log_run("dispatch_lint", "prompt", a.prompt, {"n_fail": len(fails)})
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
