#!/usr/bin/env python3
"""Compute weighted plan completion from read-only evidence checks."""

import argparse
import datetime
import hashlib
import json
import math
from pathlib import Path, PureWindowsPath
import re
import subprocess
import sys


PLAN_REPOS = {
    "harness": Path("<harness-repo>"),
    "project": Path("<project-repo>"),
}
STATUSES = {"DONE", "PARTIAL", "TODO"}
LANES = {"LIGHT", "HEAVY", "SOLO", "CODEX_RO", "CODEX_WRITE", "OWNER"}
VERDICT_PREFIX = "## VERDICT:"
# Token after the prefix with "*" stripped: capitals ended by whitespace, "(" or end of line.
VERDICT_TOKEN = re.compile(r"\s*([A-Z]+)(?=\s|\(|$)")


class SchemaError(ValueError):
    """An input cannot be interpreted as a plan."""


def require(condition, where, message):
    if not condition:
        raise SchemaError(f"{where}: {message}")


def nonempty_string(value):
    return isinstance(value, str) and bool(value.strip()) and "\0" not in value


def validate(plan, source):
    """Validate schema, including real owner dates and repo-relative record paths.

    Owner dates use YYYY-MM-DD and must parse as calendar dates. Owner paths
    cannot be absolute, drive-qualified, rooted, or contain '..' segments.
    """
    require(isinstance(plan, dict), source, "expected a plan object")
    name = plan.get("plan")
    require(isinstance(name, str) and name in PLAN_REPOS, source,
            "unknown plan; expected harness or project")
    items = plan.get("items")
    require(isinstance(items, list) and bool(items), source,
            "items must be a nonempty array (percentage needs a denominator)")
    ids = set()
    for index, item in enumerate(items):
        where = f"{source}: items[{index}]"
        require(isinstance(item, dict), where, "expected an item object")
        for field in ("id", "title", "done_definition"):
            require(nonempty_string(item.get(field)), where,
                    f"missing or invalid {field}; expected a nonempty string")
        where += f" ({item['id']})"
        require(item["id"] not in ids, where, f"duplicate id {item['id']!r}")
        ids.add(item["id"])
        for field, allowed in (("status", STATUSES), ("lane", LANES)):
            value = item.get(field)
            require(isinstance(value, str) and value in allowed, where,
                    f"unknown {field} {value!r}; expected {', '.join(sorted(allowed))}")
        weight = item.get("weight_hours")
        try:
            valid_weight = (type(weight) in (int, float)
                            and math.isfinite(weight) and weight > 0)
        except OverflowError:
            valid_weight = False
        require(valid_weight, where, "weight_hours must be a finite positive number")
        dependencies = item.get("depends_on", [])
        require(isinstance(dependencies, list)
                and all(nonempty_string(dep) for dep in dependencies), where,
                "depends_on must be an array of ids")
        evidence = item.get("evidence", [])
        require(isinstance(evidence, list), where, "evidence must be an array")
        for number, check in enumerate(evidence):
            location = f"{where}: evidence[{number}]"
            require(isinstance(check, dict), location, "expected an evidence object")
            kind = check.get("type")
            require(isinstance(kind, str) and kind in {"commit", "report", "file", "owner"},
                    location, f"unknown evidence type {kind!r}")
            fields = {"commit": ("repo", "sha", "branch"),
                      "owner": ("note", "date", "recorded_in")}.get(kind, ("path",))
            for field in fields:
                require(nonempty_string(check.get(field)), location,
                        f"missing or invalid {field}")
            if kind == "owner":
                require(re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", check["date"]) is not None,
                        location, "date must be YYYY-MM-DD")
                try:
                    datetime.date.fromisoformat(check["date"])
                except ValueError as exc:
                    raise SchemaError(f"{location}: date must be a valid calendar date") from exc
                record_path = PureWindowsPath(check["recorded_in"])
                require(not record_path.drive and not record_path.root
                        and ".." not in record_path.parts, location,
                        "recorded_in must be repo-relative without '..' segments")
            if kind == "commit":
                require(re.fullmatch(r"[0-9a-fA-F]{1,64}", check["sha"]) is not None,
                        location, "sha must be a hexadecimal commit id")
                require(not check["branch"].startswith("-"), location,
                        "branch must not start with '-' (a git option)")
            if kind == "report":
                accept = check.get("accept", ["PASS"])
                require(isinstance(accept, list)
                        and all(nonempty_string(token) for token in accept), location,
                        "accept must be an array of verdict tokens")
            if kind == "file" and "sha256_prefix" in check:
                prefix = check["sha256_prefix"]
                require(isinstance(prefix, str)
                        and re.fullmatch(r"[0-9a-fA-F]{1,64}", prefix) is not None,
                        location, "sha256_prefix must contain 1 to 64 hexadecimal digits")
    for item in items:
        for dep in item.get("depends_on", []):
            require(dep in ids, f"{source}: item {item['id']}",
                    f"depends_on names missing id {dep!r}")
    try:
        math.fsum(item["weight_hours"] for item in items)
    except OverflowError as exc:
        raise SchemaError(f"{source}: total weight_hours is too large") from exc
    return plan


def resolve_path(value, root):
    path = Path(value)
    return path if path.is_absolute() else root / path


def check_evidence(check, root, item_id=None, items_source=None):
    """Return a failure description, or None when the check passes.

    Owner records must name the whole item id (bounded by characters outside
    A-Z, a-z, 0-9 and '-'). The items source and meta/cache/_plan-* files or
    directories cannot serve as owner records. Schema validation requires
    repo-relative owner paths without '..' and valid YYYY-MM-DD calendar dates.
    """
    kind = check["type"]
    try:
        if kind == "commit":
            repo = resolve_path(check["repo"], root)
            sha, branch = check["sha"], check["branch"]
            exists = subprocess.run(
                ["git", "-C", str(repo), "cat-file", "-e", f"{sha}^{{commit}}"],
                capture_output=True, check=False,
            )
            if exists.returncode != 0:
                return f"commit {sha}: cat-file -e failed (exit {exists.returncode}) in {repo}"
            reachable = subprocess.run(
                ["git", "-C", str(repo), "merge-base", "--is-ancestor", sha, branch],
                capture_output=True, check=False,
            )
            if reachable.returncode != 0:
                return (f"commit {sha}: merge-base --is-ancestor failed "
                        f"(exit {reachable.returncode}); not reachable from {branch} in {repo}")
            return None
        if kind == "owner":
            path = resolve_path(check["recorded_in"], root).resolve()
            if items_source is not None and path == Path(items_source).resolve():
                return f"owner {path}: items file cannot be an owner record"
            relative = path.relative_to(root.resolve())
            parts = tuple(part.lower() for part in relative.parts)
            if (len(parts) >= 3 and parts[:2] == ("meta", "cache")
                    and parts[2].startswith("_plan-")):
                return f"owner {path}: plan files cannot be owner records"
            record = path.read_text(encoding="utf-8-sig")
            if not item_id or re.search(
                    rf"(?<![A-Za-z0-9-]){re.escape(item_id)}(?![A-Za-z0-9-])", record) is None:
                return f"owner {path}: does not contain item id {item_id!r}"
            return None
        path = resolve_path(check["path"], root)
        if kind == "report":
            with path.open(encoding="utf-8-sig") as report:
                for line in report:
                    if line.startswith(VERDICT_PREFIX):
                        rest = line[len(VERDICT_PREFIX):].replace("*", "").rstrip("\r\n")
                        match = VERDICT_TOKEN.match(rest)
                        if not match:
                            return f"report {path}: first VERDICT line unparseable: {line.strip()[:80]!r}"
                        token = match.group(1)
                        accept = check.get("accept", ["PASS"])
                        if token not in accept:
                            return f"report {path}: first verdict {token!r} not in accept {accept!r}"
                        return None
            return f"report {path}: no matching VERDICT line"
        if not path.exists():
            return f"file {path}: does not exist"
        if "sha256_prefix" in check:
            with path.open("rb") as artifact:
                digest = hashlib.file_digest(artifact, "sha256").hexdigest()
            if not digest.startswith(check["sha256_prefix"].lower()):
                return f"file {path}: sha256 prefix mismatch (actual {digest})"
        return None
    except (OSError, UnicodeError, ValueError) as exc:
        return f"{kind} check failed: {exc}"


def compute(plan, repo_root=None, items_source=None):
    """Compute completion, passing the items source to reject owner self-evidence."""
    root = Path(repo_root) if repo_root is not None else PLAN_REPOS[plan["plan"]]
    items = plan["items"]
    total = math.fsum(item["weight_hours"] for item in items)
    done_weights = []
    rejected = []
    for item in items:
        if item["status"] != "DONE":
            continue
        checks = item.get("evidence", [])
        failures = [failure for check in checks
                    if (failure := check_evidence(check, root, item["id"], items_source)) is not None]
        if not checks:
            failures.append("empty evidence")
        if failures:
            rejected.append({"id": item["id"], "failures": failures})
        else:
            done_weights.append(item["weight_hours"])
    partial = math.fsum(item["weight_hours"] for item in items if item["status"] == "PARTIAL")
    claimed = math.fsum(item["weight_hours"] for item in items if item["status"] == "DONE")
    pending = [{key: item[key] for key in ("id", "weight_hours", "lane", "status")}
               for item in items if item["status"] in {"TODO", "PARTIAL"}]
    pending.sort(key=lambda item: -item["weight_hours"])
    return {
        "plan": plan["plan"],
        "done_pct": 100 * (math.fsum(done_weights) / total),
        "in_progress_pct": 100 * (partial / total),
        "claimed_done_pct": 100 * (claimed / total),
        "items": len(items),
        "weight_hours": total,
        "rejected_done": rejected,
        "pending": pending,
    }


def print_text(result):
    print(f"{result['plan']}: done {result['done_pct']:.1f}% | "
          f"in progress {result['in_progress_pct']:.1f}% | "
          f"claimed done {result['claimed_done_pct']:.1f}% | "
          f"items {result['items']} | weight {result['weight_hours']:g} h")
    for item in result["rejected_done"]:
        for failure in item["failures"]:
            print(f"  rejected DONE {item['id']}: {failure}")
    for item in result["pending"]:
        print(f"  {item['id']} | {item['weight_hours']:g} h | {item['lane']}")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("items_json", nargs="+", type=Path)
    parser.add_argument("--repo-root", type=Path)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    plans = []
    for source in args.items_json:
        try:
            with source.open(encoding="utf-8-sig") as stream:
                plans.append(validate(json.load(stream), source))
        except (SchemaError, OSError, ValueError) as exc:
            print(f"error: {source}: {exc}", file=sys.stderr)
            return 2
    results = [compute(plan, args.repo_root, source)
               for plan, source in zip(plans, args.items_json)]
    if args.json:
        print(json.dumps(results, indent=2, allow_nan=False))
    else:
        for result in results:
            print_text(result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
