import { useEffect, useMemo, useState } from 'react';
import { sendToActiveTab } from './bridge';
import type { ShopBrief } from '@shared/messaging';

interface Props {
  /** 标题前缀,如 "源门店" / "目标门店" */
  label: string;
  value: string | number | null;
  onChange: (shopId: string | number | null, shop: ShopBrief | null) => void;
  /** 是否禁用(导出/导入进行中) */
  disabled?: boolean;
}

/**
 * 选择当前账号下的某一家门店。
 * - 自动拉取门店列表,带搜索框
 * - 拉取失败展示错误,可重试
 */
export function ShopSelect({ label, value, onChange, disabled }: Props) {
  const [shops, setShops] = useState<ShopBrief[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState('');

  const load = async () => {
    setLoading(true);
    setError(null);
    const r = await sendToActiveTab<ShopBrief[]>({ type: 'GET_SHOP_LIST' });
    setLoading(false);
    if (r.ok) {
      setShops(r.data ?? []);
    } else {
      setError(r.error);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    if (!shops) return [];
    const k = keyword.trim().toLowerCase();
    if (!k) return shops;
    return shops.filter(
      (s) =>
        String(s.shopId).includes(k) ||
        s.shopName.toLowerCase().includes(k) ||
        s.region?.toLowerCase().includes(k),
    );
  }, [shops, keyword]);

  return (
    <div className="shop-select">
      <div className="shop-select__head">
        <span className="shop-select__label">{label}</span>
        <button
          className="btn btn--ghost"
          onClick={load}
          disabled={loading || disabled}
          title="重新加载"
        >
          {loading ? '加载中…' : '刷新'}
        </button>
      </div>

      {error && (
        <div className="progress error">
          ✗ 加载失败:{error}
        </div>
      )}

      {shops && shops.length > 0 && (
        <>
          <input
            className="shop-select__search"
            placeholder="搜索门店名/编号/城市"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            disabled={disabled}
          />
          <select
            className="shop-select__list"
            size={Math.min(6, Math.max(3, filtered.length))}
            value={value == null ? '' : String(value)}
            disabled={disabled}
            onChange={(e) => {
              const v = e.target.value;
              const hit = filtered.find((s) => String(s.shopId) === v) ?? null;
              onChange(hit ? hit.shopId : null, hit);
            }}
          >
            {filtered.map((s) => (
              <option key={String(s.shopId)} value={String(s.shopId)}>
                {s.shopName}
                {s.region ? ` · ${s.region}` : ''} · #{s.shopId}
              </option>
            ))}
          </select>
          <div className="muted" style={{ fontSize: 12 }}>
            共 {shops.length} 家,已筛选 {filtered.length} 家
          </div>
        </>
      )}

      {shops && shops.length === 0 && !error && (
        <div className="muted">当前账号下没有可管理的门店</div>
      )}
    </div>
  );
}
