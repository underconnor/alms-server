import type { FastifyInstance, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError } from './errors.js';
import type { Store } from './store.js';
import type { ManualVideoService } from './manual-video-service.js';
import { boundedWorkerOperation, WorkerDeadlineError } from './worker-bounds.js';
import { logManualObservationFailure, logManualReportResult, manualTransportTrace } from './manual-transport-trace.js';

const id = z.string().regex(/^[1-9]\d{0,15}$/), nonce = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const empty = z.object({}).strict(), sequence = z.number().int().min(1).max(100_000);
const observation = z.object({ positionSeconds: z.number().finite().min(0).max(14_401), durationSeconds: z.number().finite().gt(0).max(14_400),
  playbackRate: z.literal(1), paused: z.boolean(), ended: z.boolean(), seeking: z.literal(false), visible: z.literal(true),
  capturedAtMs: z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER).optional() }).strict();
const observations = z.object({ nonce, sequence, observation }).strict();
const reports = z.object({ nonce, reportSequence: sequence, event: z.enum(['playing', 'update', 'unload', 'ended']) }).strict();

export function registerManualVideo(app: FastifyInstance, store: Pick<Store, 'getSession'>,
  authenticate: (request: FastifyRequest) => Promise<void>, service?: ManualVideoService) {
  const base = '/v1/courses/:id/activities/:activityId/manual-playback';
  for (const action of ['start', 'observations', 'reports', 'stop'] as const) {
    const url = action === 'start' ? base : `${base}/:playbackId/${action}`;
    app.post(url, { ...manualTransportTrace(action === 'start' ? 'prepare' : action === 'observations' ? 'observation' : action === 'reports' ? 'report' : 'stop'), preHandler: async request => {
      try { await boundedWorkerOperation(async bounded => { await authenticate(request); bounded.throwIfAborted(); }, { timeoutMs: 5_000 }); }
      catch (error) { if (error instanceof WorkerDeadlineError) throw new AppError(503, 'VIDEO_REPORT_UNAVAILABLE', '학교 진도 기록을 준비하지 못했습니다.'); throw error; }
    }, bodyLimit: 2048 }, async (request, reply) => {
      empty.parse(request.query);
      const target = z.object({ id, activityId: id, playbackId: action === 'start' ? z.undefined().optional() : z.uuid() }).strict().parse(request.params);
      const value = action === 'start' ? empty.parse(request.body) : action === 'observations' ? observations.parse(request.body)
        : action === 'reports' ? reports.parse(request.body) : z.object({ nonce }).strict().parse(request.body);
      if (!service) throw new AppError(503, 'VIDEO_REPORT_UNAVAILABLE', '학교 진도 기록을 준비 중입니다.');
      const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(['start', 'reports'].includes(action) ? 90_000 : 10_000)]);
      const cancel = () => abort.abort(); request.raw.once('aborted', cancel); reply.raw.once('close', cancel);
      const session = request.session!, context = { owner: session.user.id, sessionHash: session.tokenHash, courseId: target.id, moduleItemId: target.activityId };
      const validate = () => boundedWorkerOperation(async bounded => {
        const latest = await store.getSession(session.tokenHash); bounded.throwIfAborted();
        if (!latest || latest.user.id !== context.owner || Buffer.byteLength(latest.csrfToken) !== Buffer.byteLength(session.csrfToken)
          || !timingSafeEqual(Buffer.from(latest.csrfToken), Buffer.from(session.csrfToken))) throw new AppError(401, 'AUTH_REQUIRED', '다시 로그인해 주세요.');
      }, { signal, timeoutMs: 5_000 });
      try {
        await validate();
        if (action === 'start') return await service.start(context, validate, signal);
        if (action === 'observations') return await service.observe(context, target.playbackId!, value as z.infer<typeof observations>, validate, signal);
        if (action === 'reports') {
          const input = value as z.infer<typeof reports>;
          const result = await service.report(context, target.playbackId!, input, validate, signal);
          logManualReportResult(request, input.event, result);
          return result;
        }
        return await service.stop(context, target.playbackId!, (value as { nonce: string }).nonce, validate);
      } catch (error) {
        if (action === 'observations') logManualObservationFailure(request, error);
        throw error;
      } finally { request.raw.off('aborted', cancel); reply.raw.off('close', cancel); }
    });
  }
  if (service) app.addHook('onClose', () => service.close());
}
