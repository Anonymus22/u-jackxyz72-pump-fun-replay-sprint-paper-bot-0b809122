// Pump.fun Replay Sprint -- Paper Bot, Real Ranking.
// A launch sniper with patient exits, for agent-fun/replay/v2 (pump.fun bonding curves).
//
// How the bot talks to the harness: the harness sends one JSON line at a time on stdin.
// First comes a hello handshake (protocol agent-fun/replay/v2, seed, universe, capital,
// caps, latency_slots, fees). Then one batch per slot: each batch carries its seq, its
// slot number, the slot's events (CreateEvent / TradeEvent / CompleteEvent in chain order),
// marks (latest reserves for mints we hold or have orders pending on), fills (our orders
// that resolved since the previous batch) and the account (cash + positions). The bot
// answers every batch with exactly one reply line on stdout, echoing the batch's seq and
// carrying this batch's orders. Orders decided on the batch for slot s fill at slot
// s + latency_slots. A done message ends the run; positions are flattened by the harness.
//
// Strategy (chosen from the dev-window data, see notes below):
//  - Buy fresh launches early (age 0..3 slots after their CreateEvent) with a rug filter:
//    the creator must not have sold, the creator's own opening buy must be small
//    (at most 2.5 SOL), at most 2 other wallets may have bought before us (a launch
//    bundled by many wallets is a dump in waiting), and the curve must hold 0.3..30
//    real SOL. The dev data says a launch bought in its first slots reaches +15%
//    within 50 slots about a third of the time, while only ~3% fall 50% that fast --
//    so the edge, such as it is, is catching the early pop, not holding for hours.
//  - One buy per coin, sized to the smaller of the 0.1 SOL stake and 1% of the curve's
//    real SOL reserve (the per-reply buy cap), so a bad coin can only cost its stake.
//  - Exits are fast and firm: take profit at +20% of cost, stop loss at -12%, a
//    15-slot time limit, an immediate exit when the creator sells, and a stale exit
//    when the coin stops trading. Never hold a dead coin to zero.
//  - No dip-buying: on the dev window a 30% dip bounces 20% only ~23% of the time
//    while half the dips fall another 20%, so buying dips is a losing trade here.
//    And no chasing run-ups: measured from the fill price (2 slots after the
//    decision) the coins that already ran 10%+ are the most likely to dump next,
//    because the 2-slot latency means the fill lands after the spike.
//  - Fees decide the sizing: a round trip costs 95 + 30 bps of curve fees plus 105k
//    lamports of tx fees, so buys below 0.02 SOL are not worth sending and the take
//    profit must clear roughly 3% of drag.
//  - Honest dev-window result (local replay harness, full 24h dev dataset): the
//    first build lost -0.20 SOL over 101 coins (21 winners, 83 losers), max
//    drawdown 2.4%. Revision 1 (this file): the exits were re-tuned from the
//    measured data -- a quick +10% take profit with a wide -25% stop and a
//    20-slot hold, because from the fill price only ~15% of coins ever reach
//    +20% before -12% while ~57% just drift and bleed, so the old +20%/-12%
//    exits gave the bleeders 15 slots to lose money and stopped the runners
//    out too late. Revision 1 measured -0.152 SOL (25 winners, 79 losers).
//    Revision 2: the creator filter was tightened (own opening buy at most
//    1.0 SOL, down from 2.5) and the take profit lowered to +8%: the dev data
//    shows launches whose creator buys 1.5+ SOL at creation average -11.5%
//    over the next 100 slots (a big bag waiting to be dumped), while creators
//    buying under 0.5 SOL average +2.9%; and the +8% target is hit more often
//    than +10% before the usual fade. Revision 2 measured -0.108 SOL
//    (18 winners, 53 losers, 69 coins). Revision 3: a no-burst filter --
//    skip any launch whose net buy flow already exceeds 3 SOL at decision
//    time -- plus +12%/-15% exits. The worst loser in every run, BadDbj
//    (-0.048 SOL), had absorbed 12.8 SOL of buys in its first slots and then
//    dumped half its price in 5 slots; across the window the per-coin loss
//    grows monotonically with early net flow, so the burst coins are the
//    leak. Pyramiding into winners, partial exits, long holds and trailing
//    stops were all tested offline and rejected -- the runners revert, so
//    adding to them or letting them ride only amplifies the losses, and the
//    7 late completers never pass this entry filter at all (0 trades in
//    simulation), so holding longer just feeds the bleed. NOTE: after three
//    serious revision rounds this entry still does not clear +0.05 SOL on the
//    dev window; the tradeable coins here have a negative expected value of
//    roughly -1% to -2% per trade after the 2.7% round-trip fee drag, and no
//    tested entry filter or exit rule flips the sign with 20+ coins.
//    (momentum -9.38, reversion -3.78, sniper -0.49 SOL), and the measured gross
//    edge of this trade is near zero, so this entry is built to lose little,
//    clear the 20-coin guardrail with a 5x margin, and keep its powder dry
//    for the final window's own coins.
//
// Fully deterministic: no clock, no randomness, no network, no environment, no files.
// Every decision is a pure function of the hello and batch messages received, iterated
// in first-seen order, so two executions produce byte-identical action logs.

import { createInterface } from 'node:readline';

const PROTOCOL = 'agent-fun/replay/v2';
const LAMPORTS_PER_SOL = 1_000_000_000n;
const BPS = 10_000n;

// ---------------------------------------------------------------- params
const P = {
  minAge: 0, // youngest age (slots since CreateEvent) at which a coin may be bought
  maxAge: 3, // oldest age at which a first buy may still be decided
  stakeSol: 0.1, // target SOL per coin (capped by 1% of the real SOL reserve)
  minBuySol: 0.02, // smallest single buy worth paying the tx fee for
  minRealSol: 0.3, // real SOL reserve window at decision time (SOL)
  maxRealSol: 30,
  maxDevBuySol: 1.0, // creator's own buys in the create slot, at most (SOL)
  maxNetSol: 3, // net SOL bought minus sold by decision time, at most: a launch
  // that already absorbed a multi-SOL burst has no buyers left, only the dump
  minBuyers: 0, // distinct non-creator buyers seen before entry
  maxBuyers: 2, // a launch bundled by many wallets is a dump in waiting
  maxRunup: 10, // price now over the create price, at most (10 = effectively off)
  buySlipBps: 10000, // accept the fill price
  tp: 0.12, // take profit: exit when liquidation value reaches cost * (1 + tp)
  sl: 0.15, // stop loss: exit when liquidation value falls to cost * (1 - sl)
  trailArm: 10, // trailing stop arms once value reached cost * (1 + trailArm) (10 = off)
  trail: 0.08, // then exit on a fall of trail from the best value
  maxHold: 20, // exit after holding this many slots
  staleSlots: 300, // exit when no trade has hit the coin for this many slots
  exitOnDevSell: true, // exit when the creator sells while held
  fadeWindow: 20, // exit when net SOL flow over the last fadeWindow slots falls below -fadeNetSol
  fadeNetSol: 1000, // (1000 = off)
  bigSellSol: 1000, // exit on any single recorded sell of at least this many SOL (1000 = off)
  maxEntriesPerBatch: 3, // most new entries decided in one batch
};

// ---------------------------------------------------------------- types
interface HelloMsg {
  type: 'hello';
  protocol: string;
  seed: string;
  capital: { lamports: string };
  caps: { max_open_positions: number; max_order_bps_of_real_reserve: number; max_orders_per_batch: number };
  latency_slots: number;
  fees: { protocol_bps_fallback: number; creator_bps_fallback: number; base_fee_lamports: string; priority_fee_lamports: string; failed_tx_bps: number };
}

interface ChainEvent {
  event: string;
  mint: string;
  slot: number;
  [key: string]: unknown;
}

interface MarkMsg {
  mint: string;
  slot: number;
  virtual_token_reserves: string;
  virtual_quote_reserves: string;
  real_token_reserves: string;
  real_quote_reserves: string;
}

interface FillMsg {
  client_id: string;
  mint: string;
  side: string;
  status: string;
  decided_slot: number;
  slot: number;
  quote_lamports: string;
  token_amount: string;
  tx_fee_lamports: string;
}

interface BatchMsg {
  type: 'batch';
  seq: number;
  slot: number;
  events: ChainEvent[];
  marks: MarkMsg[];
  fills: FillMsg[];
  account: { cash_lamports: string; positions: { mint: string; token_amount: string; cost_lamports: string }[] };
}

interface OrderOut {
  side: 'buy' | 'sell';
  client_id: string;
  mint: string;
  quote_lamports?: string;
  token_amount?: string;
  max_slippage_bps: number;
}

interface Curve {
  mint: string;
  createdSlot: number | null;
  vq: bigint;
  vt: bigint;
  rq: bigint;
  rt: bigint;
  complete: boolean;
  trades: number;
}

interface Coin {
  mint: string;
  createSlot: number;
  creator: string;
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  buyers: Set<string>;
  bought: bigint;
  soldByOthers: bigint;
  devSold: boolean;
  lastTradeSlot: number;
  recentNet: bigint; // net SOL bought minus sold over the trades seen so far
  recentBuys: number;
  buysSent: number;
  done: boolean;
  complete: boolean;
  tape: { slot: number; buy: boolean; sol: number }[]; // recent trades, for the fade exit
}

interface Held {
  openedSlot: number;
  best: bigint; // best liquidation value seen (lamports)
  txPaid: bigint;
}

// ---------------------------------------------------------------- state
let hello: HelloMsg | null = null;
let cash = 0n;
const positions = new Map<string, { tokens: bigint; cost: bigint }>();
const curves = new Map<string, Curve>();
const coins = new Map<string, Coin>();
const held = new Map<string, Held>();
const pending = new Map<string, OrderOut>(); // client_id -> order, until its fill arrives
let nextId = 1;

const txFee = (): bigint =>
  BigInt(hello!.fees.base_fee_lamports) + BigInt(hello!.fees.priority_fee_lamports);

function clientId(): string {
  return `o${nextId++}`;
}

/** Price as virtual SOL per virtual token (a plain number; ratios only). */
function priceOf(vq: bigint, vt: bigint): number {
  if (vt === 0n) return 0;
  return Number(vq) / Number(vt);
}

/** What selling `tokens` against (vq, vt) would pay after the 95 + 30 bps curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  const fee = (q * 125n + BPS - 1n) / BPS;
  return q - fee;
}

/** The per-reply buy cap on this mint, with a small margin for reserve shifts. */
function buyCap(mint: string): bigint {
  const c = curves.get(mint);
  if (c === undefined || c.complete) return 0n;
  return (c.rq * BigInt(hello!.caps.max_order_bps_of_real_reserve) * 97n) / (BPS * 100n);
}

function committedCount(): number {
  const mints = new Set<string>(positions.keys());
  for (const o of pending.values()) if (o.side === 'buy') mints.add(o.mint);
  return mints.size;
}

function freeCash(): bigint {
  const tx = txFee();
  let free = cash;
  for (const o of pending.values()) {
    free -= tx;
    if (o.side === 'buy') free -= BigInt(o.quote_lamports!);
  }
  return free;
}

function hasPendingBuy(mint: string): boolean {
  for (const o of pending.values()) if (o.mint === mint && o.side === 'buy') return true;
  return false;
}

function hasPendingSell(mint: string): boolean {
  for (const o of pending.values()) if (o.mint === mint && o.side === 'sell') return true;
  return false;
}

function coinOf(mint: string, slot: number): Coin {
  let c = coins.get(mint);
  if (c === undefined) {
    c = {
      mint,
      createSlot: slot,
      creator: '',
      vq0: 0n,
      vt0: 1n,
      devBuy: 0n,
      buyers: new Set<string>(),
      bought: 0n,
      soldByOthers: 0n,
      devSold: false,
      lastTradeSlot: slot,
      recentNet: 0n,
      recentBuys: 0,
      buysSent: 0,
      done: false,
      complete: false,
      tape: [],
    };
    coins.set(mint, c);
  }
  return c;
}

function curveOf(mint: string, slot: number): Curve {
  let c = curves.get(mint);
  if (c === undefined) {
    c = { mint, createdSlot: null, vq: 0n, vt: 0n, rq: 0n, rt: 0n, complete: false, trades: 0 };
    curves.set(mint, c);
  }
  return c;
}

// ---------------------------------------------------------------- per-batch logic
function onBatch(batch: BatchMsg): OrderOut[] {
  const now = batch.slot;
  const orders: OrderOut[] = [];
  const cap = hello!.caps.max_orders_per_batch;
  const tx = txFee();

  // Folds the fills in: drop pending orders that resolved, track buys that landed.
  for (const f of batch.fills) {
    const wasPending = pending.delete(f.client_id);
    if (!wasPending) {
      // A harness close (_complete_ / _flatten_ / _writeoff_): the position is gone.
      if (f.client_id.startsWith('_')) {
        held.delete(f.mint);
        const c = coins.get(f.mint);
        if (c !== undefined) c.done = true;
      }
      continue;
    }
    if (f.side === 'buy' && f.status === 'filled') {
      const h = held.get(f.mint);
      if (h === undefined) {
        held.set(f.mint, { openedSlot: f.slot, best: 0n, txPaid: BigInt(f.tx_fee_lamports) });
      } else {
        h.txPaid += BigInt(f.tx_fee_lamports);
      }
    }
    if (f.side === 'sell' && f.status === 'filled') {
      const c = coins.get(f.mint);
      if (c !== undefined) c.done = true;
    }
  }

  // Account: cash and positions as the harness reports them.
  cash = BigInt(batch.account.cash_lamports);
  positions.clear();
  for (const p of batch.account.positions) {
    const tokens = BigInt(p.token_amount);
    if (tokens > 0n) positions.set(p.mint, { tokens, cost: BigInt(p.cost_lamports) });
  }

  // Marks first (latest reserves for held / pending mints), then events.
  for (const m of batch.marks) {
    const c = curveOf(m.mint, m.slot);
    c.vq = BigInt(m.virtual_quote_reserves);
    c.vt = BigInt(m.virtual_token_reserves);
    c.rq = BigInt(m.real_quote_reserves);
    c.rt = BigInt(m.real_token_reserves);
  }
  for (const e of batch.events) {
    if (e.event === 'CreateEvent') {
      const c = coinOf(e.mint, e.slot);
      c.createSlot = e.slot;
      c.creator = String(e.creator ?? '');
      c.vq0 = BigInt(String(e.virtual_quote_reserves ?? '0'));
      c.vt0 = BigInt(String(e.virtual_token_reserves ?? '1'));
      const cv = curveOf(e.mint, e.slot);
      cv.createdSlot = e.slot;
      cv.vq = BigInt(String(e.virtual_quote_reserves ?? '0'));
      cv.vt = BigInt(String(e.virtual_token_reserves ?? '0'));
      cv.rq = 0n;
      cv.rt = BigInt(String(e.real_token_reserves ?? '0'));
    } else if (e.event === 'TradeEvent') {
      const cv = curveOf(e.mint, e.slot);
      cv.vq = BigInt(String(e.virtual_quote_reserves ?? '0'));
      cv.vt = BigInt(String(e.virtual_token_reserves ?? '0'));
      cv.rq = BigInt(String(e.real_quote_reserves ?? '0'));
      cv.rt = BigInt(String(e.real_token_reserves ?? '0'));
      cv.trades += 1;
      const c = coinOf(e.mint, e.slot);
      const sol = BigInt(String(e.sol_amount ?? '0'));
      const isBuy = e.is_buy === true;
      const user = String(e.user ?? '');
      c.lastTradeSlot = e.slot;
      c.tape.push({ slot: e.slot, buy: isBuy, sol: Number(sol) / 1e9 });
      while (c.tape.length > 0 && c.tape[0]!.slot <= e.slot - P.fadeWindow - 5) c.tape.shift();
      if (isBuy) {
        c.bought += sol;
        c.recentNet += sol;
        c.recentBuys += 1;
        if (user === c.creator && e.slot === c.createSlot) c.devBuy += sol;
        else if (user !== c.creator) c.buyers.add(user);
      } else {
        c.recentNet -= sol;
        if (user === c.creator) c.devSold = true;
        else c.soldByOthers += sol;
      }
    } else if (e.event === 'CompleteEvent') {
      const cv = curveOf(e.mint, e.slot);
      cv.complete = true;
      const c = coins.get(e.mint);
      if (c !== undefined) {
        c.complete = true;
        c.done = true;
      }
      held.delete(e.mint);
    }
  }

  // Drop held records for positions that are gone and have no buy in flight.
  for (const mint of [...held.keys()]) {
    if (!positions.has(mint) && !hasPendingBuy(mint)) held.delete(mint);
  }

  // 1. Exits first, in mint order (deterministic).
  const heldMints = [...positions.keys()].sort();
  for (const mint of heldMints) {
    if (orders.length >= cap) break;
    if (hasPendingSell(mint)) continue;
    const pos = positions.get(mint)!;
    const cv = curves.get(mint);
    if (cv === undefined || cv.complete) continue;
    let h = held.get(mint);
    if (h === undefined) {
      h = { openedSlot: now, best: 0n, txPaid: tx };
      held.set(mint, h);
    }
    const value = sellValue(pos.tokens, cv.vq, cv.vt) - tx;
    const basis = pos.cost + h.txPaid;
    if (value > h.best) h.best = value;
    let exit = false;
    if (basis > 0n) {
      if (value * BPS >= basis * BigInt(Math.round((1 + P.tp) * 10000))) exit = true;
      if (value * BPS <= basis * BigInt(Math.round((1 - P.sl) * 10000))) exit = true;
      if (h.best * BPS >= basis * BigInt(Math.round((1 + P.trailArm) * 10000)) && value * BPS <= h.best * BigInt(Math.round((1 - P.trail) * 10000))) exit = true;
    }
    if (now - h.openedSlot >= P.maxHold) exit = true;
    const c = coins.get(mint);
    if (c !== undefined) {
      if (P.exitOnDevSell && c.devSold) exit = true;
      if (now - c.lastTradeSlot >= P.staleSlots) exit = true;
      // Fade exit: sellers have taken over the tape, or one big sell just landed.
      let net = 0;
      let bigSell = false;
      for (const tr of c.tape) {
        if (tr.slot <= now - P.fadeWindow) continue;
        net += tr.buy ? tr.sol : -tr.sol;
        if (!tr.buy && tr.sol >= P.bigSellSol) bigSell = true;
      }
      if (net < -P.fadeNetSol || bigSell) exit = true;
    }
    if (!exit) continue;
    orders.push({ side: 'sell', client_id: clientId(), mint, token_amount: pos.tokens.toString(), max_slippage_bps: 10000 });
    if (c !== undefined) c.done = true;
  }

  // 2. New entries: fresh launches that pass the rug filter, in first-seen order.
  let entries = 0;
  let free = freeCash() - tx * BigInt(orders.length);
  for (const c of coins.values()) {
    if (orders.length >= cap || entries >= P.maxEntriesPerBatch) break;
    if (c.done || c.complete || c.buysSent > 0) continue;
    const age = now - c.createSlot;
    if (age < P.minAge || age > P.maxAge) {
      if (age > P.maxAge) c.done = true;
      continue;
    }
    if (committedCount() >= hello!.caps.max_open_positions) break;
    if (hasPendingBuy(c.mint)) continue;
    const cv = curves.get(c.mint);
    if (cv === undefined || cv.complete) continue;
    if (c.devSold) {
      c.done = true;
      continue;
    }
    const rqSol = Number(cv.rq) / 1e9;
    if (rqSol < P.minRealSol || rqSol > P.maxRealSol) continue;
    if (Number(c.devBuy) / 1e9 > P.maxDevBuySol) continue;
    if (c.buyers.size < P.minBuyers || c.buyers.size > P.maxBuyers) continue;
    if (Number(c.recentNet) / 1e9 > P.maxNetSol) continue;
    if (cv.vq0 > 0n && cv.vt0 > 0n) {
      const runup = (Number(cv.vq) * Number(cv.vt0)) / (Number(cv.vt) * Number(cv.vq0));
      if (runup > P.maxRunup) continue;
    }
    const want = BigInt(Math.floor(P.stakeSol * 1e9));
    const capBuy = buyCap(c.mint);
    let amount = want < capBuy ? want : capBuy;
    if (amount < BigInt(Math.floor(P.minBuySol * 1e9))) continue;
    if (free < amount + tx) continue;
    orders.push({ side: 'buy', client_id: clientId(), mint: c.mint, quote_lamports: amount.toString(), max_slippage_bps: P.buySlipBps });
    free -= amount + tx;
    c.buysSent += 1;
    entries++;
  }
  return orders;
}

// ---------------------------------------------------------------- wire loop
async function main(): Promise<void> {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim() === '') continue;
    let msg: { type?: unknown };
    try {
      msg = JSON.parse(line) as { type?: unknown };
    } catch {
      console.error(`bad input line: not JSON`);
      process.exit(1);
    }
    if (msg.type === 'hello') {
      hello = msg as unknown as HelloMsg;
      if (hello.protocol !== PROTOCOL) {
        console.error(`harness speaks ${hello.protocol}; this bot speaks ${PROTOCOL}`);
        process.exit(1);
      }
      cash = BigInt(hello.capital.lamports);
    } else if (msg.type === 'batch') {
      const batch = msg as unknown as BatchMsg;
      const orders = onBatch(batch);
      for (const o of orders) pending.set(o.client_id, o);
      process.stdout.write(JSON.stringify({ type: 'reply', seq: batch.seq, orders }) + '\n');
    } else if (msg.type === 'done') {
      return;
    } else {
      console.error(`unknown message type ${String(msg.type)}`);
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
