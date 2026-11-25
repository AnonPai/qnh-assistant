const storeName = 'directories';
const workspaceKey = 'workspace-root';
let sessionRoot: FileSystemDirectoryHandle | undefined;

// IndexedDB 可以直接保存目录句柄，读取时仍受浏览器的文件权限控制。
function openDirectoryDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('qnh-assistant-recent-directories', 1);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

export async function loadWorkspaceRoot(): Promise<FileSystemDirectoryHandle | undefined> {
  if (sessionRoot) return sessionRoot;
  const db = await openDirectoryDb();
  try {
    return await new Promise<FileSystemDirectoryHandle | undefined>((resolve, reject) => {
      const request = db.transaction(storeName).objectStore(storeName).get(workspaceKey);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function saveWorkspaceRoot(dir: FileSystemDirectoryHandle): Promise<boolean> {
  try {
    const db = await openDirectoryDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
        tx.objectStore(storeName).put(dir, workspaceKey);
      });
    } finally {
      db.close();
    }
    sessionRoot = undefined;
    return true;
  } catch {
    sessionRoot = dir;
    return false;
  }
}
