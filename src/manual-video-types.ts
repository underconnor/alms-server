import type { SchoolResult } from './domain.js';
export interface ManualVideoContext { owner: string; sessionHash: string; courseId: string; moduleItemId: string }
export interface ManualVideoObservation { positionSeconds: number; durationSeconds: number; playbackRate: number; paused: boolean; ended: boolean; seeking: boolean; visible: boolean; capturedAtMs?: number }
export type ManualVideoEvent = 'playing' | 'update' | 'unload' | 'ended';
export interface PreparedManualVideo {
  generation: string; encryptedSession: string; baseline: number;
  /** Capability from this exact SDK-owned controller, not a request assertion. */
  observationTiming?: 'client_monotonic_v1';
  /** Current generation/identity only; this must not query the school on every heartbeat. */
  validate(signal: AbortSignal): Promise<void>;
  observe(value: ManualVideoObservation): void;
  report(event: ManualVideoEvent, validate: () => Promise<void>, signal: AbortSignal): Promise<{ transport: 'acknowledged' | 'unknown'; school: SchoolResult; state: 'ready' | 'closed' }>;
  close(): void;
}
export interface ManualVideoSchool {
  prepare(context: ManualVideoContext, validate: () => Promise<void>, signal: AbortSignal): Promise<PreparedManualVideo>;
}
