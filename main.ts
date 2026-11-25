// Pump.fun Sharpe Sprint — cleanest paper bot.
//
// Paper money only. This program trades on the house replay harness and
// never touches real funds.
//
// The idea, measured on the dev replay: a brand-new pump.fun coin that
// draws several distinct buyers inside its first few trades, and whose
// price has already lifted a little above its first print, tends to drift
// a bit further up before fading. So the bot snipes only those coins —
// one small round trip per mint — and exits on a take-profit, a tight
// stop, or a short maximum hold, so equity moves in many small steps
// rather than a few wild swings.
//
// Everything here is deterministic: no clock, no randomness, no reads
// from the environment. The only state is the event stream itself.
//
// Guardrails, stated here so the whole policy can be audited in one
// place (the harness enforces them too): at most 5 open positions at a
// time; a round trip counts only at 0.01 SOL or more per mint; at least
// 20 distinct mints must be round-tripped; maximum drawdown at most 50%.
// No shorts, no leverage. All exits are governed solely by EXIT_POLICY
// below: take-profit +10%, stop-loss -5%, maximum hold 60 trades. Those
// three numbers are the measured v1 values — changing them without
// re-grading is not safe, because earlier polish variants showed that
// quicker exits made hourly Sharpe worse on the dev window (see
// BUILD.md for the measured variants).

import {
  runBot,
  type Batch,
  type BotState,
  type OrderInput,
} from "./vendor/makefun-bot.ts";

const LAMPORTS_PER_SOL = 1_000_000_000n;

// Entry filter: a mint needs at least this many distinct buyers among
// its first trades before it can qualify for a snipe.
const MIN_BUYERS = 4;
// Entry filter: only mints still inside their first few trades qualify.
const MAX_ENTRY_TRADES = 10;
// Entry filter: the price must sit at least this far (in basis points)
// above the mint's first observed print.
const ENTRY_LIFT_BPS = 500;
// Position sizing: at most this much SOL per mint, and at most 90% of
// the harness buy cap (1% of the mint's real SOL reserve), for safety.
// (A +20% chase cap was tried in an earlier polish and dropped: it cut
// round trips from 464 to 152 and made hourly Sharpe worse.)
const MAX_SIZE_LAMPORTS = 300_000_000n;
// A round trip must be at least 0.01 SOL to count toward the guardrail.
const MIN_SIZE_LAMPORTS = 10_000_000n;
// Exits, grouped as one policy so the whole exit behaviour can be
// audited — and re-graded — together. The values are basis points away
// from the entry print (take-profit / stop-loss) and further trades on
// the mint (maximum hold). They are the measured v1 values: take-profit
// +10% (1000 bps), stop-loss -5% (500 bps), 60 trades. Basis-point
// arithmetic always divides by BPS_DENOMINATOR (10_000).
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
  // True only once this run has actually seen the mint's CreateEvent.
  // A mint first noticed through a trade or a mark may already be old:
  // its "first" price is not its birth price, so it must never qualify
  // as a newborn snipe.
  created: boolean;
}

interface EntryRecord {
  entryPrice: number;
  entryTrades: number;
}

// Price of one token in SOL, read off the curve's virtual reserves.
function curvePrice(state: BotState, mint: string): number | null {
  const curve = state.curves.get(mint);
  if (curve === undefined) return null;
  if (curve.virtual_token_reserves === 0n) return null;
  if (curve.virtual_quote_reserves === 0n) return null;
  return Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
}

// Exit thresholds for one entry print, derived from EXIT_POLICY. Kept
// as a helper so the exit loop reads as policy rather than arithmetic,
// while the computation stays byte-for-byte the v1 formula:
// entry * (10000 +/- bps) / 10000, evaluated in that order.
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
    // Fold this batch's events into the per-mint trackers, in chain order.
    for (const event of batch.events) {
      if (event.event === "CreateEvent") {
        const price =
          Number(event.virtual_quote_reserves) / Number(event.virtual_token_reserves);
        // Birth resets the tracker: any trades seen before the create
        // (if there were any) belong to a life the bot did not witness
        // from the start.
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

    // Record an entry print the first time a position is seen, taken
    // from the mark price at that moment. (Earlier polishes tried the
    // fill quote and the decision price instead; both graded worse than
    // this on the dev window. This restores the best-measured v1
    // behaviour, as documented in BUILD.md.)
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

    // Exits first: take profit, stop loss, or a stale position.
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
