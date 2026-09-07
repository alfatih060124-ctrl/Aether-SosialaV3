import assert from 'node:assert/strict';
import {collectSolanaTransactionOuterInstructionEvidence,verifySolanaTransactionOuterInstructionEvidence} from '../services/api/src/solana-transaction-outer-instruction-evidence.mjs';

const SIG='1'.repeat(64);
const WALLET='11111111111111111111111111111111';
const PROGRAM='4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi';
const ACCOUNT='8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR';
const START='2026-09-03T08:00:00.000Z',OBS='2026-09-03T08:01:00.000Z';
const DATA='3MN5';
const rpcFound=async(method,params)=>{assert.equal(method,'getTransaction');assert.equal(params[0],SIG);assert.equal(params[1].encoding,'json');return{jsonrpc:'2.0',result:{slot:456,blockTime:1788422400,transaction:{signatures:[SIG],message:{accountKeys:[WALLET],instructions:[{programIdIndex:1,accounts:[0,2],data:DATA},{programIdIndex:1,accounts:[2],data:'',stackHeight:null}]}},meta:{err:null,loadedAddresses:{writable:[PROGRAM],readonly:[ACCOUNT]}}}}};
const collect=(overrides={})=>collectSolanaTransactionOuterInstructionEvidence({rpcRequest:rpcFound,signature:SIG,traderWallet:WALLET,rpcEndpointLabel:'test-rpc',commitment:'confirmed',requestStartedAt:START,observedAt:OBS,...overrides});

const evidence=await collect();
assert.equal(evidence.schema,'aether.solana.transaction_outer_instruction_evidence.v1');
assert.equal(evidence.collection_status,'PENDING_DATA');assert.equal(evidence.metrics_available,false);assert.equal(evidence.verified,false);assert.equal(evidence.published,false);assert.equal(evidence.live_execution_authorized,false);assert.equal(evidence.reconciliation_required,true);
for(const k of ['trades_count','total_return_bps','win_rate_bps','drawdown_bps','reputation_score'])assert.equal(evidence[k],null);
assert.equal(evidence.source_reference,`solana_rpc:${SIG}@456`);assert.equal(evidence.outer_instruction_count,2);assert.deepEqual(evidence.outer_program_ids,[PROGRAM]);
assert.deepEqual(evidence.provenance.combined_account_keys,[WALLET,PROGRAM,ACCOUNT]);assert.equal(evidence.provenance.outer_topology[0].program_id,PROGRAM);assert.deepEqual(evidence.provenance.outer_topology[0].account_indexes,[0,2]);assert.match(evidence.provenance.outer_topology[0].data_sha256,/^[0-9a-f]{64}$/);assert.equal(verifySolanaTransactionOuterInstructionEvidence(evidence),true);

const empty=await collect({rpcRequest:async()=>({jsonrpc:'2.0',result:{slot:456,blockTime:1788422400,transaction:{signatures:[SIG],message:{accountKeys:[WALLET],instructions:[]}},meta:{err:null}}})});
assert.equal(empty.source_reference,null);assert.equal(empty.outer_instruction_count,0);assert.deepEqual(empty.outer_program_ids,[]);assert.equal(verifySolanaTransactionOuterInstructionEvidence(empty),true);
const notFound=await collect({rpcRequest:async()=>({jsonrpc:'2.0',result:null})});assert.equal(notFound.source_reference,null);assert.equal(notFound.outer_instruction_count,0);assert.equal(verifySolanaTransactionOuterInstructionEvidence(notFound),true);

for(const mutate of [
 e=>{e.total_return_bps=1},
 e=>{e.verified=true},
 e=>{e.source_reference=`solana_rpc:${SIG}@457`},
 e=>{e.outer_instruction_count=3},
 e=>{e.outer_program_ids=[]},
 e=>{e.provenance.outer_topology[0].program_id=ACCOUNT},
 e=>{e.provenance.outer_topology[0].account_indexes=[99]},
 e=>{e.provenance.outer_topology[0].data_sha256='0'.repeat(64)},
 e=>{e.provenance.combined_account_keys=[WALLET,ACCOUNT,PROGRAM]},
]){const clone=structuredClone(evidence);mutate(clone);assert.throws(()=>verifySolanaTransactionOuterInstructionEvidence(clone));}

await assert.rejects(()=>collect({rpcEndpointLabel:'https://rpc.example/?token=secret'}));
await assert.rejects(()=>collect({rpcRequest:async()=>({jsonrpc:'2.0',result:{slot:456,blockTime:1788422400,transaction:{signatures:['2'.repeat(64)],message:{accountKeys:[WALLET],instructions:[]}},meta:{err:null}}})}));
await assert.rejects(()=>collect({rpcRequest:async()=>({jsonrpc:'2.0',result:{slot:456,blockTime:1788422400,transaction:{signatures:[SIG],message:{accountKeys:[PROGRAM],instructions:[]}},meta:{err:null}}})}));
await assert.rejects(()=>collect({rpcRequest:async()=>({jsonrpc:'2.0',result:{slot:456,blockTime:1788422400,transaction:{signatures:[SIG],message:{accountKeys:[WALLET],instructions:[{programIdIndex:4,accounts:[],data:DATA}]}},meta:{err:null}}})}));
await assert.rejects(()=>collect({rpcRequest:async()=>({jsonrpc:'2.0',result:{slot:456,blockTime:1788422400,transaction:{signatures:[SIG],message:{accountKeys:[WALLET],instructions:[{programIdIndex:0,accounts:[3],data:DATA}]}},meta:{err:null}}})}));
await assert.rejects(()=>collect({rpcRequest:async()=>({jsonrpc:'2.0',result:{slot:456,blockTime:1788422400,transaction:{signatures:[SIG],message:{accountKeys:[WALLET],instructions:[{programIdIndex:0,accounts:[],data:'0OIl'}]}},meta:{err:null}}})}));
await assert.rejects(()=>collect({rpcRequest:async()=>({jsonrpc:'2.0',result:{slot:456,blockTime:1788422400,transaction:{signatures:[SIG],message:{accountKeys:[WALLET],instructions:[]}},meta:{err:'failed'}}})}));
await assert.rejects(()=>collect({rpcRequest:async()=>({jsonrpc:'2.0',result:{slot:456,blockTime:1788422600,transaction:{signatures:[SIG],message:{accountKeys:[WALLET],instructions:[]}},meta:{err:null}}})}));

console.log('SYNTHETIC / TEST-ONLY Solana transaction outer instruction evidence regression: PASS');
