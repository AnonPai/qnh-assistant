/**
 * 导出流程编排(目录直写 · 不再压缩为 zip):
 *
 *   1) 由调用方传入用户选定的目录 handle(必须由用户手势触发 showDirectoryPicker
 *      产生,否则浏览器会拒绝)
 *   2) 拉店铺信息 / 类目树
 *   3) 拉商品列表;若是续传任务,列表 + 队列从 .qnh-progress.json 恢复
 *   4) 逐个 SPU:抓详情 → 下载该 SPU 引用的所有媒体 → 把详情 json 写到
 *      products/<spuId>.json,并把进度文件 .qnh-progress.json 增量更新一次
 *   5) 全部完成后写 manifest.json(用作"完整"标记),清掉 .qnh-progress.json
 *
 * 跟旧实现的差异:
 *   - 没有 JSZip,没有 base64 大字符串,峰值内存就是当前正在处理的那个媒体的大小
 *   - 单 SPU 原子提交;中途崩了可以从最近一个完成的 SPU 之后继续
 *   - 媒体按 hash 命名跨 SPU 去重,目录里同一张图永远只存一份
 */

import { createLogger } from '@shared/logger';
import { sha256Hex, base64ToBytes } from '@shared/hash';
import { jitter, THROTTLE } from '@shared/sleep';
import type {
  CategorySnapshot,
  ExportManifest,
  MediaAsset,
  ProductSpu,
} from '@shared/types';
import type { ProgressEvent, ShopInfo } from '@shared/messaging';
import type { CallInjected } from './index';
import {
  ExportProgressFile,
  MANIFEST_FILE,
  getOrCreateDir,
  readExportProgress,
  readJsonFile,
  removeExportProgress,
  writeBinaryFile,
  writeExportProgress,
  writeJsonFile,
} from './fs-stage';

const log = createLogger('export');

interface RunExportArgs {
  sourceShopId: string | number;
  sourceShopName?: string;
  /** 仅导出前 N 个商品(冒烟测试用)。不传或 <= 0 表示不限制 */
  limitCount?: number;
  /** 商品名关键词模糊匹配 */
  spuNameKeyword?: string;
  /**
   * 显式指定要导出的 SPU id 列表(精确筛选 / 冒烟测试 / 灰度);
   * 设置后会跳过 FETCH_PRODUCT_LIST 分页,直接拿这份清单进队列。
   * 子商品(组合装的 childSkuList)依然会被自动发现并入队。
   * 优先级高于 spuNameKeyword / skuUpcList —— 一旦给了清单,其它列表筛选条件忽略。
   */
  spuIdAllowlist?: Array<string | number>;
  /**
   * 商品条码筛选:UPC / 条码列表。只导出"任一 SKU 命中给定条码"的 SPU。
   * best-effort 透传给后端的同时,会在拿到门店列表后按 item.upcList 本地兜底过滤
   * (后端若忽略该参数,本地过滤仍能保证结果正确)。
   */
  skuUpcList?: string[];
  /**
   * SKU id 筛选:只导出"任一 SKU 命中给定 skuId"的 SPU。
   * best-effort 透传给后端的同时,会在拿到门店列表后按 item.skuIdList 本地兜底过滤。
   */
  skuIdList?: Array<string | number>;
  /** 是否一并导出图片(默认 true);关闭后图片字段保留原始 CDN URL,不会下载到本地 */
  includeImages?: boolean;
  /** 是否一并导出视频(默认 false) */
  includeVideo?: boolean;
  /** 用户已选目录(已具备读写权限);导出产物直接写到这里 */
  targetDir: FileSystemDirectoryHandle;
  cancelFlag: { cancelled: boolean };
  onProgress: (e: ProgressEvent) => void;
  callInjected: CallInjected;
}

interface ProductListPage {
  list: Array<{ spuId: string | number; name: string; upcList?: string[]; skuIdList?: string[] }>;
  total: number;
}

/** 商品列表 / 队列里每一项的形态(和 ExportProgressFile.queue 等价) */
type QueueItem = ExportProgressFile['queue'][number];

export async function runExport({
  sourceShopId,
  sourceShopName,
  limitCount,
  spuNameKeyword,
  spuIdAllowlist,
  skuUpcList,
  skuIdList,
  includeImages = true,
  includeVideo = false,
  targetDir,
  cancelFlag,
  onProgress,
  callInjected,
}: RunExportArgs) {
  const limited = typeof limitCount === 'number' && limitCount > 0;
  const useAllowlist = !!spuIdAllowlist && spuIdAllowlist.length > 0;
  // 商品条码筛选:规整成去重后的非空集合,供本地兜底过滤
  const upcFilter = normalizeUpcFilter(skuUpcList);
  const useUpcFilter = upcFilter.size > 0;
  // SKU id 筛选:同样规整成去重后的非空集合
  const skuIdFilter = normalizeUpcFilter(skuIdList?.map(String));
  const useSkuIdFilter = skuIdFilter.size > 0;

  // ---- 0) 准备目录与续传状态 ----
  const productsDir = await getOrCreateDir(targetDir, 'products');
  const mediaDir = await getOrCreateDir(targetDir, 'media');
  const existingProgress = await readExportProgress(targetDir);
  // 仅在"目标店一致 + 选项一致"的前提下才接续上次;否则按全新任务起
  const resume =
    existingProgress &&
    String(existingProgress.source.shopId) === String(sourceShopId) &&
    existingProgress.options.includeVideo === includeVideo &&
    (existingProgress.options.includeImages ?? true) === includeImages
      ? existingProgress
      : null;
  if (existingProgress && !resume) {
    log.warn('目录里有上次的进度,但与当前任务不匹配,按全新任务覆盖');
  }

  // ---- 1) 店铺信息 ----
  const shop = await callInjected<ShopInfo>({ type: 'FETCH_SHOP_INFO' });
  shop.shopId = sourceShopId;
  if (sourceShopName) shop.shopName = sourceShopName;
  log.info('shop', shop);

  // ---- 2) 类目树 ----
  // 续传场景下也重写一次,反正几十 KB,免得旧的过时
  const categories = await callInjected<CategorySnapshot[]>({
    type: 'FETCH_CATEGORY_TREE',
    payload: { shopId: sourceShopId },
  });
  await writeJsonFile(targetDir, 'categories.json', categories);

  // ---- 3) 商品列表 ----
  const fetched = new Set<string>(resume?.doneSpuIds ?? []);
  const queue: QueueItem[] = resume ? [...resume.queue] : [];
  let listFinished = resume?.listFinished ?? false;

  if (!listFinished) {
    if (useAllowlist) {
      // 显式 SPU 清单:跳过分页,直接把 ID 入队。商品名拿不到,先用 ID 占位,
      // 后面 FETCH_PRODUCT_DETAIL 拿到详情时进度面板的 message 会用真实名。
      onProgress({
        kind: 'export',
        phase: 'list',
        current: spuIdAllowlist!.length,
        total: spuIdAllowlist!.length,
        message: `按指定 SPU 清单导出(${spuIdAllowlist!.length} 个)`,
      });
      queue.push(
        ...spuIdAllowlist!.map((id) => ({
          spuId: id,
          name: String(id),
          reason: 'list' as const,
        })),
      );
      listFinished = true;
      log.info(`使用 SPU 清单导出,共 ${spuIdAllowlist!.length} 个`);
      await persistProgress({
        targetDir,
        sourceShopId,
        sourceShopName,
        includeVideo,
        includeImages,
        fetched,
        queue,
        listFinished,
        existingCreatedAt: resume?.createdAt,
      });
    } else {
      onProgress({ kind: 'export', phase: 'list', current: 0, total: 0, message: '加载商品列表' });
      let pageNo = 1;
      const pageSize = limited ? 10 : 50;
      const allList: Array<{ spuId: string | number; name: string; upcList?: string[]; skuIdList?: string[] }> = [];
      while (!cancelFlag.cancelled) {
        const page = await callInjected<ProductListPage>({
          type: 'FETCH_PRODUCT_LIST',
          payload: {
            shopId: sourceShopId,
            pageNo,
            pageSize,
            spuName: spuNameKeyword,
            upcList: useUpcFilter ? [...upcFilter] : undefined,
            skuIdList: useSkuIdFilter ? [...skuIdFilter] : undefined,
            scope: 'store',
          },
        });
        allList.push(...page.list);
        onProgress({ kind: 'export', phase: 'list', current: allList.length, total: page.total });
        if (limited) break;
        if (allList.length >= page.total || page.list.length === 0) break;
        pageNo++;
        await jitter(...THROTTLE.EXPORT_LIST_PAGE);
      }
      if (cancelFlag.cancelled) {
        // 把已抓的列表先落盘,下次直接从这里接
        await persistProgress({
          targetDir,
          sourceShopId,
          sourceShopName,
          includeVideo,
          includeImages,
          fetched,
          queue,
          listFinished: false,
          existingCreatedAt: resume?.createdAt,
        });
        throw new Error('已取消');
      }
      const limitedList = limited ? allList.slice(0, limitCount!) : allList;
      // 本地兜底过滤:后端如果忽略了 upcList / skuIdList 透传,这里按门店列表里
      // 每个 SPU 的 upcList / skuIdList 精确比对。两个筛选都给时取交集(都要命中)。
      const targetList = limitedList.filter((it) => {
        if (useUpcFilter && !(it.upcList ?? []).some((u) => upcFilter.has(normalizeUpc(u)))) {
          return false;
        }
        if (useSkuIdFilter && !(it.skuIdList ?? []).some((s) => skuIdFilter.has(normalizeUpc(s)))) {
          return false;
        }
        return true;
      });
      log.info(
        `商品总数: ${allList.length}` +
          (limited ? `,本次仅导出前 ${limitedList.length} 个` : '') +
          (useUpcFilter || useSkuIdFilter ? `,按 SKU/条码筛选后 ${targetList.length} 个` : ''),
      );
      queue.push(
        ...targetList.map((it) => ({ spuId: it.spuId, name: it.name, reason: 'list' as const })),
      );
      listFinished = true;

      await persistProgress({
        targetDir,
        sourceShopId,
        sourceShopName,
        includeVideo,
        includeImages,
        fetched,
        queue,
        listFinished,
        existingCreatedAt: resume?.createdAt,
      });
    }
  } else {
    log.info(`续传:已写入 ${fetched.size} 个 SPU,队列里还有 ${queue.length} 个待处理`);
  }

  // ---- 4) 详情 + 媒体 ----
  // mediaIndex:本次会话内已知的所有 hash → asset。续传时从已有 media 目录可以推断
  // 出 hash,但具体 mime/size/sourceUrl 已经丢了;为了简化,续传场景里 mediaIndex
  // 留空,媒体写盘时直接判 fs 是否已存在该 hash 文件来跳过下载,新增的 asset 信息
  // 仍可以通过该 SPU 的 __pendingMedia 现场补齐。
  const mediaIndex = new Map<string, MediaAsset>();
  let processed = fetched.size; // 已完成 SPU 数(含续传)

  while (queue.length > 0) {
    if (cancelFlag.cancelled) {
      await persistProgress({
        targetDir,
        sourceShopId,
        sourceShopName,
        includeVideo,
        includeImages,
        fetched,
        queue,
        listFinished,
        existingCreatedAt: resume?.createdAt,
      });
      throw new Error('已取消');
    }
    const item = queue[0];
    const key = String(item.spuId);
    if (fetched.has(key)) {
      queue.shift();
      continue;
    }
    processed++;
    const productTotal = processed + queue.length - 1;

    onProgress({
      kind: 'export',
      phase: 'detail',
      current: processed,
      total: productTotal,
      message: item.reason === 'child' ? `子商品 ${item.name}` : item.name,
      productCurrent: processed,
      productTotal,
    });

    let spu = await callInjected<ProductSpu>({
      type: 'FETCH_PRODUCT_DETAIL',
      payload: { shopId: sourceShopId, spuId: item.spuId },
    });

    const allPending =
      (spu.raw?.__pendingMedia as Array<{ url: string; kind: 'image' | 'video'; ref: string }>) ?? [];
    // includeImages = false 时跳过图片下载(图片 URL 保留在 spu json 里,
    // 不会被替换成 media://hash;导入端会按"直链同步"的路径走);
    // includeVideo 控制是否同时下视频。
    const pending = allPending.filter((m) => {
      if (m.kind === 'image' && !includeImages) return false;
      if (m.kind === 'video' && !includeVideo) return false;
      return true;
    });

    const urlToHash = new Map<string, string>();
    for (let m = 0; m < pending.length; m++) {
      if (cancelFlag.cancelled) break;
      const { url, kind } = pending[m];
      onProgress({
        kind: 'export',
        phase: 'media',
        current: m + 1,
        total: pending.length,
        message: `${item.name} · ${kind}`,
        productCurrent: processed,
        productTotal,
      });
      try {
        const r = await downloadMedia(url, kind, mediaDir, mediaIndex);
        urlToHash.set(url, r.asset.hash);
      } catch (e) {
        log.warn(`下载媒体失败,跳过: ${url}`, e);
      }
    }
    if (cancelFlag.cancelled) {
      // 把刚刚抓下来的媒体已经落了盘,但 SPU 自己还没写;不计入 fetched
      // 下次续传会重新跑这个 SPU,媒体因为 hash 命中能跳过实际下载
      processed--;
      await persistProgress({
        targetDir,
        sourceShopId,
        sourceShopName,
        includeVideo,
        includeImages,
        fetched,
        queue,
        listFinished,
        existingCreatedAt: resume?.createdAt,
      });
      throw new Error('已取消');
    }

    delete (spu.raw as Record<string, unknown> | undefined)?.__pendingMedia;
    spu = replaceUrlsInSpu(spu, urlToHash);

    const childIds = collectChildSpuIds(spu);
    for (const cid of childIds) {
      if (!fetched.has(String(cid)) && !queue.some((q) => String(q.spuId) === String(cid))) {
        queue.push({ spuId: cid, name: String(cid), reason: 'child' });
      }
    }

    // 商品 json 落盘 — 这是 SPU 的"提交点"。落盘后才把它登记到 fetched + 进度文件
    await writeJsonFile(productsDir, `${spu.sourceSpuId}.json`, spu);

    fetched.add(key);
    queue.shift();
    await persistProgress({
      targetDir,
      sourceShopId,
      sourceShopName,
      includeVideo,
      includeImages,
      fetched,
      queue,
      listFinished,
      existingCreatedAt: resume?.createdAt,
    });

    onProgress({
      kind: 'log',
      level: 'success',
      index: processed,
      total: productTotal,
      text: `导出 ${item.reason === 'child' ? '[子] ' : ''}${item.name} · 媒体 ${pending.length} 项`,
    });

    await jitter(...THROTTLE.EXPORT_PRODUCT);
  }

  // ---- 5) manifest + media 索引 ----
  const allMediaAssets = await collectMediaAssetsForManifest(mediaDir, mediaIndex);
  const manifest: ExportManifest = {
    schemaVersion: 1,
    pluginVersion: '0.1.0',
    source: {
      shopId: shop.shopId,
      shopName: shop.shopName,
      accountName: shop.accountName,
      exportedAt: new Date().toISOString(),
    },
    productCount: fetched.size,
    mediaCount: allMediaAssets.length,
  };
  await writeJsonFile(targetDir, 'media.json', allMediaAssets);
  await writeJsonFile(targetDir, MANIFEST_FILE, manifest);
  // 完成后清掉续传文件,留 manifest 作为完整标记
  await removeExportProgress(targetDir);

  onProgress({ kind: 'done', result: { manifest, fileName: '(目录直写)' } });
}

/** 把进度文件原子写盘,所有可能"中断"的位置都过这一个出口 */
async function persistProgress(args: {
  targetDir: FileSystemDirectoryHandle;
  sourceShopId: string | number;
  sourceShopName?: string;
  includeVideo: boolean;
  includeImages: boolean;
  fetched: Set<string>;
  queue: QueueItem[];
  listFinished: boolean;
  existingCreatedAt?: string;
}): Promise<void> {
  const progress: ExportProgressFile = {
    schemaVersion: 1,
    createdAt: args.existingCreatedAt ?? new Date().toISOString(),
    source: { shopId: args.sourceShopId, shopName: args.sourceShopName },
    options: { includeVideo: args.includeVideo, includeImages: args.includeImages },
    doneSpuIds: [...args.fetched],
    doneMediaHashes: [], // 媒体跳过下载靠"目录里 hash 文件已存在"的现场判断,这里不维护
    queue: args.queue,
    listFinished: args.listFinished,
  };
  await writeExportProgress(args.targetDir, progress);
}

/**
 * 下载单个媒体(走 background service worker 代理 fetch)。
 * 返回的 asset 已写入目录 / mediaIndex(按 hash 去重)。
 *
 * 这里走 base64 over message 的 trade-off:单张图/单段视频体量可控,
 * 跨进程克隆瞬时翻倍可以接受;尝试过 SW 端 createObjectURL + content 端 fetch,
 * 但 blob:chrome-extension://… 受同源策略限制,content 拿不到。
 */
async function downloadMedia(
  url: string,
  kind: 'image' | 'video',
  mediaDir: FileSystemDirectoryHandle,
  index: Map<string, MediaAsset>,
): Promise<{ asset: MediaAsset; fresh: boolean }> {
  const resp = (await chrome.runtime.sendMessage({
    __channel: 'fetch-media',
    url,
  })) as
    | { ok: true; bytesBase64: string; mime: string; size: number }
    | { ok: false; error: string };

  if (!resp || !resp.ok) {
    throw new Error(`下载媒体失败: ${(resp && 'error' in resp && resp.error) || 'unknown'} @ ${url}`);
  }

  // 解码后立刻把 base64 字符串引用切断,让 GC 能回收;hash 计算在 buf 上做。
  const bytes = base64ToBytes(resp.bytesBase64);
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const hash = await sha256Hex(buf);

  const cached = index.get(hash);
  if (cached) return { asset: cached, fresh: false };

  const mime = resp.mime || (kind === 'image' ? 'image/jpeg' : 'video/mp4');
  const ext = guessExt(mime, url);
  const path = `media/${hash}${ext}`;
  await writeBinaryFile(mediaDir, `${hash}${ext}`, buf);

  const asset: MediaAsset = { hash, kind, sourceUrl: url, mime, size: resp.size, path };
  index.set(hash, asset);
  return { asset, fresh: true };
}

/**
 * 写 manifest 前重建 media.json 的内容:
 *   - 如果是从头跑的导出,mediaIndex 已经覆盖所有产生的 asset
 *   - 续传场景下 mediaIndex 可能不完整(老的没记进来),
 *     兜底再扫一遍目录把已有文件都补到 media.json 里(信息有限,kind/sourceUrl 留空)
 */
async function collectMediaAssetsForManifest(
  mediaDir: FileSystemDirectoryHandle,
  index: Map<string, MediaAsset>,
): Promise<MediaAsset[]> {
  const out = new Map<string, MediaAsset>();
  for (const a of index.values()) out.set(a.hash, a);
  const iter = (mediaDir as FileSystemDirectoryHandle & {
    values?: () => AsyncIterable<FileSystemHandle>;
  }).values?.();
  if (iter) {
    for await (const entry of iter) {
      if (entry.kind !== 'file') continue;
      const m = entry.name.match(/^([a-f0-9]{64})(\..+)?$/);
      if (!m) continue;
      const hash = m[1];
      if (out.has(hash)) continue;
      // 续传补齐:这些是上一轮已经下载但 mediaIndex 没记忆的文件
      const ext = m[2] ?? '';
      out.set(hash, {
        hash,
        kind: ext === '.mp4' || ext === '.mov' || ext === '.webm' ? 'video' : 'image',
        sourceUrl: '',
        mime: '',
        size: 0,
        path: `media/${entry.name}`,
      });
    }
  }
  return [...out.values()];
}

function guessExt(mime: string, url: string): string {
  if (mime.includes('jpeg')) return '.jpg';
  if (mime.includes('png')) return '.png';
  if (mime.includes('webp')) return '.webp';
  if (mime.includes('gif')) return '.gif';
  if (mime.includes('mp4')) return '.mp4';
  if (mime.includes('quicktime')) return '.mov';
  const m = url.match(/\.(jpg|jpeg|png|webp|gif|mp4|mov|webm)(\?|$)/i);
  return m ? `.${m[1].toLowerCase()}` : '.bin';
}

/**
 * 批量把 spu 内所有出现的 url 替换成 `media://${hash}`,
 * 包括字符串、数组、对象、以及 HTML 字符串内的 src/href。
 */
function replaceUrlsInSpu(spu: ProductSpu, urlToHash: Map<string, string>): ProductSpu {
  if (urlToHash.size === 0) return spu;
  const entries = Array.from(urlToHash.entries()).sort((a, b) => b[0].length - a[0].length);
  const replaceInString = (s: string): string => {
    if (!s) return s;
    let out = s;
    for (const [url, hash] of entries) {
      if (out.includes(url)) out = out.split(url).join(`media://${hash}`);
    }
    return out;
  };
  const visit = (node: unknown): unknown => {
    if (typeof node === 'string') return replaceInString(node);
    if (Array.isArray(node)) return node.map(visit);
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = visit(v);
      return out;
    }
    return node;
  };
  return visit(spu) as ProductSpu;
}

/** SKU 条码筛选:把 UPC 列表去重、去空、规整 */
function normalizeUpcFilter(list?: string[]): Set<string> {
  const out = new Set<string>();
  for (const raw of list ?? []) {
    const u = normalizeUpc(raw);
    if (u) out.add(u);
  }
  return out;
}

/** 单个 UPC 规整:trim,去掉内部空白(条码里偶尔粘了空格) */
function normalizeUpc(u: string | number | null | undefined): string {
  if (u == null) return '';
  return String(u).trim().replace(/\s+/g, '');
}

/** 收集组合装的子 SPU id */
function collectChildSpuIds(spu: ProductSpu): Array<string | number> {  const detail = spu.raw?.detail as
    | { skus?: Array<{ childSkuList?: Array<{ spuId?: string | number }> | null }> }
    | undefined;
  if (!detail?.skus) return [];
  const out: Array<string | number> = [];
  const seen = new Set<string>();
  for (const sku of detail.skus) {
    for (const child of sku.childSkuList ?? []) {
      const id = child.spuId;
      if (id == null) continue;
      const key = String(id);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(id);
    }
  }
  return out;
}

/* ============================================================
   续传探测:在用户挑好目录之后、决定要不要跑导出之前调用,
   返回该目录的状态描述供 UI 弹"继续 / 重新开始"。
   ============================================================ */

export type ExportTargetStatus =
  | { kind: 'empty' }
  | { kind: 'incomplete'; progress: ExportProgressFile }
  | { kind: 'complete'; manifest: ExportManifest };

export async function detectExportTargetStatus(
  dir: FileSystemDirectoryHandle,
): Promise<ExportTargetStatus> {
  const manifest = await readJsonFile<ExportManifest>(dir, MANIFEST_FILE);
  if (manifest) return { kind: 'complete', manifest };
  const progress = await readExportProgress(dir);
  if (progress) return { kind: 'incomplete', progress };
  return { kind: 'empty' };
}
