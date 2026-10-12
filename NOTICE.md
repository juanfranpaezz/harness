# What this public package leaves out

This repository is a public cut of a larger private harness. The following categories were removed on purpose. Nothing here is needed to use the verifier agent.

1. Personal records: the owner's preference model, memory files, decision logs, plans, night logs, caches and any document about the owner's own projects or work.
2. Owner-communication machinery: hooks and gates that enforce one person's message style and question format, the correction detector, and their logs.
3. The two-profile machinery that synchronises a personal and a work Claude configuration on one machine, and the status line that reports per-profile usage.
4. Agents that are retired (marked DORMANT) or that only serve the owner's own workflow: the signal-capture scribe, the client-voice and order-analyst roles, and four other retired roles.
5. Tools that scan the owner's own conversation history, and test files whose fixtures describe the owner's machine or private projects.
6. Every runtime artefact: logs, JSONL ledgers, backups, reversibility markers, `__pycache__`, `node_modules` and pre-edit snapshots.
7. The owner's private terms list used by the scrubber, and the private rules file of the source repository (it was written for one person and in another language). The plugin bootstrap ships a short English rules file instead.

Machine-specific names and paths in the shipped files were replaced with generic placeholders (for example `<work-root>`, `<denylisted-root>`, `example.invalid`). Some agent and standard texts still mention project folders such as `meta/` or tools such as `review_risk_tier.py` and `report_lint.py` that are not part of this package; treat those mentions as conventions to adapt.

Identifiers such as `CEO`, `ceo-model`, `dec-NN`, `PENDING-FIXES`, `HANDOFF` and `OPEN-THREADS` are the vocabulary of the owner's own record files (the preference model, the decision log, the fix queue, the session handoff and the open-thread list). Those files are among the removed categories above. In this package `CEO` means the person the harness works for. The tools, hooks and agent texts that mention these names are inert without those files; where a tool takes the record paths as options (for example `dispatch_planner.py` with `--handoff`, `--open-threads` and `--pending-fixes`), point them at your own files.
