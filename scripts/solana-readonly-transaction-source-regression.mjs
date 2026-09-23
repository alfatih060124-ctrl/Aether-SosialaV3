import assert from 'node:assert/strict';
import {createSolanaReadonlyTransactionSource} from '../services/api/src/solana-readonly-transaction-source.mjs';
const calls=[]; const fetchImpl=async(_u,o)=>{const b=JSON.parse(o.body);calls.push(b);return {ok:true,json:async()=>({result:b.method==='getSignaturesForAddress'?[{signature:'sig',slot:1}]:{slot:1,transaction:{}}})};};
const s=createSolanaReadonlyTransactionSource({rpcUrl:'https://rpc.invalid',fetchImpl});
assert.equal((await s.getSignaturesForAddress('address',25))[0].signature,'sig');
assert.equal((await s.getTransaction('sig')).slot,1);
assert.deepEqual(calls.map(x=>x.method),['getSignaturesForAddress','getTransaction']);
assert.equal(s.safety.send_transaction,false);assert.equal(s.safety.non_custodial,true);
console.log('PASS solana readonly transaction source regression');