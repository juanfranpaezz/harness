# Documented command existence table

Static source lookup only; this is not evidence that installation or the complete
suites executed successfully. Each row was found using rg -n -F against the
implementation shown. Standard interpreter and shell options are supplied by
Node, Python, PowerShell or Bash, not implemented by the harness. Repeated
examples are listed once. The CI loops are shown as whole blocks in PORTABILITY.md.

| Command or CI block | Implementation |
| --- | --- |
| `node .claude/global-layer/harness-install.mjs install --profile core --dry-run --config-dir "<config-dir>" --personal-terms "<terms-file>"` | .claude/global-layer/harness-install.mjs:37 <!-- Implements: .claude/global-layer/harness-install.mjs:37 --> |
| `python .claude/tools/usage_meters.py show --profile-dir "<config-dir>"` | .claude/tools/usage_meters.py:739 <!-- Implements: .claude/tools/usage_meters.py:739 --> |
| `python .claude/tools/agent_meter.py report --meter "<meter-jsonl>" --json` | .claude/tools/agent_meter.py:215 <!-- Implements: .claude/tools/agent_meter.py:215 --> |
| `python .claude/tools/verifier_preflight.py --artifact "<artifact-file>" --json` | .claude/tools/verifier_preflight.py:81 <!-- Implements: .claude/tools/verifier_preflight.py:81 --> |
| `python .claude/tools/usage_meters.py show --help` | .claude/tools/usage_meters.py:739 <!-- Implements: .claude/tools/usage_meters.py:739 --> |
| `python .claude/tools/agent_meter.py --help` | .claude/tools/agent_meter.py:215 <!-- Implements: .claude/tools/agent_meter.py:215 --> |
| `python .claude/tools/verifier_preflight.py --help` | .claude/tools/verifier_preflight.py:81 <!-- Implements: .claude/tools/verifier_preflight.py:81 --> |
| `powershell -NoProfile -ExecutionPolicy Bypass -File .claude/global-layer/bootstrap/harness-bootstrap.ps1 -DryRun -Unattended` | .claude/global-layer/bootstrap/harness-bootstrap.ps1:23 <!-- Implements: .claude/global-layer/bootstrap/harness-bootstrap.ps1:23 --> |
| `sh .claude/global-layer/bootstrap/harness-bootstrap.sh --dry-run --unattended` | .claude/global-layer/bootstrap/harness-bootstrap.sh:19 <!-- Implements: .claude/global-layer/bootstrap/harness-bootstrap.sh:19 --> |
| `node .claude/global-layer/sync-harness-from-source.mjs --check --source "." --global "<config-dir>" --scrub --personal-terms "<terms-file>"` | .claude/global-layer/sync-harness-from-source.mjs:1146 <!-- Implements: .claude/global-layer/sync-harness-from-source.mjs:1146 --> |
| `node .claude/global-layer/sync-harness-from-source.mjs --apply --source "." --global "<config-dir>" --scrub --personal-terms "<terms-file>"` | .claude/global-layer/sync-harness-from-source.mjs:1146 <!-- Implements: .claude/global-layer/sync-harness-from-source.mjs:1146 --> |
| `node .claude/global-layer/harness-install.mjs install --config-dir "<config-dir>" --personal-terms "<terms-file>"` | .claude/global-layer/harness-install.mjs:37 <!-- Implements: .claude/global-layer/harness-install.mjs:37 --> |
| `node .claude/global-layer/harness-install.mjs install --repo "<local-source-repo>" --clone-dir "<new-source-dir>" --config-dir "<config-dir>" --personal-terms "<terms-file>"` | .claude/global-layer/harness-install.mjs:37 <!-- Implements: .claude/global-layer/harness-install.mjs:37 --> |
| `node .claude/global-layer/harness-install.mjs install --profile developer --with-hooks --config-dir "<config-dir>" --personal-terms "<terms-file>"` | .claude/global-layer/harness-install.mjs:37 <!-- Implements: .claude/global-layer/harness-install.mjs:37 --> |
| `node .claude/global-layer/harness-install.mjs doctor --config-dir "<config-dir>" --json` | .claude/global-layer/harness-install.mjs:37 <!-- Implements: .claude/global-layer/harness-install.mjs:37 --> |
| `node .claude/global-layer/harness-install.mjs update --config-dir "<config-dir>"` | .claude/global-layer/harness-install.mjs:37 <!-- Implements: .claude/global-layer/harness-install.mjs:37 --> |
| `node .claude/global-layer/sync-harness-from-source.mjs --source "." --unseed "<project-dir>"` | .claude/global-layer/sync-harness-from-source.mjs:1146 <!-- Implements: .claude/global-layer/sync-harness-from-source.mjs:1146 --> |
| `node --test .github/workflows/harness-publication.test.mjs` | .github/workflows/harness-portability.yml:49 <!-- Implements: .github/workflows/harness-portability.yml:49 --> |
| `python .claude/tools/suite_runner.py --selfcheck` | .github/workflows/harness-portability.yml:57 <!-- Implements: .github/workflows/harness-portability.yml:57 --> |
| `python .claude/tools/suite_runner_portability.test.py` | .github/workflows/harness-portability.yml:61 <!-- Implements: .github/workflows/harness-portability.yml:61 --> |
| `python .claude/tools/suite_runner_stderr_unittest.test.py` | .github/workflows/harness-portability.yml:65 <!-- Implements: .github/workflows/harness-portability.yml:65 --> |
| `node .claude/tools/python_launcher.test.mjs` | .github/workflows/harness-portability.yml:69 <!-- Implements: .github/workflows/harness-portability.yml:69 --> |
| Node directory loop (exact block in PORTABILITY.md) | .github/workflows/harness-portability.yml:74 <!-- Implements: .github/workflows/harness-portability.yml:74 --> |
| Python directory loop (exact block in PORTABILITY.md) | .github/workflows/harness-portability.yml:79 <!-- Implements: .github/workflows/harness-portability.yml:79 --> |
| `node --test .claude/global-layer/bootstrap/harness-bootstrap-windows.test.mjs` | .github/workflows/harness-portability.yml:84 <!-- Implements: .github/workflows/harness-portability.yml:84 --> |
| `node --test .claude/global-layer/bootstrap/harness-bootstrap-posix.test.mjs` | .github/workflows/harness-portability.yml:92 <!-- Implements: .github/workflows/harness-portability.yml:92 --> |
| `python .claude/tools/data_repo_gate.py check-staged "<data-repo>" --whitelist "<whitelist-json>"` | .claude/tools/data_repo_gate.py:230 <!-- Implements: .claude/tools/data_repo_gate.py:230 --> |
| `python .claude/tools/data_repo_gate.py --help` | .claude/tools/data_repo_gate.py:230 <!-- Implements: .claude/tools/data_repo_gate.py:230 --> |
