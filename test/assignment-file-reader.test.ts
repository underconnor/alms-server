import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { LearningxClient } from '@alms/ssu-api';
import { createLearningxReader } from '../src/school-reader.js';
import { encryptSchoolSession } from '../src/crypto.js';
import { AppError } from '../src/errors.js';
import { withSchoolSessionLock } from '../src/school-session-lock.js';
import { assignmentFixture } from './helpers/assignment-fixture.js';
const options = () => ({ signal: new AbortController().signal, validate: async () => {} });
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
function fixture(hooks: { bytes?: () => Promise<void>; afterCas?: () => void } = {}) {
  const key = randomBytes(32), states = new Map<string, string>();
  const replace = (owner: string) => states.set(owner, encryptSchoolSession({ version: 1, generation: randomUUID(), identity: { studentId: '90000001' }, jar: {} }, key, owner, 'ssu'));
  replace('a'); replace('b'); let details = 0, downloads = 0, catalogs = 0, proof = true, bytes = Buffer.from('%PDF-abc');
  const reader = createLearningxReader({ getEncryptedSchoolSession: async owner => states.get(owner) ?? null,
    replaceEncryptedSchoolSession: async (owner, _provider, before, after) => { if (states.get(owner) !== before) return false; states.set(owner, after); hooks.afterCas?.(); return true; } }, key,
    async () => ({ client: {
      terms: async () => [{ id: '1', name: '합성 학기', default: true }],
      courses: async () => { catalogs++; return [{ id: '10', name: '합성 강좌', termId: '1' }]; },
      assignmentDetail: async () => { details++; const value = assignmentFixture(); value.submission!.attachments![0] = { id: '7', fileName: '답안.pdf', contentType: 'application/pdf', sizeBytes: 8, downloadAvailable: proof }; return value; },
      assignmentAttachment: async () => { downloads++; await hooks.bytes?.(); return { fileId: '7', fileName: '답안.pdf', contentType: 'application/pdf', bytes }; },
    } as unknown as LearningxClient, serialize: async () => ({}) }), undefined, undefined, undefined, null);
  return { reader, replace, states, proof: (value: boolean) => { proof = value; }, bytes: (value: Buffer) => { bytes = value; }, counts: () => ({ details, downloads, catalogs }) };
}
test('cached assignment bytes still require fresh own metadata, isolate owner/generation and explicit refresh', async () => {
  const f = fixture();
  const first = await f.reader.readAssignmentFile!('a', '10', '90', '7', options());
  const second = await f.reader.readAssignmentFile!('a', '10', '90', '7', options());
  assert.equal(first.bytes, second.bytes); assert.deepEqual(f.counts(), { details: 2, downloads: 1, catalogs: 1 });
  await f.reader.readAssignmentFile!('b', '10', '90', '7', options()); f.replace('a'); await f.reader.readAssignmentFile!('a', '10', '90', '7', options());
  assert.equal(f.counts().downloads, 3);
  await f.reader.readAssignmentFile!('a', '10', '90', '7', { ...options(), refresh: true }); assert.equal(f.counts().downloads, 4);
});
test('removed or unrelated file association fails before bytes, even if an earlier download is cached', async () => {
  const f = fixture(); await f.reader.readAssignmentFile!('a', '10', '90', '7', options()); f.proof(false);
  await assert.rejects(f.reader.readAssignmentFile!('a', '10', '90', '7', options()), { statusCode: 404 });
  f.proof(true); await assert.rejects(f.reader.readAssignmentFile!('a', '10', '90', '8', options()), { statusCode: 404 });
  assert.equal(f.counts().downloads, 1);
  f.bytes(Buffer.from('%PDF-too-many'));
  await assert.rejects(f.reader.readAssignmentFile!('a', '10', '90', '7', { ...options(), refresh: true }), { code: 'ASSIGNMENT_FILE_UNAVAILABLE' });
});
test('an unsupported file read retains the all-term read catalog while the dashboard keeps its default catalog separate', async () => {
  const f = fixture(); await f.reader.readAssignmentFile!('a', '10', '90', '7', options());
  await assert.rejects(f.reader.readAssignmentFile!('a', '10', '90', '8', options()), { statusCode: 404 });
  const count = f.counts().catalogs;
  await f.reader.readAssignmentFile!('a', '10', '90', '7', options()); assert.equal(f.counts().catalogs, count);
  const catalog = await f.reader.catalog('a'); assert.equal(catalog.courses[0]!.id, '10'); assert.equal(f.counts().catalogs, count + 1);
  await f.reader.catalog('a'); assert.equal(f.counts().catalogs, count + 1);
});
test('new login, logout and ALMS revocation during download withhold bytes and preserve the newer session', async () => {
  for (const mode of ['login', 'logout', 'alms']) {
    let active = true; const wait = gate(), f = fixture({ bytes: () => wait.promise });
    const reading = f.reader.readAssignmentFile!('a', '10', '90', '7', { ...options(), validate: async () => { if (!active) throw new AppError(401, 'AUTH_REQUIRED', '합성'); } });
    await flush(); if (mode === 'login') f.replace('a'); if (mode === 'logout') f.states.delete('a'); if (mode === 'alms') active = false;
    const state = f.states.get('a'); wait.release(); await assert.rejects(reading, error => error instanceof AppError && [401, 409].includes(error.statusCode));
    if (mode !== 'alms') assert.equal(f.states.get('a'), state);
  }
});
test('cancelled queued file request starts no school request and cancellation after CAS cannot publish bytes', async () => {
  const wait = gate(), f = fixture(), controller = new AbortController(), holding = withSchoolSessionLock('a', () => wait.promise);
  const reading = f.reader.readAssignmentFile!('a', '10', '90', '7', { ...options(), signal: controller.signal }); await flush();
  const rejection = assert.rejects(reading, { code: 'ASSIGNMENTS_UNAVAILABLE' }); controller.abort(); await rejection; wait.release(); await holding; await flush();
  assert.deepEqual(f.counts(), { details: 0, downloads: 0, catalogs: 0 });
  const after = new AbortController(), other = fixture({ afterCas: () => after.abort() });
  await assert.rejects(other.reader.readAssignmentFile!('a', '10', '90', '7', { ...options(), signal: after.signal }));
});
