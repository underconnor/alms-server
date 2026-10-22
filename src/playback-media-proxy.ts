import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { inspect } from 'node:util';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Socket } from 'node:net';
import { validateVideoAccess, type VideoRequest, type VideoResponse } from './video-stream.js';
import { maxSchoolVideoBytes } from './video-policy.js';

export interface PlaybackMediaProxyInput {
  /** Readiness-only document. No media URL or media request is available in this mode. */
  probe?: true;
  stream(request: VideoRequest): Promise<VideoResponse>;
  validate(signal: AbortSignal): Promise<void>;
  signal: AbortSignal;
  onMedia(): void;
  onFailure(): void;
}
export interface PlaybackMediaProxy {
  readonly playerUrl: string;
  readonly mediaUrl: string;
  close(): Promise<void>;
  toJSON(): { kind: 'private-playback-media-proxy' };
}
const player = (
  mediaPath: string,
  nonce: string,
  probe = false,
) => `<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>Playback</title>
<video id="lecture" preload="metadata" muted${probe ? '' : ` src="${mediaPath}"`}></video><button id="start" type="button">Start</button>
<script nonce="${nonce}">document.getElementById('start').addEventListener('click',()=>{document.getElementById('lecture').play().catch(()=>{});});</script>`;
const metadataValid = (value: VideoResponse, head: boolean) => {
  if (![200, 206].includes(value.status) || !Number.isSafeInteger(value.contentLength)
    || value.contentLength <= 0 || value.contentLength > maxSchoolVideoBytes
    || !(head ? value.body === null : value.body instanceof Readable)) return false;
  if (value.status === 200) return value.contentRange === undefined;
  if (typeof value.contentRange !== 'string') return false;
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value.contentRange);
  if (!match) return false;
  const start = Number(match[1]), end = Number(match[2]), total = Number(match[3]);
  return [start, end, total].every(Number.isSafeInteger) && total > 0 && total <= maxSchoolVideoBytes
    && start <= end && end < total && end - start + 1 === value.contentLength;
};

/** Server-only loopback transport. The injected stream owns upstream URL/range/auth validation. */
export async function createPlaybackMediaProxy(input: PlaybackMediaProxyInput): Promise<PlaybackMediaProxy> {
  input.signal.throwIfAborted();
  const nonce = randomBytes(32).toString('base64url'),
    playerPath = `/${nonce}/player`,
    mediaPath = `/${nonce}/media`;
  const lifetime = new AbortController(),
    signal = AbortSignal.any([input.signal, lifetime.signal]);
  const sockets = new Set<Socket>(),
    pending = new Set<AbortController>();
  let closing: Promise<void> | undefined,
    active = 0,
    requests = 0,
    host = '';
  const server = createServer(
    { maxHeaderSize: 8192, requestTimeout: 30_000, headersTimeout: 5000 },
    (request, response) => {
      const reject = (status: number) => {
        response.writeHead(status, {
          'content-length': '0',
          'cache-control': 'no-store',
        });
        response.end();
      };
      if (signal.aborted || !host) return reject(503);
      if (
        ++requests > 5000 ||
        request.headers.host !== host ||
        request.headers.cookie ||
        request.headers.authorization ||
        request.headers['proxy-authorization'] ||
        request.headers.upgrade
      )
        return reject(403);
      if (request.url === playerPath && request.method === 'GET') {
        const html = Buffer.from(player(mediaPath, nonce, input.probe));
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': html.length,
          'cache-control': 'no-store',
          'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; media-src 'self'; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
        });
        response.end(html);
        return;
      }
      if (input.probe || request.url !== mediaPath || !['GET', 'HEAD'].includes(request.method ?? '')) return reject(404);
      if (active >= 8 || request.headers['content-length'] || request.headers['transfer-encoding']) return reject(429);
      active++;
      const controller = new AbortController();
      pending.add(controller);
      const current = AbortSignal.any([signal, controller.signal]);
      const abort = () => controller.abort();
      request.once('aborted', abort);
      const closed = () => {
        if (!response.writableFinished) abort();
      };
      response.once('close', closed);
      let body: Readable | null = null;
      const respond = async () => {
        try {
          const validate = () => input.validate(current);
          await validateVideoAccess(validate, current);
          // Bound the handoff as well as the upstream implementation. An ignored abort must not retain this request.
          let accepted = false;
          const offered = Promise.resolve().then(() =>
            input.stream({
              method: request.method as 'GET' | 'HEAD',
              range: request.headers.range,
              signal: current,
              validate,
            }),
          );
          void offered.then(
            (value) => {
              if (!accepted && current.aborted) value.body?.destroy();
            },
            () => {},
          );
          let rejectWait!: () => void;
          const interrupted = new Promise<never>((_, reject) => {
            rejectWait = () => reject(new Error('PLAYBACK_STREAM_STOPPED'));
          });
          const stopWaiting = () => rejectWait();
          const setup = setTimeout(() => {
            rejectWait();
            controller.abort();
          }, 30_000);
          current.addEventListener('abort', stopWaiting, { once: true });
          let value: VideoResponse;
          try {
            current.throwIfAborted();
            value = await Promise.race([offered, interrupted]);
            accepted = true;
          } finally {
            clearTimeout(setup);
            current.removeEventListener('abort', stopWaiting);
          }

          body = value.body;
          current.throwIfAborted();
          if (!metadataValid(value, request.method === 'HEAD')) throw new Error('Invalid media');
          await validateVideoAccess(validate, current);
          current.throwIfAborted();
          response.writeHead(value.status, {
            'content-type': 'video/mp4',
            'content-length': value.contentLength,
            'accept-ranges': 'bytes',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
            ...(value.contentRange ? { 'content-range': value.contentRange } : {}),
          });
          if (request.method === 'HEAD') response.end();
          else {
            input.onMedia();
            await pipeline(body!, response, { signal: current });
          }
        } catch {
          body?.destroy();
          // A browser may abandon a metadata Range normally; abort is not an upstream failure.
          if (!current.aborted) {
            try {
              input.onFailure();
            } catch {}
          }
          if (!response.headersSent) reject(502);
          else response.destroy();
        } finally {
          request.off('aborted', abort);
          response.off('close', closed);
          controller.abort();
          pending.delete(controller);
          active--;
        }
      };
      void respond();
    },
  );
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (_request, socket) => socket.destroy());
  server.on('clientError', (_error, socket) => socket.destroy());
  const stop = () => {
    lifetime.abort();
    for (const controller of pending) controller.abort();
    for (const socket of sockets) socket.destroy();
  };
  const close = () =>
    (closing ??= new Promise<void>((resolve, reject) => {
      stop();
      input.signal.removeEventListener('abort', stop);
      const timer = setTimeout(() => reject(new Error('PLAYBACK_PROXY_CLOSE_FAILED')), 2000);
      timer.unref();
      server.close((error) => {
        clearTimeout(timer);
        if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING')
          reject(new Error('PLAYBACK_PROXY_CLOSE_FAILED'));
        else resolve();
      });
    }));
  input.signal.addEventListener('abort', stop, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      const failed = () => reject(new Error('PLAYBACK_PROXY_START_FAILED'));
      server.once('error', failed);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', failed);
        resolve();
      });
    });
    signal.throwIfAborted();
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('PLAYBACK_PROXY_START_FAILED');
    host = `127.0.0.1:${address.port}`;
    server.on('error', () => {
      try {
        input.onFailure();
      } catch {}
      stop();
    });
    return Object.freeze({
      playerUrl: `http://${host}${playerPath}`,
      mediaUrl: `http://${host}${mediaPath}`,
      close,
      toJSON: () => ({ kind: 'private-playback-media-proxy' as const }),
      [inspect.custom]: () => 'PlaybackMediaProxy { private }',
    });
  } catch {
    await close().catch(() => {});
    throw new Error('PLAYBACK_PROXY_START_FAILED');
  }
}
