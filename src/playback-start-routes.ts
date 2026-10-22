import type { FastifyInstance, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError } from './errors.js';
import type { Store } from './store.js';
import type { PlaybackStartService } from './playback-start-service.js';
import { boundedWorkerOperation, WorkerDeadlineError } from './worker-bounds.js';
import { takePlaybackStartDiagnostic } from './playback-start-diagnostics.js';

const id = z.string().regex(/^[1-9]\d{0,15}$/), empty = z.object({}).strict();
const observation = z.object({ positionSeconds: z.number().finite().min(0).max(14_401), durationSeconds: z.number().finite().gt(0).max(14_400),
  playbackRate: z.literal(1), paused: z.literal(true), ended: z.literal(false), seeking: z.literal(false), visible: z.literal(true) }).strict();
const confirmation = z.object({ nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/), observation }).strict();

export function registerPlaybackStart(app: FastifyInstance, store: Pick<Store, 'getSession'>,
  authenticate: (request: FastifyRequest) => Promise<void>, service?: PlaybackStartService) {
  const requests = new WeakMap<FastifyRequest, { signal: AbortSignal; clean: () => void }>();
  const clean = (request: FastifyRequest) => { requests.get(request)?.clean(); requests.delete(request); };
  const base = '/v1/courses/:id/activities/:activityId/playback-start-confirmations';
  for (const action of ['prepare', 'confirm'] as const) app.post(action === 'prepare' ? base : `${base}/:confirmationId/confirm`,
    { onRequest: async (request, reply) => {
      const abort = new AbortController(), cancel = () => abort.abort();
      const timer = setTimeout(cancel, 90_000);
      request.raw.once('aborted', cancel); reply.raw.once('close', cancel);
      requests.set(request, { signal: abort.signal, clean: () => {
        clearTimeout(timer); request.raw.off('aborted', cancel); reply.raw.off('close', cancel);
      } });
    }, onResponse: async request => clean(request), onError: async request => clean(request),
    preHandler: async request => {
      try { await boundedWorkerOperation(async bounded => { await authenticate(request); bounded.throwIfAborted(); }, { signal: requests.get(request)!.signal, timeoutMs: 5_000 }); }
      catch (error) { if (requests.get(request)?.signal.aborted || error instanceof WorkerDeadlineError) throw new AppError(503, 'PLAYBACK_START_UNAVAILABLE', '학교 진도 기록 시작을 준비하지 못했습니다.'); throw error; }
    }, bodyLimit: 2048 }, async (request, reply) => {
      empty.parse(request.query);
      const target = z.object({ id, activityId: id, confirmationId: action === 'prepare' ? z.undefined().optional() : z.uuid() }).strict().parse(request.params);
      const value = action === 'prepare' ? empty.parse(request.body) : confirmation.parse(request.body);
      if (!service) throw new AppError(503, 'PLAYBACK_START_UNAVAILABLE', '학교 진도 기록 시작을 준비 중입니다.');
      const signal = requests.get(request)!.signal;
      const session = request.session!, context = { owner: session.user.id, sessionHash: session.tokenHash, courseId: target.id, moduleItemId: target.activityId };
      const validate = () => boundedWorkerOperation(async bounded => {
        const latest = await store.getSession(session.tokenHash); bounded.throwIfAborted();
        if (!latest || latest.user.id !== context.owner || Buffer.byteLength(latest.csrfToken) !== Buffer.byteLength(session.csrfToken)
          || !timingSafeEqual(Buffer.from(latest.csrfToken), Buffer.from(session.csrfToken))) throw new AppError(401, 'AUTH_REQUIRED', '다시 로그인해 주세요.');
      }, { signal, timeoutMs: 5_000 });
      const logDiagnostic = (source: unknown) => {
        const diagnostic = takePlaybackStartDiagnostic(source);
        if (diagnostic) try { request.log.warn({ event: 'school_video_start_failed', ...diagnostic }, 'school video start failed'); }
        catch { /* Logging must preserve the original HTTP result and execution policy. */ }
      };
      try {
        await validate();
        if (action === 'prepare') return await service.prepare(context, validate, signal);
        const input = value as z.infer<typeof confirmation>;
        try {
          const result = await service.confirm(context, target.confirmationId!, input.nonce, input.observation, validate, signal);
          logDiagnostic(result); return result;
        } catch (error) { logDiagnostic(error); throw error; }
      } finally { clean(request); }
    });
  if (service) app.addHook('onClose', () => service.close());
}
