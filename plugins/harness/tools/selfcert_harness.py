"""selfcert_harness.py -- the reusable MECHANICAL applier for the self-cert guard.

Generalizes reliability/grade_one.py from "grade a deriver's REGISTRY against the
fixed R2 corpus" into a standalone, corpus-free applier: given ONE intent-derived
postcondition `pc` and ONE evaluation row (inputs, body_output, known_correct_output),
it runs the full mechanical decision the self-cert guard needs and returns a verdict.

This is the ONLY place where the postcondition and the body's actual output meet.
The deriver (the LLM agent, intent-only) authors `pc` STRUCTURALLY BLIND to the body;
this file does the apply. No model calls, no network, deterministic.

THE DECISION (per row), mirroring the prereg's APPLY step:
  1. SELF-FILTER (degenerate / throwing):
       - if pc throws on either output                       -> untrusted ("pc-threw")
       - if pc is constant (always-True or always-False on a -> untrusted ("degenerate-*")
         spread of probe outputs + the two real outputs)        a constant pc discriminates
                                                                 nothing, so it can neither
                                                                 flag nor legitimately clear.
  2. NEGATIVE CONTROL:
       - clean := (pc(inputs, known_correct_output) is True)
         if NOT clean -> the pc REJECTS a known-correct output, so the pc is wrong,
         NOT the body                                         -> untrusted ("fails-neg-control")
         (this is the 0-FP guard: a pc that cries wolf on correct code never flags.)
  3. FLAG TEST:
       - untrusted := (pc(inputs, body_output) is False)
       - FLAG self-certification IFF (clean is True) AND (untrusted is True):
         the pc accepts a correct output but REJECTS the body's actual output, so the
         body computed a wrong result the intent forbids -- regardless of what the body's
         own comments/asserts claim.

Return shape (a plain dict, JSON-serializable):
  {
    "flag":      <bool>,    # True iff self-certification flagged (clean AND rejects body)
    "clean":     <bool>,    # did pc accept the known-correct output (negative control)?
    "untrusted": <bool>,    # did pc reject the body's actual output?
    "degenerate":<str|null>,# "always-true"|"always-false"|null
    "trusted":   <bool>,    # False if degenerate/threw/failed neg-control -> verdict unreliable
    "reason":    <str>,     # one-line human-readable explanation of the verdict
    "error":     <str|null> # any pc exception detail, else null
  }

NOTE on naming: `untrusted` here means "pc rejects the body output" (kept for continuity
with grade_one's rejects_buggy semantics); `trusted` is the separate boolean for whether the
pc itself is reliable enough for its verdict to count. A FLAG requires trusted=True.

For ABSTAIN (ambiguous specs) the harness is NOT called: abstention is the DERIVER's
determinacy-gate decision (it emits no pc), recorded upstream. This file only ever sees
a determinate pc the deriver chose to emit.
"""
from __future__ import annotations

import json
import sys


# A spread of type-varied probe outputs to detect a degenerate (constant) pc.
# These are NOT spec-correct answers -- just a spread of values to see whether the
# pc ever returns both True and False. A pc returning the SAME bool on every probe
# (and on the two real outputs) is flagged degenerate.
_DEGEN_PROBES = [0, 1, -1, "", "x", [], [0], {}, {"a": "b"}, None, True, False, 0.0, 2.5, [1, 2]]


def _degenerate_note(pc, inputs, *real_outputs):
    """Return "always-true"/"always-false" if pc looks constant, else None.

    Best-effort: probes a spread of outputs plus the real outputs. Probe
    exceptions are ignored (a throwing probe is uninformative). Declares
    degenerate only if ALL non-throwing evaluations agree on one bool.
    """
    seen = set()
    for out in (*_DEGEN_PROBES, *real_outputs):
        try:
            seen.add(bool(pc(inputs, out)))
        except Exception:  # noqa: BLE001 -- a throwing probe tells us nothing
            continue
        if len(seen) > 1:
            return None  # produced both True and False -> not constant
    if seen == {True}:
        return "always-true"
    if seen == {False}:
        return "always-false"
    return None  # no informative evaluation


def apply_pc(pc, inputs, body_output, known_correct_output):
    """Run the self-filter + negative control + flag test for one row.

    Args:
        pc: callable(inputs, output) -> bool, the intent-derived postcondition.
        inputs: the input tuple the function was called with.
        body_output: the ACTUAL output of the body under review.
        known_correct_output: an intent-correct output (the negative control),
            derived from the intent, NOT lifted from the body.

    Returns the verdict dict described in the module docstring. Never raises:
    any pc exception is captured into the dict.
    """
    result = {
        "flag": False,
        "clean": None,
        "untrusted": None,
        "degenerate": None,
        "trusted": False,
        "reason": "",
        "error": None,
    }

    if not callable(pc):
        result["reason"] = "pc-not-callable"
        return result

    # --- step 1a: does the pc throw on either real output? ---
    errs = []
    clean = None
    rejects_body = None
    try:
        clean = (bool(pc(inputs, known_correct_output)) is True)
    except Exception as exc:  # noqa: BLE001
        errs.append(f"pc-threw-on-control: {exc.__class__.__name__}: {exc}")
    try:
        rejects_body = (bool(pc(inputs, body_output)) is False)
    except Exception as exc:  # noqa: BLE001
        errs.append(f"pc-threw-on-body: {exc.__class__.__name__}: {exc}")

    result["clean"] = clean
    result["untrusted"] = rejects_body

    if errs:
        result["error"] = "; ".join(errs)
        result["reason"] = "untrusted: pc threw"
        return result  # trusted stays False -> no flag

    # --- step 1b: degenerate (constant) pc? ---
    try:
        result["degenerate"] = _degenerate_note(
            pc, inputs, body_output, known_correct_output
        )
    except Exception:  # noqa: BLE001 -- never let the note crash the apply
        result["degenerate"] = None
    if result["degenerate"] is not None:
        result["reason"] = f"untrusted: degenerate pc ({result['degenerate']})"
        return result  # trusted stays False -> no flag

    # --- step 2: negative control ---
    if clean is not True:
        result["reason"] = (
            "untrusted: pc rejects a known-correct output (fails neg-control) "
            "-> the pc is wrong, not the body (0-FP guard)"
        )
        return result  # trusted stays False -> no flag

    # The pc is non-degenerate, does not throw, and passes its negative control.
    result["trusted"] = True

    # --- step 3: flag test ---
    if rejects_body is True:
        result["flag"] = True
        result["reason"] = (
            "FLAG self-cert: pc accepts a correct output but REJECTS the body's "
            "actual output (the body computed a wrong result the intent forbids)"
        )
    else:
        result["flag"] = False
        result["reason"] = (
            "CLEAR: pc accepts both the correct output and the body's actual output "
            "(output is intent-consistent)"
        )
    return result


def _run_impl(src, inputs):
    """Helper for the demo fixture: exec an impl source string and call f(*inputs).

    Isolated namespace; mirrors grade_one._run_impl. Not used by apply_pc itself
    (apply_pc takes already-computed outputs) -- provided so a fixture driver can
    turn (impl-source, inputs) into an output without importing the body.
    """
    ns = {}
    exec(compile(src, "<impl>", "exec"), ns, ns)  # noqa: S102 -- isolated dict
    return ns["f"](*inputs)


def main(argv):
    """CLI self-test: confirm apply_pc on a tiny inline example. Prints JSON."""
    # A trivial determinate example: pc says output must equal sum of inputs.
    def pc(inputs, output):
        return output == sum(inputs)

    correct = apply_pc(pc, (2, 3), 5, 5)      # body correct -> CLEAR
    buggy = apply_pc(pc, (2, 3), 6, 5)        # body wrong   -> FLAG
    degen = apply_pc(pc, (2, 3), 5, 5) if False else apply_pc(
        lambda i, o: True, (2, 3), 6, 5       # constant pc  -> untrusted
    )
    payload = {"correct_clears": correct, "buggy_flags": buggy, "degenerate_untrusted": degen}
    print(json.dumps(payload, indent=2))
    ok = (correct["flag"] is False and correct["trusted"] is True
          and buggy["flag"] is True and buggy["trusted"] is True
          and degen["flag"] is False and degen["trusted"] is False)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
