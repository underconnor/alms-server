import { AppError } from './errors.js';
import { publicCourseContent, readLmsDashboard, type DashboardReader } from './school-read.js';
import type { SchoolProvider } from './provider.js';
import type { SaintReader, Schedule } from './saint-reader.js';
import { mapScheduleCourses } from './course-mapping.js';
import { SchoolError } from '@alms/ssu-api';
import { featureSupport } from './feature-support.js';

export function currentActivityItems(content: ReturnType<typeof publicCourseContent>, now: number) {
  return content.weeks.filter(week => week.isCurrent).flatMap(week => week.activities.map(item => ({
    id: item.id, courseId: item.courseId, weekId: week.id, title: item.title, type: item.type, resourceType: item.resourceType,
    assignmentId: item.assignmentId, published: item.published, moduleCompleted: item.moduleCompleted,
    dueAt: item.dueAt, unlockAt: item.unlockAt, detailAvailable: item.detailAvailable, playbackAvailable: item.playbackAvailable,
    status: {
      completion: item.moduleCompleted === true ? 'completed' as const : item.moduleCompleted === false ? 'incomplete' as const : 'unknown' as const,
      publication: item.published === true ? 'published' as const : item.published === false ? 'unpublished' as const : 'unknown' as const,
      // An elapsed unlock date is not proof that the school's actual player has opened.
      unlock: item.unlockAt === null ? 'unknown' as const : Date.parse(item.unlockAt) > now ? 'scheduled' as const : 'elapsed' as const,
    },
  })));
}

function sourceError(error: unknown): 'SCHOOL_AUTH_REQUIRED' | 'SCHOOL_UPSTREAM_UNAVAILABLE' {
  return error instanceof AppError && error.code === 'SCHOOL_AUTH_REQUIRED'
    || error instanceof SchoolError && ['authentication_required', 'identity_mismatch'].includes(error.code)
    ? 'SCHOOL_AUTH_REQUIRED' : 'SCHOOL_UPSTREAM_UNAVAILABLE';
}

export function currentSchedule(entries: Schedule[], now: Date): Schedule | null {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const part = (type: string) => parts.find(item => item.type === type)?.value ?? '';
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(part('weekday')) + 1;
  const time = `${part('hour')}:${part('minute')}`;
  return entries.find(entry => entry.dayOfWeek === weekday && entry.startTime <= time && time < entry.endTime) ?? null;
}

const sourceReadTimeout = () => new AppError(502, 'SCHOOL_UPSTREAM_UNAVAILABLE', '일부 학교 정보를 불러오지 못했습니다. 다시 조회해 주세요.');

// Once one source is usable, give the other a bounded window to complete it.
// This only bounds what the response waits for; each connector still owns its
// lock, deadline and error handling until its pending operation settles.
async function settleDashboardOverview<A, B>(first: Promise<A>, second: Promise<B>, waitMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  const timeout = new Promise<never>((_, reject) => {
    void Promise.any([first, second]).then(() => {
      if (!done) timer = setTimeout(() => reject(sourceReadTimeout()), waitMs);
    }, () => {});
  });
  try { return await Promise.allSettled([Promise.race([first, timeout]), Promise.race([second, timeout])]); }
  finally { done = true; clearTimeout(timer); }
}

async function optionalCatalog(lms: DashboardReader, owner: string, waitMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => lms.catalog(owner)).catch(() => null),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), waitMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

/** Timetable remains usable when LMS fails; each empty section has explicit source availability. */
export function createCombinedDashboard(saint: SaintReader, lms?: DashboardReader, now = () => new Date(),
  waits = { optionalCatalogMs: 2_000, overviewSourceMs: 5_000 }): Pick<SchoolProvider, 'dashboard' | 'timetable'> {
  return {
    timetable: async context => {
      const value = await saint.timetable(context.userId);
      const catalog = lms && value.entries.length ? await optionalCatalog(lms, context.userId, waits.optionalCatalogMs) : null;
      return { items: mapScheduleCourses(value.entries, catalog?.courses ?? [], value.term), term: value.term };
    },
    dashboard: async (context, options) => {
      const overview = options?.detail === 'overview';
      const saintRead = Promise.resolve().then(() => saint.timetable(context.userId));
      const lmsRead = Promise.resolve().then(() => {
        if (!lms) throw new AppError(503, 'SCHOOL_PROVIDER_UNAVAILABLE', 'LMS 조회를 준비하고 있습니다.');
        return overview ? lms.catalog(context.userId).then(value => ({ ...value, upcomingTasks: [], coursesAvailable: true, tasksAvailable: false }))
          : readLmsDashboard(lms, context.userId);
      });
      const [timetable, catalog] = overview ? await settleDashboardOverview(saintRead, lmsRead, waits.overviewSourceMs)
        : await Promise.allSettled([saintRead, lmsRead]);
      if (timetable.status === 'rejected' && catalog.status === 'rejected') {
        if ([timetable.reason, catalog.reason].some(error => sourceError(error) === 'SCHOOL_AUTH_REQUIRED'))
          throw new AppError(401, 'SCHOOL_AUTH_REQUIRED', '학교 인증을 다시 확인해야 합니다. 통합 로그인으로 이어서 이용해 주세요.');
        throw timetable.reason;
      }
      const courses = catalog.status === 'fulfilled' ? catalog.value.courses : [];
      const entries = timetable.status === 'fulfilled' ? mapScheduleCourses(timetable.value.entries, courses, timetable.value.term) : [];
      const schedule = currentSchedule(entries, now());
      const course = schedule?.courseId ? courses.find(course => course.id === schedule.courseId) : null;
      const currentCourse = course ? { ...course, room: schedule!.room, scheduleLabel: `${schedule!.startTime}–${schedule!.endTime}`,
        scheduleStartTime: schedule!.startTime, scheduleEndTime: schedule!.endTime, timeZone: 'Asia/Seoul' } : null;
      let currentActivities: ReturnType<typeof publicCourseContent>['materials'] = [];
      let allCurrentActivities: ReturnType<typeof currentActivityItems> = [];
      let currentActivitiesAvailable = false;
      let currentActivitiesError: ReturnType<typeof sourceError> | null = null;
      if (!overview && course && lms?.readCourse) {
        try {
          const read = await lms.readCourse(context.userId, course.id);
          if (read.course.id === course.id) {
            const timestamp = now().getTime();
            const content = publicCourseContent(read, true, false, timestamp);
            allCurrentActivities = currentActivityItems(content, timestamp);
            currentActivities = content.weeks.filter(week => week.isCurrent).flatMap(week => week.activities)
              .filter(item => item.published === true && (!item.unlockAt || Date.parse(item.unlockAt) <= timestamp))
              .sort((a, b) => {
                const priority = (value: typeof a) => value.dueAt && Date.parse(value.dueAt) >= timestamp ? Date.parse(value.dueAt) : Infinity;
                return priority(a) - priority(b);
              }).slice(0, 3);
            currentActivitiesAvailable = content.currentWeek.source === 'school_lesson_dates';
          }
        } catch (error) { currentActivitiesError = sourceError(error); /* Preserve the verified timetable/course match. */ }
      }
      return {
        ...(overview ? { detail: 'overview' } : {}),
        sourceErrors: { courses: catalog.status === 'rejected' ? sourceError(catalog.reason) : null,
          tasks: !overview && catalog.status === 'rejected' ? sourceError(catalog.reason) : null,
          timetable: timetable.status === 'rejected' ? sourceError(timetable.reason) : null,
          currentActivities: currentActivitiesError },
        term: timetable.status === 'fulfilled' ? timetable.value.term : catalog.status === 'fulfilled' ? catalog.value.term : null,
        courses,
        timetable: entries, currentSchedule: schedule, currentCourse,
        currentActivities, currentActivityItems: allCurrentActivities, upcomingTasks: catalog.status === 'fulfilled' ? catalog.value.upcomingTasks : [],
        featureSupport: {
          courses: featureSupport(Boolean(lms), 'course', { availability: catalog.status === 'fulfilled' ? 'available' : 'unavailable',
            reason: catalog.status === 'fulfilled' ? null : 'source_unavailable', read: catalog.status === 'fulfilled', write: false }),
          timetable: featureSupport(true, 'course', { availability: timetable.status === 'fulfilled' ? 'available' : 'unavailable',
            reason: timetable.status === 'fulfilled' ? null : 'source_unavailable', read: timetable.status === 'fulfilled', write: false }),
          tasks: featureSupport(Boolean(lms?.readTasks), 'course', {
            availability: catalog.status === 'fulfilled' && catalog.value.tasksAvailable ? 'available' : overview ? 'unknown' : 'unavailable',
            reason: !lms?.readTasks ? 'provider_unavailable' : overview ? 'overview_only'
              : catalog.status === 'fulfilled' && catalog.value.tasksAvailable ? null : 'source_unavailable',
            read: catalog.status === 'fulfilled' && catalog.value.tasksAvailable ? true : null, write: false }),
          current_activities: featureSupport(Boolean(lms?.readCourse), 'module_collection', {
            availability: currentActivitiesAvailable ? 'available' : overview || !course ? 'unknown' : 'unavailable',
            reason: !lms?.readCourse ? 'provider_unavailable' : currentActivitiesAvailable ? null : overview ? 'overview_only'
              : currentActivitiesError ? 'source_unavailable' : 'school_week_unavailable',
            read: currentActivitiesAvailable ? true : null, write: false }),
        },
        availability: { courses: catalog.status === 'fulfilled' && catalog.value.coursesAvailable ? 'available' : 'unavailable',
          timetable: timetable.status === 'fulfilled' ? 'available' : 'unavailable',
          tasks: catalog.status === 'fulfilled' && catalog.value.tasksAvailable ? 'available' : 'unavailable', currentActivities: currentActivitiesAvailable ? 'available' : 'unavailable' },
      };
    },
  };
}
