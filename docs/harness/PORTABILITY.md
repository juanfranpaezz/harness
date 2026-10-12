# Harness portability

The publication workflow is manual-only (workflow_dispatch), with read-only
repository permissions and no persisted checkout credentials. It selects
windows-latest, ubuntu-latest and macos-latest, Node 22 and Python 3.12.
Action references are pinned to commit hashes. Their remote availability has not
been checked in this offline task. The expanded matrix is **pending CI run**.

The .yml file uses JSON syntax, a YAML 1.2 subset, allowing a complete local
syntax parse with Node's JSON parser without an installed YAML package.

## Exact commands per operating system

Run these from the checkout root, with Node and Python already installed. The
loops require Bash (Git Bash on Windows). Each loop continues through its group
and exits 1 if any suite exits nonzero. Remaining suite groups run after a failed
step unless cancelled; failures remain job failures. No baseline tolerances,
continue-on-error, dependency installs or automatic triggers are used.
The job has a 60-minute timeout; a timeout is not a passing result.

### Publication workflow contract (All three operating systems)

<!-- Implements: .github/workflows/harness-portability.yml (step: Publication workflow contract); test entry points are the paths below. -->
```bash
node --test .github/workflows/harness-publication.test.mjs
```

### Runner selfcheck (All three operating systems)

<!-- Implements: .github/workflows/harness-portability.yml (step: Runner selfcheck); test entry points are the paths below. -->
```bash
python .claude/tools/suite_runner.py --selfcheck
```

### Python interpreter selection (All three operating systems)

<!-- Implements: .github/workflows/harness-portability.yml (step: Python interpreter selection); test entry points are the paths below. -->
```bash
python .claude/tools/suite_runner_portability.test.py
```

### Unittest result classification (All three operating systems)

<!-- Implements: .github/workflows/harness-portability.yml (step: Unittest result classification); test entry points are the paths below. -->
```bash
python .claude/tools/suite_runner_stderr_unittest.test.py
```

### Python launcher fallback (All three operating systems)

<!-- Implements: .github/workflows/harness-portability.yml (step: Python launcher fallback); test entry points are the paths below. -->
```bash
node .claude/tools/python_launcher.test.mjs
```

### Node harness, tools and hooks (All three operating systems)

<!-- Implements: .github/workflows/harness-portability.yml (step: Node harness, tools and hooks); test entry points are the paths below. -->
```bash
status=0
for suite in .claude/global-layer/*.test.mjs .claude/tools/*.test.mjs .claude/hooks/*.test.mjs; do
  node --test "$suite" || status=1
done
exit "$status"
```

### Python tools and profiles (includes data_repo_gate, verifier_preflight, agent_meter) (All three operating systems)

<!-- Implements: .github/workflows/harness-portability.yml (step: Python tools and profiles (includes data_repo_gate, verifier_preflight, agent_meter)); test entry points are the paths below. -->
```bash
status=0
for suite in .claude/tools/*.test.py .claude/global-layer/*.test.py; do
  python "$suite" || status=1
done
exit "$status"
```

### Windows prerequisite bootstrap (Windows only)

<!-- Implements: .github/workflows/harness-portability.yml (step: Windows prerequisite bootstrap); test entry points are the paths below. -->
```bash
node --test .claude/global-layer/bootstrap/harness-bootstrap-windows.test.mjs
```

### POSIX prerequisite bootstrap (Ubuntu and macOS only)

Set BOOTSTRAP_POSIX_REQUIRED=1 for this step, as CI does; missing POSIX test prerequisites must fail.

<!-- Implements: .github/workflows/harness-portability.yml (step: POSIX prerequisite bootstrap); test entry points are the paths below. -->
```bash
node --test .claude/global-layer/bootstrap/harness-bootstrap-posix.test.mjs
```

## Scope and verification limits

The Node loop includes the global-layer, tools and hooks test files. The Python
loop includes tool tests (including data_repo_gate, verifier_preflight and
agent_meter) and profile tests. Bootstrap tests live in a nested directory and
are invoked separately for the matching OS. Shell globs are nonrecursive;
historical tests under meta or archive and differently named tests are outside
this harness-directory matrix. An unmatched glob is passed to the interpreter
and fails rather than silently running zero files.

The older scripts/run-portable-suites.sh and scripts/run-portable-suites.ps1
remain four-check smoke runners; they do not reproduce the expanded matrix.
The original four checks are retained above, even though the directory loops
also cover their test files. No existing suite or baseline was weakened.

Use a disposable checkout and profile when running the complete suites: some
legacy tests depend on local transcripts, executables or hook logs. Their clean
runner behavior remains unverified, and failures must be investigated rather
than relabeled as successful. This task did not execute GitHub Actions or install
packages. Local Python execution was unavailable; the full suite and three-OS
runtime behavior are unverified. The local contract test validates structure and
rejects malformed JSON, automatic triggers, missing OSes, unpinned actions and
hidden failures; it does not certify the harness suites themselves.

## Acceptance test location

AC6.1 names `.claude/global-layer/ci-matrix-publication-suites.test.mjs`. This task retains `.github/workflows/harness-publication.test.mjs` because its authorized edit scope excludes the planned destination; the workflow and command catalog already invoke the retained path. This is a documented path deviation, not a claim that the planned file exists. The contract rejects job- and step-level failure suppression, swallowed loop failures, early exits and missing command files. Hosted execution remains pending.
