export const workerShutdownTimeoutMs = 35_000;

/** Abort first, then drain consumers and close the pool. The caller must terminate the
 * process on failure: a non-cooperative adapter or driver must not keep it alive forever. */
export function shutdownWorker(options: {
  controller: AbortController;
  stop: Array<() => Promise<void>>;
  close: () => Promise<void>;
  failed: () => void;
  timeoutMs?: number;
}): Promise<void> {
  options.controller.abort('shutdown');
  return new Promise<void>((resolve, reject) => {
    let done = false;
    const finish = (error?: unknown) => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (error) { options.failed(); reject(new Error('WORKER_SHUTDOWN_FAILED')); }
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error('WORKER_SHUTDOWN_TIMEOUT')), options.timeoutMs ?? workerShutdownTimeoutMs);
    void (async () => {
      // Invoke every stop function even if one fails synchronously.
      const outcomes = await Promise.allSettled(options.stop.map(stop => Promise.resolve().then(stop)));
      await options.close();
      if (outcomes.some(outcome => outcome.status === 'rejected')) throw new Error('WORKER_STOP_FAILED');
    })().then(() => finish(), finish);
  });
}
