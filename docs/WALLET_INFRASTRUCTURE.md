# Aether Wallet Infrastructure

Aether is non-custodial by design. The Admin Control Panel stores **public addresses/public keys only**. Seed phrases, private keys, hardware-wallet secrets, and user funds must never be entered into Admin, API, GitHub, or the database.

## Core platform wallets

| Role | Required before LIVE | Purpose | Custody |
|---|---:|---|---|
| `TREASURY_MULTISIG` | Yes | Holds Aether-owned revenue only | External multisig |
| `FEE_COLLECTOR` | Yes | Receives platform execution fee and Aether performance-fee share | External wallet / controlled settlement |
| `EXECUTION_AUTHORITY` | Yes | Public key of isolated execution authority | Isolated signer; private key outside API/Admin |
| `EMERGENCY_MULTISIG` | Yes | Emergency pause / critical safety authority | External multisig |
| `OPERATIONS_FEE_PAYER` | No | Optional limited-balance fee payer for sponsored Solana fees | External operational wallet |
| `PROGRAM_UPGRADE_AUTHORITY` | No | Future on-chain program upgrade authority | External multisig |

## Wallets that are NOT configured by Admin

- **Follower/User wallet**: connected and controlled by the user.
- **Trader wallet**: trader's own on-chain wallet and signal source.
- **Trader payout address**: associated with the trader account, not a global platform wallet.
- **User withdrawal address**: user-controlled; Treasury approval is not part of normal user withdrawal.

## Money flow

```text
User wallet / user-controlled vault
        |
        | copy or algorithmic execution under user permission
        v
Execution Engine -> DEX / Solana
        |
        +--> execution fee ------------------> FEE_COLLECTOR
        |
        +--> realized performance fee --------> split
                                                 |-- trader share
                                                 `-- Aether share -> FEE_COLLECTOR

FEE_COLLECTOR -> periodic settlement -> TREASURY_MULTISIG
```

User principal never enters the Aether Treasury.

## Admin UX

The Admin page should expose a single **Wallet Infrastructure** section. The operator pastes only public addresses into fixed role fields. A readiness indicator shows which required roles are missing. No private-key input exists anywhere in the UI or schema.

## LIVE safety rule

Wallet configuration completeness is only one LIVE prerequisite. Even when all required wallet roles are configured, `LIVE_ENABLED` must remain false until signer isolation, user permission architecture, quote/simulation, reconciliation, risk controls, decoder fixtures, operational monitoring, and explicit operator approval are all independently verified.
