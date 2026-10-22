import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { SchoolError, type LearningxClient } from '@alms/ssu-api';
import { createLearningxReader } from '../src/school-reader.js';
import { createLearningxReads } from '../src/school-read.js';
import { encryptSchoolSession } from '../src/crypto.js';
import { AppError } from '../src/errors.js';
import { withSchoolSessionLock } from '../src/school-session-lock.js';
import { schoolHistoryFixture } from './helpers/assignment-history-fixture.js';
import { assignmentFixture } from './helpers/assignment-fixture.js';
const options = () => ({ signal: new AbortController().signal, validate: async () => {} });
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
function fixture(hooks: { history?: () => Promise<void>; bytes?: () => Promise<void>; afterCas?: () => void } = {}) {
  const key = randomBytes(32), states = new Map<string, string>();
  const replace = (owner: string) => states.set(owner, encryptSchoolSession({ version: 1, generation: randomUUID(), identity: { studentId: '90000001' }, jar: {} }, key, owner, 'ssu'));
  replace('a'); replace('b'); let owned = true, catalogs = 0, historyReads = 0, downloads = 0, latestDownloads = 0;
  const history = schoolHistoryFixture(), downloadsTo: string[] = [];
  const reader = createLearningxReader({ getEncryptedSchoolSession: async owner => states.get(owner) ?? null,
    replaceEncryptedSchoolSession: async (owner, _provider, previous, next) => { if (states.get(owner) !== previous) return false; states.set(owner, next); hooks.afterCas?.(); return true; } }, key,
    async () => ({ client: {
      terms: async () => [{ id: '1', name: '합성 현재 학기', default: true }, { id: '2', name: '합성 과거 학기', default: false }],
      courses: async (terms: string[]) => { catalogs++; return owned ? [{ id: '10', name: '합성 강좌', termId: '1' }, ...(terms.includes('2') ? [{ id: '20', name: '합성 과거 강좌', termId: '2' }] : [])] : []; },
      assignmentDetail: async () => { const value = assignmentFixture(); value.submission!.attachments![0] = { ...value.submission!.attachments![0]!, sizeBytes: 8, downloadAvailable: true }; return value; },
      assignmentAttachment: async () => { latestDownloads++; return { fileId: '7', fileName: '합성 이전 답안.pdf', contentType: 'application/pdf', bytes: Buffer.from('%PDF-new') }; },
      assignmentSubmissionHistory: async () => { historyReads++; await hooks.history?.(); return structuredClone(history); },
      assignmentSubmissionHistoryAttachment: async (_course: string, _id: string, attempt: string) => { downloads++; downloadsTo.push(attempt); await hooks.bytes?.();
        return { fileId: '7', fileName: '합성 이전 답안.pdf', contentType: 'application/pdf', bytes: Buffer.from(attempt === history.items[0]!.key ? '%PDF-one' : '%PDF-two') }; },
    } as unknown as LearningxClient, serialize: async () => ({}) }), undefined, undefined, undefined, null);
  return { reader, history, replace, states, downloadsTo, setOwned: (value: boolean) => { owned = value; }, counts: () => ({ historyReads, downloads, latestDownloads, catalogs }) };
}
test('history is lazy, cached for thirty seconds, refreshable and scoped to owner/generation/current enrollment', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = fixture(); assert.equal(f.counts().historyReads, 0);
  const first = await f.reader.readAssignmentHistory!('a', '10', '90', options());
  const cached = await f.reader.readAssignmentHistory!('a', '10', '90', options());
  assert.deepEqual(first, cached); assert.deepEqual(f.counts(), { historyReads: 1, downloads: 0, latestDownloads: 0, catalogs: 1 });
  now += 20_000; await f.reader.readAssignmentHistory!('a', '10', '90', options());
  now += 11_000; await f.reader.readAssignmentHistory!('a', '10', '90', options()); assert.equal(f.counts().historyReads, 2);
  await f.reader.readAssignmentHistory!('a', '10', '90', { ...options(), refresh: true }); assert.equal(f.counts().historyReads, 3);
  const other = await f.reader.readAssignmentHistory!('b', '10', '90', options()); assert.notEqual(other.items![0]!.key, first.items![0]!.key);
  f.replace('a'); const next = await f.reader.readAssignmentHistory!('a', '10', '90', options()); assert.notEqual(next.items![0]!.key, first.items![0]!.key);
  f.setOwned(false); await assert.rejects(f.reader.readAssignmentHistory!('a', '10', '90', { ...options(), refresh: true }), { statusCode: 404 });
  await assert.rejects(f.reader.readAssignmentHistory!('a', '20', '90', { ...options(), refresh: true }), { statusCode: 404 });
});
test('history projection stays separate from latest/operation and preserves missing/null without fabricated attempts', async () => {
  const f = fixture(), provider = createLearningxReads(f.reader);
  for (const state of ['missing', 'null'] as const) {
    Object.assign(f.history, { state, items: null });
    const result = await provider.assignmentHistory!({ userId: 'a' }, '10', '90', { ...options(), refresh: true });
    assert.equal(result.state, state); assert.equal(result.items, null); assert.equal(result.coverage, 'school_returned');
  }
  assert.equal(f.counts().downloads, 0); assert.equal(f.counts().latestDownloads, 0);
});
test('selected historical bytes require fresh own association on every hit and isolate attempts from latest bytes', async () => {
  const f = fixture(); const second = f.history.items[1]!;
  Object.assign(second, { submissionType: 'online_upload', content: { text: { state: 'not_applicable', value: null }, url: { state: 'not_applicable', value: null } }, attachments: structuredClone(f.history.items[0]!.attachments) });
  const history = await f.reader.readAssignmentHistory!('a', '10', '90', options());
  const firstKey = history.items![0]!.key, secondKey = history.items![1]!.key;
  const first = await f.reader.readAssignmentHistoryFile!('a', '10', '90', firstKey, '7', options());
  const cached = await f.reader.readAssignmentHistoryFile!('a', '10', '90', firstKey, '7', options());
  assert.equal(first.bytes, cached.bytes); assert.equal(f.counts().downloads, 1); assert.equal(f.counts().historyReads, 3);
  const otherAttempt = await f.reader.readAssignmentHistoryFile!('a', '10', '90', secondKey, '7', options());
  assert.equal(otherAttempt.bytes.toString(), '%PDF-two'); assert.equal(first.bytes.toString(), '%PDF-one'); assert.equal(f.counts().downloads, 2);
  const latest = await f.reader.readAssignmentFile!('a', '10', '90', '7', options()); assert.equal(latest.bytes.toString(), '%PDF-new');
  assert.equal(f.counts().latestDownloads, 1);
  await f.reader.readAssignmentHistoryFile!('a', '10', '90', firstKey, '7', { ...options(), refresh: true }); assert.equal(f.counts().downloads, 3);
  assert.deepEqual(f.downloadsTo, [f.history.items[0]!.key, f.history.items[1]!.key, f.history.items[0]!.key]);
});
test('removed file, changed school attempt, copied owner key and stale generation fail before cached bytes leave', async () => {
  const f = fixture(), history = await f.reader.readAssignmentHistory!('a', '10', '90', options()), handle = history.items![0]!.key;
  await f.reader.readAssignmentHistoryFile!('a', '10', '90', handle, '7', options());
  await assert.rejects(f.reader.readAssignmentHistoryFile!('b', '10', '90', handle, '7', options()), { statusCode: 404 });
  await assert.rejects(f.reader.readAssignmentHistoryFile!('a', '10', '91', handle, '7', options()), { statusCode: 502 });
  await assert.rejects(f.reader.readAssignmentHistoryFile!('a', '10', '90', handle, '8', options()), { statusCode: 404 });
  f.history.items[0]!.attachments![0]!.downloadAvailable = false;
  await assert.rejects(f.reader.readAssignmentHistoryFile!('a', '10', '90', handle, '7', options()), { statusCode: 404 });
  f.history.items[0]!.attachments![0]!.downloadAvailable = true; f.history.items[0]!.key = 'a_' + 'c'.repeat(64);
  await assert.rejects(f.reader.readAssignmentHistoryFile!('a', '10', '90', handle, '7', options()), { statusCode: 404 });
  f.replace('a'); await assert.rejects(f.reader.readAssignmentHistoryFile!('a', '10', '90', handle, '7', options()), { statusCode: 404 });
  assert.equal(f.counts().downloads, 1);
});
test('new school generation, logout and ALMS revocation withhold pending history and file responses', async () => {
  for (const kind of ['history', 'file']) for (const mode of ['login', 'logout', 'alms']) {
    let active = true; const wait = gate(), f = fixture(kind === 'history' ? { history: () => wait.promise } : { bytes: () => wait.promise });
    const ownOptions = { ...options(), validate: async () => { if (!active) throw new AppError(401, 'AUTH_REQUIRED', '합성'); } };
    const reading = kind === 'history' ? f.reader.readAssignmentHistory!('a', '10', '90', ownOptions)
      : (async () => { const history = await f.reader.readAssignmentHistory!('a', '10', '90', options()); return f.reader.readAssignmentHistoryFile!('a', '10', '90', history.items![0]!.key, '7', ownOptions); })();
    await flush(); if (mode === 'login') f.replace('a'); if (mode === 'logout') f.states.delete('a'); if (mode === 'alms') active = false;
    const newer = f.states.get('a'); wait.release();
    await assert.rejects(reading, error => error instanceof AppError && [401, 409].includes(error.statusCode));
    if (mode !== 'alms') assert.equal(f.states.get('a'), newer);
  }
});
test('history queued cancellation starts no school read and post-CAS cancellation withholds the result', async () => {
  const wait = gate(), f = fixture(), controller = new AbortController(), holding = withSchoolSessionLock('a', () => wait.promise);
  const reading = f.reader.readAssignmentHistory!('a', '10', '90', { ...options(), signal: controller.signal }); await flush();
  const rejection = assert.rejects(reading, { code: 'ASSIGNMENTS_UNAVAILABLE' }); controller.abort(); await rejection; wait.release(); await holding; await flush();
  assert.equal(f.counts().historyReads, 0); assert.equal(f.counts().downloads, 0);
  const after = new AbortController(), other = fixture({ afterCas: () => after.abort() });
  await assert.rejects(other.reader.readAssignmentHistory!('a', '10', '90', { ...options(), signal: after.signal }));
});
test('history upstream auth/unsupported/malformed errors are not successful empty history', async () => {
  for (const code of ['authentication_required', 'unsupported', 'unexpected_response'] as const) {
    const f = fixture({ history: async () => { throw new SchoolError(code); } });
    await assert.rejects(f.reader.readAssignmentHistory!('a', '10', '90', options()), error => error instanceof AppError && error.statusCode === (code === 'authentication_required' ? 401 : code === 'unsupported' ? 503 : 502));
  }
});
