# BUILD.md — Pump.fun Sharpe Sprint paper bot

Paper money only. The bot runs on the house pump.fun replay; it never
touches real funds. Metric: hourly Sharpe ratio on the final 6-hour window,
with guardrails of at least 20 distinct-mint round trips of >= 0.01 SOL,
at most 5 open positions, and max drawdown <= 50%.

## v1 — early-snipe momentum (this revision)

Rationale: an offline sweep over the kit's 24h dev dataset (128,058 events,
1,222 mints, my own simulator in /tmp, fills at the next trade, 1.25% curve
fee per side + 105,000 lamports tx fee, 0.9% of real-reserve size cap)
showed plain momentum-chasing after +10–50% rises loses about 3% per round
trip, dip-buying loses about 4% per round trip, while buying very early —
within the first 10 trades, >= 4 distinct buyers, price >= +5% over the
first print — averaged about +6% per round trip (win rate ~0.42–0.53
depending on the exit). The >= 4 distinct-buyer filter was the difference:
it was positive in every 6-hour chunk of the dev window and its profit was
broad-based (top 3 coins only ~1.3 of ~4.1 SOL in the full-window sim),
not one lucky coin. That suits a Sharpe ranking: many small, similar-sized
round trips rather than one moonshot.

Parameters: entry within first 10 trades, >= 4 distinct buyers, >= +5%
lift; size min(0.30 SOL, 90% of the harness buy cap); exit at +10%
take-profit, -5% stop, or 60 further trades; one attempt per mint ever;
max 5 open positions; buy slippage 800 bps, sell slippage 1500 bps.

Measured grade-local result (process driver, Node v24 vs the server's
Node v26 harness, so result_sha256 will differ on the server): Sharpe
(hourly) -0.2468, net PnL -0.568 SOL, return -5.68%, max drawdown 0.078,
win rate 0.334 over 464 round trips / 464 distinct mints, 923 fills,
38 rejected, 14 failed. Guardrails met. The bot traded far more coins
(464) than the offline sim's ~283, at a much lower win rate — consistent
with entering coins first seen mid-life, whose "first print" was not
their birth price.

## Polish 1 — enter only witnessed births

Rationale: require the mint's CreateEvent to have been seen in this run
before any entry, resetting the tracker at birth. Mints first observed via
a trade or mark are never treated as newborns. Nothing else changed, so
the grade delta isolates this filter.

Measured grade-local result: IDENTICAL to v1 (Sharpe -0.2468, PnL
-0.568 SOL, same action_log_sha256) — the filter excluded nothing, so every
entry already had a witnessed birth. Hypothesis rejected; the sim gap is
elsewhere, most plausibly fill/exit measurement.

## Polish 2 — entry print from the buy fill

Rationale: v1 measured take-profit/stop from the mark price at the first
batch where the position appeared, which can be several trades after the
fill on a fast coin. Polish 2 records the entry print from the buy fill
itself (quote_lamports / token_amount, fees included) and falls back to
the mark only when no fill record was seen.

Measured grade-local result: Sharpe -0.6445, net PnL -1.166 SOL, win
rate 0.281 over 499 round trips. WORSE than v1 on every metric: the
fee/impact-inclusive fill print pulls the stop closer and pushes the
take-profit further away, so exits fire sooner at a loss and later at a
gain. Reverted in polish 3.

## Polish 3 — revert fill print, cap the chase, exit quicker

Rationale: (1) restore the v1 mark-based entry print; (2) refuse entries
whose price has already run more than +20% over the first print by
decision time, since the harness decides per slot-batch and fills two
slots later, so a stale +5% crossing can fill on a badly extended price;
(3) quicker exits, TP +8% / stop -4% / 40 trades, the middle of the
sim's flat optimum (TP6/S3/H30 and TP8/S4/H40 both beat TP10/S5/H60
in the offline sweep, and shorter holds cut exposure to the fade that
follows most early spikes).

Measured grade-local result: (to be recorded after the polish-3 grade run).
