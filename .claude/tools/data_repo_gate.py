"""Fail-closed whitelist and exact-object scanner adapter for a private data repo."""

import argparse
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile


DEFAULT_WHITELIST = frozenset({
    "personal-terms.txt", "ceo-model/**", "memory/**", "README.md", ".gitignore",
    "schema-manifest.json", "preferences.json",
})
DATA_SUFFIXES = frozenset({".txt", ".md", ".json", ".yaml", ".yml", ".csv", ".tsv"})


class Refusal(Exception):
    def __init__(self, rule, path, code=2):
        self.rule, self.path, self.code = rule, str(path), code


def report(rule, path):
    # JSON quoting prevents filenames from injecting terminal lines or controls.
    print(rule + " " + json.dumps(str(path), ensure_ascii=True))


def git(repo, *args, input_data=None):
    try:
        result = subprocess.run(
            ["git", "--no-replace-objects", "-C", str(repo), *args],
            input=input_data, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
    except OSError:
        raise Refusal("GIT-UNAVAILABLE", repo)
    if result.returncode:
        raise Refusal("GIT-ERROR", repo)
    return result.stdout


def exact_path(path):
    return (isinstance(path, str) and bool(path)
            and not any(c in path for c in "\\:*?[]\x00\r\n")
            and all(part not in ("", ".", "..") for part in path.split("/"))
            and not any(part.lower() == ".git" for part in path.split("/")))


def load_whitelist(path, default_if_missing=False):
    try:
        if default_if_missing and not path.exists() and not path.is_symlink():
            return DEFAULT_WHITELIST
        if path.is_symlink() or not path.is_file():
            raise ValueError
        data = json.loads(path.read_text(encoding="utf-8"))
        if (not isinstance(data, list) or not data
                or not all(exact_path(p) or p in ("ceo-model/**", "memory/**") for p in data)
                or len(set(data)) != len(data)):
            raise ValueError
        return set(data)
    except (OSError, ValueError, UnicodeError):
        raise Refusal("WHITELIST-INVALID", path)


def policy(path, mode, allowed):
    if path.rsplit("/", 1)[-1].lower() == ".gitmodules":
        raise Refusal("GITMODULES-FORBIDDEN", path, 1)
    if mode == "120000":
        raise Refusal("SYMLINK-FORBIDDEN", path, 1)
    if mode == "160000":
        raise Refusal("GITLINK-FORBIDDEN", path, 1)
    if mode != "100644":
        raise Refusal("NON-DATA-MODE", path, 1)
    matched = path in allowed or any(
        pattern.endswith("/**") and path.startswith(pattern[:-2]) for pattern in allowed)
    if not exact_path(path) or not matched:
        raise Refusal("PATH-NOT-WHITELISTED", path, 1)
    if path != ".gitignore" and Path(path).suffix.lower() not in DATA_SUFFIXES:
        raise Refusal("NON-DATA-PATH", path, 1)


def entries(raw, index=False):
    for record in raw.split(b"\0"):
        if not record:
            continue
        header, name = record.split(b"\t", 1)
        fields = header.decode("ascii").split()
        path = os.fsdecode(name)
        if index:
            mode, sha, stage = fields
            if stage != "0":
                raise Refusal("INDEX-UNMERGED", path)
        else:
            mode, kind, sha = fields
            if kind not in ("blob", "commit"):
                raise Refusal("OBJECT-TYPE", path)
        yield path, mode, sha


class Exports:
    """Own only a newly created directory and the files exclusively created in it."""

    def __init__(self, requested):
        self.directory = Path(requested).absolute() if requested else None
        self.files = []
        self.mapping = []

    def create(self):
        if self.directory is None:
            self.directory = Path(tempfile.mkdtemp(prefix="data-repo-gate-"))
        else:
            try:
                self.directory.mkdir(mode=0o700)
            except OSError:
                raise Refusal("STAGING-CREATE-FAILED", self.directory)

    def add(self, raw, original, suffix=".txt"):
        exported = self.directory / (str(len(self.files)) + suffix)
        try:
            with exported.open("xb") as stream:
                self.files.append(exported)
                stream.write(raw)
        except OSError:
            raise Refusal("EXPORT-FAILED", original)
        self.mapping.append((exported, original))

    def blob(self, repo, sha, original):
        self.add(git(repo, "cat-file", "blob", sha), original,
                 Path(original).suffix)

    def cleanup(self):
        if self.directory is None:
            return
        for path in self.files:
            path.unlink()
        self.directory.rmdir()


def staged(repo, allowed, exports):
    snapshot = list(entries(git(repo, "ls-files", "-s", "-z"), index=True))
    for path, mode, sha in snapshot:
        policy(path, mode, allowed)
    # diff-index handles an unborn HEAD through --cached diff's empty-tree semantics.
    changed = set(git(repo, "diff", "--cached", "--name-only", "-z",
                      "--no-renames", "--diff-filter=ACMT").split(b"\0"))
    for path, mode, sha in snapshot:
        if os.fsencode(path) in changed:
            exports.blob(repo, sha, path)
            exports.add(os.fsencode(path), path)


def resolve_commit(repo, ref):
    return git(repo, "rev-parse", "--verify", "--end-of-options",
               ref + "^{commit}").decode("ascii").strip()


def outgoing(repo, local_ref, remote_sha, allowed, exports):
    if git(repo, "rev-parse", "--is-shallow-repository").strip() != b"false":
        raise Refusal("HISTORY-INCOMPLETE", repo)
    local = resolve_commit(repo, local_ref)
    if not re.fullmatch(r"[0-9a-fA-F]{40}|[0-9a-fA-F]{64}", remote_sha):
        raise Refusal("REMOTE-SHA-INVALID", repo)
    revisions = [local]
    if set(remote_sha) != {"0"}:
        revisions.append("^" + resolve_commit(repo, remote_sha))
    commits = git(repo, "rev-list", *revisions, "--").splitlines()
    seen = set()
    for commit in commits:
        sha = commit.decode("ascii")
        snapshot = list(entries(git(repo, "ls-tree", "-r", "-z", sha)))
        for path, mode, blob in snapshot:
            policy(path, mode, allowed)
        # Commit messages, author fields, and path names can carry secrets too.
        exports.add(git(repo, "cat-file", "commit", sha), sha)
        for path, mode, blob in snapshot:
            key = (blob, Path(path).suffix)
            if key not in seen:
                exports.blob(repo, blob, path)
                seen.add(key)
            exports.add(os.fsencode(path), path)


def working_tree(repo, allowed, exports):
    def walk(directory):
        with os.scandir(directory) as children:
            for child in children:
                if directory == repo and child.name == ".git":
                    continue
                path = Path(child.path)
                relative = path.relative_to(repo).as_posix()
                info = child.stat(follow_symlinks=False)
                if child.is_symlink() or getattr(info, "st_file_attributes", 0) & 0x400:
                    raise Refusal("SYMLINK-FORBIDDEN", relative, 1)
                if stat.S_ISDIR(info.st_mode):
                    walk(path)
                else:
                    mode = "100644" if stat.S_ISREG(info.st_mode) else "000000"
                    policy(relative, mode, allowed)
                    exports.add(path.read_bytes(), relative, path.suffix)
                    exports.add(os.fsencode(relative), relative)
    # Index-only links and submodules must fail even if absent on disk.
    for path, mode, sha in entries(git(repo, "ls-files", "-s", "-z"), index=True):
        policy(path, mode, allowed)
    walk(repo)


def scan(exports, python, scanner):
    verdict = 0
    for start in range(0, len(exports.mapping), 50):
        batch = exports.mapping[start:start + 50]
        try:
            result = subprocess.run(
                [python, str(scanner), "--paths", *[str(p) for p, _ in batch]],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
        except OSError:
            raise Refusal("SCANNER-INVOKE-FAILED", scanner)
        code = result.returncode
        if code:
            rule = "SCANNER-FINDING" if code == 1 else "SCANNER-CANNOT-CHECK"
            # Batch-level attribution is conservative; scanner previews stay suppressed.
            for _, original in batch:
                report(rule, original)
            verdict = max(verdict, 1 if code == 1 else 2)
    return verdict


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--whitelist")
    common.add_argument("--scanner", default=str(Path(__file__).with_name("secret_scan.py")))
    common.add_argument("--python", default=sys.executable)
    common.add_argument("--staging-dir")
    # Accept common options both before and after the subcommand.
    for action in common._actions:
        parser._add_action(action)
    subs = parser.add_subparsers(dest="command", required=True)
    for command in ("check-tree", "check-staged", "check-outgoing"):
        sub = subs.add_parser(command)
        sub.add_argument("repo")
        if command == "check-outgoing":
            sub.add_argument("remote")  # Hook argument only: no network operation.
            sub.add_argument("local_ref")
            sub.add_argument("remote_sha")
        for option in ("whitelist", "scanner", "python", "staging-dir"):
            sub.add_argument("--" + option, default=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    exports = Exports(args.staging_dir)
    created = False
    result = 2
    try:
        repo = Path(args.repo).resolve(strict=True)
        top = Path(os.fsdecode(git(repo, "rev-parse", "--show-toplevel").rstrip(b"\r\n"))).resolve()
        if repo != top:
            raise Refusal("REPO-ROOT-REQUIRED", repo)
        allowed = load_whitelist(Path(args.whitelist) if args.whitelist
                                 else repo / "data-whitelist.json", default_if_missing=not args.whitelist)
        scanner = Path(args.scanner).absolute()
        if not scanner.is_file():
            raise Refusal("SCANNER-MISSING", scanner)
        try:
            probe = subprocess.run([args.python, "-c", "pass"],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except OSError:
            raise Refusal("PYTHON-UNAVAILABLE", args.python)
        if probe.returncode:
            raise Refusal("PYTHON-UNAVAILABLE", args.python)
        exports.create()
        created = True
        if args.command == "check-staged":
            staged(repo, allowed, exports)
        elif args.command == "check-outgoing":
            outgoing(repo, args.local_ref, args.remote_sha, allowed, exports)
        else:
            working_tree(repo, allowed, exports)
        result = scan(exports, args.python, scanner)
    except Refusal as error:
        report(error.rule, error.path)
        result = error.code
    except (OSError, ValueError, UnicodeError):
        report("CANNOT-CHECK", args.repo)
        result = 2
    finally:
        if created:
            try:
                exports.cleanup()
            except OSError:
                report("CLEANUP-FAILED", exports.directory)
                result = 2
    return result


if __name__ == "__main__":
    sys.exit(main())
