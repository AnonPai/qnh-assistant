/**
 * Background Service Worker
 *
 * 职责(故意保持轻量):
 *  1. 监听插件图标点击 / 转发 popup 与 content 之间的消息
 *  2. 提供"把 Blob 写文件并下载"的能力(content script 也能做,但 background 更稳)
 *  3. 状态的全局缓存:最近一次进度、最近一次结果(便于 popup 重新打开后恢复)
 *
 * 真实的接口调用都留在 content script + injected 里,因为那里能直接复用页面 cookie/签名上下文。
 */

import { createLogger } from '@shared/logger';
import type { ProgressEvent, PopupRequest, PopupResponse } from '@shared/messaging';
import { startDevReloader } from './dev-reloader';

const log = createLogger('background');

interface State {
  lastProgress: ProgressEvent | null;
}

const state: State = {
  lastProgress: null,
};

/** 转发来自 content 的进度事件给 popup(popup 没开就先缓存) */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // content 上报进度
  if (msg && msg.__channel === 'progress') {
    state.lastProgress = msg.event as ProgressEvent;
    // 广播给所有 popup
    chrome.runtime.sendMessage({ __channel: 'progress', event: msg.event }).catch(() => {
      /* popup 未打开会报错,忽略 */
    });
    sendResponse({ ok: true });
    return true;
  }

  // popup 拉取最近进度
  if ((msg as PopupRequest)?.type === 'GET_PROGRESS') {
    const resp: PopupResponse = { ok: true, data: state.lastProgress };
    sendResponse(resp);
    return true;
  }

  // 代理下载远程媒体(图片/视频)
  // - 跨域 CDN 不开 CORS,但 SW 走扩展上下文,只要 manifest 配了 host_permissions 就能拿到响应
  // - 把 http 升级为 https,绕过页面的混合内容拦截
  // - 返回 base64:这条消息只承载单张图/单段视频,体量可控;
  //   尝试过返回 blob URL 让 content 自己 fetch,但 SW 创建的
  //   blob:chrome-extension://... URL 受同源策略限制,content script 在页面源里没法 fetch。
  if (msg?.__channel === 'fetch-media') {
    const { url } = msg as { url: string };
    fetchMediaProxy(url)
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((e: Error) => sendResponse({ ok: false, error: e.message }));
    return true; // 异步响应
  }

  log.debug('未识别消息', msg, sender);
  return false;
});

async function fetchMediaProxy(originalUrl: string): Promise<{
  bytesBase64: string;
  mime: string;
  size: number;
}> {
  const upgraded = originalUrl.replace(/^http:\/\//i, 'https://');
  // 先尝试 https,失败再退回原 URL
  let res: Response;
  try {
    res = await fetch(upgraded, { credentials: 'omit', cache: 'no-store' });
  } catch (e) {
    if (upgraded === originalUrl) throw e;
    res = await fetch(originalUrl, { credentials: 'omit', cache: 'no-store' });
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const buf = await res.arrayBuffer();
  const mime = res.headers.get('content-type') || '';
  return {
    bytesBase64: bufferToBase64(buf),
    mime,
    size: buf.byteLength,
  };
}

function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as unknown as number[]);
  }
  return btoa(bin);
}

chrome.runtime.onInstalled.addListener((details) => {
  log.info('插件安装/更新', details.reason);
});

log.info('service worker started');

// 开发模式热重载(生产构建会被 esbuild 死代码消除)
startDevReloader();
