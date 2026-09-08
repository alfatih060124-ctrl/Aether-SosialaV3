# AETHER Roadmap — STATE LOCK

Date locked: 2026-09-08
Canonical active roadmap: 22 steps
Current runtime posture: SHADOW / fail-closed / LIVE OFF
Hard minimum expected net edge: 20 bps / 0.20%

## Source of truth
1. Repository branch / HEAD / PR / CI overrides chat recollection.
2. Step numbers below are fixed. Older PR titles do not renumber the roadmap.
3. Steps 1–15 are historical foundations present in the repository. They are not all active final product surfaces.
4. Steps 16–22 are the active Auto Trade completion sequence and must not move.
5. No merge and no production LIVE deployment unless explicitly ordered by the user.
6. Old or parallel PRs are integration inputs only; newer canonical replacements win.

## Status meanings
- `FOUNDATION DONE`: the underlying capability/code exists, but it may be parked, superseded in UI, or still require final consolidation.
- `PRODUCT SURFACE PARKED`: code is preserved but intentionally excluded from the current member-facing launch path.
- `COMPLETE`: that numbered step passed its acceptance work on its canonical branch.
- `LOCKED`: do not repeat, renumber, or expand that completed step unless a verified defect requires a fix. LOCKED does not mean merged to main or LIVE deployed.
- `NEXT`: current work item.
- `NOT STARTED`: no work should begin before prior locked steps are satisfied.
- `LIVE OFF`: no signer/network submission/fund movement is authorized.

## Locked 22-step roadmap
| Step | Canonical scope | Status |
|---|---|---|
| 01 | Repository, runtime and service foundation | FOUNDATION DONE |
| 02 | Database schema, migrations and persistence foundation | FOUNDATION DONE |
| 03 | SHADOW safety gates and fail-closed execution boundary | FOUNDATION DONE |
| 04 | Wallet authentication, session and account boundary | FOUNDATION DONE |
| 05 | Admin/API control-plane and audit foundation | FOUNDATION DONE |
| 06 | Trader onboarding and marketplace foundation | FOUNDATION DONE / PRODUCT SURFACE PARKED |
| 07 | Solana/Solscan evidence collection and provenance | FOUNDATION DONE |
| 08 | Reconciliation, verified performance and deterministic accounting | FOUNDATION DONE |
| 09 | Fee, revenue and platform configuration controls | FOUNDATION DONE |
| 10 | Copy Mandate / follower Copy Trading foundation | FOUNDATION DONE / PRODUCT SURFACE PARKED |
| 11 | Market intelligence, discovery and token-risk inputs | FOUNDATION DONE |
| 12 | Signal quality, risk qualification and net-edge calculation | FOUNDATION DONE |
| 13 | ORCA/Raydium read-only market evidence and scanner foundation | FOUNDATION DONE |
| 14 | PAPER/SHADOW persistence, history and performance foundation | FOUNDATION DONE |
| 15 | Runtime/deployment readiness, audit and pre-simulator checkpoint | FOUNDATION DONE |
| 16 | Real-market SHADOW Auto Trade simulator web | COMPLETE / LOCKED |
| 17 | Persistent per-member Auto Trade START/STOP control | COMPLETE / LOCKED |
| 18 | Scan performance optimization and persistent candidate cache | COMPLETE / LOCKED |
| 19 | Runtime observability, duration metrics and scan audit events | COMPLETE / LOCKED |
| 20 | SHADOW validation matrix / validation gate | COMPLETE / LOCKED |
| 21 | HARDEN + current product/control-plane consolidation | COMPLETE / LOCKED |
| 22 | APPROVE + final end-to-end readiness review | COMPLETE / LOCKED |

## Copy Trading status — explicit
Copy Trading is not deleted. Its SHADOW foundation exists in the repository, including persisted Copy Mandates, follower accounting, admin controls and regressions. The consolidated Copy Mandate → Auto Trade SHADOW runtime was merged historically in PR #193.

However, the canonical new Member Area target in PR #324 intentionally uses exactly five top-level menus — Dashboard, Auto Trade, Performance, Subscription and Account — and keeps Copy Trade, Trader Marketplace and Market Discovery out of the active member navigation while preserving their code.

Therefore for the current Auto Trade launch path:
- Copy Trading = PARKED / OUT OF ACTIVE PRODUCT SURFACE.
- Trader Marketplace = PARKED / OUT OF ACTIVE PRODUCT SURFACE.
- Market Discovery as a standalone member menu = PARKED from the five-menu shell; market data still remains an engine input.
- These parked modules do not block Steps 21–22.
- They are not to be silently re-enabled during Step 21 or Step 22.
- Re-enabling Social/Copy Trading later requires a separate explicit roadmap decision.

## Step 21 — HARDEN + consolidation
Step 21 refreshes only the current Auto Trade product/control-plane targets onto the Step-20 base:
- New Admin Control Panel target: PR #314, refreshed rather than merged wholesale.
- Member Area target: PR #324 five-menu shell.
- Subscription/payment target: PR #325 dynamic server-authoritative pricing + finalized USDC verification; this supersedes fixed-price assumptions from #313.
- Delegated authority target: PR #326.
- LIVE funding/preflight target: PR #327.
- Auto Trade state/runtime binding inputs: PRs #328, #329 and #330.
- Two-leg LIVE executor foundation input: PR #331, still fail-closed and not LIVE-enabled.

Step 21 acceptance:
- preserve EXECUTION_MODE=SHADOW and LIVE_ENABLED=false;
- preserve 20 bps minimum expected net edge and all route/risk/accounting gates;
- circuit breaker / Emergency Kill stays fail-closed;
- provider failure and fault-injection cannot authorize execution;
- no private-key/signer material is placed in Admin/API;
- Copy Trading/Marketplace are not reintroduced into the five-menu member surface;
- stale/duplicate PR overlap is resolved before integration.

Step 21 completion evidence:
- canonical Step-21 PR: #338, open/draft/unmerged;
- canonical GitHub head: `7455f941210ffeb24a85ba2e202cecb79d2a009c`;
- GitHub tree: `5cb9b6b54d4ad8decdc326e8ce5b26648aab2ff8`, exactly matching the verified local Step-21 tree;
- Step 20 SHADOW Validation Gate PASS;
- Step 21 Admin Control Panel Regression PASS;
- Step 21 Member Area Regression PASS;
- Step 21 Subscription Regression PASS;
- Step 21 Member Auto Trade Runtime Binding Regression PASS;
- Member Delegated Authority Regression PASS;
- Member LIVE Funding Preflight Regression PASS;
- Two-Leg LIVE Execution Boundary Regression PASS;
- Aether V3 CI PASS;
- SHADOW / LIVE OFF preserved.

## Step 22 — APPROVE / final readiness review
Final end-to-end acceptance covers the current Auto Trade launch path only: engine, five-menu Member Area, subscription/payment, delegated authority, funding preflight, new Admin Control Panel, audit, accounting and security gates.

Step 22 completion evidence:
- canonical release-candidate branch: `rc/step22-auto-trade-readiness`;
- canonical Step-22 PR: #339, open/draft/unmerged;
- exact GitHub head: `1e06fcae62a839ef02323a4af7276773fe47548f`;
- exact tree: `93d79371e1aa375ad107041a6917c70b4fa03af6`, matching the verified local RC tree;
- dedicated Step 22 Final Readiness Gate PASS 13/13;
- GitHub PR workflows on the exact RC head: 9/9 observed runs completed successfully, including Step 22 Final Readiness Gate, Aether V3 CI and Step 20 SHADOW Validation Gate;
- runtime API health: ok, execution mode SHADOW, LIVE false;
- runtime API readiness: ready, database ok;
- operator-approval workflow recorded separately from LIVE activation;
- `EXECUTION_MODE=SHADOW`, `LIVE_ENABLED=false`, `FIXTURE_GATE_PASSED=false`, `OPERATOR_APPROVED=false` preserved;
- no signer, transaction submission or fund movement authorized.

## After Step 22
`LIVE PILOT` is outside the numbered 22-step build roadmap. It is never automatic and requires a separate explicit user instruction with limited exposure. Until that instruction is given, LIVE remains OFF and all fail-closed gates remain locked.

## Current checkpoint
- Steps 16–22: COMPLETE / LOCKED.
- Step 21 PR: #338, open/draft/unmerged.
- Step 22 branch: `rc/step22-auto-trade-readiness`.
- Step 22 GitHub HEAD: `1e06fcae62a839ef02323a4af7276773fe47548f`.
- Step 22 tree: `93d79371e1aa375ad107041a6917c70b4fa03af6`.
- Step 22 CI: 9/9 observed PR workflows PASS.
- Step 22 PR: #339, open/draft/unmerged.
- Roadmap documentation PR: #337, open/draft/unmerged.
- Runtime: SHADOW / LIVE OFF / fail-closed.
- Numbered 22-step build roadmap is complete.
- NEXT, only by separate explicit user instruction: LIVE PILOT.
