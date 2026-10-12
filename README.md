# harness

New to Claude Code? Start with [GETTING-STARTED.md](GETTING-STARTED.md).

A set of Claude Code agents, tools and rules built around one idea: **the agent that builds something never signs it off.** An independent verifier, started with a fresh context, re-derives the result from the artifact itself and returns a verdict. The verifier agent and the verification doctrine are the part worth trying first; the rest of the package (planner, coder, analyzer, investigator, guard hooks and helper tools) is built to feed it.

## The verification doctrine in 10 lines

1. The builder never approves its own work. An independent verifier re-derives the truth from the artifact, not from the builder's story.
2. Every verifier dispatch starts with the fresh-context line (see the template below). A verifier that inherits the builder's conversation is a second pass of the same context, not a check.
3. "Done" means an independent re-run met success criteria written down before the build. "It compiles", "it imports", "tests pass" or "I reviewed it" are not criteria.
4. Success criteria name the exact command and the exact observable (exit code, printed value, file, a test going red to green).
5. Every test, detector, gate or metric is shown to give BOTH outcomes on a realistic case before anyone trusts it. One that can only ever say one thing is inert.
6. An absence ("not found", "zero hits", "never ran") counts only with a positive control: the same query, same tool and flags, against a target known to match. State the scope searched.
7. A text search over a very large file (above ~10 MB, or with huge lines) cannot prove that something is missing. Measure size and longest line first.
8. Every number or conclusion returned by a sub-agent or a tool is a claim, not a verdict. Re-derive it from the raw data before acting on it.
9. Never put the expected result in the dispatch prompt.
10. Verdicts use a closed token set (PASS, FAIL, REJECT, AMEND, HOLD, INCONCLUSIVE, CONFLICT), carry a confidence strictly below 100, and list what was not verified.

## Use the verifier in any project (no install)

1. Copy `.claude/agents/verifier.md` from this repository to `<your-project>/.claude/agents/verifier.md`.
2. Copy `.claude/standards/verifier-creation.md` to `<your-project>/.claude/standards/verifier-creation.md`. It holds the dispatch contract, the template and the report contract the verifier follows.
3. Optional: copy `.claude/tools/` as well. The verifier uses `instrument_fitness.py` (is a logged field ever varying?), `gate_coherence.py` (is a safeguard actually read by the verdict?) and `secret_scan.py` when they are present. They need Python 3.
4. Restart Claude Code in the project. Ask it to dispatch the `verifier` sub-agent with a prompt built from the template below, after a build or before you merge.

Some paths inside the agent files (for example `meta/cache/` for reports) are project conventions. Change them to whatever your project uses; nothing depends on that folder existing in advance except the report you ask for.

## The dispatch template

Below is a filled example. Replace the example values (the module, ticket, commit and paths) with yours and delete nothing; the first line is mandatory, verbatim. The bare template with angle brackets is in `.claude/standards/verifier-creation.md`.

```text
Re-derive from the artifact and from the primary source. Do NOT use anything from the conversation that brought you here; if you know an expected result, ignore it and derive it again.
TASK: Judge whether the rounding change in the invoice module does what ticket 412 asks, and whether it breaks anything that worked before. Run the project's test suite yourself.
Artifact: src/billing/invoice.py@3f2a9c1e            (untracked files: <path>@sha256:<hex16> mtime <iso>)
Claims (not evidence): meta/cache/_coder-invoice-rounding-2026-10-12.md
Output: write your report to exactly meta/cache/_verifier-invoice-rounding-2026-10-12.md. That path must not exist yet; run an existence check first and stop if it exists.
Report rules: first heading `## VERDICT: <TOKEN> (confidence NN)` (PASS FAIL REJECT AMEND HOLD INCONCLUSIVE CONFLICT); prove every check both ways; every absence carries a positive control and its scope; size + longest line before a text-search absence (above ~10 MB it cannot prove absence); never truncate an enumeration with head/tail; mark each number measured or RELAYED; sections "### Absence controls", "### Relayed, not re-derived", "### Not verified"; never emit a secret value; never kill a process by image name.
```

You can check a filled prompt before sending it: `py -I .claude/tools/dispatch_lint.py <prompt-file>` (or `python3 -I` outside Windows). It flags missing mandatory clauses and is observe-only.

## Modelling an external entity

`.claude/standards/entity-reading-discipline.md` is the method for reading a real person, company, institution or market (for example a client, a competitor or a judging panel) without pretending to read minds. To use it, dispatch the `analyzer` agent with that standard named as the method to follow and your evidence packs (cited primary material about the entity: what it did and what it said, each item with source and date) as the input. Ask for two outputs: a model of what the entity wants, each objective with its evidence and a confidence below 100, and the alignment vector, a list of checkable things your proposal or deliverable must show to line up with those objectives. Whoever builds or decides next works from the alignment vector.

## What else is in the package

- `.claude/agents/`: 13 agents. `verifier`, `selfcert-guard` (flags a builder certifying itself), `contract-checker`, `reversibility-reviewer`, `memory-guard`, `coder`, `planner`, `analyzer`, `investigator`, `innovator`, `closer`, `secretary`, `dispatch-planner`.
- `.claude/hooks/`: guard and observe hooks (evidence gate, reversibility guard, injection tripwire and others), all routed through one runner with a double-fire guard.
- `.claude/tools/`: the Python and Node helper tools the agents call (dispatch lint, plan progress, dispatch planner, secret scan, instrument fitness, gate coherence and others), with one shipped tool test, `plan_progress.test.py` (the other tool tests are not part of this package).
- `.claude/standards/`: verifier creation, entity reading, review sizing by risk, the routing guide, credential isolation.
- `.claude/global-layer/`: the installer, the sync script that copies the harness into a Claude config folder, and the bootstrap scripts (prerequisites, MCP servers, editor profiles).
- `plugins/harness/`, `.claude-plugin/` and `bootstrap/`: the same agents, hooks and tools packaged as a Claude Code plugin.
- `docs/harness/`: installation, architecture, commands and safety documentation.

## Full install

Two routes, both optional; copying the verifier (above) needs neither.

- As a Claude Code plugin: `claude plugin marketplace add <path or git URL of this repository>`, then `claude plugin install harness@claude-harness --scope user`, then `node bootstrap/bootstrap.mjs` (copies the rules file, standards and review lenses into your Claude config folder and backs up anything it overwrites).
- As a full harness install with the installer: follow [INSTALL.md](INSTALL.md) and [docs/harness/INSTALL.md](docs/harness/INSTALL.md).

## Installation status

The agents and plugin layer is usable today by copying files: the verifier route above, or copying the whole `.claude/agents/`, `.claude/standards/` and `.claude/tools/` folders (the same agents and tools are under `plugins/harness/`) into your Claude config folder, needs no installer. The one-command Windows installer (`install-harness-windows.ps1`, no private data repository required) is being verified end to end this week on a second machine; until that run is done, treat it and the plugin route as a preview and start with the dry runs the guide describes. A public user needs Git, Node.js, Python 3 and the Claude Code CLI (`claude`) on PATH; the exact commands are in [INSTALL.md](INSTALL.md), and the guide it links covers versions and the manual route for Linux and macOS.

## License

Source available, not open source. Copyright (c) 2026, all rights reserved; see [LICENSE.md](LICENSE.md). What was deliberately left out of this public package is listed in [NOTICE.md](NOTICE.md).
