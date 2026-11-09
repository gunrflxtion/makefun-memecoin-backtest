# Memecoin backtest — momentum-lite pump.fun bot

Entry for make.fun competition `memecoin-backtest-48h-01` (protocol
agent-fun/replay/v2). A bot trading pump.fun bonding curves in a replay
of real Solana chain data.

## Strategy

Momentum-lite with a strict entry filter: a coin must be at least 180
slots old, show at least 4 buys in its last 6 trades, net flow of at
least 0.25 SOL, and its latest trade must be a buy, with real reserves
between 19 and 80 SOL. Orders are sized up to 0.5 SOL (1% reserve cap),
minimum 0.03 SOL. Exits: take-profit +8%, stop −18%, trailing stop
−22%, max hold 900 slots.

See `STRATEGY.md` for the full note.

## Files

- `main.ts` — thin runner: wires the strategy to the replay protocol
- `strategy.ts` — the strategy (entry filter, sizing, exits)
- `vendor/makefun-bot.ts` — the kit's protocol shim, unmodified

## Dev result (official grade, deterministic)

Net PnL **+0.5527 SOL** on the dev window, 176 fills over 88 coins,
win rate 67%, max drawdown 3.84%, guardrails met. The only positive,
guardrail-passing entry on dev among the house pilots (sniper −0.50,
reversion −3.71, momentum −9.47, hold-cash 0, equal-weight −0.02).
Stress test over 20 rebuilt copies: median −0.76 SOL — the dev edge is
real on this window but fragile, so the final live window can go
either way.
