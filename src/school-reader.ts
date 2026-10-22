import { createVerifiedVideoMediaCache, verifiedVideoMedia } from './verified-video-media.js';
import { progressCacheResources, type ProgressCacheTarget } from './school-progress-cache.js';
import { createAssignmentFileCache, publicAssignmentFile, type AssignmentFileData } from './assignment-files.js';
import { randomUUID } from 'node:crypto';
import { assignmentId, assignmentCourseContext, publicAssignments, publicAssignmentDetail } from './assignments.js';
import { assignmentReadFailureDiagnostic, rememberAssignmentReadFailure, type AssignmentReadTrace } from './assignment-read-diagnostics.js';
import { assignmentAttemptKey, assignmentHistoryAttemptHandle, bindAssignmentHistory, publicAssignmentHistory, type AssignmentHistoryData } from './assignment-history.js';
import { projectLearningStatus } from './learning-status.js';
import { calendarQuery, publicCalendar, calendarMatchesCatalog, type CalendarData } from './calendar.js';
import { SchoolHttpClient, initializeLearningxClient, selectDefaultTerms, type LearningxClient, SchoolError,
  inspectSchoolVideoLaunch, resolveSchoolVideoMedia, inspectSchoolVideoMedia, createSchoolMaterialPageCountCache, type SchoolSyllabusRenderLaunch, inspectSchoolSyllabusRenderLaunch } from '@alms/ssu-api';
import { createSyllabusCache } from './syllabus-cache.js';
import { type SyllabusRenderInput, type SyllabusAuthCheck } from './syllabus-runtime.js';
import { z } from 'zod';
import type { SchoolResult } from './domain.js';
import { boundedWorkerOperation } from './worker-bounds.js';
import { withSchoolSessionLock } from './school-session-lock.js';
import { decryptSchoolSession, encryptSchoolSession } from './crypto.js';
import { AppError, notFound } from './errors.js';
import type { AuthenticatedSchoolSessionSnapshot } from './store.js';
import { createMaterialByteCache, isMaterialViewer, type MaterialLoader } from './material-cache.js';
import { schoolCacheTtl, type SchoolReadCache } from './school-read-cache.js';
import { createVideoStreamer, type VideoRequest } from './video-stream.js';
import { publicCourse, publicTaskCatalog, normalizeSchoolReadError, type TasksRead, type CalendarRead, type LearningxReader, type Catalog, type CourseTerm, type AttendanceRead, type CourseRead, type ActivityRead, type MaterialViewRead, type Course } from './school-read.js';
import type { MaterialViewObservation, SyllabusReadOptions, AssignmentReadOptions, TasksReadOptions } from './provider.js';
import { materialViewFailureDiagnostic, rememberMaterialViewFailure, type MaterialViewFailureDiagnostic,
  type MaterialViewFailureStage } from './material-view-diagnostics.js';

const storedSession = z.object({ version: z.literal(1), generation: z.uuid().optional(), identity: z.object({ studentId: z.string().regex(/^\d{6,12}$/) }).passthrough(), jar: z.unknown() }).passthrough();
type SessionStore = {
  getEncryptedSchoolSession(userId: string, provider: string): Promise<string | null>;
  getAuthenticatedSchoolSession?(userId: string, provider: string, tokenHash: string): Promise<AuthenticatedSchoolSessionSnapshot>;
  replaceEncryptedSchoolSession(userId: string, provider: string, previous: string, next: string): Promise<boolean>;
};
type Connection = { client: LearningxClient; serialize: () => Promise<unknown>; readSyllabusAuthCheck?: SyllabusAuthCheck; verifyVideoIdentity?: () => Promise<void> };
type Connector = (session: z.infer<typeof storedSession>, signal?: AbortSignal) => Promise<Connection>;
type MaterialReporter = (client: LearningxClient, courseId: string, moduleItemId: string,
  observation: MaterialViewObservation, beforeWrite: () => Promise<void>) =>
  Promise<{ detail: ActivityRead['detail']; report: MaterialViewRead['report'] }>;
// Only anonymous manifest page counts are shared; school callback and user progress stay request-scoped.
const materialPageCounts = createSchoolMaterialPageCountCache();
const reportMaterial: MaterialReporter = (client, courseId, moduleItemId, observation, beforeWrite) =>
  client.acknowledgeMaterialView(courseId, moduleItemId, observation, { beforeWrite, pageCountCache: materialPageCounts });
const open: Connector = async (session, signal) => {
  const scopedFetch: typeof fetch | undefined = signal ? async (input, init) => {
    signal.throwIfAborted();
    const response = await fetch(input, { ...init, signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]) });
    if (signal.aborted) { void response.body?.cancel().catch(() => {}); signal.throwIfAborted(); }
    return response;
  } : undefined;
  const http = SchoolHttpClient.fromSessionJar(session.jar, scopedFetch);
  const client = await initializeLearningxClient(http, session.identity.studentId);
  return { client, serialize: () => http.jar.serialize(), verifyVideoIdentity: async () => {
    const profile = (await http.readLearningStatusJson('https://canvas.ssu.ac.kr/api/v1/users/self/profile', signal ?? AbortSignal.timeout(15_000))).value;
    const native = z.object({ id: z.union([z.string(), z.number()]).transform(String), login_id: z.string() }).parse(profile);
    if (client.bootstrap.role !== 1 || native.id !== client.bootstrap.userId || native.login_id !== client.bootstrap.userLogin
      || native.login_id !== session.identity.studentId) throw new SchoolError('identity_mismatch');
  }, readSyllabusAuthCheck: (plan, url, signal) => http.readSyllabusRenderAuthCheck(plan, url, signal) };
};

/** Cancel the caller's wait without releasing a still-running owner lock. That operation checks abort before each next step. */
type ReadAbortKind = 'syllabus' | 'calendar' | 'tasks' | 'assignment' | 'verification';
function abortableRead<T>(pending: Promise<T>, signal?: AbortSignal, kind: ReadAbortKind = 'syllabus'): Promise<T> {
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(kind === 'verification' ? new AppError(503, 'SCHOOL_RESULT_UNAVAILABLE', '학교 결과 조회가 중단됐습니다. 다시 시도해 주세요.')
      : kind === 'assignment' ? new AppError(503, 'ASSIGNMENTS_UNAVAILABLE', '과제를 불러오지 못했습니다. 다시 시도해 주세요.')
      : kind === 'calendar' ? new AppError(503, 'CALENDAR_UNAVAILABLE', '캘린더 조회가 중단됐습니다. 다시 시도해 주세요.')
      : kind === 'tasks' ? new AppError(503, 'SCHOOL_PROVIDER_UNAVAILABLE', '할 일 조회가 중단됐습니다. 다시 시도해 주세요.')
      : new AppError(503, 'SYLLABUS_UNAVAILABLE', '강의계획서 조회가 중단됐습니다. 다시 시도해 주세요.'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    void pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** A request owns its client until all school reads and the final session CAS finish. */
export function createLearningxReader(store: SessionStore, key: Buffer, connect: Connector = open, loadMaterial?: MaterialLoader, durable?: SchoolReadCache,
  videoOperations = { resolve: resolveSchoolVideoMedia, inspect: inspectSchoolVideoMedia, stream: createVideoStreamer() },
  materialReporter: MaterialReporter | null = reportMaterial,
  renderSyllabus: ((input: SyllabusRenderInput, signal: AbortSignal) => Promise<{ bytes: Uint8Array; pageCount: number }>) | null = null): LearningxReader & { invalidate(owner: string, courseId?: string, moduleItemId?: string): Promise<void>; invalidateActivities(owner: string, targets: readonly ProgressCacheTarget[], signal: AbortSignal): Promise<void> } {
  type Cached = { expiresAt: number; value: unknown };
  type OwnerCache = { generation: string; values: Map<string, Cached> };
  const cache = new Map<string, OwnerCache>();
  const pending = new Map<string, Map<string, Promise<unknown>>>();
  type Warmup = { generation: string; courseId: string; items: string[] };
  const warmups = new Map<string, Warmup>();
  const warming = new Set<string>();
  const viewPending = new Map<string, Map<string, Promise<MaterialViewRead>>>();
  const viewLimits = new Map<string, { start: number; count: number }>();
  const ttl = 30_000;
  const resolveVideo = videoOperations.resolve === resolveSchoolVideoMedia && videoOperations.inspect === inspectSchoolVideoMedia
    ? verifiedVideoMedia : createVerifiedVideoMediaCache(videoOperations);
  const materialBytes = createMaterialByteCache(loadMaterial);
  const syllabusBytes = createSyllabusCache();
  const assignmentFiles = createAssignmentFileCache();
  // Object and caller signal bind a one-use cache refresh proof to the exact fresh read.
  // Neither this metadata nor the school jar enters the public result or durable cache.
  const learningProofs = new WeakMap<SchoolResult, { owner: string; generation: string; courseId: string; moduleItemId: string; signal: AbortSignal | undefined; expiresAt: number }>();
  const taskProofs = new WeakMap<TasksRead, { owner: string; generation: string; expiresAt: number }>();
  const calendarProofs = new WeakMap<CalendarRead, { owner: string; generation: string; expiresAt: number }>();
  type CalendarSnapshot = { data: CalendarData; mappingGeneration: string };
  class WarmupCancelled extends AppError {
    constructor() { super(409, 'SCHOOL_SESSION_CHANGED', '학교 세션이 갱신됐습니다. 다시 조회해 주세요.'); }
  }

  function remember(owner: string, generation: string, values: Array<[string, unknown]>, expiresAt = Date.now() + ttl) {
    for (const [id, entry] of cache) {
      for (const [resource, value] of entry.values) if (value.expiresAt <= Date.now()) entry.values.delete(resource);
      if (!entry.values.size) cache.delete(id);
    }
    if (!cache.has(owner) && cache.size >= 100) cache.delete(cache.keys().next().value!);
    const existing = cache.get(owner);
    const entry = existing?.generation === generation ? existing : { generation, values: new Map<string, Cached>() };
    for (const [resource, value] of values) {
      if (!entry.values.has(resource) && entry.values.size >= 50) {
        const oldest = [...entry.values.keys()].find(key => key !== 'catalog' && key !== 'catalog:terms');
        if (oldest) entry.values.delete(oldest);
      }
      entry.values.set(resource, { expiresAt: Math.min(Date.now() + ttl, expiresAt), value });
    }
    cache.set(owner, entry);
  }

  type CatalogSelection = 'default' | 'all' | 'terms' | { termId: string };
  const courseCompatible = (value: unknown): value is Course => {
    const course = value as Course | null;
    return Boolean(course && typeof course.termId === 'string' && typeof course.schoolDefaultTerm === 'boolean'
      && (course.ended === null || typeof course.ended === 'boolean'));
  };
  const catalogCompatible = (value: unknown): value is Catalog => {
    const catalog = value as Catalog | null;
    return Boolean(catalog && Array.isArray(catalog.terms) && Object.hasOwn(catalog, 'defaultTermId')
      && Array.isArray(catalog.courses) && catalog.courses.every(courseCompatible)
      && catalog.commonsModes && catalog.courses.every(course => Object.hasOwn(catalog.commonsModes!, course.id)
        && (catalog.commonsModes![course.id] === null || typeof catalog.commonsModes![course.id] === 'boolean')));
  };
  const cachedCompatible = (resource: string, value: unknown) => {
    if (resource === 'catalog' || resource.startsWith('catalog:')) return catalogCompatible(value);
    if (resource === 'tasks') {
      const tasks = value as TasksRead | null;
      return Boolean(tasks && tasks.taskMappingVersion === 4 && catalogCompatible(tasks.catalog) && typeof tasks.mappingGeneration === 'string');
    }
    if (resource.startsWith('calendar:v3:')) {
      const calendar = value as CalendarSnapshot | null;
      return Boolean(calendar && typeof calendar.mappingGeneration === 'string' && calendar.data);
    }
    if (resource.startsWith('calendar-modules:')) {
      const course = value as CourseRead | null;
      return Boolean(course && courseCompatible(course.course) && course.assignmentMappingVersion === 1
        && course.commonsMappingVersion === 3 && (course.usePureCanvas === null || typeof course.usePureCanvas === 'boolean')
        && Array.isArray(course.modules));
    }
    if (!resource.startsWith('course:') && !resource.startsWith('activity:')) return true;
    return Boolean(value && typeof value === 'object' && courseCompatible((value as CourseRead).course)
      && (!resource.startsWith('course:') || Object.hasOwn(value, 'lessons') && (value as CourseRead).assignmentMappingVersion === 1
        && (value as CourseRead).commonsMappingVersion === 3
        && ((value as CourseRead).usePureCanvas === null || typeof (value as CourseRead).usePureCanvas === 'boolean')));
  };
  function execute<T>(owner: string, resource: string, run: (client: LearningxClient, catalog: Catalog, generation: string, validate: () => Promise<void>, connection: Connection) => Promise<T>, expectedGeneration?: string, transient = false, fresh = false, signal?: AbortSignal, validateCached?: (value: T, catalog: Catalog) => boolean, abortKind: ReadAbortKind = validateCached ? 'calendar' : 'syllabus', selection?: CatalogSelection, assignmentTrace?: AssignmentReadTrace): Promise<T> {
    // Explicit course reads include previously enrolled terms; the dashboard/TODO default stays current.
    const selectedCatalog = selection ?? (/^(?:course|activity|video|assignments?|attendance|learning-status|syllabus-owner|syllabus-launch):/.test(resource) ? 'all' : 'default');
    let catalogResource = typeof selectedCatalog === 'object' ? `catalog:term:${selectedCatalog.termId}`
      : selectedCatalog === 'default' ? 'catalog' : `catalog:${selectedCatalog}`;
    const active = transient || fresh || validateCached ? undefined : pending.get(owner)?.get(resource);
    if (active) return active as Promise<T>;
    const result = abortableRead(withSchoolSessionLock(owner, async () => {
      signal?.throwIfAborted();
      const encrypted = await store.getEncryptedSchoolSession(owner, 'ssu');
      signal?.throwIfAborted();
      if (!encrypted) throw new AppError(401, 'SCHOOL_AUTH_REQUIRED', '학교 로그인이 필요합니다.');
      let session: z.infer<typeof storedSession>;
      try { session = storedSession.parse(decryptSchoolSession(encrypted, key, owner, 'ssu')); }
      catch { throw new AppError(401, 'SCHOOL_AUTH_REQUIRED', '저장된 학교 세션을 확인할 수 없습니다. 다시 로그인해 주세요.'); }
      const generation = session.generation ?? randomUUID();
      const currentSession = async (expected: string) => {
        if (await store.getEncryptedSchoolSession(owner, 'ssu') !== expected)
          throw new AppError(409, 'SCHOOL_SESSION_CHANGED', '학교 세션이 갱신됐습니다. 다시 조회해 주세요.');
      };
      const scope = (name: string, encryptedSession = encrypted) => ({ owner, provider: 'ssu', generation, resource: name, encryptedSession });
      if (expectedGeneration && generation !== expectedGeneration) throw new WarmupCancelled();
      const existing = cache.get(owner);
      const valid = session.generation && existing?.generation === session.generation ? existing : undefined;
      let cached = transient || fresh ? undefined : valid?.values.get(resource);
      if (cached && !cachedCompatible(resource, cached.value)) cached = undefined;
      if (cached && cached.expiresAt > Date.now() && !validateCached) { await currentSession(encrypted); return cached.value as T; }
      if (!transient && !fresh && (!cached || cached.expiresAt <= Date.now()) && session.generation && durable) {
        const persisted = await durable.get<T>(scope(resource)).catch(() => null);
        if (persisted && persisted.expiresAt > Date.now() && cachedCompatible(resource, persisted.value)) {
          if (!validateCached) {
            await currentSession(encrypted);
            remember(owner, generation, [[resource, persisted.value]], persisted.expiresAt);
            return persisted.value;
          }
          cached = persisted;
        }
      }

      // Assignment methods recheck native self and fresh all-term enrollment inside the SDK.
      // Reuse only this owner's current-generation, unexpired catalog for display context;
      // a cold assignment must not duplicate the SDK's terms/courses GETs first.
      let assignmentCatalog: Cached | undefined;
      if (!fresh && abortKind === 'assignment' && validateCached && selectedCatalog === 'all') {
        const liveCatalog = (entry: Cached | undefined) => entry && entry.expiresAt > Date.now() && catalogCompatible(entry.value);
        const targetCourse = resource.split(':')[1];
        const exactTarget = (entry: Cached | undefined) => liveCatalog(entry)
          && (entry!.value as Catalog).courses.filter(course => course.id === targetCourse).length === 1;
        assignmentCatalog = valid?.values.get(catalogResource);
        if (!exactTarget(assignmentCatalog) && session.generation && durable)
          assignmentCatalog = await durable.get<Catalog>(scope(catalogResource)).catch(() => null) ?? undefined;
        if (!exactTarget(assignmentCatalog)) {
          assignmentCatalog = undefined;
          let current = valid?.values.get('catalog');
          let currentResource = 'catalog';
          if (!exactTarget(current)) {
            const selected = [...(valid?.values.entries() ?? [])].find(([name, entry]) => name.startsWith('catalog:term:') && exactTarget(entry));
            current = selected?.[1]; currentResource = selected?.[0] ?? 'catalog';
          }
          if (!exactTarget(current) && session.generation && durable) {
            current = await durable.get<Catalog>(scope('catalog')).catch(() => null) ?? undefined;
            currentResource = 'catalog';
          }
          if (exactTarget(current)) { assignmentCatalog = current; catalogResource = currentResource; }
        }
      }

      // A thirty-second read result already contains an owned catalog proof. Recheck the
      // exact session/generation and that proof, rather than bootstrap the school on each hit.
      // Misses/explicit refresh below still obtain fresh native identity and enrollment.
      if (!transient && !fresh && cached && cached.expiresAt > Date.now() && validateCached) {
        if (assignmentTrace) assignmentTrace.stage = 'cache_proof';
        let proof = assignmentCatalog ?? valid?.values.get(catalogResource);
        if ((!proof || proof.expiresAt <= Date.now() || !catalogCompatible(proof.value)) && session.generation && durable)
          proof = await durable.get<Catalog>(scope(catalogResource)).catch(() => null) ?? undefined;
        if (proof && proof.expiresAt > Date.now() && catalogCompatible(proof.value) && validateCached(cached.value as T, proof.value)) {
          if (assignmentTrace) assignmentTrace.stage = 'final_session';
          await currentSession(encrypted); signal?.throwIfAborted();
          remember(owner, generation, [[resource, cached.value], [catalogResource, proof.value]], Math.min(cached.expiresAt, proof.expiresAt));
          return cached.value as T;
        }
      }

      // Restore the latest stored jar, including a Saint refresh. Never reuse a cached client.
      let cachedCatalog = assignmentCatalog ?? (fresh || validateCached ? undefined : valid?.values.get(catalogResource));
      if (cachedCatalog && !catalogCompatible(cachedCatalog.value)) cachedCatalog = undefined;
      // A current course already proven by the dashboard does not need another all-term catalog request.
      // This optimization is unavailable for fresh proof and never authorizes a missing/past target.
      if (!fresh && !validateCached && selectedCatalog === 'all' && (!cachedCatalog || cachedCatalog.expiresAt <= Date.now())) {
        const targetCourse = resource.split(':')[1];
        let current = valid?.values.get('catalog');
        if (!current || current.expiresAt <= Date.now() || !catalogCompatible(current.value) || !current.value.courses.some(course => course.id === targetCourse))
          current = [...(valid?.values.entries() ?? [])].find(([name, item]) => name.startsWith('catalog:term:')
            && item.expiresAt > Date.now() && catalogCompatible(item.value) && item.value.courses.some(course => course.id === targetCourse))?.[1];
        if ((!current || current.expiresAt <= Date.now()) && session.generation && durable)
          current = await durable.get<Catalog>(scope('catalog')).catch(() => null) ?? undefined;
        if (current && current.expiresAt > Date.now() && catalogCompatible(current.value) && current.value.courses.some(course => course.id === targetCourse)) {
          cachedCatalog = current; catalogResource = (current.value as Catalog).termIds.length === 1
            && !(current.value as Catalog).courses.some(course => course.schoolDefaultTerm === true)
            ? `catalog:term:${(current.value as Catalog).termIds[0]}` : 'catalog';
        }
      }
      if (!fresh && !validateCached && (!cachedCatalog || cachedCatalog.expiresAt <= Date.now()) && session.generation && durable) {
        const persisted = await durable.get<Catalog>(scope(catalogResource)).catch(() => null);
        if (persisted && persisted.expiresAt > Date.now() && catalogCompatible(persisted.value)) cachedCatalog = persisted;
      }
      signal?.throwIfAborted();
      if (assignmentTrace) assignmentTrace.stage = 'owned_catalog';
      const connection = await connect(session, signal);
      signal?.throwIfAborted();
      let catalog: Catalog;
      if (cachedCatalog && cachedCatalog.expiresAt > Date.now()) catalog = cachedCatalog.value as Catalog;
      else {
        const terms = await connection.client.terms();
        signal?.throwIfAborted();
        if (terms.length > 30 || new Set(terms.map(term => term.id)).size !== terms.length) throw new SchoolError('unexpected_response');
        const defaults = selectDefaultTerms(terms);
        const selected = typeof selectedCatalog === 'object' ? terms.filter(term => term.id === selectedCatalog.termId)
          : selectedCatalog === 'terms' ? [] : selectedCatalog === 'all' ? terms : defaults;
        if (typeof selectedCatalog === 'object' && !selected.length) throw notFound();
        const termIds = selected.map(term => term.id);
        const termNames = new Map(terms.map(term => [term.id, term.name]));
        const courses = termIds.length ? await connection.client.courses(termIds) : [];
        signal?.throwIfAborted();
        if (courses.length > (selectedCatalog === 'all' ? 3_000 : 100) || new Set(courses.map(course => course.id)).size !== courses.length
          || courses.some(course => !termIds.includes(course.termId))) throw new SchoolError('unexpected_response');
        const termItems: CourseTerm[] = terms.map(term => {
          const year = /(?:^|\D)(20\d{2})(?:\D|$)/.exec(term.name)?.[1];
          return { id: term.id, label: term.name, year: year ? Number(year) : null, current: defaults.some(value => value.id === term.id) };
        });
        catalog = { courses: courses.map(row => publicCourse(row, termNames, new Set(defaults.map(term => term.id)))), termIds,
          commonsModes: Object.fromEntries(courses.map(row => [row.id, typeof row.usePureCanvas === 'boolean' ? row.usePureCanvas : null])),
          term: selected.length === 1 ? selected[0]!.name : null,
          terms: termItems, defaultTermId: defaults.length === 1 ? defaults[0]!.id : null };
      }
      if (assignmentTrace && cached && cached.expiresAt > Date.now() && validateCached) assignmentTrace.stage = 'cache_proof';
      const reused = cached && cached.expiresAt > Date.now() && validateCached?.(cached.value as T, catalog) ? cached : undefined;
      const value = reused ? reused.value as T : await run(connection.client, catalog, generation, () => currentSession(encrypted), connection);
      if (assignmentTrace) assignmentTrace.stage = 'final_session';
      signal?.throwIfAborted();
      const serialized = await connection.serialize();
      signal?.throwIfAborted();
      const updated = encryptSchoolSession({ ...session, generation, jar: serialized }, key, owner, 'ssu');
      if (!await store.replaceEncryptedSchoolSession(owner, 'ssu', encrypted, updated)) {
        throw new AppError(409, 'SCHOOL_SESSION_CHANGED', '학교 세션이 갱신됐습니다. 다시 조회해 주세요.');
      }
      signal?.throwIfAborted();
      // Publish neither data nor jar from a read that lost a race with a new login.
      // Opaque handles never enter this display cache or durable storage.
      const values: Array<[string, unknown]> = transient || reused ? [] : [[resource, value]];
      if (!cachedCatalog || cachedCatalog.expiresAt <= Date.now()) values.unshift([catalogResource, catalog]);
      if (durable) for (const [name, data] of values)
        await durable.put(scope(name, updated), data, schoolCacheTtl(name)).catch(() => false);
      await currentSession(updated);
      signal?.throwIfAborted();
      remember(owner, generation, values);
      if (reused) remember(owner, generation, [[resource, value]], reused.expiresAt);
      return value;
    }), signal, abortKind).catch(async error => {
      if (error instanceof WarmupCancelled) throw error;
      // Authentication/session changes clear the account; one failed resource must not
      // evict independently usable courses/timetable/catalog and restart the whole screen.
      const accountInvalid = error instanceof AppError && [401, 409].includes(error.statusCode)
        || error instanceof SchoolError && ['authentication_required', 'identity_mismatch'].includes(error.code);
      if (accountInvalid) cache.delete(owner);
      else if (!expectedGeneration) cache.get(owner)?.values.delete(resource);
      if (durable) await durable.delete(owner, 'ssu', error instanceof AppError && [401, 409].includes(error.statusCode)
        || error instanceof SchoolError && ['authentication_required', 'identity_mismatch'].includes(error.code) ? undefined : resource).catch(() => {});
      const diagnostic = assignmentTrace && assignmentReadFailureDiagnostic(error, assignmentTrace.operation, assignmentTrace.stage, assignmentTrace.scope, false);
      try { return normalizeSchoolReadError(error); }
      catch (normalized) { if (diagnostic) rememberAssignmentReadFailure(normalized, diagnostic, assignmentTrace!.scope); throw normalized; }
    }).finally(() => {
      const ownerPending = pending.get(owner);
      if (ownerPending?.get(resource) === result) ownerPending.delete(resource);
      if (!ownerPending?.size) pending.delete(owner);
    });
    if (!transient && !validateCached) {
      const ownerPending = pending.get(owner) ?? new Map<string, Promise<unknown>>();
      ownerPending.set(resource, result); pending.set(owner, ownerPending);
    }
    return result;
  }

  const ownedCourse = (catalog: Catalog, courseId: string) => {
    const course = catalog.courses.find(row => row.id === courseId);
    if (!course) throw notFound();
    return course;
  };
  const assignmentCourseMatches = (cached: Course, current: Course) => JSON.stringify(assignmentCourseContext(cached, current.id))
    === JSON.stringify(assignmentCourseContext(current, current.id));
  const ownedAssignmentCourse = (catalog: Catalog, courseId: string) => {
    // The general course browser allows a larger catalog. Assignment reads retain
    // the SDK's narrower 30-term/100-course bound, including cached catalog reuse.
    if (catalog.termIds.length > 30 || catalog.courses.length > 100) throw new SchoolError('unsupported');
    return ownedCourse(catalog, courseId);
  };
  async function assignmentRead<T>(owner: string, course: string, resource: string, options: AssignmentReadOptions,
    load: (client: LearningxClient, signal: AbortSignal) => Promise<unknown>, project: (value: unknown, owned: Course) => T): Promise<T> {
    assignmentId.parse(course);
    const trace: AssignmentReadTrace = { operation: resource.startsWith('assignments:') ? 'list' : 'detail', stage: 'owned_catalog', scope: options.validate };
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(90_000)]);
    const operation = (async () => {
      signal.throwIfAborted(); await options.validate(); signal.throwIfAborted();
      const value = await execute<{ course: Course; data: T }>(owner, resource, async (client, catalog) => {
        trace.stage = 'owned_catalog';
        const owned = ownedAssignmentCourse(catalog, course);
        await options.validate(); signal.throwIfAborted();
        trace.stage = 'school_read'; const raw = await load(client, signal);
        trace.stage = 'projection'; return { course: owned, data: project(raw, owned) };
      }, undefined, false, Boolean(options.refresh), signal, (value, catalog) => {
        const owned = ownedAssignmentCourse(catalog, course);
        try { project(value.data, value.course); return assignmentCourseMatches(value.course, owned); }
        catch { return false; }
      }, 'assignment', 'all', trace);
      trace.stage = 'final_session'; await options.validate(); signal.throwIfAborted();
      trace.stage = 'projection'; return project(value.data, value.course);
    })();
    return abortableRead(operation, signal, 'assignment').catch(error => {
      rememberAssignmentReadFailure(error, assignmentReadFailureDiagnostic(error, trace.operation, trace.stage, trace.scope), trace.scope); throw error;
    });
  }
  const activity = (owner: string, courseId: string, moduleItemId: string, generation?: string, fresh = false) => execute<ActivityRead>(
    owner, `activity:${courseId}:${moduleItemId}`, async (client, catalog) => {
      const course = ownedCourse(catalog, courseId);
      const detail = await client.moduleActivityDetail(courseId, moduleItemId);
      if (detail.courseId !== courseId || detail.moduleItemId !== moduleItemId) throw new SchoolError('unexpected_response');
      return { course, detail, observedAt: new Date().toISOString() };
    }, generation, false, fresh);

  // Cold TODO loads modules only for its own persisted-override courses; never the whole catalog.
  async function tasksWithCachedModules(owner: string, value: TasksRead, options: TasksReadOptions = {}): Promise<TasksRead> {
    const signal = options.signal ?? AbortSignal.timeout(90_000);
    const candidates = [...new Set(value.groups.filter(group => group.items.some(item =>
      item.componentType === 'assignment' && item.assignmentId
      || item.componentType === 'commons' && item.componentId && ['movie', 'mp4', 'pdf', 'file', 'readystream'].includes(item.commonsType ?? '')
        && value.catalog.commonsModes?.[group.courseId] === true)).map(group => group.courseId))];
    const requested = options.personalCompletionCourses ? await options.personalCompletionCourses(candidates) : [];
    const modules = await planningModules(owner, value.mappingGeneration, candidates, requested,
      {signal, validate: options.validate ?? (async () => {})}, 'tasks');
    signal.throwIfAborted();
    return withSchoolSessionLock(owner, async () => {
      const generation = await planningGeneration(owner, value.mappingGeneration);
      signal.throwIfAborted();
      const result = {...value, moduleProofs: modules};
      taskProofs.set(result, {owner, generation, expiresAt: Date.now() + 90_000});
      return result;
    });
  }
  async function validateTasks(owner: string, value: TasksRead, sessionTokenHash: string): Promise<void> {
    const proof = taskProofs.get(value);
    if (!proof || proof.owner !== owner || proof.expiresAt <= Date.now())
      throw new AppError(409, 'SCHOOL_SESSION_CHANGED', '학교 세션이 갱신됐습니다. 다시 조회해 주세요.');
    taskProofs.delete(value);
    return validatePlanningProof(owner, proof, sessionTokenHash);
  }
  async function validateCalendar(owner: string, value: CalendarRead, sessionTokenHash: string): Promise<void> {
    const proof = calendarProofs.get(value);
    if (!proof || proof.owner !== owner || proof.expiresAt <= Date.now())
      throw new AppError(409, 'SCHOOL_SESSION_CHANGED', '학교 세션이 갱신됐습니다. 다시 조회해 주세요.');
    calendarProofs.delete(value);
    return validatePlanningProof(owner, proof, sessionTokenHash);
  }
  async function validatePlanningProof(owner: string, proof: { generation: string; expiresAt: number }, sessionTokenHash: string): Promise<void> {
    if (!store.getAuthenticatedSchoolSession) throw new AppError(503, 'SCHOOL_PROVIDER_UNAVAILABLE', '학교 연동을 확인할 수 없습니다.');
    const snapshot = await store.getAuthenticatedSchoolSession(owner, 'ssu', sessionTokenHash);
    // No asynchronous authority reads follow this snapshot. Same-owner relogin
    // and ALMS logout/expiry are evaluated together before comparing the private proof.
    if (!snapshot.almsSessionValid) throw new AppError(401, 'AUTH_REQUIRED', '다시 로그인해 주세요.');
    const encrypted = snapshot.encryptedSchoolSession;
    if (!encrypted) throw new AppError(401, 'SCHOOL_AUTH_REQUIRED', '학교 로그인이 필요합니다.');
    let session: z.infer<typeof storedSession>;
    try { session = storedSession.parse(decryptSchoolSession(encrypted, key, owner, 'ssu')); }
    catch { throw new AppError(401, 'SCHOOL_AUTH_REQUIRED', '학교 인증을 다시 확인해 주세요.'); }
    if (session.generation !== proof.generation || proof.expiresAt <= Date.now())
      throw new AppError(409, 'SCHOOL_SESSION_CHANGED', '학교 세션이 갱신됐습니다. 다시 조회해 주세요.');
  }

  async function planningGeneration(owner: string, expected: string | undefined): Promise<string> {
    const encrypted = await store.getEncryptedSchoolSession(owner, 'ssu');
    if (!encrypted) throw new AppError(401, 'SCHOOL_AUTH_REQUIRED', '학교 로그인이 필요합니다.');
    let session: z.infer<typeof storedSession>;
    try {session = storedSession.parse(decryptSchoolSession(encrypted, key, owner, 'ssu'));}
    catch {throw new AppError(401, 'SCHOOL_AUTH_REQUIRED', '학교 인증을 다시 확인해 주세요.');}
    if (!session.generation || session.generation !== expected) throw new WarmupCancelled();
    return session.generation;
  }
  async function planningModules(owner: string, generation: string | undefined, candidates: readonly string[], requested: readonly string[],
    options: {signal: AbortSignal; validate: () => Promise<void>; refresh?: boolean}, kind: 'calendar' | 'tasks'): Promise<NonNullable<TasksRead['moduleProofs']>> {
    const coldCourses = new Set(requested);
    // The callback is an internal DB projection, never HTTP input. Reject broadened scopes.
    if (candidates.length > 100 || coldCourses.size > 100 || [...coldCourses].some(id => !candidates.includes(id))) throw new SchoolError('unexpected_response');
    await options.validate(); options.signal.throwIfAborted();
    const modules: NonNullable<TasksRead['moduleProofs']> = [];
    for (const courseId of candidates) {
      options.signal.throwIfAborted();
      let proof = await withSchoolSessionLock(owner, async () => {
        await planningGeneration(owner, generation); options.signal.throwIfAborted();
        const encrypted = await store.getEncryptedSchoolSession(owner, 'ssu');
        if (!encrypted) throw new AppError(401, 'SCHOOL_AUTH_REQUIRED', '학교 로그인이 필요합니다.');
        const entry = cache.get(owner)?.generation === generation ? cache.get(owner) : undefined;
        for (const resource of [`course:${courseId}`, `calendar-modules:${courseId}`]) {
          let cached = entry?.values.get(resource);
          if ((!cached || cached.expiresAt <= Date.now() || !cachedCompatible(resource, cached.value)) && durable)
            cached = await durable.get<CourseRead>({owner, provider: 'ssu', generation: generation!, resource, encryptedSession: encrypted}).catch(() => null) ?? undefined;
          const value = cached?.value as CourseRead | undefined;
          if (cached && cached.expiresAt > Date.now() && cachedCompatible(resource, value)
            && value?.course.id === courseId && Array.isArray(value.modules)) return value;
        }
        return undefined;
      });
      if ((!proof || options.refresh) && coldCourses.has(courseId)) {
        proof = await execute<CourseRead>(owner, `calendar-modules:${courseId}`, async (client, catalog) => {
          const course = ownedCourse(catalog, courseId);
          await options.validate(); options.signal.throwIfAborted();
          const modules = await client.modules(courseId); options.signal.throwIfAborted();
          return {course, modules, lessons: null, observedAt: new Date().toISOString(), assignmentMappingVersion: 1,
            commonsMappingVersion: 3, usePureCanvas: catalog.commonsModes?.[courseId] ?? null};
        }, generation, false, Boolean(options.refresh), options.signal, undefined, kind, 'default');
      }
      if (proof) modules.push({courseId, modules: proof.modules, usePureCanvas: proof.usePureCanvas, commonsMappingVersion: proof.commonsMappingVersion});
    }
    await options.validate(); options.signal.throwIfAborted();
    return modules;
  }
  async function calendarWithModules(owner: string, snapshot: CalendarSnapshot, options: import('./provider.js').CalendarReadOptions): Promise<CalendarRead> {
    const candidates = [...new Set(snapshot.data.items.filter(item => item.type === 'assignment').map(item => item.courseId))];
    const requested = options.personalCompletionCourses ? await options.personalCompletionCourses(candidates) : [];
    const modules = await planningModules(owner, snapshot.mappingGeneration, candidates, requested, options, 'calendar');
    return withSchoolSessionLock(owner, async () => {
      const generation = await planningGeneration(owner, snapshot.mappingGeneration); options.signal.throwIfAborted();
      const value = {...snapshot.data, mappingGeneration: snapshot.mappingGeneration, moduleProofs: modules};
      calendarProofs.set(value, {owner, generation, expiresAt: Date.now() + 90_000});
      return value;
    });
  }
  function catalogWithCachedCounts(owner: string, catalog: Catalog): Catalog {
    // execute just validated this same owner's current school generation. Projection is synchronous.
    const proof = cache.get(owner)?.values.get('tasks');
    const tasks = proof?.value as TasksRead | undefined;
    return proof && proof.expiresAt > Date.now() && cachedCompatible('tasks', tasks)
      && tasks && tasks.mappingGeneration === cache.get(owner)?.generation
      ? publicTaskCatalog(catalog, tasks.groups.filter(group => catalog.courses.some(course => course.id === group.courseId))) : catalog;
  }

  // Call while holding the owner lock. Invalidating through the public method here would deadlock.
  async function invalidateActivity(owner: string, courseId: string, moduleItemId: string) {
    warmups.delete(owner);
    const resources = progressCacheResources([{ courseId, lectureId: moduleItemId }]);
    for (const resource of resources) {
      cache.get(owner)?.values.delete(resource);
      if (durable) await durable.delete(owner, 'ssu', resource);
    }
  }

  function recordMaterialView(owner: string, courseId: string, moduleItemId: string, observation: MaterialViewObservation,
    validate: () => Promise<void>): Promise<MaterialViewRead> {
    const id = JSON.stringify([courseId, moduleItemId, observation.event, observation.page, observation.totalPages, [...observation.viewedPages].sort((a, b) => a - b)]);
    const joined = viewPending.get(owner)?.get(id);
    if (joined) return joined;
    const now = Date.now();
    for (const [id, limit] of viewLimits) if (limit.start + 60_000 <= now) viewLimits.delete(id);
    const limit = viewLimits.get(owner) ?? { start: now, count: 0 };
    if (limit.count >= 120 || !viewLimits.has(owner) && viewLimits.size >= 500 || (viewPending.get(owner)?.size ?? 0) >= 8)
      return Promise.reject(new AppError(429, 'RATE_LIMITED', '자료 열람 기록이 많습니다. 잠시 후 다시 시도해 주세요.'));
    limit.count++; viewLimits.set(owner, limit);
    let phase: MaterialViewFailureStage = 'validation';
    let diagnostic: MaterialViewFailureDiagnostic | undefined;
    const result = execute<MaterialViewRead>(owner, `material-view:${courseId}:${moduleItemId}`, async (client, catalog, _generation, currentSchoolSession) => {
      const course = ownedCourse(catalog, courseId);
      if (!materialReporter) throw new AppError(503, 'MATERIAL_VIEW_UNAVAILABLE', '자료 열람 기록을 아직 반영할 수 없습니다.');
      await validate(); await currentSchoolSession();
      let attempted = false;
      try {
        const result = await materialReporter(client, courseId, moduleItemId, observation, async () => {
          await validate(); await currentSchoolSession();
          // Failure to clear stale completion data aborts before the first school write.
          await invalidateActivity(owner, courseId, moduleItemId);
          await validate(); await currentSchoolSession();
          attempted = true;
          // A provider without stage evidence may fail in either callback or refresh.
          phase = 'unknown';
        });
        phase = 'finalization';
        const alreadyCompleted = result.report === 'already_completed' && !attempted && result.detail.itemContentType === 'commons'
          && result.detail.published === true && result.detail.opened === true && result.detail.omitProgress === false
          && result.detail.attendance.completed === true;
        if (!(result.report === 'recorded' && attempted || alreadyCompleted)
          || result.detail.courseId !== courseId || result.detail.moduleItemId !== moduleItemId
          || result.detail.resourceType !== 'pdf') throw new SchoolError('unexpected_response');
        await validate(); await currentSchoolSession();
        // Fresh school completion supersedes cached incomplete data without sending another report.
        if (alreadyCompleted) {
          await invalidateActivity(owner, courseId, moduleItemId);
          await validate(); await currentSchoolSession();
        }
        // The module list's completion and the detail's attendance completion are
        // separate school fields. Read the exact module after the first visible
        // page so the UI need not wait for a second full course/catalog request.
        // Subsequent page observations do not add this read.
        let moduleCompleted: boolean | null | undefined;
        if (observation.event === 'opened') {
          const modules = await client.modules(courseId);
          const matches = modules.flatMap(module => module.items).filter(item => item.id === moduleItemId);
          if (matches.length !== 1 || matches[0]!.contentType !== 'attendance_item'
            || matches[0]!.itemContentType !== 'commons' || matches[0]!.resourceType !== 'pdf') throw new SchoolError('unexpected_response');
          const value = matches[0]!.completed;
          moduleCompleted = typeof value === 'boolean' ? value : null;
          await validate(); await currentSchoolSession();
        }
        return { course, detail: result.detail, report: result.report, observedAt: new Date().toISOString(),
          ...(moduleCompleted !== undefined ? { moduleCompleted } : {}) };
      } catch (error) {
        diagnostic = materialViewFailureDiagnostic(error, phase);
        throw error;
      } finally {
        // A timeout after sending is ambiguous: never leave cached old completion/attendance behind.
        // No other operation can refill these owner-scoped keys while this lock is held.
        if (attempted) try { await invalidateActivity(owner, courseId, moduleItemId); }
        catch (error) { diagnostic = materialViewFailureDiagnostic(error, 'finalization'); throw error; }
      }
    }, undefined, true, true).catch(error => {
      // execute() keeps the existing public HTTP error. Preserve only the fixed internal evidence.
      rememberMaterialViewFailure(error, diagnostic ?? materialViewFailureDiagnostic(error, phase));
      throw error;
    }).finally(() => {
      const waiting = viewPending.get(owner);
      if (waiting?.get(id) === result) waiting.delete(id);
      if (!waiting?.size) viewPending.delete(owner);
    });
    const waiting = viewPending.get(owner) ?? new Map<string, Promise<MaterialViewRead>>();
    waiting.set(id, result); viewPending.set(owner, waiting);
    return result;
  }

  async function material(owner: string, courseId: string, moduleItemId: string, expectedGeneration?: string, background = false, refresh = false) {
    const resource = `${courseId}:${moduleItemId}`;
    if (refresh) {
      materialBytes.invalidate(owner, resource);
      await withSchoolSessionLock(owner, () => invalidateActivity(owner, courseId, moduleItemId));
    }
    const value = await activity(owner, courseId, moduleItemId, expectedGeneration, refresh);
    const { detail } = value;
    if (detail.resourceType !== 'pdf' || detail.published !== true || detail.opened !== true || !isMaterialViewer(detail.materialViewerUrl)) {
      throw new AppError(503, 'MATERIAL_UNAVAILABLE', '이 자료는 아직 바로 열 수 없습니다.');
    }
    const entry = cache.get(owner);
    if (!entry || entry.values.get(`activity:${courseId}:${moduleItemId}`)?.value !== value) {
      throw new AppError(409, 'SCHOOL_SESSION_CHANGED', '학교 세션이 갱신됐습니다. 다시 조회해 주세요.');
    }
    // A read that began before the fresh metadata request may have started another download.
    if (refresh) materialBytes.invalidate(owner, resource);
    const bytes = await materialBytes.read(owner, entry.generation, resource, detail.materialViewerUrl, background);
    const currentMetadata = cache.get(owner)?.values.get(`activity:${courseId}:${moduleItemId}`);
    if (!currentMetadata || currentMetadata.expiresAt <= Date.now() || currentMetadata.value !== value) {
      const refreshed = await activity(owner, courseId, moduleItemId, entry.generation);
      if (refreshed.detail.resourceType !== 'pdf' || refreshed.detail.published !== true || refreshed.detail.opened !== true
        || refreshed.detail.materialViewerUrl !== detail.materialViewerUrl) {
        throw new AppError(503, 'MATERIAL_UNAVAILABLE', '자료가 변경됐습니다. 다시 열어 주세요.');
      }
    }
    // Anonymous content fetches do not mutate the school jar. Reauthorize after download/cache lookup
    // so school-session revocation or a new login cannot publish the previous login's bytes.
    // The HTTP route also rechecks the ALMS session after this read to catch a concurrent logout.
    const encrypted = await store.getEncryptedSchoolSession(owner, 'ssu');
    if (!encrypted) throw new AppError(401, 'SCHOOL_AUTH_REQUIRED', '학교 로그인이 필요합니다.');
    let current: z.infer<typeof storedSession>;
    try { current = storedSession.parse(decryptSchoolSession(encrypted, key, owner, 'ssu')); }
    catch { throw new AppError(401, 'SCHOOL_AUTH_REQUIRED', '학교 로그인이 필요합니다.'); }
    if (current.generation !== entry.generation) throw new AppError(409, 'SCHOOL_SESSION_CHANGED', '학교 세션이 갱신됐습니다. 다시 조회해 주세요.');
    if (!materialBytes.isCurrent(owner, entry.generation, resource, detail.materialViewerUrl, bytes))
      throw new AppError(409, 'MATERIAL_REFRESHED', '자료를 다시 불러오고 있습니다. 잠시 후 다시 열어 주세요.');
    return { bytes };
  }

  async function videoLaunch(owner: string, courseId: string, moduleItemId: string, signal: AbortSignal) {
    const prepared = await execute(owner, `video:${courseId}:${moduleItemId}`, async (client, catalog, generation, _validate, connection) => {
      signal.throwIfAborted();
      const course = ownedCourse(catalog, courseId);
      const source = await client.moduleActivityVideoLaunch(courseId, moduleItemId), data = inspectSchoolVideoLaunch(source), { detail } = data;
      if (detail.courseId !== courseId || detail.moduleItemId !== moduleItemId) throw new SchoolError('unexpected_response');
      if (!['movie', 'readystream'].includes(detail.resourceType ?? '') || detail.published !== true
        || detail.opened !== true || typeof detail.useAttendance !== 'boolean')
        throw new AppError(503, 'VIDEO_UNAVAILABLE', '이 영상은 아직 ALMS에서 재생할 수 없습니다.');
      if (detail.resourceType === 'readystream') {
        // A cached display catalog cannot authorize reuse of a learner-specific opaque proof.
        if (!connection.verifyVideoIdentity) throw new SchoolError('unsupported');
        await connection.verifyVideoIdentity(); signal.throwIfAborted();
        const terms = await client.terms();
        if (terms.length > 30 || new Set(terms.map(term => term.id)).size !== terms.length) throw new SchoolError('unexpected_response');
        const courses = await client.courses(terms.map(term => term.id));
        if (courses.length > 3_000 || new Set(courses.map(row => row.id)).size !== courses.length
          || courses.some(row => !terms.some(term => term.id === row.termId))) throw new SchoolError('unexpected_response');
        const matches = courses.filter(row => row.id === courseId);
        if (matches.length !== 1) throw notFound();
        if (matches[0]!.usePureCanvas !== true) throw new SchoolError('unsupported');
      }
      signal.throwIfAborted();
      return { source, generation, course, data };
    }, undefined, true, false, signal);
    const validate = async () => {
      signal.throwIfAborted();
      const encrypted = await store.getEncryptedSchoolSession(owner, 'ssu');
      if (!encrypted) throw new AppError(401, 'SCHOOL_AUTH_REQUIRED', '학교 로그인이 필요합니다.');
      let current: z.infer<typeof storedSession>;
      try { current = storedSession.parse(decryptSchoolSession(encrypted, key, owner, 'ssu')); }
      catch { throw new AppError(401, 'SCHOOL_AUTH_REQUIRED', '다시 로그인해 주세요.'); }
      if (current.generation !== prepared.generation)
        throw new AppError(409, 'SCHOOL_SESSION_CHANGED', '학교 세션이 갱신됐습니다. 다시 조회해 주세요.');
      signal.throwIfAborted();
    };
    await validate(); return { ...prepared, validate };
  }
  async function video(owner: string, courseId: string, moduleItemId: string, request: VideoRequest) {
    return videoOperations.stream(owner, async signal => {
      const prepared = await videoLaunch(owner, courseId, moduleItemId, signal);
      const verified = await resolveVideo(owner, prepared.generation, prepared.source, prepared.validate, signal);
      await prepared.validate();
      return { contentId: verified.media.contentId, mediaUrl: verified.media.mediaUrl, validate: prepared.validate,
        ...(verified.media.detail.resourceType === 'readystream' ? { resourceType: 'readystream' as const } : {}) };
    }, request);
  }
  async function selectedActivity(owner: string, courseId: string, moduleItemId: string) {
    const value = await activity(owner, courseId, moduleItemId);
    if (value.detail.resourceType !== 'readystream' || value.detail.published !== true
      || value.detail.opened !== true || typeof value.detail.useAttendance !== 'boolean') return value;
    const signal = AbortSignal.timeout(30_000), prepared = await videoLaunch(owner, courseId, moduleItemId, signal);
    let readystreamMediaVerified = false;
    try { await resolveVideo(owner, prepared.generation, prepared.source, prepared.validate, signal); readystreamMediaVerified = true; }
    catch (error) {
      await prepared.validate();
      // Unsupported manifests retain readable school metadata, with manual capabilities closed.
      if (!(error instanceof SchoolError && ['unsupported', 'unexpected_response', 'forbidden_target'].includes(error.code))) throw error;
    }
    await prepared.validate();
    return { course: prepared.course, detail: prepared.data.detail, observedAt: new Date().toISOString(), readystreamMediaVerified };
  }

  function syllabus(owner: string, courseId: string, options: SyllabusReadOptions) {
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(90_000)]);
    return abortableRead(readSyllabus(owner, courseId, { ...options, signal }), signal);
  }
  async function readSyllabus(owner: string, courseId: string, options: SyllabusReadOptions) {
    if (!renderSyllabus) throw new SchoolError('unsupported');
    options.signal.throwIfAborted(); await options.validate();
    // Fresh ownership is required even on a byte cache hit. Opaque launch preparation is deferred until a cache miss.
    const authorized = await execute(owner, `syllabus-owner:${courseId}`, async (_client, catalog, generation) => {
      ownedCourse(catalog, courseId); await options.validate(); options.signal.throwIfAborted(); return { generation };
    }, undefined, true, true, options.signal);
    const validate = async () => {
      options.signal.throwIfAborted(); await options.validate();
      const encrypted = await store.getEncryptedSchoolSession(owner, 'ssu');
      if (!encrypted) throw new AppError(401, 'SCHOOL_AUTH_REQUIRED', '학교 로그인이 필요합니다.');
      let current: z.infer<typeof storedSession>;
      try { current = storedSession.parse(decryptSchoolSession(encrypted, key, owner, 'ssu')); }
      catch { throw new AppError(401, 'SCHOOL_AUTH_REQUIRED', '다시 로그인해 주세요.'); }
      if (current.generation !== authorized.generation) throw new AppError(409, 'SCHOOL_SESSION_CHANGED', '학교 세션이 갱신됐습니다. 다시 조회해 주세요.');
      options.signal.throwIfAborted();
    };
    let value: Awaited<ReturnType<typeof syllabusBytes.read>> | undefined;
    try {
      value = await syllabusBytes.read(owner, authorized.generation, courseId, async signal => {
        const combined = AbortSignal.any([signal, options.signal]);
        const prepared = await execute(owner, `syllabus-launch:${courseId}`, async (client, catalog, _generation, current, connection) => {
          ownedCourse(catalog, courseId); await validate(); combined.throwIfAborted();
          if (!connection.readSyllabusAuthCheck) throw new SchoolError('unsupported');
          const plan: SchoolSyllabusRenderLaunch = await client.prepareCourseSyllabusRender(courseId, combined);
          if (inspectSchoolSyllabusRenderLaunch(plan).courseId !== courseId) throw new SchoolError('forbidden_target');
          await current(); await validate(); combined.throwIfAborted();
          return { plan, readAuthCheck: connection.readSyllabusAuthCheck };
        }, authorized.generation, true, true, combined);
        // No owner lock is held during browser execution. The bound auth helper only reads scoped cookies.
        const result = await renderSyllabus({ ...prepared, validate }, combined);
        await validate(); combined.throwIfAborted(); return result;
      }, options.refresh, options.signal);
      await validate();
      if (!syllabusBytes.isCurrent(owner, authorized.generation, courseId, value))
        throw new AppError(409, 'SYLLABUS_REFRESHED', '강의계획서를 다시 불러오고 있습니다.');
      return { ...value, courseId };
    } catch (error) {
      // Failed loaders remove their own entry. Only discard a resolved document
      // when it is still current; an older request must not cancel its replacement.
      if (value && error instanceof AppError && [401, 409].includes(error.statusCode))
        syllabusBytes.invalidateDocument(owner, authorized.generation, courseId, value);
      throw error;
    }
  }

  function warmOpenedMaterial(owner: string, value: ActivityRead) {
    const { detail } = value, entry = cache.get(owner);
    if (!entry || entry.values.get(`activity:${detail.courseId}:${detail.moduleItemId}`)?.value !== value
      || detail.resourceType !== 'pdf' || detail.published !== true || detail.opened !== true || !isMaterialViewer(detail.materialViewerUrl)) return;
    const current = warmups.get(owner);
    const sameCourse = current?.generation === entry.generation && current.courseId === detail.courseId;
    const items = [...new Set([detail.moduleItemId, ...(sameCourse ? current.items : [])])].slice(0, 3);
    enqueueWarmup(owner, { generation: entry.generation, courseId: detail.courseId, items });
  }

  function warmMaterials(owner: string, value: CourseRead) {
    const entry = cache.get(owner);
    // The result must still belong to this login. The warmup rechecks generation inside each lock.
    if (!entry || entry.values.get(`course:${value.course.id}`)?.value !== value) return;
    const items = [...new Set(value.modules.flatMap(module => module.items)
      .filter(item => item.activityDetailAvailable === true && item.published === true
        && item.contentType === 'attendance_item' && item.itemContentType === 'commons'
        && ['pdf', 'file'].includes(item.resourceType ?? '')
        && (!item.unlockAt || Number.isFinite(Date.parse(item.unlockAt)) && Date.parse(item.unlockAt) <= Date.now()))
      .map(item => item.id))].slice(0, 3);
    if (!items.length) { warmups.delete(owner); return; }
    const queued = warmups.get(owner);
    if (queued?.generation === entry.generation && queued.courseId === value.course.id) return;
    const work = { generation: entry.generation, courseId: value.course.id, items };
    enqueueWarmup(owner, work);
  }
  function enqueueWarmup(owner: string, work: Warmup) {
    if (!warmups.has(owner) && warmups.size >= 100) return;
    warmups.set(owner, work);
    if (warming.has(owner)) return;
    warming.add(owner);
    // Let the course response leave first. Each metadata request uses the existing owner lock,
    // yielding between items so foreground navigation is never behind a whole speculative batch.
    setImmediate(() => { void (async () => {
      try {
        while (true) {
          const next = warmups.get(owner);
          if (!next) break;
          const foreground = pending.get(owner);
          if (foreground?.size) await Promise.allSettled([...foreground.values()]);
          if (warmups.get(owner) !== next) continue;
          const item = next.items.shift();
          if (!item) { warmups.delete(owner); break; }
          try {
            const value = await activity(owner, next.courseId, item, next.generation);
            if (value.detail.resourceType === 'pdf' && value.detail.published === true && value.detail.opened === true
              && isMaterialViewer(value.detail.materialViewerUrl)) await material(owner, next.courseId, item, next.generation, true);
          }
          catch { if (warmups.get(owner) === next) warmups.delete(owner); }
          await new Promise<void>(resolve => setImmediate(resolve));
        }
      } finally { warming.delete(owner); }
    })(); });
  }
  return {
    invalidateActivities: async (owner, targets, signal) => {
      const resources = progressCacheResources(targets);
      if (!resources.length) return;
      await withSchoolSessionLock(owner, async () => {
        signal.throwIfAborted();
        const warmup = warmups.get(owner);
        if (warmup && targets.some(target => target.courseId === warmup.courseId)) warmups.delete(owner);
        for (const resource of resources) cache.get(owner)?.values.delete(resource);
        if (durable?.deleteMany) await durable.deleteMany(owner, 'ssu', resources, signal);
        else if (durable) for (const resource of resources) { signal.throwIfAborted(); await durable.delete(owner, 'ssu', resource); }
        signal.throwIfAborted();
      });
    },
    invalidate: async (owner, courseId, moduleItemId) => {
      warmups.delete(owner);
      if (!moduleItemId) assignmentFiles.invalidate(owner, courseId);
      if (!moduleItemId) syllabusBytes.invalidate(owner, courseId);
      await withSchoolSessionLock(owner, async () => {
        if (!courseId || !moduleItemId) {
          cache.delete(owner);
          if (durable) await durable.delete(owner, 'ssu');
          return;
        }
        await invalidateActivity(owner, courseId, moduleItemId);
      });
    },
    catalog: (owner, options) => {
      if (options?.termId !== undefined) assignmentId.parse(options.termId);
      const resource = options?.termId ? `catalog:term:${options.termId}` : 'catalog';
      return execute(owner, resource, async (_client, catalog) => catalog, undefined, false, false, undefined, undefined, undefined,
        options?.termId ? { termId: options.termId } : 'default').then(value => catalogWithCachedCounts(owner, value));
    },
    readTerms: owner => execute(owner, 'course-terms', async (_client, catalog) => ({
      items: catalog.terms ?? [], defaultTermId: catalog.defaultTermId ?? null,
    }), undefined, false, false, undefined, undefined, undefined, 'terms'),
    readCourse: (owner, courseId) => execute(owner, `course:${courseId}`, async (client, catalog) => {
      const course = ownedCourse(catalog, courseId);
      const modules = await client.modules(courseId);
      let lessons: CourseRead['lessons'] = null;
      try { if (typeof client.lessons === 'function') lessons = await client.lessons(courseId); }
      catch (error) {
        if (error instanceof SchoolError && ['authentication_required', 'identity_mismatch'].includes(error.code)
          || error instanceof AppError && error.code === 'SCHOOL_AUTH_REQUIRED') throw error;
        // The module list remains usable when independent school lesson dates are unavailable.
      }
      return { course, modules, lessons, observedAt: new Date().toISOString(), assignmentMappingVersion: 1 as const,
        commonsMappingVersion: 3 as const, usePureCanvas: catalog.commonsModes?.[courseId] ?? null };
    }).then(value => { warmMaterials(owner, value); return value; }),
    readActivity: (owner, courseId, moduleItemId) => selectedActivity(owner, courseId, moduleItemId).then(value => { warmOpenedMaterial(owner, value); return value; }),
    ...(materialReporter ? { recordMaterialView } : {}),
    readMaterial: (owner, courseId, moduleItemId, options) => material(owner, courseId, moduleItemId, undefined, false, options?.refresh),
    ...(renderSyllabus ? { readSyllabus: syllabus } : {}),
    readVideo: (owner, courseId, moduleItemId, request) => video(owner, courseId, moduleItemId, request),
    readLearningStatus: async (owner, courseId, moduleItemId, callerSignal) => {
      assignmentId.parse(courseId); assignmentId.parse(moduleItemId);
      const signal = AbortSignal.any([AbortSignal.timeout(90_000), ...(callerSignal ? [callerSignal] : [])]);
      const value = await execute(owner, `learning-status:${courseId}:${moduleItemId}`, async (client, catalog, generation) => {
        ownedCourse(catalog, courseId); signal.throwIfAborted();
        const value = await client.moduleLearningStatus(courseId, moduleItemId, signal);
        signal.throwIfAborted(); return { result: projectLearningStatus(value, courseId, moduleItemId), generation };
      }, undefined, true, true, signal, undefined, 'verification');
      signal.throwIfAborted();
      learningProofs.set(value.result, { owner, generation: value.generation, courseId, moduleItemId, signal: callerSignal, expiresAt: Date.now() + 90_000 });
      return value.result;
    },
    refreshLearningStatus: async (owner, courseId, moduleItemId, result, options) => {
      const proof = learningProofs.get(result);
      learningProofs.delete(result);
      if (!proof || proof.owner !== owner || proof.courseId !== courseId || proof.moduleItemId !== moduleItemId
        || proof.signal !== options.signal || proof.expiresAt <= Date.now())
        throw new AppError(503, 'SCHOOL_RESULT_UNAVAILABLE', '학교 결과 갱신을 확인하지 못했습니다. 다시 시도해 주세요.');
      try {
        await boundedWorkerOperation(signal => withSchoolSessionLock(owner, async () => {
          const validate = async () => {
            signal.throwIfAborted(); await options.validate(); signal.throwIfAborted();
            const encrypted = await store.getEncryptedSchoolSession(owner, 'ssu'); signal.throwIfAborted();
            if (!encrypted) throw new AppError(401, 'SCHOOL_AUTH_REQUIRED', '학교 로그인이 필요합니다.');
            let generation: string | undefined;
            try { generation = storedSession.parse(decryptSchoolSession(encrypted, key, owner, 'ssu')).generation; }
            catch { throw new AppError(401, 'SCHOOL_AUTH_REQUIRED', '저장된 학교 세션을 확인할 수 없습니다. 다시 로그인해 주세요.'); }
            if (generation !== proof.generation) throw new AppError(409, 'SCHOOL_SESSION_CHANGED', '학교 세션이 갱신됐습니다. 다시 조회해 주세요.');
          };
          await validate();
          const resources = progressCacheResources([{ courseId, lectureId: moduleItemId }]);
          if (warmups.get(owner)?.courseId === courseId) warmups.delete(owner);
          for (const resource of resources) cache.get(owner)?.values.delete(resource);
          if (durable?.deleteMany) await durable.deleteMany(owner, 'ssu', resources, signal);
          else if (durable) for (const resource of resources) { signal.throwIfAborted(); await durable.delete(owner, 'ssu', resource); }
          await validate(); signal.throwIfAborted();
        }), { signal: options.signal, timeoutMs: 15_000 });
      } catch (error) {
        if (error instanceof AppError && [401, 403, 409].includes(error.statusCode)) throw error;
        throw new AppError(503, 'SCHOOL_RESULT_UNAVAILABLE', '학교 결과 갱신을 확인하지 못했습니다. 다시 시도해 주세요.');
      }
    },
    readAssignments: (owner, courseId, options) => assignmentRead(owner, courseId, `assignments:${courseId}`, options,
      (client, signal) => client.assignments(courseId, signal),
      (value, course) => publicAssignments(value, courseId, course)),
    readAssignment: (owner, courseId, id, options) => {
      assignmentId.parse(id);
      return assignmentRead(owner, courseId, `assignment:${courseId}:${id}`, options,
        (client, signal) => client.assignmentDetail(courseId, id, signal),
        (value, course) => publicAssignmentDetail(value, courseId, id, course));
    },
    readAssignmentHistory: async (owner, courseId, id, options) => {
      assignmentId.parse(courseId); assignmentId.parse(id);
      const resource = `assignment-history:${courseId}:${id}`;
      const signal = AbortSignal.any([options.signal, AbortSignal.timeout(90_000)]);
      const operation = (async () => {
        await options.validate(); signal.throwIfAborted();
        const value = await execute<{ course: Course; data: AssignmentHistoryData }>(owner, resource, async (client, catalog, generation) => {
          const course = ownedAssignmentCourse(catalog, courseId); await options.validate(); signal.throwIfAborted();
          const data = bindAssignmentHistory(await client.assignmentSubmissionHistory(courseId, id, signal), courseId, id, owner, generation, key);
          return { course, data };
        }, undefined, false, Boolean(options.refresh), signal, (value, catalog) => {
          const course = ownedAssignmentCourse(catalog, courseId);
          try { publicAssignmentHistory(value.data, courseId, id); return assignmentCourseMatches(value.course, course); }
          catch { return false; }
        }, 'assignment', 'all');
        await options.validate(); signal.throwIfAborted(); return publicAssignmentHistory(value.data, courseId, id);
      })();
      return abortableRead(operation, signal, 'assignment');
    },
    readAssignmentHistoryFile: async (owner, courseId, id, attemptKey, fileId, options) => {
      assignmentId.parse(courseId); assignmentId.parse(id); assignmentAttemptKey.parse(attemptKey); assignmentId.parse(fileId);
      const signal = AbortSignal.any([options.signal, AbortSignal.timeout(90_000)]);
      const operation = (async () => {
        await options.validate(); signal.throwIfAborted();
        const value = await execute<AssignmentFileData>(owner, `assignment-history-file:${courseId}:${id}:${attemptKey}:${fileId}`, async (client, catalog, generation, validate) => {
          ownedAssignmentCourse(catalog, courseId); await options.validate(); await validate(); signal.throwIfAborted();
          // This fresh own-history read precedes every byte-cache lookup. A prior displayed
          // row, latest submission or caller-provided attempt number is never authority.
          const schoolHistory = await client.assignmentSubmissionHistory(courseId, id, signal);
          const history = bindAssignmentHistory(schoolHistory, courseId, id, owner, generation, key);
          const item = history.items?.find(item => item.key === attemptKey);
          const schoolItem = schoolHistory.items?.find(item => assignmentHistoryAttemptHandle(item.key, courseId, id, owner, generation, key) === attemptKey);
          const proof = item?.attachments?.find(file => file.id === fileId && file.downloadAvailable === true);
          if (!item || !schoolItem || item.attempt === null || item.attempt <= 0 || !proof) throw notFound();
          await options.validate(); await validate(); signal.throwIfAborted();
          const resource = `${courseId}:${id}:history:${attemptKey}:${fileId}`;
          let bytes = options.refresh ? null : assignmentFiles.get(owner, generation, resource, proof);
          if (!bytes) {
            bytes = await assignmentFiles.load(signal, async () => publicAssignmentFile(
              await client.assignmentSubmissionHistoryAttachment(courseId, id, schoolItem.key, fileId, { signal }), proof));
            await options.validate(); await validate(); signal.throwIfAborted();
            assignmentFiles.put(owner, generation, resource, proof, bytes);
          }
          await options.validate(); await validate(); signal.throwIfAborted(); return bytes;
        }, undefined, true, Boolean(options.refresh), signal, undefined, 'assignment', 'all');
        await options.validate(); signal.throwIfAborted(); return value;
      })();
      return abortableRead(operation, signal, 'assignment');
    },
    readAssignmentFile: async (owner, courseId, id, fileId, options) => {
      assignmentId.parse(courseId); assignmentId.parse(id); assignmentId.parse(fileId);
      const signal = AbortSignal.any([options.signal, AbortSignal.timeout(90_000)]);
      const operation = (async () => {
        await options.validate(); signal.throwIfAborted();
        const value = await execute<AssignmentFileData>(owner, `assignment-file:${courseId}:${id}:${fileId}`, async (client, catalog, generation, validate) => {
          ownedAssignmentCourse(catalog, courseId); await options.validate(); await validate(); signal.throwIfAborted();
          // Fresh SDK detail verifies native self/enrollment and association before cached bytes can leave.
          const detail = publicAssignmentDetail(await client.assignmentDetail(courseId, id, signal), courseId, id);
          const proof = [...(detail.submission?.attachments ?? []), ...detail.descriptionAttachments]
            .find(file => file.id === fileId && file.downloadAvailable === true);
          if (!proof) throw notFound();
          const resource = `${courseId}:${id}:${fileId}`;
          let bytes = options.refresh ? null : assignmentFiles.get(owner, generation, resource, proof);
          if (!bytes) {
            bytes = await assignmentFiles.load(signal, async () => publicAssignmentFile(await client.assignmentAttachment(courseId, id, fileId, { signal }), proof));
            await options.validate(); await validate(); signal.throwIfAborted();
            assignmentFiles.put(owner, generation, resource, proof, bytes);
          }
          await options.validate(); await validate(); signal.throwIfAborted(); return bytes;
        }, undefined, true, Boolean(options.refresh), signal, undefined, 'assignment', 'all');
        await options.validate(); signal.throwIfAborted(); return value;
      })();
      return abortableRead(operation, signal, 'assignment');
    },
    readCalendar: async (owner, input, options) => {
      const query = calendarQuery.parse(input);
      const signal = AbortSignal.any([options.signal, AbortSignal.timeout(90_000)]);
      const operation = (async () => {
        signal.throwIfAborted(); await options.validate(); signal.throwIfAborted();
        const value = await execute<CalendarSnapshot>(owner, `calendar:v3:${query.start}:${query.end}:${query.courseId ?? 'all'}`,
          async (client, catalog, generation) => {
            if (query.courseId) ownedCourse(catalog, query.courseId);
            await options.validate(); signal.throwIfAborted();
            const result = await client.calendar(query, signal);
            return {data: publicCalendar(result, query, catalog), mappingGeneration: generation};
          }, undefined, false, Boolean(options.refresh), signal, (value, catalog) => {
            if (query.courseId) ownedCourse(catalog, query.courseId);
            return calendarMatchesCatalog(value.data, query, catalog);
          });
        await options.validate(); signal.throwIfAborted();
        return calendarWithModules(owner, value, {...options, signal});
      })();
      return abortableRead(operation, signal, 'calendar');
    },
    validateCalendar,
    readTasks: (owner, options) => execute<TasksRead>(owner, 'tasks', async (client, catalog, generation) => {
      const groups = catalog.termIds.length ? await client.todos(catalog.termIds) : [];
      const ids = new Set(catalog.courses.map(course => course.id));
      if (groups.some(group => !ids.has(group.courseId))) throw new SchoolError('unexpected_response');
      return { catalog, groups, observedAt: new Date().toISOString(), taskMappingVersion: 4, mappingGeneration: generation };
    }, undefined, false, false, options?.signal, undefined, 'tasks').then(value => tasksWithCachedModules(owner, value, options)),
    validateTasks,
    readAttendance: (owner, courseId) => execute(owner, courseId ? `attendance:${courseId}` : 'attendance', async (client, catalog) => {
      const courses = courseId ? [ownedCourse(catalog, courseId)] : catalog.courses;
      const rows: AttendanceRead['courses'] = [];
      // One mutable jar is used sequentially; no parallel Set-Cookie updates are merged.
      for (const course of courses) {
        const lessons = await client.lessons(course.id);
        const attendances = await client.lessonAttendances(course.id);
        rows.push({ course, lessons, attendances });
      }
      return { courses: rows, observedAt: new Date().toISOString() };
    }),
  };
}
