import { randomUUID } from 'node:crypto';

export function createSignalIntelligenceRepository(pool) {
  return {
    async recordAssessment(assessment) {
      const assessmentId = randomUUID();
      const q = await pool.query(
        `INSERT INTO signal_assessments
          (assessment_id,source_type,token_mint,quote_mint,quality_score,verdict,hard_rejects,components,snapshot,observed_at)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10)
         RETURNING *`,
        [
          assessmentId,
          assessment.source_type || 'MACHINE_INTELLIGENCE',
          assessment.token_mint,
          assessment.quote_mint,
          assessment.quality_score,
          assessment.verdict,
          JSON.stringify(assessment.hard_rejects || []),
          JSON.stringify(assessment.components || {}),
          JSON.stringify(assessment.snapshot || {}),
          assessment.observed_at ? new Date(assessment.observed_at) : null
        ]
      );
      return q.rows[0];
    },

    async getAssessment(id) {
      return (await pool.query('SELECT * FROM signal_assessments WHERE assessment_id=$1', [id])).rows[0] ?? null;
    },

    async recentAssessments(limit = 50) {
      const n = Math.min(200, Math.max(1, Number(limit) || 50));
      return (await pool.query('SELECT * FROM signal_assessments ORDER BY created_at DESC LIMIT $1', [n])).rows;
    },

    async recordDecision({ assessmentId = null, decision, mandate = {}, position = {} }) {
      const decisionId = randomUUID();
      const q = await pool.query(
        `INSERT INTO auto_trade_decisions
          (decision_id,assessment_id,source_type,token_mint,action,reason_codes,requested_amount_usd,mode,live_execution_authorized,mandate,position)
         VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,false,$9::jsonb,$10::jsonb)
         RETURNING *`,
        [
          decisionId,
          assessmentId,
          decision.source_type || 'ALGORITHMIC_STRATEGY',
          decision.token_mint,
          decision.action,
          JSON.stringify(decision.reason_codes || []),
          Number(decision.requested_amount_usd || 0),
          'SHADOW',
          JSON.stringify(mandate || {}),
          JSON.stringify(position || {})
        ]
      );
      return q.rows[0];
    },

    async recentDecisions(limit = 50) {
      const n = Math.min(200, Math.max(1, Number(limit) || 50));
      return (await pool.query('SELECT * FROM auto_trade_decisions ORDER BY created_at DESC LIMIT $1', [n])).rows;
    }
  };
}
