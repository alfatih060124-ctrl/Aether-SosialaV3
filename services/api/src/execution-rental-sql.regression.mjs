import fs from 'node:fs';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');
const routeStart = source.indexOf("if(req.method==='POST'&&route==='/api/execution/rental')");
assert.notEqual(routeStart, -1, 'execution rental route must remain explicit');
const routeEnd = source.indexOf('\n', routeStart);
const route = source.slice(routeStart, routeEnd === -1 ? source.length : routeEnd);

const insert = route.match(/INSERT INTO execution_engine_rentals \(([^)]+)\) VALUES\(([^)]+)\)/);
assert.ok(insert, 'execution rental INSERT must remain statically auditable');

const columns = insert[1].split(',').map((value) => value.trim()).filter(Boolean);
const placeholders = [...insert[2].matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
assert.equal(placeholders.length, columns.length, 'execution rental INSERT column/value count must match');
assert.deepEqual(placeholders, Array.from({ length: columns.length }, (_, index) => index + 1), 'execution rental INSERT placeholders must be contiguous and complete');

console.log('execution rental SQL contract regression: PASS');
