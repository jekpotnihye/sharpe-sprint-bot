// Pump.fun Sharpe Sprint — cleanest paper bot.
// Paper money only: this bot trades on the house replay harness, never real funds.
//
// Idea, from the dev replay: brand-new pump.fun coins that attract several
// distinct buyers within their first few trades, and whose price has already
// lifted a little off its first print, tend to drift up a bit more before
// fading. The bot snipes only those, one small round trip per mint, with a
// take-profit, a tight stop and a short maximum hold, so equity moves in
// many small steps instead of a few wild swings. Everything is deterministic:
// no clock, no randomness, no environment reads; the only state is the event
// stream itself.
//
// Guardrails, documented here so the whole policy is auditable in one
// place (the harness also enforces them): at most 5 open positions at
// once; a round trip counts only at >= 0.01 SOL per mint; at least 20
// distinct mints must be round-tripped; maximum drawdown <= 50%; no
// shorts, no leverage. Exits are governed solely by EXIT_POLICY below:
// take-profit +10%, stop-loss -5%, and a 60-trade maximum hold. Those
// three values are the measured v1 values — do not retune them without
// re-grading, because earlier polishes showed quicker exits worsen
// hourly Sharpe on the dev window (see BUILD.md).

import {
  runBot,
  type Batch,
  type BotState,
  type OrderInput,
} from "./vendor/makefun-bot.ts";

const LAMPORTS_PER_SOL = 1_000_000_000n;

// Entry: at least this many distinct buyers in the mint's first trades.
const MIN_BUYERS = 4;
// Entry: only within the first this many trades of a mint's life.
const MAX_ENTRY_TRADES = 10;
// Entry: price must be at least this far above its first observed print.
const ENTRY_LIFT_BPS = 500;
// (Polish 3's +20% chase cap was tried and dropped: it cut round trips
// from 464 to 152 and made hourly Sharpe worse. Polish 5 keeps it out.)
// Position size: at most this much SOL per mint, and at most 90% of the
// harness buy cap (1% of the mint's real SOL reserve) for safety.
const MAX_SIZE_LAMPORTS = 300_000_000n;
// A round trip must be at least 0.01 SOL to count toward the guardrail.
const MIN_SIZE_LAMPORTS = 10_000_000n;
// Exits: take profit / stop loss / maximum hold, grouped as one policy
// so the whole exit behaviour can be audited — and re-graded — together.
// Values are basis points off the entry print (take-profit / stop-loss)
// and further trades on the mint (maximum hold). They are the measured
// v1 values: TP +10% (1000 bps), stop -5% (500 bps), 60 trades.
// Basis-point arithmetic always divides by BPS_DENOMINATOR (10_000).
const BPS_DENOMINATOR = 10_000;
const EXIT_POLICY = {
  takeProfitBps: 1000,
  stopLossBps: 500,
  maxHoldTrades: 60,
} as const;
// Slippage tolerance on fills, in basis points.
const BUY_SLIPPAGE_BPS = 800;
const SELL_SLIPPAGE_BPS = 1500;

interface MintTrack {
  firstPrice: number;
  trades: number;
  buyers: Set<string>;
  complete: boolean;
  // True only once this run has seen the mint's CreateEvent. A mint first
  // seen through a trade or a mark may already be old: its "first" price
  // is not its birth price, so it must never qualify as a newborn snipe.
  created: boolean;
}

interface EntryRecord {
  entryPrice: number;
  entryTrades: number;
}

// Price of one token in SOL, from the curve's virtual reserves.
function curvePrice(state: BotState, mint: string): number | null {
  const curve = state.curves.get(mint);
  if (curve === undefined) return null;
  if (curve.virtual_token_reserves === 0n) return null;
  if (curve.virtual_quote_reserves === 0n) return null;
  return Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
}

// Exit thresholds for one entry print, from EXIT_POLICY. Kept as a
// helper so the exit loop reads as policy, not arithmetic, while the
// computation stays byte-for-byte the v1 formula: entry * (10000 +/- bps)
// / 10000, evaluated in that order.
function exitThresholds(entryPrice: number): { takeProfit: number; stopLoss: number } {
  return {
    takeProfit:
      (entryPrice * (BPS_DENOMINATOR + EXIT_POLICY.takeProfitBps)) / BPS_DENOMINATOR,
    stopLoss:
      (entryPrice * (BPS_DENOMINATOR - EXIT_POLICY.stopLossBps)) / BPS_DENOMINATOR,
  };
}

const tracks = new Map<string, MintTrack>();
const attempted = new Set<string>();
const entries = new Map<string, EntryRecord>();

function trackFor(mint: string, firstPrice: number): MintTrack {
  let track = tracks.get(mint);
  if (track === undefined) {
    track = { firstPrice, trades: 0, buyers: new Set<string>(), complete: false, created: false };
    tracks.set(mint, track);
  }
  return track;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    // Fold this batch's events into per-mint trackers, in chain order.
    for (const event of batch.events) {
      if (event.event === "CreateEvent") {
        const price =
          Number(event.virtual_quote_reserves) / Number(event.virtual_token_reserves);
        // Birth resets the tracker: trades seen before the create (if any)
        // belong to a life the bot did not witness from the start.
        tracks.set(event.mint, {
          firstPrice: price,
          trades: 0,
          buyers: new Set<string>(),
          complete: false,
          created: true,
        });
      } else if (event.event === "TradeEvent") {
        const price =
          Number(event.virtual_quote_reserves) / Number(event.virtual_token_reserves);
        const track = trackFor(event.mint, price);
        track.trades += 1;
        if (event.is_buy) track.buyers.add(event.user);
      } else if (event.event === "CompleteEvent") {
        const track = tracks.get(event.mint);
        if (track !== undefined) track.complete = true;
      }
    }

    // Record an entry print the first time a position is seen, from the
    // mark price then. (Polishes 2 and 4 tried the fill quote and the
    // decision price instead; both graded worse than this on the dev
    // window. Polish 5 restores the v1 behaviour, which measured best.)
    for (const [mint] of state.positions) {
      if (!entries.has(mint)) {
        const price = curvePrice(state, mint);
        const track = tracks.get(mint);
        if (price !== null) {
          entries.set(mint, { entryPrice: price, entryTrades: track?.trades ?? 0 });
        }
      }
    }

    const pendingBuys = new Set<string>();
    const pendingSells = new Set<string>();
    for (const pending of state.pending.values()) {
      if (pending.order.side === "buy") pendingBuys.add(pending.order.mint);
      else pendingSells.add(pending.order.mint);
    }

    const orders: OrderInput[] = [];
    const maxOrders = state.hello.caps.max_orders_per_batch;
    const txFee = state.txFeeLamports();
    let reserved = 0n;

    // Exits first: take profit, stop loss, or stale position.
    for (const [mint, position] of state.positions) {
      if (pendingSells.has(mint)) continue;
      const track = tracks.get(mint);
      if (track?.complete) continue;
      const record = entries.get(mint);
      const price = curvePrice(state, mint);
      if (record === undefined || price === null) continue;
      const age = (track?.trades ?? record.entryTrades) - record.entryTrades;
      const thresholds = exitThresholds(record.entryPrice);
      const up = price >= thresholds.takeProfit;
      const down = price <= thresholds.stopLoss;
      if (up || down || age >= EXIT_POLICY.maxHoldTrades) {
        orders.push({
          side: "sell",
          mint,
          token_amount: BigInt(position.token_amount),
          max_slippage_bps: SELL_SLIPPAGE_BPS,
        });
      }
    }

    // Entries: one small snipe per mint, only while slots remain.
    if (orders.length < maxOrders) {
      for (const [mint, track] of tracks) {
        if (orders.length >= maxOrders) break;
        if (attempted.has(mint)) continue;
        if (state.positions.has(mint)) continue;
        if (pendingBuys.has(mint)) continue;
        if (track.complete) continue;
        if (!track.created) continue;
        if (track.trades < 1 || track.trades > MAX_ENTRY_TRADES) continue;
        if (track.buyers.size < MIN_BUYERS) continue;
        const price = curvePrice(state, mint);
        if (price === null) continue;
        if (price * BPS_DENOMINATOR < track.firstPrice * (BPS_DENOMINATOR + ENTRY_LIFT_BPS)) continue;
        if (state.committedPositionCount() + orders.filter((o) => o.side === "buy").length >= 5) break;
        const cap = state.maxBuyLamports(mint);
        let size = cap * 9n / 10n;
        if (size > MAX_SIZE_LAMPORTS) size = MAX_SIZE_LAMPORTS;
        if (size < MIN_SIZE_LAMPORTS) continue;
        if (state.freeCashLamports() - reserved < size + txFee) continue;
        reserved += size + txFee;
        attempted.add(mint);
        orders.push({
          side: "buy",
          mint,
          quote_lamports: size,
          max_slippage_bps: BUY_SLIPPAGE_BPS,
        });
      }
    }

    return orders;
  },
});
