#!/usr/bin/env python3
"""Read plan meters without sending a model prompt. UNKNOWN is printed instead of any stale or unproven value.

  usage_meters.py                 live read of Codex and Claude; blocks up to --timeout-seconds, NEVER call it from a
                                  hook; exit 1 if either side is UNKNOWN
  usage_meters.py refresh         background job: probe both, write <profile>/cache/usage-meters-cache.json
  usage_meters.py show            fast reader for session start: cached values with their age, or UNKNOWN
  usage_meters.py show --refresh-if-stale
                                  same, and start a detached refresh when the cache is missing or old
<profile> is --profile-dir, else CLAUDE_CONFIG_DIR, else ~/.claude.
"""
from __future__ import annotations

import argparse
from datetime import datetime
import json
import math
import os
from pathlib import Path
import queue
import signal
import subprocess
import sys
import tempfile
import threading
import time
from typing import Iterable


WEEKLY_MINUTES = 10080
# Set in the child's environment; every spawn path refuses to run when it is present (no recursion).
PROBE_MARK = "CLAUDE_USAGE_METERS_PROBE"
# Names that tie a child to the parent session; a nested probe must not inherit them.
SESSION_BOUND = frozenset({
    "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_EXECPATH", "CLAUDE_PID",
    "CLAUDE_CODE_SSE_PORT", "CLAUDE_PROJECT_DIR", "CLAUDE_ENV_FILE", "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_AGENT_SDK_VERSION"})
BASE_FLAGS = ("-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose")
# The probe needs nothing but get_usage: no MCP servers, no transcript, and (settings file) no hooks.
QUIET_FLAGS = ("--no-session-persistence", "--strict-mcp-config")
HOOKS_OFF_SETTINGS = '{"disableAllHooks":true}\n'
CACHE_VERSION = 1
CACHE_NAME = "usage-meters-cache.json"
LOCK_NAME = "usage-meters-refresh.lock"
CODEX_MAX_AGE_HOURS = 6
CACHE_MAX_AGE_HOURS = 2
REFRESH_AFTER_SECONDS = 900
LOCK_STALE_SECONDS = 300
REFRESH_TIMEOUT_SECONDS = 180
CACHE_MAX_BYTES = 1000000
# 2100-01-01 UTC. A plan window never ends later; a bigger value is junk and some platforms cannot show it as a local time.
MAX_RESET_EPOCH = 4_102_444_800
NAME_LIMIT = 40  # longest label printed for a model or credit row
LINE_LIMIT = 1500  # longest line `show` or the live mode prints
JSON_SIDE_LIMIT = 20000  # longest JSON a live-mode side (Codex or Claude) may print; a real one is about 2000


class InvalidReading(ValueError):
    pass


def unknown(reason: str) -> dict:
    # Reasons are fixed strings: never echo source lines, stderr, or exceptions.
    return {"status": "UNKNOWN", "reason": reason}


def number(value, minimum=0):
    if type(value) not in (int, float) or not math.isfinite(value) or value < minimum:
        raise InvalidReading("invalid number")
    return value


def object_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise InvalidReading("duplicate field")
        result[key] = value
    return result


def json_object(line):
    def invalid_constant(_):
        raise InvalidReading("non-finite JSON")
    value = json.loads(line, object_pairs_hook=object_pairs, parse_constant=invalid_constant)
    if not isinstance(value, dict):
        raise InvalidReading("expected object")
    return value


def timestamp(value):
    if not isinstance(value, str):
        raise InvalidReading("missing timestamp")
    date = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if date.tzinfo is None:
        raise InvalidReading("timestamp needs timezone")
    return date.timestamp()


def epoch_of(value):
    """A reset moment (epoch number or ISO string) as an epoch number; one past the plausible range is refused."""
    epoch = number(timestamp(value) if isinstance(value, str) else value, 1)
    if epoch > MAX_RESET_EPOCH:
        raise InvalidReading("reset time out of range")
    return epoch


def local_time(value, tz=None):
    """A reset moment (epoch number or ISO string) as local 'YYYY-MM-DD HH:MM+HH:MM'."""
    epoch = epoch_of(value)
    try:
        return datetime.fromtimestamp(epoch, tz).astimezone(tz).isoformat(sep=" ", timespec="minutes")
    except (OSError, OverflowError, ValueError):
        raise InvalidReading("reset time cannot be shown") from None


def clean_name(name):
    """A label that is safe to print: ASCII only, no control characters, at most NAME_LIMIT characters."""
    raw = str(name)
    text = "".join(char if " " <= char <= "~" else "?" for char in raw[:NAME_LIMIT + 1])
    return text[:NAME_LIMIT - 3] + "..." if len(raw) > NAME_LIMIT else text


def bound_line(text):
    return text if len(text) <= LINE_LIMIT else text[:LINE_LIMIT - 3] + "..."


def emit(text):
    """print() that cannot raise on a console or pipe whose code page lacks a character."""
    stream = sys.stdout
    try:
        text = text.encode(getattr(stream, "encoding", None) or "ascii", "replace").decode(
            getattr(stream, "encoding", None) or "ascii", "replace")
    except (LookupError, UnicodeError):
        text = text.encode("ascii", "replace").decode("ascii")
    print(text, file=stream)


def bounded_report(report):
    """The live report with any side whose JSON is longer than JSON_SIDE_LIMIT replaced by UNKNOWN (fail closed)."""
    return {name: side if len(json.dumps(side, separators=(",", ":"), allow_nan=False)) <= JSON_SIDE_LIMIT
            else unknown("report too large") for name, side in report.items()}


def age_text(seconds):
    seconds = max(0, int(seconds))
    days, rest = divmod(seconds, 86400)
    hours, rest = divmod(rest, 3600)
    minutes = rest // 60
    if days:
        return f"{days}d{hours:02d}h"
    if hours:
        return f"{hours}h{minutes:02d}m"
    return f"{minutes}m" if minutes else f"{seconds}s"


def parse_codex(lines: Iterable[str], *, file_mtime: float, now: float,
                max_age_seconds: float = 21600) -> dict:
    try:
        number(max_age_seconds)
        last = None
        for line in lines:
            event = json_object(line)
            payload = event.get("payload")
            if isinstance(payload, dict) and "rate_limits" in payload:
                last = (event.get("timestamp"), payload["rate_limits"])
        if last is None:
            return unknown("missing rate_limits")
        as_of, limits = last
        age = now - timestamp(as_of)
        file_age = now - number(file_mtime)
        if age < 0 or file_age < 0 or age > max_age_seconds or file_age > max_age_seconds:
            return unknown("stale or future reading")
        primary = limits["primary"]
        used = number(primary["used_percent"])
        window = number(primary["window_minutes"], 1)
        reset = number(primary["resets_at"], 1)
        if used > 100 or type(window) is not int or type(reset) is not int or reset > MAX_RESET_EPOCH:
            raise InvalidReading("invalid primary")
        # Only the 10080-minute window may be called weekly; any other window is not this meter.
        if window != WEEKLY_MINUTES:
            return unknown("primary window is not weekly")
        if reset <= now:
            return unknown("expired primary window")
        return {"status": "OK", "primary": {"used_percent": used,
                "window_minutes": window, "resets_at": reset}, "as_of": as_of,
                "reading_age_seconds": age, "file_age_seconds": file_age, "file_mtime": file_mtime}
    except (ValueError, TypeError, KeyError, OverflowError):
        return unknown("invalid Codex reading")


def read_codex(sessions: Path | None = None, *, now=None, max_age_seconds=21600):
    sessions = sessions if sessions is not None else Path.home() / ".codex" / "sessions"
    now = time.time() if now is None else now
    try:
        # Only the specified dated rollout paths; never inspect auth or config files.
        files = list(sessions.glob("[0-9][0-9][0-9][0-9]/[0-9][0-9]/[0-9][0-9]/rollout-*.jsonl"))
        if not files:
            return unknown("no Codex rollout")
        newest = max(files, key=lambda path: (path.stat().st_mtime_ns, str(path)))
        modified = newest.stat().st_mtime
        with newest.open(encoding="utf-8") as source:
            return parse_codex(source, file_mtime=modified, now=now,
                               max_age_seconds=max_age_seconds)
    except (OSError, UnicodeError, ValueError):
        return unknown("unreadable Codex rollout")


def read_profile_codex(profile: Path, *, max_age_seconds=21600):
    """Codex meter of a NON-default profile (the work one): only its own <profile>/.codex/sessions, laid out like
    ~/.codex/sessions. Without that folder Codex does not apply there: the owner's personal reading must never show up
    under another profile's name."""
    own = profile / ".codex" / "sessions"
    if not own.is_dir():
        return unknown("Codex not applicable to this profile")
    return read_codex(own, max_age_seconds=max_age_seconds)


def child_environment(parent=None):
    source = os.environ if parent is None else parent
    # Case-insensitive filtering also covers Windows environment names.
    excluded = {"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"}
    return {key: value for key, value in source.items() if key.upper() not in excluded}


def probe_environment(parent=None, *, config_dir=None):
    """Environment for the probe child: no API key, no parent-session identity, recursion mark set.

    config_dir: None = inherit the parent's CLAUDE_CONFIG_DIR (live mode); a path = probe that profile;
    False = the default profile (~/.claude): drop CLAUDE_CONFIG_DIR, so a variable exported for another
    profile cannot make the child read that profile's meters under the default profile's name."""
    env = child_environment(parent)
    for key in [name for name in env if name.upper() in SESSION_BOUND]:
        del env[key]
    if config_dir is False:
        for key in [name for name in env if name.upper() == "CLAUDE_CONFIG_DIR"]:
            del env[key]
    elif config_dir is not None:
        env["CLAUDE_CONFIG_DIR"] = str(config_dir)
    env[PROBE_MARK] = "1"
    return env


def reset_at(row, now, *, nullable=False):
    value = row["resets_at"]
    if value is None and nullable:
        return None
    epoch = epoch_of(value)
    if epoch <= now:
        raise InvalidReading("expired Claude window")
    return value


def usage_row(row, now):
    used = number(row["utilization"])
    if used > 100:
        raise InvalidReading("invalid utilization")
    return {"utilization": used, "resets_at": reset_at(row, now)}


def cost_proof(data):
    """True when every place that carries the spend proof shows zero. The CLI reports it under data["session"]."""
    if not isinstance(data, dict):
        raise InvalidReading("invalid response")
    holders = [h for h in (data, data.get("session")) if isinstance(h, dict) and "total_cost_usd" in h]
    if not holders:
        raise InvalidReading("missing zero-cost proof")
    for holder in holders:
        if number(holder["total_cost_usd"]) != 0 or holder["model_usage"] not in ({}, []):
            return False
    return True


def parse_claude(lines: Iterable[str], request_id: str, *, now=None):
    now = time.time() if now is None else now
    try:
        for line in lines:
            event = json_object(line)
            if event.get("type") in ("assistant", "user", "stream_event"):
                return unknown("unexpected model activity")
            # Refuse any explicit evidence of spend, including unmatched messages.
            envelope = event.get("response", {})
            nested = envelope.get("response", {}) if isinstance(envelope, dict) else {}
            session = nested.get("session", {}) if isinstance(nested, dict) else {}
            for data in (event, envelope, nested, session):
                if isinstance(data, dict):
                    if "total_cost_usd" in data and number(data["total_cost_usd"]) != 0:
                        return unknown("nonzero cost")
                    if "model_usage" in data and data["model_usage"] not in ({}, []):
                        return unknown("nonempty model_usage")
            if event.get("type") != "control_response":
                continue
            envelope = event["response"]
            if envelope["request_id"] != request_id:
                continue
            if envelope["subtype"] != "success":
                return unknown("Claude control request failed")
            data = envelope["response"]
            if not cost_proof(data):
                return unknown("zero-cost proof refused")
            limits = data["rate_limits"]
            result = {name: usage_row(limits[name], now) for name in ("five_hour", "seven_day")}
            models = limits["model_scoped"]
            if not isinstance(models, list):
                raise InvalidReading("invalid model_scoped")
            result["model_scoped"] = []
            for row in models:
                name = row["display_name"]
                if not isinstance(name, str) or not name.strip() or not name.isprintable():
                    raise InvalidReading("invalid display_name")
                result["model_scoped"].append({"display_name": name, **usage_row(row, now)})
            for name, row in limits.items():
                if name in result or row is None:
                    continue
                if isinstance(row, dict) and "limit_dollars" in row:
                    extra = {"limit_dollars": number(row["limit_dollars"]),
                             "resets_at": reset_at(row, now, nullable=True)}
                    for field in ("utilization", "used_dollars"):
                        if field in row and row[field] is not None:
                            extra[field] = number(row[field])
                    result[name] = extra
            proof = data if "total_cost_usd" in data else data["session"]
            return {"status": "OK", "rate_limits": result,
                    "total_cost_usd": 0, "model_usage": proof["model_usage"]}
        return unknown("missing matching control_response")
    except (ValueError, TypeError, KeyError, OverflowError):
        return unknown("invalid Claude reading")


def resolve_claude(env=None):
    """Find the claude launcher on PATH honouring PATHEXT; relative PATH entries (the current folder) are ignored."""
    env = os.environ if env is None else env
    names = ["claude"]
    if os.name == "nt":
        runnable = {".com", ".exe", ".bat", ".cmd"}  # what CreateProcess can start
        pathext = (env.get("PATHEXT") or ".COM;.EXE;.BAT;.CMD").split(";")
        names = ["claude" + ext.strip().lower() for ext in pathext if ext.strip().lower() in runnable]
    for folder in (env.get("PATH") or "").split(os.pathsep):
        folder = folder.strip().strip('"')
        if not folder or not os.path.isabs(folder):
            continue
        for name in names:
            candidate = os.path.join(folder, name)
            if os.path.isfile(candidate) and (os.name == "nt" or os.access(candidate, os.X_OK)):
                return candidate
    return None


def claude_command(executable, work_dir):
    """Production argv: base flags, quiet flags, and a settings file that turns every hook off."""
    argv = [executable, *BASE_FLAGS, *QUIET_FLAGS]
    settings = Path(work_dir) / "probe-settings.json"
    # cmd.exe would split an unquoted '&' or '^' inside a batch-shim argument, so never pass such a path.
    unsafe = os.name == "nt" and executable.lower().endswith((".cmd", ".bat")) \
        and any(char in str(settings) for char in '&|<>^%"')
    if not unsafe:
        settings.write_text(HOOKS_OFF_SETTINGS, encoding="utf-8")
        argv += ["--settings", str(settings)]
    return argv


def kill_tree(process) -> bool:
    """Stop the process and everything it started, selected by PID tree (never by image name)."""
    ok = False
    try:
        if os.name == "nt":
            taskkill = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "taskkill.exe"
            subprocess.run([str(taskkill), "/PID", str(process.pid), "/T", "/F"],
                           stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           timeout=20, creationflags=subprocess.CREATE_NO_WINDOW)
            # The exit code is not trusted: a child that dies while the tree is walked makes taskkill report an
            # error for a process that is already gone. The launcher having exited is the check.
            process.wait(timeout=5)
            ok = True
        else:
            os.killpg(process.pid, signal.SIGKILL)  # the child leads its own session
            ok = True
    except (OSError, subprocess.SubprocessError):
        ok = False
    if not ok:
        try:
            process.kill()
        except OSError:
            pass
    return ok


def run_probe(argv, environment, work_dir, request, request_id, timeout_seconds):
    flags = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {"start_new_session": True}
    try:
        process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, env=environment, cwd=work_dir,
                                   encoding="utf-8", errors="strict", shell=False, **flags)
    except (OSError, ValueError):
        return unknown("Claude could not start")
    outcome = queue.Queue(maxsize=1)

    def exchange():
        try:
            process.stdin.write(json.dumps(request, separators=(",", ":")) + "\n")
            process.stdin.close()

            def lines():
                while True:
                    line = process.stdout.readline(1048577)
                    if not line:
                        return
                    if len(line) > 1048576:
                        raise InvalidReading("oversized response")
                    yield line

            outcome.put(parse_claude(lines(), request_id))
        except (OSError, ValueError, UnicodeError):
            outcome.put(unknown("unreadable Claude response"))

    worker = threading.Thread(target=exchange, daemon=True)
    worker.start()
    try:
        result = outcome.get(timeout=timeout_seconds)
        if process.poll() not in (None, 0):
            result = unknown("Claude exited unsuccessfully")
    except queue.Empty:
        result = unknown("Claude timeout")
    finally:
        try:
            if process.poll() is None and not kill_tree(process):
                result = unknown("Claude cleanup failed")
            process.wait(timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            result = unknown("Claude cleanup failed")
        worker.join(timeout=1)
        if not worker.is_alive():
            for stream in (process.stdin, process.stdout):
                try:
                    stream.close()
                except OSError:
                    result = unknown("Claude cleanup failed")
    return result


def read_claude(*, timeout_seconds=60, command=None, config_dir=None):
    try:
        number(timeout_seconds, 0.001)
    except ValueError:
        return unknown("invalid timeout")
    if os.environ.get(PROBE_MARK):
        return unknown("nested probe refused")
    executable = None
    if command is None:
        executable = resolve_claude()
        if executable is None:
            return unknown("Claude not found")
    request_id = "usage_" + str(time.time_ns())
    request = {"type": "control_request", "request_id": request_id,
               "request": {"subtype": "get_usage", "skip_behaviors": True}}
    # A throw-away folder is the probe's working directory: no project settings, nothing left behind.
    with tempfile.TemporaryDirectory(prefix="usage-meters-probe-", ignore_cleanup_errors=True) as work_dir:
        argv = claude_command(executable, work_dir) if command is None else list(command) + list(BASE_FLAGS)
        if command is None and "--settings" not in argv:  # the hooks-off file could not be passed: never probe with hooks on
            return unknown("hooks cannot be disabled")
        return run_probe(argv, probe_environment(config_dir=config_dir), work_dir, request,
                         request_id, timeout_seconds)


SHOW_ERRORS = (ValueError, TypeError, KeyError, OverflowError, OSError)  # bad data or a clock the platform lacks


def meter_text(label, row, tz=None, note=None):
    when = f"resets {local_time(row['resets_at'], tz)}" + (f"; {note}" if note else "")
    return f"{clean_name(label)} {row['utilization']:g}% used ({when})"


def extra_text(name, row, tz=None, note=None):
    when = "no reset" if row["resets_at"] is None else f"resets {local_time(row['resets_at'], tz)}"
    return f"{json.dumps(clean_name(name))} limit ${row['limit_dollars']:g} ({when}" + (f"; {note}" if note else "") + ")"


def codex_text(row, tz=None, note=None):
    when = f"resets {local_time(row['resets_at'], tz)}" + (f"; {note}" if note else "")
    return f"Codex weekly {row['used_percent']:g}% used ({when})"


def safe_text(make, unknown_label):
    """make() or '<label> UNKNOWN': one bad value must not take the other meters (or the process) down."""
    try:
        return make()
    except SHOW_ERRORS:
        return f"{clean_name(unknown_label)} UNKNOWN"


def human_line(report, tz=None):
    codex, claude = report["codex"], report["claude"]
    if codex["status"] != "OK":
        parts = ["Codex UNKNOWN"]
    else:
        parts = [safe_text(lambda: codex_text(codex["primary"], tz), "Codex")]
    if claude["status"] != "OK":
        parts.append("Claude UNKNOWN")
    else:
        limits = claude["rate_limits"]
        for key, label in (("five_hour", "5h"), ("seven_day", "7d")):
            parts.append(safe_text(lambda: meter_text(f"Claude {label}", limits[key], tz), f"Claude {label}"))
        for row in limits["model_scoped"]:
            parts.append(safe_text(lambda: meter_text(row["display_name"], row, tz), row["display_name"]))
        for name, row in limits.items():
            if isinstance(row, dict) and "limit_dollars" in row:
                parts.append(safe_text(lambda: extra_text(name, row, tz), json.dumps(clean_name(name))))
    return bound_line(" | ".join(parts))


def positive_seconds(value):
    try:
        return number(float(value), 0.001)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("must be a finite positive number") from exc


# ---- cache: a background refresh writes it, the fast reader prints it -------------------------------------


def profile_dir(explicit=None, env=None):
    env = os.environ if env is None else env
    chosen = (explicit or "").strip() or (env.get("CLAUDE_CONFIG_DIR") or "").strip()
    return Path(chosen).expanduser() if chosen else Path.home() / ".claude"


def write_cache(path: Path, payload: dict):
    temp = path.with_name(f"{path.name}.tmp{os.getpid()}")
    try:
        temp.write_text(json.dumps(payload, separators=(",", ":"), allow_nan=False), encoding="utf-8")
        os.replace(temp, path)
    except (OSError, ValueError, TypeError):
        try:
            temp.unlink()
        except OSError:
            pass
        raise OSError("cache write failed")


def acquire_lock(path: Path, now: float) -> bool:
    for _ in range(2):
        try:
            descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            try:
                if now - path.stat().st_mtime < LOCK_STALE_SECONDS:
                    return False
                path.unlink()  # the previous refresh died: take over
            except OSError:
                return False
            continue
        except OSError:
            return False
        with os.fdopen(descriptor, "w") as handle:
            handle.write(str(os.getpid()))
        return True
    return False


def release_lock(path: Path):
    try:
        path.unlink()
    except OSError:
        pass


def refresh_in_flight(path: Path, now: float) -> bool:
    try:
        return now - path.stat().st_mtime < LOCK_STALE_SECONDS
    except OSError:
        return False


def previous_claude(path: Path, now: float, max_age_seconds: float):
    """(block, read_at) of the last good Claude reading in the old cache while it is young enough, else None."""
    data, _ = load_cache(path)
    if data is None:
        return None
    read_at = data.get("claude_read_at", data["written_at"])
    try:
        number(read_at, 1)
    except ValueError:
        return None
    if data["claude"].get("status") != "OK" or read_at > data["written_at"] or not 0 <= now - read_at <= max_age_seconds:
        return None
    return data["claude"], read_at


def refresh(profile: Path, *, timeout_seconds=REFRESH_TIMEOUT_SECONDS, max_age_seconds=CODEX_MAX_AGE_HOURS * 3600):
    """Probe both sides and write the cache. Returns (exit code, one fixed-text status line)."""
    if os.environ.get(PROBE_MARK):
        return 0, "skipped: nested probe"
    cache_dir = profile / "cache"
    if not profile.is_dir():
        return 1, "failed: profile folder missing"
    try:
        cache_dir.mkdir(exist_ok=True)
    except OSError:
        return 1, "failed: cache folder not writable"
    lock = cache_dir / LOCK_NAME
    if not acquire_lock(lock, time.time()):
        return 0, "skipped: refresh already running"
    try:
        default = Path.home() / ".claude"
        # The same test that picks the Claude profile picks the Codex source: only the default profile reads ~/.codex.
        codex = (read_codex(max_age_seconds=max_age_seconds) if profile == default
                 else read_profile_codex(profile, max_age_seconds=max_age_seconds))
        claude = read_claude(timeout_seconds=timeout_seconds,
                             config_dir=False if profile == default else profile)
        now = time.time()
        payload = {"version": CACHE_VERSION, "written_at": now, "codex": codex, "claude": claude,
                   "claude_read_at": now}
        kept = None
        if claude["status"] != "OK":
            # A failed or timed-out read must not erase a reading that is still young: keep it, with its own time.
            kept = previous_claude(cache_dir / CACHE_NAME, now, CACHE_MAX_AGE_HOURS * 3600)
            if kept is not None:
                payload["claude"], payload["claude_read_at"] = kept
        write_cache(cache_dir / CACHE_NAME, payload)
    except OSError:
        return 1, "failed: cache write"
    finally:
        release_lock(lock)
    note = f" (kept the reading from {age_text(now - kept[1])} ago)" if kept is not None else ""
    return 0, f"refreshed: codex {codex['status']}, claude {claude['status']}{note}"


def start_refresh(profile: Path, explicit=None) -> bool:
    """Start a detached refresh and return at once. Never starts one from inside a probe child."""
    if os.environ.get(PROBE_MARK) or refresh_in_flight(profile / "cache" / LOCK_NAME, time.time()):
        return False
    argv = [sys.executable, str(Path(__file__).resolve()), "refresh"]
    if explicit:
        argv += ["--profile-dir", str(profile)]
    flags = ({"creationflags": subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP}
             if os.name == "nt" else {"start_new_session": True})
    try:
        subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         close_fds=True, shell=False, **flags)
    except (OSError, ValueError):
        return False
    return True


def load_cache(path: Path):
    """(data, None) or (None, fixed reason)."""
    try:
        with path.open("rb") as source:
            raw = source.read(CACHE_MAX_BYTES + 1)
        if len(raw) > CACHE_MAX_BYTES:
            return None, "cache too large"
        data = json_object(raw.decode("utf-8"))
        if data.get("version") != CACHE_VERSION:
            return None, "cache version mismatch"
        number(data["written_at"], 1)
        if not isinstance(data["codex"], dict) or not isinstance(data["claude"], dict):
            return None, "invalid cache"
        return data, None
    except FileNotFoundError:
        return None, "no cache yet"
    except (OSError, UnicodeError, ValueError, TypeError, KeyError):
        return None, "unreadable cache"


def cached_codex(entry, written_at, now, max_age_seconds):
    """Run the same parser on the stored facts, so every freshness rule is applied with today's clock."""
    try:
        if entry.get("status") != "OK":
            return unknown("Codex unknown at refresh")
        line = json.dumps({"timestamp": entry["as_of"],
                           "payload": {"rate_limits": {"primary": entry["primary"]}}})
        return parse_codex([line], file_mtime=number(entry["file_mtime"]), now=now,
                           max_age_seconds=max_age_seconds)
    except (ValueError, TypeError, KeyError, OverflowError):
        return unknown("invalid cached Codex reading")


def cached_claude_parts(claude, now, tz=None, note=None):
    """One text per meter; a meter whose window has ended or whose numbers are invalid becomes UNKNOWN."""
    if claude.get("status") != "OK":
        return ["Claude UNKNOWN"], False
    try:
        limits = claude["rate_limits"]
        wanted = [(f"Claude {label}", limits[key]) for key, label in (("five_hour", "5h"), ("seven_day", "7d"))]
        wanted += [(clean_name(row["display_name"]), row) for row in limits["model_scoped"]]
    except (KeyError, TypeError):
        return ["Claude UNKNOWN"], False
    parts, core_known = [], True
    for index, (label, row) in enumerate(wanted):
        try:
            parts.append(meter_text(label, usage_row(row, now), tz, note))
        except SHOW_ERRORS:
            parts.append(f"{label} UNKNOWN")
            core_known = core_known and index >= 2
    for name, row in limits.items():
        if isinstance(row, dict) and "limit_dollars" in row:
            try:
                parts.append(extra_text(name, {"limit_dollars": number(row["limit_dollars"]),
                                               "resets_at": reset_at(row, now, nullable=True)}, tz, note))
            except SHOW_ERRORS:
                parts.append(f"{json.dumps(clean_name(name))} UNKNOWN")
    return parts, core_known


def cached_view(path: Path, *, now, codex_max_age, cache_max_age, tz=None):
    data, why = load_cache(path)
    if data is None:
        return {"line": f"Plan meters: UNKNOWN ({why})", "age": None, "all_known": False}
    age = now - data["written_at"]
    if age < 0:
        return {"line": "Plan meters: UNKNOWN (cache time is in the future)", "age": None, "all_known": False}
    codex = cached_codex(data["codex"], data["written_at"], now, codex_max_age)
    if codex["status"] == "OK":
        reading = f"reading {age_text(codex['reading_age_seconds'])} old"
        parts = [safe_text(lambda: codex_text(codex["primary"], tz, reading), "Codex")]
    else:
        parts = ["Codex UNKNOWN"]
    # A failed refresh keeps the last good Claude block, so its reading time can be older than the file's.
    claude_at = data.get("claude_read_at", data["written_at"])
    try:
        valid_time = number(claude_at, 1) <= data["written_at"]
    except ValueError:
        valid_time = False
    kept = valid_time and data["written_at"] - claude_at > 1
    claude_age = now - claude_at if valid_time else None
    if not valid_time:
        claude_parts, claude_known = ["Claude UNKNOWN (invalid reading time)"], False
    elif claude_age > cache_max_age:
        what = "reading" if kept else "cache"
        claude_parts, claude_known = [f"Claude UNKNOWN ({what} older than {age_text(cache_max_age)})"], False
    else:
        note = f"reading {age_text(claude_age)} old, last refresh failed" if kept else None
        claude_parts, claude_known = cached_claude_parts(data["claude"], now, tz, note)
    return {"line": bound_line(f"Plan meters (cache {age_text(age)} old): " + " | ".join(parts + claude_parts)),
            "age": age, "all_known": codex["status"] == "OK" and claude_known}


def cached_main(command, argv):
    parser = argparse.ArgumentParser(prog=f"usage_meters.py {command}")
    parser.add_argument("--profile-dir", help="default: CLAUDE_CONFIG_DIR, else ~/.claude")
    parser.add_argument("--max-age-hours", type=positive_seconds, default=CODEX_MAX_AGE_HOURS,
                        help="Codex reading age limit")
    if command == "refresh":
        parser.add_argument("--timeout-seconds", type=positive_seconds, default=REFRESH_TIMEOUT_SECONDS)
    else:
        parser.add_argument("--cache-max-age-hours", type=positive_seconds, default=CACHE_MAX_AGE_HOURS,
                            help="Claude values older than this are UNKNOWN")
        parser.add_argument("--refresh-if-stale", action="store_true",
                            help="start a detached refresh when the cache is missing or %d+ minutes old"
                                 % (REFRESH_AFTER_SECONDS // 60))
        parser.add_argument("--strict", action="store_true", help="exit 1 when any core meter is UNKNOWN")
    args = parser.parse_args(argv)
    profile = profile_dir(args.profile_dir)
    if command == "refresh":
        code, text = refresh(profile, timeout_seconds=args.timeout_seconds,
                             max_age_seconds=args.max_age_hours * 3600)
        emit(text)
        return code
    try:
        view = cached_view(profile / "cache" / CACHE_NAME, now=time.time(),
                           codex_max_age=args.max_age_hours * 3600, cache_max_age=args.cache_max_age_hours * 3600)
    except Exception:  # noqa: BLE001 - the session-start reader prints a fixed line, never a traceback or the error text
        view = {"line": "Plan meters: UNKNOWN (internal error)", "age": None, "all_known": False}
    started = args.refresh_if_stale and (view["age"] is None or view["age"] >= REFRESH_AFTER_SECONDS) \
        and start_refresh(profile, args.profile_dir)
    emit(view["line"] + (" [refresh started]" if started else ""))
    return 1 if args.strict and not view["all_known"] else 0


def main(argv=None):
    args_list = list(sys.argv[1:] if argv is None else argv)
    if args_list[:1] in (["refresh"], ["show"]):
        return cached_main(args_list[0], args_list[1:])
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--max-age-hours", type=positive_seconds, default=6)
    parser.add_argument("--timeout-seconds", type=positive_seconds, default=120)
    args = parser.parse_args(args_list)
    profile = profile_dir()
    codex = (read_codex(max_age_seconds=args.max_age_hours * 3600) if profile == Path.home() / ".claude"
             else read_profile_codex(profile, max_age_seconds=args.max_age_hours * 3600))
    report = {"codex": codex,
              "claude": read_claude(timeout_seconds=args.timeout_seconds)}
    report = bounded_report(report)  # a flood of rows or a huge name cannot make the machine line unbounded
    print(json.dumps(report, separators=(",", ":"), allow_nan=False))
    try:
        line = human_line(report)
    except Exception:  # noqa: BLE001 - same rule as `show`: a fixed line, never a traceback or the error text
        line = "Plan meters: UNKNOWN (internal error)"
    emit(line)
    return 0 if all(row["status"] == "OK" for row in report.values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
