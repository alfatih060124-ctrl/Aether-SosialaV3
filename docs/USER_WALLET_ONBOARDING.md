# Aether Wallet-Only User Onboarding

## Product decision

Aether V1 uses **wallet-only identity**. There is no KYC requirement and no password-based account registration in the core onboarding flow.

Aether must never request, receive, store, or display a user's seed phrase or private key.

The wallet proves account ownership by signing a one-time authentication message. Login signatures are not blockchain transactions and do not move funds.

---

## 1. First-time registration

```text
Landing Page
    |
    v
Connect Solana Wallet
    |
    v
Request One-Time Challenge
    |
    v
User Signs Login Message
    |
    v
Backend Verifies Signature + Nonce + Expiry
    |
    +-- invalid --> Reject / Retry
    |
    `-- valid
          |
          v
     Create Aether Account
          |
          v
     Optional Username / Display Name
          |
          v
     Accept Terms + Risk + Fee Disclosure
          |
          v
     User Dashboard
```

A newly created account starts as a normal Aether user/follower-capable account. The user does **not** need to choose Trader during registration.

---

## 2. Returning-user login

```text
Connect Existing Wallet
    |
    v
One-Time Challenge
    |
    v
Sign Message
    |
    v
Verify Signature
    |
    v
Create Secure Session
    |
    v
Dashboard
```

Each login challenge must be single-use, short-lived, domain-bound, and wallet-bound to prevent replay attacks.

---

## 3. Default user/follower flow

After account creation, the user can use follower features without becoming a trader.

```text
Dashboard
   |
   +--> Browse Trader Marketplace
   |       |
   |       v
   |    View Verified On-chain Performance
   |       |
   |       v
   |    Select Trader
   |       |
   |       v
   |    Configure Copy Policy
   |       |- amount / allocation
   |       |- max exposure
   |       |- max slippage
   |       |- daily loss limit
   |       `- pause / revoke
   |       |
   |       v
   |    User Approval / Permission
   |       |
   |       v
   |    SHADOW / LIVE execution according to runtime gates
   |
   `--> Algorithmic Strategies / Signal Intelligence
           |
           v
        User selects strategy + bounded mandate
```

User funds remain controlled by the user or by an explicitly user-authorized non-custodial execution mechanism. Treasury does not control normal user withdrawals.

---

## 4. Become a Trader

Trader status is an **upgrade path after the user already owns an Aether account**.

```text
User Dashboard
    |
    v
Become a Trader
    |
    v
Select Signal Wallet
    |
    v
Sign Trader-Ownership Challenge
    |
    +-- invalid --> Reject
    |
    `-- valid
          |
          v
     Create Trader Profile
          |
          |- display name
          |- strategy category
          |- description
          |- payout public address
          `- public risk disclosure
          |
          v
     On-chain History Analysis
          |
          |- realized / unrealized PnL
          |- ROI
          |- max drawdown
          |- win/loss ratio
          |- trade count
          |- account age
          |- holding time
          |- exposure
          `- risk score
          |
          v
     Verification / Marketplace Gate
          |
          +-- insufficient history / risk issue --> Private / Pending
          |
          `-- passes requirements
                 |
                 v
             Marketplace Trader
```

A user can remain a follower while also becoming a trader.

---

## 5. Account model

```text
Aether User Account
    |
    +-- Primary Wallet (required)
    +-- Linked Wallets (optional)
    +-- Public Profile
    +-- Consent History
    +-- Security / Session State
    +-- Follower Copy Policies
    |
    `-- Trader Profile (optional)
            |
            +-- Verified Signal Wallet
            +-- Payout Public Address
            +-- On-chain Performance
            +-- Risk Metrics
            `-- Marketplace Status
```

Wallet ownership and trader status are separate concepts. A wallet-authenticated account does not automatically become a trader.

---

## 6. Wallet linking and recovery

V1 should support one primary wallet. A later linked-wallet feature can allow multiple verified wallets under one account.

Changing the primary wallet must require:

1. an authenticated current session;
2. signature from the current primary wallet whenever available;
3. signature from the new wallet;
4. a security cooldown for sensitive account changes;
5. an immutable audit event.

An optional recovery wallet can be added without introducing passwords or KYC.

---

## 7. Authentication security requirements

Every login or wallet-ownership proof must use:

- cryptographically random nonce;
- one-time use;
- short expiration;
- exact wallet public address;
- Aether domain / application identifier;
- purpose (`LOGIN`, `LINK_WALLET`, `BECOME_TRADER`, `CHANGE_PRIMARY`, etc.);
- server-side signature verification;
- replay protection;
- rate limiting;
- session expiration / revocation;
- audit logging for security-sensitive actions.

A challenge signature must never be interpreted as permission to transfer funds.

---

## 8. Data minimization

Core account data should be limited to:

- internal user ID;
- wallet public address(es);
- optional username / display name;
- role/status flags;
- consent timestamps and policy versions;
- trader profile data if the user becomes a trader;
- security/session metadata needed for abuse prevention.

No KYC identity fields are required in Aether V1.

---

## 9. User-facing safety copy

The wallet connection and signature screen should always show a message equivalent to:

> Aether will never ask for your seed phrase or private key. Signing this login message does not move funds and does not authorize a trade.

Trading permissions must be requested separately and must show explicit capital, risk, slippage, duration, and revocation limits.

---

## 10. Final V1 journey

```text
REGISTER / LOGIN
Connect Wallet -> Sign -> Aether Account -> Dashboard

FOLLOWER
Dashboard -> Marketplace -> Trader -> Copy Policy -> User Permission -> Execution

TRADER
Dashboard -> Become a Trader -> Verify Signal Wallet -> Build Profile -> On-chain Analysis -> Marketplace

AUTO TRADE
Dashboard -> Algorithmic Strategy -> Configure Bounded Mandate -> Risk Gate -> Execution Engine
```

This separation keeps onboarding simple while preserving Aether's non-custodial and transparency principles.