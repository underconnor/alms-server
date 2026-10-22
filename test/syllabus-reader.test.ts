import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { LearningxClient } from '@alms/ssu-api';
import { createLearningxReader } from '../src/school-reader.js';
import { createLearningxReads } from '../src/school-read.js';
import { encryptSchoolSession } from '../src/crypto.js';
import { withSchoolSessionLock } from '../src/school-session-lock.js';
import { AppError } from '../src/errors.js';
import { syllabusFixture } from './helpers/syllabus-fixture.js';
import type { SyllabusReadOptions } from '../src/provider.js';
const options = (): SyllabusReadOptions => ({ signal: new AbortController().signal, validate: async () => {} });
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
async function fixture(render?: NonNullable<Parameters<typeof createLearningxReader>[7]>, hooks: { connect?: (signal?: AbortSignal) => Promise<void>; afterGet?: () => Promise<void>; afterReplace?: () => Promise<void> } = {}) {
  const key = randomBytes(32), states = new Map<string, string>();
  const replace = (owner: string) => states.set(owner, encryptSchoolSession({ version: 1, generation: randomUUID(), identity: { studentId: '90000001' }, jar: {} }, key, owner, 'ssu'));
  replace('a'); replace('b');
  let owned = true, rendered = 0, prepared = 0, catalogs = 0, seenSignal: AbortSignal | undefined;
  const client = { terms: async () => [{ id: '9', name: 'Synthetic term', default: true }],
    courses: async () => { catalogs++; return owned ? [{ id: '7001', name: 'Synthetic', termId: '9' }] : []; },
    prepareCourseSyllabusRender: async (_id: string, signal?: AbortSignal) => { prepared++; seenSignal = signal; signal?.throwIfAborted(); return (await syllabusFixture()).plan; },
  } as unknown as LearningxClient;
  const reader = createLearningxReader({ getEncryptedSchoolSession: async owner => { const value = states.get(owner) ?? null; await hooks.afterGet?.(); return value; },
    replaceEncryptedSchoolSession: async (owner, _provider, previous, next) => { if (states.get(owner) !== previous) return false; states.set(owner, next); await hooks.afterReplace?.(); return true; } }, key,
    async (_session, signal) => { await hooks.connect?.(signal); return { client, serialize: async () => ({}), readSyllabusAuthCheck: async () => ({ body: 'jsonpCallback();', contentType: 'text/javascript' }) }; },
    undefined, undefined, undefined, null, async (input, signal) => { rendered++; if (render) return render(input, signal);
      await input.validate(); return { bytes: Buffer.from('%PDF-1.7\nsynthetic\n%%EOF'), pageCount: 1 }; });
  return { reader, states, replace, setOwned: (value: boolean) => { owned = value; }, counts: () => ({ rendered, prepared, catalogs }), signal: () => seenSignal };
}
test('syllabus uses fresh ownership for every cache hit and DTO hides private bytes and launch values', async () => {
  const f = await fixture(), provider = createLearningxReads(f.reader);
  const a = await provider.syllabus!({ userId: 'a' }, '7001', options()) as any;
  const b = await provider.syllabusMaterial!({ userId: 'a' }, '7001', options());
  assert.equal(a.documentAvailable, true); assert.match(a.documentVersion, /^[a-f0-9]{64}$/); assert.equal(a.sourceUrl, null);
  assert.doesNotMatch(JSON.stringify(a), /bytes|UNAME|synthetic|office|launcher|pageCount/);
  assert.ok(b.bytes.length); assert.deepEqual(f.counts(), { rendered: 1, prepared: 1, catalogs: 3 });
  await provider.syllabus!({ userId: 'b' }, '7001', options()); assert.equal(f.counts().rendered, 2);
  f.setOwned(false); await assert.rejects(provider.syllabus!({ userId: 'a' }, '7001', options()), error => error instanceof AppError && error.statusCode === 404);
  assert.equal(f.counts().rendered, 2);
});
test('fresh login, explicit refresh and invalidation each replace private syllabus bytes', async () => {
  const f = await fixture();
  await f.reader.readSyllabus!('a', '7001', options());
  await f.reader.readSyllabus!('a', '7001', { ...options(), refresh: true });
  f.replace('a'); await f.reader.readSyllabus!('a', '7001', options());
  await f.reader.invalidate('a'); await f.reader.readSyllabus!('a', '7001', options());
  assert.equal(f.counts().rendered, 4); assert.ok(f.signal());
});
test('session revocation and generation changes during render withhold documents', async () => {
  for (const reason of ['logout', 'login', 'alms']) {
    const wait = gate(); let session = true;
    const f = await fixture(async input => { await wait.promise; await input.validate(); return { bytes: Buffer.from('%PDF-1.7\nsynthetic\n%%EOF'), pageCount: 1 }; });
    const loading = f.reader.readSyllabus!('a', '7001', { ...options(), validate: async () => { if (!session) throw new AppError(401, 'AUTH_REQUIRED', 'synthetic'); } });
    await flush();
    if (reason === 'logout') f.states.delete('a'); if (reason === 'login') f.replace('a'); if (reason === 'alms') session = false;
    wait.release(); await assert.rejects(loading, error => error instanceof AppError && [401, 409].includes(error.statusCode));
  }
});
test('joined requests fail together when the original caller disconnects and can retry with a fresh plan', async () => {
  const wait = gate(); let calls = 0;
  const f = await fixture(async (input, signal) => { if (++calls === 1) await wait.promise; signal.throwIfAborted(); await input.validate(); return { bytes: Buffer.from('%PDF-1.7\nsynthetic\n%%EOF'), pageCount: 1 }; });
  const controller = new AbortController();
  const first = f.reader.readSyllabus!('a', '7001', { ...options(), signal: controller.signal }); await flush();
  const second = f.reader.readSyllabus!('a', '7001', options()); await flush();
  const a = assert.rejects(first), b = assert.rejects(second); controller.abort(); wait.release(); await Promise.all([a, b]);
  assert.equal(f.signal()?.aborted, true);
  await f.reader.readSyllabus!('a', '7001', options()); assert.equal(calls, 2);
});

test('queued owner lock cancellation returns promptly and starts no school read when the lock later opens', async () => {
  const f = await fixture(), wait = gate(), controller = new AbortController();
  const holding = withSchoolSessionLock('a', () => wait.promise);
  const loading = f.reader.readSyllabus!('a', '7001', { ...options(), signal: controller.signal });
  await flush(); controller.abort(); await assert.rejects(loading);
  assert.equal(f.counts().catalogs, 0); wait.release(); await holding; await flush();
  assert.deepEqual(f.counts(), { rendered: 0, prepared: 0, catalogs: 0 });
});
test('overall 90-second signal reaches initial connection and prevents later catalog calls after timeout', async t => {
  const timeout = AbortSignal.timeout, wait = gate(); let received: AbortSignal | undefined;
  t.mock.method(AbortSignal, 'timeout', (ms: number) => timeout(ms === 90_000 ? 20 : ms));
  const f = await fixture(undefined, { connect: async signal => { received = signal; await wait.promise; } });
  const alive = setTimeout(() => {}, 100);
  try {
    await assert.rejects(f.reader.readSyllabus!('a', '7001', options()));
    assert.equal(received?.aborted, true); assert.equal(f.counts().catalogs, 0);
    wait.release(); await flush(); assert.equal(f.counts().catalogs, 0);
  } finally { clearTimeout(alive); wait.release(); }
});
test('abort after asynchronous generation read or session CAS withholds metadata before render', async () => {
  for (const phase of ['generation', 'cas']) {
    const controller = new AbortController(); let checks = 0;
    const f = await fixture(undefined, phase === 'generation'
      ? { afterGet: async () => { if (++checks === 1) controller.abort(); } }
      : { afterReplace: async () => { controller.abort(); } });
    await assert.rejects(f.reader.readSyllabus!('a', '7001', { ...options(), signal: controller.signal }));
    await flush(); assert.equal(f.counts().rendered, 0); assert.equal(f.counts().prepared, 0);
    if (phase === 'generation') assert.equal(f.counts().catalogs, 0);
  }
});
test('ordinary catalog reads retain the existing connector without a syllabus deadline', async () => {
  const signals: Array<AbortSignal | undefined> = [];
  const f = await fixture(undefined, { connect: async signal => { signals.push(signal); } });
  await f.reader.catalog('a'); assert.deepEqual(signals, [undefined]);
});

for (const replacement of ['refresh', 'new-login'] as const) {
  test(`late old syllabus validation never cancels replacement work after ${replacement}`, async () => {
    const oldChecking = gate(), releaseOld = gate(), newRendering = gate(), releaseNew = gate();
    let renders = 0, validations = 0;
    const f = await fixture(async (input, signal) => {
      if (++renders === 2) { newRendering.release(); await releaseNew.promise; }
      signal.throwIfAborted(); await input.validate();
      return { bytes: Buffer.from('%PDF-1.7\nsynthetic-' + renders + '\n%%EOF'), pageCount: 1 };
    });
    await f.reader.readSyllabus!('a', '7001', options());
    const old = f.reader.readSyllabus!('a', '7001', { ...options(), validate: async () => {
      // Third check is after the cached PDF has resolved, outside the owner lock.
      if (++validations === 3) { oldChecking.release(); await releaseOld.promise; }
    } });
    await oldChecking.promise;
    const oldRejected = assert.rejects(old, error => error instanceof AppError && error.statusCode === 409);
    if (replacement === 'new-login') f.replace('a');
    const next = f.reader.readSyllabus!('a', '7001', { ...options(), refresh: replacement === 'refresh' });
    // Observe rejection immediately so a broken implementation cannot emit an unhandled promise rejection.
    const nextOutcome = next.then(value => ({ value }), error => ({ error }));
    await newRendering.promise;
    releaseOld.release(); await oldRejected;
    releaseNew.release();
    const outcome = await nextOutcome;
    assert.ok('value' in outcome, 'obsolete request must not abort the replacement render');
    const cached = await f.reader.readSyllabus!('a', '7001', options());
    assert.equal(cached.documentVersion, outcome.value.documentVersion);
    assert.equal(renders, 2, 'replacement PDF must remain cached');
  });
}

test('final permission failure still removes its own cached syllabus document', async () => {
  const f = await fixture(); let validations = 0;
  await f.reader.readSyllabus!('a', '7001', options());
  await assert.rejects(f.reader.readSyllabus!('a', '7001', { ...options(), validate: async () => {
    if (++validations === 3) throw new AppError(401, 'AUTH_REQUIRED', 'synthetic');
  } }), error => error instanceof AppError && error.statusCode === 401);
  assert.equal(f.counts().rendered, 1);
  await f.reader.readSyllabus!('a', '7001', options());
  assert.equal(f.counts().rendered, 2, 'a failed final permission check must evict the document it returned');
});
