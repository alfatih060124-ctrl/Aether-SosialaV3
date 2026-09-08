# Step 22 Release Readiness

Canonical scope: final end-to-end readiness review for the current AETHER Auto Trade launch path.

## Release candidate
- Branch: `rc/step22-auto-trade-readiness`
- Parent Step 21 canonical head: `7455f941210ffeb24a85ba2e202cecb79d2a009c`
- Exact Step 22 commit: recorded by the Step 22 PR after this readiness gate is committed.
- No merge is implied by Step 22 completion.
- No production LIVE deployment is implied by Step 22 completion.

## Product surfaces in scope
- New Admin Control Panel: operational control plane.
- Member Area: exactly five menus — Dashboard, Auto Trade, Performance, Subscription, Account.
- Copy Trading, Trader Marketplace and standalone Market Discovery remain PARKED.
- Dynamic subscription/payment, delegated authority and funding preflight.
- Member Auto Trade START/STOP, real-market SHADOW runtime binding, PAPER persistence/performance.
- Two-leg execution boundary remains fail-closed.

## Safety invariants
- SHADOW only during Step 22.
- LIVE_ENABLED=false.
- FIXTURE_GATE_PASSED=false.
- OPERATOR_APPROVED=false.
- Minimum expected NET edge = 20 bps / 0.20%.
- No private key/signer exposure to Admin/API.
- No transaction submission or fund movement.

## Final acceptance gates
1. Step 20 SHADOW validation matrix passes again.
2. All Step 21 regressions pass again on the RC tree.
3. Infrastructure and deployment contracts pass.
4. GitHub Actions are green on the exact RC head.
5. Runtime API health reports `execution_mode=SHADOW` and `live_enabled=false`.
6. Runtime API readiness reports `status=ready` and `database=ok`.
7. Post-deployment SHADOW audit contract remains read-only/fail-closed.
8. Operator approval workflow is recorded and explicitly separates readiness approval from LIVE activation.

## Runtime evidence collected on 2026-09-08
- API container running.
- Postgres running and healthy.
- `/api/health`: status ok, execution mode SHADOW, LIVE false, wallet-signature auth.
- `/api/readiness`: status ready, database ok.
- `.env` safety posture: SHADOW / LIVE false / fixture false / operator false.

The exact release candidate is considered Step 22 complete only after the Step 22 gate and GitHub CI pass on the committed RC head. LIVE PILOT remains a separate post-roadmap decision.
