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
| 21 | HARDEN + current product/control-plane consolidation | NEXT |
| 22 | APPROVE + final end-to-end readiness review | NOT STARTED |

## Copy Trading status — explicit
Copy Trading is not deleted. Its SHADOW foundation exists in the repository, including persisted Copy Mandates, follower accounting, admin controls and regressions. The consolidated Copy Mandate → Auto Trade SHADOW runtime was merged historically in PR #193.

However, the canonical new Member Area target in PR #324 intentionally uses exactly five top-level menus — Dashboard, Auto Trade, Performance, Subscription and Account — and keeps Copy Trade, Trader Marketplace and Market Discovery out of the active member navigation while preserving their code.

Therefore for the current Auto Trade launch path:
- Copy Trading = PARKED / OUT OF ACTIVE PRODUCT SURFACE.
- Trader Marketplace = PARKED / OUT OF ACTIVE PRODUCT SURFACE.
- Market Discovery as a standalone member menu = PARKED from the five-menu shell; market data still remains an engine input.
- These parked modules do not block Steps 21–22.
- They are not to be silently re-enabled during Step 21.
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

## Step 22 — APPROVE / final readiness review
Final end-to-end acceptance covers the current Auto Trade launch path only: engine, five-menu Member Area, subscription/payment, delegated authority, funding preflight, new Admin Control Panel, audit, accounting and security gates.

Required output:
- one release-candidate branch/commit;
- all required CI green;
- deployment/runtime audit green;
- explicit operator-approval workflow recorded;
- LIVE remains OFF unless the user separately orders activation after all gates pass.

## After Step 22
`LIVE PILOT` is outside the numbered 22-step build roadmap. It is never automatic and requires a separate explicit instruction with limited exposure.

## Current checkpoint
- Step 20 branch: `feat/step20-shadow-validation-gate`
- Step 20 HEAD: `6b97df7`
- Step 20 validation: 8/8 local PASS and GitHub CI PASS
- Step 20 PR: #336, open/draft/unmerged
- Roadmap documentation PR: #337, open/draft/unmerged
- NEXT work item: Step 21 only.
