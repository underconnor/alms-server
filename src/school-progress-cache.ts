export type ProgressCacheTarget = { courseId: string; lectureId: string };

/** Metadata/progress only: retain other courses, timetable and document bytes. */
export function progressCacheResources(targets: readonly ProgressCacheTarget[]): string[] {
  if (targets.length > 200) throw new Error('CACHE_TARGET_LIMIT');
  const keys = new Set<string>();
  for (const { courseId, lectureId } of targets) {
    if (![courseId, lectureId].every(value => /^[A-Za-z0-9:_-]{1,200}$/.test(value))) throw new Error('CACHE_TARGET_INVALID');
    keys.add(`course:${courseId}`); keys.add(`activity:${courseId}:${lectureId}`);
    keys.add(`calendar-modules:${courseId}`);
    keys.add('tasks'); keys.add('attendance'); keys.add(`attendance:${courseId}`);
  }
  return [...keys];
}
