import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockBackend } from '../src/storage/testing/mock-backend.ts';

type Helpers = typeof import('../src/utils/canvas-helpers.ts');

/** A fresh copy of the module, so its cached compression verdict starts empty. */
async function freshHelpers(): Promise<Helpers> {
  vi.resetModules();
  return import('../src/utils/canvas-helpers.ts');
}

const NativeCompression = CompressionStream;
const NativeDecompression = DecompressionStream;

/** jsdom's Blob has no `stream()`, which the module needs; give it one, and restore the real streams. */
function installStreams() {
  vi.stubGlobal('CompressionStream', NativeCompression);
  vi.stubGlobal('DecompressionStream', NativeDecompression);
  if (typeof Blob.prototype.stream !== 'function') {
    Blob.prototype.stream = function (this: Blob) {
      const blob = this;
      return new ReadableStream({
        async start(controller) {
          controller.enqueue(new Uint8Array(await readBlob(blob)));
          controller.close();
        },
      });
    };
  }
}

function readBlob(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

/** Something drawImage accepts, with the close() a real ImageBitmap has. */
function fakeBitmap() {
  return Object.assign(document.createElement('canvas'), { close: vi.fn() }) as unknown as ImageBitmap;
}

/** Semi-transparent, varied pixels, the kind a canvas round trip would shift. */
function pixels(width: number, height: number) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i++) data[i] = (i * 37 + 11) & 255;
  data[3] = 1; // nearly transparent: premultiplication would flatten its colour
  return new ImageData(data, width, height);
}

async function header(blob: Blob) {
  const bytes = new Uint8Array(await readBlob(blob.slice(0, 16)));
  const view = new DataView(bytes.buffer);
  return {
    magic: String.fromCharCode(...bytes.slice(0, 4)),
    version: view.getUint32(4),
    width: view.getUint32(8),
    height: view.getUint32(12),
  };
}

/** A raw blob as the encoder writes it, with the header fields replaced. */
async function rawBlobWith(helpers: Helpers, fields: Partial<{ version: number; width: number; height: number }>) {
  const good = await helpers.imageDataToBlob(pixels(4, 3));
  const head = new Uint8Array(await readBlob(good.slice(0, 16)));
  const view = new DataView(head.buffer);
  if (fields.version !== undefined) view.setUint32(4, fields.version);
  if (fields.width !== undefined) view.setUint32(8, fields.width);
  if (fields.height !== undefined) view.setUint32(12, fields.height);
  return new Blob([head, good.slice(16)]);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('raw KTCH pixel format', () => {
  it('writes a KTCH header and decodes back exactly, semi-transparent pixels included', async () => {
    installStreams();
    const helpers = await freshHelpers();
    const source = pixels(7, 5);

    const blob = await helpers.imageDataToBlob(source);

    expect(await header(blob)).toEqual({ magic: 'KTCH', version: 1, width: 7, height: 5 });
    const back = await helpers.blobToImageData(blob, 7, 5);
    expect(back.width).toBe(7);
    expect(back.height).toBe(5);
    expect(Array.from(back.data)).toEqual(Array.from(source.data));
  });

  it('decodes onto a canvas through putImageData without altering pixels', async () => {
    installStreams();
    const helpers = await freshHelpers();
    const put = vi.spyOn(CanvasRenderingContext2D.prototype, 'putImageData');
    const blob = await helpers.imageDataToBlob(pixels(4, 3));

    const canvas = await helpers.blobToCanvas(blob, 4, 3);

    expect(canvas.width).toBe(4);
    expect(canvas.height).toBe(3);
    expect(put).toHaveBeenCalledTimes(1);
    expect(Array.from((put.mock.calls[0][0] as ImageData).data)).toEqual(Array.from(pixels(4, 3).data));
  });

  it('roundtrips a layer through the storage serializer', async () => {
    installStreams();
    await freshHelpers();
    const backend = new MockBackend();
    await backend.init();
    const serialization = await import('../src/utils/storage-serialization.ts');
    const source = pixels(6, 4);
    const put = vi.spyOn(CanvasRenderingContext2D.prototype, 'putImageData');

    const stored = await serialization.serializeLayerFromImageData(
      { id: 'l', name: 'L', visible: true, opacity: 1 }, source, backend.blobs);
    expect(await header(await backend.blobs.get(stored.imageBlobRef))).toMatchObject({ magic: 'KTCH', width: 6, height: 4 });
    await serialization.deserializeLayer(stored, 6, 4, backend.blobs);

    expect(Array.from((put.mock.calls.at(-1)![0] as ImageData).data)).toEqual(Array.from(source.data));
  });

  it('pads or clips when the record size differs from the stored header', async () => {
    installStreams();
    const helpers = await freshHelpers();
    const blob = await helpers.imageDataToBlob(pixels(4, 3));
    const back = await helpers.blobToImageData(blob, 6, 2);
    expect(back.width).toBe(6);
    expect(back.height).toBe(2);
  });

  describe('header bounds', () => {
    it.each([
      ['zero width', { width: 0, height: 3 }],
      ['zero height', { width: 4, height: 0 }],
      ['a side above 16384', { width: 16385, height: 1 }],
      ['more pixels than the largest canvas', { width: 16384, height: 16384 + 1 }],
    ])('rejects %s', async (_name, fields) => {
      installStreams();
      const helpers = await freshHelpers();
      const blob = await rawBlobWith(helpers, fields);

      await expect(helpers.blobToImageData(blob, fields.width, fields.height))
        .rejects.toBeInstanceOf(helpers.PixelDecodeError);
    });

    it('rejects an unsupported version', async () => {
      installStreams();
      const helpers = await freshHelpers();
      const blob = await rawBlobWith(helpers, { version: 2 });
      await expect(helpers.blobToImageData(blob, 4, 3)).rejects.toThrow(/version/i);
    });

    it('rejects truncated and oversized pixel data as PixelDecodeError', async () => {
      installStreams();
      const helpers = await freshHelpers();
      const good = await helpers.imageDataToBlob(pixels(4, 3));
      // Header says 4x3 but the deflate body holds only part of it.
      const truncated = new Blob([good.slice(0, 16), await helpers.imageDataToBlob(pixels(2, 1)).then(b => b.slice(16))]);
      await expect(helpers.blobToImageData(truncated, 4, 3)).rejects.toBeInstanceOf(helpers.PixelDecodeError);
      // Header says 2x1 but the body holds 4x3.
      const oversized = new Blob([(await rawBlobWith(helpers, { width: 2, height: 1 })).slice(0, 16), good.slice(16)]);
      await expect(helpers.blobToImageData(oversized, 2, 1)).rejects.toBeInstanceOf(helpers.PixelDecodeError);
    });

    it('rejects a body that is not deflate data', async () => {
      installStreams();
      const helpers = await freshHelpers();
      const good = await helpers.imageDataToBlob(pixels(4, 3));
      const garbage = new Blob([good.slice(0, 16), new Uint8Array(40).fill(0xff)]);
      await expect(helpers.blobToImageData(garbage, 4, 3)).rejects.toBeInstanceOf(helpers.PixelDecodeError);
    });
  });

  describe('legacy PNG blobs', () => {
    it('still decode through the canvas path, not the raw decoder', async () => {
      installStreams();
      const helpers = await freshHelpers();
      const png = new Blob(['\x89PNG fake'], { type: 'image/png' });
      const create = vi.fn(async () => fakeBitmap());
      vi.stubGlobal('createImageBitmap', create);

      const data = await helpers.blobToImageData(png, 4, 3);
      const canvas = await helpers.blobToCanvas(png, 4, 3);

      expect(create).toHaveBeenCalledTimes(2);
      expect(data.width).toBe(4);
      expect(canvas.height).toBe(3);
    });

    it('load through deserializeLayer', async () => {
      installStreams();
      await freshHelpers();
      const backend = new MockBackend();
      await backend.init();
      const { deserializeLayer } = await import('../src/utils/storage-serialization.ts');
      vi.stubGlobal('createImageBitmap', vi.fn(async () => fakeBitmap()));
      const ref = await backend.blobs.put(new Blob(['png'], { type: 'image/png' }));
      const layer = await deserializeLayer(
        { id: 'l', name: 'L', visible: true, opacity: 1, blendMode: 'normal', imageBlobRef: ref }, 5, 4, backend.blobs);
      expect(layer.canvas.width).toBe(5);
    });

    it('a PNG that cannot be decoded is a PixelDecodeError', async () => {
      installStreams();
      const helpers = await freshHelpers();
      vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new DOMException('bad image', 'InvalidStateError'); }));
      await expect(helpers.blobToImageData(new Blob(['nope']), 4, 3)).rejects.toBeInstanceOf(helpers.PixelDecodeError);
    });

    it('other createImageBitmap failures are not wrapped as decode errors', async () => {
      installStreams();
      const helpers = await freshHelpers();
      const err = new Error('out of memory');
      vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw err; }));
      await expect(helpers.blobToImageData(new Blob(['nope']), 4, 3)).rejects.toBe(err);
    });

    it('a blob that cannot be read keeps its DOMException (not a decode error)', async () => {
      installStreams();
      const helpers = await freshHelpers();
      const blob = await rawBlobWith(helpers, { width: 4, height: 3 });
      const err = new DOMException('gone', 'NotFoundError');
      vi.spyOn(blob, 'slice').mockImplementation(() => ({ arrayBuffer: async () => { throw err; } }) as unknown as Blob);
      await expect(helpers.blobToImageData(blob, 4, 3)).rejects.toBe(err);
    });
  });

  describe('PNG for opaque photo-like pixels', () => {
    /** Pixels that deflate poorly (noise), opaque unless `alpha` says otherwise. */
    function noise(width: number, height: number, alpha = 255) {
      const data = new Uint8ClampedArray(width * height * 4);
      let x = 7;
      for (let i = 0; i < data.length; i++) data[i] = (x = (Math.imul(x, 1664525) + 1013904223) >>> 0) >>> 24;
      for (let i = 3; i < data.length; i += 4) data[i] = alpha;
      return new ImageData(data, width, height);
    }
    const pngOfSize = (size: number) => vi.spyOn(HTMLCanvasElement.prototype, 'toBlob')
      .mockImplementation(function (cb) { cb(new Blob([new Uint8Array(size)], { type: 'image/png' })); });

    it('stores PNG when it is smaller than the raw encoding', async () => {
      installStreams();
      const helpers = await freshHelpers();
      const toBlob = pngOfSize(100);
      const blob = await helpers.imageDataToBlob(noise(32, 32));
      expect(toBlob).toHaveBeenCalledTimes(1);
      expect(blob.type).toBe('image/png');
    });

    it('keeps raw when PNG comes out larger', async () => {
      installStreams();
      const helpers = await freshHelpers();
      pngOfSize(1 << 20);
      const blob = await helpers.imageDataToBlob(noise(32, 32));
      expect((await header(blob)).magic).toBe('KTCH');
    });

    it('never tries PNG for pixels with transparency (it would not round-trip)', async () => {
      installStreams();
      const helpers = await freshHelpers();
      const toBlob = pngOfSize(100);
      const blob = await helpers.imageDataToBlob(noise(32, 32, 254));
      expect(toBlob).not.toHaveBeenCalled();
      expect((await header(blob)).magic).toBe('KTCH');
    });

    it('does not try PNG for content that deflates well', async () => {
      installStreams();
      const helpers = await freshHelpers();
      const toBlob = pngOfSize(1);
      const flat = new ImageData(new Uint8ClampedArray(64 * 64 * 4).fill(255), 64, 64);
      const blob = await helpers.imageDataToBlob(flat);
      expect(toBlob).not.toHaveBeenCalled();
      expect((await header(blob)).magic).toBe('KTCH');
    });

    it('keeps raw when PNG encoding fails', async () => {
      installStreams();
      const helpers = await freshHelpers();
      vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (cb) { cb(null); });
      const blob = await helpers.imageDataToBlob(noise(32, 32));
      expect((await header(blob)).magic).toBe('KTCH');
    });
  });

  describe('canCompress fallback to PNG', () => {
    const encodedAsPng = async (helpers: Helpers) => {
      const toBlob = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (cb) {
        cb(new Blob(['png'], { type: 'image/png' }));
      });
      const blob = await helpers.imageDataToBlob(pixels(4, 3));
      return { blob, usedPng: toBlob.mock.calls.length === 1 };
    };

    it('writes PNG when CompressionStream is unavailable', async () => {
      installStreams();
      vi.stubGlobal('CompressionStream', undefined);
      const helpers = await freshHelpers();
      const { blob, usedPng } = await encodedAsPng(helpers);
      expect(usedPng).toBe(true);
      expect(blob.type).toBe('image/png');
    });

    it('writes PNG when the self-test round trip comes back wrong (truncating browser)', async () => {
      installStreams();
      vi.stubGlobal('DecompressionStream', class {
        readable: ReadableStream;
        writable: WritableStream;
        constructor() {
          const inner = new NativeDecompression('deflate');
          // Drops the tail of the output, like Safari 16.4-16.5 on a large flush.
          const chunks: Uint8Array[] = [];
          const cut = new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk: Uint8Array) { chunks.push(chunk); },
            flush(controller: TransformStreamDefaultController<Uint8Array>) {
              for (const c of chunks.slice(0, -1)) controller.enqueue(c);
              if (chunks.length === 1) controller.enqueue(chunks[0].slice(0, 100));
            },
          });
          this.writable = inner.writable as WritableStream;
          this.readable = (inner.readable as ReadableStream).pipeThrough(cut as unknown as ReadableWritablePair);
        }
      });
      const helpers = await freshHelpers();
      const { usedPng } = await encodedAsPng(helpers);
      expect(usedPng).toBe(true);
    });

    it('caches a verdict, but not a failure to run the test', async () => {
      installStreams();
      const helpers = await freshHelpers();
      const spy = vi.fn((format: CompressionFormat) => new NativeCompression(format));
      vi.stubGlobal('CompressionStream', spy);
      await helpers.imageDataToBlob(pixels(2, 2));
      await helpers.imageDataToBlob(pixels(2, 2));
      // Self-test (once) plus one encode per call: no second self-test.
      expect(spy.mock.calls.length).toBeLessThanOrEqual(3);
    });

    describe('a self-test that hangs', () => {
      afterEach(() => {
        vi.useRealTimers();
      });

      /** A CompressionStream that takes its input and never puts anything out. */
      function installHungCompression() {
        const counts = { constructed: 0, cancelled: 0 };
        vi.stubGlobal('CompressionStream', class {
          writable = new WritableStream({ write() {} });
          readable = new ReadableStream({ cancel: () => { counts.cancelled++; } });
          constructor() { counts.constructed++; }
        });
        return counts;
      }

      it('starts once the caller yields, gives up after 3 s and cancels the hung stream', async () => {
        vi.useFakeTimers();
        installStreams();
        const counts = installHungCompression();
        const helpers = await freshHelpers();
        const toBlob = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (cb) {
          cb(new Blob(['png'], { type: 'image/png' }));
        });

        let done = false;
        const pending = helpers.imageDataToBlob(pixels(4, 3)).then((b) => { done = true; return b; });
        // Nothing has started (no timeout running) during the caller's synchronous work.
        expect(counts.constructed).toBe(0);
        await vi.advanceTimersByTimeAsync(0);
        expect(counts.constructed).toBe(1);
        await vi.advanceTimersByTimeAsync(2999);
        expect(done).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect((await pending).type).toBe('image/png');
        expect(toBlob).toHaveBeenCalledTimes(1);
        // The hung stream is let go of rather than left pending.
        expect(counts.cancelled).toBe(1);
      });

      it('falls back to PNG at once for 60 s after a timeout, then tests again', async () => {
        vi.useFakeTimers();
        installStreams();
        const counts = installHungCompression();
        const helpers = await freshHelpers();
        vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (cb) {
          cb(new Blob(['png'], { type: 'image/png' }));
        });

        const first = helpers.imageDataToBlob(pixels(2, 2));
        await vi.advanceTimersByTimeAsync(3000);
        await first;
        expect(counts.constructed).toBe(1);

        await vi.advanceTimersByTimeAsync(59000);
        // Within the window: PNG straight away, no second self-test waited out.
        expect((await helpers.imageDataToBlob(pixels(2, 2))).type).toBe('image/png');
        await vi.advanceTimersByTimeAsync(0);
        expect(counts.constructed).toBe(1);

        await vi.advanceTimersByTimeAsync(1000);
        // Past it, the timeout cached no verdict (and the cancelled read none
        // either), so the test runs again.
        const retry = helpers.imageDataToBlob(pixels(2, 2));
        await vi.advanceTimersByTimeAsync(0);
        expect(counts.constructed).toBe(2);
        await vi.advanceTimersByTimeAsync(3000);
        expect((await retry).type).toBe('image/png');
        expect(counts.cancelled).toBe(2);
      });
    });

    it('serializeLayerFromImageData still stores a layer when falling back to PNG', async () => {
      installStreams();
      vi.stubGlobal('CompressionStream', undefined);
      await freshHelpers();
      const { serializeLayerFromImageData } = await import('../src/utils/storage-serialization.ts');
      vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (cb) {
        cb(new Blob(['png'], { type: 'image/png' }));
      });
      const backend = new MockBackend();
      await backend.init();
      const stored = await serializeLayerFromImageData(
        { id: 'l', name: 'L', visible: true, opacity: 1 }, pixels(3, 3), backend.blobs);
      expect((await backend.blobs.get(stored.imageBlobRef)).type).toBe('image/png');
    });
  });
});
