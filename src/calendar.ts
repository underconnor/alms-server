import { z } from 'zod';
import { AppError } from './errors.js';
import { SchoolError } from '@alms/ssu-api';
import type { Catalog } from './school-read.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00Z`);
  return value >= '2000-01-01' && value <= '2100-12-31' && Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
});
const courseId = z.string().regex(/^[1-9]\d{0,15}$/);
export const calendarQuery = z.object({ start: day, end: day, courseId: courseId.optional() }).strict().refine(value => {
  const days = (Date.parse(value.end) - Date.parse(value.start)) / 86_400_000;
  return days >= 1 && days <= 31;
});
export type CalendarQuery = z.infer<typeof calendarQuery>;
export const calendarReadQuery = z.object({ start: day, end: day, courseId: courseId.optional(), refresh: z.literal('1').optional() }).strict();
const instant = z.iso.datetime({ offset: true }).nullable();
const item = z.object({
  id: z.string().min(1).max(200).regex(/^[A-Za-z0-9:_-]+$/), type: z.enum(['event', 'assignment']),
  courseId, title: z.string().min(1).max(10000), startsAt: instant, endsAt: instant,
  allDay: z.boolean(), allDayDate: day.nullable(), dueAt: instant,
  assignmentId: courseId.nullable(), sourceUrl: z.string().max(2048).nullable(),
  userSubmitted: z.boolean().nullable().default(null),
});
const result = z.object({ start: day, end: day, timeZone: z.literal('Asia/Seoul'),
  courses: z.array(z.object({ id: courseId, title: z.string().min(1).max(10000) })).max(100),
  items: z.array(item).max(2000), complete: z.literal(true) });
export type CalendarData = Omit<z.infer<typeof result>, 'items'> & { items: Array<z.infer<typeof item> & {
  moduleItemId?: string; weekId?: string; moduleCompleted?: boolean | null; personalCompleted?: boolean | null;
}> };

/** Only Canvas's own-user flag can mark a calendar assignment submitted; dates never do. */
export function publicCalendar(input: unknown, query: CalendarQuery, catalog?: Catalog): CalendarData {
  const parsed = result.safeParse(input);
  if (!parsed.success) throw new SchoolError('unexpected_response');
  const value = parsed.data, courses = new Map(value.courses.map(course => [course.id, course.title]));
  if (value.start !== query.start || value.end !== query.end || courses.size !== value.courses.length
    || query.courseId && !courses.has(query.courseId)) throw new SchoolError('unexpected_response');
  if (catalog && (new Set(catalog.courses.map(course => course.id)).size !== catalog.courses.length
    || catalog.courses.length !== courses.size || catalog.courses.some(course => courses.get(course.id) !== course.title)))
    throw new SchoolError('unexpected_response');
  const seen = new Set<string>();
  for (const entry of value.items) {
    if (!courses.has(entry.courseId) || query.courseId && entry.courseId !== query.courseId || seen.has(entry.id)
      || entry.allDay && !entry.allDayDate || entry.type === 'assignment' && !entry.assignmentId)
      throw new SchoolError('unexpected_response');
    seen.add(entry.id);
    const start = entry.startsAt ? Date.parse(entry.startsAt) : null, end = entry.endsAt ? Date.parse(entry.endsAt) : null;
    const rangeStart = Date.parse(query.start + 'T00:00:00+09:00'), rangeEnd = Date.parse(query.end + 'T00:00:00+09:00');
    const inRange = entry.allDay ? entry.allDayDate! >= query.start && entry.allDayDate! < query.end
      : start !== null && start < rangeEnd && (end !== null && end > start ? end > rangeStart : start >= rangeStart);
    if (!inRange || start !== null && end !== null && end < start
      || entry.type === 'assignment' && (entry.id !== `assignment_${entry.assignmentId}` || entry.dueAt === null
        || start !== Date.parse(entry.dueAt) || end !== Date.parse(entry.dueAt))
      || entry.type === 'event' && (!courseId.safeParse(entry.id).success || entry.assignmentId !== null || entry.dueAt !== null || entry.userSubmitted !== null))
      throw new SchoolError('unexpected_response');
    // The browser never receives query parameters or arbitrary source destinations.
    if (entry.sourceUrl) {
      try {
        const url = new URL(entry.sourceUrl);
        entry.sourceUrl = url.href === entry.sourceUrl && !url.port && url.origin === 'https://canvas.ssu.ac.kr' && !url.username && !url.password
          && !url.search && !url.hash && entry.type === 'assignment'
          && url.pathname === `/courses/${entry.courseId}/assignments/${entry.assignmentId}` ? url.href : null;
      } catch { entry.sourceUrl = null; }
    }
  }
  if (Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024) throw new SchoolError('unsupported');
  return value;
}

/** A bounded hit must match its owned catalog proof; refresh/miss rechecks current enrollment. */
export function calendarMatchesCatalog(value: unknown, query: CalendarQuery, catalog: Catalog): boolean {
  try { publicCalendar(value, query, catalog); return true; } catch { return false; }
}

/** Covers even a slow session recheck without logging transport or school values. */
export function awaitCalendarRead<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new AppError(503, 'CALENDAR_UNAVAILABLE', '캘린더 조회가 중단됐습니다. 다시 시도해 주세요.'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    void pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
