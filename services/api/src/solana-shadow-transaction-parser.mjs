const TOKEN_PROGRAMS=new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA','TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']);
function keyString(k){return typeof k==='string'?k:String(k?.pubkey||'');}
function finite(v){const n=Number(v);return Number.isFinite(n)?n:null;}
function tokenMap(rows=[]){const out=new Map();for(const r of rows){const mint=String(r?.mint||'');const owner=String(r?.owner||'');const amount=finite(r?.uiTokenAmount?.uiAmountString??r?.uiTokenAmount?.uiAmount);if(mint&&amount!==null)out.set(`${owner}:${mint}`,{mint,owner,amount});}return out;}

export function parseSolanaShadowTransaction(signature,tx){
 if(!tx?.transaction?.message)return null;
 const keys=(tx.transaction.message.accountKeys||[]).map(keyString).filter(Boolean);
 const programIds=new Set();
 for(const ix of tx.transaction.message.instructions||[]){const p=keyString(ix?.programId);if(p)programIds.add(p);}
 for(const group of tx.meta?.innerInstructions||[])for(const ix of group?.instructions||[]){const p=keyString(ix?.programId);if(p)programIds.add(p);}
 const pre=tokenMap(tx.meta?.preTokenBalances),post=tokenMap(tx.meta?.postTokenBalances),changes=[];
 for(const key of new Set([...pre.keys(),...post.keys()])){const a=pre.get(key),b=post.get(key);const delta=(b?.amount||0)-(a?.amount||0);if(Math.abs(delta)>0)changes.push({mint:(b||a).mint,owner:(b||a).owner,delta_ui:delta});}
 const mints=[...new Set(changes.map(x=>x.mint))];
 return {signature:String(signature||''),slot:finite(tx.slot),block_time:finite(tx.blockTime),success:tx.meta?.err==null,fee_lamports:finite(tx.meta?.fee),program_ids:[...programIds],token_mints:mints,token_balance_changes:changes,token_program_observed:[...programIds].some(p=>TOKEN_PROGRAMS.has(p)),source:'SOLANA_RPC_REAL_TRANSACTION',mode:'SHADOW',non_custodial:true,signer_required:false,execution_dispatched:false,live_execution_authorized:false};
}