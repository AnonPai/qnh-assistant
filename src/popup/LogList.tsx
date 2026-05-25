import { useEffect, useRef } from 'react';

/**
 * 安装软件式滚动进度: 固定 12 行高度,新行从底部进、旧行被挤出顶部,
 * 不让日志量"撑大"宿主面板。父组件追加 entries 时也会按 MAX_LOG_LINES 裁剪。
 */
export const MAX_LOG_LINES = 50;
const VISIBLE_ROWS = 12;

export interface LogEntry {
  level: 'info' | 'success' | 'warn' | 'error';
  index: number;
  total?: number;
  text: string;
}

export function LogList({ entries }: { entries: LogEntry[] }) {
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // 总是滚到底部,模仿安装器"当前正在处理 X"的体验
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries]);

  return (
    <div
      className="log-list"
      ref={listRef}
      style={{ ['--qnh-log-rows' as never]: VISIBLE_ROWS }}
    >
      {entries.length === 0 ? (
        <div className="log-list__empty">等待商品处理…</div>
      ) : (
        entries.map((e) => (
          <div key={e.index} className={`log-row log-row--${e.level}`}>
            <span className="log-row__index">
              {e.index}
              {e.total ? `/${e.total}` : ''}
            </span>
            <span className="log-row__text" title={e.text}>
              {e.text}
            </span>
          </div>
        ))
      )}
    </div>
  );
}
