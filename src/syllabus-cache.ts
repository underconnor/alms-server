import { createHash } from 'node:crypto';
import { AppError } from './errors.js';

export interface SyllabusDocument { bytes: Buffer; pageCount: number; documentVersion: string }
export type SyllabusLoader = (signal: AbortSignal) => Promise<{ bytes: Uint8Array; pageCount: number }>;
const changed = () => new AppError(409, 'SYLLABUS_REFRESHED', '강의계획서를 다시 불러오고 있습니다. 잠시 후 다시 열어 주세요.');
const unavailable = () => new AppError(503, 'SYLLABUS_UNAVAILABLE', '강의계획서를 아직 불러올 수 없습니다. 잠시 후 다시 시도해 주세요.');

/** Only validated bytes, bounded and scoped to a user, login generation and course. No filesystem cache. */
export function createSyllabusCache(options: { ttlMs?: number; maximumBytes?: number; waitMs?: number } = {}) {
  // Reuse an export through ordinary reading/navigation. Every reader call still
  // checks current school ownership and login generation before returning bytes.
  const ttl = options.ttlMs ?? 30 * 60_000, maximum = options.maximumBytes ?? 64 * 1024 * 1024;
  type Entry = { owner: string; key: string; abort: AbortController; promise: Promise<SyllabusDocument>; value?: SyllabusDocument; expires: number };
  const entries = new Map<string, Entry>();
  const queue: Array<{ owner: string; start: () => void; cancel: () => void }> = [];
  let running = false, total = 0;
  const remove = (entry: Entry) => {
    if (entries.get(entry.key) !== entry) return;
    entries.delete(entry.key); entry.abort.abort(); if (entry.value) total -= entry.value.bytes.length;
  };
  const clean = () => { for (const entry of entries.values()) if (entry.value && entry.expires <= Date.now()) remove(entry); };
  const pump = () => { if (!running) queue.shift()?.start(); };
  const acquire = (owner: string, signal: AbortSignal): Promise<() => void> => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(changed()); return; }
    if (queue.length >= 4 || queue.some(row => row.owner === owner)) { reject(new AppError(429, 'RATE_LIMITED', '강의계획서를 준비하고 있습니다. 잠시 후 다시 시도해 주세요.')); return; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clear = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); };
    const cancel = () => { const index = queue.indexOf(item); if (index >= 0) queue.splice(index, 1); clear(); reject(changed()); pump(); };
    const item = { owner, cancel, start: () => { clear(); running = true; let released = false; resolve(() => { if (!released) { released = true; running = false; pump(); } }); } };
    signal.addEventListener('abort', cancel, { once: true });
    if (!running) item.start(); else { timer = setTimeout(cancel, options.waitMs ?? 20_000); queue.push(item); }
  });
  return {
    invalidate(owner: string, courseId?: string) {
      for (const entry of entries.values()) if (entry.owner === owner && (!courseId || JSON.parse(entry.key)[2] === courseId)) remove(entry);
    },
    invalidateDocument(owner: string, generation: string, courseId: string, value: SyllabusDocument) {
      const entry = entries.get(JSON.stringify([owner, generation, courseId]));
      // A late failure belongs to the document it read, never a newer refresh or login.
      if (entry?.value === value) remove(entry);
    },
    isCurrent(owner: string, generation: string, courseId: string, value: SyllabusDocument) {
      const entry = entries.get(JSON.stringify([owner, generation, courseId]));
      return entry?.value === value && entry.expires > Date.now() && !entry.abort.signal.aborted;
    },
    async read(owner: string, generation: string, courseId: string, load: SyllabusLoader, refresh = false, callerSignal?: AbortSignal): Promise<SyllabusDocument> {
      if (callerSignal?.aborted) throw changed();
      clean();
      const key = JSON.stringify([owner, generation, courseId]);
      if (!entries.has(key) && entries.size >= 128) {
        const old = [...entries.values()].find(row => row.value); if (old) remove(old); else throw unavailable();
      }
      // A new login can never join pending or cached work from the previous generation.
      for (const entry of entries.values()) if (entry.owner === owner && JSON.parse(entry.key)[1] !== generation) remove(entry);
      const existing = entries.get(key);
      if (existing && !refresh) return existing.promise;
      if (existing) remove(existing);
      if ([...entries.values()].some(entry => entry.owner === owner && !entry.value))
        throw new AppError(429, 'RATE_LIMITED', '강의계획서를 준비하고 있습니다. 잠시 후 다시 시도해 주세요.');
      const entry = { owner, key, abort: new AbortController(), expires: 0 } as Entry;
      const run = async () => {
        const release = await acquire(owner, entry.abort.signal);
        try {
          const signal = AbortSignal.any([entry.abort.signal, AbortSignal.timeout(60_000)]);
          const value = await load(signal);
          if (signal.aborted || entries.get(key) !== entry) throw changed();
          if (!(value.bytes instanceof Uint8Array) || value.bytes.length < 16 || value.bytes.length > 16 * 1024 * 1024
            || !Number.isSafeInteger(value.pageCount) || value.pageCount < 1 || value.pageCount > 1000) throw unavailable();
          const bytes = Buffer.from(value.bytes);
          while (total + bytes.length > maximum) {
            const old = [...entries.values()].find(row => row.value && row !== entry);
            if (!old) throw unavailable(); remove(old);
          }
          entry.value = { bytes, pageCount: value.pageCount, documentVersion: createHash('sha256').update(bytes).digest('hex') };
          entry.expires = Date.now() + ttl; total += bytes.length;
          return entry.value;
        } catch (error) { remove(entry); throw error; }
        finally { release(); }
      };
      const cancel = () => remove(entry);
      entries.set(key, entry);
      callerSignal?.addEventListener('abort', cancel, { once: true });
      if (callerSignal?.aborted) cancel();
      entry.promise = run().finally(() => callerSignal?.removeEventListener('abort', cancel));
      // Queued cancellation rejects before entering the load body.
      void entry.promise.catch(() => remove(entry));
      return entry.promise;
    },
  };
}
