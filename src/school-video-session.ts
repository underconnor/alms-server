import { verifiedVideoMedia } from './verified-video-media.js';
import { z } from 'zod';
import { rememberVideoReportPreparation, rememberVideoReportResult, videoReportDiagnostic, type VideoReportPreparationStage, type VideoReportContext } from './video-report-diagnostics.js';
import { SchoolHttpClient, initializeLearningxClient, selectDefaultTerms, inspectSchoolVideoLaunch,
  prepareSchoolVideoCallbackBinding, createSchoolManualVideoReportController, observeSchoolManualVideoPlayback,
  reportSchoolManualVideoPlayback, closeSchoolManualVideoReportController, inspectSchoolManualVideoReportController,
  inspectSchoolVideoReportResponseFailure, createSchoolVideoPlaybackStartController, startSchoolVideoPlayback, closeSchoolVideoPlaybackStartController,
  SchoolError, type LearningxClient, type SchoolVideoLaunchData } from '@alms/ssu-api';
import { decryptSchoolSession, encryptSchoolSession } from './crypto.js';
import { withSchoolSessionLock } from './school-session-lock.js';
import { boundedWorkerOperation } from './worker-bounds.js';
import { AppError, notFound } from './errors.js';
import { projectLearningStatus } from './learning-status.js';
import type { PreparedPlaybackStart } from './playback-start-service.js';
import type { PreparedManualVideo } from './manual-video-types.js';
import type { PreparedVideoSource } from './video-stream.js';
import type { SchoolResult } from './domain.js';
import { playbackStartFailureDiagnostic, rememberPlaybackStartDiagnostic, type PlaybackStartFailureDiagnostic } from './playback-start-diagnostics.js';

const stored = z.object({ version: z.literal(1), generation: z.uuid(),
  identity: z.object({ studentId: z.string().regex(/^\d{6,12}$/) }).passthrough(), jar: z.unknown() }).passthrough();
export type SchoolVideoSessionStore = { getEncryptedSchoolSession(owner: string, provider: string): Promise<string | null>;
  replaceEncryptedSchoolSession(owner: string, provider: string, before: string, after: string): Promise<boolean> };
const changed = () => new AppError(409, 'SCHOOL_SESSION_CHANGED', '학교 인증이 변경됐습니다. 다시 확인해 주세요.');
const required = () => new AppError(401, 'SCHOOL_AUTH_REQUIRED', '학교 인증을 다시 확인해 주세요.');
type Session = z.infer<typeof stored>;
type Connection = { client: LearningxClient; http: SchoolHttpClient; session: Session; current: () => Promise<void> };

/** Fresh, account-scoped school preparation and reporting. Handles and URLs remain in this process only. */
export interface SchoolVideoTarget { owner: string; courseId: string; moduleItemId: string }
export interface PreparedSchoolVideo extends PreparedManualVideo {
  readonly durationSeconds: number;
  /** Separate explicit confirmation, never invoked by normal reports or workers. */
  confirmStart?: PreparedPlaybackStart['confirmStart'];
  /** Identity/claim proof survives close; a caller must still prove its current authority. */
  authority(validate: () => Promise<void>, signal: AbortSignal): Promise<{ generation: string; encryptedSession: string }>;
  readFresh(validate: () => Promise<void>, signal: AbortSignal): Promise<SchoolResult>;
  prepareMedia(validate: () => Promise<void>, signal: AbortSignal): Promise<PreparedVideoSource>;
}
export interface SchoolVideoSessions {
  prepare(context: SchoolVideoTarget, validate: () => Promise<void>, signal: AbortSignal, expectedGeneration?: string): Promise<PreparedSchoolVideo>;
}
export function createSchoolVideoSessions(store: SchoolVideoSessionStore, key: Buffer,
  invalidate: (owner: string, courseId: string, activityId: string) => Promise<void>, fetcher: typeof fetch = fetch,
  options: { allowReadystreamManual?: boolean } = {}): SchoolVideoSessions {
  const readSession = async (owner: string, signal: AbortSignal) => boundedWorkerOperation(async bounded => {
    const raw = await store.getEncryptedSchoolSession(owner, 'ssu'); bounded.throwIfAborted();
    if (!raw) throw required();
    try { return { raw, value: stored.parse(decryptSchoolSession(raw, key, owner, 'ssu')) }; }
    catch { throw required(); }
  }, { signal, timeoutMs: 5_000 });
  const sameSession = async (owner: string, expected: Session, signal: AbortSignal) => {
    const latest = await readSession(owner, signal);
    if (latest.value.generation !== expected.generation || latest.value.identity.studentId !== expected.identity.studentId) throw changed();
    return latest;
  };
  async function execute<T>(owner: string, expected: Session | undefined, validate: () => Promise<void>, signal: AbortSignal,
    run: (connection: Connection) => Promise<T>, expectedGeneration?: string): Promise<{ value: T; encrypted: string; session: Session }> {
    return withSchoolSessionLock(owner, async () => {
      signal.throwIfAborted(); await validate(); signal.throwIfAborted();
      const before = expected ? await sameSession(owner, expected, signal) : await readSession(owner, signal);
      if (expectedGeneration !== undefined && before.value.generation !== expectedGeneration) throw changed();
      const current = async () => { signal.throwIfAborted(); await validate(); await sameSession(owner, before.value, signal); signal.throwIfAborted(); };
      let requests = 0;
      const guardedFetch: typeof fetch = async (input, init) => {
        await current(); if (++requests > 24) throw new SchoolError('unsupported');
        const response = await fetcher(input, { ...init, signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]) });
        try { await current(); return response; }
        catch (error) { void response.body?.cancel().catch(() => {}); throw error; }
      };
      const http = SchoolHttpClient.fromSessionJar(before.value.jar, guardedFetch);
      try {
      const client = await initializeLearningxClient(http, before.value.identity.studentId); await current();
      const value = await run({ client, http, session: before.value, current }); await current();
      const encrypted = encryptSchoolSession({ ...before.value, jar: await http.jar.serialize() }, key, owner, 'ssu');
      await boundedWorkerOperation(async bounded => {
        bounded.throwIfAborted();
        if (!await store.replaceEncryptedSchoolSession(owner, 'ssu', before.raw, encrypted)) throw changed();
        bounded.throwIfAborted();
      }, { signal, timeoutMs: 5_000 });
      await current(); return { value, encrypted, session: before.value };
      } catch (error) {
        // SDK HTTP normalization must not hide a concurrent ALMS logout or school generation change.
        await current(); throw error;
      }
    });
  }
  async function ownedLaunch(connection: Connection, courseId: string, activityId: string, signal: AbortSignal,
    mark?: (stage: VideoReportPreparationStage) => void) {
    mark?.('identity');
    const { client, http } = connection, profile = (await http.readLearningStatusJson('https://canvas.ssu.ac.kr/api/v1/users/self/profile', signal)).value;
    const identity = z.object({ id: z.union([z.string(), z.number()]).transform(String), login_id: z.string() }).parse(profile);
    if (client.bootstrap.role !== 1 || identity.id !== client.bootstrap.userId || identity.login_id !== client.bootstrap.userLogin) throw new SchoolError('identity_mismatch');
    mark?.('enrollment');
    const terms = await client.terms(), selected = selectDefaultTerms(terms);
    if (terms.length > 30 || new Set(terms.map(term => term.id)).size !== terms.length || !selected.length) throw new SchoolError('unsupported');
    const courses = await client.courses(selected.map(term => term.id));
    if (courses.length > 100 || new Set(courses.map(course => course.id)).size !== courses.length
      || courses.some(course => !selected.some(term => term.id === course.termId))) throw new SchoolError('unexpected_response');
    if (!courses.some(course => course.id === courseId)) throw notFound();
    mark?.('launch');
    const launch = await client.moduleActivityVideoLaunch(courseId, activityId), data = inspectSchoolVideoLaunch(launch);
    if (data.detail.courseId !== courseId || data.detail.moduleItemId !== activityId || data.detail.published !== true
      || data.detail.opened !== true || data.detail.omitProgress !== false || typeof data.detail.useAttendance !== 'boolean') throw new SchoolError('unsupported');
    if (data.contentType === 'readystream' && courses.find(course => course.id === courseId)?.usePureCanvas !== true) throw new SchoolError('unsupported');
    await connection.current(); return { launch, data, login: identity.login_id, userId: identity.id };
  }
  const sameLaunch = (left: SchoolVideoLaunchData, right: SchoolVideoLaunchData) => {
    const a = left.detail, b = right.detail;
    return left.contentId === right.contentId && left.contentType === right.contentType && a.courseId === b.courseId
      && a.moduleItemId === b.moduleItemId && a.itemId === b.itemId && a.durationSeconds === b.durationSeconds
      && a.useAttendance === b.useAttendance && b.published === true && b.opened === true && b.omitProgress === false
      && new URL(left.viewerUrl).searchParams.get('TargetUrl') === new URL(right.viewerUrl).searchParams.get('TargetUrl');
  };
  return { prepare: async (context, validate, signal, expectedGeneration) => {
    const prepared = await execute(context.owner, undefined, validate, signal,
      connection => ownedLaunch(connection, context.courseId, context.moduleItemId, signal), expectedGeneration);
    signal.throwIfAborted();
    if (prepared.value.data.contentType === 'readystream' && options.allowReadystreamManual !== true) throw new SchoolError('unsupported');
    const lifetime = new AbortController();
    let original = prepared.value;
    const currentPrepared = async () => { signal.throwIfAborted(); await validate(); await sameSession(context.owner, prepared.session, signal); signal.throwIfAborted(); };
    // Readystream's SDK proof belongs to this exact opaque launch, before any callback/controller exists.
    const initialMedia = original.data.contentType === 'readystream'
      ? await verifiedVideoMedia(context.owner, prepared.session.generation, original.launch, currentPrepared, signal, fetcher) : null;
    if (initialMedia) original = { ...original, launch: initialMedia.launch, data: inspectSchoolVideoLaunch(initialMedia.launch) };
    let knownSchoolProgress = original.data.detail.attendance.progressSeconds;
    let lastPosition: number | null = null, observationState: VideoReportContext['observationState'] = 'missing',
      positionDelta: VideoReportContext['positionDelta'] = 'unknown';
    let startConsumed = false;
    let active: { connection: Connection; validate: () => Promise<void>; signal: AbortSignal } | null = null, reporting = false;
    const binding = prepareSchoolVideoCallbackBinding(original.launch, original.login);
    const controller = createSchoolManualVideoReportController(binding, {
      signal: lifetime.signal,
      validateCurrent: async sdkSignal => {
        if (!active) throw new SchoolError('unsupported'); sdkSignal.throwIfAborted(); active.signal.throwIfAborted();
        await active.validate(); await active.connection.current(); sdkSignal.throwIfAborted();
      },
      readFresh: async sdkSignal => {
        if (!active) throw new SchoolError('unsupported');
        return active.connection.client.moduleLearningStatus(context.courseId, context.moduleItemId, AbortSignal.any([sdkSignal, active.signal]));
      },
    });
    const inspectedController = inspectSchoolManualVideoReportController(controller);
    const observationTiming = 'observationTiming' in inspectedController && inspectedController.observationTiming === 'client_monotonic_v1'
      ? 'client_monotonic_v1' as const : undefined;
    return { generation: prepared.session.generation, encryptedSession: prepared.encrypted, baseline: original.data.detail.attendance.progressSeconds!, durationSeconds: original.data.detail.durationSeconds!,
      ...(observationTiming ? { observationTiming } : {}),
      validate: async currentSignal => { await sameSession(context.owner, prepared.session, currentSignal); },
      authority: async (validate, currentSignal) => {
        currentSignal.throwIfAborted(); await validate();
        const latest = await sameSession(context.owner, prepared.session, currentSignal);
        await validate(); currentSignal.throwIfAborted();
        return { generation: latest.value.generation, encryptedSession: latest.raw };
      },
      readFresh: async (validate, currentSignal) => {
        const result = await execute(context.owner, prepared.session, validate, currentSignal, async connection => {
          const fresh = await ownedLaunch(connection, context.courseId, context.moduleItemId, currentSignal);
          if (fresh.login !== original.login || fresh.userId !== original.userId || !sameLaunch(original.data, fresh.data)) throw new SchoolError('forbidden_target');
          return projectLearningStatus(await connection.client.moduleLearningStatus(context.courseId, context.moduleItemId, currentSignal), context.courseId, context.moduleItemId);
        });
        return result.value;
      },
      prepareMedia: async (validate, currentSignal) => {
        lifetime.signal.throwIfAborted();
        const combined = AbortSignal.any([currentSignal, lifetime.signal]);
        const current = async () => { combined.throwIfAborted(); await validate(); await sameSession(context.owner, prepared.session, combined); combined.throwIfAborted(); };
        await current();
        const resolved = initialMedia ?? await verifiedVideoMedia(context.owner, prepared.session.generation,
          original.launch, current, combined, fetcher);
        await current();
        return { contentId: resolved.media.contentId, mediaUrl: resolved.media.mediaUrl, validate: current,
          ...(resolved.media.detail.resourceType === 'readystream' ? { resourceType: 'readystream' as const } : {}) };
      },
      confirmStart: async (observation, validate, currentSignal) => {
        if (startConsumed || reporting || lifetime.signal.aborted) throw new SchoolError('unsupported');
        startConsumed = true;
        let mayHaveWritten = false;
        let transmissionDiagnostic: PlaybackStartFailureDiagnostic | undefined;
        let startStage: PlaybackStartFailureDiagnostic['stage'] = 'validation';
        const combined = AbortSignal.any([currentSignal, lifetime.signal]);
        try {
          const result = await execute(context.owner, prepared.session, validate, combined, async connection => {
            const fresh = await ownedLaunch(connection, context.courseId, context.moduleItemId, combined);
            if (fresh.login !== original.login || fresh.userId !== original.userId || !sameLaunch(original.data, fresh.data)) throw new SchoolError('forbidden_target');
            const verifiedStart = fresh.data.contentType === 'readystream'
              ? await verifiedVideoMedia(context.owner, prepared.session.generation, fresh.launch, connection.current, combined, fetcher) : null;
            await connection.current();
            const start = createSchoolVideoPlaybackStartController(prepareSchoolVideoCallbackBinding(verifiedStart?.launch ?? fresh.launch, fresh.login), {
              confirmation: 'user_confirmed', observation, signal: combined,
              validateCurrent: async sdkSignal => { sdkSignal.throwIfAborted(); await connection.current(); sdkSignal.throwIfAborted(); },
              readFresh: sdkSignal => connection.client.moduleLearningStatus(context.courseId, context.moduleItemId, AbortSignal.any([combined, sdkSignal])),
            });
            try {
              const result = await startSchoolVideoPlayback(start, { startVideoPlayback: async (request, sdkSignal) => {
                startStage = 'transmission';
                mayHaveWritten = true;
                try { return await connection.http.startVideoPlayback(request, sdkSignal); }
                catch (error) { transmissionDiagnostic = playbackStartFailureDiagnostic(error, 'transmission', true); throw error; }
              } });
              startStage = 'refresh';
              const returned = { transport: result.transport, school: projectLearningStatus(result.school, context.courseId, context.moduleItemId) };
              if (result.transport === 'unknown') rememberPlaybackStartDiagnostic(returned,
                transmissionDiagnostic ?? playbackStartFailureDiagnostic(undefined, 'transmission', mayHaveWritten));
              return returned;
            } finally { closeSchoolVideoPlaybackStartController(start); }
          });
          return result.value;
        } catch (error) {
          rememberPlaybackStartDiagnostic(error, transmissionDiagnostic ?? playbackStartFailureDiagnostic(error, startStage, mayHaveWritten)); throw error;
        } finally {
          // Invalidation takes the owner lock, so it follows execute's release.
          if (mayHaveWritten) try { await boundedWorkerOperation(() => invalidate(context.owner, context.courseId, context.moduleItemId), { timeoutMs: 5_000 }); }
          catch (error) {
            rememberPlaybackStartDiagnostic(error, transmissionDiagnostic ?? playbackStartFailureDiagnostic(error, 'refresh', true)); throw error;
          }
        }
      },
      observe: value => {
        observeSchoolManualVideoPlayback(controller, value);
        positionDelta = lastPosition === null ? 'unknown' : value.positionSeconds === lastPosition ? 'unchanged'
          : value.positionSeconds > lastPosition ? 'advanced' : 'regressed';
        lastPosition = value.positionSeconds;
        observationState = value.ended ? 'ended' : value.paused ? 'paused' : 'playing';
      },
      report: async (event, current, reportSignal) => {
        let stage: VideoReportPreparationStage = 'guard', mayHaveWritten = false;
        const snapshot = (): VideoReportContext => {
          const state = inspectSchoolManualVideoReportController(controller);
          return { event, controllerPhase: state.phase, controllerAttempt: state.attempts === 0 ? 'none' : 'previous', observationState, positionDelta };
        };
        let reportContext = snapshot();
        if (reporting || lifetime.signal.aborted || reportContext.controllerPhase !== 'ready') {
          const error = new SchoolError('unsupported'); rememberVideoReportPreparation(error, stage, false, reportContext); throw error;
        }
        reporting = true;
        let invalidateRequired = false;
        try {
          stage = 'session';
          const value = await execute(context.owner, prepared.session, current, AbortSignal.any([reportSignal, lifetime.signal]), async connection => {
            const fresh = await ownedLaunch(connection, context.courseId, context.moduleItemId, reportSignal, value => { stage = value; });
            stage = 'target';
            if (fresh.login !== original.login || fresh.userId !== original.userId || !sameLaunch(original.data, fresh.data)) throw new SchoolError('forbidden_target');
            // A native player is outside our ALMS lease. Do not send an old cumulative baseline
            // after another school observation changed it; delayed visibility is not retried either.
            stage = 'baseline';
            if (fresh.data.detail.attendance.progressSeconds !== knownSchoolProgress) {
              invalidateRequired = true;
              throw new AppError(409, 'PLAYBACK_OBSERVATION_INVALID', '학교 진도가 변경됐습니다. 학교 결과를 확인한 뒤 다시 재생해 주세요.');
            }
            // No owner lock spans playback. A report restores the latest jar and owns it only through its fresh read/CAS.
            active = { connection, validate: current, signal: reportSignal };
            try {
              stage = 'manual_event'; reportContext = snapshot();
              const transmissionDiagnostic: { code: ReturnType<typeof videoReportDiagnostic>['code'] | 'none';
                response: ReturnType<typeof inspectSchoolVideoReportResponseFailure> } = { code: 'none', response: null };
              const result = await reportSchoolManualVideoPlayback(controller, event, {
                forwardVideoReport: async (request, sdkSignal) => { mayHaveWritten = true; invalidateRequired = true;
                  try { return await connection.http.forwardVideoReport(request, sdkSignal); }
                  catch (error) { transmissionDiagnostic.code = videoReportDiagnostic(error).code;
                    transmissionDiagnostic.response = inspectSchoolVideoReportResponseFailure(error); throw error; } },
              });
              stage = 'post_report';
              if (result.transport === 'acknowledged') knownSchoolProgress = result.school.progressSeconds;
              const returned = { transport: result.transport, school: projectLearningStatus(result.school, context.courseId, context.moduleItemId),
                state: inspectSchoolManualVideoReportController(controller).phase === 'ready' ? 'ready' as const : 'closed' as const };
              rememberVideoReportResult(returned, { controllerPhase: inspectSchoolManualVideoReportController(controller).phase,
                transmissionCode: result.transport === 'acknowledged' ? 'none' : transmissionDiagnostic.code === 'none' ? 'unknown' : transmissionDiagnostic.code,
                publishedStillTrue: result.school.published === true, openedStillTrue: result.school.opened === true,
                omitProgressStillFalse: result.school.omitProgress === false,
                durationExactlyMatches: result.school.durationSeconds === original.data.detail.durationSeconds,
                ...(result.transport === 'unknown' && transmissionDiagnostic.response ? { responseFailure: transmissionDiagnostic.response.kind } : {}) });
              return returned;
            } finally { active = null; }
          });
          return value.value;
        } catch (error) {
          rememberVideoReportPreparation(error, stage, mayHaveWritten, reportContext); throw error;
        } finally {
          // Run outside the school owner lock: the reader's invalidation acquires that same lock.
          try { if (invalidateRequired) await boundedWorkerOperation(() => invalidate(context.owner, context.courseId, context.moduleItemId), { timeoutMs: 5_000 }); }
          catch (error) { rememberVideoReportPreparation(error, 'cache_invalidation', mayHaveWritten, reportContext); throw error; }
          finally { reporting = false; }
        }
      },
      close: () => { lifetime.abort(); closeSchoolManualVideoReportController(controller); },
    };
  } };
}
