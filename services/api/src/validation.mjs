const POLICY_TYPES = new Set(['FIXED_USD', 'PERCENT_EQUITY', 'CAPPED_PROPORTIONAL']);
const MODES = new Set(['SHADOW', 'PAPER', 'LIVE']);

export function validateCopyPolicy(input) {
  if (!input || !POLICY_TYPES.has(input.policy_type)) throw new Error('invalid_policy_type');
  if (!(Number(input.value) > 0)) throw new Error('invalid_policy_value');
  if (!(Number(input.max_copy_amount_usd) > 0)) throw new Error('invalid_max_copy_amount');
  if (!(Number(input.max_position_amount_usd) > 0)) throw new Error('invalid_max_position_amount');
  return true;
}

export function validateExecutionMode(mode) {
  if (!MODES.has(mode)) throw new Error('invalid_execution_mode');
  return mode;
}
