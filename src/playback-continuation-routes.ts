import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError, notFound, unavailable } from './errors.js';
import { publicJob } from './domain.js';
import { hashToken, type Store } from './store.js';
import type { SchoolProvider } from './provider.js';
import { inspectPlaybackAdmission } from './playback-authority.js';
import { requirePlaybackClient } from './playback-client-contract.js';
import { playbackIsReady, type PlaybackReadinessReader } from './playback-worker-readiness.js';
import { boundedWorkerOperation, WorkerDeadlineError } from './worker-bounds.js';
import { currentContinuationGeneration } from './playback-auth-wait.js';
import { publicVerifiedSchoolResult } from './job-verification.js';

const unconfirmed = () => new AppError(503, 'PLAYBACK_CONTINUATION_UNCONFIRMED', '대기열에서 계속 수강 접수 결과를 확인해 주세요.');
export const playbackContinuationHash = (id: string,startConsentId?:string) => hashToken(JSON.stringify({ operation: 'continue_playback', originalJobId: id,...(startConsentId?{startConsentId}:{}) }));
/** Explicit new admission only. Never a retry of an interrupted/unknown school execution. */
export function registerPlaybackContinuation(app: FastifyInstance, store: Store, provider: SchoolProvider,
  authenticate: (request: FastifyRequest) => Promise<void>, key: Buffer | undefined, readiness?: PlaybackReadinessReader) {
  const requests = new WeakMap<FastifyRequest, { signal: AbortSignal; clean: () => void }>();
  const clean = (request: FastifyRequest) => { requests.get(request)?.clean(); requests.delete(request); };
  const active = new Map<string, symbol>();
  app.post('/v1/jobs/:id/continue', {
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
    const { id } = z.object({ id: z.uuid() }).strict().parse(request.params);
    z.object({}).strict().parse(request.query); const input=z.object({startConsentId:z.uuid().optional()}).strict().parse(request.body);
    const idempotencyKey = z.uuid().parse(request.headers['idempotency-key']);
    requirePlaybackClient(request, true);
    const owner = request.session!.user.id, tokenHash = request.session!.tokenHash, csrfToken = request.session!.csrfToken;
    const clientId = request.session!.clientId ?? null, requestHash = playbackContinuationHash(id,input.startConsentId), signal = requests.get(request)!.signal;
    let writeStarted = false, activeFlight: { key: string; token: symbol } | undefined;
    const releaseFlight = () => { if (activeFlight && active.get(activeFlight.key) === activeFlight.token) active.delete(activeFlight.key); };
    try {
      const result = await boundedWorkerOperation(async current => {
        if (!store.findJobContinuation || !store.continueJob) throw unavailable('PLAYBACK_CONTINUATION_UNAVAILABLE');
        const operation = { signal: current, timeoutMs: 5000 };
        const validate = async () => {
          const session = await boundedWorkerOperation(() => store.getSession(tokenHash), operation);
          if (!session || session.user.id !== owner || session.csrfToken !== csrfToken || (session.clientId ?? null) !== clientId)
            throw new AppError(401, 'AUTH_REQUIRED', '다시 로그인해 주세요.');
          current.throwIfAborted();
        };
        const authorization = { almsTokenHash: tokenHash, csrfToken, clientId };
        await validate();
        const existing = await store.findJobContinuation(owner, id, idempotencyKey, requestHash, authorization, operation);
        await validate(); if (existing) return existing;
        const initial = await boundedWorkerOperation(() => store.getJob(owner, id), operation);
        if (!initial || initial.userId !== owner || initial.id !== id) throw notFound();
        if (initial.authWait?.continuedAsJobId) throw new AppError(409, 'PLAYBACK_ALREADY_CONTINUED', '이미 이어서 수강할 요청이 접수됐습니다. 대기열을 확인해 주세요.');
        if (!initial.authenticationContinuationEligible || !initial.authWait)
          throw new AppError(409, 'PLAYBACK_CONTINUATION_UNAVAILABLE', '실행하지 않은 인증 대기 요청만 이어서 수강할 수 있습니다.');
        if (!provider.capabilities.playback || !provider.authorizePlayback || !provider.learningStatus) throw unavailable('PLAYBACK_UNAVAILABLE');
        const generation = await currentContinuationGeneration(store, key, owner);
        if (!generation || generation === initial.acceptedGeneration)
          throw new AppError(409, 'PLAYBACK_REAUTHENTICATION_REQUIRED', '학교 인증을 갱신한 뒤 계속 수강해 주세요.');
        const flight = owner + ':' + id;
        if (active.has(flight)) throw new AppError(409, 'PLAYBACK_CONTINUATION_BUSY', '계속 수강 요청을 확인 중입니다. 대기열을 다시 확인해 주세요.');
        activeFlight = { key: flight, token: Symbol('playback-continuation') }; active.set(flight, activeFlight.token);
        try {
          if (!await playbackIsReady(readiness, current)) throw unavailable('PLAYBACK_UNAVAILABLE');
          const target = { courseId: initial.courseId, lectureId: initial.lectureId };
          const rawSchool = await provider.learningStatus({ userId: owner }, target, current);
          await validate();
          // The raw value carries this exact read's private proof. Projection must
          // follow cache invalidation so completed rejections update related views too.
          await provider.refreshLearningStatus?.({ userId: owner }, target, rawSchool, { signal: current, validate });
          const school = publicVerifiedSchoolResult(rawSchool);
          await validate();
          if (school.evidence?.completed === true)
            throw new AppError(409, 'PLAYBACK_ALREADY_COMPLETED', '학교에서 이미 완료한 영상은 다시 자동수강하지 않습니다.');
          const admission = await provider.authorizePlayback({ userId: owner }, target, { signal: current, validate });
          if (inspectPlaybackAdmission(admission, { userId: owner, ...target }).generation !== generation)
            throw new AppError(409, 'PLAYBACK_AUTHORITY_CHANGED', '학교 인증이 변경됐습니다. 대기열을 다시 확인해 주세요.');
          await validate(); if (!await playbackIsReady(readiness, current)) throw unavailable('PLAYBACK_UNAVAILABLE');
          current.throwIfAborted(); writeStarted = true;
          return await store.continueJob(owner, id, idempotencyKey, requestHash, { ...authorization, admission,...input }, operation);
        } finally { releaseFlight(); }
      }, { signal, timeoutMs: 90_000 });
      return reply.code(202).send({ originalJob: publicJob(result.originalJob), job: publicJob(result.job), continued: true });
    } catch (error) {
      if (signal.aborted || error instanceof WorkerDeadlineError || writeStarted && !(error instanceof AppError)) throw unconfirmed();
      throw error;
    } finally { releaseFlight(); clean(request); }
  });
}
