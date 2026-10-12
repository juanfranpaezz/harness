# Getting started: your first independent check in 15 minutes

This guide is for you if Claude Code is installed (the `claude` command in a terminal, or the Claude Code extension in VS Code) and you have only used it for simple chats. You do not need to install the whole harness. You will copy two files into your project and ask Claude to run one sub-agent.

Checked against Claude Code 2.1.251 on Windows (PowerShell) on 2026-10-12. The Linux and macOS commands are standard shell commands; they were not run on those systems. The section "Common problems" lists what to do if something differs on your machine.

## 1. What you get in 15 minutes

You get a `verifier`: a separate Claude helper (a sub-agent) that checks work that was done in your project and writes a report. The report starts with a verdict (PASS, FAIL, AMEND and so on), shows the commands it re-ran and their exit codes, and ends with a list of what it did not check.

Why it is separate from the agent that builds: an agent that wrote the code tends to say "done, it works" and to believe it. The verifier starts with a fresh, empty conversation. It does not see the builder's story. It re-runs your tests, tries to break the change, and treats the builder's claims as claims, not as proof. Its instructions forbid it to edit your code; it has no edit tool, and its only file write is one report. It does run shell commands (your tests, for example), which is why Claude Code asks you to approve them.

What it is not: a guarantee. It is a second pair of eyes that shows its work. Read the "Not verified" section of every report.

## 2. Before you start

### 2.1 Check that Claude Code runs

In a terminal, type:

```text
claude --version
```

Expected: one line with a version number and the words "Claude Code", for example `2.1.251 (Claude Code)`. Your number will differ; other recent versions should behave the same. If the terminal says the command is not found, install Claude Code first by following Anthropic's documentation, then come back.

If you use the VS Code extension: open the Extensions view (Ctrl+Shift+X, or Cmd+Shift+X on macOS), find "Claude Code" and check that it is enabled. You can still use a terminal inside VS Code (Terminal menu, New Terminal) for the commands in this guide.

### 2.2 Be inside a project folder

Pick a project (any folder with your code in it). If you only want to practice, make an empty folder, for example `practice-project`, and use that. In a terminal, go to that folder:

```text
cd path/to/your-project
```

Expected: your prompt now shows the project folder name. On Windows, use PowerShell for the commands in this guide (type `powershell` in a cmd window to open it). In VS Code, "the project folder" is the folder you opened with File, Open Folder. It is the folder shown at the top of the Explorer panel, and a new VS Code terminal starts there.

### 2.3 What a sub-agent is

A sub-agent is a helper that Claude Code can hand a job to. It runs in its own separate conversation, works alone, and sends back only its final answer.

You define one with a single Markdown file in a folder called `.claude/agents/`. The top of the file, between two lines of three dashes, has four fields: a `name`, a `description` (when to use it), the `tools` it may use, and the `model`. The text below is its instructions. This is the top of the verifier file:

```text
---
name: verifier
model: opus
description: Use when an agent claims completion or an engineering deliverable needs independent verification before trust or shipping. ...
tools: Read, Grep, Glob, Bash, Write
---
```

Claude Code reads these files when a session starts. After that, you can ask Claude to delegate a job to the sub-agent by name. There are two places for the files: `.claude/agents/` inside a project (that project only), and `.claude/agents/` in your home folder (every project). This guide uses the project one.

### 2.4 Where the `.claude` folder lives

It lives at the root of your project, next to your source files. Folders whose names start with a dot are hidden by default in some tools:

- VS Code: the Explorer panel shows `.claude` normally. If you do not see it, open Settings and search for `files.exclude`.
- Terminal on Linux or macOS: `ls` hides it. Use `ls -a`.
- macOS Finder: press Cmd+Shift+. to show hidden items. Linux file managers: Ctrl+H.
- Windows File Explorer: `.claude` shows as a normal folder. This guide creates it with commands, so you never have to type a dot-name in a dialog.

## 3. Step by step, no install

### 3.1 Get a copy of this repository next to your project

Put it in the folder that contains your project, not inside the project. From your project folder, go up one level first:

```text
cd ..
```

Then use ONE of these ways.

Way A, with git (any system). Copy the clone address from the green Code button on this repository's GitHub page and paste it in place of `<repo-url>`:

```text
git clone <repo-url> harness
```

Way B, ZIP, from the browser: on the GitHub page click Code, then Download ZIP, extract it next to your project, and rename the extracted folder from `harness-main` to `harness`.

Way B, ZIP, from the command line. Use the page address (without `.git`) in place of `<repo-url>`.

Windows PowerShell:

```text
Invoke-WebRequest -Uri <repo-url>/archive/refs/heads/main.zip -OutFile harness.zip
Expand-Archive harness.zip -DestinationPath .
Rename-Item harness-main harness
```

Linux or macOS:

```text
curl -L -o harness.zip <repo-url>/archive/refs/heads/main.zip
unzip harness.zip
mv harness-main harness
```

Expected: a folder called `harness` sits next to your project folder, and it contains `README.md` and a `.claude` folder (use `ls -a harness` or `dir -Force harness` to see it). Now go back into your project:

```text
cd your-project
```

### 3.2 Copy the two files into your project

Windows PowerShell, run inside your project folder:

```text
New-Item -ItemType Directory -Force .claude\agents, .claude\standards | Out-Null
Copy-Item ..\harness\.claude\agents\verifier.md .claude\agents\
Copy-Item ..\harness\.claude\standards\verifier-creation.md .claude\standards\
```

Linux, macOS, or Git Bash:

```text
mkdir -p .claude/agents .claude/standards
cp ../harness/.claude/agents/verifier.md .claude/agents/
cp ../harness/.claude/standards/verifier-creation.md .claude/standards/
```

Expected: the commands print nothing. To check, list the files.

Windows PowerShell:

```text
Get-ChildItem .claude -Recurse -File | Select-Object -ExpandProperty FullName
```

Linux, macOS, or Git Bash:

```text
find .claude -type f
```

You should see exactly two files: `verifier.md` under `agents` and `verifier-creation.md` under `standards`. If your project already had a file called `.claude/agents/verifier.md`, do not overwrite it. Rename yours first.

The first file is the sub-agent. The second holds the rules the verifier follows, including the template you will use in step 3.8.

### 3.3 Create the folder for reports

By convention the verifier writes its report under `meta/cache/`. The folder does not exist in your project yet, so create it (or choose another path and use it everywhere below).

Windows PowerShell:

```text
New-Item -ItemType Directory -Force meta\cache | Out-Null
```

Linux, macOS, or Git Bash:

```text
mkdir -p meta/cache
```

Expected: no output, and an empty `meta/cache` folder.

### 3.4 Restart Claude Code

Claude Code reads sub-agent files when a session starts, so restart it now.

- Terminal: if `claude` is running, type `/exit` and press Enter. Then start it again in the project folder with `claude`.
- VS Code: press Ctrl+Shift+P (Cmd+Shift+P on macOS), type `Reload Window`, and choose "Developer: Reload Window". Then open a new Claude conversation.

Expected: a fresh session with an empty conversation.

### 3.5 Confirm that the sub-agent loaded

The simplest check runs from an ordinary terminal, outside Claude Code. It asks Claude Code to print its own context report. It does not call the model: it showed 0 model turns and 0 cost when checked. Run it inside your project folder.

Windows PowerShell:

```text
claude -p "/context" | Select-String verifier
```

Linux or macOS:

```text
claude -p "/context" | grep verifier
```

Expected: a line like this (the number at the end will differ):

```text
| verifier | Project | 102 |
```

`Project` means Claude Code found the file in this project's `.claude/agents/`. If it says `User`, Claude Code is using a `verifier.md` from the `.claude/agents/` folder in your home directory, not the one you just copied: check that you ran the command inside the project folder, then see "Common problems". If nothing is printed, no verifier loaded; go to "Common problems".

The same report is available inside a running session: type `/context` and look at the "Custom agents" part of the output.

Two other ways to see it:

- Ask Claude: "List the sub-agents you can delegate to. Names only."
- Type `@agent-` in the message box. The sub-agents should appear as suggestions, with `agent-verifier` among them.

About the `/agents` command: in Claude Code 2.1.251, typing `/agents` no longer opens a manager. It prints a note that the wizard was removed and points to the `.claude/agents/` folders. Older versions opened a menu that listed the sub-agents. In this version, use `/context`.

### 3.6 Have a small change to check

Use a real change in your own project if you have one. If you want a practice change, create these four files inside the same project folder where you copied the verifier in step 3.2.

`src/__init__.py` and `tests/__init__.py`: empty files.

`src/invoice.py`:

```python
from decimal import Decimal, ROUND_HALF_UP


def line_total(price, qty):
    """Return price * qty rounded to 2 decimals, halves round up."""
    return (Decimal(str(price)) * qty).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
```

`tests/test_invoice.py`:

```python
import unittest
from decimal import Decimal
from src.invoice import line_total


class TestInvoice(unittest.TestCase):
    def test_half_rounds_up(self):
        self.assertEqual(line_total("0.125", 1), Decimal("0.13"))

    def test_plain(self):
        self.assertEqual(line_total("2.50", 3), Decimal("7.50"))


if __name__ == "__main__":
    unittest.main()
```

Run the tests once yourself. On Windows use `py -m unittest`; on Linux or macOS use `python3 -m unittest`:

```text
py -m unittest
```

Expected: `Ran 2 tests` and `OK`.

The story for the rest of this guide: "I changed the rounding in `invoice.py`; verify it."

### 3.7 Pin the exact version of the file

The verifier prompt names the file and a fingerprint of its current content, so the report is about that exact version. Compute the first 16 characters of the file's SHA-256 hash.

Windows PowerShell:

```text
(Get-FileHash src\invoice.py -Algorithm SHA256).Hash.Substring(0,16).ToLower()
```

Linux (macOS: use `shasum -a 256` instead of `sha256sum`):

```text
sha256sum src/invoice.py | cut -c1-16
```

Expected: 16 letters and digits, for example `c7fa3a60212b8f1a`. Yours will differ. Keep it for the next step. (If your change is committed in git, you can use the short commit id instead: `src/invoice.py@<short commit id>`.)

### 3.8 Ask Claude to dispatch the verifier

Type this in the Claude message box, as one message. Replace the 16 characters after `sha256:` with your own from step 3.7. Replace the date in the report path with today's date. Everything else stays as written, including the first line of the prompt, which is mandatory and must stay word for word.

```text
Use the verifier sub-agent to check my change to src/invoice.py. Send it exactly the prompt below, word for word, then wait for it to finish and tell me the report path and its VERDICT line.

Re-derive from the artifact and from the primary source. Do NOT use anything from the conversation that brought you here; if you know an expected result, ignore it and derive it again.
TASK: Judge whether the rounding change in src/invoice.py does what it should: line totals are rounded to 2 decimals with halves rounding up, and nothing that worked before is broken. Run the project's tests yourself (from the project root, command: py -m unittest) and try edge cases of your own.
Artifact: src/invoice.py@sha256:9c1e4b7a2d5f08e3
Claims (not evidence): the builder says line_total() now uses Decimal with ROUND_HALF_UP and that the 2 tests in tests/test_invoice.py pass. These are claims to test, not facts.
Output: write your report to exactly meta/cache/_verifier-invoice-rounding-2026-10-12.md. That path must not exist yet; run an existence check first and stop if it exists.
Report rules: first heading `## VERDICT: <TOKEN> (confidence NN)` (PASS FAIL REJECT AMEND HOLD INCONCLUSIVE CONFLICT); prove every check both ways; every absence carries a positive control and its scope; size + longest line before a text-search absence (above ~10 MB it cannot prove absence); never truncate an enumeration with head/tail; mark each number measured or RELAYED; sections "### Absence controls", "### Relayed, not re-derived", "### Not verified"; never emit a secret value; never kill a process by image name.
```

What each line of the prompt is for:

- Line 1, the fresh-context line: tells the verifier to ignore the conversation that sent it, so it is not a second pass of the builder's context.
- `TASK`: what to judge. It never says what the answer should be.
- `Artifact`: the file and its fingerprint.
- `Claims (not evidence)`: what the builder says. The verifier tests it. If you have a written report from the builder, put its path here instead.
- `Output`: the one file the verifier may write, and the rule that it must not already exist, so it never overwrites an earlier report.
- `Report rules`: the shape of the report. This line is long on purpose; copy it as it is.

If you use Linux or macOS, change `py -m unittest` in the TASK line to `python3 -m unittest`. For a different project, change the TASK, the Artifact path and the output name. The bare template with angle brackets is in `.claude/standards/verifier-creation.md`, section 2.

Expected: Claude shows a sub-agent call for `verifier` and starts waiting. Then it works for a few minutes. A run can take many tool calls (its own limit is 65).

### 3.9 Approve the permission prompts

While it works, Claude Code will ask you to allow some actions the first time, such as running a command (the tests, the file hash, an existence check) and writing the report file. This is normal. For a verifier, saying yes to reading files, running your tests, and writing the one report file is what you want. Read each command before you approve it. Say no to anything that deletes files or sends data somewhere. If you choose the "don't ask again" option, it applies to that kind of action in this project.

Expected: after your approvals, the sub-agent finishes and Claude tells you the report path.

### 3.10 Find and read the report

Show the top of the report. Windows PowerShell:

```text
Get-Content meta\cache\_verifier-invoice-rounding-2026-10-12.md -TotalCount 8
```

Linux, macOS, or Git Bash:

```text
head -n 8 meta/cache/_verifier-invoice-rounding-2026-10-12.md
```

Expected: an optional title line starting with `# `, and then, as the first heading, a line of this exact form:

```text
## VERDICT: <TOKEN> (confidence NN)
```

Open the whole file in your editor. Its shape is always the same (the words in angle brackets stand for what the verifier writes; this is the structure, not output from a real run):

```text
# <report title>
## VERDICT: <TOKEN> (confidence NN)
<a few lines of summary>
### Re-executed
<the commands it ran, their exit codes, and what failed>
### Absence controls
<every "not found / zero / never" claim, with the test that shows its search can find something>
### Relayed, not re-derived
<numbers it took from you or from files without recomputing them>
### Not verified
<everything it did not check, and why>
## ACTIONS
| id | change | owner | reversible | file:line |
```

How to read it, in this order:

1. The verdict token. PASS: the checks it ran held. FAIL: a check failed (for example a test exited with a non-zero code). AMEND: sound only after the corrections listed in the ACTIONS table; not ready to ship as it is. INCONCLUSIVE: it could not decide, for example because the code could not be built or run, and the report says what is missing. HOLD: a person should take a look. REJECT and CONFLICT are also valid tokens; this package does not define them further, so read the reasons in the report and treat both as "not ready".
2. The number after `confidence`. It is the verifier's own estimate, always below 100. It is a hint, not a measurement.
3. `### Re-executed`. Look for the test command and its exit code. Exit code 0 means success.
4. `### Not verified`. This is your to-do list: things nobody checked. Decide if any of them matter for you.
5. `## ACTIONS`. One row per fix. `owner` says who should do it (coder, orchestrator or user). `reversible` says whether the change can be undone. The line `## ACTIONS: none` means nothing to fix.

If the verdict is FAIL or AMEND: fix the problem, then ask for a new check with a new report name (for example `-2` at the end of the file name). Never reuse the old name; the verifier refuses to overwrite.

## 4. Optional: copy the tools and check a prompt

The verifier uses a few small Python tools when they are present, and one of them can check your dispatch prompt before you send it. They need Python 3.

Copy the tools. Windows PowerShell, inside your project folder:

```text
New-Item -ItemType Directory -Force .claude\tools | Out-Null
Copy-Item ..\harness\.claude\tools\* .claude\tools\
```

Linux, macOS, or Git Bash:

```text
mkdir -p .claude/tools
cp ../harness/.claude/tools/* .claude/tools/
```

Expected: about 16 files in `.claude/tools`, including `dispatch_lint.py`.

Save the prompt (the lines from "Re-derive from the artifact..." to "...never kill a process by image name.", without your first sentence about the sub-agent) as a text file, for example `meta/cache/dispatch-invoice-rounding.txt`. Then run the check.

Windows:

```text
py -I .claude\tools\dispatch_lint.py meta\cache\dispatch-invoice-rounding.txt
```

Linux or macOS:

```text
python3 -I .claude/tools/dispatch_lint.py meta/cache/dispatch-invoice-rounding.txt
```

(`-I` runs Python in isolated mode, so nothing from your environment or the current folder is loaded by accident.)

Expected, with the prompt from step 3.8: fifteen lines starting `D01` to `D15`, each ending in `PASS`, and a last line:

```text
15/15 clauses PASS
```

Exit code 0 means every mandatory clause is present. To see the exit code: `echo $?` on Linux, macOS or Git Bash; `$LASTEXITCODE` in PowerShell.

Exit code 1 means at least one clause is missing. The missing ones are marked `FAIL` with a reason. For example, if you delete the first line of the prompt, the output has:

```text
D01 FRESH_CONTEXT_LITERAL          FAIL  <- missing the literal fresh-context line ('Re-derive from the artifact ... Do NOT use anything from the conversation ...; if you know an expected result, ignore it ...')
...
14/15 clauses PASS
```

Exit code 2 means the file could not be read; check the path.

The check only looks for the presence of each clause. It does not judge whether the prompt is good, and it never blocks anything. Each run appends one line to `.claude/tools/verification_lints_runs.log`; add that file to your `.gitignore` if you use git.

Note: `verifier-creation.md` and `verifier.md` mention a few other helper scripts (`review_risk_tier.py`, `report_lint.py`, `verdict_token_adapter.py`) and a `meta/PENDING-FIXES.md` file. They are not part of this package. Skip those lines; the verifier works without them.

## 5. Common problems

The sub-agent does not appear in step 3.5.

- Restart again. Files are read at session start (step 3.4).
- Check the exact path: `.claude/agents/verifier.md` at the root of the folder you opened (step 2.4), not in a sub-folder and not in the `harness` folder.
- Check the file name. On Windows, Explorer can hide extensions and save `verifier.md.txt`. In PowerShell, `Get-ChildItem .claude\agents` shows the real names.
- Check that the first lines are still `---` and `name: verifier`. If the `name` line is missing, Claude Code skips the file without an error.
- Run `claude plugin validate .claude/agents`. If the top of the file has a formatting error, it prints the error and exits with code 1. A pass does not prove the agent loaded: a file with no `name` also passes. The real test is step 3.5.
- On Windows in Git Bash, a command that starts with `/` is rewritten by Git Bash. If `claude -p "/context"` answers with something about a strange path, run it in PowerShell, or type `MSYS_NO_PATHCONV=1 claude -p "/context"`.

Claude answers by itself instead of delegating.

- Say it explicitly: "Use the verifier sub-agent." This guide's message does.
- Or start the message with `@agent-verifier` and then your text.
- Check step 3.5 first; Claude cannot delegate to an agent that did not load.

The report path already exists.

- By design the verifier stops and tells you. Choose a new name (add `-2`), or move the old report away. To check a path first: `Test-Path <path>` in PowerShell, or `test -f <path> && echo exists || echo free` in a Unix shell.

Python is not found.

- Windows: use the `py` launcher (`py -I ...`). Do not use `python3` on Windows: it can be a Microsoft Store shortcut that does not run Python. If `py` is also missing, install Python 3 from python.org.
- Linux and macOS: use `python3 -I ...`.

Permission prompts keep appearing.

- Claude Code asks before it runs a command or writes a file. This is a safety feature, not an error. Saying yes to reading files, running your tests, and writing the one report is normal. Type `/permissions` to see and change the rules.

The model is not available on your plan.

- The verifier file says `model: opus` on line 3. Change that word to `model: inherit` to use the same model as your session, or to another model name your plan allows. Restart Claude Code afterwards.

It is slow.

- A verifier re-runs your tests and tries to break the change. Several minutes is normal for a small change. Check the report path first; do not start a second run on the same path.

## 6. Next steps

- Full install (the other agents, hooks, tools and standards): [INSTALL.md](INSTALL.md) and [docs/harness/INSTALL.md](docs/harness/INSTALL.md). Start with the dry runs the guide describes.
- The verification doctrine in 10 lines, and the template with explanations: [README.md](README.md).

The other agents, one line each. They are in `.claude/agents/` of this repository; copy a file into your project the same way as the verifier. Some of them mention files from the full install (hooks, tools, a `meta/` folder), so read the description at the top of each file first.

- `coder`: builds one approved change as a small, reversible diff, runs its checks, and reports the evidence. It never commits, never pushes, and never signs off its own work.
- `planner`: turns a chosen direction into a step-by-step plan, with the success criteria written down before anything is built.
- `analyzer`: compares two or more options from the research you already have and recommends one, with trade-offs and what would change the recommendation.
- `investigator`: finds sourced facts on the web and in files, grades them, checks how recent they are, and tries to refute them.
- `secretary`: reads big files, logs and code scans for you and returns a short digest plus a file with the full detail, to keep your main conversation small.
- `selfcert-guard`: checks code that claims its own correctness, using only the stated intent and not the code body. Advisory only.
- `contract-checker`: checks a function against what its documentation promises, clause by clause, and abstains where the documentation is silent.
- `reversibility-reviewer`: reviews the written reason for a dangerous action before it runs and returns safe or unsafe. It never runs the action.
- `memory-guard`: audits claims in your notes or memory files against the files they cite and returns MATCH, DRIFT or UNCHECKABLE.
- `dispatch-planner`: when three or more jobs are ready, plans non-overlapping waves of sub-agents (who runs when, on which model).
- `innovator`: produces several different hypotheses for a stuck problem. It never picks one.
- `closer`: when the next step is contacting a person, writes the send-ready package (named recipient, address, channel, final message, the ask). It does not send it.
