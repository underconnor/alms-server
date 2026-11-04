import { AppError } from './errors.js';

export interface SourceReadObserver {
  signal?: AbortSignal;
  validate?: () => Promise<void>;
  personalCompletionCourses?: (courseIds: readonly string[]) => Promise<readonly string[]>;
}
export interface SharedSourceReadOptions extends SourceReadObserver {
  signal: AbortSignal;
  validate: () => Promise<void>;
}
type Member = { options: SourceReadObserver };
type Flight = { owner: string; controller: AbortController; members: Set<Member>; promise: Promise<unknown>; settled: boolean };
const cancelled = () => new AppError(503, 'SCHOOL_PROVIDER_UNAVAILABLE', '최신 정보 확인이 중단됐습니다. 다시 시도해 주세요.');
const preferFailure = (previous: unknown, next: unknown) => previous === undefined
  || previous instanceof AppError && previous.statusCode === 401 && !(next instanceof AppError && next.statusCode === 401) ? next : previous;

/** Only equivalent fresh reads share work. Each waiter retains its own session and cancellation. */
export function createSourceReadFlights() {
  const flights = new Map<string, Flight>();
  return async function share<T>(scope: { owner: string; generation: string; resource: string; policy: string },
    options: SourceReadObserver, run: (options: SharedSourceReadOptions) => Promise<T>): Promise<T> {
    options.signal?.throwIfAborted(); await options.validate?.(); options.signal?.throwIfAborted();
    const id = JSON.stringify([scope.owner, scope.generation, scope.resource, scope.policy]);
    let flight = flights.get(id);
    if (flight?.controller.signal.aborted) flight = undefined;
    if (!flight) {
      if (flights.size >= 128 || [...flights.values()].filter(value => value.owner === scope.owner).length >= 8)
        throw new AppError(429, 'SOURCE_REFRESH_BUSY', '최신 정보를 확인하고 있어요. 잠시 후 다시 시도해 주세요.');
      flight = { owner: scope.owner, controller: new AbortController(), members: new Set(), settled: false, promise: Promise.resolve() };
      const work = flight;
      const signal = AbortSignal.any([work.controller.signal, AbortSignal.timeout(90_000)]);
      const eligible = () => [...work.members].filter(member => !member.options.signal?.aborted);
      const validate = async () => {
        signal.throwIfAborted();
        let failure: unknown;
        for (const member of eligible()) {
          try { await member.options.validate?.(); if (!member.options.signal?.aborted) return; }
          catch (error) { failure = preferFailure(failure, error); }
        }
        throw failure ?? cancelled();
      };
      const personalCompletionCourses = async (courseIds: readonly string[]): Promise<readonly string[]> => {
        signal.throwIfAborted(); let failure: unknown;
        for (const member of eligible()) {
          try {
            await member.options.validate?.();
            if (member.options.signal?.aborted) continue;
            const result = await member.options.personalCompletionCourses?.(courseIds) ?? [];
            await member.options.validate?.();
            if (!member.options.signal?.aborted) return result;
          } catch (error) { failure = preferFailure(failure, error); }
        }
        throw failure ?? cancelled();
      };
      // Defer until the first member is registered. No caller owns the shared signal.
      work.promise = Promise.resolve().then(() => run({ signal, validate, personalCompletionCourses })).finally(() => {
        work.settled = true;
        if (flights.get(id) === work) flights.delete(id);
      });
      flights.set(id, work);
    }
    const work = flight;
    if (work.members.size >= 64) throw new AppError(429, 'SOURCE_REFRESH_BUSY', '최신 정보를 확인하고 있어요. 잠시 후 다시 시도해 주세요.');
    const member: Member = { options }; work.members.add(member);
    let rejectAbort!: (error: unknown) => void;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const detach = () => {
      work.members.delete(member);
      if (!work.members.size && !work.settled) work.controller.abort();
    };
    const abort = () => { detach(); rejectAbort(cancelled()); };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    try {
      const value = await Promise.race([work.promise as Promise<T>, aborted]);
      options.signal?.throwIfAborted(); await options.validate?.(); options.signal?.throwIfAborted();
      return value;
    } catch (error) {
      // A shared upstream failure must not turn an expired caller's 401 into
      // another caller's logout, or conceal this waiter's own revoked session.
      if (options.signal?.aborted) throw cancelled();
      await options.validate?.();
      throw error;
    } finally { options.signal?.removeEventListener('abort', abort); detach(); }
  };
}
