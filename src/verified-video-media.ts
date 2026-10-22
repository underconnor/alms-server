import { createHash } from 'node:crypto';
import { SchoolHttpClient, SchoolError, inspectSchoolVideoLaunch, resolveSchoolVideoMedia, inspectSchoolVideoMedia,
  type SchoolVideoLaunch, type SchoolVideoMediaData } from '@alms/ssu-api';

type Operations = { resolve: typeof resolveSchoolVideoMedia; inspect: typeof inspectSchoolVideoMedia };
type Verified = { launch: SchoolVideoLaunch; media: SchoolVideoMediaData };
/** Private opaque handles only. Never persist this cache or reuse a caller's authority/signal. */
export function createVerifiedVideoMediaCache(operations: Operations = { resolve: resolveSchoolVideoMedia, inspect: inspectSchoolVideoMedia },
  limits: { now?: () => number; ttlMs?: number; entries?: number } = {}) {
  const entries = new Map<string, { expiresAt: number; value: Verified }>();
  const now = limits.now ?? Date.now;
  return async (owner: string, generation: string, launch: SchoolVideoLaunch, validate: () => Promise<void>,
    signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<Verified> => {
    const current = async () => { signal.throwIfAborted(); await validate(); signal.throwIfAborted(); };
    await current();
    const data = inspectSchoolVideoLaunch(launch), readystream = data.contentType === 'readystream';
    // Include the complete viewer/target, flags and attendance baseline. A new launch never inherits proof.
    const key = createHash('sha256').update(JSON.stringify([owner, generation, data])).digest('hex');
    for (const [key, value] of entries) if (value.expiresAt <= now()) entries.delete(key);
    const hit = readystream ? entries.get(key) : undefined;
    if (hit) { await current(); return hit.value; }
    // Pending work is deliberately not shared: cancellation and authority belong to this caller.
    const anonymous = new SchoolHttpClient(undefined, async (input, init) => {
      await current();
      const response = await fetcher(input, { ...init, signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]) });
      try { await current(); return response; }
      catch (error) { void response.body?.cancel().catch(() => {}); throw error; }
    });
    let media: SchoolVideoMediaData;
    try { media = operations.inspect(await operations.resolve(launch, anonymous, { signal })); }
    catch (error) { await current(); throw error; }
    await current();
    if (media.contentId !== data.contentId || media.detail.courseId !== data.detail.courseId
      || media.detail.moduleItemId !== data.detail.moduleItemId || media.detail.itemId !== data.detail.itemId
      || media.detail.resourceType !== data.detail.resourceType || media.detail.durationSeconds !== data.detail.durationSeconds
      || media.detail.useAttendance !== data.detail.useAttendance || media.useAttendance !== data.detail.useAttendance
      || media.mimeType !== 'video/mp4' || media.delivery !== 'progressive' || media.callbackVerified !== false)
      throw new SchoolError('forbidden_target');
    const value = { launch, media };
    if (readystream) {
      if (!entries.has(key) && entries.size >= (limits.entries ?? 100)) entries.delete(entries.keys().next().value!);
      entries.set(key, { expiresAt: now() + (limits.ttlMs ?? 30_000), value });
    }
    return value;
  };
}
/** Shared by detail, manual preparation and byte requests in this process, scoped to owner and school generation. */
export const verifiedVideoMedia = createVerifiedVideoMediaCache();
