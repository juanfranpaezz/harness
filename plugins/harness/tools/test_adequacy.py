"""test_adequacy.py -- ON-DEMAND test-adequacy capability (two surviving legs).

INVOKE (on-demand, never a hook):
  py .claude/tools/test_adequacy.py --tests <test_file.py> [--tests ...] \
     [--impl <suspect_pkg_dir> --ref <intent_correct_pkg_dir> --pytest-id-env LEDGER_SUT \
      --trigger-tests t1 t2 ...]   [--json]

  - assert-density only (no reference impl available):
      py .claude/tools/test_adequacy.py --tests tests_ai/test_suite_1.py
  - full (both legs), needing an intent-correct reference to run the suite against:
      py .claude/tools/test_adequacy.py --impl sut_buggy --ref sut \
         --pytest-id-env LEDGER_SUT --tests tests_ai/test_suite_1.py [--tests ...]

What it reports, given a module + its AI-written test suite:
  (a) FIT-TO-BUGGY flags via a BODY-BLIND intent oracle (L-intent, the CEO's #1 pain):
      a test whose pinned expectation matches the SUSPECT impl's output but DISAGREES with the
      intent-correct REFERENCE has been fit to the bug. Detected BEHAVIOURALLY (run the test
      against both impls; flag pass-on-suspect AND fail-on-reference) so it is blind to the test
      body's literal expectation -- the dec-39/dec-40 back-translation lane. The flag/no-flag
      DECISION reuses .claude/tools/selfcert_harness.apply_pc (the same 0-FP negative-control +
      degeneracy discipline) rather than re-deriving it: the test, viewed as an oracle, is the
      postcondition `pc`; "known-correct output" = does the test accept the impl it was written
      against; "body output" = does it accept the intent reference. A FLAG = the test accepts the
      suspect but REJECTS intent.   (de-risk score: 6/6 P1, 0 false positives.)
  (b) VACUOUS-TEST flags via assertion density (L-assert): cheap AST count of meaningful asserts
      per test; a suite below the frozen floor (mean < 1.0 meaningful asserts/test OR > 34% of
      tests with zero meaningful asserts) is FLAGGED-VACUOUS. A meaningful assert is a bare `assert`,
      a `with pytest.raises(...)`, or a unittest `self.assert*(...)` call (added 2026-09-25: before that,
      a unittest suite read as 0 asserts, e.g. a unittest module with 32 self.assert calls,
      31 of them inside test functions; asserts in setUp/helpers are not attributed, as for bare asserts).

DROPPED on purpose: the mutation-kill-rate leg. It DROWNED on a real 129-LOC module
(equivalent-mutant noise; cosmic-ray over-generates low-value mutants) -- do not re-add it.

NOT a hook / not settings.json / not PostToolUse. On-demand only (dec-14/dec-45).
No network, no model calls; the L-intent leg runs pytest in a subprocess against the two impls.
"""
from __future__ import annotations

import argparse
import ast
import json
import os
import subprocess
import sys
from pathlib import Path

# Reuse the canonical self-cert applier (dec-39/dec-40) for the flag/no-flag decision.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from selfcert_harness import apply_pc  # noqa: E402


# ===========================================================================
# LEG (b): assertion-density (L-assert) -- cheap, AST-only, no execution.
# Frozen floor (from the de-risk PREREG): mean meaningful asserts/test >= 1.0
# AND fraction-of-tests-with-zero-meaningful-asserts <= 0.34.
# ===========================================================================
_FLOOR_MEAN_ASSERTS = 1.0
_FLOOR_FRAC_ZERO = 0.34


def _is_pytest_raises(node: ast.AST) -> bool:
    """True if `node` is a `with pytest.raises(...):` (counts as a meaningful assert)."""
    if isinstance(node, ast.With):
        for item in node.items:
            call = item.context_expr
            if isinstance(call, ast.Call):
                f = call.func
                if isinstance(f, ast.Attribute) and f.attr == "raises":
                    return True
    return False


def _weak_assert(node: ast.Assert) -> bool:
    """True if the assert is weak (bare truthiness / is-None / isinstance) -- reported, not floored."""
    t = node.test
    if isinstance(t, (ast.Name, ast.Attribute, ast.Call)):
        if isinstance(t, ast.Call):
            f = t.func
            if isinstance(f, ast.Name) and f.id == "isinstance":
                return True
            return False
        return True
    if isinstance(t, ast.Compare):
        for op, comp in zip(t.ops, t.comparators):
            if isinstance(op, (ast.Is, ast.IsNot)) and isinstance(comp, ast.Constant) and comp.value is None:
                return True
    return False


_UNITTEST_WEAK = {"assertTrue", "assertFalse", "assertIsNone", "assertIsNotNone",
                  "assertIsInstance", "assertNotIsInstance"}


def _unittest_assert(node: ast.AST) -> str | None:
    """-> the method name if `node` is a unittest `self.assert*(...)` call, else None."""
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
        f = node.func
        if isinstance(f.value, ast.Name) and f.value.id == "self" and f.attr.startswith("assert"):
            return f.attr
    return None


def assert_density(path: Path) -> dict:
    """AST-count meaningful asserts per test in a suite file; apply the frozen vacuity floor."""
    src = path.read_text(encoding="utf-8")
    tree = ast.parse(src)
    tests = []
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name.startswith("test"):
            asserts = weak = raises = 0
            for sub in ast.walk(node):
                if isinstance(sub, ast.Assert):
                    asserts += 1
                    if _weak_assert(sub):
                        weak += 1
                elif _is_pytest_raises(sub):
                    raises += 1
                elif _unittest_assert(sub):
                    asserts += 1
                    if _unittest_assert(sub) in _UNITTEST_WEAK:   # truthiness / is-None / isinstance
                        weak += 1
            meaningful = asserts + raises
            strong = (asserts - weak) + raises
            tests.append({
                "name": node.name, "asserts": asserts, "raises": raises, "weak": weak,
                "meaningful": meaningful, "strong": strong, "zero_assert": meaningful == 0,
            })
    n = len(tests)
    total_meaningful = sum(t["meaningful"] for t in tests)
    zero = sum(1 for t in tests if t["zero_assert"])
    weak_only = sum(1 for t in tests if t["strong"] == 0)
    mean_asserts = total_meaningful / n if n else 0.0
    frac_zero = zero / n if n else 1.0
    flagged_vacuous = (mean_asserts < _FLOOR_MEAN_ASSERTS) or (frac_zero > _FLOOR_FRAC_ZERO)
    return {
        "file": path.name,
        "n_tests": n,
        "total_meaningful_asserts": total_meaningful,
        "mean_asserts_per_test": round(mean_asserts, 3),
        "n_zero_assert_tests": zero,
        "frac_zero_assert": round(frac_zero, 3),
        "n_weak_only_tests": weak_only,
        "frac_weak_only": round(weak_only / n if n else 1.0, 3),
        "FLAGGED_VACUOUS": flagged_vacuous,
    }


# ===========================================================================
# LEG (a): body-blind intent oracle (L-intent) -- behavioural, reuses apply_pc.
# Run each test against the SUSPECT impl and the intent-correct REFERENCE.
# A test is FIT-TO-BUGGY iff it passes on the suspect AND fails on the reference.
# ===========================================================================
def _list_tests(path: Path) -> list[str]:
    """Return the top-level `test*` function names defined in a suite file."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    return [n.name for n in tree.body if isinstance(n, ast.FunctionDef) and n.name.startswith("test")]


def _run_one(impl_dir: str, suite_path: Path, test_name: str, id_env: str, root: Path):
    """Run ONE test against the impl at `impl_dir` (injected via env var `id_env`).

    Returns True (passed), False (failed/errored), or None (not collected / indeterminate).
    `id_env` is the env var the suite's conftest reads to choose the import path (e.g. LEDGER_SUT).
    """
    env = dict(os.environ)
    env[id_env] = str((root / impl_dir).resolve())
    rel = suite_path.relative_to(root) if suite_path.is_absolute() else suite_path
    cmd = [sys.executable, "-m", "pytest", f"{rel.as_posix()}::{test_name}",
           "-q", "-p", "no:cacheprovider", "--no-header"]
    r = subprocess.run(cmd, cwd=str(root), env=env, capture_output=True, text=True)
    out = (r.stdout + r.stderr).lower()
    if "no tests ran" in out or "not found" in out:
        return None
    if "passed" in out and "failed" not in out and "error" not in out:
        return True
    if "failed" in out or " error" in out:
        return False
    return None


def _fit_to_buggy_via_harness(passes_on_suspect, passes_on_reference) -> dict:
    """Decide fit-to-buggy for ONE test by REUSING selfcert_harness.apply_pc.

    Mapping (the test, viewed as an oracle, is the postcondition `pc`):
      - pc(inputs, verdict) := bool(verdict)            # the oracle "accepts" an impl iff the test
                                                          passes on it.
      - known_correct_output := passes_on_suspect       # negative control: the test MUST pass on the
                                                          impl it was authored against (else it is a
                                                          broken test, not fit-to-buggy -> no flag).
      - body_output          := passes_on_reference     # the intent-correct reference is the "body"
                                                          under suspicion of being rejected.
    apply_pc FLAGs iff (pc accepts known-correct) AND (pc rejects body)
            = passes_on_suspect AND NOT passes_on_reference  == fit-to-buggy.
    The harness's 0-FP negative-control + degeneracy discipline is thereby inherited unchanged.
    """
    pc = lambda _inputs, verdict: bool(verdict)  # noqa: E731 -- trivial oracle adapter
    return apply_pc(pc, (), passes_on_reference, passes_on_suspect)


def l_intent(suites, impl_dir, ref_dir, id_env, root, trigger_tests=None) -> dict:
    """Run the body-blind oracle over every test (or just `trigger_tests`) in each suite.

    Flags each test whose verdict is fit-to-buggy (pass-on-suspect AND fail-on-reference),
    using apply_pc for the decision. Returns per-suite flags + the aggregate.
    """
    per_suite = []
    flagged_total = 0
    for suite in suites:
        spath = Path(suite)
        names = _list_tests(spath)
        if trigger_tests:
            names = [n for n in names if n in set(trigger_tests)]
        flags = []
        for tname in names:
            on_suspect = _run_one(impl_dir, spath, tname, id_env, root)
            if on_suspect is None:
                continue
            on_ref = _run_one(ref_dir, spath, tname, id_env, root)
            if on_ref is None:
                continue
            verdict = _fit_to_buggy_via_harness(on_suspect, on_ref)
            if verdict["flag"]:
                flagged_total += 1
                flags.append({
                    "test": tname, "pass_on_suspect": on_suspect, "pass_on_reference": on_ref,
                    "reason": verdict["reason"],
                })
        per_suite.append({
            "suite": spath.name, "n_checked": len(names),
            "n_fit_to_buggy": len(flags), "fit_to_buggy_tests": flags,
        })
    return {
        "n_fit_to_buggy_tests_total": flagged_total,
        "any_fit_to_buggy": flagged_total > 0,
        "per_suite": per_suite,
    }


# ===========================================================================
# CLI
# ===========================================================================
def main(argv):
    ap = argparse.ArgumentParser(description="On-demand test-adequacy: L-intent + L-assert.")
    ap.add_argument("--tests", action="append", required=True,
                    help="A test suite file (repeatable).")
    ap.add_argument("--impl", help="Suspect impl pkg dir (the impl the suite was written against).")
    ap.add_argument("--ref", help="Intent-correct reference pkg dir (the body-blind oracle).")
    ap.add_argument("--pytest-id-env", default="LEDGER_SUT",
                    help="Env var the suite's conftest reads to pick the import path.")
    ap.add_argument("--root", default=None,
                    help="Working dir for pytest (default: common parent of the test files).")
    ap.add_argument("--trigger-tests", nargs="*", default=None,
                    help="Restrict L-intent to these test names (optional).")
    ap.add_argument("--json", action="store_true", help="Emit machine-readable JSON only.")
    args = ap.parse_args(argv[1:])

    report = {"L_assert_density": [assert_density(Path(t)) for t in args.tests]}
    report["L_assert_any_vacuous"] = any(d["FLAGGED_VACUOUS"] for d in report["L_assert_density"])

    if args.impl and args.ref:
        root = Path(args.root).resolve() if args.root else \
            Path(os.path.commonpath([str(Path(t).resolve()) for t in args.tests])).parent
        report["L_intent"] = l_intent(
            args.tests, args.impl, args.ref, args.pytest_id_env, root, args.trigger_tests,
        )
    else:
        report["L_intent"] = {"skipped": "no --impl/--ref pair given (assert-density only)"}

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print(json.dumps(report, indent=2))
        d = report["L_assert_density"]
        vac = [x["file"] for x in d if x["FLAGGED_VACUOUS"]]
        print("\n=== SUMMARY ===", file=sys.stderr)
        print(f"L-assert: {len(vac)}/{len(d)} suite(s) FLAGGED VACUOUS"
              + (f" -> {vac}" if vac else ""), file=sys.stderr)
        li = report["L_intent"]
        if "skipped" in li:
            print(f"L-intent: {li['skipped']}", file=sys.stderr)
        else:
            print(f"L-intent: {li['n_fit_to_buggy_tests_total']} fit-to-buggy test(s) flagged",
                  file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
