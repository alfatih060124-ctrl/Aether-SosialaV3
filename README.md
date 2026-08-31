# AETHER Social Trading

AETHER is an on-chain social trading foundation built around canonical TradeEvent observation, decoder reconciliation, follower copy policies, fail-closed risk controls, and an isolated Execution Engine.

## Safety baseline

- Default execution mode: `SHADOW`
- `LIVE_ENABLED=false`
- `FIXTURE_GATE_PASSED=false`
- `OPERATOR_APPROVED=false`
- LIVE execution remains blocked until independent fixture, regression, health, reconciliation, idempotency, price-freshness, signer-isolation, and operator-approval gates pass
- Private keys and seed phrases must never be committed to the repository or exposed to public API/Admin UI
- User funds remain user-controlled; AETHER is non-custodial by design

## Canonical runtime ownership

There is exactly one writable production runtime:

`GitHub (source + CI) -> Vercel (public read-only UI/BFF) -> PRIMARY_VM (API + DB + control plane)`

Render is `STANDBY_RENDER` only: health-only, database-detached, no production API/admin token, no execution, no automatic deploy. It must never operate as a second production writer while the VM is active.

The full contract and fenced failover procedure are in `docs/DEPLOYMENT_TOPOLOGY.md`.

## Core flow

`Solana ingestion -> DEX decoder -> canonical TradeEvent -> copy policy -> risk gate -> Execution Engine -> receipt -> reconciliation -> audit`

## Repository

- `services/api` — API, migrations, marketplace, protected SHADOW simulation, risk and audit services
- `public` / `apps/web` — public web foundation
- `web/admin.html` / `apps/admin` — Admin operational surfaces
- `deploy/Caddyfile` — authoritative VM ingress boundary
- `scripts/infrastructure-contract.mjs` — CI topology regression guard
- `scripts/vm-apply-routing.sh` — transactional VM routing cutover
- `migrations` / `database` — database schema and related resources

## Current deployment posture

AETHER is SHADOW-first and fail-closed. Public traffic is read-only. State-changing control-plane operations remain on the primary VM, and LIVE trading stays locked until the separate production safety gates are explicitly approved.
