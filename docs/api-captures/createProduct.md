# 新建商品主档 / product/tenant/create/v2

> 抓包于 `https://qnh.meituan.com/home.html#/unifiedGoods/tenant/create` 点「保存」时触发。
>
> 这是**租户级商品主档**的创建入口,与 `product/tenant/update/v2` 是配套设计:
> 同一份 `tenantSpu`,创建时 `tenantId: 0` 且无 `spuId`,更新时带真实 `tenantId` 与 `spuId`。
>
> 之前的 `product/store/create` 是"门店端新建"接口,会同时创建主档+门店覆盖+库存初始流水,
> 业务侧"导入商品"应该走主档,因此本工程已经全面切换到这条 v2 接口。

## Endpoint

```
POST https://qnh.meituan.com/qnh-gw3/api/product/tenant/create/v2?yodaReady=h5&csecplatform=4&csecversion=4.2.0
```

## Request Headers

```
content-type: application/json
m-appkey:    fe_recofesaascrm
qnhreferrer: /unifiedGoods/tenant/create
```

`mtgsig` / `m-traceid` 由页面 fetch 拦截器自动注入,**必须从 page world 调用**。

## Request Body 顶层

```jsonc
{
  "tenantSpu":  { /* 见下 */ },
  "dataType":   1,
  "hasAudit":   0,
  "hasDraft":   0,
  "remark":     "/unifiedGoods/tenant/create?"
}
```

> 与 `tenant/update/v2` 不同的是: **没有** `coverageRequest / submitReason / actCheckType`,
> 多了 `dataType / hasAudit / hasDraft / remark` 这一组创建专用字段。
> 顶层完全没有 `storeId / source / createType / storeSpu / adjustStock`,因为是主档接口。

## tenantSpu

与 update v2 的 `tenantSpu` 结构高度同源,差异仅在"创建/修改身份"那几个字段:

| 字段                   | create v2                         | update v2                        |
|------------------------|-----------------------------------|----------------------------------|
| `tenantId`             | **`0`**(占位,服务端按 cookie 决定) | 真实租户 ID                      |
| `spuId`                | **不存在**                         | 必填(目标主档 ID)              |
| `createTime / updateTime` | 不存在                          | detail 透传                      |
| `weightTypeDesc`       | 不存在                            | "标品" 等                        |
| `saleInfo`             | 不存在                            | 1                                |
| `originPlace`          | 字符串,可空 `""`                  | 字符串 `"1"` / `"2"`             |
| `deliveryRequirement`  | 字符串,可空 `""`                  | 字符串 `"0"`                     |
| `coverageInfo / abnormalCodeList / abnormalMarkMsg / noSaleChannelInfoList / customizedChannelName / jumpPageType` | 都不传 | 都给 `null` |
| `medicalDeviceQuaInfo / nameSupplementInfo` | 都不传  | 给 `{ clean: true }`             |

create v2 的 `tenantSpu` 实际包含字段:

```jsonc
{
  "tenantId": 0,
  "spuName": "示例商品",
  "specType": 1,
  "weightType": 3,
  "onlineStatus": 1,
  "productPlace": "",
  "backendCategoryCode": "",
  "brandCode": "501",
  "sellPoint": "",
  "description": "",
  "originPlace": "",
  "deliveryRequirement": "",
  "picUrlList": [ "..." ],
  "picContentList": [ "..." ],
  "properties": [],
  "aiRecommendInfo": { "aiRecommendSellingPoint": false },
  "specialty": 0,
  "depleteMaterial": 0,
  "erpTenantSpuExtend": { "fromErp": 1 },
  "skus": [ /* 见下 */ ],
  "spuChannelInfoList": [ /* 见下 */ ],
  "storeFrontCategoryList": [
    {
      "groupId": 0,
      "storeCategoryList": [{ "categoryCode": "9000000000000000301", "name": "示例分类" }],
      "auxiliaryStoreCategoryList": []
    }
  ]
}
```

注意:
- `storeFrontCategoryList[].storeCategoryList[]` 元素带 **`name`** 字段(update v2 抓包里没有,可不填,这里加上更稳)。
- 若有视频,顶层应有 `videoInfo: { videoUrl, coverImageUrl }`(本商品无视频,字段省略)。

## tenantSpu.skus[]

```jsonc
{
  "specName": "示例规格",
  "saleUnit": "",
  "suggestPrice": { "tenantSuggestPrice": { "unifiedSuggestPrice": "48" } },
  "onlineStatus": 1,
  "onlineChannelType": 1,
  "upcList": ["0000000000000"],
  "externalCode": "",
  "goodsCode": "",
  "manageSNCode": 0,
  "weightForUnit": "3000.000",
  "weightUnit": "毫升(ml)",
  "expirationForUnit": "",
  "expirationUnit": "",
  "cartonMeasureConvertFactorList": [],
  "skuChannelInfoList": [],
  "erpTenantSkuExtend": { "tenantSkuErpGoodsRelList": [] },
  "skuSaleType": 2,
  "childSkuList": [
    {
      "skuId": "9000000000000000202",
      "spuId": "9000000000000000102",
      "spuName": "示例商品",
      "skuSpec": "示例规格",
      "amount": 6,
      "weightForUnit": "500",
      "weightUnit": "毫升(ml)",
      "key": "9000000000000000202",
      "franchiseStatus": null
    }
  ]
}
```

与 update v2 sku 的差异:
- **不带** `skuId`(创建时还没分配)
- **不带** `volume / enableExpiredCheck / comboGroupList / comboType / isSavePromotion / customizeNoUpcCode / useSkuAsUpc / goodsPriceInfo`
- `erpTenantSkuExtend` 简化成 `{ tenantSkuErpGoodsRelList: [] }`(update v2 里多了 `shareStockType / stockUpRoundStatus / stockUpRoundRatio`)

## tenantSpu.spuChannelInfoList[]

每个渠道一条,字段比 update v2 还要丰富(create 时携带了 UI 级元数据):

```jsonc
{
  "channelId": 100,
  "channelName": "美团闪购",
  "loading": false,
  "value": ["601","602","603"],   // 与 categoryCodePath 等价的数组形式
  "idPath": "601>602>603",
  "categoryId": "603",
  "defaultValue": [],
  "categoryName": "黄啤",
  "level": 3,
  "parentCategoryId": "602",
  "supportSpecType": null,
  "children": null,
  "saleAttrInfoVOList": [
    { "attrId": "702", "attrName": "销售规格", "imageRelated": false, "attrSortNum": null, "saleAttrValueList": null },
    { "attrId": "703", "attrName": "存储方式", "imageRelated": false, "attrSortNum": null, "saleAttrValueList": null }
  ],
  "checkUpcStatus": null,
  "upcRequired": 0,
  "resourceType": 1,
  "existedInRetailAndMedicine": null,
  "isExtendCategory": null,
  "medicalDeviceQuaRequirement": 0,
  "dyRecommendId": null,
  "namePath": "示例分类>子分类",
  "categoryCode": "603",
  "categoryCodePath": "601>602>603",
  "categoryNamePath": "酒类>啤酒>黄啤",
  "categoryProperties": [ /* 见下 */ ],
  "specialPictureList": [ /* 同 update v2 渠道侧特殊图 */ ],
  "afterSaleServiceType": "801",
  "saleAttrList": [],
  "skuPicSetting": null
}
```

ch300 多一个 `brandInfo: { channelId: 300, brandCode, brandName }`(京东到家专属)。

`categoryProperties[k]` 元素结构与 create 旧版基本相同(`attrId` 是 number),
**但 `customValue[]` 元素更精简**,只保留有意义的键:
- 普通枚举:`{ attrValueId, attrValue }`(去掉 `douyinDiyType / childrenJson / structAttrValueList:[]`)
- 结构化属性:`{ structAttrValueList: [{ valueList: [[ {sequence, value/optionId/optionValue} ]], formatType }] }`
  - `valueList[i][j]` 元素去掉了 `moduleId / unitId / unitName` 等空字段

## Response

```json
{
  "msg": "",
  "code": 0,
  "data": { "approvalNo": null, "spuId": "9000000000000000101" }
}
```

注意 spuId 在 **`data.spuId`**,而旧的 `store/create` 是顶层 `spuId`。

## 字段映射 → buildTenantSpuV2('create', ...)

实现入口:`src/injected/api.ts` 里的 `createProduct` + `buildTenantSpuV2`(create / update 共用核心)。

1. 把源端 `product` 内 `media://${hash}` 占位符替换成目标账号上传后得到的 `fileUrl`
2. 拿源端 `raw.detail` 当基线
3. 调 `buildTenantSpuV2('create', { product, detail, childSkuMap, frontCategoryIdRemap })` 构造 `tenantSpu`:
   - 顶层 `tenantId: 0`、不带 `spuId`、不带 `createTime / updateTime`
   - `originPlace / deliveryRequirement` 都给空字符串占位
   - 不输出 `coverageInfo / abnormalCodeList / abnormalMarkMsg / noSaleChannelInfoList / customizedChannelName / jumpPageType` 这一组 `null` 字段(那是 update 专属的)
4. `skus[]` 每个 SKU(`buildTenantSkuV2('create', ...)`)
   - 不带 `skuId`(创建时还没分配)
   - 不带 `volume / enableExpiredCheck / comboGroupList / comboType / isSavePromotion / customizeNoUpcCode / useSkuAsUpc / goodsPriceInfo`
   - `erpTenantSkuExtend: { tenantSkuErpGoodsRelList: [] }`
   - `childSkuList[]` 里的源 `spuId/skuId` 用 `childSkuMap`(由调用方在导入"先单品再组合装"过程中累积)替换为目标店里新建后的 ID
5. `spuChannelInfoList[]` 每个渠道(`buildSpuChannelInfoV2('create', ...)`)
   - 携带 UI 级元数据:`loading / value / idPath / categoryId / defaultValue / level / parentCategoryId / saleAttrInfoVOList / checkUpcStatus / dyRecommendId / namePath` 等
   - 渠道侧特殊图 `specialPictureList` 直接平铺挂上(ch100 = 闪购特殊图,ch200 = 饿了么特殊图)
   - ch300 多一个 `brandInfo: { channelId: 300, brandCode, brandName }`(京东到家专属)
6. `storeFrontCategoryList[]` 跨租户必须做 ID 映射:用 `frontCategoryIdRemap`(源 `categoryCode` → 目标 `categoryCode`)改写。映射表由 `import.ts` 在校验阶段建立,缺映射会直接抛错终止流程。
