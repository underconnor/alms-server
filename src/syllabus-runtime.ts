import { chromium, type Browser, type BrowserContext, type BrowserServer } from 'playwright';
import { SchoolError, inspectSchoolSyllabusRenderLaunch, parseSchoolSyllabusPdf, type SchoolSyllabusRenderLaunch } from '@alms/ssu-api';
import { AppError } from './errors.js';
import { inspectSyllabusPdf } from './syllabus-pdf-inspector.js';

export type SyllabusRuntimeCode = 'INVALID_SOURCE' | 'ABORTED' | 'BLOCKED_REQUEST' | 'UPSTREAM_FAILED' | 'TIMEOUT' | 'EXPORT_FAILED' | 'CLEANUP_FAILED';
export class SyllabusRuntimeError extends Error {
  constructor(readonly code: SyllabusRuntimeCode) { super(`Syllabus renderer: ${code}`); }
}
const fail = (code: SyllabusRuntimeCode): never => { throw new SyllabusRuntimeError(code); };
export type SyllabusAuthCheck = (plan: SchoolSyllabusRenderLaunch, url: string, signal?: AbortSignal) => Promise<{ body: string; contentType: string }>;
export interface SyllabusRenderInput { plan: SchoolSyllabusRenderLaunch; readAuthCheck: SyllabusAuthCheck; validate: () => Promise<void> }
export type SyllabusPdfStage = 'callback_received' | 'inspection_started' | 'inspection_passed' | 'normalization_passed';
/** QA sees only fixed stages. It cannot inspect or replace the PDF validator. Observer failures are ignored. */
export async function validateSyllabusRuntimePdf(output: unknown, signal: AbortSignal, observe?: (stage: SyllabusPdfStage) => void) {
  const stage = (value: SyllabusPdfStage) => { try { observe?.(value); } catch {} };
  stage('callback_received');
  const result = await parseSchoolSyllabusPdf(output, { signal, inspectPdf: async (bytes, signal) => {
    stage('inspection_started');
    const checked = await inspectSyllabusPdf(bytes, signal);
    stage('inspection_passed'); return checked;
  } });
  stage('normalization_passed'); return result;
}
type Launch = () => Promise<{ browser: Browser; server: Pick<BrowserServer, 'close' | 'kill' | 'process'> }>;
const bounded = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new SyllabusRuntimeError('CLEANUP_FAILED')), ms); })]); }
  finally { clearTimeout(timer); }
};
const launch: Launch = async () => {
  const server = await chromium.launchServer({ headless: true, chromiumSandbox: true, host: '127.0.0.1', timeout: 20_000,
    handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
  try { return { browser: await chromium.connect(server.wsEndpoint(), { timeout: 5000 }), server }; }
  catch { await bounded(server.kill(), 5000); return fail('EXPORT_FAILED'); }
};

// Closed list of observed runtime assets. No arbitrary JSP, URL proxy, school cookies or redirects.
const staticPaths = new Set([
  // Installed CResourceLoader d6.oZR + explicit en-US browser locale. First path matched live GET hash.
  ...['server_error_msg_', 'viewer_server_error_msg_', 'chartres_', 'qd_error_msg_', 'rm_error_msg_',
    'em_error_msg_', 'viewer_error_msg_', 'rr_error_msg_', 'ad_error_msg_', 'av_error_msg_',
    'as_error_msg_', 'af_error_msg_', 'rd_error_msg_'].map(prefix => '/oz70/ozhviewer/res/' + prefix + 'en_US.xml'),
  ...['animated-overlay.gif', 'ui-bg_flat_0_aaaaaa_40x100.png', 'ui-bg_flat_75_ffffff_40x100.png',
    'ui-bg_glass_55_fbf9ee_1x400.png', 'ui-bg_glass_65_ffffff_1x400.png', 'ui-bg_glass_75_dadada_1x400.png',
    'ui-bg_glass_75_e6e6e6_1x400.png', 'ui-bg_glass_95_fef1ec_1x400.png', 'ui-bg_highlight-soft_75_cccccc_1x100.png',
    'ui-icons_222222_256x240.png', 'ui-icons_2e83ff_256x240.png', 'ui-icons_454545_256x240.png',
    'ui-icons_888888_256x240.png', 'ui-icons_cd0a0a_256x240.png'].map(name => '/oz70/ozhviewer/images/' + name),
  '/oz70/ozhviewer/ltError.gif',
  '/oz70/authcheck_utf.js',
  ...['jquery-1.8.3.min.js', 'jquery-ui.css', 'jquery-ui.min.js', 'ui.dynatree.css', 'jquery.dynatree.js',
    'OZJSViewer.js', 'OZJSViewer_export.js', 'OZJSViewer_chart.js', 'OZJSViewer_ozimg_m.js', 'OZJSViewer_ozimg_pc.js',
    'OZJSViewer_ozjscript.js', 'OZJSViewer_ozscript.js'].map(name => '/oz70/ozhviewer/' + name),
]);
const dynamicPaths = new Set(['OZJSViewer_export.js', 'OZJSViewer_chart.js', 'OZJSViewer_ozimg_m.js', 'OZJSViewer_ozimg_pc.js', 'OZJSViewer_ozjscript.js', 'OZJSViewer_ozscript.js'].map(name => '/oz70/ozhviewer/' + name));
const runtimeVersionQuery = '?Version%20-%2070%2C2021%2C0714%2C100';
export function syllabusRequestRole(value: string, kind: string, method: string): 'static' | 'auth' | 'report' | null {
  let url: URL; try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port || url.href !== value
    || /[\\\x00-\x20]|%(?:2f|5c|25|2e|0[0-9a-f]|1[0-9a-f]|7f)/i.test(url.pathname)) return null;
  if (url.hostname === 'ecc.ssu.ac.kr' && url.pathname === '/sap/bc/bsp/sap/z_oz_authcheck/check.htm'
    && method === 'GET' && ['script', 'xhr', 'fetch'].includes(kind)) return 'auth';
  if (url.hostname !== 'office.ssu.ac.kr') return null;
  if (!url.search && url.pathname === '/oz70/server' && method === 'POST' && ['xhr', 'fetch'].includes(kind)) return 'report';
  if ((!url.search || dynamicPaths.has(url.pathname) && url.search === runtimeVersionQuery) && staticPaths.has(url.pathname) && method === 'GET' && ['script', 'stylesheet', 'font', 'image', 'xhr', 'fetch'].includes(kind)) return 'static';
  return null;
}

/** One bounded anonymous asset/report read. Even a stalled transport that ignores abort cannot hold a renderer. */
export async function readSyllabusRuntimeResponse(fetcher: typeof fetch, url: string, init: RequestInit, maximum: number, signal: AbortSignal, timeoutMs = 15_000) {
  const controller = new AbortController();
  let rejectAbort!: (error: unknown) => void;
  const interrupted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const stop = () => { controller.abort(); rejectAbort(new SyllabusRuntimeError('UPSTREAM_FAILED')); };
  signal.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, timeoutMs);
  let response: Response | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let closed = false;
  const discard = (value?: Response) => { void value?.body?.cancel().catch(() => {}); };
  try {
    if (signal.aborted) { stop(); return await interrupted; }
    const loading = fetcher(url, { ...init, redirect: 'manual', credentials: 'omit', signal: controller.signal }).then(value => {
      if (closed || controller.signal.aborted) discard(value); return value;
    });
    response = await Promise.race([loading, interrupted]);
    const declared = response.headers.get('content-length');
    if (response.status !== 200 || declared && (!/^\d+$/.test(declared) || Number(declared) > maximum)) fail('UPSTREAM_FAILED');
    const chunks: Uint8Array[] = []; let size = 0;
    if (response.body) {
      reader = response.body.getReader();
      while (true) {
        const row = await Promise.race([reader.read(), interrupted]); if (row.done) break;
        size += row.value.length; if (size > maximum) fail('UPSTREAM_FAILED'); chunks.push(row.value);
      }
    }
    if (controller.signal.aborted) fail('UPSTREAM_FAILED');
    return { body: Buffer.concat(chunks, size), contentType: response.headers.get('content-type') ?? 'application/octet-stream' };
  } finally {
    closed = true; clearTimeout(timer); signal.removeEventListener('abort', stop); controller.abort();
    if (reader) { void reader.cancel().catch(() => {}); } else discard(response);
  }
}

/** One fresh sandboxed browser process per private launch. Dependencies are server-only synthetic QA seams. */
export function createSyllabusRuntime(dependencies: { launch?: Launch; fetch?: typeof fetch; observePdfStage?: (stage: SyllabusPdfStage) => void } = {}) {
  const used = new WeakSet<SchoolSyllabusRenderLaunch>();
  let cleanupFailed = false;
  return async (input: SyllabusRenderInput, signal: AbortSignal) => {
    if (cleanupFailed) return fail('CLEANUP_FAILED');
    if (used.has(input.plan)) return fail('INVALID_SOURCE');
    const source = inspectSchoolSyllabusRenderLaunch(input.plan); used.add(input.plan);
    if (source.authenticationChecked !== false || source.viewerId !== 'OZViewer') return fail('INVALID_SOURCE');
    let browser: Browser | undefined, context: BrowserContext | undefined, server: Awaited<ReturnType<Launch>>['server'] | undefined;
    let pendingLaunch: ReturnType<Launch> | undefined, closed = false, failure: unknown;
    let result: Awaited<ReturnType<typeof parseSchoolSyllabusPdf>> | undefined;
    const io = new AbortController();
    let interrupt!: (error: unknown) => void;
    const interrupted = new Promise<never>((_, reject) => { interrupt = reject; });
    const stop = (error: unknown) => { if (!io.signal.aborted) { io.abort(); interrupt(error); } };
    const abort = () => stop(new SyllabusRuntimeError('ABORTED'));
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop(new SyllabusRuntimeError('TIMEOUT')), 60_000);
    const guard = () => { if (signal.aborted || io.signal.aborted) fail('ABORTED'); };
    let validationPending = false;
    const validateTimer = setInterval(() => {
      if (validationPending || io.signal.aborted) return;
      validationPending = true;
      void input.validate().catch(stop).finally(() => { validationPending = false; });
    }, 1000);
    try {
      const operation = async () => {
        guard(); await input.validate(); guard();
        pendingLaunch = (dependencies.launch ?? launch)().then(async value => {
          browser = value.browser; server = value.server;
          if (closed) { try { await bounded(server.kill(), 5000); } catch {} }
          return value;
        });
        await pendingLaunch; guard();
        context = await browser!.newContext({ serviceWorkers: 'block', acceptDownloads: false, ignoreHTTPSErrors: false,
          bypassCSP: false, permissions: [], locale: 'en-US', viewport: { width: 1280, height: 900 } });
        guard(); const ctx = context;
        let documentSeen = false, authenticated = false, requests = 0, reports = 0, inFlight = 0, received = 0, pages = 0;
        await ctx.routeWebSocket('**/*', socket => { stop(new SyllabusRuntimeError('BLOCKED_REQUEST')); void socket.close().catch(() => {}); });
        await ctx.route('**/*', async route => {
          const request = route.request();
          try {
            guard(); if (++requests > 256 || ++inFlight > 16) fail('BLOCKED_REQUEST');
            const headers = await request.allHeaders();
            if (headers.authorization || headers['proxy-authorization'] || headers.cookie) fail('BLOCKED_REQUEST');
            if (request.url() === source.launcherUrl && request.method() === 'GET' && request.resourceType() === 'document' && !documentSeen) {
              documentSeen = true;
              await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: source.launcherHtml }); return;
            }
            const role = syllabusRequestRole(request.url(), request.resourceType(), request.method());
            if (!role) fail('BLOCKED_REQUEST');
            if (role === 'auth') {
              if (authenticated) fail('BLOCKED_REQUEST');
              await input.validate(); guard();
              const checked = await input.readAuthCheck(input.plan, request.url(), io.signal);
              await input.validate(); guard(); authenticated = true;
              await route.fulfill({ status: 200, contentType: checked.contentType, body: checked.body }); return;
            }
            const body = request.postDataBuffer();
            if (role === 'report' && (!authenticated || ++reports > 16 || !body || body.length > 2 * 1024 * 1024)) fail('BLOCKED_REQUEST');
            if (role === 'static' && body) fail('BLOCKED_REQUEST');
            const outgoing: Record<string, string> = {};
            if (role === 'report') {
              // The school runtime constructs this opaque report-read body. It is not stored or logged.
              if (!['application/octet-stream', 'application/x-www-form-urlencoded'].includes((headers['content-type'] ?? '').split(';')[0]!.trim())) fail('BLOCKED_REQUEST');
              outgoing['content-type'] = headers['content-type']!;
              await input.validate(); guard();
            }
            const response = await readSyllabusRuntimeResponse(dependencies.fetch ?? fetch, request.url(), {
              method: request.method(), headers: outgoing, ...(body ? { body: new Uint8Array(body) } : {}),
            }, role === 'static' ? 8 * 1024 * 1024 : 16 * 1024 * 1024, io.signal);
            received += response.body.length; if (received > 64 * 1024 * 1024) fail('UPSTREAM_FAILED');
            guard();
            await route.fulfill({ status: 200, contentType: response.contentType, body: response.body });
          } catch (error) {
            try { await route.abort('blockedbyclient'); } catch {}
            stop(error instanceof SyllabusRuntimeError || error instanceof SchoolError || error instanceof AppError ? error : new SyllabusRuntimeError('UPSTREAM_FAILED'));
          } finally { inFlight--; }
        });
        ctx.on('page', page => {
          if (++pages > 1) stop(new SyllabusRuntimeError('BLOCKED_REQUEST'));
          page.on('download', download => { void download.cancel().catch(() => {}); stop(new SyllabusRuntimeError('BLOCKED_REQUEST')); });
          page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}); stop(new SyllabusRuntimeError('EXPORT_FAILED')); });
          page.on('framenavigated', frame => {
            if (frame.url() !== 'about:blank' && frame.url() !== source.launcherUrl) stop(new SyllabusRuntimeError('BLOCKED_REQUEST'));
          });
        });
        const page = await ctx.newPage();
        await page.goto(source.launcherUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }); guard();
        // GetInformation/TOTAL_PAGE is present in the installed official runtime. Empty means not ready.
        await page.waitForFunction(() => {
          const viewer = document.getElementById('OZViewer') as HTMLElement & { GetInformation?: (key: string) => string; ScriptEx?: unknown };
          if (!viewer || typeof viewer.ScriptEx !== 'function' || typeof viewer.GetInformation !== 'function') return false;
          const pages = Number(viewer.GetInformation('TOTAL_PAGE'));
          return Number.isSafeInteger(pages) && pages > 0 && pages <= 1000;
        }, undefined, { timeout: 30_000 });
        if (!authenticated || !reports) fail('EXPORT_FAILED');
        await input.validate(); guard();
        const exported = await page.evaluate(async () => {
          const scope = window as unknown as Record<string, unknown>;
          const viewer = document.getElementById('OZViewer') as HTMLElement & { GetInformation: (key: string) => string; ScriptEx: (command: string, options: string, delimiter: string) => unknown };
          const pageCount = Number(viewer.GetInformation('TOTAL_PAGE'));
          const callback = 'OZExportMemoryStreamCallBack_OZViewer';
          const had = Object.prototype.hasOwnProperty.call(scope, callback), previous = scope[callback];
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const output = await new Promise<string>((resolve, reject) => {
              timer = setTimeout(() => reject(new Error('export timeout')), 30_000);
              scope[callback] = (value: unknown) => {
                try {
                  if (typeof previous === 'function') previous(value);
                  if (typeof value !== 'string' || value.length > 23 * 1024 * 1024) throw new Error('invalid export');
                  resolve(value);
                } catch { reject(new Error('invalid export')); }
              };
              viewer.ScriptEx('save_memorystream', 'export.format=pdf;export.mode=silent;export.confirmsave=false;export.target=disk;export.filename=syllabus.pdf', ';');
            });
            return { output, pageCount };
          } finally { clearTimeout(timer); if (had) scope[callback] = previous; else delete scope[callback]; }
        });
        guard();
        result = await validateSyllabusRuntimePdf(exported.output, io.signal, dependencies.observePdfStage);
        if (result.pageCount !== exported.pageCount) fail('EXPORT_FAILED');
        await input.validate(); guard();
      };
      await Promise.race([operation(), interrupted]);
    } catch (error) { failure = error instanceof SyllabusRuntimeError || error instanceof SchoolError || error instanceof AppError ? error : new SyllabusRuntimeError('EXPORT_FAILED'); }
    finally {
      clearTimeout(timer); clearInterval(validateTimer); io.abort(); signal.removeEventListener('abort', abort);
      let unconfirmed = false;
      if (pendingLaunch && !server) { try { await bounded(pendingLaunch, 25_000); } catch (error) { unconfirmed = error instanceof SyllabusRuntimeError && error.code === 'CLEANUP_FAILED'; } }
      let exited = !server && !unconfirmed;
      try {
        if (context) await bounded(context.close(), 5000);
        if (server) await bounded(server.close(), 5000);
        exited = !unconfirmed && (!server || server.process().exitCode !== null || server.process().signalCode !== null);
      } catch {}
      if (!exited && server) { try { await bounded(server.kill(), 5000); exited = server.process().exitCode !== null || server.process().signalCode !== null; } catch {} }
      if (browser?.isConnected()) { try { await bounded(browser.close(), 2000); } catch {} }
      closed = true;
      if (!exited) { cleanupFailed = true; failure = new SyllabusRuntimeError('CLEANUP_FAILED'); }
    }
    if (failure) throw failure;
    if (!result) return fail('EXPORT_FAILED');
    return result;
  };
}
