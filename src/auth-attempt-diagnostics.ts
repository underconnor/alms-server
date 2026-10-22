/** Process-local evidence only. A miss does not prove that an attempt never succeeded. */
export class IssuedAttemptDiagnostics {
  #issued = new Map<string, number>();
  #now: () => number;
  #ttlMs: number;
  #capacity: number;

  constructor(options: {now?: () => number; ttlMs?: number; capacity?: number} = {}) {
    this.#now = options.now ?? (() => performance.now());
    this.#ttlMs = options.ttlMs ?? 300_000;
    this.#capacity = options.capacity ?? 1024;
    if (!Number.isFinite(this.#ttlMs) || this.#ttlMs <= 0 || !Number.isInteger(this.#capacity) || this.#capacity <= 0)
      throw new RangeError('Invalid diagnostic retention bounds.');
  }

  #prune(now: number): void {
    for (const [key, expiresAt] of this.#issued) if (expiresAt <= now) this.#issued.delete(key);
  }

  rememberSessionIssued(stateHash: string): void {
    // Only the hash of the validated one-use callback state is retained, never school/session credentials.
    if (!/^[a-f0-9]{64}$/.test(stateHash)) return;
    const now = this.#now();
    this.#prune(now);
    if (this.#issued.has(stateHash)) return;
    while (this.#issued.size >= this.#capacity) this.#issued.delete(this.#issued.keys().next().value!);
    this.#issued.set(stateHash, now + this.#ttlMs);
  }

  sameAttemptPreviouslyIssuedSession(stateHash: string): boolean {
    this.#prune(this.#now());
    return this.#issued.has(stateHash);
  }
}
