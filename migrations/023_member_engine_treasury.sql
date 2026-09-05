BEGIN;

CREATE TABLE IF NOT EXISTS member_engine_treasuries (
  treasury_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  network TEXT NOT NULL DEFAULT 'SOLANA' CHECK (network IN ('SOLANA')),
  payment_asset TEXT NOT NULL DEFAULT 'USDC' CHECK (payment_asset IN ('USDC')),
  wallet_address TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','VERIFIED','DISABLED')),
  verified_at TIMESTAMPTZ,
  verification_method TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((status='VERIFIED' AND verified_at IS NOT NULL) OR status<>'VERIFIED')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_member_engine_verified_treasury
  ON member_engine_treasuries(network,payment_asset)
  WHERE status='VERIFIED';

INSERT INTO member_engine_treasuries(network,payment_asset,wallet_address,status)
VALUES('SOLANA','USDC','DPwJ2m52bmFV5ghDT3dVeDTrv1aSQste5jTxPEsqGTJt','PENDING')
ON CONFLICT(wallet_address) DO NOTHING;

COMMIT;
