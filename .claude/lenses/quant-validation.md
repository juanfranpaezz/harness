# Lens — quant-validation (backtest & strategy validation)

When to load: the artifact backtests, validates, or gates the deployment of a trading /
forecasting strategy on historical data — anything that produces a performance metric
(Sharpe, returns, hit-rate, a "deploy / don't-deploy" verdict) from past data.

These are the QUESTIONS a rigorous quant reviewer asks. They are general good practice, not
claims about this artifact. Apply them yourself to find what (if anything) is wrong; do not
expect the artifact to fail any particular one. (See `lens-format.md`: principles only, never
a defect name.)

## Leakage / lookahead
- Does any feature, label, or scaling parameter use information not available at the decision
  time it is applied to (future bars, full-sample statistics, target peeking)?
- Are normalization / fit / feature-selection steps fit ONLY on the training portion, or do
  they see the whole sample before the split?
- Is the train/test split chronological, with the test strictly after the train?

## Cross-validation hygiene (purge + embargo + memory)
- For time-series CV, are overlapping/leaking samples between train and test PURGED, and is
  there an EMBARGO gap after each test fold?
- Is the purge/embargo window sized to the TRUE memory of every feature and label — including
  features whose memory is effectively unbounded (recursive / exponentially-weighted / IIR
  filters), not just the nominal lookback window?
- Does the label horizon overlap across samples, and is that overlap accounted for?

## Multiple testing / effective sample size
- How many configurations, parameters, or strategies were tried (explicitly AND implicitly,
  via iteration) before this result was selected?
- Is the reported significance deflated for that number of trials (e.g. a deflated/probabilistic
  performance metric, a minimum-backtest-length argument), or is it a naive single-shot stat?
- What is the EFFECTIVE number of independent observations, given autocorrelation and
  overlapping windows — not the raw row count?

## Significance must be benchmark-relative
- Is outperformance measured against the right BENCHMARK (the passive/buy-and-hold/index
  alternative the strategy actually displaces), or merely against cash / zero?
- "Beats cash" is not "beats the thing you'd otherwise hold." Which baseline does the verdict
  use, and is it the economically correct one?
- Are returns risk-adjusted and net, before any significance claim?

## Distribution, not a point estimate
- Does the gate read a DISTRIBUTION of outcomes (across folds / paths / resamples) or a single
  point number? A single backtest path is one draw.
- Are confidence intervals / dispersion reported and actually used in the decision, or only the
  mean / best case?

## Outlier & robustness
- How much of the total performance comes from a handful of bars/trades/days? Does it survive
  dropping the top-k contributors?
- Is there a robustness check to small perturbations of parameters, periods, and the universe?
- Would the verdict flip under a reasonable alternative specification?

## Regime
- Is performance stable across distinct market regimes (vol, trend, liquidity), or concentrated
  in one period?
- Was the strategy tuned in the same regime it is being validated on?

## Realistic costs & frictions
- Are transaction costs, slippage, market impact, borrow/financing, and fees modeled at
  realistic levels for the strategy's turnover and size?
- Are fills assumed at prices that were actually attainable (no trading at the close you only
  knew after the bar)?

## Survivorship & data quality
- Does the universe include delisted / failed names, or only those that survived to today?
- Are corporate actions, restatements, point-in-time fundamentals, and timestamp alignment
  handled correctly?

## Gate coherence (cross-check with the verifier's general gate-coherence step)
- Does EVERY computed safeguard / statistic actually feed the deploy decision, or is some of it
  computed and then ignored (decorative)?
- Does the final verdict AND together facts about the SAME object (the thing being shipped), or
  does it mix a check on one variant with the deployment of another?
- Is each metric in the verdict compared against the correct threshold and the correct baseline?

## Acceptance — DOWNGRADED, NOT PROVEN (dec-11, measurement deferred INDEFINITELY)
This lens is an OPTIONAL light advisory aid, never relied on (dec-06: review lenses add ≈0 over a strong
base model; execution is what catches). UNPROVEN on held-out: a decisive A18 run is un-runnable without new
build (this lens NAMES every defect class in the only diluted artifact on disk). Re-open a real A18
measurement ONLY if a lens is ever promoted to load-bearing; until then it is not pursued.
