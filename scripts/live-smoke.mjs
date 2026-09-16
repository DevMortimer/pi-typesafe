import assert from 'node:assert/strict';
import { createTypeSafe, choice, noul, score } from '../dist/index.js';

// One explicitly requested, billable call with synthetic data only.
try {
  const client = createTypeSafe({ maxRequests: 1 });
  const result = await client.evaluate({
    state: { message: 'I was charged twice for my subscription. Please help today.' },
    questions: {
      category: choice('Which team should handle this message?', {
        billing: 'Charges and payments', technical: 'Software failures', other: 'None of these',
      }),
      urgent: noul('Does the sender request help today?'),
      frustration: score('How frustrated does the sender sound?', [
        'A neutral request without expressed frustration',
        'Expressed frustration while remaining civil',
        'Explicit anger or threats',
      ]),
    },
  });
  assert.equal(result.answers.category.choice, 'billing');
  assert.ok(result.answers.urgent.noul > 0.5);
  assert.ok(result.answers.frustration.score >= 0 && result.answers.frustration.score <= 2);
  assert.equal(client.getUsage().requestsStarted, 1);
  console.log(JSON.stringify({
    passed: true, model: result.model, elapsedMs: result.elapsedMs, usage: result.usage,
    category: result.answers.category.choice,
    urgent: result.answers.urgent.noul,
    frustration: result.answers.frustration.score,
  }, null, 2));
} catch (error) {
  // Do not dump errors, request bodies, environment, or stacks containing credentials.
  console.error(JSON.stringify({ passed: false, code: error?.code ?? 'assertion-or-configuration', status: error?.status }));
  process.exitCode = 1;
}
