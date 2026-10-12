#!/usr/bin/env python3
r"""dispatch_planner.py - mechanical half of the harness dispatch planner (plan v1, 2026-10-10; round 2 same day).

WHY: the owner's 11th correction on proactive launching (OPEN-THREADS THREAD-HARNESS-DISPATCH-PLANNER-2026-10-10):
at a breakpoint the orchestrator must find the agents it can launch in parallel WITHOUT them stepping on each other.
This tool is the oracle behind that: it reads the owed-work sources, checks a proposed set of dispatches for overlap,
and lists finished innovator / analyzer / verifier results that never reached the owner. It launches nothing, wires
nothing, writes nothing except one row per `check` run in dispatch_planner_runs.log. Stdlib only.

SUBCOMMANDS (exit codes are part of the contract)
  check PLAN.json [--agents-dir D] [--scratchpad-root P ...] [--plan-root D]
      Plan JSON schema 1: {"cap":6, "root":<abs main checkout, optional>, "scratchpad_root":<abs, optional>,
      "agents":[{id, source, role, model, output_path, branch, worktree, reads[], writes[], live[], load,
      reversible, ready_reason, repo?, exclusive_reads?[]}], "deferred":[{source, reason}]}. Conflict kinds:
        K1 file        A writes a path that B reads or writes; also B reading A's output_path (B would start before
                       the artifact exists). A BROAD read (a plain directory above the write) does not conflict unless
                       the same path is listed in `exclusive_reads` OR the reader works in the same checkout as the
                       writer (it would read a half-written file); a read of the written file or of anything inside
                       a written directory always conflicts.
        K2 branch      two writing agents, same branch, same checkout
        K3 worktree    two agents share an explicit worktree path; or two writing agents share the LIVE checkout
                       (worktree null or equal to the root) on different branches (a working tree has one HEAD)
        K4 live        two agents hold conflicting `live` tokens (see LIVE VOCABULARY)
        K5 load        a `sensitive` agent beside a `heavy` one, beside a writer of the live checkout, or beside an
                       agent holding a `profile:` live token (a timing-sensitive test must not share the clock)
        K6 path-collision  output paths equal / parent-child / equal to the scratchpad root / inside another's writes
        K7 path-exists an output path already exists on disk (msys /c/x is folded to c:/x before the test)
        K8 path-generic output basename is partN/secN/chunkN or a bare generic noun
        K9 cap         more than 6 READ-NOW agents (agents already running, listed in `in_flight`, count; agents
                       with `archive_only: true` are counted apart) or more than 10 agents in total
        K11 heavy-lane more than one agent with load=heavy (plan field `heavy_cap`, default 1; in-flight count). Set
                       load=heavy for anything that runs a JVM / Maven / Docker / browser / the full suite.
                       SOLO (load=sensitive) has one slot; two SOLO agents also conflict (mixed heavy/SOLO is K5).
        K10 schema     missing field, empty/non-string id, model outside the list, reversible not true, relative
                       output path, coder with empty writes, bad optional fields
      PATHS: case-insensitive, \ = /, drive letter folded, /c/x folded to c:/x, . and .. resolved, matched by path
      SEGMENT (a.py vs ab.py and tools/ vs toolsx/ never overlap). Globs (`*` `?` `[..]` `**`) are matched segment-wise
      against their literal directory prefix. REPO IDENTITY: a relative entry is a repo-relative LOGICAL path; an
      absolute entry inside the plan root or inside an agent's worktree is mapped to the same repo-relative form, so
      one file spelled relative, absolute in the main checkout, and absolute in two worktrees is ONE file. An agent on
      another repository sets `repo` (default "main"). Absolute paths outside every root stay physical. The root is
      --plan-root, else plan["root"], else the git main checkout of the current directory; with none, a plan that mixes
      relative and absolute paths gets a printed `warnings` entry (the two spellings cannot be compared).
      LIVE VOCABULARY: `docker` (the whole daemon: `docker`, `docker:<name>`, `docker compose`, `docker-compose`,
      `compose` are one resource), `port:N`,
      `profile:<dir>`, `deploy:<target>`, `db:<name>`, `browser-profile:<name>`. A bare token (`profile`) conflicts
      with any `profile:<x>`; `fam:a` vs `fam:b` conflicts only for family `docker`. Declare BOTH `docker` and
      `port:N` when a container publishes a port: the tool cannot know that a container owns a port.
      Exit 0 clean | 1 conflicts (JSON on stdout) | 2 NEVER_LOOKED (unreadable / invalid input / internal error; never
      printed as clean). Also reports per agent the advisory `above_default` (dispatch_lint.tier_check); it never
      changes the exit code.
      IN FLIGHT: --in-flight FILE (or plan["in_flight"]) lists agents already running ({id, writes?, reads?, live?,
      load?, worktree?, branch?, output_path?, archive_only?}); only `id` is required, a missing `worktree` key means
      unknown checkout. They are checked against every planned agent (never against each other) and counted by K9/K11.
      GLOBS: `*` `?` `[class]` `**` and `{a,b}` braces (max 64 expansions); a segment that is entirely `[name]` is a
      literal (Next.js routes). `**/*.test.py` matches only paths under its base whose tail matches, or a directory
      spelled with a trailing slash. Two globs meet when their literal bases overlap, unless their tails are `*.ext`
      with different extensions. REPO ID without a `repo` field: the git common dir of the worktree (see Ctx).
  gather [--root D] [--handoff F] [--open-threads F] [--pending-fixes F] [--ledger-json F] [--handoff-items N]
         [--allow-missing NAME ...]
      Reads the four owed-work sources WHOLE and prints candidates JSON ({candidates:[...], never_looked:[...], gaps}).
      Each candidate carries `has_explicit_paths` (the text names a file or folder; R1 of the plan) and `paths`.
      OPEN-THREADS: every entry whose heading is not marked closed (case-insensitive) is a candidate, with
      `status_hint` open | unstated. HANDOFF: the last N numbered items of the final section; the LATEST item is
      delivered in full (it is the live state), older items are cut at 700 characters.
      A source that is missing or parses to nothing is NEVER_LOOKED: exit 2, source named, candidates EMPTY (never a
      partial list read as the whole). --allow-missing NAME (handoff | open-threads | pending-fixes | verifier-ledger)
      turns that one source into a named `gap` and exits 0.
  unrelayed [unreported_work options] [--roles analyzer,innovator,verifier] [--record F ...] [--max-dir-entries N] [--json]
      Walks the scan roots with unreported_work.py's own functions but filters to `_<role>-` deliverables BEFORE
      classifying (so it never reads the other ~2,000 bodies), keeps the base tool's relay legs, and adds a RECORD leg:
      a deliverable whose file name appears in the handoff / OPEN-THREADS / PENDING-FIXES under a scan root (or in a
      --record file) is moved to `relayed_by_record` (accounted for in the orchestrator's own record; not proof the
      owner saw it). Directories pruned by the entry cap are always printed as `not_scanned_dirs`; if a pruned
      directory holds role deliverables the run is NEVER_LOOKED (exit 2), never a silent "nothing to relay".
      Output is labelled `SCREEN (low precision)`: the base tool is a high-recall, low-precision screen.
      Exit 0 nothing listed | 1 something listed | 2 NEVER_LOOKED.

HONEST LIMIT: `check` verifies the DECLARED resources, not the truth. An agent that under-declares what it touches
passes. That gap stays with judgment (plan section 3, last paragraph). Not modelled: nested worktrees, 8.3 short
names, `\\?\` and file:// spellings, heavy-vs-heavy CPU contention.
"""
from __future__ import annotations

import argparse
import datetime as dt
import fnmatch
import importlib.util
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(HERE))
DEFAULT_LOG = os.path.join(HERE, "dispatch_planner_runs.log")

MODELS = ("haiku", "sonnet", "opus", "fable", "codex", "inherit")
LOADS = ("heavy", "sensitive", "none")
REQUIRED = ("id", "source", "role", "model", "output_path", "branch", "worktree", "reads", "writes", "live", "load",
            "reversible", "ready_reason")
HARD_CAP = 6               # read-now agents (their results are read this batch)
TOTAL_CAP = 10             # read-now + archive_only, in-flight included
HEAVY_CAP_DEFAULT = 1      # one JVM / Maven / Docker / browser / full-suite job at a time
HEAVY_FAMILIES = {"docker", "jvm", "maven", "mvn", "gradle", "java", "browser", "browser-profile", "playwright"}
GENERIC_NOUNS = {"output", "result", "report", "findings", "notes", "summary", "analysis"}
SOURCES = ("handoff", "open-threads", "pending-fixes", "verifier-ledger")
FAMILY_EXCLUSIVE = {"docker"}          # live families that are ONE shared resource whatever the qualifier
DEFAULT_MAX_DIR_ENTRIES = 5000         # unreported_work.py default is 1000: meta/cache holds ~2,400 entries


# ------------------------------------------------------------------------------------------------ paths

def fold_msys(p: str) -> str:
    s = str(p).strip().replace("\\", "/")
    m = re.match(r"^/([A-Za-z])/(.*)$", s)
    return (m.group(1) + ":/" + m.group(2)) if m else s


def is_abs(p: str) -> bool:
    return bool(re.match(r"^([A-Za-z]:[\\/]|/|\\\\)", str(p)))


def norm(p: str):
    """(drive, absolute, segments): case-insensitive, \\ = /, drive folded, /c/x folded to c:/x, . and .. resolved."""
    s = fold_msys(p).lower()
    drive = ""
    m = re.match(r"^([a-z]:)(.*)$", s)
    if m:
        drive, s = m.group(1), m.group(2)
    absolute = s.startswith("/") or bool(drive)
    segs: list[str] = []
    for seg in s.split("/"):
        seg = seg.strip()
        if seg in ("", "."):
            continue
        if seg == "..":
            if segs and segs[-1] != "..":
                segs.pop()
            else:
                segs.append("..")
            continue
        segs.append(seg)
    return (drive, absolute, tuple(segs))


def show(n) -> str:
    drive, absolute, segs = n
    return drive + ("/" if absolute else "") + "/".join(segs)


def covers(a, b) -> bool:
    """a is b, or a is an ancestor of b, by whole path segments."""
    return a[0] == b[0] and a[1] == b[1] and b[2][:len(a[2])] == a[2]


def overlaps(a, b) -> bool:
    return covers(a, b) or covers(b, a)


BRACKET_WHOLE_RX = re.compile(r"^\[[^\]]*\]$")
CLASS_RX = re.compile(r"\[[^\]]+\]")
EXT_RX = re.compile(r"^\*\.([a-z0-9]+)$")


def has_glob(seg: str) -> bool:
    """`*`, `?` and a [..] class inside a segment are glob syntax. A segment that is ENTIRELY [name] is a literal
    (Next.js dynamic routes such as app/[id]/page.tsx)."""
    if "*" in seg or "?" in seg:
        return True
    return bool(CLASS_RX.search(seg)) and not BRACKET_WHOLE_RX.match(seg)


def _split_top(body: str) -> list:
    parts, depth, cur = [], 0, ""
    for ch in body:
        if ch == "," and depth == 0:
            parts.append(cur)
            cur = ""
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
        cur += ch
    parts.append(cur)
    return parts


def expand_braces(s: str, limit: int = 64) -> list:
    """a/{b,c}/d -> [a/b/d, a/c/d]; nested braces work; {x} without a comma and unbalanced braces stay literal;
    at most `limit` results (the rest is dropped, which can only under-report, so keep patterns small)."""
    start = s.find("{")
    if start < 0:
        return [s]
    depth, end = 0, -1
    for i in range(start, len(s)):
        if s[i] == "{":
            depth += 1
        elif s[i] == "}":
            depth -= 1
            if depth == 0:
                end = i
                break
    if end < 0:
        return [s]
    parts = _split_top(s[start + 1:end])
    if len(parts) < 2:
        return [s[:end + 1] + r for r in expand_braces(s[end + 1:], limit)][:limit]
    out = []
    for p in parts:
        for e in expand_braces(s[:start] + p + s[end + 1:], limit):
            out.append(e)
            if len(out) >= limit:
                return out
    return out


class Entry:
    """One path a plan names: a literal base, the glob segments below it (if any), and whether it was spelled as a dir."""
    __slots__ = ("base", "pat", "isdir")

    def __init__(self, base, pat=(), isdir=False):
        self.base, self.pat, self.isdir = base, tuple(pat), isdir

    def text(self) -> str:
        return show(self.base) + ("/" + "/".join(self.pat) if self.pat else "")


def split_glob(n, isdir: bool = False) -> Entry:
    for i, seg in enumerate(n[2]):
        if has_glob(seg):
            return Entry((n[0], n[1], n[2][:i]), n[2][i:], isdir)
    return Entry(n, (), isdir)


def glob_overlap(pat, rest, rest_dir: bool = False) -> bool:
    """Can pattern segments `pat` match something at or under the other path whose segments below the glob's base are
    `rest`? A path that ends before the pattern does counts only if it was spelled as a directory (trailing slash)."""
    if not pat:
        return True          # the pattern is used up: the other path is at or below a match
    if not rest:
        return rest_dir      # the other path stops early: only a directory can contain matches
    if pat[0] == "**":
        if len(pat) == 1:
            return True
        return any(glob_overlap(pat[1:], rest[i:], rest_dir) for i in range(len(rest) + 1))
    if not fnmatch.fnmatchcase(rest[0], pat[0]):
        return False
    return glob_overlap(pat[1:], rest[1:], rest_dir)


def ent_overlap(a: Entry, b: Entry) -> bool:
    """Plain vs plain: segment overlap. Glob vs plain: glob-aware. Glob vs glob: their literal bases must overlap, and
    two `*.ext` tails with different literal extensions never meet (src/**/*.ts vs src/**/*.css)."""
    if not a.pat and not b.pat:
        return overlaps(a.base, b.base)
    if a.pat and b.pat:
        if not overlaps(a.base, b.base):
            return False
        ea, eb = EXT_RX.match(a.pat[-1]), EXT_RX.match(b.pat[-1])
        return not (ea and eb and ea.group(1) != eb.group(1))
    g, p = (a, b) if a.pat else (b, a)
    if covers(p.base, g.base):
        return True
    if covers(g.base, p.base):
        return glob_overlap(list(g.pat), list(p.base[2][len(g.base[2]):]), p.isdir)
    return False


def ent_contains(w: Entry, n: Entry) -> bool:
    """Is the plain path n inside (or equal to) what the entry w names?"""
    if not covers(w.base, n.base):
        return False
    return not w.pat or glob_overlap(list(w.pat), list(n.base[2][len(w.base[2]):]), n.isdir)


def broad_read(r: Entry, w: Entry) -> bool:
    """A plain directory read strictly above a write (or above a glob write's base): the benign 'read meta/' case."""
    return (not r.pat) and covers(r.base, w.base) and not ((not w.pat) and r.base == w.base)


def generic_name(path_str: str) -> bool:
    base = re.split(r"[\\/]", path_str.rstrip("/\\"))[-1].lower()
    stem = re.sub(r"\.[a-z0-9]{1,5}$", "", base)
    if re.search(r"(?<![a-z])(part|sec|chunk)\d+(?![a-z])", stem):
        return True
    core = re.sub(r"(?:[-_ ]*\d{4}-\d{2}-\d{2}(?:[-_]\d{4})?)+$", "", stem)
    core = re.sub(r"[-_ ]*\d+$", "", core).strip("_- ")
    return core in GENERIC_NOUNS


_CD_CACHE: dict = {}


def git_common_dir(path):
    """Absolute common .git dir of the repo that contains `path` (the same for a main checkout and its linked
    worktrees, different for a separate clone), or None: path not on disk, not a repo, or no git."""
    p = os.path.abspath(path)
    if p in _CD_CACHE:
        return _CD_CACHE[p]
    out = None
    if os.path.isdir(p):
        try:
            r = subprocess.run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], cwd=p,
                               capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=15)
            gd = r.stdout.strip()
            if r.returncode == 0 and gd:
                out = gd.rstrip("/\\")
        except (OSError, subprocess.SubprocessError):
            out = None
    _CD_CACHE[p] = out
    return out


def git_main_checkout(cwd=None):
    """Main checkout of the repo that contains `cwd` (works from a linked worktree), or None."""
    gd = git_common_dir(cwd or os.getcwd())
    return os.path.dirname(gd) if gd and os.path.basename(gd) == ".git" else None


class Ctx:
    """Repo identity. Every absolute path inside the plan root or an agent worktree is mapped to a repo-relative key
    `repo:<id>/<path>`; a relative path is that key directly. An agent's repo id is, in order: its `repo` field; the
    git common dir of its worktree (equal to the root's = "main", else "git:<dir>"); "main" when it works in the live
    checkout; "main" ASSUMED when the worktree is not on disk yet (reported in `repo_ids`)."""

    def __init__(self, plan: dict, agents: list, plan_root_cli):
        root, self.root_source = None, "none"
        if plan_root_cli:
            root, self.root_source = plan_root_cli, "cli"
        elif isinstance(plan.get("root"), str) and plan["root"].strip():
            root, self.root_source = plan["root"], "plan"
        else:
            g = git_main_checkout()
            if g:
                root, self.root_source = g, "git"
        self.root = norm(root) if root else None
        self.root_text = root
        root_cd = git_common_dir(root) if root else None
        self.repo, pairs = {}, []
        if self.root:
            pairs.append((self.root, "main"))
        for a in agents:
            rid, src = self._repo_of(a, root_cd)
            self.repo[a["id"]] = (rid, src)
            if a.get("worktree"):
                pairs.append((norm(a["worktree"]), rid))
        self.repo_roots = sorted(pairs, key=lambda x: -len(x[0][2]))

    @staticmethod
    def _repo_of(a: dict, root_cd):
        if a.get("repo"):
            return a["repo"], "declared"
        wt = a.get("worktree")
        if a.get("_wt_unknown"):
            return "main", "assumed"
        if not wt:
            return "main", "live-checkout"
        cd = git_common_dir(wt)
        if cd:
            if root_cd and norm(cd) == norm(root_cd):
                return "main", "git"
            return "git:" + show(norm(cd)), "git"
        return "main", "assumed"

    def entries(self, p: str, agent: dict, expand: bool = True) -> list:
        rid = self.repo[agent["id"]][0]
        out = []
        for q in (expand_braces(p) if expand else [p]):
            isdir = q.rstrip(" ").endswith(("/", "\\"))
            if not is_abs(q):
                out.append(split_glob(("repo:" + rid, True, norm(q)[2]), isdir))
                continue
            n = norm(q)
            for r, rid2 in self.repo_roots:
                if covers(r, n):
                    n = ("repo:" + rid2, True, n[2][len(r[2]):])
                    break
            out.append(split_glob(n, isdir))
        return out

    def checkout(self, agent: dict):
        """Checkout key: the live checkout (worktree null or equal to the root) is one key."""
        if agent.get("_wt_unknown"):
            return ("UNKNOWN", agent["id"])
        wt = agent.get("worktree")
        if not wt:
            return self.root if self.root else "MAIN"
        return norm(wt)

    def is_main(self, key) -> bool:
        return key == "MAIN" or (self.root is not None and key == self.root)


# ------------------------------------------------------------------------------------------------ log

def log_run(mode: str, target: str, result: dict) -> None:
    if os.environ.get("DISPATCH_PLANNER_NO_LOG") == "1":
        return
    path = os.environ.get("DISPATCH_PLANNER_LOG") or DEFAULT_LOG
    row = {"ts": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "tool": "dispatch_planner",
           "mode": mode, "target": str(target)[:300], "caller": os.environ.get("DISPATCH_PLANNER_CALLER", "cli")}
    row.update(result)
    try:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(row) + "\n")
    except OSError:
        pass


def load_module(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, filename))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


# ------------------------------------------------------------------------------------------------ check

class NeverLooked(Exception):
    pass


def read_plan(path: str) -> dict:
    try:
        with open(path, encoding="utf-8-sig") as fh:
            plan = json.load(fh)
    except OSError as e:
        raise NeverLooked("cannot read plan %s: %s" % (path, e.strerror or e))
    except ValueError as e:
        raise NeverLooked("plan %s is not valid JSON: %s" % (path, e))
    if not isinstance(plan, dict):
        raise NeverLooked("plan %s: top level is not an object" % path)
    if not isinstance(plan.get("agents"), list):
        raise NeverLooked("plan %s: `agents` is missing or not a list" % path)
    return plan


def validate(plan: dict):
    """-> (K10 entries, set of agent indexes with a schema problem)."""
    out, bad, seen = [], set(), {}

    def k10(idx, aid, field, detail):
        out.append({"kind": "K10", "agents": [aid], "resource": field, "detail": detail})
        bad.add(idx)

    if "schema" in plan and plan["schema"] != 1:
        out.append({"kind": "K10", "agents": [], "resource": "schema", "detail": "schema must be 1"})
    hc = plan.get("heavy_cap", 1)
    if isinstance(hc, bool) or not isinstance(hc, int) or hc < 1:
        out.append({"kind": "K10", "agents": [], "resource": "heavy_cap", "detail": "heavy_cap must be an integer >= 1"})
    for idx, ag in enumerate(plan["agents"]):
        if not isinstance(ag, dict):
            k10(idx, "#%d" % idx, "agent", "entry is not an object")
            continue
        good_id = isinstance(ag.get("id"), str) and bool(ag.get("id").strip())
        aid = ag["id"] if good_id else "#%d" % idx
        for f in REQUIRED:
            if f not in ag:
                k10(idx, aid, f, "missing required field")
        if "id" in ag and not good_id:
            k10(idx, aid, "id", "must be a non-empty string")
        if good_id:
            if ag["id"] in seen:
                k10(idx, aid, "id", "duplicate id")
            seen[ag["id"]] = idx
        if "model" in ag and ag["model"] not in MODELS:
            k10(idx, aid, "model", "%r not in %s" % (ag["model"], "|".join(MODELS)))
        if "load" in ag and ag["load"] not in LOADS:
            k10(idx, aid, "load", "%r not in %s" % (ag["load"], "|".join(LOADS)))
        if "reversible" in ag and ag["reversible"] is not True:
            k10(idx, aid, "reversible", "must be true")
        for f in ("reads", "writes", "live", "exclusive_reads"):
            if f in ag and (not isinstance(ag[f], list) or not all(isinstance(x, str) for x in ag[f])):
                k10(idx, aid, f, "must be a list of strings")
        if "archive_only" in ag and not isinstance(ag["archive_only"], bool):
            k10(idx, aid, "archive_only", "must be true or false")
        for f in ("source", "role", "branch", "ready_reason", "repo"):
            if f in ag and not isinstance(ag[f], str):
                k10(idx, aid, f, "must be a string")
        if "worktree" in ag and ag["worktree"] is not None and not (isinstance(ag["worktree"], str)
                                                                    and is_abs(ag["worktree"])):
            k10(idx, aid, "worktree", "must be null (main checkout) or an absolute path")
        if "output_path" in ag:
            op = ag["output_path"]
            if not isinstance(op, str) or not op.strip():
                k10(idx, aid, "output_path", "must be a non-empty string")
            elif not is_abs(op):
                k10(idx, aid, "output_path", "relative output path %r" % op)
        if ag.get("role") == "coder" and isinstance(ag.get("writes"), list) and not ag["writes"]:
            k10(idx, aid, "writes", "a coder must declare writes")
    dfr = plan.get("deferred", [])
    if not isinstance(dfr, list) or any(not isinstance(d, dict) or not d.get("source") or not d.get("reason")
                                        for d in dfr):
        out.append({"kind": "K10", "agents": [], "resource": "deferred",
                    "detail": "deferred must be a list of {source, reason}"})
    return out, bad


def live_family(t: str):
    """('docker', 'atlas-pg') for 'Docker Compose:atlas-pg'. docker, docker-compose, docker_compose, 'docker compose'
    and compose are ONE family."""
    fam, _, q = t.strip().lower().partition(":")
    fam = re.sub(r"[\s_]+", "-", fam.strip())
    if fam in ("docker", "docker-compose", "compose"):
        fam = "docker"
    return fam, q.strip()


def live_conflict(t1: str, t2: str) -> bool:
    f1, q1 = live_family(t1)
    f2, q2 = live_family(t2)
    if f1 != f2:
        return False
    if f1 in FAMILY_EXCLUSIVE:
        return True
    return q1 == q2 or q1 == "" or q2 == ""


def res_of(x: Entry, y: Entry) -> str:
    """Resource name for a K1 hit: the more specific of the two entries."""
    e = x if len(x.base[2]) + len(x.pat) >= len(y.base[2]) + len(y.pat) else y
    return e.text()


def normalise_in_flight(items, planned_ids, conflicts) -> list:
    """Agents already running. Only `id` is required; the rest defaults to 'declares nothing'. A missing `worktree`
    key means UNKNOWN checkout (never equal to another). Invalid entries are K10 on the plan."""
    out, seen = [], set(planned_ids)
    for idx, f in enumerate(items):
        before = len(conflicts)
        fid = f.get("id") if isinstance(f, dict) else None

        def bad(field, detail):
            conflicts.append({"kind": "K10", "agents": [fid if isinstance(fid, str) and fid else "in_flight#%d" % idx],
                              "resource": "in_flight." + field, "detail": detail})

        if not isinstance(f, dict):
            bad("entry", "must be an object")
            continue
        if not (isinstance(fid, str) and fid.strip()):
            bad("id", "must be a non-empty string")
            continue
        if fid in seen:
            bad("id", "duplicate id (planned or in flight)")
            continue
        for k in ("reads", "writes", "live", "exclusive_reads"):
            if k in f and (not isinstance(f[k], list) or not all(isinstance(x, str) for x in f[k])):
                bad(k, "must be a list of strings")
        for k in ("branch", "repo", "role", "model"):
            if k in f and not isinstance(f[k], str):
                bad(k, "must be a string")
        if "load" in f and f["load"] not in LOADS:
            bad("load", "%r not in %s" % (f["load"], "|".join(LOADS)))
        if "archive_only" in f and not isinstance(f["archive_only"], bool):
            bad("archive_only", "must be true or false")
        for k in ("output_path", "worktree"):
            if k in f and f[k] is not None and not (isinstance(f[k], str) and is_abs(f[k])):
                bad(k, "must be an absolute path")
        if len(conflicts) > before:
            continue
        seen.add(fid)
        g = dict(f)
        for k in ("reads", "writes", "live", "exclusive_reads"):
            g.setdefault(k, [])
        g.setdefault("branch", "?inflight:" + fid)
        g.setdefault("load", "none")
        g.setdefault("role", "inflight")
        g.setdefault("model", "inherit")
        g.setdefault("output_path", None)
        g["_inflight"] = True
        g["_wt_unknown"] = "worktree" not in f
        g.setdefault("worktree", None)
        out.append(g)
    return out


def analyse(plan: dict, scratch_roots: list, plan_root_cli, agents_dirs, in_flight=None) -> dict:
    conflicts, bad = validate(plan)
    planned = [a for i, a in enumerate(plan["agents"]) if i not in bad]
    raw_flying = plan.get("in_flight") or []
    if not isinstance(raw_flying, list):
        conflicts.append({"kind": "K10", "agents": [], "resource": "in_flight", "detail": "must be a list"})
        raw_flying = []
    flying = normalise_in_flight(list(raw_flying) + list(in_flight or []), {a["id"] for a in planned}, conflicts)
    fly_ids = {a["id"] for a in flying}
    agents = planned + flying
    ctx = Ctx(plan, agents, plan_root_cli)

    def add(kind, ags, resource, detail=""):
        c = {"kind": kind, "agents": sorted(ags), "resource": resource, "detail": detail}
        if any(i in fly_ids for i in ags):
            c["in_flight"] = sorted(i for i in ags if i in fly_ids)
        conflicts.append(c)

    reads, xreads, writes, outs_e, outs_p, chk = {}, {}, {}, {}, {}, {}
    for a in agents:
        i = a["id"]
        reads[i] = [e for p in a["reads"] for e in ctx.entries(p, a)]
        xreads[i] = [e for p in a.get("exclusive_reads", []) for e in ctx.entries(p, a)]
        writes[i] = [e for p in a["writes"] for e in ctx.entries(p, a)]
        outs_e[i] = ctx.entries(a["output_path"], a, expand=False)[0] if a.get("output_path") else None
        outs_p[i] = norm(a["output_path"]) if a.get("output_path") else None
        chk[i] = ctx.checkout(a)

    for n, a in enumerate(agents):
        for b in agents[n + 1:]:
            ia, ib = a["id"], b["id"]
            if ia in fly_ids and ib in fly_ids:
                continue                      # both already running: not this plan's doing
            # K1: write-write, then reader-vs-writer in both orders (an agent output counts as a write for readers)
            seen = set()

            def k1(res, why):
                if res not in seen:
                    seen.add(res)
                    add("K1", [ia, ib], res, why)

            for w in writes[ia]:
                for o in writes[ib]:
                    if ent_overlap(w, o):
                        k1(res_of(w, o), "both write")
            for wr, rd in ((ia, ib), (ib, ia)):
                shared = chk[wr] == chk[rd]   # same working tree: a broad read DOES see a half-written file
                cands = [(w, True) for w in writes[wr]] + ([(outs_e[wr], False)] if outs_e[wr] else [])
                for w, is_write in cands:
                    for r, excl in [(x, False) for x in reads[rd]] + [(x, True) for x in xreads[rd]]:
                        if ent_overlap(w, r) and (excl or (shared and is_write) or not broad_read(r, w)):
                            k1(res_of(w, r), "writer %s vs reader %s" % (wr, rd))
            # K2 / K3: same checkout
            wa, wb = bool(writes[ia]), bool(writes[ib])
            if chk[ia] == chk[ib]:
                same_branch = a["branch"].strip() == b["branch"].strip()
                if wa and wb and same_branch:
                    add("K2", [ia, ib], a["branch"].strip(), "two writers on one branch in one checkout")
                if not ctx.is_main(chk[ia]):
                    add("K3", [ia, ib], show(chk[ia]), "shared worktree")
                elif wa and wb and not same_branch:
                    add("K3", [ia, ib], "live checkout", "two writers share the live checkout on different branches")
            # K5: a sensitive agent beside a heavy one / a live-checkout writer / a profile holder
            for s, o in ((a, b), (b, a)):
                if s["load"] != "sensitive":
                    continue
                si, oi = s["id"], o["id"]
                why = []
                if o["load"] == "heavy":
                    why.append("a heavy agent")
                if writes[oi] and ctx.is_main(chk[oi]):
                    why.append("a writer of the live checkout")
                if any(live_family(t)[0] == "profile" for t in o["live"]):
                    why.append("a holder of a profile: live token")
                if why:
                    add("K5", [si, oi], "load", "sensitive agent beside " + ", ".join(why))
            # K4: conflicting live tokens
            hits = [(t1, t2) for t1 in a["live"] for t2 in b["live"] if live_conflict(t1, t2)]
            if hits:
                t1, t2 = (hits[0][0].strip().lower(), hits[0][1].strip().lower())
                add("K4", [ia, ib], t1 if t1 == t2 else t1 + " ~ " + t2, "shared live resource")
            # K6
            oa, ob = outs_p[ia], outs_p[ib]
            if oa and ob and overlaps(oa, ob):
                add("K6", [ia, ib], show(oa if len(oa[2]) <= len(ob[2]) else ob), "output paths equal or parent/child")
            for outer, inner in ((ia, ib), (ib, ia)):
                if outs_e[inner] is None:
                    continue
                for w in writes[outer]:
                    if ent_contains(w, outs_e[inner]):
                        add("K6", [ia, ib], outs_e[inner].text(),
                            "output of %s lies inside writes of %s" % (inner, outer))
    roots = [norm(r) for r in scratch_roots if isinstance(r, str) and r.strip()]
    for a in planned:
        aid = a["id"]
        if any(outs_p[aid] == r for r in roots):
            add("K6", [aid], show(outs_p[aid]), "output path is the shared scratchpad root")
        if os.path.exists(fold_msys(a["output_path"])):
            add("K7", [aid], a["output_path"], "output path already exists")
        if generic_name(a["output_path"]):
            add("K8", [aid], a["output_path"], "generic or numbered output name")
    # K9 (read-now cap 6, in-flight included, archive_only counted apart; total cap 10) and K11 (heavy lane)
    cap = plan.get("cap")
    eff = min(HARD_CAP, cap) if isinstance(cap, int) and not isinstance(cap, bool) and cap > 0 else HARD_CAP
    archive = sum(1 for a in plan["agents"] if isinstance(a, dict) and a.get("archive_only") is True) + \
        sum(1 for f in flying if f.get("archive_only"))
    total = len(plan["agents"]) + len(flying)
    read_now = total - archive
    hc = plan.get("heavy_cap", HEAVY_CAP_DEFAULT)
    hcap = hc if isinstance(hc, int) and not isinstance(hc, bool) and hc >= 1 else HEAVY_CAP_DEFAULT
    heavy = sorted(a["id"] for a in agents if a["load"] == "heavy")
    solo = sorted(a["id"] for a in agents if a["load"] == "sensitive")
    if plan["agents"]:
        if read_now > eff:
            add("K9", [], "read-now=%d" % read_now, "more than %d read-now agents (in-flight included; archive_only "
                "agents are counted apart)" % eff)
        if total > TOTAL_CAP:
            add("K9", [], "total=%d" % total, "more than %d agents in total (in-flight and archive_only included)" % TOTAL_CAP)
        if len(heavy) > hcap and any(a["load"] == "heavy" for a in planned):
            add("K11", heavy, "heavy-lane", "more than %d heavy agent(s) at a time (JVM / Maven / Docker / browser / "
                "full suite); in-flight agents count" % hcap)
        if len(solo) > 1 and any(a["load"] == "sensitive" for a in planned):
            add("K11", solo, "solo-lane", "more than 1 SOLO agent (load=sensitive) at a time; in-flight agents count")

    warnings = []
    every = [p for a in agents for p in a["reads"] + a["writes"] + a.get("exclusive_reads", [])]
    has_rel, has_abs = any(not is_abs(p) for p in every), any(is_abs(p) for p in every)
    if ctx.root is None and has_rel and has_abs:
        warnings.append("no root resolved (--plan-root, plan.root or a git checkout): relative and absolute "
                        "spellings of one file cannot be compared; set plan.root")
    elif ctx.root_source == "git" and has_rel and has_abs and not any(
            covers(ctx.root, norm(p)) for p in every if is_abs(p)):
        warnings.append("the root %s came from the current directory's git repo and no absolute path lies under it: "
                        "if the plan belongs to another repo, relative and absolute spellings of one file will not "
                        "meet; pass --plan-root or set plan.root" % ctx.root_text)
    for a in agents:
        fams = sorted({live_family(t)[0] for t in a["live"]} & HEAVY_FAMILIES)
        if fams and a["load"] != "heavy":
            warnings.append("%s holds a heavy-family live token (%s) but load is %r: K11 cannot count it; declare "
                            "load=heavy if it runs a JVM / Docker / browser / full suite" % (a["id"], ", ".join(fams), a["load"]))
    return {"conflicts": conflicts, "advisories": advisories(planned, agents_dirs), "warnings": warnings,
            "root": ctx.root_text, "root_source": ctx.root_source,
            "repo_ids": {k: {"repo": v[0], "source": v[1]} for k, v in ctx.repo.items()},
            "capacity": {"read_now": read_now, "archive_only": archive, "in_flight": len(flying), "heavy": len(heavy),
                         "solo": len(solo), "total": total, "read_now_cap": eff, "total_cap": TOTAL_CAP, "heavy_cap": hcap}}


def check_plan(plan: dict, scratch_roots: list, plan_root_cli, agents_dirs, in_flight=None):
    r = analyse(plan, scratch_roots, plan_root_cli, agents_dirs, in_flight)
    return r["conflicts"], r["advisories"]


def advisories(agents: list, agents_dirs):
    try:
        dl = load_module("dispatch_lint", "dispatch_lint.py")
    except Exception as e:  # advisory only; say so, never fail the check
        return [{"id": a["id"], "above_default": False, "status": "NEVER_LOOKED",
                 "detail": "dispatch_lint not importable: %s" % e} for a in agents]
    out = []
    for a in agents:
        r = dl.tier_check(a["role"], a["model"], agents_dirs)
        out.append({"id": a["id"], "role": a["role"], "model": a["model"], "default": r.get("default_family"),
                    "above_default": bool(r.get("above")), "status": r.get("status")})
    return out


def read_in_flight(path: str) -> list:
    try:
        with open(path, encoding="utf-8-sig") as fh:
            data = json.load(fh)
    except OSError as e:
        raise NeverLooked("cannot read in-flight file %s: %s" % (path, e.strerror or e))
    except ValueError as e:
        raise NeverLooked("in-flight file %s is not valid JSON: %s" % (path, e))
    if isinstance(data, dict):
        data = data.get("in_flight")
    if not isinstance(data, list):
        raise NeverLooked("in-flight file %s: expected a JSON list or {\"in_flight\": [...]}" % path)
    return data


def cmd_check(a) -> int:
    dirs = [a.agents_dir] if a.agents_dir else ([os.environ["DISPATCH_LINT_AGENTS_DIR"]]
                                                if os.environ.get("DISPATCH_LINT_AGENTS_DIR") else None)
    try:
        plan = read_plan(a.plan)
        scratch = list(a.scratchpad_root)
        sr = plan.get("scratchpad_root")
        scratch += [sr] if isinstance(sr, str) else (sr if isinstance(sr, list) else [])
        flying = read_in_flight(a.in_flight) if a.in_flight else None
        res = analyse(plan, scratch, a.plan_root, dirs, flying)
    except NeverLooked as e:
        print("NEVER_LOOKED: %s" % e)
        log_run("check", a.plan, {"verdict": "never_looked", "n_agents": None, "kinds": []})
        return 2
    except Exception as e:  # an internal fault is NEVER_LOOKED with a log row, never a traceback read as "conflict"
        print("NEVER_LOOKED: internal error %s: %s" % (type(e).__name__, e))
        log_run("check", a.plan, {"verdict": "never_looked", "n_agents": None, "kinds": [], "error": type(e).__name__})
        return 2
    conflicts = res["conflicts"]
    verdict = "conflict" if conflicts else "clean"
    kinds = sorted({c["kind"] for c in conflicts}, key=lambda k: int(k[1:]))
    running = flying if flying is not None else plan.get("in_flight", [])
    for agent in plan["agents"] + (running if isinstance(running, list) else []):
        if not isinstance(agent, dict):
            continue
        aid, wt = agent.get("id"), agent.get("worktree")
        if (isinstance(aid, str) and isinstance(wt, str) and wt
                and res["repo_ids"].get(aid, {}).get("source") == "assumed"):
            reason = "is not on disk" if not os.path.isdir(fold_msys(wt)) else "is not a git checkout"
            print("WARNING: %s repo ASSUMED as main: worktree %s %s; declare repo for another repository"
                  % (agent["id"], wt, reason), file=sys.stderr)
    print(json.dumps({"verdict": verdict, "n_agents": len(plan["agents"]), "kinds": kinds, "conflicts": conflicts,
                      "advisories": res["advisories"], "warnings": res["warnings"], "root": res["root"],
                      "root_source": res["root_source"], "repo_ids": res["repo_ids"], "capacity": res["capacity"]},
                     indent=1))
    log_run("check", a.plan, {"verdict": verdict, "n_agents": len(plan["agents"]), "kinds": kinds})
    return 1 if conflicts else 0


# ------------------------------------------------------------------------------------------------ gather

PATH_RXS = (
    re.compile(r"(?<![A-Za-z])[A-Za-z]:[\\/][^\s,;)\"'`|]+"),
    re.compile(r"(?<![\w/\\])(?:[\w.\-]+[\\/])+[\w.\-]*"),
    re.compile(r"\b[\w\-]+\.(?:py|mjs|js|ts|md|json|toml|ya?ml|sh|ps1|html|css|mmd|txt|log|tsv|xml)\b"),
)
HINT_WORDS = ("UNVERIFIED", "DONE", "CLOSED", "MERGED", "DEPLOYED", "PASS", "AMEND", "FAIL", "HELD", "BLOCKED",
              "PAUSED", "WAITS", "IN FLIGHT", "OPEN", "NEW")
TEXT_CAP = 700
THREAD_TEXT_CAP = 3000


class SourceError(Exception):
    pass


def find_paths(text: str) -> list:
    found, seen = [], set()
    for rx in PATH_RXS:
        for m in rx.finditer(text):
            p = m.group(0).rstrip(".,;:)")
            if len(p) < 4 or not (p[-1] in "/\\" or re.search(r"\.[A-Za-z0-9]{1,6}$", p)):
                continue
            if "://" in p or re.match(r"^(?:www\.|[\w\-]+\.(?:com|org|io|net|dev|app|ai)/)", p):
                continue
            if re.fullmatch(r"[\d./:\-]+", p):
                continue
            if p.lower() not in seen:
                seen.add(p.lower())
                found.append(p)
    return found[:20]


def candidate(source, kind, cid, text, cap=TEXT_CAP, **extra) -> dict:
    text = re.sub(r"\s+", " ", text).strip()
    paths = find_paths(text)
    up = text.upper()
    c = {"source": source, "kind": kind, "id": cid, "text": text if cap is None else text[:cap],
         "truncated": cap is not None and len(text) > cap, "chars": len(text),
         "hints": [w for w in HINT_WORDS if re.search(r"(?<![A-Z])" + w + r"(?![A-Z])", up)],
         "paths": paths, "has_explicit_paths": bool(paths)}
    c.update(extra)
    return c


def read_whole(path: str) -> str:
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            return fh.read()
    except OSError as e:
        raise SourceError("cannot read %s: %s" % (path, e.strerror or e))


def parse_handoff(path: str, last_n: int) -> list:
    lines = read_whole(path).splitlines()
    heads = [i for i, ln in enumerate(lines) if ln.startswith("## ")]
    if not heads:
        raise SourceError("%s has no '## ' section" % path)
    items, cur = [], None
    for i in range(heads[-1] + 1, len(lines)):
        m = re.match(r"^(\d+[a-z]*)\.\s+(.*)$", lines[i])
        if m:
            cur = {"label": m.group(1), "line": i + 1, "parts": [m.group(2)]}
            items.append(cur)
        elif cur is not None and lines[i].strip():
            cur["parts"].append(lines[i].strip())
    if not items:
        raise SourceError("%s: the final section has no numbered items (layout changed?)" % path)
    out, used = [], set()
    keep = items[-last_n:]
    for k, it in enumerate(keep):
        cid = it["label"] if it["label"] not in used else "%s@L%d" % (it["label"], it["line"])
        used.add(it["label"])
        latest = k == len(keep) - 1
        out.append(candidate("HANDOFF#" + cid, "handoff-item", cid, " ".join(it["parts"]),
                             cap=None if latest else TEXT_CAP, line=it["line"], latest=latest))
    return out


THREAD_RX = re.compile(r"^###\s+\[(THREAD-[A-Z0-9][A-Z0-9\-]*)\]\s*(.*)$")
OQ_RX = re.compile(r"^\*\*\[(OQ-[A-Z0-9][A-Z0-9\-]*)\]\s*(.*)$")
STATUS_OPEN_RX = re.compile(r"\b(OPEN|NEW|IN PROGRESS|IN FLIGHT|PENDING)\b", re.I)
STATUS_DONE_RX = re.compile(r"\b(CLOSED|RESOLVED|DONE|SUPERSEDED)\b", re.I)


def parse_open_threads(path: str) -> list:
    lines = read_whole(path).splitlines()
    starts = []
    for i, ln in enumerate(lines):
        m = THREAD_RX.match(ln) or OQ_RX.match(ln)
        if m:
            starts.append((i, m.group(1), m.group(2)))
    if not starts:
        raise SourceError("%s has no [THREAD-...] / [OQ-...] entry (layout changed?)" % path)
    out = []
    for n, (i, tid, rest) in enumerate(starts):
        first = rest[:240]          # the status words live in the heading text, not in the id
        is_open = bool(STATUS_OPEN_RX.search(first))
        if STATUS_DONE_RX.search(first) and not is_open:
            continue
        j = starts[n + 1][0] if n + 1 < len(starts) else len(lines)
        for k in range(i + 1, j):
            if lines[k].startswith("## "):
                j = k
                break
        out.append(candidate("OPEN-THREADS#" + tid, "open-thread", tid, " ".join(lines[i:j]), cap=THREAD_TEXT_CAP,
                             line=i + 1, status_hint="open" if is_open else "unstated"))
    return out


def split_row(line: str) -> list:
    s = line.strip().strip("|")
    return [c.strip().replace("\\|", "|") for c in re.split(r"(?<!\\)\|", s)]


def parse_pending_fixes(path: str) -> list:
    lines = read_whole(path).splitlines()
    rows, out = 0, []
    for i, ln in enumerate(lines):
        if not ln.startswith("|"):
            continue
        cells = split_row(ln)
        if len(cells) < 8 or not re.fullmatch(r"[A-Z]+\d+", cells[0]):
            continue
        rows += 1
        rid, opened, src = cells[0], cells[1], cells[2]
        change = " | ".join(cells[3:len(cells) - 4])
        owner, rev, state, evidence = cells[-4], cells[-3], cells[-2], cells[-1]
        if not state.lower().startswith("open"):
            continue
        flags = ["paused"] if "paused" in state.lower() else []
        out.append(candidate("PENDING-FIXES#" + rid, "pending-fix", rid, change + " (source: " + src + ")",
                             line=i + 1, opened=opened, owner=owner, reversible_declared=rev, state=state,
                             flags=flags))
    if rows == 0:
        raise SourceError("%s: no PENDING-FIXES row parsed (layout changed?)" % path)
    return out


def parse_ledger(root: str, ledger_json) -> list:
    if ledger_json:
        raw = read_whole(ledger_json)
    else:
        tool = os.path.join(root, ".claude", "tools", "verifier_actions_ledger.py")
        if not os.path.isfile(tool):
            raise SourceError("verifier ledger tool not found: %s" % tool)
        r = subprocess.run([sys.executable, tool, "check", "--older-than=-1", "--json"], capture_output=True,
                           text=True, encoding="utf-8", errors="replace", cwd=root,
                           env=dict(os.environ, PYTHONIOENCODING="utf-8"))
        if r.returncode == 2:
            raise SourceError("verifier ledger MISSING (tool exit 2: open rows UNKNOWN, not zero): %s"
                              % r.stdout.strip()[:200])
        raw = r.stdout
    try:
        data = json.loads(raw)
        rows = data["stale"]
        assert isinstance(rows, list)
    except (ValueError, KeyError, AssertionError, TypeError):
        raise SourceError("verifier ledger output is not the `check --json` shape ({summary, stale[]})")
    out = []
    for r in rows:
        key = str(r.get("key", ""))
        out.append(candidate("verifier-ledger#" + key, "verifier-action", key, str(r.get("change", "")),
                             owner=r.get("owner", ""), age_days=r.get("age_days")))
    return out


def cmd_gather(a) -> int:
    root = os.path.abspath(a.root)
    paths = {
        "handoff": a.handoff or os.path.join(root, "meta", "HANDOFF-2026-09-29-EOD.md"),
        "open-threads": a.open_threads or os.path.join(root, "meta", "OPEN-THREADS.md"),
        "pending-fixes": a.pending_fixes or os.path.join(root, "meta", "PENDING-FIXES.md"),
    }
    parsers = {
        "handoff": lambda: parse_handoff(paths["handoff"], a.handoff_items),
        "open-threads": lambda: parse_open_threads(paths["open-threads"]),
        "pending-fixes": lambda: parse_pending_fixes(paths["pending-fixes"]),
        "verifier-ledger": lambda: parse_ledger(root, a.ledger_json),
    }
    cands, never, gaps, counts = [], [], [], {}
    for name in SOURCES:
        try:
            items = parsers[name]()
            counts[name] = len(items)
            cands.extend(items)
        except SourceError as e:
            if name in a.allow_missing:
                gaps.append({"source": name, "reason": str(e)})
            else:
                never.append({"source": name, "reason": str(e)})
    if never:
        for n in never:
            print("NEVER_LOOKED: %s - %s" % (n["source"], n["reason"]), file=sys.stderr)
        cands = []
    with_p = sum(1 for c in cands if c["has_explicit_paths"])
    print(json.dumps({"verdict": "NEVER_LOOKED" if never else "ok", "generated": dt.datetime.now().isoformat(
        timespec="seconds"), "root": root, "per_source": counts, "never_looked": never, "gaps": gaps,
        "stats": {"total": len(cands), "with_paths": with_p, "without_paths": len(cands) - with_p},
        "candidates": cands}, indent=1, ensure_ascii=True))
    return 2 if never else 0


# ------------------------------------------------------------------------------------------------ unrelayed

RECORD_FILES = ("HANDOFF-2026-09-29-EOD.md", "OPEN-THREADS.md", "PENDING-FIXES.md")


def dedupe_roots(roots: list) -> list:
    """Scan roots that differ only by case or slash style are one root (project_cwds() returns both spellings of the
    repo dir, which listed every item twice), and a root inside another kept root is dropped (it is walked already)."""
    uniq, keys = [], []
    for r in roots:
        k = norm(r)
        if k not in keys:
            keys.append(k)
            uniq.append(r)
    return [r for r, k in zip(uniq, keys) if not any(o is not k and o != k and covers(o, k) for o in keys)]


def cmd_unrelayed(a) -> int:
    label = "SCREEN (low precision)"
    roles = [r.strip().lower() for r in a.roles.split(",") if r.strip()]
    role_rx = re.compile(r"^_(?:%s)-" % "|".join(re.escape(r) for r in roles), re.I)
    argv = ["--max-dir-entries", str(a.max_dir_entries)]
    for flag, val in (("--session", a.session), ("--project-dir", a.project_dir), ("--since", a.since),
                      ("--as-of", a.as_of), ("--min-bytes", a.min_bytes)):
        if val is not None:
            argv += [flag, str(val)]
    for r in a.root:
        argv += ["--root", r]
    try:
        ur = load_module("unreported_work", "unreported_work.py")
        args = ur.build_argparser().parse_args(argv)
        main_path, _sid = ur.resolve_session(args.session, os.path.expanduser(args.project_dir))
        span_lo, span_hi = ur.session_span(main_path, [])
        lo, hi = args.since or span_lo, args.as_of or span_hi
        lo_dt, hi_dt = ur.parse_dt(lo), ur.parse_dt(hi)
        roots = [os.path.abspath(r) for r in args.root] or [c for c in ur.project_cwds(main_path) if os.path.isdir(c)]
        if not roots:
            raise SystemExit("no scan root: pass --root")
        roots = dedupe_roots(roots)
        found, pruned = ur.walk_deliverables(roots, args, lo_dt, hi_dt)
        arts, seen_art = {}, set()
        for p, m in found.items():
            k = show(norm(p))
            if role_rx.match(os.path.basename(p)) and k not in seen_art:
                seen_art.add(k)
                arts[p] = m
        hidden = []
        for d, n in pruned:
            try:
                k = sum(1 for x in os.listdir(d) if role_rx.match(x))
            except OSError:
                k = 0
            if k:
                hidden.append({"dir": d, "entries": n, "role_files": k})
        if hidden:
            print("NEVER_LOOKED: %d director%s holding %s deliverables exceeded --max-dir-entries %d and was not "
                  "scanned: %s" % (len(hidden), "y" if len(hidden) == 1 else "ies", "/".join(roles),
                                   a.max_dir_entries, "; ".join("%s (%d entries, %d role files)" % (
                                       h["dir"], h["entries"], h["role_files"]) for h in hidden)))
            return 2
        ceo_msgs = ur.collect_ceo_facing(main_path, lo, hi)
        res = ur.classify(arts, ceo_msgs, args, fact_corpus=list(arts)) if arts else {}
    except SystemExit as e:
        print("NEVER_LOOKED: unreported_work did not run (%s)" % (e.code if e.code is not None else "exit"))
        return 2
    except (ValueError, OSError) as e:
        print("NEVER_LOOKED: unreported_work output unusable (%s)" % e)
        return 2

    rec_paths = list(a.record)
    for r in roots:
        rec_paths += [os.path.join(r, "meta", f) for f in RECORD_FILES if os.path.isfile(os.path.join(r, "meta", f))]
    records = []
    for rp in rec_paths:
        try:
            with open(rp, encoding="utf-8", errors="replace") as fh:
                records.append((os.path.basename(rp), fh.read().replace("\\", "/").lower()))
        except OSError:
            continue

    def mentioned(path):
        base = os.path.basename(path).lower()
        stem = base[:-3] if base.endswith(".md") else base
        return [name for name, text in records if base in text or stem in text]

    def row(p):
        return {"path": p, "bytes": arts[p]["bytes"], "produced": arts[p]["mtime_ts"]}

    unrep = sorted([p for p, v in res.items() if v["verdict"] == "UNREPORTED"], key=lambda x: -arts[x]["bytes"])
    undec = sorted([p for p, v in res.items() if v["verdict"] == "UNDECIDABLE"], key=lambda x: -arts[x]["bytes"])
    listed, by_record = [], []
    for p in unrep:
        m = mentioned(p)
        if m:
            by_record.append(dict(row(p), records=m))
        else:
            listed.append(row(p))
    not_scanned = [{"dir": d, "entries": n} for d, n in pruned]
    out = {"label": label, "roles": roles, "window": {"from": lo, "to": hi}, "ceo_facing_messages": len(ceo_msgs),
           "deliverables_in_roles": len(arts), "unrelayed": listed, "relayed_by_record": by_record,
           "undecidable": [row(p) for p in undec], "not_scanned_dirs": not_scanned,
           "records_read": [n for n, _ in records],
           "note": "high recall, low precision: read the list yourself. relayed_by_record = the file name appears in "
                   "the orchestrator's own record (handoff / OPEN-THREADS / PENDING-FIXES), not proof the owner saw it."}
    if a.json:
        print(json.dumps(out, indent=1, ensure_ascii=True))
    else:
        print("%s - a list to read, never a verdict" % label)
        print("roles: %s | window: %s -> %s | owner-facing messages scanned: %d | role deliverables in window: %d"
              % (",".join(roles), lo, hi, len(ceo_msgs), len(arts)))
        print("UNRELAYED (%d)" % len(listed))
        for r in listed:
            print("  %8d B  %s  %s" % (r["bytes"], r["produced"], r["path"]))
        print("RELAYED BY RECORD (%d): named in %s" % (len(by_record), ", ".join(out["records_read"]) or "no record read"))
        if undec:
            print("UNDECIDABLE (%d)" % len(undec))
            for r in out["undecidable"]:
                print("  %8d B  %s" % (r["bytes"], r["path"]))
        if not_scanned:
            print("NOT SCANNED (%d; no role deliverables inside)" % len(not_scanned))
            for d in not_scanned:
                print("  %s (%d entries)" % (d["dir"], d["entries"]))
    return 1 if listed else 0


# ------------------------------------------------------------------------------------------------ main

def build_parser():
    ap = argparse.ArgumentParser(description="Harness dispatch planner: overlap checker, owed-work gather, "
                                             "unrelayed screen.",
                                 epilog="No incidental writes (Bash): DISPATCH_PLANNER_NO_LOG=1 py -I -B "
                                        ".claude/tools/dispatch_planner.py <gather|check|unrelayed> ...")
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("check", help="check a plan JSON for overlap; exit 0 clean / 1 conflict / 2 NEVER_LOOKED")
    c.add_argument("plan")
    c.add_argument("--agents-dir", default=None, help="where <role>.md definitions live (model advisory)")
    c.add_argument("--scratchpad-root", action="append", default=[])
    c.add_argument("--plan-root", default=None, help="main checkout: relative paths and worktree paths map to it")
    c.add_argument("--in-flight", default=None, help="JSON list (or {\"in_flight\": [...]}) of agents already running")
    g = sub.add_parser("gather", help="read the owed-work sources into candidates JSON; exit 2 = a source NEVER_LOOKED")
    g.add_argument("--root", default=REPO_ROOT)
    g.add_argument("--handoff")
    g.add_argument("--open-threads")
    g.add_argument("--pending-fixes")
    g.add_argument("--ledger-json", help="saved `verifier_actions_ledger.py check --json` output instead of running it")
    g.add_argument("--handoff-items", type=int, default=20, help="keep the last N numbered items of the final section")
    g.add_argument("--allow-missing", action="append", default=[], choices=SOURCES)
    u = sub.add_parser("unrelayed", help="finished analyzer/innovator/verifier results never relayed (a SCREEN)")
    u.add_argument("--session")
    u.add_argument("--project-dir")
    u.add_argument("--root", action="append", default=[])
    u.add_argument("--since")
    u.add_argument("--as-of")
    u.add_argument("--min-bytes", type=int)
    u.add_argument("--roles", default="analyzer,innovator,verifier")
    u.add_argument("--record", action="append", default=[], help="extra file whose text counts as 'already relayed'")
    u.add_argument("--max-dir-entries", type=int, default=DEFAULT_MAX_DIR_ENTRIES)
    u.add_argument("--json", action="store_true")
    return ap


def main(argv=None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    a = build_parser().parse_args(argv)
    return {"check": cmd_check, "gather": cmd_gather, "unrelayed": cmd_unrelayed}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
