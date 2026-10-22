import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { boundedWorkerOperation, workerTransaction } from './worker-bounds.js';

export interface PlaybackBuildIdentity { readonly commit: string; readonly sdkSha256: string }
export interface PlaybackReadinessReader { isReady(signal?: AbortSignal): Promise<boolean> }
export const playbackReadinessPolicy = Object.freeze({ lifetimeMs: 30_000, heartbeatMs: 10_000, databaseMs: 5000 });

/** Hash installed executable SDK files, not a vendor archive omitted by runtime images. */
export async function installedPlaybackIdentity(commit: string, sdkRoot = dirname(dirname(fileURLToPath(import.meta.resolve('@alms/ssu-api'))))): Promise<PlaybackBuildIdentity> {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('PLAYBACK_BUILD_IDENTITY_INVALID');
  const hash = createHash('sha256'); let count = 0, bytes = 0;
  const append = async (file: string) => {
    const info = await lstat(file);
    if (!info.isFile() || ++count > 1024 || (bytes += info.size) > 32 * 1024 * 1024) throw new Error('PLAYBACK_BUILD_IDENTITY_INVALID');
    const contents = await readFile(file), path = relative(sdkRoot, file);
    hash.update(String(Buffer.byteLength(path)) + ':' + path + ':' + contents.length + ':'); hash.update(contents);
  };
  await append(join(sdkRoot, 'package.json'));
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) await append(file);
      else throw new Error('PLAYBACK_BUILD_IDENTITY_INVALID');
    }
  };
  await walk(join(sdkRoot, 'dist'));
  if (count < 2) throw new Error('PLAYBACK_BUILD_IDENTITY_INVALID');
  return Object.freeze({ commit, sdkSha256: hash.digest('hex') });
}

export class PgPlaybackReadiness implements PlaybackReadinessReader {
  constructor(private readonly pool: Pool, private readonly identity: PlaybackBuildIdentity) {
    if (!/^[0-9a-f]{40}$/.test(identity.commit) || !/^[0-9a-f]{64}$/.test(identity.sdkSha256)) throw new Error('PLAYBACK_BUILD_IDENTITY_INVALID');
  }
  isReady(signal?: AbortSignal): Promise<boolean> {
    return workerTransaction(this.pool, async query => {
      const result = await query(`SELECT EXISTS(SELECT 1 FROM playback_worker_readiness
        WHERE backend_commit=$1 AND sdk_sha256=$2 AND ready_until>clock_timestamp()) AS ready`, [this.identity.commit, this.identity.sdkSha256]);
      return result.rows[0]?.ready === true;
    }, { signal, timeoutMs: playbackReadinessPolicy.databaseMs });
  }
  renew(instance: string, signal?: AbortSignal): Promise<void> {
    return workerTransaction(this.pool, async query => {
      await query('DELETE FROM playback_worker_readiness WHERE ready_until<=clock_timestamp()');
      const result = await query(`INSERT INTO playback_worker_readiness(instance_id,backend_commit,sdk_sha256,ready_until)
        VALUES($1,$2,$3,clock_timestamp()+interval '30 seconds')
        ON CONFLICT(instance_id) DO UPDATE SET ready_until=EXCLUDED.ready_until
        WHERE playback_worker_readiness.backend_commit=EXCLUDED.backend_commit AND playback_worker_readiness.sdk_sha256=EXCLUDED.sdk_sha256`,
      [instance, this.identity.commit, this.identity.sdkSha256]);
      if (result.rowCount !== 1) throw new Error('PLAYBACK_BUILD_IDENTITY_INVALID');
    }, { signal, timeoutMs: playbackReadinessPolicy.databaseMs });
  }
  withdraw(instance: string): Promise<void> {
    return workerTransaction(this.pool, async query => {
      await query('DELETE FROM playback_worker_readiness WHERE instance_id=$1 AND backend_commit=$2 AND sdk_sha256=$3', [instance, this.identity.commit, this.identity.sdkSha256]);
    }, { timeoutMs: 2500 });
  }
}

export async function startReadyPlaybackWorker(options: {
  enabled: boolean; signal: AbortSignal;
  repository(): Promise<HeartbeatRepository>;
  probe(signal: AbortSignal): Promise<void>;
  startQueue(): Promise<() => Promise<void>>;
  failed(): void;
}): Promise<() => Promise<void>> {
  if (!options.enabled || options.signal.aborted) return async () => {};
  const repository = await options.repository(); options.signal.throwIfAborted();
  await options.probe(options.signal); options.signal.throwIfAborted();
  const stopQueue = await options.startQueue();
  try {
    const stopHeartbeat = await startPlaybackHeartbeat(repository, options.signal, options.failed);
    let stopping: Promise<void> | undefined;
    return () => stopping ??= Promise.all([stopHeartbeat(), stopQueue()]).then(() => {});
  } catch (error) { await stopQueue(); throw error; }
}

export async function playbackIsReady(reader?: PlaybackReadinessReader, signal?: AbortSignal): Promise<boolean> {
  if (!reader) return false;
  try { return await boundedWorkerOperation(inner => reader.isReady(inner), { signal, timeoutMs: playbackReadinessPolicy.databaseMs }) === true; }
  catch { return false; }
}

interface HeartbeatRepository { renew(instance: string, signal?: AbortSignal): Promise<void>; withdraw(instance: string): Promise<void> }
/** Start only after the runtime probe and queue registration succeed. Stop is idempotent and fences late renewals. */
export async function startPlaybackHeartbeat(repository: HeartbeatRepository, signal: AbortSignal, failed: () => void,
  options: { intervalMs?: number; instance?: string } = {}): Promise<() => Promise<void>> {
  const instance = options.instance ?? randomUUID(), controller = new AbortController();
  let timer: ReturnType<typeof setInterval> | undefined, pending: Promise<void> | undefined, stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    controller.abort(); if (timer) clearInterval(timer); signal.removeEventListener('abort', aborted);
    await pending?.catch(() => {});
    await repository.withdraw(instance);
  })();
  const aborted = () => { void stop().catch(() => {}); };
  signal.addEventListener('abort', aborted, { once: true });
  const renew = () => {
    if (pending || controller.signal.aborted || signal.aborted) return;
    pending = boundedWorkerOperation(inner => repository.renew(instance, inner), { signal: controller.signal, timeoutMs: 5000 })
      .catch(() => { if (!controller.signal.aborted && !signal.aborted) { failed(); void stop().catch(() => {}); } })
      .finally(() => { pending = undefined; });
  };
  try {
    signal.throwIfAborted();
    pending = boundedWorkerOperation(inner => repository.renew(instance, inner), { signal: AbortSignal.any([signal, controller.signal]), timeoutMs: 5000 });
    await pending; pending = undefined;
    signal.throwIfAborted();
    timer = setInterval(renew, options.intervalMs ?? playbackReadinessPolicy.heartbeatMs).unref();
    return stop;
  } catch (error) { await stop().catch(() => {}); throw error; }
}
