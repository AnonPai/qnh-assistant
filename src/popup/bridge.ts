import type { PopupRequest, PopupResponse, ProgressEvent } from '@shared/messaging';

/** 给当前 active tab 的 content script 发消息 */
export async function sendToActiveTab<T = unknown>(req: PopupRequest): Promise<PopupResponse<T>> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { ok: false, error: '未找到当前页面' };
  try {
    const resp = (await chrome.tabs.sendMessage(tab.id, req)) as PopupResponse<T>;
    return resp ?? { ok: false, error: '空响应,可能未注入 content script' };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
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
