import { createHash, randomUUID } from 'node:crypto';
import { SchoolHttpClient, SaintTimetableClient, parseUsaintIdentity, type SaintTimetable } from '@alms/ssu-api';
import { z } from 'zod';
import { decryptSchoolSession, encryptSchoolSession } from './crypto.js';
import { AppError } from './errors.js';
import { normalizeSchoolReadError } from './school-read.js';
import { withSchoolSessionLock } from './school-session-lock.js';
import { schoolCacheTtl, type SchoolReadCache } from './school-read-cache.js';

const stateSchema = z.object({ version: z.literal(1), generation: z.uuid().optional(), identity: z.object({ studentId: z.string().regex(/^\d{6,12}$/) }).passthrough(), jar: z.unknown() }).passthrough();
type Store = {
  getEncryptedSchoolSession(owner: string, provider: string): Promise<string | null>;
  replaceEncryptedSchoolSession(owner: string, provider: string, previous: string, next: string): Promise<boolean>;
};
export type Schedule = { id: string; courseId: string | null; courseTitle: string; dayOfWeek: number; startTime: string; endTime: string; room: string | null; professor: string | null };
export interface SaintReader { timetable(owner: string): Promise<{ term: string; entries: Schedule[] }> }
type Connector = (state: z.infer<typeof stateSchema>) => Promise<{ timetable: SaintTimetable; jar: unknown }>;
const open: Connector = async state => {
  const http = SchoolHttpClient.fromSessionJar(state.jar);
  const portal = await http.get('https://saint.ssu.ac.kr/webSSUMain/main_student.jsp');
  parseUsaintIdentity(portal.body, state.identity.studentId);
  const timetable = await new SaintTimetableClient(http).read();
  return { timetable, jar: await http.jar.serialize() };
};
const semesters = { '090': '1학기', '091': '여름학기', '092': '2학기', '093': '겨울학기' };
export function createSaintReader(store: Store, key: Buffer, connect: Connector = open, durable?: SchoolReadCache): SaintReader {
  type Result = Awaited<ReturnType<SaintReader['timetable']>>;
  const cache = new Map<string, { generation: string; expiresAt: number; value: Result }>();
  const pending = new Map<string, Promise<Result>>();
  return { timetable(owner) {
    const active = pending.get(owner);
    if (active) return active;
    const result = withSchoolSessionLock(owner, async () => {
      const encrypted = await store.getEncryptedSchoolSession(owner, 'ssu');
      if (!encrypted) { cache.delete(owner); throw new AppError(401, 'SCHOOL_AUTH_REQUIRED', '학교 로그인이 필요합니다.'); }
      let state: z.infer<typeof stateSchema>;
      try { state = stateSchema.parse(decryptSchoolSession(encrypted, key, owner, 'ssu')); }
      catch { throw new AppError(401, 'SCHOOL_AUTH_REQUIRED', '저장된 학교 세션을 확인할 수 없습니다. 다시 로그인해 주세요.'); }
      const existing = cache.get(owner);
      const generation = state.generation ?? randomUUID();
      const scope = (encryptedSession: string) => ({ owner, provider: 'ssu', generation, resource: 'saint:timetable', encryptedSession });
      const currentSession = async (expected: string) => {
        if (await store.getEncryptedSchoolSession(owner, 'ssu') !== expected)
          throw new AppError(409, 'SCHOOL_SESSION_CHANGED', '학교 세션이 갱신됐습니다. 다시 조회해 주세요.');
      };
      if (state.generation && existing?.generation === state.generation && existing.expiresAt > Date.now()) { await currentSession(encrypted); return existing.value; }
      if (state.generation && durable) {
        const persisted = await durable.get<Result>(scope(encrypted)).catch(() => null);
        if (persisted && persisted.expiresAt > Date.now()) {
          await currentSession(encrypted);
          if (!cache.has(owner) && cache.size >= 100) cache.delete(cache.keys().next().value!);
          cache.set(owner, { generation, expiresAt: Math.min(Date.now() + 60_000, persisted.expiresAt), value: persisted.value });
          return persisted.value;
        }
      }
      const response = await connect(state);
      const updated = encryptSchoolSession({ ...state, generation, jar: response.jar }, key, owner, 'ssu');
      if (!await store.replaceEncryptedSchoolSession(owner, 'ssu', encrypted, updated)) {
        throw new AppError(409, 'SCHOOL_SESSION_CHANGED', '학교 세션이 갱신됐습니다. 다시 조회해 주세요.');
      }
      const term = `${response.timetable.selectedYear}년 ${semesters[response.timetable.selectedSemester]}`;
      const entries = response.timetable.entries.map((entry, index) => ({ ...entry, courseId: null,
        id: createHash('sha256').update(JSON.stringify([term, entry, index])).digest('hex').slice(0, 24) }));
      const value = { term, entries };
      if (durable) await durable.put(scope(updated), value, schoolCacheTtl('saint:timetable')).catch(() => false);
      await currentSession(updated);
      for (const [ownerKey, entry] of cache) if (entry.expiresAt <= Date.now()) cache.delete(ownerKey);
      if (cache.size >= 100) cache.delete(cache.keys().next().value!);
      cache.set(owner, { generation, expiresAt: Date.now() + 60_000, value });
      return value;
    }).catch(async error => { cache.delete(owner); if (durable) await durable.delete(owner, 'ssu', 'saint:timetable').catch(() => {}); return normalizeSchoolReadError(error); }).finally(() => { pending.delete(owner); });
    pending.set(owner, result);
    return result;
  } };
}
