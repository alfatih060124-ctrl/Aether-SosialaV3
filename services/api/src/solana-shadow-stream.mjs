const DEFAULT_PROGRAMS = Object.freeze({
  RAYDIUM_AMM_V4: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  RAYDIUM_CPMM: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
  RAYDIUM_CLMM: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  ORCA_WHIRLPOOL: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  METEORA_DLMM: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo'
});

function wsUrl(rpc = process.env.SOLANA_RPC_URL || '') {
  return String(rpc).replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
}

export function createSolanaShadowStream({
  rpcUrl = process.env.SOLANA_RPC_URL,
  WebSocketImpl = globalThis.WebSocket,
  onEvent = () => {}
} = {}) {
  if (typeof WebSocketImpl !== 'function') throw new Error('websocket_unavailable');
  const url = wsUrl(rpcUrl);
  if (!url) throw new Error('solana_rpc_unconfigured');

  let ws = null;
  let seq = 1;
  let startedAt = 0;
  let events = 0;
  let lastEventAt = null;
  const programs = Object.entries(DEFAULT_PROGRAMS);
  const requestDex = new Map();
  const subscriptions = new Map();

  function subscribe() {
    for (const [dex, program] of programs) {
      const id = seq++;
      requestDex.set(id, { dex, program });
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'logsSubscribe',
        params: [{ mentions: [program] }, { commitment: 'processed' }]
      }));
    }
  }

  function handleMessage(event) {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }

    if (message?.id && Number.isSafeInteger(Number(message?.result))) {
      const pending = requestDex.get(Number(message.id));
      if (pending) {
        subscriptions.set(Number(message.result), pending);
        requestDex.delete(Number(message.id));
      }
      return;
    }

    if (message?.method !== 'logsNotification') return;
    const subscription = Number(message?.params?.subscription);
    const route = subscriptions.get(subscription) || null;
    events += 1;
    lastEventAt = Date.now();
    onEvent(Object.freeze({
      source: 'SOLANA_RPC_WEBSOCKET',
      dex: route?.dex || null,
      program_id: route?.program || null,
      observed_at: new Date(lastEventAt).toISOString(),
      slot: message?.params?.result?.context?.slot ?? null,
      signature: message?.params?.result?.value?.signature ?? null,
      err: message?.params?.result?.value?.err ?? null,
      ingest_latency_ms: 0,
      mode: 'SHADOW',
      execution_dispatched: false,
      live_execution_authorized: false
    }));
  }

  return Object.freeze({
    start() {
      if (ws) return;
      startedAt = Date.now();
      ws = new WebSocketImpl(url);
      ws.onopen = subscribe;
      ws.onmessage = handleMessage;
    },
    stop() {
      try { ws?.close(); } catch {}
      ws = null;
      requestDex.clear();
      subscriptions.clear();
    },
    status() {
      return {
        enabled: Boolean(ws),
        source: 'SOLANA_RPC_WEBSOCKET',
        programs: programs.map(([dex, program]) => ({ dex, program })),
        subscriptions_active: subscriptions.size,
        events,
        last_event_at: lastEventAt ? new Date(lastEventAt).toISOString() : null,
        started_at: startedAt ? new Date(startedAt).toISOString() : null,
        mode: 'SHADOW',
        read_only: true,
        signer_required: false,
        network_submission_authorized: false,
        live_execution_authorized: false
      };
    }
  });
}