/**
 * 文件系统操作封装(File System Access API)。
 *
 * 用户在页面浮动按钮上点击后,我们通过 showDirectoryPicker 让 ta 选定一个本地
 * 目录,所有导出产物直接写到该目录,不再走 zip 中转;导入则从同样的目录里读。
 *
 * 续传:
 *   - 进度文件 `.qnh-progress.json` 记录已完成的 SPU 与媒体 hash
 *   - 完成时写 `manifest.json` 作为"完整"标记
 *   - 下次进入,优先按是否存在 manifest.json 区分"已完成 / 未完成"
 *
 * 这一层只暴露薄薄一层 IO 原语,业务编排放在 export.ts / import.ts 各自的主流程。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/** 浏览器目前对 File System Access 的类型未必齐全,这里给一个最小子集 */
type FsDirectoryHandle = FileSystemDirectoryHandle & {
  values?: () => AsyncIterable<FileSystemHandle>;
};

/** 让用户挑一个目录(必须发生在用户手势中,否则浏览器会拒绝) */
export async function pickDirectory(
  options?: { id?: string; mode?: 'read' | 'readwrite' },
): Promise<FsDirectoryHandle> {
  const w = window as unknown as {
    showDirectoryPicker?: (opts?: {
      id?: string;
      mode?: 'read' | 'readwrite';
      startIn?: string;
    }) => Promise<FileSystemDirectoryHandle>;
  };
  if (!w.showDirectoryPicker) {
    throw new Error('当前浏览器不支持 File System Access(需要 Chromium 86+)');
  }
  const handle = await w.showDirectoryPicker({
    id: options?.id ?? 'qnh-export-dir',
    mode: options?.mode ?? 'readwrite',
  });
  // 二次确认权限(showDirectoryPicker 通常已经给了,但保险一手)
  await ensurePermission(handle, options?.mode ?? 'readwrite');
  return handle as FsDirectoryHandle;
}

/** 在已有 handle 上确保具备所需权限,缺失则申请;申请同样要求用户手势 */
export async function ensurePermission(
  handle: FileSystemHandle,
  mode: 'read' | 'readwrite',
): Promise<void> {
  const h = handle as FileSystemHandle & {
    queryPermission?: (d: { mode: string }) => Promise<PermissionState>;
    requestPermission?: (d: { mode: string }) => Promise<PermissionState>;
  };
  if (h.queryPermission) {
    const cur = await h.queryPermission({ mode });
    if (cur === 'granted') return;
  }
  if (h.requestPermission) {
    const next = await h.requestPermission({ mode });
    if (next !== 'granted') throw new Error('未获得目录读写权限');
  }
}

/** 取/建子目录(getDirectoryHandle + create) */
export function getOrCreateDir(
  parent: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemDirectoryHandle> {
  return parent.getDirectoryHandle(name, { create: true });
}

/** 取子目录,不存在返回 null(读路径用) */
export async function getSubdirOrNull(
  parent: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await parent.getDirectoryHandle(name, { create: false });
  } catch {
    return null;
  }
}

/** 写一个文本文件(utf-8) */
export async function writeTextFile(
  dir: FileSystemDirectoryHandle,
  name: string,
  text: string,
): Promise<void> {
  const file = await dir.getFileHandle(name, { create: true });
  const w = await file.createWritable();
  try {
    await w.write(text);
  } finally {
    await w.close();
  }
}

/** 写一个二进制文件 */
export async function writeBinaryFile(
  dir: FileSystemDirectoryHandle,
  name: string,
  data: ArrayBuffer | Uint8Array | Blob,
): Promise<void> {
  const file = await dir.getFileHandle(name, { create: true });
  const w = await file.createWritable();
  try {
    // 三种入参 createWritable 都接受;TS 在 Uint8Array<ArrayBufferLike> 上对
    // SharedArrayBuffer 收紧了类型,这里 cast 一下避免误报。运行时不受影响。
    await w.write(data as BufferSource | Blob);
  } finally {
    await w.close();
  }
}

/** 读一个文本文件,不存在返回 null */
export async function readTextFile(
  dir: FileSystemDirectoryHandle,
  name: string,
): Promise<string | null> {
  try {
    const file = await dir.getFileHandle(name, { create: false });
    const blob = await file.getFile();
    return await blob.text();
  } catch {
    return null;
  }
}

/** 读 JSON,文件不存在或解析失败都返回 null */
export async function readJsonFile<T>(
  dir: FileSystemDirectoryHandle,
  name: string,
): Promise<T | null> {
  const text = await readTextFile(dir, name);
  if (text == null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function writeJsonFile(
  dir: FileSystemDirectoryHandle,
  name: string,
  value: unknown,
): Promise<void> {
  return writeTextFile(dir, name, JSON.stringify(value, null, 2));
}

/** 把目录里某文件读成 Blob,不存在返回 null */
export async function readFileBlob(
  dir: FileSystemDirectoryHandle,
  name: string,
): Promise<File | null> {
  try {
    const fh = await dir.getFileHandle(name, { create: false });
    return await fh.getFile();
  } catch {
    return null;
  }
}

/** 列出目录下所有文件名(浅层,不进子目录) */
export async function listFileNames(
  dir: FileSystemDirectoryHandle,
): Promise<string[]> {
  const out: string[] = [];
  // values() 是 async iterable,Edge / Chrome 都已实现
  const iter = (dir as FsDirectoryHandle).values?.();
  if (!iter) return out;
  for await (const entry of iter) {
    if (entry.kind === 'file') out.push(entry.name);
  }
  return out;
}

/** 在目录里查一个以 prefix 开头的文件名(媒体按 hash 命名,扩展名变化用前缀匹配) */
export async function findFileByPrefix(
  dir: FileSystemDirectoryHandle,
  prefix: string,
): Promise<string | null> {
  const iter = (dir as FsDirectoryHandle).values?.();
  if (!iter) return null;
  for await (const entry of iter) {
    if (entry.kind === 'file' && entry.name.startsWith(prefix)) return entry.name;
  }
  return null;
}

/* ============================================================
   续传进度文件
   ----------------------------------------------------------
   .qnh-progress.json 跟 manifest.json 一块躺在导出目录根。
   导出过程:
     - 启动时若发现已有 progress 文件,提示是否续传
     - 每完成一个 SPU(详情 + 全部媒体写盘)立即更新 progress
     - 全部完成,写 manifest.json 后即可删除 progress(留着也无害,主要看 manifest)
   ============================================================ */

export const PROGRESS_FILE = '.qnh-progress.json';
export const MANIFEST_FILE = 'manifest.json';

export interface ExportProgressFile {
  schemaVersion: 1;
  createdAt: string;
  source: { shopId: string | number; shopName?: string };
  options: { includeVideo: boolean; includeImages?: boolean };
  /** 已写入到 products/<spuId>.json 的源 SPU id 列表 */
  doneSpuIds: string[];
  /** 已写入到 media/ 的内容 hash 列表 */
  doneMediaHashes: string[];
  /** 队列快照:含初始 list 抓出的 SPU + 后续发现的子商品 SPU */
  queue: Array<{ spuId: string | number; name: string; reason: 'list' | 'child' }>;
  /** 列表抓取是否已完成(用于"未抓完列表就崩"的场景) */
  listFinished: boolean;
}

/** 检查目录是否已经是一份"已完成"的导出包 */
export async function readManifestIfComplete(
  dir: FileSystemDirectoryHandle,
): Promise<unknown | null> {
  return readJsonFile<unknown>(dir, MANIFEST_FILE);
}

/** 读续传进度,无返回 null */
export function readExportProgress(
  dir: FileSystemDirectoryHandle,
): Promise<ExportProgressFile | null> {
  return readJsonFile<ExportProgressFile>(dir, PROGRESS_FILE);
}

/**
 * 写进度。这里有意每次都重写整文件:
 *   - 文件就那点内容(几 KB),IO 完全可接受
 *   - createWritable 默认是 truncate 重写,自带原子性
 */
export function writeExportProgress(
  dir: FileSystemDirectoryHandle,
  progress: ExportProgressFile,
): Promise<void> {
  return writeJsonFile(dir, PROGRESS_FILE, progress);
}

/** 完成导出后,删除进度文件(留 manifest 即可) */
export async function removeExportProgress(
  dir: FileSystemDirectoryHandle,
): Promise<void> {
  try {
    await dir.removeEntry(PROGRESS_FILE);
  } catch {
    /* 不存在也无所谓 */
  }
}
