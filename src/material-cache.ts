import { load } from 'cheerio';
import { AppError } from './errors.js';

const MAX_PDF = 20 * 1024 * 1024;
const MAX_CACHE = 128 * 1024 * 1024;
const TTL = 5 * 60_000;
const unsupported = () => new AppError(503, 'MATERIAL_UNAVAILABLE', '자료를 불러오지 못했습니다. 잠시 후 다시 열어 주세요.');
const refreshed = () => new AppError(409, 'MATERIAL_REFRESHED', '자료를 다시 불러오고 있습니다. 잠시 후 다시 열어 주세요.');
export type MaterialLoader = (viewerUrl: string, signal?: AbortSignal) => Promise<Buffer>;

function schoolUrl(value: string, base?: URL): URL {
  let url: URL;
  try { url = new URL(value, base); } catch { throw unsupported(); }
  if (url.protocol !== 'https:' || url.hostname !== 'commons.ssu.ac.kr' || url.port || url.username || url.password
    || url.hash || /[\\\x00-\x20]/.test(value) || /%(?:2f|5c|25|2e|0[0-9a-f]|1[0-9a-f]|20|7f)/i.test(value)) throw unsupported();
  return url;
}
export function isMaterialViewer(value: string | null): value is string {
  return typeof value === 'string' && /^https:\/\/commons\.ssu\.ac\.kr\/em\/[A-Za-z0-9_-]{1,128}$/.test(value);
}

/** Read the measured school PDF manifest chain without executing the viewer or its progress scripts. */
export function createMaterialLoader(fetcher: typeof fetch = fetch): MaterialLoader {
  return async (viewerUrl, externalSignal) => {
    if (!isMaterialViewer(viewerUrl)) throw unsupported();
    const timeout = AbortSignal.timeout(20_000);
    const signal = externalSignal ? AbortSignal.any([externalSignal, timeout]) : timeout;
    const read = async (url: URL, types: RegExp, limit: number) => {
      signal.throwIfAborted();
      const response = await fetcher(url, { method: 'GET', redirect: 'manual', credentials: 'omit', signal });
      const length = response.headers.get('content-length');
      if (response.status !== 200 || !types.test(response.headers.get('content-type') ?? '')
        || length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
        await response.body?.cancel(); throw unsupported();
      }
      const reader = response.body?.getReader(); if (!reader) throw unsupported();
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          size += chunk.value.length; if (size > limit) { await reader.cancel(); throw unsupported(); }
          chunks.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
      const encoding = response.headers.get('content-encoding');
      if (length !== null && (!encoding || encoding === 'identity') && size !== Number(length)) throw unsupported();
      return Buffer.concat(chunks, size);
    };
    const viewer = schoolUrl(viewerUrl), contentId = viewer.pathname.slice('/em/'.length);
    const html = (await read(viewer, /^text\/html\b/i, 512 * 1024)).toString('utf8');
    const scripts = load(html)('script:not([src])').map((_i, node) => load(node).text()).get().join('\n');
    const configs = [...scripts.matchAll(/\bvar\s+contentUri\s*=\s*(['"])([^'"\\\r\n]+)\1\s*;/g)];
    if (configs.length !== 1) throw unsupported();
    const contentUrl = schoolUrl(configs[0]![2]!, viewer);
    if (contentUrl.pathname !== '/viewer/ssplayer/uniplayer_support/content.php'
      || [...contentUrl.searchParams.keys()].length !== 1 || contentUrl.searchParams.get('content_id') !== contentId) throw unsupported();
    const xml = (await read(contentUrl, /^(?:text|application)\/xml\b/i, 512 * 1024)).toString('utf8');
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw unsupported();
    const $ = load(xml, { xmlMode: true });
    const text = (selector: string) => { const nodes = $(selector); if (nodes.length !== 1) throw unsupported(); return nodes.text().trim(); };
    if (text('content_id') !== contentId || text('content_type') !== 'sharedocs') throw unsupported();
    const base = schoolUrl(text('content_uri'));
    if (base.search || !/\/contents\/web_files\/?$/.test(base.pathname)) throw unsupported();
    const root = schoolUrl(base.href.replace(/\/?$/, '/'));
    // The measured sharedocs response has no story list. UniPlayer selects slide_list.xml for that default story.
    if ($('story, story_list, story_file_list').length) throw unsupported();
    const slides = (await read(schoolUrl('slide_list.xml', root), /^(?:text|application)\/xml\b/i, 2 * 1024 * 1024)).toString('utf8');
    if (/<!DOCTYPE|<!ENTITY/i.test(slides)) throw unsupported();
    const files = load(slides, { xmlMode: true })('slide_file[type="pdf"]');
    if (files.length !== 1) throw unsupported();
    const pdf = schoolUrl(files.text().trim(), root);
    if (pdf.search || !pdf.href.startsWith(root.href) || !pdf.pathname.endsWith('.pdf')) throw unsupported();
    const bytes = await read(pdf, /^application\/pdf\b/i, MAX_PDF);
    if (bytes.length < 5 || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw unsupported();
    return bytes;
  };
}

/** Private process memory only: no browser/shared caches, disk copies, raw URLs in logs, or cross-login reuse. */
export function createMaterialByteCache(loader: MaterialLoader = createMaterialLoader()) {
  const values = new Map<string, { owner: string; generation: string; resource: string; expiresAt: number; bytes: Buffer }>();
  type Pending = { owner: string; resource: string; controller: AbortController; promise: Promise<Buffer> };
  const pending = new Map<string, Pending>();
  let used = 0, reserved = 0;
  let active = 0;
  const waiting: Array<() => void> = [];
  const remove = (key: string) => { const value = values.get(key); if (value) { used -= value.bytes.length; values.delete(key); } };
  const acquire = async (background: boolean, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (active < 2) { active++; return; }
    if (background || waiting.length >= 16) throw unsupported();
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timeout); signal.removeEventListener('abort', abort); };
      const cancel = (error: unknown) => { cleanup(); const index = waiting.indexOf(grant); if (index >= 0) waiting.splice(index, 1); reject(error); };
      const abort = () => cancel(signal.reason);
      const timeout = setTimeout(() => cancel(unsupported()), 20_000);
      const grant = () => { cleanup(); active++; resolve(); };
      signal.addEventListener('abort', abort, { once: true });
      waiting.push(grant);
    });
  };
  const release = () => { active--; waiting.shift()?.(); };
  return {
    invalidate(owner: string, resource: string) {
      for (const [id, value] of values) if (value.owner === owner && value.resource === resource) remove(id);
      for (const [id, work] of pending) if (work.owner === owner && work.resource === resource) {
        pending.delete(id); work.controller.abort(refreshed());
      }
    },
    isCurrent(owner: string, generation: string, resource: string, viewer: string, bytes: Buffer) {
      const value = values.get(JSON.stringify([owner, generation, resource, viewer]));
      return value?.bytes === bytes && value.expiresAt > Date.now();
    },
    async read(owner: string, generation: string, resource: string, viewer: string, background = false) {
      const now = Date.now();
      for (const [id, value] of values) if (value.expiresAt <= now || value.owner === owner && value.generation !== generation) remove(id);
      const key = JSON.stringify([owner, generation, resource, viewer]);
      const cached = values.get(key);
      if (cached) { values.delete(key); values.set(key, cached); return cached.bytes; }
      const active = pending.get(key); if (active) return active.promise;
      const controller = new AbortController();
      let acquired = false, reservation = false;
      const task = Promise.resolve().then(async () => {
        await acquire(background, controller.signal); acquired = true;
        controller.signal.throwIfAborted();
        while (values.size && used + reserved + MAX_PDF > MAX_CACHE) remove(values.keys().next().value!);
        reserved += MAX_PDF; reservation = true;
        return loader(viewer, controller.signal);
      }).then(bytes => {
        if (controller.signal.aborted || pending.get(key)?.promise !== task) throw refreshed();
        if (!Buffer.isBuffer(bytes) || bytes.length > MAX_PDF || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw unsupported();
        values.set(key, { owner, generation, resource, expiresAt: Date.now() + TTL, bytes }); used += bytes.length;
        return bytes;
      }).finally(() => {
        if (pending.get(key)?.promise === task) pending.delete(key);
        if (reservation) reserved -= MAX_PDF;
        if (acquired) release();
      });
      pending.set(key, { owner, resource, controller, promise: task }); return task;
    },
  };
}
