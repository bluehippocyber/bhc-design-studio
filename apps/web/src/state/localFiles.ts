// Browser-side project file store — IndexedDB for persistence, in-memory
// object URL cache for synchronous access in render paths.
// Used as a fallback when the daemon is offline (Vercel / API-only mode).

const DB_NAME = 'bhc-project-files-v1';
const STORE = 'blobs';

let _db: IDBDatabase | null = null;

function openDB(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => {
      _db = req.result;
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  });
}

// In-memory object URL cache keyed by "projectId/name"
const _urlCache = new Map<string, string>();

function fileKey(projectId: string, name: string): string {
  return `${projectId}/${name}`;
}

export async function localStoreFile(
  projectId: string,
  name: string,
  file: File | Blob,
): Promise<string> {
  const db = await openDB();
  const k = fileKey(projectId, name);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(file, k);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  // Revoke any stale object URL before creating a new one
  const stale = _urlCache.get(k);
  if (stale) URL.revokeObjectURL(stale);
  const url = URL.createObjectURL(file);
  _urlCache.set(k, url);
  return url;
}

export async function localListFiles(
  projectId: string,
): Promise<Array<{ name: string; size: number; url: string }>> {
  const db = await openDB();
  const prefix = `${projectId}/`;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).openCursor();
    const results: Array<{ name: string; size: number; url: string }> = [];
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) { resolve(results); return; }
      const k = cursor.key as string;
      if (k.startsWith(prefix)) {
        const blob = cursor.value as Blob;
        const name = k.slice(prefix.length);
        // Prime URL cache if not already set
        if (!_urlCache.has(k)) {
          _urlCache.set(k, URL.createObjectURL(blob));
        }
        results.push({ name, size: blob.size, url: _urlCache.get(k)! });
      }
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

/** Returns the cached object URL for a local:// path, or null if not primed. */
export function resolveLocalUrl(path: string): string | null {
  if (!path.startsWith('local://')) return null;
  const k = path.slice('local://'.length);
  return _urlCache.get(k) ?? null;
}

/** Async version — reads from IndexedDB if the URL isn't cached yet. */
export async function primeLocalUrl(path: string): Promise<string | null> {
  if (!path.startsWith('local://')) return null;
  const k = path.slice('local://'.length);
  if (_urlCache.has(k)) return _urlCache.get(k)!;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(k);
    req.onsuccess = () => {
      const blob = req.result as Blob | undefined;
      if (!blob) { resolve(null); return; }
      const url = URL.createObjectURL(blob);
      _urlCache.set(k, url);
      resolve(url);
    };
    req.onerror = () => reject(req.error);
  });
}

/** Read a local file as base64 data URL (for embedding in API messages). */
export async function localFileToDataUrl(path: string): Promise<string | null> {
  if (!path.startsWith('local://')) return null;
  const k = path.slice('local://'.length);
  const db = await openDB();
  const blob: Blob | undefined = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(k);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  if (!blob) return null;
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

export async function deleteLocalFile(
  projectId: string,
  name: string,
): Promise<void> {
  const db = await openDB();
  const k = fileKey(projectId, name);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(k);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  const url = _urlCache.get(k);
  if (url) { URL.revokeObjectURL(url); _urlCache.delete(k); }
}
