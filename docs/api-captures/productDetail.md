# 商品主档详情 / product/tenant/detail

> 抓包于编辑商品主档页 `https://qnh.meituan.com/home.html#/unifiedGoods/tenant/edit`,
> 在主档列表点击「编辑」时触发。
>
> 这是**租户级商品主档**的详情入口,与 `tenant/page-query` / `tenant/create-v2` / `tenant/update-v2` 配套。
> 旧的 `product/store/detail`(门店覆盖层)字段差异较大,本工程已不再使用 ——
> 历史导出包靠 `shared/normalize-legacy-detail.ts` 在导入时归一成 tenant 形态。

## Endpoint

```
POST https://qnh.meituan.com/qnh-gw3/api/product/tenant/detail?yodaReady=h5&csecplatform=4&csecversion=4.2.0
```

## Request Headers

```
content-type: application/json
m-appkey: fe_recofesaascrm
qnhreferrer: /unifiedGoods/tenant/edit
```

> `mtgsig` 由页面拦截器自动注入,接口走 cookie `_qnh_tenant_id` 识别租户,**不需要** 传 `storeId`。

## Request Body

```json
{ "spuId": "9000000000000000101" }
```

## Response 关键结构

```jsonc
{
  "code": 0,
  "data": {
    "tenantId": 101,
    "spuId": "9000000000000000101",
    "spuName": "示例商品",
    "goodsName": "示例商品",

    "specType": 2,                 // 1 = 单规格, 2 = 多规格
    "weightType": 3,
    "weightTypeDesc": "标品",
    "onlineStatus": 1,
    "productPlace": "",
    "matchMedicalStandard": null,

    "brand": { "brandCode": "501", "brandName": "示例品牌" },
    "brandName": "示例品牌",

    /* ----------- 主图 / 图文详情 / 视频(直接是字符串数组,与 page-query 一致) ----------- */
    "picUrlList":     [ "https://media.example.invalid/sample.jpg" ],
    "picContentList": [ "https://media.example.invalid/sample.jpg" ],
    "videoInfo": { "videoUrl": "https://media.example.invalid/sample.mp4", "coverImageUrl": "..." },

    /* description 在牵牛花后台未启用,实测都是空串。保留字段以备将来 */
    "description": "",
    "sellPoint": "",

    /* ----------- 渠道特殊图(ch100 闪购 / ch200 饿了么) ----------- */
    "mtSpecialPictureList": [
      {
        "pictureType": 5,
        "pictureTitle": "配料图",
        "pictureExample": [ "..." ],
        "pictureUrl": [ "https://media.example.invalid/sample.jpg" ],
        "isRequired": 1, "isDisplay": 1, "numLimit": 4, "numMin": 1
      }
    ],
    "elmSpecialPictureList": [ /* 同结构,品类不同导致字段元素不同 */ ],

    /* ----------- CDN 缩略图 → 高清原图(0.0.o 路径)字典 ----------- */
    "originPicUrlMapping":     { "https://media.example.invalid/sample.jpg": "https://media.example.invalid/sample.jpg" },
    "originPicContentMapping": { /* 同结构,但作用于 picContentList */ },

    /* ----------- 店内分类(挂载本商品到某个店面前台分类) ----------- */
    "storeFrontCategoryList": [
      {
        "groupId": 0,
        "storeCategoryList": [
          {
            "categoryCode": "9000000000000000301",
            "name": "示例分类",
            "namePath": "示例分类>子分类",
            "channelIdList": [100, 200, 300]
          }
        ],
        "auxiliaryStoreCategoryList": null,
        "allCategoryCodeList": [ "..." ]
      }
    ],

    /* ----------- 渠道列表(每渠道一条:ch100 闪购 / ch200 饿了么 / ch300 京东到家 / ch2911 客无忧 ...) ----------- */
    "spuChannelInfoList": [
      {
        "channelId": 100,
        "channelName": null,
        "categoryCode": "603",
        "categoryName": "黄啤",
        "categoryCodePath": "601>602>603",
        "categoryNamePath": "酒类>啤酒>黄啤",
        "categoryProperties": [             /* 平铺,不再嵌 channelCategory.channelDynamicInfoBizDTOList */
          {
            "attrId": "701",
            "attrName": "品牌",
            "attrValueType": "...",
            "customValue": [ { "attrValueId": "501", "attrValue": "示例品牌" } ],
            "optionList": [ /* …可选值字典,体量大,导出端会瘦身丢弃… */ ]
          }
        ],
        "saleAttrList": [
          { "attrId": "702", "attrName": "销售规格", "saleAttrValueList": [...], "picRelated": false }
        ],
        "skuPicSetting": null,
        "categoryCanModify": null,
        "afterSaleServiceType": "801",
        /* ch300 多一个 brandInfo,京东到家专属 */
        "brandInfo": { "brandCode": "...", "brandName": "示例品牌" },
        "supportSpecType": null,
        "upcRequired": 0,
        "resourceType": 1,
        "channelOnlineStatus": null
      }
    ],

    /* ----------- SKU 列表(原 storeSkuList,现在是 tenant 维度的主档 SKU) ----------- */
    "skus": [
      {
        "tenantId": 101,
        "spuId": "9000000000000000101",
        "skuId": "9000000000000000201",
        "specName": "示例规格",
        "saleUnit": "份",
        "suggestPrice": {
          "tenantSuggestPrice": { "unifiedSuggestPrice": "48" },
          "areaSuggestPriceList": null
        },
        "upcList": [ "0000000000000" ],
        "weightForUnit": "3000",
        "weightUnit": "毫升(ml)",
        "weight": 3000,
        "skuSaleType": 2,
        "onlineStatus": 1,
        "minOrderCount": 1,
        "externalCode": null,
        "goodsCode": null,
        "customizeNoUpcCode": 0,
        "manageSNCode": null,
        "expirationDays": null,
        "expirationUnit": null,
        "expirationForUnit": null,
        /* 组合装才有的子单品列表 */
        "childSkuList": [
          {
            "spuId": "9000000000000000102",
            "skuId": "9000000000000000202",
            "spuName": "示例商品",
            "skuSpec": "示例规格",
            "amount": 6,
            "weightForUnit": "500",
            "weightUnit": "毫升(ml)",
            "picUrl": "https://media.example.invalid/sample.jpg",
            "franchiseStatus": null
          }
        ],
        /* 渠道侧售卖属性(用于多规格,京东 / 饿了么必填) */
        "skuChannelInfoList": [
          {
            "channelId": 100,
            "saleAttrValueList": [
              { "attrId": "704", "attrName": "颜色", "attrValue": "粉色", "attrValueId": null }
            ],
            "skuPicUrlList": null,
            "upc": null
          }
        ],
        "spuPicUrlList": [ "..." ],
        "skuPicUrlList": [ "..." ],
        "onlineChannelType": 1,
        "onlineChannels": [100, 200],
        "volume": null,
        "erpTenantSkuExtend": { /* update 时回写要保留 */ }
      }
    ],

    /* ----------- 元信息 + ERP 拓展 ----------- */
    "createTime": 1700000000000,
    "updateTime": 1700000000000,
    "erpTenantSpuExtend": { "fromErp": 1 },
    "backendCategoryCode": "",
    "deliveryRequirement": 0
  }
}
```

## 与旧 `store/detail` 的对照

代码里没有再调旧接口,这个表只用于理解历史导出包(归一逻辑见 `shared/normalize-legacy-detail.ts`):

| 用途 | 旧 `store/detail`(店内) | 新 `tenant/detail`(主档) |
|------|---------------------------|----------------------------|
| 主图 | `picInfoList[].picUrl` (`{picUrl, isDelete}`) | `picUrlList[]`(直接字符串) |
| 图文详情 | `pictureContents[]` | `picContentList[]` |
| SKU 列表 | `storeSkuList[]` | `skus[]` |
| SKU 规格名 | `spec` | `specName` |
| 价格 | `storePrice` / `onlinePrice`(店内) | `suggestPrice.tenantSuggestPrice.unifiedSuggestPrice`(建议售价) |
| 库存 | `stock` | (主档无库存,门店覆盖层才有) |
| 店内分类 | `tenantMainFrontCategoryList[]`(`frontCategoryId / frontCategoryNamePath`) | `storeFrontCategoryList[].storeCategoryList[]`(`categoryCode / namePath`) |
| 渠道类目 | `channelSpuList[].channelCategory.channelCategoryCodePath` | `spuChannelInfoList[].categoryCodePath`(平铺) |
| 渠道动态属性 | `channelSpuList[].channelCategory.channelDynamicInfoBizDTOList[]` | `spuChannelInfoList[].categoryProperties[]`(平铺) |
| 渠道品牌(京东) | 顶层 `brand` 兼容 | `spuChannelInfoList[ch=300].brandInfo` |
| 影子字段 | `tenantSpuName / tenantPicInfoList / tenantPicContents / tenantVideoInfo` 等 | 没有(本身就是 tenant 维度) |

## 字段映射 → ProductSpu

| ProductSpu 字段 | 接口字段 |
|-----------------|----------|
| `sourceSpuId` | `data.spuId` |
| `name` | `data.spuName`(回退 `goodsName`) |
| `sourceCategoryPath` | `spuChannelInfoList[ch=100].categoryCodePath` split `>` |
| `sourceCategoryNamePath` | `spuChannelInfoList[ch=100].categoryNamePath` split `>` |
| `mainImageHashes`(URL) | `picUrlList[]`(`originPicUrlMapping` 命中时升级到高清) |
| `videoHashes`(URL) | `videoInfo.videoUrl`(若有) |
| `detailHtml` | `description`(实测均为空串) |
| `detailImageHashes`(URL) | `picContentList[]` |
| `skus` | `skus[]` |
| `raw.detail` | 整个 `data`(瘦身后:剔除属性可选值枚举,留作导入端复刻) |

## 字段映射 → ProductSku

| ProductSku 字段 | 接口字段 |
|-----------------|----------|
| `sourceSkuId` | `sku.skuId` |
| `specs` | 优先 `sku.skuChannelInfoList[].saleAttrValueList[]`(`name=attrName, value=attrValue`);全空时回退 `[{ name: '规格', value: sku.specName }]` |
| `price` | `parseFloat(sku.suggestPrice.tenantSuggestPrice.unifiedSuggestPrice)`(回退 `basicPrice`) |
| `originPrice` | 暂无对应字段 |
| `stock` | `undefined`(主档无库存,门店覆盖层才有) |
| `outerSkuCode` | `sku.upcList[0]` |

## 待处理媒体收集到 `raw.__pendingMedia`

导出阶段会下载并替换为 `media://${hash}`,详情见 `src/content/export.ts`。
明确只收集这 4 处图 + 1 处视频:

- 图 1 `picUrlList[]` —— 主图
- 图 2 `picContentList[]` —— 图文详情
- 图 3 `mtSpecialPictureList[].pictureUrl[]` —— 美团闪购渠道特殊图(配料图、营养成分图;服装类目下含 `pictureType=7` 吊牌及洗唛、`pictureType=14` 尺码表)
- 图 4 `elmSpecialPictureList[].pictureUrl[]` —— 饿了么渠道特殊图(同结构,品类不同导致字段元素不同)
- 视频 `videoInfo.videoUrl`

故意不收的:

- `originPicUrlMapping` / `originPicContentMapping` —— 缩略图 → 高清原图字典,导入端会重新生成
- `*.pictureExample[]` —— 平台示例图,非本商品资产
- `description` 内 `<img src>` —— 牵牛花后台未启用,实测为空串
- `skus[].skuChannelInfoList[].skuPicUrlList[]` —— 当前租户尚未启用

## 详情瘦身

接口里每个属性(尤其是 `spuChannelInfoList[].categoryProperties[]`)都附带"可选值字典"
(`attrValueList / optionList / structAttrTemplateList`),例如鞋面材质会列出几百种枚举,
每个商品都重复一份,体积膨胀严重但对"复刻商品"无意义。

实际选中的值在 `customValue[]` 里,导出端只保留 `customValue` 与必要元数据,
其余可选值字典在 `slimDetail()` 里整体丢弃。
