#!/usr/bin/env python3
"""Evidence and CLI regression tests using an isolated temporary git repository."""

import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


TOOL = Path(__file__).with_name("plan_progress.py")
sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location("plan_progress", TOOL)
progress = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(progress)


class PlanProgressTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="plan-progress-")
        cls.addClassCleanup(cls.temp.cleanup)
        cls.root = Path(cls.temp.name)
        cls.repo = cls.root / "evidence repo"
        cls.repo.mkdir()
        cls.env = dict(os.environ, GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull)
        cls.git("init", "-b", "main")
        cls.git("-c", "user.name=Plan Test", "-c", "user.email=plan@example.invalid",
                "-c", "commit.gpgsign=false", "-c", f"core.hooksPath={cls.root / 'no-hooks'}",
                "commit", "--allow-empty", "-m", "first main commit")
        cls.first = cls.git("rev-parse", "HEAD").strip()
        cls.git("-c", "user.name=Plan Test", "-c", "user.email=plan@example.invalid",
                "-c", "commit.gpgsign=false", "-c", f"core.hooksPath={cls.root / 'no-hooks'}",
                "commit", "--allow-empty", "-m", "second main commit")
        cls.second = cls.git("rev-parse", "HEAD").strip()
        cls.git("checkout", "-b", "side", cls.first)
        cls.git("-c", "user.name=Plan Test", "-c", "user.email=plan@example.invalid",
                "-c", "commit.gpgsign=false", "-c", f"core.hooksPath={cls.root / 'no-hooks'}",
                "commit", "--allow-empty", "-m", "side commit")
        cls.side = cls.git("rev-parse", "HEAD").strip()
        cls.git("checkout", "main")
        (cls.root / "pass.md").write_text("# Review\n## VERDICT: PASS\n", encoding="utf-8")
        (cls.root / "amend.md").write_text(
            "# Review\n## VERDICT: AMEND\n## VERDICT: PASS\n", encoding="utf-8")
        (cls.root / "first-pass.md").write_text(
            "## VERDICT: PASS\n## VERDICT: AMEND\n", encoding="utf-8")
        (cls.root / "no-verdict.md").write_text(
            "prefix ## VERDICT: PASS\n ## VERDICT: PASS\n", encoding="utf-8")
        (cls.root / "bold-fail.md").write_text(
            "## VERDICT: **FAIL** (confidence 70)\n## VERDICT: PASS\n", encoding="utf-8")
        (cls.root / "bold-pass.md").write_text(
            "## VERDICT: **PASS** (confidence 80)\n", encoding="utf-8")
        (cls.root / "pass-with-notes.md").write_text(
            "## VERDICT: PASS-WITH-NOTES\n## VERDICT: PASS\n", encoding="utf-8")
        (cls.root / "artifact.bin").write_bytes(b"accepted artifact\x00\xff\n")
        cls.digest = hashlib.sha256(b"accepted artifact\x00\xff\n").hexdigest()

    @classmethod
    def git(cls, *args):
        result = subprocess.run(["git", "-C", str(cls.repo), *args], env=cls.env,
                                capture_output=True, text=True, check=True)
        return result.stdout

    def item(self, identifier="A", status="DONE", weight=1, evidence=None, lane="LIGHT"):
        return {"id": identifier, "title": f"Item {identifier}",
                "done_definition": "Evidence is accepted", "weight_hours": weight,
                "status": status, "evidence": evidence if evidence is not None else [],
                "depends_on": [], "lane": lane}

    def plan(self, items, name="harness"):
        return {"plan": name, "generated": "2026-10-11T00:30:00-03:00",
                "definition_of_100": "Every item meets its acceptance criterion.", "items": items}

    def write_plan(self, plan):
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", suffix=".items.json",
                                         dir=self.root, delete=False) as stream:
            json.dump(plan, stream)
            return Path(stream.name)

    def cli(self, plan, json_output=True, additional=()):
        paths = [self.write_plan(p) for p in (plan, *additional)]
        args = [sys.executable, "-I", str(TOOL), *map(str, paths), "--repo-root", str(self.root)]
        if json_output:
            args.append("--json")
        return subprocess.run(args, capture_output=True, text=True, env=self.env)

    def result(self, items):
        process = self.cli(self.plan(items))
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertEqual(process.stderr, "")
        return json.loads(process.stdout)[0]

    def assert_evidence(self, evidence, accepted, failure=None):
        result = self.result([self.item(evidence=evidence)])
        self.assertEqual(result["done_pct"], 100.0 if accepted else 0.0)
        self.assertEqual(result["claimed_done_pct"], 100.0)
        self.assertEqual(len(result["rejected_done"]), 0 if accepted else 1)
        if failure:
            self.assertIn(failure, " ".join(result["rejected_done"][0]["failures"]))

    def commit(self, sha, branch="main", repo="evidence repo"):
        return {"type": "commit", "repo": repo, "sha": sha, "branch": branch}

    def test_commit_reachable(self):
        for sha in (self.first, self.second, self.first[:7]):
            with self.subTest(sha=sha):
                self.assert_evidence([self.commit(sha)], True)

    def test_commit_unreachable(self):
        self.assert_evidence([self.commit(self.side)], False, "merge-base --is-ancestor")
        self.assert_evidence([self.commit(self.side, "side")], True)

    def test_commit_missing_and_bad_branch(self):
        self.assert_evidence([self.commit("0" * 40)], False, "cat-file -e")
        self.assert_evidence([self.commit(self.first, "missing-branch")], False, "merge-base")
        self.assert_evidence([self.commit(self.first, repo="missing-repo")], False, "cat-file")

    def test_report_default_and_explicit_accept(self):
        self.assert_evidence([{"type": "report", "path": "pass.md"}], True)
        self.assert_evidence([{"type": "report", "path": "amend.md"}], False, "AMEND")
        self.assert_evidence([{"type": "report", "path": "amend.md", "accept": ["AMEND"]}], True)
        self.assert_evidence([{"type": "report", "path": "pass.md", "accept": ["AMEND"]}], False)

    def test_report_uses_first_matching_line(self):
        self.assert_evidence([{"type": "report", "path": "first-pass.md"}], True)
        self.assert_evidence([{"type": "report", "path": "no-verdict.md"}], False, "no matching")
        self.assert_evidence([{"type": "report", "path": "missing.md"}], False, "report")

    def test_report_first_verdict_line_is_binding(self):
        self.assert_evidence([{"type": "report", "path": "bold-fail.md"}], False, "FAIL")
        self.assert_evidence([{"type": "report", "path": "bold-pass.md"}], True)
        self.assert_evidence([{"type": "report", "path": "pass-with-notes.md"}], False, "unparseable")

    def test_file_sha256_prefix(self):
        for prefix in (self.digest[:16], self.digest.upper(), self.digest[:1]):
            with self.subTest(prefix=prefix):
                self.assert_evidence([{"type": "file", "path": "artifact.bin",
                                       "sha256_prefix": prefix}], True)
        self.assert_evidence([{"type": "file", "path": "artifact.bin",
                               "sha256_prefix": "0" * 16}], False, "sha256 prefix mismatch")

    def test_file_exists(self):
        self.assert_evidence([{"type": "file", "path": "artifact.bin"}], True)
        self.assert_evidence([{"type": "file", "path": "missing.bin"}], False, "does not exist")

    def test_owner_record_contains_item_id(self):
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=self.root,
                                         suffix=".md", delete=False) as stream:
            stream.write("Owner confirmed A in chat.\n")
            record = Path(stream.name).relative_to(self.root).as_posix()
        self.assert_evidence([{"type": "owner", "note": "Owner confirmed in chat",
                               "date": "2026-10-11", "recorded_in": record}], True)

    def test_owner_record_lacks_item_id(self):
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=self.root,
                                         suffix=".md", delete=False) as stream:
            stream.write("Owner confirmed B in chat.\n")
            record = Path(stream.name).relative_to(self.root).as_posix()
        self.assert_evidence([{"type": "owner", "note": "Owner confirmed in chat",
                               "date": "2026-10-11", "recorded_in": record}],
                             False, "does not contain item id 'A'")

    def test_owner_record_missing(self):
        self.assert_evidence([{"type": "owner", "note": "Owner confirmed in chat",
                               "date": "2026-10-11", "recorded_in": "missing-owner.md"}],
                             False, "owner check failed")

    def test_owner_required_fields(self):
        evidence = {"type": "owner", "note": "Owner confirmed in chat",
                    "date": "2026-10-11", "recorded_in": "record.md"}
        for field in ("note", "date", "recorded_in"):
            with self.subTest(missing=field):
                check = dict(evidence)
                del check[field]
                process = self.cli(self.plan([self.item(evidence=[check])]))
                self.assertEqual(process.returncode, 2, process.stderr)
                self.assertIn(f"missing or invalid {field}", process.stderr)
                self.assertEqual(process.stdout, "")

    def test_owner_date_format(self):
        process = self.cli(self.plan([self.item(evidence=[{
            "type": "owner", "note": "Owner confirmed in chat",
            "date": "11/10/2026", "recorded_in": "record.md"}])]))
        self.assertEqual(process.returncode, 2, process.stderr)
        self.assertIn("date must be YYYY-MM-DD", process.stderr)
        self.assertEqual(process.stdout, "")

    def test_owner_whole_token(self):
        for text, accepted in (("Only H-47 confirmed", False),
                               ("Owner confirmed H-4 today", True),
                               ("XH-4 H-4-extra H-4x", False)):
            with self.subTest(text=text):
                with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=self.root,
                                                 suffix=".md", delete=False) as stream:
                    stream.write(text)
                    record = Path(stream.name).relative_to(self.root).as_posix()
                result = self.result([self.item("H-4", evidence=[{
                    "type": "owner", "note": "Confirmed", "date": "2026-10-11",
                    "recorded_in": record}])])
                self.assertEqual(result["done_pct"], 100.0 if accepted else 0.0)

    def test_owner_rejects_items_source(self):
        source = self.write_plan({})
        plan = self.plan([self.item(evidence=[{
            "type": "owner", "note": "Confirmed", "date": "2026-10-11",
            "recorded_in": source.relative_to(self.root).as_posix()}])])
        source.write_text(json.dumps(plan), encoding="utf-8")
        process = subprocess.run([sys.executable, "-I", str(TOOL), str(source),
                                  "--repo-root", str(self.root), "--json"],
                                 capture_output=True, text=True, env=self.env)
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertEqual(json.loads(process.stdout)[0]["done_pct"], 0.0)

    def test_owner_rejects_plan_records(self):
        for record in ("meta/cache/_plan-owner.md", "meta/cache/_plan-owner/record.md"):
            path = self.root / record
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("Owner confirmed A", encoding="utf-8")
            self.assert_evidence([{"type": "owner", "note": "Confirmed",
                                   "date": "2026-10-11", "recorded_in": record}], False)

    def test_owner_rejects_nonrelative_paths(self):
        for record in (str(self.root / "pass.md"), "/record.md", "C:\\record.md",
                       "../record.md", "nested/../record.md", "nested\\..\\record.md"):
            with self.subTest(record=record):
                process = self.cli(self.plan([self.item(evidence=[{
                    "type": "owner", "note": "Confirmed", "date": "2026-10-11",
                    "recorded_in": record}])]))
                self.assertEqual(process.returncode, 2, process.stderr)
                self.assertIn("recorded_in must be repo-relative", process.stderr)

    def test_owner_calendar_date(self):
        for value, valid in (("2026-13-45", False), ("2026-02-29", False),
                             ("2024-02-29", True)):
            with self.subTest(date=value):
                process = self.cli(self.plan([self.item(evidence=[{
                    "type": "owner", "note": "Confirmed", "date": value,
                    "recorded_in": "missing-owner.md"}])]))
                self.assertEqual(process.returncode, 0 if valid else 2, process.stderr)
                if not valid:
                    self.assertIn("date must be a valid calendar date", process.stderr)

    def test_empty_or_missing_evidence(self):
        self.assert_evidence([], False, "empty evidence")
        item = self.item()
        del item["evidence"]
        self.assertEqual(self.result([item])["done_pct"], 0)

    def test_every_evidence_check_must_pass(self):
        good = {"type": "file", "path": "artifact.bin"}
        self.assert_evidence([good, self.commit(self.first)], True)
        self.assert_evidence([good, self.commit(self.side)], False, "merge-base")

    def test_partial_and_todo_do_not_check_evidence(self):
        for status, expected in (("PARTIAL", 100), ("TODO", 0)):
            with self.subTest(status=status):
                result = self.result([self.item(status=status, evidence=[self.commit(self.side)])])
                self.assertEqual(result["done_pct"], 0)
                self.assertEqual(result["in_progress_pct"], expected)
                self.assertEqual(result["claimed_done_pct"], 0)
                self.assertEqual(result["rejected_done"], [])

    def test_hand_computed_percentages_and_order(self):
        items = [self.item("partial", "PARTIAL", 2),
                 self.item("done", "DONE", 3, [{"type": "report", "path": "pass.md"}]),
                 self.item("owner", "TODO", 5, lane="OWNER")]
        result = self.result(items)
        self.assertEqual((result["done_pct"], result["in_progress_pct"],
                          result["claimed_done_pct"]), (30.0, 20.0, 30.0))
        self.assertEqual((result["items"], result["weight_hours"]), (3, 10))
        self.assertEqual([i["id"] for i in result["pending"]], ["owner", "partial"])
        text = self.cli(self.plan(items), json_output=False)
        self.assertEqual(text.returncode, 0, text.stderr)
        self.assertEqual(text.stdout,
                         "harness: done 30.0% | in progress 20.0% | claimed done 30.0% | "
                         "items 3 | weight 10 h\n  owner | 5 h | OWNER\n  partial | 2 h | LIGHT\n")

    def test_rejected_done_stays_in_claimed_and_denominator(self):
        items = [self.item("accepted", weight=3, evidence=[self.commit(self.first)]),
                 self.item("rejected", weight=7, evidence=[self.commit(self.side)])]
        result = self.result(items)
        self.assertEqual((result["done_pct"], result["claimed_done_pct"]), (30, 100))
        text = self.cli(self.plan(items), json_output=False)
        self.assertEqual(text.returncode, 0)
        self.assertIn("rejected DONE rejected: commit", text.stdout)
        self.assertIn("merge-base --is-ancestor", text.stdout)

    def test_multiple_plans(self):
        first = self.plan([self.item(status="PARTIAL")])
        second = self.plan([self.item(evidence=[{"type": "file", "path": "artifact.bin"}])], "project")
        process = self.cli(first, additional=(second,))
        self.assertEqual(process.returncode, 0, process.stderr)
        results = json.loads(process.stdout)
        self.assertEqual([r["plan"] for r in results], ["harness", "project"])
        self.assertEqual([r["done_pct"] for r in results], [0, 100])

    def test_default_roots_and_absolute_paths(self):
        self.assertEqual(str(progress.PLAN_REPOS["harness"]), str(Path("<harness-repo>")))
        self.assertEqual(str(progress.PLAN_REPOS["project"]), str(Path("<project-repo>")))
        for name in ("harness", "project"):
            with mock.patch.dict(progress.PLAN_REPOS, {name: self.root}):
                plan = self.plan([self.item(evidence=[{"type": "file", "path": "artifact.bin"}])], name)
                self.assertEqual(progress.compute(plan)["done_pct"], 100)
                plan["items"][0]["evidence"][0]["path"] = "missing.bin"
                self.assertEqual(progress.compute(plan)["done_pct"], 0)
        self.assert_evidence([{"type": "file", "path": str(self.root / "artifact.bin")}], True)

    def test_only_expected_read_git_commands(self):
        with mock.patch.object(progress.subprocess, "run", wraps=subprocess.run) as run:
            self.assertIsNone(progress.check_evidence(self.commit(self.first), self.root))
        self.assertEqual([call.args[0] for call in run.call_args_list], [
            ["git", "-C", str(self.repo), "cat-file", "-e", f"{self.first}^{{commit}}"],
            ["git", "-C", str(self.repo), "merge-base", "--is-ancestor", self.first, "main"],
        ])
        with mock.patch.object(progress.subprocess, "run", side_effect=FileNotFoundError("git unavailable")):
            self.assertIn("git unavailable", progress.check_evidence(self.commit(self.first), self.root))

    def test_schema_errors_and_valid_control(self):
        valid = self.plan([self.item("A", "TODO"), self.item("B", "PARTIAL")])
        valid["items"][1]["depends_on"] = ["A"]
        self.assertEqual(self.cli(valid).returncode, 0)
        cases = [("id", "A", "duplicate id"), ("status", "UNKNOWN", "unknown status"),
                 ("lane", "UNKNOWN", "unknown lane"), ("depends_on", ["missing"], "missing id"),
                 ("weight_hours", 0, "positive number"), ("weight_hours", -1, "positive number"),
                 ("weight_hours", True, "positive number"), ("weight_hours", "3", "positive number"),
                 ("weight_hours", float("nan"), "positive number"),
                 ("weight_hours", float("inf"), "positive number"),
                 ("status", [], "unknown status"), ("lane", {}, "unknown lane")]
        for field, value, error in cases:
            with self.subTest(field=field, value=value):
                plan = copy.deepcopy(valid)
                plan["items"][1][field] = value
                process = self.cli(plan)
                self.assertEqual(process.returncode, 2, process.stderr)
                self.assertIn(error, process.stderr)
                self.assertEqual(process.stdout, "")
        for field in ("id", "title", "done_definition"):
            with self.subTest(missing=field):
                plan = copy.deepcopy(valid)
                del plan["items"][0][field]
                process = self.cli(plan)
                self.assertEqual(process.returncode, 2)
                self.assertIn(field, process.stderr)

    def test_malformed_evidence_and_plan(self):
        for evidence in ([{"type": "shell"}], [{"type": "file"}],
                         [{"type": "report", "path": "pass.md", "accept": "PASS"}],
                         [{"type": "file", "path": "artifact.bin", "sha256_prefix": "xyz"}],
                         [self.commit("--help")], [self.commit(self.first, "--help")], None):
            with self.subTest(evidence=evidence):
                item = self.item()
                item["evidence"] = evidence
                self.assertEqual(self.cli(self.plan([item])).returncode, 2)
        for plan in ([], {}, self.plan([]), self.plan([self.item()], "unknown")):
            with self.subTest(plan=plan):
                self.assertEqual(self.cli(plan).returncode, 2)

    def test_bad_second_plan_emits_no_partial_result(self):
        process = self.cli(self.plan([self.item(status="TODO")]), additional=({},))
        self.assertEqual(process.returncode, 2)
        self.assertEqual(process.stdout, "")

    def test_bad_json_and_missing_input(self):
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=self.root,
                                         suffix=".json", delete=False) as stream:
            stream.write("{bad json")
            bad_json = stream.name
        for path in (bad_json, str(self.root / "missing.items.json")):
            with self.subTest(path=path):
                process = subprocess.run([sys.executable, "-I", str(TOOL), path],
                                         capture_output=True, text=True)
                self.assertEqual(process.returncode, 2)
                self.assertIn("error:", process.stderr)
                self.assertEqual(process.stdout, "")


if __name__ == "__main__":
    unittest.main()
