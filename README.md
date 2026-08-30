# Aether Social Trading V3

Aether Social Trading V3 is an on-chain social trading foundation built around canonical TradeEvent observation, exact decoder reconciliation, follower copy policies, fail-closed risk controls, and an isolated Execution Engine.

## Safety baseline

- Default execution mode: `SHADOW`
- `LIVE_ENABLED=false` by default
- LIVE execution must remain blocked until fixture, regression, health, reconciliation, idempotency, price-freshness, signer-isolation, and explicit operator approval gates pass
- Private keys and seed phrases must never be committed to the repository or exposed to the public API/admin UI
- User funds remain user-controlled; Aether is designed as non-custodial infrastructure

## Core flow

`Solana ingestion -> DEX decoder -> canonical TradeEvent -> copy policy -> risk gate -> Execution Engine V3 -> receipt -> reconciliation -> audit`

## Repository

- `services/api` — API, migrations, marketplace, SHADOW simulation, risk and audit services
- `apps/web` — public web foundation
- `apps/admin` — admin operational shell
- `scripts` — fixture gates and VM operational tooling
- `migrations` / `database` — database schema and related resources

## Current deployment posture

The production baseline is intentionally SHADOW-first. Public/runtime health can be exposed, while LIVE trading stays locked until all required safety gates are independently verified.
