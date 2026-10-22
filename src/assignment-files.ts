import { AppError } from './errors.js';

export type AssignmentFileData = { fileId: string; fileName: string; contentType: string; bytes: Buffer; previewAvailable: boolean };
export type AssignmentFileProof = { id: string; fileName: string | null; contentType: string | null; sizeBytes: number | null; downloadAvailable: boolean };
const MAX_FILE = 20 * 1024 * 1024, MAX_TOTAL = 64 * 1024 * 1024, MAX_OWNER = 32 * 1024 * 1024, TTL = 5 * 60_000;
const unavailable = () => new AppError(503, 'ASSIGNMENT_FILE_UNAVAILABLE', '첨부파일을 불러오지 못했어요. 다시 열어 주세요.');
const downloadedMimes = new Set(['application/pdf', 'application/zip', 'application/x-zip-compressed', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'image/png', 'image/jpeg', 'image/webp', 'text/plain']);

/** Never use a school-supplied header or executable MIME as an inline document. */
export function publicAssignmentFile(input: { fileId: string; fileName: string | null; contentType: string; bytes: Uint8Array }, proof: AssignmentFileProof): AssignmentFileData {
  if (input.fileId !== proof.id || !(input.bytes instanceof Uint8Array) || !input.bytes.byteLength || input.bytes.byteLength > MAX_FILE
    || proof.sizeBytes !== null && proof.sizeBytes !== input.bytes.byteLength) throw unavailable();
  const bytes = Buffer.isBuffer(input.bytes) ? input.bytes : Buffer.from(input.bytes), mime = input.contentType.split(';')[0]!.trim().toLowerCase();
  if (!/^[a-z0-9!#$&^_.+\-]+\/[a-z0-9!#$&^_.+\-]+$/.test(mime)) throw unavailable();
  const previewAvailable = mime === 'application/pdf' && bytes.subarray(0, 5).toString('ascii') === '%PDF-';
  if (mime === 'application/pdf' && !previewAvailable) throw unavailable();
  // Keep the existing UTF-16 length limit without splitting a Unicode character.
  const name = Buffer.from(input.fileName ?? proof.fileName ?? `attachment-${proof.id}`, 'utf8').toString('utf8')
    .replace(/[\x00-\x1f\x7f/\\"<>:|?*]/g, '_').trim().slice(0, 240).replace(/[\uD800-\uDBFF]$/, '');
  return { fileId: proof.id, fileName: name || `attachment-${proof.id}`, contentType: downloadedMimes.has(mime) ? mime : 'application/octet-stream', bytes, previewAvailable };
}
export function assignmentFileDisposition(file: AssignmentFileData, download: boolean): string {
  const name = encodeURIComponent(file.fileName).replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
  return `${!download && file.previewAvailable ? 'inline' : 'attachment'}; filename="attachment-${file.fileId}${file.previewAvailable ? '.pdf' : ''}"; filename*=UTF-8''${name}`;
}

/** Private memory cache. A fresh association proof must precede each access; no signed URL is a key. */
export function createAssignmentFileCache() {
  type Entry = { owner: string; generation: string; resource: string; expiresAt: number; value: AssignmentFileData };
  const values = new Map<string, Entry>(); let used = 0;
  let active = 0;
  const waiting: Array<() => void> = [];
  const acquire = async (signal: AbortSignal) => {
    signal.throwIfAborted(); if (active < 2) { active++; return; }
    if (waiting.length >= 16) throw unavailable();
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
      const cancel = (error: unknown) => { cleanup(); const index = waiting.indexOf(grant); if (index >= 0) waiting.splice(index, 1); reject(error); };
      const abort = () => cancel(signal.reason), timer = setTimeout(() => cancel(unavailable()), 20_000);
      const grant = () => { cleanup(); active++; resolve(); };
      waiting.push(grant); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    });
  };
  const remove = (id: string) => { const entry = values.get(id); if (entry) { used -= entry.value.bytes.length; values.delete(id); } };
  const key = (owner: string, generation: string, resource: string, proof: AssignmentFileProof) => JSON.stringify([owner, generation, resource, proof.id, proof.fileName, proof.contentType, proof.sizeBytes]);
  const prune = (owner: string, generation: string) => { for (const [id, entry] of values) if (entry.expiresAt <= Date.now() || entry.owner === owner && entry.generation !== generation) remove(id); };
  return {
    async load<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
      await acquire(signal);
      try { signal.throwIfAborted(); return await run(); }
      finally { active--; waiting.shift()?.(); }
    },
    get(owner: string, generation: string, resource: string, proof: AssignmentFileProof) {
      prune(owner, generation); const id = key(owner, generation, resource, proof), entry = values.get(id);
      if (!entry) return null; values.delete(id); values.set(id, entry); return entry.value;
    },
    put(owner: string, generation: string, resource: string, proof: AssignmentFileProof, value: AssignmentFileData) {
      prune(owner, generation); const id = key(owner, generation, resource, proof); remove(id);
      let ownerBytes = [...values.values()].filter(item => item.owner === owner).reduce((sum, item) => sum + item.value.bytes.length, 0);
      for (const [other, entry] of values) if (entry.owner === owner && ownerBytes + value.bytes.length > MAX_OWNER) { ownerBytes -= entry.value.bytes.length; remove(other); }
      while (values.size && (used + value.bytes.length > MAX_TOTAL || values.size >= 256)) remove(values.keys().next().value!);
      values.set(id, { owner, generation, resource, expiresAt: Date.now() + TTL, value }); used += value.bytes.length;
    },
    invalidate(owner: string, courseId?: string) { for (const [id, entry] of values) if (entry.owner === owner && (!courseId || entry.resource.startsWith(courseId + ':'))) remove(id); },
  };
}
