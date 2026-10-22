import { createHash } from 'node:crypto';
import { publicAssignments, publicAssignmentDetail, type AssignmentListData, type AssignmentDetailData } from './assignments.js';
import type { SchoolResult } from './domain.js';
import { publicCalendar, type CalendarQuery, type CalendarData } from './calendar.js';
import { SchoolError, type SchoolActivityDetail, type SchoolCourse, type SchoolModule, type SchoolCourseTodos, type SchoolLessonWeek, type SchoolLessonAttendance } from '@alms/ssu-api';
import { AppError } from './errors.js';
import type { MaterialReadOptions, SyllabusReadOptions, CalendarReadOptions, TasksReadOptions, AssignmentReadOptions, MaterialViewObservation, SchoolProvider, CourseCatalogOptions, LearningStatusRefreshOptions } from './provider.js';
import { isMaterialViewer } from './material-cache.js';
import type { VideoRequest, VideoResponse } from './video-stream.js';
import { currentSchoolWeek } from './current-school-week.js';
import type { AssignmentFileData } from './assignment-files.js';
import { publicAssignmentHistory, type AssignmentHistoryData } from './assignment-history.js';
import { featureSupport, type FeatureReason } from './feature-support.js';

export type Course = { id: string; title: string; professor: string | null; term: string | null; sourceUrl: string | null;
  termId?: string; ended?: boolean | null; schoolDefaultTerm?: boolean; todoCounts?: SchoolCourseTodos['activities'] };
export type CourseTerm = { id: string; label: string; year: number | null; current: boolean };
export type Catalog = { courses: Course[]; term: string | null; termIds: string[]; terms?: CourseTerm[]; defaultTermId?: string | null;
  // Private school discriminator, retained with the owned catalog rather than exposed in Course DTOs.
  commonsModes?: Record<string, boolean | null> };
export type CourseRead = { course: Course; modules: SchoolModule[]; observedAt: string; lessons?: SchoolLessonWeek[] | null;
  assignmentMappingVersion?: 1; commonsMappingVersion?: 1 | 2 | 3; usePureCanvas?: boolean | null };
export type ActivityRead = { course: Course; detail: SchoolActivityDetail; observedAt: string; readystreamMediaVerified?: boolean };
export type SyllabusRead = { courseId: string; bytes: Buffer; documentVersion: string; pageCount: number };
export type MaterialViewRead = ActivityRead & { report: 'recorded' | 'already_completed'; moduleCompleted?: boolean | null };
export type TasksRead = { catalog: Catalog; groups: SchoolCourseTodos[]; observedAt: string;
  taskMappingVersion?: 1 | 2 | 3 | 4; mappingGeneration?: string;
  moduleProofs?: Array<{ courseId: string; modules: SchoolModule[]; usePureCanvas?: boolean | null; commonsMappingVersion?: 1 | 2 | 3 }> };
export type CalendarRead = CalendarData & { mappingGeneration?: string;
  moduleProofs?: Array<{ courseId: string; modules: SchoolModule[] }> };
export type AttendanceRead = { courses: Array<{ course: Course; lessons: SchoolLessonWeek[]; attendances: SchoolLessonAttendance[] }>; observedAt: string };
export interface LearningxReader {
  readLearningStatus?(userId: string, courseId: string, moduleItemId: string, signal?: AbortSignal): Promise<SchoolResult>;
  refreshLearningStatus?(userId: string, courseId: string, moduleItemId: string, result: SchoolResult, options: LearningStatusRefreshOptions): Promise<void>;
  invalidate?(userId: string, courseId?: string, moduleItemId?: string): Promise<void>;
  // Only data leaves the owner-locked operation; the authenticated client and jar never do.
  catalog(userId: string, options?: CourseCatalogOptions): Promise<Catalog>;
  readTerms?(userId: string): Promise<{ items: CourseTerm[]; defaultTermId: string | null }>;
  readCourse(userId: string, courseId: string): Promise<CourseRead>;
  readActivity?(userId: string, courseId: string, moduleItemId: string): Promise<ActivityRead>;
  recordMaterialView?(userId: string, courseId: string, moduleItemId: string, observation: MaterialViewObservation,
    validate: () => Promise<void>): Promise<MaterialViewRead>;
  readMaterial?(userId: string, courseId: string, moduleItemId: string, options?: MaterialReadOptions): Promise<{ bytes: Buffer }>;
  readSyllabus?(userId: string, courseId: string, options: SyllabusReadOptions): Promise<SyllabusRead>;
  readVideo?(userId: string, courseId: string, moduleItemId: string, request: VideoRequest): Promise<VideoResponse>;
  readAssignments?(userId: string, courseId: string, options: AssignmentReadOptions): Promise<AssignmentListData>;
  readAssignment?(userId: string, courseId: string, assignmentId: string, options: AssignmentReadOptions): Promise<AssignmentDetailData>;
  readAssignmentFile?(userId: string, courseId: string, assignmentId: string, fileId: string, options: AssignmentReadOptions): Promise<AssignmentFileData>;
  readAssignmentHistory?(userId: string, courseId: string, assignmentId: string, options: AssignmentReadOptions): Promise<AssignmentHistoryData>;
  readAssignmentHistoryFile?(userId: string, courseId: string, assignmentId: string, attemptKey: string, fileId: string, options: AssignmentReadOptions): Promise<AssignmentFileData>;
  readCalendar?(userId: string, query: CalendarQuery, options: CalendarReadOptions): Promise<CalendarRead>;
  validateCalendar?(userId: string, result: CalendarRead, sessionTokenHash: string): Promise<void>;
  readTasks(userId: string, options?: TasksReadOptions): Promise<TasksRead>;
  validateTasks?(userId: string, result: TasksRead, sessionTokenHash: string): Promise<void>;
  readAttendance(userId: string, courseId?: string): Promise<AttendanceRead>;
}

export function normalizeSchoolReadError(error: unknown): never {
  if (error instanceof AppError) throw error;
  if (error instanceof SchoolError && ['authentication_required', 'identity_mismatch'].includes(error.code)) {
    throw new AppError(401, 'SCHOOL_AUTH_REQUIRED', '학교 인증을 다시 확인해야 합니다. 통합 로그인으로 이어서 이용해 주세요.');
  }
  if (error instanceof SchoolError && error.code === 'unsupported') {
    throw new AppError(503, 'SCHOOL_PROVIDER_UNAVAILABLE', '이 학교 정보는 아직 조회할 수 없습니다. LMS에서 확인해 주세요.');
  }
  throw new AppError(502, 'SCHOOL_UPSTREAM_UNAVAILABLE', '학교 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
}

export function publicCourse(row: SchoolCourse, termNames: Map<string, string>, defaultTermIds?: ReadonlySet<string>): Course {
  return { id: row.id, title: row.name, professor: row.professors, term: termNames.get(row.termId) ?? null,
    termId: row.termId, ended: typeof row.ended === 'boolean' ? row.ended : null,
    ...(defaultTermIds ? { schoolDefaultTerm: defaultTermIds.has(row.termId) } : {}),
    // Per-course links require a successful school page check, not URL interpolation.
    sourceUrl: null };
}

type ActivityType = 'video' | 'material' | 'assignment' | 'quiz' | 'notice' | 'other';
type ObservedModuleItem = SchoolModule['items'][number] & { itemContentType?: string | null; resourceType?: string | null;
  completed?: boolean | null; dueAt?: string | null; unlockAt?: string | null; published?: boolean | null; assignmentId?: string };
export type SchoolTask = { id: string; courseId: string; courseTitle: string; title: string; type: ActivityType;
  dueAt: string | null; sourceUrl: null; schoolStatus: null; progressPercent: null; playbackAvailable: false;
  todoSource: 'school_todo'; assignmentId?: string; moduleItemId?: string; weekId?: string;
  moduleCompleted?: boolean | null; personalCompleted?: boolean | null };

/** Reject ambiguous local datetimes instead of guessing a timezone. */
function instant(value: string | null | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  return validDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value)) ? value : null;
}
function validDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}
function classDate(value: string | null | undefined): string | null {
  if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return validDate(value) ? `${value}T00:00:00+09:00` : null;
  }
  return instant(value);
}
function stableId(parts: Array<string | number | null>): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
}
function moduleType(item: ObservedModuleItem): ActivityType {
  if (item.contentType === 'assignment') return 'assignment';
  if (item.contentType === 'attendance_item' && item.itemContentType === 'commons') {
    if (['movie', 'readystream'].includes(item.resourceType ?? '')) return 'video';
    if (item.resourceType === 'pdf' || item.resourceType === 'file') return 'material';
  }
  return 'other';
}

const todoCountKeys = ['total_announcements', 'total_incompleted_commons_resources', 'total_incompleted_movies',
  'total_incompleted_smart_attendances', 'total_incompleted_video_conferences', 'total_resources',
  'total_unread_announcements', 'total_unread_resources', 'total_unsubmitted_assignments',
  'total_unsubmitted_discussion_topics', 'total_unsubmitted_quizzes'] as const;
/** Group counts remain school observations. Missing groups and missing keys are unknown, not zero. */
export function publicTaskCatalog(catalog: Catalog, groups: readonly SchoolCourseTodos[]): Catalog {
  const courses = new Set(catalog.courses.map(course => course.id));
  const counts = new Map<string, SchoolCourseTodos['activities']>();
  for (const group of groups) {
    if (!courses.has(group.courseId) || counts.has(group.courseId)) throw new SchoolError('unexpected_response');
    const value: SchoolCourseTodos['activities'] = {};
    for (const key of todoCountKeys) {
      const count = group.activities[key];
      if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) value[key] = count;
    }
    counts.set(group.courseId, value);
  }
  return { ...catalog, courses: catalog.courses.map(course => {
    const { todoCounts: _previousCounts, ...base } = course;
    return { ...base, ...(counts.has(course.id) ? { todoCounts: counts.get(course.id)! } : {}) };
  }) };
}

/** Use the school's explicit discriminator and identifier; never infer from titles or numeric similarity. */
function taskModuleLink(value: TasksRead, courseId: string, todo: SchoolCourseTodos['items'][number]): Partial<SchoolTask> {
  const proof = value.moduleProofs?.filter(proof => proof.courseId === courseId);
  if (proof?.length !== 1) return {};
  const assignment = todo.componentType === 'assignment' && todo.assignmentId;
  const currentCommons = proof[0]!.usePureCanvas === true && value.catalog.commonsModes?.[courseId] === true;
  const commons = todo.componentType === 'commons' && ['movie', 'mp4', 'pdf', 'file'].includes(todo.commonsType ?? '')
    && todo.componentId && [2, 3, 4].includes(value.taskMappingVersion ?? 0)
    && [1, 2, 3].includes(proof[0]!.commonsMappingVersion ?? 0) && currentCommons;
  // Exact metadata relations do not authorize manual reports or server playback.
  const readystream = todo.componentType === 'commons' && todo.commonsType === 'readystream'
    && typeof todo.componentId === 'string' && /^[1-9]\d{0,15}$/.test(todo.componentId)
    && value.taskMappingVersion === 4 && proof[0]!.commonsMappingVersion === 3 && currentCommons;
  if (!assignment && !commons && !readystream) return {};
  const matches = proof[0]!.modules.flatMap(module => module.items
    .filter(item => assignment ? item.assignmentId === todo.assignmentId
      : item.contentType === 'attendance_item' && item.itemContentType === 'commons'
        && item.attendanceItemId === todo.componentId)
    .map(item => ({ module, item })));
  if (matches.length !== 1 || matches[0]!.item.published === false) return {};
  const {module, item} = matches[0]!;
  if (assignment && item.contentType !== 'assignment'
    || proof[0]!.modules.filter(row => row.id === module.id).length !== 1
    || proof[0]!.modules.flatMap(row => row.items).filter(row => row.id === item.id).length !== 1) return {};
  if (commons && (item.activityDetailAvailable !== true
    || item.resourceType !== (todo.commonsType === 'mp4' ? 'movie' : todo.commonsType))) return {};
  if (readystream && (item.todoReferenceAvailable !== true || item.resourceType !== 'readystream'
    || item.activityDetailAvailable !== true)) return {};
  if (![module.id, item.id].every(id => /^[1-9]\d{0,15}$/.test(id))) return {};
  return { moduleItemId: item.id, weekId: module.id,
    moduleCompleted: typeof item.completed === 'boolean' ? item.completed : null, personalCompleted: null };
}

/** The observed pending-activity list is not proof of per-item submission or completion. */
export function publicTasks(value: TasksRead): SchoolTask[] {
  const courses = new Map(value.catalog.courses.map(course => [course.id, course]));
  const items = new Map<string, SchoolTask>();
  for (const group of value.groups) {
    const course = courses.get(group.courseId);
    if (!course) throw new SchoolError('unexpected_response');
    for (const item of group.items) {
      const keys = [item.componentId, item.assignmentId, item.quizId, item.discussionId, item.sectionId, item.unitId];
      if (keys.every(key => key === null)) throw new SchoolError('unexpected_response');
      const id = stableId(['todo', course.id, item.componentType, ...keys]);
      const type: ActivityType = item.componentType === 'assignment' ? 'assignment'
        : item.componentType === 'commons' && (['movie', 'mp4'].includes(item.commonsType ?? '') || value.taskMappingVersion === 4 && item.commonsType === 'readystream') ? 'video'
        : item.componentType === 'commons' && ['pdf', 'file'].includes(item.commonsType ?? '') ? 'material' : 'other';
      const task: SchoolTask = { id, courseId: course.id, courseTitle: course.title, title: item.title, type,
        dueAt: instant(item.dueAt), sourceUrl: null, schoolStatus: null, progressPercent: null, playbackAvailable: false,
        todoSource: 'school_todo',
        ...(item.componentType === 'assignment' && item.assignmentId ? { assignmentId: item.assignmentId } : {}),
        ...taskModuleLink(value, course.id, item) };
      const previous = items.get(id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(task)) throw new SchoolError('unexpected_response');
      items.set(id, task);
    }
  }
  return [...items.values()].sort((a, b) => {
    const left = a.dueAt ? Date.parse(a.dueAt) : Infinity, right = b.dueAt ? Date.parse(b.dueAt) : Infinity;
    return left === right ? a.id.localeCompare(b.id) : left - right;
  });
}

/** Exact school assignment relations, including submitted items absent from the pending TODO feed. */
export function publicCalendarLearning(value: CalendarRead, query: CalendarQuery): CalendarData {
  const calendar = publicCalendar(value, query);
  return { ...calendar, items: calendar.items.map(entry => {
    if (entry.type !== 'assignment') return entry;
    const proofs = value.moduleProofs?.filter(proof => proof.courseId === entry.courseId);
    if (proofs?.length !== 1) return entry;
    const proof = proofs[0]!;
    const matches = proof.modules.flatMap(module => module.items.filter(item =>
      item.assignmentId === entry.assignmentId).map(item => ({module, item})));
    if (matches.length !== 1) return entry;
    const { module, item } = matches[0]!;
    if (item.contentType !== 'assignment' || item.published === false || proof.modules.filter(row => row.id === module.id).length !== 1
      || proof.modules.flatMap(row => row.items).filter(row => row.id === item.id).length !== 1
      || ![module.id, item.id].every(id => /^[1-9]\d{0,15}$/.test(id))) return entry;
    return { ...entry, moduleItemId: item.id, weekId: module.id,
      moduleCompleted: typeof item.completed === 'boolean' ? item.completed : null, personalCompleted: null };
  }) };
}

/** Join school lesson attendance to lesson dates, never to module completion or progress counts. */
export function publicAttendance(value: AttendanceRead) {
  return value.courses.flatMap(({ course, lessons, attendances }) => {
    const dates = new Map<string, string | null>();
    for (const week of lessons) for (const lesson of week.lessons) {
      if (week.week === null || lesson.lesson === null) continue;
      const key = `${week.week}:${lesson.lesson}`;
      if (dates.has(key)) throw new SchoolError('unexpected_response');
      dates.set(key, classDate(lesson.makeupDate || lesson.classDate));
    }
    const seen = new Set<string>();
    return attendances.map(row => {
      if (row.week === null || row.lesson === null) throw new SchoolError('unexpected_response');
      const key = `${row.week}:${row.lesson}`;
      if (seen.has(key)) throw new SchoolError('unexpected_response');
      seen.add(key);
      return { id: stableId(['lesson-attendance', course.id, row.week, row.lesson]), courseId: course.id,
        courseTitle: course.title, title: `${row.week}주차 · ${row.lesson}차시`, week: row.week,
        date: dates.get(key) ?? null, type: '차시 출결', progressPercent: null,
        schoolStatus: row.schoolStatus === 'attendance' ? '출석' : row.schoolStatus,
        schoolStatusCode: row.schoolStatus,
        checkedAt: value.observedAt, sourceUrl: null };
    });
  });
}

export type DashboardReader = Pick<LearningxReader, 'catalog'> & Partial<Pick<LearningxReader, 'readTasks' | 'readCourse'>>;
export async function readLmsDashboard(reader: DashboardReader, userId: string) {
  if (reader.readTasks) {
    try {
      const tasks = await reader.readTasks(userId);
      return { courses: tasks.catalog.courses, term: tasks.catalog.term, upcomingTasks: publicTasks(tasks),
        coursesAvailable: true, tasksAvailable: true };
    } catch (error) {
      // Confirmed school authentication failure cannot be repaired by repeating the same bootstrap.
      if (error instanceof AppError && error.code === 'SCHOOL_AUTH_REQUIRED'
        || error instanceof SchoolError && ['authentication_required', 'identity_mismatch'].includes(error.code)) throw error;
      /* Preserve a usable catalog when the independent TODO request or projection fails. */
    }
  }
  const catalog = await reader.catalog(userId);
  return { courses: catalog.courses, term: catalog.term, upcomingTasks: [], coursesAvailable: true, tasksAvailable: false };
}

function publicActivityDetail(detail: SchoolActivityDetail, observedAt: string, reader: LearningxReader, course?: Course, readystreamMediaVerified = false) {
  const material = ['pdf','file'].includes(detail.resourceType ?? '');
  const manualVideoAvailable = Boolean(reader.readVideo && (detail.resourceType === 'movie' || detail.resourceType === 'readystream' && readystreamMediaVerified) && detail.published === true
    && detail.opened === true && typeof detail.useAttendance === 'boolean');
  const writableCourse = course?.schoolDefaultTerm !== false && course?.ended !== true;
  const knownWritableCourse = course?.schoolDefaultTerm === true && course?.ended === false;
  const materialContentAvailable = Boolean(reader.readMaterial && detail.resourceType === 'pdf' && detail.published === true
    && detail.opened === true && isMaterialViewer(detail.materialViewerUrl));
  const materialViewAvailable = Boolean(reader.recordMaterialView && writableCourse && detail.resourceType === 'pdf' && detail.published === true
    && detail.opened === true && detail.omitProgress === false && isMaterialViewer(detail.materialViewerUrl));
  const capability = (installed: boolean, available: boolean, resource: 'pdf' | 'video', write: boolean,
    progressFlag?: boolean | null) => {
    const permitted = available && (!write || knownWritableCourse);
    const reason: FeatureReason | null = permitted ? null : !installed ? 'provider_unavailable'
      : !(resource === 'video' ? ['movie', 'readystream'].includes(detail.resourceType ?? '') : detail.resourceType === resource) ? 'unsupported_resource' : write && !writableCourse ? 'course_read_only'
      : detail.published === false ? 'not_published' : detail.opened === false ? 'not_opened'
      : progressFlag === false ? 'progress_not_applicable' : 'conditions_unknown';
    return featureSupport(installed, 'activity', { availability: permitted ? 'available' : reason === 'conditions_unknown' ? 'unknown' : 'unavailable',
      reason, read: write ? false : available, write: write ? reason === 'conditions_unknown' ? null : permitted : false });
  };
  // Only the separately supplied, identity-free resource URL may reach the browser.
  // The player's viewer_url contains a student-specific progress callback and is never exposed.
  return {courseId: detail.courseId, moduleItemId: detail.moduleItemId, title: detail.title, descriptionText: detail.descriptionText,
    type: material ? 'material' : 'video', resourceType: detail.resourceType,
    published: detail.published, opened: detail.opened, unlockAt: instant(detail.unlockAt),
    dueAt: instant(detail.dueAt), lateAt: instant(detail.lateAt), lockAt: instant(detail.lockAt),
    completed: detail.attendance.completed, attendanceStatus: detail.attendance.status,
    durationSeconds: detail.durationSeconds ?? null, progressSeconds: detail.attendance.progressSeconds ?? null,
    lastPositionSeconds: detail.attendance.lastPositionSeconds ?? null, progressPercent: detail.attendance.progressPercent ?? null,
    fileName: detail.fileName, fileSizeBytes: detail.reportedSizeBytes,
    materialViewerUrl: material && detail.published === true && detail.opened === true ? detail.materialViewerUrl : null,
    materialContentAvailable,
    materialViewAvailable,
    // Manual bytes do not report school progress. The UI distinguishes attendance-bearing videos.
    // The byte route rechecks the owned module and resolves the school source afresh.
    manualVideoAvailable,
    manualVideoReportAvailable: manualVideoAvailable && detail.useAttendance === true && writableCourse,
    manualVideoProgressMode: manualVideoAvailable ? detail.useAttendance === false ? 'not_applicable' : 'untracked' : null,
    featureSupport: {
      material_content: capability(Boolean(reader.readMaterial), materialContentAvailable, 'pdf', false),
      material_view: capability(Boolean(reader.recordMaterialView), materialViewAvailable, 'pdf', true,
        detail.omitProgress === null || detail.omitProgress === undefined ? null : !detail.omitProgress),
      manual_video: capability(Boolean(reader.readVideo), manualVideoAvailable, 'video', false),
      manual_video_progress: capability(Boolean(reader.readVideo), manualVideoAvailable && detail.useAttendance === true && writableCourse,
        'video', true, detail.useAttendance),
    },
    observedAt};
}

/** School data is returned only when the corresponding read succeeds. Unsupported sections are explicit. */
export function createLearningxReads(reader: LearningxReader, playbackSelectable = false): Pick<SchoolProvider, 'courses' | 'courseTerms' | 'dashboard' | 'course' | 'tasks' | 'validateTasks' | 'attendance' | 'activity' | 'material' | 'video' | 'recordMaterialView' | 'syllabus' | 'syllabusMaterial' | 'calendar' | 'validateCalendar' | 'assignments' | 'assignment' | 'assignmentFile' | 'assignmentHistory' | 'assignmentHistoryFile' | 'learningStatus' | 'refreshLearningStatus'> {
  const taskProofs = new WeakMap<object, { owner: string; value: TasksRead }>();
  const calendarProofs = new WeakMap<object, { owner: string; value: CalendarRead }>();
  const read = async <T>(run: () => Promise<T>): Promise<T> => {
    try { return await run(); } catch (error) { return normalizeSchoolReadError(error); }
  };
  return {
    courses: (context, options) => read(async () => {
      const catalog = await reader.catalog(context.userId, options);
      return { items: catalog.courses, term: catalog.term, selectedTermId: catalog.termIds.length === 1 ? catalog.termIds[0] : null };
    }),
    ...(reader.readTerms ? { courseTerms: context => read(() => reader.readTerms!(context.userId)) } satisfies Pick<SchoolProvider, 'courseTerms'> : {}),
    dashboard: (context, options) => read(async () => {
      const overview = options?.detail === 'overview';
      const value = overview ? { ...(await reader.catalog(context.userId)), upcomingTasks: [], coursesAvailable: true, tasksAvailable: false }
        : await readLmsDashboard(reader, context.userId);
      return { courses: value.courses, term: value.term, timetable: [], currentCourse: null,
        currentActivities: [], currentActivityItems: [], upcomingTasks: value.upcomingTasks,
        ...(overview ? { detail: 'overview' } : {}),
        featureSupport: {
          courses: featureSupport(true, 'course', { availability: 'available', reason: null, read: true, write: false }),
          timetable: featureSupport(false, 'course'),
          tasks: featureSupport(true, 'course', { availability: value.tasksAvailable ? 'available' : overview ? 'unknown' : 'unavailable',
            reason: value.tasksAvailable ? null : overview ? 'overview_only' : 'source_unavailable', read: value.tasksAvailable ? true : null, write: false }),
          current_activities: featureSupport(false, 'module_collection', { reason: 'provider_unavailable' }),
        },
        availability: { courses: value.coursesAvailable ? 'available' : 'unavailable', timetable: 'unavailable',
          tasks: value.tasksAvailable ? 'available' : 'unavailable', currentActivities: 'unavailable' } };
    }),
    ...(reader.readActivity ? { activity: (context, courseId, moduleItemId) => read(async () => {
      const {course, detail, observedAt, readystreamMediaVerified} = await reader.readActivity!(context.userId, courseId, moduleItemId);
      if (detail.courseId !== courseId || detail.moduleItemId !== moduleItemId) throw new SchoolError('unexpected_response');
      return publicActivityDetail(detail, observedAt, reader, course, readystreamMediaVerified);
    }) } satisfies Pick<SchoolProvider, 'activity'> : {}),
    ...(reader.recordMaterialView ? { recordMaterialView: (context, courseId, moduleItemId, observation, validate) => read(async () => {
      const result = await reader.recordMaterialView!(context.userId, courseId, moduleItemId, observation, validate);
      if (result.detail.courseId !== courseId || result.detail.moduleItemId !== moduleItemId || result.detail.resourceType !== 'pdf'
        || !['recorded', 'already_completed'].includes(result.report)
        || result.report === 'already_completed' && (result.detail.itemContentType !== 'commons' || result.detail.published !== true
          || result.detail.opened !== true || result.detail.omitProgress !== false || result.detail.attendance.completed !== true))
        throw new SchoolError('unexpected_response');
      if (result.moduleCompleted !== undefined && result.moduleCompleted !== null && typeof result.moduleCompleted !== 'boolean')
        throw new SchoolError('unexpected_response');
      return { activity: { ...publicActivityDetail(result.detail, result.observedAt, reader, result.course),
        ...(result.moduleCompleted !== undefined ? { moduleCompleted: result.moduleCompleted } : {}) }, report: result.report };
    }) } satisfies Pick<SchoolProvider, 'recordMaterialView'> : {}),
    ...(reader.readMaterial ? { material: (context, courseId, moduleItemId, options) => read(() =>
      reader.readMaterial!(context.userId, courseId, moduleItemId, options)) } satisfies Pick<SchoolProvider, 'material'> : {}),
    ...(reader.readVideo ? { video: (context, courseId, moduleItemId, request) => read(() =>
      reader.readVideo!(context.userId, courseId, moduleItemId, request)) } satisfies Pick<SchoolProvider, 'video'> : {}),
    ...(reader.readSyllabus ? {
      syllabus: (context, courseId, options) => read(async () => {
        const value = await reader.readSyllabus!(context.userId, courseId, options);
        if (value.courseId !== courseId || !/^[a-f0-9]{64}$/.test(value.documentVersion)) throw new SchoolError('unexpected_response');
        return { courseId, title: '강의계획서', resourceType: 'pdf', documentAvailable: true,
          documentVersion: value.documentVersion, sourceUrl: null };
      }),
      syllabusMaterial: (context, courseId, options) => read(async () => {
        const value = await reader.readSyllabus!(context.userId, courseId, options);
        if (value.courseId !== courseId) throw new SchoolError('unexpected_response');
        return { bytes: value.bytes };
      }),
    } satisfies Pick<SchoolProvider, 'syllabus' | 'syllabusMaterial'> : {}),
    ...(reader.readLearningStatus ? { learningStatus: (context, target, signal) => read(() =>
      reader.readLearningStatus!(context.userId, target.courseId, target.lectureId, signal)) } satisfies Pick<SchoolProvider, 'learningStatus'> : {}),
    ...(reader.readLearningStatus && reader.refreshLearningStatus ? { refreshLearningStatus: (context, target, result, options) => read(() =>
      reader.refreshLearningStatus!(context.userId, target.courseId, target.lectureId, result, options)) } satisfies Pick<SchoolProvider, 'refreshLearningStatus'> : {}),
    ...(reader.readAssignments ? { assignments: (context, courseId, options) => read(async () =>
      publicAssignments(await reader.readAssignments!(context.userId, courseId, options), courseId)) } satisfies Pick<SchoolProvider, 'assignments'> : {}),
    ...(reader.readAssignment ? { assignment: (context, courseId, assignmentId, options) => read(async () =>
      publicAssignmentDetail(await reader.readAssignment!(context.userId, courseId, assignmentId, options), courseId, assignmentId)) } satisfies Pick<SchoolProvider, 'assignment'> : {}),
    ...(reader.readAssignmentFile ? { assignmentFile: (context, courseId, assignmentId, fileId, options) => read(() =>
      reader.readAssignmentFile!(context.userId, courseId, assignmentId, fileId, options)) } satisfies Pick<SchoolProvider, 'assignmentFile'> : {}),
    ...(reader.readAssignmentHistory ? { assignmentHistory: (context, courseId, assignmentId, options) => read(async () =>
      publicAssignmentHistory(await reader.readAssignmentHistory!(context.userId, courseId, assignmentId, options), courseId, assignmentId)) } satisfies Pick<SchoolProvider, 'assignmentHistory'> : {}),
    ...(reader.readAssignmentHistoryFile ? { assignmentHistoryFile: (context, courseId, assignmentId, attemptKey, fileId, options) => read(() =>
      reader.readAssignmentHistoryFile!(context.userId, courseId, assignmentId, attemptKey, fileId, options)) } satisfies Pick<SchoolProvider, 'assignmentHistoryFile'> : {}),
    ...(reader.readCalendar ? { calendar: (context, query, options) => read(async () => {
      const value = await reader.readCalendar!(context.userId, query, options);
      const result = publicCalendarLearning(value, query);
      if (reader.validateCalendar) calendarProofs.set(result, { owner: context.userId, value });
      return result;
    }) } satisfies Pick<SchoolProvider, 'calendar'> : {}),
    ...(reader.validateCalendar ? { validateCalendar: (context, result) => read(async () => {
      const proof = result && typeof result === 'object' ? calendarProofs.get(result) : undefined;
      if (!proof || proof.owner !== context.userId)
        throw new AppError(409, 'SCHOOL_SESSION_CHANGED', '학교 세션이 갱신됐습니다. 다시 조회해 주세요.');
      calendarProofs.delete(result as object);
      await reader.validateCalendar!(context.userId, proof.value, context.sessionTokenHash);
    }) } satisfies Pick<SchoolProvider, 'validateCalendar'> : {}),
    tasks: (context, options) => read(async () => { const value = await reader.readTasks(context.userId, options);
      const result = { items: publicTasks(value), courses: publicTaskCatalog(value.catalog, value.groups).courses };
      if (reader.validateTasks) taskProofs.set(result, { owner: context.userId, value });
      return result; }),
    ...(reader.validateTasks ? { validateTasks: (context, result) => read(async () => {
      const proof = result && typeof result === 'object' ? taskProofs.get(result) : undefined;
      if (!proof || proof.owner !== context.userId)
        throw new AppError(409, 'SCHOOL_SESSION_CHANGED', '학교 세션이 갱신됐습니다. 다시 조회해 주세요.');
      taskProofs.delete(result as object);
      await reader.validateTasks!(context.userId, proof.value, context.sessionTokenHash);
    }) } satisfies Pick<SchoolProvider, 'validateTasks'> : {}),
    attendance: (context, courseId) => read(async () => ({ items: publicAttendance(await reader.readAttendance(context.userId, courseId)) })),
    course: (context, courseId) => read(async () => {
      const value = await reader.readCourse(context.userId, courseId);
      return publicCourseContent(value, Boolean(reader.readActivity), playbackSelectable);
    }),
  };
}

export function publicCourseContent({ course, modules, lessons, observedAt }: Pick<CourseRead, 'course' | 'modules'> & Partial<Pick<CourseRead, 'lessons' | 'observedAt'>>, detailsAvailable = false, playbackSelectable = false, now = Date.now()) {
  const courseId = course.id;
  const currentWeek = currentSchoolWeek(lessons, observedAt, new Date(now));
  const weeks = modules.map(module => ({ id: module.id, number: module.week, title: module.title,
        isCurrent: module.week !== null && currentWeek.numbers.includes(module.week),
        activities: module.items.map(item => {
          const type = moduleType(item), unlockAt = instant(item.unlockAt);
          const detailAvailable = Boolean(detailsAvailable && item.activityDetailAvailable === true);
          // List metadata only permits selection. Admission independently revalidates identity,
          // ownership, opened/report flags and the supported media before accepting a job.
          const playbackAvailable = playbackSelectable && course.schoolDefaultTerm !== false && course.ended !== true && type === 'video' && item.resourceType !== 'readystream' && detailAvailable
            && item.published === true && unlockAt !== null && Date.parse(unlockAt) <= now;
          const schoolAssignment = (item as ObservedModuleItem).assignmentId;
          return { id: item.id, courseId, title: item.title,
            type, resourceType: ['movie', 'readystream', 'pdf', 'file'].includes(item.resourceType ?? '') ? item.resourceType as 'movie' | 'readystream' | 'pdf' | 'file' : null,
            sourceUrl: null, playbackAvailable, progressPercent: null, schoolStatus: null,
            assignmentId: type === 'assignment' && typeof schoolAssignment === 'string' && /^[1-9]\d{0,15}$/.test(schoolAssignment) ? schoolAssignment : null,
            dueAt: instant(item.dueAt), unlockAt,
            moduleCompleted: item.completed ?? null, published: item.published ?? null,
            detailAvailable };
        }) }));
      const activities = weeks.flatMap(week => week.activities);
      return { course, weeks, currentWeek, notices: [], materials: activities.filter(item => item.type === 'material'),
        assignments: activities.filter(item => item.type === 'assignment'), quizzes: [],
        // These categories project the verified module list, not the school's full resource/assignment collections.
        categoryScope: { materials: 'modules', assignments: 'modules' },
        featureSupport: {
          weeks: featureSupport(true, 'module_collection', { availability: 'available', reason: null, read: true, write: false }),
          materials: featureSupport(true, 'module_collection', { availability: 'available', reason: null, read: true, write: false }),
          assignments: featureSupport(true, 'module_collection', { availability: 'available', reason: null, read: true, write: false }),
          notices: featureSupport(false, 'course', { reason: 'not_implemented' }),
          quizzes: featureSupport(false, 'course', { reason: 'not_implemented' }),
        },
        availability: { weeks: 'available', notices: 'unavailable', materials: 'available', assignments: 'available', quizzes: 'unavailable' } };
}
