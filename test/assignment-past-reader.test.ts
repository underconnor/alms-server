import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { LearningxClient } from '@alms/ssu-api';
import { createLearningxReader } from '../src/school-reader.js';
import { createLearningxReads } from '../src/school-read.js';
import { encryptSchoolSession } from '../src/crypto.js';
import type { SchoolReadCache, SchoolCacheScope } from '../src/school-read-cache.js';
import { assignmentFixture, assignmentListFixture } from './helpers/assignment-fixture.js';
import { schoolHistoryFixture } from './helpers/assignment-history-fixture.js';
const options = () => ({ signal: new AbortController().signal, validate: async () => {} });
function fixture() {
  const key = randomBytes(32), owner = 'synthetic-past-owner';
  let state = encryptSchoolSession({ version: 1, generation: randomUUID(), identity: { studentId: '90000001' }, jar: {} }, key, owner, 'ssu');
  let details = 0, lists = 0, histories = 0, downloads = 0;
  const terms = [{ id: '1', name: '2099 현재 학기', default: true }, { id: '2', name: '2098 과거 학기', default: false }];
  const courses = [{ id: '10', name: '합성 현재 강좌', termId: '1' }, { id: '20', name: '합성 과거 강좌', termId: '2', ended: true }];
  const selections: string[][] = [];
  const values = new Map<string, { value: unknown; expiresAt: number }>();
  const durable: SchoolReadCache = {
    get: async <T>(scope: SchoolCacheScope) => { const item = values.get(scope.resource); return item ? { value: structuredClone(item.value) as T, expiresAt: item.expiresAt } : null; },
    put: async (scope, value, ttl) => { values.set(scope.resource, { value: structuredClone(value), expiresAt: Date.now() + ttl }); return true; },
    delete: async (_owner, _provider, resource) => { if (resource) values.delete(resource); else values.clear(); },
  };
  const detail = (course: string) => { const value = assignmentFixture(); value.courseId = course; value.sourceUrl = `https://canvas.ssu.ac.kr/courses/${course}/assignments/90`;
    value.submission!.attachments![0]!.sizeBytes = 8; value.submission!.attachments![0]!.downloadAvailable = true; return value; };
  const reader = () => createLearningxReader({ getEncryptedSchoolSession: async () => state,
    replaceEncryptedSchoolSession: async (_owner, _provider, previous, next) => { if (state !== previous) return false; state = next; return true; } }, key,
    async () => ({ client: {
      terms: async () => terms,
      courses: async (ids: string[]) => { selections.push([...ids]); return courses.filter(course => ids.includes(course.termId)); },
      assignments: async (course: string) => { lists++; const value = assignmentListFixture(); value.courseId = course; value.items = [detail(course)]; return value; },
      assignmentDetail: async (course: string) => { details++; return detail(course); },
      assignmentSubmissionHistory: async (course: string) => { histories++; return { ...schoolHistoryFixture(), courseId: course }; },
      assignmentAttachment: async () => { downloads++; return { fileId: '7', fileName: '합성 답안.pdf', contentType: 'application/pdf', bytes: Buffer.from('%PDF-old') }; },
      assignmentSubmissionHistoryAttachment: async () => { downloads++; return { fileId: '7', fileName: '합성 이전 답안.pdf', contentType: 'application/pdf', bytes: Buffer.from('%PDF-old') }; },
    } as unknown as LearningxClient, serialize: async () => ({}) }), undefined, durable, undefined, null);
  return { reader, owner, selections, values, terms, courses, counts: () => ({ details, lists, histories, downloads }) };
}
test('all five assignment read purposes authorize actual past enrollment and list/detail project catalog course context', async () => {
  const f = fixture(), reader = f.reader(), provider = createLearningxReads(reader);
  const list = await provider.assignments!({ userId: f.owner }, '20', options()), detail = await provider.assignment!({ userId: f.owner }, '20', '90', options());
  const context = { id: '20', title: '합성 과거 강좌', term: '2098 과거 학기', termId: '2', schoolDefaultTerm: false, ended: true };
  assert.deepEqual(list.course, context); assert.deepEqual(detail.course, context); assert.equal(Object.hasOwn(list.items[0]!, 'course'), false);
  assert.deepEqual((await provider.assignment!({ userId: f.owner }, '10', '90', options())).course,
    { id: '10', title: '합성 현재 강좌', term: '2099 현재 학기', termId: '1', schoolDefaultTerm: true, ended: null });
  const history = await provider.assignmentHistory!({ userId: f.owner }, '20', '90', options());
  const file = await provider.assignmentFile!({ userId: f.owner }, '20', '90', '7', options());
  const oldFile = await provider.assignmentHistoryFile!({ userId: f.owner }, '20', '90', history.items![0]!.key, '7', options());
  assert.equal(file.bytes.toString(), '%PDF-old'); assert.equal(oldFile.bytes.toString(), '%PDF-old');
  assert.ok(f.selections.length > 0); f.selections.forEach(ids => assert.deepEqual(ids, ['1', '2']));
  await assert.rejects(provider.assignment!({ userId: f.owner }, '30', '90', options()), { statusCode: 404 });
});
test('list/detail/history cache proofs reject changed term metadata even when course ID and title stay equal', async () => {
  for (const resource of ['assignments:20', 'assignment:20:90', 'assignment-history:20:90'])
    for (const [field, value] of [['term', 'changed'], ['termId', '1'], ['schoolDefaultTerm', true], ['ended', false]] as const) {
      const f = fixture(), first = f.reader();
      const read = (reader: ReturnType<typeof f.reader>) => resource.startsWith('assignments:') ? reader.readAssignments!(f.owner, '20', options())
        : resource.startsWith('assignment-history:') ? reader.readAssignmentHistory!(f.owner, '20', '90', options()) : reader.readAssignment!(f.owner, '20', '90', options());
      await read(first); const item = f.values.get(resource)!, envelope = item.value as { course: Record<string, unknown> }; envelope.course[field] = value;
      const before = f.counts(); await read(f.reader()); const after = f.counts();
      assert.equal(after.lists + after.details + after.histories, before.lists + before.details + before.histories + 1);
    }
});
test('a compatible past list/detail hit retains context through public re-projection and reader restart', async () => {
  const f = fixture(), first = createLearningxReads(f.reader());
  const list = await first.assignments!({ userId: f.owner }, '20', options()), detail = await first.assignment!({ userId: f.owner }, '20', '90', options());
  const before = f.counts(), next = createLearningxReads(f.reader());
  assert.deepEqual(await next.assignments!({ userId: f.owner }, '20', options()), list);
  assert.deepEqual(await next.assignment!({ userId: f.owner }, '20', '90', options()), detail); assert.deepEqual(f.counts(), before);
});
test('assignment reads retain the one-hundred-course bound when reusing a general all-term catalog', async () => {
  const f = fixture(); f.courses.push(...Array.from({ length: 99 }, (_, index) => ({ id: String(index + 100), name: 'Synthetic bounded course', termId: '2' })));
  const reader = f.reader();
  for (const read of [() => reader.readAssignments!(f.owner, '20', options()), () => reader.readAssignment!(f.owner, '20', '90', options()),
    () => reader.readAssignmentHistory!(f.owner, '20', '90', options()), () => reader.readAssignmentFile!(f.owner, '20', '90', '7', options()),
    () => reader.readAssignmentHistoryFile!(f.owner, '20', '90', 'a'.repeat(64), '7', options())])
    await assert.rejects(read(), { statusCode: 503 });
  assert.deepEqual(f.counts(), { details: 0, lists: 0, histories: 0, downloads: 0 });
});
