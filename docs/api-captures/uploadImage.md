# 图片上传 / uploadImageFullType

> 抓包于商品编辑页拖入 / 选择图片时触发。

## Endpoint

```
POST https://qnh.meituan.com/api/v1/image/uploadImageFullType
```

## Request

```
Content-Type: multipart/form-data; boundary=----WebKitFormBoundaryXxx
X-Requested-With: XMLHttpRequest
```

multipart body 只包含一个字段:

| 字段 | 含义                       |
|------|----------------------------|
| file | 图片二进制(`image/jpeg` / `png` / `webp` 等) |

文件名建议传一个有 `.jpg` / `.png` 等扩展名的字符串,接口会按扩展名兜底判 mime。
**注意**:抓包样本里 file 内容长度为 0,实际请求里要把图片字节放进去。

> `mtgsig` / `m-traceid` 等鉴权头由页面 fetch 拦截器自动注入,
> 因此必须从 page world (`injected/api.ts`) 调用,不能在 background 调。

## Response

```json
{
  "code": 0,
  "msg": "成功",
  "success": true,
  "data": {
    "fileUrl":       "https://media.example.invalid/sample.jpg",
    "originFileUrl": "https://media.example.invalid/sample.jpg"
  }
}
```

| 字段           | 说明                                                                 |
|----------------|----------------------------------------------------------------------|
| `fileUrl`      | 缩略图地址(可能带 CDN 缩放后缀),回填到 `picUrlList[]` 等"展示图"字段 |
| `originFileUrl`| 高清原图地址(`0.0.o` 路径段),tenant 形态下创建商品请求体不再显式回填(服务端会自己补);保留供未来扩展 |

## 跟 tenantSpu 字段的回填关系

> 当前实现沿用 `tenant/detail` 的形态,所有图片字段直接是字符串数组(不再有 `picInfoList[].picUrl` 这种包一层的形式)。
> 导入路径下,所有 `media://${hash}` 占位会被统一替换成 `fileUrl`,然后由 `buildTenantSpuV2` 派生 create / update 的 body。

| 目标字段                                                  | 用 fileUrl 还是 originFileUrl |
|-----------------------------------------------------------|-------------------------------|
| `tenantSpu.picUrlList[]`                                  | `fileUrl`                     |
| `tenantSpu.picContentList[]`                              | `fileUrl`                     |
| `tenantSpu.spuChannelInfoList[].specialPictureList[].pictureUrl[]` | `fileUrl`            |
| `tenantSpu.skus[].skuChannelInfoList[].skuPicUrlList[]`   | `fileUrl`（按租户配置返回）   |
| 详情 HTML 中的 `<img src>`                                | `fileUrl`(`description` 实测为空串,目前无效路径) |

> `originFileUrl` 在 tenant 形态下不再被显式回填到请求体 —— 之前 `originPicUrlMapping` 是详情接口
> 服务端给的"缩略图 → 高清原图"映射,客户端创建商品时不需要传,服务端会自己补。
> 这里仍然把 `uploadMedia` 的返回结构里保留 `originFileUrl`,供未来字段需要时直接复用。

## 视频上传

视频走的是 **S3 multipart 直传 + 业务网关签名 + 异步缩略图任务**,跟图片接口完全不同(不是一次 multipart/form-data 直传业务接口)。详见 [uploadVideo.md](./uploadVideo.md)。

简单说就是三段:

1. `POST /common/tenant/upload-api/get-web-upload-sign-with-permission` 拿 AWS v2 签名(分别在 init / 每片 uploadPart / complete 之前各取一次)。
2. 用签名直传到 `https://s3plus.sankuai.com/example-media-bucket/<key>`(init → 多片 PUT → complete 合并)。
3. 调 `create-video-thumbnails` + 轮询 `query-video-thumbnails-job-status` 生成封面;最终视频写回 SPU `videoInfo`,URL 形如 `s3plus.sankuai.com/v1/mss_.../example-media-bucket/<key>`。
