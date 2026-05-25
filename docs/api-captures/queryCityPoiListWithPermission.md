# 门店列表 / queryCityPoiListWithPermission

> 当前账号下、按城市分组的全部有权限门店。
> 抓包于商品列表页 `https://qnh.meituan.com/home.html#/unifiedGoods/store/spu-list`,
> 点击页面顶部门店选择器时触发。

## Endpoint

```
POST https://qnh.meituan.com/api/v1/common/poi/queryCityPoiListWithPermission
```

> 浏览器实际请求带了 `?yodaReady=h5&csecplatform=4&csecversion=4.2.0`,
> 这是页面 SDK 自动加上的,不传也能通,但保留以减少风险。

## Request Headers

```
accept: application/json, text/plain, */*
accept-language: zh-CN,zh;q=0.9
content-type: application/json
m-appkey: fe_recofesaascrm
m-traceid: <随机串,可缺省>
mtgsig: <由页面拦截器自动生成,injected world 复用页面 fetch 即可>
qnhreferrer: /unifiedGoods/store/spu-list
referer: https://qnh.meituan.com/home.html
sec-fetch-mode: cors
sec-fetch-site: same-origin
```

> 关键签名头 `mtgsig` 在页面 fetch 上有 monkey-patched 拦截器自动注入。
> 因此我们只能在 page world 里用 `fetch(...)` 调用,而不是从 background。

## Request Body

```json
{}
```

## Response

```json
{
  "code": 0,
  "msg": "成功",
  "success": true,
  "data": [
    {
      "cityCode": "301",
      "cityName": "示例城市",
      "poiList": [
        {
          "poiId": 201,
          "poiName": "示例门店",
          "address": "示例地址",
          "status": "有效",
          "statusCode": "1",
          "cityName": "示例城市",
          "areaCode": "401_301",
          "outPoiId": "201",
          "entityType": 3,
          "shippingMode": 2,
          "multiCargoOwner": 0,
          "manageMode": 1
        }
      ]
    }
  ]
}
```

## 字段映射

| 我们的 ShopBrief | 接口字段          |
|------------------|-------------------|
| `shopId`         | `poi.poiId`       |
| `shopName`       | `poi.poiName`     |
| `region`         | `city.cityName`   |

## 调用示例（页面 fetch）

```js
fetch("https://qnh.meituan.com/api/v1/common/poi/queryCityPoiListWithPermission?yodaReady=h5&csecplatform=4&csecversion=4.2.0", {
  "method": "POST",
  "headers": {
    "accept": "application/json, text/plain, */*",
    "content-type": "application/json",
    "m-appkey": "fe_recofesaascrm",
    "qnhreferrer": "/unifiedGoods/store/spu-list"
  },
  "body": "{}",
  "credentials": "include"
});
```
