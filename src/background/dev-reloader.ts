/**
 * 开发模式热重载(仅 __DEV__ 时存在,生产构建被死代码消除)。
 *
 * 思路 - 自检产物指纹,无需任何外部服务:
 *   1. 每 1s fetch 一次扩展自己的 content.js / injected.js / popup.js
 *   2. 用响应文本的长度 + 头尾片段拼一个轻量指纹
 *   3. 任一文件指纹变化 -> 刷新匹配的 tab + chrome.runtime.reload()
 *
 * 这样只要 esbuild 在 watch 模式输出新文件,扩展就会自动 reload。
 * 用 setTimeout 递归,避免 SW 休眠时 setInterval 漏触发。
 */
const POLL_INTERVAL = 1000;
const WATCHED = ['content.js', 'injected.js', 'background.js'];
const HOST_PATTERNS = [
  'https://e.dianping.com/*',
  'https://*.meituan.com/*',
  'https://*.dianping.com/*',
];

let fingerprints: Record<string, string> = {};
let stopped = false;

async function fingerprint(file: string): Promise<string> {
  const url = chrome.runtime.getURL(file);
  const res = await fetch(url, { cache: 'no-store' });
  const text = await res.text();
  // 长度 + 首尾片段,够判断 watch 重写就行
  return `${text.length}:${text.slice(0, 64)}:${text.slice(-64)}`;
}

async function tick() {
  if (stopped) return;
  try {
    const next: Record<string, string> = {};
    let changed = false;
    for (const f of WATCHED) {
      next[f] = await fingerprint(f);
      if (fingerprints[f] && fingerprints[f] !== next[f]) {
        changed = true;
      }
    }
    const first = Object.keys(fingerprints).length === 0;
    fingerprints = next;
    if (changed && !first) {
      await reloadEverything();
      return; // SW 即将重启
    }
  } catch {
    // 忽略瞬时读取失败
  }
  setTimeout(tick, POLL_INTERVAL);
}

async function reloadEverything() {
  console.log('[QNH:dev] 产物变更,重载…');
  try {
    const tabs = await chrome.tabs.query({ url: HOST_PATTERNS });
    await Promise.all(
      tabs
        .filter((t) => typeof t.id === 'number')
        .map((t) => chrome.tabs.reload(t.id!).catch(() => undefined)),
    );
  } catch (e) {
    console.warn('[QNH:dev] 刷新 tab 失败', e);
  }
  setTimeout(() => chrome.runtime.reload(), 250);
}

export function startDevReloader() {
  if (!__DEV__) return;
  console.log('[QNH:dev] reloader 启动');
  tick();
}
