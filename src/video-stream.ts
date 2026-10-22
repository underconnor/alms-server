import { Readable } from 'node:stream';
import { AppError } from './errors.js';
import { maxSchoolVideoBytes } from './video-policy.js';

export interface VideoRequest {
  method: 'GET' | 'HEAD';
  range?: string;
  signal: AbortSignal;
  // Rechecks the requesting ALMS session; school generation is checked by the reader.
  validate(): Promise<void>;
}
export interface VideoResponse {
  status: 200 | 206;
  contentLength: number;
  contentRange?: string;
  body: Readable | null;
}
// Private server handoff. Never serialize or log the resolved URL.
export interface PreparedVideoSource {
  contentId: string;
  mediaUrl: string;
  resourceType?: 'readystream';
  validate(): Promise<void>;
}
type Range = { start: number; end: number | null } | { suffix: number };
const unavailable = () => new AppError(502, 'VIDEO_UNAVAILABLE', '영상을 불러오지 못했습니다. 다시 시도해 주세요.');
const invalidRange = () => new AppError(416, 'VIDEO_RANGE_INVALID', '요청한 영상 범위를 읽을 수 없습니다.');
const aborted = () => new AppError(499, 'REQUEST_ABORTED', '영상 요청이 취소됐습니다.');

/** A stalled session store cannot keep an otherwise live stream authorized indefinitely. */
export async function validateVideoAccess(validate: () => Promise<void>, signal: AbortSignal, timeoutMs = 5_000): Promise<void> {
  if (signal.aborted) throw aborted();
  let rejectAbort!: (error: AppError) => void;
  const interruption = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const cancel = () => rejectAbort(aborted());
  const timer = setTimeout(() => rejectAbort(unavailable()), timeoutMs); timer.unref();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    await Promise.race([validate(), interruption]);
    if (signal.aborted) throw aborted();
  } finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); }
}

function rangeValue(raw?: string): Range | null {
  if (raw === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(raw);
  if (!match || !match[1] && !match[2]) throw invalidRange();
  const number = (text: string) => {
    const value = Number(text);
    if (!Number.isSafeInteger(value) || value < 0 || value > maxSchoolVideoBytes) throw invalidRange();
    return value;
  };
  if (!match[1]) { const suffix = number(match[2]!); if (!suffix) throw invalidRange(); return { suffix }; }
  const start = number(match[1]), end = match[2] ? number(match[2]) : null;
  if (end !== null && end < start) throw invalidRange();
  return { start, end };
}
function safeMediaUrl(source: PreparedVideoSource): string {
  const { mediaUrl, contentId } = source;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(contentId) || /[\\%\x00-\x20\x7f]/.test(mediaUrl)) throw unavailable();
  let url: URL; try { url = new URL(mediaUrl); } catch { throw unavailable(); }
  const readystream = source.resourceType === 'readystream';
  const prefixes = readystream ? [`/contents31/ssu1000001/${contentId}/contents/media_files/`]
    : [`/ssu-contents/contents31/ssu1000001/${contentId}/contents/media_files/mobile/`,
      `/ssu-contents/contents29/ssu1000001/${contentId}/contents/media_files/mobile/`,
      `/ssu-contents/contents/ssu1000001/${contentId}/contents/media_files/`];
  const prefix = prefixes.find(value => url.pathname.startsWith(value));
  const file = prefix ? url.pathname.slice(prefix.length) : '';
  if (url.href !== mediaUrl || url.origin !== (readystream ? 'https://ssu-toast.commonscdn.com' : 'https://ssuin-object.commonscdn.com')
    || url.username || url.password || url.port || url.search || url.hash || !prefix
    || !(readystream ? /^[A-Za-z0-9][A-Za-z0-9._()-]{0,127}\.mp4$/ : /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.mp4$/).test(file)) throw unavailable();
  return mediaUrl;
}
function responseMetadata(response: Response, range: Range | null): Omit<VideoResponse, 'body'> {
  if (response.status === 416) throw invalidRange();
  if (response.redirected || ![200, 206].includes(response.status)
    || response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'video/mp4'
    || ![null, 'identity'].includes(response.headers.get('content-encoding'))) throw unavailable();
  const lengthText = response.headers.get('content-length');
  if (!lengthText || !/^\d+$/.test(lengthText)) throw unavailable();
  const contentLength = Number(lengthText);
  if (!Number.isSafeInteger(contentLength) || contentLength < 1 || contentLength > maxSchoolVideoBytes) throw unavailable();
  if (!range) {
    if (response.status !== 200 || response.headers.has('content-range')) throw unavailable();
    return { status: 200, contentLength };
  }
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
  if (response.status !== 206 || !match) throw unavailable();
  const start = Number(match[1]), end = Number(match[2]), total = Number(match[3]);
  if (![start, end, total].every(Number.isSafeInteger) || total < 1 || total > maxSchoolVideoBytes || end >= total
    || start > end || end - start + 1 !== contentLength) throw unavailable();
  const expectedStart = 'suffix' in range ? Math.max(0, total - range.suffix) : range.start;
  const expectedEnd = 'suffix' in range || range.end === null ? total - 1 : Math.min(total - 1, range.end);
  if (start !== expectedStart || end !== expectedEnd) throw unavailable();
  return { status: 206, contentLength, contentRange: `bytes ${start}-${end}/${total}` };
}

/** Anonymous, bounded, backpressured byte transport. No player or progress callback is executed. */
export function createVideoStreamer(fetcher: typeof fetch = fetch, limits: { idleMs?: number; checkMs?: number; setupMs?: number; validationMs?: number } = {}) {
  const owners = new Map<string, number>(); let active = 0;
  return async (owner: string, prepare: (signal: AbortSignal) => Promise<PreparedVideoSource>, request: VideoRequest): Promise<VideoResponse> => {
    const range = rangeValue(request.range);
    if (request.signal.aborted) throw aborted();
    if (active >= 8 || (owners.get(owner) ?? 0) >= 2)
      throw new AppError(429, 'VIDEO_BUSY', '다른 영상 요청이 끝난 뒤 다시 시도해 주세요.');
    active++; owners.set(owner, (owners.get(owner) ?? 0) + 1);
    const controller = new AbortController();
    let source: PreparedVideoSource | undefined, body: Readable | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let released = false, stopped: AppError | undefined, checking = false;
    let checkTimer: NodeJS.Timeout | undefined, idleTimer: NodeJS.Timeout | undefined;
    const normalized = (error: unknown) => error instanceof AppError ? error : unavailable();
    const release = () => {
      if (released) return; released = true;
      clearTimeout(setupTimer); clearTimeout(idleTimer); clearInterval(checkTimer);
      request.signal.removeEventListener('abort', cancel);
      controller.abort();
      void reader?.cancel().catch(() => {});
      active--; const count = (owners.get(owner) ?? 1) - 1;
      if (count) owners.set(owner, count); else owners.delete(owner);
    };
    let rejectStop!: (error: AppError) => void;
    const interruption = new Promise<never>((_resolve, reject) => { rejectStop = reject; });
    // A late interruption must remain handled after the setup race resolves.
    void interruption.catch(() => {});
    const stop = (error: AppError) => {
      if (released || stopped) return;
      stopped = error; controller.abort(); rejectStop(error);
      if (body) body.destroy(error); else release();
    };
    const cancel = () => stop(aborted());
    const setupTimer = setTimeout(() => stop(unavailable()), limits.setupMs ?? 30_000);
    setupTimer.unref();
    request.signal.addEventListener('abort', cancel, { once: true });
    const validate = async () => {
      if (stopped || controller.signal.aborted) throw stopped ?? aborted();
      await validateVideoAccess(async () => { await request.validate(); await source?.validate(); }, controller.signal, limits.validationMs);
      if (stopped || controller.signal.aborted) throw stopped ?? aborted();
    };
    const deadline = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => stop(unavailable()), limits.idleMs ?? 30_000); idleTimer.unref();
    };
    try {
      const metadata = await Promise.race([interruption, (async () => {
        await validate(); source = await prepare(controller.signal); await validate();
        const url = safeMediaUrl(source);
        const response = await fetcher(url, { method: request.method, redirect: 'manual', credentials: 'omit',
          signal: controller.signal, headers: { Accept: 'video/mp4', 'Accept-Encoding': 'identity',
            ...(source.resourceType === 'readystream' ? { Referer: 'https://commons.ssu.ac.kr/' } : {}), ...(request.range ? { Range: request.range } : {}) } });
        // Capturing the reader immediately lets every validation failure cancel the upstream body.
        reader = response.body?.getReader();
        if (stopped || controller.signal.aborted) { void reader?.cancel().catch(() => {}); throw stopped ?? aborted(); }
        const result = responseMetadata(response, range);
        await validate();
        return result;
      })()]);
      clearTimeout(setupTimer);
      if (request.method === 'HEAD') { release(); return { ...metadata, body: null }; }
      if (!reader) throw unavailable();
      const upstream = reader;
      // A shared never-settled Promise in every chunk's race retains each
      // resolved read result until the stream ends. Use a removable listener
      // per read so consumed byte buffers can be collected during playback.
      const readChunk = () => new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
        const cleanup = () => controller.signal.removeEventListener('abort', cancelRead);
        const cancelRead = () => { cleanup(); reject(stopped ?? aborted()); };
        controller.signal.addEventListener('abort', cancelRead, { once: true });
        if (controller.signal.aborted) { cancelRead(); return; }
        void upstream.read().then(value => {
          cleanup();
          if (controller.signal.aborted) reject(stopped ?? aborted());
          else resolve(value);
        }, error => { cleanup(); reject(error); });
      });
      body = Readable.from((async function* () {
        let received = 0;
        try {
          while (true) {
            if (stopped) throw stopped;
            deadline(); const chunk = await readChunk(); clearTimeout(idleTimer);
            if (stopped) throw stopped;
            if (chunk.done) break;
            received += chunk.value.byteLength;
            if (received > metadata.contentLength || received > maxSchoolVideoBytes) throw unavailable();
            deadline();
            yield chunk.value;
          }
          if (received !== metadata.contentLength) throw unavailable();
        } catch (error) { throw normalized(error); }
        finally { release(); }
      })(), { objectMode: false, highWaterMark: 64 * 1024 });
      body.on('error', () => {}); // Fastify also observes the normalized stream error.
      body.once('close', release);
      checkTimer = setInterval(() => {
        if (checking || released) return;
        checking = true;
        void validate().catch(error => stop(normalized(error))).finally(() => { checking = false; });
      }, limits.checkMs ?? 2_000);
      checkTimer.unref();
      deadline();
      return { ...metadata, body };
    } catch (error) { release(); throw stopped ?? normalized(error); }
  };
}
