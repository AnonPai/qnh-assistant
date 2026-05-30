/**
 * 导入流程编排(per-product 串行版,源直接从用户选定目录读):
 *   1) 读目录的 manifest / categories / products / media
 *   2) 校验目标店「店内分类」(缺则一次性列出所有缺失项,直接终止,不上传任何图)
 *   3) 增量模式:拉目标店现有商品索引(UPC + 商品名)
 *   4) 单品在前、组合装在后,逐个商品执行:
 *        a) 增量模式按 UPC / 同名命中 → 跳过创建,仍写入 childSkuMap
 *        b) 解析目标"渠道类目"路径
 *        c) 仅上传当前商品引用到的图片(去重 + 跨商品复用)
 *        d) 调 CREATE_PRODUCT(店内分类 ID 用 remap 改写)
 *        e) 回查目标 SKU 映射,写入 childSkuMap 供后续组合装使用
 *   5) 视频不上传,导入结束后落一份补传清单 txt(直接写到源目录里)
 */

import { createLogger } from '@shared/logger';
import { bytesToBase64 } from '@shared/hash';
import { normalizeLegacyDetail } from '@shared/normalize-legacy-detail';
import { jitter, THROTTLE } from '@shared/sleep';
import { UrlHashCache, fetchUrlAsArrayBuffer } from '@shared/url-hash-cache';
import type {
  CategoryMapping,
  ExportManifest,
  ImportResultItem,
  ImportSummary,
  MediaAsset,
  ProductSpu,
} from '@shared/types';
import type {
  FrontCategoryNode,
  ImportConfirmMode,
  ImportMode,
  ProgressEvent,
  UploadedMedia,
} from '@shared/messaging';
import type { CallInjected } from './index';
import {
  findFileByPrefix,
  getSubdirOrNull,
  listFileNames,
  readFileBlob,
  readJsonFile,
  readTextFile,
  writeTextFile,
} from './fs-stage';

const log = createLogger('import');

/**
 * 解析"探针店":部分接口(创建商品 store/create、上传图片、商品列表/详情、店内分类树)
 * 必须带某个 storeId 上下文。导入流程语义上面向"租户主档",但底层接口仍要求 storeId,
 * 因此在导入开始时取当前账号下的第一家门店当探针即可。用户层不再需要选门店。
 */
async function resolveProbeShopId(
  callInjected: CallInjected,
): Promise<string | number> {
  const list = await callInjected<Array<{ shopId: string | number; shopName?: string }>>({
    type: 'FETCH_SHOP_LIST',
  });
  if (!list || list.length === 0) {
    throw new Error('当前账号下没有可用门店,无法导入');
  }
  return list[0].shopId;
}

/** 手动模式下,每个商品准备写入(create/update)前的确认决定 */
export type ConfirmDecision = 'confirm' | 'skip' | 'cancel-all';

/** 调用方提供的确认函数:在 UI 层弹一个确认框,返回用户选择 */
export type RequestConfirm = (info: {
  productName: string;
  productCurrent: number;
  productTotal: number;
  /** 'create' | 'update' — 让 UI 上提示"新建 / 修改" */
  action: 'create' | 'update';
}) => Promise<ConfirmDecision>;

interface RunImportArgs {
  /** 用户选定的导入源目录(由 inpage UI 通过 showDirectoryPicker 拿到) */
  sourceDir: FileSystemDirectoryHandle;
  mapping: CategoryMapping;
  /** 'full' = 全部导入(默认),'incremental' = 增量导入(已存在的跳过) */
  mode?: ImportMode;
  /** 'auto' = 自动跑;'manual' = 每个商品写入前等用户确认。默认 'auto'。 */
  confirmMode?: ImportConfirmMode;
  /**
   * 是否把图片同步到目标店(默认 true)。
   * 关闭后:不再上传源端图片,也不在 update 路径下载目标店图算 hash 比对。
   * 仍会把源端 `media://<hash>` 占位符替换成源端原始 CDN URL,
   * 这样 createProduct/updateProduct 不会触发"媒体未上传"报错路径,
   * 牵牛花后端会自行从该 URL 拉一份(等价于"图片直链同步")。
   */
  syncImages?: boolean;
  /**
   * 名称一致但 UPC 不一致时是否走"修改"。默认 false。
   * - false(默认):目标店已有同名商品但 UPC 对不上 → 跳过,不新建也不修改(避免误覆盖/建重复)
   * - true:把这种"仅同名命中"也当作已存在,走 update 路径(先比对,不一致才改)
   * 仅在全量模式下生效;增量模式同名一律跳过。
   */
  updateOnNameMatch?: boolean;
  /**
   * 可选:用户人工维护的「店内分类映射」文件(TSV)。
   * 检测到目标店分类与源端不齐时,把已自动匹配 + 缺失的清单写到源目录;
   * 用户编辑好后下次再传。文件格式见 docs(以 # 开头的为注释,空目标列视为未填)。
   */
  frontCategoryMappingFile?: File | null;
  /** 手动模式必须提供;UI 层弹确认框,返回用户决定 */
  requestConfirm?: RequestConfirm;
  cancelFlag: { cancelled: boolean };
  onProgress: (e: ProgressEvent) => void;
  callInjected: CallInjected;
}

export async function runImport({
  sourceDir,
  mapping,
  mode = 'full',
  confirmMode = 'auto',
  syncImages = true,
  updateOnNameMatch = false,
  frontCategoryMappingFile,
  requestConfirm,
  cancelFlag,
  onProgress,
  callInjected,
}: RunImportArgs) {
  const startedAt = new Date().toISOString();
  log.info(
    `开始导入,模式: ${mode},执行: ${confirmMode},图片同步: ${syncImages ? '是' : '否'},` +
      `同名异 UPC 修改: ${updateOnNameMatch ? '是' : '否'}`,
  );

  // 排查用:把整个导入过程的日志攒到内存里,结束时(成功 / 失败 / 取消 / 中断)都落一份
  // .log 到源目录根。popup UI 只保留最近 N 条 ring buffer,30k 商品时早期日志会被冲掉,
  // 出问题后这份完整落盘日志才是排查依据。
  const runLog: string[] = [];
  const recordLog = (level: string, text: string) => {
    const ts = new Date().toISOString();
    runLog.push(`[${ts}] [${level.toUpperCase()}] ${text}`);
  };
  const logFileName = buildImportLogFileName();
  recordLog('info', `开始导入 模式=${mode} 执行=${confirmMode} 图片同步=${syncImages ? '是' : '否'} 同名异UPC修改=${updateOnNameMatch ? '是' : '否'}`);

  if (confirmMode === 'manual' && !requestConfirm) {
    throw new Error('手动模式必须提供 requestConfirm');
  }

  // 商品级日志计数:每处理完一个商品(无论成功/失败/跳过/修改)就发一条 'log' 事件,
  // UI 端按 ring buffer 展示最近 N 条,避免 30k 商品撑爆 DOM。
  let logIndex = 0;
  const emitLog = (
    level: 'info' | 'success' | 'warn' | 'error',
    text: string,
  ) => {
    logIndex++;
    recordLog(level, text);
    onProgress({
      kind: 'log',
      level,
      index: logIndex,
      text,
    });
  };

  try {

  // ---- 探针店:仍有少数接口(创建商品、上传图片、查询商品列表/详情、店内分类树)
  // 必须带一个 storeId 上下文。导入面向"租户主档",但这些接口的语义是"以某门店身份调用",
  // 因此自动取当前账号下第一家门店做探针店即可。用户层面已经不需要选门店了。
  const probeShopId = await resolveProbeShopId(callInjected);
  log.info(`探针店:${probeShopId}(无需用户选择,默认取首家)`);
  recordLog('info', `探针店=${probeShopId}`);

  // ---- 1) 解析源目录 ----
  onProgress({ kind: 'import', phase: 'parse', current: 0, total: 1, message: '读取数据目录' });

  const manifest = await readJsonFile<ExportManifest>(sourceDir, 'manifest.json');
  if (!manifest) {
    throw new Error('manifest.json 缺失,目录可能不是完整的导出包(或导出未完成)');
  }
  log.info('manifest', manifest);

  const productsDir = await getSubdirOrNull(sourceDir, 'products');
  const mediaDir = await getSubdirOrNull(sourceDir, 'media');
  if (!productsDir) {
    throw new Error('products 子目录缺失,目录不是有效的导出包');
  }

  const products: ProductSpu[] = [];
  const productFileNames = await listFileNames(productsDir);
  // 先读全量,几千个 JSON 文件大约几十 MB 内存,完全可以一次性加载;
  // 比起 zip 路径 base64 + 解压双份内存,这条路反而轻量。
  for (const name of productFileNames) {
    if (!name.endsWith('.json')) continue;
    const text = await readTextFile(productsDir, name);
    if (!text) continue;
    try {
      const spu = JSON.parse(text) as ProductSpu;
      // 兼容历史导出包(早期 store/detail 形态)→ 归一成 tenant/detail 形态,
      // 后续创建 / 修改 / 比对统一按一种形态处理
      if (spu.raw?.detail) {
        (spu.raw as Record<string, unknown>).detail = normalizeLegacyDetail(spu.raw.detail);
      }
      products.push(spu);
    } catch (e) {
      log.warn(`解析商品文件失败,跳过: ${name}`, e);
    }
  }

  // hash → 原始 CDN URL 索引(从导出包的 media.json 来),
  // 用来把视频占位符还原成可下载 / 手工上传用的 URL 写进 txt。
  const mediaIndex = await loadMediaIndex(sourceDir);

  // 索引出所有用到的 media hash(从 raw 也提)—— 仅用于后续视频补传清单统计
  const usedHashes = collectMediaHashes(products);
  log.info(`商品 ${products.length} 个,引用媒体 ${usedHashes.size} 个`);
  recordLog('info', `源目录: ${sourceDir.name} · 商品 ${products.length} 个,引用媒体 ${usedHashes.size} 个`);

  // ---- 1.5) 校验目标租户的"店内分类"是否齐全(跨租户导入必走) ----
  // 用导出包里所有商品引用的店内分类 namePath,跟目标店的店内分类树匹配。
  // 缺失项处理:
  //   1) 如果用户提供了映射文件,先按文件里的"源 path → 目标 path"覆盖一遍;
  //   2) 仍有缺失 → 把"已自动匹配 + 缺失"的全量清单写到源目录,抛错让用户人工补齐
  onProgress({
    kind: 'import',
    phase: 'parse',
    current: 1,
    total: 1,
    message: '校验店内分类',
  });
  log.info('开始校验目标店「店内分类」…');
  const userOverrides = frontCategoryMappingFile
    ? await parseFrontCategoryMappingFile(frontCategoryMappingFile)
    : new Map<string, string>();
  if (userOverrides.size > 0) {
    log.info(`已加载用户分类映射:${userOverrides.size} 条`);
  }
  const { idRemap: frontCategoryIdRemap, pathRemap: frontCategoryPathRemap } =
    await validateFrontCategories(
      callInjected,
      products,
      probeShopId,
      userOverrides,
      sourceDir,
    );
  log.info(
    `店内分类映射就绪:ID ${Object.keys(frontCategoryIdRemap).length} 条,` +
      `路径改写 ${frontCategoryPathRemap.size} 条`,
    frontCategoryIdRemap,
  );
  recordLog(
    'info',
    `店内分类校验通过:ID 映射 ${Object.keys(frontCategoryIdRemap).length} 条,路径改写 ${frontCategoryPathRemap.size} 条`,
  );

  // ---- 2) 商品创建 / 修改(per-product) ----
  // 每个商品独立完成 [按 UPC 查目标店是否已有 → 上传它自己的图片 → 创建/修改] 的小回路。
  // 跨商品复用的图片(同 hash)走 mediaIdMap 缓存,只上传一次。
  const mediaIdMap: Record<string, UploadedMedia> = {}; // hash -> 上传结果(空 fileUrl 表示视频跳过)
  const skippedVideoHashes = new Set<string>();

  // URL → SHA-256 缓存:在"修改前对比"路径里把目标店里那张图的 URL 下载并算 hash,
  // 跟源端 `media://<hash>` 比对。同一店重复导入会反复命中同一组 URL,
  // 缓存落到源目录的 sidecar 文件,避免每次都重下。
  const urlHashCache = await UrlHashCache.load(sourceDir);

  // 组合装会引用子单品的 spuId/skuId,必须先建子再建父。
  // 数据模型只有两层(单品 / 组合装),按 raw.detail.skus[0].skuSaleType=2 简单分批。
  const isCombo = (p: ProductSpu) => {
    const d = p.raw?.detail as
      | { skus?: Array<{ skuSaleType?: number }>; isCompose?: number }
      | undefined;
    if (d?.isCompose === 1) return true;
    return (d?.skus ?? []).some((s) => s?.skuSaleType === 2);
  };
  const orderedProducts = [
    ...products.filter((p) => !isCombo(p)),
    ...products.filter((p) => isCombo(p)),
  ];
  // 源 sourceSpuId → 目标店 spu/sku 映射,父商品建之前会按这个改写 childSkuList
  const childSkuMap: Record<
    string,
    import('@shared/messaging').ChildSkuMapping
  > = {};

  const items: ImportResultItem[] = [];
  for (let i = 0; i < orderedProducts.length; i++) {
    if (cancelFlag.cancelled) break;
    const spu = orderedProducts[i];
    onProgress({
      kind: 'import',
      phase: 'product',
      current: i + 1,
      total: orderedProducts.length,
      message: spu.name,
      productCurrent: i + 1,
      productTotal: orderedProducts.length,
    });

    const startTs = Date.now();
    /**
     * 这个商品如果通过 UPC 命中目标店已有 SPU,把映射先存到外层,
     * 即便后续 update 自己失败,也得让依赖它的组合装父商品能拿到 targetSpuId,
     * 避免出现"子单品报错 → 父组合装也跟着崩"的连锁失败。
     */
    let matchedForFallback: { spuId: string | number; reason: string } | null = null;
    try {
      // (a) 按当前商品的 UPC 去目标店做一次精准存在性查询
      //   - 之前是预拉全店建索引(几千条 UPC + 名字),小批量导入时浪费严重
      //   - 现在只发一次 page-query-spu,带上当前商品的所有 UPC 做过滤
      const matched = await lookupExistingForProduct(
        callInjected,
        probeShopId,
        spu,
      );
      matchedForFallback = matched;

      if (matched && mode === 'incremental') {
        // 增量: 命中即跳过,只把映射写进去给组合装用
        log.info(`[增量] 跳过已存在: ${spu.name} → 目标 SPU ${matched.spuId}`);
        try {
          const skuMap = await buildSkuMapping(
            callInjected,
            spu,
            probeShopId,
            matched.spuId,
          );
          childSkuMap[String(spu.sourceSpuId)] = {
            targetSpuId: matched.spuId,
            skuMap,
          };
        } catch (e) {
          log.warn(`[增量] 回查目标 SKU 映射失败,组合装可能受影响: ${spu.name}`, e);
          childSkuMap[String(spu.sourceSpuId)] = {
            targetSpuId: matched.spuId,
            skuMap: {},
          };
        }
        items.push({
          sourceSpuId: spu.sourceSpuId,
          name: spu.name,
          status: 'skipped',
          targetSpuId: matched.spuId,
          errorMessage: `已存在(匹配方式: ${matched.reason})`,
          durationMs: Date.now() - startTs,
        });
        emitLog('info', `跳过 ${spu.name} · 已存在(${matched.reason})`);
        continue;
      }

      // 全量模式下,UPC 没命中但「商品名」命中:目标店已有同名商品。
      // 默认行为(updateOnNameMatch = false):不能走 update(没有可靠的 UPC 对应关系,
      // 贸然改会改错商品),也不能走 create(否则会建出重复的同名商品),直接跳过并提示。
      // 开启 updateOnNameMatch 后:把"仅同名命中"也当作已存在,继续往下走 update 路径
      // (后面 willUpdate 会接管,先比对、不一致才真正调 update)。
      if (matched && mode === 'full' && matched.reason === '同名' && !updateOnNameMatch) {
        log.warn(`[全量] 目标店已存在同名商品,跳过新建: ${spu.name} → 目标 SPU ${matched.spuId}`);
        try {
          const skuMap = await buildSkuMapping(
            callInjected,
            spu,
            probeShopId,
            matched.spuId,
          );
          childSkuMap[String(spu.sourceSpuId)] = {
            targetSpuId: matched.spuId,
            skuMap,
          };
        } catch (e) {
          log.warn(`回查目标 SKU 映射失败,组合装可能受影响: ${spu.name}`, e);
          childSkuMap[String(spu.sourceSpuId)] = {
            targetSpuId: matched.spuId,
            skuMap: {},
          };
        }
        items.push({
          sourceSpuId: spu.sourceSpuId,
          name: spu.name,
          status: 'skipped',
          targetSpuId: matched.spuId,
          errorMessage: '已存在相同名称商品(UPC 不一致,未新建)',
          durationMs: Date.now() - startTs,
        });
        emitLog('warn', `跳过 ${spu.name} · 已存在相同名称商品(UPC 不一致)`);
        continue;
      }

      // (b) 类目映射
      const targetCategoryPath = resolveCategoryPath(spu, mapping);
      if (!targetCategoryPath) {
        items.push({
          sourceSpuId: spu.sourceSpuId,
          name: spu.name,
          status: 'failed',
          errorMessage: `未映射的类目: ${spu.sourceCategoryNamePath.join('/')}`,
          durationMs: Date.now() - startTs,
        });
        emitLog('error', `失败 ${spu.name} · 未映射类目`);
        continue;
      }

      // 全量 + 命中已存在 → 走"修改"路径(走 update 接口)。
      //   - UPC 命中:一定走 update
      //   - 仅同名命中:只有开启 updateOnNameMatch 时才走 update(否则上面已 continue 跳过)
      // update body 里 picUrlList / picContentList / videoInfo / specialPictureList 都要写,
      // 与 create 一样会覆盖目标店现有图片字段。要让"源端图改了就改、没改就不动"
      // 这个语义成立,必须先上传源端图、再让 buildTenantSpuV2(update) 用源端 detail
      // 派生 picUrlList,跟 create 路径保持一致。
      const willUpdate =
        !!matched &&
        mode === 'full' &&
        (matched.reason.startsWith('UPC=') ||
          (matched.reason === '同名' && updateOnNameMatch));
      let targetDetailForUpdate: unknown;
      if (willUpdate && matched) {
        targetDetailForUpdate = await fetchTargetDetailForUpdate(
          callInjected,
          probeShopId,
          matched.spuId,
        );
        log.info(`[全量·修改] ${spu.name}: 已拉取目标 detail,准备调 update 接口`);

        // 修改前对比:除库存外,源端 / 目标端关键字段完全一致就直接跳过,不再调 update
        // 图片对比走"目标 URL 下载后算 SHA-256 → 跟源端 media://<hash> 比"的路径,
        // 命中过的 URL 落到 sidecar 缓存,避免重复导入时反复下载。
        // syncImages = false 时跳过图片比对,只比非图字段。
        if (
          await isProductSame(
            spu.raw?.detail as Record<string, unknown> | undefined,
            targetDetailForUpdate as Record<string, unknown>,
            {
              urlHashCache,
              sourceMediaDir: mediaDir,
              compareImages: syncImages,
              frontCategoryPathRemap,
            },
          )
        ) {
          log.info(`[全量·跳过] ${spu.name}: 与目标商品参数一致(库存除外),无需修改`);
          // childSkuMap 仍要写,组合装父商品引用得到目标 sku
          try {
            const skuMap = await buildSkuMapping(
              callInjected,
              spu,
              probeShopId,
              matched.spuId,
            );
            childSkuMap[String(spu.sourceSpuId)] = {
              targetSpuId: matched.spuId,
              skuMap,
            };
          } catch (e) {
            log.warn(`回查目标 SKU 映射失败,组合装可能受影响: ${spu.name}`, e);
            childSkuMap[String(spu.sourceSpuId)] = {
              targetSpuId: matched.spuId,
              skuMap: {},
            };
          }
          items.push({
            sourceSpuId: spu.sourceSpuId,
            name: spu.name,
            status: 'skipped',
            targetSpuId: matched.spuId,
            errorMessage: '参数一致(库存除外),无需修改',
            durationMs: Date.now() - startTs,
          });
          emitLog('info', `跳过 ${spu.name} · 参数与目标店一致(库存除外)`);
          continue;
        }
      }

      // (c) 上传图片 — create / update 都要,update body 也包含 picUrlList 等图片字段。
      // syncImages = false:跳过实际上传,直接把 mediaIdMap 填上"源端原始 CDN URL",
      // createProduct/updateProduct 仍能把 media://hash 替换成可用的 URL,
      // 后端会自行从该 URL 抓一份(等价于"图片直链同步")。
      if (syncImages) {
        await uploadMediaForProduct({
          spu,
          mediaDir,
          targetShopId: probeShopId,
          mediaIdMap,
          skippedVideoHashes,
          urlHashCache,
          onProgress,
          cancelFlag,
          callInjected,
          productIndex: i + 1,
          productTotal: orderedProducts.length,
        });
      } else {
        fillMediaIdMapWithSourceUrls({
          spu,
          mediaIndex,
          mediaIdMap,
          skippedVideoHashes,
        });
      }

      // (c.5) 手动模式 — 写入前等用户点确认
      if (confirmMode === 'manual' && requestConfirm) {
        const decision = await requestConfirm({
          productName: spu.name,
          productCurrent: i + 1,
          productTotal: orderedProducts.length,
          action: willUpdate ? 'update' : 'create',
        });
        if (decision === 'cancel-all') {
          cancelFlag.cancelled = true;
          emitLog('warn', `用户取消整批导入(在 ${spu.name} 之前)`);
          break;
        }
        if (decision === 'skip') {
          items.push({
            sourceSpuId: spu.sourceSpuId,
            name: spu.name,
            status: 'skipped',
            errorMessage: '用户手动跳过',
            durationMs: Date.now() - startTs,
          });
          emitLog('info', `跳过 ${spu.name} · 用户手动跳过`);
          continue;
        }
      }

      // (d) 创建 / 修改商品
      let targetSpuId: string | number;
      let resultStatus: ImportResultItem['status'];
      if (willUpdate && matched) {
        targetSpuId = await callInjected<string | number>({
          type: 'UPDATE_PRODUCT',
          payload: {
            product: spu,
            mediaIdMap,
            targetSpuId: matched.spuId,
            targetDetail: targetDetailForUpdate,
            // 组合装父商品 update 时,childSkuList 仍要按子商品的目标 spu/sku 改写,
            // 跟 create 路径一样得透传 childSkuMap
            childSkuMap,
            frontCategoryIdRemap,
          },
        });
        resultStatus = 'updated';
      } else {
        targetSpuId = await callInjected<string | number>({
          type: 'CREATE_PRODUCT',
          payload: {
            shopId: probeShopId,
            product: spu,
            mediaIdMap,
            targetCategoryPath,
            childSkuMap,
            frontCategoryIdRemap,
          },
        });
        resultStatus = 'success';
      }

      // (e) 回查目标 sku 映射,供后续组合装父商品使用
      try {
        const skuMap = await buildSkuMapping(callInjected, spu, probeShopId, targetSpuId);
        childSkuMap[String(spu.sourceSpuId)] = { targetSpuId, skuMap };
      } catch (e) {
        log.warn(`回查目标 SKU 映射失败,后续组合装可能创建失败: ${spu.name}`, e);
        childSkuMap[String(spu.sourceSpuId)] = { targetSpuId, skuMap: {} };
      }

      items.push({
        sourceSpuId: spu.sourceSpuId,
        name: spu.name,
        status: resultStatus,
        targetSpuId,
        durationMs: Date.now() - startTs,
      });
      emitLog(
        'success',
        `${resultStatus === 'updated' ? '修改' : '新建'} ${spu.name} · 目标 SPU ${targetSpuId}`,
      );
    } catch (e) {
      const msg = (e as Error).message;
      log.error(`商品处理失败: ${spu.name} (sourceSpuId=${spu.sourceSpuId})`, e);
      // 失败兜底:虽然这个商品本身没建/改成功,但如果它在目标店已经存在(UPC 命中),
      // 还是把目标 SPU 记到 childSkuMap,让依赖它的组合装继续跑。
      // 没有 skuMap 时 buildTenantSkuV2 里的 childSkuList 改写会按位用源 skuId 兜底,
      // 大多数单品场景(skuId 单一)这能让组合装顺利建成。
      if (matchedForFallback && !childSkuMap[String(spu.sourceSpuId)]) {
        try {
          const skuMap = await buildSkuMapping(
            callInjected,
            spu,
            probeShopId,
            matchedForFallback.spuId,
          );
          childSkuMap[String(spu.sourceSpuId)] = {
            targetSpuId: matchedForFallback.spuId,
            skuMap,
          };
        } catch {
          childSkuMap[String(spu.sourceSpuId)] = {
            targetSpuId: matchedForFallback.spuId,
            skuMap: {},
          };
        }
      }
      items.push({
        sourceSpuId: spu.sourceSpuId,
        name: spu.name,
        status: 'failed',
        errorMessage: msg,
        durationMs: Date.now() - startTs,
      });
      emitLog('error', `失败 ${spu.name} · ${msg}`);
    }
    // 每个商品创建/修改后串行限速,加大窗口避开风控(写入接口比读敏感得多)
    await jitter(...THROTTLE.IMPORT_PRODUCT);
  }
  // 把"修改前对比"路径下载并算过 hash 的 URL 落到源目录的 sidecar 缓存,
  // 下次重复导入直接命中,免下载。
  await urlHashCache.flush(sourceDir);
  if (skippedVideoHashes.size > 0) {
    log.warn(`本次共跳过 ${skippedVideoHashes.size} 个视频文件,需后续手动补传`);
  }

  // ---- 5) 视频手动补传清单 ----
  // 当前实现不支持自动上传视频,但每个成功创建的商品都把源视频 URL 落进一份 txt,
  // 让运营可以一对一手动补传。这里列出所有被收集到的视频(无论是否在 mediaIdMap 中跳过),
  // 因为 mediaIdMap 只在我们尝试上传后才会写,而源视频 URL 主要来自导出包 media.json。
  const videoEntries = collectVideoMappingEntries(products, items, mediaIndex);
  let videoMappingFileName: string | undefined;
  if (videoEntries.length > 0) {
    const text = renderVideoMappingTxt({
      shopId: probeShopId,
      manifest,
      entries: videoEntries,
      generatedAt: new Date().toISOString(),
    });
    videoMappingFileName = buildVideoMappingFileName(probeShopId);
    try {
      await triggerTxtDownload(sourceDir, text, videoMappingFileName);
      log.info(`视频补传清单已写入: ${videoMappingFileName}(共 ${videoEntries.length} 条)`);
    } catch (e) {
      log.warn('视频补传清单下载失败,可在控制台导出:', e);
      // 退化:把全文打到 console,运营至少能复制出来
      console.log(`[QNH:import] 视频补传清单(下载失败,fallback 到 console)\n${text}`);
      videoMappingFileName = undefined;
    }
  }

  const summary: ImportSummary = {
    total: orderedProducts.length,
    succeeded: items.filter((x) => x.status === 'success').length,
    updated: items.filter((x) => x.status === 'updated').length,
    failed: items.filter((x) => x.status === 'failed').length,
    skipped: items.filter((x) => x.status === 'skipped').length,
    startedAt,
    finishedAt: new Date().toISOString(),
    items,
    videoMappingFileName,
    videoMappingCount: videoEntries.length || undefined,
    logFileName,
  };
  recordLog(
    'info',
    `导入结束 共${summary.total} 新建${summary.succeeded} 修改${summary.updated} ` +
      `跳过${summary.skipped} 失败${summary.failed}${cancelFlag.cancelled ? ' (已取消)' : ''}`,
  );
  // 逐条商品结果也落进日志,排查时能精确定位每个商品的归宿
  for (const it of items) {
    recordLog(
      it.status === 'failed' ? 'error' : 'detail',
      `· ${it.status} | ${it.name} | sourceSpuId=${it.sourceSpuId}` +
        (it.targetSpuId != null ? ` → targetSpuId=${it.targetSpuId}` : '') +
        (it.errorMessage ? ` | ${it.errorMessage}` : ''),
    );
  }
  await flushRunLog(sourceDir, logFileName, runLog);
  onProgress({ kind: 'done', result: summary });

  } catch (e) {
    // 主流程异常(如店内分类缺失而提前终止):把已攒下的日志连同错误一并落盘,
    // 这正是最需要排查的场景。落盘失败不掩盖原始错误。
    recordLog('error', `导入流程异常终止: ${(e as Error).message}`);
    try {
      await flushRunLog(sourceDir, logFileName, runLog);
    } catch (writeErr) {
      log.warn('导入日志落盘失败', writeErr);
    }
    throw e;
  }
}

/** 排查日志文件名:qnh-import-<时间戳>.log */
function buildImportLogFileName(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return `qnh-import-${ts}.log`;
}

/** 把内存里攒的导入日志写到源目录根,失败只告警不影响主流程 */
async function flushRunLog(
  dir: FileSystemDirectoryHandle,
  fileName: string,
  lines: string[],
): Promise<void> {
  try {
    // 加 BOM,Windows 记事本打开 UTF-8 中文不乱码
    await writeTextFile(dir, fileName, '\uFEFF' + lines.join('\r\n') + '\r\n');
    log.info(`导入日志已写入: ${fileName}(共 ${lines.length} 行)`);
  } catch (e) {
    log.warn('导入日志落盘失败', e);
  }
}

/** 收集 spu 中所有 media://${hash} 引用 */
function collectMediaHashes(products: ProductSpu[]): Set<string> {
  const re = /media:\/\/([a-f0-9]{64})/g;
  const set = new Set<string>();
  const visit = (node: unknown) => {
    if (typeof node === 'string') {
      let m: RegExpExecArray | null;
      while ((m = re.exec(node))) set.add(m[1]);
    } else if (Array.isArray(node)) node.forEach(visit);
    else if (node && typeof node === 'object') Object.values(node as object).forEach(visit);
  };
  visit(products);
  return set;
}

function guessMimeFromName(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return (
    {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp',
      gif: 'image/gif',
      mp4: 'video/mp4',
      mov: 'video/quicktime',
      webm: 'video/webm',
    }[ext] ?? 'application/octet-stream'
  );
}

/**
 * 决定目标类目路径:
 *   1. 如果用户提供了显式 mapping,优先用 mapping
 *   2. 否则默认 "源类目即目标类目"(同租户跨门店复制商品的最常见场景)
 *      —— 直接复用 spu.sourceCategoryPath,这就是导出时从
 *      raw.detail.spuChannelInfoList[].categoryCodePath 取出来的
 *   3. 兜底:仍然返回 null,表示无法决定
 */
function resolveCategoryPath(
  spu: ProductSpu,
  mapping: CategoryMapping,
): Array<string | number> | null {
  const key = spu.sourceCategoryNamePath.join('/');
  const hit = mapping[key];
  if (hit) return hit.targetCategoryPath;
  // 默认沿用源类目;sourceCategoryPath 由导出端从 categoryCodePath 解析得来
  if (spu.sourceCategoryPath && spu.sourceCategoryPath.length > 0) {
    return spu.sourceCategoryPath;
  }
  return null;
}

/**
 * 商品创建成功后,回查目标店里这个 SPU 的详情,
 * 建立 "源 skuId → 目标 skuId" 映射,供后续依赖它的组合装使用。
 *
 * 对齐策略:按 skus 数组顺序对齐(顺序与 create body 的 skus[] 一致)。
 * 若长度不一致退化成空映射,childSkuList 改写时 skuId 用源值兜底。
 */
async function buildSkuMapping(
  callInjected: import('./index').CallInjected,
  sourceSpu: ProductSpu,
  targetShopId: string | number,
  targetSpuId: string | number,
): Promise<Record<string, string | number>> {
  const detail = await callInjected<{
    raw?: {
      detail?: { skus?: Array<{ skuId?: string | number }> };
    };
  }>({
    type: 'FETCH_PRODUCT_DETAIL',
    payload: { shopId: targetShopId, spuId: targetSpuId },
  });

  const targetSkus = detail?.raw?.detail?.skus ?? [];
  const sourceDetail = sourceSpu.raw?.detail as
    | { skus?: Array<{ skuId?: string | number }> }
    | undefined;
  const sourceSkus = sourceDetail?.skus ?? [];

  const map: Record<string, string | number> = {};
  if (targetSkus.length !== sourceSkus.length) {
    log.warn(
      `目标 SKU 数 ${targetSkus.length} ≠ 源 SKU 数 ${sourceSkus.length},按位对齐可能错位`,
    );
  }
  const n = Math.min(targetSkus.length, sourceSkus.length);
  for (let i = 0; i < n; i++) {
    const src = sourceSkus[i]?.skuId;
    const dst = targetSkus[i]?.skuId;
    if (src != null && dst != null) {
      map[String(src)] = dst;
    }
  }
  return map;
}

/**
 * 店内分类校验产物:
 *   - idRemap:源「店内分类」ID → 目标租户「店内分类」ID,createProduct/updateProduct 用它改写
 *   - pathRemap:源「店内分类」namePath → 目标「店内分类」namePath。
 *     仅当映射到"不同名"的目标分类时才有意义;`isProductSame` 用它把源快照的
 *     店内分类翻译成目标侧的预期值,避免"映射后每次都误判为已修改"。
 */
interface FrontCategoryResolveResult {
  idRemap: Record<string, string>;
  pathRemap: Map<string, string>;
}

/**
 * 跨租户导入前的"店内分类"校验:
 *   - 收集导出包里所有商品引用到的店内分类(name path + 源 ID)
 *   - 拉一次目标租户的店内分类树
 *   - 优先按完整名称路径(如 "饮料饮品/功能饮料")在目标树里直接匹配
 *   - 仍找不到的,看用户提供的映射文件里有没有"源 path → 目标 path"的覆盖
 *   - 任何一个最终找不到 → 把"已自动匹配 + 缺失"的清单写到源目录,
 *     抛错让用户编辑后下次重传(不上传任何图,流程在这里就终止)
 *   - 全部命中 → 返回"源 ID → 目标 ID" + "源 path → 目标 path"两张映射表
 *
 * 这样可以避免"开始上传媒体之后才发现分类不存在"的尴尬。
 */
async function validateFrontCategories(
  callInjected: CallInjected,
  products: ProductSpu[],
  targetShopId: string | number,
  userOverrides: Map<string, string>,
  sourceDir: FileSystemDirectoryHandle,
): Promise<FrontCategoryResolveResult> {
  // 1) 收集源端用到的店内分类 (name path → 源 ID 集合)
  type SourceRef = { sourceId: string; namePath: string[] };
  const refs: SourceRef[] = [];
  for (const p of products) {
    const detail = p.raw?.detail as
      | {
          storeFrontCategoryList?: Array<{
            storeCategoryList?: Array<{
              categoryCode?: string;
              namePath?: string;
              name?: string;
            }>;
          }>;
        }
      | undefined;
    for (const group of detail?.storeFrontCategoryList ?? []) {
      for (const c of group.storeCategoryList ?? []) {
        if (!c?.categoryCode) continue;
        const namePath = (c.namePath ?? '').split('>').filter(Boolean);
        if (namePath.length === 0 && c.name) namePath.push(c.name);
        if (namePath.length === 0) continue;
        refs.push({ sourceId: String(c.categoryCode), namePath });
      }
    }
  }
  if (refs.length === 0) return { idRemap: {}, pathRemap: new Map() };

  // 2) 拉目标店内分类树
  let tree: FrontCategoryNode[];
  try {
    tree = await callInjected<FrontCategoryNode[]>({
      type: 'FETCH_FRONT_CATEGORY_TREE',
      payload: { shopId: targetShopId },
    });
  } catch (e) {
    throw new Error(`无法获取目标店「店内分类」: ${(e as Error).message}`);
  }

  // 3) 按 name path 索引:Map<"a/b/c", FrontCategoryNode>
  const byPath = new Map<string, FrontCategoryNode>();
  const walk = (nodes: FrontCategoryNode[], parentPath: string[]) => {
    for (const n of nodes) {
      const path = [...parentPath, n.name];
      byPath.set(path.join('/'), n);
      if (n.children?.length) walk(n.children, path);
    }
  };
  walk(tree, []);

  // 4) 解析每个源 path:同名匹配优先,失败再查用户映射文件,再失败计入缺失
  type ResolveResult =
    | { status: 'auto'; targetPath: string; targetId: string }
    | { status: 'mapped'; targetPath: string; targetId: string }
    | { status: 'mapped-missing'; mappedTo: string }
    | { status: 'missing' };

  const resolveOne = (sourcePath: string): ResolveResult => {
    const auto = byPath.get(sourcePath);
    if (auto) return { status: 'auto', targetPath: sourcePath, targetId: auto.categoryId };
    const mappedTo = userOverrides.get(sourcePath);
    if (mappedTo) {
      const mapped = byPath.get(mappedTo);
      if (mapped) return { status: 'mapped', targetPath: mappedTo, targetId: mapped.categoryId };
      return { status: 'mapped-missing', mappedTo };
    }
    return { status: 'missing' };
  };

  // 4.1) 同一 namePath 可能对应多个源 ID(不同店重复用),只解一次
  const resolved = new Map<string, ResolveResult>();
  for (const r of refs) {
    const key = r.namePath.join('/');
    if (!resolved.has(key)) resolved.set(key, resolveOne(key));
  }

  // 5) 按解析结果分桶
  const remap: Record<string, string> = {};
  // 源 namePath → 目标 namePath,仅在"映射到不同名分类"时记录;
  // 同名自动匹配(auto)源/目标一致,无需记入(记了也不影响,只是冗余)。
  const pathRemap = new Map<string, string>();
  const autoMatched: string[] = [];
  const userMapped: Array<{ source: string; target: string }> = [];
  const missing: string[] = []; // 用户没填或填错的源 path
  const mappedMissing: Array<{ source: string; mappedTo: string }> = []; // 用户填了但目标店不存在
  for (const [key, res] of resolved) {
    if (res.status === 'auto') autoMatched.push(key);
    else if (res.status === 'mapped') {
      userMapped.push({ source: key, target: res.targetPath });
      if (res.targetPath !== key) pathRemap.set(key, res.targetPath);
    } else if (res.status === 'mapped-missing') mappedMissing.push({ source: key, mappedTo: res.mappedTo });
    else missing.push(key);
  }

  for (const r of refs) {
    const key = r.namePath.join('/');
    const res = resolved.get(key)!;
    if (res.status === 'auto' || res.status === 'mapped') {
      remap[r.sourceId] = res.targetId;
    }
  }

  if (missing.length === 0 && mappedMissing.length === 0) {
    log.info(
      `店内分类校验通过:${refs.length} 处引用 → 自动匹配 ${autoMatched.length},用户映射 ${userMapped.length}`,
    );
    return { idRemap: remap, pathRemap };
  }

  // 6) 还有缺失 → 写一份完整模板回源目录,抛错指导用户修复
  const fileName = 'front-category-mapping.txt';
  const text = renderFrontCategoryMappingTemplate({
    autoMatched,
    userMapped,
    missing,
    mappedMissing,
    targetPaths: [...byPath.keys()].sort(),
  });
  try {
    await writeTextFile(sourceDir, fileName, '\uFEFF' + text);
    log.warn(`已写入分类映射模板: ${fileName}`);
  } catch (e) {
    log.warn('写入分类映射模板失败', e);
  }

  const lines: string[] = [];
  const totalMissing = missing.length + mappedMissing.length;
  // 浏览器 File System Access API 不暴露目录的硬盘绝对路径,
  // 只能给到"目录名 / 文件名",用户对照打开即可。
  const relPath = `${sourceDir.name}/${fileName}`;
  lines.push(`目标店缺少 ${totalMissing} 项店内分类,请在 ${relPath} 里维护后重新导入。`);
  throw new Error(lines.join('\n'));
}

/**
 * 解析用户的店内分类映射文件:
 *   - 行格式:`源 namePath==>目标 namePath`
 *   - 以 # 开头的行 / 空行 / 目标 namePath 为空 都视为未填
 *
 * 返回 Map<源 path, 目标 path>。
 */
async function parseFrontCategoryMappingFile(file: File): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const text = await file.text();
  // 兼容 BOM 与各种换行
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('==>');
    if (idx < 0) continue;
    const src = line.slice(0, idx).trim();
    const dst = line.slice(idx + 3).trim();
    if (!src || !dst) continue;
    out.set(src, dst);
  }
  return out;
}

/**
 * 生成"店内分类映射模板":
 *   - 让用户能一眼看到哪些已经自动匹配 / 已经按映射文件命中 / 仍待填
 *   - 缺失项的目标列默认为空,等用户填
 *   - 末尾附一份"目标店现有分类树"列表,方便 copy-paste
 */
function renderFrontCategoryMappingTemplate(args: {
  autoMatched: string[];
  userMapped: Array<{ source: string; target: string }>;
  missing: string[];
  mappedMissing: Array<{ source: string; mappedTo: string }>;
  targetPaths: string[];
}): string {
  const lines: string[] = [];
  lines.push('# 店内分类映射文件');
  lines.push('# 生成时间: ' + new Date().toISOString());
  lines.push('# 格式:每行一条映射,用 ==> 分隔。第一列=源 namePath,第二列=目标 namePath。');
  lines.push('#       目标 namePath 留空 / 不写 / 此行以 # 开头  →  视为未维护。');
  lines.push('#       一级与子级之间用 / 分隔,例如 "饮料饮品/功能饮料"。');
  lines.push('#');
  lines.push('# 示例:');
  lines.push('#   3C/数码/数码配件==>3C数码/手机配件');
  lines.push('#   饮料饮品/功能饮料==>饮料/功能饮料');
  lines.push('#');
  lines.push('# 修改完后,在导入选项里通过"附带映射文件"再次发起导入即可。');
  lines.push('');

  if (args.missing.length > 0) {
    lines.push('# ===== 待维护 (' + args.missing.length + ') —— 请把目标 namePath 填到 ==> 右侧 =====');
    for (const p of [...args.missing].sort()) {
      lines.push(`${p}==>`);
    }
    lines.push('');
  }
  if (args.mappedMissing.length > 0) {
    lines.push(
      '# ===== 映射目标在目标店不存在 (' + args.mappedMissing.length + ') —— 请改成存在的 namePath =====',
    );
    for (const m of args.mappedMissing) {
      lines.push(`${m.source}==>${m.mappedTo}`);
    }
    lines.push('');
  }
  if (args.userMapped.length > 0) {
    lines.push('# ===== 已按当前映射文件命中 (' + args.userMapped.length + ') =====');
    for (const m of args.userMapped) {
      lines.push(`${m.source}==>${m.target}`);
    }
    lines.push('');
  }
  if (args.autoMatched.length > 0) {
    lines.push('# ===== 同名自动匹配 (' + args.autoMatched.length + ') —— 不需要改,不再列出 =====');
    lines.push('');
  }

  lines.push('# ===== 目标店现有分类树 (供 copy-paste) =====');
  for (const p of args.targetPaths) {
    lines.push('#   ' + p);
  }
  lines.push('');
  return lines.join('\n');
}


/**
 * 仅上传当前商品引用到的图片(视频跳过,留给后续清单导出):
 *   - mediaIdMap 跨商品共享,同一 hash 只上传一次。
 *   - 出错抛异常,由调用方落到 items 里标记为 failed,后续商品继续。
 */
async function uploadMediaForProduct(args: {
  spu: ProductSpu;
  mediaDir: FileSystemDirectoryHandle | null;
  targetShopId: string | number;
  mediaIdMap: Record<string, UploadedMedia>;
  skippedVideoHashes: Set<string>;
  /**
   * 可选:URL→hash 缓存。上传成功后顺手把"源图 hash ≡ 目标店重编码后 hash"登记进去,
   * 让后续(及下次)的"修改前对比"不再因美团服务端重编码而永远误判"已修改"。
   */
  urlHashCache?: UrlHashCache;
  onProgress: (e: ProgressEvent) => void;
  cancelFlag: { cancelled: boolean };
  callInjected: CallInjected;
  productIndex: number;
  productTotal: number;
}): Promise<void> {
  const {
    spu,
    mediaDir,
    targetShopId,
    mediaIdMap,
    skippedVideoHashes,
    urlHashCache,
    onProgress,
    cancelFlag,
    callInjected,
    productIndex,
    productTotal,
  } = args;

  // 找出 spu 内所有 media://hash 引用,但去掉已经在 mediaIdMap 里的(跨商品复用)
  const hashes = new Set<string>();
  const re = /media:\/\/([a-f0-9]{64})/g;
  const visit = (node: unknown) => {
    if (typeof node === 'string') {
      let m: RegExpExecArray | null;
      re.lastIndex = 0;
      while ((m = re.exec(node))) hashes.add(m[1]);
    } else if (Array.isArray(node)) node.forEach(visit);
    else if (node && typeof node === 'object') Object.values(node as object).forEach(visit);
  };
  visit(spu);

  const pending: string[] = [];
  for (const h of hashes) {
    if (mediaIdMap[h]) continue; // 之前的商品已经传过(或视频已跳过),复用即可
    pending.push(h);
  }
  if (pending.length === 0) return;

  if (!mediaDir) {
    log.warn(`没有 media 子目录,该商品的 ${pending.length} 个媒体引用无文件可读`);
    for (const h of pending) mediaIdMap[h] = { fileUrl: '' };
    return;
  }

  for (let j = 0; j < pending.length; j++) {
    if (cancelFlag.cancelled) throw new Error('已取消');
    const hash = pending[j];
    onProgress({
      kind: 'import',
      phase: 'media',
      current: j + 1,
      total: pending.length,
      message: `${spu.name} · 第 ${j + 1}/${pending.length} 张`,
      productCurrent: productIndex,
      productTotal,
    });

    const fileName = await findFileByPrefix(mediaDir, hash);
    if (!fileName) {
      log.warn('媒体文件缺失', hash);
      continue;
    }
    const file = await readFileBlob(mediaDir, fileName);
    if (!file) {
      log.warn('媒体文件读取失败', hash);
      continue;
    }
    const mime = file.type || guessMimeFromName(fileName);
    const kind: MediaAsset['kind'] = mime.startsWith('video') ? 'video' : 'image';
    if (kind === 'video') {
      // 视频暂不上传,占位 fileUrl 设为空,createProduct 会清空对应字段
      skippedVideoHashes.add(hash);
      mediaIdMap[hash] = { fileUrl: '' };
      continue;
    }

    const buf = await file.arrayBuffer();
    const uploaded = await callInjected<UploadedMedia>({
      type: 'UPLOAD_MEDIA',
      payload: { shopId: targetShopId, kind, mime, bytesBase64: bytesToBase64(buf) },
    });
    mediaIdMap[hash] = uploaded;

    // 登记"源图 hash ≡ 目标店重编码后 hash"等价关系:
    // 美团对上传图做服务端重编码,目标 URL 下载回来的字节 hash 跟源文件必然不同,
    // 不记下来的话,"修改前对比"里这张图永远对不上 → 每次都误判"已修改"。
    // 下载目标 URL 的开销复用 urlHashCache(对比阶段本来也要下),命中即免重下。
    if (urlHashCache && uploaded.fileUrl) {
      try {
        const targetHash = await urlHashCache.getOrCompute(
          uploaded.fileUrl,
          fetchUrlAsArrayBuffer,
        );
        urlHashCache.recordUploadEquiv(hash, targetHash);
      } catch (e) {
        // 算目标 hash 失败不致命:大不了这张图这次仍走 update,下次再补
        log.warn(`登记上传等价失败(忽略): ${hash} → ${uploaded.fileUrl}`, e);
      }
    }
    // 单张图上传之间留 ~0.5s,降低连发被风控的概率
    await jitter(...THROTTLE.IMPORT_MEDIA_UPLOAD);
  }
}

/**
 * "不同步图片"模式下走这条路:不上传任何文件,直接把 mediaIdMap 填上源端原始 CDN URL,
 * createProduct/updateProduct 内的 `media://hash` 占位会被替换成可访问的 URL,
 * 牵牛花后端会自行从该 URL 拉取图片(等价"图片直链同步")。
 *
 *   - 视频依旧不上传(同 uploadMediaForProduct 行为),但记录到 skippedVideoHashes,
 *     方便最终生成视频补传清单。
 *   - 在 media.json 里查不到的 hash 退化为空 fileUrl(下游会清空对应字段),
 *     至少不会触发 "媒体未上传" 的硬错误。
 */
function fillMediaIdMapWithSourceUrls(args: {
  spu: ProductSpu;
  mediaIndex: Map<string, MediaAsset>;
  mediaIdMap: Record<string, UploadedMedia>;
  skippedVideoHashes: Set<string>;
}): void {
  const { spu, mediaIndex, mediaIdMap, skippedVideoHashes } = args;
  const hashes = new Set<string>();
  const re = /media:\/\/([a-f0-9]{64})/g;
  const visit = (node: unknown) => {
    if (typeof node === 'string') {
      let m: RegExpExecArray | null;
      re.lastIndex = 0;
      while ((m = re.exec(node))) hashes.add(m[1]);
    } else if (Array.isArray(node)) node.forEach(visit);
    else if (node && typeof node === 'object') Object.values(node as object).forEach(visit);
  };
  visit(spu);
  for (const h of hashes) {
    if (mediaIdMap[h]) continue;
    const asset = mediaIndex.get(h);
    if (!asset) {
      // media.json 里没记 → 没法给 URL,只能空串(占位会被清空,字段缺图)
      mediaIdMap[h] = { fileUrl: '' };
      continue;
    }
    if (asset.kind === 'video') {
      skippedVideoHashes.add(h);
      mediaIdMap[h] = { fileUrl: '' };
      continue;
    }
    if (!asset.sourceUrl) {
      mediaIdMap[h] = { fileUrl: '' };
      continue;
    }
    // 直链同步:fileUrl 与 originFileUrl 都用源端原始 URL
    mediaIdMap[h] = { fileUrl: asset.sourceUrl, originFileUrl: asset.sourceUrl };
  }
}


async function loadMediaIndex(
  sourceDir: FileSystemDirectoryHandle,
): Promise<Map<string, MediaAsset>> {
  const out = new Map<string, MediaAsset>();
  const arr = await readJsonFile<MediaAsset[]>(sourceDir, 'media.json');
  if (!arr) return out;
  try {
    for (const a of arr) {
      if (a?.hash) out.set(a.hash, a);
    }
  } catch (e) {
    log.warn('media.json 内容异常,视频补传清单 URL 将留空', e);
  }
  return out;
}

/** 视频补传清单的一条记录 */
interface VideoMappingEntry {
  /** 目标店里新建的 SPU id;失败时为 null */
  targetSpuId: string | number | null;
  sourceSpuId: string | number;
  productName: string;
  /** 该商品引用到的视频 URL 列表(去重) */
  videoUrls: string[];
  status: ImportResultItem['status'];
}

/**
 * 把每个商品的视频引用提取出来:
 *   - 视频引用主要来自 spu.videoHashes(导出阶段已替换成 media://${hash}),
 *     兜底再扫 raw.detail 里的 videoUrl/videoInfo 字段以防万一。
 *   - 通过 mediaIndex 把 hash 还原回原始 CDN URL。
 *   - 没有视频引用的商品直接跳过。
 */
function collectVideoMappingEntries(
  products: ProductSpu[],
  items: ImportResultItem[],
  mediaIndex: Map<string, MediaAsset>,
): VideoMappingEntry[] {
  const itemBySource = new Map<string, ImportResultItem>();
  for (const it of items) itemBySource.set(String(it.sourceSpuId), it);

  const out: VideoMappingEntry[] = [];
  const hashRe = /media:\/\/([a-f0-9]{64})/g;
  for (const p of products) {
    const hashes = new Set<string>();
    // 主入口:顶层 videoHashes(导出端已用 media:// 占位)
    for (const v of p.videoHashes ?? []) {
      const m = /media:\/\/([a-f0-9]{64})/.exec(v ?? '');
      if (m) hashes.add(m[1]);
    }
    // 兜底:扫 raw.detail.videoInfo 里的 videoUrl
    const detail = p.raw?.detail as
      | {
          videoInfo?: { videoUrl?: string } | null;
        }
      | undefined;
    for (const v of [detail?.videoInfo?.videoUrl]) {
      if (typeof v !== 'string') continue;
      let m: RegExpExecArray | null;
      hashRe.lastIndex = 0;
      while ((m = hashRe.exec(v))) hashes.add(m[1]);
    }
    if (hashes.size === 0) continue;

    // 只保留确认是视频类型的(图片混入也兜底排除一下)
    const videoUrls: string[] = [];
    const seenUrl = new Set<string>();
    for (const h of hashes) {
      const asset = mediaIndex.get(h);
      if (asset && asset.kind !== 'video') continue;
      const url = asset?.sourceUrl ?? `(未知 URL,hash=${h})`;
      if (seenUrl.has(url)) continue;
      seenUrl.add(url);
      videoUrls.push(url);
    }
    if (videoUrls.length === 0) continue;

    const it = itemBySource.get(String(p.sourceSpuId));
    out.push({
      targetSpuId: it?.status === 'success' ? it.targetSpuId ?? null : null,
      sourceSpuId: p.sourceSpuId,
      productName: p.name,
      videoUrls,
      status: it?.status ?? 'skipped',
    });
  }
  return out;
}

/** 渲染补传清单 txt(纯文本,Tab 分列,UTF-8) */
function renderVideoMappingTxt(args: {
  shopId: string | number;
  manifest: ExportManifest;
  entries: VideoMappingEntry[];
  generatedAt: string;
}): string {
  const { shopId, manifest, entries, generatedAt } = args;
  const lines: string[] = [];
  lines.push('# QNH 视频补传清单');
  lines.push(`# 生成时间: ${generatedAt}`);
  lines.push(`# 目标门店 ID: ${shopId}`);
  lines.push(
    `# 数据来源: ${manifest.source.shopName ?? ''} (shopId=${manifest.source.shopId ?? ''})`,
  );
  lines.push(
    '# 列: 状态\t目标SPU\t源SPU\t商品名\t视频源URL(同一商品多条视频会拆成多行)',
  );
  lines.push('');

  // 成功的排前面,失败 / 跳过的排后面,商品名按字典序便于人工核对
  const ordered = [...entries].sort((a, b) => {
    const sa = statusRank(a.status);
    const sb = statusRank(b.status);
    if (sa !== sb) return sa - sb;
    return a.productName.localeCompare(b.productName, 'zh-Hans-CN');
  });

  for (const e of ordered) {
    const tgt = e.targetSpuId ?? '-';
    for (const url of e.videoUrls) {
      lines.push(
        [statusLabel(e.status), tgt, e.sourceSpuId, e.productName, url].join('\t'),
      );
    }
  }
  lines.push('');
  lines.push(
    `# 共 ${ordered.length} 个商品,${ordered.reduce((n, x) => n + x.videoUrls.length, 0)} 条视频待手动补传`,
  );
  return lines.join('\n');
}

function statusRank(s: ImportResultItem['status']): number {
  return s === 'success' ? 0 : s === 'skipped' ? 1 : 2;
}
function statusLabel(s: ImportResultItem['status']): string {
  return s === 'success' ? '成功' : s === 'skipped' ? '跳过' : '失败';
}

function buildVideoMappingFileName(shopId: string | number): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return `qnh-video-mapping-${shopId}-${ts}.txt`;
}

/** 把视频补传清单写到源目录(导入和导出共用同一个目录) */
async function triggerTxtDownload(
  dir: FileSystemDirectoryHandle,
  text: string,
  fileName: string,
): Promise<void> {
  // 加一个 BOM,Windows 下 Excel / 记事本打开就是 UTF-8,中文不乱码
  const withBom = '\uFEFF' + text;
  await writeTextFile(dir, fileName, withBom);
}


/**
 * 按 UPC 精准查询目标店是否已存在该商品。
 *   - 用 page-query-spu 的 upcList 过滤,在线计算,不预拉全店清单
 *   - 命中即返回 { spuId, reason: 'UPC=xxx' };找不到再用商品名兜底
 *   - 名字兜底:后端 spuName 是关键词模糊检索,且"关键词超上限只取前 3 个词",
 *     返回结果可能多个且不一定同名;这里翻页拉回候选,再用「去空格精确匹配」挑出真正同名项,
 *     命中返回 { spuId, reason: '同名' }
 *   - 找不到匹配 → 返回 null,调用方走"创建"路径
 */
export async function lookupExistingForProduct(
  callInjected: CallInjected,
  targetShopId: string | number,
  spu: ProductSpu,
): Promise<{ spuId: string | number; reason: string } | null> {
  // 1) 收集本商品所有 UPC
  const upcSet = new Set<string>();
  for (const sku of spu.skus ?? []) {
    if (sku.outerSkuCode) upcSet.add(sku.outerSkuCode);
  }
  const detail = spu.raw?.detail as
    | { skus?: Array<{ upcList?: string[] }> }
    | undefined;
  for (const sku of detail?.skus ?? []) {
    for (const u of sku.upcList ?? []) if (u) upcSet.add(u);
  }
  const upcList = [...upcSet];

  // 2) UPC 查询
  if (upcList.length > 0) {
    const page = await callInjected<{
      list: Array<{ spuId: string | number; name: string; upcList: string[] }>;
      total: number;
    }>({
      type: 'FETCH_PRODUCT_LIST',
      payload: { shopId: targetShopId, pageNo: 1, pageSize: 20, upcList },
    });
    if (page.list.length > 0) {
      // 后端按"任一 UPC 匹配"返回,取第一个命中即可
      const hit = page.list[0];
      const matchedUpc = (hit.upcList ?? []).find((u) => upcSet.has(u)) ?? upcList[0];
      return { spuId: hit.spuId, reason: `UPC=${matchedUpc}` };
    }
  }

  // 3) 兜底:商品名查询。
  //    后端 spuName 是按关键词 like 检索,且有"关键词个数超出上限,只取前 3 个关键词"
  //    的限制 —— 名字一长就只用前 3 个词模糊匹配,因此返回结果往往是多个、且不一定同名。
  //    这里翻页把候选拉回来,在程序内用「去空格精确匹配」(normalizeName)挑出真正同名的那一个。
  if (spu.name) {
    const target = normalizeName(spu.name);
    if (target) {
      const pageSize = 50;
      const maxPages = 10; // 最多翻 500 条:名字过于通用时也不至于无限翻页
      for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
        const page = await callInjected<{
          list: Array<{ spuId: string | number; name: string; upcList: string[] }>;
          total: number;
        }>({
          type: 'FETCH_PRODUCT_LIST',
          payload: { shopId: targetShopId, pageNo, pageSize, spuName: spu.name },
        });
        const exact = page.list.find((it) => normalizeName(it.name) === target);
        if (exact) return { spuId: exact.spuId, reason: '同名' };
        // 没翻到底就继续下一页;后端 total 可用时按 total 截断,避免空翻
        if (page.list.length < pageSize) break;
        if (page.total && pageNo * pageSize >= page.total) break;
      }
    }
  }

  return null;
}

/** 商品名归一化:去空白 / 全半角空格,统一小写,够用即可 */
function normalizeName(name: string): string {
  return (name ?? '')
    .replace(/[\s\u3000]+/g, '')
    .toLowerCase()
    .trim();
}


/**
 * 全量·修改路径:获取目标商品 detail 用作 update body 的基线。
 * update 接口要求 channelInfoList / skuList / specialPictureList 都按目标店当前现状回传,
 * 这里直接拉一次 detail,把 raw.detail 透给 injected 的 updateProduct 用。
 */
async function fetchTargetDetailForUpdate(
  callInjected: CallInjected,
  targetShopId: string | number,
  targetSpuId: string | number,
): Promise<unknown> {
  const r = await callInjected<{ raw?: { detail?: unknown } }>({
    type: 'FETCH_PRODUCT_DETAIL',
    payload: { shopId: targetShopId, spuId: targetSpuId },
  });
  const d = r?.raw?.detail;
  if (!d) throw new Error('拉取目标商品详情失败,update 流程无法继续');
  return d;
}


/**
 * 判断源商品 detail 与目标商品 detail 是否"实质相同":
 *   - 名字 / 图片 / 视频 / 图文详情 / 渠道类目 / 渠道动态属性 / SKU 价格-售卖单位-售卖渠道 等都一致
 *   - 库存(stock / channelStock / customizeStockFlag 等)在比较前剔除,不影响判定
 *   - 字段顺序无关:深度比对前先做规范化(数组按 key 排序)
 *
 * 图片比较走"内容 hash"路径:
 *   - 源端图片在导出时被替换成 `media://<sha256>` 占位符(部分主图字段例外,保留原 URL),
 *     我们能直接拿到 sha256;裸 URL 则就近从源目录 media/<hash>.<ext> 读文件回算 hash,
 *     拿不到就走代理 fetch + 算 hash。
 *   - 目标端图片永远是美团 CDN URL(basename 是美团自己的内容哈希,跟我们的 sha256 无关),
 *     必须走代理 fetch 下载、算一遍 sha256 才能跟源端比对。
 *   - 算过的 URL → hash 映射会写到源目录的 sidecar 缓存,下次重复导入直接命中。
 *
 * 任何异常都退化为"不相同",让上层走 update 路径,保证安全(宁可重写也别漏改)。
 */
async function isProductSame(
  src: Record<string, unknown> | undefined,
  tgt: Record<string, unknown> | undefined,
  ctx: {
    urlHashCache: UrlHashCache;
    sourceMediaDir: FileSystemDirectoryHandle | null;
    /** false 时跳过图片字段比对,只比非图字段(配合 syncImages = false 使用) */
    compareImages?: boolean;
    /**
     * 源「店内分类」namePath → 目标「店内分类」namePath。
     * 跨租户导入时,源端分类常被映射到目标店里"不同名"的分类;
     * 比对前先把源快照里的店内分类翻译成目标侧预期值,避免"映射后每次都误判为已修改"。
     */
    frontCategoryPathRemap?: Map<string, string>;
  },
): Promise<boolean> {
  if (!src || !tgt) return false;
  try {
    // 非图片字段:直接做规范化结构对比。
    // 源侧应用店内分类 path 改写(把源 namePath 翻译成目标侧预期值),目标侧不改写。
    const a = canonicalizeNonMediaForCompare(src, ctx.frontCategoryPathRemap) as Record<
      string,
      unknown
    >;
    const b = canonicalizeNonMediaForCompare(tgt) as Record<string, unknown>;
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      // 逐字段定位首个差异,打到日志,方便排查"明明没改却走 update"的情况
      for (const key of Object.keys(a)) {
        const av = JSON.stringify(a[key]);
        const bv = JSON.stringify(b[key]);
        if (av !== bv) {
          log.info(
            `[对比差异] 字段「${key}」不一致 → 走 update\n  源端: ${truncateForLog(av)}\n  目标: ${truncateForLog(bv)}`,
          );
          break;
        }
      }
      return false;
    }

    if (ctx.compareImages === false) return true;

    // 图片字段:把 URL/占位符 都解成 sha256,再按"内容等价"比较。
    // "等价"= 字面相等 或 命中上传重编码等价表(源图上传到目标店被美团重编码,
    // 字节 hash 必然变,但等价表记录了这层对应关系)。
    const resolveSrc = (url: string) => resolveImageHash(url, ctx, 'source');
    const resolveTgt = (url: string) => resolveImageHash(url, ctx, 'target');
    const eq = (x: string, y: string) => ctx.urlHashCache.hashesEquivalent(x, y);
    return await compareMediaFields(src, tgt, resolveSrc, resolveTgt, eq);
  } catch (e) {
    log.warn('参数比对失败,保守起见走 update 路径', e);
    return false;
  }
}

/**
 * 把单个媒体引用解成 sha256:
 *   - `media://<hash>` → 直接返回 hash
 *   - 普通 URL:
 *     · source 侧先尝试在源目录 media/<hash>.<ext> 里找现成文件;失败再走代理 fetch
 *     · target 侧只走代理 fetch
 *   - 算过的 URL 落 sidecar 缓存,重复导入命中
 *   - 空串返回空串(由调用方决定是否参与比对)
 */
async function resolveImageHash(
  url: string,
  ctx: {
    urlHashCache: UrlHashCache;
    sourceMediaDir: FileSystemDirectoryHandle | null;
  },
  side: 'source' | 'target',
): Promise<string> {
  if (!url) return '';
  const m = /^media:\/\/([a-f0-9]{64})$/i.exec(url);
  if (m) return m[1].toLowerCase();

  // 已缓存:直接拿
  const cached = ctx.urlHashCache.peek(url);
  if (cached) return cached;

  if (side === 'source' && ctx.sourceMediaDir) {
    // 源端裸 URL(导出时部分字段未被替换)→ 多数情况其实在 media/ 下也没有现成文件,
    // 因为只有被 __pendingMedia 收集到的 URL 才会下载。直接走代理 fetch。
    // 留这条分支是为了将来扩展(比如从 media.json 推 hash);现状跟 target 走同一路径。
  }

  return ctx.urlHashCache.getOrCompute(url, fetchUrlAsArrayBuffer);
}

/**
 * 把 detail 里图片相关字段按"内容 hash"做一次结构化比对。
 *   - picUrlList / picContentList:顺序敏感,按位比
 *   - videoInfo.videoUrl:单值
 *   - mt/elmSpecialPictureList:按 pictureType 分组,组内按位比
 * 任意一处对不上 → false。
 */
async function compareMediaFields(
  src: Record<string, unknown>,
  tgt: Record<string, unknown>,
  resolveSrc: (url: string) => Promise<string>,
  resolveTgt: (url: string) => Promise<string>,
  /** 内容 hash 等价判定:字面相等 或 命中上传重编码等价表 */
  eq: (a: string, b: string) => boolean,
): Promise<boolean> {
  const get = <T>(o: Record<string, unknown>, k: string): T | undefined => o[k] as T | undefined;

  // 写入端(buildTenantSpuV2)对 picUrlList / picContentList 会做 uniqueStrings(...).filter(Boolean),
  // 即"去重 + 去空"后才落库。比对必须用同一套归一,否则源端若有重复/空串(常见于历史导出包),
  // 会跟目标店实际落库的去重结果对不上,导致"明明没改却每次都 update"。
  const dedupNonEmpty = (arr: string[]): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const s of arr) {
      if (typeof s !== 'string' || !s) continue;
      if (seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
    return out;
  };

  // 主图 / 图文详情:按位比。不一致时把 长度 / 解析出的 hash 打到日志,方便定位。
  const eqList = async (label: string, a: string[], b: string[]) => {
    if (a.length !== b.length) {
      log.info(
        `[对比差异] 图片字段「${label}」数量不一致 → 走 update(源 ${a.length} 张 / 目标 ${b.length} 张)\n  源端: ${truncateForLog(JSON.stringify(a))}\n  目标: ${truncateForLog(JSON.stringify(b))}`,
      );
      return false;
    }
    const ah = await Promise.all(a.map(resolveSrc));
    const bh = await Promise.all(b.map(resolveTgt));
    for (let i = 0; i < ah.length; i++) {
      if (!ah[i] || !eq(ah[i], bh[i])) {
        log.info(
          `[对比差异] 图片字段「${label}」第 ${i + 1} 张内容不一致 → 走 update\n` +
            `  源端 url: ${a[i]}  hash: ${ah[i] || '(空)'}\n` +
            `  目标 url: ${b[i]}  hash: ${bh[i] || '(空)'}`,
        );
        return false; // 任一为空 hash 视为不同(避免误判)
      }
    }
    return true;
  };

  if (
    !(await eqList(
      'picUrlList',
      dedupNonEmpty(get<string[]>(src, 'picUrlList') ?? []),
      dedupNonEmpty(get<string[]>(tgt, 'picUrlList') ?? []),
    ))
  ) {
    return false;
  }
  if (
    !(await eqList(
      'picContentList',
      dedupNonEmpty(get<string[]>(src, 'picContentList') ?? []),
      dedupNonEmpty(get<string[]>(tgt, 'picContentList') ?? []),
    ))
  ) {
    return false;
  }

  // 视频:videoInfo.videoUrl(单个),空对空也算相等
  const srcVideo = get<{ videoUrl?: string }>(src, 'videoInfo')?.videoUrl ?? '';
  const tgtVideo = get<{ videoUrl?: string }>(tgt, 'videoInfo')?.videoUrl ?? '';
  if (!!srcVideo !== !!tgtVideo) {
    log.info(
      `[对比差异] 视频有无不一致 → 走 update(源 ${srcVideo ? '有' : '无'} / 目标 ${tgtVideo ? '有' : '无'})`,
    );
    return false;
  }
  if (srcVideo && tgtVideo) {
    const sh = await resolveSrc(srcVideo);
    const th = await resolveTgt(tgtVideo);
    if (!sh || !eq(sh, th)) {
      log.info(
        `[对比差异] 视频内容不一致 → 走 update\n  源端 hash: ${sh || '(空)'}\n  目标 hash: ${th || '(空)'}`,
      );
      return false;
    }
  }

  // 渠道特殊图:按 pictureType 分桶,桶内按位比
  if (
    !(await eqSpecialPictures(
      'mtSpecialPictureList',
      get<Array<Record<string, unknown>>>(src, 'mtSpecialPictureList'),
      get<Array<Record<string, unknown>>>(tgt, 'mtSpecialPictureList'),
      resolveSrc,
      resolveTgt,
      eq,
    ))
  ) {
    return false;
  }
  if (
    !(await eqSpecialPictures(
      'elmSpecialPictureList',
      get<Array<Record<string, unknown>>>(src, 'elmSpecialPictureList'),
      get<Array<Record<string, unknown>>>(tgt, 'elmSpecialPictureList'),
      resolveSrc,
      resolveTgt,
      eq,
    ))
  ) {
    return false;
  }

  return true;
}

/** 渠道特殊图按 pictureType 分桶后,逐桶按位比对(走 hash 路径) */
async function eqSpecialPictures(
  label: string,
  src: Array<Record<string, unknown>> | undefined,
  tgt: Array<Record<string, unknown>> | undefined,
  resolveSrc: (url: string) => Promise<string>,
  resolveTgt: (url: string) => Promise<string>,
  eq: (a: string, b: string) => boolean,
): Promise<boolean> {
  const norm = (list: Array<Record<string, unknown>> | undefined) => {
    const groups: Array<{ pictureType: number; urls: string[] }> = [];
    for (const p of list ?? []) {
      const urls = ((p.pictureUrl as string[] | null | undefined) ?? []).filter((u) => !!u);
      if (urls.length === 0) continue;
      groups.push({ pictureType: Number(p.pictureType ?? 0), urls });
    }
    groups.sort((a, b) => a.pictureType - b.pictureType);
    return groups;
  };
  const a = norm(src);
  const b = norm(tgt);
  if (a.length !== b.length) {
    log.info(
      `[对比差异] 特殊图「${label}」分桶数量不一致 → 走 update(源 ${a.length} 桶 / 目标 ${b.length} 桶)`,
    );
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i].pictureType !== b[i].pictureType) {
      log.info(
        `[对比差异] 特殊图「${label}」pictureType 不一致 → 走 update(源 ${a[i].pictureType} / 目标 ${b[i].pictureType})`,
      );
      return false;
    }
    if (a[i].urls.length !== b[i].urls.length) {
      log.info(
        `[对比差异] 特殊图「${label}」pictureType=${a[i].pictureType} 图片数量不一致 → 走 update(源 ${a[i].urls.length} 张 / 目标 ${b[i].urls.length} 张)`,
      );
      return false;
    }
    const ah = await Promise.all(a[i].urls.map(resolveSrc));
    const bh = await Promise.all(b[i].urls.map(resolveTgt));
    for (let j = 0; j < ah.length; j++) {
      if (!ah[j] || !eq(ah[j], bh[j])) {
        log.info(
          `[对比差异] 特殊图「${label}」pictureType=${a[i].pictureType} 第 ${j + 1} 张内容不一致 → 走 update\n` +
            `  源端 url: ${a[i].urls[j]}  hash: ${ah[j] || '(空)'}\n` +
            `  目标 url: ${b[i].urls[j]}  hash: ${bh[j] || '(空)'}`,
        );
        return false;
      }
    }
  }
  return true;
}

/**
 * 把 detail 规范化成"对比友好"的形态(只覆盖非图片字段;图片走 compareMediaFields 单独比):
 *   - 只比 update 接口实际会写到服务端的那部分字段
 *   - 渠道侧 ch2911(客无忧POS)是店内通道,tenant/detail 不返回,
 *     update 也不会改它,跳过
 *   - SKU 的 onlineChannels / onlineStatus 是店内属性,同上
 *   - storeFrontCategoryList 跨租户 ID 不一样,只比 namePath
 */
function canonicalizeNonMediaForCompare(
  d: Record<string, unknown>,
  frontCategoryPathRemap?: Map<string, string>,
): unknown {
  const get = <T>(o: Record<string, unknown>, k: string): T | undefined =>
    o[k] as T | undefined;

  // --- 渠道类目 + 动态属性(平铺到 spuChannelInfoList[].categoryProperties) ---
  // ch2911 是店内通道(客无忧POS),tenant/detail 不返回,update 也不写,
  // 留在源端会引发"假差异",这里直接过滤掉。
  const channels = (get<Array<Record<string, unknown>>>(d, 'spuChannelInfoList') ?? [])
    .filter((c) => Number(c.channelId ?? 0) !== 2911)
    .map((c) => {
      const attrs = ((c.categoryProperties as Array<Record<string, unknown>>) ?? [])
        .map(canonicalizeAttrForCompare)
        .sort((x, y) => String(x.attrId).localeCompare(String(y.attrId)));
      return {
        channelId: c.channelId,
        categoryCode: c.categoryCode,
        categoryCodePath: c.categoryCodePath,
        attrs,
      };
    })
    .sort((a, b) => Number(a.channelId ?? 0) - Number(b.channelId ?? 0));

  // --- 店内分类(只比 namePath,跨租户 categoryCode 必然不同) ---
  // namePath 在 tenant/detail 里以 ">" 分隔(如 "膨化食品>乐事薯片"),
  // 这里统一归一成 "/" 分隔,跟 validateFrontCategories 的 path key 对齐。
  // 源侧:若该分类被映射到目标店里"不同名"的分类,先翻译成目标 namePath,
  //       这样跟目标店实际落库的 namePath 对得上,不会每次都误判为已修改。
  // 目标侧:不传 remap,原样归一即可。
  const frontCats: string[] = [];
  for (const group of get<Array<{ storeCategoryList?: Array<{ namePath?: string }> }>>(
    d,
    'storeFrontCategoryList',
  ) ?? []) {
    for (const c of group.storeCategoryList ?? []) {
      if (!c.namePath) continue;
      const canonical = c.namePath.split('>').filter(Boolean).join('/');
      frontCats.push(frontCategoryPathRemap?.get(canonical) ?? canonical);
    }
  }
  frontCats.sort();

  // --- SKU(tenant 维度 SKU 没有店内库存字段,直接全要) ---
  const skus = (get<Array<Record<string, unknown>>>(d, 'skus') ?? [])
    .map(canonicalizeSkuForCompare)
    .sort((a, b) => {
      const sa = `${a.specName ?? ''}|${(a.upcList as string[])?.join(',') ?? ''}`;
      const sb = `${b.specName ?? ''}|${(b.upcList as string[])?.join(',') ?? ''}`;
      return sa.localeCompare(sb);
    });

  return {
    spuName: (get<string>(d, 'spuName') ?? '').trim(),
    specType: get<number>(d, 'specType') ?? null,
    weightType: get<number>(d, 'weightType') ?? null,
    onlineStatus: get<number>(d, 'onlineStatus') ?? null,
    sellPoint: (get<string>(d, 'sellPoint') ?? '').trim(),
    description: (get<string>(d, 'description') ?? '').trim(),
    channels,
    frontCats,
    skus,
  };
}

/** 渠道动态属性:只比 attrId / attrValueId / attrValue / structAttrValueList */
function canonicalizeAttrForCompare(p: Record<string, unknown>): Record<string, unknown> {
  return {
    attrId: String(p.attrId ?? ''),
    customValue: ((p.customValue as Array<Record<string, unknown>>) ?? [])
      .map((cv) => ({
        attrValueId: cv.attrValueId ?? null,
        attrValue: cv.attrValue ?? null,
        structAttrValueList: cv.structAttrValueList ?? null,
      }))
      .sort((a, b) =>
        String(a.attrValueId ?? a.attrValue ?? '').localeCompare(
          String(b.attrValueId ?? b.attrValue ?? ''),
        ),
      ),
  };
}

/**
 * SKU 比对(只看 update 接口实际写到服务端的字段):
 *   - specName / saleUnit / 重量 / UPC / 建议售价 / 售卖类型 / 子单品
 *   - onlineStatus / onlineChannels 是店内字段(tenant/detail 不返回或为空数组),
 *     update 也不会改它们,跳过避免假差异
 *   - 价格只来自 suggestPrice.tenantSuggestPrice.unifiedSuggestPrice
 */
function canonicalizeSkuForCompare(s: Record<string, unknown>): Record<string, unknown> {
  const upc = ((s.upcList as string[]) ?? []).slice().sort();
  const suggest = (
    s.suggestPrice as { tenantSuggestPrice?: { unifiedSuggestPrice?: string } } | undefined
  )?.tenantSuggestPrice?.unifiedSuggestPrice;
  return {
    specName: (s.specName as string)?.trim() ?? '',
    skuSaleType: s.skuSaleType ?? 1,
    saleUnit: s.saleUnit ?? '',
    weightForUnit: trimZero(String(s.weightForUnit ?? '')),
    weightUnit: s.weightUnit ?? '',
    upcList: upc,
    suggestPrice: trimZero(String(suggest ?? '')),
    minOrderCount: s.minOrderCount ?? 1,
    childSkuList: ((s.childSkuList as Array<Record<string, unknown>>) ?? [])
      .map((c) => ({
        // 跨租户对比时 spuId/skuId 必然不同(目标店是新建出来的),
        // 只比 amount 等业务可见字段
        amount: c.amount,
        skuSpec: c.skuSpec,
      }))
      .sort((a, b) => String(a.skuSpec ?? '').localeCompare(String(b.skuSpec ?? ''))),
  };
}

function trimZero(s: string): string {
  if (!s) return '';
  if (!s.includes('.')) return s;
  return s.replace(/\.?0+$/, '');
}

/** 把可能很长的 JSON 字符串截断,避免比对差异日志刷屏 */
function truncateForLog(s: string | undefined, max = 600): string {
  if (s == null) return '(undefined)';
  return s.length > max ? `${s.slice(0, max)}…(${s.length} chars)` : s;
}
