CREATE TABLE IF NOT EXISTS platform_wallets (
  role text PRIMARY KEY CHECK (role IN (
    'TREASURY_MULTISIG',
    'FEE_COLLECTOR',
    'OPERATIONS_FEE_PAYER',
    'EXECUTION_AUTHORITY',
    'EMERGENCY_MULTISIG',
    'PROGRAM_UPGRADE_AUTHORITY'
  )),
  network text NOT NULL DEFAULT 'SOLANA_MAINNET' CHECK (network = 'SOLANA_MAINNET'),
  public_address text NOT NULL CHECK (public_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  label text,
  custody_model text NOT NULL CHECK (custody_model IN ('MULTISIG','EXTERNAL_WALLET','ISOLATED_SIGNER')),
  enabled boolean NOT NULL DEFAULT true,
  verification_status text NOT NULL DEFAULT 'UNVERIFIED' CHECK (verification_status IN ('UNVERIFIED','VERIFIED_ONCHAIN','DISABLED')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS platform_wallets_enabled_idx ON platform_wallets(enabled);

COMMENT ON TABLE platform_wallets IS 'Public addresses only. Never store seed phrases, private keys, signing material, or user funds here.';
COMMENT ON COLUMN platform_wallets.public_address IS 'Solana public address/public key only.';
