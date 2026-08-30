# Aether Signal Intelligence + Auto Trade

## Product principle

Aether optimizes for **quality over quantity**. Signal Intelligence is not a promise of profit and it must not manufacture confidence. Its job is to reject weak, stale, concentrated, illiquid, or operationally unsafe opportunities before they can reach an execution path.

The system keeps a strict source distinction:

- `MACHINE_INTELLIGENCE` = a machine-generated market assessment.
- `ALGORITHMIC_STRATEGY` = a machine-generated trading decision based on a user/operator mandate.
- Human trader activity remains a separate source and must never be presented as machine-generated or vice versa.

## Signal quality gate

A candidate snapshot is fail-closed. By default it must satisfy all hard gates before the quality score can qualify it:

- minimum liquidity: $500,000
- minimum 24h volume: $250,000
- maximum spread: 50 bps
- maximum estimated price impact: 100 bps
- maximum top-10 holder concentration: 35%
- minimum token age: 24 hours
- at least 2 execution routes
- at least 2 independent data sources
- maximum market-data age: 5 seconds
- maximum 1h volatility: 1,500 bps
- sell path must pass simulation
- token must remain transferable
- no unresolved token risk flags

After hard gates pass, the engine scores liquidity, volume, spread, price impact, routing depth, holder distribution, momentum, order flow, volatility, and data quality. Default qualification threshold is **82/100**.

A score never overrides a hard reject.

## Auto Trade mandate

Auto Trade is permission-bounded. A mandate can specify:

- capital limit
- maximum amount per trade
- maximum portfolio allocation per token
- maximum daily loss
- maximum trades per day
- cooldown between trades
- maximum slippage
- minimum signal score
- stop loss
- trailing stop
- token allowlist

The default posture is conservative: no more than 6 trades/day and a 30-minute cooldown unless explicitly changed.

## Sell-quality logic

The exit path receives the same attention as entry. A position can generate a `SELL` decision when one or more of these conditions occur:

- stop-loss threshold is breached
- trailing-stop drawdown is breached
- the underlying signal becomes hard-rejected
- quality score deteriorates below the exit floor
- profitable momentum reverses materially

A `SELL` decision is only considered executable when the sell route itself is verified and its estimated impact remains inside the mandate. If the position should exit but the route is unsafe, the engine emits a risk alert instead of pretending a safe exit exists.

## Current safety posture

This foundation is intentionally **SHADOW-only**. The database enforces `mode='SHADOW'` and `live_execution_authorized=false` for Auto Trade decisions. No private key, seed phrase, or signer is part of Signal Intelligence.

Before live algorithmic execution is allowed, Aether still requires real market-data providers, multi-source reconciliation, user permission/signing architecture, quote/simulation integration, idempotency, position reconciliation, external RPC redundancy, strategy-level circuit breakers, production monitoring, and controlled-live approval gates.

## Transparency rule

Aether should expose the reason codes behind machine decisions. A public or user-facing signal must never be represented only as "AI says buy". Users should be able to inspect the quality score, failed gates, execution constraints, and whether the source is human or algorithmic.
