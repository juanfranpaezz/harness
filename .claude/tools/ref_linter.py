#!/usr/bin/env python3
r"""
ref_linter.py - deterministic broken-REFERENCE linter for the corpus (self-governance robot #1).

SCOPE v1 (locked by independent design review af8596d049e27a9d0): MARKDOWN LINKS ONLY,
in git-TRACKED *.md files. The review implemented the original 3-rule plan and measured
~201 false positives / 0 true positives on the real corpus -- 150 of them from backticked
prose mentions of real files that live in other dirs, plus `file:line` grammar tokens,
line-range citations, and absolute paths shattered on spaces. The markdown-link rule ALONE
measured 0 false positives while still catching the target class (a `[text](path)` whose
path does not resolve). So this v1 ships ONLY that rule. Any future extractor must: skip
absolute paths, skip out-of-repo targets, not split on spaces, skip `file:line`/`file:symbol`
grammar tokens and `name:NN-MM` citations -- and must re-calibrate to 0 FP before shipping.

This linter IS the mechanical oracle (no model judgment) -> running it is the verification.

Usage:  py ref_linter.py [repo_root]      (default: current dir)
Output: JSON {broken:[{file,line,text,target}], scanned_md, links_checked, n_broken}; exit 0.
        Plus, ONLY when a tracked *.md is not valid UTF-8: n_non_utf8_files + non_utf8_files (see ENCODING below);
        a clean corpus prints the same JSON as before.
The hook layer (ref-lint-gate.mjs) decides observe-vs-block; this tool only reports.
"""
from __future__ import annotations
import hashlib
import json
import os
import re
import subprocess
import sys

LINK = re.compile(r"\[([^\]]*)\]\(([^)]+)\)")
SKIP_PREFIX = ("http://", "https://", "mailto:", "#", "tel:")

# --- 2026-09-23 scope + precision, added after the count sat pinned at 638 for 13 days ---------
# Re-derived 2026-09-23 from this linter's own output: of 638 "broken" refs, 521 were
# site-root-absolute vendor-doc URLs (/docs/en/...) inside MIRRORED Claude Code documentation
# under meta/cache/, 114 were archived snapshots whose targets legitimately live elsewhere, and
# ZERO were in a live tracked document. Two separate defects, fixed separately below.
#
# (1) PRECISION. This file's own v1 contract (docstring above) says a future extractor "must skip
#     absolute paths, skip out-of-repo targets". That was never implemented: v1 fed an absolute
#     target straight to os.path.exists. On Windows "/docs/en/tools" IS os.path.isabs, so every
#     site-root link in a mirrored web page counted as a broken FILE reference. The 0-FP
#     calibration held only until vendor-doc mirrors landed in the corpus. An absolute target that
#     resolves OUTSIDE the lint root is now skipped and counted in skipped_out_of_repo.
# (2) SCOPE. Broken refs inside archival snapshot trees are real but are not actionable debt: the
#     snapshot is a photograph of a moment and its targets moved on purpose. They are split into
#     n_broken_archival -- REPORTED, never hidden -- so that n_broken can reach 0 and breakage
#     number 639 in a LIVE document becomes visible instead of drowning in frozen history.
ARCHIVAL_PREFIXES = ("meta/cache/", "meta/wave9-portable/")
ARCHIVAL_SAMPLE_N = 5
OUT_OF_REPO_SAMPLE_N = 5

# (4) ENCODING, i.e. the three-day outage. Measured 2026-10-01: ONE tracked file
#     (meta/cache/_verifier-<topic>-2026-09-19-1510.md: 72 stray 0xC2/0xA7 bytes, likely the two halves
#     of a split U+00A7) raised UnicodeDecodeError out of the strict open() in main(), which caught only OSError. The
#     traceback killed the WHOLE run -- every one of ~2,860 files, not just that one -- on every Stop from 2026-09-29
#     (137 + 33 + 62 logged check_status=error rows); ref-lint-gate.mjs fails open by design, so nothing blocked and
#     nothing was loud. POLICY: such a file is decoded with errors="replace" and STILL linted (skipping it would exempt
#     every link in it, the same blind spot in miniature) and is REPORTED in two additive keys that exist only when
#     something is wrong (n_non_utf8_files, non_utf8_files): n_broken keeps meaning "broken reference", and a clean
#     corpus prints byte-identical JSON to before. A flagged file is never cached, so a cache hit cannot silence it.
NON_UTF8_SAMPLE_N = 20

# (3) SPEED, i.e. the ETIMEDOUT root cause. ref-lint-gate.mjs spawns this with a 12 s internal
#     budget (_py-resolve.mjs:34, itself pinned under the 15 s hook budget in settings.json, which
#     is CEO-gated and NOT touched here). Measured 2026-09-23 on the real corpus: 50.9 s on a cold
#     file cache, then 6.4 s and 3.0 s warm, over 2,120 tracked *.md / 40.6 MB. The cold read is
#     what blows the 12 s budget. Link EXTRACTION is now cached per file, keyed by (size,
#     mtime_ns), so a steady-state turn re-reads only files that actually changed. Cache failure
#     is never fatal: any error degrades to a full re-scan. REF_LINTER_NO_CACHE=1 disables it.
#     WHERE (portability fix 2026-10-01): the cache is HARNESS state, so it lives under the harness's own config
#     dir -- CLAUDE_CONFIG_DIR when set, else the root this file ships in (<root>/tools/ref_linter.py -> <root>) --
#     and NEVER under the lint root, which is the user's project. Measured 2026-10-01: the work profile wrote
#     C:/work/employer/cache/ref_linter_scan_cache.json into the owner's work folder. One file per lint root, named
#     by a hash of its real path, keeps the old one-cache-per-root behaviour without cross-project collisions.
CACHE_DIRNAME = "ref_linter_scan_cache"
CACHE_VERSION = 2


def _harness_home() -> str:
    cfg = (os.environ.get("CLAUDE_CONFIG_DIR") or "").strip()
    return cfg or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _cache_path(root: str) -> str:
    key = hashlib.sha256(os.path.normcase(os.path.realpath(root)).encode("utf-8")).hexdigest()[:16]
    return os.path.join(_harness_home(), "cache", CACHE_DIRNAME, key + ".json")


def _load_cache(root: str) -> dict:
    if os.environ.get("REF_LINTER_NO_CACHE"):
        return {}
    try:
        with open(_cache_path(root), encoding="utf-8") as fh:
            blob = json.load(fh)
        if blob.get("v") != CACHE_VERSION:
            return {}
        files = blob.get("files", {})
        return files if isinstance(files, dict) else {}
    except Exception:  # noqa: BLE001 -- a bad cache must degrade to a full scan, never crash
        return {}


def _save_cache(root: str, files: dict) -> None:
    if os.environ.get("REF_LINTER_NO_CACHE"):
        return
    try:
        cp = _cache_path(root)
        os.makedirs(os.path.dirname(cp), exist_ok=True)
        tmp = cp + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump({"v": CACHE_VERSION, "files": files}, fh)
        os.replace(tmp, cp)
    except Exception:  # noqa: BLE001 -- an unwritable cache is a slow linter, not a broken one
        pass


def _inside_root(root: str, resolved: str) -> bool:
    """True when resolved sits inside the lint root. False on another drive/volume."""
    try:
        r = os.path.realpath(root)
        p = os.path.realpath(resolved)
        return os.path.commonpath([r, p]) == r
    except (ValueError, OSError):
        return False


def _read_md(fp: str) -> tuple[str, bool]:
    """(text, was_non_utf8). Strict UTF-8 first, so a valid file takes EXACTLY the old path (same open() call, same
    newline translation); only a file that fails to decode is re-read with errors="replace". OSError still propagates."""
    try:
        with open(fp, encoding="utf-8") as fh:
            return fh.read(), False
    except UnicodeDecodeError:
        with open(fp, encoding="utf-8", errors="replace") as fh:
            return fh.read(), True


def extract_links(text: str) -> list:
    """[[line, link_text, target], ...] for every LIVE markdown link (fences + code spans out)."""
    out: list = []
    in_fence = False
    for ln, line in enumerate(text.splitlines(), 1):
        stripped = line.lstrip()
        if stripped.startswith("```") or stripped.startswith("~~~"):
            in_fence = not in_fence  # toggle fenced code block
            continue
        if in_fence:
            continue  # links inside fenced code blocks are not live links
        # remove inline `code` spans: a [text](x) inside backticks renders as literal text,
        # not a live link, so it must not be linted (kills the doc-grammar FP class).
        scan = re.sub(r"`[^`]*`", "", line)
        for m in LINK.finditer(scan):
            out.append([ln, m.group(1), m.group(2).strip()])
    return out


def tracked_md(root: str) -> list[str]:
    """git-tracked *.md only (review change #3: avoids untracked/transient + JSON FP sources)."""
    try:
        out = subprocess.run(["git", "-C", root, "ls-files", "*.md"],
                             capture_output=True, text=True, check=True).stdout
    except Exception:  # noqa: BLE001 -- not a git repo / git missing -> nothing to lint
        return []
    return [os.path.join(root, p) for p in out.splitlines() if p.strip()]


def main() -> None:
    root = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else ".")
    broken: list[dict] = []           # LIVE documents -- the actionable alarm set
    broken_archival: list[dict] = []  # archival snapshot trees -- reported, not alarmed on
    scanned = 0
    checked = 0
    skipped_out_of_repo = 0
    out_of_repo_sample: list[dict] = []
    files_read = 0
    files_cached = 0
    non_utf8: list[str] = []          # tracked *.md that are not valid UTF-8: linted anyway, reported (see ENCODING)
    cache = _load_cache(root)
    fresh: dict = {}
    for fp in sorted(tracked_md(root)):
        scanned += 1
        rel = os.path.relpath(fp, root).replace("\\", "/")
        try:
            st = os.stat(fp)
        except OSError:
            continue
        sig = [st.st_size, st.st_mtime_ns]
        bad = False
        ent = cache.get(rel)
        if isinstance(ent, list) and len(ent) == 3 and ent[0] == sig[0] and ent[1] == sig[1]:
            links = ent[2]
            files_cached += 1
        else:
            try:
                text, bad = _read_md(fp)
            except OSError:
                continue
            links = extract_links(text)
            files_read += 1
        if bad:
            non_utf8.append(rel)   # never cached: re-derived from the bytes every run, so a warm cache cannot silence it
        else:
            fresh[rel] = [sig[0], sig[1], links]
        base = os.path.dirname(fp)
        for ln, link_text, target in links:
            low = target.lower()
            if low.startswith(SKIP_PREFIX):
                continue
            # drop a trailing #anchor and an optional (path "title") suffix
            path_part = target.split("#", 1)[0].split(" ", 1)[0].strip()
            if not path_part:
                continue  # pure #anchor link
            # A target that starts with "/" (or "\\") is ROOT-relative, never dir-relative.
            # PORTABILITY, measured here 2026-09-23: Python 3.13 changed ntpath.isabs so that
            # "/docs/en/tools" is NO LONGER os.path.isabs on Windows while it still is on POSIX.
            # Testing isabs alone therefore gives two different answers on two machines for the
            # same corpus. This branch is explicit and platform-independent.
            if path_part[0] in ("/", "\\"):
                cand = os.path.normpath(os.path.join(root, path_part.lstrip("/\\")))
                if os.path.exists(cand):
                    checked += 1        # repo-root-relative and it resolves -> genuinely fine
                    continue
                # Does not resolve under the lint root => a SITE-root URL (the vendor-doc mirror
                # class: 521 of the old 638) or an out-of-repo absolute path. v1's own contract
                # says skip out-of-repo targets. Sampled in out_of_repo_sample so the decision
                # stays auditable -- KNOWN RESIDUAL: a genuinely broken repo-root-relative link
                # lands here too and is no longer alarmed on. Audit that sample, do not trust it.
                skipped_out_of_repo += 1
                if len(out_of_repo_sample) < OUT_OF_REPO_SAMPLE_N:
                    out_of_repo_sample.append({"file": rel, "line": ln, "target": target})
                continue
            is_abs = os.path.isabs(path_part)
            resolved = (path_part if is_abs
                        else os.path.normpath(os.path.join(base, path_part)))
            if is_abs and not _inside_root(root, resolved):
                skipped_out_of_repo += 1
                if len(out_of_repo_sample) < OUT_OF_REPO_SAMPLE_N:
                    out_of_repo_sample.append({"file": rel, "line": ln, "target": target})
                continue
            checked += 1
            if not os.path.exists(resolved):
                rec = {"file": rel, "line": ln, "text": link_text, "target": target}
                if rel.startswith(ARCHIVAL_PREFIXES):
                    broken_archival.append(rec)
                else:
                    broken.append(rec)
    _save_cache(root, fresh)
    # additive keys, present ONLY when something is wrong: a clean corpus prints the same JSON as before
    extra = ({"n_non_utf8_files": len(non_utf8), "non_utf8_files": non_utf8[:NON_UTF8_SAMPLE_N]}
             if non_utf8 else {})
    arch_files = sorted({b["file"] for b in broken_archival})
    print(json.dumps({"broken": broken, "scanned_md": scanned,
                      "links_checked": checked, "n_broken": len(broken),
                      # --- archival debt: split out, counted and sampled, NEVER hidden ---
                      "n_broken_archival": len(broken_archival),
                      "n_archival_files": len(arch_files),
                      "archival_files": arch_files[:ARCHIVAL_SAMPLE_N],
                      "archival_sample": broken_archival[:ARCHIVAL_SAMPLE_N],
                      "n_broken_total": len(broken) + len(broken_archival),
                      "archival_prefixes": list(ARCHIVAL_PREFIXES),
                      # --- precision + speed telemetry ---
                      "skipped_out_of_repo": skipped_out_of_repo,
                      "out_of_repo_sample": out_of_repo_sample,
                      "files_read": files_read, "files_cached": files_cached, **extra},
                     indent=2))
    sys.exit(0)


if __name__ == "__main__":
    main()
