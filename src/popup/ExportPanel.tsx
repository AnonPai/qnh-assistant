import { useEffect, useState } from 'react';
import { onProgress, sendToActiveTab } from './bridge';
import type { ProgressEvent } from '@shared/messaging';
import { LogList, type LogEntry, MAX_LOG_LINES } from './LogList';

/**
 * 导出面板(Popup 内只展示状态,实际操作必须在页面里完成)
 *
 * 由于浏览器对 File System Access(showDirectoryPicker)的"用户手势"判定
 * 跨不过 popup → content script 这层调用,导出入口已经搬到牵牛花后台页面的
 * 浮动「📦 导出本店商品」按钮上。Popup 仅做"打开页面入口 + 展示进度"。
 */
export function ExportPanel() {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [doneFileName, setDoneFileName] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  useEffect(() => {
    const off = onProgress((e) => {
      if (e.kind === 'log') {
        setLogs((prev) => {
          const next = prev.length >= MAX_LOG_LINES ? prev.slice(-MAX_LOG_LINES + 1) : prev;
          return [...next, { level: e.level, index: e.index, total: e.total, text: e.text }];
        });
        return;
      }
      setProgress(e);
      if (e.kind === 'export') setRunning(true);
      if (e.kind === 'error') {
        setError(e.message);
        setRunning(false);
      } else if (e.kind === 'done') {
        if ('fileName' in e.result) setDoneFileName(e.result.fileName);
        setRunning(false);
      }
    });
    return off;
  }, []);

  const openInPage = async () => {
    setError(null);
    const r = await sendToActiveTab({
      type: 'EXPORT_START',
      payload: { sourceShopId: '' },
    });
    if (!r.ok) setError(r.error);
    else window.close();
  };

  const cancel = async () => {
    await sendToActiveTab({ type: 'EXPORT_CANCEL' });
  };

  return (
    <div>
      <div className="muted" style={{ marginBottom: 8, fontSize: 12, lineHeight: 1.6 }}>
        在页面中选择来源门店，再从项目列表选择或新建导出项目。
      </div>

      <div className="row">
        <button className="btn primary" onClick={openInPage}>
          打开导出配置
        </button>
        {running && (
          <button className="btn danger" onClick={cancel}>
            取消
          </button>
        )}
      </div>

      {progress && progress.kind === 'export' && (
        <ExportProgressView progress={progress} />
      )}

      {(running || logs.length > 0) && <LogList entries={logs} />}

      {doneFileName && (
        <div className="summary">
          ✓ 导出完成 · 产物已写入选定目录
        </div>
      )}

      {error && <div className="progress error">✗ {error}</div>}
    </div>
  );
}

function ExportProgressView({
  progress,
}: {
  progress: Extract<ProgressEvent, { kind: 'export' }>;
}) {
  const pCur =
    progress.productCurrent ??
    (progress.phase === 'detail' || progress.phase === 'list' ? progress.current : 0);
  const pTotal =
    progress.productTotal ??
    (progress.phase === 'detail' || progress.phase === 'list' ? progress.total : 0);
  const pct = pTotal > 0 ? Math.min(100, (pCur / pTotal) * 100) : 0;

  return (
    <div className="progress">
      <div className="progress__head">
        <span className="progress__stage">{phaseLabel(progress.phase)}</span>
        <span className="progress__count">
          商品 {pCur} / {pTotal || '?'}
        </span>
      </div>
      {progress.message && (
        <div className="progress__detail" title={progress.message}>
          {progress.message}
        </div>
      )}
      <div className="bar">
        <div style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function phaseLabel(p: 'list' | 'detail' | 'media' | 'pack'): string {
  return {
    list: '加载商品列表',
    detail: '抓取商品详情',
    media: '下载图片',
    pack: '打包',
  }[p];
}
