export type DirectoryTask = 'export' | 'import' | 'sync';
type DirectoryKey = DirectoryTask | 'workspace-root';

const storeName = 'directories';
const sessionOnly = new Map<DirectoryKey, FileSystemDirectoryHandle>();

// IndexedDB 可以直接保存目录句柄，读取时仍受浏览器的文件权限控制。
function openDirectoryDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('qnh-assistant-recent-directories', 1);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

export async function lastDirectory(task: DirectoryKey): Promise<FileSystemDirectoryHandle | undefined> {
  if (sessionOnly.has(task)) return sessionOnly.get(task);
  const db = await openDirectoryDb();
  try {
    return await new Promise<FileSystemDirectoryHandle | undefined>((resolve, reject) => {
      const request = db.transaction(storeName).objectStore(storeName).get(task);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function rememberDirectory(task: DirectoryKey, dir: FileSystemDirectoryHandle): Promise<boolean> {
  try {
    const db = await openDirectoryDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
        tx.objectStore(storeName).put(dir, task);
      });
    } finally {
      db.close();
    }
    sessionOnly.delete(task);
    return true;
  } catch {
    sessionOnly.set(task, dir);
    return false;
  }
}
