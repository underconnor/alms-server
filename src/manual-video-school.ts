import { createSchoolVideoSessions, type SchoolVideoSessionStore } from './school-video-session.js';
import type { ManualVideoSchool } from './manual-video-types.js';

/** Browser manual playback retains its existing request/session guard. Worker authority is separate. */
export function createManualVideoSchool(store: SchoolVideoSessionStore, key: Buffer,
  invalidate: (owner: string, courseId: string, activityId: string) => Promise<void>, fetcher: typeof fetch = fetch): ManualVideoSchool {
  const sessions = createSchoolVideoSessions(store, key, invalidate, fetcher, { allowReadystreamManual: true });
  return { prepare: async (context, validate, signal) => {
    const prepared = await sessions.prepare(context, validate, signal);
    let closed = false;
    return { generation: prepared.generation, encryptedSession: prepared.encryptedSession, baseline: prepared.baseline,
      ...(prepared.observationTiming ? { observationTiming: prepared.observationTiming } : {}),
      validate: async currentSignal => { if (closed) throw new DOMException('Playback closed', 'AbortError'); await prepared.validate(currentSignal); },
      observe: value => prepared.observe(value), report: (event, current, reportSignal) => prepared.report(event, current, reportSignal),
      close: () => { closed = true; prepared.close(); },
    };
  } };
}
