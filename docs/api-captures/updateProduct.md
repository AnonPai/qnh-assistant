# 修改商品主档 / product/tenant/update/v2

> 抓包于编辑商品页 `https://qnh.meituan.com/home.html#/unifiedGoods/tenant/edit`
> 在主档详情里改完商品名(`雪花花花2 → 雪花花11`)、点「保存」时触发。
>
> 这是**租户级商品主档**的修改入口,不是之前那个 `product/store/update`(门店覆盖层)。
> 业务侧"修改商品"应该改主档,门店侧的差异(店内价/店内库存)走另外的接口,
> 因此本工程把 `updateProduct` 全面切换到这个接口。

## Endpoint

```
POST https://qnh.meituan.com/qnh-gw3/api/product/tenant/update/v2?yodaReady=h5&csecplatform=4&csecversion=4.2.0
```

## Request Headers

```
content-type: application/json
m-appkey: fe_recofesaascrm
qnhreferrer: /unifiedGoods/tenant/edit
```

## Request Body 顶层

```jsonc
{
  "tenantSpu": { /* 见下 */ },
  "coverageRequest": {},
  "submitReason": "",
  "actCheckType": 1
}
```

> 与 `tenant/create/v2` 不同的是:**没有** `dataType / hasAudit / hasDraft / remark`,
> 多了 `coverageRequest / submitReason / actCheckType` 这一组修改专用字段。
> 整个请求只关心租户主档,不涉及门店级数据(价、库存、特殊图覆盖)。

## tenantSpu 关键字段

`tenantSpu` 与 `tenant/create/v2` 的 `tenantSpu` 大体同源,但增加了"主档身份"与一组占位字段。

新增字段(create 没有):

| 字段                           | 含义 / 取值                                  |
|--------------------------------|----------------------------------------------|
| `tenantId`                     | 租户 ID(必填)                              |
| `spuId`                        | 目标主档 ID(必填)                          |
| `createTime` / `updateTime`    | detail 透传                                  |
| `weightTypeDesc`               | "标品" 等(detail 透传)                     |
| `saleInfo`                     | 1                                            |
| `properties`                   | `[]`                                         |
| `depleteMaterial`              | 0                                            |
| `specialty`                    | 0                                            |
| `erpTenantSpuExtend`           | `{ "fromErp": 1 }`                           |
| `productPlace` / `backendCategoryCode` / `brandCode` / `sellPoint` / `description` | 都给空字符串 `""` |
| `videoInfo / medicalDeviceQuaInfo / nameSupplementInfo` | 没值时给 `{ "clean": true }` |
| `aiRecommendInfo`              | `{ "aiRecommendSellingPoint": false }`(create 是 `{}`) |
| `abnormalCodeList / abnormalMarkMsg / noSaleChannelInfoList / coverageInfo` | 都是 `null` |

类型变化(create vs update):
- `originPlace`:create 是 number `1`,update 是 **字符串** `"1"`
- `deliveryRequirement`:字符串 `"0"`(create 没这个字段,update 必带)

去掉的字段(相比 create):
- 顶层 `brand`、`backendCategory`(被打散到 `brandCode`、渠道属性里)
- 顶层 `mtSpecialPictureList` / `elmSpecialPictureList`(下沉到 `spuChannelInfoList[].specialPictureList`)

## tenantSpu.skus[]

| 字段                              | 含义 / 取值                                  |
|-----------------------------------|----------------------------------------------|
| `skuId`                           | 目标 SKU ID(必填)                          |
| `specName / saleUnit / weightForUnit / weightUnit / upcList / suggestPrice / onlineStatus / childSkuList` | 与 create 同源 |
| `onlineChannelType`               | 1                                            |
| `goodsPriceInfo`                  | `null`                                       |
| `externalCode / goodsCode`        | 空字符串                                     |
| `customizeNoUpcCode / manageSNCode` | 0                                          |
| `useSkuAsUpc`                     | `null`                                       |
| `expirationForUnit / expirationUnit` | 空字符串                                  |
| `volume`                          | `{ "clean": true }`(没值时)                |
| `enableExpiredCheck`              | `null`                                       |
| `comboGroupList`                  | `[]`                                         |
| `comboType`                       | `null`                                       |
| `skuChannelInfoList`              | `[]`                                         |
| `cartonMeasureConvertFactorList`  | `[]`                                         |
| `erpTenantSkuExtend`              | `{ tenantSkuErpGoodsRelList:null, erpSaleStatus:null, shareStockType:0, stockUpRoundStatus:2, stockUpRoundRatio:"" }` |
| `skuSaleType`                     | 1=普通 / 2=组合装(detail 透传)             |
| `isSavePromotion`                 | `null`                                       |

## tenantSpu.spuChannelInfoList[]

每个渠道一条,与 create 接口同名同义,但**特殊图下沉到这里**:

```jsonc
{
  "channelId": 100,
  "channelName": null,
  "categoryCode": "603",
  "categoryName": "黄啤",
  "categoryCodePath": "601>602>603",
  "categoryNamePath": "酒类>啤酒>黄啤",
  "categoryProperties": [ /* 与 create 同结构 */ ],
  "saleAttrList": [],
  "skuPicSetting": null,
  "categoryCanModify": null,
  "afterSaleServiceType": "801",
  "brandInfo": { "clean": true },
  "auditInfo": null,
  "channelOnlineStatus": null,
  "materialAuditList": null,
  "qualificationList": null,
  "channelSpuList": null,
  "recommendId": null,
  "categoryId": "603",          // 与 categoryCode 同值,接口里两份都要
  "idPath":   "601>602>603",  // 与 categoryCodePath 同值
  "namePath": "示例分类>子分类",       // 与 categoryNamePath 同值
  "specialPictureList": [ /* 见下 */ ],
  "upcRequired": 0,
  "resourceType": 1,
  "existedInRetailAndMedicine": null,
  "medicalDeviceQuaRequirement": null,
  "supportSpecType": 2
}
```

`specialPictureList[]` 元素结构(与 create 顶层 `mtSpecialPictureList` 元素同源,但多了实际选中图):

```jsonc
{
  "pictureType": 5,
  "pictureTitle": "配料图",
  "pictureDesc": "...",
  "pictureExample": [ /* 平台示例图 URL 数组 */ ],
  "isRequired": 1,
  "isDisplay": 1,
  "numLimit": 4,
  "numMin": 1,
  "pictureUrl": [ "https://media.example.invalid/sample.jpg" ],
  "customized": null
}
```

注意:
- ch100 的特殊图对应原 `mtSpecialPictureList`
- ch200 的特殊图对应原 `elmSpecialPictureList`(数据库 `categoryCanModify=1` 时存在)
- ch300(京东到家)抓包里 `categoryProperties=[]`、不带 `specialPictureList`

## tenantSpu.storeFrontCategoryList[]

与 create 接口同结构。新增 `auxiliaryStoreCategoryList: []` 字段。

## 字段映射 → buildTenantSpuV2('update', ...)

实现细节见 `src/injected/api.ts` 里的 `updateProduct` + `buildTenantSpuV2`(create / update 共用核心):

1. 把源端 `product` 内 `media://${hash}` 占位符替换成目标账号上传后得到的 `fileUrl`
2. 拿源端 `raw.detail`(导出时存下来的快照)作基线
3. 调 `buildTenantSpuV2('update', { product, detail, targetDetail, targetSpuId, ... })` 构造 `tenantSpu`:
   - 顶层填 `tenantId`(从 targetDetail 取)/ `spuId`(目标 ID)/ `createTime / updateTime`(targetDetail 透传)
   - `originPlace` 转字符串、`deliveryRequirement` 默认 `"0"`
   - 空 `videoInfo` / 空 `volume` 自动改成 `{ clean: true }`
   - `aiRecommendInfo: { aiRecommendSellingPoint: false }`
   - `coverageInfo / abnormalCodeList / abnormalMarkMsg / noSaleChannelInfoList / customizedChannelName / jumpPageType` 全给 `null`
   - `medicalDeviceQuaInfo / nameSupplementInfo` 没值时给 `{ clean: true }`
4. `skus[]` 每个 SKU(`buildTenantSkuV2('update', ...)`)
   - 填 `skuId`(从 targetDetail.skus[i].skuId 取,按位对齐)
   - `volume: { clean: true }`(没有真值时)
   - `goodsPriceInfo / useSkuAsUpc / enableExpiredCheck / comboType / isSavePromotion` 给 `null`
   - `comboGroupList: []`
   - `erpTenantSkuExtend` 优先用 targetSku 的(保留 ERP 链接关系),源端没有时给默认占位
5. `spuChannelInfoList[]` 每个渠道(`buildSpuChannelInfoV2('update', ...)`)
   - 把渠道侧 mt/elm 特殊图下沉成 `specialPictureList`
   - `auditInfo / channelOnlineStatus / materialAuditList / qualificationList / channelSpuList / recommendId` 给 `null`
   - 补齐 `categoryId / idPath / namePath`(与 `categoryCode / categoryCodePath / categoryNamePath` 同值)
   - ch300 透传 `brandInfo`,ch100/ch200 给 `{ clean: true }`

## Response

```json
{ "code": 0, "msg": "成功" }
```

返回里**没有** spuId — 这是更新接口,目标 ID 与请求里的 `tenantSpu.spuId` 一致。
