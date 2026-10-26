import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { calculateEstimate, routeLead, validateContact } from '../server/domain.mjs';
import { createAdapters } from '../server/adapters.mjs';

const pricing = JSON.parse(readFileSync(new URL('../config/pricing.json', import.meta.url)));
const routing = JSON.parse(readFileSync(new URL('../config/routing.json', import.meta.url)));
const project = { projectType: 'custom_home', finish: 'standard', site: 'ready', areaSqft: 1000, city: 'Bellevue' };

test('estimate uses the configured rates, allowances and contingency; preserves provenance', () => {
  const result = calculateEstimate(project, pricing);
  // 250,000 build + 10,000 site + 20,000 planning + 42,000 contingency.
  assert.equal(result.low, 322000);
  assert.equal(result.high, 457700);
  assert.equal(result.lines.reduce((sum, line) => sum + line.low, 0), result.low);
  assert.equal(result.lines.reduce((sum, line) => sum + line.high, 0), result.high);
  assert.equal(result.mode, 'demo');
  assert.equal(result.pricingVersion, pricing.version);
  assert.ok(result.exclusions.includes('Land purchase'));
});

test('customer budget does not influence the calculated price', () => {
  assert.deepEqual(calculateEstimate({ ...project, budget: '$5M' }, pricing), calculateEstimate({ ...project, budget: '$100' }, pricing));
});

test('unknown sites and locations route to review; ready projects route to the right team', () => {
  const uncertain = { ...project, city: 'Portland', site: 'unknown' };
  const estimate = calculateEstimate(uncertain, pricing);
  assert.equal(estimate.reviewReasons.length, 2);
  assert.equal(routeLead(uncertain, estimate, routing).owner, routing.reviewOwner);
  assert.equal(routeLead(project, calculateEstimate(project, pricing), routing).owner, routing.ownersByProjectType.custom_home);
});

test('invalid areas and prototype property names cannot reach the estimator', () => {
  for (const areaSqft of [0, -1, 'NaN', Infinity, 20001, null]) assert.throws(() => calculateEstimate({ ...project, areaSqft }, pricing));
  for (const key of ['projectType', 'finish', 'site']) assert.throws(() => calculateEstimate({ ...project, [key]: '__proto__' }, pricing));
});

test('contact must include a valid email and explicit consent', () => {
  assert.throws(() => validateContact({ name: 'Test', email: 'invalid', consent: true }));
  assert.throws(() => validateContact({ name: 'Test', email: 'demo@example.com', consent: 'true' }));
  assert.equal(validateContact({ name: 'Test', email: 'DEMO@example.com', consent: true }).email, 'demo@example.com');
});

test('unimplemented live providers fail explicitly rather than silently using mock', () => {
  assert.throws(() => createAdapters({ SOCIAL_PROVIDER: 'instagram' }), /not implemented/);
  assert.throws(() => createAdapters({ CRM_PROVIDER: 'hubspot' }), /not implemented/);
  assert.throws(() => createAdapters({ BOOKING_URL: 'javascript:alert(1)' }), /HTTPS/);
});
