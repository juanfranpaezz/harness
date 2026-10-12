#!/usr/bin/env python3
r"""
memory_linter.py - deterministic index<->file coherence linter for the auto-memory store
(mirrors decision_linter.py / ceo_model_linter.py — the self-governance robot pattern). Closes the TP-03
gap (verification-gap-audit, 2026-06-07): MEMORY.md was the ONLY auto-loaded steering store with NO
linter, while its two siblings (decisions.md, ceo-model.md) each have one. A drifted index — a dangling
pointer, an orphan memory file, a malformed frontmatter — silently steers EVERY future session.

WHAT IT CHECKS (no model judgment -> running it IS the verification; CONTENT correctness is UNGUARDED):
  1. dangling_pointer: every `- [..](file.md)` index row in MEMORY.md links to a file that EXISTS in
     the memory dir.
  2. orphan_file: every memory `*.md` file in the dir (except MEMORY.md) is referenced by AT LEAST ONE
     index row. (">=1", not "==1": one file may legitimately carry >1 index pointer — an UPDATE
     annotation; e.g. back-translation-defeats-self-certification.md is pointed at twice on purpose.)
     EXCEPTION (2026-10-05, memory-index compaction): a file whose FIRST non-empty body line is a
     `> MERGED <date> into [[<target>]]` pointer is reachable through <target> and is NOT an orphan,
     but ONLY when <target>.md exists AND has an index row. A pointer to an unindexed or missing target,
     a chained pointer, or a pointer below the first body line is still an orphan. Count: n_merged_pointer.
  3. frontmatter: every memory file has YAML frontmatter with a non-empty `name` + `description` and a
     `metadata.type` in `VALID_TYPES` below (the ONLY authority; writer spec: .claude/agents/scribe.md).
  It REPORTS n_files / n_index_rows (the anti-bloat tripwire) but never gates on size. A file referenced
  by >1 index row is REPORTED as `multi_ref` INFO, NOT as drift.

This is the mechanical oracle (structure only). A wrong-but-well-formed memory PASSES — content
correctness (is a recorded fact TRUE / still current?) is the read-leg risk, unguarded here by design
(poisoning-resistance != safety; same posture as the decisions/ceo-model stores).

STORE RESOLUTION (fixed 2026-09-04 -- the silent-no-op class). The default used to be the CWD-relative
`./MEMORY.md`, so running the linter from anywhere but a directory that happens to hold a MEMORY.md
examined NOTHING and still exited 0. The real auto-memory store lives OUTSIDE the repo. Order now:
  1. `--memory-dir <path>` (explicit; the form a caller should rely on)
  2. a bare positional `path/to/MEMORY.md | path/to/memory-dir` (back-compat: hook + suite use it)
  3. the CANONICAL store `~/.claude/projects/<slug>/memory`, where <slug> is this repo's absolute
     path with the drive letter lowercased and every non-alphanumeric char turned into `-`
     (`c:/src/my project` -> `c--src-my-project`) -- how Claude Code names project dirs
  4. the LEGACY repo-local `<repo>/MEMORY.md` (repo-root anchored, no longer CWD-dependent)
The chosen store and the rule that picked it are ECHOED in the JSON as `memory_dir` + `source`, so a
caller can never again be unable to tell WHICH store was linted.

EMPTY-STORE GATE: examining 0 memory files and reporting `n_drift:0` is a clean bill of health from an
instrument that looked at nothing. When the index is readable but the dir holds 0 memory files, this
now emits an `empty_store` drift row and exits 3 with a message on stderr, unless `--allow-empty` is
passed. CARVE-OUT (deliberate, so the fail-open hook contract is untouched): an unreadable index or an
unreadable dir keeps its historical `exit 0` with `n_drift>=1` -- those already report NOT-clean, so
they were never the silent-CLEAN hole.

Usage:  py memory_linter.py [--memory-dir <path>] [--allow-empty] [path/to/MEMORY.md | memory-dir]
Output: JSON {drift:[{file,kind,detail}], n_files, n_index_rows, n_merged_pointer, multi_ref, n_drift, warnings:[],
        memory_dir, source}; exit 0 clean, 2 bad usage, 3 empty store.
        `warnings` is a NON-BLOCKING advisory channel (e.g. an anti-bloat soft-cap notice, or a file with bytes
        that are not valid UTF-8: kind "non_utf8"); it NEVER changes n_drift or the exit code.
"""
from __future__ import annotations
import json
import os
import re
import sys

# An index bullet:  - [Some Title](some-file.md) — hook   (capture the link target)
INDEX_LINK_RE = re.compile(r"^- \[[^\]]*\]\(([^)]+)\)")
TOP_FIELD_RE = re.compile(r"^([A-Za-z_]+):\s*(.*)$")
NESTED_FIELD_RE = re.compile(r"^\s+([A-Za-z_]+):\s*(.*)$")
VALID_TYPES = {"user", "feedback", "project", "reference"}
# Anti-bloat SOFT cap (TP-14): an advisory tripwire on the count of memory files. NON-BLOCKING — it
# only appends a `warnings` entry and NEVER touches n_drift or the exit code. Set HIGHER than the
# decision/ceo-pref cap (30) because memories are one-line index entries by design and the curated
# real store already sits at ~35 healthily; 50 is the "now it's genuinely sprawling, distill" line.
FILES_SOFT_CAP = 50
# A merged-away memory file keeps its history copy and points at the file that now holds its text, on the
# FIRST non-empty body line, exactly as the 2026-10-05 merge script writes it:
#   > MERGED 2026-10-05 into [[target-stem]] — this file's full content was moved there verbatim ...
MERGED_POINTER_RE = re.compile(r"^> MERGED \S+ into \[\[([^\]|#]+)\]\]")


def _unquote_scalar(v: str) -> str:
    """Strip ONE matching pair of surrounding quotes (YAML-style), then re-strip whitespace.

    The reader below is a line-regex, not a YAML parser, so it used to store the RAW two-character
    string for `name: ""` -- and `'""'` is TRUTHY, so an EMPTY quoted value silently passed the
    non-empty tests (harness-is-the-system-name.md carried one for months, undetected). Unquoting at
    the single point of storage fixes the whole class at once: an empty quoted value now reads as
    empty and IS flagged, while a legitimately quoted one (`type: "user"`, or the quoted
    `description:` that most real memory files use) keeps its real content.
    """
    v = v.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in ('"', "'"):
        v = v[1:-1]
    return v.strip()


def parse_frontmatter(text: str) -> dict | None:
    """Flat dict of frontmatter fields (metadata.* flattened, values unquoted), None if no `---` block."""
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return None
    fm: dict[str, str] = {}
    in_meta = False
    for ln in lines[1:]:
        if ln.strip() == "---":
            break
        top = TOP_FIELD_RE.match(ln)
        if top:
            key, val = top.group(1).lower(), _unquote_scalar(top.group(2))
            if key == "metadata":
                in_meta = True            # a mapping follows on indented lines
            else:
                fm[key] = val
                in_meta = False           # left the metadata block
            continue
        nested = NESTED_FIELD_RE.match(ln)
        if nested and in_meta:
            fm["metadata." + nested.group(1).lower()] = _unquote_scalar(nested.group(2))
    return fm


def _read_text(path: str) -> tuple[str, bool]:
    """(text, was_non_utf8). utf-8-sig strict first (a valid file takes the exact old path, BOM stripped); a file that
    fails to decode is re-read with errors="replace" so ONE bad byte cannot kill the whole linter. OSError propagates.
    2026-10-01: the same defect class silently killed ref_linter.py for three days (a strict decode under `except
    OSError` -- UnicodeDecodeError is a ValueError, so it escaped as a traceback and every check died with it)."""
    try:
        with open(path, encoding="utf-8-sig") as fh:
            return fh.read(), False
    except UnicodeDecodeError:
        with open(path, encoding="utf-8-sig", errors="replace") as fh:
            return fh.read(), True


def merged_pointer_target(text: str) -> str | None:
    """`<target>.md` named by a MERGED pointer on the first non-empty line after the frontmatter, else None."""
    lines = text.splitlines()
    start = 0
    if lines and lines[0].strip() == "---":
        close = next((i for i in range(1, len(lines)) if lines[i].strip() == "---"), None)
        if close is None:
            return None
        start = close + 1
    first = next((ln for ln in lines[start:] if ln.strip()), "")
    m = MERGED_POINTER_RE.match(first)
    return (m.group(1).strip() + ".md") if m else None


def _non_utf8_warning(fname: str) -> dict:
    return {"kind": "non_utf8", "file": fname,
            "detail": "contains bytes that are not valid UTF-8; decoded with replacement so every check still ran"}


def check_frontmatter(fname: str, fpath: str, drift: list[dict], warnings: list[dict] | None = None) -> None:
    try:
        text, bad = _read_text(fpath)
    except OSError as e:
        drift.append({"file": fname, "kind": "file_unreadable", "detail": str(e)})
        return
    if bad and warnings is not None:
        warnings.append(_non_utf8_warning(fname))
    fm = parse_frontmatter(text)
    if fm is None:
        drift.append({"file": fname, "kind": "frontmatter", "detail": "no `---` frontmatter block"})
        return
    if not fm.get("name", "").strip():
        drift.append({"file": fname, "kind": "frontmatter", "detail": "missing/empty `name`"})
    if not fm.get("description", "").strip():
        drift.append({"file": fname, "kind": "frontmatter", "detail": "missing/empty `description`"})
    mtype = fm.get("metadata.type", "").strip().lower()
    if not mtype:
        drift.append({"file": fname, "kind": "frontmatter", "detail": "missing `metadata.type`"})
    elif mtype not in VALID_TYPES:
        drift.append({"file": fname, "kind": "frontmatter",
                      "detail": f"metadata.type '{mtype}' not in {sorted(VALID_TYPES)}"})


REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
EXIT_USAGE = 2
EXIT_EMPTY_STORE = 3


def project_slug(repo_path: str) -> str:
    """Claude Code's project-dir name for an absolute path: drive letter lowercased, every
    non-alphanumeric character -> `-`.  `C:\\\\src\\\\my project` -> `c--src-my-project`
    (the `:` and the separator each contribute one dash, hence the doubled dash after the drive).
    """
    p = os.path.abspath(repo_path)
    if len(p) >= 2 and p[1] == ":":
        p = p[0].lower() + p[1:]
    return re.sub(r"[^A-Za-z0-9]", "-", p)


def canonical_memory_dir(repo_path: str = REPO_ROOT, home: str | None = None) -> str:
    """`<config dir>/projects/<slug>/memory` -- where the auto-memory store actually lives.

    <config dir> is the RUNNING profile: CLAUDE_CONFIG_DIR when set (e.g. ~/.claude-employer), else ~/.claude.
    2026-10-08 (hook-paths fix): it was always ~/.claude, so a no-argument run inside a work profile linted
    the PERSONAL profile's store. An explicit `home` keeps its old meaning (<home>/.claude).
    """
    if home is None:
        cfg = (os.environ.get("CLAUDE_CONFIG_DIR") or "").strip()
        if cfg:
            return os.path.join(cfg, "projects", project_slug(repo_path), "memory")
    h = home if home is not None else os.path.expanduser("~")
    return os.path.join(h, ".claude", "projects", project_slug(repo_path), "memory")


def resolve_target(argv: list[str]) -> tuple[str, str, bool]:
    """(target_path, source_label, allow_empty) from argv[1:]. See STORE RESOLUTION in the docstring."""
    allow_empty = False
    explicit: str | None = None
    positional: str | None = None
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--allow-empty":
            allow_empty = True
        elif a == "--memory-dir":
            i += 1
            if i >= len(argv):
                sys.stderr.write("memory_linter: --memory-dir requires a path\n")
                sys.exit(EXIT_USAGE)
            explicit = argv[i]
        elif a.startswith("--memory-dir="):
            explicit = a.split("=", 1)[1]
        elif a.startswith("--"):
            sys.stderr.write(f"memory_linter: unknown option {a}\n")
            sys.exit(EXIT_USAGE)
        elif positional is None:
            positional = a
        i += 1
    if explicit is not None:
        return os.path.abspath(explicit), "--memory-dir", allow_empty
    if positional is not None:
        return os.path.abspath(positional), "positional", allow_empty
    canon = canonical_memory_dir()
    if os.path.isfile(os.path.join(canon, "MEMORY.md")):
        return canon, "canonical", allow_empty
    return os.path.join(REPO_ROOT, "MEMORY.md"), "legacy-repo-local", allow_empty


def main() -> None:
    arg, source, allow_empty = resolve_target(sys.argv[1:])
    if os.path.isdir(arg):
        memory_dir, index_fp = arg, os.path.join(arg, "MEMORY.md")
    else:
        index_fp, memory_dir = arg, os.path.dirname(arg)

    drift: list[dict] = []
    warnings: list[dict] = []   # NON-BLOCKING advisory channel; declared here because the index read below can add to it
    try:
        text, index_bad = _read_text(index_fp)
    except OSError as e:
        # Index missing/unreadable is itself drift (fail-closed signal; the hook still decides).
        print(json.dumps({"drift": [{"file": None, "kind": "file_unreadable", "detail": str(e)}],
                          "n_files": 0, "n_index_rows": 0, "n_merged_pointer": 0, "multi_ref": [], "n_drift": 1,
                          "warnings": [], "memory_dir": memory_dir, "source": source}, indent=2))
        sys.exit(0)
    if index_bad:
        warnings.append(_non_utf8_warning(os.path.basename(index_fp)))

    # --- collect index link targets (basename, to compare against the memory dir) ---
    referenced: list[str] = []
    for ln in text.splitlines():
        m = INDEX_LINK_RE.match(ln)
        if m:
            referenced.append(os.path.basename(m.group(1).strip()))

    # --- collect actual memory files (exclude the index itself) ---
    try:
        files = sorted(f for f in os.listdir(memory_dir) if f.endswith(".md") and f != "MEMORY.md")
    except OSError as e:
        print(json.dumps({"drift": [{"file": None, "kind": "dir_unreadable", "detail": str(e)}],
                          "n_files": 0, "n_index_rows": len(referenced), "n_merged_pointer": 0, "multi_ref": [], "n_drift": 1,
                          "warnings": [], "memory_dir": memory_dir, "source": source}, indent=2))
        sys.exit(0)

    files_set = set(files)
    ref_counts: dict[str, int] = {}
    for r in referenced:
        ref_counts[r] = ref_counts.get(r, 0) + 1

    # --- check 1: dangling pointer (index row -> missing file) ---
    for r in sorted(set(referenced)):  # sorted(): deterministic drift order across processes
        if r not in files_set:
            drift.append({"file": r, "kind": "dangling_pointer",
                          "detail": "index row links to a file not present in the memory dir"})

    # --- check 2: orphan file (file on disk -> not referenced by any index row) ---
    # A first-body-line MERGED pointer to an INDEXED, existing target makes the file reachable (not drift).
    ref_set = set(referenced)
    n_merged_pointer = 0
    for f in files:  # already sorted
        if f not in ref_set:
            try:
                target = merged_pointer_target(_read_text(os.path.join(memory_dir, f))[0])
            except OSError:
                target = None   # unreadable: stays an orphan; check 3 reports file_unreadable
            if target is not None and target in ref_set and target in files_set:
                n_merged_pointer += 1
                continue
            drift.append({"file": f, "kind": "orphan_file",
                          "detail": "memory file exists but no index row points at it" + (
                              f" (its MERGED pointer names {target}, which has no index row or does not exist)"
                              if target is not None else "")})

    # --- check 3: frontmatter completeness (every real memory file) ---
    for f in files:
        check_frontmatter(f, os.path.join(memory_dir, f), drift, warnings)

    # --- info (NOT drift): files carrying more than one index pointer (allowed) ---
    multi_ref = sorted(f for f, c in ref_counts.items() if c > 1)

    # --- anti-bloat ADVISORY (TP-14): non-blocking; never affects n_drift / exit code ---
    if len(files) > FILES_SOFT_CAP:
        warnings.append({"kind": "bloat",
                         "detail": f"n_files={len(files)} exceeds soft cap {FILES_SOFT_CAP}"})

    # --- EMPTY-STORE GATE: an instrument that examined nothing must never report clean ---
    empty = (len(files) == 0 and not allow_empty)
    if empty:
        drift.append({"file": None, "kind": "empty_store",
                      "detail": f"0 memory files examined in {memory_dir} - a linter that examines "
                                "nothing must never report clean"})

    print(json.dumps({"drift": drift, "n_files": len(files), "n_index_rows": len(referenced),
                      "n_merged_pointer": n_merged_pointer,
                      "multi_ref": multi_ref, "n_drift": len(drift), "warnings": warnings,
                      "memory_dir": memory_dir, "source": source}, indent=2))
    if empty:
        sys.stderr.write(
            f"memory_linter: FAIL - 0 memory files examined in {memory_dir} (source={source}). "
            "Pass --memory-dir <path/to/the/real/store>, or --allow-empty if an empty store is "
            "expected.\n")
        sys.exit(EXIT_EMPTY_STORE)
    sys.exit(0)


if __name__ == "__main__":
    main()
