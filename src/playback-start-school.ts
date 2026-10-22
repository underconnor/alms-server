import { createSchoolVideoSessions, type SchoolVideoSessionStore } from './school-video-session.js';
import type { PlaybackStartSchool } from './playback-start-service.js';
import { AppError } from './errors.js';

export function createPlaybackStartSchool(store: SchoolVideoSessionStore, key: Buffer,
  invalidate: (owner: string, courseId: string, activityId: string) => Promise<void>, fetcher: typeof fetch = fetch): PlaybackStartSchool {
  const sessions = createSchoolVideoSessions(store, key, invalidate, fetcher, { allowReadystreamManual: true });
  return { prepare: async (context, validate, signal) => {
    const driver = await sessions.prepare(context, validate, signal);
    if (!driver.confirmStart) { driver.close(); throw new AppError(503, 'PLAYBACK_START_UNAVAILABLE', '학교 진도 기록 시작을 준비하지 못했습니다.'); }
    return { generation: driver.generation, authority: (validate, signal) => driver.authority(validate, signal),
      confirmStart: (observation, validate, signal) => driver.confirmStart!(observation, validate, signal), close: () => driver.close() };
  } };
}
