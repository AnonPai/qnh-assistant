/**
 * 共享类型定义。
 * 真实字段需要在抓接口阶段补全;这里先给一个 MVP 友好的最小集合,
 * 多余字段统一塞 raw,避免导出阶段丢字段。
 */

/** 媒体类型 */
export type MediaKind = 'image' | 'video';

/** 单个媒体资源(导出时下载并以 hash 命名) */
export interface MediaAsset {
  /** 文件内容 sha256(也可临时用 md5),作为去重 key 与文件名 */
  hash: string;
  kind: MediaKind;
  /** 原 URL(用于排错) */
  sourceUrl: string;
  /** mime 类型 */
  mime: string;
  /** 文件大小,字节 */
  size: number;
  /** 在 zip 内的相对路径,如 media/abc123.jpg */
  path: string;
}

/** 商品规格(SKU 维度,如 "辣度=中辣") */
export interface SpecOption {
  name: string;
  value: string;
}

/** SKU */
export interface ProductSku {
  /** 门店线下价，旧导出包没有此字段。 */
  storePrice?: number;
  /** 源门店线上零售价，旧导出包可能未记录。 */
  onlinePrice?: number;
  /** 源系统 SKU id,仅用于 manifest 调试,不传给目标账号 */
  sourceSkuId?: string | number;
  /** 规格组合 */
  specs: SpecOption[];
  /** 售价(元) */
  price: number;
  /** 原价(元) */
  originPrice?: number;
  /** 库存(门店维度;导出时从 store/detail 的 storeSkuList[].stock 取) */
  stock?: number;
  /**
   * 分渠道零售价(门店维度;导出时从 store/detail 的 onlinePriceList 取)。
   * 「同步库存价格」同步零售价时优先用它;为空时回退到建议售价 price。
   */
  channelPrices?: Array<{ channelId: number; price: number }>;
  /** 第三方编码 */
  outerSkuCode?: string;
  /** 该 SKU 独有图片(如不同颜色),引用 MediaAsset.hash */
  imageHashes?: string[];
}

/** 商品(SPU) */
export interface ProductSpu {
  /** 源 SPU id,仅做指纹,不传给目标账号 */
  sourceSpuId: string | number;
  name: string;
  /** 源类目 id 路径 [一级,二级,三级] */
  sourceCategoryPath: Array<string | number>;
  /** 源类目名称路径,导入时用于自动匹配/人工映射 */
  sourceCategoryNamePath: string[];
  /** 主图,引用 MediaAsset.hash 数组 */
  mainImageHashes: string[];
  /** 视频,引用 MediaAsset.hash */
  videoHashes: string[];
  /** 商品详情(富文本 HTML),内含图片会被改写成 hash 占位符 */
  detailHtml?: string;
  /** 详情中引用的图片 hash 列表(便于上传) */
  detailImageHashes?: string[];
  /** SKU 列表 */
  skus: ProductSku[];
  /** 其他原样字段,留作目标账号复刻用 */
  raw?: Record<string, unknown>;
}

/** 类目快照,导入端做映射用 */
export interface CategorySnapshot {
  id: string | number;
  name: string;
  parentId: string | number | null;
  level: number;
}

/** 导出包 manifest */
export interface ExportManifest {
  /** 包格式版本 */
  schemaVersion: 1;
  /** 插件版本 */
  pluginVersion: string;
  /** 源账号信息 */
  source: {
    shopId?: string | number;
    shopName?: string;
    accountName?: string;
    exportedAt: string;
  };
  /** 商品总数 */
  productCount: number;
  /** 本次导出的商品；早期导出包需从 products 目录读取清单。 */
  productIds?: string[];
  /** 媒体总数 */
  mediaCount: number;
}

/** 导入阶段的类目映射 */
export interface CategoryMapping {
  /** key: 源类目名称路径 join("/") */
  [sourceKey: string]: {
    targetCategoryPath: Array<string | number>;
    targetCategoryNamePath: string[];
  };
}

/** 单个商品的导入结果 */
export interface ImportResultItem {
  sourceSpuId: string | number;
  name: string;
  status: 'success' | 'updated' | 'failed' | 'skipped';
  /** 目标 spu id(成功 / 已修改时) */
  targetSpuId?: string | number;
  errorMessage?: string;
  /** 步骤耗时(ms) */
  durationMs?: number;
}

/** 「同步库存 / 零售价」整体结果(从导出目录把每个 SKU 的价格/库存推到目标门店) */
export interface SyncSummary {
  cancelled: boolean;
  /** 商品匹配或读取目标详情失败，尚未执行 SKU 写入。 */
  productFailed: number;
  /** 判别标记,便于 UI 在 done 事件里和导出 / 导入结果区分 */
  kind: 'sync';
  /** 目标门店 */
  shopId: string | number;
  shopName?: string;
  /** 本次是否同步了库存 / 零售价 */
  syncedStock: boolean;
  syncedPrice: boolean;
  /** products 目录里的商品总数 / 实际处理数 */
  productTotal: number;
  productProcessed: number;
  /** 在目标门店没匹配到(UPC + 商品名都没命中)的商品数 */
  productNotFound: number;
  /** 零售价:成功 / 失败 / 跳过(无有效价格)的 SKU 数 */
  priceOk: number;
  priceFailed: number;
  priceSkipped: number;
  /** 库存:成功 / 失败 / 跳过(导出包未带库存)的 SKU 数 */
  stockOk: number;
  stockFailed: number;
  stockSkipped: number;
  startedAt: string;
  finishedAt: string;
  /** 首个错误信息(便于 UI 直接展示) */
  firstError?: string;
}

/** 整体导入结果 */
export interface ImportSummary {
  cancelled: boolean;
  total: number;
  succeeded: number;
  /** 已通过修改接口更新的商品数(全量模式 + UPC 命中) */
  updated: number;
  failed: number;
  skipped: number;
  startedAt: string;
  finishedAt: string;
  items: ImportResultItem[];
  /** 视频暂不支持上传,导入完成后会落一个手动补传清单的 txt;此处记录文件名 */
  videoMappingFileName?: string;
  /** 需要手动补传的视频条目数(含一个商品多个视频) */
  videoMappingCount?: number;
  /** 排查用:导入全过程日志落盘文件名(写在源目录根) */
  logFileName?: string;
}
