# Review sized by risk, and verifier follow-through (standard, 2026-10-10; round 2 after verifier AMEND 84)

Why: the 2026-10-08 audit of 330 verifier reports since 09-24 (`meta/cache/_audit-verifier-track-record-2026-10-08.md`)
measured that findings are almost never wrong (0.2% refuted), but 11% of PASS verdicts missed a defect that already
existed, 18.7% of ACTIONS rows were left open or untraceable, and twice the artifact that shipped was not the one gated.
On 2026-10-10 hook batch F round 2 got PASS 85 and its apply then rolled back on an idle machine because a wall-clock
test raced. One review size for every change is the defect; these three rules fix the after-the-report half.

## 1. Size the review BEFORE dispatching the verifier

Run, with every touched path and the change type:

    py .claude/tools/review_risk_tier.py <path> [<path> ...] --change-type <edit|new|delete|send|email|apply|message|publish|deploy|push|security|...>

The tier is the highest one any path or the change type reaches. What the classifier really does (the code is
canonical; if this page and the code disagree, the code wins):
- brake: `.claude/hooks/` (also `hooks/x` relative to `.claude`, and the bare directory), `.githooks/`, any
  `settings*.json`, `.claude/global-layer/`, `.gitignore`/`.gitattributes`, reversibility markers, allow/deny lists,
  names containing secret/credential/permission/ssh, every tool a settings.json runs (hooks or statusLine, project,
  local and global) and every tool a project hook source names; change types brake/hook/settings/security/permissions.
- outward: message drafts to a person (`*/outward/*`, `MENSAJES-*`, `drafts/`, names with `draft`), deploy config
  (`.github/workflows/`, `*deploy*`, `render.yaml`, `public/`); for code only, the repo's send paths (outreach
  pipeline, names with send/submit/mailer/notify/apply-/telegram/gmail) and code whose text calls
  Telegram, SMTP, Gmail send, Slack/Discord webhooks or a submit button; change types send, email, apply, message,
  bid, reply, publish, deploy, push, post, submit. NOT everything that leaves the machine: an HTTP call to a model or
  an API is not detected by path or content; pass `--change-type send` (or `deploy`) yourself for those.
- code: other code and config; agent definitions, standards, lenses, skills and CLAUDE.md (behaviour-bearing
  text); unknown or missing extensions (never docs).
- docs: document extensions with none of the above.
`merge` is not outward (local, reversible); a send script touched by a merge still is, by its path.

Copy the printed "Minimum verifier requirements" into the dispatch TASK. The floor per tier:
- brake: Opus verifier; both-ways plants on the real wiring; every timing-sensitive test run idle AND under load (3x
  each); apply rehearsal in a scratch clone by the packaged script plus the full suite there; fresh-clone run; pin
  recheck right before the apply; the owner gates the apply.
- outward: Opus verifier on the exact final bytes; recipient and claims checked; pin recheck right before the send;
  the owner sends.
- code: one fresh verifier; new tests red on a planted defect and green on the real code; full suite against the
  baseline; listed timing-sensitive tests run idle and under load; pin recheck before merge.
- docs: no verifier unless a decision or the owner relies on it; relayed or sent text is re-classified as outward.

The timing list is a floor (touched tests and their siblings with wall-clock markers), not every racy test in the suite.

## 2. Byte-identical check right before an apply, merge or send

    py .claude/tools/verdict_pin_recheck.py --report <meta/cache/_verifier-...md> [--pin <path>@sha256:<hex16>] [--ignore-pin <hex>]

Every pin in the whole report is read (Artifact lines, tables, `Pinned:` lines, prose), with the path bare, in
backticks or in quotes; `main@<sha>` is a ref pin. Exit 0 = every pin byte-identical and nothing unread. Exit 1 =
REFUSE: a pin changed, is missing or cannot be resolved, OR a pin-shaped token could not be read (the output counts
found / read / unread / ignored). An older copy the report names on purpose is left out with `--ignore-pin <hex>`,
which prints it as IGNORED. Exit 3 = no pin-shaped token at all: the verdict does not cover what you ship; add `--pin`.

## 3. Every ACTIONS row lands in the ledger and a topic closes only when its rows are closed

    py .claude/tools/verifier_actions_ledger.py sync            # after each verifier report (first run: --since <date>)
    py .claude/tools/verifier_actions_ledger.py mark <report>#<id>|<report>#* --done --evidence "<commit / report path / command>"
    py .claude/tools/verifier_actions_ledger.py mark <report>#<id> --dropped --reason "<why>"
    py .claude/tools/verifier_actions_ledger.py snooze <report>#* --until <YYYY-MM-DD> --reason "<why it can wait>"
    py .claude/tools/verifier_actions_ledger.py check --older-than 3 --brief    # advisory line for the session brief
    py .claude/tools/verifier_actions_ledger.py close-topic <report-name substring>

No daily marking: age counts from the report date; a re-gate closes the previous report in one line
(`mark <old>#* --done --evidence <new report>`), and rows that wait on someone are snoozed (still block close-topic).
Sections are found under any ACTIONS heading (also `## 7. ACTIONS`), in tables or `- A1: ...` bullets, outside code
fences; an ACTIONS section that parses to nothing makes sync exit 1. `close-topic` exit 0 is required before a topic
is marked closed in `meta/OPEN-THREADS.md`; exit 1 (open rows, an unsynced or an unparsed report) blocks it; exit 3
means nothing matched, which vouches for nothing. All three tools are advisory and wired to nothing; making any of
them a hook is a separate, gated decision.
