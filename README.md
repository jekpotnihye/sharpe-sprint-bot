# Sharpe Sprint Bot — Pump.fun Sharpe Sprint

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/jekpotnihye/sharpe-sprint-bot/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/jekpotnihye/sharpe-sprint-bot/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper-money trading bot for the [Pump.fun Sharpe Sprint — Cleanest Paper
Bot Wins](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
competition on [make.fun](https://make.fun). It trades only on the house
replay harness, with paper money — never real funds, never real trading.

## Strategy

Snipes brand-new pump.fun coins that attract at least 4 distinct buyers
within their first 10 trades and lift at least 5% off their first print:
one small round trip per mint (at most 0.30 SOL, capped at 90% of the
harness buy cap), exiting at +10% take-profit, −5% stop, or after 60
further trades, with at most 5 open positions. See `BUILD.md` for the
measured results of each polish revision on the dev replay — the dev
grade is negative, reported honestly there; no profit is claimed.

## Layout

- `main.ts` — the strategy entrypoint (Node 22, TypeScript as-is).
- `vendor/makefun-bot.ts` — the kit's replay-protocol shim, vendored
  unchanged.
- `BUILD.md` — build rationale and measured grade-local results.
