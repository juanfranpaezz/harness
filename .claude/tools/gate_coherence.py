#!/usr/bin/env python3
"""
gate_coherence.py  --  GATE-COHERENCE CHECKER (decorative-safeguard detector)

WHAT THIS IS
------------
A dependency-free (stdlib `ast` only) static analyzer that answers, for a Python
file, ONE question per safeguard:

    "Does a value produced by this safeguard's computation actually REACH the
     deploy / verdict decision -- or is it computed-but-never-gates-the-decision
     (DECORATIVE)?"

This is the mechanical form of the Verifier's gate-coherence check (#7). It is
the one general verification technique MEASURED to catch a real defect unaided:
in Trader 3 v1 a CPCV path-Sharpe distribution was printed and persisted but the
deploy verdict never read it -- a decorative safeguard a bare review pass missed.
In v2 the same distribution flows (path_sharpes -> cpcv_p5 -> cpcv_gate_ok) into
the verdict's boolean AND, so it REACHES.

HOW IT WORKS (behavior / data-flow, NOT magic variable names)
-------------------------------------------------------------
Generalized from oracles/cpcv-decorative/oracle.py:

  1. Parse the file. Pick the DECISION FUNCTION: the function that contains the
     decision expression -- the function holding the largest boolean And/Or
     assignment (or, with --decision SUBSTR, the function with a BoolOp
     assignment whose target name contains SUBSTR). Falls back to `main`, and
     finally to the guard-clause / early-return verdict function.

  2. Locate the DECISION EXPRESSION by STRUCTURE, not by a hard-coded name:
       - if --decision SUBSTR is given: the BoolOp(And) assignment whose target
         name contains SUBSTR;
       - else the canonical name 'claims' if present;
       - else a BoolOp(And|Or) assignment whose target is RETURNED or referenced in a
         deploy/ship/verdict/claim/edge context;
       - else the BoolOp(And|Or) assignment with the most operands (the big gate);
       - else, if the function has no boolean assignment at all, the GUARD-CLAUSE /
         EARLY-RETURN surface: the test of every `if` that can return, plus every
         returned expression (S27 FIX 2026-09-23).

  3. For each SAFEGUARD, compute the TRANSITIVE def-use (taint) closure of every
     value it produces, following data-flow edges to a fixpoint:
       - plain assignment            x = f(...)            x tainted
       - annotated assignment        x: T = expr
       - augmented assignment        x += expr
       - tuple / list unpack         a, b = ...            a, b tainted
       - starred unpack              a, *b = ...
       - subscript / attribute base  v[i] = ... / v.a = .. v's base tainted
       - for-loop target             for t in iterable:    t from iterable
       - with ... as v               v from context expr
       - IN-PLACE MUTATION           c.append(x) / c.update / c.extend / +=
                                     taints the RECEIVER container c when a
                                     tainted value flows in.
     A binding is tainted if its value references any already-tainted name.

     SAFEGUARDS are defined as:
       - if --safeguard-call NAME ... is given: each value bound from a call to
         any NAME (matched by simple name OR attribute method name), tracked as
         its OWN safeguard group; OR
       - if none given: every value in the decision function bound directly from
         a function call (auto-discovered). Each such producer call is one
         safeguard group, keyed by "<varname> <- <callee>(...)".

  4. A safeguard REACHES the decision iff any name in its taint closure appears
     among the decision expression's data dependencies (Names). Otherwise it is
     DECORATIVE.

USAGE
-----
    py gate_coherence.py <pyfile> [--decision <substr>] \
                                  [--safeguard-call <name> ...] \
                                  [--function <name>] [-v|--verbose]

OUTPUT
------
Per safeguard: "REACHES" or "DECORATIVE" with the producer call and (verbose) the
taint trace + the reaching names. A final summary line, then an `exit-status:` line.

EXIT CODES (S27 FIX 2026-09-23 -- they used to be 0 on EVERY path, including from
inside both exception handlers, so a crash reported success):
    0  CLEAN          -- the analysis ran and found no decorative/not-found safeguard,
                         OR it found some and --strict was not given (reporter mode).
    1  FINDINGS       -- --strict AND >=1 decorative / not-found safeguard.
    2  INCONCLUSIVE   -- nothing could be analyzed (no decision function, no decision
                         expression, no safeguards, unparseable source). This is NOT a
                         clean pass and must never again be confused with one.
    3  INTERNAL-ERROR -- the tool itself failed (missing file, unexpected exception).
                         Raised REGARDLESS of any flag: the exception handlers never launder.

PAPER / STATIC ONLY. Read-only against the target; writes nothing.
"""
from __future__ import annotations

import argparse
import ast
import sys

# --- EXIT CODES (S27 FIX 2026-09-23). Previously EVERY path returned 0, so a clean pass, an
# unanalyzable input and an internal crash were indistinguishable to any caller reading $?.
EXIT_CLEAN = 0
EXIT_FINDINGS = 1
EXIT_INCONCLUSIVE = 2
EXIT_INTERNAL_ERROR = 3
_EXIT_LABEL = {0: "CLEAN", 1: "FINDINGS", 2: "INCONCLUSIVE", 3: "INTERNAL-ERROR"}


def _emit_status(code: int, why: str = "") -> int:
    """Print the exit status in-band (for stdout parsers) and return it (for the shell)."""
    tail = " -- " + why if why else ""
    print("exit-status: %s (%d)%s" % (_EXIT_LABEL.get(code, code), code, tail))
    return code


# ---------------------------------------------------------------------------
# AST helpers (generalized from the cpcv-decorative oracle)
# ---------------------------------------------------------------------------
def _names_bound_by_target(tgt: ast.AST) -> list[str]:
    """Simple Name ids bound by an assignment target, flattening tuple/list
    unpack and starred targets, and capturing the BASE name of subscript /
    attribute targets so in-place mutation keeps the taint."""
    if isinstance(tgt, ast.Name):
        return [tgt.id]
    if isinstance(tgt, (ast.Tuple, ast.List)):
        out: list[str] = []
        for el in tgt.elts:
            out.extend(_names_bound_by_target(el))
        return out
    if isinstance(tgt, ast.Starred):
        return _names_bound_by_target(tgt.value)
    if isinstance(tgt, ast.Subscript):   # v[i] = ...  -> mutates v
        return _names_bound_by_target(tgt.value)
    if isinstance(tgt, ast.Attribute):   # v.a = ...   -> mutates v
        return _names_bound_by_target(tgt.value)
    return []


def _assign_targets(node: ast.Assign) -> list[str]:
    out: list[str] = []
    for tgt in node.targets:
        out.extend(_names_bound_by_target(tgt))
    return out


def _names_in(node: ast.AST) -> set[str]:
    """Every Name id referenced anywhere under node."""
    return {n.id for n in ast.walk(node) if isinstance(n, ast.Name)}


def _callee_name(call: ast.Call) -> str | None:
    """The callee's simple name: f(...) -> 'f', obj.m(...) -> 'm'."""
    f = call.func
    if isinstance(f, ast.Name):
        return f.id
    if isinstance(f, ast.Attribute):
        return f.attr
    return None


def _calls_to(node: ast.AST, names: set[str]) -> set[str]:
    """Subset of `names` that `node` contains a Call to (simple or attribute)."""
    hit: set[str] = set()
    for n in ast.walk(node):
        if isinstance(n, ast.Call):
            cn = _callee_name(n)
            if cn in names:
                hit.add(cn)
    return hit


def _direct_call_callee(value: ast.AST) -> str | None:
    """If `value` IS (or is trivially) a call expression, return its callee
    name. Handles  x = f(...)  and  x = f(...)[i]  / x = await f(...)."""
    node = value
    if isinstance(node, ast.Await):
        node = node.value
    # unwrap a trailing subscript/attribute on the call result: f(...)[i], f(...).a
    while isinstance(node, (ast.Subscript, ast.Attribute)):
        node = node.value
    if isinstance(node, ast.Call):
        return _callee_name(node)
    return None


def _iter_assign_like(func: ast.FunctionDef):
    """Yield (targets:list[str], value_node, raw_node) for every binding stmt in
    func: Assign, AnnAssign, AugAssign, For-targets, with ... as, and in-place
    mutating method calls (append/extend/update/...). Source order."""
    for node in ast.walk(func):
        if isinstance(node, ast.Assign):
            yield _assign_targets(node), node.value, node
        elif isinstance(node, ast.AnnAssign) and node.value is not None:
            yield _names_bound_by_target(node.target), node.value, node
        elif isinstance(node, ast.AugAssign):
            yield _names_bound_by_target(node.target), node.value, node
        elif isinstance(node, ast.For):
            yield _names_bound_by_target(node.target), node.iter, node
        elif isinstance(node, ast.withitem):
            if node.optional_vars is not None:
                yield _names_bound_by_target(node.optional_vars), node.context_expr, node
        elif isinstance(node, ast.Expr) and isinstance(node.value, ast.Call):
            # In-place mutation edge: c.append(x) / c.extend(xs) / d.update(...).
            # Passing a tainted value into a mutating method taints receiver c.
            call = node.value
            if isinstance(call.func, ast.Attribute):
                recv = _names_bound_by_target(call.func.value)
                if recv:
                    args = list(call.args) + [k.value for k in call.keywords]
                    yield recv, ast.Tuple(elts=args, ctx=ast.Load()), node


# ---------------------------------------------------------------------------
# Pick the decision function + locate the decision expression by structure
# ---------------------------------------------------------------------------
def _bool_and_assigns(func: ast.FunctionDef):
    """(targets, value, raw) for every `<name> = (<BoolOp>)` in func -- And OR Or.

    S27 FIX (2026-09-23): this accepted ast.And only. A verdict is written as a DISJUNCTION at
    least as often as as a conjunction -- e.g.
        allowed = bool(is_pre_authorised) or (approval_row is not None)
    -- and restricting to And made every such verdict invisible, so the tool fell through to an
    unrelated conjunction (or to "no decision function") and mislabelled real safeguards.
    """
    out = []
    for targets, value, raw in _iter_assign_like(func):
        if isinstance(raw, ast.Assign) and isinstance(value, ast.BoolOp) \
                and isinstance(value.op, (ast.And, ast.Or)):
            out.append((targets, value, raw))
    return out


def _bool_and_only_assigns(func: ast.FunctionDef):
    """The PRE-FIX predicate: conjunction assignments only.

    Kept deliberately. Widening function SELECTION from And to And|Or measurably degraded a real
    file (eval_runner.py moved off `genuine_flip` in `_preflight()` onto an unrelated `main()`
    disjunction and produced 14 new decorative labels). So selection stays EXACTLY as it was
    whenever the file contains any conjunction, and the Or / guard-clause tiers only run when the
    old tiers find nothing -- strictly additive recall, zero change to files that already worked.
    """
    return [(t, v, r) for (t, v, r) in _bool_and_assigns(func)
            if isinstance(v.op, ast.And)]


def _guarded_returns(func: ast.FunctionDef):
    """The GUARD-CLAUSE / EARLY-RETURN verdict shape (S27 FIX 2026-09-23).

    Many verdict functions never bind a named boolean at all: they decide by returning early out
    of a chain of guard clauses --
        if amount is None:   return False, "unparseable"
        if amount > limit:   return False, "over-limit"
        ...
        return True, "ok"
    For that shape the DECISION SURFACE is (a) the test of every `if` that can return and (b)
    every returned expression: together they are exactly the data the caller's verdict depends
    on. A value reaching neither is computed-and-discarded, i.e. decorative.

    Returns (guard_tests, return_values). Honest over-approximation: an outer `if` that merely
    CONTAINS a return somewhere below it is counted as a guard.
    """
    guards, returns = [], []
    for node in ast.walk(func):
        if isinstance(node, ast.Return) and node.value is not None:
            returns.append(node.value)
        elif isinstance(node, ast.If):
            if any(isinstance(n, ast.Return) for n in ast.walk(node)):
                guards.append(node.test)
    return guards, returns


def _guard_surface_node(guards, returns):
    """Fold the guard-clause surface into ONE synthetic node the taint check can read."""
    return ast.Tuple(elts=list(guards) + list(returns), ctx=ast.Load())


def _returned_names(func: ast.FunctionDef) -> set[str]:
    """Every Name referenced by a `return` in func -- i.e. consumed by the caller's verdict."""
    out: set[str] = set()
    for node in ast.walk(func):
        if isinstance(node, ast.Return) and node.value is not None:
            out |= _names_in(node.value)
    return out


def pick_decision_function(tree: ast.AST, decision_substr: str | None,
                           prefer_name: str | None):
    """Choose the function holding the decision expression. Priority:
       1. explicit --function name;
       2. a function with a BoolOp/And whose target contains --decision substr;
       3. function named 'main' if it has any BoolOp/And;
       4. the function with the single largest BoolOp/And assignment."""
    funcs = [n for n in ast.walk(tree)
             if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]
    if not funcs:
        return None

    if prefer_name:
        for f in funcs:
            if f.name == prefer_name:
                return f

    if decision_substr:
        for f in funcs:
            for targets, _v, _r in _bool_and_assigns(f):
                if any(decision_substr in t for t in targets):
                    return f

    # --- ORIGINAL TIERS, unchanged: conjunction-only, so no file that already resolved can move.
    for f in funcs:
        if f.name == "main" and _bool_and_only_assigns(f):
            return f

    best = None
    best_size = -1
    for f in funcs:
        for _t, value, _r in _bool_and_only_assigns(f):
            size = len(value.values)
            if size > best_size:
                best_size, best = size, f
    if best is not None:
        return best

    # --- S27 FIX tier: the same two rules, now allowing a DISJUNCTIVE verdict.
    for f in funcs:
        if f.name == "main" and _bool_and_assigns(f):
            return f
    for f in funcs:
        for _t, value, _r in _bool_and_assigns(f):
            size = len(value.values)
            if size > best_size:
                best_size, best = size, f
    if best is not None:
        return best

    # S27 FIX (2026-09-23): LAST TIER -- the guard-clause / early-return verdict function.
    # Without it the tool printed "no function with a boolean-AND decision found" and
    # "0 safeguards analyzed" for any file that decides by returning early -- byte-identical to
    # what it prints for a clean file: one answer, always. Pick the function with the most
    # guarded returns (needs >=1 guard and >=2 returns to count as a verdict chain).
    best_score = (1, 1)
    for f in funcs:
        guards, returns = _guarded_returns(f)
        score = (len(guards), len(returns))
        if len(guards) >= 2 and len(returns) >= 2 and score > best_score:
            best_score, best = score, f
    return best


def find_decision_expr(func: ast.FunctionDef, decision_substr: str | None):
    """Return (value_node, target_name, how). Located by structure, not magic
    name, mirroring the oracle's strategy and adding the --decision override."""
    bands = _bool_and_assigns(func)
    if not bands:
        # S27 FIX (2026-09-23): fall back to the GUARD-CLAUSE / EARLY-RETURN surface instead of
        # giving up. Giving up here is what made the tool print an identical "0 safeguards
        # analyzed" for clean and for defective guard-clause code alike.
        guards, returns = _guarded_returns(func)
        if len(guards) >= 2 and len(returns) >= 2:
            node = _guard_surface_node(guards, returns)
            return (node, "<guard-clause surface of %s()>" % func.name,
                    "guard-clause/early-return surface (%d guard test(s), %d return(s))"
                    % (len(guards), len(returns)))
        return None, None, "no-boolop-assignment-and-no-guard-clause-surface-in-decision-function"

    if decision_substr:
        for targets, value, _raw in bands:
            if any(decision_substr in t for t in targets):
                nm = next(t for t in targets if decision_substr in t)
                return value, nm, f"--decision match ({nm})"

    for targets, value, _raw in bands:
        if "claims" in targets:
            return value, "claims", "named-claims (BoolOp/And)"

    verdict_hints = ("claim", "deploy", "ship", "verdict", "edge")
    # S27 FIX (2026-09-23): a name the function RETURNS is consumed by the caller's verdict by
    # definition -- the strongest verdict context there is, and the one the old heuristic (Call
    # dumps + keyword names) missed entirely. Without it, `allowed = a or b` returned inside a
    # dict lost to an unrelated `all_self = x and y and z` picked only for being the largest And.
    referenced: set[str] = set(_returned_names(func))
    for node in ast.walk(func):
        if isinstance(node, ast.Call):
            txt = ast.dump(node).lower()
            if any(h in txt for h in verdict_hints):
                referenced |= _names_in(node)
        if isinstance(node, ast.keyword) and node.arg and \
                any(h in node.arg.lower() for h in ("claim", "deploy", "edge", "verdict")):
            referenced |= _names_in(node.value)
    for targets, value, _raw in bands:
        if any(t in referenced for t in targets):
            nm = targets[0] if targets else "<anon>"
            return value, nm, f"structure: BoolOp And/Or consumed by verdict or return ({nm})"

    targets, value, _raw = max(bands, key=lambda t: len(t[1].values))
    nm = targets[0] if targets else "<anon>"
    return value, nm, f"fallback: largest BoolOp/And ({nm})"


# ---------------------------------------------------------------------------
# Transitive taint from a set of seed names
# ---------------------------------------------------------------------------
def taint_closure(bindings, seeds: dict[str, str]):
    """Fixpoint def-use closure. `seeds` maps name -> origin trace line. Returns
    (tainted:set[str], trace:list[str])."""
    tainted: set[str] = set(seeds)
    trace: list[str] = [f"{n}  <- {origin}" for n, origin in seeds.items()]
    changed = True
    while changed:
        changed = False
        for targets, value, _raw in bindings:
            hit = _names_in(value) & tainted
            if hit:
                for t in targets:
                    if t and t not in tainted:
                        tainted.add(t)
                        trace.append(f"{t}  <- via {sorted(hit)}")
                        changed = True
    return tainted, trace


def discover_safeguards(bindings, safeguard_calls: set[str] | None):
    """Return a list of safeguard groups: (label, seed_names:dict[name->origin]).

    With --safeguard-call NAMES: ALL values bound from a call to any NAME are
    grouped into ONE safeguard per NAME (so e.g. every cpcv_paths(...) output is
    one group). Without: each binding whose value is directly a function call is
    its own safeguard group, keyed by the bound var(s) + callee."""
    groups: list[tuple[str, dict[str, str]]] = []

    if safeguard_calls:
        per_call: dict[str, dict[str, str]] = {n: {} for n in safeguard_calls}
        for targets, value, _raw in bindings:
            hit = _calls_to(value, safeguard_calls)
            for cn in hit:
                for t in targets:
                    if t:
                        per_call[cn][t] = f"{cn}(...)"
        for cn in safeguard_calls:
            if per_call[cn]:
                groups.append((f"{cn}(...)", per_call[cn]))
            else:
                groups.append((f"{cn}(...)", {}))  # report not-found explicitly
        return groups

    # auto-discover: each binding directly from a call is one safeguard
    seen: set[tuple] = set()
    for targets, value, _raw in bindings:
        callee = _direct_call_callee(value)
        if callee is None:
            continue
        names = [t for t in targets if t]
        if not names:
            continue
        key = (tuple(names), callee)
        if key in seen:
            continue
        seen.add(key)
        label = f"{', '.join(names)} <- {callee}(...)"
        seeds = {n: f"{callee}(...)" for n in names}
        groups.append((label, seeds))
    return groups


# ---------------------------------------------------------------------------
def run(path: str, decision_substr: str | None, safeguard_calls: list[str] | None,
        function_name: str | None, verbose: bool, strict: bool = False) -> int:
    with open(path, encoding="utf-8") as f:
        src = f.read()
    try:
        tree = ast.parse(src)
    except SyntaxError as e:
        print(f"[ERR] could not parse {path}: {e}")
        print("summary: 0 safeguards analyzed (parse error)")
        return _emit_status(EXIT_INCONCLUSIVE, "source did not parse; nothing was checked")

    func = pick_decision_function(tree, decision_substr, function_name)
    if func is None:
        print(f"[ERR] no decision function found in {path} (no boolean And/Or assignment "
              f"and no guard-clause return chain).")
        print("summary: 0 safeguards analyzed (no decision function)")
        return _emit_status(EXIT_INCONCLUSIVE, "no decision function; nothing was checked")

    verdict_node, verdict_name, how = find_decision_expr(func, decision_substr)
    if verdict_node is None:
        print(f"[DECISION] none found in `{func.name}()`: {how}")
        print("summary: 0 safeguards analyzed (no decision expression)")
        return _emit_status(EXIT_INCONCLUSIVE, "no decision expression; nothing was checked")

    verdict_names = _names_in(verdict_node)
    try:
        verdict_src = ast.get_source_segment(src, verdict_node) or "<unavailable>"
    except Exception:
        verdict_src = "<unavailable>"

    print(f"[FILE]     {path}")
    print(f"[FUNCTION] decision function = `{func.name}()`")
    print(f"[DECISION] `{verdict_name}` ({how})")
    print(f"[DECISION] data dependencies (Names) = {sorted(verdict_names)}")
    if verbose:
        print("[DECISION] expression source:")
        for line in verdict_src.splitlines():
            print(f"           {line}")

    bindings = list(_iter_assign_like(func))
    sg_calls = set(safeguard_calls) if safeguard_calls else None
    groups = discover_safeguards(bindings, sg_calls)

    if not groups:
        print("[SAFEGUARDS] none discovered (no values bound from function calls "
              "in the decision function).")
        print(f"summary: 0 safeguards | 0 reach | 0 decorative | "
              f"decision=`{verdict_name}` in `{func.name}()`")
        return _emit_status(EXIT_INCONCLUSIVE, "0 safeguards discovered; nothing was checked")

    print(f"[SAFEGUARDS] analyzing {len(groups)} safeguard group(s) in `{func.name}()`")
    print("-" * 72)

    n_reach = 0
    n_decor = 0
    n_absent = 0
    for label, seeds in groups:
        if not seeds:
            print(f"NOT-FOUND  {label}")
            print(f"           (no value bound from this call in `{func.name}()`)")
            n_absent += 1
            continue
        tainted, trace = taint_closure(bindings, seeds)
        reaching = tainted & verdict_names
        reaches = bool(reaching)
        tag = "REACHES   " if reaches else "DECORATIVE"
        print(f"{tag} {label}")
        if reaches:
            n_reach += 1
            print(f"           reaches decision via: {sorted(reaching)}")
        else:
            n_decor += 1
            print(f"           computed but NEVER gates `{verdict_name}` "
                  f"(decorative safeguard)")
        if verbose:
            print(f"           taint closure = {sorted(tainted)}")
            for tline in trace:
                print(f"             {tline}")
    print("-" * 72)
    extra = f" | {n_absent} not-found" if n_absent else ""
    print(f"summary: {len(groups)} safeguards | {n_reach} reach | "
          f"{n_decor} decorative{extra} | decision=`{verdict_name}` in `{func.name}()`")
    if n_decor:
        print(f"WARNING: {n_decor} decorative safeguard(s) -- computed but do NOT "
              f"gate the decision.")
    findings = n_decor + n_absent
    if findings and strict:
        return _emit_status(EXIT_FINDINGS,
                            "%d decorative + %d not-found (--strict)" % (n_decor, n_absent))
    if findings:
        return _emit_status(EXIT_CLEAN,
                            "%d decorative + %d not-found reported; pass --strict to make "
                            "findings non-zero" % (n_decor, n_absent))
    return _emit_status(EXIT_CLEAN, "every safeguard reaches the decision")


def main(argv=None) -> int:
    p = argparse.ArgumentParser(
        prog="gate_coherence.py",
        description="Static gate-coherence checker: does each safeguard's value "
                    "actually reach the deploy/verdict decision, or is it "
                    "decorative (computed-but-never-gates)?",
    )
    p.add_argument("pyfile", help="Python source file to analyze")
    p.add_argument("--decision", metavar="SUBSTR", default=None,
                   help="substring of the decision variable's target name "
                        "(else auto-detect the largest boolean-AND assignment)")
    p.add_argument("--safeguard-call", metavar="NAME", nargs="+",
                   action="extend", default=None,
                   help="name(s) of producer function(s) whose outputs are a "
                        "safeguard. Accepts several names after one flag and is "
                        "also repeatable. If omitted, every value bound from a "
                        "function call is treated as a safeguard.")
    p.add_argument("--function", metavar="NAME", default=None,
                   help="force the decision function by name (else auto-detect)")
    p.add_argument("-v", "--verbose", action="store_true",
                   help="print taint traces and the decision expression source")
    p.add_argument("--strict", action="store_true",
                   help="exit 1 when any safeguard is decorative or not-found (default stays 0 "
                        "so existing reporter callers are unaffected). INCONCLUSIVE (2) and "
                        "INTERNAL-ERROR (3) are raised regardless of this flag.")
    args = p.parse_args(argv)
    return run(args.pyfile, args.decision, args.safeguard_call,
               args.function, args.verbose, args.strict)


if __name__ == "__main__":
    # S27 FIX (2026-09-23) -- EXIT-CODE LAUNDERING REMOVED. Both handlers below used to set
    # rc = 0, so a crash (missing file, unreadable path, any internal bug) reported SUCCESS to
    # every caller that reads $?. They now return EXIT_INTERNAL_ERROR, and they do so
    # UNCONDITIONALLY: no flag, --strict included, can turn an internal error back into a pass.
    try:
        rc = main()
    except FileNotFoundError as e:
        print(f"[ERR] file not found: {e}")
        rc = _emit_status(EXIT_INTERNAL_ERROR, "target file not found")
    except Exception as e:  # honest failure surface
        import traceback
        traceback.print_exc()
        print(f"[ERROR] gate_coherence could not run: {type(e).__name__}: {e}")
        rc = _emit_status(EXIT_INTERNAL_ERROR, "unhandled " + type(e).__name__)
    sys.exit(rc)
