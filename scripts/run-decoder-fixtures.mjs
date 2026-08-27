import fs from 'node:fs';
import { runFixtureSuite } from '../packages/decoder-fixtures/fixture-runner.mjs';
import { jupiterDecoder } from '../services/ingestion-worker/src/decoders/jupiter.mjs';

const fixtures = JSON.parse(fs.readFileSync(new URL('../packages/decoder-fixtures/fixtures/core.json', import.meta.url), 'utf8'));
const report = runFixtureSuite({ decoder: jupiterDecoder, fixtures });
console.log(JSON.stringify(report, null, 2));
if (report.failed !== 0) process.exit(1);
