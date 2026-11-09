import type { WorkerClaim } from './playback-authority.js';
import type { ManualVideoObservation } from './manual-video-types.js';
import type { WorkerOperation } from './worker-bounds.js';
export interface PlaybackObservation {
  observedAt: string; positionSeconds: number; durationSeconds: number; percent: number; paused: boolean; ended: boolean;
}
export interface PlaybackReportAck { event: 'playing' | 'update' | 'ended'; acknowledgedAt: string }
export interface PlaybackProgress extends PlaybackObservation { lastReport: PlaybackReportAck | null }
const timestamp = (value: unknown): value is string => typeof value === 'string'
  && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
export function validPlaybackObservation(value: unknown): value is PlaybackObservation {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).length === 6 && timestamp(v.observedAt) && finite(v.positionSeconds) && v.positionSeconds >= 0
    && finite(v.durationSeconds) && v.durationSeconds > 0 && v.durationSeconds <= 14400
    && v.positionSeconds <= v.durationSeconds + 0.25 && finite(v.percent) && v.percent >= 0 && v.percent <= 100
    && Math.abs(v.percent - Math.min(100, v.positionSeconds / v.durationSeconds * 100)) < 0.000001
    && typeof v.paused === 'boolean' && typeof v.ended === 'boolean'
    && (!v.ended || Math.abs(v.durationSeconds - v.positionSeconds) <= 0.25);
}
export function validPlaybackReportAck(value: unknown): value is PlaybackReportAck {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).length === 2 && ['playing','update','ended'].includes(String(v.event)) && timestamp(v.acknowledgedAt);
}
/** Explicit projection prevents internal claim fields or malformed rows reaching HTTP. */
export function publicPlaybackProgress(observation: unknown, reportAck: unknown): PlaybackProgress | null {
  if (!validPlaybackObservation(observation)) return null;
  return { observedAt: observation.observedAt, positionSeconds: observation.positionSeconds,
    durationSeconds: observation.durationSeconds, percent: observation.percent, paused: observation.paused, ended: observation.ended,
    lastReport: validPlaybackReportAck(reportAck) ? { event: reportAck.event, acknowledgedAt: reportAck.acknowledgedAt } : null };
}
export function publicJobPlaybackProgress(value: unknown): PlaybackProgress | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { lastReport, ...observation } = value as Record<string, unknown>;
  return publicPlaybackProgress(observation, lastReport);
}
export interface PlaybackProgressRepository {
  recordPlaybackObservation(claim: WorkerClaim, value: PlaybackObservation, operation?: WorkerOperation): Promise<boolean>;
  recordPlaybackReportAck(claim: WorkerClaim, value: PlaybackReportAck, operation?: WorkerOperation): Promise<boolean>;
}
type Entry = { claim: WorkerClaim; observation?: PlaybackObservation; ack?: PlaybackReportAck; pending?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>; lastWrite: number; stopped: boolean; lost: boolean };
/** Never blocks the sampler or changes school report success/retry policy. */
export function createPlaybackProgressRecorder(repository: PlaybackProgressRepository,
  options: { now?: () => number; intervalMs?: number } = {}) {
  const now = options.now ?? Date.now, interval = options.intervalMs ?? 2000;
  if (!Number.isFinite(interval) || interval < 10 || interval > 10000) throw new RangeError('Invalid progress interval');
  const entries = new Map<string, Entry>(), closed = new WeakSet<WorkerClaim>();
  const key = (claim: WorkerClaim) => claim.jobId + ':' + claim.executionTokenHash;
  const entryFor = (claim: WorkerClaim) => {
    if (closed.has(claim)) return undefined;
    const id = key(claim); let entry = entries.get(id);
    if (!entry) { entry = { claim, lastWrite: -Infinity, stopped: false, lost: false }; entries.set(id, entry); }
    return entry;
  };
  const schedule = (entry: Entry, immediate = false) => {
    if (entry.lost || entry.pending || entry.timer || !entry.observation && !entry.ack) return;
    const wait = immediate || entry.stopped || entry.ack ? 0 : Math.max(0, interval - (now() - entry.lastWrite));
    if (wait) {
      entry.timer = setTimeout(() => { entry.timer = undefined; schedule(entry, true); }, wait); entry.timer.unref?.(); return;
    }
    entry.lastWrite = now();
    const observation = entry.observation, ack = entry.ack; entry.observation = undefined; entry.ack = undefined;
    entry.pending = (async () => {
      try {
        const operation = { timeoutMs: 750 };
        if (observation && !await repository.recordPlaybackObservation(entry.claim, observation, operation)) entry.lost = true;
        if (!entry.lost && ack && !await repository.recordPlaybackReportAck(entry.claim, ack, operation)) entry.lost = true;
      } catch { /* Best-effort display metadata, never a retry of a school write. */ }
    })().finally(() => { entry.pending = undefined; if (!entry.lost) schedule(entry, entry.stopped); });
  };
  return {
    observe(claim: WorkerClaim, value: ManualVideoObservation): void {
      if (value.playbackRate !== 1 || value.seeking || !finite(value.positionSeconds) || !finite(value.durationSeconds)) return;
      const observation = { observedAt: new Date(now()).toISOString(), positionSeconds: value.positionSeconds,
        durationSeconds: value.durationSeconds, percent: Math.min(100, value.positionSeconds / value.durationSeconds * 100),
        paused: value.paused, ended: value.ended };
      if (!validPlaybackObservation(observation)) return;
      const entry = entryFor(claim); if (!entry || entry.stopped || entry.lost) return;
      entry.observation = observation;
      if (value.ended && entry.timer) { clearTimeout(entry.timer); entry.timer = undefined; }
      schedule(entry, value.ended);
    },
    acknowledge(claim: WorkerClaim, event: PlaybackReportAck['event']): void {
      if (!['playing','update','ended'].includes(event)) return;
      const entry = entryFor(claim); if (!entry || entry.stopped || entry.lost) return;
      entry.ack = { event, acknowledgedAt: new Date(now()).toISOString() };
      if (entry.timer) { clearTimeout(entry.timer); entry.timer = undefined; }
      schedule(entry, true);
    },
    async flushAndStop(claim: WorkerClaim): Promise<void> {
      closed.add(claim); const id = key(claim), entry = entries.get(id); if (!entry) return;
      entry.stopped = true; if (entry.timer) { clearTimeout(entry.timer); entry.timer = undefined; }
      schedule(entry, true);
      while (entry.pending) await entry.pending;
      if (entries.get(id) === entry) entries.delete(id);
    },
  };
}
