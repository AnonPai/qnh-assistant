import { useEffect, useState } from 'react';
import { onProgress, sendToActiveTab } from './bridge';
import type { ImportSummary, ProgressEvent } from '@shared/messaging';
import { LogList, type LogEntry, MAX_LOG_LINES } from './LogList';

/**
 * 导入面板(Popup 内只展示状态,实际操作必须在页面里完成)
 *
 * 导入也改为"直接读用户选定的目录",同样需要 showDirectoryPicker 的用户手势,
 * 因此入口固定在页面浮动「📥 导入商品」按钮。
 */
export function ImportPanel() {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
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
      if (e.kind === 'import') setRunning(true);
      if (e.kind === 'error') {
        setError(e.message);
        setRunning(false);
      } else if (e.kind === 'done' && 'items' in e.result) {
        setSummary(e.result);
        setRunning(false);
      }
    });
    return off;
  }, []);

  const openInPage = async () => {
    setError(null);
    setSummary(null);
    const r = await sendToActiveTab({ type: 'IMPORT_START' });
    if (!r.ok) setError(r.error);
    else window.close();
  };

  const cancel = async () => {
    await sendToActiveTab({ type: 'IMPORT_CANCEL' });
  };

  return (
    <div>
      <div className="muted" style={{ marginBottom: 8, fontSize: 12, lineHeight: 1.6 }}>
        在页面的项目列表中选择已完成导出的项目，再选择导入模式。
      </div>

      <div className="row">
        <button className="btn primary" onClick={openInPage}>
          打开导入配置
        </button>
        {running && (
          <button className="btn danger" onClick={cancel}>
            取消
          </button>
        )}
      </div>

      {progress && progress.kind === 'import' && <ImportProgressView progress={progress} />}

      {(running || logs.length > 0) && <LogList entries={logs} />}

      {summary && (
        <div className="summary">
          {summary.cancelled ? '导入已取消' : summary.failed ? '导入完成（有失败）' : '✓ 导入完成'} · 共 {summary.total} · 新建{' '}
          <span className="success">{summary.succeeded}</span>
          {summary.updated > 0 && (
            <>
              {' '}
              · 修改 <span className="success">{summary.updated}</span>
            </>
          )}
          {summary.skipped > 0 && (
            <>
              {' '}
              · 跳过 <span className="muted">{summary.skipped}</span>
            </>
          )}
          {summary.failed > 0 && (
            <>
              {' '}
              · 失败 <span className="error">{summary.failed}</span>
            </>
          )}
          {summary.videoMappingFileName && (
            <div style={{ marginTop: 6, lineHeight: 1.5 }}>
              已生成视频补传清单(共 {summary.videoMappingCount} 条),写入源目录:
              <br />
              <code style={{ fontSize: 11 }}>{summary.videoMappingFileName}</code>
            </div>
          )}
          {summary.logFileName && (
            <div style={{ marginTop: 6, lineHeight: 1.5 }}>
              排查日志已写入源目录:
              <br />
              <code style={{ fontSize: 11 }}>{summary.logFileName}</code>
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="progress error" style={{ whiteSpace: 'pre-wrap' }}>
          ✗ {error}
        </div>
      )}
    </div>
  );
}

function phaseLabel(p: 'parse' | 'media' | 'product'): string {
  return { parse: '解析数据包', media: '上传图片', product: '创建/修改商品' }[p];
}

function ImportProgressView({
  progress,
}: {
  progress: Extract<ProgressEvent, { kind: 'import' }>;
}) {
  if (progress.phase === 'category') {
    return (
      <div className="progress" role="status">
        <div className="progress__stage">店内分类</div>
        <div className="progress__detail" title={progress.message}>{progress.message}</div>
        {progress.loading && <progress aria-label="店内分类处理中" style={{ width: '100%' }} />}
      </div>
    );
  }
  const pCur =
    progress.productCurrent ??
    (progress.phase === 'product' ? progress.current : 0);
  const pTotal =
    progress.productTotal ??
    (progress.phase === 'product' ? progress.total : 0);
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
