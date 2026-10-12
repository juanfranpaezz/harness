# Private personal data template

Only three exact paths are approved: personal-terms.txt, schema-manifest.json,
and preferences.json. Use them for curated personal terms, a non-secret file
description, and the portable preference fields described in the manifest.
The gate checks paths and secrets; the manifest is descriptive, not a schema
validator. Review preference fields before adding them.

Never store login state of any tool, keys, tokens, passwords, environment files,
browser sessions, histories, caches, logs, machine paths, backups, project trees,
raw settings, or generated installation state. Private visibility does not make
these categories suitable for this repository. Keep executable code in the harness.

Keep this README and data-whitelist.json with the trusted gate configuration,
outside the data tree. Copy schema-manifest.json into the data repository and
create the other two approved files there. Pass the external policy file with
--whitelist. The default policy location is data-whitelist.json at the data repo
root; it may remain untracked for staged and outgoing checks, but check-tree will
reject it like any other unapproved data path. The policy never approves itself.

Run the trusted harness tool with Python 3:

    python data_repo_gate.py check-tree DATA_REPO --whitelist POLICY_FILE
    python data_repo_gate.py check-staged DATA_REPO --whitelist POLICY_FILE
    python data_repo_gate.py check-outgoing DATA_REPO REMOTE LOCAL_REF REMOTE_SHA --whitelist POLICY_FILE

check-tree checks files on disk, including ignored files. check-staged checks all
index paths and scans the exact changed staged bytes even if the copy on disk is
different. check-outgoing checks every outgoing commit, including data removed
later. An all-zero remote SHA checks every reachable commit. The remote argument
is a hook-provided label; the command never contacts a remote. The old remote
commit must already exist locally. Shallow history fails closed.

Symlinks, submodules, module configuration and executable index entries fail.
Exact exported bytes, path names and outgoing commit metadata go through the
unchanged secret scanner in batches of at most 50 absolute file paths. Scanner
output is suppressed; reports contain rule names and original paths only. A
reported batch may include clean paths alongside a finding. Exit 0 means clean,
1 means a policy violation or scanner finding, and 2 means the check could not
complete. Treat both 1 and 2 as a block.

--scanner selects the trusted scanner and --python selects its interpreter.
--staging-dir must name a directory that does not yet exist, in a private local
parent. Otherwise the gate creates a private temporary directory. Export suffixes
are preserved and an in-memory map connects each export to its original path.
The gate removes only its own exports and directory after a run; an interruption
or operating-system cleanup failure may require local recovery. On Windows,
temporary directory privacy also depends on the parent directory's inherited ACL.

This template installs no hooks and creates no remote repository. Hook wiring,
installation on another machine, and recovery rehearsal are separate steps.
Keep the gate, scanner and policy outside writable data content. Local checks
can be bypassed, and scanning cannot guarantee that all secrets are detected.
