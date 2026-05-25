import { useEffect, useState } from 'react';
import { ExportPanel } from './ExportPanel';
import { ImportPanel } from './ImportPanel';
import { sendToActiveTab } from './bridge';
import type { ShopInfo } from '@shared/messaging';

type Tab = 'export' | 'import';

export function App() {
  const [tab, setTab] = useState<Tab>('export');
  const [shop, setShop] = useState<ShopInfo | null>(null);
  const [shopErr, setShopErr] = useState<string | null>(null);

  useEffect(() => {
    sendToActiveTab<ShopInfo>({ type: 'GET_SHOP_INFO' })
      .then((r) => {
        if (r.ok) setShop(r.data);
        else setShopErr(r.error);
      })
      .catch((e: Error) => setShopErr(e.message));
  }, []);

  return (
    <div>
      <h1>牵牛花同步助手</h1>
      <div className="subtitle">在同主体的两个账号之间复制门店商品</div>

      <div className="shop-info">
        当前页面:
        {shop ? (
          <span>
            {' '}
            <strong>{shop.shopName ?? '(未识别)'}</strong>
            {shop.shopId ? ` · #${shop.shopId}` : ''}
          </span>
        ) : shopErr ? (
          <span className="error"> 未连接 - {shopErr}</span>
        ) : (
          <span className="muted"> 检测中…</span>
        )}
      </div>

      <div className="tabs">
        <button className={tab === 'export' ? 'active' : ''} onClick={() => setTab('export')}>
          导出
        </button>
        <button className={tab === 'import' ? 'active' : ''} onClick={() => setTab('import')}>
          导入
        </button>
      </div>

      {tab === 'export' ? <ExportPanel /> : <ImportPanel />}
    </div>
  );
}
