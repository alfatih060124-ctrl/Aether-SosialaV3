const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const WALLET_ROLES = Object.freeze([
  { role:'TREASURY_MULTISIG', label:'Main Treasury Multisig', required_for_live:true, custody_model:'MULTISIG', purpose:'Receives and stores Aether-owned platform revenue only. Never user funds.' },
  { role:'FEE_COLLECTOR', label:'Platform Fee Collector', required_for_live:true, custody_model:'EXTERNAL_WALLET', purpose:'Receives execution fee and Aether share of performance fees before settlement to Treasury.' },
  { role:'EXECUTION_AUTHORITY', label:'Execution Authority Public Key', required_for_live:true, custody_model:'ISOLATED_SIGNER', purpose:'Public key of the isolated execution authority. Private signing material must remain outside API/Admin.' },
  { role:'EMERGENCY_MULTISIG', label:'Emergency / Pause Multisig', required_for_live:true, custody_model:'MULTISIG', purpose:'Safety authority for emergency pause and critical controls.' },
  { role:'OPERATIONS_FEE_PAYER', label:'Operations / Fee Payer', required_for_live:false, custody_model:'EXTERNAL_WALLET', purpose:'Optional limited-balance wallet for sponsored Solana network or priority fees.' },
  { role:'PROGRAM_UPGRADE_AUTHORITY', label:'Program Upgrade Authority', required_for_live:false, custody_model:'MULTISIG', purpose:'Optional multisig authority for future on-chain program upgrades.' }
]);

const defs = new Map(WALLET_ROLES.map(x => [x.role, x]));

function roleDef(role) {
  const r = String(role || '').toUpperCase();
  const def = defs.get(r);
  if (!def) throw new Error('invalid_wallet_role');
  return def;
}

function normalizeAddress(value) {
  const address = String(value || '').trim();
  if (!address) throw new Error('wallet_public_address_required');
  if (!ADDRESS_RE.test(address)) throw new Error('invalid_solana_public_address');
  return address;
}

function project(def, row) {
  return {
    role:def.role,
    label:row?.label || def.label,
    purpose:def.purpose,
    required_for_live:def.required_for_live,
    custody_model:def.custody_model,
    network:'SOLANA_MAINNET',
    configured:Boolean(row?.public_address),
    public_address:row?.public_address || null,
    enabled:row ? Boolean(row.enabled) : false,
    verification_status:row?.verification_status || 'UNVERIFIED',
    notes:row?.notes || null,
    updated_at:row?.updated_at || null
  };
}

export function createWalletInfrastructureRepository(pool) {
  async function list() {
    const q = await pool.query('SELECT * FROM platform_wallets ORDER BY role');
    const rows = new Map(q.rows.map(r => [r.role, r]));
    return WALLET_ROLES.map(def => project(def, rows.get(def.role)));
  }

  async function readiness() {
    const items = await list();
    const required = items.filter(x => x.required_for_live);
    const missing = required.filter(x => !x.configured || !x.enabled).map(x => x.role);
    return {
      wallet_layer_ready_for_live: missing.length === 0,
      required_configured: required.length - missing.length,
      required_total: required.length,
      missing_roles: missing,
      live_execution_authorized:false,
      private_keys_stored:false,
      user_funds_custodied:false
    };
  }

  async function upsert(role, input = {}) {
    const def = roleDef(role);
    const address = normalizeAddress(input.public_address);
    const label = String(input.label || def.label).trim().slice(0, 120);
    const notes = input.notes == null ? null : String(input.notes).trim().slice(0, 500);
    const enabled = input.enabled !== false;
    const q = await pool.query(`
      INSERT INTO platform_wallets(role,network,public_address,label,custody_model,enabled,verification_status,notes)
      VALUES($1,'SOLANA_MAINNET',$2,$3,$4,$5,'UNVERIFIED',$6)
      ON CONFLICT(role) DO UPDATE SET
        public_address=EXCLUDED.public_address,
        label=EXCLUDED.label,
        custody_model=EXCLUDED.custody_model,
        enabled=EXCLUDED.enabled,
        verification_status=CASE WHEN platform_wallets.public_address=EXCLUDED.public_address THEN platform_wallets.verification_status ELSE 'UNVERIFIED' END,
        notes=EXCLUDED.notes,
        updated_at=now()
      RETURNING *
    `,[def.role,address,label,def.custody_model,enabled,notes]);
    return project(def,q.rows[0]);
  }

  return { list, readiness, upsert };
}
