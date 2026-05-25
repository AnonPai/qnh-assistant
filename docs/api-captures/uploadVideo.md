# 视频上传 / S3 multipart + 视频缩略图任务

> 抓包于商品编辑页选/拖入 mp4 时触发。整体不是「一个 multipart 接口直传文件」,
> 而是 **业务网关签名 + S3plus 直传 + 缩略图异步任务** 三段拼起来。

## 名词约定

| 名词           | 含义                                                                                  |
|----------------|---------------------------------------------------------------------------------------|
| 业务网关       | `https://qnh.meituan.com/common/tenant/upload-api/...`,出 AWS 签名/缩略图任务管理      |
| S3plus         | `https://s3plus.sankuai.com`,S3 v2 协议兼容的对象存储                                  |
| 桶 / bucket    | 业务配置的存储桶，示例值为 `example-media-bucket` |
| object key     | `{timestamp_ms}_{uuid}.mp4`,例:`1700000000000_00000000-0000-4000-8000-000000000001.mp4`                  |
| videoInfo URL  | 最终写回 SPU 的 CDN 地址:`s3plus.sankuai.com/v1/mss_example/example-media-bucket/<key>` |

业务网关请求头里 `mtgsig` / `m-traceid` / `m-appkey` 都由页面拦截器注入,所以
**所有这些请求都必须从 page world(`injected/api.ts`)发,不能从 background 直接 fetch**。
S3plus 的请求允许跨域,但 `Authorization` / `x-amz-date` 由网关返回的签名给出,
我们不需要在客户端实现 AWS 签名算法。

---

## 1. 初始化 multipart(initMultiUpload)

### 1.1 业务网关取签名

```
POST https://qnh.meituan.com/common/tenant/upload-api/get-web-upload-sign-with-permission
Content-Type: application/json
```

```json
{
  "multiple": true,
  "type": "initMultiUpload",
  "sign": true,
  "key": "1700000000000_00000000-0000-4000-8000-000000000001.mp4",
  "contentType": "video/mp4"
}
```

返回(响应体约 193 字节,字段未完整抓到,推断结构):

```json
{
  "code": 0,
  "data": {
    "url": "https://s3plus.sankuai.com/example-media-bucket/<key>?uploads&yodaReady=h5&csecplatform=4&csecversion=4.2.0&mtgsig=...",
    "authorization": "AWS <ACCESS_KEY_ID>:<SIGNATURE>",
    "date": "Tue, 14 Nov 2023 22:13:20 GMT"
  }
}
```

> 实现时建议把响应整体回传给调用方,命名上跟着抓包字段(`url` / `authorization` / `date`)走;
> 字段名等真正实现的时候二次确认,接口可能用 `signedUrl` / `auth` / `xAmzDate` 之类的命名。

### 1.2 用拿到的签名去 S3plus 起 multipart

```
POST <data.url>
Authorization: <data.authorization>
x-amz-date:    <data.date>
content-type:  video/mp4
```

请求体为空。响应是 S3 标准 XML(约 253 字节):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<InitiateMultipartUploadResult>
  <Bucket>example-media-bucket</Bucket>
  <Key>1700000000000_00000000-0000-4000-8000-000000000001.mp4</Key>
  <UploadId>example-upload-id</UploadId>
</InitiateMultipartUploadResult>
```

把 `<UploadId>` 取出来,后面每一片都要带。

---

## 2. 上传分片(uploadPart),按片循环

抓包里这个视频只有 1 片(`partNumber=1`),实际可能要按 chunk 切。
经验上 S3 v2 multipart 单片下限 5MB(最后一片可小)。

### 2.1 业务网关取分片签名

```
POST https://qnh.meituan.com/common/tenant/upload-api/get-web-upload-sign-with-permission
```

```json
{
  "multiple": true,
  "type": "uploadPart",
  "partNumber": 1,
  "uploadId": "example-upload-id",
  "key": "1700000000000_00000000-0000-4000-8000-000000000001.mp4",
  "contentType": "video/mp4",
  "sign": true
}
```

返回结构同 1.1,`url` 形如:

```
https://s3plus.sankuai.com/example-media-bucket/<key>?partNumber=1&uploadId=example-upload-id
```

### 2.2 PUT 分片到 S3plus

```
PUT <data.url>
Authorization: <data.authorization>
x-amz-date:    <data.date>
content-type:  video/mp4
```

请求体 = 该分片的二进制(`Blob.slice(start, end)`)。

响应头里有:

```
ETag: "example-identifier"
```

把 `partNumber` 和 `ETag`(**保留双引号**)记下来,Complete 时要回填。

> 浏览器一般能从 `response.headers.get('ETag')` 拿到;若被 CORS 屏蔽,
> S3plus 通常会带 `Access-Control-Expose-Headers: ETag`,抓包能看到也是直接读到的。

---

## 3. 完成上传(completeMultipartUpload)

### 3.1 业务网关取签名

```
POST https://qnh.meituan.com/common/tenant/upload-api/get-web-upload-sign-with-permission
```

```json
{
  "multiple": true,
  "type": "completeMultipartUpload",
  "uploadId": "example-upload-id",
  "key": "1700000000000_00000000-0000-4000-8000-000000000001.mp4",
  "sign": true,
  "contentType": "video/mp4"
}
```

### 3.2 POST 给 S3plus 完成合并

```
POST <data.url>          # 形如 .../<key>?uploadId=<uploadId>&...
Authorization: <data.authorization>
x-amz-date:    <data.date>
content-type:  video/mp4 (抓包是 video/mp4,实际 S3 一般 application/xml,这里跟着抓包走)
```

请求体 = 按分片顺序拼好的 XML:

```xml
<CompleteMultipartUpload>
  <Part>
    <PartNumber>1</PartNumber>
    <ETag>&quot;example-identifier&quot;</ETag>
  </Part>
  <!-- ... 多片继续 append ... -->
</CompleteMultipartUpload>
```

> 注意 `&quot;`:抓包样本里 ETag 外的双引号被 HTML 转义了。直接用 `"..."` 也能识别,
> 但跟着抓包写最稳。

响应 XML(约 419 字节)里包含最终对象 URL,但更通用的做法是 **不依赖 S3 返回值**,
直接拼 CDN 形式:

```
https://s3plus.sankuai.com/v1/mss_example/example-media-bucket/<key>
```

这就是要写回 `ProductSpu.videoInfo` 的 URL。

> `mss_example` 是示例空间名，实际空间名由业务配置决定。

---

## 4. 触发缩略图任务(可选,但页面会做)

页面在 complete 之后立刻发起一个抽帧任务,用第一秒的画面当封面。

### 4.1 创建任务

```
POST https://qnh.meituan.com/common/tenant/upload-api/create-video-thumbnails
Content-Type: application/json
```

```json
{
  "videoUrl": "https://media.example.invalid/v1/mss_example/example-media-bucket/1700000000000_00000000-0000-4000-8000-000000000001.mp4",
  "thumbnailFormat": "jpg",
  "thumbnailWidth": 480,
  "thumbnailHeight": 360,
  "thumbnailOffset": 1,
  "bucketName": "example-media-bucket",
  "objectName": "1700000000000_00000000-0000-4000-8000-000000000001_1s.jpg"
}
```

返回(约 78 字节):

```json
{ "code": 0, "data": { "taskId": "example-identifier" } }
```

约定:`objectName` 是 `<key 去掉 .mp4>_${thumbnailOffset}s.${thumbnailFormat}`,跟下面查询出的图地址一致。

### 4.2 轮询任务状态

```
POST https://qnh.meituan.com/common/tenant/upload-api/query-video-thumbnails-job-status
Content-Type: application/json
```

```json
{ "taskId": "example-identifier" }
```

抓包里短间隔轮了 3 次(分别 1s 内,响应 91/91/196 字节),最后一次成功。
任务完成后,缩略图直接挂在桶里:

```
https://media.example.invalid/example-media-bucket/1700000000000_00000000-0000-4000-8000-000000000001_1s.jpg
```

> 这个 URL 不需要再经业务网关取,直接 GET 即可显示在编辑页封面位。

---

## 5. 跟 ProductSpu 字段的回填关系

| 目标字段                 | 取值                                                                  |
|--------------------------|-----------------------------------------------------------------------|
| `videoInfo`              | `https://s3plus.sankuai.com/v1/mss_example/example-media-bucket/<key>` |
| 视频封面(若 SPU 有该字段) | `https://s3plus.sankuai.com/example-media-bucket/<key 去 .mp4>_1s.jpg` |

---

## 6. 实现到扩展里的伪代码

```ts
// injected/api.ts (page world)
async function uploadVideo(file: File): Promise<{ videoUrl: string; coverUrl: string }> {
  const key = `${Date.now()}_${crypto.randomUUID()}.${ext(file.name)}`;
  const bucket = 'example-media-bucket';
  const cdnPrefix = 'https://s3plus.sankuai.com/v1/mss_example';

  // 1. init
  const init = await sign({ type: 'initMultiUpload', key, contentType: file.type, sign: true, multiple: true });
  const initRes = await s3(init, { method: 'POST', headers: { 'content-type': file.type } });
  const uploadId = parseXml(await initRes.text(), 'UploadId');

  // 2. parts
  const PART_SIZE = 5 * 1024 * 1024;
  const parts: { PartNumber: number; ETag: string }[] = [];
  for (let i = 0, n = 1; i < file.size; i += PART_SIZE, n++) {
    const chunk = file.slice(i, i + PART_SIZE);
    const part = await sign({
      type: 'uploadPart', partNumber: n, uploadId, key,
      contentType: file.type, sign: true, multiple: true,
    });
    const r = await s3(part, { method: 'PUT', headers: { 'content-type': file.type }, body: chunk });
    parts.push({ PartNumber: n, ETag: r.headers.get('ETag')! });
  }

  // 3. complete
  const complete = await sign({
    type: 'completeMultipartUpload', uploadId, key,
    contentType: file.type, sign: true, multiple: true,
  });
  const xml = `<CompleteMultipartUpload>${parts.map(p =>
    `<Part><PartNumber>${p.PartNumber}</PartNumber><ETag>${p.ETag}</ETag></Part>`
  ).join('')}</CompleteMultipartUpload>`;
  await s3(complete, { method: 'POST', headers: { 'content-type': file.type }, body: xml });

  const videoUrl = `${cdnPrefix}/${bucket}/${key}`;

  // 4. thumbnails (best-effort)
  const objectName = key.replace(/\.[^.]+$/, '_1s.jpg');
  const { taskId } = await post('/common/tenant/upload-api/create-video-thumbnails', {
    videoUrl, thumbnailFormat: 'jpg', thumbnailWidth: 480, thumbnailHeight: 360,
    thumbnailOffset: 1, bucketName: bucket, objectName,
  });
  await poll(() => post('/common/tenant/upload-api/query-video-thumbnails-job-status', { taskId }));
  const coverUrl = `https://s3plus.sankuai.com/${bucket}/${objectName}`;

  return { videoUrl, coverUrl };
}

async function sign(body: any) {
  return post('/common/tenant/upload-api/get-web-upload-sign-with-permission', body)
    .then(r => r.data); // { url, authorization, date } —— 字段名以实际响应为准
}

function s3(s: { url: string; authorization: string; date: string }, init: RequestInit) {
  return fetch(s.url, {
    ...init,
    headers: { ...(init.headers as object), Authorization: s.authorization, 'x-amz-date': s.date },
  });
}
```

---

## TODO / 待确认

1. `get-web-upload-sign-with-permission` 的真实响应字段名(`url` / `signedUrl`?`authorization` / `auth`?)。
   抓包里只看到响应字节数,没看到 body。下次实现时让请求成功跑一次再确定。
2. 业务侧是否对单视频大小有限制(常见 200MB / 500MB)。
3. `mss_example` 的稳定性:不同租户/不同业务是否会换 mss space。
4. SPU schema 里有没有专门的 `coverUrl` / `videoCoverUrl` 字段;如果没有,封面只是页面预览用,不需要回写。
