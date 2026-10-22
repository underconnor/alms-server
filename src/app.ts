import { registerJobSettlement } from './job-settlement.js';
import type { JobResultCache } from './job-result-cache.js';
import { videoReportDiagnostic } from './video-report-diagnostics.js';
import { requirePlaybackClient } from './playback-client-contract.js';
import { registerPlaybackStart } from './playback-start-routes.js';
import type { PlaybackStartService } from './playback-start-service.js';
import { registerManualVideo } from './manual-video-routes.js';
import type { ManualVideoService } from './manual-video-service.js';
import { registerAssignmentSubmission } from './assignment-submission-routes.js';
import { registerAssignmentHistory } from './assignment-history-routes.js';
import type { AssignmentSubmissionService } from './assignment-submission-service.js';
import Fastify, { LogController, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { timingSafeEqual } from 'node:crypto';
import { z, ZodError } from 'zod';
import type { Config } from './config.js';
import type { Job, Session } from './domain.js';
import { boundedWorkerOperation, WorkerDeadlineError } from './worker-bounds.js';
import { publicJob } from './domain.js';
import { AppError, notFound, unavailable } from './errors.js';
import { materialViewFailureDiagnostic } from './material-view-diagnostics.js';
import { assignmentReadFailureDiagnostic, rememberAssignmentReadFailure, type AssignmentReadFailureStage } from './assignment-read-diagnostics.js';
import { hashToken, type Store } from './store.js';
import { readSchool, type SchoolProvider, unavailableSchoolProvider } from './provider.js';
import { captureEvent } from './analytics.js';
import { registerAuth, sessionCookieName } from './auth.js';
import { validateVideoAccess } from './video-stream.js';
import { calendarQuery, calendarReadQuery, awaitCalendarRead } from './calendar.js';
import { assignmentId, assignmentReadQuery, awaitAssignmentRead } from './assignments.js';
import { assignmentFileDisposition, publicAssignmentFile } from './assignment-files.js';
import { registerJobVerification } from './job-verification.js';
import { registerActivityLearningStatus } from './activity-learning-status.js';
import { registerPersonalCompletion } from './personal-completion-routes.js';
import { defaultFrontendClientId, getFrontendClient } from './frontend-clients.js';
import { providerFeatures } from './feature-support.js';
import { httpOpenApi } from './contracts/http-openapi.js';
import { apiDiscovery } from './api-discovery.js';
import { playbackIsReady, type PlaybackReadinessReader } from './playback-worker-readiness.js';
export { setSessionCookie } from './auth.js';

declare module 'fastify' { interface FastifyRequest { session: Session | null } }
const uuid = z.uuid();
const title = z.string().trim().min(1).max(240);
const dateTime = z.iso.datetime({ offset: true });
const identifier = z.string().min(1).max(200).regex(/^[A-Za-z0-9:_-]+$/);
const createTodo = z.object({ title, dueAt: dateTime.nullable().optional() }).strict();
const patchTodo = z.object({ title: title.optional(), dueAt: dateTime.nullable().optional(), completed: z.boolean().optional() }).strict().refine(v => Object.keys(v).length > 0);
const createJob = z.object({ courseId: identifier, lectureId: identifier, scheduledFor: dateTime.optional() }).strict();
const materialView = z.object({ event: z.enum(['opened', 'page_changed']), page: z.number().int().min(1).max(10_000), totalPages: z.number().int().min(1).max(10_000),
  viewedPages: z.array(z.number().int().min(1).max(10_000)).min(1).max(10_000) }).strict()
  .refine(value => value.page <= value.totalPages && value.viewedPages.includes(value.page)
    && new Set(value.viewedPages).size === value.viewedPages.length && value.viewedPages.every(page => page <= value.totalPages));
const safeEqual = (a: string,b: string) => {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left,right);
};
function awaitTasksRead<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new AppError(503, 'SCHOOL_PROVIDER_UNAVAILABLE', '할 일 조회가 중단됐습니다. 다시 시도해 주세요.'));
    signal.addEventListener('abort', abort, {once: true}); if (signal.aborted) abort();
    void pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export async function buildApp(config: Config, store: Store, provider: SchoolProvider = unavailableSchoolProvider, submissions?: AssignmentSubmissionService, manualVideo?: ManualVideoService, playbackReadiness?: PlaybackReadinessReader, jobResultCache?: JobResultCache, playbackStart?: PlaybackStartService) {
  const app = Fastify({ logger: { level: config.logLevel }, logController: new LogController({ disableRequestLogging: true }), bodyLimit: 32 * 1024, requestTimeout: 120000, trustProxy: false });
  app.server.headersTimeout = 15000;
  app.decorateRequest('session', null);
  await app.register(cookie);
  await app.register(formbody);
  await app.register(cors, { origin: (origin,cb) => cb(null,origin ? config.allowedOrigins.includes(origin) : false), credentials: true, methods: ['GET','HEAD','POST','PATCH','DELETE','OPTIONS'], allowedHeaders: ['Accept','Content-Type','Authorization','X-ALMS-Client-Id','X-ALMS-Trace-Id','X-CSRF-Token','Idempotency-Key','Range'], exposedHeaders: ['Accept-Ranges','Content-Range','Content-Length','Content-Encoding','Content-Disposition'] });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute', errorResponseBuilder: () => new AppError(429,'RATE_LIMITED','잠시 후 다시 시도해 주세요.') });
  app.addHook('onResponse',async (request,reply) => {
    request.log.info({ route: request.routeOptions.url, method: request.method, statusCode: reply.statusCode, elapsedMs: reply.elapsedTime },'request completed');
  });
  app.addHook('onSend',async (request,reply,payload) => {
    const consentHtml = request.method === 'GET' && request.routeOptions.url === '/oauth/interaction/:uid'
      && reply.statusCode === 200 && String(reply.getHeader('content-type')).startsWith('text/html;')
      && reply.getHeader('referrer-policy') === 'same-origin';
    reply.header('cache-control',reply.hasHeader('content-disposition') || ['application/pdf','video/mp4'].includes(String(reply.getHeader('content-type'))) ? 'private, no-store' : 'no-store')
      .header('x-content-type-options','nosniff').header('referrer-policy',consentHtml ? 'same-origin' : 'no-referrer');
    return payload;
  });
  app.setErrorHandler((error,request,reply) => {
    if (request.method === 'GET' && ['/v1/courses/:id/assignments', '/v1/courses/:id/assignments/:assignmentId'].includes(request.routeOptions.url ?? '')) {
      try { request.log.warn({ event: 'assignment_read_failed', ...assignmentReadFailureDiagnostic(error,
        request.routeOptions.url === '/v1/courses/:id/assignments' ? 'list' : 'detail', 'unknown', request) }, 'assignment read failed'); }
      catch { /* A logging failure must preserve the original HTTP error. */ }
    }
    if (request.method === 'POST' && request.routeOptions.url === '/v1/courses/:id/activities/:activityId/manual-playback/:playbackId/reports')
      request.log.warn({ event: 'manual_video_report_failed', ...videoReportDiagnostic(error) }, 'manual video report failed');
    if (request.method === 'POST' && request.routeOptions.url === '/v1/courses/:id/activities/:activityId/view')
      request.log.warn({ event: 'material_view_failed', ...materialViewFailureDiagnostic(error) }, 'material view failed');
    if (error instanceof ZodError) return reply.code(400).send({ error: { code: 'INVALID_REQUEST',message: '입력값을 확인해 주세요.',requestId: request.id } });
    if (error instanceof AppError) return reply.code(error.statusCode).send({ error: { code: error.code,message: error.message,requestId: request.id } });
    const fastifyError = error as { statusCode?: number; code?: string };
    if (fastifyError.statusCode && fastifyError.statusCode < 500) return reply.code(fastifyError.statusCode).send({ error: { code: 'INVALID_REQUEST',message: '요청을 처리할 수 없습니다.',requestId: request.id } });
    request.log.error({ code: 'INTERNAL_ERROR',requestId: request.id },'request failed');
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR',message: '요청 처리 중 오류가 발생했습니다.',requestId: request.id } });
  });
  app.setNotFoundHandler((request,reply) => reply.code(404).send({ error: { code: 'NOT_FOUND',message: '경로를 찾을 수 없습니다.',requestId: request.id } }));

  app.get('/healthz',{ config: { rateLimit: false } },async () => ({ status: 'ok' }));
  const capabilities = async () => ({ ...provider.capabilities,
    playback: provider.capabilities.playback && await playbackIsReady(playbackReadiness) });
  app.get('/readyz',{ config: { rateLimit: false } },async (_request,reply) => {
    try { await store.health(); const current = await capabilities(); return { status: 'ready',capabilities: current,
      playback: { state: !provider.capabilities.playback ? 'disabled' : current.playback ? 'ready' : 'unavailable' } }; }
    catch { return reply.code(503).send({ status: 'not_ready',reason: 'database_unavailable' }); }
  });
  app.get('/version',async () => ({ name: 'alms-backend',version: config.version,commit: config.commit }));
  app.get('/openapi.json',async () => httpOpenApi);
  app.get('/.well-known/alms-api',async () => apiDiscovery(config));
  await registerAuth(app,config,store,provider);

  const authenticate = async (request: FastifyRequest) => {
    const authorization = request.headers.authorization;
    const bearer = authorization === undefined ? null : /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization);
    if (authorization !== undefined && !bearer) throw new AppError(401,'AUTH_REQUIRED','로그인 정보를 확인할 수 없습니다.');
    const declaredClient = request.headers['x-alms-client-id'];
    const origin = request.headers.origin;
    let cookieClientId = defaultFrontendClientId;
    if (!bearer) {
      if (declaredClient !== undefined) {
        if (typeof declaredClient !== 'string') throw new AppError(401,'AUTH_REQUIRED','로그인 프론트를 확인할 수 없습니다.');
        cookieClientId = declaredClient;
      } else {
        const available = config.frontendClients.filter(client => client.authMode === 'cookie' && request.cookies[sessionCookieName(config,client.id)]);
        const candidates = available.filter(client => !origin || client.origins.includes(origin));
        if (candidates.length === 1) cookieClientId = candidates[0]!.id;
        else if (candidates.length === 0 && available.length === 1) cookieClientId = available[0]!.id;
        else if (!origin && candidates.some(client => client.id === defaultFrontendClientId)) cookieClientId = defaultFrontendClientId;
        else if (candidates.length > 1) throw new AppError(403,'CLIENT_ORIGIN_INVALID','로그인 프론트를 지정해 주세요.');
      }
    }
    const token = bearer ? bearer[1] : request.cookies[sessionCookieName(config,cookieClientId)];
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AppError(401,'AUTH_REQUIRED','숭실 통합로그인이 필요합니다.');
    const session = await store.getSession(hashToken(token));
    if (!session) throw new AppError(401,'AUTH_REQUIRED','다시 로그인해 주세요.');
    const clientId = session.clientId ?? defaultFrontendClientId;
    let client;
    try { client = getFrontendClient(config.frontendClients,clientId); }
    catch { throw new AppError(401,'AUTH_REQUIRED','등록된 프론트에서 다시 로그인해 주세요.'); }
    if ((declaredClient !== undefined && declaredClient !== clientId) || (origin && !client.origins.includes(origin) && (bearer || ['GET','HEAD','OPTIONS'].includes(request.method)))
      || (!bearer && cookieClientId !== clientId)
      || (bearer ? client.authMode !== 'bearer' || declaredClient !== clientId || !origin : client.authMode !== 'cookie'))
      throw new AppError(403,'CLIENT_ORIGIN_INVALID','로그인 프론트를 확인할 수 없습니다.');
    request.session = session;
    if (!['GET','HEAD','OPTIONS'].includes(request.method)) {
      const csrf = request.headers['x-csrf-token'];
      if (!origin || !client.origins.includes(origin) || typeof csrf !== 'string' || !safeEqual(csrf,session.csrfToken)) {
        throw new AppError(403,'CSRF_INVALID','요청을 확인할 수 없습니다. 화면을 새로고침해 주세요.');
      }
    }
  };
  const protectedRoute = { preHandler: authenticate };
  await registerAssignmentSubmission(app,store,authenticate,submissions);
  await registerAssignmentHistory(app,store,authenticate,provider);
  registerJobSettlement(app,store,provider,authenticate);
  registerManualVideo(app,store,authenticate,manualVideo);
  registerPlaybackStart(app,store,authenticate,playbackStart);
  registerJobVerification(app, store, provider, authenticate);
  registerActivityLearningStatus(app, store, provider, authenticate);
  registerPersonalCompletion(app, store, provider, authenticate);
  const owner = (request: FastifyRequest) => request.session!.user.id;
  const featureSupport = async () => providerFeatures(provider, { assignmentSubmission: Boolean(submissions), manualVideo: Boolean(manualVideo),
    playbackStart: Boolean(playbackStart), playbackReady: provider.capabilities.playback && await playbackIsReady(playbackReadiness) });
  app.get('/v1/features',protectedRoute,async () => ({ features: await featureSupport() }));
  const paramId = (request: FastifyRequest) => uuid.parse((request.params as { id?: unknown }).id);
  app.get('/v1/me',protectedRoute,async request => ({
    user: { id: owner(request),displayName: request.session!.user.displayName },
    csrfToken: request.session!.csrfToken,capabilities: await capabilities(),
    client: { id: request.session!.clientId ?? defaultFrontendClientId,
      authMode: getFrontendClient(config.frontendClients,request.session!.clientId ?? defaultFrontendClientId).authMode },
    featureSupport: await featureSupport(),
    analytics: { enabled: true,collection: 'required',configured: Boolean(config.posthogKey),delivery: config.posthogKey ? 'posthog_eu' : 'local',analyticsId: request.session!.user.analyticsId,sessionId: request.session!.analyticsSessionId },
  }));
  app.patch('/v1/me/preferences',protectedRoute,async request => {
    const input = z.object({ analyticsEnabled: z.boolean() }).strict().parse(request.body);
    if (!input.analyticsEnabled) throw new AppError(409,'ANALYTICS_REQUIRED','허용된 사용 기록은 서비스 개선을 위해 기본 수집합니다.');
    return { analyticsEnabled: true,collection: 'required',configured: Boolean(config.posthogKey) };
  });
  app.post('/v1/auth/logout',protectedRoute,async (request,reply) => {
    await store.deleteSession(request.session!.tokenHash);
    if (getFrontendClient(config.frontendClients,request.session!.clientId ?? defaultFrontendClientId).authMode === 'cookie')
      reply.clearCookie(sessionCookieName(config,request.session!.clientId ?? defaultFrontendClientId),{ path: '/',httpOnly: true,secure: config.cookieSecure,sameSite: 'lax' });
    return reply.code(204).send();
  });
  app.get('/v1/timetable',protectedRoute,async request => readSchool(provider,'timetable',owner(request)));
  app.get('/v1/tasks',protectedRoute,async (request, reply) => {
    z.object({}).strict().parse(request.query);
    if (!provider.tasks) throw unavailable();
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]);
    const abort = () => controller.abort(); request.raw.once('aborted', abort); reply.raw.once('close', abort);
    const validate = async () => {
      const session = await store.getSession(request.session!.tokenHash);
      if (!session || session.user.id !== owner(request)) throw new AppError(401, 'AUTH_REQUIRED', '다시 로그인해 주세요.');
    };
    try {return await awaitTasksRead((async () => {
    signal.throwIfAborted();
    const observedTasks = await provider.tasks!({userId: owner(request)}, {signal, validate,
      personalCompletionCourses: async courseIds => {
        signal.throwIfAborted();
        const rows = await store.listCompletionsForCourses(owner(request), courseIds);
        signal.throwIfAborted();
        return [...new Set(rows.filter(row => courseIds.includes(row.courseId)).map(row => row.courseId))];
      }});
    const value = z.object({ items: z.array(z.object({ courseId: identifier,
      moduleItemId: identifier.optional() }).passthrough()).max(10_000) }).passthrough()
      .parse(observedTasks);
    const linkedCourses = [...new Set(value.items.filter(item => item.moduleItemId).map(item => item.courseId))];
    if (linkedCourses.length && !provider.validateTasks) throw unavailable();
    const rows = linkedCourses.length ? await store.listCompletionsForCourses(owner(request), linkedCourses) : [];
    const overrides = new Map(rows.map(row => [JSON.stringify([row.courseId, row.activityId]), row.completed]));
    // A same-owner school login keeps old ALMS cookies alive, so getSession is not a generation check.
    // Validate the original DTO object after the local batch, never its Zod copy or serialized payload.
    signal.throwIfAborted();
    if (provider.validateTasks) {
      await provider.validateTasks({ userId: owner(request), sessionTokenHash: request.session!.tokenHash }, observedTasks);
    } else {
      // Unmapped legacy providers do not attach school module proof or personal overrides.
      const session = await store.getSession(request.session!.tokenHash);
      if (!session || session.user.id !== owner(request)) throw new AppError(401,'AUTH_REQUIRED','다시 로그인해 주세요.');
    }
    signal.throwIfAborted();
    return { ...value, items: value.items.map(item => item.moduleItemId
      ? { ...item, personalCompleted: overrides.get(JSON.stringify([item.courseId, item.moduleItemId])) ?? null }
      : item) };
    })(), signal);} finally {request.raw.off('aborted', abort); reply.raw.off('close', abort);}
  });
  app.get('/v1/dashboard', protectedRoute, async request => {
    const query = z.object({ detail: z.literal('overview').optional() }).strict().parse(request.query);
    if (!provider.dashboard) throw unavailable();
    return provider.dashboard({ userId: owner(request) }, query);
  });
  app.get('/v1/courses', protectedRoute, async request => {
    const query = z.object({ termId: z.string().regex(/^[1-9]\d{0,15}$/).optional() }).strict().parse(request.query);
    if (!provider.courses) throw unavailable();
    return provider.courses({ userId: owner(request) }, query);
  });
  app.get('/v1/course-terms', protectedRoute, async request => {
    z.object({}).strict().parse(request.query);
    if (!provider.courseTerms) throw unavailable();
    return provider.courseTerms({ userId: owner(request) });
  });
  app.get('/v1/calendar',protectedRoute,async (request, reply) => {
    const { refresh, ...input } = calendarReadQuery.parse(request.query);
    const query = calendarQuery.parse(input);
    if (!provider.calendar) throw unavailable('CALENDAR_UNAVAILABLE');
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]);
    const abort = () => controller.abort(); request.raw.once('aborted', abort); reply.raw.once('close', abort);
    const validate = async () => {
      const session = await store.getSession(request.session!.tokenHash);
      if (!session || session.user.id !== owner(request)) throw new AppError(401, 'AUTH_REQUIRED', '다시 로그인해 주세요.');
    };
    try {
      return await awaitCalendarRead((async () => {
        signal.throwIfAborted(); await validate(); signal.throwIfAborted();
        const result = await provider.calendar!({ userId: owner(request) }, query, { signal, validate, ...(refresh ? { refresh: true } : {}),
          personalCompletionCourses: async courseIds => {
            signal.throwIfAborted();
            const rows = await store.listCompletionsForCourses(owner(request), courseIds);
            signal.throwIfAborted();
            return [...new Set(rows.filter(row => courseIds.includes(row.courseId)).map(row => row.courseId))];
          } });
        const linkedCourses = [...new Set(result.items.filter(item => item.type === 'assignment' && item.moduleItemId).map(item => item.courseId))];
        if (linkedCourses.length && !provider.validateCalendar) throw unavailable('CALENDAR_UNAVAILABLE');
        const rows = linkedCourses.length ? await store.listCompletionsForCourses(owner(request), linkedCourses) : [];
        const overrides = new Map(rows.map(row => [JSON.stringify([row.courseId, row.activityId]), row.completed]));
        signal.throwIfAborted();
        // Bind the exact original school DTO after the fresh local batch. No async authority
        // reads follow this adapter's single ALMS/school snapshot.
        if (provider.validateCalendar) await provider.validateCalendar({userId: owner(request), sessionTokenHash: request.session!.tokenHash}, result);
        else await validate();
        signal.throwIfAborted();
        return {...result, items: result.items.map(item => item.type === 'assignment' && item.moduleItemId
          ? {...item, personalCompleted: overrides.get(JSON.stringify([item.courseId, item.moduleItemId])) ?? null} : item)};
      })(), signal);
    } finally { request.raw.off('aborted', abort); reply.raw.off('close', abort); }
  });
  for (const detail of [false, true]) {
    app.get('/v1/courses/:id/assignments' + (detail ? '/:assignmentId' : ''), protectedRoute, async (request, reply) => {
      const query = assignmentReadQuery.parse(request.query);
      const params = z.object({ id: assignmentId, assignmentId: detail ? assignmentId : z.undefined().optional() }).parse(request.params);
      if (detail ? !provider.assignment : !provider.assignments) throw unavailable('ASSIGNMENTS_UNAVAILABLE');
      const controller = new AbortController(), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]);
      let stage: AssignmentReadFailureStage = 'owned_catalog';
      const abort = () => controller.abort(); request.raw.once('aborted', abort); reply.raw.once('close', abort);
      const validate = async () => {
        const session = await store.getSession(request.session!.tokenHash);
        if (!session || session.user.id !== owner(request)) throw new AppError(401, 'AUTH_REQUIRED', '다시 로그인해 주세요.');
      };
      try {
        return await awaitAssignmentRead((async () => {
          signal.throwIfAborted(); await validate(); signal.throwIfAborted();
          const options = { signal, validate, ...(query.refresh ? { refresh: true } : {}) };
          stage = 'school_read';
          const result = detail ? await provider.assignment!({ userId: owner(request) }, params.id, params.assignmentId!, options)
            : await provider.assignments!({ userId: owner(request) }, params.id, options);
          stage = 'final_session';
          await validate(); signal.throwIfAborted(); return result;
        })(), signal);
      } catch (error) {
        rememberAssignmentReadFailure(error, assignmentReadFailureDiagnostic(error, detail ? 'detail' : 'list', stage, validate), request); throw error;
      } finally { request.raw.off('aborted', abort); reply.raw.off('close', abort); }
    });
  }
  app.get('/v1/courses/:id/assignments/:assignmentId/files/:fileId', protectedRoute, async (request, reply) => {
    const query = z.object({ download: z.literal('1').optional(), refresh: z.literal('1').optional() }).strict().parse(request.query);
    const params = z.object({ id: assignmentId, assignmentId, fileId: assignmentId }).parse(request.params);
    if (!provider.assignmentFile) throw unavailable('ASSIGNMENT_FILE_UNAVAILABLE');
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]);
    const abort = () => controller.abort(); request.raw.once('aborted', abort); reply.raw.once('close', abort);
    const validate = async () => {
      const session = await store.getSession(request.session!.tokenHash);
      if (!session || session.user.id !== owner(request)) throw new AppError(401, 'AUTH_REQUIRED', '다시 로그인해 주세요.');
    };
    try {
      const file = await awaitAssignmentRead((async () => {
        await validate(); signal.throwIfAborted();
        const input = await provider.assignmentFile!({ userId: owner(request) }, params.id, params.assignmentId, params.fileId,
          { signal, validate, ...(query.refresh ? { refresh: true } : {}) });
        if (input.fileId !== params.fileId) throw unavailable('ASSIGNMENT_FILE_UNAVAILABLE');
        const result = publicAssignmentFile(input, { id: params.fileId, fileName: input.fileName, contentType: input.contentType, sizeBytes: null, downloadAvailable: true });
        await validate(); signal.throwIfAborted(); return result;
      })(), signal);
      return reply.type(file.contentType).header('cache-control', 'private, no-store')
        .header('content-disposition', assignmentFileDisposition(file, query.download === '1'))
        .header('content-length', file.bytes.length).header('accept-ranges', 'none')
        .header('content-security-policy', "default-src 'none'; sandbox").send(file.bytes);
    } finally { request.raw.off('aborted', abort); reply.raw.off('close', abort); }
  });
  app.get('/v1/attendance',protectedRoute,async request => {
    const query = z.object({ courseId: identifier.optional() }).strict().parse(request.query);
    if (!provider.attendance) throw unavailable();
    return provider.attendance({ userId: owner(request) },query.courseId);
  });
  app.get('/v1/courses/:id',protectedRoute,async request => {
    if (!provider.course) throw unavailable();
    return provider.course({ userId: owner(request) },identifier.parse((request.params as { id: string }).id));
  });
  for (const material of [false, true]) {
    app.get('/v1/courses/:id/syllabus' + (material ? '/material' : ''), protectedRoute, async (request, reply) => {
      const query = z.object({ refresh: z.literal('1').optional() }).strict().parse(request.query);
      const courseId = identifier.parse((request.params as { id: string }).id);
      const method = material ? provider.syllabusMaterial : provider.syllabus;
      if (!method) throw unavailable('SYLLABUS_UNAVAILABLE');
      const controller = new AbortController();
      const abort = () => controller.abort(); request.raw.once('aborted', abort); reply.raw.once('close', abort);
      const validate = async () => {
        const session = await store.getSession(request.session!.tokenHash);
        if (!session || session.user.id !== owner(request)) throw new AppError(401, 'AUTH_REQUIRED', '다시 로그인해 주세요.');
      };
      try {
        await validate();
        const result = await method({ userId: owner(request) }, courseId, {
          ...(query.refresh ? { refresh: true } : {}), signal: controller.signal, validate,
        });
        await validate(); controller.signal.throwIfAborted();
        if (!material) return result;
        const { bytes } = result as { bytes: Buffer };
        return reply.type('application/pdf').header('content-disposition', `inline; filename="syllabus.pdf"; filename*=UTF-8''${encodeURIComponent('강의계획서.pdf')}`)
          .header('content-length', bytes.length).header('accept-ranges', 'none').send(bytes);
      } finally { request.raw.off('aborted', abort); reply.raw.off('close', abort); }
    });
  }
  app.get('/v1/courses/:id/activities/:activityId',protectedRoute,async request => {
    z.object({}).strict().parse(request.query);
    const params = z.object({id: identifier, activityId: identifier}).parse(request.params);
    if (!provider.activity) throw unavailable();
    const activity = await provider.activity({userId: owner(request)},params.id,params.activityId);
    // Older Front builds label every manual video as attendance-exempt. Expose
    // untracked attendance playback only to a client that understands that mode.
    if (activity && typeof activity === 'object' && 'manualVideoProgressMode' in activity
      && activity.manualVideoProgressMode === 'untracked' && request.headers.accept !== 'application/json; alms-manual-video=untracked')
      return { ...activity, manualVideoAvailable: false };
    return activity;
  });
  app.post('/v1/courses/:id/activities/:activityId/view',{ ...protectedRoute, bodyLimit: 64 * 1024 },async request => {
    z.object({}).strict().parse(request.query);
    const observation = materialView.parse(request.body);
    const params = z.object({id: identifier, activityId: identifier}).parse(request.params);
    if (!provider.recordMaterialView) throw unavailable('MATERIAL_VIEW_UNAVAILABLE');
    const validate = async () => {
      const session = await store.getSession(request.session!.tokenHash);
      if (!session || session.user.id !== owner(request) || !safeEqual(session.csrfToken, request.session!.csrfToken))
        throw new AppError(401,'AUTH_REQUIRED','다시 로그인해 주세요.');
    };
    // A slow school preparation must not authorize a write using an ALMS session that logged out.
    await validate();
    const result = await provider.recordMaterialView({ userId: owner(request) },params.id,params.activityId,observation,validate);
    await validate();
    return result;
  });
  app.get('/v1/courses/:id/activities/:activityId/material',protectedRoute,async (request,reply) => {
    const query = z.object({ refresh: z.literal('1').optional() }).strict().parse(request.query);
    const params = z.object({id: identifier, activityId: identifier}).parse(request.params);
    if (!provider.material) throw unavailable();
    const { bytes } = await provider.material({userId: owner(request)},params.id,params.activityId,
      query.refresh ? { refresh: true } : undefined);
    if (!await store.getSession(request.session!.tokenHash)) throw new AppError(401,'AUTH_REQUIRED','다시 로그인해 주세요.');
    return reply.type('application/pdf').header('content-disposition','inline; filename="material.pdf"')
      .header('content-length',bytes.length).header('accept-ranges','none').send(bytes);
  });
  app.route({ method: ['GET','HEAD'], url: '/v1/courses/:id/activities/:activityId/media', ...protectedRoute,
    handler: async (request,reply) => {
      z.object({}).strict().parse(request.query);
      const params = z.object({id: identifier, activityId: identifier}).parse(request.params);
      if (!provider.video) throw unavailable();
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.raw.once('aborted',abort); reply.raw.once('close',abort);
      const validate = async () => {
        const session = await store.getSession(request.session!.tokenHash);
        if (!session || session.user.id !== owner(request)) throw new AppError(401,'AUTH_REQUIRED','다시 로그인해 주세요.');
      };
      try {
        const response = await provider.video({ userId: owner(request) },params.id,params.activityId,{
          method: request.method === 'HEAD' ? 'HEAD' : 'GET',range: request.headers.range,signal: controller.signal,validate });
        await validateVideoAccess(validate, controller.signal);
        reply.code(response.status).type('video/mp4').header('content-disposition','inline; filename="video.mp4"')
          .header('content-length',response.contentLength).header('accept-ranges','bytes');
        if (response.contentRange) reply.header('content-range',response.contentRange);
        return reply.send(response.body);
      } catch (error) { controller.abort(); throw error; }
      finally { request.raw.removeListener('aborted',abort); }
    } });
  app.get('/v1/todos',protectedRoute,async request => {
    const limit = 500, rows = await store.listTodos(owner(request),limit + 1), hasMore = rows.length > limit;
    return { items: rows.slice(0,limit), complete: !hasMore, hasMore, limit };
  });
  app.post('/v1/todos',protectedRoute,async (request,reply) => reply.code(201).send(await store.createTodo(owner(request),createTodo.parse(request.body))));
  app.patch('/v1/todos/:id',protectedRoute,async request => store.updateTodo(owner(request),paramId(request),patchTodo.parse(request.body)));
  app.delete('/v1/todos/:id',protectedRoute,async (request,reply) => { await store.deleteTodo(owner(request),paramId(request)); return reply.code(204).send(); });
  const refreshJobResults = async (request: FastifyRequest, reply: FastifyReply, jobs: Job[]) => {
    if (!jobResultCache) return;
    const controller = new AbortController(), abort = () => controller.abort();
    request.raw.once('aborted', abort); reply.raw.once('close', abort);
    try {
      await jobResultCache.refresh(request.session!, jobs, { signal: controller.signal, validate: async () => {
        const session = await store.getSession(request.session!.tokenHash);
        if (!session || session.user.id !== owner(request)) throw new AppError(401, 'AUTH_REQUIRED', '다시 로그인해 주세요.');
      } });
    } finally { request.raw.off('aborted', abort); reply.raw.off('close', abort); }
  };
  app.get('/v1/jobs',protectedRoute,async (request, reply) => {
    const query = z.object({ courseId: identifier.optional() }).strict().parse(request.query);
    requirePlaybackClient(request, provider.capabilities.playback);
    const limit = 200, rows = await store.listJobs(owner(request),query.courseId,limit + 1), hasMore = rows.length > limit;
    const jobs = rows.slice(0,limit);
    requirePlaybackClient(request, jobs.some(job => job.acceptedGeneration != null));
    await refreshJobResults(request, reply, jobs);
    return { items: jobs.map(publicJob), complete: !hasMore, hasMore, limit };
  });
  app.get('/v1/jobs/:id',protectedRoute,async (request, reply) => {
    const job = await store.getJob(owner(request),paramId(request)); if (!job) throw notFound();
    requirePlaybackClient(request, provider.capabilities.playback || job.acceptedGeneration != null);
    await refreshJobResults(request, reply, [job]);
    return publicJob(job);
  });
  const jobRequests = new WeakMap<FastifyRequest, { signal: AbortSignal; clean: () => void }>();
  const cleanJobRequest = (request: FastifyRequest) => { jobRequests.get(request)?.clean(); jobRequests.delete(request); };
  const admissionError = (error: unknown, signal: AbortSignal) => {
    if (signal.aborted || error instanceof WorkerDeadlineError)
      return new AppError(503, 'PLAYBACK_ADMISSION_UNCONFIRMED', '작업 목록에서 접수 결과를 확인해 주세요.');
    return error;
  };
  app.post('/v1/jobs', {
    onRequest: async (request, reply) => {
      const controller = new AbortController(), abort = () => controller.abort();
      const timer = setTimeout(() => controller.abort(new WorkerDeadlineError()), 90_000);
      request.raw.once('aborted', abort); reply.raw.once('close', abort);
      jobRequests.set(request, { signal: controller.signal, clean: () => {
        clearTimeout(timer); request.raw.off('aborted', abort); reply.raw.off('close', abort);
      } });
    },
    preHandler: async request => {
      const signal = jobRequests.get(request)!.signal;
      try { await boundedWorkerOperation(() => authenticate(request), { signal, timeoutMs: 5000 }); }
      catch (error) { throw admissionError(error, signal); }
    },
    onResponse: async request => cleanJobRequest(request),
    onError: async request => cleanJobRequest(request),
  },async (request,reply) => {
    const input = createJob.parse(request.body);
    const idempotencyKey = uuid.parse(request.headers['idempotency-key']);
    requirePlaybackClient(request, provider.capabilities.playback);
    if (!provider.capabilities.playback || !provider.authorizePlayback) throw unavailable('PLAYBACK_UNAVAILABLE');
    if (input.scheduledFor && Date.parse(input.scheduledFor) > Date.now() + 365 * 24 * 60 * 60 * 1000) throw new AppError(400,'INVALID_SCHEDULE','1년 이내 시각을 선택해 주세요.');
    const requestHash = hashToken(JSON.stringify(input)), userId = owner(request), tokenHash = request.session!.tokenHash;
    const requestSignal = jobRequests.get(request)!.signal;
    try {
      const job = await boundedWorkerOperation(async signal => {
        const operation = { signal, timeoutMs: 5000 };
        const validate = async () => {
          const session = await boundedWorkerOperation(() => store.getSession(tokenHash), operation);
          if (!session || session.user.id !== userId) throw new AppError(401,'AUTH_REQUIRED','다시 로그인해 주세요.');
          signal.throwIfAborted();
        };
        await validate();
        const existing = await store.findJobRequest(userId, idempotencyKey, requestHash, operation);
        await validate();
        if (existing) return existing;
        if (!await playbackIsReady(playbackReadiness, signal)) throw unavailable('PLAYBACK_UNAVAILABLE');
        signal.throwIfAborted();
        const admission = await provider.authorizePlayback!({ userId }, { courseId: input.courseId, lectureId: input.lectureId }, { signal, validate });
        await validate();
        if (!await playbackIsReady(playbackReadiness, signal)) throw unavailable('PLAYBACK_UNAVAILABLE');
        signal.throwIfAborted();
        return store.createJob(userId, { ...input, scheduledFor: input.scheduledFor ?? new Date().toISOString(), idempotencyKey, requestHash },
          { admission, almsTokenHash: tokenHash }, operation);
      }, { signal: requestSignal, timeoutMs: 90_000 });
      return reply.code(202).send(publicJob(job));
    } catch (error) { throw admissionError(error, requestSignal); }
    finally { cleanJobRequest(request); }
  });
  app.post('/v1/jobs/:id/cancel',protectedRoute,async request => {
    const id = paramId(request), userId = owner(request), job = await store.getJob(userId,id);
    if (!job) throw notFound();
    requirePlaybackClient(request, provider.capabilities.playback || job.acceptedGeneration != null);
    return publicJob(await store.cancelJob(userId,id));
  });
  for (const action of ['pause','resume']) {
    app.post('/v1/jobs/:id/' + action,protectedRoute,async request => {
      const job = await store.getJob(owner(request),paramId(request));
      if (!job) throw notFound();
      requirePlaybackClient(request, provider.capabilities.playback || job.acceptedGeneration != null);
      throw unavailable('PLAYBACK_CONTROL_UNAVAILABLE');
    });
  }
  app.post('/v1/analytics/events',protectedRoute,async (request,reply) => reply.code(202).send(await captureEvent(request.body,request.session!,store.analytics)));
  app.get('/v1/analytics/summary',protectedRoute,async request => {
    const query = z.object({ days: z.coerce.number().int().min(1).max(365).default(7) }).strict().parse(request.query);
    const summary = await store.analytics.summarize(owner(request),query.days);
    return { ...summary,delivery: { ...summary.delivery,configured: Boolean(config.posthogKey),destination: config.posthogKey ? 'posthog_eu' : 'local' } };
  });
  return app;
}
