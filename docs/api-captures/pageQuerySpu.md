# 商品列表分页 / page-query (租户维度)

> 抓包于商品库列表页 `https://qnh.meituan.com/home.html#/unifiedGoods/tenant/spu-list`

## Endpoint

```
POST https://qnh.meituan.com/qnh-gw3/api/product/tenant/page-query?yodaReady=h5&csecplatform=4&csecversion=4.2.0
```

> 旧版本曾用 `/qnh-gw3/api/product/store/page-query-spu`(店内维度,需要 `storeIdList`),
> 现已切换到本接口。两者请求/响应字段差异较大,迁移时需要重写解析逻辑。

## Request Headers

```
content-type: application/json
m-appkey: fe_recofesaascrm
qnhreferrer: /unifiedGoods/tenant/spu-list
```

> `mtgsig` 由页面 fetch 拦截器自动注入,injected world 直接 fetch 即可。
> 租户身份通过 cookie `_qnh_tenant_id` 识别,**不需要** 传 `storeIdList` / `poiId`。

## Request Body (最小可用集)

```json
{
  "labelInfoList": [],
  "storeFrontGroupCategoryList": [],
  "channelCategory": {
    "channelId": 100,
    "categoryIds": [],
    "categoryProperty": {}
  },
  "page": 1,
  "pageSize": 20,
  "backendCategoryList": []
}
```

**关键参数说明**

| 字段                          | 说明                                  |
|-------------------------------|---------------------------------------|
| `page`                        | 页码,从 1 开始                        |
| `pageSize`                    | 每页数量,典型 20 / 50                 |
| `channelCategory.channelId`   | 100 = 美团闪购(商品库以美团为主)     |
| `backendCategoryList`         | 后台类目过滤,为空表示不过滤          |
| `labelInfoList`               | 标签过滤,为空表示不过滤              |
| `storeFrontGroupCategoryList` | 店内分组前台类目,为空表示不过滤      |

> 抓包样本里没有出现 `spuName` / `upcList` / `spuIdList` / `_t`。
> 代码里仍按 best-effort 透传 `spuName` / `upcList`(后端如忽略,行为退化为常规分页;
> 调用方可在拿到结果后做本地名字 / UPC 精确比对作为兜底)。

## Response 关键字段

```json
{
  "code": 0,
  "msg": "成功",
  "data": {
    "list": [
      {
        "tenantId": 101,
        "spuId": "9000000000000000101",
        "spuName": "示例商品",
        "goodsName": "示例商品",
        "picUrlList": [
          "https://media.example.invalid/sample.jpg",
          "https://media.example.invalid/sample.jpg"
        ],
        "skus": [
          {
            "spuId": "9000000000000000101",
            "skuId": "9000000000000000201",
            "upcList": ["0000000000000"],
            "specName": "示例规格",
            "saleUnit": "份",
            "weightForUnit": "3000",
            "weightUnit": "毫升(ml)",
            "weight": 3000,
            "skuSaleType": 2,
            "childSkuList": [
              {
                "spuId": "9000000000000000102",
                "skuId": "9000000000000000202",
                "skuSpec": "示例规格",
                "amount": 6.0,
                "weightForUnit": "500",
                "weightUnit": "毫升(ml)",
                "picUrl": "https://media.example.invalid/sample.jpg"
              }
            ]
          }
        ],
        "spuChannelInfoList": [
          {
            "channelId": 100,
            "categoryCode": "603",
            "categoryName": "黄啤",
            "categoryCodePath": "601>602>603",
            "categoryNamePath": "酒类>啤酒>黄啤"
          }
        ],
        "onlineChannels": [100, 200, 300, 2911],
        "onlineStatus": 1
      }
    ],
    "page": 1,
    "pageSize": 20,
    "total": 1,
    "totalPage": 1
  }
}
```

## 字段映射 → ProductSpu / ProductSku

| 我们的字段                  | 接口字段                                                                     |
|-----------------------------|------------------------------------------------------------------------------|
| `sourceSpuId`               | `spu.spuId`                                                                  |
| `name`                      | `spu.spuName` (兜底 `spu.goodsName`)                                         |
| `mainImageHashes`(原 URL)   | `spu.picUrlList[]`                                                           |
| `sourceCategoryPath`        | `spuChannelInfoList[channelId=100].categoryCodePath` (split `>`)             |
| `sourceCategoryNamePath`    | `spuChannelInfoList[channelId=100].categoryNamePath` (split `>`)             |
| `sku.sourceSkuId`           | `skus[].skuId`                                                               |
| `sku.specs`                 | `skus[].specName` (解析成 name/value 对)                                     |
| `sku.outerSkuCode`          | `skus[].upcList[0]`                                                          |
| 子商品(组合装)             | `skus[].childSkuList[]` (含 `spuId` / `skuId` / `amount` / `picUrl` 等)      |

> 注意:租户维度接口里 **没有** `storePrice` / `stock` / `onlinePrice` 字段。
> 价格只在 `tenant/detail` 的 `skus[].suggestPrice.tenantSuggestPrice.unifiedSuggestPrice`(建议售价)里返回;
> 库存属于门店覆盖层,主档接口都不返回。

## 与旧 `store/page-query-spu` 的对照

> 旧接口已不再使用,这个表只用于理解历史代码 / 历史导出包。

| 用途              | 旧 store 接口                    | 新 tenant 接口                       |
|-------------------|---------------------------------|--------------------------------------|
| 列表数组          | `data.list[]`                    | `data.list[]` (相同)                 |
| 主图              | `picInfoList[].picUrl`           | `picUrlList[]`                       |
| SKU 列表          | `storeSkuList[]`                 | `skus[]`                             |
| SKU 规格名        | `spec`                           | `specName`                           |
| 渠道类目          | `channelSpuList[].channelCategory.channelCategoryCodePath` | `spuChannelInfoList[].categoryCodePath` |
| 类目名路径        | `channelCategory.channelCategoryNamePath` | `categoryNamePath`              |
| 是否需要 `storeIdList` | 是,按门店过滤              | 否,按租户(cookie)隐式过滤          |

## 门店维度变体 / `product/store/page-query-spu`

> 仅在「门店在售商品」导出场景使用(`scope: 'store'`),响应字段与上面 tenant 端一致。

代码里 `fetchProductListStore` 在请求体里多塞一项 `storeIdList: [String(shopId)]`,
其它字段、解析逻辑都与 tenant 端共用。导出端默认走 store 维度(几千~两万条),
导入端的"按 UPC / 名字查目标店是否已存在"走 tenant 端。
