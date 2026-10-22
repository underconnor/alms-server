import { AppError } from './errors.js';

type Pending<T> = { promise: Promise<T>; expiresAt: number; participants: number; timer: ReturnType<typeof setTimeout> };
type Options = { maxFlights?: number; maxParticipants?: number; retentionMs?: number; duplicateWaitMs?: number; now?: () => number };

/** A short process-local rendezvous for exact, still-running cookie callbacks.
 * It is not an authentication cache: completion/expiry removes the lookup, and
 * every unshared execution still has to consume the original SQL binding. */
export class CookieCallbackFlights<T> {
  #pending = new Map<string, Pending<T>>();
  #maxFlights: number;
  #maxParticipants: number;
  #retentionMs: number;
  #duplicateWaitMs: number;
  #now: () => number;

  constructor(options: Options = {}) {
    this.#maxFlights = options.maxFlights ?? 64;
    this.#maxParticipants = options.maxParticipants ?? 8;
    this.#retentionMs = options.retentionMs ?? 60_000;
    this.#duplicateWaitMs = options.duplicateWaitMs ?? 15_000;
    this.#now = options.now ?? (() => performance.now());
    if (![this.#maxFlights, this.#maxParticipants, this.#retentionMs, this.#duplicateWaitMs]
      .every(value => Number.isSafeInteger(value) && value > 0)) throw new RangeError('Invalid callback sharing limits.');
  }

  #remove(key: string, entry: Pending<T>): void {
    clearTimeout(entry.timer);
    if (this.#pending.get(key) === entry) this.#pending.delete(key);
  }

  #prune(): void {
    const now = this.#now();
    for (const [key, entry] of this.#pending) if (entry.expiresAt <= now) this.#remove(key, entry);
  }

  get pendingCount(): number { this.#prune(); return this.#pending.size; }

  run(key: string, execute: () => Promise<T>): Promise<T> {
    // The caller hashes length-framed client/state/binding/artifact values. Raw
    // credentials, request objects and issued tokens are never lookup keys.
    if (!/^[a-f0-9]{64}$/.test(key)) throw new RangeError('Invalid callback sharing key.');
    this.#prune();
    const existing = this.#pending.get(key);
    if (existing && existing.participants < this.#maxParticipants) return this.#wait(existing);
    // Capacity must not change the first callback's SQL, provider or issuance
    // behavior. Overflow simply uses the existing unshared authentication path.
    if (existing || this.#pending.size >= this.#maxFlights) return Promise.resolve().then(execute);

    let entry!: Pending<T>;
    const promise = Promise.resolve().then(execute).finally(() => this.#remove(key, entry));
    const timer = setTimeout(() => this.#remove(key, entry), this.#retentionMs);
    timer.unref();
    entry = { promise, expiresAt: this.#now() + this.#retentionMs, participants: 0, timer };
    this.#pending.set(key, entry);
    // Only duplicate waiters have a new deadline. Neither lookup expiry nor a
    // duplicate timeout cancels, repeats or delays the original execution.
    return promise;
  }

  #wait(entry: Pending<T>): Promise<T> {
    entry.participants++;
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new AppError(502, 'SCHOOL_UPSTREAM_UNAVAILABLE',
        '학교 로그인 확인 요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.')), this.#duplicateWaitMs);
      timer.unref();
    });
    return Promise.race([entry.promise, deadline]).finally(() => { clearTimeout(timer); entry.participants--; });
  }

  /** Shutdown drops only the rendezvous; it never cancels an accepted callback. */
  close(): void { for (const [key, entry] of this.#pending) this.#remove(key, entry); }
}
