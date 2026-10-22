import type { SchoolLessonWeek } from '@alms/ssu-api';

export type CurrentSchoolWeek = { source: 'school_lesson_dates' | 'unavailable'; numbers: number[]; observedAt: string | null };
function schoolDate(value: string | null): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date.getTime() : null;
}
/** Exact school week positions joined to real lesson dates in the current Seoul Monday–Sunday. */
export function currentSchoolWeek(lessons: SchoolLessonWeek[] | null | undefined, observedAt?: string, now = new Date()): CurrentSchoolWeek {
  const unavailable: CurrentSchoolWeek = { source: 'unavailable', numbers: [], observedAt: observedAt ?? null };
  if (!lessons || !Number.isFinite(now.getTime())) return unavailable;
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const localDate = schoolDate(day);
  if (localDate === null) return unavailable;
  const monday = localDate - ((new Date(localDate).getUTCDay() + 6) % 7) * 86_400_000;
  const numbers = new Set<number>(); let validDates = 0;
  for (const week of lessons) {
    if (week.week === null || !Number.isSafeInteger(week.week) || week.week < 1 || week.week > 100) continue;
    for (const lesson of week.lessons) {
      const timestamp = schoolDate(lesson.makeupDate || lesson.classDate);
      if (timestamp === null) continue;
      validDates++;
      if (monday <= timestamp && timestamp < monday + 7 * 86_400_000) numbers.add(week.week);
    }
  }
  return validDates ? { source: 'school_lesson_dates', numbers: [...numbers].sort((a, b) => a - b), observedAt: observedAt ?? null } : unavailable;
}
