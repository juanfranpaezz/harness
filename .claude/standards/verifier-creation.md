# Verifier-creation standard (portable; load ON DEMAND)

Load this file when you are about to write (a) a NEW verification agent or role, (b) a NEW verifier dispatch
prompt or dispatch template, or (c) a NEW detector, gate, linter or hook. It is not always-loaded text and
must not become so. Written 2026-09-24 from the owner's direction (dec-168: harden the corpus that CREATES
verifiers so this week's failures cannot recur) and the analyzer spec
`meta/cache/_analyzer-verifier-creation-corpus-standard-2026-09-24.md` (option O2).

Everything below is an instruction for the AUTHOR. The mechanical legs (section 7) only make an omission
VISIBLE; they block nothing. Observe-only until a leg meets the dec-05 bar (false-positive rate <= ~5 %,
measured on real input, both outcomes demonstrated).

## 1. A verification role is done when (one line each)

- C1 Fresh context is an INSTRUCTION in the definition: ignore any inherited conversation and any expected result.
- C2 It re-derives from the artifact and the primary source, never from a narration of them.
- C3 Every absence it asserts carries a positive control (same query, same flags, same scope, a known hit) and a declared scope.
- C4 Before a text-search absence on a file it measures size and longest line; above ~10 MB or with huge lines a text search cannot prove absence.
- C5 No head/tail/limit truncation on an enumeration that backs a count or an absence.
- C6 It proves its own method both ways (one run that fires, one that does not) on realistic input.
- C7 Every claim carries a confidence strictly under 100.
- C8 ONE verdict line, the first heading after an optional `# ` title, adapter-parseable (section 3, R01).
- C9 A "Not verified" section with content.
- C10 Second-hand numbers are marked RELAYED.
- C11 One output file at a semantic path that did not exist before the dispatch.
- C12 `tools:` match the promise: Write if it writes its report; Bash if re-execution is the job; none where blindness is the property. Proven by one real dispatch that writes its named file (S49).
- C13 No self-certification: it never judges work it built.
- C14 It never edits the artifact under test.
- C15 It never kills a process by image name.
- C16 An owner-readable label in plain language; a closing line the orchestrator can relay without pasting.
- C17 Recorded decisions and ledgers are CLAIMS to a verifier, not settled premises (dec-145).

## 2. Dispatch contract (what every verifier prompt must carry)

Checked by `dispatch_lint.py` (clause ids in brackets). Each clause check is a regex heuristic on PRESENCE, not a
precise detector: on 5 hand-checked dispatches the 2026-09-25 gate found 5 of 75 clause verdicts wrong, and D02 read
7 of 7 real pins as missing. D02, D04, D07, D08, D11, D13, D14 and D15 were narrowed after that; their precision on
real prompts has NOT been re-measured since. Whether the verifier obeys is a different question the linter cannot answer.
What the linter actually checks is stated per clause ("checked:"); anything else in a clause is author guidance only.

- [D01] The fresh-context line, literally, first: *"Re-derive from the artifact and from the primary source. Do
  NOT use anything from the conversation that brought you here; if you know an expected result, ignore it and
  derive it again."* (Spanish form: "Re-derivá desde el artefacto ... NO uses nada de la conversación ... si conocés
  el resultado esperado ..."). Checked: all three fragments present anywhere AND fragment 1 ("Re-derive from the
  artifact") opens the first non-blank line. Limit: only fragment 1's position is checked, so a split literal
  (fragment 1 on line 1, fragments 2-3 at the end) passes.
- [D02] The artifact PINNED: `Artifact: <path>@<git sha>` for tracked content, or `<path>@sha256:<first 16+ hex>`
  (plus mtime) for untracked or dirty files; the path may sit in backticks or quotes (`` `path`@sha256:<hex> ``,
  `` `path` (note)@<sha> ``), optionally followed by ` mtime <iso>` or ` (...)`. "HEAD e9cbcd7 with uncommitted work
  on top" is NOT a pin: the sha does not identify the content under review (six such prompts on 2026-09-24, zero real
  pins in 28). Checked: at least one pin in one of those shapes. NOT checked: that a git pin is not used on a dirty
  file, and that the mtime is present. Length rule for a bare `path@<hex>` (no `sha256:`): 7-12 hex or exactly 40 =
  a git commit; 16-39 or 64 hex = a CONTENT pin (sha256 prefix, the house `path@hex16` style); other lengths are not
  pins. A git abbreviation longer than 12 hex would be misread as content (not house practice). `name@hex.tld`
  (an e-mail) is not a pin. Path rule (round 5): a QUOTED path (backticks or quotes) may be a bare word, so
  `` `Makefile`@abc1234 `` and `` `x`@abc1234 `` are pins; an UNQUOTED token must contain `.`, `/` or `\` to count,
  so prose such as master@6ab1906 or word@abc1234 is not a pin. The SAME rule governs the sha256 form (round 6): an
  unquoted Docker digest such as ubuntu@sha256:<hex>, or Makefile@sha256:<hex>, is not a pin, while
  `` `Makefile`@sha256:<hex> `` and meta/x.md@sha256:<hex> are. An image reference that holds a `/` or `.`
  (docker.io/library/ubuntu@sha256:<hex>) still reads as a pin. R11's closure line uses the same pin reader.
- [D03] `Claims (not evidence): <builder's report path>` -- the builder's account is a list of claims to test.
  Checked: the phrase "claim(s) (not evidence)" or "afirmaciones (no evidencia)"; the path after it is not checked.
- [D04] ONE output path, semantically named after what it contains (never part1/output/notes/temp). Checked: at least
  one semantic path ending in .md, .jsonl, .json, .csv or .txt, written AFTER an output keyword (output, write,
  writes, written, save, saved) on the same line, or, when that line names no path, on the next non-blank line
  within 2 lines if that line opens with a path ("Output:" then the path). A path before the keyword, or with
  another extension (.log), does not count; the count of paths is NOT checked.
- [D05] "That path must not exist yet; run an existence check first and stop if it exists." (9 silent overwrites
  across 18 shared paths were measured 2026-08-29.) Checked: "must not (already) exist", "does not exist yet",
  "not exist before", "existence check" or "no debe existir".
- [D06] The report's first heading (after an optional `# ` title) is `## VERDICT: <TOKEN> (confidence NN)`, TOKEN in
  PASS, FAIL, REJECT, AMEND, HOLD, INCONCLUSIVE, CONFLICT; confidence under 100. Checked in the PROMPT: only that
  `## VERDICT:` and the word confidence appear. The token list and the < 100 are checked on the REPORT (R01, R02).
- [D07] Both ways: any check the verifier writes is shown firing and not firing ("both ways", "fires / does not",
  "named positive ... named negative", "red-then-green" all count).
- [D08] Positive control on every absence, with its declared scope. Checked: "scope" within ~200 characters of
  "positive control" (a "scope" elsewhere in another sense does not count).
- [D09] Big-file rule: size + longest line before any text-search absence. Checked: "10 MB", "longest line",
  "large file", "big file", "archivo grande" or "linea mas larga".
- [D10] No head/tail truncation of an enumeration that backs a count. Checked: "truncat...", "head/tail",
  "head or tail" or "head_limit".
- [D11] Mark each number measured vs RELAYED. Checked: "relayed" / "second-hand" within ~120 characters of number /
  figure / count / measured, on the same line ("relayed to the owner" alone does not count; the two words more
  than 120 characters apart on one line do not count either). Also accepted: "de segunda mano", "no re-derivado";
  metric(s), cifra(s), numero(s), medido.
- [D12] End with a "Not verified" section. Checked: "not verified", "did not verify", "unverified" or
  "no verifiqu..." anywhere; that it is a closing section is not checked.
- [D13] Never print, log or paste a secret value. Checked: a negation + a disclosure verb (print, emit, log, paste,
  echo, reveal, expose, leak; Spanish verbs by stem: imprim-, pegu- / pegar, logue-, devuelv- / devolv-, mostr-, so
  "No pegar", "No devolver", "no pegues", "no devuelvas" all count) + secret / credential / password /
  api key / token / secreto / credencial / contrasena, or "secret value" / "valor de un secreto" ("no token
  budget" does not count).
- [D14] Never kill a process by image name. Checked: a kill ban that names image name, "by name" / "by its name", /IM,
  -Name, nombre, pkill or killall
  ("do not kill the dev server" does not count).
- [D15] The expected result is NEVER in the prompt; numbers in the prompt are claims, not targets. Checked (FAIL
  on a hit): "expected result / verdict / outcome / answer is|was|:|=" unless followed by never/not, "the answer
  is", "should come back / return PASS|ACCEPT|green", "resultado esperado es|:". A target given as a bare number
  is not detected.
- The dispatch `description` is a short plain-language label (it is the only prompt text the registry copies).

Before filling it, size the review: `py .claude/tools/review_risk_tier.py <touched paths> --change-type <type>` and copy its minimum requirements into TASK (rule: `.claude/standards/review-sizing-by-risk.md`).

Template (copy, fill the angle brackets, delete nothing):

```
Re-derive from the artifact and from the primary source. Do NOT use anything from the conversation that brought you here; if you know an expected result, ignore it and derive it again.
TASK: <what to judge, one paragraph, no expected verdict>
Artifact: <path>@<sha>            (untracked: <path>@sha256:<hex16> mtime <iso>)
Claims (not evidence): <builder report path>
Output: write your report to exactly <meta/cache/_verifier-<what>-<date>.md>. That path must not exist yet; run an existence check first and stop if it exists.
Report rules: first heading `## VERDICT: <TOKEN> (confidence NN)` (PASS FAIL REJECT AMEND HOLD INCONCLUSIVE CONFLICT); prove every check both ways; every absence carries a positive control and its scope; size + longest line before a text-search absence (above ~10 MB it cannot prove absence); never truncate an enumeration with head/tail; mark each number measured or RELAYED; sections "### Absence controls", "### Relayed, not re-derived", "### Not verified"; never emit a secret value; never kill a process by image name.
```

## 3. Report contract (how a verifier report is judged)

Checked by `report_lint.py` (rule ids in brackets):

Verdict tokens (exactly the set verdict_token_adapter.CANONICAL_TOKENS parses): PASS FAIL REJECT AMEND HOLD INCONCLUSIVE CONFLICT.
(All three places agree on the adapter's 7 tokens: this line, the template and D06 here, and line 239 of BOTH
`.claude/agents/verifier.md` and `~/.claude/agents/verifier.md`. Two passing tests in `report_lint.test.py` assert it:
`test_verdict_token_sets_agree` and `test_verifier_md_token_line_agrees_with_adapter`.)

- [R01] The first markdown heading after at most ONE `# ` report title is the canonical verdict line. This matches
  `.claude/agents/verifier.md` ("The FIRST heading after the report title is exactly `## VERDICT: ...`"), which live
  verifiers follow (2 of the 3 real reports sampled by the 2026-09-25 gate). Any other heading above it (a `##`
  section, a second title) breaks the rule. Chosen over "no title at all" because the agent contract is the source
  verifiers are dispatched with, and the adapter reads the canonical line either way.
- [R02] A confidence under 100.
- [R03] Every absence PHRASE ("not found", "0 hits", "does not exist", "never ran / fired / called ...", not a bare
  "never" or "none") has a control in the SAME paragraph AND within 8 lines of it (`--window`, default 8; a longer
  hard-wrapped paragraph does not count past line 8) ("positive control", "the same grep found N"), or its
  control is filed in `### Absence controls` (the section carries a control and repeats an anchor of the line: a code
  span, a path or a long word). Not read: double-quoted and curly-quoted text, code spans, single-quoted text when
  the quotes stand alone ('not found'; an apostrophe inside a word, as in builder's or isn't, is not a quote),
  ACTIONS rows, and the Absence controls, Not verified and ACTIONS sections. Measured 2026-09-25 on 30
  reports of 2026-09-24: 14 flags, about 6 true by the letter, about 6 false, 2 not judged; the re-gate's random
  sample of 10 flags over 35 reports found 6 true, so precision is about 60 %, far below dec-05: R03 stays
  observe-only and must not count toward any retire or promote decision until re-measured.
  An absence about live machinery also carries a date and time and expires within hours (CLAUDE.md); not checked.
- [R04] `### Not verified` exists and is not empty.
- [R05] A number next to a citation of another agent's report is marked re-derived / measured / RELAYED.
- [R07] `verdict_token_adapter.py` reads the verdict from the canonical line (no second verdict-ish line; no
  `Verdict: **AMEND.**` shapes).
- [R08] `verification_independence.py` finds no un-declared reliance on a derived account.
- [R09] `### Absence controls` and `### Relayed, not re-derived` exist with content ("nothing relayed; every number
  measured in this run" is content). A heading, a bold label, or a plain "Absence controls." paragraph label opens
  the section.
- [R10] At least one evidence line (round 6): a fenced block whose FIRST content line is a command (starts with `$`,
  py, python, node, git, mvn, or a path), or an inline `command` (a known program such as py / git / grep, or text
  with arguments) followed on the same line by "exit N" / "EXIT=N" / "returned N" or a count ("N hits / rows /
  matches / lines / tests / files / results"). Prose that only says "exit 2", a fence holding only prose, and a
  bare file name in backticks do not count.
- [R11] AMEND must name what closes it: an ACTIONS table with an `owner` column and at least one `| A<n> |` row
  (verifier.md's mandatory closing block), or ONE closure line carrying a closure cue (re-gate or regate in any tense;
  close or closes + when / after / once / on, so "closes on" counts; to close), who re-verifies (verifier, reviewer, orchestrator, owner, coder) and the artifact@sha. An incidental "I
  re-verified the pin `x`@sha256:... before starting" does not close it. Checked only when the canonical line says
  AMEND; whether the named owner is the right one is not checked. Residual looseness: a line that only tells history
  ("the previous verifier re-gated `x`@sha on 09-24") has a cue, a who and a pin, so it also closes an AMEND.
  AMEND was the most common verdict on 2026-09-24
  (10 of the 28 verifier reports in the derived registry, 23 of them classifiable) and nothing recorded its closure.
- R06 is RETIRED (2026-09-25): the tool had a rule "exactly one Output: label in the report" that this standard never
  stated; it fired on 3 of 3 real reports. The id is not reused.
- Not checked by any rule: that a number is actually re-derived (R05 sees only a number next to a cited report),
  and report quality in general. R05 and R08 also fire on line numbers and on source-audit lists (gate 2026-09-25).
- A NULL-VERIFIER report (canonical PASS line, empty sections, no evidence) must fail R04+R09+R10; if a new
  report linter passes it, the linter is broken.

## 4. Detector admission (how a new detector / gate / hook is born)

Checked by `detector_birth_check.py` (B1-B4, static presence checks):

- [B1] A planted-defect fixture AND a clean twin in the repo, in `fixtures/<stem>/` (file names say planted / clean;
  two DISTINCT files, one name carrying both words is not a pair), so a reviewer can open them. Fixtures built only
  inside a test's tmp dir do not count. A committed clean twin must itself be born clean where it sits (its own
  `fixtures/<stem>/` pair and `<stem>.test.py` beside it), so `detector_birth_check.py <clean twin>` exits 0 and
  `<planted twin>` exits 1 standalone. Known looseness: any `fixtures/*` folder whose name CONTAINS the stem is
  accepted, so a short stem can borrow a sibling's fixtures.
- [B2] A test that runs both and asserts both outcomes; red at base, green after.
- [B3] "Never looked" is a DISTINCT status from "looked, found nothing": an unreadable input, a timeout, a missing
  path, a walker that parsed 0 items while raw input holds some (SILENT_ZERO) all exit 2 / print NEVER_LOOKED,
  never exit 0 (S55: `secret_scan.py` exited 0 on a path that does not exist; ref-lint 9.3 % timeouts read as clean).
- [B4] Proof of run: each invocation appends one row to a log. A hook is called WIRED only after one real log row
  exists after registration (S57: a malformed Stop entry never ran; found by accident).
- Before trusting its precision, check the detector's evidence criteria against the house output rules (S50: the
  evidence-gate demanded shapes the house rules forbid, 33/33 false positives).
- Observe-only until measured precision meets dec-05. Never promote to blocking on an unmeasured heuristic.
- A PASS from B1-B4 says only that the parts are NAMED: two fixture file names, a test file that mentions both
  outcomes, a status literal or `return 2`, a log/append literal. It does not prove the fixtures hold real cases,
  that the test runs, or that the status or the log row is reachable: the 2026-09-25 gate built a hollow detector
  (unused "ERROR" and ".log" literals, two empty fixtures, a one-comment test) that scored B1-B4 PASS and still exited
  0 on a missing input. Only running the detector both ways proves the parts work, and even that never proves it
  precise.

## 5. Named tool traps (each produced a silent zero or a false count)

- Multi-directory brace globs in a grep tool (`{agents/*.md,hooks/*.mjs}`) return ZERO silently; measured twice on
  2026-09-24 by two agents. Scope by path, one directory per query, and run the positive control on that scope.
- head / tail / limit / head_limit on an enumeration that backs a count or an absence (S47).
- Text search over a file above ~10 MB or with very long lines: the same reader returned 3,018 hits for one term
  and a false zero for another in the same 160 MB log (dec-144, figures corrected in dec-145).
- A positive control validates the QUERY, not the SCOPE: ask where else the thing could live (imported, called by
  another file, another name, another branch, another repo) before writing "not wired".

## 6. Shared-state rules

- Commit path-scoped; never `git add -u` while another actor may commit (commit races swept staged files).
- No untrack-then-rebase on a live folder (it deleted one).
- Never kill by image name (`taskkill /F /IM python.exe` killed three processes, two possibly other agents').
- One output path per agent that did not exist before its first write; check existence before writing.

## 7. Mechanical legs and their retire condition

- `dispatch_lint.py` (one prompt, or `--transcript` over a session), `report_lint.py` (one or many reports),
  `detector_birth_check.py` (a script), `attestation_registry.py` (DERIVED registry from transcripts: pin, report,
  hashes at pin and at registry run, supersedes, and a build-to-verifier view). All observe-only, all exit 2 on
  NEVER_LOOKED (for the registry this includes a readable file with no JSON object line, and, since round 6, any
  missing or unreadable transcript path even when another one was read: it is named and nothing is written), all
  log a proof-of-run
  row (an argparse usage error exits 2 WITHOUT a row).
- Scope: `dispatch_lint.py --transcript` and the registry count only 8 named verification roles (verifier,
  contract-checker, grader, memory-guard, reversibility-reviewer, selfcert-guard, v1-coverage-checker, arm-reviewer);
  a verification task dispatched as general-purpose is invisible to them unless the run passes `--all-roles`
  (both tools have it; it lints / registers every Agent call whatever its role). The builds view counts only `coder`
  dispatches and links a later verifier only when it is one of the 8 named roles, EVEN under --all-roles (a later
  coder prompt naming earlier notes is not a verification), and only when its prompt names the coder's notes file
  BY BASENAME, so "never
  verified" is an upper bound (verification by glob, by description, or in a transcript not passed in is missed).
- Registry hashes (round 2): only the FIRST pin of a prompt is registered, meaning the textually first one
  (`extract_pins` returns pins in text order, whatever their form). A relative pin is located in the repo the
  prompt names (the one named root holding the path; with several, the one that is not the session cwd's root); a
  prompt that names no absolute path uses the transcript's `cwd` root; anything else is UNRESOLVED, never the harness
  repo by default. `artifact_moved` reads MATCH / MOVED / UNRESOLVED / MISSING / n-a, and `supersedes` links only
  the same LOCATED file. A located DIRECTORY pinned at a git sha or at sha256 has no content hash to
  compare: `artifact_moved` reads UNRESOLVED and `pin_resolves` says "directory: no content hash to compare" (round
  4; before, `git show <sha>:<dir>` hashed a tree listing and the directory read MISSING). An UNPINNED directory
  reads n-a, like any unpinned artifact (round 5). A sha256 pin
  matches the raw bytes or the LF-normalised bytes. B1 accepts synonym file-name vocabularies (missing, compliant,
  good, ...), as the tool's docstring lists.
- Retire condition (analyzer 3.4 flip-fact): if the FULLY-COMPLIANT rate (share of verification dispatches with
  every clause PASS in `dispatch_lint.py --transcript`, not the mean clause pass rate) is already >= 95 % and the
  report linter finds < 3 true violations (judged by hand) in 30 reports, the mechanical legs do not pay: retire them
  and keep this document.
- Not to build: a detector of done-claims in owner-facing prose or a join from prose to attestation; a blocking leg
  before dec-05; an LLM judge of report quality; a new verification role; a hand-kept registry; new always-loaded text.

## 8. Failure catalogue, 2026-09-17..24 (worked examples)

Figures below are as recorded in the cited rows; this document relays them and did not re-derive them.

**F1 False absence.** Six in two days, three by the orchestrator (PENDING S47; dec-142/144/145). Four absences at
confidence 88-97 were refuted by one measurement each; a control that matched the query but not the scope called
a live control "not wired"; a 160 MB log read as empty. The standard answer is C3/C4/C5 and D08-D10.

**F2 Detector never proven both ways.** The evidence-gate flagged 33 of 33 sampled rows falsely (S50); the key v3
failed both of its bars (62.5 % vs 90; 45.5 % vs 80) and was amended post hoc; ref-lint timed out on 9.3 % of runs
and read as clean; `secret_scan.py` exited 0 on a missing path (S55). Section 4.

**F3 Verifier without the tool its job needs.** Eight verification agents lacked Write, so they could not write
the report they were asked for (S49). C12.

**F4 Unparseable verdict.** The adapter read a blocking report as ACCEPT (HANDOFF-2026-09-23-0155 :267-268); a
`Verdict: **AMEND.**` line on 2026-09-24 was not the canonical shape. D06, R01, R07.

**F5 Second-hand number relayed as measured.** 1,034 motivating alarms did not reproduce (HANDOFF :279); wrong
figures reached the canonical decisions record (dec-145). C10, D11, R05.

**F6 Dispatch without the fresh-context line.** A reviewer that sees the original context scores 23.8 % vs 28.6 %
fresh (CLAUDE.md measurement). D01; baseline 2026-09-24: the line was present in 79 % of 28 verifier dispatches.

**F7 Done-claim without in-turn attestation.** The key v3 found 11/303 and 20/615 attested done-claims ("fewer than
1 in 20"); object identity was never recorded at dispatch. D02 and the registry. Baseline 2026-09-24: 0 of 28
verifier dispatches pinned an artifact; 19 of 34 coder builds had no later verifier naming their notes.

**F8 Hook registered but never ran.** A malformed Stop entry produced ENOENT on every run and nobody knew (S57). B4.

**F9 Hand-back text reaching the owner.** Subagent hand-backs surfaced raw in the owner's view (S56). C16.

**F10 The builder's fixture was wrong while the rule was right.** Java round 1 to 2 (brief). Fixtures are claims
too: the verifier re-derives the expected outcome, it does not inherit the builder's fixture as the oracle.

**F11 Shared-state destruction.** Commit races, untrack-then-rebase, `taskkill /IM`, 9 silent overwrites (HANDOFF
:297-303; memory git-commit-races-with-coders). Section 6.
