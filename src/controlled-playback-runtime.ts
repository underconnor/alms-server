import { inspect } from 'node:util';
import { chromium, type Browser, type BrowserContext, type BrowserServer } from 'playwright';
import { createPlaybackMediaProxy, type PlaybackMediaProxy } from './playback-media-proxy.js';
import type { VideoRequest, VideoResponse } from './video-stream.js';

const codes = [
  'SOURCE_INVALID',
  'SOURCE_USED',
  'ABORTED',
  'LAUNCH_FAILED',
  'ROUTE_BLOCKED',
  'MEDIA_INVALID',
  'START_TIMEOUT',
  'STALLED',
  'GUARD_FAILED',
  'REPORT_FAILED',
  'EXECUTION_TIMEOUT',
  'CLEANUP_FAILED',
] as const;
export type ControlledPlaybackFailure = (typeof codes)[number];
export class ControlledPlaybackError extends Error {
  constructor(readonly code: ControlledPlaybackFailure) {
    super(code);
    this.name = 'ControlledPlaybackError';
  }
}
const fail = (code: ControlledPlaybackFailure): never => {
  throw new ControlledPlaybackError(code);
};
export interface ControlledPlaybackObservation {
  readonly positionSeconds: number;
  readonly durationSeconds: number;
  readonly playbackRate: number;
  readonly paused: boolean;
  readonly ended: boolean;
  readonly seeking: boolean;
  readonly visible: boolean;
}
export interface ControlledPlaybackInput {
  expectedDurationSeconds: number;
  validate(signal: AbortSignal): Promise<void>;
  stream(request: VideoRequest): Promise<VideoResponse>;
  /** Synchronous observation only; reporting and DB checks must not block the sampler. */
  observe(value: ControlledPlaybackObservation): void;
  /** One school attempt; the hook must honor signal and must never retry a write. */
  report(event: 'playing' | 'update' | 'ended', signal: AbortSignal): Promise<void>;
  timeouts?: { startMs?: number; stallMs?: number; totalMs?: number };
}
type SourceData = Omit<ControlledPlaybackInput, 'timeouts'> & {
  timeouts: { startMs: number; stallMs: number; totalMs: number };
};
const brand: unique symbol = Symbol('ControlledPlaybackSource');
export interface ControlledPlaybackSource {
  readonly [brand]: true;
  toJSON(): { kind: 'private-controlled-playback-source' };
}
const sources = new WeakMap<ControlledPlaybackSource, SourceData>();
export function createControlledPlaybackSource(input: ControlledPlaybackInput): ControlledPlaybackSource {
  if (
    !input ||
    Object.keys(input).some(
      (key) => !['expectedDurationSeconds', 'validate', 'stream', 'observe', 'report', 'timeouts'].includes(key),
    ) ||
    !Number.isFinite(input.expectedDurationSeconds) ||
    input.expectedDurationSeconds <= 0 ||
    input.expectedDurationSeconds > 14400 ||
    ['validate', 'stream', 'observe', 'report'].some(
      (key) => typeof input[key as keyof ControlledPlaybackInput] !== 'function',
    )
  )
    return fail('SOURCE_INVALID');
  if (input.timeouts && Object.keys(input.timeouts).some((key) => !['startMs', 'stallMs', 'totalMs'].includes(key)))
    return fail('SOURCE_INVALID');
  const timeouts = {
    startMs: input.timeouts?.startMs ?? 30_000,
    stallMs: input.timeouts?.stallMs ?? 30_000,
    totalMs: input.timeouts?.totalMs ?? 4 * 60 * 60_000,
  };
  if (
    Object.values(timeouts).some((value) => !Number.isSafeInteger(value)) ||
    timeouts.startMs < 500 ||
    timeouts.startMs > 60_000 ||
    timeouts.stallMs < 500 ||
    timeouts.stallMs > 60_000 ||
    timeouts.totalMs < 1000 ||
    timeouts.totalMs > 4 * 60 * 60_000
  )
    return fail('SOURCE_INVALID');
  const source = Object.freeze({
    [brand]: true as const,
    toJSON: () => ({ kind: 'private-controlled-playback-source' as const }),
    [inspect.custom]: () => 'ControlledPlaybackSource { private }',
  });
  sources.set(source, Object.freeze({ ...input, timeouts: Object.freeze(timeouts) }));
  return source;
}
type LaunchResult = {
  browser: Browser;
  server: Pick<BrowserServer, 'close' | 'kill' | 'process'>;
};
type Launch = () => Promise<LaunchResult>;
export interface ControlledPlaybackEvidence {
  ended: true;
  mediaResponseObserved: true;
  playingObserved: true;
  positionAdvanced: true;
  elapsedMs: number;
  durationSeconds: number;
  finalPositionSeconds: number;
  browserClosed: true;
  processExited: true;
}
const bounded = <T>(
  promise: Promise<T>,
  ms: number,
  code: ControlledPlaybackFailure,
  signal?: AbortSignal,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>;
  let aborted!: () => void;
  const interruption = new Promise<never>((_, reject) => {
    aborted = () => reject(new ControlledPlaybackError(code));
    timer = setTimeout(aborted, ms);
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
  });
  return Promise.race([promise, interruption]).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', aborted);
  });
};
const launch: Launch = async () => {
  const server = await chromium.launchServer({
    headless: true,
    chromiumSandbox: true,
    host: '127.0.0.1',
    timeout: 20_000,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
  try {
    return {
      server,
      browser: await chromium.connect(server.wsEndpoint(), { timeout: 5000 }),
    };
  } catch {
    try {
      await bounded(server.kill(), 3000, 'CLEANUP_FAILED');
    } catch {
      return fail('CLEANUP_FAILED');
    }
    if (server.process().exitCode === null && server.process().signalCode === null) return fail('CLEANUP_FAILED');
    return fail('LAUNCH_FAILED');
  }
};
type Snapshot = ControlledPlaybackObservation & {
  connected: boolean;
  loop: boolean;
  src: string;
  error: number | null;
  count: number;
  playingCount: number;
  endedCount: number;
  seekCount: number;
};
const exited = (server: LaunchResult['server'] | undefined) =>
  !server || server.process().exitCode !== null || server.process().signalCode !== null;


type RuntimeResources = { pendingLaunch?: Promise<LaunchResult>; launchSettled: boolean;
  browser?: Browser; server?: LaunchResult['server']; context?: BrowserContext; proxy?: PlaybackMediaProxy };
/** Shared by playback and readiness. A late launch never makes an uncertain cleanup successful. */
async function closeRuntimeResources(current: () => RuntimeResources, finished: () => void): Promise<boolean> {
  const deadline = performance.now() + 7000;
  const left = (limit: number) => Math.max(1, Math.min(limit, deadline - performance.now()));
  let uncertain = false;
  const pending = current().pendingLaunch;
  if (pending && !current().launchSettled) {
    try { await bounded(pending, left(2500), 'CLEANUP_FAILED'); }
    catch { if (!current().launchSettled) uncertain = true; }
  }
  const { proxy, context, server, browser } = current();
  let proxyClosed = !proxy;
  const closing = [
    ...(proxy ? [Promise.resolve().then(() => proxy.close()).then(() => { proxyClosed = true; })] : []),
    ...(context ? [Promise.resolve().then(() => context.close())] : []),
    ...(server ? [Promise.resolve().then(() => server.close())] : []),
  ];
  try { await bounded(Promise.allSettled(closing), left(2000), 'CLEANUP_FAILED'); } catch {}
  if (!exited(server) && server) {
    try { await bounded(server.kill(), left(2000), 'CLEANUP_FAILED'); } catch {}
  }
  if (browser?.isConnected()) {
    try { await bounded(browser.close(), left(500), 'CLEANUP_FAILED'); } catch {}
  }
  finished();
  return !uncertain && proxyClosed && exited(server);
}

/** Check the installed sandboxed browser and loopback transport, without opening any media or school service. */
export async function probeControlledPlaybackRuntime(external: AbortSignal, dependencies: { launch?: Launch } = {}): Promise<void> {
  const io = new AbortController(), signal = AbortSignal.any([external, io.signal]);
  let browser: Browser | undefined, server: LaunchResult['server'] | undefined,
    context: BrowserContext | undefined, proxy: PlaybackMediaProxy | undefined,
    pendingLaunch: Promise<LaunchResult> | undefined, launchSettled = false, cleanupFinished = false;
  let failure: ControlledPlaybackFailure | undefined, documentResponses = 0;
  const stop = (code: ControlledPlaybackFailure) => { failure ??= code; io.abort(); };
  const guard = () => { if (signal.aborted) fail(failure ?? 'ABORTED'); };
  try {
    await bounded((async () => {
      guard();
      proxy = await createPlaybackMediaProxy({ probe: true, signal,
        validate: async current => { current.throwIfAborted(); },
        stream: async () => fail('MEDIA_INVALID'), onMedia: () => stop('MEDIA_INVALID'), onFailure: () => stop('MEDIA_INVALID') });
      guard();
      pendingLaunch = (dependencies.launch ?? launch)().then(async value => {
        browser = value.browser; server = value.server; launchSettled = true;
        if (cleanupFinished) { try { await bounded(value.server.kill(), 3000, 'CLEANUP_FAILED'); } catch {} }
        return value;
      }, error => { launchSettled = true; throw error; });
      await bounded(pendingLaunch, 25_000, 'LAUNCH_FAILED'); guard();
      context = await browser!.newContext({ serviceWorkers: 'block', acceptDownloads: false, ignoreHTTPSErrors: false,
        bypassCSP: false, permissions: [], viewport: { width: 1280, height: 720 } }); guard();
      const allowed = proxy.playerUrl;
      await context.routeWebSocket('**/*', socket => { stop('ROUTE_BLOCKED'); void socket.close().catch(() => {}); });
      await context.route('**/*', async route => {
        const request = route.request();
        if (signal.aborted || request.url() !== allowed || request.resourceType() !== 'document' || request.method() !== 'GET') {
          try { await route.abort('blockedbyclient'); } catch {} stop('ROUTE_BLOCKED'); return;
        }
        try { await route.continue(); } catch { if (!signal.aborted) stop('ROUTE_BLOCKED'); }
      });
      context.on('page', page => { if (context!.pages().length > 1) { stop('ROUTE_BLOCKED'); void page.close().catch(() => {}); } });
      const page = await context.newPage(); guard();
      page.on('response', response => { if (response.url() === allowed && response.status() === 200) documentResponses++; });
      page.on('download', download => { stop('ROUTE_BLOCKED'); void download.cancel().catch(() => {}); });
      await page.goto(allowed, { waitUntil: 'load', timeout: 5000 }); guard();
      const valid = await page.evaluate(() => {
        const video = document.querySelector('video');
        return document.visibilityState === 'visible' && document.querySelectorAll('video').length === 1
          && video instanceof HTMLVideoElement && video.isConnected && video.currentSrc === '' && !video.hasAttribute('src')
          && video.currentTime === 0 && video.paused && video.playbackRate === 1 && !video.seeking && !video.error;
      }); guard();
      if (!valid || documentResponses !== 1 || page.frames().length !== 1 || context.pages().length !== 1) fail('MEDIA_INVALID');
    })(), 30_000, 'START_TIMEOUT', signal);
    guard();
  } catch (error) {
    failure ??= external.aborted ? 'ABORTED' : error instanceof ControlledPlaybackError ? error.code : 'LAUNCH_FAILED';
  } finally {
    io.abort();
    if (!await closeRuntimeResources(() => ({ pendingLaunch, launchSettled, browser, server, context, proxy }),
      () => { cleanupFinished = true; })) failure = 'CLEANUP_FAILED';
  }
  if (failure) throw new ControlledPlaybackError(failure);
}

/** Controlled, single-use runtime. No school URL, credentials, job authority or reporting rule is created here. */
export function createControlledPlaybackRuntime(dependencies: { launch?: Launch } = {}) {
  const used = new WeakSet<ControlledPlaybackSource>(),
    active = new WeakMap<
      ControlledPlaybackSource,
      { abort: AbortController; done: Promise<ControlledPlaybackEvidence> }
    >();
  async function run(source: ControlledPlaybackSource, external: AbortSignal): Promise<ControlledPlaybackEvidence> {
    const data = sources.get(source);
    if (!data) return fail('SOURCE_INVALID');
    const io = new AbortController(),
      signal = AbortSignal.any([external, io.signal]);
    const started = performance.now();
    let failure: ControlledPlaybackFailure | undefined;
    let browser: Browser | undefined,
      server: LaunchResult['server'] | undefined,
      context: BrowserContext | undefined,
      proxy: PlaybackMediaProxy | undefined;
    let pendingLaunch: Promise<LaunchResult> | undefined,
      cleanupFinished = false,
      launchSettled = false;
    let mediaSeen = false,
      playingSeen = false,
      advanced = false,
      finalPosition = 0,
      duration = 0;
    let report: Promise<void> | null = null,
      reportStarted = false,
      lastReport = 0,
      terminalReport = false;
    let validation: Promise<void> | null = null;
    let interrupt!: (error: ControlledPlaybackError) => void;
    const interruption = new Promise<never>((_, reject) => {
      interrupt = reject;
    });
    void interruption.catch(() => {});
    const stop = (code: ControlledPlaybackFailure) => {
      failure ??= code;
      io.abort();
      interrupt(new ControlledPlaybackError(failure));
    };
    const cancelled = () => stop('ABORTED');
    external.addEventListener('abort', cancelled, { once: true });
    const timer = setTimeout(() => stop('EXECUTION_TIMEOUT'), data.timeouts.totalMs);
    const guard = () => {
      if (signal.aborted) fail(failure ?? 'ABORTED');
    };
    const check = async () => {
      guard();
      try {
        await bounded(data.validate(signal), 5000, 'GUARD_FAILED', signal);
      } catch {
        guard();
        fail('GUARD_FAILED');
      }
      guard();
    };
    const send = (event: 'playing' | 'update' | 'ended') => {
      if (report || terminalReport) return fail('REPORT_FAILED');
      guard();
      if (event === 'ended') terminalReport = true;
      reportStarted = true;
      const reportSignal = AbortSignal.any([signal, AbortSignal.timeout(90_000)]);
      const current = bounded(
        Promise.resolve().then(() => {
          guard();
          reportSignal.throwIfAborted();
          return data.report(event, reportSignal);
        }),
        90_000,
        'REPORT_FAILED',
        reportSignal,
      );
      report = current;
      void current.then(
        () => {
          if (report === current) {
            lastReport = performance.now();
            report = null;
          }
        },
        () => {
          if (report === current) report = null;
          stop('REPORT_FAILED');
        },
      );
    };
    try {
      const operation = async () => {
        guard();
        await check();
        proxy = await createPlaybackMediaProxy({
          stream: data.stream,
          validate: data.validate,
          signal,
          onMedia: () => {
            mediaSeen = true;
          },
          onFailure: () => stop('MEDIA_INVALID'),
        });
        guard();
        pendingLaunch = (dependencies.launch ?? launch)().then(
          async (value) => {
            browser = value.browser;
            server = value.server;
            launchSettled = true;
            if (cleanupFinished) {
              try {
                await bounded(value.server.kill(), 3000, 'CLEANUP_FAILED');
              } catch {}
            }
            return value;
          },
          (error) => {
            launchSettled = true;
            throw error;
          },
        );
        await bounded(pendingLaunch, 25_000, 'LAUNCH_FAILED');
        guard();
        context = await browser!.newContext({
          serviceWorkers: 'block',
          acceptDownloads: false,
          ignoreHTTPSErrors: false,
          bypassCSP: false,
          permissions: [],
          viewport: { width: 1280, height: 720 },
        });
        guard();
        const allowedProxy = proxy;
        await context.routeWebSocket('**/*', (socket) => {
          stop('ROUTE_BLOCKED');
          void socket.close().catch(() => {});
        });
        await context.route('**/*', async (route) => {
          const request = route.request(),
            url = request.url(),
            kind = request.resourceType(),
            method = request.method();
          const allowed =
            (url === allowedProxy.playerUrl && kind === 'document' && method === 'GET') ||
            (url === allowedProxy.mediaUrl && kind === 'media' && ['GET', 'HEAD'].includes(method));
          if (signal.aborted || !allowed) {
            try {
              await route.abort('blockedbyclient');
            } catch {}
            stop('ROUTE_BLOCKED');
            return;
          }
          try {
            await route.continue();
          } catch {
            if (!signal.aborted) stop('ROUTE_BLOCKED');
          }
        });
        let pages = 0;
        context.on('page', (page) => {
          if (++pages !== 1) stop('ROUTE_BLOCKED');
          page.on('download', (value) => {
            void value.cancel().catch(() => {});
            stop('ROUTE_BLOCKED');
          });
          page.on('dialog', (value) => {
            void value.dismiss().catch(() => {});
            stop('MEDIA_INVALID');
          });
          page.on('framenavigated', (frame) => {
            if (frame.url() !== 'about:blank' && frame.url() !== allowedProxy.playerUrl) stop('ROUTE_BLOCKED');
          });
        });
        const page = await context.newPage();
        guard();
        await page.goto(proxy.playerUrl, {
          waitUntil: 'domcontentloaded',
          timeout: data.timeouts.startMs,
        });
        guard();
        await page.waitForFunction(
          () => {
            const v = document.querySelector('video');
            return !!v && v.readyState >= 1 && Number.isFinite(v.duration);
          },
          undefined,
          { timeout: data.timeouts.startMs },
        );
        guard();
        await page.evaluate(() => {
          const node = document.querySelector('video')!;
          const events = { playing: 0, ended: 0, seeking: 0 };
          Object.defineProperty(node, '__almsControlled', { value: events });
          for (const kind of ['playing', 'ended', 'seeking'] as const)
            node.addEventListener(kind, (event) => {
              if (event.isTrusted) events[kind]++;
            });
        });
        const capture = () =>
          page.evaluate((): Snapshot => {
            const v = document.querySelector('video') as HTMLVideoElement & {
              __almsControlled: {
                playing: number;
                ended: number;
                seeking: number;
              };
            };
            if (!v) throw new Error('Missing video');
            return {
              positionSeconds: v.currentTime,
              durationSeconds: v.duration,
              playbackRate: v.playbackRate,
              paused: v.paused,
              ended: v.ended,
              seeking: v.seeking,
              visible: document.visibilityState === 'visible',
              connected: v.isConnected,
              loop: v.loop,
              src: v.currentSrc,
              error: v.error?.code ?? null,
              count: document.querySelectorAll('video').length,
              playingCount: v.__almsControlled.playing,
              endedCount: v.__almsControlled.ended,
              seekCount: v.__almsControlled.seeking,
            };
          });
        const verify = (value: Snapshot) => {
          if (
            !value.connected ||
            value.count !== 1 ||
            page.frames().length !== 1 ||
            !value.visible ||
            value.loop ||
            value.playbackRate !== 1 ||
            value.seeking ||
            value.seekCount !== 0 ||
            value.error ||
            value.src !== allowedProxy.mediaUrl ||
            !Number.isFinite(value.positionSeconds) ||
            value.positionSeconds < 0 ||
            !Number.isFinite(value.durationSeconds) ||
            value.durationSeconds <= 0 ||
            Math.abs(value.durationSeconds - data.expectedDurationSeconds) > 1
          )
            return fail('MEDIA_INVALID');
        };
        const observe = (value: Snapshot) =>
          data.observe(
            Object.freeze({
              positionSeconds: value.positionSeconds,
              durationSeconds: value.durationSeconds,
              playbackRate: value.playbackRate,
              paused: value.paused,
              ended: value.ended,
              seeking: value.seeking,
              visible: value.visible,
            }),
          );
        const initial = await capture();
        guard();
        verify(initial);
        if (!initial.paused || initial.ended || initial.positionSeconds !== 0) return fail('MEDIA_INVALID');
        observe(initial);
        await check();
        await page.locator('#start').click({ timeout: data.timeouts.startMs });
        guard();
        let previous = initial,
          previousAt = performance.now(),
          lastProgress = previousAt,
          lastCheck = previousAt,
          activeElapsed = 0;
        const playbackStarted = previousAt;
        for (;;) {
          guard();
          const value = await capture(),
            now = performance.now();
          guard();
          verify(value);
          const elapsed = (now - previousAt) / 1000;
          if (
            elapsed > 1.5 ||
            value.positionSeconds < previous.positionSeconds - 0.05 ||
            value.positionSeconds - previous.positionSeconds > elapsed + 1
          )
            return fail('MEDIA_INVALID');
          if (!previous.paused && !previous.ended) activeElapsed += elapsed;
          // First capture follows the real click; this tolerance cannot accumulate between samples.
          if (value.positionSeconds > activeElapsed + 1) return fail('MEDIA_INVALID');
          if (value.positionSeconds > previous.positionSeconds + 0.01) {
            advanced = true;
            lastProgress = now;
          }
          if (value.playingCount > 0) playingSeen = true;
          if (playingSeen && value.paused && !value.ended) return fail('MEDIA_INVALID');
          finalPosition = value.positionSeconds;
          duration = value.durationSeconds;
          // After the terminal report starts, continue safety checks but never observe a closed SDK controller.
          if (!terminalReport) observe(value);
          if (!reportStarted && playingSeen && !value.paused && !value.ended) send('playing');
          if (value.ended) {
            if (
              !value.endedCount ||
              !playingSeen ||
              !advanced ||
              !mediaSeen ||
              !reportStarted ||
              Math.abs(duration - finalPosition) > 0.2
            )
              return fail('MEDIA_INVALID');
            if (!report && !terminalReport) send('ended');
            if (terminalReport && !report) {
              if (validation) await validation;
              await check();
              guard();
              break;
            }
          } else if (!report && reportStarted && now - lastReport >= 300_000) send('update');
          if (!playingSeen && now - playbackStarted > data.timeouts.startMs) return fail('START_TIMEOUT');
          if (!value.ended && playingSeen && now - lastProgress > data.timeouts.stallMs) return fail('STALLED');
          if (now - lastCheck >= 1000 && !validation) {
            lastCheck = now;
            const current = check();
            validation = current;
            void current.then(
              () => {
                if (validation === current) validation = null;
              },
              () => {
                if (validation === current) validation = null;
                stop('GUARD_FAILED');
              },
            );
          }
          previous = value;
          previousAt = now;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      };
      await Promise.race([operation(), interruption]);
    } catch (error) {
      failure ??= external.aborted
        ? 'ABORTED'
        : error instanceof ControlledPlaybackError
          ? error.code
          : browser
            ? 'MEDIA_INVALID'
            : 'LAUNCH_FAILED';
    } finally {
      clearTimeout(timer);
      external.removeEventListener('abort', cancelled);
      io.abort();
      if (!await closeRuntimeResources(() => ({ pendingLaunch, launchSettled, browser, server, context, proxy }),
        () => { cleanupFinished = true; })) failure = 'CLEANUP_FAILED';
    }
    if (failure) throw new ControlledPlaybackError(failure);
    return {
      ended: true,
      mediaResponseObserved: true,
      playingObserved: true,
      positionAdvanced: true,
      elapsedMs: Math.round(performance.now() - started),
      durationSeconds: duration,
      finalPositionSeconds: finalPosition,
      browserClosed: true,
      processExited: true,
    };
  }
  return {
    play(source: ControlledPlaybackSource, signal: AbortSignal): Promise<ControlledPlaybackEvidence> {
      if (!sources.has(source)) return Promise.reject(new ControlledPlaybackError('SOURCE_INVALID'));
      if (used.has(source)) return Promise.reject(new ControlledPlaybackError('SOURCE_USED'));
      used.add(source);
      const abort = new AbortController(),
        done = run(source, AbortSignal.any([signal, abort.signal]));
      active.set(source, { abort, done });
      void done.then(
        () => active.delete(source),
        (error) => {
          if (!(error instanceof ControlledPlaybackError && error.code === 'CLEANUP_FAILED')) active.delete(source);
        },
      );
      return done;
    },
    async dispose(source: ControlledPlaybackSource) {
      if (sources.has(source)) used.add(source);
      const value = active.get(source);
      if (!value) return;
      value.abort.abort();
      try {
        await value.done;
      } catch (error) {
        if (error instanceof ControlledPlaybackError && error.code === 'CLEANUP_FAILED') throw error;
      }
    },
  };
}
