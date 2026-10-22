import { isIP } from 'node:net';
import { inspect } from 'node:util';
import { chromium, type Browser, type BrowserContext, type BrowserServer, type ElementHandle } from 'playwright';
import { z } from 'zod';

const failureCodes = ['SOURCE_INVALID', 'SOURCE_USED', 'ABORTED', 'LAUNCH_FAILED', 'ROUTE_BLOCKED', 'UPSTREAM_FAILED', 'MEDIA_UNSUPPORTED', 'START_TIMEOUT', 'STALLED', 'PAUSED', 'MEDIA_FAILED', 'EXECUTION_TIMEOUT', 'CLEANUP_FAILED'] as const;
export type PlaybackFailureCode = typeof failureCodes[number];
export class PlaybackRuntimeError extends Error {
  constructor(readonly code: PlaybackFailureCode) { super(`Playback runtime: ${code}`); this.name = 'PlaybackRuntimeError'; }
}
const fail = (code: PlaybackFailureCode): never => { throw new PlaybackRuntimeError(code); };
const kinds = ['document', 'script', 'stylesheet', 'image', 'font', 'media', 'xhr', 'fetch', 'other'] as const;
const requestRule = z.object({ url: z.string().max(8000), kind: z.enum(kinds), methods: z.array(z.enum(['GET', 'HEAD'])).min(1).max(2) }).strict();
const inputSchema = z.object({
  launchUrl: z.string().max(8000), frameUrl: z.string().max(8000).optional(), mediaUrl: z.string().max(8000),
  videoSelector: z.string().min(1).max(256), startSelector: z.string().min(1).max(256),
  requests: z.array(requestRule).min(2).max(256),
  cookies: z.array(z.object({ name: z.string().regex(/^[A-Za-z0-9_!#$%&'*+.^`|~-]{1,128}$/), value: z.string().max(16384),
    domain: z.string().max(253), path: z.string().min(1).max(1024), secure: z.literal(true), httpOnly: z.boolean(), sameSite: z.enum(['Strict', 'Lax', 'None']) }).strict()).max(50).default([]),
  timeouts: z.object({ startMs: z.number().int().min(500).max(60_000).default(30_000),
    stallMs: z.number().int().min(500).max(60_000).default(30_000), totalMs: z.number().int().min(1000).max(4 * 60 * 60_000).default(2 * 60 * 60_000) }).strict().default({ startMs: 30_000, stallMs: 30_000, totalMs: 2 * 60 * 60_000 }),
}).strict();
export type PlaybackSourceInput = z.input<typeof inputSchema>;
type SourceData = z.output<typeof inputSchema>;
const sourceBrand: unique symbol = Symbol('PlaybackSource');
export interface PlaybackSource { readonly [sourceBrand]: true; toJSON(): { kind: 'private-playback-source' } }
const sources = new WeakMap<PlaybackSource, SourceData>();
// CDN support is deliberately closed until an actual selected lecture establishes its contract.
// The reserved .invalid name is used only by the isolated synthetic transport harness.
const knownHosts = new Set(['lms.ssu.ac.kr', 'canvas.ssu.ac.kr', 'commons.ssu.ac.kr', 'fixture.alms.invalid']);

function safeUrl(value: string): URL {
  let url: URL; try { url = new URL(value); } catch { return fail('SOURCE_INVALID'); }
  if (url.href !== value || url.protocol !== 'https:' || url.port || url.username || url.password || url.hash
    || isIP(url.hostname) || !knownHosts.has(url.hostname) || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(url.hostname)
    || /(?:^|\.)(?:localhost|local|internal|home|lan)$/.test(url.hostname)
    || /[\\\x00-\x20]|%(?:2f|5c|25|2e|0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)) return fail('SOURCE_INVALID');
  return url;
}
/** A server adapter must establish ownership and the exact observed launch contract first. This validates structure only. */
export function createPlaybackSource(input: PlaybackSourceInput): PlaybackSource {
  const parsed = inputSchema.safeParse(input); if (!parsed.success) return fail('SOURCE_INVALID');
  const data = parsed.data;
  for (const value of [data.launchUrl, data.frameUrl, data.mediaUrl].filter((v): v is string => Boolean(v))) safeUrl(value);
  const identifiers = new Set<string>();
  for (const rule of data.requests) {
    safeUrl(rule.url); const id = rule.kind + ':' + rule.url;
    if (identifiers.has(id) || new Set(rule.methods).size !== rule.methods.length) return fail('SOURCE_INVALID');
    identifiers.add(id);
  }
  if (![data.launchUrl, data.frameUrl].filter(Boolean).every(url => data.requests.some(rule => rule.url === url && rule.kind === 'document' && rule.methods.includes('GET')))
    || !data.requests.some(rule => rule.url === data.mediaUrl && rule.kind === 'media' && rule.methods.includes('GET'))) return fail('SOURCE_INVALID');
  const cookieKeys = new Set<string>();
  for (const cookie of data.cookies) {
    const host = safeUrl(`https://${cookie.domain}/`).hostname;
    if (host !== cookie.domain || !/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(cookie.path) || /[\x00-\x20;\x7f]/.test(cookie.value)
      || !data.requests.some(rule => { const u = new URL(rule.url); return u.hostname === host && u.pathname.startsWith(cookie.path); })) return fail('SOURCE_INVALID');
    if (cookie.name === 'xn_api_token' && (host !== 'canvas.ssu.ac.kr' || cookie.path !== '/learningx/')) return fail('SOURCE_INVALID');
    const key = `${cookie.domain}:${cookie.path}:${cookie.name}`;
    if (cookieKeys.has(key)) return fail('SOURCE_INVALID'); cookieKeys.add(key);
  }
  const source = Object.freeze({ [sourceBrand]: true as const, toJSON: () => ({ kind: 'private-playback-source' as const }),
    [inspect.custom]: () => 'PlaybackSource { private }' });
  sources.set(source, data); return source;
}

export function isPlaybackRequestAllowed(source: PlaybackSource, url: string, kind: string, method: string): boolean {
  const data = sources.get(source); if (!data) return false;
  try { safeUrl(url); } catch { return false; }
  return data.requests.some(rule => rule.url === url && rule.kind === kind && rule.methods.includes(method as 'GET' | 'HEAD'));
}
export type PlaybackEvidence = { ended: true; mediaResponseObserved: true; playingObserved: true; positionAdvanced: true;
  elapsedMs: number; durationSeconds: number; finalPositionSeconds: number; browserClosed: true; processExited: true };
type Launch = () => Promise<{ browser: Browser; server: Pick<BrowserServer, 'close' | 'kill' | 'process'> }>;
const launch: Launch = async () => {
  const server = await chromium.launchServer({ headless: true, chromiumSandbox: true, host: '127.0.0.1', timeout: 20_000,
    handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
  try { return { browser: await chromium.connect(server.wsEndpoint(), { timeout: 5000 }), server }; }
  catch {
    try { await bounded(server.kill(), 5000); } catch { return fail('CLEANUP_FAILED'); }
    if (server.process().exitCode === null && server.process().signalCode === null) return fail('CLEANUP_FAILED');
    return fail('LAUNCH_FAILED');
  }
};
type Active = { abort: AbortController; done: Promise<PlaybackEvidence> };
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const bounded = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_r, reject) => { timer = setTimeout(() => reject(new PlaybackRuntimeError('CLEANUP_FAILED')), ms); })]); }
  finally { clearTimeout(timer!); }
};

/** Server-only dependencies permit isolated synthetic transport tests; never wire these from an HTTP request. */
export function createPlaybackRuntime(dependencies: { launch?: Launch; fetch?: typeof fetch } = {}) {
  const active = new WeakMap<PlaybackSource, Active>(), used = new WeakSet<PlaybackSource>();
  const fetcher = dependencies.fetch ?? fetch;
  async function run(source: PlaybackSource, signal: AbortSignal): Promise<PlaybackEvidence> {
    const data = sources.get(source); if (!data) return fail('SOURCE_INVALID');
    let browser: Browser | undefined, server: Awaited<ReturnType<Launch>>['server'] | undefined, context: BrowserContext | undefined;
    let video: ElementHandle<HTMLVideoElement> | undefined, violation: PlaybackFailureCode | undefined;
    let pendingLaunch: ReturnType<Launch> | undefined, cleanupFinished = false;
    let responseObserved = false, finalPosition = 0, duration = 0, playingObserved = false, advanced = false;
    const started = performance.now(), io = new AbortController();
    let interrupt!: (error: PlaybackRuntimeError) => void;
    const interrupted = new Promise<never>((_resolve, reject) => { interrupt = reject; });
    const stop = () => { io.abort(); interrupt(new PlaybackRuntimeError(signal.aborted ? 'ABORTED' : violation ?? 'ABORTED')); };
    signal.addEventListener('abort', stop, { once: true });
    const guard = () => { if (signal.aborted) fail('ABORTED'); if (violation) fail(violation);
      if (performance.now() - started > data.timeouts.totalMs) fail('EXECUTION_TIMEOUT'); };
    const deny = (code: PlaybackFailureCode) => { violation ??= code; stop(); };
    const totalTimer = setTimeout(() => deny('EXECUTION_TIMEOUT'), data.timeouts.totalMs);
    let failure: unknown;
    try {
      const operation = async () => {
      guard();
      pendingLaunch = (dependencies.launch ?? launch)().then(async value => {
        browser = value.browser; server = value.server;
        // A dependency that resolves after the bounded launch-cleanup wait must still lose its process.
        if (cleanupFinished) { try { await bounded(server.kill(), 5000); } catch {} }
        return value;
      });
      await pendingLaunch; guard();
      context = await browser!.newContext({ serviceWorkers: 'block', acceptDownloads: false, ignoreHTTPSErrors: false,
        bypassCSP: false, permissions: [], viewport: { width: 1280, height: 720 } });
      guard();
      const ctx = context;
      let requests = 0, inFlight = 0;
      await ctx.routeWebSocket('**/*', socket => { deny('ROUTE_BLOCKED'); void socket.close().catch(() => {}); });
      await ctx.route('**/*', async route => {
        const request = route.request();
        if (io.signal.aborted || ++requests > 5000 || !isPlaybackRequestAllowed(source, request.url(), request.resourceType(), request.method())) {
          try { await route.abort('blockedbyclient'); } catch {} deny('ROUTE_BLOCKED'); return;
        }
        // Playwright routing sees only the first URL in a server redirect chain. A manual HTTP fetch
        // rejects all redirects before the browser can follow one. No school progress request is synthesized.
        try {
          if (++inFlight > 8) fail('ROUTE_BLOCKED');
          const requestHeaders = await request.allHeaders();
          if (requestHeaders.authorization || requestHeaders['proxy-authorization']) fail('ROUTE_BLOCKED');
          const headers: Record<string, string> = {};
          for (const name of ['accept', 'accept-language', 'range', 'if-range', 'user-agent']) if (requestHeaders[name]) headers[name] = requestHeaders[name];
          const u = new URL(request.url());
          const cookies = data.cookies.filter(cookie => cookie.domain === u.hostname && u.pathname.startsWith(cookie.path));
          if (cookies.length) headers.cookie = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
          const response = await fetcher(u, { method: request.method(), headers, redirect: 'manual', credentials: 'omit',
            signal: AbortSignal.any([io.signal, AbortSignal.timeout(30_000)]) });
          if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); fail('ROUTE_BLOCKED'); }
          if (![200, 206, 204].includes(response.status)) { await response.body?.cancel(); fail('UPSTREAM_FAILED'); }
          const maximum = request.resourceType() === 'media' ? 32 * 1024 * 1024 : 2 * 1024 * 1024;
          const length = response.headers.get('content-length');
          if (length && (!/^\d+$/.test(length) || Number(length) > maximum)) { await response.body?.cancel(); fail('MEDIA_UNSUPPORTED'); }
          const chunks: Uint8Array[] = []; let size = 0;
          if (response.body) for await (const chunk of response.body) { size += chunk.length; if (size > maximum) { fail('MEDIA_UNSUPPORTED'); } chunks.push(chunk); }
          const outgoing = Object.fromEntries([...response.headers].filter(([name]) => !['set-cookie', 'content-encoding', 'content-length', 'connection', 'transfer-encoding', 'alt-svc'].includes(name)));
          await route.fulfill({ status: response.status, headers: outgoing, body: Buffer.concat(chunks, size) });
          if (request.url() === data.mediaUrl && request.resourceType() === 'media' && /^video\//i.test(response.headers.get('content-type') ?? '')) responseObserved = true;
        } catch (error) {
          try { await route.abort('failed'); } catch {}
          if (!signal.aborted) deny(error instanceof PlaybackRuntimeError ? error.code : 'UPSTREAM_FAILED');
        } finally { inFlight--; }
      });
      await ctx.addCookies(data.cookies);
      let pageCount = 0;
      ctx.on('page', page => {
        if (++pageCount > 1) { deny('MEDIA_UNSUPPORTED'); return; }
        page.on('download', download => { void download.cancel().catch(() => {}); deny('ROUTE_BLOCKED'); });
        page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}); deny('MEDIA_UNSUPPORTED'); });
        page.on('framenavigated', frame => { const url = frame.url(); if (url !== 'about:blank' && !isPlaybackRequestAllowed(source, url, 'document', 'GET')) deny('ROUTE_BLOCKED'); });
      });
      const page = await ctx.newPage(); guard();
      await page.goto(data.launchUrl, { waitUntil: 'domcontentloaded', timeout: data.timeouts.startMs }); guard();
      let frame = data.frameUrl ? page.frames().find(value => value.url() === data.frameUrl) : page.mainFrame();
      const frameDeadline = performance.now() + data.timeouts.startMs;
      while (!frame && performance.now() < frameDeadline) { guard(); await delay(50); frame = page.frames().find(value => value.url() === data.frameUrl); }
      if (!frame) fail('START_TIMEOUT');
      const locator = frame!.locator(data.videoSelector);
      await locator.waitFor({ state: 'attached', timeout: data.timeouts.startMs });
      let count = 0; for (const candidate of page.frames()) count += await candidate.locator('video').count();
      if (count !== 1 || await locator.count() !== 1) fail('MEDIA_UNSUPPORTED');
      video = await locator.elementHandle() as ElementHandle<HTMLVideoElement> | undefined;
      if (!video) fail('MEDIA_UNSUPPORTED');
      await video!.evaluate(node => {
        const events = { playing: 0, ended: 0, seeking: 0, waiting: 0, stalled: 0 };
        Object.defineProperty(node, '__almsObservation', { value: events, configurable: true });
        for (const kind of Object.keys(events)) node.addEventListener(kind, event => { if (event.isTrusted) events[kind as keyof typeof events]++; });
      });
      const button = frame!.locator(data.startSelector);
      if (await button.count() !== 1) fail('MEDIA_UNSUPPORTED');
      await button.click({ timeout: data.timeouts.startMs });
      const mediaStart = performance.now(); let previousTime = 0, previousWall = mediaStart, lastProgress = mediaStart;
      while (true) {
        guard();
        let videos = 0; for (const candidate of page.frames()) videos += await candidate.locator('video').count();
        if (videos !== 1) fail('MEDIA_UNSUPPORTED');
        const snapshot = await video!.evaluate(node => ({ connected: node.isConnected, time: node.currentTime, duration: node.duration,
          rate: node.playbackRate, paused: node.paused, ended: node.ended, loop: node.loop, error: node.error?.code ?? null,
          src: node.currentSrc, events: (node as HTMLVideoElement & { __almsObservation: { playing: number; ended: number; seeking: number } }).__almsObservation }));
        const now = performance.now();
        if (!snapshot.connected || snapshot.loop || snapshot.rate !== 1 || snapshot.events.seeking > 0 || snapshot.src && snapshot.src !== data.mediaUrl) fail('MEDIA_UNSUPPORTED');
        if (snapshot.error) fail('MEDIA_FAILED');
        if (snapshot.time < previousTime - 0.05 || snapshot.time - previousTime > (now - previousWall) / 1000 * 1.25 + 0.5) fail('MEDIA_UNSUPPORTED');
        if (snapshot.time > previousTime + 0.01) { lastProgress = now; advanced = true; }
        if (snapshot.events.playing > 0) playingObserved = true;
        finalPosition = snapshot.time; duration = snapshot.duration;
        if (snapshot.ended) {
          if (!snapshot.events.ended || !responseObserved || !playingObserved || !advanced || !Number.isFinite(duration) || duration <= 0 || Math.abs(duration - finalPosition) > 0.2) fail('MEDIA_UNSUPPORTED');
          break;
        }
        if (!playingObserved && now - mediaStart > data.timeouts.startMs) fail('START_TIMEOUT');
        if (playingObserved && now - lastProgress > data.timeouts.stallMs) fail(snapshot.paused ? 'PAUSED' : 'STALLED');
        previousTime = snapshot.time; previousWall = now; await delay(200);
      }
      };
      await Promise.race([operation(), interrupted]);
    } catch (error) { failure = signal.aborted ? new PlaybackRuntimeError('ABORTED') : violation ? new PlaybackRuntimeError(violation)
      : error instanceof PlaybackRuntimeError ? error : new PlaybackRuntimeError(browser ? 'START_TIMEOUT' : 'LAUNCH_FAILED'); }
    finally {
      clearTimeout(totalTimer); io.abort(); signal.removeEventListener('abort', stop);
      let launchUnconfirmed = false;
      if (pendingLaunch && !server) {
        try { await bounded(pendingLaunch, 25_000); }
        catch (error) { launchUnconfirmed = error instanceof PlaybackRuntimeError && error.code === 'CLEANUP_FAILED'; }
      }
      let exited = !server && !launchUnconfirmed;
      try {
        if (context) await bounded(context.close(), 5000);
        if (server) await bounded(server.close(), 5000);
        exited = !launchUnconfirmed && (!server || server.process().exitCode !== null || server.process().signalCode !== null);
      } catch { /* The job owns this browser process; force only this one if orderly cleanup fails. */ }
      if (!exited && server) {
        try { await bounded(server.kill(), 5000); exited = server.process().exitCode !== null || server.process().signalCode !== null; } catch {}
      }
      if (browser?.isConnected()) { try { await bounded(browser.close(), 2000); } catch {} }
      cleanupFinished = true;
      if (!exited) failure = new PlaybackRuntimeError('CLEANUP_FAILED');
    }
    if (failure) throw failure;
    return { ended: true, mediaResponseObserved: true, playingObserved: true, positionAdvanced: true,
      elapsedMs: Math.round(performance.now() - started), durationSeconds: duration, finalPositionSeconds: finalPosition, browserClosed: true, processExited: true };
  }
  return {
    play(source: PlaybackSource, signal: AbortSignal): Promise<PlaybackEvidence> {
      if (!sources.has(source)) return Promise.reject(new PlaybackRuntimeError('SOURCE_INVALID'));
      if (used.has(source)) return Promise.reject(new PlaybackRuntimeError('SOURCE_USED'));
      used.add(source); const abort = new AbortController();
      const done = run(source, AbortSignal.any([signal, abort.signal]));
      active.set(source, { abort, done });
      void done.then(() => active.delete(source), error => {
        // Keep a failed cleanup as a tombstone: a later dispose must not report a successful stop.
        if (!(error instanceof PlaybackRuntimeError && error.code === 'CLEANUP_FAILED')) active.delete(source);
      });
      return done;
    },
    async dispose(source: PlaybackSource) {
      if (sources.has(source)) used.add(source);
      const current = active.get(source); if (!current) return;
      current.abort.abort(); try { await current.done; } catch (error) { if (error instanceof PlaybackRuntimeError && error.code === 'CLEANUP_FAILED') throw error; }
    },
  };
}
