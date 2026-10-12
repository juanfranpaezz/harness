# Harness architecture

The harness coordinates specialist agents and local checks around Claude Code. The orchestrator assigns work; agents return artifacts and evidence; an independent verifier challenges completion claims. Hooks run at client lifecycle events. A hook with “gate” in its name is not necessarily blocking. This is a source-derived overview, not a runtime certification. Start with [Install](INSTALL.md) and read [Safety](SAFETY.md) before relying on a control.

## Agents

Roles below come from each file's `name`, `model`, `description`, and `tools` frontmatter in [`.claude/agents/`](../../.claude/agents/). Definitions constrain intended work; they do not prove an agent follows the instructions.

| Agent | Purpose |
| --- | --- |
| `secretary` | Gather large inputs and return a compact digest with a cache artifact; no judgment call. |
| `investigator` | Gather sourced facts and examine recency and contrary evidence. |
| `innovator` | Generate alternatives and falsifiable hypotheses. |
| `analyzer` | Rank real alternatives, trade-offs, and conditions that change the recommendation. |
| `planner` | Freeze executable acceptance criteria in a plan. |
| `dispatch-planner` | Propose non-overlapping waves of ready items at a breakpoint when three or more are ready; the orchestrator launches each wave. |
| `coder` | Build a minimal reversible diff and provide execution evidence; does not certify it. |
| `verifier` | Independently rerun and adversarially challenge a deliverable, including plan coverage. |
| `contract-checker` | Derive checks from an explicit documented contract; abstain where it is silent. |
| `selfcert-guard` | Derive postconditions without seeing the body, then check outputs; advisory only. |
| `memory-guard` | Re-derive recorded claims from cited artifacts; report drift or inability to check. |
| `scribe` | Persist decisions, corrections, and progress into canonical records. |
| `closer` | Prepare a concrete contact package; preparation alone does not authorize sending. |
| `reversibility-reviewer` | Judge one dangerous action's recorded rationale without executing it. |
| `arm-reviewer`, `grader` | Dormant experiment roles, not installed: review an artifact and score findings against an answer key. |
| `v1-coverage-checker` | Dormant standalone role, not installed; plan coverage is folded into `verifier`. |
| `order-analyst`, `client-voice` | Dormant definitions retained on disk, not installed. |

The installer derives its roster from frontmatter: every agent file whose frontmatter lacks a DORMANT marker is copied, and only those ([payload selection](../../.claude/global-layer/sync-harness-from-source.mjs#L134), `shippedAgents`); discovery on disk and active dispatch policy differ. `order-analyst`, `client-voice`, `arm-reviewer`, `grader` and `v1-coverage-checker` are DORMANT in their frontmatter and none is in the installer roster. The active roles are the first fourteen rows above; the final three rows describe dormant definitions that remain on disk but are not installed. Frontmatter alone determines this inventory.

## Hooks and installation layers

Repository wiring lives in [settings](../../.claude/settings.json). Installed wiring is generated separately by [`WIRED` and `wireGlobal`](../../.claude/global-layer/sync-harness-from-source.mjs#L627). The global seeder copies selected hooks into eligible projects; `_global-runner.mjs` skips opted-out, excluded, source, and already-wired projects to reduce duplicate firing. These are distinct layers, not identical hook sets.

| Event / components | Current role and enforcement |
| --- | --- |
| SessionStart: session brief, deletion canary (repository); seeder (global) | Gather context, observe unexpected deletion, or seed files. Seeder writes files; it is not an action-approval gate. |
| Stop: reference, memory, decision, and personal-model coherence; discipline, communication, fake-persistence, fork-vote checks | Observe/log issues under current constants. Decision/model and fork-vote hooks are repository wiring, not the generic installed set. |
| Stop: `evidence-gate` | Observe completion claims; included in generic installed wiring, not the repository's current Stop list. |
| Stop: `_ceo-format-gate` | Records by default; blocks when `CEO_FORMAT_GATE_BLOCK` enables `BLOCK_MODE`. Repository-specific. |
| PreToolUse: `reversibility-guard` | `deny-shadow` by default: records dangerous actions, does not deny them. |
| PreToolUse: `askuserquestion-deny` | Actively denies the matched question tool. This controls interaction, not safety of other actions. |
| PostToolUse: `injection-tripwire-observe` | Observes suspicious returned text after reads/searches/shell calls; not an injection barrier. |
| UserPromptSubmit: date and correction detector | Adds time context and detects corrections; advisory. |
| Agent/lifecycle/configuration events | Verification lints, dispatch observations, lifecycle probe, configuration audit: telemetry/advice, not independent approval. |

Enforcement anchors: [reversibility mode](../../.claude/hooks/reversibility-guard.mjs#L51), [format mode](../../.claude/hooks/_ceo-format-gate.mjs#L84), [question denial](../../.claude/hooks/askuserquestion-deny.mjs#L101), [fork-vote observer](../../.claude/hooks/_fork-vote-gate.mjs), [fake-persistence observer](../../.claude/hooks/_fake-persist-gate.mjs#L44).

## Tools and verification doctrine

Local tools do narrow mechanical work: `suite_runner.py` discovers tests and separates pass, fail, broken, vacuous, and timeout results; reference/memory linters check structure; `gate_coherence.py` and `test_adequacy.py` check validation discipline; `selfcert_harness.py` applies intent-derived checks; `secret_scan.py` examines candidate content. The installer ships a selected subset and dependencies, not every repository tool ([tool selection](../../.claude/global-layer/sync-harness-from-source.mjs#L125)). Repository worker and cross-family wrappers are separate execution paths.

Use this one-page doctrine: freeze the intended result before building; reproduce defects with an executable failing case; show the repaired case passing; prove detectors can both reject bad input and accept good input. Prefer a mechanical oracle for what it can decide. Treat the builder's report as a claim, then give an independent verifier the artifacts and primary sources. Cite locations, exact commands, output, and exit status. Preserve failures, skips, and uncertainty. An absent result is not success; neither is a clean exit with zero checks. A documented intention is not evidence of runtime behavior, and an observed hook warning is not enforcement. Sources: [verifier](../../.claude/agents/verifier.md#L4), [coder](../../.claude/agents/coder.md#L4), [suite classification](../../.claude/tools/suite_runner.py).

## Meters and artifact checks

Usage meters describe observed plan usage, not money or an authorization to spend.
The cache reader below does not request a refresh. Missing, stale or invalid
readings remain UNKNOWN; do not interpret them as zero usage. The separate refresh
mode can launch the client and is not needed just to inspect a cached reading.

<!-- Implements: .claude/tools/usage_meters.py:739 -->
```text
python .claude/tools/usage_meters.py show --profile-dir "<config-dir>"
```

The agent meter summarizes recorded outcomes and tokens per accepted task. It is
a repository tool, separate from client plan meters. Supply your own meter file;
missing values remain unknown and routing advice does not itself dispatch work.

<!-- Implements: .claude/tools/agent_meter.py:215 -->
```text
python .claude/tools/agent_meter.py report --meter "<meter-jsonl>" --json
```

Verifier preflight checks artifact availability and optional SHA-256 pins before
verification. It cannot determine whether the artifact satisfies its task.

<!-- Implements: .claude/tools/verifier_preflight.py:81 -->
```text
python .claude/tools/verifier_preflight.py --artifact "<artifact-file>" --json
```

Run examples from the source checkout with Python on PATH (use your installed
Python launcher if named differently). For argument details, the three tools
above expose argparse help without running their normal work:

<!-- Implements: .claude/tools/usage_meters.py:739; .claude/tools/agent_meter.py:215; .claude/tools/verifier_preflight.py:81 -->
```text
python .claude/tools/usage_meters.py show --help
python .claude/tools/agent_meter.py --help
python .claude/tools/verifier_preflight.py --help
```
