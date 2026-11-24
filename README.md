# 牵牛花商品同步助手 (qnh-assistant)

Edge / Chrome 插件,在美团牵牛花后台两个**同主体**租户之间复制商品主档(含规格、详情图、主图、视频、店内分类等)。

## 工作流程

```
源租户 ──导出──► 本地目录 ──导入──► 目标租户
```

首次使用时，在任一配置窗口点击「选择主目录」或拖入一个文件夹，按浏览器提示授予读写权限。导出、导入和库存价格同步共用这个主目录。

主目录下的每个一级子目录都是一个项目。点击项目名即可选用，列表始终显示同一层的项目。右上角「新增」在主目录下创建项目，行末「重命名」可修改项目目录名。导入和同步使用含有 `manifest.json` 的完整项目。如果已有导出包位于更深的层级，可将它的直接上级文件夹设为主目录。

同一浏览器配置下，刷新或重新打开页面会恢复主目录，以及各项操作上次选用的一级项目。若浏览器已收回权限，点击「重新授权」。

门店商品页的「导入本店商品」可将项目导入选中的目标门店。按条码和商品名查重，已在门店的商品会跳过。仅在主档中存在的匹配商品会记入日志，供后台关联到目标门店。每个 SKU 使用总部建议零售价，各渠道同价时统一设置，异价时保留渠道明细。京东到家多规格商品会在写入前校验规格定义及各 SKU 的取值。采购单价可选，留空时按规格提交空供应关系列表。库存和门店渠道零售价可在新建后通过「同步库存价格」同步。

导出目录结构:

```
manifest.json                # 包元信息(完成后才写,作为"完整"标记)
categories.json              # 源类目快照
media.json                   # hash → 源 URL / mime / size 索引
products/<spuId>.json        # 单商品快照(图/视频引用 = media://${hash})
media/<sha256>.<ext>         # 图片 / 视频(按内容 hash 去重)
.qnh-progress.json           # 续传进度文件(导出中存在,完成后删除)
.qnh-url-hash-cache.json     # 修改前对比用的 URL → SHA-256 缓存(导入侧)
front-category-mapping.txt   # 店内分类映射模板(目标店缺分类时自动写出)
qnh-video-mapping-...txt     # 视频补传清单(导入完成后写出)
```

## 主要功能

**导出(源租户)**

- 目录直写 + 单 SPU 原子提交,中途崩了能从最近一个完成的 SPU 之后续跑
- 媒体按 hash 跨 SPU 去重,目录里同一张图永远只存一份
- 支持「全量」「冒烟样本(前 N 条)」「按 SPU id 清单」「按名字关键词」四种范围
- 组合装父 SPU 抓详情时会自动把子单品的 spuId 加进队列,不漏不重

**导入(目标租户)**

- **全量模式**:UPC 命中 → 走 update 修改路径;未命中 → 走 create 新建路径
- **增量模式**:UPC / 同名命中 → 直接跳过,只把映射写进 childSkuMap 给后面的组合装用
- **修改前对比**:全量模式下命中的 SPU 会做"按内容 hash 比图、按规范化结构比文本"的校验,字面相同就跳过 update,不发请求
- **手动模式**:每次写入(create/update)前等 UI 弹确认,可跳过单条或取消整批
- **图片直链同步**(可选):不下载源图,把目标店写入字段填成源 CDN URL,后端自动拉取
- **跨批次图片复用**：启用图片同步时，扩展在当前浏览器中按目标门店和图片内容保存已核实的图片地址。不同商品、不同导出目录都可复用。再次使用前会下载目标图片核对内容，地址失效或内容改变时重新上传。
- **店内分类自动校验**:目标租户缺分类时一次性列出全部缺失项,生成 `front-category-mapping.txt` 模板,导入流程在这里就终止,不上传任何媒体
- **视频跳过 + 补传清单**:视频上传走 S3 multipart,目前未接通,导入完成后落一份 `qnh-video-mapping-*.txt` 让运营手动补传

**进度面板**

- 顶部:当前阶段进度条(列表 / 详情 / 媒体 / 写入)
- 中部:商品级 ring buffer 日志(最近 N 条),避免几万条 SPU 撑爆 DOM
- 在牵牛花后台页面右下角悬浮,popup 与页面 UI 共用同一份进度事件

## 目录结构

```
src/
  background/   Service Worker:进度转发 + 媒体下载代理
  content/      Content Script(隔离世界):流程编排
    export.ts   导出编排(目录直写 + 续传)
    import.ts   导入编排(创建 / 修改 / 跳过对比 / 视频清单)
    fs-stage.ts File System Access API 包装(读写目录 / JSON / 二进制)
    config-forms.ts  导出 / 导入选项表单(注入到页面 UI)
    inpage-ui.ts     在页面工具栏注入按钮 + 浮动进度面板
  injected/     注入到页面 MAIN world,所有真实接口调用都在这里
    api.ts      ★ 接口适配层(详见 docs/api-captures/*)
    index.ts    Content ↔ Injected 桥的命令分发
  popup/        React UI(扩展弹窗,核心还是页面 UI)
  shared/       消息协议、类型、工具
    messaging.ts             Popup / Content / Background / Injected 消息协议
    types.ts                 ProductSpu / MediaAsset / ImportSummary 等
    hash.ts                  sha256Hex / base64 / Uint8Array 工具
    sleep.ts                 限速 jitter
    logger.ts                带前缀的 console
    url-hash-cache.ts        修改前对比用的 URL → SHA-256 缓存(sidecar)
    normalize-legacy-detail.ts  历史导出包(store/detail 形态)→ tenant 形态
public/
  manifest.json
  icons/
docs/
  api-captures/    抓包记录(URL / 请求体 / 响应结构 / 字段映射)
scripts/
  build.mjs        esbuild 打包(三个 entry:background / content / injected + popup)
  zip-dist.mjs     打 dist-zip/qnh-assistant-x.y.z.zip
  pack-crx.mjs     打 crx(可选)
  gen-icons.mjs / resize-icon.mjs   图标生成
```

## 开发

```bash
npm i
npm run dev          # esbuild 监听式构建,产物输出到 dist/
```

加载插件:

1. 打开 `edge://extensions`
2. 开启「开发人员模式」
3. 点击「加载解压缩的扩展」,选择 `dist/` 目录

> 装好后访问 `https://qnh.meituan.com/home.html#/unifiedGoods/...`,
> 页面工具栏会出现「📦 导出本店商品」「📥 导入商品」按钮 ——
> 这两个动作必须在页面里点(需要用户手势触发 `showDirectoryPicker`),
> 在 popup 里点会被引导回页面。

## 构建发布包

```bash
npm run build        # tsc 类型检查 + esbuild 打包
npm run zip          # 输出 dist-zip/qnh-assistant-x.y.z.zip
```

## 接口抓包文档

`src/injected/api.ts` 已经全部接通真实接口,字段映射的"事实依据"都落在 `docs/api-captures/`:

| 接口 | 文档 |
|------|------|
| 当前账号下门店列表 | [queryCityPoiListWithPermission.md](docs/api-captures/queryCityPoiListWithPermission.md) |
| 商品列表分页(租户 / 门店) | [pageQuerySpu.md](docs/api-captures/pageQuerySpu.md) |
| 商品主档详情 | [productDetail.md](docs/api-captures/productDetail.md) |
| 图片上传 | [uploadImage.md](docs/api-captures/uploadImage.md) |
| 视频上传(S3 multipart,未接通) | [uploadVideo.md](docs/api-captures/uploadVideo.md) |
| 新建商品主档 | [createProduct.md](docs/api-captures/createProduct.md) |
| 修改商品主档 | [updateProduct.md](docs/api-captures/updateProduct.md) |

如果将来接口再有调整,改实现的同时把对应抓包文档也同步更新一下。

## 实现要点

- **MAIN world 调用**:接口必须经过页面的 fetch 拦截器(自动注入 `mtgsig` / `m-traceid`),所以业务请求都跑在 `src/injected/api.ts` 里。content 与 injected 通过 `window.postMessage` 双向通信。
- **媒体代理下载**:跨域 CDN 不开 CORS,但 background service worker 走扩展上下文(配合 `host_permissions`)能拿到响应。所以图片/视频下载走 SW 代理(base64 over message),`src/background/index.ts` 里实现。
- **历史包归一**:早期导出包基于 `store/detail`(店内维度)的字段结构,新版基于 `tenant/detail`(主档维度),`shared/normalize-legacy-detail.ts` 在导入时做一次形态归一,后续 create/update/比对统一按 tenant 形态处理。
- **共用 buildTenantSpuV2**:create v2 与 update v2 的 `tenantSpu` 高度同源,差异点(skuId 是否带、UI 元数据是否带、time/null 占位是否带)由 `direction: 'create' | 'update'` 参数分支,见 `injected/api.ts`。
- **多规格销售属性反聚合**:多规格商品(specType=2)在京东(ch300)/饿了么(ch200)的 `spuChannelInfoList[].saleAttrList` 必填,但源端 detail 经常只填 ch100。代码会按 SKU 上 `skuChannelInfoList[].saleAttrValueList` 反聚合补齐其它渠道,详见 `buildChannelSaleAttrAgg`。

## 限速 & 风控

- 列表分页之间 200~600ms 抖动
- 商品创建之间 800~2000ms 抖动
- 单图上传之间 ~500ms 抖动
- 失败 / 超时:`callInjected` 内置 60s 兜底超时;创建商品本身没有重试(避免重复创建)

## 类目映射

- **渠道类目**(ch100/200/300):跨同主体租户通常一致,默认沿用源类目路径(`spu.sourceCategoryPath`)。`CategoryMapping` 仅在跨类目体系迁移时才需要由 popup 显式传入。
- **店内分类**:跨租户 ID 必然不同,导入前自动校验:同名 namePath 自动匹配 → 仍缺失则写出 `front-category-mapping.txt` 模板,流程终止。用户编辑模板填好"源 namePath ==> 目标 namePath",下次再以"附带映射文件"的方式发起导入即可。

## 安全声明

仅供同主体多租户管理使用;请遵守平台协议,不要用于跨主体的数据搬运。
