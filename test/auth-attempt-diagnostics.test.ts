import test from 'node:test';
import assert from 'node:assert/strict';
import { hashToken } from '../src/store.js';
import { IssuedAttemptDiagnostics } from '../src/auth-attempt-diagnostics.js';

test('issued-attempt correlation retains only exact hashes and expires without extending on reads or repeats', () => {
  let now = 0;
  const diagnostics = new IssuedAttemptDiagnostics({now: () => now, ttlMs: 100});
  const first = hashToken('synthetic-first-state'), other = hashToken('synthetic-other-state');
  assert.equal(diagnostics.sameAttemptPreviouslyIssuedSession(first), false);
  diagnostics.rememberSessionIssued(first);
  assert.equal(diagnostics.sameAttemptPreviouslyIssuedSession(first), true);
  assert.equal(diagnostics.sameAttemptPreviouslyIssuedSession(other), false);
  assert.equal(diagnostics.sameAttemptPreviouslyIssuedSession('synthetic-first-state'), false);
  assert.deepEqual(Object.keys(diagnostics), []);
  assert.equal(JSON.stringify(diagnostics), '{}');
  now = 99;
  diagnostics.rememberSessionIssued(first);
  assert.equal(diagnostics.sameAttemptPreviouslyIssuedSession(first), true);
  now = 100;
  assert.equal(diagnostics.sameAttemptPreviouslyIssuedSession(first), false);
  diagnostics.rememberSessionIssued(other);
  now = 199;
  assert.equal(diagnostics.sameAttemptPreviouslyIssuedSession(other), true);
  now = 200;
  assert.equal(diagnostics.sameAttemptPreviouslyIssuedSession(other), false);
});

test('issued-attempt diagnostics cap process-local evidence and release expired capacity before eviction', () => {
  let now = 0;
  const diagnostics = new IssuedAttemptDiagnostics({now: () => now, ttlMs: 100, capacity: 2});
  const first = hashToken('synthetic-first-state'), second = hashToken('synthetic-second-state'), third = hashToken('synthetic-third-state');
  diagnostics.rememberSessionIssued(first);
  now = 1; diagnostics.rememberSessionIssued(second);
  now = 2; diagnostics.rememberSessionIssued(third);
  assert.equal(diagnostics.sameAttemptPreviouslyIssuedSession(first), false);
  assert.equal(diagnostics.sameAttemptPreviouslyIssuedSession(second), true);
  assert.equal(diagnostics.sameAttemptPreviouslyIssuedSession(third), true);
  now = 101; diagnostics.rememberSessionIssued(first);
  assert.equal(diagnostics.sameAttemptPreviouslyIssuedSession(second), false);
  assert.equal(diagnostics.sameAttemptPreviouslyIssuedSession(third), true);
  assert.equal(diagnostics.sameAttemptPreviouslyIssuedSession(first), true);
});

test('diagnostic retention bounds are finite positive values and unvalidated input is never retained', () => {
  for (const ttlMs of [0, -1, NaN, Infinity]) assert.throws(() => new IssuedAttemptDiagnostics({ttlMs}), RangeError);
  for (const capacity of [0, -1, 1.5, NaN, Infinity]) assert.throws(() => new IssuedAttemptDiagnostics({capacity}), RangeError);
  const diagnostics = new IssuedAttemptDiagnostics();
  for (const value of ['synthetic-private-state', 'A'.repeat(64), '1'.repeat(65)]) {
    diagnostics.rememberSessionIssued(value);
    assert.equal(diagnostics.sameAttemptPreviouslyIssuedSession(value), false);
  }
});
