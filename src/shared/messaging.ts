/**
 * Popup / Content / Background / Injected 之间的统一消息协议。
 *
 * 通信路径:
 *   Popup ─chrome.runtime.sendMessage─▶ Background
 *   Popup ─chrome.tabs.sendMessage────▶ Content (定向到当前 tab)
 *   Content ─window.postMessage──────▶ Injected (页面 MAIN world)
 *   Injected ─window.postMessage─────▶ Content
 */

import type {
  CategorySnapshot,
  ExportManifest,
  ImportSummary,
  ProductSpu,
} from './types';

export type { ImportSummary } from './types';

/** 消息源/目标标识 */
export const BRIDGE_SOURCE_INJECTED = 'qnh-injected';
export const BRIDGE_SOURCE_CONTENT = 'qnh-content';

/** 导入模式 */
export type ImportMode = 'full' | 'incremental';

/** 执行方式:auto = 程序自动跑;manual = 每次创建/修改前等待人工确认 */
export type ImportConfirmMode = 'auto' | 'manual';

/** Popup ↔ Content/Background */
export type PopupRequest =
  | { type: 'PING' }
  | { type: 'GET_SHOP_LIST' }
  | { type: 'EXPORT_START'; payload: { sourceShopId: string | number; includeVideo?: boolean } }
  | { type: 'EXPORT_CANCEL' }
  | { type: 'IMPORT_START' }
  | { type: 'IMPORT_CANCEL' }
  | { type: 'GET_PROGRESS' }
  | { type: 'GET_SHOP_INFO' };

export type PopupResponse<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/** 进度事件,从 Content/Background 推到 Popup */
export type ProgressEvent =
  | {
      kind: 'export';
      phase: 'list' | 'detail' | 'media' | 'pack';
      current: number;
      total: number;
      message?: string;
      /** 已处理 / 总商品数,跨 phase 始终维持,UI 用它做"商品进度"展示 */
      productCurrent?: number;
      productTotal?: number;
    }
  | {
      kind: 'import';
      phase: 'parse' | 'media' | 'product';
      current: number;
      total: number;
      message?: string;
      productCurrent?: number;
      productTotal?: number;
    }
  /**
   * 离散的商品级日志,UI 端用来渲染"滚动日志列表"。
   * 进度条与计数仍由 export/import 事件驱动,这个只追加文本行。
   */
  | {
      kind: 'log';
      level: 'info' | 'success' | 'warn' | 'error';
      /** 顺序号,从 1 开始;UI 用它配合 productTotal 展示 "5/3w" */
      index: number;
      total?: number;
      /** 简短文本,渲染时单行省略 */
      text: string;
    }
  | { kind: 'done'; result: ExportResult | ImportSummary }
  | { kind: 'error'; message: string };

export interface ExportResult {
  manifest: ExportManifest;
  /** 文件名占位(目录直写后没有 zip 文件,留个字段方便 UI 兼容旧逻辑) */
  fileName: string;
}

/** Content → Injected 的指令 */
export type InjectedCommand =
  | { id: string; type: 'FETCH_SHOP_LIST' }
  | { id: string; type: 'SWITCH_SHOP'; payload: { shopId: string | number } }
  | { id: string; type: 'FETCH_PRODUCT_LIST'; payload: { shopId: string | number; pageNo: number; pageSize: number; spuName?: string; upcList?: string[]; skuIdList?: Array<string | number>; /** 'tenant' = 租户主档(几万条);'store' = 门店在售(默认导出走这个) */ scope?: 'tenant' | 'store' } }
  | { id: string; type: 'FETCH_PRODUCT_DETAIL'; payload: { shopId: string | number; spuId: string | number } }
  | { id: string; type: 'FETCH_CATEGORY_TREE'; payload: { shopId: string | number } }
  | { id: string; type: 'FETCH_FRONT_CATEGORY_TREE'; payload: { shopId: string | number } }
  | { id: string; type: 'FETCH_SHOP_INFO' }
  | { id: string; type: 'UPLOAD_MEDIA'; payload: { shopId: string | number; kind: 'image' | 'video'; mime: string; bytesBase64: string } }
  | { id: string; type: 'CREATE_PRODUCT'; payload: { shopId: string | number; product: ProductSpu; mediaIdMap: Record<string, UploadedMedia>; targetCategoryPath: Array<string | number>; childSkuMap?: Record<string, ChildSkuMapping>; frontCategoryIdRemap?: Record<string, string> } }
  | { id: string; type: 'UPDATE_PRODUCT'; payload: { product: ProductSpu; mediaIdMap: Record<string, UploadedMedia>; targetSpuId: string | number; targetDetail: unknown; frontCategoryIdRemap?: Record<string, string>; existingMediaIdMap?: Record<string, UploadedMedia>; childSkuMap?: Record<string, ChildSkuMapping> } };

/** 父商品创建时,把组合装 childSkuList 里的源 spuId/skuId 替换成目标店里新建后的 ID */
export interface ChildSkuMapping {
  /** 目标 SPU id */
  targetSpuId: string | number;
  /** 源 skuId → 目标 skuId */
  skuMap: Record<string, string | number>;
}

export type InjectedResponse =
  | { id: string; ok: true; data: unknown }
  | { id: string; ok: false; error: string };

/** 页面信息(导出时落到 manifest) */
export interface ShopInfo {
  shopId?: string | number;
  shopName?: string;
  accountName?: string;
}

/** 账号下的门店摘要 */
export interface ShopBrief {
  shopId: string | number;
  shopName: string;
  /** 可选:门店所在城市/地址,展示用 */
  region?: string;
}

/** 类目树查询结果 */
export type CategoryTree = CategorySnapshot[];

/** 店内前台分类节点(用于跨租户导入前的"店内分类"映射校验) */
export interface FrontCategoryNode {
  /** 该租户分配的分类 ID(跨租户不通用) */
  categoryId: string;
  /** 父级 ID,顶级为 "0" */
  parentCategoryId: string;
  name: string;
  level: number;
  enable: number;
  children: FrontCategoryNode[];
}

/** 媒体上传结果(图片/视频共用) */
export interface UploadedMedia {
  /** 缩略 / 标准尺寸 URL,回填到大多数业务字段 */
  fileUrl: string;
  /** 高清原图 URL,回填到 originPicUrlMapping 等"原图"字段 */
  originFileUrl?: string;
  /** 视频:封面图 URL */
  coverUrl?: string;
}
