# AETHER Deployment Topology

Status: canonical infrastructure contract for the current SHADOW release.

## One owner per function

| Layer | Role | May serve public traffic | May write production state | May execute/simulate operator flows | Production database |
| --- | --- | --- | --- | --- | --- |
| GitHub | Source of truth + CI | No | No | CI tests only | No |
| Vercel | Public UI + constrained read/auth BFF | Yes | No authoritative writes | No | No |
| PRIMARY_VM | API + PostgreSQL + wallet-auth authority + control plane + execution/signal runtime | Yes, through Caddy allowlist | Yes | Yes, protected/internal | Yes, sole authoritative DB |
| Render | STANDBY_RENDER health-only placeholder | Health endpoint only | No | No | Detached |

This topology intentionally avoids active-active API/database operation. There is one authoritative state writer: `PRIMARY_VM`.

## Traffic contract

Public browser traffic terminates at Vercel for the public site. The Vercel API function has two narrowly defined responsibilities:

1. Proxy explicit public read-only GET endpoints to `https://api.aether.boats`.
2. Act as a wallet-auth BFF for `/api/auth/challenge`, `/api/auth/verify`, `/api/auth/session`, and `/api/auth/logout`.

The BFF does not receive or inject `API_TOKEN`, `ADMIN_API_TOKEN`, database credentials, or signer material. It never forwards a client-supplied Authorization header. After successful wallet signature verification, the opaque user session token returned by the PRIMARY_VM is converted into a host-only `HttpOnly; Secure; SameSite=Lax` cookie and removed from the browser-visible JSON response.

`api.aether.boats` terminates at Caddy on the VM. Caddy allows public read endpoints plus only the four wallet-auth endpoints above. Admin, SHADOW simulation, execution mutation, billing mutation, signal mutation, and other state-changing control routes are not routable on the public API hostname.

Wallet authentication is an identity function, not execution authority. A login signature proves control of a public wallet address only and does not authorize a trade, transfer, token approval, or movement of funds.

`a.aether.boats` is the dedicated Admin control-plane hostname. Its `/api/admin/*` traffic is proxied only to the VM-local API on `127.0.0.1:8080`. Backend `ADMIN_API_TOKEN` authorization remains mandatory. The public Vercel project does not serve Admin.

PostgreSQL is not published to a host port. The API container is published only to `127.0.0.1:8080`; Caddy is the public ingress.

## Render standby contract

Render is not an automatic production failover and must not be configured as a second active backend. `render.yaml` starts `services/api/src/standby-server.mjs`, disables automatic deploy, carries no `DATABASE_URL`, `API_TOKEN`, or `ADMIN_API_TOKEN`, and returns `503` for all non-health operational traffic.

An existing Render dashboard may still retain historical environment values. The standby process does not read them, but they should be removed from the Render dashboard when convenient. Never attach the production database to Render while the VM is the active writer.

## Failover fencing rule

A future failover must be deliberate and fenced. Do not point production DNS to Render while `PRIMARY_VM` can still write. The required order is:

1. Declare an incident and block/stop the VM write path.
2. Verify the old primary can no longer mutate state.
3. Promote or restore a single authoritative database under a documented recovery procedure.
4. Change exactly one backend to the active role and re-run safety/readiness checks.
5. Move traffic only after the new primary is proven ready.
6. Keep the former primary fenced until reconciliation is complete.

Automatic dual-writer failover is prohibited because it can create split-brain execution, duplicate billing, conflicting copy decisions, and inconsistent audit history.

## SHADOW safety invariant

Current production flags remain:

- `EXECUTION_MODE=SHADOW`
- `LIVE_ENABLED=false`
- `FIXTURE_GATE_PASSED=false`
- `OPERATOR_APPROVED=false`

No deployment topology or wallet-auth change is permission to enable LIVE. LIVE requires a separate explicit gate review and approval process.

## Repository enforcement

`scripts/infrastructure-contract.mjs` is run by CI and prevents regression to a dual-runtime topology. It checks VM role, localhost-only API publication, Render standby isolation, constrained Vercel read/auth routing, Caddy public/admin separation, session-cookie handling, canonical frontend sources, and removal of public simulation controls.

`scripts/vm-apply-routing.sh` performs a transactional Caddy cutover on the VM: validate, backup, install, reload, verify public reads, verify the wallet-auth lane, verify blocked execution/control mutation paths, and roll back automatically if verification fails.

`scripts/vm-deploy-wallet-auth.sh` performs the wallet-auth rollout with a pre-deploy database backup, SHADOW/LIVE gate checks, migration deployment, API rebuild, routing cutover, port-isolation checks, and final fail-closed verification.
