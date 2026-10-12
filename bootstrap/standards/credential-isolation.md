# STANDARD: Credential isolation (the agent WIELDS access, NEVER sees a secret value)

**Status:** ACTIVE standard. Read this BEFORE any task that touches an API key, a token, an
SSH key, a VPS/server, a deploy, or any other secret. It tells you what to do on your own.

**The one rule that governs everything below:**

> An agent NEVER receives a raw secret value into its reasoning context.
> It either (A) reads a secret **by name** through a tool that injects the value for it, or
> (B) **wields the access** by running a program (e.g. `ssh`) that injects the credential for it.
> In both modes the agent only ever handles **non-secret** data (a key *name*, an IP, a username,
> a command). If you are ever about to print, log, echo, paste, or return a secret value — STOP;
> you are doing it wrong.

This is the 2026 consensus frame ("secret-by-name, never-in-context" + least privilege). The
load-bearing primary is the **OWASP** guidance (AI Agent Security Cheat Sheet + Secrets Management
Cheat Sheet: per-tool least privilege, no secrets in logs, out-of-prompt injection). Vendor "agents
never receive a secret; scoped short-lived token issued at runtime" writeups (Descope/Akeyless/
BeyondTrust) echo it but are graded B and discounted for hype. SSH behavior below is OpenSSH-primary.

There are exactly **two modes**. Pick the one that matches the secret.

---

## MODE A — Tokens / API keys (research keys, GitHub token, provider keys)

**Where the secret lives:** in a keystore OUTSIDE the repo tree, under the user profile
(`<USERPROFILE>/.claude/projects/<repo-slug>/<name>.key`), OR in an environment variable. The repo
tree (which you browse) NEVER contains the value.

**How you use it — read by name, never see the value:**

1. Resolve the secret **by its logical name** through the tool, never by reading a file yourself:

   ```python
   from keystore_min import read_key, redact_provider_error, KeyStoreError
   key = read_key("OPENAI_API_KEY")          # env override, else outside-repo store
   # hand `key` STRAIGHT to the HTTP transport (Authorization header) and nothing else
   ```

   Tool: `.claude/tools/keystore_min.py`. `read_key()` returns the value ONLY to the transport line
   that builds the request. Do not assign it to anything you print, log, return, or put in a message.

2. **Diagnostics only via the CLI**, which reports presence/source/path and NEVER the value:

   ```
   py .claude/tools/keystore_min.py --check OPENAI_API_KEY
   # -> {"key_present": true, "source": "env|file", "store_path": "...", ...}  (no key, no length)
   ```

3. **Fail-closed.** If `read_key` raises `KeyStoreError` (no key / empty / unreadable / store in a
   bad location), treat it as "no usable key" and ABORT the paid/authenticated call. Never fall open,
   never guess a key, never proceed.

4. **Redact provider errors.** A real provider 401 echoes the key inside its human `message`. NEVER
   surface a raw provider response body. Use `redact_provider_error(status, body)`, which emits only
   `HTTP <status> (error.code=<code>)` — the machine code, never the body.

5. **Same redaction to logs and errors** as to user output (OWASP: no secrets in logs). Never put a
   secret in argv (it shows in process listings) or in a committed config.

**Structural guarantees the tool already enforces (do not weaken them):**
- The store path is REFUSED if it resolves under the repo tree, and REQUIRED to be under the user
  profile — so you cannot accidentally `Read` the key file from the workspace.
- No code path prints/logs/json-dumps the key or puts it in an exception message (even the length is
  withheld).

**Honest caveats to know (do not over-state the tool):**
- **Plaintext at rest:** the store file is plaintext under the user profile. Protected only by
  outside-repo + user-profile scope; a process running as the user can read it. OS-keyring/DPAPI
  encryption is a deferred upgrade, not present yet.
- **Narrow redaction edge:** `safe_error_code` whitelists `error.code`/`type` to <=64 chars of
  `[A-Za-z0-9_.-]`. The protection is about WHERE the key appears, not its length: no provider echoes
  the full API key into the structured `error.code`/`type` field — keys ride in the human-readable
  error `message`, which is always dropped. (Length alone would NOT save you: legacy `sk-`(51) /
  `ghp_`(40) keys would pass the <=64 whitelist if a provider ever put one in `error.code`.)
  Contrived corner; noted.

**Do NOT adopt a vault for Mode A.** The JIT / ephemeral-token / SPIFFE-SPIRE / HashiCorp-Vault story
is enterprise-scoped and over-engineered for a solo/local or single-VPS setup. Cite it as direction
only. The keystore is the strong-enough local form.

---

## MODE B — Deploy / OS access (SSH to a VPS/server)

Use this when the task needs to reach a live external machine (deploy, run a remote command, copy
files). The secret here is an **SSH private key**, and you handle it the same way in spirit: you
never see it.

**Where the secret lives:** in the OS store — `~/.ssh`, loaded into **ssh-agent** (or, preferred in
2026, issued as a **short-lived SSH certificate** instead of a long-lived deploy key). The private
key value never enters your context.

**How you use it — wield the access, never the value:**

1. You run the access program; it injects the key for you:

   ```
   ssh <deploy-user>@<IP> '<command>'
   scp <file> <deploy-user>@<IP>:<path>      # or rsync over ssh
   ```

   `ssh` reads the private key from the agent/`~/.ssh` and authenticates. You only ever handle
   **non-secret** data: the target IP, the username, and the command. You never read, print, or pass
   the key value. This is the same never-in-context invariant as Mode A — shifted from
   "read-by-name" to "wield-by-running".

2. **Fail-closed.** If the key is absent, the agent is not loaded, or the host is unreachable —
   ABORT. Never fall open, never paste a key into the command line, never disable host-key checking
   to "make it work".

3. **No secret in logs/argv.** Never echo a key, never put one in a command's arguments, never commit
   one. Keep keys/certs time-limited via ssh-agent; prefer short-lived certs over long-lived keys.

**The risk model shifts.** Because you hold no key, the threat moves from *key-leak* to
*what-the-command-does-on-the-server*. So the deploy guardrails below become the load-bearing
controls — they are part of this standard, not optional.

### Deploy guardrails (apply every time Mode B reaches a real server)

1. **Least-privilege deploy user, NOT root.** Disable root SSH login (`PermitRootLogin no`). Deploy as
   a dedicated non-root user holding ONLY the deploy capability. Use distinct key pairs per context
   (CI vs laptop) so one is revocable without the other. Box even a compromised key with per-key
   restrictions in `authorized_keys` (`command="..."`, `no-pty`, `no-agent-forwarding`).

2. **A deploy is an OUTWARD / irreversible-ish GATED action.** It reaches a live external server and
   changes outward state, so it is NOT auto-pass reversible work. It must pass the project's gate
   (user sign-off class for outward/irreversible actions). Dry-run / plan first where possible; take
   one explicit "go" for the live push.

3. **Database NOT public.** Postgres (or any DB) binds to the internal Docker network only, never
   `0.0.0.0`. Reach it via the internal network or an SSH port-forward / bastion — never a public
   port. SSH port-forwarding secures the DB/dashboard connection without per-service TLS.

4. **Tunnel / endpoint with auth, no sensitive data exposed.** Any exposed endpoint or tunnel requires
   auth. Production hosts sit on a private network reachable only through a bastion / jump host. No
   sensitive data on a public surface. Prefer `ProxyJump` / destination-constrained agent forwarding
   over open agent forwarding.

(SSH hardening + least-privilege deploy posture grounded in 2026 OpenSSH/sysadmin best-practice;
secondary sources mutually corroborating, OpenSSH primary for injection behavior.)

---

## Quick decision flow for a fresh agent

```
Need a secret?
 ├─ It's a token / API key (provider key, GitHub token)  ............... MODE A
 │     read_key("NAME") -> transport only; fail-closed; redact errors; never print.
 │
 └─ It's access to a live machine (deploy / remote cmd / file copy)  ... MODE B
       ssh/scp/rsync wields the OS-stored key; you handle only IP+user+cmd.
       Then apply ALL FOUR deploy guardrails. Deploy = gated outward action.

In EITHER mode: if you are about to see/print/log/paste/return a secret VALUE -> STOP. Wrong path.
If the secret/host is missing or unreachable -> fail-closed (abort), never fall open.
```

## Why this standard exists (provenance)

Extends P-5 (the keystore covers Mode A and already travels in the portable template). The gap this
closes: Mode A was not written as a general standard a fresh agent reads on its own, and nothing
covered DEPLOY secrets (Mode B). The trigger was external — a deploy task needed SSH/VPS access
without the agent seeing the credential, and the convention had to be codified rather than improvised
each time. Mode-A claims here were grounded by running `keystore_min.py` (CLI presence-without-value,
provider-401 redaction, in-repo-store refusal, fail-closed) — not by trusting docstrings. Mode-B
mechanics are provided by OpenSSH; what was missing was this written standard plus the guardrails.
