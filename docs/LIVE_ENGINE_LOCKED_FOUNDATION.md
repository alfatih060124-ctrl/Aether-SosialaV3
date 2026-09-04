# AETHER LIVE Engine — Locked Foundation

This foundation prepares the LIVE execution path without enabling real-money trading.

## Default posture

- `EXECUTION_MODE=SHADOW`
- `LIVE_ENABLED=false`
- `LIVE_READINESS_PASSED=false`
- `ADMIN_LIVE_APPROVED=false`
- `LIVE_SIGNER_UNLOCKED=false`
- `LIVE_NETWORK_SUBMISSION_ENABLED=false`
- `LIVE_FUND_MOVEMENT_ENABLED=false`
- `LIVE_EMERGENCY_KILL_SWITCH=true`

All gates must be explicitly opened and the emergency kill switch must be disabled before the LIVE boundary authorizes execution. Any missing, malformed, or false gate keeps execution closed.

## Architecture

The signal/decision logic remains shared with SHADOW. LIVE is a separate execution boundary behind a fail-closed state machine. This prevents simulator-vs-live strategy drift while keeping real-money capabilities unavailable during validation.

## Required admin flow before any future LIVE activation

1. Readiness checks pass.
2. Admin grants LIVE approval.
3. Signer is unlocked through the approved signer service.
4. Network submission is enabled.
5. Fund movement is enabled.
6. Emergency kill switch is intentionally cleared.

Every blocked and authorized execution attempt must be audit logged.
