import { AsyncLocalStorage } from 'node:async_hooks';
import { AppError } from './errors.js';

/** The dedicated coordinator must keep its lock until run settles, including cancellation. */
export type SchoolSessionLockRunner = <T>(owner: string, run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal) => Promise<T>;
type Options = { coordinate?: SchoolSessionLockRunner; signal?: AbortSignal };
const held = new AsyncLocalStorage<ReadonlySet<string>>();
const uninterrupted = new AbortController().signal;
/** Serialize jar refreshes locally and, when configured, across API/worker processes.
 * A nested same-owner acquisition is a programming error, not another queued request. */
const pending = new Map<string, Promise<unknown>>();
export function withSchoolSessionLock<T>(owner: string, run: (signal: AbortSignal) => Promise<T>, options: Options = {}): Promise<T> {
  if (held.getStore()?.has(owner)) return Promise.reject(new AppError(503, 'SCHOOL_SESSION_LOCK_REENTRANT', '학교 요청 처리를 다시 확인해 주세요.'));
  const previous = pending.get(owner) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => {
    options.signal?.throwIfAborted();
    const execute = (coordinated: AbortSignal) => {
      const signal = options.signal ? AbortSignal.any([options.signal, coordinated]) : coordinated;
      signal.throwIfAborted();
      return held.run(new Set([...(held.getStore() ?? []), owner]), () => run(signal));
    };
    return options.coordinate ? options.coordinate(owner, execute, options.signal) : execute(options.signal ?? uninterrupted);
  });
  pending.set(owner, next);
  void next.finally(() => { if (pending.get(owner) === next) pending.delete(owner); }).catch(() => {});
  return next;
}
