import assert from 'node:assert/strict';
import {parseSolanaShadowTransaction} from '../services/api/src/solana-shadow-transaction-parser.mjs';
const tx={slot:123,blockTime:456,transaction:{message:{accountKeys:[{pubkey:'wallet'}],instructions:[{programId:'DexProgram'}]}},meta:{err:null,fee:5000,preTokenBalances:[{mint:'MintA',owner:'wallet',uiTokenAmount:{uiAmountString:'10'}}],postTokenBalances:[{mint:'MintA',owner:'wallet',uiTokenAmount:{uiAmountString:'8'}},{mint:'MintB',owner:'wallet',uiTokenAmount:{uiAmountString:'4'}}],innerInstructions:[]}};
const r=parseSolanaShadowTransaction('sig',tx);
assert.equal(r.signature,'sig');assert.equal(r.success,true);assert.deepEqual(r.token_mints.sort(),['MintA','MintB']);
assert.equal(r.token_balance_changes.find(x=>x.mint==='MintA').delta_ui,-2);assert.equal(r.token_balance_changes.find(x=>x.mint==='MintB').delta_ui,4);
assert.equal(r.non_custodial,true);assert.equal(r.signer_required,false);assert.equal(r.execution_dispatched,false);assert.equal(r.live_execution_authorized,false);
console.log('PASS solana shadow transaction parser regression');