// src/storage/indexeddb/indexeddb-brushes.ts
import type { BrushLibraryStore, BrushTipMeta, UserBrushPreset } from '../types.js';
import { isTipMask, type TipMask } from '../../engine/tip-mask.js';
import { mapDOMException, txAbortError, txRequestError, openTx, type Connection } from './error-utils.js';
import { packAlpha, unpackAlpha } from './alpha-codec.js';

const TIPS_STORE = 'brush-tips';
const MASKS_STORE = 'brush-tip-masks';
const PRESETS_STORE = 'brush-presets';
const ALL = [TIPS_STORE, MASKS_STORE, PRESETS_STORE];

interface MaskRecord {
  id: string;
  width: number;
  height: number;
  encoding: 'raw' | 'deflate';
  data: ArrayBuffer;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = e => reject(txRequestError(e, tx));
    tx.onabort = () => reject(txAbortError(tx));
  });
}

function isMeta(v: unknown): v is BrushTipMeta {
  const m = v as Partial<BrushTipMeta> | null;
  return !!m && typeof m.id === 'string' && typeof m.name === 'string' && isTipMask(m.thumb)
    && typeof m.spacing === 'number' && typeof m.createdAt === 'number';
}

function isPreset(v: unknown): v is UserBrushPreset {
  const p = v as Partial<UserBrushPreset> | null;
  return !!p && typeof p.id === 'string' && typeof p.name === 'string' && !!p.descriptor && typeof p.descriptor === 'object';
}

export class IndexedDBBrushStore implements BrushLibraryStore {
  constructor(private _connection: Connection) {}

  async list(): Promise<{ tips: BrushTipMeta[]; presets: UserBrushPreset[] }> {
    const db = await this._connection();
    return new Promise((resolve, reject) => {
      const tx = openTx(db, [TIPS_STORE, PRESETS_STORE], 'readonly');
      const tips = tx.objectStore(TIPS_STORE).getAll();
      const presets = tx.objectStore(PRESETS_STORE).getAll();
      tips.onerror = () => reject(mapDOMException(tips.error));
      presets.onerror = () => reject(mapDOMException(presets.error));
      tx.oncomplete = () => {
        // A record this build can't read is left out rather than failing the list.
        const t = (tips.result as unknown[]).filter(isMeta).map(m => ({ ...m, thumb: { ...m.thumb, alpha: new Uint8Array(m.thumb.alpha) } })).sort((a, b) => a.createdAt - b.createdAt);
        const p = (presets.result as unknown[]).filter(isPreset).sort((a, b) => a.createdAt - b.createdAt);
        resolve({ tips: t, presets: p });
      };
      tx.onabort = () => reject(txAbortError(tx));
    });
  }

  async getMask(id: string): Promise<TipMask | null> {
    const db = await this._connection();
    const record = await new Promise<MaskRecord | undefined>((resolve, reject) => {
      const tx = openTx(db, MASKS_STORE, 'readonly');
      const req = tx.objectStore(MASKS_STORE).get(id);
      req.onsuccess = () => resolve(req.result as MaskRecord | undefined);
      req.onerror = () => reject(mapDOMException(req.error));
      tx.onabort = () => reject(txAbortError(tx));
    });
    if (!record) return null;
    const alpha = await unpackAlpha(record.encoding, record.data);
    const mask = alpha && { width: record.width, height: record.height, alpha };
    return isTipMask(mask) ? mask : null;
  }

  async putBatch(batch: { tips?: { meta: BrushTipMeta; mask: TipMask }[]; presets?: UserBrushPreset[] }): Promise<void> {
    // Packed before the transaction opens: one can't wait on compression.
    const masks: MaskRecord[] = [];
    for (const { meta, mask } of batch.tips ?? []) {
      const packed = await packAlpha(mask.alpha);
      masks.push({ id: meta.id, width: mask.width, height: mask.height, ...packed });
    }
    const db = await this._connection();
    const tx = openTx(db, ALL, 'readwrite');
    const finished = done(tx);
    const tips = tx.objectStore(TIPS_STORE);
    const maskStore = tx.objectStore(MASKS_STORE);
    (batch.tips ?? []).forEach(({ meta }, i) => {
      tips.put(meta);
      maskStore.put(masks[i]);
    });
    const presets = tx.objectStore(PRESETS_STORE);
    for (const preset of batch.presets ?? []) presets.put(preset);
    await finished;
  }

  async deletePreset(id: string): Promise<void> {
    const db = await this._connection();
    const tx = openTx(db, ALL, 'readwrite');
    const finished = done(tx);
    const presets = tx.objectStore(PRESETS_STORE);
    const get = presets.get(id);
    get.onsuccess = () => {
      const tipId = (get.result as UserBrushPreset | undefined)?.tipId;
      presets.delete(id);
      if (!tipId) return;
      const left = presets.index('tipId').count(IDBKeyRange.only(tipId));
      left.onsuccess = () => {
        if (left.result === 0) {
          tx.objectStore(TIPS_STORE).delete(tipId);
          tx.objectStore(MASKS_STORE).delete(tipId);
        }
      };
    };
    await finished;
  }

  async deleteTip(id: string): Promise<void> {
    const db = await this._connection();
    const tx = openTx(db, ALL, 'readwrite');
    const finished = done(tx);
    tx.objectStore(TIPS_STORE).delete(id);
    tx.objectStore(MASKS_STORE).delete(id);
    const cursor = tx.objectStore(PRESETS_STORE).index('tipId').openCursor(IDBKeyRange.only(id));
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (c) {
        c.delete();
        c.continue();
      }
    };
    await finished;
  }
}
