# AETHER ORCA ↔ Raydium SHADOW Core Wiring

This branch is a dependent follow-up to PR #318.

Scope is limited to wiring the already-verified concrete ORCA Whirlpool and Raydium CLMM/CPMM read-only providers into the ORCA↔Raydium scanner and existing fail-closed two-leg arbitrage qualification core.

It does not add LIVE execution, transaction signing, network submission, production deployment, subscription changes, UI redesign, persistence, or new risk-provider implementation.

Qualification continues to require explicit verified network-fee evidence and verified risk evidence. Missing/unverified evidence fails closed. The minimum expected NET edge remains 20 bps (0.20%) after predictable route and network costs.
