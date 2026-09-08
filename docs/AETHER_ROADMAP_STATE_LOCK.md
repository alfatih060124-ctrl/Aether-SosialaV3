# AETHER Roadmap — STATE LOCK

Date locked: 2026-09-08
Canonical active roadmap: 22 steps
Current runtime posture: SHADOW / fail-closed / LIVE OFF
Hard minimum expected net edge: 20 bps / 0.20%

## Source of truth
1. Repository branch / HEAD / PR / CI status overrides chat recollection.
2. Step numbers below are fixed. Do not renumber them because an older PR has a different title.
3. Steps 1–15 are normalized names for completed foundation work. They are not claims about old historical chat labels.
4. Steps 16–22 are the active locked sequence and must not move.
5. No merge and no production LIVE deployment unless explicitly ordered by the user.
6. Old or parallel PRs are integration inputs only; do not merge them wholesale when a newer replacement exists.

## Locked 22-step roadmap
| Step | Canonical scope | Status |
|---|---|---|
| 01 | Repository, runtime and service foundation | COMPLETE / LOCKED |
| 02 | Database schema, migrations and persistence foundation | COMPLETE / LOCKED |
| 03 | SHADOW safety gates and fail-closed execution boundary | COMPLETE / LOCKED |
| 04 | Wallet authentication, session and account boundary | COMPLETE / LOCKED |
| 05 | Admin/API control-plane foundation and audit boundary | COMPLETE / LOCKED |
| 06 | Trader onboarding and marketplace foundation | COMPLETE / LOCKED |
| 07 | Solana/Solscan evidence collection and provenance | COMPLETE / LOCKED |
| 08 | Reconciliation, verified performance and deterministic accounting | COMPLETE / LOCKED |
| 09 | Fee, revenue and platform configuration controls | COMPLETE / LOCKED |
| 10 | Copy mandate, follower controls and position accounting | COMPLETE / LOCKED |
| 11 | Market intelligence, discovery and token-risk inputs | COMPLETE / LOCKED |
| 12 | Signal quality, risk qualification and net-edge calculation | COMPLETE / LOCKED |
| 13 | ORCA/Raydium read-only market evidence and scanner foundation | COMPLETE / LOCKED |
| 14 | PAPER/SHADOW persistence, history and performance foundation | COMPLETE / LOCKED |
| 15 | Runtime/deployment readiness, audit and pre-simulator checkpoint | COMPLETE / LOCKED |
| 16 | Real-market SHADOW Auto Trade simulator web | COMPLETE / LOCKED |
| 17 | Persistent per-member Auto Trade START/STOP control | COMPLETE / LOCKED |
| 18 | Scan performance optimization and persistent candidate cache | COMPLETE / LOCKED |
| 19 | Runtime observability, duration metrics and scan audit events | COMPLETE / LOCKED |
| 20 | SHADOW validation matrix / validation gate | COMPLETE / LOCKED |
| 21 | HARDEN + product/control-plane consolidation | NEXT |
| 22 | APPROVE + final end-to-end readiness review | NOT STARTED |

## Step 21 — HARDEN + consolidation
Step 21 is the only place where the parallel product/control-plane stack is refreshed onto the current Step-20 base.

Canonical targets:
- New Admin Control Panel design/function target: PR #314, refreshed rather than merged wholesale.
- Member Area target: PR #324 five-menu functional member shell.
- Subscription/payment target: PR #325 dynamic server-authoritative pricing + finalized USDC verification; this supersedes fixed-price assumptions from #313.
- Delegated authority target: PR #326.
- LIVE funding/preflight target: PR #327.
- Auto Trade state/runtime binding inputs: PRs #328, #329 and #330.
- Two-leg LIVE executor foundation input: PR #331, still fail-closed and not LIVE-enabled.

Hardening acceptance:
- preserve EXECUTION_MODE=SHADOW and LIVE_ENABLED=false throughout Step 21;
- circuit breaker / emergency-kill behavior remains fail-closed;
- fault-injection and provider-failure cases must not authorize execution;
- signer isolation is design/contract only until a later explicit LIVE authorization;
- no weakening of the 20 bps net-edge floor, risk filters, route verification or accounting;
- resolve stale/duplicate PR overlap before any integration commit.

## Step 22 — APPROVE / final readiness review
Step 22 performs final dependency reconciliation and end-to-end acceptance across engine, member area, subscription/payment, delegated authority, Control Panel, audit, accounting and security gates.

Required output:
- one final release-candidate commit/branch;
- all required CI green;
- deployment/runtime audit green;
- explicit operator-approval workflow recorded;
- LIVE remains OFF unless the user separately orders activation after all gates pass.

## After Step 22
`LIVE PILOT` is deliberately outside the numbered 22-step build roadmap. It is not automatic and is never implied by Step 22 completion. A pilot requires a separate explicit user instruction and tightly limited exposure.

## Current checkpoint
- Step 20 branch: `feat/step20-shadow-validation-gate`
- Step 20 HEAD: `6b97df7`
- Step 20 validation: 8/8 local PASS and GitHub CI PASS
- Step 20 PR: #336, open/draft/unmerged
- Current roadmap documentation branch: `chore/aether-roadmap-state-lock`
- NEXT work item after this roadmap lock: Step 21 only.
