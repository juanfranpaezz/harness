#!/usr/bin/env python3
r"""
secret_scan.py  --  pure-stdlib pre-commit secret scanner (no gitleaks needed).
                    Windows-compatible.  (Wave-4 / Part 1, FIX 2)

WHAT THIS IS
------------
gitleaks may not be installed (or may not be installable), so this is
the dependency-free gate that stops an API key from ever being committed. It scans
the STAGED content (what `git diff --cached` would commit) for known key patterns
plus a generic high-entropy long-token heuristic, and EXITS NON-ZERO if it finds
one -- which aborts the commit when wired as a pre-commit hook.

It scans STAGED CONTENT (via `git diff --cached`), not the working tree, so it
gates exactly what is about to be committed.

PATTERNS  (kept in sync with `_PATTERNS` below -- the CODE is the source of truth)
--------
- OpenAI project keys ...... sk-proj-<...>
- OpenAI legacy keys ....... sk-<base62>{20,}   (but NOT sk-proj-, handled above)
- Anthropic keys ........... sk-ant-<...>
- GitHub PATs (classic) .... ghp_<36+>
- GitHub fine-grained PATs . github_pat_<...>
- GitHub other tokens ...... gh[ousr]_<36+>            (ADDED 2026-08-30)
- Telegram bot tokens ...... <8-10 digit bot id>:AA<33 base64url chars>
                                                               (ADDED 2026-09-04)
- AWS access key ids ....... AKIA<16>
- AWS SECRET access keys ... an `(aws_)secret_access_key` identifier followed by
                             40 base64 chars                   (ADDED 2026-08-30)
- Google / Gemini API keys . AIza<35>                          (ADDED 2026-08-30)
- Google OAuth secrets ..... GOCSPX-<20+>                      (ADDED 2026-08-30)
- PEM private keys ......... a BEGIN..PRIVATE KEY header WITH a base64 body
                                                               (ADDED 2026-08-30)
- Generic high-entropy ..... a long ([A-Za-z0-9_\-]{32,}) token whose Shannon
                             entropy is high (random-looking), to catch unknown
                             key shapes. Tuned to avoid hashes/ids where feasible.
- Base64 high-entropy ...... a long [A-Za-z0-9+/]{32,} token CONTAINING a base64
                             special (`+` `/` `=`), which the generic class above
                             structurally cannot see.          (ADDED 2026-08-30)

NOT COVERED, deliberately (each pattern costs false positives forever, so a service
nobody here uses is not worth its noise): Stripe, Twilio, SendGrid, Discord,
HuggingFace, npm, PyPI, Docker Hub, Azure, and JWTs. (Mercado Pago ACCESS tokens left this
list in CANDIDATE6; see `mercadopago-access-token`.) There is NO JWT
pattern -- earlier revisions of this docstring claimed `PEM/JWT` were covered when
neither was; PEM is now real, JWT is still absent and is not claimed.
TELEGRAM bot tokens are NOT on that list: they are COVERED. Any project that runs a
Telegram bot reads one (typically from TELEGRAM_BOT_TOKEN), so the premise that would
put them there (`a service nobody here uses`) does not hold in general, and a token
of that shape in a staged file is a live credential leak. See the
`telegram-bot-token` entry below for the shape, and for the one thing about it that
was NOT re-verified.

CARVE-OUT: npm/yarn LOCKFILE INTEGRITY DIGESTS  (ADDED 2026-09-04, CEO go)
-------------------------------------------------------------------------
A `package-lock.json` (v3) stores a Subresource-Integrity digest per package --
`"integrity": "sha512-<base64>"`. That value is the PUBLIC SHA-512 of a published tarball,
printed by `npm install` and served by the registry to everyone; it is a content hash, not a
credential. Base64 contains `+` and `/`, which `_GENERIC_TOKEN` excludes, so each digest is
chopped into 32+ char fragments that trip the generic-high-entropy leg -- measured at base SHA
4f2f05c: 3 of 3 `"integrity"` fields in this repo's 62-line lockfile produced 3 findings and
exit 1, blocking the commit.
THE CARVE-OUT IS DELIBERATELY THE NARROWEST ONE THAT WORKS, and it is a SPAN exclusion, not a
file allowlist. It stands down the HEURISTIC legs (generic-high-entropy + base64-high-entropy)
ONLY for a candidate token that lies WHOLLY INSIDE a digest value satisfying ALL THREE of:
  (1) the FILE basename is package-lock.json / npm-shrinkwrap.json (or yarn.lock for the
      `integrity sha512-...` line form) -- every other file in the repo is untouched;
  (2) the value is the value of an `"integrity":` key (yarn: an `integrity` line); and
  (3) the value carries the literal SRI prefix `sha256-`/`sha384-`/`sha512-` and a base64 body.
The explicit high-confidence `_PATTERNS` are NOT span-filtered and still fire everywhere,
INCLUDING inside an integrity value -- so a real `AKIA...`/`sk-ant-`/`ghp_`/`github_pat_`
smuggled into a lockfile is still caught, and a value disguised as `"integrity": "AKIA..."`
(no sha prefix) never matches the carve-out at all. RESIDUAL, stated honestly: a random-looking
token given a fake `sha512-` prefix inside a file actually named like a lockfile would be
excused by the two heuristic legs. See `_integrity_digest_spans`.

PROPOSED REFINEMENT v2 (2026-06-21, NON-WIRED copy: secret_scan.v2.PROPOSED.py)
------------------------------------------------------------------------------
Builds on the already-wired v1 refinements (chunked-key discriminator + fixture allowlist
+ v1 camelCase carve-out). v2 fixes the REMAINING camelCase false-positive class: long
PascalCase Java/Spring identifiers that embed SHORT capitalized acronym/qualifier fragments
(`OAuth`, `Mp`, `API`, `Controller`, `Filter`) which the v1 carve-out rejected because it
required EVERY camelCase piece to be a >=2-char pure word. The live blocker tonight was
`ProfessionalOAuthTokenRefreshScheduler` (38 chars). v2 changes ONLY the camelCase
identifier carve-out (`_looks_like_code_identifier` + new `_merge_singleton_caps`):
  1. Re-glue a stray 1-char uppercase piece (acronym split `OAuth`->`O`,`Auth`) before
     judging, so embedded acronyms score as whole tokens.
  2. Replace "EVERY piece is a >=2-char word" with a DIGIT-FREE word-SHAPE majority test: a
     majority of pieces (and >= 2) must be "real PascalCase words" (match `^[A-Z]?[a-z]{2,}$`
     = a capital then >=2 LOWERCASE letters), and the LONGEST such word must be >= 6 chars --
     so a minority of short acronym/qualifier fragments (`OAuth`,`Mp`,`API`) is tolerated but
     the identifier must be CARRIED by substantial real words. The DIGIT GUARD is untouched --
     any token with a digit (every realistic base62 key) is NEVER excused.
The explicit high-confidence _PATTERNS (sk-ant-/sk-proj-/ghp_/AKIA; PEM added 2026-08-30,
JWT is NOT and never was covered), the per-run
length floor, and the v1 chunked-key + fixture legs are ALL unchanged. (For the v1 changes
this file inherits, see the PRIOR REFINEMENT block at `_looks_like_chunked_key`.)

PRIOR REFINEMENT (v1, 2026-06-21, wired in the live secret_scan.py)
-------------------------------------------------------------------
Refines ONLY the generic-high-entropy rule to stop false-positiving on hyphen/underscore
filename slugs that carry a short `word+digit` chunk (e.g. `fable5`, `wave4`, `v2`), on
markdown-anchor slugs, and on camelCase identifiers, while STILL catching real secrets.
Two changes, both strict tightenings of the generic leg (explicit _PATTERNS untouched):
  1. The grouped/chunked-key leg now requires the letter+digit-mixed chunks to DOMINATE
     (>=3, a majority of alnum chunks, >=3.5 chars avg) -- a real chunked key passes; a
     filename/date slug with one short version chunk does not. (`_looks_like_chunked_key`)
  2. Files under the scanner's OWN test-fixture dirs (meta/secret-scan-fp-fix/) are skipped
     at the file level in commit/audit modes (they intentionally hold fake key-shaped
     tokens). (`_is_fixture_path`)

USAGE
-----
    py secret_scan.py            # scan staged content; exit 1 if a secret is found
    py secret_scan.py --all      # scan ALL tracked files (audit mode)
    py secret_scan.py --paths a b # scan specific files or directories (walked recursively)

Exit 0 = clean. Exit 1 = secret(s) found (commit should abort). Exit 2 = scan error.
Exit 2 also covers every "could not scan" case: a --paths argument that does not exist, a
directory with no files, an unreadable file, a staged blob git cannot produce, and a recognised
container that cannot be fully opened. Exit 1 wins when a secret is also found.

CANDIDATE6 (2026-09-24) -- fixes A1-A7 of the candidate5 install gate (AMEND 85)
-----------------------------------------------------------------------------------------
The candidate5 gate showed three carriers that were recognised (or cheaply recognisable) but
not decoded, then reported BYTE-SCANNED clean. Candidate6 decodes them or refuses them:
  A1 PDF streams: the /Filter value (a name or an array, abbreviations included) is decoded IN
     ORDER -- /ASCIIHexDecode, /ASCII85Decode, /FlateDecode, any chain of them. An image codec
     (DCT, JPX, JBIG2, CCITTFax) ends the chain: that stream is pixel data. ANY OTHER filter
     (LZW, RunLength, Crypt, an unreadable /Filter value) is exit 2 naming the filter.
  A2 PNG text chunks: tEXt is read, zTXt and compressed iTXt are inflated (shared budget); an
     inflate failure or an unknown compression method is exit 2.
  A3 (bounds revised by CANDIDATE7 below) gzip members and zlib streams are PROBED at ANY offset of a blob that is not a parsed
     ZIP/TAR/PDF/PNG (gzip magic + deflate + sane flags; zlib header 0x78 with the four
     standard FLG bytes). Only a stream that inflates to its end marker AND checksum counts; a
     failed probe is "not a stream here", never a refusal. Bounded: at most
     _MAX_PROBE_ATTEMPTS candidate offsets and _MAX_PROBE_MEMBERS streams per blob, output under
     the shared 64 MiB budget; exceeding any bound is exit 2.
  A4 ESC, FF and SUB no longer count as control bytes in the cp1252-text test, so a cp1252 log
     with ANSI colour codes gets the FULL rules.
  A6 (owner decision 2026-09-24) TEXT members of a ZIP (Office documents included) get the FULL
     rule set, entropy legs included; binary members, gzip/TAR/PDF/PNG content stay on explicit
     patterns only. A ZIP that cannot be opened (password, unsupported method, corrupt) is exit 2
     "container not scannable".
  A7 Mercado Pago ACCESS tokens (`APP_USR-` / `TEST-` + digits-date-hex32-digits) are a rule.
     Mercado Pago PUBLIC keys (`APP_USR-`/`TEST-` + a UUID) are NOT matched on purpose: they are
     designed to be shipped inside browser and mobile front-ends, so they are public by design.
NOT COVERED, still: raw deflate with no zlib/gzip framing; zlib streams with a non-default
window (CMF other than 0x78); probes nested at the depth cap; bytes appended OUTSIDE a parsed
ZIP/TAR/PDF/PNG structure; entropy legs inside PNG text, gzip, TAR and PDF content.

CANDIDATE7 (2026-09-24) -- the A3 any-offset probe is bounded
-----------------------------------------------------------------
Measured on candidate6: a 200 MB random binary took 441 s (candidate5: 42 s). Measured cause: a
FAILING `decompress` call costs time proportional to the input handed to it (~0.7 ms per MiB),
and candidate6 handed every candidate the whole rest of the file. Random-byte candidates fail
within 48 input bytes (largest garbage output 774 bytes over a 64 MiB sample). Rules now:
  (a) a gzip candidate is inflated only behind a full sane 10-byte header: magic, CM=8, FLG
      reserved bits clear, XFL in {0,2,4}, OS in {0..19,255} (RFC 1952 plus the codes zlib writes,
      19 = macOS). MTIME is NOT filtered (builds that
      pin it to 0 or 1 are real). A zlib candidate needs CMF 0x78 and an FLG byte whose FCHECK
      passes with FDICT clear.
  (b) input is fed in 64 KiB slices. A zlib candidate may produce at most 256 KiB; reaching that
      without its end marker means "not a stream here" (skipped, never exit 2) UNLESS those
      256 KiB are text (<=1% control bytes), in which case it continues under the shared budget.
      A gzip candidate (strong header) continues under the shared 64 MiB budget; running out of
      budget is exit 2, exactly as for a gzip at offset 0.
  (c) at most 4096 inflated candidates in any one MiB (random data: ~64) and 200000 per blob;
      beyond either is exit 2 "container not scannable".
NOT COVERED, added by these bounds: a zlib stream (no gzip header) whose content is NOT text
and is larger than 256 KiB is skipped, not scanned; a gzip member whose XFL or OS byte is
non-standard is not probed at a non-zero offset (at offset 0 the gzip parser still opens it).

CANDIDATE5 (2026-09-24) -- read this BEFORE the candidate4 notes below, which it partly REVERSES
-----------------------------------------------------------------------------------------
The candidate4 install gate FAILED it (A1-A9). Candidate5 REMOVES the hash-pinned fixture ledger
and the `"fixture": true` JWT carve-out described below (both were self-mintable escape hatches),
ADDS a Slack `xox[abpr]-` rule (so Slack leaves the NOT COVERED list above), refuses every
recognised-but-unopened container (7z/xz/bzip2/RAR/CAB/zstd/lz4, or nesting past depth 3) with
exit 2, opens ustar TAR members and ZIPs found by their end record anywhere, and makes the
`meta/secret-scan-fp-fix/` skip LOUD (SKIPPED line, exit 2). Full list: the changelog comment
right after `HERE = ...` below.

CANDIDATE4 CONSOLIDATION (2026-09-24) -- one file reconciling the four divergent artefacts
-----------------------------------------------------------------------------------------
Base = secret_scan.candidate3.py (byte-level detector, NUL/UTF-16 routing, digit-budgeted
identifier carve-out, numeric base64 path segments, hash-pinned fixture ledger shipping EMPTY,
and the 2026-09-22 fail-closed-on-undecodable block of the live working tree). Added here:
  1. PEM private-key header set WIDENED (from secret_scan.candidate.py): labels with a digit
     (`ED25519`, `X25519`, `SSH2 ENCRYPTED`) and OpenPGP `PRIVATE KEY BLOCK`. Detection-only.
  2. REDACTION: a finding prints its rule, the token LENGTH and its LINE -- never a byte of the
     value (the previous `_redact` printed the first four characters).
  3. FAIL-CLOSED IN EVERY MODE (S55 + the gap the live diff named): see the exit-2 list above.
     Each case is NAMED on stderr. Nothing is skipped in silence.
  4. CONTAINERS: gzip streams, ZIP members and PDF /FlateDecode streams are inflated (capped at
     64 MiB per file, depth 3) and their content is scanned; an encrypted, corrupt or oversized
     container is UNSCANNABLE (exit 2), never "clean".
  5. PRECISION, content-derived, no path leg, heuristic legs only (explicit patterns always run):
     (a) a `data:image/<fmt>;base64,` payload that decodes STRICTLY to a structurally complete
         image of the declared format (magic + trailer) is not entropy-judged; its DECODED bytes
         are scanned instead; (b) a JWT whose SIGNED payload carries `"fixture": true` is not
         entropy-judged -- the label lives inside the signed part, so it cannot be added to a real
         issued token without invalidating that token's signature.
NOT merged, deliberately: the public-material carve-outs of candidate.py (verifier NO-GO, 93) and
candidate2.py (signature verification via openssl/cryptography, unverified) -- see
meta/cache/_coder-secret-scan-consolidated-candidate-2026-09-24.md.
"""
from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import io
import json
import zipfile
import zlib
import math
import os
import re
import subprocess
import sys
import tarfile

HERE = os.path.dirname(os.path.abspath(__file__))
# --- CANDIDATE5 (2026-09-24) -- fixes from the candidate4 install gate (A1-A9) --------------
#  A1  containers recognised by MAGIC BYTES and not opened (7z, xz, bzip2, RAR, CAB, zstd, lz4)
#      are exit 2 "container not supported", never BYTE-SCANNED clean; ZIP is found by its
#      end-of-central-directory record anywhere (a ZIP appended after a PNG header is opened);
#      ustar TAR members are opened; a container nested past the depth cap is exit 2.
#  A2  valid UTF-8 carrying NUL bytes keeps the FULL text rules (NUL -> space view) plus an
#      explicit-pattern pass over the NUL-stripped view (catches a key split by NULs).
#  A3  non-UTF-8 text that is mostly printable single-byte text (cp1252/latin-1) gets the FULL
#      rules on its cp1252 decoding.
#  A4  the `"fixture": true` JWT carve-out is REMOVED (census 2026-09-24: 0 fixture JWTs in
#      the tracked tree, meta/cache or the test files; 2 JWTs in total, neither labelled).
#  A5  the fixture ledger is REMOVED (dec-140 strict; S48(a) stays blocked, owner-accepted).
#  A6  staged listing uses --diff-filter=ACMRT (type changes are scanned).
#  A7  a failing `git diff --cached` / `git ls-files` is exit 2 naming the failure.
#  A8  Telegram: leading `\b` -> `(?<![0-9])`, trailing `\b` -> `(?![A-Za-z0-9_\-])`, so the
#      URL form `api.telegram.org/bot<token>` is caught. Slack `xox[abpr]-` rule added.
#  A9  staged/tracked names are read with `-z` as UTF-8 bytes: non-ASCII names are scanned.
#  +   `meta/secret-scan-fp-fix/` is no longer skipped in silence: a `SKIPPED <path>:` line and
#      an exit-2 contribution. PDF text operands are joined across lines (explicit patterns
#      only). UTF-16 views are tried at both byte alignments.
# --- CANDIDATE6 (2026-09-24) -- fixes from the candidate5 install gate (A1-A7) --------------
#  A1 `_pdf_filters` / `_pdf_decode`; A2 `_png_text_chunks`; A3 `_probe_compressed`;
#  A4 `_CTRL_BYTES`; A6 `text_full` in `_scan_blob` + "container not scannable" ZIP refusals;
#  A7 `mercadopago-access-token` in `_PATTERNS`. See the CANDIDATE6 docstring section.
# --- CANDIDATE7 (2026-09-24): `_probe_compressed` + `_probe_stream` bounded (header, slice, cap,
#     per-MiB candidates). See the CANDIDATE7 docstring section.
# -------------------------------------------------------------------------------------------
REPO_ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))

# ---------------------------------------------------------------------------
# Known high-confidence secret patterns. Each is (name, compiled-regex).
# ---------------------------------------------------------------------------
#
# --- COVERAGE FIX (2026-08-30): the HIGH-VALUE half of an AWS credential was uncovered ---
# Measured at base SHA b95b8bb: there was NO `aws-secret-access-key` pattern at all -- only the
# key ID (`AKIA...`). The ID authenticates nothing on its own and is sent in cleartext on every
# signed request; the SECRET is the actual credential. So the gate flagged the harmless half and
# let the dangerous half through. Re-measured over 2000 generated 40-char tokens drawn uniformly
# from the AWS secret alphabet [A-Za-z0-9+/], scanned BARE: the base scanner caught 941/2000
# = 47.1% and let 52.9% through (see `.claude/tools/secret_scan.test.py --catch-rate`).
# The cause is structural: `_GENERIC_TOKEN` below is `[A-Za-z0-9_\-]{32,}`, which EXCLUDES the
# two characters base64 actually uses (`+` and `/`), so a secret containing either is split into
# sub-32-char runs and becomes invisible to the only leg that could have seen it.
# TWO independent fixes, so neither is a single point of failure:
#   (1) this CONTEXTUAL pattern -- an AWS-secret-shaped 40-char base64 value next to an
#       `(aws_)secret_access_key` / `secretAccessKey` identifier; and
#   (2) the `_B64_TOKEN` leg further down, which closes the structural blind spot for ANY
#       base64 payload, with or without a context word.
_AWS_SECRET_CTX = r"(?:aws[_\-.]?)?secret[_\-.]?access[_\-.]?key"
# Separator junk allowed between the identifier and the value: quotes, whitespace, : = > , only.
# Deliberately EXCLUDES `$` `{` `(` so an env-var indirection (`= ${AWS_SECRET_ACCESS_KEY}`) --
# the LEGITIMATE way this project writes it -- cannot be read as a value.
_AWS_SECRET_SEP = "[\"'`\\s:=>,]{0,12}"

# Shared by userinfo and JDBC patterns, including their byte-scanning consumers.
_DB_URI_SCHEME = (r"(?:postgres(?:ql)?|(?:mysql|mariadb)"
                  r"(?::(?:replication|sequential|loadbalance|failover|aurora|fabric))?"
                  r"|mongodb|cockroachdb|rediss?|amqps?)"
                  r"(?:\+[a-z][a-z0-9_.-]*)?")
# Apply only to a WHOLE password; encoded bytes and placeholder-like substrings
# in a longer value must still be detected. Both callers use IGNORECASE.
_DB_URI_PLACEHOLDER = (
    r"(?:\*+|x{3,}|password|change[_-]?me|replace[_-]?me|your[_-]?password"
    r"|\$[a-z_][a-z0-9_]*|%s|%\([a-z_][a-z0-9_]*\)s|%[a-z_][a-z0-9_]*%)"
)

_PATTERNS = [
    ("openai-project-key", re.compile(r"sk-proj-[A-Za-z0-9_\-]{20,}")),
    ("anthropic-key",      re.compile(r"sk-ant-[A-Za-z0-9_\-]{20,}")),
    # legacy OpenAI key: sk- followed by >=20 base62, but not the sk-proj-/sk-ant- forms.
    ("openai-legacy-key",  re.compile(r"sk-(?!proj-|ant-)[A-Za-z0-9]{20,}")),
    ("github-pat-classic", re.compile(r"ghp_[A-Za-z0-9]{36,}")),
    ("github-pat-fine",    re.compile(r"github_pat_[A-Za-z0-9_]{22,}")),
    ("aws-access-key-id",  re.compile(r"AKIA[0-9A-Z]{16}")),
    # --- ADDED 2026-08-30 -------------------------------------------------------------
    # AWS SECRET access key: 40 chars of base64 sitting next to an AWS-secret identifier.
    # SCOPING (deliberate, to keep the FP cost at zero): the context is required to be the
    # AWS-specific phrasing `secret[_-.]access[_-.]key` / `secretAccessKey`. A bare `secretKey`
    # is NOT accepted -- it is an extremely common Java/Spring variable name and Java
    # codebases use it widely, so accepting it would manufacture false positives forever.
    ("aws-secret-access-key", re.compile(
        _AWS_SECRET_CTX + _AWS_SECRET_SEP + r"[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])",
        re.IGNORECASE)),
    # Google / Gemini API key. `GEMINI_API_KEY` and `GOOGLE_API_KEY` are the usual environment
    # variable names for it, and a leaked key of this class grants paid API access to whoever
    # holds it. The `AIza` prefix + exactly 35 base64url chars is a hard
    # structural shape -- a prose mention of "AIza" cannot reach 35 trailing key chars.
    ("google-api-key", re.compile(r"AIza[0-9A-Za-z_\-]{35}")),
    # Google OAuth client secret. Any app that signs users in with Google OAuth (Gmail, Drive,
    # Calendar clients) ships one, and committed client secrets are a common leak class.
    ("google-oauth-client-secret", re.compile(r"GOCSPX-[A-Za-z0-9_\-]{20,}")),
    # PEM private key. `.claude/standards/credential-isolation.md` Mode B is SSH keys, so this
    # is a credential class the project's own standard governs. The BODY is required (>=40
    # base64 chars within 200 chars of the header) so that a DOCUMENTATION MENTION of the
    # header -- which really occurs in several meta/ files -- does not fire.
    ("private-key-pem", re.compile(
        r"-----BEGIN [A-Z0-9 ]{0,24}PRIVATE KEY(?: BLOCK)?-----"
        r"[\s\S]{0,200}?[A-Za-z0-9+/=]{40,}")),
    # GitHub OAuth / user / server / refresh tokens. `ghp_` is already covered above, so this
    # is scoped to the four OTHER prefixes and cannot double-report. `gh auth login` stores a
    # `gho_` token, and GH_TOKEN/GITHUB_TOKEN are referenced 35 times across this repo.
    ("github-token", re.compile(r"gh[ousr]_[A-Za-z0-9]{36,}")),
    # Telegram bot token. Any project that runs a Telegram bot reads one (typically from
    # TELEGRAM_BOT_TOKEN), so this is a live credential class, which is exactly why it is
    # not on the NOT-COVERED list above.
    # SHAPE: `<bot_id>:<35 chars of [A-Za-z0-9_-]>` -- a numeric bot user id (8-10 digits in
    # the current id range), a colon, then the 35-char secret half, which conventionally
    # opens with `AA`. Requiring the literal `AA` plus exactly 33 more chars (2 + 33 = the
    # documented 35) is what holds the false-positive cost at zero: an ISO timestamp
    # (`2026-09-04T23:31:00`), a MAC address, a `host:port`, a bare chat id and a numeric
    # ratio all fail it structurally -- none of them can present 35 token chars after a
    # colon that begin with `AA`. Measured on this repo at 2026-09-04: 0 new findings.
    # HONEST LIMIT: the 35-char length and the `AA` opener come from the task brief and the
    # widely-published token shape; they were NOT re-verified against Telegram's live docs
    # in the run that added this (no network read was made). Consequences, both stated:
    # (1) a token whose secret half does NOT open with `AA` is NOT matched here and falls
    # back to the heuristic legs, which catch that shape only about a third of the time;
    # (2) widening `AA` to a bare `[A-Za-z0-9_\-]{35}` would fix (1) but would also match
    # any 35-char generic run that happens to follow `<8-10 digits>:`, so do it only after
    # the docs are actually checked.
    # MEASURED RESIDUAL of the two word-boundary assertions (500 synthetic tokens, 2026-09-04):
    # 491/500 = 98.2%. The 9 misses are the tokens whose 33rd body char is a hyphen -- a
    # trailing word-boundary cannot assert after a non-word char. Replacing the final
    # boundary with a negative lookahead for another token char measures 500/500 and adds no
    # false positive; the same applies to the leading boundary when a letter precedes the bot
    # id. That upgrade is NOT applied here because the regex above is the one the task
    # authorised verbatim -- it is written up in the handoff for a deliberate decision.
    # CANDIDATE5 (A8): the leading `\b` failed after `bot` in `api.telegram.org/bot<id>:AA...`
    # (the shape this repo's bot uses) and the trailing one on a hyphen-final body. Replaced by
    # digit / token-char lookarounds, which keep the "whole 8-10 digit id" meaning.
    # CANDIDATE7 (2026-09-25, install-gate blocker A1): the candidate5 trailing lookahead
    # `(?![A-Za-z0-9_\-])` was added to catch a hyphen-FINAL body (live's `\b` cannot assert
    # after a `-` at end of line). It was NOT added against a false positive. Its side effect was
    # a detection REGRESSION vs live: a token written straight against a suffix (`<token>-prod`,
    # `<token>_x`) was no longer matched by this rule (gate: 1471/3000 caught, all by entropy).
    # Now: `(?![A-Za-z0-9])` OR live's `\b` -- a strict superset of live's rule and of the
    # candidate5 rule. The one protection the lookahead gave -- not matching the first 35 chars
    # of a LONGER alphanumeric run such as `<id>:AAAAAAAA...` (base64 of zero bytes) -- is kept.
    # Residual, stated: a longer run whose 34th body char is `_` or `-` now matches (it is
    # byte-identical to `<token>_x`, so the two cannot be told apart).
    ("telegram-bot-token", re.compile(
        r"(?<![0-9])\d{8,10}:AA[A-Za-z0-9_\-]{33}(?:(?![A-Za-z0-9])|\b)")),
    # CANDIDATE5: Slack tokens (xoxb bot, xoxp user, xoxa app, xoxr refresh). A numeric group
    # right after the prefix is REQUIRED, so a placeholder `xoxb-` + `YOUR-SLACK-BOT-TOKEN` does not
    # fire. HONEST LIMIT: shape from the published format, not re-checked against Slack's live
    # docs in this run; `xoxe.`-rotated and `xapp-` app-level tokens are NOT covered.
    ("slack-token", re.compile(r"(?<![A-Za-z0-9])xox[abpr]-[0-9]+-[A-Za-z0-9-]{10,}")),
    # CANDIDATE6 (A7, owner decision 2026-09-24): Mercado Pago ACCESS token, production
    # (`APP_USR-`) and sandbox (`TEST-`): <prefix>-<app id digits>-<6-digit date>-<32 hex>-<user
    # id digits>. It authorises API calls (charges, refunds, account data), so it is a secret.
    # The PUBLIC key (`APP_USR-`/`TEST-` + a UUID, 8-4-4-4-12 hex) is NOT matched: Mercado Pago
    # issues it to be embedded in browser/mobile checkout code, so it is public by design and a
    # rule on it would be a false positive forever. HONEST LIMIT: the segment lengths come from
    # the widely-published token shape and the gate's battery; they were NOT re-checked against
    # Mercado Pago's live docs in this run (no network read). A token whose segments fall
    # outside these ranges falls back to the entropy legs. KNOWN, PRE-EXISTING FALSE POSITIVE: a
    # production public key `APP_USR-<uuid>` is flagged by the GENERIC chunked-key leg for about 59% of
    # random UUIDs (118/200 measured 2026-09-24; live and candidate5 give the identical 118/200), never
    # by this rule. No carve-out was added for it here: that is a separate, owner-level decision.
    ("mercadopago-access-token", re.compile(
        r"(?<![A-Za-z0-9])(?:APP_USR|TEST)-\d{10,20}-\d{6}-[0-9a-fA-F]{32}-\d{6,12}(?![0-9])")),
    # Vendor API key (2026-10-03, plan v4/v5 A3): the literal `lmapv_` prefix
    # plus 43 base64url characters (32 random bytes, unpadded). ADDITIVE: only a text holding
    # `lmapv_` + 43 such characters can change; a random key was already caught by the generic leg
    # (now reported under this name instead), a low-entropy or patterned one was missed before.
    ("lmapv-api-key", re.compile(r"lmapv_[A-Za-z0-9_\-]{43}")),
    # Database userinfo: require a nonempty password and a host. Exclude template
    # delimiters and whole placeholders; the username may be empty (Redis default user).
    ("database-uri-password", re.compile(
        r"\b" + _DB_URI_SCHEME + r"://"
        r"[^\s:/@?#\"'<>]*:(?!" + _DB_URI_PLACEHOLDER + r"@)[^\s/@?#\"'<>{}]+@"
        r"[A-Za-z0-9\[][^\s/?#\"'<>]*", re.IGNORECASE)),
    # JDBC query parameters: password can be first or follow other parameters.
    # Stay within one URI/query, require the whole value, and reject placeholders
    # instead of accepting their prefix (for example the '$' in an env reference).
    # Bare angles are parameter data; only '</' ends XML element text.
    # JSON \\u0026 and triple-escaped &amp;amp;amp; remain out of scope.
    ("jdbc-uri-password", re.compile(
        r"\bjdbc:" + _DB_URI_SCHEME + r"://"
        r"[^\s?#\"'<>]+\?(?:(?:(?!</|%26)[^\s&#\"'])*"
        r"(?:&(?:amp;amp;(?!amp;)|amp;(?!amp;)|#(?:38|038|x26);|(?!amp;|#))|%26))*pass"
        r"word="
        r"(?!(?:" + _DB_URI_PLACEHOLDER + r"|<" + _DB_URI_PLACEHOLDER + r">)(?=%26|[&#\s\"'<>]|$))"
        r"(?:(?!</|%26)[^\s&#\"'{}])+(?=</|%26|[&#\s\"']|$)",
        re.IGNORECASE)),
]

# CANDIDATE7 (2026-09-25, install-gate blocker A2, the `--all` sweep time): NECESSARY-LITERAL
# PREFILTERS. Measured (scratchpad c7fix/pattern_cost.py over 80 MB of tracked text): the four
# rules that START with a lookbehind, `\d` or an IGNORECASE group cannot use the regex engine's
# literal-prefix search and cost 11.2 s of the 14.4 s spent on explicit rules (aws-secret 4.0,
# telegram 3.0, mercadopago 2.1, slack 2.0); one tracked 0.9 MB tar.gz (22 MB inflated) re-runs
# them over 107 MB of views. Every match of each of these rules CONTAINS the literal listed
# below (read off the regex), so a text without it cannot produce a match and the rule is
# skipped for that text; with the literal present the unchanged regex runs over the whole text.
# The findings are therefore identical by construction -- only the time changes. The aws-secret
# prefilter is the rule's own `secret` literal under the SAME re.IGNORECASE flag, so every case
# variant the full rule accepts is accepted by the prefilter too.
_PATTERN_PREFILTER_LITERALS = {
    "telegram-bot-token": (":AA",),
    "slack-token": ("xox",),
    "mercadopago-access-token": ("APP_USR-", "TEST-"),
    "database-uri-password": ("://",),
    "jdbc-uri-password": ("://",),
}
_AWS_SECRET_PREFILTER = re.compile("secret", re.IGNORECASE)

# CASE-FOLDED prefilter (2026-10-10, database-URI rules, round 2). Both rules are IGNORECASE and
# start with `\b`, so the engine cannot skip ahead and tries every position of every text that
# holds `://`: measured +9.5 s (database-uri 5.9 s, jdbc 3.7 s) of a ~78 s `--all` sweep, +16%
# over the scanner without them. Every match of a rule contains one of its words below under
# re.IGNORECASE, so a text holding none cannot match and the rule is skipped; otherwise the
# unchanged regex runs over the whole text. The words are tested on `text.lower()`, which is
# exact for ASCII. Outside ASCII, IGNORECASE also folds U+0130, U+0131 and U+017F onto
# `i`/`s` while lower() does not map them back (probed over every code point on Python 3.13.2;
# secret_scan_dburi.test.py re-probes it), so a text holding one of those skips this gate and
# keeps the unfiltered regex. Findings are therefore identical by construction.
_PATTERN_PREFILTER_FOLDED = {
    "database-uri-password": ("postgres", "mysql", "mariadb", "mongodb", "cockroachdb",
                             "redis", "amqp"),
    "jdbc-uri-password": ("jdbc",),
}
_FOLD_ESCAPE_CHARS = ("İ", "ı", "ſ")


def _patterns_for(text: str) -> list:
    """The (name, rx) pairs of `_PATTERNS` that can match somewhere in `text` (see above).
    Also exact for any SUBSTRING of `text`: a literal absent from `text` is absent from it too."""
    out = []
    low = None          # text.lower(), computed once and only if a folded gate needs it
    fold_escape = False
    for name, rx in _PATTERNS:
        lits = _PATTERN_PREFILTER_LITERALS.get(name)
        if lits is not None and not any(lit in text for lit in lits):
            continue
        if name == "aws-secret-access-key" and _AWS_SECRET_PREFILTER.search(text) is None:
            continue
        words = _PATTERN_PREFILTER_FOLDED.get(name)
        if words is not None:
            if low is None:
                low = text.lower()
                fold_escape = (not text.isascii()
                               and any(c in text for c in _FOLD_ESCAPE_CHARS))
            if not fold_escape and not any(w in low for w in words):
                continue
        out.append((name, rx))
    return out


# Generic long-token candidate (then entropy-filtered to cut false positives).
# NOTE the character class: `+` and `/` are ABSENT, which is exactly why a base64 payload was
# structurally invisible to this leg. That gap is closed by `_B64_TOKEN` below rather than by
# widening this class, because widening it here would re-interpret every `/` in every file path
# as part of a token and flood the scanner with path false positives.
_GENERIC_TOKEN = re.compile(r"[A-Za-z0-9_\-]{32,}")
_ENTROPY_THRESHOLD = 4.0  # bits/char; random base64-ish ~5.0-6.0, English prose ~3-4.

# --- BASE64 PAYLOAD LEG (ADDED 2026-08-30) ---------------------------------------------
# Closes the structural blind spot: a candidate token over the FULL base64 alphabet, including
# the `+` and `/` that `_GENERIC_TOKEN` omits, plus optional `=` padding.
_B64_TOKEN = re.compile(r"[A-Za-z0-9+/]{32,}={0,2}")
_B64_SPECIALS = frozenset("+/=")

# FALSE-POSITIVE DISCRIMINATORS for the base64 leg, both MEASURED on this repository rather
# than guessed. The first cut (classes + entropy alone) produced 6 findings on the real tree,
# every one of them a false positive of a SINGLE class: a `/`-separated sequence of ordinary
# WORDS -- a scheme-less URL (`sciencedirect.` + `com/science/article/pii/...`) or a slash-
# joined word list (`.../alpha/beta/rc/Specifier/...`). In such a token the `/` is a WORD
# SEPARATOR; in a real base64 payload `/` is just one more random symbol (p = 1/64).
# HONESTY CORRECTION (independent measurement, 2026-09-04): "a genuine 40-char secret usually
# has no separator at all" was the old wording here and it UNDERSTATES the collision. Over the
# base64 alphabet, P(>= 2 separators in 40 chars) is about 35%, so a real secret reaches the
# >= 3-segment word test roughly one time in three. What keeps the recall cost small is the WORD
# test (a majority of >= 3-char PURE-ALPHA segments), not the scarcity of separators. The
# measured price of that carve-out is stated at the carve-out itself, in `_looks_like_base64_secret`.
_B64_SEGMENT = re.compile(r"[+/]")
# A pure-alpha segment of >= 3 chars is a WORD. The >= 3 floor is load-bearing and was
# MEASURED, not guessed: at >= 2 chars a random secret whose separator happens to land 2 chars
# from an end produces a 2-letter "word" ~70% of the time, which alone cost 7 points of recall
# (99.95% -> 92.97%) for no false-positive benefit. Real word-lists are carried by >= 3-char
# words, so the floor is free on the FP side.
_B64_WORD_SEG = re.compile(r"^[A-Za-z]{3,}$")
# Only judge word-composition once the token has enough segments for "a sequence of words" to
# be a meaningful description. Below this it is one payload that happens to contain a symbol.
_MIN_B64_SEGMENTS_TO_JUDGE = 3
# PRECISION FIX (2026-09-23, S48 case c): a `/`-separated PATH also carries pure-NUMERIC
# components (a date directory `2026`, `09`, an id). The word test counted only pure-ALPHA
# segments, so `word/camelWord/word/NNNNNN/NNNNNNNN` scored 2 words out of 5 segments and
# missed the majority by one, flagging a file path as a base64 payload. A random base64 body
# draws digits at p = 10/64, so a run of >= 4 consecutive digits appears at ~6e-4 per position
# and TWO such runs essentially never; measured recall cost is in the notes file.
_B64_NUMERIC_SEG = re.compile(r"^[0-9]{4,}$")
# A real base64 payload draws digits at p = 10/64, so 32+ chars carry ~5; a word sequence
# carries 0-1. Requiring >= 2 costs under 1% recall and removes the digit-free word slugs.
_MIN_B64_DIGITS = 2


def _looks_like_base64_secret(tok: str) -> bool:
    """True if `tok` looks like a random BASE64 secret payload.

    Scoped to be STRICTLY ORTHOGONAL to the existing generic leg, so it can only ADD catches
    and can never re-judge a token the generic leg already handles:

      1. The token MUST contain at least one of `+ / =`. A token without them is pure
         [A-Za-z0-9], which is a subset of `_GENERIC_TOKEN`'s class and is therefore already
         covered upstream. This single condition is what confines the new leg to exactly the
         blind spot and nothing else.
      2. The body (padding stripped) must be >= `_MIN_SECRET_RUN` chars.
      3. It must carry ALL THREE character classes -- lowercase AND uppercase AND digit.
         This is the false-positive killer. A 32+ char random base64 payload has all three
         with probability ~0.995, so the recall cost is ~0.5%; but ordinary long
         `[A-Za-z0-9+/]{32,}` runs in a repository are FILE PATHS, and a path essentially
         never carries all three (`meta/measurement/1c/blinded/c055` has no uppercase;
         `C:/Users/<user>/AppData/Local/Temp/claude` has no digit; a git object path has no
         uppercase). Measured on this repository: ZERO new findings.
      4. Shannon entropy must clear the same `_ENTROPY_THRESHOLD` the rest of the file uses.
    """
    if not any(c in _B64_SPECIALS for c in tok):
        return False                      # already covered by the generic leg -- add nothing
    body = tok.rstrip("=")
    if len(body) < _MIN_SECRET_RUN:
        return False
    if not (any(c.islower() for c in body)
            and any(c.isupper() for c in body)
            and any(c.isdigit() for c in body)):
        return False
    # 5. Digit floor: a word sequence carries 0-1 digits; a base64 payload carries ~5 per 32.
    if sum(c.isdigit() for c in body) < _MIN_B64_DIGITS:
        return False
    # 6. WORD-SEQUENCE carve-out: if the token splits on `+`/`/` into 2+ segments of which a
    #    majority are pure-alpha WORDS, it is a path / scheme-less URL / slash-joined word
    #    list, not a key.
    #    RECALL COST -- MEASURED, and NOT "negligible" as this comment used to claim
    #    (independent measurement, 2026-09-04, recorded in
    #    meta/cache/_INDEPENDENT-REVIEW-2026-09-04.md section 3.D): BARE secrets -- a random
    #    payload with no surrounding context identifier -- escape the scanner at 2.45%
    #    (49 of 2000), and that miss rate is DOMINATED by this carve-out. The old supporting
    #    reasoning ("a random base64 secret almost never has 2+ segments at all") is refuted
    #    by its own arithmetic: P(>= 2 separators in 40 chars) is about 35%. The "100% catch"
    #    result holds only WITH a context identifier (e.g. an AWS-style key id) present.
    #    Kept anyway: it is what removes the measured path / scheme-less-URL false positives.
    segments = [s for s in _B64_SEGMENT.split(body) if s]
    if len(segments) >= _MIN_B64_SEGMENTS_TO_JUDGE:
        words = [
            s for s in segments
            if _B64_WORD_SEG.match(s) or _B64_NUMERIC_SEG.match(s)
        ]
        if len(words) * 2 >= len(segments):
            return False
    return shannon_entropy(body) >= _ENTROPY_THRESHOLD

# A real secret is a SINGLE continuous high-entropy run. The generic heuristic
# therefore evaluates a token's longest continuous alphanumeric run (split on the
# slug separators - _ .), NOT the whole separator-joined string. This rejects
# word-slugs / doc titles like `openai-removed-hard-budget-limits`, whose length
# and apparent entropy come from concatenating short dictionary-ish words with
# separators rather than from real randomness, while still catching an unknown-shape
# key, which is a long unbroken random run. Must be >= the 32-char generic minimum.
_SLUG_SEPARATORS = re.compile(r"[-_.]")
_MIN_SECRET_RUN = 32

# --- PROPOSED REFINEMENT (2026-06-21): chunked-key discriminator + fixture allowlist ---
# Tonight's commit of analysis caches was BLOCKED by the generic-high-entropy rule on a
# narrow FALSE-POSITIVE class: hyphen/underscore filename slugs that contain ONE short
# `word+digit` chunk (e.g. `fable5`, `wave4`, `part3`, `v2`). The old grouped-format
# discriminator (`has_mixed_chunk` = "any one letter+digit chunk") was satisfied by such
# an innocent version-suffix word, then the concatenated-words stripped string cleared the
# 4.0-bit entropy bar (English-word concatenation lands ~4.0-4.3). The three real blocked
# tokens were:
#   ANALYZE-A-component-value-under-fable5            (chunk `fable5`)
#   session-handoff-2026-06-08-wave4-part3-start      (chunks `wave4`,`part3`)
#   _finder-corporate-prereg-FULL-v2-2026-06-12       (chunk `v2`)
# A GENUINE chunked key (e.g. `Xa8K-9Lm2-Qx7z-Wp3R-7bNq-Td4V`) is built almost ENTIRELY of
# random base62 groups, so its letter+digit-mixed chunks DOMINATE: they are the majority of
# the alnum chunks, there are several of them (>=3), and each is a few chars of base62. A
# filename/date slug has at most one or two short version chunks among many pure-word /
# pure-date chunks. So the refined gate (see `_looks_like_chunked_key`) requires the mixed
# chunks to be (1) >=3 in count, (2) a MAJORITY of the alnum chunks, and (3) >=3.5 chars on
# average -- which the FP slugs fail and a real chunked key passes. This is STRICTLY a
# tightening of the grouped-format leg: the per-run leg and the explicit high-confidence
# _PATTERNS are untouched, so single-run unknown keys + every sk-/ghp_/AKIA/PEM shape
# are caught exactly as before.
_MIN_CHUNKED_MIXED_GROUPS = 3      # a real chunked key has several random groups
_MIN_CHUNKED_MIXED_AVGLEN = 3.5    # base62 groups are a few chars; `v2`/`p14` are too short

# Test-fixture allowlist: files UNDER these repo-relative dirs are the secret-scan's OWN
# both-outcomes fixtures (they INTENTIONALLY contain fake/synthetic tokens that LOOK like
# keys, e.g. meta/secret-scan-fp-fix/fp_test.py). Scanning them produces guaranteed
# false positives, so they are skipped at the FILE level. NOTE: this is path-scoped to the
# scanner's dedicated fixture dir ONLY -- it does not whitelist arbitrary content, and the
# generic + explicit detection is unchanged for every other path. A real key committed
# anywhere OUTSIDE these fixture dirs is still caught.
_FIXTURE_ALLOWLIST_DIRS = (
    "meta/secret-scan-fp-fix/",
)


# CANDIDATE5: the skip below is no longer SILENT. Each skipped path prints `SKIPPED <path>: ...`
# and contributes exit 2, so a skip can never read as a clean result.
_FIXTURE_SKIP_REASON = ("NOT scanned: it is under the scanner's fixture-directory skip "
                        "(meta/secret-scan-fp-fix/ holds synthetic key-shaped test data)")


def _is_fixture_path(path: str) -> bool:
    """True if `path` (repo-relative, any slash style) is under a known test-fixture dir."""
    norm = path.replace("\\", "/").lstrip("./")
    return any(norm.startswith(d) for d in _FIXTURE_ALLOWLIST_DIRS)


# --- NPM/YARN LOCKFILE SRI-DIGEST CARVE-OUT (ADDED 2026-09-04, CEO go) --------------------
# Full rationale: the CARVE-OUT block in the module docstring. Three conditions, ALL required,
# and the product is a set of SPANS -- not a file-level skip, and not a change to any pattern.
# The explicit `_PATTERNS` never consult these spans, so no known key shape is weakened.
_NPM_LOCKFILE_BASENAMES = frozenset({"package-lock.json", "npm-shrinkwrap.json"})
_YARN_LOCKFILE_BASENAMES = frozenset({"yarn.lock"})
# `"integrity": "sha512-<base64>"` -- group 1 is the digest VALUE only (the quotes are outside
# the group), so a token must sit inside the digest itself to be excused. The >=32-char body
# floor matches `_MIN_SECRET_RUN`; every real SRI body is 43 (sha256) to 86 (sha512) chars.
_NPM_INTEGRITY_VALUE = re.compile(
    r'"integrity"\s*:\s*"(sha(?:256|384|512)-[A-Za-z0-9+/]{32,}={0,2})"')
# yarn.lock v1 line form: `  integrity sha512-<base64>` alone on its own line.
_YARN_INTEGRITY_VALUE = re.compile(
    r"^[ \t]*integrity[ \t]+(sha(?:256|384|512)-[A-Za-z0-9+/]{32,}={0,2})[ \t]*$",
    re.MULTILINE)


def _integrity_digest_spans(path: str, text: str) -> list:
    """Spans of npm/yarn SRI digest VALUES in `text`, but ONLY when `path` is a lockfile.

    Returns [] for every other filename (and for no path at all), so this predicate is inert
    across the whole repository except those three lockfile names. Callers use WHOLE
    CONTAINMENT -- a candidate token must lie entirely inside a span -- which is stricter than
    the overlap test the URL leg uses: a token that merely touches a digest is NOT excused.
    """
    if not path:
        return []
    base = os.path.basename(path.replace("\\", "/")).lower()
    if base in _NPM_LOCKFILE_BASENAMES:
        return [m.span(1) for m in _NPM_INTEGRITY_VALUE.finditer(text)]
    if base in _YARN_LOCKFILE_BASENAMES:
        return [m.span(1) for m in _YARN_INTEGRITY_VALUE.finditer(text)]
    return []


def _inside_integrity(span, integrity_spans) -> bool:
    """True if `span` lies WHOLLY inside one of the SRI digest value spans."""
    ts, te = span
    return any(ts >= ds and te <= de for ds, de in integrity_spans)


# =============================================================================================
# PREPARED, NOT APPLIED (2026-08-30) -- the meta/measurement/1c/ placeholder allowance.
# =============================================================================================
# THE PROBLEM: six files under `meta/measurement/1c/` (of 121 tracked there) carry a planted
# fake AWS credential from a June measurement corpus. They are currently UN-RECOMMITTABLE: any
# reformat or rerun that rewrites them is blocked fail-closed by this scanner.
#
# THIS PREDICATE IS DEFINED BUT NEVER CALLED. Nothing in the verdict path consults it, so the
# scanner's behaviour is BYTE-FOR-BYTE unchanged and `--all` is still red on those six files.
# Applying it NARROWS A SECURITY CONTROL, which is the CEO's call and not the author's. The
# exact three-hunk wiring diff, its revert line, and who must approve it are in the handoff.
#
# WHY IT IS SAFE BY CONSTRUCTION: it requires BOTH conditions, never either one alone --
#   (1) the file is under `meta/measurement/1c/`, AND
#   (2) the MATCHED TOKEN ITSELF contains a documentation-placeholder marker.
# A real credential structurally cannot contain the word EXAMPLE, so this cannot be reused to
# hide one. NOTE what is deliberately NOT built: a blanket directory allowlist would blind all
# 121 files under 1c to ALL patterns, and is exactly the wrong shape.
#
# SCOPE FINDING THAT CHANGED THE ORIGINAL DESIGN (must be read before wiring this): the
# allowance was specified as scoped to the key-ID pattern ONLY. That was correct when the
# scanner had no AWS-secret pattern. As of this change those same six files ALSO trip the new
# `aws-secret-access-key` pattern (7 ID matches + 7 secret matches, and BOTH halves carry the
# EXAMPLE marker -- re-derived, see the handoff). So a key-ID-only wiring would NO LONGER make
# the files re-committable and would not achieve its purpose. Whether to extend the allowance
# to the second pattern name is a DELIBERATE WIDENING of a security carve-out and is escalated,
# not self-authorized here.
_FIXTURE_PLACEHOLDER_DIRS = (
    "meta/measurement/1c/",
)
# Markers that a documentation placeholder carries and a real credential cannot.
_FIXTURE_PLACEHOLDER_MARKERS = (
    "EXAMPLE",
)


def _is_allowed_fixture_placeholder(path: str, token: str) -> bool:
    """PREPARED, NOT WIRED. True only if BOTH the path is under a known measurement-fixture
    dir AND the matched token itself carries a documentation-placeholder marker.

    Both legs are required. Path alone is a blanket directory allowlist (refused by design);
    marker alone would let any file anywhere smuggle a token by embedding the word EXAMPLE.
    """
    norm = path.replace("\\", "/").lstrip("./")
    if not any(norm.startswith(d) for d in _FIXTURE_PLACEHOLDER_DIRS):
        return False
    return any(marker in token for marker in _FIXTURE_PLACEHOLDER_MARKERS)


# camelCase / PascalCase code-identifier boundary: split at a lower->Upper transition or at
# an Upper-run -> Upper+lower transition (so `HTTPServer` -> `HTTP`,`Server`). A long
# camelCase Java identifier (e.g. `AbstractSingletonProxyFactoryBeanBuilderImpl`) is one
# continuous run (no slug separators), so the per-run leg flags it as high-entropy. But it
# is a concatenation of DICTIONARY WORDS at case boundaries, NOT a random key, so it splits
# into many pure-alpha word-pieces -- which a random base62 key does not.
_CAMEL_BOUNDARY = re.compile(r"(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])")
_MIN_CAMEL_WORDS = 3   # >=3 word-pieces => a multi-word identifier, not a key body

# --- PROPOSED REFINEMENT v2 (2026-06-21): tolerate short capitalized fragments ---
# The v1 carve-out (above) required EVERY camelCase piece to be a pure-alpha word of >=2
# chars. That was too strict for real-world Java/Spring identifiers, which routinely embed
# SHORT capitalized acronym/qualifier fragments among the dictionary words:
#   * embedded acronyms: `OAuth`, `API`, `HTTP`, `URL`, `JWT`, `SQL`, `MP`, `Mp`
#   * short qualifiers/suffixes: `Mp`, `Db`, `Id`, `Dto`, `Vo`
# The v1 _CAMEL_BOUNDARY also mis-splits a leading acronym: `OAuth` -> `O`,`Auth` (a 1-char
# `O` piece), which alone tripped the `len(p) >= 2` guard. Tonight's real blocker was
#   ProfessionalOAuthTokenRefreshScheduler  (38 chars, one continuous run)
# whose v1 split was ['Professional','O','Auth','Token','Refresh','Scheduler'] -- the stray
# 1-char `O` failed `all(...)`, so v1 did NOT excuse it and the 4.0-bit generic leg flagged
# it. The prompt's named class `ProfessionalMpOAuthController` is the same family (the short
# `Mp`,`O` fragments).
#
# v2 fix (two parts, both still strictly DIGIT-FREE -- the load-bearing safety is untouched):
#   1. Re-glue a stray length-1 uppercase piece onto the NEXT piece before judging, so a
#      leading/embedded acronym like `OAuth` is scored as the single token `OAuth`, not as
#      `O`+`Auth`. (Random all-caps runs do not produce clean `<1-upper><Upper+lower>` shapes,
#      so this does not open a key-shaped hole.)
#   2. Replace "EVERY piece is a >=2-char pure word" with a WORD-SHAPE majority test: the run
#      is a code identifier iff (a) it splits into >= _MIN_CAMEL_WORDS pieces, (b) every piece
#      is pure-alpha (NO digits anywhere -- a single digit still disqualifies the whole run, so
#      every realistic base62 key is excluded), (c) a MAJORITY of pieces (and >= 2) are
#      "real PascalCase words" -- i.e. match `^[A-Z]?[a-z]{2,}$` (a capital then >=2 LOWERCASE
#      letters, the shape of an actual English word), so a minority of short acronym/qualifier
#      fragments (`OAuth`,`Mp`,`API`) is tolerated but the identifier must be CARRIED by real
#      words, and (d) the LONGEST such word is >= _MIN_CAMEL_LONGEST chars (every real Spring
#      identifier has a substantial word like `Professional`/`Controller`/`Authentication`).
# WHY THE WORD-SHAPE (not just length): a random mixed-case all-letter run -- the ONLY token a
# digit-free carve-out could possibly excuse -- rarely segments into capital-then-lowercase
# words; requiring most pieces to be lowercase-tailed words (plus a >=6-char longest word) cuts
# the random-run leak ~6x vs a bare length-majority rule (measured: 4766->~240 / 5000 random
# digit-free 38-char runs flagged) while still clearing every real Java/Spring identifier.
# RESIDUAL (honest): a key that is digit-free AND letters-only AND happens to word-segment can
# still slip -- but (i) a random base62 key is digit-free only ~1 in 800, (ii) the explicit
# _PATTERNS (sk-/ghp_/AKIA/...) fire regardless, and (iii) any digit anywhere disqualifies.
# The digit guard, the per-run length floor, and ALL explicit high-confidence _PATTERNS are
# UNCHANGED, so any digit-bearing key, any base62/hex key shape, and every explicit pattern are
# caught exactly as before.
_MIN_CAMEL_WORD_MAJORITY = 2   # >= this many real-word pieces, AND a majority of all pieces
_MIN_CAMEL_LONGEST = 6         # the longest real word must be substantial (Professional, etc.)
# A "real PascalCase word": a capital (or none) then >= 2 LOWERCASE letters. Random mixed-case
# runs rarely produce this shape; real identifiers are built of these.
_CAMEL_WORD = re.compile(r"^[A-Z]?[a-z]{2,}$")


# --- PRECISION FIX (2026-09-23, PENDING-FIXES S32/S48): camelCase identifiers that carry a
# SHORT digit run. v2 refused ANY digit, so `...Sha256...`-shaped identifiers (32-37 chars,
# 6 camel pieces, exactly one embedded digit run) fell straight through to the entropy leg and
# blocked four legitimate cache files -- twice. The relaxation is budgeted, not removed:
# a run may carry at most `_MAX_ID_DIGIT_RUNS` digit runs, each at most `_MAX_ID_DIGIT_RUN_LEN`
# chars, `_MAX_ID_DIGITS_TOTAL` digits in all. A random base62 key of 32+ chars draws digits at
# p = 10/62, so it carries ~5 digits in ~4 separate runs and blows every one of these three
# budgets; the measured recall cost is reported in the notes file (Monte Carlo, not asserted).
# The digit runs are then DELETED before the word test, so the surviving alpha pieces must still
# pass the unchanged v2 majority/longest-word gate -- the real discriminator is still "is this
# built out of dictionary words", which a key body is not.
_DIGIT_RUN = re.compile(r"[0-9]+")
# BUDGET CHOSEN BY MEASUREMENT (25,000 random base62 keys per cell, seed 20260923; the sweep
# and its output are in the notes file). Share of random 32/40/64-char keys the carve-out
# swallows:  (2,4,5) -> 0.636% / 0.192% / 0.000%;  (2,6,6) -> 0.620% / 0.188% / 0.000%;
# (3,6,8) -> 1.572% / 0.672% / 0.028%. The first two are INDISTINGUISHABLE (standard error is
# about +/-0.05pp at this N), so run-length 6 is free relative to 4, while (3,6,8) triples the
# cost and is rejected. Run-length 6 is also what an identifier actually needs: a `202609`-style
# date stamp or a 5-digit build number. The binding guard is the RUN COUNT, not the length.
_MAX_ID_DIGIT_RUNS = 2
_MAX_ID_DIGIT_RUN_LEN = 6
_MAX_ID_DIGITS_TOTAL = 6


def _digit_budget_ok(run: str) -> bool:
    """True if `run`'s digits are sparse enough to be identifier decoration rather than key
    material. A digit-free run trivially passes (v1/v2 behaviour, unchanged)."""
    runs = _DIGIT_RUN.findall(run)
    if not runs:
        return True
    if len(runs) > _MAX_ID_DIGIT_RUNS:
        return False
    if max(len(r) for r in runs) > _MAX_ID_DIGIT_RUN_LEN:
        return False
    return sum(len(r) for r in runs) <= _MAX_ID_DIGITS_TOTAL


def _merge_singleton_caps(parts: list[str]) -> list[str]:
    """Glue a stray length-1 UPPERCASE piece onto the following piece, so a leading/embedded
    acronym split (`OAuth` -> `O`,`Auth`) is recovered as one token (`OAuth`). Only a single
    isolated uppercase letter is merged forward; everything else is left as-is. This is a
    presentation fix for the boundary regex, not a relaxation of the digit/word guards."""
    merged: list[str] = []
    carry = ""
    for p in parts:
        if len(p) == 1 and p.isupper():
            carry += p
            continue
        merged.append(carry + p)
        carry = ""
    if carry:
        merged.append(carry)
    return merged


def _looks_like_code_identifier(run: str) -> bool:
    """True if a continuous run is a camelCase/PascalCase code identifier rather than a key.

    Load-bearing safety (UNCHANGED from v1): a run with ANY DIGIT is NEVER treated as an
    identifier (real base62 keys carry digits; this carve-out is digit-free only), so no
    digit-bearing key can be misclassified.

    v2 refinement: the run must decompose (after re-gluing stray 1-char uppercase acronym
    fragments, see `_merge_singleton_caps`) into >= `_MIN_CAMEL_WORDS` pure-ALPHA pieces, of
    which at least `_MIN_CAMEL_WORD_MAJORITY` are "real PascalCase words" (match `_CAMEL_WORD`
    = a capital then >=2 LOWERCASE letters), the real-word pieces form a MAJORITY of all pieces,
    AND the longest real word is >= `_MIN_CAMEL_LONGEST` chars. So a minority of short
    acronym/qualifier fragments (`OAuth`,`Mp`,`API`,`Db`,`Id`) is tolerated, but the identifier
    must be CARRIED by several substantial dictionary words. A random all-letter run rarely
    segments into capital-then-lowercase words, so this stays a narrow carve-out (a key body
    would need to be digit-free AND letters-only AND coincidentally word-segmentable)."""
    if not _digit_budget_ok(run):
        return False
    parts = _merge_singleton_caps(
        [p for p in _CAMEL_BOUNDARY.split(_DIGIT_RUN.sub("", run)) if p]
    )
    if len(parts) < _MIN_CAMEL_WORDS:
        return False
    if not all(p.isalpha() for p in parts):
        return False
    words = [p for p in parts if _CAMEL_WORD.match(p)]
    if len(words) < _MIN_CAMEL_WORD_MAJORITY:
        return False
    # real-word pieces must be a MAJORITY (not a pile of acronym fragments with 2 real words)...
    if len(words) < (len(parts) + 1) // 2:
        return False
    # ...and the longest real word must be substantial (a random run rarely has a long word).
    return max(len(w) for w in words) >= _MIN_CAMEL_LONGEST


# --- A8 EXPLICIT CARVE-OUT (2026-06-21, CEO go): lowercase-hyphen slug + #anchor ---
# The go-package (A8) asks the generic-high-entropy leg to NOT fire on two harmless shapes
# that previously cleared the bar only INCIDENTALLY (by run-length / entropy), so a longer
# instance could regress:
#   (a) a filename slug that is ONLY lowercase letters and hyphens (e.g. `nombre-de-archivo`),
#   (b) a markdown anchor: a leading `#` then only lowercase letters and hyphens
#       (e.g. `#titulo-de-seccion`).
# These are made an EXPLICIT structural carve-out. The shapes are gate-safe by CONSTRUCTION:
# they contain NO uppercase and NO digits and are hyphen-separated lowercase chunks, so NO
# realistic base62/mixed-case/digit-bearing key can take this shape -- the carve-out cannot
# excuse a real key. NOTE the prompt's third shape (c) "pure camelCase identifier" is ALREADY
# handled, more safely, by `_looks_like_code_identifier` above (a naive `^[A-Za-z]+$` allowlist
# would WEAKEN the scanner: it would excuse a 40-char letters-only digit-free RANDOM run, which
# the scanner catches today -- see meta/cache/_A8-allowlist-fork-analysis-2026-06-21.md), so (c)
# is NOT broadened here. The explicit high-confidence _PATTERNS are UNTOUCHED -- they still fire
# everywhere, so a real sk-/ghp_/AKIA key is caught regardless of any surrounding slug text.
_LOWERCASE_HYPHEN_SLUG = re.compile(r"^[a-z]+(?:-[a-z]+)+$")        # (a) word-de-word, lowercase only
_LOWERCASE_HYPHEN_ANCHOR = re.compile(r"^#[a-z]+(?:-[a-z]+)+$")     # (b) #word-de-word anchor


def _looks_like_lowercase_slug_or_anchor(tok: str) -> bool:
    """True if `tok` is a filename slug (only lowercase letters + hyphens, e.g.
    `nombre-de-archivo`) or a markdown anchor (a leading `#` then the same shape, e.g.
    `#titulo-de-seccion`). Gate-safe: no uppercase, no digit, hyphen-separated lowercase
    chunks -- a real base62/mixed-case/digit-bearing key cannot match, so this never excuses
    a real key. The explicit high-confidence _PATTERNS are unaffected."""
    return bool(_LOWERCASE_HYPHEN_SLUG.match(tok) or _LOWERCASE_HYPHEN_ANCHOR.match(tok))


# URLs: any candidate token that lies INSIDE an http(s):// or www. URL is a path
# segment / slug, not a secret, so it is excluded from the generic heuristic. (The
# specific high-confidence patterns are unaffected -- they still fire everywhere.)
_URL_SPAN = re.compile(r"(?:https?://|www\.)\S+")

# Markdown doc-link DESTINATIONS: a token inside a markdown inline link target
# `](dest)` is a relative path / anchor slug (e.g. `meta/roadmap.md#b1-status-...`),
# not a secret. This is the SIBLING of the URL exclusion above: a `#`-anchor heading
# slug or relative file path is the same "path/slug, not a key" category, it just
# isn't written as an absolute http(s):// URL. We scope the exclusion to link targets
# that are genuine DOC REFERENCES -- the destination must carry a `#` anchor, a `/`
# path separator, or a `.ext` file extension -- so a bare `](randomtoken)` wrapper does
# NOT get a free pass (keeps the weakening surface as narrow as the existing URL leg).
# The specific high-confidence _PATTERNS are UNAFFECTED: they still fire everywhere,
# including inside a link, so a real sk-/ghp_/AKIA key wrapped in `](...)` is still caught.
_MD_LINK_DEST = re.compile(r"\]\(([^)\s]+)\)")
_DOCREF_HINT = re.compile(r"[#/]|\.[A-Za-z]{1,5}(?:\b|$)")


def shannon_entropy(s: str) -> float:
    """Shannon entropy in bits per character."""
    if not s:
        return 0.0
    counts: dict[str, int] = {}
    for ch in s:
        counts[ch] = counts.get(ch, 0) + 1
    n = len(s)
    ent = 0.0
    for c in counts.values():
        p = c / n
        ent -= p * math.log2(p)
    return ent


def _looks_like_secret_run(run: str) -> bool:
    """High-entropy heuristic for ONE continuous run (no slug separators in it).
    True only if the run is long AND high-entropy AND mixes character classes (to
    skip long hex hashes / base-only ids that are usually not secrets but reduce
    noise)."""
    if len(run) < _MIN_SECRET_RUN:
        return False
    # PROPOSED REFINEMENT: a long camelCase/PascalCase code identifier is one continuous
    # high-entropy run, so it would otherwise be flagged. It is digit-free dictionary words
    # concatenated at case boundaries, NOT a key -- exclude it. Digit-bearing runs (i.e.
    # every realistic base62 key) are never excluded here (see _looks_like_code_identifier).
    if _looks_like_code_identifier(run):
        return False
    if shannon_entropy(run) < _ENTROPY_THRESHOLD:
        return False
    has_lower = any(c.islower() for c in run)
    has_upper = any(c.isupper() for c in run)
    has_digit = any(c.isdigit() for c in run)
    # Require at least two of {lower, upper, digit} -> skips pure-hex hashes and
    # all-uppercase constants, which dominate false positives.
    classes = sum([has_lower, has_upper, has_digit])
    return classes >= 2


def _looks_like_chunked_key(tok: str) -> bool:
    """True only if `tok` looks like a GROUPED/CHUNKED random key (e.g.
    `Xa8K-9Lm2-Qx7z-Wp3R-7bNq-Td4V`), as opposed to a multi-word filename/date slug that
    merely happens to carry a short version-suffix chunk (`fable5`, `wave4`, `v2`).

    Discriminator (all three required): the letter+digit-MIXED chunks must
      (1) number at least `_MIN_CHUNKED_MIXED_GROUPS` (a real key has several groups),
      (2) be a MAJORITY of the alnum chunks (a key is mostly random groups; a slug is
          mostly pure-word / pure-date chunks with at most one or two mixed), and
      (3) average at least `_MIN_CHUNKED_MIXED_AVGLEN` chars (base62 groups are a few
          chars; `v2`/`p14`/`p15`-style version chunks are too short).
    This replaces the old "any single mixed chunk" gate, which an innocent `word+digit`
    filename chunk satisfied. It is a strict TIGHTENING -- it only ever returns True for a
    SUBSET of what the old gate accepted, so no real-key catch is lost (single-run keys are
    still caught by the per-run leg and the explicit _PATTERNS)."""
    chunks = [c for c in _SLUG_SEPARATORS.split(tok) if c]
    alnum = [c for c in chunks if c.isalnum()]
    if not alnum:
        return False
    mixed = [
        c for c in alnum
        if any(ch.isdigit() for ch in c) and any(ch.isalpha() for ch in c)
    ]
    if len(mixed) < _MIN_CHUNKED_MIXED_GROUPS:
        return False
    if len(mixed) < (len(alnum) + 1) // 2:  # must be a majority of alnum chunks
        return False
    avg_len = sum(len(c) for c in mixed) / len(mixed)
    return avg_len >= _MIN_CHUNKED_MIXED_AVGLEN


def _looks_like_secret_token(tok: str) -> bool:
    """High-entropy heuristic for an UNKNOWN-shape secret. A real secret is a single
    CONTINUOUS high-entropy run, so we test the token's longest run between slug
    separators (- _ .), not the whole separator-joined string. A word-slug / doc
    title (e.g. `openai-removed-hard-budget-limits`) clears the length bar only by
    concatenating short words with separators; its longest continuous run is short,
    so it is correctly NOT flagged, while a genuine key (one long random run) is.

    SECONDLY, to catch GROUPED-FORMAT keys (e.g. `8-8-8-8` / `8_8_8_8` chunked keys
    whose individual runs are each < the 32-char single-run minimum), we ALSO run the
    same high-entropy test on the WHOLE token with the separators stripped, but ONLY
    when that stripped length is large. The stripped test reuses `_looks_like_secret_run`
    verbatim, so it inherits the SAME entropy (>= 4.0) AND >=2-char-class guards: a
    word-slug stripped to one string is low-entropy / single-class (dictionary letters),
    so it stays NOT flagged, while a chunked random key (high entropy, mixed classes) is."""
    # A8 EXPLICIT CARVE-OUT (CEO go 2026-06-21): a lowercase-letters+hyphens filename slug
    # or a `#`-prefixed lowercase-letters+hyphens markdown anchor is never a secret. Gate-safe
    # by construction (no uppercase, no digit) -- a real key cannot match. (Note: the leading
    # `#` of an anchor is stripped by _GENERIC_TOKEN's char class before this point, so the
    # slug regex already covers both; the anchor regex covers a `#...` token passed directly.)
    if _looks_like_lowercase_slug_or_anchor(tok):
        return False
    if any(_looks_like_secret_run(run) for run in _SLUG_SEPARATORS.split(tok)):
        return True
    # Grouped-format catch: entropy-test the whole stripped token when it is long --
    # but ONLY when the token actually looks like a CHUNKED KEY, not a multi-word
    # filename/doc slug. Discriminator: a real chunked key's groups are random base62,
    # so at least one group MIXES a letter AND a digit (e.g. `a8Kf`); a word/date slug
    # splits into all-alpha word chunks + all-numeric date chunks, where NO single chunk
    # mixes letter+digit (e.g. `finder-corporate-prereg-FULL-2026-06-12`). Requiring
    # >=1 letter+digit-mixed chunk removes the dated-filename-slug false-positive class
    # WITHOUT weakening real-key catching: single-run keys are still caught by the
    # per-run leg above and by the explicit _PATTERNS; a real >=8-char-group chunked key
    # has a letter+digit-mixed group with ~99.5% probability across 4 groups.
    # PROPOSED REFINEMENT: only run the grouped/stripped leg when the token actually looks
    # like a CHUNKED KEY (mixed groups dominate), not a filename/date slug carrying one short
    # version chunk. `_looks_like_chunked_key` is a strict tightening of the old
    # "any one mixed chunk" gate -- see its docstring + the module-level note.
    if _looks_like_chunked_key(tok):
        stripped = _SLUG_SEPARATORS.sub("", tok)
        if len(stripped) >= _MIN_SECRET_RUN and _looks_like_secret_run(stripped):
            return True
    return False


def scan_text(text: str, path: str = "") -> list[tuple[str, str]]:
    """Return a list of (pattern_name, redacted_preview) findings for `text`.
    The preview is REDACTED -- we never echo the full secret in our own output.

    `path` is OPTIONAL and defaults to "" (path unknown). It feeds EXACTLY ONE thing: the
    npm/yarn lockfile SRI-digest carve-out (2026-09-04). With no path the carve-out is inert
    and behaviour is byte-for-byte what it was before, which is why every pre-existing caller
    that passes only `text` is unaffected."""
    findings: list[tuple[str, str]] = []
    explicit_spans: list[tuple[int, int]] = []
    # npm/yarn SRI digest value spans -- EMPTY for every filename except the lockfile names.
    integrity_spans = _integrity_digest_spans(path, text)
    patterns = _patterns_for(text)   # CANDIDATE7 (A2): exact prefilter, see _patterns_for
    for name, rx in patterns:
        for m in rx.finditer(text):
            findings.append((name, _redact(m.group(0), text, m.start())))
            explicit_spans.append(m.span())
    # Spans covered by http(s):// or www. URLs -- tokens inside these are path
    # slugs, not secrets, and are excluded from the generic heuristic only.
    url_spans = [m.span() for m in _URL_SPAN.finditer(text)]
    # Spans covered by a markdown doc-link DESTINATION `](dest)` whose dest is a doc
    # reference (has a #anchor / path / .ext) -- tokens inside are path/anchor slugs,
    # not secrets. Same "path slug, not a key" category as URLs; generic heuristic only.
    md_link_spans = [
        m.span(1) for m in _MD_LINK_DEST.finditer(text)
        if _DOCREF_HINT.search(m.group(1))
    ]
    slug_skip_spans = url_spans + md_link_spans
    # CANDIDATE4 precision carve-outs: a heuristic-leg token is stood down ONLY when it lies
    # WHOLLY inside one of these spans (never on mere overlap, so a secret glued to the edge of
    # one is still judged). Explicit patterns above already ran over the whole text regardless.
    carve_spans = []   # CANDIDATE5 (A4): the fixture-JWT carve-out is gone; data-URI images only
    for span, raw in _data_uri_image_payloads(text):
        carve_spans.append(span)
        for name, preview in _scan_blob(raw, path, 1, None):
            findings.append(("data-uri:" + name, preview + " (inside a data-URI image at line %d)"
                             % (text.count("\n", 0, span[0]) + 1)))
    # Generic high-entropy pass (skip anything already flagged to avoid dup noise).
    generic_spans: list[tuple[int, int]] = []
    for m in _GENERIC_TOKEN.finditer(text):
        tok = m.group(0)
        if any(rx.search(tok) for _, rx in patterns):   # tok is a substring of text: exact
            continue
        ts, te = m.span()
        if any(ts < ue and us < te for us, ue in slug_skip_spans):
            continue  # token lies inside a URL or md doc-link -> a path/anchor slug, not a secret
        if any(us <= ts and te <= ue for us, ue in carve_spans):
            continue  # wholly inside a verified data-URI image
        if _inside_integrity((ts, te), integrity_spans):
            # npm/yarn SRI digest value in a lockfile -> a PUBLIC tarball content hash. Only
            # the HEURISTIC legs stand down here; the explicit _PATTERNS above are never
            # span-filtered, so a real key hidden in a lockfile is still caught. (2026-09-04)
            continue
        # DEDUP (added 2026-08-30): an explicit pattern is allowed to be CONTEXTUAL (the
        # aws-secret one matches `<identifier><sep><value>`), so the value's own token does not
        # itself contain the pattern and the `rx.search(tok)` test above cannot see it. Skipping
        # generic tokens that OVERLAP an explicit finding keeps one secret from being reported
        # twice. This CANNOT change the exit code: an overlapping span means an explicit finding
        # was already appended, so `any_found` is already true either way.
        if any(ts < ue and us < te for us, ue in explicit_spans):
            continue
        if _looks_like_secret_token(tok):
            findings.append(("generic-high-entropy", _redact(tok, text, m.start())))
            generic_spans.append(m.span())
    # BASE64 PAYLOAD PASS (added 2026-08-30): the blind-spot leg. Candidates over the full
    # base64 alphabet, minus anything a URL/doc-link exclusion or an earlier pass already
    # accounted for. See `_looks_like_base64_secret` for why this cannot double-count the
    # generic leg (it requires a `+`, `/` or `=`, which the generic class cannot contain).
    already_spans = explicit_spans + generic_spans
    for m in _B64_TOKEN.finditer(text):
        tok = m.group(0)
        ts, te = m.span()
        if any(ts < ue and us < te for us, ue in slug_skip_spans):
            continue  # inside a URL or md doc-link -> a path, not a secret
        if any(us <= ts and te <= ue for us, ue in carve_spans):
            continue  # wholly inside a verified data-URI image
        if any(ts < ue and us < te for us, ue in already_spans):
            continue  # already reported by an explicit pattern or the generic leg
        if _inside_integrity((ts, te), integrity_spans):
            continue  # npm/yarn SRI digest value -> a public content hash (2026-09-04)
        if _looks_like_base64_secret(tok):
            findings.append(("base64-high-entropy", _redact(tok, text, m.start())))
    return findings


def _redact(secret: str, text: str | None = None, pos: int | None = None) -> str:
    """CANDIDATE4: NEVER any byte of the value -- only its length and, when known, its line.
    (Was: the first 4 characters + the length; four characters of a generic token are four
    characters of the secret.) The rule name travels separately in the finding tuple."""
    loc = "" if text is None or pos is None else ", line %d" % (text.count("\n", 0, pos) + 1)
    return f"<redacted, len={len(secret)}{loc}>"


# --- CANDIDATE4 PRECISION CARVE-OUT HELPERS (2026-09-24) ---------------------------------
# (a) data-URI images. The payload must decode STRICTLY and be a structurally complete image of
#     the DECLARED format: leading magic AND the format's trailer (PNG IEND chunk, JPEG EOI, GIF
#     trailer, WEBP RIFF length, SVG closing tag). A secret pasted after the prefix does not
#     decode to such an image, so it is still judged by every leg.
_DATA_URI_IMAGE = re.compile(
    r"data:image/(png|jpeg|jpg|gif|webp|svg\+xml);base64,([A-Za-z0-9+/]{16,}={0,2})")


def _is_complete_image(fmt: str, raw: bytes) -> bool:
    if fmt == "png":
        return raw.startswith(b"\x89PNG\r\n\x1a\n") and raw.endswith(b"IEND\xaeB`\x82")
    if fmt in ("jpeg", "jpg"):
        return raw.startswith(b"\xff\xd8\xff") and raw.rstrip(b"\x00").endswith(b"\xff\xd9")
    if fmt == "gif":
        return raw[:6] in (b"GIF87a", b"GIF89a") and raw.endswith(b"\x3b")
    if fmt == "webp":
        return (raw[:4] == b"RIFF" and raw[8:12] == b"WEBP"
                and int.from_bytes(raw[4:8], "little") + 8 == len(raw))
    if fmt == "svg+xml":
        s = raw.strip()
        return s.startswith((b"<svg", b"<?xml")) and s.endswith(b"</svg>")
    return False


def _data_uri_image_payloads(text: str) -> list:
    """[(payload_span, decoded_bytes)] for every data-URI image that passes `_is_complete_image`."""
    out = []
    for m in _DATA_URI_IMAGE.finditer(text):
        try:
            raw = base64.b64decode(m.group(2), validate=True)
        except (binascii.Error, ValueError):
            continue
        if _is_complete_image(m.group(1), raw):
            out.append((m.span(2), raw))
    return out


# (b) CANDIDATE5 (A4): candidate4's `"fixture": true` JWT carve-out was REMOVED here. The
#     signature segment is unverified, so any writer could wrap an arbitrary secret in a JWT
#     that labels itself a fixture -- a self-minted in-content marker, which dec-140 refuses.
# --- END CANDIDATE4 PRECISION CARVE-OUT HELPERS -------------------------------------------


# ===========================================================================================
# BYTE-LEVEL DETECTOR (2026-09-23) -- the remedy dec-140 chose INSTEAD of a decode carve-out.
# ===========================================================================================
# WHAT IT REPLACES. Before this block, a file whose bytes are not valid UTF-8 was handled two
# incompatible ways: the COMMIT path named it and exited 2 (fail closed, correct), while AUDIT
# mode (--paths/--all) skipped it in silence and exited 0 -- a scanner reporting a clean sweep
# over files it never opened. Both are now the same path: the bytes ARE READ AND SCANNED.
# WHY THIS IS NOT A CARVE-OUT. Nothing is exempted by extension, by name or by size. Every byte
# of the file is examined; what changes is the ALPHABET the detector works over.
# WHAT IT LOOKS FOR, and why each leg cannot fire on ordinary binary noise:
#   (1) DER private-key STRUCTURE. A PKCS#8 PrivateKeyInfo opens `30 82 LL LL 02 01 00 30`:
#       six fixed bytes out of eight, i.e. ~1 in 2^48 per offset by chance. Same for PKCS#1,
#       SEC1 EC and PKCS#12. These are near-zero-FP structural signatures, not heuristics.
#   (2) KEYSTORE CONTAINER MAGIC (JKS 0xFEEDFEED, JCEKS 0xCECECECE, OpenSSH `openssh-key-v1`,
#       PuTTY `PuTTY-User-Key-File-`). A file in one of these formats IS key material; the
#       magic is the finding and no entropy test is needed.
#   (3) PEM BLOCKS IN ANY ENCODING. The ASCII marker is also searched in its UTF-16LE and
#       UTF-16BE forms, which is how a PEM key pasted into a wide-encoded file is caught.
#   (4) AN EXPLICIT-PATTERN PASS OVER EXTRACTED STRINGS. Printable runs are pulled out of the
#       raw bytes and out of both NUL-stripped wide-encoding views, then run through the
#       EXPLICIT `_PATTERNS` only.
# DELIBERATELY NOT DONE, and this is a real coverage limit, not an oversight: the HEURISTIC
# legs (generic-high-entropy, base64-high-entropy) are NOT run over extracted binary strings.
# Compiled artefacts, images and compressed streams are high-entropy BY CONSTRUCTION, so those
# legs would fire on essentially every binary and the detector would be turned off within a
# day. Consequence to state plainly: an UNKNOWN-SHAPE secret with no structural marker and no
# recognisable context identifier, sitting inside a binary, is still NOT caught. Compressed or
# encrypted containers (a key inside a .zip/.7z) are likewise out of reach.


def _widen(marker: bytes, little: bool) -> bytes:
    """The UTF-16 form of an ASCII marker (each byte followed/preceded by a NUL)."""
    return b"".join((bytes([c]) + b"\x00") if little else (b"\x00" + bytes([c]))
                    for c in marker)


_BYTE_STRUCT_MARKERS = [
    ("pem-private-key-block", b"-----BEGIN RSA PRIVATE KEY"),
    ("pem-private-key-block", b"-----BEGIN PRIVATE KEY"),
    ("pem-private-key-block", b"-----BEGIN EC PRIVATE KEY"),
    ("pem-private-key-block", b"-----BEGIN DSA PRIVATE KEY"),
    ("pem-private-key-block", b"-----BEGIN OPENSSH PRIVATE KEY"),
    ("pem-private-key-block", b"-----BEGIN ENCRYPTED PRIVATE KEY"),
    ("pem-private-key-block", b"-----BEGIN PGP PRIVATE KEY BLOCK"),
    ("pem-private-key-block", b"-----BEGIN ED25519 PRIVATE KEY"),
    ("pem-private-key-block", b"-----BEGIN X25519 PRIVATE KEY"),
    ("pem-private-key-block", b"-----BEGIN SSH2 ENCRYPTED PRIVATE KEY"),
    ("openssh-private-key-container", b"openssh-key-v1\x00"),
    ("putty-private-key-container", b"PuTTY-User-Key-File-"),
    ("jks-keystore-container", b"\xfe\xed\xfe\xed"),
    ("jceks-keystore-container", b"\xce\xce\xce\xce"),
]
# ...plus every PEM marker again in both UTF-16 byte orders (that is leg 3).
for _n, _m in list(_BYTE_STRUCT_MARKERS):
    if _m.startswith(b"-----BEGIN"):
        _BYTE_STRUCT_MARKERS.append((_n + "-utf16le", _widen(_m, True)))
        _BYTE_STRUCT_MARKERS.append((_n + "-utf16be", _widen(_m, False)))

_DER_SIGNATURES = [
    # name, regex over raw bytes. `.` with DOTALL is any byte and stands for a length octet.
    ("der-pkcs8-private-key", re.compile(rb"\x30\x82..\x02\x01\x00\x30", re.S)),
    ("der-pkcs8-private-key", re.compile(rb"\x30\x81.\x02\x01\x00\x30", re.S)),
    ("der-pkcs1-rsa-private-key", re.compile(rb"\x30\x82..\x02\x01\x00\x02\x82", re.S)),
    ("der-sec1-ec-private-key", re.compile(rb"\x30.\x02\x01\x01\x04\x20", re.S)),
    ("der-sec1-ec-private-key", re.compile(rb"\x30\x81.\x02\x01\x01\x04\x20", re.S)),
    ("der-pkcs12-keystore", re.compile(rb"\x30\x82..\x02\x01\x03\x30", re.S)),
    ("der-ed25519-private-key",
     re.compile(rb"\x30\x2e\x02\x01\x00\x30\x05\x06\x03\x2b\x65\x70", re.S)),
]

_PRINTABLE_RUN = re.compile(rb"[\x20-\x7e]{6,}")


def _extracted_strings(data: bytes) -> str:
    """Printable ASCII runs from three views of the bytes: as-is, and with the NULs of a
    UTF-16LE and a UTF-16BE layout removed. Joined with newlines so line-anchored patterns
    behave. Never returned to a caller or printed -- only fed to the explicit patterns."""
    views = [data, data[0::2] if len(data) > 1 else b"", data[1::2] if len(data) > 1 else b""]
    out = []
    for v in views:
        out.extend(m.group(0).decode("ascii", "replace") for m in _PRINTABLE_RUN.finditer(v))
    return "\n".join(out)


def _scan_explicit(text: str) -> list:
    """The EXPLICIT `_PATTERNS` only -- no entropy heuristics. Used on binary-extracted
    strings, where entropy is meaningless."""
    return [(name, _redact(m.group(0)) + " (in extracted printable strings)")
            for name, rx in _patterns_for(text) for m in rx.finditer(text)]


class _Unscannable(Exception):
    """CANDIDATE4: raised when content is recognised but cannot be fully examined (encrypted,
    corrupt or oversized container). main() turns it into an UNSCANNABLE line and exit 2."""


_MAX_INFLATE_TOTAL = 64 * 1024 * 1024   # per top-level file, across every nested container
_MAX_CONTAINER_DEPTH = 3
_PDF_STREAM_KW = re.compile(rb"(?<!end)stream\r?\n")   # never the tail of `endstream`


def _take(budget: list, n: int, what: str) -> None:
    if n > budget[0]:
        raise _Unscannable("%s inflates past the %d-byte cap" % (what, _MAX_INFLATE_TOTAL))
    budget[0] -= n


def _inflate_capped(data: bytes, wbits: int, budget: list, what: str) -> tuple:
    d = zlib.decompressobj(wbits)
    try:
        out = d.decompress(data, budget[0] + 1)
    except zlib.error as e:
        raise _Unscannable("%s could not be inflated (%s)" % (what, e))
    _take(budget, len(out), what)
    if d.unconsumed_tail:
        raise _Unscannable("%s inflates past the %d-byte cap" % (what, _MAX_INFLATE_TOTAL))
    if not d.eof:
        # zlib does NOT raise on a truncated stream; it returns what it could. A stream that
        # never reached its end marker was not fully read, so it cannot be called clean.
        raise _Unscannable("%s is truncated (no end-of-stream marker)" % what)
    return out, d.unused_data


# CANDIDATE5 (A1): formats this scanner RECOGNISES but does not open. Detected on the BYTES,
# never on the file name. The long magics (6+ fixed bytes, ~1 in 2^48 per offset by chance)
# are searched ANYWHERE, so one appended after an image header is still seen; the 4-byte
# ones only at offset 0. Finding one is exit 2 ("container not supported"), never clean.
_UNSUPPORTED_ANYWHERE = [
    ("7z archive", re.compile(rb"7z\xbc\xaf\x27\x1c")),
    ("xz stream", re.compile(rb"\xfd7zXZ\x00")),
    ("RAR archive", re.compile(rb"Rar!\x1a\x07[\x00\x01]")),
    ("bzip2 stream", re.compile(rb"BZh[1-9](?:1AY&SY|\x17rE8P\x90)")),
    ("CAB archive", re.compile(rb"MSCF\x00\x00\x00\x00")),
]
_UNSUPPORTED_AT_0 = [("zstd frame", b"\x28\xb5\x2f\xfd"), ("lz4 frame", b"\x04\x22\x4d\x18")]
_ZIP_EOCD = b"PK\x05\x06\x00\x00\x00\x00"   # end-of-central-directory, single-disk


def _unsupported_container(data: bytes):
    for name, magic in _UNSUPPORTED_AT_0:
        if data[:len(magic)] == magic:
            return name, 0
    for name, rx in _UNSUPPORTED_ANYWHERE:
        m = rx.search(data)
        if m:
            return name, m.start()
    return None


def _container_kinds(data: bytes) -> list:
    """The SUPPORTED container kinds this blob is (it can be several: a PDF with an embedded
    stored ZIP is both)."""
    kinds = []
    if data[:2] == b"\x1f\x8b":
        kinds.append("gzip")
    if data[257:262] == b"ustar":
        kinds.append("tar")
    if data[:4] == b"PK\x03\x04" or data.rfind(_ZIP_EOCD) >= 0:
        kinds.append("ZIP")
    if data[:5] == b"%PDF-":
        kinds.append("PDF")
    if data[:8] == _PNG_SIG:
        kinds.append("PNG")
    return kinds


# PDF text operands: literal strings `( ... )` (one level of balanced parens) and hex strings
# `< ... >` (never the `<<` of a dictionary), in content-stream order.
_PDF_STRING = re.compile(
    rb"\(((?:\\.|[^\\()]|\((?:\\.|[^\\()])*\))*)\)|(?<!<)<([0-9A-Fa-f\s]{2,})>(?!>)", re.S)
_PDF_ESC = {b"n": b"\n", b"r": b"\r", b"t": b"\t", b"b": b"\b", b"f": b"\f",
            b"(": b"(", b")": b")", b"\\": b"\\"}


def _pdf_unescape(s: bytes) -> bytes:
    out, i = bytearray(), 0
    while i < len(s):
        c = s[i:i + 1]
        if c != b"\\":
            out += c
            i += 1
            continue
        nxt = s[i + 1:i + 2]
        if nxt in _PDF_ESC:
            out += _PDF_ESC[nxt]
            i += 2
        elif nxt in (b"\r", b"\n"):          # backslash-newline: a line continuation
            i += 2 + (nxt == b"\r" and s[i + 2:i + 3] == b"\n")
        elif nxt.isdigit():
            j = i + 1
            while j < len(s) and j < i + 4 and s[j:j + 1] in b"01234567":
                j += 1
            out.append(int(s[i + 1:j] or b"0", 8) & 0xFF)
            i = max(j, i + 2)
        else:
            i += 1
    return bytes(out)


def _pdf_text_segments(stream: bytes) -> list:
    segs = []
    for m in _PDF_STRING.finditer(stream):
        if m.group(1) is not None:
            segs.append(_pdf_unescape(m.group(1)))
        else:
            h = re.sub(rb"\s", b"", m.group(2))
            try:
                segs.append(bytes.fromhex((h + b"0" * (len(h) % 2)).decode("ascii")))
            except ValueError:
                pass
    return segs


# The joined PDF view is fed to these explicit patterns only. `openai-legacy-key` (a bare
# `sk-` + 20 alnum) is left out ON PURPOSE: joining text runs with no separator turns a
# hyphenated `risk-` + `management...` into exactly that shape.
_PDF_JOIN_EXCLUDED = frozenset({"openai-legacy-key"})


_PNG_SIG = b"\x89PNG\r\n\x1a\n"

# CANDIDATE6 (A1): PDF stream filters. The /Filter value is a name or an array of names, applied
# in order. Abbreviated names (inline-image style) are accepted by readers, so they are mapped.
_PDF_FILTER_VALUE = re.compile(rb"/Filter\s*(\[[^\]]*\]|/[^\s/\[\]<>()]+)")
_PDF_NAME = re.compile(rb"/([^\s/\[\]<>()]+)")
_PDF_FILTER_ALIASES = {b"AHx": b"ASCIIHexDecode", b"A85": b"ASCII85Decode", b"Fl": b"FlateDecode",
                       b"LZW": b"LZWDecode", b"RL": b"RunLengthDecode", b"CCF": b"CCITTFaxDecode",
                       b"DCT": b"DCTDecode"}
# Image codecs: what they wrap is pixel data, never text operands. The file's raw bytes are
# still under the whole-file string pass; the DECODED pixels are not scanned (stated limit).
_PDF_IMAGE_FILTERS = frozenset({b"DCTDecode", b"JPXDecode", b"JBIG2Decode", b"CCITTFaxDecode"})


def _pdf_filters(dic: bytes):
    """[filter names] of a stream dictionary; [] when it has no /Filter; None when a /Filter key
    is present but its value cannot be read (an indirect reference, a malformed value)."""
    if b"/Filter" not in dic:
        return []
    m = _PDF_FILTER_VALUE.search(dic)
    if not m:
        return None
    names = [_PDF_FILTER_ALIASES.get(n, n) for n in _PDF_NAME.findall(m.group(1))]
    return names or None


def _pdf_ahx(raw: bytes, what: str) -> bytes:
    h = re.sub(rb"\s", b"", raw.split(b">", 1)[0])
    if h.startswith(b"<"):
        h = h[1:]
    try:
        return binascii.unhexlify(h + b"0" * (len(h) % 2))
    except (binascii.Error, ValueError) as e:
        raise _Unscannable("%s is not valid /ASCIIHexDecode data (%s)" % (what, e))


def _pdf_a85(raw: bytes, what: str) -> bytes:
    a = re.sub(rb"\s", b"", raw)
    if a.startswith(b"<~"):
        a = a[2:]
    a = a.split(b"~>", 1)[0]
    try:
        return base64.a85decode(a)
    except (binascii.Error, ValueError) as e:
        raise _Unscannable("%s is not valid /ASCII85Decode data (%s)" % (what, e))


def _pdf_decode(raw: bytes, filters: list, budget: list, what: str):
    """Decoded stream bytes, or None for an image codec. Raises _Unscannable for any filter this
    scanner does not decode -- a stream that was not read is never reported clean."""
    buf = raw
    for f in filters:
        if f == b"FlateDecode":
            buf, _ = _inflate_capped(buf, zlib.MAX_WBITS, budget, what)
        elif f == b"ASCIIHexDecode":
            buf = _pdf_ahx(buf, what)
            _take(budget, len(buf), what)
        elif f == b"ASCII85Decode":
            buf = _pdf_a85(buf, what)
            _take(budget, len(buf), what)
        elif f in _PDF_IMAGE_FILTERS:
            return None
        else:
            raise _Unscannable("container not supported: %s uses the /%s filter, which this scanner "
                               "does not decode" % (what, f.decode("latin-1", "replace")))
    return buf


def _png_text_chunks(data: bytes, budget: list) -> list:
    """CANDIDATE6 (A2): [(label, text bytes)] for every tEXt, zTXt and iTXt chunk. Walks the chunk
    list (each step advances >= 12 bytes, so the walk is bounded by the file size); a truncated
    chunk ends the walk (its bytes stay under the whole-file string pass)."""
    out, pos = [], 8
    while pos + 12 <= len(data):
        n = int.from_bytes(data[pos:pos + 4], "big")
        ctype = data[pos + 4:pos + 8]
        if pos + 12 + n > len(data):
            break
        body = data[pos + 8:pos + 8 + n]
        what = "PNG %s chunk at byte offset %d" % (ctype.decode("latin-1", "replace"), pos)
        if ctype == b"tEXt":
            out.append((what, body.replace(b"\x00", b"\n")))
        elif ctype == b"zTXt":
            kw, _, rest = body.partition(b"\x00")
            if rest[:1] != b"\x00":
                raise _Unscannable("%s uses an unknown compression method" % what)
            text, _ = _inflate_capped(rest[1:], zlib.MAX_WBITS, budget, what)
            out.append((what, kw + b"\n" + text))
        elif ctype == b"iTXt":
            kw, _, rest = body.partition(b"\x00")
            flag, method = rest[:1], rest[1:2]
            lang, _, rest2 = rest[2:].partition(b"\x00")
            tkw, _, text = rest2.partition(b"\x00")
            if flag == b"\x01":
                if method != b"\x00":
                    raise _Unscannable("%s uses an unknown compression method" % what)
                text, _ = _inflate_capped(text, zlib.MAX_WBITS, budget, what)
            out.append((what, b"\n".join((kw, lang, tkw, text))))
        elif ctype == b"IEND":
            break
        pos += 12 + n
    return out


# CANDIDATE6 (A3): compressed streams at ANY offset. gzip: magic, CM=8, FLG reserved bits clear.
# zlib: CMF 0x78 (32 KiB window, what zlib emits) + the four FLG bytes with FDICT clear.
_COMPRESSED_PROBE = re.compile(rb"\x1f\x8b\x08[\x00-\x1f]|\x78[\x01\x5e\x9c\xda]")
_MAX_PROBE_ATTEMPTS = 200_000
_MAX_PROBE_MEMBERS = 64
# CANDIDATE7: the bounds (see the CANDIDATE7 docstring section).
_GZIP_SANE_XFL = frozenset((0, 2, 4))
_GZIP_SANE_OS = frozenset(range(20)) | {255}   # RFC 1952 codes 0-13 + zlib 16-19 (19 = macOS)
_PROBE_IN_SLICE = 64 * 1024        # input handed to one decompress call
_PROBE_ZLIB_CAP = 256 * 1024       # output a zlib candidate may produce before it must be text
_MAX_PROBE_PER_MIB = 4096          # inflated candidates in any one MiB of the blob


def _probe_stream(mv, off: int, gz: bool, budget: list, what: str):
    """CANDIDATE7: inflate ONE candidate, feeding the input in _PROBE_IN_SLICE slices (a failing
    call costs time in proportion to the input it was handed). Returns (inflated, end offset) for
    a stream that reached its end marker -- zlib verifies the checksum -- or None for "not a
    stream here". A gzip candidate, or a zlib one that proved to be text, still inflating when the
    shared budget runs out is a real stream: that is exit 2."""
    d = zlib.decompressobj(16 + zlib.MAX_WBITS if gz else zlib.MAX_WBITS)
    limit = budget[0] if gz else min(_PROBE_ZLIB_CAP, budget[0])
    extended = gz
    parts, n, pos, tail = [], 0, off, b""
    while True:
        if tail:
            piece, tail = tail, b""
        else:
            piece = mv[pos:pos + _PROBE_IN_SLICE]
            if not piece:
                return None            # input ended before the end marker: truncated / not a stream
            pos += len(piece)
        try:
            res = d.decompress(piece, limit - n + 1)
        except zlib.error:
            return None
        parts.append(res)
        n += len(res)
        if d.eof:
            return (b"".join(parts) if n else None), pos - len(d.unused_data)
        tail = d.unconsumed_tail
        if n > limit or tail:
            if extended:
                raise _Unscannable("%s inflates past the %d-byte cap" % (what, _MAX_INFLATE_TOTAL))
            head = b"".join(parts)
            if not _looks_like_single_byte_text(head[:_PROBE_ZLIB_CAP]):
                return None            # (b) cap reached, no end marker, not text: not a stream here
            parts, limit, extended = [head], budget[0], True


def _probe_compressed(data: bytes, budget: list, skip_offset_0: bool) -> list:
    """[(label, inflated bytes)] for every gzip member / zlib stream that inflates to its END
    MARKER with a valid checksum. A candidate that fails is not a stream (random bytes match a
    2-byte zlib header ~64 times per MiB). CANDIDATE7 bounds: sane gzip header before any inflate;
    bounded input per call and bounded zlib output (_probe_stream); per-MiB and per-blob candidate
    caps. Candidates inside an already-inflated stream are skipped."""
    out, attempts, covered = [], 0, 0
    mib, in_mib = -1, 0
    mv = memoryview(data)
    for m in _COMPRESSED_PROBE.finditer(data):
        off = m.start()
        if off < covered or (off == 0 and skip_offset_0):
            continue
        gz = data[off] == 0x1f
        if gz:
            if (off + 10 > len(data) or data[off + 8] not in _GZIP_SANE_XFL
                    or data[off + 9] not in _GZIP_SANE_OS):
                continue               # (a) not a full sane gzip header: never inflated
        elif ((data[off] << 8) | data[off + 1]) % 31:
            continue                   # (a) FCHECK (the pattern already lists only passing FLG bytes)
        attempts += 1
        if attempts > _MAX_PROBE_ATTEMPTS:
            raise _Unscannable("container not scannable: more than %d compressed-stream candidates "
                               "(gzip/zlib headers) to probe" % _MAX_PROBE_ATTEMPTS)
        if off >> 20 != mib:
            mib, in_mib = off >> 20, 0
        in_mib += 1
        if in_mib > _MAX_PROBE_PER_MIB:
            raise _Unscannable("container not scannable: more than %d compressed-stream candidates "
                               "(gzip/zlib headers) in the MiB at byte offset %d"
                               % (_MAX_PROBE_PER_MIB, mib << 20))
        what = "%s stream at byte offset %d" % ("gzip" if gz else "zlib", off)
        got = _probe_stream(mv, off, gz, budget, what)
        if got is None or got[0] is None:
            continue
        res, covered = got
        _take(budget, len(res), what)
        out.append((what, res))
        if len(out) > _MAX_PROBE_MEMBERS:
            raise _Unscannable("container not scannable: more than %d compressed streams in one "
                               "blob" % _MAX_PROBE_MEMBERS)
    return out

def _container_members(data: bytes, budget: list) -> list:
    """[(label, content)] for a gzip stream, a TAR archive, a ZIP archive (found by its
    end-of-central-directory anywhere, or its local header at offset 0) and a PDF's streams.
    Raises _Unscannable when the container is recognised but cannot be fully opened."""
    out = []
    kinds = _container_kinds(data)
    if "gzip" in kinds:
        rest, n = data, 0
        while rest[:2] == b"\x1f\x8b":
            content, rest = _inflate_capped(rest, 16 + zlib.MAX_WBITS, budget, "gzip member")
            n += 1
            out.append(("gzip member %d" % n, content))
    if "tar" in kinds:
        try:
            tf = tarfile.open(fileobj=io.BytesIO(data), mode="r:")
            for ti in tf.getmembers():
                if not ti.isreg():
                    continue
                fh = tf.extractfile(ti)
                content = fh.read(budget[0] + 1) if fh is not None else b""
                _take(budget, len(content), "TAR member %r" % ti.name)
                out.append(("tar member %r" % ti.name, content))
        except _Unscannable:
            raise
        except (tarfile.TarError, OSError, EOFError, ValueError) as e:
            raise _Unscannable("TAR archive could not be read (%s)" % e.__class__.__name__)
    if "ZIP" in kinds:
        eocd = data.rfind(_ZIP_EOCD)
        view = data
        if eocd >= 0:
            clen = int.from_bytes(data[eocd + 20:eocd + 22], "little")
            view = data[:eocd + 22 + clen]
        try:
            zf = zipfile.ZipFile(io.BytesIO(view))
            infos = zf.infolist()
        except (zipfile.BadZipFile, zipfile.LargeZipFile, ValueError, OSError, EOFError) as e:
            raise _Unscannable("container not scannable: ZIP archive could not be opened (%s)" % e)
        for info in infos:
            if info.is_dir():
                continue
            if info.flag_bits & 0x1:
                raise _Unscannable("container not scannable: ZIP member %r is encrypted" % info.filename)
            try:
                with zf.open(info) as fh:
                    content = fh.read(budget[0] + 1)
            except (zipfile.BadZipFile, NotImplementedError, RuntimeError, zlib.error,
                    OSError, EOFError, ValueError) as e:
                raise _Unscannable("container not scannable: ZIP member %r could not be read (%s)"
                                  % (info.filename, e))
            _take(budget, len(content), "ZIP member %r" % info.filename)
            out.append(("zip member %r" % info.filename, content))
    if "PDF" in kinds:
        segs = []
        for m in _PDF_STREAM_KW.finditer(data):
            start = m.end()
            end = data.find(b"endstream", start)
            if end < 0:
                continue
            obj = data.rfind(b"obj", 0, m.start())
            dic = data[max(obj, 0):m.start()]
            what = "PDF stream at byte offset %d" % start
            filters = _pdf_filters(dic)
            if filters is None:
                raise _Unscannable("container not supported: %s has a /Filter value this scanner "
                                   "cannot read" % what)
            if filters:
                # CANDIDATE6 (A1): candidate5 skipped every non-Flate filter here with a comment
                # claiming the raw bytes were covered -- false for ASCIIHex/ASCII85, whose raw
                # bytes are an encoding of the text. Now: decode, or refuse (see _pdf_decode).
                content = _pdf_decode(data[start:end], filters, budget, what)
                if content is None:
                    continue   # image codec: pixel data, no text operands in it
                out.append((what, content))
            else:
                content = data[start:end]
            segs.extend(_pdf_text_segments(content))
        if segs:
            # CANDIDATE5 (item 7): a key broken across two text lines / two Tj operands, or by a
            # line-end hyphen, is invisible to every line-based leg. Join the operands.
            joined = b"".join(segs)
            dehyph = re.sub(rb"-?[\r\n]+", b"", b"".join(
                s[:-1] if s.endswith(b"-") else s for s in segs))
            out.append(("PDF text operands joined across lines", joined + b"\n" + dehyph))
    if "PNG" in kinds:
        out.extend(_png_text_chunks(data, budget))
    return out


def _scan_blob(raw: bytes, path: str, depth: int, budget, heuristics: bool = True,
               text_full: bool = False) -> list:
    """Route decoded/inflated bytes: clean UTF-8 text gets the text scan, anything else the byte
    detector (which recurses into nested containers). `heuristics=False` (used for the content
    of compressed containers) restricts every leg to the EXPLICIT patterns + key structures:
    measured 2026-09-24, entropy legs over ONE tracked third-party .tar.gz produced 440 findings
    on content nobody wrote here, which is how an instrument gets switched off."""
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = None
    if text is not None and "\x00" not in text:
        if heuristics or text_full:   # CANDIDATE6 (A6): a ZIP's TEXT members get the full rules
            return scan_text(text, path)
        return [(name, _redact(m.group(0), text, m.start()))
                for name, rx in _patterns_for(text) for m in rx.finditer(text)]
    return scan_bytes(raw, path, depth, budget, heuristics)


def scan_bytes(data: bytes, path: str = "", depth: int = 0, budget=None,
               heuristics: bool = True) -> list:
    """Findings for content that could not be (or should not be) read as UTF-8 text.
    Returns the same (name, redacted_preview) shape as `scan_text`. The preview for a
    structural hit is the MARKER NAME and the byte OFFSET -- never a byte of the file."""
    unsupported = _unsupported_container(data)
    if unsupported:
        raise _Unscannable("container not supported: %s (magic bytes at byte offset %d) -- this "
                           "scanner cannot open it" % unsupported)
    findings = []
    seen = set()
    for name, marker in _BYTE_STRUCT_MARKERS:
        off = data.find(marker)
        if off >= 0 and name not in seen:
            seen.add(name)
            findings.append(("byte:" + name, "<structural marker at byte offset %d>" % off))
    for name, rx in _DER_SIGNATURES:
        m = rx.search(data)
        if m and name not in seen:
            seen.add(name)
            findings.append(("byte:" + name, "<DER structure at byte offset %d>" % m.start()))
    for name, preview in _scan_explicit(_extracted_strings(data)):
        findings.append(("byte:" + name, preview))
    # (5) TEXT-VIEW RECOVERY. Two sub-cases where the ENTROPY legs are meaningful again and it
    # would be a real loss to drop them:
    #   (a) a file that is essentially UTF-8 text with a handful of bad bytes -- which is what
    #       the 209-file undecodable class in this repository actually is (mojibake markdown,
    #       not binaries). Decoding with replacement recovers ~all of it.
    #   (b) a NUL-dense file, i.e. UTF-16 with or without a BOM. Both byte orders are decoded.
    # The 1% ceiling in (a) is what keeps genuine binaries out of this branch: a compiled
    # artefact or an image decodes to mostly replacement characters, so it never qualifies.
    for view, tag, full in _text_views(data):
        for name, preview in (scan_text(view, path) if (heuristics and full)
                              else _scan_explicit(view)):
            findings.append(("byte:" + tag + ":" + name, preview))
    # CANDIDATE4: look INSIDE compressed containers instead of calling them clean (explicit
    # patterns + key structures only inside them -- see _scan_blob).
    if budget is None:
        budget = [_MAX_INFLATE_TOTAL]
    if depth < _MAX_CONTAINER_DEPTH:
        members = _container_members(data, budget)
        kinds = _container_kinds(data)
        if not {"ZIP", "tar", "PDF", "PNG"} & set(kinds):
            # CANDIDATE6 (A3): gzip/zlib at any offset (a parsed structure is walked instead).
            members += _probe_compressed(data, budget, "gzip" in kinds)
        for label, content in members:
            full = label.startswith("zip member")   # CANDIDATE6 (A6, owner decision)
            for name, preview in _scan_blob(content, path, depth + 1, budget, False, full):
                rule = name.split(":")[-1]
                if label.startswith("PDF text operands") and rule in _PDF_JOIN_EXCLUDED:
                    continue
                findings.append(("inflated:" + rule, preview + " in " + label))
    elif _container_kinds(data):
        # CANDIDATE5 (A1): was a silent stop -- the innermost container's content went unread.
        raise _Unscannable("container not supported: %s nested deeper than the %d levels this "
                           "scanner opens" % ("/".join(_container_kinds(data)), _MAX_CONTAINER_DEPTH))
    # De-duplicate: the same secret is usually seen by both the string pass and a text view.
    out, seen_pv = [], set()
    for name, preview in findings:
        key = (name.split(":")[-1], preview)
        if key in seen_pv:
            continue
        seen_pv.add(key)
        out.append((name, preview))
    return out


_MAX_REPLACEMENT_RATIO = 0.01


# CANDIDATE6 (A4): ESC (0x1b, ANSI colour codes), FF (0x0c, page breaks) and SUB (0x1a, DOS
# end-of-file) are NOT counted: they occur in real text logs. Random binary stays ~10% control.
_CTRL_BYTES = (bytes(range(0, 9)) + b"\x0b" + bytes(range(0x0e, 0x1a)) + bytes(range(0x1c, 0x20))
               + b"\x7f")


def _looks_like_single_byte_text(data: bytes) -> bool:
    """CANDIDATE5 (A3): mostly-printable bytes (<=1% C0 control bytes, ESC/FF/SUB excluded since
    CANDIDATE6). Random or compressed binary is ~10% control bytes; cp1252/latin-1 prose is ~0%."""
    ctrl = len(data) - len(data.translate(None, _CTRL_BYTES))
    return bool(data) and ctrl <= _MAX_REPLACEMENT_RATIO * len(data)


def _text_views(data: bytes) -> list:
    """(decoded_text, tag, full_rules) views of `data`. full_rules=False -> explicit patterns only."""
    views = []
    try:
        t = data.decode("utf-8", "replace")
    except Exception:
        t = ""
    if t:
        bad = t.count("\ufffd")
        if 0 < bad <= _MAX_REPLACEMENT_RATIO * len(t):
            views.append((t.replace("\ufffd", " ").replace("\x00", " "), "text-recovered", True))
        elif bad == 0 and "\x00" in t:
            # CANDIDATE5 (A2): candidate4 dropped this view (`pass`), so ONE NUL switched off the
            # entropy legs. NUL -> space keeps token boundaries (full rules); the NUL-stripped view
            # re-joins a key split by NULs (explicit patterns only: joining could fabricate runs).
            views.append((t.replace("\x00", " "), "text-nul-spaced", True))
            views.append((t.replace("\x00", ""), "text-nul-stripped", False))
        elif bad == 0:
            views.append((t, "text", True))   # valid UTF-8 routed here on purpose (an ASCII PDF)
        if bad > _MAX_REPLACEMENT_RATIO * len(t) and _looks_like_single_byte_text(data):
            # CANDIDATE5 (A3): cp1252 never fails to map a byte except 5 undefined ones.
            views.append((data.decode("cp1252", "replace"), "text-cp1252", True))
    if b"\x00" in data:
        # CANDIDATE5: both byte ALIGNMENTS (a UTF-16 run can start at an odd offset), each cut to
        # an even length so a dangling last byte does not cost a replacement character.
        for off in (0, 1):
            chunk = data[off:]
            chunk = chunk[:len(chunk) - (len(chunk) % 2)]
            for codec, tag in (("utf-16-le", "utf16le"), ("utf-16-be", "utf16be")):
                try:
                    w = chunk.decode(codec, "replace")
                except Exception:
                    continue
                if w and w.count("\ufffd") <= _MAX_REPLACEMENT_RATIO * len(w):
                    views.append((w, tag + ("-odd" if off else ""), True))
    return views


# --- WIDE-ENCODING-WITHOUT-BOM (2026-09-23) --------------------------------------------
# THE HOLE, verified to exist BEFORE it was fixed (positive control in the notes file): ASCII
# text saved as UTF-16LE with NO BOM decodes as PERFECTLY VALID UTF-8, because every ASCII byte
# is followed by 0x00 and 0x00 is a legal one-byte codepoint. So the file never reaches the
# undecodable branch; it is scanned as a NUL-interleaved string that no pattern can match, and
# it passes clean. A BOM-bearing UTF-16 file was already caught (2026-09-22) because it fails
# to decode at all.
# THE TEST: a genuine UTF-8 source or document essentially never contains a NUL codepoint,
# while a wide-encoded ASCII file is ~50% NULs. Any NUL therefore routes the file to the byte
# detector, which reads both UTF-16 byte orders. This is a ROUTE, not a skip: the file is still
# scanned, and more thoroughly than before.
def _is_wide_or_nul_bearing(text: str) -> bool:
    return "\x00" in text


# --- CANDIDATE5 (A5): the DECLARED-FIXTURE LEDGER was REMOVED. It was read from the WORKTREE,
# never from the index, so one untracked, unreviewed line excused a staged key (measured by the
# install gate). dec-140 is strict: a planted positive-control fixture (S48 case a) stays blocked
# or untracked, which the owner already accepted. No allowlist replaces it.


def _git_names(args: list, what: str) -> list[str]:
    """CANDIDATE5 (A7, A9): NUL-separated names read as UTF-8 BYTES (no quoting, no cp1252
    decode, so a non-ASCII name is scanned, not refused); a git failure is exit 2, named."""
    try:
        out = subprocess.run(["git"] + args, cwd=REPO_ROOT, capture_output=True, timeout=30)
    except (OSError, subprocess.SubprocessError) as e:
        print(f"secret_scan: could not list {what}: {e}", file=sys.stderr)
        sys.exit(2)
    if out.returncode != 0:
        err = (out.stderr or b"").decode("utf-8", "replace").strip().splitlines()[-1:]
        print("secret_scan: could not list %s: `git %s` exited %d %r -- nothing was scanned, "
              "so this is not a clean result." % (what, " ".join(args), out.returncode, err),
              file=sys.stderr)
        sys.exit(2)
    return [n.decode("utf-8", "surrogateescape") for n in out.stdout.split(b"\0") if n]


def _staged_files() -> list[str]:
    """Files staged for commit (Added/Copied/Modified/Renamed/Type-changed), repo-relative."""
    return _git_names(["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMRT"],
                      "staged files")


# --- BEGIN FAIL-CLOSED-ON-UNDECODABLE (added 2026-09-22) -------------------------------
# HOLE THIS CLOSES (re-derived at SHA b1a8278): a staged file whose bytes are not valid
# UTF-8 returned None here, and main() then skipped it in COMPLETE SILENCE and exited 0 --
# an unscannable file was indistinguishable from a clean one. Now it is named and refused.
# Covers: UTF-16/UTF-32 WITH a BOM, and ordinary binaries -- measured, they all raise
# UnicodeDecodeError on the first byte.
# WHAT THIS DOES **NOT** COVER, measured 2026-09-22, do not assume otherwise: ASCII text
# saved as UTF-16 WITHOUT a BOM decodes as PERFECTLY VALID UTF-8 (every ASCII byte is
# followed by 0x00, and 0x00 is a legal 1-byte codepoint), so it never reaches this branch.
# It is scanned as a NUL-interleaved string that no pattern matches, and the commit still
# passes clean. Closing that needs a separate, deliberate decision (e.g. treating decoded
# text that contains NUL as unscannable); it is NOT done here.
# The fix reports the PATH and the REASON only -- never any byte of the file's content --
# and exits non-zero. Exit 2 ("could not scan", per the exit-code contract in the module
# docstring) is used, not 1, so the invariant "exit 1 <=> at least one SECRET FOUND line"
# that secret_scan_repo_clean.test.py's parser-integrity guard depends on still holds.
# SCOPE (2026-09-22 text, CORRECTED 2026-09-25 by candidate7 A4): this block was written for
# staged mode only. It is SUPERSEDED by dec-140: `_staged_blob` and `_read_worktree` now return
# the raw BYTES of an undecodable file, which `scan_bytes` scans in every mode, so nothing returns
# UNDECODABLE any more and the `isinstance(text, _Undecodable)` branch in main() is unreachable
# (kept only as a guard). The exit-2 path that remains live is `_CouldNotRead` (content that
# could not be obtained at all), in every mode.
# SELF-CONTAINED: this block, the marked `except` arm in _staged_blob, and the two marked
# hunks in main() are the whole change -- delete the four marked regions to revert.
class _CouldNotRead:
    """CANDIDATE4: the content could not be obtained at all; carries the reason (never content)."""
    __slots__ = ("reason",)

    def __init__(self, reason: str):
        self.reason = reason


class _Undecodable:
    """Sentinel type: the staged blob could not be decoded as UTF-8, so it was NOT scanned."""
    __slots__ = ()


UNDECODABLE = _Undecodable()
# --- END FAIL-CLOSED-ON-UNDECODABLE ----------------------------------------------------


def _staged_blob(path: str) -> str | _Undecodable | None:
    """The STAGED content of a file (the version that will be committed): text when it is clean
    UTF-8, the raw BYTES otherwise (undecodable, PDF, NUL-bearing), `_CouldNotRead` when `git show`
    fails. (CORRECTED 2026-09-25: it no longer returns None or UNDECODABLE -- dec-140.)"""
    try:
        out = subprocess.run(
            ["git", "show", f":{path}"],
            cwd=REPO_ROOT, capture_output=True, timeout=30,
        )
    except (OSError, subprocess.SubprocessError) as e:
        return _CouldNotRead("`git show` of the staged blob failed (%s)" % e.__class__.__name__)
    if out.returncode != 0:
        return _CouldNotRead("`git show` of the staged blob exited %d" % out.returncode)
    try:
        text = out.stdout.decode("utf-8")
    except UnicodeDecodeError:
        # dec-140 (2026-09-23): was UNDECODABLE, which fail-closed and BLOCKED the commit
        # without ever reading the file. Now the raw bytes are returned and actually scanned
        # by `scan_bytes`. The 2026-09-22 fail-closed exit-2 path is KEPT in main() for the
        # case where not even the bytes can be obtained.
        return out.stdout
    if out.stdout[:5] == b"%PDF-":
        return out.stdout   # CANDIDATE5: a PDF always takes the byte path (streams + joined text)
    if _is_wide_or_nul_bearing(text):
        # WIDE-ENCODING-WITHOUT-BOM: it decoded, but what "decoded" is not the text a human
        # sees. Scan the bytes instead.
        return out.stdout
    return text


def _tracked_files() -> list[str]:
    return _git_names(["ls-files", "-z"], "tracked files")


def _read_worktree(path: str) -> str | bytes | None:
    """dec-140 (2026-09-23): audit mode used to return None here on an undecodable file and
    main() then skipped it in SILENCE, so `--paths`/`--all` exited 0 over files it never read.
    Now the raw bytes come back and are scanned by `scan_bytes`, so audit mode and the commit
    path have the same coverage."""
    full = os.path.join(REPO_ROOT, path)
    try:
        with open(full, "rb") as fh:
            raw = fh.read()
    except OSError as e:
        return _CouldNotRead("could not be read (%s: %s)" % (e.__class__.__name__,
                                                              e.strerror or "no detail"))
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw
    if raw[:5] == b"%PDF-":
        return raw   # CANDIDATE5: a PDF always takes the byte path (streams + joined text)
    return raw if _is_wide_or_nul_bearing(text) else text


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="Pure-stdlib pre-commit secret scanner.")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--all", action="store_true", help="scan all tracked files (audit)")
    g.add_argument("--paths", nargs="+", help="scan these specific files (testing)")
    g.add_argument("--file-list", metavar="FILE",
                   help="scan the paths named in FILE, one per line (export/blob scans); "
                        "same semantics as --paths")
    args = ap.parse_args(argv)
    try:   # CANDIDATE5: a non-ASCII path must never crash the report (exit 1 with no finding)
        sys.stderr.reconfigure(errors="backslashreplace")
    except (AttributeError, ValueError):
        pass
    # --- BEGIN FILE-LIST MODE (2026-10-03, plan v3:65 / v4 A3) ---
    # ADDITIVE and opt-in: with no flag, args.file_list is None and nothing below runs. The list
    # becomes args.paths, so every listed path takes the unchanged --paths branch (missing path
    # -> NOT FOUND, exit 2). An unreadable or empty list is a refusal (exit 2), never a clean run.
    if args.file_list is not None:
        try:
            with open(args.file_list, encoding="utf-8-sig") as fh:
                listed = [ln.rstrip("\r\n") for ln in fh]
        except (OSError, UnicodeDecodeError) as e:
            print("FILE LIST %s: could not be read (%s), so nothing was scanned."
                  % (args.file_list, e.__class__.__name__), file=sys.stderr)
            return 2
        listed = [p for p in listed if p.strip()]
        if not listed:
            print("FILE LIST %s: names no path, so nothing was scanned." % args.file_list,
                  file=sys.stderr)
            return 2
        args.paths = listed
    # --- END FILE-LIST MODE ---

    any_found = False

    unscannable: list[str] = []  # FAIL-CLOSED (2026-09-22; widened to every mode by CANDIDATE4)

    def _refuse(path: str, reason: str, tag: str = "UNSCANNABLE FILE") -> None:
        unscannable.append(path)
        print(f"{tag} {path}: {reason}", file=sys.stderr)

    if args.paths:
        # CANDIDATE4 (S55): a path that names nothing, or a directory with no files, is NOT a
        # clean result -- it is exit 2 with the path named. Directories are walked.
        items = []
        for p in args.paths:
            full = os.path.join(REPO_ROOT, p)
            if os.path.isdir(full):
                found = []
                for root, dirs, files in os.walk(full):
                    dirs.sort()
                    found.extend(os.path.join(root, f) for f in sorted(files))
                if not found:
                    _refuse(p, "is a directory that contains no files, so nothing was scanned.",
                            "EMPTY DIRECTORY")
                items.extend((f, _read_worktree(f)) for f in found)
            elif not os.path.lexists(full):
                _refuse(p, "no such file or directory (resolved to %s), so it was NOT scanned."
                        % full, "NOT FOUND")
            else:
                items.append((p, _read_worktree(p)))
    elif args.all:
        items = [(p, _read_worktree(p)) for p in _tracked_files()]
    else:
        items = [(p, _staged_blob(p)) for p in _staged_files()]

    byte_scanned: list[str] = []  # dec-140 (2026-09-23): read as bytes, not skipped

    for path, text in items:
        # --- BEGIN FAIL-CLOSED-ON-UNDECODABLE (2026-09-22) ---
        # UNREACHABLE since dec-140 (no reader returns UNDECODABLE; undecodable content is
        # byte-scanned). Kept as a fail-closed guard in case a future reader returns it again.
        # Name the file and the reason. NEVER any of its bytes.
        if isinstance(text, _Undecodable):
            unscannable.append(path)
            print(
                f"UNSCANNABLE FILE {path}: its staged bytes are not valid UTF-8 text, so the "
                "scanner could not read it and cannot tell whether it contains a secret.",
                file=sys.stderr,
            )
            continue
        # --- END FAIL-CLOSED-ON-UNDECODABLE ---
        if isinstance(text, _CouldNotRead):
            _refuse(path, text.reason + ", so it was NOT scanned.")
            continue
        if text is None:
            _refuse(path, "no content could be obtained, so it was NOT scanned.")
            continue
        # --- BEGIN BYTE-LEVEL DETECTOR ROUTING (dec-140, 2026-09-23) ---
        # The file is not UTF-8 text (or it decoded but carries NULs, i.e. a wide encoding
        # without a BOM). It is NOT skipped and NOT merely refused: its bytes are scanned.
        if isinstance(text, (bytes, bytearray)):
            raw = bytes(text)
            if not args.paths and _is_fixture_path(path):
                _refuse(path, _FIXTURE_SKIP_REASON, "SKIPPED")
                continue
            try:
                findings = scan_bytes(raw, path)
            except _Unscannable as e:
                _refuse(path, "%s, so its content was NOT fully scanned." % e)
                continue
            byte_scanned.append(path)
            if findings:
                any_found = True
                for name, preview in findings:
                    print("SECRET FOUND [%s] in %s: %s" % (name, path, preview),
                          file=sys.stderr)
            else:
                # Say out loud that this file got the REDUCED-coverage detector, so a clean
                # result here is never silently equated with a clean text scan.
                print(
                    "BYTE-SCANNED %s: not UTF-8 text; scanned at byte level (key structures, "
                    "explicit patterns, full rules on any recovered UTF-16/mojibake/cp1252/NUL-bearing "
                    "text, and the content of gzip/TAR/ZIP/PDF/PNG containers and probed gzip/zlib streams), clean. Entropy "
                    "heuristics are not applied to raw binary." % path,
                    file=sys.stderr,
                )
            continue
        # --- END BYTE-LEVEL DETECTOR ROUTING ---
        # PROPOSED REFINEMENT: skip the scanner's OWN test-fixture dirs (which intentionally
        # contain fake/synthetic key-shaped tokens) in commit/audit modes. Explicit --paths
        # is NOT skipped, so a both-ways test can still scan a fixture file directly to prove
        # a planted real key is still caught. Real keys committed OUTSIDE these dirs are
        # unaffected -- this is a path-scoped allowlist, not a content allowlist.
        if not args.paths and _is_fixture_path(path):
            _refuse(path, _FIXTURE_SKIP_REASON, "SKIPPED")
            continue
        try:
            findings = scan_text(text, path)
        except _Unscannable as e:   # a nested container inside a data-URI image
            _refuse(path, "%s, so its content was NOT fully scanned." % e)
            continue
        if findings:
            any_found = True
            for name, preview in findings:
                print(f"SECRET FOUND [{name}] in {path}: {preview}", file=sys.stderr)

    if any_found:
        print(
            "\nsecret_scan: BLOCKED -- a secret-looking token is in the commit.\n"
            "Remove it (keys live OUTSIDE the repo under the user profile), then re-commit.\n"
            "If this is a genuine false positive, inspect the line above and adjust.",
            file=sys.stderr,
        )
        return 1
    # --- BEGIN FAIL-CLOSED-ON-UNDECODABLE (2026-09-22) ---
    # Placed AFTER the existing any_found verdict so no pre-existing rule or its ordering
    # changes: a real finding still returns 1 first, and the UNSCANNABLE line above has
    # already been printed in that case.
    if unscannable:
        print(
            f"\nsecret_scan: BLOCKED -- {len(unscannable)} path(s) named above could not be "
            "scanned (missing, empty, unreadable, skipped, or a container that could not be opened).\n"
            "A path that was never read is not a clean result, so this scan fails closed.\n"
            "Fix: correct the path, or make the content readable, then re-run.",
            file=sys.stderr,
        )
        return 2
    # --- END FAIL-CLOSED-ON-UNDECODABLE ---
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
