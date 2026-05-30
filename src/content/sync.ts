/**
 * 「同步库存 / 零售价」流程编排
 *
 * 场景:把一份导出目录里每个 SKU 的「零售价 / 库存」推送到用户选定的目标门店。
 *   - 数据源:导出目录的 products/<spuId>.json(与导入共用同一份产物)。
 *   - 关键点:跨门店 / 跨账号时,目标门店的 SPU / SKU id 与导出包里的 id 不同,
 *     不能直接复用源 id。必须和「导入」一致,先按 UPC、再按商品名匹配到目标商品,
 *     再按 UPC 把源 SKU 对齐到目标 SKU,最后把价格 / 库存写到「目标 SKU id」上。
 *
 * 逐个 SPU 串行处理:
 *   1) 用导入同款规则 lookupExistingForProduct 在目标门店找到对应 SPU(UPC → 商品名)。
 *   2) 拉目标商品详情,按 UPC 把源 SKU 对齐到目标 SKU(数量一致时回退按顺序对齐)。
 *   3) 同步零售价:adjustSkuOnlinePriceSyncStrategy(固定价同时下发渠道 100 / 200)。
 *   4) 同步库存:batchContainer/stockadjustment(按门店 + 目标 SKU 列表,绝对值覆盖)。
 *
 * 数据缺失处理:
 *   - 目标门店没匹配到该商品 → productNotFound 计数,跳过。
 *   - 某源 SKU 没有有效价格(channelPrices / price 都无 → 价格跳过并计数)。
 *   - 某源 SKU 导出包未带库存(stock == null)→ 库存跳过并计数。
 *   - 源 SKU 在目标商品里找不到对齐的目标 SKU → 该 SKU 的价格 / 库存都跳过。
 */

import { createLogger } from '@shared/logger';
import { jitter, THROTTLE } from '@shared/sleep';
import type { ProductSpu, SyncSummary } from '@shared/types';
import type {
  ProgressEvent,
  SkuPriceAdjust,
  SkuStockAdjust,
} from '@shared/messaging';
import type { CallInjected } from './index';
import { lookupExistingForProduct } from './import';
import {
  getSubdirOrNull,
  listFileNames,
  readTextFile,
} from './fs-stage';

const log = createLogger('sync');

interface RunSyncArgs {
  /** 目标门店 */
  shopId: string | number;
  shopName?: string;
  /** 是否同步库存 */
  syncStock: boolean;
  /** 是否同步零售价 */
  syncPrice: boolean;
  /** 数据源目录(导出产物) */
  sourceDir: FileSystemDirectoryHandle;
  cancelFlag: { cancelled: boolean };
  onProgress: (e: ProgressEvent) => void;
  callInjected: CallInjected;
}

/** 目标商品详情里单个 SKU 的最小形态(FETCH_PRODUCT_DETAIL 返回的 ProductSpu) */
interface TargetSku {
  /** 目标门店里的真实 skuId */
  skuId: string | number;
  /** 该 SKU 的全部 UPC(去重、规整后) */
  upcs: Set<string>;
  /** 规格名,用于 UPC 都为空时的兜底比对 */
  specName: string;
}

export async function runSync({
  shopId,
  shopName,
  syncStock,
  syncPrice,
  sourceDir,
  cancelFlag,
  onProgress,
  callInjected,
}: RunSyncArgs): Promise<void> {
  const startedAt = new Date().toISOString();
  log.info(
    `开始同步,目标门店: ${shopName ?? shopId},库存: ${syncStock ? '是' : '否'},零售价: ${syncPrice ? '是' : '否'}`,
  );

  // ---- 1) 读取源目录里的全部商品 ----
  onProgress({ kind: 'sync', phase: 'parse', current: 0, total: 1, message: '读取数据目录' });

  const productsDir = await getSubdirOrNull(sourceDir, 'products');
  if (!productsDir) {
    throw new Error('products 子目录缺失,目录不是有效的导出包');
  }

  const products: ProductSpu[] = [];
  const fileNames = await listFileNames(productsDir);
  for (const name of fileNames) {
    if (!name.endsWith('.json')) continue;
    const text = await readTextFile(productsDir, name);
    if (!text) continue;
    try {
      products.push(JSON.parse(text) as ProductSpu);
    } catch (e) {
      log.warn(`解析商品文件失败,跳过: ${name}`, e);
    }
  }

  if (products.length === 0) {
    throw new Error('products 目录里没有可解析的商品,无法同步');
  }
  log.info(`待同步商品 ${products.length} 个`);

  // ---- 2) 逐个 SPU 同步 ----
  let logIndex = 0;
  const emitLog = (level: 'info' | 'success' | 'warn' | 'error', text: string) => {
    logIndex++;
    onProgress({ kind: 'log', level, index: logIndex, total: products.length, text });
  };

  const summary: SyncSummary = {
    kind: 'sync',
    shopId,
    shopName,
    syncedStock: syncStock,
    syncedPrice: syncPrice,
    productTotal: products.length,
    productProcessed: 0,
    productNotFound: 0,
    priceOk: 0,
    priceFailed: 0,
    priceSkipped: 0,
    stockOk: 0,
    stockFailed: 0,
    stockSkipped: 0,
    startedAt,
    finishedAt: startedAt,
  };

  for (let i = 0; i < products.length; i++) {
    if (cancelFlag.cancelled) break;
    const spu = products[i];
    summary.productProcessed++;

    onProgress({
      kind: 'sync',
      phase: 'sku',
      current: i + 1,
      total: products.length,
      message: spu.name,
      productCurrent: i + 1,
      productTotal: products.length,
    });

    try {
      // ---- 2.1) 用导入同款规则在目标门店找到对应 SPU(UPC → 商品名) ----
      const matched = await lookupExistingForProduct(callInjected, shopId, spu);
      if (!matched) {
        summary.productNotFound++;
        emitLog('warn', `${spu.name} · 目标门店未匹配到(UPC / 商品名都没命中),跳过`);
        await jitter(...THROTTLE.SYNC_PRODUCT);
        continue;
      }

      // ---- 2.2) 拉目标商品详情,准备 SKU 对齐 ----
      const targetSkus = await fetchTargetSkus(callInjected, shopId, matched.spuId);

      const notes: string[] = [`匹配:${matched.reason}`];
      let hadError = false;

      // ---- 2.3) 把源 SKU 对齐到目标 SKU(按 UPC,数量一致时回退按顺序) ----
      const aligned = alignSkus(spu, targetSkus);

      // ---- 2.4) 零售价 ----
      if (syncPrice) {
        const priceList: SkuPriceAdjust[] = [];
        for (const a of aligned) {
          if (!a.target) continue; // 没对齐到目标 SKU 的源 SKU 在下面统一计入跳过
          const channelPrices = resolveChannelPrices(a.source);
          if (channelPrices.length === 0) {
            summary.priceSkipped++;
            continue;
          }
          priceList.push({ skuId: a.target.skuId, channelPrices });
        }
        if (priceList.length > 0) {
          try {
            await callInjected({
              type: 'ADJUST_SKU_PRICE',
              payload: { storeId: shopId, spuId: matched.spuId, skuPriceList: priceList },
            });
            summary.priceOk += priceList.length;
            notes.push(`价×${priceList.length}`);
          } catch (e) {
            summary.priceFailed += priceList.length;
            hadError = true;
            const msg = (e as Error).message;
            if (!summary.firstError) summary.firstError = msg;
            notes.push(`价失败:${msg}`);
          }
        }
      }

      // ---- 2.5) 库存 ----
      if (syncStock && !cancelFlag.cancelled) {
        const stockList: SkuStockAdjust[] = [];
        for (const a of aligned) {
          if (!a.target) continue;
          const stock = a.source.stock;
          if (stock == null || typeof stock !== 'number') {
            summary.stockSkipped++;
            continue;
          }
          stockList.push({ skuId: a.target.skuId, skuName: spu.name, newQuantity: stock });
        }
        if (stockList.length > 0) {
          try {
            await callInjected({
              type: 'ADJUST_SKU_STOCK',
              payload: { storeId: shopId, skuStockList: stockList },
            });
            summary.stockOk += stockList.length;
            notes.push(`库×${stockList.length}`);
          } catch (e) {
            summary.stockFailed += stockList.length;
            hadError = true;
            const msg = (e as Error).message;
            if (!summary.firstError) summary.firstError = msg;
            notes.push(`库失败:${msg}`);
          }
        }
      }

      // 源 SKU 没对齐到目标 SKU:价格 / 库存都没法写,计入对应跳过计数
      const unmatchedSku = aligned.filter((a) => !a.target).length;
      if (unmatchedSku > 0) {
        if (syncPrice) summary.priceSkipped += unmatchedSku;
        if (syncStock) summary.stockSkipped += unmatchedSku;
        notes.push(`${unmatchedSku} 个 SKU 未对齐`);
      }

      emitLog(hadError ? 'error' : 'success', `${spu.name} · ${notes.join(' · ')}`);
    } catch (e) {
      const msg = (e as Error).message;
      if (!summary.firstError) summary.firstError = msg;
      emitLog('error', `${spu.name} · 处理失败:${msg}`);
    }

    await jitter(...THROTTLE.SYNC_PRODUCT);
  }

  summary.finishedAt = new Date().toISOString();
  if (cancelFlag.cancelled) {
    log.warn('同步被取消', summary);
  } else {
    log.info('同步完成', summary);
  }
  onProgress({ kind: 'done', result: summary });
}

/** 拉目标门店里某 SPU 的 SKU 列表(skuId + UPC 集合 + 规格名) */
async function fetchTargetSkus(
  callInjected: CallInjected,
  shopId: string | number,
  targetSpuId: string | number,
): Promise<TargetSku[]> {
  const detail = await callInjected<ProductSpu>({
    type: 'FETCH_PRODUCT_DETAIL',
    payload: { shopId, spuId: targetSpuId },
  });
  const rawSkus = (detail.raw?.detail as
    | { skus?: Array<{ skuId?: string | number; upcList?: string[]; specName?: string }> }
    | undefined)?.skus ?? [];

  // 优先用 raw.detail.skus(带完整 upcList);为空时回退到顶层 skus(只有 outerSkuCode)
  if (rawSkus.length > 0) {
    return rawSkus
      .filter((s) => s.skuId != null)
      .map((s) => ({
        skuId: s.skuId as string | number,
        upcs: normalizeUpcSet(s.upcList),
        specName: normalizeName(s.specName ?? ''),
      }));
  }
  return (detail.skus ?? [])
    .filter((s) => s.sourceSkuId != null)
    .map((s) => ({
      skuId: s.sourceSkuId as string | number,
      upcs: normalizeUpcSet(s.outerSkuCode ? [s.outerSkuCode] : []),
      specName: normalizeName(s.specs?.map((x) => x.value).join('') ?? ''),
    }));
}

interface AlignedSku {
  source: ProductSpu['skus'][number];
  /** 对齐到的目标 SKU;找不到为 null */
  target: TargetSku | null;
}

/**
 * 把源商品的 SKU 对齐到目标商品的 SKU(与「商品导入」一致的口径:UPC → 名称 → 兜底):
 *   1) 优先按 UPC 交集匹配(一个目标 SKU 只用一次)
 *   2) UPC 未命中的,按「规格名」精确匹配 —— 跨门店 / 跨账号时 UPC(常等于源 skuId)
 *      几乎必然不一致,但规格名(如 "3XL（80-100斤）")是稳定信号,不能退化成按 skuId / 顺序硬对
 *   3) 仍未匹配的源 SKU,在源 / 目标 SKU 数量一致时按剩余顺序兜底对齐
 *      (单规格商品最常见,规格名也偶尔录入不一致时还能救回来)
 */
function alignSkus(spu: ProductSpu, targetSkus: TargetSku[]): AlignedSku[] {
  const sourceSkus = spu.skus ?? [];
  const usedTarget = new Set<number>();
  const result: AlignedSku[] = sourceSkus.map((source) => ({ source, target: null }));

  // 源 SKU 的 UPC 集合:顶层 outerSkuCode + raw.detail.skus[i].upcList
  const sourceRawSkus = (spu.raw?.detail as
    | { skus?: Array<{ upcList?: string[]; specName?: string }> }
    | undefined)?.skus ?? [];
  const sourceUpcSets = sourceSkus.map((s, idx) => {
    const set = normalizeUpcSet(s.outerSkuCode ? [s.outerSkuCode] : []);
    for (const u of sourceRawSkus[idx]?.upcList ?? []) {
      const n = normalizeUpc(u);
      if (n) set.add(n);
    }
    return set;
  });

  // 源 SKU 的规格名(归一化):优先 raw.detail.skus[i].specName(导出快照里的整串规格名),
  // 回退到 specs 拼接(早期导出包形态)。与目标侧 TargetSku.specName 同口径(normalizeName)。
  const sourceSpecNames = sourceSkus.map((s, idx) => {
    const raw = sourceRawSkus[idx]?.specName;
    if (raw) return normalizeName(raw);
    return normalizeName((s.specs ?? []).map((x) => x.value).join(''));
  });

  // 1) UPC 交集匹配(最强信号)
  for (let i = 0; i < sourceSkus.length; i++) {
    const srcUpcs = sourceUpcSets[i];
    if (srcUpcs.size === 0) continue;
    const tIdx = targetSkus.findIndex(
      (t, idx) => !usedTarget.has(idx) && hasIntersection(srcUpcs, t.upcs),
    );
    if (tIdx >= 0) {
      usedTarget.add(tIdx);
      result[i].target = targetSkus[tIdx];
    }
  }

  // 2) 规格名精确匹配(UPC 未命中时):跨账号 UPC 不一致但规格名一致是常态,
  //    按名称对齐才能把库存 / 价格写到正确的目标 SKU 上。
  for (let i = 0; i < sourceSkus.length; i++) {
    if (result[i].target) continue;
    const name = sourceSpecNames[i];
    if (!name) continue;
    const tIdx = targetSkus.findIndex(
      (t, idx) => !usedTarget.has(idx) && !!t.specName && t.specName === name,
    );
    if (tIdx >= 0) {
      usedTarget.add(tIdx);
      result[i].target = targetSkus[tIdx];
    }
  }

  // 3) 数量一致时,剩余未匹配的按顺序兜底对齐
  if (sourceSkus.length === targetSkus.length) {
    for (let i = 0; i < sourceSkus.length; i++) {
      if (result[i].target) continue;
      const tIdx = targetSkus.findIndex((_t, idx) => !usedTarget.has(idx));
      if (tIdx >= 0) {
        usedTarget.add(tIdx);
        result[i].target = targetSkus[tIdx];
      }
    }
  }

  return result;
}

function hasIntersection(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

/**
 * 解析一个源 SKU 要下发的分渠道价格:
 *   - 优先用导出包记录的门店分渠道零售价 channelPrices(来自 store/detail)
 *   - 没有 channelPrices 时,回退用建议售价 price,套用到默认渠道 100 / 200
 *   - 都拿不到有效价(>0)时返回空数组 → 调用方计入"跳过"
 */
function resolveChannelPrices(
  sku: ProductSpu['skus'][number],
): Array<{ channelId: number; fixedPrice: number }> {
  const out: Array<{ channelId: number; fixedPrice: number }> = [];
  const channelPrices = sku.channelPrices ?? [];
  if (channelPrices.length > 0) {
    for (const cp of channelPrices) {
      if (typeof cp.price === 'number' && cp.price > 0) {
        out.push({ channelId: cp.channelId, fixedPrice: cp.price });
      }
    }
    if (out.length > 0) return out;
  }
  const price = sku.price;
  if (typeof price === 'number' && price > 0) {
    return [
      { channelId: 100, fixedPrice: price },
      { channelId: 200, fixedPrice: price },
    ];
  }
  return [];
}

/** UPC 列表 → 去重、规整后的集合 */
function normalizeUpcSet(list?: Array<string | number | null | undefined>): Set<string> {
  const out = new Set<string>();
  for (const u of list ?? []) {
    const n = normalizeUpc(u);
    if (n) out.add(n);
  }
  return out;
}

/** 单个 UPC 规整:转字符串、trim、去掉内部空白 */
function normalizeUpc(u: string | number | null | undefined): string {
  if (u == null) return '';
  return String(u).trim().replace(/\s+/g, '');
}

/** 商品名 / 规格名归一化:去空白、统一小写(与 import 的 normalizeName 一致) */
function normalizeName(name: string): string {
  return (name ?? '').replace(/[\s\u3000]+/g, '').toLowerCase().trim();
}
