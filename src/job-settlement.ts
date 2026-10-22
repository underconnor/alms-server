import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError, notFound, unavailable } from './errors.js';
import { publicJob } from './domain.js';
import type { Store } from './store.js';
import type { SchoolProvider } from './provider.js';
import { inspectPlaybackAdmission } from './playback-authority.js';
import { requirePlaybackClient } from './playback-client-contract.js';
import { publicVerifiedSchoolResult } from './job-verification.js';
import { boundedWorkerOperation, WorkerDeadlineError } from './worker-bounds.js';

const body = z.object({ expectedUpdatedAt: z.iso.datetime({ offset: true }), confirmed: z.literal(true) }).strict();
const unconfirmed = () => new AppError(503, 'JOB_SETTLEMENT_UNCONFIRMED', '작업 목록에서 정리 결과를 확인해 주세요.');
const changed = () => new AppError(409, 'JOB_CHANGED', '작업 상태가 바뀌었습니다. 다시 조회해 주세요.');

/** Explicit local settlement only. No playback, school report, cancellation or automatic retry. */
export function registerJobSettlement(app: FastifyInstance, store: Store, provider: SchoolProvider,
  authenticate: (request: FastifyRequest) => Promise<void>) {
  const active = new Set<string>();
  const requests = new WeakMap<FastifyRequest, { signal: AbortSignal; clean: () => void }>();
  const clean = (request: FastifyRequest) => { requests.get(request)?.clean(); requests.delete(request); };
  app.post('/v1/jobs/:id/settle', {
    onRequest: async (request, reply) => {
      const controller = new AbortController();
      const abort = () => controller.abort(new WorkerDeadlineError());
      const timer = setTimeout(abort, 90_000);
      request.raw.once('aborted', abort); reply.raw.once('close', abort);
      requests.set(request, { signal: controller.signal, clean: () => {
        clearTimeout(timer); request.raw.off('aborted', abort); reply.raw.off('close', abort);
      } });
    },
    preHandler: async request => {
      try { await boundedWorkerOperation(() => authenticate(request), { signal: requests.get(request)!.signal, timeoutMs: 5_000 }); }
      catch (error) { if (error instanceof WorkerDeadlineError) throw unconfirmed(); throw error; }
    },
    onResponse: async request => clean(request), onError: async request => clean(request),
  }, async request => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    z.object({}).strict().parse(request.query);
    const input = body.parse(request.body), owner = request.session!.user.id;
    const tokenHash = request.session!.tokenHash, csrfToken = request.session!.csrfToken;
    const signal = requests.get(request)!.signal;
    let writeStarted = false;
    try {
      return await boundedWorkerOperation(async current => {
        const operation = { signal: current, timeoutMs: 5_000 };
        const validate = async () => {
          const session = await boundedWorkerOperation(() => store.getSession(tokenHash), operation);
          if (!session || session.user.id !== owner || session.csrfToken !== csrfToken)
            throw new AppError(401, 'AUTH_REQUIRED', '다시 로그인해 주세요.');
          current.throwIfAborted();
        };
        await validate();
        const initial = await boundedWorkerOperation(() => store.getJob(owner, id), operation);
        if (!initial || initial.userId !== owner || initial.id !== id) throw notFound();
        requirePlaybackClient(request, provider.capabilities.playback || initial.acceptedGeneration != null);
        if (initial.recovery?.version !== input.expectedUpdatedAt) throw changed();
        if (!initial.recovery?.eligible && initial.recovery?.reason !== 'already_settled')
          throw new AppError(409, 'JOB_SETTLEMENT_UNSAFE', '실행 종료와 학교 결과를 먼저 확인해 주세요.');
        if (!store.settleJob || !provider.authorizePlayback || !provider.learningStatus) throw unavailable('JOB_SETTLEMENT_UNAVAILABLE');
        if (active.has(owner)) throw new AppError(409, 'JOB_SETTLEMENT_BUSY', '작업을 정리하고 있습니다. 잠시 후 다시 확인해 주세요.');
        active.add(owner);
        try {
          const target = { courseId: initial.courseId, lectureId: initial.lectureId };
          const first = await provider.authorizePlayback({ userId: owner }, target, { signal: current, validate });
          const firstGeneration = inspectPlaybackAdmission(first, { userId: owner, ...target }).generation;
          const schoolResult = publicVerifiedSchoolResult(await provider.learningStatus({ userId: owner }, target, current));
          await validate();
          const admission = await provider.authorizePlayback({ userId: owner }, target, { signal: current, validate });
          if (inspectPlaybackAdmission(admission, { userId: owner, ...target }).generation !== firstGeneration)
            throw new AppError(409, 'PLAYBACK_AUTHORITY_CHANGED', '학교 인증이 바뀌었습니다. 다시 확인해 주세요.');
          await validate(); current.throwIfAborted();
          writeStarted = true;
          const job = await store.settleJob(owner, id, input.expectedUpdatedAt,
            { admission, tokenHash, csrfToken, schoolResult }, operation);
          current.throwIfAborted();
          return { job: publicJob(job), settlementRecorded: true as const, stateChanged: false as const };
        } finally { active.delete(owner); }
      }, { signal, timeoutMs: 90_000 });
    } catch (error) {
      if (signal.aborted || error instanceof WorkerDeadlineError || writeStarted && !(error instanceof AppError)) throw unconfirmed();
      throw error;
    } finally { clean(request); }
  });
}
