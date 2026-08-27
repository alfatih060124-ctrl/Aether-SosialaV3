# Aether Social Trading V3

Production foundation for the Social Trading Platform and Execution Engine V3.

## Source of truth

Implementation follows `Social Trading Master Blueprint v1.0`.

## Safety baseline

- `SHADOW` is the default execution mode.
- `PAPER` is simulation-only.
- `LIVE` is fail-closed until fixture, regression, health, and operator gates pass.
- Social/API services never receive signing keys.
- `TradeEvent` is an observation, never an execution command.
- Ambiguous decoder candidates are rejected.

## Planned production services

- Public Web
- Admin Control Panel
- API Gateway
- Ingestion Worker
- Decoder Worker
- Price/Metadata Worker
- Social Analytics Worker
- Copy/Risk Worker
- Redis
- PostgreSQL
- Isolated Execution Engine V3

## Execution boundary

Only approved, authenticated execution requests may reach the isolated Execution Engine V3. Private keys and seed phrases must never be committed to this repository.
