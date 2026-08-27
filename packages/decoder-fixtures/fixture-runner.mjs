import { validateCanonicalTradeEvent } from '../canonical-tradeevent/schema.mjs';

export function runFixtureSuite({ decoder, fixtures }) {
  const results = fixtures.map((fixture) => {
    let candidates = [];
    try { candidates = decoder.decode(fixture.transaction) || []; } catch { candidates = []; }
    const expected = fixture.expected;
    const validCandidates = candidates.filter((event) => validateCanonicalTradeEvent(event).valid);
    const passed = expected === 'REJECT'
      ? validCandidates.length === 0
      : validCandidates.length === 1;
    return { id: fixture.id, expected, passed, candidate_count: validCandidates.length };
  });
  return {
    total: results.length,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    pass_rate: results.length ? results.filter((r) => r.passed).length / results.length : 1,
    results
  };
}
