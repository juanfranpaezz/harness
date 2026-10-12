# Domain-lens format (skill A18)

A **lens** is a curated, on-demand pack of BROAD, category-level methodology knowledge the
Verifier loads for a domain. Purpose: lift catch-rate on subtle defects diluted in large
artifacts — the regime where a bare single pass misses most (see
`../../meta/experiment/verification-measurement-attribution.md`).

## THE HARD RULE — broad principles only, never an answer-sheet

A lens lists the QUESTIONS a rigorous reviewer asks in a domain. It must NEVER name a
specific seeded defect, its code location, its variable/function name, or its exact shape.
Naming the defect just leaks the answer — the attribution experiment proved the "4/4" lift
was largely the checklist *telling the verifier the answer* (RSI/IIR caught only when the
brief literally said "IIR memory exceeds the window"). The defensible, real lift comes from
*general good-practice questions*, applied by the verifier to find the defect itself.

So, for every line in a lens:
- **DO** — phrase it as a QUESTION / principle of general good practice. "Is significance
  measured against the right benchmark, not just vs cash/zero?"
- **DON'T** — phrase it as an answer about THIS artifact. "The DSR here is hollow / the CPCV
  is decorative / `rsi_14` is an IIR filter undersized by MAX_LOOKBACK=20." Anything naming a
  symbol, line number, or the concrete defect is forbidden.

Test each line: *Could this same line ship unchanged in a lens for a different project in the
same domain, before anyone knows what that project's defects are?* If no, it is too specific —
broaden it back to a principle.

## File layout

One file per domain: `.claude/lenses/<domain>.md`. Structure:

```
# Lens — <domain>

When to load: <one line — what kind of artifact triggers this lens>

## Principles a rigorous reviewer asks
- <question / principle, broad, defect-agnostic>
- ...
```

Keep it to ~one screen. Group related questions if it helps, but every bullet stays a
question, not an answer.

## How the Verifier uses it

The verifier subagent (`.claude/agents/verifier.md`) loads the matching lens on demand when an
artifact is in a known domain, and applies its principles as a category-level checklist —
alongside (not instead of) general adversarial rigor and the gate-coherence check. It does NOT
go off researching on its own (measured not to help; it even distracted from cross-module
reading).

## Acceptance — DOWNGRADED, NOT PROVEN (dec-11, measurement deferred INDEFINITELY)

A lens is an OPTIONAL light advisory aid, NEVER relied on. It is UNPROVEN on held-out: dec-06 measured
that review lenses add ≈0 over a strong base model (execution is what catches), and a decisive A18 run —
measure a lens against a held-out defect class it does NOT name, on a DILUTED artifact where the bare arm
misses — is un-runnable without new build (the existing lens NAMES every defect class on disk → no held-out
class). Cost > value for an advisory aid (CA-09; the dec-09/dec-10 "don't measure to polish a capped
mechanism" trap). RE-OPEN a real A18 measurement ONLY if a lens is ever promoted to load-bearing.
The original acceptance test (a lens passes only if it lifts catches on a class it never mentions) stands as
the bar IF that day comes — but it is not pursued now.
