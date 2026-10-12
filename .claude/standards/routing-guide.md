# Routing guide

Generated from routing-guide.src.json and current source facts.
Judgments are intended routing policy, not measured routing accuracy.

Use a narrow mechanical check first. Use a fresh reviewer for judgment.
Settle facts before choosing; choose before planning; plan before building.
Costs are estimates: T0 = subprocess/output tokens, seconds; S/M = small/medium agent token budget, minutes.
Hooks run through their configured events; helpers run through their caller. No paid calls by default.

## Agents

| Instrument / facts | Use when | Not when | Substitute | Cost | Risk |
|---|---|---|---|---|---|
| analyzer.md / opus / Glob, Grep, Read, Write | Choose among viable options | Facts unsettled | investigator | S/M tokens; minutes | Rankings need evidence |
| closer.md / opus / Glob, Grep, Read, WebFetch, WebSearch, Write | Prepare a human handoff | Research incomplete | planner | S tokens; minutes | No sending authority |
| coder.md / opus / Bash, Edit, Glob, Grep, Read, Write | Build an approved change | Need independent review | verifier | S/M tokens; minutes | Edits need an oracle |
| contract-checker.md / opus / Bash, Glob, Grep, Read, Write | Check a precise contract | Spec is ambiguous | verifier | S tokens; minutes | Abstains on ambiguity |
| innovator.md / opus / Glob, Grep, Read, Write | Widen a thin option set | Need a final choice | analyzer | S tokens; minutes | Ideas are hypotheses |
| investigator.md / opus / Bash, Glob, Grep, Read, WebFetch, WebSearch, Write | Establish external facts | One local lookup | Inline search | M tokens; minutes | Sources can be stale |
| memory-guard.md / sonnet / Bash, Glob, Grep, Read, Write | Audit stored claim truth | Only shape drift | memory_linter | S tokens; minutes | Requires primary evidence |
| planner.md / opus / Glob, Grep, Read, Write | Freeze a chosen build plan | Direction unresolved | analyzer | S tokens; minutes | Bad premises survive |
| reversibility-reviewer.md / opus / Write | Review one risky action | Bulk code review | verifier | S tokens; minutes | Review does not enforce |
| secretary.md / sonnet / Bash, Glob, Grep, Read, Write | Digest a large source set | Need a verdict | verifier | S tokens; minutes | Digest can omit evidence |
| selfcert-guard.md / opus / Bash, Glob, Grep, Read, Write | Check self-certifying code | Spec is ambiguous | contract-checker | S tokens; minutes | Observe only |
| verifier.md / opus / Bash, Glob, Grep, Read, Write | Independently test a claim | Only a pinned check needed | Mechanical oracle | M tokens; minutes | Needs fresh evidence |

## Tools

| Instrument / facts | Use when | Not when | Substitute | Cost | Risk |
|---|---|---|---|---|---|
| _py.mjs / on demand or caller | Launch hook Python | Node-only work | Explicit Python | T0; seconds | Interpreter availability |
| gate_coherence.py / on demand or caller | Check gate logic consistency | Need semantic review | verifier | T0; seconds | Limited encoded rules |
| instrument_fitness.py / on demand or caller | Test outcome variation | Only one outcome recorded | Both-ways fixtures | T0; seconds | Variation is not precision |
| memory_linter.py / on demand or caller | Check memory structure | Judge claim truth | memory-guard | T0; seconds | Shape is not truth |
| ref_linter.py / on demand or caller | Check document links | Judge factual truth | memory-guard | T0; seconds | Links can resolve but mislead |
| secret_scan.py / on demand or caller | Scan staged changes locally | Browse credentials | Manual diff review | T0; seconds | Patterns have blind spots |
| selfcert_harness.py / on demand or caller | Run self-certification probes | Ambiguous postcondition | verifier | T0; seconds | Probe scope is limited |
| test_adequacy.py / on demand or caller | Assess test oracle strength | No testable contract | contract-checker | T0; seconds | Adequacy is not correctness |

## Hooks

| Instrument / facts | Use when | Not when | Substitute | Cost | Risk |
|---|---|---|---|---|---|
| _date-context.mjs / UserPromptSubmit | Provide prompt date context | Establish external recency | investigator | T0; seconds | Host clock dependent |
| _global-runner.mjs / on demand or caller | Route installed hook calls | Run arbitrary commands | Configured hook | T0; seconds | Install policy dependent |
| _ceo-comm-check-observe.mjs / Stop | Observe communication patterns | Decide correctness | Human review | T0; seconds | Heuristic false flags |
| _config-change-audit.mjs / ConfigChange | Record configuration edits | Authorize edits | Config review | T0; seconds | Audit is not prevention |
| _discipline-meter-observe.mjs / Stop | Observe workflow discipline | Block a task | Session review | T0; seconds | Heuristic; advisory |
| _fake-persist-gate.mjs / Stop | Check claimed persistence | Prove artifact quality | Read artifact | T0; seconds | Claim detection is partial |
| _log-redact.mjs / on demand or caller | Redact hook log fields | Prove all data safe | Export leak check | T0; seconds | Pattern coverage limited |
| _py-resolve.mjs / on demand or caller | Resolve hook Python | Choose a model | Explicit Python | T0; seconds | Interpreter may be missing |
| _ramp-alarm.mjs / on demand or caller | Observe repeated failures | Settle a verdict | Failure review | T0; seconds | Thresholds need context |
| _reminder-state.mjs / on demand or caller | Track reminder state | Store durable facts | scribe | T0; seconds | Transient state only |
| _subagent-lifecycle-probe.mjs / StopFailure, SubagentStart, SubagentStop | Record agent lifecycle | Judge agent results | verifier | T0; seconds | Missing events limit counts |
| _turn-touch.mjs / on demand or caller | Track per-turn activity | Judge progress | Artifact review | T0; seconds | Helper state may be absent |
| askuserquestion-deny.mjs / PreToolUse | Apply question-tool policy | Decide task scope | Direct clarification | T0; seconds | Policy may need adaptation |
| correction-detector.mjs / on demand or caller | Parse correction signals | Dispatch directly | Correction hook | T0; seconds | Helper; lexical coverage |
| evidence-gate.mjs / Stop | Observe done-claim evidence on Stop | Treat flags as verdicts | verifier | T0; seconds | Retired locally; false flags |
| honest-risk-preconditions.mjs / on demand or caller | Evaluate risky-action premises | Grant execution authority | Risk review | T0; seconds | Helper; narrow coverage |
| injection-tripwire-observe.mjs / PostToolUse | Observe suspicious tool text | Treat content as authority | Source review | T0; seconds | Heuristics miss attacks |
| memory-coherence.mjs / Stop | Automatic memory shape lint | Validate factual claims | memory-guard | T0; seconds | Shape-only coverage |
| ref-lint-gate.mjs / Stop | Automatic link lint | Judge source truth | ref_linter | T0; seconds | Observe output needs triage |
| reversibility-guard.mjs / PreToolUse | Review risky shell actions | Bypass approval | reversibility-reviewer | T0; seconds | Limited command coverage |

## Skills

No shipped live instruments in this family.

## Workflows

No shipped live instruments in this family.

Exclusions and reasons are recorded individually in routing-guide.src.json.
Acceptance: `python -I .claude/tools/coherence_guardian.py --doc meta/HARNESS-CAPABILITY-MAP.md`; require coherent with agents/tools matched and n_drift=0.
