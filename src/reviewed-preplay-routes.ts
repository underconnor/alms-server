import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError, notFound, unavailable } from './errors.js';
import { publicJob } from './domain.js';
import { hashToken, type Store } from './store.js';
import type { SchoolProvider } from './provider.js';
import { requirePlaybackClient } from './playback-client-contract.js';
import { boundedWorkerOperation, WorkerDeadlineError } from './worker-bounds.js';
import { playbackIsReady, type PlaybackReadinessReader } from './playback-worker-readiness.js';
import { currentContinuationGeneration } from './playback-auth-wait.js';
import { inspectPlaybackAdmission } from './playback-authority.js';
import { publicVerifiedSchoolResult } from './job-verification.js';

const empty = z.object({}).strict();
const inputSchema = z.object({ expectedVersion: z.iso.datetime({ offset: true }), startConsentId: z.uuid() }).strict();
const unconfirmed = () => new AppError(503, 'PLAYBACK_REVIEWED_PREPLAY_UNCONFIRMED', '접수 결과를 확인하지 못했습니다. 원래 요청 키로 상태를 확인해 주세요.');
export const reviewedPreplayRequestHash = (originalJobId: string, input: z.infer<typeof inputSchema>) =>
  hashToken(JSON.stringify({ operation: 'retry_reviewed_preplay', originalJobId,
    expectedVersion: input.expectedVersion, startConsentId: input.startConsentId }));

/** Only independently reviewed historical pre-play failures may obtain a new child.
 * The review is distinct from execution termination proof and school report results. */
export function registerReviewedPreplayRoutes(app: FastifyInstance, store: Store, provider: SchoolProvider,
  authenticate: (request: FastifyRequest) => Promise<void>, key: Buffer | undefined, readiness?: PlaybackReadinessReader) {
  const requests = new WeakMap<FastifyRequest, { signal: AbortSignal; clean: () => void }>();
  const active = new Map<string, symbol>();
  const clean = (request: FastifyRequest) => { requests.get(request)?.clean(); requests.delete(request); };
  const auth = (request: FastifyRequest) => ({ almsTokenHash: request.session!.tokenHash,
    csrfToken: request.session!.csrfToken, clientId: request.session!.clientId ?? null });
  const response = (result: { originalJob: Parameters<typeof publicJob>[0]; job: Parameters<typeof publicJob>[0] }) =>
    ({ originalJob: publicJob(result.originalJob), job: publicJob(result.job), retried: true as const });

  app.get('/v1/jobs/:id/retry-reviewed-preplay/:requestKey', {
    preHandler: async request => boundedWorkerOperation(() => authenticate(request), { timeoutMs: 5000 }),
  }, async request => {
    empty.parse(request.query);
    const { id, requestKey } = z.object({ id: z.uuid(), requestKey: z.uuid() }).strict().parse(request.params);
    requirePlaybackClient(request, true);
    if (!store.findReviewedPreplayRetry) throw unavailable('PLAYBACK_REVIEWED_PREPLAY_UNAVAILABLE');
    const result = await store.findReviewedPreplayRetry(request.session!.user.id, id, requestKey, auth(request), { timeoutMs: 5000 });
    if (!result) throw notFound();
    return response(result);
  });

  app.post('/v1/jobs/:id/retry-reviewed-preplay', {
    onRequest: async (request, reply) => {
      const controller = new AbortController(), abort = () => controller.abort(new WorkerDeadlineError());
      const timer = setTimeout(abort, 90_000);
      request.raw.once('aborted', abort); reply.raw.once('close', abort);
      requests.set(request, { signal: controller.signal, clean: () => {
        clearTimeout(timer); request.raw.off('aborted', abort); reply.raw.off('close', abort);
      } });
    },
    preHandler: async request => {
      const signal = requests.get(request)!.signal;
      try { await boundedWorkerOperation(() => authenticate(request), { signal, timeoutMs: 5000 }); }
      catch (error) { if (signal.aborted || error instanceof WorkerDeadlineError) throw unconfirmed(); throw error; }
    },
    onResponse: async request => clean(request), onError: async request => clean(request),
  }, async (request, reply) => {
    empty.parse(request.query);
    const { id } = z.object({ id: z.uuid() }).strict().parse(request.params);
    const input = inputSchema.parse(request.body), idempotencyKey = z.uuid().parse(request.headers['idempotency-key']);
    requirePlaybackClient(request, true);
    const owner = request.session!.user.id, authorization = auth(request), signal = requests.get(request)!.signal;
    const requestHash = reviewedPreplayRequestHash(id, input);
    let writeStarted = false, flight: { key: string; token: symbol } | undefined;
    const release = () => { if (flight && active.get(flight.key) === flight.token) active.delete(flight.key); };
    try {
      const result = await boundedWorkerOperation(async current => {
        if (!store.findReviewedPreplayRetry || !store.getReviewedPreplayEligibility || !store.retryReviewedPreplay)
          throw unavailable('PLAYBACK_REVIEWED_PREPLAY_UNAVAILABLE');
        const operation = { signal: current, timeoutMs: 5000 };
        const validate = async () => {
          const session = await boundedWorkerOperation(() => store.getSession(authorization.almsTokenHash), operation);
          if (!session || session.user.id !== owner || session.csrfToken !== authorization.csrfToken
            || (session.clientId ?? null) !== authorization.clientId) throw new AppError(401, 'AUTH_REQUIRED', '다시 로그인해 주세요.');
          current.throwIfAborted();
        };
        await validate();
        const existing = await store.findReviewedPreplayRetry(owner, id, idempotencyKey, authorization, operation, requestHash);
        await validate();
        if (existing) return existing;
        const eligibility = await store.getReviewedPreplayEligibility(owner, id, authorization, operation);
        if (!eligibility) throw notFound();
        if (eligibility.retriedAsJobId) throw new AppError(409, 'PLAYBACK_REVIEWED_PREPLAY_ALREADY_RETRIED', '이미 새 수강 요청이 접수됐습니다. 원래 요청 키로 확인해 주세요.');
        if (eligibility.version !== input.expectedVersion) throw new AppError(409, 'JOB_CHANGED', '이전 요청 상태가 바뀌었습니다. 다시 확인해 주세요.');
        if (!eligibility.eligible) throw new AppError(409, 'PLAYBACK_REVIEWED_PREPLAY_INELIGIBLE', '시작 전 중단이 검토된 요청만 새로 접수할 수 있습니다.');
        const original = await boundedWorkerOperation(() => store.getJob(owner, id), operation);
        if (!original || original.userId !== owner || original.id !== id) throw notFound();
        if (!provider.capabilities.playback || !provider.authorizePlayback || !provider.learningStatus)
          throw unavailable('PLAYBACK_REVIEWED_PREPLAY_UNAVAILABLE');
        const generation = await currentContinuationGeneration(store, key, owner);
        if (!generation) throw new AppError(401, 'SCHOOL_AUTH_REQUIRED', '학교 인증을 갱신한 뒤 다시 확인해 주세요.');
        if (generation === original.acceptedGeneration)
          throw new AppError(409, 'PLAYBACK_REAUTHENTICATION_REQUIRED', '학교 인증을 갱신한 뒤 새 수강을 접수해 주세요.');
        const flightKey = owner + ':' + id;
        if (active.has(flightKey)) throw new AppError(409, 'PLAYBACK_REVIEWED_PREPLAY_BUSY', '접수 상태를 확인하고 있습니다. 원래 요청 키로 확인해 주세요.');
        flight = { key: flightKey, token: Symbol('reviewed-preplay') }; active.set(flightKey, flight.token);
        try {
          if (!await playbackIsReady(readiness, current)) throw unavailable('PLAYBACK_UNAVAILABLE');
          const target = { courseId: original.courseId, lectureId: original.lectureId };
          const rawSchool = await provider.learningStatus({ userId: owner }, target, current);
          await validate();
          await provider.refreshLearningStatus?.({ userId: owner }, target, rawSchool, { signal: current, validate });
          const schoolResult = publicVerifiedSchoolResult(rawSchool);
          if (schoolResult.evidence?.completed === true) throw new AppError(409, 'PLAYBACK_ALREADY_COMPLETED', '학교에서 이미 완료한 영상은 다시 자동수강하지 않습니다.');
          if (schoolResult.evidence?.completed !== false)
            throw new AppError(409, 'PLAYBACK_REVIEWED_PREPLAY_STATUS_UNKNOWN', '학교 완료 여부를 확인한 뒤 새 수강을 접수해 주세요.');
          await validate();
          const admission = await provider.authorizePlayback({ userId: owner }, target, { signal: current, validate });
          if (inspectPlaybackAdmission(admission, { userId: owner, ...target }).generation !== generation)
            throw new AppError(409, 'PLAYBACK_AUTHORITY_CHANGED', '학교 인증이 바뀌었습니다. 다시 확인해 주세요.');
          await validate();
          if (!await playbackIsReady(readiness, current)) throw unavailable('PLAYBACK_UNAVAILABLE');
          current.throwIfAborted(); writeStarted = true;
          return store.retryReviewedPreplay(owner, id, { ...input, idempotencyKey, requestHash },
            { ...authorization, admission, schoolResult }, operation);
        } finally { release(); }
      }, { signal, timeoutMs: 90_000 });
      return reply.code(202).send(response(result));
    } catch (error) {
      if (signal.aborted || error instanceof WorkerDeadlineError || writeStarted && !(error instanceof AppError)) throw unconfirmed();
      throw error;
    } finally { release(); clean(request); }
  });
}
