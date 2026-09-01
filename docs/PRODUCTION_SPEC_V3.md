# Aether Social Trading V3 — Production Specification

## Source of truth

Implementation baseline: `Social Trading Master Blueprint v1.0` supplied for this project.

## Safety invariants

1. `TradeEvent` is an observation, never an execution command.
2. Social/API layers must never receive signing keys.
3. Ambiguous decoder candidates are rejected.
4. Execution Engine V3 is an isolated secured service.
5. Execution modes are `SHADOW`, `PAPER`, and `LIVE`.
6. `LIVE` is fail-closed and remains disabled until all required gates pass.

## Core flow

Solana discovery/ingestion -> exact DEX decoder -> reconciliation -> canonical `TradeEvent` -> trader intelligence/copy policy -> risk gate -> authenticated execution request -> Execution Engine V3 -> execution receipt -> audit/reporting.

## Risk gate

Reject when applicable: stale event, low parser confidence, low trader reputation, excessive trader drawdown, excessive slippage, follower exposure limit exceeded, denied token, circuit breaker active, duplicate event.

## Copy policy

Supported policy forms in the blueprint: `FIXED_USD`, `PERCENT_EQUITY`, `CAPPED_PROPORTIONAL`. Every policy is bounded by maximum copy and maximum position limits.

## Decoder requirements

- Jupiter/aggregator routes must be reconciled using net token balance changes.
- Raydium and Orca use program/version-aware adapters.
- Token and raw amount reconciliation is exact.
- Unknown or ambiguous candidates are rejected rather than guessed.

## LIVE fixture gate

Per DEX/version: at least 30 verified positive fixtures and 10 negative/ambiguous fixtures; 100% regression pass; zero false positives in negative corpus; exact token/amount reconciliation; replay idempotency; price freshness; V3 health; explicit operator approval.

`preflight_live.py` is the intended activation gate. LIVE must remain blocked when the corpus or any required check is incomplete.

The implemented preflight is intentionally read-only and fail-closed. It validates a non-secret `VERIFIED_ONCHAIN` evidence manifest plus the runtime safety flags, emits machine-readable PASS/FAIL output, and never changes execution mode, enables LIVE, writes runtime state, contacts the network, or handles signing material. It requires `EXECUTION_MODE=SHADOW` and `LIVE_ENABLED=false` while evaluating readiness, so activation remains a separate explicit operator-controlled action after preflight.

Synthetic/demo fixtures do not count toward LIVE readiness. `packages/decoder-fixtures/live-manifest.example.json` is an intentionally failing template only; its zero counts, placeholder sources, and false checks must not be interpreted as evidence. The dedicated regression suite must prove that incomplete coverage, insufficient counts, nonzero negative false positives, non-100% regression, inexact reconciliation, stale/failed health checks, secret-bearing manifests, disabled fixture approval, missing operator approval, or already-enabled LIVE all fail closed.

## Services

- Public Web
- Admin Control Panel
- API
- Ingestion Worker
- Decoder Worker
- Price/Metadata Worker
- Social Analytics Worker
- Copy/Risk Worker
- Redis
- PostgreSQL
- Isolated Execution Engine V3

## Security and operations

Use secret management, service authentication, least privilege, immutable audit trails, idempotency controls, rate limits, circuit breakers, LIVE feature flags, monitoring and rollback to SHADOW on defined anomalies.

## Deployment principle

The public Web must not directly access the signer. The Execution Engine V3 is deployed as a separate secured service. Credentials and private keys are supplied only through production secret management and never committed to source control.

## Implementation note

The blueprint does not mandate a specific frontend framework, backend framework, cloud provider, or exact SQL schema. Those are implementation decisions and must not alter the invariants above.
