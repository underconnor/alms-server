import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { SchoolError } from '@alms/ssu-api';

const parserPath = createRequire(import.meta.url).resolve('pdf-lib');
// Parsing runs outside the API event loop. A cyclic or unusually expensive page tree is terminated.
export async function inspectSyllabusPdf(bytes: Uint8Array, signal?: AbortSignal): Promise<{ pageCount: number }> {
  if (signal?.aborted || bytes.length < 16 || bytes.length > 16 * 1024 * 1024) throw new SchoolError('unexpected_response');
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { PDFDocument } = require(${JSON.stringify(parserPath)});
    (async () => {
      try {
        const pdf = await PDFDocument.load(workerData, { ignoreEncryption: false, throwOnInvalidObject: true, updateMetadata: false });
        const count = pdf.getPageCount();
        if (pdf.isEncrypted || !Number.isSafeInteger(count) || count < 1 || count > 1000) throw new Error();
        for (const page of pdf.getPages()) {
          const { width, height } = page.getSize();
          if (![width, height].every(n => Number.isFinite(n) && n > 0 && n <= 20000)) throw new Error();
        }
        parentPort.postMessage(count);
      } catch { parentPort.postMessage(null); }
    })();`, { eval: true, workerData: Uint8Array.from(bytes), stdout: true, stderr: true,
    resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } });
  // The parser's own warnings can contain PDF object text; they never reach application logging.
  worker.stdout?.resume(); worker.stderr?.resume();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await new Promise((resolve, reject) => {
      const failure = () => reject(new SchoolError('unexpected_response'));
      abort = failure; signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(failure, 5000);
      worker.once('message', count => Number.isSafeInteger(count) && count >= 1 && count <= 1000 ? resolve({ pageCount: count }) : failure());
      worker.once('error', failure); worker.once('exit', code => { if (code !== 0) failure(); });
      if (signal?.aborted) failure();
    });
  } finally {
    clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort);
    await worker.terminate();
  }
}
