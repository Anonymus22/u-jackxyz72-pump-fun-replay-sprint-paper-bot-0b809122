[![Pump.fun Replay Sprint](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![Rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Anonymus22/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![Reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Anonymus22/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

# Pump.fun Replay Sprint - Paper Bot, Real Ranking

A paper-trading bot for the agent-fun/replay/v2 pump.fun replay. It trades 10 SOL of
paper money on 24 hours of recorded pump.fun bonding-curve activity. Nothing is traded
for real. The bot is one self-contained file, `main.ts` (Node 22, standard library only),
speaking the replay protocol on stdin/stdout: a `hello` handshake, one `batch` per slot,
one `reply` per batch echoing the batch's `seq`, and a `done` at the end of the data.

## Strategy: early-launch sniper with fast exits

- **Buy fresh launches early** (age 0..3 slots after their CreateEvent) with a rug
  filter: the creator must not have sold, the creator's own opening buy must be small
  (at most 2.5 SOL), at most 2 other wallets may have bought before us (a launch
  bundled by many wallets is a dump in waiting), and the curve must hold 0.3..30 real
  SOL. One buy per coin, sized to the smaller of the 0.1 SOL stake and 1% of the
  curve's real SOL reserve (the per-reply buy cap).
- **Exit fast and firm:** take profit at +20% of cost, stop loss at -12%, a 15-slot
  time limit, an immediate exit when the creator sells, and a stale exit when the
  coin stops trading. Never hold a dead coin to zero.
- **No dip-buying:** on the dev window a 30% dip bounces 20% only about 23% of the
  time while half the dips fall another 20%. No chasing run-ups either: measured
  from the fill price (2 slots after the decision) the coins that already ran 10%+
  are the most likely to dump next, because the latency means the fill lands after
  the spike.
- **Fees decide the sizing:** a round trip costs 95 + 30 bps of curve fees plus
  105,000 lamports of tx fees, so buys below 0.02 SOL are not worth sending.

## Dev-window result (local replay, full 24h dev dataset)

Net **-0.20 SOL** over 101 coins (21 winners, 83 losers), 101 qualifying round trips
of at least 0.01 SOL, max drawdown 2.4%. Every pilot baseline loses more on the same
window (momentum -9.38, reversion -3.78, sniper -0.49 SOL). The measured gross edge
of this trade is near zero, so the entry is built to lose little, clear the 20-coin
guardrail with a 5x margin, and keep its powder dry for the final window's own coins.

## Run

The grader runs `node /bot/main.ts`. The bot is fully deterministic: no clock, no
randomness, no network, no environment, no files. Every decision is a pure function
of the `hello` and `batch` messages it receives, so two executions produce
byte-identical action logs.

## License

MIT. See [LICENSE](LICENSE).
