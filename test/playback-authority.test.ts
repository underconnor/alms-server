import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import { createPlaybackAdmission, createPlaybackFinalProof, inspectPlaybackAdmission, inspectPlaybackFinalProof, jobClaim,
  type PlaybackAdmission, type PlaybackFinalProof, type WorkerClaim } from '../src/playback-authority.js';
import { publicJob, resultStatus, type Job } from '../src/domain.js';

const scope = { userId: 'private-owner', courseId: 'private-course', lectureId: 'private-lecture' };
const school = { generation: randomUUID(), encryptedSession: 'private-sealed-school-cookie' };
const claim: WorkerClaim = { ...scope, jobId: 'private-job', acceptedGeneration: school.generation, executionTokenHash: 'b'.repeat(64) };
const changed = (error: unknown) => error instanceof Error && error.message === '학교 인증이나 작업 상태가 바뀌었습니다. 다시 확인해 주세요.';

test('admission is opaque and cannot be reconstructed from JSON or moved to another owner/target', () => {
  const proof = createPlaybackAdmission(scope,school);
  assert.equal(Object.isFrozen(proof),true);
  assert.equal(inspectPlaybackAdmission(proof,scope).generation,school.generation);
  assert.equal(inspectPlaybackAdmission(proof,scope).encryptedSession,school.encryptedSession);
  for(const key of ['userId','courseId','lectureId'] as const)
    assert.throws(()=>inspectPlaybackAdmission(proof,{...scope,[key]:'different'}),changed);
  for(const copied of [{...proof},JSON.parse(JSON.stringify(proof)),{}])
    assert.throws(()=>inspectPlaybackAdmission(copied as PlaybackAdmission,scope),changed);
  const visible=JSON.stringify(proof)+inspect(proof);
  for(const secret of [...Object.values(scope),...Object.values(school)])assert.equal(visible.includes(secret),false);
});
test('final proof is bound to every execution claim field and its exact accepted school generation', () => {
  const proof=createPlaybackFinalProof(claim,school);
  assert.equal(inspectPlaybackFinalProof(proof,claim).encryptedSession,school.encryptedSession);
  for(const key of Object.keys(claim) as Array<keyof WorkerClaim>)
    assert.throws(()=>inspectPlaybackFinalProof(proof,{...claim,[key]:'different'}),changed);
  assert.throws(()=>createPlaybackFinalProof(claim,{...school,generation:randomUUID()}),changed);
  assert.throws(()=>inspectPlaybackFinalProof({} as PlaybackFinalProof,claim),changed);
  const visible=JSON.stringify(proof)+inspect(proof);
  for(const secret of [...Object.values(claim),...Object.values(school)])assert.equal(visible.includes(secret),false);
});
test('admission and final proof expire after 30 seconds without changing their contents', t => {
  let now=Date.now();t.mock.method(Date,'now',()=>now);
  const admission=createPlaybackAdmission(scope,school),final=createPlaybackFinalProof(claim,school);
  now+=29_999;assert.equal(inspectPlaybackAdmission(admission,scope).generation,school.generation);
  assert.equal(inspectPlaybackFinalProof(final,claim).generation,school.generation);
  now++;assert.throws(()=>inspectPlaybackAdmission(admission,scope),changed);assert.throws(()=>inspectPlaybackFinalProof(final,claim),changed);
});
test('public job uses a whitelist and legacy outcome stays unknown', () => {
  const job={id:'job',userId:scope.userId,courseId:scope.courseId,lectureId:scope.lectureId,status:'running',scheduledFor:'2026-10-03T00:00:00Z',
    createdAt:'2026-10-03T00:00:00Z',updatedAt:'2026-10-03T00:00:00Z',schoolResult:null,errorCode:null,
    idempotencyKey:'private-key',requestHash:'private-hash',acceptedGeneration:school.generation,executionTokenHash:claim.executionTokenHash,
    executionOutcome:null,arbitraryFuturePrivateField:'private-cookie'} as Job;
  const dto=publicJob(job);
  assert.deepEqual(Object.keys(dto).sort(),['id','courseId','lectureId','status','scheduledFor','createdAt','updatedAt','schoolResult','errorCode','executionOutcome'].sort());
  assert.equal(dto.executionOutcome,null);assert.doesNotMatch(JSON.stringify(dto),/private-owner|private-key|private-hash|private-cookie/);
  assert.throws(()=>jobClaim({...job,acceptedGeneration:null}),changed);
  assert.throws(()=>jobClaim({...job,executionTokenHash:null}),changed);
});
test('school recognition and ended playback remain separate even at 100 percent', () => {
  const schoolResult={observedAt:'2026-10-03T00:00:00Z',progressPercent:100,attendance:'unknown' as const,recognized:null};
  assert.equal(resultStatus(schoolResult,'ended'),'completed');
  for(const outcome of [null,'not_started','interrupted'] as const)assert.equal(resultStatus(schoolResult,outcome),'needs_verification');
  assert.equal(resultStatus(null,'ended'),'needs_verification');
  assert.equal(resultStatus({...schoolResult,recognized:true},'ended'),'succeeded');
  assert.equal(resultStatus({...schoolResult,recognized:true},'interrupted'),'needs_verification');
  assert.equal(resultStatus({...schoolResult,recognized:true},null),'needs_verification');
});
