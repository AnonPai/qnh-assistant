/**
 * Injected Script(运行在页面 MAIN world)
 *
 * 这里所有 fetch 都跑在页面同一上下文,可以:
 *  - 自动带上页面的 cookie / referer / origin
 *  - 复用页面对 fetch / XMLHttpRequest 的拦截器(比如自动加 mtgsig 签名)
 *  - 调用页面 window 上已暴露的工具函数
 *
 * 与 content script 通过 window.postMessage 通信。
 *
 * 实际接口(URL、字段名、返回结构)需要在抓包后填到 ./api.ts 里,
 * 这里只做"分发指令到 api.ts" 的胶水。
 */

import {
  BRIDGE_SOURCE_CONTENT,
  BRIDGE_SOURCE_INJECTED,
  type InjectedCommand,
  type InjectedResponse,
} from '@shared/messaging';
import * as api from './api';

window.addEventListener('message', async (ev) => {
  if (ev.source !== window) return;
  const data = ev.data;
  if (!data || data.__source !== BRIDGE_SOURCE_CONTENT) return;
  const cmd = data.payload as InjectedCommand;
  if (!cmd?.id || !cmd.type) return;

  const send = (resp: InjectedResponse) => {
    window.postMessage({ __source: BRIDGE_SOURCE_INJECTED, payload: resp }, '*');
  };

  try {
    let result: unknown;
    switch (cmd.type) {
      case 'FETCH_SHOP_INFO':
        result = await api.fetchShopInfo();
        break;
      case 'FETCH_SHOP_LIST':
        result = await api.fetchShopList();
        break;
      case 'FETCH_CATEGORY_TREE':
        result = await api.fetchCategoryTree(cmd.payload);
        break;
      case 'FETCH_FRONT_CATEGORY_TREE':
        result = await api.fetchFrontCategoryTree(cmd.payload);
        break;
      case 'FETCH_STORE_RELATION_CATEGORY':
        result = await api.fetchStoreRelationCategory(cmd.payload);
        break;
      case 'CREATE_FRONT_CATEGORY':
        result = await api.createFrontCategory(cmd.payload);
        break;
      case 'FETCH_PRODUCT_LIST':
        result = await api.fetchProductList(cmd.payload);
        break;
      case 'FETCH_PRODUCT_DETAIL':
        result = await api.fetchProductDetail(cmd.payload);
        break;
      case 'FETCH_STORE_SKU_INFO':
        result = await api.fetchStoreSkuInfo(cmd.payload);
        break;
      case 'UPLOAD_MEDIA':
        result = await api.uploadMedia(cmd.payload);
        break;
      case 'CREATE_PRODUCT':
        result = await api.createProduct(cmd.payload);
        break;
      case 'SET_NEW_STORE_PURCHASE':
        result = await api.setNewStorePurchase(cmd.payload);
        break;
      case 'UPDATE_PRODUCT':
        result = await api.updateProduct(
          cmd.payload as Parameters<typeof api.updateProduct>[0],
        );
        break;
      case 'ADJUST_SKU_PRICE':
        result = await api.adjustSkuPrice(cmd.payload);
        break;
      case 'ADJUST_SKU_STOCK':
        result = await api.adjustSkuStock(cmd.payload);
        break;
      default:
        throw new Error(`未实现的指令: ${(cmd as { type: string }).type}`);
    }
    send({ id: cmd.id, ok: true, data: result });
  } catch (e) {
    send({ id: cmd.id, ok: false, error: (e as Error).message });
  }
});

// 标记一下,便于在 console 里确认已注入
(window as unknown as { __qnhInjected?: boolean }).__qnhInjected = true;
console.log('%c[QNH:injected] ready', 'color:#1677ff');
