/**
 * 牵牛花后台接口适配层(运行在页面 MAIN world)
 *
 * ========================== 重要 ==========================
 * 下面所有函数都是"占位骨架",真实 URL / 入参 / 返回结构需要
 * 通过抓包把以下接口确认下来,再回填:
 *
 *   1. 店铺/账号信息
 *   2. 类目树
 *   3. 商品分页列表
 *   4. 商品详情(SPU + SKU + 图文 + 视频)
 *   5. 图片上传
 *   6. 视频上传
 *   7. 商品创建/编辑
 *
 * 抓包步骤:
 *   - F12 → Network 过滤 XHR/Fetch
 *   - 在牵牛花后台依次操作:进入商品列表 / 编辑商品 / 上传图片 / 新建商品
 *   - 把每个接口的 cURL 复制下来,逐一翻译成下面的函数
 *
 * 抓包小贴士:
 *   - 接口域名常见 e.dianping.com / w.meituan.com / cas.dianping.com
 *   - 表单 multipart 上传可以直接用 FormData,fetch 会自动设置 boundary
 *   - 如果请求头里看到 mtgsig / mtgcsig,通常是页面里某个 SDK 自动加的,
 *     直接用 fetch 一般也会被拦截器加上;若没加,看 fetchWithSign 备注
 * ==========================================================
 */

import { base64ToBytes } from '@shared/hash';
import { jdStoreSpecs } from '@shared/store-specs';
import type {
  CategorySnapshot,
  ProductSpu,
} from '@shared/types';
import type { FrontCategoryNode, FrontCategoryTree, ProductListPage, ShopBrief, ShopInfo } from '@shared/messaging';

// ---- 通用工具 ----

const DEFAULT_CSEC_VERSION = '4.3.0';
let cachedCsecVersion: string | undefined;

function isCsecVersion(value: string | null | undefined): value is string {
  return !!value && /^\d+(?:\.\d+){1,3}$/.test(value);
}

function compareVersion(a: string, b: string): number {
  const aa = a.split('.').map((item) => Number(item));
  const bb = b.split('.').map((item) => Number(item));
  const len = Math.max(aa.length, bb.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (aa[i] ?? 0) - (bb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function rememberCsecVersion(value: string | null | undefined) {
  if (!isCsecVersion(value)) return;
  if (!cachedCsecVersion || compareVersion(value, cachedCsecVersion) > 0) {
    cachedCsecVersion = value;
  }
}

function rememberCsecVersionFromUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl, location.origin);
    rememberCsecVersion(url.searchParams.get('csecversion'));
  } catch {
    // ignore invalid resource names
  }
}

function detectCsecVersionFromPerformance(): string | undefined {
  for (const entry of performance.getEntriesByType('resource')) {
    rememberCsecVersionFromUrl((entry as PerformanceResourceTiming).name);
  }
  return cachedCsecVersion;
}

function currentCsecVersion(): string {
  return cachedCsecVersion ?? detectCsecVersionFromPerformance() ?? DEFAULT_CSEC_VERSION;
}

function qnhApiPath(path: string): string {
  const url = new URL(path, location.origin);
  url.searchParams.set('yodaReady', 'h5');
  url.searchParams.set('csecplatform', '4');
  url.searchParams.set('csecversion', currentCsecVersion());
  return `${url.pathname}${url.search}`;
}

/**
 * 站内 fetch:同 origin 默认带 cookie。
 * 如果遇到签名拦截器没自动生效的情况,可以改成 await window.fetch(...)
 * 或者寻找页面上的 ajax 工具(如 window.__APP__.request)。
 */
async function siteFetch<T = unknown>(
  input: RequestInfo, init?: RequestInit, parseJson?: (text: string) => T,
): Promise<T> {
  if (typeof input === 'string') rememberCsecVersionFromUrl(input);
  else rememberCsecVersionFromUrl(input.url);
  const res = await fetch(input, {
    credentials: 'include',
    ...init,
    headers: {
      Accept: 'application/json,text/plain,*/*',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} @ ${typeof input === 'string' ? input : input.url}`);
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return parseJson ? parseJson(await res.text()) : (await res.json()) as T;
  return (await res.text()) as unknown as T;
}

function parseProductResponse<T>(text: string): T {
  return JSON.parse(text, (key, value, context?: { source?: string }) => {
    // 商品接口也会用 JSON 数字返回长 ID。用原始数字文本保留完整编号。
    if (typeof value === 'number' && !Number.isSafeInteger(value) &&
        ['skuId', 'spuId', 'categoryId', 'parentCategoryId'].includes(key)) {
      const source = context?.source;
      if (source && /^\d+$/.test(source)) return source;
    }
    return value;
  }) as T;
}

// ============================================================
// 1) 店铺信息(当前账号 / 当前选中门店)
// ============================================================
export async function fetchShopInfo(): Promise<ShopInfo> {
  // TODO: 替换为真实接口
  // 示例占位:从页面右上角 DOM 读
  const shopName = document.querySelector('[data-qnh="shop-name"]')?.textContent?.trim();
  return {
    shopId: undefined,
    shopName: shopName || undefined,
    accountName: undefined,
  };
}

// ============================================================
// 1.5) 当前账号下的门店列表
//      接口: POST /core/poi/b/store/selector/agg-by-city
// ============================================================
interface StoreSelectorAggByCityResp {
  code: number;
  msg?: string;
  data?: Array<{
    cityCode?: number | string;
    cityName?: string;
    storeList?: Array<{
      storeId: number | string;
      storeName: string;
      storeStatus?: number;
      addressInfo?: {
        provinceName?: string;
        cityName?: string;
        areaName?: string;
        detailAddr?: string;
      } | null;
    }>;
  }>;
}

export async function fetchShopList(): Promise<ShopBrief[]> {
  const data = await siteFetch<StoreSelectorAggByCityResp>(
    qnhApiPath('/core/poi/b/store/selector/agg-by-city'),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'm-appkey': 'fe_recofesaascrm',
        qnhreferrer: '/unifiedGoods/store/spu-list',
      },
      body: JSON.stringify({ statusList: [1, 2] }),
    },
  );
  if (data?.code !== 0) {
    throw new Error(`门店列表接口失败: ${data?.msg ?? 'unknown'}`);
  }
  const result: ShopBrief[] = [];
  for (const city of data.data ?? []) {
    for (const store of city.storeList ?? []) {
      result.push({
        shopId: store.storeId,
        shopName: store.storeName,
        region: city.cityName ?? store.addressInfo?.cityName,
      });
    }
  }
  return result;
}

// ============================================================
// 2) 类目树(可能因门店类型不同而不同,故按 shopId 拉)
// ============================================================
export async function fetchCategoryTree(payload: { shopId: string | number }): Promise<CategorySnapshot[]> {
  // TODO: 替换为真实接口,返回扁平类目数组
  // const data = await siteFetch<...>(`/api/category/tree?shopId=${payload.shopId}`);
  void payload;
  return [];
}

// ============================================================
// 2.5) 店内前台分类树
//      接口: POST /qnh-gw3/api/product/support/front-category/query
//
// 这是「店内分类」专用,与上面 channel 类目不同 —— ID 由租户自己分配,
// 跨租户无法直接复用,导入前需要按"分类名称路径"做映射。
// 后端把整棵树编码进 data 字段(JSON 字符串)。
// ============================================================
interface FrontCategoryQueryResp {
  code: number;
  msg?: string;
  /** 服务端把整棵树序列化为 JSON 字符串放在 data 里 */
  data?: string | { categoryList?: RawFrontCategory[]; storeGroupId?: string | number };
}

interface RawFrontCategory {
  categoryId: string | number;
  parentCategoryId: string | number;
  storeGroupId?: string | number;
  name: string;
  level: number;
  enable: number;
  children?: RawFrontCategory[];
}

export async function fetchFrontCategoryTree(payload: {
  shopId: string | number;
  storeGroupId?: number;
}): Promise<FrontCategoryTree> {
  const { storeGroupId } = payload;
  const resp = await siteFetch<FrontCategoryQueryResp>(
    qnhApiPath('/qnh-gw3/api/product/support/front-category/query'),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'm-appkey': 'fe_recofesaascrm',
        qnhreferrer: storeGroupId ? '/unifiedGoods/front-category' : '/unifiedGoods/store/create',
      },
      body: JSON.stringify({ storeGroupId: storeGroupId ?? 0, sceneIdentity: storeGroupId ? 20 : 10, storeSpuCustomFlag: 0 }),
    },
    parseProductResponse,
  );
  if (resp?.code !== 0 || !resp.data) {
    throw new Error(`店内分类接口失败: ${resp?.msg ?? 'unknown'}`);
  }
  let parsed: Exclude<FrontCategoryQueryResp['data'], string | undefined>;
  try {
    parsed = typeof resp.data === 'string' ? parseProductResponse(resp.data) : resp.data;
  } catch {
    throw new Error('店内分类接口返回数据无法解析');
  }
  if (storeGroupId && !Array.isArray(parsed.categoryList) && parsed.storeGroupId == null) {
    throw new Error('接口未返回目标分组的分类列表。');
  }
  const groups = new Set<number>();
  const collectGroup = (value?: string | number) => {
    const id = Number(value);
    if (Number.isSafeInteger(id) && id > 0) groups.add(id);
  };
  collectGroup(parsed.storeGroupId);
  const trim = (n: RawFrontCategory): FrontCategoryNode => {
    collectGroup(n.storeGroupId);
    return {
      categoryId: String(n.categoryId), parentCategoryId: String(n.parentCategoryId ?? '0'),
      name: n.name, level: n.level, enable: n.enable, children: (n.children ?? []).map(trim),
    };
  };
  const categories = (parsed.categoryList ?? []).map(trim);
  if (storeGroupId && [...groups].some(group => group !== storeGroupId)) {
    throw new Error('返回的店内分类与指定分组不一致。');
  }
  return { categories, storeGroupId: groups.size === 1 ? [...groups][0] : undefined };
}

export async function fetchStoreRelationCategory({ shopId }: { shopId: string | number }): Promise<{ storeId: number }> {
  const storeId = numericStoreId(shopId);
  const resp = await siteFetch<{ code: number; success?: boolean; msg?: string; data?: unknown }>(
    qnhApiPath('/qnh-gw3/api/product/support/front-category/query-store-relation-category'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'm-appkey': 'fe_recofesaascrm',
        qnhreferrer: '/unifiedGoods/front-category',
      },
      body: JSON.stringify({ storeId, needChannelException: true, needHasPriceAdjustRate: true, needRelationSpuCount: true }),
    },
  );
  if (resp?.code !== 0 || resp.success === false) throw new Error(resp?.msg ?? '门店关联分类查询失败。');

  let data = resp.data;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { throw new Error('门店关联分类响应无法解析。'); }
  }
  if (data && typeof data === 'object' && 'storeId' in data && data.storeId != null &&
      String(data.storeId) !== String(storeId)) {
    throw new Error('返回的关联分类与所选门店不一致。');
  }
  return { storeId };
}

export async function createFrontCategory({ storeGroupId, parentCategoryId, name }: {
  storeGroupId: number;
  parentCategoryId: string;
  name: string;
}) {
  if (!Number.isSafeInteger(storeGroupId) || storeGroupId <= 0 || !/^\d+$/.test(parentCategoryId) || !name.trim()) {
    throw new Error('创建分类需要有效的分类分组、父级 ID 和名称。');
  }
  const resp = await siteFetch<{ code: number; success?: boolean; msg?: string }>(
    qnhApiPath('/qnh-gw3/api/product/support/front-category/create'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'm-appkey': 'fe_recofesaascrm',
        qnhreferrer: '/unifiedGoods/front-category',
      },
      body: JSON.stringify({ parentCategoryId, storeGroupId, sceneIdentity: 20, storeSpuCustomFlag: 0, name, channelIdList: [0] }),
    },
  );
  if (resp?.code !== 0 || resp.success === false) throw new Error(resp?.msg ?? '店内分类创建失败');
}

// ============================================================
// 3) 商品列表分页(租户维度)
//    接口: POST /qnh-gw3/api/product/tenant/page-query
//    详见 docs/api-captures/pageQuerySpu.md
//
// 注意:这是「商品库 / 总店」级别的列表,不带 storeIdList,
//      返回结果包含整个租户的商品(以 cookie 里的 _qnh_tenant_id 为准)。
//      原 store/page-query-spu 是店内维度,响应字段名差异较大,这里全部按
//      tenant 端返回结构(`picUrlList` / `skus` / `spuChannelInfoList` 等)解析。
// ============================================================

interface PageQuerySpuResp {
  code: number;
  msg?: string;
  data?: {
    list?: RawSpuItem[];
    page?: number;
    pageSize?: number;
    total?: number;
    totalPage?: number;
  };
}

interface RawListSku {
  skuId?: string | number;
  upc?: string | null;
  upcList?: string[] | null;
}

interface RawSpuItem {
  spuId: string | number;
  spuName?: string;
  goodsName?: string;
  picUrlList?: string[];
  skus?: RawListSku[];
  storeSkuList?: RawListSku[];
  spuChannelInfoList?: Array<{
    channelId?: number;
    categoryCode?: string;
    categoryName?: string;
    categoryCodePath?: string;
    categoryNamePath?: string;
  }>;
}

export async function fetchProductList(payload: {
  shopId: string | number;
  pageNo: number;
  pageSize: number;
  /**
   * 商品名关键词。租户端 page-query 的捕获请求里没有出现该字段,
   * 此处沿用旧接口的字段名作为 best-effort 透传:
   *   - 后端如支持 → 模糊匹配按名筛选
   *   - 后端如忽略 → 行为退化为常规分页
   * 调用方仍可在拿到结果后做本地名字精确比对(import.ts 已经这么做)
   */
  spuName?: string;
  /**
   * UPC 列表过滤,best-effort 透传(同上)。
   * import 端的"按 UPC 查目标租户"依赖此参数;如果后端不再支持,
   * 退化结果是 lookupExistingForProduct 落到名字兜底分支,不影响功能正确性。
   */
  upcList?: string[];
  /**
   * SKU id 列表过滤,best-effort 透传(同上)。后端如忽略,
   * 调用方可按返回的规格列表本地精确比对。
   */
  skuIdList?: Array<string | number>;
  /**
   * 拉哪个维度的商品列表:
   *   - 'tenant'(默认):租户主档(整个租户全部商品,几万条)。
   *      import 端做"目标租户是否已存在"查询时用这个。
   *   - 'store':门店维度,只列出当前门店在售/在架商品(通常一两万条)。
   *      export 走这个,避免把整个租户主档当成单店商品导出。
   */
  scope?: 'tenant' | 'store';
}): Promise<ProductListPage> {
  if (payload.scope === 'store') {
    return fetchProductListStore(payload);
  }
  return fetchProductListTenant(payload);
}

/** tenant 维度(原默认实现):整个租户的商品主档分页 */
async function fetchProductListTenant(payload: {
  shopId: string | number;
  pageNo: number;
  pageSize: number;
  spuName?: string;
  upcList?: string[];
  skuIdList?: Array<string | number>;
}): Promise<ProductListPage> {
  void payload.shopId; // 租户端接口不再需要 shopId,通过 cookie 上下文识别租户

  const body: Record<string, unknown> = {
    labelInfoList: [],
    storeFrontGroupCategoryList: [],
    channelCategory: { channelId: 100, categoryIds: [], categoryProperty: {} },
    page: payload.pageNo,
    pageSize: payload.pageSize,
    backendCategoryList: [],
  };

  // best-effort 透传过滤参数:仅在调用方传入时附带,避免改变默认请求体形态
  if (payload.spuName) body.spuName = payload.spuName;
  if (payload.upcList && payload.upcList.length > 0) body.upcList = payload.upcList;
  if (payload.skuIdList && payload.skuIdList.length > 0) {
    body.skuIdList = payload.skuIdList.map(String);
  }

  const data = await siteFetch<PageQuerySpuResp>(
    qnhApiPath('/qnh-gw3/api/product/tenant/page-query'),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'm-appkey': 'fe_recofesaascrm',
        qnhreferrer: '/unifiedGoods/tenant/spu-list',
      },
      body: JSON.stringify(body),
    },
  );

  if (data?.code !== 0) {
    throw new Error(`商品列表接口失败: ${data?.msg ?? 'unknown'}`);
  }

  return mapPageQueryResp(data);
}

/**
 * store 维度:只列出当前门店"在架/在售"的 SPU。
 * 接口: POST /qnh-gw3/api/product/store/page-query-spu
 *   - 通过 storeIdList 限定门店
 *   - SKU 列表兼容 skus 和 storeSkuList
 *   - 总数对应"门店商品"页签上看到的数量(几千~两万级)
 */
async function fetchProductListStore(payload: {
  shopId: string | number;
  pageNo: number;
  pageSize: number;
  spuName?: string;
  upcList?: string[];
  skuIdList?: Array<string | number>;
}): Promise<ProductListPage> {
  const body: Record<string, unknown> = {
    labelInfoList: [],
    storeFrontGroupCategoryList: [],
    channelCategory: { channelId: 100, categoryIds: [], categoryProperty: {} },
    page: payload.pageNo,
    pageSize: payload.pageSize,
    backendCategoryList: [],
    storeIdList: [String(payload.shopId)],
  };

  if (payload.spuName) body.spuName = payload.spuName;
  if (payload.upcList && payload.upcList.length > 0) body.upcList = payload.upcList;
  if (payload.skuIdList && payload.skuIdList.length > 0) {
    body.skuIdList = payload.skuIdList.map(String);
  }

  const data = await siteFetch<PageQuerySpuResp>(
    qnhApiPath('/qnh-gw3/api/product/store/page-query-spu'),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'm-appkey': 'fe_recofesaascrm',
        qnhreferrer: '/unifiedGoods/store/spu-list',
      },
      body: JSON.stringify(body),
    },
    parseProductResponse,
  );

  if (data?.code !== 0) {
    throw new Error(`门店商品列表接口失败: ${data?.msg ?? 'unknown'}`);
  }

  return mapPageQueryResp(data);
}

function readSkuUpcs({ upcList, upc }: RawListSku): string[] {
  return [...new Set([...(upcList ?? []), upc].filter(Boolean).map(String))];
}

/** 保留规格与条码的关联，也提供导入查询使用的商品级条码列表。 */
function mapPageQueryResp(data: PageQuerySpuResp): ProductListPage {
  const list = (data.data?.list ?? []).map((spu) => {
    const skus = [...(spu.skus ?? []), ...(spu.storeSkuList ?? [])].map(sku => ({
      skuId: sku.skuId,
      upcList: readSkuUpcs(sku),
    }));
    return {
      spuId: spu.spuId,
      name: spu.spuName?.trim() || spu.goodsName?.trim() || String(spu.spuId),
      upcList: [...new Set(skus.flatMap(sku => sku.upcList))],
      skus,
    };
  });
  return {
    list,
    total: data.data?.total ?? list.length,
  };
}

// ============================================================
// 4) 商品主档详情(租户维度)
//    接口: POST /qnh-gw3/api/product/tenant/detail
//    详见 docs/api-captures/productDetail.md
//
// 注意:这是「商品主档」详情,与之前的 store/detail(店内维度)字段差异较大:
//   - 主图:`picUrlList`(string[]),不再有 `picInfoList[].picUrl`
//   - 图文详情:`picContentList`(string[]),不再有 `pictureContents`
//   - SKU 列表:`skus[]`,字段 `specName`(原 `spec`),不再有 `storePrice`/`onlinePrice`/`stock`
//             (这些是店内维度概念);价格统一从 `suggestPrice.tenantSuggestPrice.unifiedSuggestPrice` 取
//   - 渠道:`spuChannelInfoList[]`,字段平铺 `categoryCode/categoryCodePath/categoryNamePath`
//          (原 `channelSpuList[].channelCategory.channelCategoryXxx`),
//          属性 `categoryProperties`(原 `channelDynamicInfoBizDTOList`)
//   - 店内分类:`storeFrontCategoryList`(原 `tenantMainFrontCategoryList`)
//   - 渠道品牌:仍是 ch100「品牌」属性 customValue;ch300 看 spuChannelInfoList[ch300].brandInfo
//   - 没有 `tenantXxx` 影子字段(这本身就是 tenant 维度)
// ============================================================

interface ProductDetailResp {
  code: number;
  msg?: string;
  data?: RawProductDetail;
}

/** 商品主档详情(对应 tenant/detail 接口响应) */
interface RawProductDetail {
  tenantId?: string | number;
  spuId: string | number;
  spuName?: string;
  goodsName?: string;
  specType?: number;
  weightType?: number;
  weightTypeDesc?: string;
  onlineStatus?: number;
  productPlace?: string;
  matchMedicalStandard?: number | null;
  /** 顶层 brand 在 tenant detail 里通常已填充(从 ch100 品牌属性同步过来) */
  brand?: { clean?: unknown; brandCode?: string; brandName?: string } | null;
  brandName?: string;
  /** 主图 URL 列表(直接是字符串数组) */
  picUrlList?: string[];
  /** 商品图文详情图(直接是字符串数组) */
  picContentList?: string[];
  /** 视频(没有就是 null;若被导出端跳过会留 { videoUrl: '' } 占位) */
  videoInfo?: { videoUrl?: string; coverUrl?: string; coverImageUrl?: string; clean?: unknown } | null;
  description?: string;
  sellPoint?: string;
  /** 美团闪购渠道特殊图(配料图/营养成分图、包装标签图等) */
  mtSpecialPictureList?: Array<{ pictureType?: number; pictureUrl?: string[] | null }>;
  /** 饿了么渠道特殊图(同结构) */
  elmSpecialPictureList?: Array<{ pictureType?: number; pictureUrl?: string[] | null }>;
  /** key: 缩略图 url, value: 高清原图 url(p0.meituan.net/0.0.o/...) */
  originPicUrlMapping?: Record<string, string>;
  originPicContentMapping?: Record<string, string>;
  /** 店内分类(挂载本商品到某个店面前台分类) */
  storeFrontCategoryList?: Array<{
    groupId?: number;
    storeCategoryList?: Array<{
      categoryCode?: string;
      name?: string;
      namePath?: string;
      channelIdList?: number[];
    }>;
    auxiliaryStoreCategoryList?: unknown[] | null;
    allCategoryCodeList?: string[];
  }>;
  /** 渠道列表(每个渠道一条:ch100 美团闪购 / ch200 饿了么 / ch300 京东到家 / ch2911 抖音 等) */
  spuChannelInfoList?: Array<{
    channelId?: number;
    channelName?: string | null;
    /** 渠道后台类目(平铺,不再嵌 channelCategory.channelCategoryXxx) */
    categoryCode?: string;
    categoryName?: string;
    categoryCodePath?: string;
    categoryNamePath?: string;
    /** 渠道动态属性(原 channelDynamicInfoBizDTOList) */
    categoryProperties?: Array<Record<string, unknown>>;
    upcRequired?: number | null;
    resourceType?: number | null;
    existedInRetailAndMedicine?: number | null;
    medicalDeviceQuaRequirement?: unknown;
    supportSpecType?: number | null;
    saleAttrList?: Array<Record<string, unknown>>;
    skuPicSetting?: number | null;
    categoryCanModify?: number | null;
    afterSaleServiceType?: string;
    /** ch300(京东到家)的渠道品牌信息 */
    brandInfo?: { clean?: unknown; brandCode?: string; brandName?: string } | null;
    auditInfo?: unknown;
    channelOnlineStatus?: number | null;
    materialAuditList?: unknown;
    qualificationList?: unknown;
    channelSpuList?: unknown;
    recommendId?: unknown;
    /** 新版 tenant/detail 会把渠道特殊图直接挂在对应渠道下 */
    specialPictureList?: Array<{ pictureType?: number; pictureUrl?: string[] | null }>;
  }>;
  /** SKU 列表(原 storeSkuList,现在是 tenant 维度的主档 SKU) */
  skus?: RawTenantSku[];
  /** 元信息 */
  createTime?: number;
  updateTime?: number;
  /** ERP 拓展字段,update 时回写需要保留 */
  erpTenantSpuExtend?: unknown;
  backendCategoryCode?: string;
  backendCategory?: { categoryCode?: string | number | null } | null;
  /** 配送要求 */
  deliveryRequirement?: number | string;
  /** 其他扩展字段(留作占位/调试) */
  [key: string]: unknown;
}

/** 商品主档 SKU(对应 tenant/detail 响应里的 skus[]) */
interface RawTenantSku {
  tenantId?: string | number;
  spuId?: string | number;
  skuId: string | number;
  /** 规格名(原店内维度的 spec) */
  specName?: string;
  /** 售卖单位(瓶/份/个/盒...);不传服务端会报 "售卖单位不能为空"(11001) */
  saleUnit?: string;
  /** 售价相关:tenant 维度只有「建议售价」(没有店内的 storePrice / onlinePrice) */
  suggestPrice?: {
    tenantSuggestPrice?: { unifiedSuggestPrice?: string | null; channelSuggestPriceList?: Array<{
      channelId: string | number; suggestPrice: string | number;
    }> | null };
    areaSuggestPriceList?: unknown;
    skuId?: string | number;
    clean?: unknown;
  };
  upcList?: string[];
  weightForUnit?: string;
  weightUnit?: string;
  weight?: number;
  basicPrice?: string;
  skuSaleType?: number;
  composeSku?: number;
  onlineStatus?: number;
  /** 起订量,通常为 1 */
  minOrderCount?: number | null;
  externalCode?: string | null;
  goodsCode?: string | null;
  customizeNoUpcCode?: number;
  manageSNCode?: number | null;
  expirationDays?: number | null;
  expirationUnit?: string | null;
  expirationForUnit?: string | null;
  cartonMeasureName?: string | null;
  cartonMeasureConvertFactorList?: Array<Record<string, unknown>> | null;
  /** ERP 拓展字段;update 时回写要保留 */
  erpTenantSkuExtend?: unknown;
  /** 组合装才有 */
  childSkuList?: Array<{
    spuId?: string | number;
    spuName?: string;
    skuId?: string | number;
    skuSpec?: string;
    amount?: number;
    weightForUnit?: string;
    weightUnit?: string;
    picUrl?: string;
    franchiseStatus?: unknown;
  }> | null;
  /** SKU 渠道信息(售卖属性等) */
  skuChannelInfoList?: Array<{
    channelId?: number;
    saleAttrValueList?: Array<{
      attrId?: number | string;
      attrName?: string;
      attrValue?: string;
      attrValueId?: string | null;
    }>;
    skuPicUrlList?: string[] | null;
    upc?: string | null;
    channelSkuList?: unknown;
  }> | null;
  /** SKU 主图 / 规格图 */
  spuPicUrlList?: string[];
  skuPicUrlList?: string[];
  onlineChannelType?: number;
  onlineChannels?: number[];
  goodsUpcList?: string[] | null;
  /** 容量信息(update 时回写要保留) */
  volume?: Record<string, unknown> | null;
  /** 其他扩展字段 */
  [key: string]: unknown;
}

interface PendingMedia {
  url: string;
  kind: 'image' | 'video';
  ref: string;
}

export async function fetchProductDetail(payload: {
  shopId: string | number;
  spuId: string | number;
}): Promise<ProductSpu> {
  void payload.shopId; // tenant/detail 不需要门店上下文,通过 cookie 识别租户
  const resp = await siteFetch<ProductDetailResp>(
    qnhApiPath('/qnh-gw3/api/product/tenant/detail'),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'm-appkey': 'fe_recofesaascrm',
        qnhreferrer: '/unifiedGoods/tenant/edit',
      },
      body: JSON.stringify({ spuId: payload.spuId }),
    },
    parseProductResponse,
  );

  if (resp?.code !== 0 || !resp.data) {
    throw new Error(`商品详情接口失败: ${resp?.msg ?? 'unknown'}`);
  }
  const d = resp.data;

  // ---- 类目路径(优先取美团 channel=100;字段已平铺) ----
  const meituanCh =
    d.spuChannelInfoList?.find((c) => c.channelId === 100) ?? d.spuChannelInfoList?.[0];
  const codePath = meituanCh?.categoryCodePath ?? '';
  const namePath = meituanCh?.categoryNamePath ?? '';
  const sourceCategoryPath = codePath ? codePath.split('>').filter(Boolean) : [];
  const sourceCategoryNamePath = namePath ? namePath.split('>').filter(Boolean) : [];

  // ---- 主图 / 视频 / 详情 HTML / 图文详情 / 渠道特殊图 ----
  // 优先用 originPicUrlMapping 的高清原图(0.0.o 后缀通常是无压缩版本)
  const picMap = { ...(d.originPicUrlMapping ?? {}), ...(d.originPicContentMapping ?? {}) };
  const upgradePic = (u: string | undefined): string | undefined =>
    u ? picMap[u] ?? u : undefined;

  // 1) 主图:picUrlList(字符串数组)
  const mainImageUrls = uniqueStrings(d.picUrlList ?? [])
    .filter(Boolean)
    .map(upgradeRequired);

  // 2) 图文详情:picContentList(字符串数组)
  const pictureContentUrls = uniqueStrings(d.picContentList ?? [])
    .filter(Boolean)
    .map(upgradeRequired);

  // 3) 美团闪购渠道特殊图:
  //    - 旧版 tenant/detail 顶层 mtSpecialPictureList[].pictureUrl[]
  //    - 新版 detail 会把礼赠包装图 / 包装标签图 / 选购指南图等放到
  //      spuChannelInfoList[channelId=100].specialPictureList[].pictureUrl[]
  const mtSpecialPictures = mergeSpecialPictures(
    d.mtSpecialPictureList,
    d.spuChannelInfoList?.find((c) => c.channelId === 100)?.specialPictureList,
  );
  const mtSpecialPictureUrls = uniqueStrings(mtSpecialPictures.flatMap((p) => p.pictureUrl ?? []))
    .filter(Boolean)
    .map(upgradeRequired);

  // 4) 饿了么渠道特殊图:兼容顶层 elmSpecialPictureList 与渠道内 specialPictureList
  const elmSpecialPictures = mergeSpecialPictures(
    d.elmSpecialPictureList,
    d.spuChannelInfoList?.find((c) => c.channelId === 200)?.specialPictureList,
  );
  const elmSpecialPictureUrls = uniqueStrings(elmSpecialPictures.flatMap((p) => p.pictureUrl ?? []))
    .filter(Boolean)
    .map(upgradeRequired);

  // 视频:videoInfo
  const videoUrls: string[] = uniqueStrings([d.videoInfo?.videoUrl ?? '']).filter(Boolean);

  // description 在牵牛花页面通常为空,这里保留字段供导入端复刻使用
  const detailHtml = d.description ?? '';

  function upgradeRequired(u: string): string {
    return upgradePic(u) ?? u;
  }

  // ---- SKU 列表 ----
  const skus = (d.skus ?? []).map((s) => mapSku(s));

  // ---- 收集待下载媒体(url 去重),稍后导出阶段会替换成 hash ----
  // 只收集这 4 处商品本身的图 + 1 处视频:
  //   图 1: picUrlList[]                                         - 主图
  //   图 2: picContentList[]                                     - 图文详情
  //   图 3: mtSpecialPictureList[].pictureUrl[]                  - 美团闪购渠道特殊图
  //         (配料/营养成分;服装含吊牌及洗唛、尺码表、礼赠包装图、包装标签图、选购指南图等)
  //   图 4: elmSpecialPictureList[].pictureUrl[]                 - 饿了么渠道特殊图
  //   视频: videoInfo.videoUrl
  // 故意不收的:
  //   - originPicUrlMapping/originPicContentMapping 等映射字典(导入端会重新生成)
  //   - mtSpecialPictureList[].pictureExample[](平台示例图,非本商品资产)
  //   - skus[].skuChannelInfoList[].skuPicUrlList[](本租户尚未启用)
  const pendingMap = new Map<string, PendingMedia>();
  for (const url of mainImageUrls) addPending(pendingMap, url, 'image', 'main');
  for (const url of pictureContentUrls) addPending(pendingMap, url, 'image', 'pictureContent');
  for (const url of mtSpecialPictureUrls) addPending(pendingMap, url, 'image', 'mtSpecial');
  for (const url of elmSpecialPictureUrls) addPending(pendingMap, url, 'image', 'elmSpecial');
  for (const url of videoUrls) addPending(pendingMap, url, 'video', 'video');

  return {
    sourceSpuId: d.spuId,
    name: d.spuName ?? d.goodsName ?? '',
    sourceCategoryPath,
    sourceCategoryNamePath,
    // 这里先放原 URL,导出编排阶段会下载后替换为 media://${hash}
    mainImageHashes: mainImageUrls,
    videoHashes: videoUrls,
    detailHtml,
    // 顶层"详情图"现在指 picContentList 图文详情(description 富文本通常为空);
    // 渠道特殊图体量小且语义专一,只通过 raw.detail 复刻,不在顶层暴露。
    detailImageHashes: pictureContentUrls,
    skus,
    raw: {
      __pendingMedia: Array.from(pendingMap.values()),
      // 完整原始数据(已瘦身:剔除属性可选值枚举),留给导入端复刻
      detail: slimDetail({
        ...d,
        // 导入端 buildTenantSpuV2 从 raw.detail.mt/elmSpecialPictureList 取渠道特殊图。
        // 新版 tenant/detail 可能只在 spuChannelInfoList[].specialPictureList 返回包装标签图等,
        // 这里归一到顶层,保证导入 update/create 都能下沉到渠道 specialPictureList。
        mtSpecialPictureList: mtSpecialPictures,
        elmSpecialPictureList: elmSpecialPictures,
      }),
    },
  };
}

/**
 * 商品详情瘦身:
 *   - 接口里每个属性都附带了"可选值字典"(attrValueList / optionList /
 *     structAttrTemplateList),如鞋面材质会列出几百种枚举,每个商品都重复一份,
 *     体积膨胀严重但对"复刻商品"无意义。
 *   - 商品实际选中的值在 customValue 里,保留即可。
 *
 * tenant/detail 把渠道动态属性平铺成了 spuChannelInfoList[].categoryProperties,
 * 直接遍历瘦身即可,无需再处理嵌套的 channelCategory。
 */
function slimDetail(d: RawProductDetail): RawProductDetail {
  if (!d.spuChannelInfoList) return d;
  const slimAttr = (a: Record<string, unknown>): Record<string, unknown> => {
    const { attrValueList: _avl, optionList: _ol, structAttrTemplateList: _sat, ...rest } = a;
    void _avl;
    void _ol;
    void _sat;
    return rest;
  };
  return {
    ...d,
    spuChannelInfoList: d.spuChannelInfoList.map((c) => ({
      ...c,
      categoryProperties: c.categoryProperties?.map(slimAttr),
    })),
  };
}

function mapSku(s: RawTenantSku): ProductSpu['skus'][number] {
  // 解析规格:tenant 维度 SKU 主要拿 specName(整串"450ml*15听(6750毫升(ml)")
  // skuChannelInfoList[].saleAttrValueList 偶尔会带结构化数据,有就解,没就只放 specName
  const specs: Array<{ name: string; value: string }> = [];
  const attrSeen = new Set<string>();
  for (const ch of s.skuChannelInfoList ?? []) {
    for (const v of ch.saleAttrValueList ?? []) {
      const key = `${v.attrName ?? ''}|${v.attrValue ?? ''}`;
      if (!v.attrName || !v.attrValue || attrSeen.has(key)) continue;
      attrSeen.add(key);
      specs.push({ name: v.attrName, value: v.attrValue });
    }
  }
  if (specs.length === 0 && s.specName) {
    specs.push({ name: '规格', value: s.specName });
  }

  // tenant 维度只有「建议售价」,没有 store 维度的 storePrice / onlinePrice
  const priceStr = s.suggestPrice?.tenantSuggestPrice?.unifiedSuggestPrice ?? s.basicPrice ?? '0';
  const price = Number.parseFloat(priceStr) || 0;

  return {
    sourceSkuId: s.skuId,
    specs,
    price,
    // 主档不再有店内库存字段,导入端建好店内 SKU 后由门店补
    stock: undefined,
    outerSkuCode: s.upcList?.[0],
  };
}

/**
 * @deprecated tenant/detail 的主图直接是 `picUrlList: string[]`,无需再做 picUrl/isDelete 字段提取。
 *             保留此函数仅作历史参考(未来再有 isDelete 字段时复用),目前没有调用方。
 */
function _legacyCollectPicUrls(
  ...lists: Array<Array<{ picUrl?: string; isDelete?: boolean }> | undefined>
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    if (!list) continue;
    for (const p of list) {
      const u = p?.picUrl;
      if (!u || p.isDelete || seen.has(u)) continue;
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}
void _legacyCollectPicUrls;

function uniqueStrings(arr: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of arr) {
    if (typeof s !== 'string') continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

type RawSpecialPicture = NonNullable<RawProductDetail['mtSpecialPictureList']>[number];

/**
 * 兼容两种详情结构的渠道特殊图:
 *   - 老结构:顶层 mtSpecialPictureList / elmSpecialPictureList
 *   - 新结构:spuChannelInfoList[].specialPictureList(包装标签图等会出现在这里)
 * 同 pictureType 两边都存在时合并图片 URL,并优先保留渠道内返回的元数据。
 */
function mergeSpecialPictures(
  topList: RawProductDetail['mtSpecialPictureList'] | undefined,
  channelList: RawProductDetail['mtSpecialPictureList'] | undefined,
): RawSpecialPicture[] {
  const byType = new Map<number, RawSpecialPicture>();
  for (const item of [...(topList ?? []), ...(channelList ?? [])]) {
    const pictureType = Number(item.pictureType ?? 0);
    const prev = byType.get(pictureType);
    if (!prev) {
      byType.set(pictureType, {
        ...item,
        pictureType: item.pictureType,
        pictureUrl: uniqueStrings(item.pictureUrl ?? []),
      });
      continue;
    }
    byType.set(pictureType, {
      ...prev,
      ...item,
      pictureType: item.pictureType ?? prev.pictureType,
      pictureUrl: uniqueStrings([...(prev.pictureUrl ?? []), ...(item.pictureUrl ?? [])]),
    });
  }
  return Array.from(byType.values());
}

function addPending(map: Map<string, PendingMedia>, url: string, kind: 'image' | 'video', ref: string) {
  if (!url || map.has(url)) return;
  map.set(url, { url, kind, ref });
}

// ============================================================
// 5) / 6) 媒体上传
//    图片接口: POST /api/v1/image/uploadImageFullType
//    详见 docs/api-captures/uploadImage.md
//    视频接口: 待抓包
// ============================================================

interface UploadImageResp {
  code: number;
  msg?: string;
  data?: {
    fileUrl?: string;
    originFileUrl?: string;
  };
}

export async function uploadMedia(payload: {
  shopId: string | number;
  kind: 'image' | 'video';
  mime: string;
  bytesBase64: string;
}): Promise<import('@shared/messaging').UploadedMedia> {
  const bytes = base64ToBytes(payload.bytesBase64);
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: payload.mime });

  if (payload.kind === 'video') {
    // 视频上传走 S3 multipart,实现复杂(详见 docs/api-captures/uploadVideo.md),
    // 暂未接通。目前 runImport 那边已把视频媒体直接跳过(不会进到这里),
    // 留个明确报错以便发现回归。
    throw new Error('视频上传接口尚未接通(应已被 runImport 跳过)');
  }

  const fd = new FormData();
  // 文件名按 mime 给一个合理的扩展名兜底
  const ext = mimeToExt(payload.mime);
  fd.append('file', blob, `image${ext}`);

  const data = await siteFetch<UploadImageResp>('/api/v1/image/uploadImageFullType', {
    method: 'POST',
    headers: {
      // 牵牛花要求带这个头才认为是 ajax,缺了会返回 html
      'X-Requested-With': 'XMLHttpRequest',
      // 注意:Content-Type 必须由浏览器在 FormData 时自动加 boundary,
      // 这里不要手动设置 multipart/form-data
    },
    body: fd,
  });

  if (data?.code !== 0 || !data.data?.fileUrl) {
    throw new Error(`图片上传失败: ${data?.msg ?? 'unknown'}`);
  }
  return {
    fileUrl: data.data.fileUrl,
    originFileUrl: data.data.originFileUrl,
  };
}

function mimeToExt(mime: string): string {
  if (!mime) return '.jpg';
  if (mime.includes('png')) return '.png';
  if (mime.includes('webp')) return '.webp';
  if (mime.includes('gif')) return '.gif';
  if (mime.includes('jpeg')) return '.jpg';
  if (mime.includes('mp4')) return '.mp4';
  if (mime.includes('quicktime')) return '.mov';
  if (mime.includes('webm')) return '.webm';
  return '.jpg';
}

// ============================================================
// 7) 创建商品主档
//    接口: POST /qnh-gw3/api/product/tenant/create/v2
//    详见 docs/api-captures/createProduct.md
//
// 实现策略:
//   1. 把 product 内 media://${hash} 占位符替换成目标 fileUrl
//   2. 从 replaced.raw.detail(detail 接口快照)派生出 tenantSpu
//   3. 顶层 wrap { tenantSpu, dataType:1, hasAudit:0, hasDraft:0, remark:"..." }
//   4. 接口返回 spuId 在 **data.spuId**(不是顶层)
//
// 与之前的 store/create 主要差异:
//   - 完全没有门店级别字段(storeSpu / adjustStock / storeId / source / createType)
//   - tenantId 占位 0,服务端按 cookie 决定
//   - 渠道侧 categoryProperties 内 customValue 元素更精简
// ============================================================

/** 业务网关公共请求头(同其他 qnh 接口) */
const QNH_GW_HEADERS = {
  'Content-Type': 'application/json',
  'm-appkey': 'fe_recofesaascrm',
  qnhreferrer: '/unifiedGoods/tenant/create',
} as const;

interface CreateProductResp {
  code: number;
  msg?: string;
  data?: {
    approvalNo: string | null;
    spuId: string | number;
  };
}

export async function createProduct(payload: {
  scope?: 'store';
  shopId: string | number;
  product: ProductSpu;
  /** hash → 目标账号上传后得到的 fileUrl/originFileUrl */
  mediaIdMap: Record<string, import('@shared/messaging').UploadedMedia>;
  targetCategoryPath: Array<string | number>;
  /** 源子商品 spuId → 目标店里新建后的 spu/sku 映射(组合装父商品创建时使用) */
  childSkuMap?: Record<string, import('@shared/messaging').ChildSkuMapping>;
  /** 源「店内分类」ID → 目标租户「店内分类」ID(跨租户导入时必传) */
  frontCategoryIdRemap?: Record<string, string>;
}): Promise<string | number> {
  const { product, mediaIdMap, childSkuMap, frontCategoryIdRemap } = payload;
  void payload.targetCategoryPath; // 类目路径已经在 raw.detail.channelSpuList 里,不需要外部覆盖

  // ---- 1) 替换媒体占位符 ----
  const replacedJson = JSON.stringify(product).replace(
    /media:\/\/([a-f0-9]{64})/g,
    (_m, h) => {
      const v = mediaIdMap[h];
      if (!v) throw new Error(`媒体 ${h} 未上传`);
      if (!v.fileUrl) return ''; // 跳过的视频:占位串清空
      return v.fileUrl;
    },
  );
  const replaced = JSON.parse(replacedJson) as ProductSpu;
  replaced.videoHashes = (replaced.videoHashes ?? []).filter((u) => !!u);

  // ---- 2) 取 raw.detail(导出阶段保存的 productDetail 快照),所有重要字段都从这里派生 ----
  const detail = replaced.raw?.detail as RawProductDetail | undefined;
  if (!detail) {
    throw new Error('导出包缺少 raw.detail,无法构造创建商品请求体');
  }
  if (rawDetailHasEmptyVideo(detail)) {
    detail.videoInfo = null;

  }

  // ---- 3) 拼 create v2 body ----
  const tenantSpu = buildTenantSpuV2('create', {
    product: replaced,
    detail,
    childSkuMap,
    frontCategoryIdRemap,
  });

  if (payload.scope === 'store') {
    return createStoreProduct(payload.shopId, replaced, detail, tenantSpu);
  }
  const body = {
    tenantSpu,
    dataType: 1,
    hasAudit: 0,
    hasDraft: 0,
    remark: '/unifiedGoods/tenant/create?',
  };

  const resp = await siteFetch<CreateProductResp>(
    qnhApiPath('/qnh-gw3/api/product/tenant/create/v2'),
    {
      method: 'POST',
      headers: QNH_GW_HEADERS,
      body: JSON.stringify(body),
    },
  );

  if (resp?.code !== 0 || resp?.data?.spuId == null) {
    throw new Error(`创建商品失败: code=${resp?.code} msg=${resp?.msg ?? 'unknown'}`);
  }
  return resp.data.spuId;
}

const storeCreateHeaders = { ...QNH_GW_HEADERS, qnhreferrer: '/unifiedGoods/store/create' };

function numericStoreId(value: string | number) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('目标门店编号无效');
  return id;
}

function storeRetailPrice(sku: RawTenantSku, source: ProductSpu['skus'][number]) {
  const hq = sku.suggestPrice?.tenantSuggestPrice;
  const channels = hq?.channelSuggestPriceList ?? [];
  const label = sku.specName?.trim() ? `规格「${sku.specName.trim()}」` : `SKU ${sku.skuId ?? source.sourceSkuId ?? '（未编号）'}`;
  const positive = (p: unknown) => (typeof p === 'string' || typeof p === 'number') &&
    Number.isFinite(Number(p)) && Number(p) > 0;
  const formatChannels = (list: Array<{ channelId: string | number; suggestPrice: string }>) => {
    const price = list[0].suggestPrice;
    return list.every(c => c.suggestPrice === price)
      ? { tenantSuggestPrice: { unifiedSuggestPrice: price } }
      : { tenantSuggestPrice: { channelSuggestPriceList: list } };
  };
  if (channels.length) {
    if (channels.some(c => !positive(c.suggestPrice) || !positive(c.channelId))) {
      throw new Error(`${label} 的分渠道总部零售价不完整`);
    }
    return formatChannels(channels.map(c => ({ channelId: c.channelId, suggestPrice: String(Number(c.suggestPrice)) })));
  }
  const price = [hq?.unifiedSuggestPrice, source.price, sku.basicPrice].find(positive);
  if (price != null) return { tenantSuggestPrice: { unifiedSuggestPrice: String(Number(price)) } };

  const storeChannels = (source.channelPrices ?? []).filter(c => positive(c.channelId) && positive(c.price));
  if (storeChannels.length) {
    return formatChannels(storeChannels.map(c => ({ channelId: c.channelId, suggestPrice: String(Number(c.price)) })));
  }
  if (positive(source.onlinePrice)) {
    return { tenantSuggestPrice: { unifiedSuggestPrice: String(Number(source.onlinePrice)) } };
  }
  throw new Error(`${label} 缺少有效的总部建议售价和源门店线上零售价，请核对源商品定价后重新导出。`);
}

async function createStoreProduct(
  shopId: string | number, product: ProductSpu, detail: RawProductDetail, mapped: ReturnType<typeof buildTenantSpuV2>,
): Promise<string | number> {
  const rawSkus = detail.skus ?? [];
  if (!rawSkus.length || rawSkus.length !== product.skus.length) throw new Error('门店新建需要完整的 SKU 清单');
  const jd = jdStoreSpecs(detail);
  const sources = rawSkus.map((sku, i) => {
    const source = sku.skuId == null ? product.skus[i] : product.skus.find(s => String(s.sourceSkuId) === String(sku.skuId));
    if (!source) throw new Error(`门店规格「${sku.specName ?? ''}」缺少对应的导出 SKU`);
    return source;
  });
  // 两份门店新建抓包的 storePrice 都是 9999，即使各 SKU 的总部零售价不同。
  const skuList = rawSkus.map((s, i) => ({ specName: makeSpecName(s), storePrice: String(sources[i].storePrice ?? 9999), customizeStockFlag: 1 }));
  const skus = (mapped.skus as Array<Record<string, unknown>>).map((sku, i) => ({
    ...sku, suggestPrice: storeRetailPrice(rawSkus[i], sources[i]),
    skuChannelInfoList: (sku.skuChannelInfoList as Array<Record<string, unknown>>).map(c =>
      jd && Number(c.channelId) === 300 ? { ...c, saleAttrValueList: jd.values[i] } : c),
    customizeNoUpcCode: rawSkus[i].customizeNoUpcCode ?? 0,
    useSkuAsUpc: rawSkus[i].useSkuAsUpc ?? 0, goodsUpcList: rawSkus[i].goodsUpcList ?? [],
    volume: rawSkus[i].volume ?? { volumeForUnit: null },
    fourWheelDeliveryThreshold: rawSkus[i].fourWheelDeliveryThreshold ?? null,
  }));
  const channels = (mapped.spuChannelInfoList as Array<Record<string, unknown>>).map(c => ({
    channelId: c.channelId, channelName: c.channelName, categoryCode: c.categoryCode,
    categoryName: c.categoryName, categoryCodePath: c.categoryCodePath, categoryNamePath: c.categoryNamePath,
    categoryProperties: c.categoryProperties, saleAttrList: Number(c.channelId) === 300 && jd ? jd.dimensions : c.saleAttrList, skuPicSetting: c.skuPicSetting,
    brandInfo: c.brandInfo, specialPictureList: c.specialPictureList,
  }));
  // 门店分类使用所选门店的分类 ID。主档的分类字段使用总部分类目录。
  const storeMainFrontCategoryIdList = uniqueStrings(mapped.storeFrontCategoryList.flatMap(group =>
    group.storeCategoryList.map(category => String(category.categoryCode)),
  ));
  const tenantSpu = {
    spuName: product.name, weightType: mapped.weightType, specType: mapped.specType, onlineStatus: mapped.onlineStatus,
    customizedChannelName: detail.customizedChannelName ?? {}, spuChannelInfoList: channels,
    picUrlList: mapped.picUrlList, picContentList: mapped.picContentList, videoInfo: mapped.videoInfo ?? null,
    brand: detail.brand ?? {}, backendCategory: { categoryCode: detail.backendCategory?.categoryCode ?? null },
    storeFrontCategoryList: [], matchMedicalStandard: detail.matchMedicalStandard,
    aiRecommendInfo: detail.aiRecommendInfo ?? {}, otherQualificationInfo: detail.otherQualificationInfo ?? { fileList: [] },
    sellPoint: detail.sellPoint, description: detail.description, skus,
  };
  const resp = await siteFetch<CreateProductResp & { spuId?: string | number; success?: boolean }>(
    qnhApiPath('/qnh-gw3/api/product/store/create'), {
      method: 'POST', headers: storeCreateHeaders,
      body: JSON.stringify({ storeId: numericStoreId(shopId), tenantSpu, storeSpu: { skuList, storeMainFrontCategoryIdList,
        mtSpecialPictureList: channels.find(c => Number(c.channelId) === 100)?.specialPictureList },
        adjustStock: { comment: 'WEB-门店商品新增规格调整库存', skuList: [] },
        source: 2, createType: 3, fieldUpgrade: { newProperty: false } }),
    }, text => JSON.parse(text, (key, value, context?: { source?: string }) => {
      // 门店接口可能以 JSON 数字返回 19 位 SPU ID。后续采购请求必须使用原始编号。
      return key === 'spuId' && typeof value === 'number' && context?.source && /^\d+$/.test(context.source)
        ? context.source : value;
    }));
  if (resp?.code !== 0 || resp.success === false) throw new Error(`门店商品新建失败：${resp?.msg ?? resp?.code}`);
  const id = resp.spuId ?? resp.data?.spuId;
  if (typeof id === 'string' && /^[1-9]\d*$/.test(id)) return id;
  if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) return id;
  throw new Error('门店新建已返回成功，但未取得有效的目标商品编号，请到门店核对。');
}

export async function setNewStorePurchase(payload: import('@shared/messaging').StorePurchaseRequest) {
  const { shopId, targetSpuId, specs } = payload;
  if (!specs.length) throw new Error('缺少门店商品规格');
  const purchaseInfo = specs.map(spec => ({
    skuId: null, spec, purchaseStatus: 1, purchaseType: 1, distributeType: 1, distributeId: null,
    newSupplyRelations: [],
  }));
  const resp = await siteFetch<{ code: number; success?: boolean; msg?: string }>(qnhApiPath('/api/v1/store/spu/create'), {
    method: 'POST', headers: storeCreateHeaders,
    body: JSON.stringify({ manualCreate: true, newPage: true, storeId: numericStoreId(shopId),
      storeSpu: { spuId: String(targetSpuId), purchaseInfo } }),
  });
  if (resp?.code !== 0 || resp.success === false) throw new Error(resp?.msg ?? '门店采购配置失败');
}

// ============================================================
// 7.5) 修改商品主档
//      接口: POST /qnh-gw3/api/product/tenant/update/v2
//      详见 docs/api-captures/updateProduct.md
//
// 设计:
//   - 复用 buildTenantSpuV2 拿到 tenantSpu(create/update 共用核心)
//   - 顶层 wrap: { tenantSpu, coverageRequest:{}, submitReason:"", actCheckType:1 }
// ============================================================

interface UpdateProductResp {
  code: number;
  msg?: string;
}

export async function updateProduct(payload: {
  product: ProductSpu;
  mediaIdMap: Record<string, import('@shared/messaging').UploadedMedia>;
  /** 跨租户场景下,源「店内分类」ID → 目标租户「店内分类」ID。 */
  frontCategoryIdRemap?: Record<string, string>;
  targetSpuId: string | number;
  /** 子商品映射:组合装父商品改写 childSkuList 时使用。 */
  childSkuMap?: Record<string, import('@shared/messaging').ChildSkuMapping>;
  /** hash → 目标账号上已有的 fileUrl/originFileUrl(命中即免上传)。 */
  existingMediaIdMap?: Record<string, import('@shared/messaging').UploadedMedia>;
  /**
   * 目标商品 detail 快照(由调用方在判断"已存在"时顺便拉好,避免再发一次 detail 请求)。
   * 主要用来取 tenantId / createTime / updateTime / 渠道侧 categoryId 等字段。
   */
  targetDetail: RawProductDetail;
}): Promise<string | number> {
  const { product, mediaIdMap, targetSpuId, targetDetail } = payload;
  void payload.existingMediaIdMap;

  // ---- 1) 替换源商品里的 media:// 占位 ----
  // 导入流程已为图片选好复用或上传后的地址，按源快照的字段和顺序填入。
  const replacedJson = JSON.stringify(product).replace(
    /media:\/\/([a-f0-9]{64})/g,
    (_m, h) => {
      const v = mediaIdMap[h];
      if (!v) throw new Error(`媒体 ${h} 未上传`);
      if (!v.fileUrl) return ''; // 视频跳过(uploadMedia 暂不支持视频,返回空 fileUrl)
      return v.fileUrl;
    },
  );
  const replaced = JSON.parse(replacedJson) as ProductSpu;
  replaced.videoHashes = (replaced.videoHashes ?? []).filter((u) => !!u);

  const detail = replaced.raw?.detail as RawProductDetail | undefined;
  if (!detail) {
    throw new Error('导出包缺少 raw.detail,无法构造修改商品请求体');
  }
  if (rawDetailHasEmptyVideo(detail)) {
    detail.videoInfo = null;

  }

  const tenantSpu = buildTenantSpuV2('update', {
    product: replaced,
    detail,
    targetDetail,
    targetSpuId,
    childSkuMap: payload.childSkuMap,
    frontCategoryIdRemap: payload.frontCategoryIdRemap,
  });

  const body = {
    tenantSpu,
    coverageRequest: {},
    submitReason: '',
    actCheckType: 1,
  };

  const resp = await siteFetch<UpdateProductResp>(
    qnhApiPath('/qnh-gw3/api/product/tenant/update/v2'),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'm-appkey': 'fe_recofesaascrm',
        qnhreferrer: '/unifiedGoods/tenant/edit',
      },
      body: JSON.stringify(body),
    },
  );

  if (resp?.code !== 0) {
    throw new Error(`修改商品失败: code=${resp?.code} msg=${resp?.msg ?? 'unknown'}`);
  }
  return targetSpuId;
}

/** 简单判断对象有内容(用于决定 videoInfo / volume 是否给 clean 占位) */
function nonEmpty(o: Record<string, unknown> | null | undefined): boolean {
  return !!o && Object.keys(o).length > 0;
}

// ============================================================
// createProduct - 字段映射相关辅助类型与函数
// ============================================================
// ============================================================
// tenant/create/v2 与 tenant/update/v2 共用的 tenantSpu 构造器
// --------------------------------------------------------------
//   - 两个接口的 body 形态是配套设计:create 时 tenantId=0 且无 spuId,
//     update 时带真实 tenantId 与 spuId。
//   - 字段绝大多数共享,差异点用 direction 参数分支:
//       * skus[]:create 不带 skuId,update 带 skuId 和 volume/comboGroupList 等占位
//       * spuChannelInfoList[]:create 带丰富的 UI 元数据(loading/value/level/saleAttrInfoVOList 等),
//         update 不带这一组,而是带 auditInfo/channelOnlineStatus/categoryCanModify 等审核相关 null 占位
//       * 顶层:create 没有 originPlace 转字符串/coverageInfo/clean 占位 等
// ============================================================

interface SpecialPicture {
  pictureType?: number;
  pictureTitle?: string;
  pictureDesc?: string;
  pictureExample?: string[] | null;
  isRequired?: number;
  isDisplay?: number;
  numLimit?: number;
  numMin?: number;
  pictureUrl: string[];
}

interface CategoryProperty {
  attrId: number;
  attrName: string;
  attrValueType: string;
  characterType: string | null;
  maxTextLength: number | null;
  isRequired: number;
  attrSequence: number;
  customValue: Array<Record<string, unknown>>;
  optionList: unknown[];
  structAttrTemplateList: unknown[];
  originalInputValue: string | null;
  optionMaxSize: number;
  supportExtend: boolean;
}

type V2Direction = 'create' | 'update';

interface BuildTenantSpuV2Args {
  product: ProductSpu;
  detail: RawProductDetail;
  /** 仅 update 提供:从目标店 detail 取 tenantId / createTime / updateTime 等"主档身份" */
  targetDetail?: RawProductDetail;
  /** 仅 update 提供:目标主档 SPU id */
  targetSpuId?: string | number;
  childSkuMap?: Record<string, import('@shared/messaging').ChildSkuMapping>;
  frontCategoryIdRemap?: Record<string, string>;
}

/**
 * 真正的"字段翻译器":detail 快照 → tenant/{create,update}/v2 的 `tenantSpu`
 *
 * 任何不一致都以 docs/api-captures/createProduct.md / updateProduct.md 两份抓包为准。
 */
function buildTenantSpuV2(
  direction: V2Direction,
  args: BuildTenantSpuV2Args,
) {
  const { product, detail, targetDetail, targetSpuId, childSkuMap, frontCategoryIdRemap } = args;
  const channelList = detail.spuChannelInfoList ?? [];
  const ch100 = channelList.find((c) => c.channelId === 100);

  // 主图 / 图文详情 / 视频
  // create / update 统一使用已解析图片地址的源快照，保留图片顺序及增删。
  const picSource = detail;
  const picUrlList = uniqueStrings(picSource.picUrlList ?? []).filter(Boolean);
  const picContentList = uniqueStrings(picSource.picContentList ?? []).filter(Boolean);
  const videoInfoSrc = picSource.videoInfo as
    | { videoUrl?: string; coverUrl?: string; coverImageUrl?: string }
    | null
    | undefined;
  const hasVideo = !!videoInfoSrc?.videoUrl;
  const videoInfoOut: Record<string, unknown> = hasVideo
    ? {
        videoUrl: videoInfoSrc!.videoUrl!,
        coverImageUrl: videoInfoSrc!.coverImageUrl ?? videoInfoSrc!.coverUrl ?? '',
      }
    : direction === 'update'
      ? { clean: true }
      : {};

  // 品牌
  const brand = pickBrand(detail, ch100);

  // 前台类目(店内分类)— 跨租户必须 remap
  // tenant/detail 把店内分类直接挂在顶层 storeFrontCategoryList[].storeCategoryList[],
  // 每个条目自带 categoryCode / name / namePath / channelIdList,我们只关心 categoryCode + name。
  const hasRemap = !!(frontCategoryIdRemap && Object.keys(frontCategoryIdRemap).length > 0);
  const storeFrontCategoryRefs: Array<{ id: string; name: string; namePath?: string }> = [];
  for (const group of detail.storeFrontCategoryList ?? []) {
    for (const c of group.storeCategoryList ?? []) {
      const id = c.categoryCode;
      if (!id) continue;
      const name =
        c.name ?? (c.namePath ?? '').split('>').filter(Boolean).pop() ?? '';
      storeFrontCategoryRefs.push({ id, name, namePath: c.namePath });
    }
  }
  const storeFrontCategoryList = storeFrontCategoryRefs.map((x) => {
    const mapped = frontCategoryIdRemap?.[x.id];
    if (hasRemap && !mapped) {
      throw new Error(
        `店内分类源 ID ${x.id} 未在映射表中,无法跨租户创建商品(请在导入前先在目标店建好对应分类)`,
      );
    }
    return {
      groupId: 0,
      storeCategoryList: [{ categoryCode: mapped ?? x.id, name: x.name }],
      auxiliaryStoreCategoryList: [] as unknown[],
    };
  });

  // SKU 列表(create / update 形态不同)
  const skus = (detail.skus ?? []).map((s, idx) => {
    const targetSku = (targetDetail?.skus ?? [])[idx];
    return buildTenantSkuV2(direction, s, targetSku, childSkuMap);
  });

  // 渠道侧特殊图(预先备好,update 下沉到渠道里;create 也下沉到渠道里)
  // 源端 detail 里 media:// 已被上一步替换成 fileUrl,直接用。
  // 兼容历史导出包:部分 tenant/detail 会把包装标签图等只放在
  // spuChannelInfoList[].specialPictureList,而不是顶层 mt/elmSpecialPictureList。
  const specialSource = detail;
  const mtSpecial = trimSpecialPictures(
    mergeSpecialPictures(
      specialSource.mtSpecialPictureList,
      specialSource.spuChannelInfoList?.find((c) => c.channelId === 100)?.specialPictureList,
    ),
  );
  const elmSpecial = trimSpecialPictures(
    mergeSpecialPictures(
      specialSource.elmSpecialPictureList,
      specialSource.spuChannelInfoList?.find((c) => c.channelId === 200)?.specialPictureList,
    ),
  );

  // 渠道列表(create / update 形态差异较大)
  // 多规格(specType=2)需要把 SKU 上的销售属性聚合到渠道级 saleAttrList,否则
  // 京东(ch300)/饿了么(ch200)会报"多规格销售属性必填" —— detail 里这两个渠道的
  // 渠道级 saleAttrValueList 经常是空的,只有 ch100 是满的,但每个 SKU 的
  // skuChannelInfoList[].saleAttrValueList 都给齐了 attrId/attrName/attrValue。
  //
  // 关键:销售属性聚合的数据源按方向区分。
  //   - create:用源端 detail(新建商品,值来自源)。
  //   - update:用**目标商品 detail**。销售属性一旦推送到渠道(京东/饿了么)就不可变更,
  //     若透传源端的值,只要和目标店现有值不一致就会被判"变更已推送渠道的销售属性值"而拒绝;
  //     但给空数组又会触发"多规格销售属性必填"。两难之下,唯一两全的做法是回传
  //     目标商品自身现有的销售属性 —— 它本就是已推送的值,既满足"必填",又不构成"变更"。
  const saleAttrSourceDetail = direction === 'update' && targetDetail ? targetDetail : detail;
  const channelSaleAttrAgg = buildChannelSaleAttrAgg(saleAttrSourceDetail);
  const spuChannelInfoList = channelList.map((c) => {
    const target = (targetDetail?.spuChannelInfoList ?? []).find(
      (x) => x.channelId === c.channelId,
    );
    const specialPictureList =
      c.channelId === 100 ? mtSpecial : c.channelId === 200 ? elmSpecial : undefined;
    const aggForChannel = c.channelId != null ? channelSaleAttrAgg.get(c.channelId) : undefined;
    return buildSpuChannelInfoV2(direction, c, target, specialPictureList, aggForChannel);
  });

  // ---- 顶层 tenantSpu ----
  const base: Record<string, unknown> & { storeFrontCategoryList: typeof storeFrontCategoryList } = {
    tenantId:
      direction === 'create'
        ? 0
        : (targetDetail as RawProductDetail & { tenantId?: string | number })?.tenantId
          ?? (detail as RawProductDetail & { tenantId?: string | number }).tenantId,
    spuName: product.name,
    specType: detail.specType ?? 1,
    weightType: detail.weightType ?? 3,
    onlineStatus: detail.onlineStatus ?? 1,
    productPlace:
      (targetDetail as RawProductDetail & { productPlace?: string })?.productPlace
      ?? (detail as RawProductDetail & { productPlace?: string }).productPlace
      ?? '',
    backendCategoryCode:
      (targetDetail as RawProductDetail & { backendCategoryCode?: string })?.backendCategoryCode
      ?? (detail as RawProductDetail & { backendCategoryCode?: string }).backendCategoryCode
      ?? '',
    brandCode:
      (targetDetail as RawProductDetail & { brandCode?: string })?.brandCode
      ?? brand.brandCode
      ?? '',
    sellPoint:
      (targetDetail as RawProductDetail & { sellPoint?: string })?.sellPoint
      ?? (detail as RawProductDetail & { sellPoint?: string }).sellPoint
      ?? '',
    description: detail.description ?? '',
    // create 抓包是空字符串 "",update 是 "1"/"2";两个方向都允许空字符串占位
    originPlace:
      direction === 'create'
        ? ''
        : String(deriveOriginPlace(ch100)),
    deliveryRequirement:
      (targetDetail as RawProductDetail & { deliveryRequirement?: string })?.deliveryRequirement
      ?? (direction === 'update' ? '0' : ''),
    picUrlList,
    picContentList,
    properties: [] as unknown[],
    aiRecommendInfo: { aiRecommendSellingPoint: false },
    specialty: 0,
    depleteMaterial: 0,
    erpTenantSpuExtend:
      (targetDetail as RawProductDetail & { erpTenantSpuExtend?: unknown })?.erpTenantSpuExtend
      ?? (detail as RawProductDetail & { erpTenantSpuExtend?: unknown }).erpTenantSpuExtend
      ?? { fromErp: 1 },
    skus,
    spuChannelInfoList,
    storeFrontCategoryList,
  };
  if (hasVideo || direction === 'update') {
    base.videoInfo = videoInfoOut;
  }

  if (direction === 'update') {
    // update 专属:身份 + 时间戳 + 一组占位 null/clean
    base.spuId = String(targetSpuId);
    base.weightTypeDesc =
      (targetDetail as RawProductDetail & { weightTypeDesc?: string })?.weightTypeDesc
      ?? (detail as RawProductDetail & { weightTypeDesc?: string }).weightTypeDesc
      ?? '标品';
    base.saleInfo = 1;
    base.jumpPageType = null;
    base.createTime =
      (targetDetail as RawProductDetail & { createTime?: number })?.createTime ?? null;
    base.updateTime =
      (targetDetail as RawProductDetail & { updateTime?: number })?.updateTime ?? null;
    base.abnormalCodeList = null;
    base.abnormalMarkMsg = null;
    base.noSaleChannelInfoList = null;
    base.coverageInfo = null;
    base.medicalDeviceQuaInfo =
      (targetDetail as RawProductDetail & { medicalDeviceQuaInfo?: unknown })?.medicalDeviceQuaInfo
      ?? { clean: true };
    base.nameSupplementInfo =
      (targetDetail as RawProductDetail & { nameSupplementInfo?: unknown })?.nameSupplementInfo
      ?? { clean: true };
    base.spuChannelCustomizedInfoList = [];
  }

  return base;
}

/**
 * specName:服务端会基于我们传的 specName 再自动追加 `（${weightForUnit}${weightUnit}`
 * 拼成完整展示名,所以我们这里**只能传"用户在 UI 里手输的那部分"**(也就是 detail.specName 里
 * 用户输入的那截,服务端会再做拼接;直接回传 detail 的 specName 即可)。
 */
function makeSpecName(s: RawTenantSku): string {
  return s.specName ?? '';
}

/** 把 "9999.0" / "80.00" 这种结尾零去掉,变 "9999" / "80" */
function trimTrailingZeros(s: string): string {
  if (!s) return '0';
  if (!s.includes('.')) return s;
  return s.replace(/\.?0+$/, '');
}

/** 把 "6750" 格式化成 "6750.000",用于 tenantSpu.skus[].weightForUnit */
function formatWeight3(s: string | number | undefined): string {
  if (s == null) return '';
  const n = Number.parseFloat(String(s));
  if (!Number.isFinite(n)) return String(s);
  return n.toFixed(3);
}

/**
 * 构造 SKU 的「基础箱规」列表(cartonMeasureConvertFactorList)。
 *
 * 后端校验:**基础箱规单位名称必须与售卖单位(saleUnit)一致**,否则报
 * "基础箱规单位必须和售卖单位名称一致"。之前这里恒为 `[]`,组合装(saleUnit 为空)
 * 时不触发校验,但普通单品(如 saleUnit="袋")就会被拒。
 *
 * 策略:
 *   - saleUnit 为空 → 沿用旧行为给空数组(组合装等场景);
 *   - saleUnit 非空 → 复刻源端 detail 里的基础箱规(`basicUnitConvertFactor === 1` 那条),
 *     并把它的 `cartonMeasureName` 强制对齐成 saleUnit;源端缺失时合成一条
 *     `{ cartonMeasureName: saleUnit, basicUnitConvertFactor: 1, ... }`。
 *   - 跨租户创建时不能透传源端的 `cartonMeasureCode`(那是源租户的 ID),置空让服务端分配。
 */
function buildCartonMeasureList(
  direction: V2Direction,
  s: RawTenantSku,
  targetSku: RawTenantSku | undefined,
  saleUnit: string,
): unknown[] {
  if (!saleUnit) return [];

  const srcList = (s.cartonMeasureConvertFactorList ?? []) as Array<Record<string, unknown>>;
  // 基础箱规 = 换算系数为 1 的那条;找不到就退回第一条
  const basic =
    srcList.find((c) => Number(c?.basicUnitConvertFactor) === 1) ?? srcList[0];

  // update 路径优先复用目标店现有的基础箱规 code,保留其换算关系
  const targetList = (targetSku?.cartonMeasureConvertFactorList ?? []) as Array<
    Record<string, unknown>
  >;
  const targetBasic =
    targetList.find((c) => Number(c?.basicUnitConvertFactor) === 1) ?? targetList[0];

  const cartonMeasureCode =
    direction === 'update' ? targetBasic?.cartonMeasureCode ?? null : null;

  return [
    {
      cartonMeasureCode,
      // 关键:单位名称必须等于 saleUnit
      cartonMeasureName: saleUnit,
      basicUnitConvertFactor: 1,
      basicDistributePrice: basic?.basicDistributePrice ?? null,
      defaultDistributeUnitFlag: basic?.defaultDistributeUnitFlag ?? 0,
      areaConfigInfoList: (basic?.areaConfigInfoList as unknown[]) ?? [],
      boxCodeList: (basic?.boxCodeList as unknown[]) ?? [],
      weight: basic?.weight ?? null,
      weightUnit: basic?.weightUnit ?? null,
      canChangeFactor: basic?.canChangeFactor ?? null,
    },
  ];
}

/** detail.skus[i] → tenantSpu.skus[i](create 与 update 共用,direction 决定附加字段) */
function buildTenantSkuV2(
  direction: V2Direction,
  s: RawTenantSku,
  targetSku: RawTenantSku | undefined,
  childSkuMap: Record<string, import('@shared/messaging').ChildSkuMapping> | undefined,
): Record<string, unknown> {
  const childSkuList = (s.childSkuList ?? []).map((c) => {
    // 把源 spuId/skuId 改写成目标店里新建后的 ID
    const mapping = c.spuId != null ? childSkuMap?.[String(c.spuId)] : undefined;
    if (c.spuId != null && !mapping) {
      throw new Error(
        `组合装子商品未在目标店建出来:sourceSpuId=${c.spuId}。请确认子商品已在导出包内。`,
      );
    }
    const targetSpuId = mapping?.targetSpuId ?? c.spuId;
    const targetSkuId =
      c.skuId != null ? mapping?.skuMap?.[String(c.skuId)] ?? c.skuId : c.skuId;
    return {
      skuId: targetSkuId,
      spuId: targetSpuId,
      spuName: c.spuName,
      skuSpec: c.skuSpec,
      amount: c.amount,
      weightForUnit: c.weightForUnit,
      weightUnit: c.weightUnit,
      key: targetSkuId,
      franchiseStatus: c.franchiseStatus ?? null,
    };
  });

  // 主档 SKU 价格只有「建议售价」(suggestPrice.tenantSuggestPrice.unifiedSuggestPrice)。
  // update 路径下,如果源端没有可用的 suggest(老导出包里偶尔是 0/null),
  // 用目标店里现有的价格兜底,保证不会把目标店的合法定价覆盖成 "0",
  // 触发 "保存建议零售价异常"。
  const suggestSrc =
    s.suggestPrice?.tenantSuggestPrice?.unifiedSuggestPrice ??
    (direction === 'update'
      ? targetSku?.suggestPrice?.tenantSuggestPrice?.unifiedSuggestPrice
      : undefined) ??
    s.basicPrice ??
    '0';

  const skuSaleType = s.skuSaleType ?? 1;
  const onlineStatus = s.onlineStatus ?? 1;
  const saleUnit = s.saleUnit && s.saleUnit.trim() ? s.saleUnit : '';

  // 渠道侧的售卖属性:
  //   - create:透传源端 SKU 的 saleAttrValueList(否则多规格商品在京东/饿了么会报"销售属性必填")。
  //   - update:**透传目标 SKU 现有的 saleAttrValueList**,不能用源端的值。
  //     销售属性推送渠道后不可变更:给空会报"多规格销售属性必填",给源端值(若与目标店不一致)
  //     会报"已经推送渠道的情况下,京东销售属性值不允许变更"。回传目标 SKU 自身的现有值,
  //     既满足必填、又不构成变更(本 SKU 的 skuId 也取自同一个 targetSku,二者天然对齐)。
  // 元素只保留接口需要的字段:channelId / saleAttrValueList(attrId 必须是 number)。
  const saleAttrSourceSku = direction === 'update' ? targetSku : s;
  const skuChannelInfoList = (saleAttrSourceSku?.skuChannelInfoList ?? [])
    .filter((ch) => ch && ch.channelId != null)
    .map((ch) => {
      const attrs = (ch.saleAttrValueList ?? [])
        .filter((v) => v && v.attrId != null && v.attrName && v.attrValue)
        .map((v) => ({
          attrId:
            typeof v.attrId === 'string' ? Number.parseInt(v.attrId, 10) : (v.attrId as number),
          attrName: v.attrName,
          attrValue: v.attrValue,
          attrValueId: v.attrValueId ?? null,
        }));
      return {
        channelId: ch.channelId,
        saleAttrValueList: attrs,
        skuPicUrlList: ch.skuPicUrlList ?? [],
        upc: ch.upc ?? null,
      };
    });

  const base: Record<string, unknown> = {
    specName: makeSpecName(s),
    saleUnit,
    suggestPrice: {
      tenantSuggestPrice: { unifiedSuggestPrice: trimTrailingZeros(String(suggestSrc)) },
    },
    onlineStatus,
    onlineChannelType: s.onlineChannelType ?? 1,
    upcList: s.upcList ?? [],
    externalCode: s.externalCode ?? '',
    goodsCode: s.goodsCode ?? '',
    manageSNCode: s.manageSNCode ?? 0,
    weightForUnit: formatWeight3(s.weightForUnit),
    weightUnit: s.weightUnit ?? '',
    expirationForUnit: s.expirationForUnit ?? '',
    expirationUnit: s.expirationUnit ?? '',
    cartonMeasureConvertFactorList: buildCartonMeasureList(direction, s, targetSku, saleUnit),
    skuChannelInfoList,
    erpTenantSkuExtend:
      direction === 'update'
        ? targetSku?.erpTenantSkuExtend
          ?? {
            tenantSkuErpGoodsRelList: null,
            erpSaleStatus: null,
            shareStockType: 0,
            stockUpRoundStatus: 2,
            stockUpRoundRatio: '',
          }
        : { tenantSkuErpGoodsRelList: [] as unknown[] },
    skuSaleType,
    childSkuList,
  };

  if (direction === 'update') {
    const targetSkuId = targetSku?.skuId ?? s.skuId;
    if (targetSkuId == null) {
      throw new Error('修改商品时缺少目标 skuId,无法对齐');
    }
    base.skuId = String(targetSkuId);
    base.goodsPriceInfo = null;
    base.customizeNoUpcCode = s.customizeNoUpcCode ?? 0;
    base.useSkuAsUpc = null;
    const volumeRaw = (targetSku?.volume ?? s.volume) as Record<string, unknown> | null | undefined;
    base.volume = nonEmpty(volumeRaw) ? volumeRaw : { clean: true };
    base.enableExpiredCheck = null;
    base.comboGroupList = [] as unknown[];
    base.comboType = null;
    base.isSavePromotion = null;
  }

  return base;
}

/** detail.spuChannelInfoList[i] → tenantSpu.spuChannelInfoList[i](create 与 update 共用) */
function buildSpuChannelInfoV2(
  direction: V2Direction,
  c: NonNullable<RawProductDetail['spuChannelInfoList']>[number],
  target: NonNullable<RawProductDetail['spuChannelInfoList']>[number] | undefined,
  specialPictureList: SpecialPicture[] | undefined,
  /**
   * 来自 SKU 反聚合的渠道级 saleAttrList:
   *   Map<attrId, { attrName, picRelated, attrSortNum, valueNames }>
   * 多规格商品京东 / 饿了么必须给完整的 saleAttrList,源端 detail 偶尔只填了 ch100,
   * 这里按 SKU 上的销售属性补齐其它渠道的值。
   */
  aggregatedSaleAttrs: Map<string, ChannelSaleAttr> | undefined,
): Record<string, unknown> {
  const channelId = c.channelId ?? 0;

  // tenant/detail 已经把渠道动态属性平铺成 categoryProperties,
  // 不再像 store/detail 那样嵌套在 channelCategory.channelDynamicInfoBizDTOList 里。
  const props = (c.categoryProperties ?? []).map((p) => convertCategoryProperty(direction, p));

  // 同样,渠道类目编码 / 名称 / 路径都是平铺字段
  const codePath = c.categoryCodePath ?? '';
  const namePath = c.categoryNamePath ?? '';
  const codeArr = codePath ? codePath.split('>').filter(Boolean) : [];
  const nameArr = namePath ? namePath.split('>').filter(Boolean) : [];

  const cAny = c as Record<string, unknown>;

  // saleAttrList:用渠道定义当骨架,把每个 attr 的 saleAttrValueList 补齐
  //   - create:骨架 + 值都来自源端 detail(源 detail 里 ch200/ch300 经常给空数组,
  //     此时用 SKU 反聚合的值兜底),否则京东/饿了么创建时报"多规格销售属性必填"。
  //   - update:骨架优先用**目标渠道**的 saleAttrList(attrId/attrName 与目标店一致),
  //     值用 aggregatedSaleAttrs 兜底 —— 上层在 update 方向已把聚合数据源切换成目标商品 detail,
  //     因此补进去的是目标店现有销售属性,既满足"必填"又不构成"变更"
  //     (避免"已推送渠道销售属性不允许变更")。
  const sourceSaleAttrs = (
    (direction === 'update' && target?.saleAttrList && target.saleAttrList.length > 0
      ? target.saleAttrList
      : c.saleAttrList) ?? []
  ) as Array<Record<string, unknown>>;
  const saleAttrList = mergeSaleAttrList(sourceSaleAttrs, aggregatedSaleAttrs);

  const out: Record<string, unknown> = {
    channelId,
    channelName: c.channelName ?? null,
    categoryCode: c.categoryCode ?? null,
    categoryName: c.categoryName ?? null,
    categoryCodePath: codePath || null,
    categoryNamePath: namePath || null,
    categoryProperties: props,
    saleAttrList,
    skuPicSetting: c.skuPicSetting ?? null,
  };

  if (direction === 'create') {
    // create 渠道携带的 UI 元数据(加在合适位置,顺序参考抓包)
    out.loading = false;
    out.value = codeArr;
    out.idPath = codePath;
    out.categoryId = c.categoryCode ?? null;
    out.defaultValue = [] as unknown[];
    out.level = codeArr.length;
    out.parentCategoryId = codeArr[codeArr.length - 2] ?? null;
    out.supportSpecType = c.supportSpecType ?? null;
    out.children = null;
    // saleAttrInfoVOList 是 store/detail 时代的字段;tenant/detail 用 saleAttrList 承载
    // 这里用 merge 后的 saleAttrList 兜底,保持与 saleAttrList 一致
    out.saleAttrInfoVOList = (cAny.saleAttrInfoVOList as unknown[] | undefined)
      ?? (saleAttrList.length > 0 ? saleAttrList : []);
    out.checkUpcStatus = null;
    out.upcRequired = c.upcRequired ?? null;
    out.resourceType = c.resourceType ?? 1;
    out.existedInRetailAndMedicine = c.existedInRetailAndMedicine ?? null;
    out.isExtendCategory = null;
    out.medicalDeviceQuaRequirement = c.medicalDeviceQuaRequirement ?? 0;
    out.dyRecommendId = null;
    out.namePath = namePath;
    out.afterSaleServiceType = c.afterSaleServiceType ?? '';
    void nameArr; // namePath 已经传字符串,数组形式仅供后续扩展
  } else {
    // update 渠道携带的审核相关 null 占位
    out.upcRequired = pickChannelField<number>(target, c, 'upcRequired') ?? null;
    out.resourceType = pickChannelField<number>(target, c, 'resourceType') ?? 1;
    out.existedInRetailAndMedicine =
      pickChannelField<number>(target, c, 'existedInRetailAndMedicine') ?? null;
    out.medicalDeviceQuaRequirement =
      pickChannelField<unknown>(target, c, 'medicalDeviceQuaRequirement') ?? null;
    out.supportSpecType = pickChannelField<number>(target, c, 'supportSpecType') ?? 2;
    out.categoryCanModify = target?.categoryCanModify ?? c.categoryCanModify ?? null;
    out.afterSaleServiceType = target?.afterSaleServiceType ?? c.afterSaleServiceType ?? '';
    out.auditInfo = null;
    out.channelOnlineStatus = pickChannelField<number>(target, c, 'channelOnlineStatus') ?? null;
    out.materialAuditList = null;
    out.qualificationList = null;
    out.channelSpuList = null;
    out.recommendId = null;
    out.categoryId = c.categoryCode ?? null;
    out.idPath = codePath;
    out.namePath = namePath;
  }

  // 京东到家(300)单独的 brandInfo —— tenant/detail 直接把品牌挂在渠道下:
  // spuChannelInfoList[channelId=300].brandInfo = { brandCode, brandName }
  if (channelId === 300) {
    const jd = c.brandInfo;
    if (jd?.brandCode && jd?.brandName) {
      out.brandInfo =
        direction === 'create'
          ? { channelId: 300, brandCode: jd.brandCode, brandName: jd.brandName }
          : { brandCode: jd.brandCode, brandName: jd.brandName };
    } else if (direction === 'update') {
      out.brandInfo = { clean: true };
    }
  } else if (direction === 'update') {
    // update 抓包里 ch100/ch200 的 brandInfo 都给 { clean: true }
    out.brandInfo = { clean: true };
  }

  if (specialPictureList && specialPictureList.length > 0) {
    out.specialPictureList = specialPictureList;
  }
  return out;
}

/* ============================================================
   多规格销售属性聚合
   ----------------------------------------------------------
   多规格商品(specType=2)的 spuChannelInfoList[].saleAttrList[].saleAttrValueList
   京东 / 饿了么必填,但源端 detail 经常只填了 ch100。
   每个 SKU 的 skuChannelInfoList[].saleAttrValueList 都给了 attrId/attrName/attrValue,
   按 channel + attr 反聚合一次,把 SKU 顺序的 attrValue 列表收集起来,作为渠道级别 saleAttrValueList。
   ============================================================ */

interface ChannelSaleAttr {
  attrId: string;
  attrName: string;
  picRelated?: boolean;
  attrSortNum?: number;
  /** 按 SKU 出现顺序去重得到的属性值列表 */
  values: Array<{ attrValueName: string; attrValueId: string | null; attrValueSortNum: number }>;
}

/** 从 detail.skus[].skuChannelInfoList[].saleAttrValueList 反聚合 */
function buildChannelSaleAttrAgg(detail: RawProductDetail): Map<number, Map<string, ChannelSaleAttr>> {
  const out = new Map<number, Map<string, ChannelSaleAttr>>();
  for (const s of detail.skus ?? []) {
    for (const ch of s.skuChannelInfoList ?? []) {
      if (ch.channelId == null) continue;
      const channelId = ch.channelId;
      let byAttr = out.get(channelId);
      if (!byAttr) {
        byAttr = new Map<string, ChannelSaleAttr>();
        out.set(channelId, byAttr);
      }
      for (const v of ch.saleAttrValueList ?? []) {
        if (v.attrId == null || !v.attrName || !v.attrValue) continue;
        const key = String(v.attrId);
        let entry = byAttr.get(key);
        if (!entry) {
          entry = {
            attrId: key,
            attrName: v.attrName,
            picRelated: false,
            attrSortNum: 0,
            values: [],
          };
          byAttr.set(key, entry);
        }
        if (!entry.values.some((x) => x.attrValueName === v.attrValue)) {
          entry.values.push({
            attrValueName: v.attrValue,
            attrValueId: v.attrValueId ?? null,
            attrValueSortNum: entry.values.length + 1,
          });
        }
      }
    }
  }
  return out;
}

/**
 * 合并源 saleAttrList 和聚合的 SKU 维度数据:
 *   - 优先用源端 saleAttrList 的元数据(attrName / picRelated / attrSortNum 等)
 *   - 当源端 saleAttrValueList 为空时,从聚合表里取
 *   - 如果源端没有这条 attr 但聚合里有,就直接补一条(京东 ch300 多规格场景)
 */
function mergeSaleAttrList(
  sourceList: Array<Record<string, unknown>>,
  agg: Map<string, ChannelSaleAttr> | undefined,
): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();

  for (const src of sourceList) {
    const attrId = String(src.attrId ?? '');
    if (!attrId) continue;
    seen.add(attrId);
    const srcValues = (src.saleAttrValueList as Array<Record<string, unknown>> | undefined) ?? [];
    let saleAttrValueList: Array<Record<string, unknown>> = srcValues;
    if (saleAttrValueList.length === 0 && agg) {
      const fromAgg = agg.get(attrId);
      if (fromAgg) {
        saleAttrValueList = fromAgg.values.map((v) => ({
          attrValueName: v.attrValueName,
          attrValueId: v.attrValueId,
          attrValueSortNum: v.attrValueSortNum,
        }));
      }
    }
    result.push({
      attrId,
      attrName: src.attrName ?? '',
      picRelated: src.picRelated ?? false,
      saleAttrValueList,
      attrSortNum: src.attrSortNum ?? 0,
    });
  }

  // 源端 saleAttrList 没列出但聚合里有(罕见,兜底)
  if (agg) {
    for (const [attrId, entry] of agg) {
      if (seen.has(attrId)) continue;
      result.push({
        attrId,
        attrName: entry.attrName,
        picRelated: entry.picRelated ?? false,
        saleAttrValueList: entry.values.map((v) => ({
          attrValueName: v.attrValueName,
          attrValueId: v.attrValueId,
          attrValueSortNum: v.attrValueSortNum,
        })),
        attrSortNum: entry.attrSortNum ?? 0,
      });
    }
  }

  return result;
}

/** categoryProperties[k] 元素改写:attrId 转 number,customValue 元素裁剪 */
function convertCategoryProperty(
  direction: V2Direction,
  p: Record<string, unknown>,
): CategoryProperty {
  const customValue = ((p.customValue as Array<Record<string, unknown>>) ?? []).map((cv) => {
    return slimCustomValue(direction, cv);
  });
  const attrIdRaw = p.attrId;
  const attrIdNum =
    typeof attrIdRaw === 'string' ? Number.parseInt(attrIdRaw, 10) : (attrIdRaw as number);
  return {
    attrId: attrIdNum,
    attrName: p.attrName as string,
    attrValueType: p.attrValueType as string,
    characterType: (p.characterType as string | null) ?? null,
    maxTextLength: (p.maxTextLength as number | null) ?? null,
    isRequired: (p.isRequired as number) ?? 2,
    attrSequence: (p.attrSequence as number) ?? 0,
    customValue,
    optionList: ((p.optionList as Array<Record<string, unknown>>) ?? []) as unknown[],
    structAttrTemplateList: ((p.structAttrTemplateList as Array<Record<string, unknown>>) ?? []) as unknown[],
    originalInputValue: (p.originalInputValue as string | null) ?? null,
    optionMaxSize: (p.optionMaxSize as number) ?? 0,
    supportExtend: (p.supportExtend as boolean) ?? false,
  };
}

/**
 * customValue[*] 元素瘦身:
 *   - 去掉 douyinDiyType / childrenJson(detail 里多出来的"始终为 null"字段)
 *   - 普通枚举:只保留 attrValueId / attrValue
 *   - 结构化属性:保留 structAttrValueList,内部 valueList 元素去掉 moduleId/unitId/unitName 等空字段
 *
 * 这块结构 create 与 update 形态略有差异:create 抓包里普通枚举不会带 attrValueId:null+attrValue:null
 * 的"占位 customValue"项,而是直接整段省略;但 update 抓包里有时会带占位项。
 * 安全做法:保留占位项,但内部清理空键。
 */
function slimCustomValue(
  direction: V2Direction,
  cv: Record<string, unknown>,
): Record<string, unknown> {
  void direction;
  const out: Record<string, unknown> = {};
  if (cv.attrValueId != null) out.attrValueId = cv.attrValueId;
  if (cv.attrValue != null) out.attrValue = cv.attrValue;
  if (Array.isArray(cv.structAttrValueList) && (cv.structAttrValueList as unknown[]).length > 0) {
    out.structAttrValueList = (cv.structAttrValueList as Array<Record<string, unknown>>).map(
      (g) => {
        const valueList = ((g.valueList as unknown[]) ?? []).map((row) =>
          (row as Array<Record<string, unknown>>).map((cell) => {
            const slim: Record<string, unknown> = {};
            if (cell.sequence != null) slim.sequence = cell.sequence;
            if (cell.value != null) slim.value = cell.value;
            if (cell.optionId != null) slim.optionId = cell.optionId;
            if (cell.optionValue != null) slim.optionValue = cell.optionValue;
            return slim;
          }),
        );
        const slim: Record<string, unknown> = { valueList };
        if (g.formatType != null) slim.formatType = g.formatType;
        if (g.templateId != null) slim.templateId = g.templateId;
        return slim;
      },
    );
  }
  return out;
}

/** mt/elmSpecialPictureList 元素瘦身:去掉 customized/deleted,保留有意义字段 */
function trimSpecialPictures(
  list: Array<Record<string, unknown>> | null | undefined,
): SpecialPicture[] {
  return (list ?? []).map((p) => ({
    pictureType: p.pictureType as number | undefined,
    pictureTitle: p.pictureTitle as string | undefined,
    pictureDesc: p.pictureDesc as string | undefined,
    pictureExample: (p.pictureExample as string[] | null | undefined) ?? null,
    isRequired: p.isRequired as number | undefined,
    isDisplay: p.isDisplay as number | undefined,
    numLimit: p.numLimit as number | undefined,
    numMin: p.numMin as number | undefined,
    pictureUrl: ((p.pictureUrl as string[] | null | undefined) ?? []).filter((u) => !!u),
  }));
}

/** 从 ch100「品牌」属性派生顶层 brand;tenant/detail 顶层 brand 通常已填充 */
function pickBrand(
  detail: RawProductDetail,
  ch100: NonNullable<RawProductDetail['spuChannelInfoList']>[number] | undefined,
): { brandCode: string | null; brandName: string | null } {
  const top = detail.brand;
  if (top?.brandCode && top?.brandName) {
    return { brandCode: top.brandCode, brandName: top.brandName };
  }
  // 兜底:从 ch100「品牌」属性 customValue 提取
  const props = ch100?.categoryProperties;
  const brandAttr = (props ?? []).find((p) => p.attrName === '品牌');
  const cv = ((brandAttr?.customValue as Array<{ attrValueId?: string; attrValue?: string }>) ??
    [])[0];
  if (cv?.attrValueId && cv?.attrValue) {
    return { brandCode: cv.attrValueId, brandName: cv.attrValue };
  }
  return { brandCode: null, brandName: detail.brandName ?? null };
}

/** ch100「国产/进口」属性派生 originPlace:1=国产, 2=进口;不能识别给 1 兜底 */
function deriveOriginPlace(
  ch100: NonNullable<RawProductDetail['spuChannelInfoList']>[number] | undefined,
): number {
  const props = ch100?.categoryProperties;
  const attr = (props ?? []).find((p) => p.attrName === '国产/进口');
  const cv = ((attr?.customValue as Array<{ attrValue?: string }>) ?? [])[0];
  const v = cv?.attrValue;
  if (v === '进口') return 2;
  return 1;
}

/**
 * 判断 raw.detail 里 videoInfo 是不是因为视频被跳过而残留的"空对象"。
 * 用 videoUrl 是否为空串作为信号。
 */
function rawDetailHasEmptyVideo(detail: unknown): boolean {
  if (!detail || typeof detail !== 'object') return false;
  const d = detail as Record<string, unknown>;
  const v = d.videoInfo as { videoUrl?: string } | null | undefined;
  const isEmpty = (x: { videoUrl?: string } | null | undefined) =>
    !!x && (x.videoUrl === '' || x.videoUrl == null);
  return isEmpty(v);
}

/** 从 spuChannelInfoList[i] 上挑一个字段;target 优先,source 兜底。 */
function pickChannelField<T>(
  target: NonNullable<RawProductDetail['spuChannelInfoList']>[number] | undefined,
  source: NonNullable<RawProductDetail['spuChannelInfoList']>[number] | undefined,
  key: string,
): T | undefined {
  const t = target as Record<string, unknown> | undefined;
  const s = source as Record<string, unknown> | undefined;
  if (t && t[key] != null) return t[key] as T;
  if (s && s[key] != null) return s[key] as T;
  return undefined;
}

// ============================================================
// 8) 同步零售价(分渠道固定价)
//    接口: POST /api/v1/price/adjustSkuOnlinePriceSyncStrategy
//
// 一次只处理一个 SPU,把它下面的若干 SKU 的分渠道价格一次性下发。
//   - scenarioCode: 104(门店商品列表调价场景,抓包恒定)
//   - actCheckType: 2
//   - asyncUpdateStoreList: [](只改当前门店,不联动其它门店)
//   - syncStrategyType: 1(固定价)
//   - extend.autoUseHqPriceFormValue: 1
// 默认把同一个价格下发到渠道 100(美团闪购)/ 200(饿了么)。
// ============================================================

interface AdjustPriceResp {
  code: number;
  msg?: string;
  success?: boolean;
  data?: {
    createAsyncTask?: boolean;
    adjustPriceResultList?: unknown;
  };
}

export async function adjustSkuPrice(payload: {
  storeId: string | number;
  spuId: string | number;
  skuPriceList: import('@shared/messaging').SkuPriceAdjust[];
}): Promise<void> {
  const channelSkuInfoList = payload.skuPriceList.map((sku) => {
    return {
      skuId: String(sku.skuId),
      skuPriceStrategyList: sku.channelPrices.map((cp) => ({
        channelId: cp.channelId,
        syncStrategyType: 1,
        fixedPrice: cp.fixedPrice,
      })),
    };
  });

  const body = {
    storeId: Number(payload.storeId),
    spuId: String(payload.spuId),
    scenarioCode: 104,
    asyncUpdateStoreList: [] as unknown[],
    actCheckType: 2,
    channelSkuInfoList,
    extend: { autoUseHqPriceFormValue: 1 },
  };

  const resp = await siteFetch<AdjustPriceResp>(
    qnhApiPath('/api/v1/price/adjustSkuOnlinePriceSyncStrategy'),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'm-appkey': 'fe_recofesaascrm',
        qnhreferrer: '/unifiedGoods/store/spu-list',
      },
      body: JSON.stringify(body),
    },
  );

  if (resp?.code !== 0 || resp?.success === false) {
    throw new Error(`同步零售价失败: code=${resp?.code} msg=${resp?.msg ?? 'unknown'}`);
  }
}

// ============================================================
// 9) 同步库存(绝对值覆盖)
//    接口: POST /api/v1/storeempower/operate/batchContainer/stockadjustment
//
// 一次可处理一个门店下的多个 SKU,库存按"新值覆盖旧值"。
//   - entityType: 3(门店)
//   - oldQuantity 传 0 即可(后端按 newQuantity 绝对值覆盖,回执里会带真实变更)
//   - customizeStockFlag: 1
// ============================================================

interface AdjustStockResp {
  code: number;
  msg?: string;
  success?: boolean;
  data?: {
    code?: number;
    msg?: string;
    receiptNo?: string;
    failSkuList?: unknown;
  };
}

export async function adjustSkuStock(payload: {
  storeId: string | number;
  skuStockList: import('@shared/messaging').SkuStockAdjust[];
}): Promise<{ receiptNo?: string }> {
  const body = {
    comment: 'WEB-门店商品列表调整库存',
    entityId: Number(payload.storeId),
    entityType: 3,
    skuList: payload.skuStockList.map((sku) => ({
      skuId: String(sku.skuId),
      skuName: sku.skuName ?? String(sku.skuId),
      comment: '',
      enableExpiredCheck: false,
      customizeStockFlag: 1,
      batchContainerInfoList: [
        {
          newQuantity: sku.newQuantity,
          oldQuantity: 0,
          originLocationCode: '',
        },
      ],
    })),
  };

  const resp = await siteFetch<AdjustStockResp>(
    qnhApiPath('/api/v1/storeempower/operate/batchContainer/stockadjustment'),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'm-appkey': 'fe_recofesaascrm',
        qnhreferrer: '/unifiedGoods/store/spu-list',
      },
      body: JSON.stringify(body),
    },
  );

  // 外层 code=0 且内层 data.code=0 才算成功;data.failSkuList 非空说明部分失败
  if (resp?.code !== 0 || resp?.success === false) {
    throw new Error(`同步库存失败: code=${resp?.code} msg=${resp?.msg ?? 'unknown'}`);
  }
  if (resp.data?.code != null && resp.data.code !== 0) {
    throw new Error(`同步库存失败: ${resp.data?.msg ?? 'unknown'}`);
  }
  const failList = resp.data?.failSkuList;
  if (Array.isArray(failList) && failList.length > 0) {
    throw new Error(`同步库存部分失败: ${JSON.stringify(failList).slice(0, 200)}`);
  }
  return { receiptNo: resp.data?.receiptNo };
}

// ============================================================
// 10) 门店维度补充信息:某 SPU 下各 SKU 的「门店库存 + 分渠道零售价」
//     接口: POST /qnh-gw3/api/product/store/detail
//
// 主数据(图文 / 渠道 / 属性)走 tenant/detail;store/detail 只用于补齐
// tenant 维度拿不到的两类门店覆盖层数据:
//   - 库存:storeSkuList[].stock
//   - 分渠道零售价:storeSkuList[].onlinePriceList[].{channelId, onlinePrice}
//     (顶层 onlinePrice 是兜底;channelSkuList[].channelSkuPrice 也可佐证)
// 按 skuId 聚合返回,供导出阶段写进 products/<spuId>.json。
// ============================================================

interface StoreDetailResp {
  code: number;
  msg?: string;
  data?: {
    storeId?: string | number;
    spuId?: string | number;
    storeSkuList?: Array<{
      skuId: string | number;
      stock?: string | number | null;
      storePrice?: string | number | null;
      upc?: string | null;
      upcList?: string[] | null;
      onlinePrice?: string | number | null;
      onlinePriceList?: Array<{
        channelId?: number;
        onlinePrice?: string | number | null;
      }> | null;
    }>;
  };
}

export async function fetchStoreSkuInfo(payload: {
  shopId: string | number;
  spuId: string | number;
}): Promise<import('@shared/messaging').StoreSkuInfo[]> {
  const resp = await siteFetch<StoreDetailResp>(
    qnhApiPath('/qnh-gw3/api/product/store/detail'),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'm-appkey': 'fe_recofesaascrm',
        qnhreferrer: '/unifiedGoods/store/edit',
      },
      body: JSON.stringify({ storeId: Number(payload.shopId), spuId: String(payload.spuId) }),
    },
    parseProductResponse,
  );

  if (resp?.code !== 0 || !resp.data) {
    throw new Error(`门店商品详情接口失败: ${resp?.msg ?? 'unknown'}`);
  }
  const { storeId, spuId, storeSkuList } = resp.data;
  if ((storeId != null && String(storeId) !== String(payload.shopId)) ||
      (spuId != null && String(spuId) !== String(payload.spuId))) {
    throw new Error('返回的门店商品详情与请求的门店或 SPU ID 不一致。');
  }

  const parseNum = (v: string | number | null | undefined): number | undefined => {
    if (v == null || v === '') return undefined;
    const n = typeof v === 'number' ? v : Number.parseFloat(v);
    return Number.isFinite(n) ? n : undefined;
  };

  return (storeSkuList ?? [])
    .filter((s) => s.skuId != null)
    .map((s) => {
      const channelPrices: Array<{ channelId: number; price: number }> = [];
      const seen = new Set<number>();
      for (const p of s.onlinePriceList ?? []) {
        if (p.channelId == null) continue;
        const price = parseNum(p.onlinePrice);
        if (price == null || seen.has(p.channelId)) continue;
        seen.add(p.channelId);
        channelPrices.push({ channelId: p.channelId, price });
      }
      return {
        skuId: s.skuId,
        stock: parseNum(s.stock),
        storePrice: parseNum(s.storePrice),
        onlinePrice: parseNum(s.onlinePrice),
        channelPrices,
        upcList: readSkuUpcs(s),
      };
    });
}
