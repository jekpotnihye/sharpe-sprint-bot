// ============================================================================
// Pump.fun Sharpe Sprint — cleanest paper bot.
//
// Paper money only. This program trades on the house replay harness and
// never touches real funds, real markets, or any live chain. It reads one
// stream of pump.fun bonding-curve events, decides one reply of orders
// per batch, and keeps no state beyond the trackers in this file.
//
// ----------------------------------------------------------------------------
// The strategy, in one paragraph
// ----------------------------------------------------------------------------
// A brand-new pump.fun coin that draws several distinct buyers inside its
// first few trades, and whose price has already lifted a little above its
// first print, tends to drift a bit further up before fading. So the bot
// snipes only those coins — one small round trip per mint, ever — and
// exits on a take-profit, a tight stop, or a short maximum hold, so equity
// moves in many small steps rather than a few wild swings. That shape is
// what an hourly-Sharpe ranking rewards: steady, controlled gains beat one
// lucky moonshot, and a single moonshot cannot carry a negative mean.
//
// The entry signal was chosen by measurement, not by intuition. An offline
// sweep over the kit's dev dataset (see BUILD.md) showed plain
// momentum-chasing after +10–50% rises losing about 3% per round trip and
// dip-buying losing about 4%, while buying very early — within the first
// 10 trades, at least 4 distinct buyers, price at least +5% over the first
// print — averaged about +6% per round trip in the simulator. The
// distinct-buyer filter was the difference: it was positive in every
// 6-hour chunk of the dev window and its profit was broad-based, not one
// lucky coin. The harness grades the same idea more harshly (fill quotes,
// own price impact, 2-slot latency, slippage rejections, failed
// transactions), and the measured dev grade is NEGATIVE — Sharpe
// -0.2468, net PnL -0.568 SOL over 464 round trips. That number is
// reported honestly in BUILD.md and in README.md; no profit is claimed.
// The final 6-hour window is a fresh sample, and nothing here promises
// that it will grade better than the dev window did.
//
// ----------------------------------------------------------------------------
// Parameters (the whole policy, in one place)
// ----------------------------------------------------------------------------
// Entry — a mint may be sniped only when ALL of these hold at decision
// time, in the order the entry loop checks them:
//   * the mint has not been attempted before (one attempt per mint, ever);
//   * no position in it is held and no buy for it is already pending;
//   * its curve has not completed (migrated);
//   * its CreateEvent was actually witnessed in this run (see the
//     `created` flag on MintTrack: a mint first noticed through a trade
//     or a mark may already be old, so its "first" price is not its
//     birth price and it must never qualify as a newborn snipe);
//   * it is inside its entry window: at least 1 and at most 10 trades
//     seen (MIN_BUYERS / MAX_ENTRY_TRADES below);
//   * at least 4 distinct buyers have traded it (MIN_BUYERS);
//   * its current curve price sits at least +5% (500 bps) above its
//     first observed print (ENTRY_LIFT_BPS).
// Sizing — at most 0.30 SOL per mint, and at most 90% of the harness buy
// cap (1% of the mint's real SOL reserve), whichever is smaller; a round
// trip below 0.01 SOL does not count toward the guardrail, so sizes below
// that floor are skipped rather than sent. Cash is reserved per buy
// (size plus one transaction fee) so later buys in the same reply cannot
// spend cash an earlier buy in the same reply already committed.
// Exits — every open position is checked every batch, exits before
// entries, and leaves on the FIRST of: take-profit +10%, stop-loss -5%,
// or 60 further trades on the mint since the entry print was recorded
// (EXIT_POLICY). The entry print is the mark price the first time the
// position is seen in state.positions; earlier polish variants tried the
// fill quote and the decision-time price instead, and both graded worse
// on the dev window (BUILD.md, polishes 2 and 4). A completed curve is
// never exited by this bot — the harness closes it itself.
// Guardrails, stated here so the whole policy can be audited in one
// place (the harness enforces them too): at most 5 open positions at a
// time; a round trip counts only at 0.01 SOL or more per mint; at least
// 20 distinct mints must be round-tripped; maximum drawdown at most 50%.
// No shorts, no leverage.
//
// ----------------------------------------------------------------------------
// Determinism and polish history
// ----------------------------------------------------------------------------
// Everything here is deterministic: no clock, no randomness, no reads
// from the environment, no network, no file access. The only inputs are
// the event stream and the harness state for the batch being answered,
// and the only state is the three maps at module scope (per-mint
// trackers, attempted mints, entry records). Two executions of the same
// run therefore produce byte-identical action logs, which the harness
// requires. Helpers in this file are pure functions of their arguments
// (or small, explicit mutations of one tracker) with the same arithmetic
// as the inline code they replaced, in the same order of operations, so
// restructuring the code cannot change a single order the bot sends.
// Polish history, measured on the same dev window (full detail and
// numbers in BUILD.md): v1, the configuration above; polish 1, the
// witnessed-birth filter (changed nothing — every entry already had a
// witnessed birth); polish 2, entry print from the buy fill (worse);
// polish 3, a +20% chase cap plus quicker exits (smaller loss, much
// worse Sharpe, far fewer round trips); polish 4, entry print from the
// decision price (worse); polish 5, restore the v1 configuration exactly
// (byte-identical action log to v1). The post-opening re-authoring in
// this session restructures the code only — comments, doc comments, and
// pure-helper extraction — and changes no parameter, filter, sizing,
// slippage, or guardrail value. The grade-local verification after the
// rewrite must reproduce the v1 action log exactly, or the rewrite is
// wrong and must be fixed before anything is committed.
//
// ----------------------------------------------------------------------------
// Reading guide: where each decision lives
// ----------------------------------------------------------------------------
// Readers auditing this file against the v1 behaviour should start from
// the three module-scope maps (tracks, attempted, entries) and then read
// onBatch top to bottom; every decision in onBatch is delegated to at
// most one named helper, and every helper's doc comment states the
// original inline expression it replaces, so a reviewer can check each
// replacement without trusting this header. The map of the file:
//   * event folding — foldBatchEvents / foldChainEvent / recordTrade /
//     trackFor / freshTrack: turn the batch's chain events into
//     per-mint trackers, in chain order, with birth resets.
//   * prices — eventPrice (events) and curvePrice (live curves): the
//     same Number division, with the live-curve version guarding
//     against missing or empty curves.
//   * entry prints — recordEntryPrints: first-seen mark price per
//     position, recorded once and never overwritten.
//   * pending orders — pendingOrderMints: which mints already have a
//     buy or a sell in flight, recomputed every batch.
//   * exits — shouldExitPosition / holdAgeInTrades / exitThresholds:
//     the three triggers, measured from the entry record.
//   * entries — passesEntryGates / withinEntryWindow /
//     hasEnoughDistinctBuyers / entryLiftFloor / cappedBuySize /
//     exceedsAvailableCash / countBuyOrders: the gates, the lift test,
//     the sizing, the cash test, and the open-position cap.
//   * orders — buildSellOrder / buildBuyOrder: the two order shapes,
//     with their slippage tolerances, in exactly one place each.
// Invariants a reviewer can check without running the bot: (1) no
// helper reads the clock, randomness, the environment, or the network;
// (2) no helper mutates anything except the tracker it is handed (or,
// for the folding helpers, the tracker map it is handed); (3) every
// numeric helper preserves the original expression's order of
// operations, including bigint multiplication before division in
// cappedBuySize and the division-last form in exitThresholds; (4) the
// entry loop never marks a mint attempted before every skip test has
// passed, and the exit loop never sends two sells for one mint in one
// reply. If any invariant ever stops holding, the action log is the
// first thing to re-check — it must still hash to the v1 value.
// ============================================================================

import {
  runBot,
  type Batch,
  type BotState,
  type ChainEvent,
  type Holding,
  type OrderInput,
} from "./vendor/makefun-bot.ts";

// One SOL, in lamports. Kept as a named constant for readability at the
// sizing sites; the harness capital is 10 SOL (10_000_000_000 lamports).
const LAMPORTS_PER_SOL = 1_000_000_000n;

// Entry filter: a mint needs at least this many distinct buyers among
// its first trades before it can qualify for a snipe. Distinct buyers,
// not trade count, is what separated signal from noise in the offline
// sweep: a single buyer wash-trading a newborn coin looks busy but
// carries no crowd behind it.
const MIN_BUYERS = 4;
// Entry filter: only mints still inside their first few trades qualify.
// A mint first seen at trade 11 or later has already had its early drift;
// chasing it is the momentum-chasing behaviour the sweep showed loses
// about 3% per round trip.
const MAX_ENTRY_TRADES = 10;
// Entry filter: the price must sit at least this far (in basis points)
// above the mint's first observed print. 500 bps is +5%: enough lift to
// show buyers are actually pushing the price, small enough that the
// entry is still early.
const ENTRY_LIFT_BPS = 500;
// Position sizing: at most this much SOL per mint, and at most 90% of
// the harness buy cap (1% of the mint's real SOL reserve), for safety.
// The 90% factor leaves headroom against the cap so a buy is not
// rejected for grazing the cap when reserves move between decision and
// fill. (A +20% chase cap was tried in an earlier polish and dropped:
// it cut round trips from 464 to 152 and made hourly Sharpe worse.)
const MAX_SIZE_LAMPORTS = 300_000_000n;
// A round trip must be at least 0.01 SOL to count toward the guardrail
// (at least 20 distinct-mint round trips of >= 0.01 SOL). Sizes below
// this floor are skipped: sending them would spend fees and a slot for
// a trade the guardrail would not even count.
const MIN_SIZE_LAMPORTS = 10_000_000n;
// Exits, grouped as one policy so the whole exit behaviour can be
// audited — and re-graded — together. The values are basis points away
// from the entry print (take-profit / stop-loss) and further trades on
// the mint (maximum hold). They are the measured v1 values: take-profit
// +10% (1000 bps), stop-loss -5% (500 bps), 60 trades. Basis-point
// arithmetic always divides by BPS_DENOMINATOR (10_000), and the exit
// thresholds are always computed as entry * (10000 +/- bps) / 10000, in
// that order — see exitThresholds. Changing any of these three numbers
// without re-grading is not safe: quicker exits made hourly Sharpe
// worse on the dev window (BUILD.md, polish 3).
const BPS_DENOMINATOR = 10_000;
const EXIT_POLICY = {
  takeProfitBps: 1000,
  stopLossBps: 500,
  maxHoldTrades: 60,
} as const;
// Slippage tolerance on fills, in basis points: 800 bps (8%) on buys,
// 1500 bps (15%) on sells. Sells tolerate more slippage because a stale
// position that cannot exit at all is worse than an exit a little past
// the threshold; buys are the discretionary side, so they are stricter.
const BUY_SLIPPAGE_BPS = 800;
const SELL_SLIPPAGE_BPS = 1500;

interface MintTrack {
  // Price of the mint's first observed print, in SOL per token, read
  // off the curve's virtual reserves at the moment it was first seen.
  // For a witnessed birth this is the CreateEvent price; for a mint
  // first noticed later it is whatever print happened to arrive first,
  // which is exactly why `created` below must gate entry.
  firstPrice: number;
  // Trades seen on this mint in this run, counting from the tracker's
  // creation (or its reset at a witnessed birth). This is the clock
  // the entry window and the maximum hold both read.
  trades: number;
  // Distinct buyer addresses seen trading this mint. A Set, so one
  // buyer trading ten times still counts as one buyer.
  buyers: Set<string>;
  // True once this run has seen the mint's CompleteEvent: the curve
  // migrated, its tradable life is over, and no new entry may be made.
  complete: boolean;
  // True only once this run has actually seen the mint's CreateEvent.
  // A mint first noticed through a trade or a mark may already be old:
  // its "first" price is not its birth price, so it must never qualify
  // as a newborn snipe.
  created: boolean;
}

interface EntryRecord {
  // Mark price at the first batch where the position was seen in
  // state.positions. All three exit tests are measured from this print.
  entryPrice: number;
  // The mint's trade count at that same moment. The maximum hold is
  // measured as further trades since this count, not as wall time:
  // `holdAgeInTrades` subtracts it from the current trade count.
  entryTrades: number;
}

// Price of one token in SOL, implied by a pair of virtual reserves:
// quote reserves divided by token reserves, as plain numbers. This is
// the raw division the event handlers use too (see eventPrice); the
// two helpers exist separately because curvePrice must ALSO guard
// against a missing or empty curve, while an event's reserves are
// always present by construction. Do not merge the guard into
// eventPrice: an event with zero reserves must keep dividing exactly
// as the original inline code did.
function eventPrice(virtualQuoteReserves: string, virtualTokenReserves: string): number {
  return Number(virtualQuoteReserves) / Number(virtualTokenReserves);
}

// A fresh tracker for a mint first seen at `firstPrice`: no trades yet,
// no buyers yet, not complete, and — unless the caller says otherwise
// by resetting it at a witnessed birth — not a witnessed creation.
function freshTrack(firstPrice: number): MintTrack {
  return {
    firstPrice,
    trades: 0,
    buyers: new Set<string>(),
    complete: false,
    created: false,
  };
}

// Look a mint's tracker up, creating one at `firstPrice` when this is
// the mint's first sighting. The tracker is stored before it is
// returned, so later events for the same mint find the same object and
// accumulate onto it rather than starting over.
function trackFor(mint: string, firstPrice: number): MintTrack {
  let track = tracks.get(mint);
  if (track === undefined) {
    track = freshTrack(firstPrice);
    tracks.set(mint, track);
  }
  return track;
}

// Fold one trade into a tracker: the trade count always advances by
// one, and a buy adds its trader to the distinct-buyer set. A sell
// advances the count but adds nobody — sellers are not evidence of
// crowd interest in a newborn coin.
function recordTrade(track: MintTrack, isBuy: boolean, user: string): void {
  track.trades += 1;
  if (isBuy) track.buyers.add(user);
}

// Fold a single chain event into the per-mint trackers, preserving the
// exact behaviour of the original inline folding, event by event:
//   * CreateEvent — birth resets the tracker. Any trades seen before
//     the create (if there were any) belong to a life the bot did not
//     witness from the start, so they are discarded, not carried over.
//     The new tracker is marked `created: true` and its first price is
//     the create's own reserves.
//   * TradeEvent — the price at this trade becomes the first price only
//     when the mint has no tracker yet (via trackFor); otherwise the
//     existing first price stands. The trade is then recorded.
//   * CompleteEvent — the mint is marked complete when a tracker
//     exists; a complete event for an untracked mint creates nothing.
function foldChainEvent(event: ChainEvent, tracks: Map<string, MintTrack>): void {
  if (event.event === "CreateEvent") {
    const price = eventPrice(event.virtual_quote_reserves, event.virtual_token_reserves);
    tracks.set(event.mint, {
      firstPrice: price,
      trades: 0,
      buyers: new Set<string>(),
      complete: false,
      created: true,
    });
  } else if (event.event === "TradeEvent") {
    const price = eventPrice(event.virtual_quote_reserves, event.virtual_token_reserves);
    const track = trackFor(event.mint, price);
    recordTrade(track, event.is_buy, event.user);
  } else if (event.event === "CompleteEvent") {
    const track = tracks.get(event.mint);
    if (track !== undefined) track.complete = true;
  }
}

// Fold a whole batch's events into the trackers, in chain order. Order
// matters: a create that arrives after earlier trades for the same mint
// resets the tracker, and a complete that arrives mid-batch must gate
// entries decided later in this same batch, so events are folded
// strictly in the order the harness delivers them.
function foldBatchEvents(events: readonly ChainEvent[], tracks: Map<string, MintTrack>): void {
  for (const event of events) {
    foldChainEvent(event, tracks);
  }
}

// Price of one token in SOL, read off the curve's latest virtual
// reserves. Returns null when the curve is unknown or either reserve
// is zero — a zero reserve would make the division meaningless, and a
// missing curve means the harness has told this bot nothing about the
// mint yet. Callers treat null as "no usable price": no entry print is
// recorded and no entry or exit is decided from it.
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
// entry * (10000 +/- bps) / 10000, evaluated in that order — the
// addition/subtraction happens before the multiplication, and the
// division by BPS_DENOMINATOR happens last, exactly as written here.
function exitThresholds(entryPrice: number): { takeProfit: number; stopLoss: number } {
  return {
    takeProfit:
      (entryPrice * (BPS_DENOMINATOR + EXIT_POLICY.takeProfitBps)) / BPS_DENOMINATOR,
    stopLoss:
      (entryPrice * (BPS_DENOMINATOR - EXIT_POLICY.stopLossBps)) / BPS_DENOMINATOR,
  };
}

// How many further trades on the mint have been seen since the entry
// print was recorded. When the mint has no tracker (it cannot happen
// for a held position in practice, but the code must not assume it),
// the entry trade count is used as the current count, giving an age of
// zero — a position with no track history is treated as just entered,
// never as stale.
function holdAgeInTrades(track: MintTrack | undefined, record: EntryRecord): number {
  return (track?.trades ?? record.entryTrades) - record.entryTrades;
}

// The single exit decision for one open position at one price: true
// when the price has reached the take-profit, fallen to the stop-loss,
// or the position has been held for the maximum number of further
// trades. The three tests are evaluated in the same order as the
// original inline code (profit, then loss, then age), and the age test
// uses `>=`, so a position is exited on the very batch its hold limit
// is reached, not one batch later.
function shouldExitPosition(
  price: number,
  record: EntryRecord,
  track: MintTrack | undefined,
): boolean {
  const age = holdAgeInTrades(track, record);
  const thresholds = exitThresholds(record.entryPrice);
  const up = price >= thresholds.takeProfit;
  const down = price <= thresholds.stopLoss;
  return up || down || age >= EXIT_POLICY.maxHoldTrades;
}

// Split the still-pending orders into the mints with a buy pending and
// the mints with a sell pending. A mint with a buy pending must not
// receive a second buy (one attempt per mint, and no doubling up while
// the first buy is still in flight); a mint with a sell pending must
// not receive a second sell. Any other pending side is treated as a
// sell — the harness only ever sends buys and sells, so the else
// branch is the sell branch, exactly as in the original loop.
function pendingOrderMints(state: BotState): { buys: Set<string>; sells: Set<string> } {
  const buys = new Set<string>();
  const sells = new Set<string>();
  for (const pending of state.pending.values()) {
    if (pending.order.side === "buy") buys.add(pending.order.mint);
    else sells.add(pending.order.mint);
  }
  return { buys, sells };
}

// How many of the orders already decided in this reply are buys. The
// entry loop reads this fresh on every candidate mint, because each buy
// appended to the reply counts toward the 5-open-position cap together
// with the positions already committed — see the slot check in the
// entry loop, which must see buys decided earlier in this same reply.
function countBuyOrders(orders: readonly OrderInput[]): number {
  return orders.filter((o) => o.side === "buy").length;
}

// True when the reply being built still has room for another order:
// the number of orders decided so far is below the harness per-batch
// cap. Used both as the guard for entering the entry section at all
// and as the per-iteration stop test inside the entry loop; the two
// uses are complements of one comparison on integer counts
// (orders.length < maxOrders here, orders.length >= maxOrders for the
// break), so extracting them into one helper cannot change which
// batches enter the loop or when the loop stops.
function hasOrderSlot(orders: readonly OrderInput[], maxOrders: number): boolean {
  return orders.length < maxOrders;
}

// The price floor a mint's first print must be lifted past for the
// entry signal to fire: firstPrice * (10000 + ENTRY_LIFT_BPS). The
// entry loop compares `price * BPS_DENOMINATOR` against this floor
// directly (see the loop), keeping the comparison itself inline so the
// exact `<` form of the original test is preserved word for word.
function entryLiftFloor(firstPrice: number): number {
  return firstPrice * (BPS_DENOMINATOR + ENTRY_LIFT_BPS);
}

// True when the mint is inside its entry window: at least one trade
// seen (a tracker with no trades has shown no activity at all) and no
// more than MAX_ENTRY_TRADES. Trade counts are plain integer counters,
// so the inclusive bounds here are exactly the original
// `trades < 1 || trades > MAX` rejection, negated.
function withinEntryWindow(track: MintTrack): boolean {
  return track.trades >= 1 && track.trades <= MAX_ENTRY_TRADES;
}

// True when enough distinct buyers have traded the mint. The buyer set
// is a Set of addresses, so repeat trades by one buyer never inflate
// this count — see recordTrade.
function hasEnoughDistinctBuyers(track: MintTrack): boolean {
  return track.buyers.size >= MIN_BUYERS;
}

// Whether a mint passes every entry gate that does not depend on the
// current price, the cash position, or the open-position cap — in the
// original check order. All of these are pure reads with no side
// effects, so their relative order cannot change the outcome; they are
// kept in the original order anyway so the code can be audited against
// the v1 loop gate by gate: not attempted before, not held, no buy
// pending, not complete, witnessed birth, inside the entry window,
// enough distinct buyers.
function passesEntryGates(
  mint: string,
  track: MintTrack,
  attempted: ReadonlySet<string>,
  state: BotState,
  pendingBuys: ReadonlySet<string>,
): boolean {
  if (attempted.has(mint)) return false;
  if (state.positions.has(mint)) return false;
  if (pendingBuys.has(mint)) return false;
  if (track.complete) return false;
  if (!track.created) return false;
  if (!withinEntryWindow(track)) return false;
  if (!hasEnoughDistinctBuyers(track)) return false;
  return true;
}

// The buy size for one mint at the harness cap: 90% of the cap,
// computed as (cap * 9) / 10 in bigint arithmetic — the multiplication
// happens before the division, exactly as in the original line — and
// then clamped down to MAX_SIZE_LAMPORTS when the 90% figure is larger.
// The result is never clamped UP: a small cap stays small, and the
// caller skips it when it falls below MIN_SIZE_LAMPORTS.
function cappedBuySize(cap: bigint): bigint {
  let size = (cap * 9n) / 10n;
  if (size > MAX_SIZE_LAMPORTS) size = MAX_SIZE_LAMPORTS;
  return size;
}

// True when the cash left after reserving earlier buys in this reply
// cannot cover this buy plus its transaction fee. The comparison is
// kept in the original `<` form: free cash minus reserved, against size
// plus fee. Free cash here is the harness figure net of pending orders
// (state.freeCashLamports), read fresh by the caller on every mint, and
// `reserved` is only what THIS reply has committed so far.
function exceedsAvailableCash(
  freeCash: bigint,
  reserved: bigint,
  size: bigint,
  txFee: bigint,
): boolean {
  return freeCash - reserved < size + txFee;
}

// The sell order that closes a whole position: the full token balance,
// converted with BigInt exactly as the original code did (the holding
// already stores a bigint, so this is the identity conversion, kept
// explicit so the order's amount type is unambiguous), at the sell
// slippage tolerance.
function buildSellOrder(mint: string, position: Holding): OrderInput {
  return {
    side: "sell",
    mint,
    token_amount: BigInt(position.token_amount),
    max_slippage_bps: SELL_SLIPPAGE_BPS,
  };
}

// The buy order for one snipe: the sized quote amount in lamports at
// the buy slippage tolerance. The mint is marked attempted by the
// caller, not here, so that a buy that is ultimately skipped for cash
// reasons never consumes the mint's one attempt — see the entry loop,
// where `attempted.add` happens only after every skip test has passed.
function buildBuyOrder(mint: string, size: bigint): OrderInput {
  return {
    side: "buy",
    mint,
    quote_lamports: size,
    max_slippage_bps: BUY_SLIPPAGE_BPS,
  };
}

// Record an entry print the first time a position is seen, taken from
// the mark price at that moment. (Earlier polishes tried the fill quote
// and the decision price instead; both graded worse than this on the
// dev window. This restores the best-measured v1 behaviour, as
// documented in BUILD.md.) A position whose price cannot be read this
// batch records nothing and is retried next batch — it is not exited
// until it has an entry record, because without an entry print there
// is no threshold to test against. Positions that already have a
// record are never re-recorded: the first print stands for the whole
// hold, even if the price has since moved.
function recordEntryPrints(
  state: BotState,
  entries: Map<string, EntryRecord>,
  tracks: ReadonlyMap<string, MintTrack>,
): void {
  for (const [mint] of state.positions) {
    if (!entries.has(mint)) {
      const price = curvePrice(state, mint);
      const track = tracks.get(mint);
      if (price !== null) {
        entries.set(mint, { entryPrice: price, entryTrades: track?.trades ?? 0 });
      }
    }
  }
}

// Per-mint trackers, in first-seen order (a Map preserves insertion
// order, and the entry loop iterates the trackers in that order, so
// when several mints qualify in one batch the earliest-seen mint is
// considered first — the same order the original code iterated).
const tracks = new Map<string, MintTrack>();
// Mints this run has already attempted once. One attempt per mint,
// ever: a mint that was bought, or that was skipped for cash reasons
// after being marked, is never reconsidered. Note the asymmetry — a
// mint skipped BEFORE being marked (any gate above) stays eligible for
// a later batch, while a mint marked attempted does not.
const attempted = new Set<string>();
// Entry prints for positions currently or previously held, keyed by
// mint. Records are kept after a position closes; a mint is never
// re-entered anyway (see `attempted`), so a stale record can never be
// mistaken for a fresh entry.
const entries = new Map<string, EntryRecord>();

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    // Fold this batch's events into the per-mint trackers, in chain
    // order, before any decision is made: entries decided in this
    // batch must see the births, trades, and completions that arrived
    // in this batch, and exits must see this batch's completions.
    foldBatchEvents(batch.events, tracks);

    // Record entry prints for newly seen positions before the exit
    // loop runs, so a position that appeared in this batch can be
    // exited in this same batch if its very first print already sits
    // past a threshold (possible when the fill lands far from the
    // decision price on a fast coin).
    recordEntryPrints(state, entries, tracks);

    // Pending orders, split by side. Recomputed every batch from the
    // harness state: an order that filled or was rejected since the
    // last batch is no longer pending, and its mint becomes eligible
    // for a fresh decision again (subject to the attempted set).
    const { buys: pendingBuys, sells: pendingSells } = pendingOrderMints(state);

    const orders: OrderInput[] = [];
    const maxOrders = state.hello.caps.max_orders_per_batch;
    const txFee = state.txFeeLamports();
    // Cash committed by buys already decided in this reply, including
    // one transaction fee per buy. Pending orders from earlier replies
    // are already netted inside freeCashLamports; `reserved` covers
    // only this reply, so the two are never double-counted.
    let reserved = 0n;

    // Exits first: take profit, stop loss, or a stale position. Exits
    // are decided before entries so that a batch that both closes a
    // position and qualifies a new mint spends its order slots on the
    // close first — the close is the risk-reducing action, and the
    // entry loop below only runs while order slots remain.
    for (const [mint, position] of state.positions) {
      // A sell already in flight for this mint: never stack a second
      // sell on top of it. The pending sell will close the position
      // when it fills; a duplicate would be rejected or over-sell.
      if (pendingSells.has(mint)) continue;
      const track = tracks.get(mint);
      // A completed curve is closed by the harness itself; this bot
      // sends no exit for it, and the harness would reject one as
      // token_complete anyway.
      if (track?.complete) continue;
      const record = entries.get(mint);
      const price = curvePrice(state, mint);
      // No entry record yet, or no readable price: nothing to test
      // against. The position is left alone this batch and reconsidered
      // next batch, once an entry print exists.
      if (record === undefined || price === null) continue;
      // One decision, three triggers — see shouldExitPosition. The
      // thresholds and the hold age are both measured from the entry
      // record, never from the live price history.
      if (shouldExitPosition(price, record, track)) {
        orders.push(buildSellOrder(mint, position));
      }
    }

    // Entries: one small snipe per mint, only while slots remain. The
    // whole entry section is skipped when the exit loop already filled
    // the reply's order cap — exits are never crowded out by entries.
    if (hasOrderSlot(orders, maxOrders)) {
      for (const [mint, track] of tracks) {
        // Stop the moment the reply is full. This is a break, not a
        // continue: no later mint can fit either, and scanning further
        // would only waste the batch.
        if (!hasOrderSlot(orders, maxOrders)) break;
        // Every price-independent gate, in the original order. A mint
        // failing any of these is skipped without consuming its one
        // attempt and without touching cash or order slots.
        if (!passesEntryGates(mint, track, attempted, state, pendingBuys)) continue;
        const price = curvePrice(state, mint);
        // No readable price: cannot test the lift, so skip. The mint
        // is not marked attempted and may qualify on a later batch.
        if (price === null) continue;
        // The lift test, in the original `<` form: the price must sit
        // at least ENTRY_LIFT_BPS above the first print. A price below
        // the floor means the crowd has not pushed it yet — or it has
        // already faded — and the snipe does not fire.
        if (price * BPS_DENOMINATOR < entryLiftFloor(track.firstPrice)) continue;
        // Open-position cap, read fresh for every candidate: positions
        // already committed plus buys already decided in this reply.
        // A break, not a continue: when the cap is full, no later mint
        // can be entered in this reply either.
        if (state.committedPositionCount() + countBuyOrders(orders) >= 5) break;
        // Sizing: 90% of the harness buy cap, clamped to the per-mint
        // maximum. The cap is read at decision time from the curve's
        // real reserves, so it tracks the mint's current size.
        const cap = state.maxBuyLamports(mint);
        const size = cappedBuySize(cap);
        // Below the guardrail floor: skip, unmarked. A sub-floor buy
        // would not count as a round trip and would only burn fees.
        if (size < MIN_SIZE_LAMPORTS) continue;
        // Cash: free cash net of pending orders, minus what this reply
        // has already reserved, must cover size plus one tx fee. A
        // mint skipped here is not marked attempted — cash may free up
        // when a pending order resolves.
        if (exceedsAvailableCash(state.freeCashLamports(), reserved, size, txFee)) continue;
        // Commit: reserve the cash, mark the mint attempted (its one
        // attempt is now spent, whether the fill succeeds or not), and
        // append the buy. Order of these three steps matters only in
        // that the reservation must precede the next mint's cash test.
        reserved += size + txFee;
        attempted.add(mint);
        orders.push(buildBuyOrder(mint, size));
      }
    }

    return orders;
  },
});
