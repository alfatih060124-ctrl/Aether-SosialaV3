const token = process.env.ADMIN_API_TOKEN;
const response = await fetch('http://127.0.0.1:8080/api/admin/runtime', {
  headers: { authorization: `Bearer ${token}` }
});
const body = await response.json();
const scan = body.market_shadow_runtime || body.market_shadow || body.auto_strategy_market_shadow || null;
console.log(JSON.stringify({
  execution_mode: body.execution_mode,
  live_enabled: body.live_enabled,
  scheduler: body.member_autotrade_scheduler,
  scan: scan && {
    status: scan.status,
    scan_id: scan.scan_id,
    summary: scan.summary && {
      candidates_discovered: scan.summary.candidates_discovered,
      candidates_scanned: scan.summary.candidates_scanned,
      paper_min_expected_net_edge_bps: scan.summary.paper_min_expected_net_edge_bps,
      paper_qualified_count: scan.summary.paper_qualified_count,
      best_expected_net_edge_bps: scan.summary.best_expected_net_edge_bps,
      rejection_breakdown: scan.summary.rejection_breakdown
    },
    error: scan.error
  }
}, null, 2));