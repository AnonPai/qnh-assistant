# 门店商品详情 / product/store/detail

> 抓包于门店商品编辑页 `https://qnh.meituan.com/home.html#/unifiedGoods/store/edit`。
>
> 这是**门店覆盖层**详情,与 `tenant/detail`(租户主档)字段差异大。
> 本工程**只**用它补齐 tenant 维度拿不到的两类门店数据:
>   - 库存:`storeSkuList[].stock`
>   - 分渠道零售价:`storeSkuList[].onlinePriceList[].{channelId, onlinePrice}`
>
> 商品主数据(图文 / 渠道 / 属性)仍走 `tenant/detail`,不从这里取。

## Endpoint

```
POST https://qnh.meituan.com/qnh-gw3/api/product/store/detail?yodaReady=h5&csecplatform=4&csecversion=4.2.0
```

## Request Headers

```
content-type: application/json
m-appkey: fe_recofesaascrm
qnhreferrer: /unifiedGoods/store/edit
```

> `mtgsig` 由页面拦截器自动注入。

## Request Body

```json
{ "storeId": 202, "spuId": "9000000000000000103" }
```

## Response 关键字段(只列我们用到的)

```jsonc
{
  "code": 0,
  "data": {
    "storeId": 202,
    "spuId": "9000000000000000103",
    "storeSkuList": [
      {
        "skuId": "9000000000000000203",
        "spec": "示例规格",
        "stock": "1",                 // ← 门店库存(字符串,需 parseFloat)
        "upcList": ["0000000000001"],
        "suggestPrice": 10.5,
        "storePrice": "12.0",         // 线下价,本工程不用
        "onlinePrice": "10.5",         // 顶层兜底零售价
        "onlinePriceList": [           // ← 分渠道零售价(我们的主取值)
          { "channelId": 100, "onlinePrice": "10.5", "syncStrategyType": 1 },
          { "channelId": 200, "onlinePrice": "11.0", "syncStrategyType": 1 }
        ],
        "onlineChannels": [100, 200]
      }
    ]
  }
}
```

## 字段映射 → ProductSku(导出阶段补充)

| ProductSku 字段 | 接口字段 |
|-----------------|----------|
| `stock` | `storeSkuList[].stock`(parseFloat) |
| `channelPrices[]` | `storeSkuList[].onlinePriceList[].{channelId, onlinePrice}` |

> 导出时按 `skuId` 关联(导出当前店时 `sourceSkuId` 即该店真实 `skuId`),
> 关联不上时按 `upcList` 兜底。该接口失败不阻断导出,只是 `stock` / `channelPrices` 留空。

## 用途:「同步库存价格」

导出包带上 `stock` / `channelPrices` 后,`src/content/sync.ts` 在同步时:
1. 按 UPC → 商品名(与导入同款 `lookupExistingForProduct`)在目标门店找到对应 SPU;
2. 拉目标 `store/detail` / `tenant/detail`,按 UPC 把源 SKU 对齐到**目标门店的真实 skuId**;
3. 把 `channelPrices` 下发到 `adjustSkuOnlinePriceSyncStrategy`(分渠道固定价),
   `stock` 下发到 `batchContainer/stockadjustment`(绝对值覆盖)。
