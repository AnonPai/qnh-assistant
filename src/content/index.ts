/**
 * Content Script(运行在隔离世界)
 *
 * 流程:
 *  1. 在页面 DOM 注入 <script src="injected.js">,让我们的代码进入 MAIN world,
 *     从而可以复用页面里的 fetch 拦截器、签名函数(mtgsig 等)。
 *  2. 通过 window.postMessage 与 injected 双向通信。
 *  3. 监听 popup 指令(EXPORT_START / IMPORT_START …),驱动导出与导入流程。
 *  4. 把进度事件用 runtime.sendMessage 转发到 background,再广播给 popup。
 */

import { createLogger } from '@shared/logger';
import {
  BRIDGE_SOURCE_CONTENT,
  BRIDGE_SOURCE_INJECTED,
  type InjectedCommand,
  type InjectedResponse,
  type PopupRequest,
  type PopupResponse,
  type ProgressEvent,
} from '@shared/messaging';
import { runExport } from './export';
import { runImport } from './import';
import { mountInPageUI, openInPageEntry } from './inpage-ui';

const log = createLogger('content');

/** ---------- 注入 page world 脚本 ---------- */
function injectPageScript() {
  const url = chrome.runtime.getURL('injected.js');
  const s = document.createElement('script');
  s.src = url;
  s.async = false;
  s.dataset.qnh = '1';
  (document.head || document.documentElement).appendChild(s);
  s.remove(); // 注入后从 DOM 移除,代码已在 page world 执行
  log.info('injected.js attached');
}

injectPageScript();

/** ---------- Content ↔ Injected 桥 ---------- */

const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

window.addEventListener('message', (ev) => {
  if (ev.source !== window) return;
  const data = ev.data;
  if (!data || data.__source !== BRIDGE_SOURCE_INJECTED) return;
  const resp = data.payload as InjectedResponse;
  const slot = pending.get(resp.id);
  if (!slot) return;
  pending.delete(resp.id);
  if (resp.ok) slot.resolve(resp.data);
  else slot.reject(new Error(resp.error));
});

/** 向 injected 发送命令并等待响应
 *
 * 这里有意把 cmd 类型放宽,避免 TS 对判别联合 + Omit 在
 * 字面量传参时的过度严格检查;真实的 type/payload 一致性
 * 由 injected/api.ts 里的运行时分发兜底。
 */
export type CallInjected = <T = unknown>(cmd: {
  type: InjectedCommand['type'];
  payload?: unknown;
}) => Promise<T>;

export const callInjected: CallInjected = (cmd) => {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    const full = { ...cmd, id } as InjectedCommand;
    window.postMessage(
      { __source: BRIDGE_SOURCE_CONTENT, payload: full },
      '*',
    );
    // 兜底超时
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`injected command timeout: ${cmd.type}`));
      }
    }, 60_000);
  });
};

/** ---------- 进度上报 ---------- */
const progressListeners = new Set<(e: ProgressEvent) => void>();

export function subscribeProgress(fn: (e: ProgressEvent) => void): () => void {
  progressListeners.add(fn);
  return () => progressListeners.delete(fn);
}

export function reportProgress(event: ProgressEvent) {
  for (const fn of progressListeners) {
    try {
      fn(event);
    } catch (e) {
      log.warn('progress listener error', e);
    }
  }
  chrome.runtime.sendMessage({ __channel: 'progress', event }).catch(() => {
    /* background 可能短暂未就绪,忽略 */
  });
}

/** ---------- 任务执行(消息处理器与页面注入按钮共用) ---------- */

let cancelFlag = { cancelled: false };

export function startExport(args: {
  sourceShopId: string | number;
  sourceShopName?: string;
  limitCount?: number;
  spuNameKeyword?: string;
  spuIdAllowlist?: Array<string | number>;
  /** SKU id 筛选 */
  skuIdList?: Array<string | number>;
  /** SKU 维度的条码(UPC)筛选 */
  skuUpcList?: string[];
  /** 是否一并下载图片(默认 true) */
  includeImages?: boolean;
  includeVideo?: boolean;
  /** 用户已选目录(必须由用户手势触发 showDirectoryPicker 拿到) */
  targetDir: FileSystemDirectoryHandle;
}) {
  cancelFlag = { cancelled: false };
  runExport({
    sourceShopId: args.sourceShopId,
    sourceShopName: args.sourceShopName,
    limitCount: args.limitCount,
    spuNameKeyword: args.spuNameKeyword,
    spuIdAllowlist: args.spuIdAllowlist,
    skuIdList: args.skuIdList,
    skuUpcList: args.skuUpcList,
    includeImages: args.includeImages,
    includeVideo: args.includeVideo,
    targetDir: args.targetDir,
    cancelFlag,
    onProgress: reportProgress,
    callInjected,
  }).catch((e) => {
    log.error('export error', e);
    reportProgress({ kind: 'error', message: String(e?.message ?? e) });
  });
}

export function cancelCurrent() {
  cancelFlag.cancelled = true;
}

export function startImport(args: {
  /** 用户选定的导入源目录 */
  sourceDir: FileSystemDirectoryHandle;
  mapping: import('@shared/types').CategoryMapping;
  mode?: import('@shared/messaging').ImportMode;
  confirmMode?: import('@shared/messaging').ImportConfirmMode;
  /** 是否同步图片(默认 true);false 时跳过上传与图片比对 */
  syncImages?: boolean;
  /** 可选:用户人工维护的「店内分类映射」文件 */
  frontCategoryMappingFile?: File | null;
  /** 手动模式必填:UI 层弹确认框,返回用户决定 */
  requestConfirm?: import('./import').RequestConfirm;
}) {
  cancelFlag = { cancelled: false };
  runImport({
    sourceDir: args.sourceDir,
    mapping: args.mapping,
    mode: args.mode ?? 'full',
    confirmMode: args.confirmMode ?? 'auto',
    syncImages: args.syncImages ?? true,
    frontCategoryMappingFile: args.frontCategoryMappingFile,
    requestConfirm: args.requestConfirm,
    cancelFlag,
    onProgress: reportProgress,
    callInjected,
  }).catch((e) => {
    log.error('import error', e);
    reportProgress({ kind: 'error', message: String(e?.message ?? e) });
  });
}

/** ---------- Popup 指令 ---------- */

chrome.runtime.onMessage.addListener((msg: PopupRequest, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'PING':
          sendResponse({ ok: true, data: 'pong' } satisfies PopupResponse<string>);
          return;

        case 'GET_SHOP_INFO': {
          const info = await callInjected({ type: 'FETCH_SHOP_INFO' });
          sendResponse({ ok: true, data: info } satisfies PopupResponse);
          return;
        }

        case 'GET_SHOP_LIST': {
          const list = await callInjected({ type: 'FETCH_SHOP_LIST' });
          sendResponse({ ok: true, data: list } satisfies PopupResponse);
          return;
        }

        case 'EXPORT_START':
        case 'IMPORT_START':
          // 这两个动作都需要 showDirectoryPicker 的用户手势,popup 触发的链路里
          // 没有有效手势,所以一律回退:在页面里打开对应的入口,把动作转交过去。
          sendResponse({
            ok: false,
            error: '请到牵牛花后台页面点击「📦 导出本店商品」/「📥 导入商品」按钮',
          } satisfies PopupResponse);
          openInPageEntry(msg.type === 'EXPORT_START' ? 'export' : 'import');
          return;

        case 'EXPORT_CANCEL':
        case 'IMPORT_CANCEL':
          cancelCurrent();
          sendResponse({ ok: true, data: 'cancelling' } satisfies PopupResponse<string>);
          return;

        default:
          sendResponse({ ok: false, error: 'unknown command' } satisfies PopupResponse);
      }
    } catch (e) {
      sendResponse({ ok: false, error: (e as Error).message } satisfies PopupResponse);
    }
  })();
  return true; // 异步响应
});

log.info('content script ready');

// 在页面工具栏注入"导出本店商品"按钮 + 浮动进度面板
mountInPageUI();
