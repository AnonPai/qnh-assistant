/**
 * 远程图片 URL → SHA-256 缓存。
 *
 * 用途:重复导入时,目标店里那张图的 URL 跟我们源端 `media://<hash>` 没法直接比对
 *   (美团 CDN basename 是它自己的内容哈希,和 SHA-256 不同)。
 * 唯一靠得住的办法是把目标 URL 下载下来重算 SHA-256,跟源 hash 对一对。
 * 同一店重复导入会反复命中同一批 URL,所以这里用 sidecar 文件持久化,
 * 减少重复下载(几百张图 × 几 MB 也是真金白银的网络成本)。
 *
 * 落盘文件名:`.qnh-target-image-hashes.json`,放在源目录(用户挑的导入目录),
 * 跟 manifest / progress 同级。结构:
 *   { schemaVersion: 1, entries: { [url]: hash } }
 */

import { sha256Hex, base64ToBytes } from './hash';

interface CacheFile {
  schemaVersion: 1;
  /** url(已 normalize:scheme 升 https,去掉 query/hash)→ sha256 hex */
  entries: Record<string, string>;
  /**
   * 「源图内容 hash」→「上传到目标店后、美团重新编码存储的内容 hash」等价表。
   * 美团对上传图会做服务端重编码,源文件 sha256 与目标存储 sha256 必然不同,
   * 但对同一张源图是确定性的。记下这条等价关系,重复导入时比对才不会永远误判"已修改"。
   */
  uploadEquiv?: Record<string, string>;
}

const CACHE_FILE = '.qnh-target-image-hashes.json';

/**
 * URL 归一(只做最低限度的清理,避免把"同一张图的不同访问形式"算成两条记录):
 *   - http → https(background fetch 也是这么升的)
 *   - 去掉 query / hash 片段(美团 CDN 的图片处理参数不影响字节内容)
 *   - 不动路径前缀 (sgfn / retailsp / 0.0.o / @缩放参数 等),
 *     因为这些前缀对应的资源字节有可能不同,各自独立 hash 才安全
 */
function canonicalizeUrl(url: string): string {
  if (!url) return '';
  const upgraded = url.replace(/^http:\/\//i, 'https://');
  const noQuery = upgraded.split('?')[0].split('#')[0];
  return noQuery;
}

export class UrlHashCache {
  /** url(canonical)→ hash 的纯内存视图 */
  private readonly map: Map<string, string>;
  /** 源图内容 hash → 目标店重编码后存储的内容 hash(双向都登记,查的时候两边都认) */
  private readonly uploadEquiv: Map<string, string>;
  /** 哪些 key 在内存改过,持久化时只写这部分(其实整体落盘也行,文件不大) */
  private dirty = false;
  /** 同一 url 并发计算时复用同一 Promise,避免重复下载 */
  private readonly inflight = new Map<string, Promise<string>>();

  private constructor(initial: Record<string, string>, uploadEquiv?: Record<string, string>) {
    this.map = new Map(Object.entries(initial));
    this.uploadEquiv = new Map(Object.entries(uploadEquiv ?? {}));
  }

  static async load(dir: FileSystemDirectoryHandle | null | undefined): Promise<UrlHashCache> {
    if (!dir) return new UrlHashCache({});
    const data = await tryReadCache(dir);
    return new UrlHashCache(data?.entries ?? {}, data?.uploadEquiv);
  }

  /**
   * 登记一条"源图 hash ≡ 目标店重编码后 hash"的等价关系。
   * 在图片上传成功、且我们随后下载目标 URL 算出其存储 hash 时调用。
   */
  recordUploadEquiv(sourceHash: string, targetHash: string): void {
    if (!sourceHash || !targetHash || sourceHash === targetHash) return;
    const s = sourceHash.toLowerCase();
    const t = targetHash.toLowerCase();
    if (this.uploadEquiv.get(s) === t) return; // 已记过,免脏写
    this.uploadEquiv.set(s, t);
    this.dirty = true;
  }

  /**
   * 判断两个内容 hash 是否"等价":字面相等,或被上传重编码等价表关联。
   * 源图与目标存储图字节不同但语义同一时(走过上传路径),据此判等。
   */
  hashesEquivalent(a: string, b: string): boolean {
    if (!a || !b) return false;
    const x = a.toLowerCase();
    const y = b.toLowerCase();
    if (x === y) return true;
    return this.uploadEquiv.get(x) === y || this.uploadEquiv.get(y) === x;
  }

  /**
   * 拿到一个 URL 的 SHA-256(命中缓存返回内存值,未命中调 fetcher 下载并写缓存)。
   * 任何下载/解码异常都向上抛,由调用方决定退化策略。
   */
  async getOrCompute(rawUrl: string, fetcher: (url: string) => Promise<ArrayBuffer>): Promise<string> {
    const url = canonicalizeUrl(rawUrl);
    if (!url) return '';
    const cached = this.map.get(url);
    if (cached) return cached;

    const pending = this.inflight.get(url);
    if (pending) return pending;

    const job = (async () => {
      const buf = await fetcher(url);
      const hash = await sha256Hex(buf);
      this.map.set(url, hash);
      this.dirty = true;
      return hash;
    })();
    this.inflight.set(url, job);
    try {
      return await job;
    } finally {
      this.inflight.delete(url);
    }
  }

  /** 仅查缓存(供同步路径用,未命中返回 undefined) */
  peek(rawUrl: string): string | undefined {
    return this.map.get(canonicalizeUrl(rawUrl));
  }

  /** 把当前缓存原子落盘(只在有改动时写) */
  async flush(dir: FileSystemDirectoryHandle | null | undefined): Promise<void> {
    if (!dir || !this.dirty) return;
    const out: CacheFile = {
      schemaVersion: 1,
      entries: Object.fromEntries(this.map),
      uploadEquiv: Object.fromEntries(this.uploadEquiv),
    };
    try {
      await writeCache(dir, out);
      this.dirty = false;
    } catch {
      // 写失败不影响导入主流程,下次再算就是
    }
  }
}

async function tryReadCache(dir: FileSystemDirectoryHandle): Promise<CacheFile | null> {
  try {
    const fh = await dir.getFileHandle(CACHE_FILE, { create: false });
    const file = await fh.getFile();
    const text = await file.text();
    const data = JSON.parse(text) as CacheFile;
    if (data?.schemaVersion !== 1 || !data.entries || typeof data.entries !== 'object') return null;
    return data;
  } catch {
    return null;
  }
}

async function writeCache(dir: FileSystemDirectoryHandle, data: CacheFile): Promise<void> {
  const fh = await dir.getFileHandle(CACHE_FILE, { create: true });
  // Chrome 在 content script 上不暴露 createWritable,但 import 流程跑在 SW MV3 之外的页面上下文,
  // 这里跟 fs-stage.ts 一样能用 createWritable
  const w = await (fh as FileSystemFileHandle & {
    createWritable: () => Promise<FileSystemWritableFileStream>;
  }).createWritable();
  await w.write(JSON.stringify(data, null, 2));
  await w.close();
}

/**
 * 调用 background SW 的 fetch-media 代理,把任意 CDN URL 拉成 ArrayBuffer。
 * 跟 export.ts / api.ts 走的是同一条通道。
 */
export async function fetchUrlAsArrayBuffer(url: string): Promise<ArrayBuffer> {
  const resp = (await chrome.runtime.sendMessage({
    __channel: 'fetch-media',
    url,
  })) as
    | { ok: true; bytesBase64: string; mime: string; size: number }
    | { ok: false; error: string };
  if (!resp || !resp.ok) {
    throw new Error(`fetch-media 失败: ${resp && 'error' in resp ? resp.error : 'unknown'}`);
  }
  const bytes = base64ToBytes(resp.bytesBase64);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

// 仅用于测试 / 调试
export const __test__ = { canonicalizeUrl, CACHE_FILE };
