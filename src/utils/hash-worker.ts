import { hashImageData } from './image-diff.js';

/**
 * hashImageData off the main thread. A save hashes every layer it read back,
 * and on a large document that loop is a pause the user can feel just after
 * a stroke; here the pixels are handed to a worker (transferred, not copied)
 * and handed back with the hash.
 *
 * The worker is made from source held in this file, so the single-file
 * library build needs no second file. Where it can't run (no Worker, a
 * host's content policy, a wrong answer to the self-test) hashing stays on
 * the main thread, as it does for images too small to be worth the trip.
 */

/** Images under this many pixels hash in a few milliseconds where they are. */
const OFF_THREAD_MIN_PIXELS = 1024 * 1024;

/**
 * The worker's code: hashImageData's loop, word for word. It must give the
 * same answers, since hashes from both are compared with each other
 * (tests/hash-worker.test.ts checks that they do).
 */
export const HASH_WORKER_SOURCE = `
self.onmessage = function (e) {
  var d = e.data;
  var words = new Uint32Array(d.buffer, 0, d.width * d.height);
  var h1 = 0x811c9dc5;
  var h2 = 0x9e3779b9;
  for (var i = 0; i < words.length; i++) {
    var v = words[i];
    h1 = Math.imul(h1 ^ v, 0x01000193);
    h1 ^= h1 >>> 13;
    h2 = Math.imul(h2 ^ v, 0x5bd1e995);
    h2 ^= h2 >>> 15;
  }
  var hash = d.width + 'x' + d.height + ':' + (h1 >>> 0).toString(16) + ':' + (h2 >>> 0).toString(16);
  self.postMessage({ id: d.id, hash: hash, buffer: d.buffer }, [d.buffer]);
};
`;

interface Job {
  width: number;
  height: number;
  resolve: (result: HashedImage) => void;
  reject: (err: Error) => void;
}

export interface HashedImage {
  hash: string;
  /** The image that was hashed: the one passed in, or (after a trip to the worker, which detaches that one's pixels) one holding the same pixels. */
  imageData: ImageData;
}

let worker: Worker | null = null;
/** 'untested' until the self-test answers; only a worker that 'works' is given pixels. */
let state: 'untested' | 'testing' | 'works' | 'broken' = 'untested';
let nextId = 1;
const jobs = new Map<number, Job>();

function giveUp(reason: string) {
  state = 'broken';
  worker?.terminate();
  worker = null;
  // Their pixels went with the worker: these fail, and the caller's retry hashes on the main thread.
  for (const job of jobs.values()) job.reject(new Error(`Hash worker failed: ${reason}`));
  jobs.clear();
}

function startWorker() {
  state = 'testing';
  try {
    const url = URL.createObjectURL(new Blob([HASH_WORKER_SOURCE], { type: 'text/javascript' }));
    worker = new Worker(url);
    URL.revokeObjectURL(url);
  } catch {
    state = 'broken';
    return;
  }
  // A known answer first: nothing is transferred to a worker that hasn't given one.
  const probe = new ImageData(2, 1);
  probe.data.set([1, 2, 3, 4, 250, 251, 252, 253]);
  const expected = hashImageData(probe);
  worker.onmessage = (e: MessageEvent<{ id: number; hash: string; buffer: ArrayBuffer }>) => {
    const { id, hash, buffer } = e.data;
    if (id === 0) {
      if (hash === expected) state = 'works';
      else giveUp('self-test mismatch');
      return;
    }
    const job = jobs.get(id);
    if (!job) return;
    jobs.delete(id);
    job.resolve({ hash, imageData: new ImageData(new Uint8ClampedArray(buffer), job.width, job.height) });
  };
  worker.onerror = () => giveUp('worker error');
  worker.onmessageerror = () => giveUp('message error');
  const copy = probe.data.slice().buffer;
  worker.postMessage({ id: 0, width: 2, height: 1, buffer: copy }, [copy]);
}

/**
 * Hash `img` as hashImageData does, off the main thread when that is
 * possible and worth it. While the returned promise is pending `img` may be
 * without its pixels; use the image the result carries from then on.
 */
export function hashImageDataOffThread(img: ImageData): Promise<HashedImage> {
  const here = (): Promise<HashedImage> => Promise.resolve({ hash: hashImageData(img), imageData: img });
  if (img.width * img.height < OFF_THREAD_MIN_PIXELS || typeof Worker === 'undefined') return here();
  if (state === 'untested') startWorker();
  // Still testing: this one is hashed here, the next may go to the worker.
  if (state !== 'works' || !worker) return here();
  const data = img.data;
  if (data.byteOffset !== 0 || data.byteLength !== data.buffer.byteLength || !(data.buffer instanceof ArrayBuffer)) return here();
  const id = nextId++;
  return new Promise<HashedImage>((resolve, reject) => {
    jobs.set(id, { width: img.width, height: img.height, resolve, reject });
    try {
      worker!.postMessage({ id, width: img.width, height: img.height, buffer: data.buffer }, [data.buffer as ArrayBuffer]);
    } catch (err) {
      jobs.delete(id);
      // Nothing was transferred if posting threw: hash it here after all.
      if (data.buffer.byteLength > 0) resolve({ hash: hashImageData(img), imageData: img });
      else reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/** For tests: forget the worker and what was learned about it. */
export function resetHashWorker() {
  worker?.terminate();
  worker = null;
  state = 'untested';
  jobs.clear();
}
