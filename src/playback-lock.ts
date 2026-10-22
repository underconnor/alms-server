/** Every new execution, claim, lease and explicit settlement shares this owner fence. */
export const playbackAccountLock = 'SELECT pg_advisory_xact_lock(hashtextextended($1,0))';
export const playbackAccountLockKey = (userId: string) => `playback-execution:${userId}`;
