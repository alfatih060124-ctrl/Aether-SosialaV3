const safeLimit=value=>{const n=Number(value);return Number.isInteger(n)?Math.max(1,Math.min(1000,n)):500;};
const round=n=>Math.round(Number(n)*1e6)/1e6;

export function createShadowPerformanceHistory(pool){
  if(!pool||typeof pool.query!=='function')throw new Error('shadow_history_pool_required');
  return Object.freeze({
    async summary({follower_user_id=null,limit=500}={}){
      const params=[];
      let where="e.event_type='CLOSE' AND e.mode='SHADOW' AND e.live_execution_authorized=false";
      if(follower_user_id){params.push(String(follower_user_id));where+=` AND e.follower_user_id=$${params.length}`;}
      params.push(safeLimit(limit));
      const rows=(await pool.query(`SELECT e.event_id,e.position_id,e.follower_user_id,e.policy_id,e.realized_pnl_usdc,e.mark_price_usdc AS exit_price_usdc,e.occurred_at,e.evidence,p.token_mint,p.quote_mint,p.opened_at,p.closed_at
        FROM follower_shadow_position_events e JOIN follower_shadow_positions p ON p.position_id=e.position_id
        WHERE ${where} ORDER BY e.occurred_at DESC LIMIT $${params.length}`,params)).rows||[];
      const pnl=rows.map(r=>Number(r.realized_pnl_usdc)).filter(Number.isFinite);
      const wins=pnl.filter(v=>v>0),losses=pnl.filter(v=>v<0),flat=pnl.filter(v=>v===0);
      const grossProfit=wins.reduce((a,b)=>a+b,0),grossLoss=Math.abs(losses.reduce((a,b)=>a+b,0));
      let equity=0,peak=0,maxDrawdown=0;
      for(const value of [...pnl].reverse()){equity+=value;peak=Math.max(peak,equity);maxDrawdown=Math.max(maxDrawdown,peak-equity);}
      return Object.freeze({
        schema:'aether.shadow.performance_history.v1',
        mode:'SHADOW',simulated:true,live_execution_authorized:false,
        sample_size:pnl.length,wins:wins.length,losses:losses.length,flat:flat.length,
        win_rate_pct:pnl.length?round((wins.length/pnl.length)*100):null,
        net_realized_pnl_usdc:round(pnl.reduce((a,b)=>a+b,0)),
        average_pnl_usdc:pnl.length?round(pnl.reduce((a,b)=>a+b,0)/pnl.length):null,
        average_win_usdc:wins.length?round(grossProfit/wins.length):null,
        average_loss_usdc:losses.length?round(-grossLoss/losses.length):null,
        profit_factor:grossLoss>0?round(grossProfit/grossLoss):(grossProfit>0?null:0),
        max_drawdown_usdc:round(maxDrawdown),
        gross_profit_usdc:round(grossProfit),gross_loss_usdc:round(grossLoss),
        items:Object.freeze(rows.map(r=>Object.freeze({...r,realized_pnl_usdc:Number(r.realized_pnl_usdc),mode:'SHADOW',simulated:true,live_execution_authorized:false})))
      });
    }
  });
}
