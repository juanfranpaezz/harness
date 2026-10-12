# Install the harness

This harness adds agent definitions, local checks, and lifecycle hooks to Claude Code. Read [Architecture](ARCHITECTURE.md) for the parts and [Safety](SAFETY.md) for their limits. These instructions describe the merged installer and prerequisite bootstrap code. Installation, update, uninstall, and platform compatibility are **unverified** at runtime in this documentation task.

## Requirements

Use a local checkout containing `.claude/HARNESS-SOURCE`. Keep the source checkout and the destination configuration directory separate: neither may contain the other. The installer refuses overlapping directories ([installer source](../../.claude/global-layer/harness-install.mjs#L103)). Replace every `<placeholder>` below before running a command.

| Platform | Requirements and limits |
| --- | --- |
| Windows | Node.js and Git on PATH; Python 3 reachable through `py`, `python3`, or `python` for the installer's Python preflight; Claude Code to use the installed harness. Run the commands from the checkout in PowerShell, cmd, or Git Bash. The installed date hook also needs a shell with `printf` and `date`; PowerShell alone does not establish that requirement. Runtime compatibility is **unverified**. |
| Linux | Node.js, Git, Python 3, Claude Code, and a shell with `printf` and `date`. Hook launching and installer preflight try `py`, `python3`, then `python`. The Python leg is **unverified** if the preflight cannot obtain a valid response. |
| macOS | The same requirements and Python-preflight behavior as Linux. Runtime compatibility is **unverified**. |

The prerequisite bootstrap requires Node 22 or newer and Python 3.10 or newer; `prereqs-windows.tsv` specifies `any` for Git and Claude Code (no numeric minimum); the publication matrix selects Node 22 and Python 3.12. A configured matrix is not a completed compatibility test. Its JavaScript preflight uses Node's `--experimental-vm-modules`. Sources: [offline preflight](../../.claude/global-layer/sync-harness-from-source.mjs#L472), [Python launcher](../../.claude/tools/_py.mjs#L12), [hook wiring](../../.claude/global-layer/sync-harness-from-source.mjs#L627). No package-manager install command is required by these installer paths.

## Prerequisites on a new machine

Obtain a source checkout first. The prerequisite scripts probe Git, Node, Python,
Claude Code, GitHub CLI, and optional Codex/editor components. Start with a dry run.
They are separate from the plugin-export helper named bootstrap.mjs, which copies
rules, standards and lenses and does not wire settings.

<!-- Implements: .claude/global-layer/bootstrap/harness-bootstrap.ps1:23 -->
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .claude/global-layer/bootstrap/harness-bootstrap.ps1 -DryRun -Unattended
```

<!-- Implements: .claude/global-layer/bootstrap/harness-bootstrap.sh:19 -->
```sh
sh .claude/global-layer/bootstrap/harness-bootstrap.sh --dry-run --unattended
```

The POSIX script selects Linux or macOS from the host. Exit 0 means required
prerequisites are present or installed; 3 means required items remain missing or
deferred; 2 means invalid input or a bootstrap error. A dry run does not install
anything and may return 3. Neither script installs the harness: when ready, it
prints the next installer command. On Windows, remove the dry-run and unattended flags to review prompts for routes already implemented. This can use package-manager network access and elevation. The command above scopes the execution-policy bypass to that PowerShell process.
Sources: [Windows bootstrap](../../.claude/global-layer/bootstrap/harness-bootstrap.ps1), [POSIX bootstrap](../../.claude/global-layer/bootstrap/harness-bootstrap.sh), [plugin helper](../../.claude/global-layer/bootstrap.mjs).

### Windows one-command install

Before the command, complete two manual steps: install Git so `git` is on PATH, then clone the public repository (`git clone <public-repo-url> harness`) and open PowerShell in that checkout. Run `powershell -ExecutionPolicy Bypass -File .claude/global-layer/bootstrap/install-harness-windows.ps1 -SourceRepo "<public-repo-url>"`. No data repository is needed: without `-DataRepo`, STEP 3 prints `SKIPPED (no data repository: the personal layer is optional)`, STEP 4 runs the leak check with an empty term list and prints one NOTICE line, and STEP 5 installs only the harness layer. If you keep a private data repository (a `personal-terms.txt` and a personal model), add `-DataRepo "<data-repo>"` and the installer also installs the personal layer and the data gate. STEP 1 installs missing prerequisites unattended through the TSV routes using bootstrap `-Yes` (alias `-NonInteractive`), with package/source agreements accepted and winget silent mode; Windows may still show UAC administrator approval prompts. The console shows installation progress, each installed version or failure, and the required-tool check after refreshing PATH from Machine and User settings. Codex is optional and excluded by default; add `-WithCodex` to include it, or `-SkipVsCode` to omit editor setup. A failed required prerequisite stops at STEP 1 with exit 3 and the missing tool names; `-SkipPrereqs` keeps the existing installation bypass.

The one command needs no `-SkipVsCode`: STEP 6 installs the Claude Code extension (`anthropic.claude-code`) into VS Code's default profile with `code --install-extension`, skips it when it is already installed, and prints `STEP 6/7 tools: OK extension installed (default profile); VS Code profiles: manual step (see docs/harness/INSTALL.md)`. When the `code` command is not on PATH, STEP 6 prints `STEP 6/7 tools: OK MCP servers installed; VS Code extension SKIPPED (VS Code CLI not found)` and the install continues. The VS Code command line cannot create profiles, so the installer never does; the two profiles are an optional manual step. To get them, create `harness-personal` and `harness-work` from the VS Code interface (Manage, then Profiles, then New Profile; copy from Default if you want the same extensions), pick a colour for each under Color Theme, and optionally run `node .claude/global-layer/bootstrap/vscode-profiles/setup-vscode-profiles.mjs --mode profiles --code <path to code> --user-data-dir <VS Code user data folder>`, which installs the extension into profiles that already exist and merges the title-bar colours, never creating a profile. `check-vscode-profiles.mjs --mode profiles` with the same `--user-data-dir` reports, per profile, `extension present`, `extension missing` or `profile not created yet`.

### Manual prerequisites

The routes below are copied from [prereqs-windows.tsv](../../.claude/global-layer/bootstrap/prereqs-windows.tsv) and [prereqs-posix.tsv](../../.claude/global-layer/bootstrap/prereqs-posix.tsv). They were checked against the vendors' own pages, package-manager metadata and the extension marketplace on 2026-10-12 and were not executed. The `source` column of each TSV row carries the URL, the date read and any caveat; a row whose source starts with or contains `UNVERIFIED` names exactly what could not be confirmed. Run only the route for a missing prerequisite, then open a new terminal and repeat the bootstrap dry run to probe the installed programs.

#### Windows (winget)

| Windows prerequisite | Route | Scope / administrator approval | Status |
| --- | --- | --- | --- |
| Git | `winget install --id Git.Git --exact --source winget --scope user --silent --accept-package-agreements --accept-source-agreements --disable-interactivity` | user / possible | confirmed |
| Node (22+) | `winget install --id OpenJS.NodeJS.LTS --exact --source winget --silent --accept-package-agreements --accept-source-agreements --disable-interactivity` | machine / possible | UNVERIFIED part, see source column |
| Python (3.10+) | `winget install 9NQ7512CXL7T -e --accept-package-agreements --accept-source-agreements --disable-interactivity` | user / no | confirmed |
| Claude Code | `winget install --id Anthropic.ClaudeCode --exact --source winget --silent --accept-package-agreements --accept-source-agreements --disable-interactivity` | user / no | confirmed |
| GitHub CLI (`gh`) | `winget install --id GitHub.cli --exact --source winget --silent --accept-package-agreements --accept-source-agreements --disable-interactivity` | machine / possible | confirmed |
| Codex CLI (optional) | `winget install --id OpenAI.Codex --exact --source winget --silent --accept-package-agreements --accept-source-agreements --disable-interactivity` | user / possible | UNVERIFIED part, see source column |
| VS Code (optional) | `winget install --id Microsoft.VisualStudioCode --exact --source winget --scope user --silent --accept-package-agreements --accept-source-agreements --disable-interactivity` | user / no | UNVERIFIED part, see source column |
| Claude Code extension (optional, `code` on PATH) | `code --install-extension anthropic.claude-code` | user / no | confirmed |
| Codex extension (optional, `code` on PATH) | `code --install-extension openai.chatgpt` | user / no | confirmed |

If `winget` is unavailable, these scripts do not provide a fallback installer.

#### Linux and macOS

The POSIX bootstrap picks the apt column when `apt-get` exists, the dnf column when only `dnf` exists, and the brew column on macOS. Routes run through `sh -c`, with `sudo` when the elevation column says `manager` and the package manager is apt or dnf. A `download-script` route downloads the vendor installer, prints its SHA256 and runs it only after a second interactive consent; it needs a terminal. The POSIX bootstrap refuses to run as root unless `--allow-root` is explicitly passed.

CI runs `node .claude/tools/check-source-line-drift.mjs` after the publication contract test: stale source line numbers are reported as drift, missing anchor tokens fail, and `--fix` refreshes the documented line numbers and their token registry.

| Prerequisite | apt (Ubuntu, Debian) | dnf (Fedora) | brew (macOS) | Status |
| --- | --- | --- | --- | --- |
| Git | `apt-get update && apt-get install -y git` | `dnf install -y git` | `brew install git` | UNVERIFIED part, see source column |
| Node (22+) | `snap install node --classic --channel=24/stable` | `dnf install -y nodejs npm` | `brew install node@24 && brew link --force node@24` | UNVERIFIED part, see source column |
| Python (3.10+) | `apt-get update && apt-get install -y python3` | `dnf install -y python3` | `brew install python@3.14` | UNVERIFIED part, see source column |
| Claude Code | `download-script https://claude.ai/install.sh` | `download-script https://claude.ai/install.sh` | `brew install --cask claude-code` | confirmed |
| GitHub CLI (`gh`) | `apt-get update && apt-get install -y gh` | `dnf install -y dnf5-plugins && dnf config-manager addrepo --from-repofile=https://cli.github.com/packages/rpm/gh-cli.repo && dnf install -y gh` | `brew install gh` | UNVERIFIED part, see source column |
| Codex CLI (optional) | `download-script https://chatgpt.com/codex/install.sh` | `download-script https://chatgpt.com/codex/install.sh` | `brew install --cask codex` | UNVERIFIED part, see source column |
| VS Code (optional) | `snap install --classic code` | `rpm --import https://packages.microsoft.com/keys/microsoft.asc && printf '[code]\nname=Visual Studio Code\nbaseurl=https://packages.microsoft.com/yumrepos/vscode\nenabled=1\nautorefresh=1\ntype=rpm-md\ngpgcheck=1\ngpgkey=https://packages.microsoft.com/keys/microsoft.asc\n' > /etc/yum.repos.d/vscode.repo && dnf install -y code` | `brew install --cask visual-studio-code` | UNVERIFIED part, see source column |
| Claude Code extension (optional, `code` on PATH) | `code --install-extension anthropic.claude-code` | `code --install-extension anthropic.claude-code` | `code --install-extension anthropic.claude-code` | confirmed |
| Codex extension (optional, `code` on PATH) | `code --install-extension openai.chatgpt` | `code --install-extension openai.chatgpt` | `code --install-extension openai.chatgpt` | confirmed |

Known limits, all recorded in the TSV source column: the Node snap needs snapd (Ubuntu has it, Debian does not); the apt GitHub CLI is the older distro package because the vendor apt repository steps need `wget` and a pipe that the route grammar refuses; the Python and Git routes on RHEL-family systems are unconfirmed.

## Preview, then install

From the source checkout, preview the same scrubbed payload used by the wrapper:

<!-- Implements: .claude/global-layer/sync-harness-from-source.mjs:1146 -->
```text
node .claude/global-layer/sync-harness-from-source.mjs --check --source "." --global "<config-dir>" --scrub --personal-terms "<terms-file>"
```

`--check` is the sync script's default mode. It compares payload files and reports drift without applying destination changes. It also runs the payload preflight; it is not a complete simulation of settings wiring. `--apply` selects the writing mode:

<!-- Implements: .claude/global-layer/sync-harness-from-source.mjs:1146 -->
```text
node .claude/global-layer/sync-harness-from-source.mjs --apply --source "." --global "<config-dir>" --scrub --personal-terms "<terms-file>"
```

The one-command installer wraps that apply operation and then runs the doctor:

<!-- Implements: .claude/global-layer/harness-install.mjs:37 -->
```text
node .claude/global-layer/harness-install.mjs install --config-dir "<config-dir>" --personal-terms "<terms-file>"
```

The wrapper accepts `install`, `update`, and `doctor`; it accepts `--check` and `--dry-run` for install previews. Only `--apply` is sync-only. The wrapper always requests scrubbing. Its configuration default is `CLAUDE_CONFIG_DIR`, otherwise `<your-home>/.claude`. The sync script uses the same `CLAUDE_CONFIG_DIR`, then `<your-home>/.claude` default; use explicit destinations to avoid selecting the wrong profile. Sources: [wrapper parser and apply](../../.claude/global-layer/harness-install.mjs#L37), [sync parser](../../.claude/global-layer/sync-harness-from-source.mjs#L1146).

The wrapper's `--help` prints the following usage and exits 1 (observed locally):

```console
usage: node harness-install.mjs install|update|doctor [--config-dir <dir>] [--repo <url|path> --clone-dir <dir>] [--personal-terms <file>] [--no-personal-terms] [--force] [--json] [--profile <core|developer|security|full>] [--with-hooks] [--check|--dry-run]
```

Create a UTF-8 terms file with one term per line. `loadPersonalTerms` trims whitespace, ignores lines beginning with `#`, and discards empty lines; inline `#` characters remain part of the term. Matching is case-insensitive with ASCII letter/digit boundaries (not arbitrary substring matching); whitespace inside a term matches one or more whitespace characters. Example contents, using placeholder terms:

```ini
# Placeholder personal terms
Example Person
Example Organization
```

Source: [loadPersonalTerms and termRe](../../.claude/global-layer/sync-harness-from-source.mjs#L772). Replace these placeholders with your own local terms; do not publish that file.

`--personal-terms` is repeatable and supplies local redaction terms. Without explicit files, scrub mode looks for `<source>/meta/harness-plugin/personal-terms.local.txt` and `<config-dir>/harness-personal-terms.txt`. An empty or missing list refuses the install unless `--no-personal-terms` explicitly accepts proceeding without those redactions. It is not a promise that the payload contains no personal information. Keep the terms file private and outside published material ([term loading and scrub selection](../../.claude/global-layer/sync-harness-from-source.mjs#L1224)).

To clone from another local checkout as part of installation:

<!-- Implements: .claude/global-layer/harness-install.mjs:37 -->
```text
node .claude/global-layer/harness-install.mjs install --repo "<local-source-repo>" --clone-dir "<new-source-dir>" --config-dir "<config-dir>" --personal-terms "<terms-file>"
```

With `--repo`, cloning happens only when the clone directory does not exist. If omitted, `--clone-dir` defaults to `<your-home>/harness-source` for this mode. A remote repository URL is also accepted and would use network access; no remote operation was tested here ([clone path](../../.claude/global-layer/harness-install.mjs#L103)).

## Profiles

Omitting `--profile` keeps the existing full installation, including hooks. Profile definitions live in [install-profiles.json](../../.claude/global-layer/install-profiles.json).

| Profile | Capabilities |
| --- | --- |
| `core` | Agents, tools, and standards; no hooks, even with `--with-hooks`. |
| `developer` | Core plus observe-only hooks when `--with-hooks` is passed. |
| `security` | Core plus the reversibility and AskUserQuestion brake hooks when `--with-hooks` is passed. |
| `full` | Everything installed by the existing default, including all hooks and project seeding; no additional consent flag required. Existing scrub exclusions still apply. |

Developer and security print a message and install no hooks without explicit `--with-hooks` consent. Their consented installs include the runner and hook dependencies; automatic project seeding and the inline date hook remain full-only. The ledger records the profile and consent for update replay. Profiles select what to add; they do not remove previously installed hooks or user settings. Use a fresh configuration directory for an isolated profile.

<!-- Implements: .claude/global-layer/harness-install.mjs:37 -->
```text
node .claude/global-layer/harness-install.mjs install --profile developer --with-hooks --config-dir "<config-dir>" --personal-terms "<terms-file>"
node .claude/global-layer/harness-install.mjs install --profile core --dry-run --config-dir "<config-dir>" --personal-terms "<terms-file>"
```

`install --check` and `install --dry-run` print every profile's capability groups and the selected groups, run the existing drift/preflight check, and write nothing. Exit 1 can indicate files that would be installed or updated. Preview requires an existing source checkout and does not clone. The sync script also accepts `--profile`, `--with-hooks`, and `--dry-run`.

## What gets written

The [payload table](../../.claude/global-layer/sync-harness-from-source.mjs#L165) and its import closure select the files; this is not a copy of the whole repository.

| Destination | Contents |
| --- | --- |
| `<config-dir>/agents/`, `hooks/`, `tools/`, `lenses/`, `standards/` | Selected agents, checks, runner, seeder, review material, and dependencies. |
| `<config-dir>/CLAUDE.md` and the credential-isolation standard | Scrubbed rules seeded when absent; an existing copy unknown to the ledger is retained. |
| `<config-dir>/settings.json` | Merged lifecycle hook entries, including the session seeder and date hook; not a replacement permissions policy. |
| `<config-dir>/harness-MANIFEST.json` | Payload hashes and project-seeding instructions. |
| `<config-dir>/harness-install-ledger.json` | Installed hashes, ownership, and the request replayed by update. |
| Beside overwritten files | Dated `.bak-…` backups, with a suffix when needed. |
| Eligible projects' `.claude/` directories, on later session starts | Seeded hooks/tools, a manifest, merged settings, and `HARNESS-SEEDED.json`. This is a later seeder effect, not just a configuration-directory install. |

Sources: [copy and ownership handling](../../.claude/global-layer/sync-harness-from-source.mjs#L1331), [manifest and ledger writes](../../.claude/global-layer/sync-harness-from-source.mjs#L1401), [settings merge](../../.claude/global-layer/sync-harness-from-source.mjs#L1468), [project seeding](../../.claude/global-layer/harness-seed.mjs#L194).

Scrubbing excludes personal-model and machine-specific payload rows, including the shipped machine deny-roots list. It does not configure a local exclusion list for you. Ledger-known hand edits are kept unless `--force` is used. An ordinary pre-existing payload file without a ledger record can be backed up and overwritten; the special rules-seed exception above is narrower. Retired files are moved aside. Applying again can still update state and create backups; it is not a no-write operation.

## First session

Choose a fresh configuration directory for the desired profile, then run doctor
below. Start Claude Code in a disposable project using that configuration directory
(the client environment variable CLAUDE_CONFIG_DIR must match your install).
Inspect its available agent definitions and hooks before using real work. An
installer profile chooses capabilities; a configuration directory chooses which
client installation receives them. They are different choices.

For full installs, the session seeder can copy project hooks and write
HARNESS-SEEDED.json. Newly seeded project hooks take effect in the next session:
restart before checking them. Core has no hooks and does not seed projects.
Doctor checks installed hashes; it does not prove client hook execution.
Sources: [seed](../../.claude/global-layer/harness-seed.mjs#L166), [full profile](../../.claude/global-layer/install-profiles.json#L20). See [Architecture](ARCHITECTURE.md)
for agent roles, hook events and tools, and [Safety](SAFETY.md) for enforcement limits.
## Data repository

Run `node .claude/global-layer/bootstrap/data-repo-hooks.mjs install --data-repo "<data-repo>" --python "<python-executable>"` from the harness checkout to install the data gate in the private repository's untracked `.git/hooks/pre-commit` and `pre-push`; no hook is stored in the data tree. The gate defaults to this harness's `data_repo_gate.py` (override with `--gate "<gate-path>"`), using `check-staged` for commits and `check-outgoing` for each pushed ref. Keep the harness and interpreter available, and use the same command with `check` or `uninstall` in place of `install` to check or remove the hooks. The repository must have its own `.git` directory and no `core.hooksPath` override.

## Check and update an installed copy

<!-- Implements: .claude/global-layer/harness-install.mjs:37 -->
```text
node .claude/global-layer/harness-install.mjs doctor --config-dir "<config-dir>" --json
node .claude/global-layer/harness-install.mjs update --config-dir "<config-dir>"
```

Doctor compares ledger hashes and reports `OK`, `MISSING`, `MODIFIED-BY-USER`, and extra files. It checks installed bytes, not whether Claude Code executes the hooks correctly. Update uses the source path in the ledger, refuses tracked local modifications, runs `git pull --ff-only --quiet`, and reapplies the recorded scrub/terms request. Keep those terms files available. Pull may require network access; an offline or diverged pull can fail. Untracked files are excluded from its dirty check. Use `--force` only when deliberately replacing ledger-known edits; backups are retained ([update](../../.claude/global-layer/harness-install.mjs#L124), [doctor](../../.claude/global-layer/sync-harness-from-source.mjs#L603)).

The wrapper uses exit 3 for refused input and 4 for Git refusal; payload safety refusal is 2. Doctor returns 1 for missing or modified files. Update prints the doctor report but returns 0 after successful apply even if that report finds problems, so run doctor separately when its exit status matters. Sync check also uses exit 1 for drift or unresolved imports; inspect the report rather than treating every nonzero exit as the same failure.

## Disable and uninstall

The wrapper's dispatch supports only `install`, `update`, and `doctor`; a global `uninstall` mode is not implemented there. A complete automated rollback is **unverified** ([dispatch](../../.claude/global-layer/harness-install.mjs#L149)).

For a reversible disable, set `HARNESS_GLOBAL_OFF=1` in the environment of the Claude Code process. For one project, an empty `.claude/NO-HARNESS` marker opts out of global runner/seeder activity. These switches do not remove directly wired project hooks ([runner checks](../../.claude/global-layer/_global-runner.mjs#L109)).

To remove a seeded project's wiring, the source exposes:

<!-- Implements: .claude/global-layer/sync-harness-from-source.mjs:1146 -->
```text
node .claude/global-layer/sync-harness-from-source.mjs --source "." --unseed "<project-dir>"
```

This is a writing command even without `--apply`. Read its [implementation](../../.claude/global-layer/sync-harness-from-source.mjs#L1512) before use: it restores the lexically last settings backup if available, otherwise filters matching project hook entries, then moves the **whole** hooks directory to `hooks.removed-…`. It can affect custom hooks and restore unrelated older settings. It leaves other seeded material behind. Retain the opt-out marker or disable global seeding to avoid later reseeding.

For global removal, close the client, preserve the configuration and backups, and manually remove only this install's runner, seeder, and date entries from settings. Use the ledger to identify installed payloads; archive them only after checking for user edits and shared use. Restore a pre-install settings backup only if it will not discard later changes. Do not remove the entire configuration directory: it may contain unrelated settings and credentials. This manual procedure is **unverified** in this task.
