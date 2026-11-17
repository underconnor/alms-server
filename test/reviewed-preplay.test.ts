import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { reviewedPreplayPermitInput, reviewedPreplaySource } from '../src/reviewed-preplay.js';

test('operator review inputs bind exact source artifacts, a parent fingerprint and evidence digest; caller proof fields are rejected',()=>{
  const input={parentId:randomUUID(),expectedVersion:'2026-11-08T01:00:03.123456Z',originalFingerprint:'a'.repeat(64),
    evidenceSha256:'b'.repeat(64),expiresAt:new Date(Date.now()+60000).toISOString(),source:reviewedPreplaySource};
  assert.deepEqual(reviewedPreplayPermitInput.parse(input),input);
  for(const key of ['commit','archiveSha256','manifestSha256','workerImageSha256'] as const)
    assert.equal(reviewedPreplayPermitInput.safeParse({...input,source:{...input.source,[key]:'0'.repeat(input.source[key].length)}}).success,false);
  for(const extra of [{notStarted:true},{terminationProof:true},{userId:randomUUID()},{automaticallyReviewed:true}])
    assert.equal(reviewedPreplayPermitInput.safeParse({...input,...extra}).success,false);
  assert.equal(reviewedPreplayPermitInput.safeParse({...input,originalFingerprint:'missing'}).success,false);
});
