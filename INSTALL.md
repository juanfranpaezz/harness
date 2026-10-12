# Install the harness

Start with the [installation guide](docs/harness/INSTALL.md). It covers Windows,
Ubuntu and macOS prerequisites, bootstrap dry runs and their 0/3/2 exit codes,
installation, profiles and hook consent, first session, update, disable and uninstall.
The prerequisite entry points are harness-bootstrap.ps1 and harness-bootstrap.sh;
neither starts the harness installer automatically.

- [Agents, hooks, tools and meters](docs/harness/ARCHITECTURE.md)
- [Safety and personal data repositories](docs/harness/SAFETY.md)
- [CI commands and verification limits](docs/harness/PORTABILITY.md)

On Windows, the one-command route needs only the public repository: no private data
repository and no terms file. Clone it, then run the installer from the checkout
(replace `<public-repo-url>` with this repository's clone URL):

<!-- Implements: .claude/global-layer/bootstrap/install-harness-windows.ps1:2 -->
```text
git clone <public-repo-url> harness
cd harness
powershell -ExecutionPolicy Bypass -File .claude/global-layer/bootstrap/install-harness-windows.ps1 -SourceRepo "<public-repo-url>"
```

Without `-DataRepo`, STEP 3 prints `SKIPPED (no data repository: the personal layer is optional)`,
the leak check runs with an empty term list (one NOTICE line) and STEP 5 installs only the
harness layer. A manual, previewed install (any OS) is in the
[preview section](docs/harness/INSTALL.md#preview-then-install) of the guide.

STEP 6 installs the Claude Code extension into VS Code's default profile when the `code`
command is on PATH (and is skipped with a message when it is not), so the command needs no
`-SkipVsCode`. Creating the two VS Code profiles is an optional manual step, described in the
[one-command section](docs/harness/INSTALL.md#windows-one-command-install) of the guide.

Follow the full guide to apply your selected profile. Cross-platform execution of
the expanded publication matrix is **pending CI run**.

Runtime verification of installation and platform compatibility remains pending; this entry point does not claim that result. The Linux and macOS manual prerequisite routes are filled from vendor pages, package-manager metadata and the extension marketplace, checked on 2026-10-12; rows still marked UNVERIFIED, on Windows and on Linux and macOS, are listed in the [manual prerequisites section](docs/harness/INSTALL.md#manual-prerequisites) of the full guide.

Both the sync script and wrapper default to `CLAUDE_CONFIG_DIR`, otherwise `<your-home>/.claude`. The wrapper accepts `--check` and `--dry-run`; `--apply` is a sync-script flag. See the guide for the exact wrapper help output.
