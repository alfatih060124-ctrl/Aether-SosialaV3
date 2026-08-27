# Aether Social Trading V3 — Production Architecture

## System boundary

Public Web -> API Gateway -> application services -> Copy/Risk -> authenticated Execution API -> isolated Execution Engine V3.

## Services

- web: public and authenticated user interface
- admin: operational control panel
- api: authenticated application API
- ingestion-worker: chain data ingestion
- decoder-worker: exact DEX/version decoding and reconciliation
- price-worker: price and metadata freshness
- analytics-worker: trader analytics and reporting
- copy-risk-worker: copy policy and risk decisions
- execution-engine-v3: isolated quote, route, transaction construction, simulation, signing and submission service
- postgres: durable state
- redis: event/cache/queue infrastructure

## Canonical event

TradeEvent is the canonical observation. It is not an execution command.

## Execution modes

SHADOW -> PAPER -> LIVE

LIVE remains fail-closed until the production fixture and operator gates pass.

## Security

No private key or seed phrase belongs in Web, Social, API, Git, logs, or chat. Signing is isolated to the Execution Engine V3 service behind authenticated service-to-service access.

## Decoder policy

Jupiter routes are reconciled with net token balance changes. DEX-specific adapters are version-aware. Ambiguous candidates are rejected rather than guessed.
