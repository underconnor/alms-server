import test from 'node:test';
import assert from 'node:assert/strict';
import { AssignmentSubmissionService } from '../src/assignment-submission-service.js';
import { AppError } from '../src/errors.js';
import { SchoolAssignmentWriteError } from '@alms/ssu-api';
import type { AssignmentSubmissionFailureDiagnostic } from '../src/assignment-submission-diagnostics.js';
import { canRelease,publicOperation, type Operation, type SchoolOptions, type StoredOperation, type SubmissionInput, type SubmissionRepository, type SubmissionSchool, type Upload } from '../src/assignment-submission-types.js';

const owner = 'synthetic-owner', course = '101', assignment = '501';
const operationId = '11111111-1111-4111-8111-111111111111';
const uploadId = '22222222-2222-4222-8222-222222222222';
const key = '33333333-3333-4333-8333-333333333333';
const pledgeDigest = 'a'.repeat(64);
const input = (): SubmissionInput => ({ submissionType: 'online_text_entry', expectedAttempt: 1, pledgeAccepted: true, pledgeDigest, text: 'synthetic private draft' });
const options = (): SchoolOptions => ({ supported: true, modes: ['online_text_entry', 'online_url', 'online_upload'], blockedReason: null, allowedExtensions: ['pdf'], expectedAttempt: 1, pledge: { required: true, text: '합성 동의 문구', digest: pledgeDigest }, generation: 'synthetic-generation' });
const stored = (): StoredOperation => ({ id: operationId, courseId: course, assignmentId: assignment, state: 'preparing', submissionType: 'online_text_entry', createdAt: '2026-10-03T00:00:00Z', updatedAt: '2026-10-03T00:00:00Z', errorCode: null, receipt: null, owner, generation: 'synthetic-generation', executionProtocol: 1, writeStartedAt: null, executionFinishedAt: null, schoolObservation: null, observationGeneration: null, release: null, input: input(), privateReceipt: null, workerToken: null, leaseExpiresAt: null });
const upload = (): Upload => ({ id: uploadId, status: 'reserved', fileName: 'synthetic.pdf', contentType: 'application/pdf', sizeBytes: 4, expiresAt: '2099-10-03T00:00:00Z', generation: 'synthetic-generation', sha256: null });
const receipt = { attempt: 2, submittedAt: '2026-10-03T00:01:00Z' };
async function settleWork(f: ReturnType<typeof fixture>) {
  for (let attempt = 0; attempt < 20 && !f.calls.some(value => value.startsWith('release:')); attempt++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.some(value => value.startsWith('release:')), true, 'accepted synthetic work should finish');
  await new Promise(resolve => setImmediate(resolve));
}
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };

function fixture() {
  const calls: string[] = [];
  const diagnostics: AssignmentSubmissionFailureDiagnostic[] = [];
  let value: StoredOperation | null = null;
  let existing: Operation | null = null;
  const currentOptions = options();
  const validate = async () => { calls.push('validate'); };
  const repository: SubmissionRepository = {
    cleanup: async () => { calls.push('cleanup'); },
    reserve: async (o, c, a, generation, file) => { assert.deepEqual([o, c, a, generation], [owner, course, assignment, currentOptions.generation]); calls.push('reserve'); return { ...upload(), ...file }; },
    receive: async () => { calls.push('receive'); return { ...upload(), status: 'ready' }; },
    cancel: async () => { calls.push('cancel'); },
    files: async (o, c, a, generation, ids) => { assert.deepEqual([o, c, a, generation], [owner, course, assignment, currentOptions.generation]); calls.push('files'); return ids.map(id => ({ ...upload(), id, status: 'ready' as const, bytes: new Uint8Array([1, 2, 3, 4]) })); },
    existing: async (o, c, a, k) => { assert.deepEqual([o, c, a, k], [owner, course, assignment, key]); calls.push('existing'); return existing; },
    create: async (o, c, a, generation, k, content) => { assert.deepEqual([o, c, a, k], [owner, course, assignment, key]); calls.push('create'); value = { ...stored(), generation, input: content, submissionType: content.submissionType }; return { operation: publicOperation(value), created: true }; },
    current: async (o, c, a) => { assert.deepEqual([o, c, a], [owner, course, assignment]); calls.push('current'); return value ? publicOperation(value) : null; },
    get: async (o, c, a, id) => { assert.deepEqual([o, c, a, id], [owner, course, assignment, operationId]); calls.push('get'); return value ? { ...value } : null; },
    claim: async () => { calls.push('claim'); if (!value) return null; value.workerToken = 'synthetic-lease'; return { ...value }; },
    claimConfirmation: async () => { calls.push('claim_confirmation'); if (!value) return null; value.workerToken = 'synthetic-confirmation-lease'; return { ...value }; },
    save: async (o, id, token, state, errorCode, privateReceipt, publicReceipt) => { assert.deepEqual([o, id], [owner, operationId]); assert.equal(token, value?.workerToken); calls.push(`save:${state}`); if (value) { value.state = state; value.errorCode = errorCode; if (privateReceipt !== undefined) value.privateReceipt = privateReceipt; if (publicReceipt !== undefined) value.receipt = publicReceipt; } },
    finishExecution: async (_o, _id, _token) => { calls.push('finished'); if(value)value.executionFinishedAt=new Date().toISOString(); },
    observe: async (_o,_c,_a,_id,_token,proof) => { calls.push('record_observation');if(value){value.schoolObservation=proof.observation;value.observationGeneration=proof.generation;value.leaseExpiresAt=null;} },
    releaseConfirmation: async () => { calls.push('release_confirmation'); },
    release: async (_o,_c,_a,_id,_token,observedAt,proof) => { calls.push('release_operation');assert.equal(value?.schoolObservation?.observedAt,observedAt);if(value)value.release={kind:'school_submission_present',releasedAt:new Date().toISOString()}; },
    releaseFiles: async (o, ids) => { assert.equal(o, owner); calls.push(`release:${ids.length}`); },
  };
  const school: SubmissionSchool = {
    options: async (o, c, a, check, signal) => { assert.deepEqual([o, c, a], [owner, course, assignment]); assert.equal(signal.aborted, false); await check(); calls.push('school_options'); return { ...currentOptions }; },
    submit: async (_o, _c, _a, _generation, _input, _files, check, _beforeUpload, beforeWrite, signal) => { await check(); signal.throwIfAborted(); await beforeWrite({ syntheticPrivateReceipt: true }); signal.throwIfAborted(); calls.push('school_write'); return { state: 'confirmed', privateReceipt: { syntheticPrivateReceipt: true }, receipt }; },
    reconcile: async (_o, _c, _a, _privateReceipt, check) => { await check(); calls.push('school_reconcile'); return { state: 'confirmed', privateReceipt: { syntheticPrivateReceipt: true }, receipt }; },
    observe: async (_o,_c,_a,check) => { await check();calls.push('school_observe');return {generation:currentOptions.generation,encryptedSession:'synthetic-seal',observation:{workflowState:'submitted' as const,attempt:2,submittedAt:receipt.submittedAt,observedAt:new Date().toISOString(),attribution:'unattributed' as const}}; },
    invalidate: async () => { calls.push('invalidate'); },
  };
  return { calls, diagnostics, repository, school, currentOptions, validate, service: new AssignmentSubmissionService(repository, school, value => diagnostics.push(value)), value: () => value, setValue: (next: StoredOperation | null) => { value = next; }, setExisting: (next: Operation | null) => { existing = next; } };
}

test('fresh options keep owner boundaries and omit the private authentication generation', async () => {
  const f = fixture(); f.setValue(stored());
  const result = await f.service.options(owner, course, assignment, f.validate, new AbortController().signal);
  assert.equal(result.currentOperation?.id, operationId); assert.equal(result.maxFiles, 5); assert.equal(result.maxFileBytes, 20 * 1024 * 1024);
  assert.equal('generation' in result, false); assert.equal('owner' in (result.currentOperation ?? {}), false);
  assert.equal(f.calls.includes('school_write'), false); assert.equal(f.calls.at(-1), 'validate');
});

test('temporary upload reservation checks fresh support and school extension rules before storage', async () => {
  const f = fixture(); const signal = new AbortController().signal;
  await assert.rejects(f.service.reserve(owner, course, assignment, { fileName: 'synthetic.exe', contentType: 'application/octet-stream', sizeBytes: 4 }, f.validate, signal), { code: 'FILE_TYPE_NOT_ALLOWED' });
  assert.equal(f.calls.includes('reserve'), false);
  const accepted = await f.service.reserve(owner, course, assignment, { fileName: 'synthetic.PDF', contentType: 'application/pdf', sizeBytes: 4 }, f.validate, signal);
  assert.equal(accepted.status, 'reserved'); assert.equal('generation' in accepted, false); assert.equal(f.calls.includes('school_write'), false);
});

for (const mismatch of ['support', 'attempt', 'pledge', 'mode', 'acceptance'] as const) {
  test(`new submission rejects changed ${mismatch} before creating or writing`, async () => {
    const f = fixture(), content = input();
    if (mismatch === 'support') f.currentOptions.supported = false;
    if (mismatch === 'attempt') content.expectedAttempt = 0;
    if (mismatch === 'pledge') content.pledgeDigest = 'b'.repeat(64);
    if (mismatch === 'mode') f.currentOptions.modes = ['online_upload'];
    if (mismatch === 'acceptance') content.pledgeAccepted = false;
    await assert.rejects(f.service.submit(owner, course, assignment, key, content, f.validate), { code: mismatch === 'support' ? 'SUBMISSION_BLOCKED' : mismatch === 'acceptance' ? 'PLEDGE_REQUIRED' : 'SUBMISSION_CHANGED' });
    assert.equal(f.calls.includes('create'), false); assert.equal(f.calls.includes('school_write'), false);
  });
}

test('same idempotency key returns the existing operation without starting another school request', async () => {
  const f = fixture(); f.setExisting(publicOperation(stored()));
  assert.equal((await f.service.submit(owner, course, assignment, key, input(), f.validate)).id, operationId);
  assert.deepEqual(f.calls, ['validate', 'existing']);
});

test('confirmed school result follows durable before-write checkpoint and cache invalidation failure never repeats it', async () => {
  const f = fixture(); f.school.invalidate = async () => { f.calls.push('invalidate'); throw new Error('synthetic cache failure'); };
  const response = await f.service.submit(owner, course, assignment, key, input(), f.validate);
  assert.equal(response.state, 'preparing'); await settleWork(f);
  assert.equal(f.value()?.state, 'confirmed'); assert.deepEqual(f.value()?.receipt, receipt);
  assert.ok(f.calls.indexOf('save:sending') < f.calls.indexOf('school_write'));
  assert.equal(f.calls.filter(value => value === 'school_write').length, 1); assert.equal(f.calls.includes('release:0'), true);
  const publicResult = await f.service.status(owner, course, assignment, operationId);
  assert.doesNotMatch(JSON.stringify(publicResult), /synthetic private draft|syntheticPrivateReceipt|synthetic-generation|workerToken|owner/);
});

test('school generation change between acceptance and work rejects before file or school writes', async () => {
  const f = fixture(); const original = f.school.options; let reads = 0;
  f.school.options = async (...args) => { const value = await original(...args); reads++; return { ...value, generation: reads > 1 ? 'changed-generation' : value.generation }; };
  await f.service.submit(owner, course, assignment, key, input(), f.validate); await settleWork(f);
  assert.equal(f.value()?.state, 'rejected'); assert.equal(f.value()?.errorCode, 'SCHOOL_SESSION_CHANGED');
  assert.equal(f.calls.includes('files'), false); assert.equal(f.calls.includes('school_write'), false);
});

test('lost school response after write checkpoint is confirmation-needed and never auto-submitted again', async () => {
  const f = fixture();
  f.school.submit = async (_o, _c, _a, _g, _i, _f, _v, _u, beforeWrite) => { await beforeWrite({ syntheticPrivateReceipt: true }); f.calls.push('school_write'); throw new Error('synthetic lost response'); };
  await f.service.submit(owner, course, assignment, key, input(), f.validate); await settleWork(f);
  assert.equal(f.value()?.state, 'needs_confirmation'); assert.equal(f.value()?.errorCode, 'RESULT_UNCONFIRMED');
  assert.equal(f.calls.filter(value => value === 'school_write').length, 1);
  const result = await f.service.reconcile(owner, course, assignment, operationId, f.validate);
  assert.equal(result.state, 'confirmed'); assert.equal(f.calls.filter(value => value === 'school_write').length, 1); assert.equal(f.calls.includes('school_reconcile'), true);
});

test('uncertain school upload without a write receipt stays unresolved without a repeated submission', async () => {
  const f = fixture();
  f.school.submit = async (_o, _c, _a, _g, _i, _f, _v, beforeUpload) => { await beforeUpload(); f.calls.push('school_upload'); throw new Error('synthetic upload disconnect'); };
  await f.service.submit(owner, course, assignment, key, { ...input(), submissionType: 'online_upload', text: undefined, uploadIds: [uploadId] }, f.validate); await settleWork(f);
  assert.equal(f.value()?.state, 'needs_confirmation'); assert.equal(f.calls.includes('release:1'), true);
  const result = await f.service.reconcile(owner, course, assignment, operationId, f.validate);
  assert.equal(result.state, 'needs_confirmation'); assert.equal(f.calls.includes('school_reconcile'), false); assert.equal(f.calls.filter(value => value === 'school_upload').length, 1);
  assert.equal(result.reconciliationAvailable, true);
});

test('fresh school read capability is available even without receipt, preserving legacy outcome', () => {
  const original = { ...stored(), state: 'needs_confirmation' as const };
  assert.equal(publicOperation(original).reconciliationAvailable, true);
  assert.equal(publicOperation({ ...original, privateReceipt: { secret: 'synthetic receipt' }, reconciliationAvailable: false }).reconciliationAvailable, true);
  assert.equal(publicOperation({ ...original, privateReceipt: null, reconciliationAvailable: true }).reconciliationAvailable, true);
  const { privateReceipt: _private, input: _input, owner: _owner, generation: _generation, workerToken: _token, leaseExpiresAt: _lease, ...legacy } = original;
  assert.equal(publicOperation(legacy).reconciliationAvailable, true);
  assert.equal(publicOperation({ ...legacy, reconciliationAvailable: true }).reconciliationAvailable, true);
  assert.equal(original.state, 'needs_confirmation'); assert.equal(original.privateReceipt, null);
  assert.doesNotMatch(JSON.stringify(publicOperation({ ...original, privateReceipt: { secret: 'synthetic receipt' } })), /secret|synthetic receipt|privateReceipt|workerToken|generation|owner/);
});

test('durable receipt permits read-only reconciliation and successful result clears capability', async () => {
  const f = fixture(); f.setValue({ ...stored(), state: 'needs_confirmation', privateReceipt: { syntheticPrivateReceipt: true } });
  assert.equal((await f.service.status(owner, course, assignment, operationId)).reconciliationAvailable, true);
  assert.equal((await f.service.options(owner, course, assignment, f.validate, new AbortController().signal)).currentOperation?.reconciliationAvailable, true);
  const result = await f.service.reconcile(owner, course, assignment, operationId, f.validate);
  assert.equal(result.state, 'confirmed'); assert.equal(result.reconciliationAvailable, false);
  assert.equal(f.calls.includes('school_write'), false); assert.equal(f.calls.filter(value => value === 'school_reconcile').length, 1);
});

test('uncertain upload emits one fixed diagnostic and repeated status reads never retransmit or relog', async () => {
  const f = fixture(); f.school.submit = async (_o, _c, _a, _g, _i, _f, _v, beforeUpload) => {
    await beforeUpload(); f.calls.push('school_upload'); throw new SchoolAssignmentWriteError('upload', 'unknown', 'upstream_unavailable');
  };
  await f.service.submit(owner, course, assignment, key, { ...input(), submissionType: 'online_upload', text: undefined, uploadIds: [uploadId] }, f.validate); await settleWork(f);
  assert.deepEqual(f.diagnostics, [{ event: 'assignment_submission_failed', stage: 'upload', outcome: 'unknown', code: 'upstream_unavailable', mayHaveWritten: true, uploadStep:null, finalSubmissionMayHaveWritten:false, operationId }]);
  for (let i = 0; i < 2; i++) await f.service.reconcile(owner, course, assignment, operationId, f.validate);
  assert.equal(f.diagnostics.length, 1); assert.equal(f.calls.filter(value => value === 'school_upload').length, 1);
  assert.equal(f.value()?.state, 'needs_confirmation'); assert.equal(f.value()?.privateReceipt, null);
});

test('observability failure cannot alter a rejected result or create a second school write', async () => {
  const f = fixture(); f.school.submit = async (_o, _c, _a, _g, _i, _f, _v, _upload, beforeWrite) => {
    await beforeWrite({ syntheticPrivateReceipt: true }); f.calls.push('school_write'); throw new SchoolAssignmentWriteError('submit', 'rejected', 'authentication_required');
  };
  const service = new AssignmentSubmissionService(f.repository, f.school, () => { throw new Error('synthetic log failure'); });
  await service.submit(owner, course, assignment, key, input(), f.validate); await settleWork(f);
  assert.equal(f.value()?.state, 'rejected'); assert.equal(f.value()?.errorCode, 'AUTH_REQUIRED'); assert.equal(f.calls.filter(value => value === 'school_write').length, 1);
});

test('failed explicit result lookup logs only read context and leaves exact receipt unresolved', async () => {
  const f = fixture(); f.setValue({ ...stored(), state: 'needs_confirmation', privateReceipt: { syntheticPrivateReceipt: true } });
  f.school.reconcile = async () => { throw new AppError(401, 'SCHOOL_AUTH_REQUIRED', 'private'); };
  const result = await f.service.reconcile(owner, course, assignment, operationId, f.validate);
  assert.equal(result.state, 'needs_confirmation'); assert.equal(result.reconciliationAvailable, true); assert.equal(f.calls.includes('school_write'), false);
  assert.deepEqual(f.diagnostics, [{ event: 'assignment_submission_failed', stage: 'reconcile', outcome: 'unknown', code: 'SCHOOL_AUTH_REQUIRED', mayHaveWritten: false, uploadStep:null, finalSubmissionMayHaveWritten:null, operationId }]);
});

test('explicit school rejection does not become an uncertain success after a sending checkpoint', async () => {
  const f = fixture();
  f.school.submit = async (_o, _c, _a, _g, _i, _f, _v, _u, beforeWrite) => { await beforeWrite({ syntheticPrivateReceipt: true }); throw Object.assign(new Error('synthetic rejection'), { outcome: 'rejected' }); };
  await f.service.submit(owner, course, assignment, key, input(), f.validate); await settleWork(f);
  assert.equal(f.value()?.state, 'rejected'); assert.equal(f.value()?.receipt, null);
});

test('a failed durable pre-write checkpoint prevents the school write', async () => {
  const f = fixture(); const original = f.repository.save;
  f.repository.save = async (...args) => { if (args[3] === 'sending') throw new Error('synthetic checkpoint failure'); return original(...args); };
  await f.service.submit(owner, course, assignment, key, input(), f.validate); await settleWork(f);
  assert.equal(f.calls.includes('school_write'), false); assert.equal(f.value()?.state, 'rejected');
});

test('reconcile rejects still-running work and retains uncertainty when fresh lookup fails', async () => {
  const f = fixture(); f.setValue({ ...stored(), state: 'sending' });
  await assert.rejects(f.service.reconcile(owner, course, assignment, operationId, f.validate), { code: 'SUBMISSION_BUSY' });
  f.setValue({ ...stored(), state: 'needs_confirmation', privateReceipt: { syntheticPrivateReceipt: true } });
  f.school.reconcile = async () => { throw new Error('synthetic lookup failure'); };
  const result = await f.service.reconcile(owner, course, assignment, operationId, f.validate);
  assert.equal(result.state, 'needs_confirmation'); assert.equal(result.errorCode, null); assert.equal(f.calls.includes('school_write'), false);
});

for (const afterWrite of [false, true]) {
  test(`shutdown aborts accepted work ${afterWrite ? 'after' : 'before'} the school write and rejects new submissions`, async () => {
    const f = fixture(), entered = gate();
    let workSignal: AbortSignal | undefined;
    f.school.submit = async (_o, _c, _a, _g, _i, _f, validate, _upload, beforeWrite, signal) => {
      workSignal = signal;
      await validate(); signal.throwIfAborted();
      if (afterWrite) { await beforeWrite({ syntheticPrivateReceipt: true }); signal.throwIfAborted(); f.calls.push('school_write'); }
      entered.release();
      await new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
      signal.throwIfAborted();
      throw new Error('synthetic work must not continue after shutdown');
    };
    await f.service.submit(owner, course, assignment, key, input(), f.validate);
    await entered.promise;
    await f.service.close();
    await assert.rejects(f.service.submit(owner, course, assignment, key, input(), f.validate), { code: 'SERVICE_RESTARTING' });
    assert.equal(workSignal?.aborted, true);
    assert.equal(f.value()?.state, afterWrite ? 'needs_confirmation' : 'rejected');
    assert.equal(f.value()?.receipt, null);
    assert.equal(f.calls.filter(value => value === 'school_write').length, afterWrite ? 1 : 0);
    assert.equal(f.calls.includes('release:0'), true);
  });
}

test('current operation recovery forwards the exact idempotency key without a school request', async () => {
  const f = fixture();
  f.repository.current = async (o, c, a, exactKey) => { assert.deepEqual([o, c, a, exactKey], [owner, course, assignment, key]); return null; };
  assert.equal(await f.service.current(owner, course, assignment, key), null);
  assert.deepEqual(f.calls, ['cleanup']);
});

test('invalid current session blocks submission before idempotency lookup or school access', async () => {
  const f = fixture();
  await assert.rejects(f.service.submit(owner, course, assignment, key, input(), async () => { throw new AppError(401, 'AUTH_REQUIRED', 'synthetic'); }), { code: 'AUTH_REQUIRED' });
  assert.deepEqual(f.calls, []);
});

test('repeated shutdown hooks reuse one bounded drain even when accepted school work ignores abort', async t => {
  const f = fixture(), entered = gate(), wait = gate(), native = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => native(fn, ms === 7000 ? 20 : ms, ...args));
  f.school.submit = async (_o, _c, _a, _g, _i, _f, _v, _u, _w, signal) => { entered.release(); await wait.promise; signal.throwIfAborted(); throw new Error('unreachable'); };
  await f.service.submit(owner, course, assignment, key, input(), f.validate); await entered.promise;
  const first = f.service.close(), second = f.service.close(); assert.equal(first, second); await first;
  assert.equal(f.service.close(), first); await second;
  wait.release(); await settleWork(f); assert.equal(f.value()?.state, 'rejected'); assert.equal(f.calls.includes('school_write'), false);
});

test('receipt-less recheck reads fresh own school submission without attributing an external upload or changing old outcome',async()=>{
 const f=fixture(),old={...stored(),state:'needs_confirmation' as const,errorCode:'RESULT_UNCONFIRMED',executionProtocol:null};f.setValue(old);
 const before={state:old.state,errorCode:old.errorCode,updatedAt:old.updatedAt,receipt:old.receipt};
 const result=await f.service.reconcile(owner,course,assignment,operationId,f.validate);
 assert.deepEqual({state:result.state,errorCode:result.errorCode,updatedAt:result.updatedAt,receipt:result.receipt},before);
 assert.equal(result.recovery?.schoolObservation?.workflowState,'submitted');assert.equal(result.recovery?.schoolObservation?.attribution,'unattributed');assert.equal(result.recovery?.releaseAvailable,true);
 assert.equal(f.calls.filter(x=>x==='school_observe').length,1);assert.equal(f.calls.includes('school_reconcile'),false);assert.equal(f.calls.includes('release_operation'),false);assert.equal(f.calls.includes('school_write'),false);
});
test('fresh school authentication failure surfaces instead of returning a successful no-op recheck',async()=>{
 const f=fixture();f.setValue({...stored(),state:'needs_confirmation',errorCode:'RESULT_UNCONFIRMED'});f.school.observe=async()=>{throw new AppError(401,'SCHOOL_AUTH_REQUIRED','synthetic');};
 await assert.rejects(f.service.reconcile(owner,course,assignment,operationId,f.validate),{code:'SCHOOL_AUTH_REQUIRED'});
 assert.equal(f.calls.includes('record_observation'),false);assert.equal(f.calls.includes('release_confirmation'),true);assert.equal(f.value()?.state,'needs_confirmation');
});
test('safe release performs another own school read and keeps original uncertain history; repeated release cannot start anything',async()=>{
 const f=fixture();f.setValue({...stored(),state:'needs_confirmation',errorCode:'RESULT_UNCONFIRMED',executionProtocol:null});const checked=await f.service.reconcile(owner,course,assignment,operationId,f.validate),at=checked.recovery!.schoolObservation!.observedAt;
 const originalTime=f.value()!.updatedAt,authority={sessionHash:'synthetic-session',csrfToken:'synthetic-csrf'};
 const result=await f.service.release(owner,course,assignment,operationId,at,f.validate,authority);
 assert.equal(result.state,'needs_confirmation');assert.equal(result.errorCode,'RESULT_UNCONFIRMED');assert.equal(result.updatedAt,originalTime);assert.equal(result.receipt,null);assert.equal(result.recovery?.release?.kind,'school_submission_present');assert.equal(result.reconciliationAvailable,false);
 const again=await f.service.release(owner,course,assignment,operationId,at,f.validate,authority);assert.deepEqual(again,result);
 assert.equal(f.calls.filter(x=>x==='school_observe').length,2);assert.equal(f.calls.filter(x=>x==='release_operation').length,1);assert.equal(f.calls.includes('create'),false);assert.equal(f.calls.includes('school_write'),false);
});
test('stale observation CAS rejects release before any new school access',async()=>{
 const f=fixture();f.setValue({...stored(),state:'needs_confirmation'});
 await assert.rejects(f.service.release(owner,course,assignment,operationId,new Date().toISOString(),f.validate,{sessionHash:'s',csrfToken:'c'}),{code:'RECOVERY_CHANGED'});
 assert.equal(f.calls.includes('claim_confirmation'),false);assert.equal(f.calls.includes('school_observe'),false);
});
test('recovery availability rejects legacy absence, active leases, pending final writes, expired reads and incomplete school states',()=>{
 const now=Date.now(),observation={workflowState:'unsubmitted' as const,attempt:null,submittedAt:null,observedAt:new Date(now).toISOString(),attribution:'unattributed' as const};
 const base={...stored(),state:'needs_confirmation' as const,schoolObservation:observation,executionFinishedAt:new Date(now).toISOString()};
 assert.equal(canRelease(base,now),true);
 for(const patch of [{executionProtocol:null},{executionFinishedAt:null},{writeStartedAt:new Date(now).toISOString()},{privateReceipt:{synthetic:'receipt'}},{leaseExpiresAt:new Date(now+1000).toISOString()},{schoolObservation:{...observation,observedAt:new Date(now-300001).toISOString()}},{schoolObservation:{...observation,workflowState:'unknown' as const}},{release:{kind:'upload_failed_before_submit' as const,releasedAt:new Date(now).toISOString()}}])assert.equal(canRelease({...base,...patch},now),false);
 for(const workflowState of ['submitted','graded','pending_review'] as const){const present={...base,executionProtocol:null,executionFinishedAt:null,schoolObservation:{...observation,workflowState,attempt:1,submittedAt:new Date(now).toISOString()}};assert.equal(canRelease(present,now),true);assert.equal(canRelease({...present,schoolObservation:{...present.schoolObservation,attempt:null}},now),false);}
});
test('released uncertain operation no longer blocks fresh submission options but remains visible as history',async()=>{
 const f=fixture();f.setValue({...stored(),state:'needs_confirmation',release:{kind:'upload_failed_before_submit',releasedAt:new Date().toISOString()}});
 const result=await f.service.options(owner,course,assignment,f.validate,AbortSignal.timeout(1000));assert.ok(result.currentOperation?.recovery?.release);assert.equal(result.featureSupport.assignment_submission.permissions.write,true);assert.equal(f.calls.includes('create'),false);
});
