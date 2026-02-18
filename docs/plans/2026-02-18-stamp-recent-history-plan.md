# Stamp Recent History Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a recent stamps row (last 20, persisted in IndexedDB) with select/delete to the stamp tool UI.

**Architecture:** New `stamp-store.ts` module wraps IndexedDB with three async functions (get/add/delete). `tool-settings.ts` consumes the store to render a scrollable row of stamp thumbnails. No changes to drawing context, canvas, or stamp drawing logic.

**Tech Stack:** Lit 3, @lit/context, TypeScript, IndexedDB (native browser API), Vite

---

### Task 1: Create IndexedDB stamp store module

**Files:**
- Create: `src/stamp-store.ts`

**Step 1: Create the stamp-store module with types and DB helper**

```typescript
// src/stamp-store.ts

export interface StampEntry {
  id: string;
  blob: Blob;
  createdAt: number;
}

const DB_NAME = 'ketchup-stamps';
const STORE_NAME = 'stamps';
const DB_VERSION = 1;
const MAX_STAMPS = 20;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getRecentStamps(limit = MAX_STAMPS): Promise<StampEntry[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('createdAt');
    const entries: StampEntry[] = [];
    const req = index.openCursor(null, 'prev');
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor && entries.length < limit) {
        entries.push(cursor.value as StampEntry);
        cursor.continue();
      } else {
        resolve(entries);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

export async function addStamp(blob: Blob): Promise<StampEntry> {
  const entry: StampEntry = {
    id: crypto.randomUUID(),
    blob,
    createdAt: Date.now(),
  };
  const db = await openDB();

  // Add the new entry
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).add(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  // Prune oldest if over limit
  const all = await getRecentStamps(MAX_STAMPS + 10);
  if (all.length > MAX_STAMPS) {
    const toDelete = all.slice(MAX_STAMPS);
    const db2 = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db2.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      for (const old of toDelete) {
        store.delete(old.id);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  return entry;
}

export async function deleteStamp(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
```

**Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/stamp-store.ts
git commit -m "feat: add IndexedDB stamp store module"
```

---

### Task 2: Add recent stamps row UI to tool-settings

**Files:**
- Modify: `src/components/tool-settings.ts`

**Step 1: Add imports, state, and lifecycle methods for stamp history**

At the top of `tool-settings.ts`, add import:
```typescript
import { getRecentStamps, addStamp, deleteStamp, type StampEntry } from '../stamp-store.js';
```

Add reactive state and a URL cache inside the `ToolSettings` class:
```typescript
@state() private _recentStamps: StampEntry[] = [];
@state() private _activeStampId: string | null = null;
private _thumbUrls = new Map<string, string>();
```

Add a method to load stamps from IndexedDB and generate object URLs for thumbnails:
```typescript
private async _loadStamps() {
  this._recentStamps = await getRecentStamps();
  // Revoke old URLs
  for (const [id, url] of this._thumbUrls) {
    if (!this._recentStamps.some((s) => s.id === id)) {
      URL.revokeObjectURL(url);
      this._thumbUrls.delete(id);
    }
  }
  // Create new URLs
  for (const s of this._recentStamps) {
    if (!this._thumbUrls.has(s.id)) {
      this._thumbUrls.set(s.id, URL.createObjectURL(s.blob));
    }
  }
}
```

Add `connectedCallback` to load stamps on mount:
```typescript
override connectedCallback() {
  super.connectedCallback();
  this._loadStamps();
}
```

**Step 2: Update `_uploadStamp` to save to IndexedDB**

Replace the existing `_uploadStamp` method:
```typescript
private _uploadStamp() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    const entry = await addStamp(file);
    const img = new Image();
    img.onload = () => {
      this.ctx.setStampImage(img);
      this._activeStampId = entry.id;
    };
    img.src = URL.createObjectURL(file);
    await this._loadStamps();
  };
  input.click();
}
```

**Step 3: Add methods to select and delete stamps**

```typescript
private _selectStamp(entry: StampEntry) {
  const url = this._thumbUrls.get(entry.id);
  if (!url) return;
  const img = new Image();
  img.onload = () => {
    this.ctx.setStampImage(img);
    this._activeStampId = entry.id;
  };
  img.src = URL.createObjectURL(entry.blob);
}

private async _deleteStamp(entry: StampEntry, e: Event) {
  e.stopPropagation();
  await deleteStamp(entry.id);
  if (this._activeStampId === entry.id) {
    this._activeStampId = null;
    this.ctx.setStampImage(null);
  }
  await this._loadStamps();
}
```

**Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
git add src/components/tool-settings.ts
git commit -m "feat: wire stamp history load/save/delete in tool-settings"
```

---

### Task 3: Add stamp row styles and render template

**Files:**
- Modify: `src/components/tool-settings.ts`

**Step 1: Add CSS for the stamp row**

Add these rules inside the existing `static override styles = css\`...\``:

```css
.stamp-row {
  display: flex;
  gap: 4px;
  overflow-x: auto;
  max-width: 400px;
  padding: 2px 0;
  align-items: center;
}

.stamp-thumb-wrap {
  position: relative;
  flex-shrink: 0;
}

.stamp-thumb {
  width: 32px;
  height: 32px;
  border-radius: 4px;
  border: 2px solid transparent;
  object-fit: contain;
  background: #222;
  cursor: pointer;
  display: block;
}

.stamp-thumb:hover {
  border-color: #888;
}

.stamp-thumb.active {
  border-color: #5b8cf7;
}

.stamp-delete {
  display: none;
  position: absolute;
  top: -4px;
  right: -4px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #555;
  color: #ddd;
  border: none;
  font-size: 9px;
  line-height: 14px;
  text-align: center;
  cursor: pointer;
  padding: 0;
}

.stamp-thumb-wrap:hover .stamp-delete {
  display: block;
}

.stamp-delete:hover {
  background: #e55;
}
```

**Step 2: Update the stamp section in `render()`**

Replace the existing `activeTool === 'stamp'` template block with:

```typescript
${activeTool === 'stamp'
  ? html`
      <div class="separator"></div>
      <div class="section">
        ${this._recentStamps.length > 0
          ? html`
              <div class="stamp-row">
                ${this._recentStamps.map(
                  (s) => html`
                    <div class="stamp-thumb-wrap">
                      <img
                        class="stamp-thumb ${this._activeStampId === s.id ? 'active' : ''}"
                        src=${this._thumbUrls.get(s.id) ?? ''}
                        alt="stamp"
                        @click=${() => this._selectStamp(s)}
                      />
                      <button
                        class="stamp-delete"
                        @click=${(e: Event) => this._deleteStamp(s, e)}
                        title="Remove stamp"
                      >&times;</button>
                    </div>
                  `,
                )}
              </div>
            `
          : ''}
        <button class="stamp-btn" @click=${this._uploadStamp}>Upload Image</button>
        ${stampImage
          ? html`<img class="stamp-preview" .src=${stampImage.src} alt="stamp" />`
          : ''}
      </div>
    `
  : ''}
```

**Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 4: Manual verification**

Run: `npm run dev`
- Select stamp tool — recent row should be empty, upload button visible
- Upload an image — it appears in the row with blue border, and as the active stamp preview
- Upload more images — they appear in the row, newest first
- Click a different stamp thumbnail — it becomes active (blue border), preview updates
- Hover a thumbnail — X button appears top-right
- Click X — stamp removed from row, if it was active the preview clears
- Reload the page — stamps persist from IndexedDB

**Step 5: Commit**

```bash
git add src/components/tool-settings.ts
git commit -m "feat: add recent stamps row UI with select and delete"
```
