import { EXTENSION_REFRESH_MESSAGE, type PopupRequest, type PopupResponse, type ProgressEvent } from '@shared/messaging';

/** 给当前 active tab 的 content script 发消息 */
export async function sendToActiveTab<T = unknown>(req: PopupRequest): Promise<PopupResponse<T>> {
  let onQnhPage = false;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id == null) return { ok: false, error: '未找到当前页面' };
    onQnhPage = tab.url?.startsWith('https://qnh.meituan.com/') ?? false;
    const resp = await chrome.tabs.sendMessage(tab.id, req) as PopupResponse<T> | undefined;
    return resp ?? { ok: false, error: onQnhPage ? EXTENSION_REFRESH_MESSAGE : '当前页面未返回响应。' };
  } catch (e) {
    const message = (e as Error).message;
    const needsRefresh = /Extension context invalidated/i.test(message) ||
      (onQnhPage && /Receiving end does not exist|message (?:channel|port) closed/i.test(message));
    return { ok: false, error: needsRefresh ? EXTENSION_REFRESH_MESSAGE : message };
  }
}

/** 监听由 background 广播的进度事件 */
export function onProgress(listener: (event: ProgressEvent) => void): () => void {
  const handler = (msg: unknown) => {
    if (msg && (msg as { __channel?: string }).__channel === 'progress') {
      listener((msg as { event: ProgressEvent }).event);
    }
  };
  chrome.runtime.onMessage.addListener(handler);
  return () => chrome.runtime.onMessage.removeListener(handler);
}
