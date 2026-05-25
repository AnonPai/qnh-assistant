/**
 * 统一日志工具,带前缀,便于在 DevTools 里筛选。
 * 调用示例: const log = createLogger('content');  log.info('xxx');
 */
type Level = 'debug' | 'info' | 'warn' | 'error';

const styleMap: Record<Level, string> = {
  debug: 'color:#888',
  info: 'color:#1677ff',
  warn: 'color:#faad14',
  error: 'color:#ff4d4f;font-weight:bold',
};

export function createLogger(scope: string) {
  const fmt = (level: Level, args: unknown[]) => {
    const tag = `%c[QNH:${scope}]`;
    // eslint-disable-next-line no-console
    (console[level] ?? console.log)(tag, styleMap[level], ...args);
  };
  return {
    debug: (...args: unknown[]) => fmt('debug', args),
    info: (...args: unknown[]) => fmt('info', args),
    warn: (...args: unknown[]) => fmt('warn', args),
    error: (...args: unknown[]) => fmt('error', args),
  };
}
