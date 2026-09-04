import { createTraderControlPlaneRuntimeSoD, isTraderControlPlaneMutation } from './trader-control-plane-runtime-sod.mjs';

function safeStatus(code) {
  if (code === 'trader_control_plane_role_unauthorized' || code === 'trader_control_plane_actor_invalid') return 401;
  if (code === 'trader_control_plane_actor_reuse_forbidden') return 403;
  if (code.includes('_audit_') || code === 'evidence_id_required') return 409;
  if (code.includes('_credential_required') || code.includes('credentials_must_be_distinct') || code.includes('shared_admin_credential_forbidden')) return 503;
  return 400;
}

export async function handleTraderControlPlaneRoute({ req, res, parts, pool, repos, jsonBody, send, env = process.env } = {}) {
  if (!isTraderControlPlaneMutation({ method: req?.method, parts })) return false;
  if (!pool || !repos?.marketplace || !repos?.auditEvents) {
    send(res, 503, { error: 'database_unconfigured', live_execution_authorized: false });
    return true;
  }

  let sod;
  try {
    sod = createTraderControlPlaneRuntimeSoD({ pool, env });
  } catch {
    send(res, 503, { error: 'trader_control_plane_role_config_invalid', live_execution_authorized: false });
    return true;
  }

  const traderId = parts[3];
  try {
    if (req.method === 'POST' && parts[4] === 'evidence' && !parts[5]) {
      const authz = await sod.authorizeEvidence(req);
      const evidence = await repos.marketplace.recordTraderVerificationEvidence(traderId, await jsonBody(req));
      await repos.auditEvents.append({
        event_type: 'TRADER_VERIFICATION_EVIDENCE_RECORDED',
        actor: authz.actor,
        entity_type: 'trader_verification_evidence',
        entity_id: String(evidence.evidence_id),
        payload: sod.auditPayload(authz, {
          trader_id: evidence.trader_id,
          source_type: evidence.source_type,
          source_reference: evidence.source_reference,
          observed_at: evidence.observed_at,
          evidence_status: evidence.evidence_status,
          verified: false,
          published: false,
        }),
      });
      send(res, 201, {
        evidence,
        evidence_recorded: true,
        verification_authorized: false,
        publication_authorized: false,
        mode: 'SHADOW',
        execution_dispatched: false,
        live_execution_authorized: false,
      });
      return true;
    }

    if (req.method === 'PATCH' && parts[4] === 'verification' && !parts[5]) {
      const body = await jsonBody(req);
      const authz = await sod.authorizeVerification(req, { traderId, evidenceId: body.evidence_id });
      const trader = await repos.marketplace.reviewTraderVerification(traderId, body);
      await repos.auditEvents.append({
        event_type: 'TRADER_DATA_VERIFICATION_REVIEWED',
        actor: authz.actor,
        entity_type: 'trader',
        entity_id: String(trader.trader_id),
        payload: sod.auditPayload(authz, {
          decision: String(body.decision || '').toUpperCase(),
          evidence_id: body.evidence_id,
          verification_status: trader.verification_status,
          verified: trader.verified === true,
          published: trader.published === true,
          verification_source: trader.verification_source,
        }),
      });
      send(res, 200, {
        trader,
        publication_authorized: false,
        publication_requires_explicit_action: true,
        mode: 'SHADOW',
        execution_dispatched: false,
        live_execution_authorized: false,
      });
      return true;
    }

    if (req.method === 'PATCH' && parts[4] === 'publication' && !parts[5]) {
      const authz = await sod.authorizePublication(req, { traderId });
      const body = await jsonBody(req);
      const trader = await repos.marketplace.setTraderPublished(traderId, body);
      await repos.auditEvents.append({
        event_type: trader.published ? 'TRADER_MARKETPLACE_PUBLISHED' : 'TRADER_MARKETPLACE_UNPUBLISHED',
        actor: authz.actor,
        entity_type: 'trader',
        entity_id: String(trader.trader_id),
        payload: sod.auditPayload(authz, {
          published: trader.published === true,
          onboarding_status: trader.onboarding_status,
          verification_status: trader.verification_status,
          verified: trader.verified === true,
          trader_mode: trader.mode,
        }),
      });
      send(res, 200, {
        trader,
        mode: 'SHADOW',
        execution_dispatched: false,
        live_execution_authorized: false,
      });
      return true;
    }
  } catch (error) {
    const code = String(error?.message || 'trader_control_plane_request_rejected');
    send(res, safeStatus(code), { error: code, mode: 'SHADOW', execution_dispatched: false, live_execution_authorized: false });
    return true;
  }

  return false;
}
