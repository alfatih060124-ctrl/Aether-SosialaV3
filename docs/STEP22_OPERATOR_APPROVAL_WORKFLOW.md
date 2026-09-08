# Step 22 Operator Approval Workflow

Purpose: record the final readiness approval path without enabling LIVE execution.

## State at Step 22 completion
- EXECUTION_MODE=SHADOW
- LIVE_ENABLED=false
- FIXTURE_GATE_PASSED=false
- OPERATOR_APPROVED=false
- Emergency Kill remains active/fail-closed.
- Hard minimum expected NET edge remains 20 bps / 0.20%.
- No signer, transaction submission, or fund movement is authorized.

Step 22 approval means the release candidate passed readiness review. It does **not** mean LIVE activation.

## Required readiness approval evidence
1. One canonical release-candidate branch and exact commit SHA.
2. All required GitHub CI checks green on that exact commit.
3. API health reports SHADOW and `live_enabled=false`.
4. API readiness reports database `ok`.
5. Step 20 and Step 21 acceptance regressions pass again.
6. Admin Control Panel, five-menu Member Area, accounting, subscription/payment, delegated authority, funding preflight, runtime binding, audit and security boundaries pass.
7. LIVE execution gate remains closed and Emergency Kill remains effective.

## After Step 22
A LIVE PILOT is outside the 22-step roadmap. Starting it requires a separate explicit user instruction after Step 22 is complete.

Only after that separate instruction may an operator begin the LIVE authorization sequence. Each gate must be independently verified before any activation attempt:
- readiness passed;
- admin LIVE approval recorded;
- signer deliberately unlocked in its isolated boundary;
- network submission explicitly enabled;
- fund movement explicitly enabled;
- Emergency Kill deliberately released only for the authorized pilot window.

Any failed or missing gate keeps execution in SHADOW. Emergency Kill, RETURN_SHADOW, provider failure, stale execution, or incomplete evidence must fail closed.

No Step 22 automation may set LIVE mode, unlock a signer, enable network submission, enable fund movement, move funds, or flip OPERATOR_APPROVED from false.

Readiness lock: **LIVE remains OFF** at Step 22 completion; `OPERATOR_APPROVED=false` remains unchanged.
