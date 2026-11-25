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

Measured grade-local result: (to be recorded after the first grade run).
