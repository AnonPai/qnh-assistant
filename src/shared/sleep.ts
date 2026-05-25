/**
 * 节流工具:导入阶段串行调商品创建接口,需要随机抖动避开风控。
 */
export const sleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

/** 在 [min,max] 区间内随机延迟 */
export const jitter = (min: number, max: number) =>
  sleep(min + Math.random() * Math.max(0, max - min));

/**
 * 导出 / 导入流程使用的随机抖动区间(单位 ms,左闭右开)。
 * 集中管理这些常量,方便统一调整风控节奏。调用方用扩展运算符:
 *   await jitter(...THROTTLE.EXPORT_PRODUCT);
 */
export const THROTTLE = {
  /** 导出 · 商品列表分页接口之间的随机间隔 */
  EXPORT_LIST_PAGE: [400, 800],
  /** 导出 · 每个商品(详情 + 媒体下载)处理完之后的随机间隔 */
  EXPORT_PRODUCT: [400, 900],
  /** 导入 · 每个商品创建/修改之后的随机间隔(写入接口比读敏感得多,窗口更大) */
  IMPORT_PRODUCT: [500, 1500],
  /** 导入 · 单张图片上传之间的随机间隔 */
  IMPORT_MEDIA_UPLOAD: [350, 800],
} as const satisfies Record<string, readonly [number, number]>;
