import { progressCacheResources } from './school-progress-cache.js';
import { withSchoolPlayback } from './playback-bootstrap.js';
import { PgSchoolReadCache } from './school-read-cache.js';
import { Pool } from 'pg';
import { loadConfig } from './config.js';
import { PgStore } from './store.js';
import { unavailableSchoolProvider } from './provider.js';
import { createQueueClient, startWorker } from './queue.js';
import { startAnalyticsWorker } from './analytics-worker.js';
import { workerPgOptions } from './worker-bounds.js';
import { shutdownWorker } from './worker-shutdown.js';
import { installedPlaybackIdentity, PgPlaybackReadiness, startReadyPlaybackWorker } from './playback-worker-readiness.js';
import { probeControlledPlaybackRuntime } from './controlled-playback-runtime.js';
const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl, max: 6, query_timeout: 6000, ...workerPgOptions });
pool.on('error', () => process.stderr.write('{"code":"WORKER_DATABASE_ERROR"}\n'));
const boss = createQueueClient(config.databaseUrl);
const controller = new AbortController();
boss.on('error',() => { process.stderr.write('{"code":"QUEUE_ERROR"}\n'); controller.abort('queue-error'); void shutdown().catch(() => {}); });
const store = new PgStore(pool);
const cache = config.sessionEncryptionKey ? new PgSchoolReadCache(pool, config.sessionEncryptionKey) : undefined;
const provider = config.playbackEnabled && config.sessionEncryptionKey && cache
  ? withSchoolPlayback(unavailableSchoolProvider, store, config.sessionEncryptionKey,
    (owner, courseId, lectureId) => cache.deleteMany(owner, 'ssu', progressCacheResources([{ courseId, lectureId }]), controller.signal),
    diagnostic => process.stderr.write(JSON.stringify({ time: new Date().toISOString(), ...diagnostic }) + '\n'))
  : unavailableSchoolProvider;
const started = (async () => {
  await store.health();
  // Disabled playback preserves queued/reserved work; analytics continues independently.
  return startReadyPlaybackWorker({
    enabled: provider.capabilities.playback, signal: controller.signal,
    repository: async () => {
      const readiness = new PgPlaybackReadiness(pool, await installedPlaybackIdentity(config.commit));
      await readiness.isReady(controller.signal); // Verify migration 009 before Chromium or queue startup.
      return readiness;
    },
    probe: probeControlledPlaybackRuntime,
    startQueue: () => startWorker(store,boss,provider,controller.signal,code => {
      process.stderr.write(JSON.stringify({ code }) + '\n'); controller.abort('queue-error'); void shutdown().catch(() => {});
    }),
    failed: () => {
      process.stderr.write('{"code":"WORKER_READINESS_FAILED"}\n'); controller.abort('readiness-error'); void shutdown().catch(() => {});
    },
  });
})();
let stopAnalytics: () => Promise<void> = async () => {};
let ending: Promise<void> | undefined;
const shutdown = () => ending ??= shutdownWorker({
  controller, stop: [async () => (await started)(), () => stopAnalytics()], close: () => pool.end(),
  failed: () => { process.stderr.write('{"code":"WORKER_SHUTDOWN_FAILED"}\n'); process.exit(1); },
});
for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal, () => { void shutdown().catch(() => {}); });
// Install signal handlers before awaiting queue startup, which itself may be waiting for DB.
try {
  await started;
  if (!controller.signal.aborted) {
    stopAnalytics = startAnalyticsWorker(store.analytics, config.posthogKey, () => process.stderr.write('{"code":"ANALYTICS_WORKER_ERROR"}\n'));
    process.stdout.write(JSON.stringify({status:'worker_started',playbackProvider:provider.capabilities.playback}) + '\n');
  }
} catch {
  // Keep raw connection/SQL errors out of process output, including startup interrupted by SIGTERM.
  if (!controller.signal.aborted) process.stderr.write('{"code":"WORKER_STARTUP_FAILED"}\n');
  await shutdown().catch(() => {});
}
