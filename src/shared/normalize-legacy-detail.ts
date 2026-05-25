/**
 * 旧版导出包(早期 store/detail 接口形态)→ 新版 tenant/detail 形态归一化。
 *
 * 背景:
 *   - v1 版的 fetchProductDetail 调的是 store/detail,raw.detail 里有
 *     storeSkuList / channelSpuList / picInfoList / tenantMainFrontCategoryList /
 *     pictureContents / channelDynamicInfoBizDTOList 这一组字段。
 *   - 当前 fetchProductDetail 调 tenant/detail,raw.detail 里是
 *     skus / spuChannelInfoList / picUrlList / storeFrontCategoryList /
 *     picContentList / categoryProperties。
 *   - buildTenantSpuV2 / validateFrontCategories / isProductSame 都按新版字段读取。
 *     旧导出包跑过来 detail.skus / spuChannelInfoList 为空,直接被拒"[入参skuList非法]"。
 *
 * 解决:在 import 阶段把每个 spu.raw.detail 走一遍这个归一化函数,
 * 把它整成新版形态,后续所有逻辑都按一种形态处理。
 *
 * 这个函数是幂等的:发现是新形态(已经有 skus / spuChannelInfoList)直接原样返回。
 */
export function normalizeLegacyDetail(input: unknown): unknown {
  if (!input || typeof input !== 'object') return input;
  const detail = input as Record<string, unknown>;

  // 已经是新形态 → 直接返回
  if (Array.isArray(detail.skus)) return detail;
  // 既不是新形态也不是旧形态 → 不动
  if (!Array.isArray(detail.storeSkuList)) return detail;

  const out: Record<string, unknown> = { ...detail };

  // ---- picUrlList(优先 tenantPicInfoList) ----
  const picSrc =
    (asArray(detail.tenantPicInfoList) ?? []).length > 0
      ? (asArray(detail.tenantPicInfoList) ?? [])
      : (asArray(detail.picInfoList) ?? []);
  out.picUrlList = picSrc
    .filter((p): p is { picUrl?: unknown; isDelete?: unknown } => !!p && typeof p === 'object')
    .filter((p) => !p.isDelete && typeof p.picUrl === 'string' && p.picUrl)
    .map((p) => p.picUrl as string);

  // ---- picContentList(优先 tenantPicContents) ----
  const picContent =
    (asArray(detail.tenantPicContents) ?? []).length > 0
      ? asArray(detail.tenantPicContents)
      : asArray(detail.pictureContents);
  out.picContentList = (picContent ?? []).filter(
    (s): s is string => typeof s === 'string' && !!s,
  );

  // ---- videoInfo(优先 tenantVideoInfo) ----
  const v = (detail.tenantVideoInfo ?? detail.videoInfo) as
    | { videoUrl?: string; coverUrl?: string; coverImageUrl?: string }
    | null
    | undefined;
  out.videoInfo = v?.videoUrl
    ? {
        videoUrl: v.videoUrl,
        coverImageUrl: v.coverImageUrl ?? v.coverUrl ?? '',
      }
    : null;

  // ---- skus[] from storeSkuList[] ----
  const tenantId = detail.tenantId;
  const spuId = detail.spuId;
  out.skus = (asArray(detail.storeSkuList) ?? []).map((raw) => {
    const s = raw as Record<string, unknown>;
    // 价格:优先 storeSuggestPrice(它才是 { tenantSuggestPrice: { unifiedSuggestPrice } } 形态),
    // 老导出包里 storeSku.suggestPrice 经常是 0 这种裸数字,直接喂给 buildTenantSkuV2 会让请求体
    // 出现 unifiedSuggestPrice:"0",触发"保存建议零售价异常"。
    const storeSuggest = s.storeSuggestPrice as
      | { tenantSuggestPrice?: { unifiedSuggestPrice?: string } }
      | undefined;
    const suggestRaw = s.suggestPrice;
    const suggestObj =
      suggestRaw && typeof suggestRaw === 'object'
        ? (suggestRaw as { tenantSuggestPrice?: { unifiedSuggestPrice?: string } })
        : undefined;
    const suggest = suggestObj ?? storeSuggest ?? null;
    return {
      tenantId,
      spuId,
      skuId: s.skuId,
      specName: (s.spec as string) ?? (s.specName as string) ?? '',
      saleUnit: s.saleUnit ?? '',
      upcList: asArray(s.upcList) ?? [],
      weightForUnit: s.weightForUnit ?? '',
      weightUnit: s.weightUnit ?? '',
      weight: s.weight,
      minOrderCount: s.minOrderCount ?? 1,
      suggestPrice: suggest,
      skuSaleType: s.skuSaleType ?? 1,
      onlineStatus: s.onlineStatus ?? 1,
      onlineChannels: asArray(s.onlineChannels) ?? [],
      onlineChannelType: s.channelPriceType ?? 1,
      customizeNoUpcCode: s.customizeNoUpcCode ?? 0,
      manageSNCode: s.manageSNCode ?? null,
      externalCode: s.externalCode ?? null,
      goodsCode: s.goodsCode ?? null,
      expirationDays: s.expirationDays ?? null,
      expirationUnit: s.expirationUnit ?? null,
      expirationForUnit: s.expirationForUnit ?? null,
      cartonMeasureConvertFactorList: asArray(s.cartonMeasureConvertFactorList) ?? null,
      childSkuList: asArray(s.childSkuList) ?? null,
      skuChannelInfoList: null,
      skuPicUrlList: [],
      spuPicUrlList: out.picUrlList,
      volume: s.volume ?? null,
      erpTenantSkuExtend: null,
      composeSku: s.isComposeSku ? 1 : 0,
    };
  });

  // ---- spuChannelInfoList[] from channelSpuList[] ----
  out.spuChannelInfoList = (asArray(detail.channelSpuList) ?? []).map((raw) => {
    const c = raw as Record<string, unknown>;
    const cat = c.channelCategory as Record<string, unknown> | undefined;
    return {
      channelId: c.channelId,
      channelName: c.channelName ?? null,
      categoryCode: (cat?.channelCategoryCode as string) ?? null,
      categoryName: (cat?.channelCategoryName as string) ?? null,
      categoryCodePath: (cat?.channelCategoryCodePath as string) ?? null,
      categoryNamePath: (cat?.channelCategoryNamePath as string) ?? null,
      categoryProperties: asArray(cat?.channelDynamicInfoBizDTOList) ?? [],
      saleAttrList: asArray(cat?.saleAttrList) ?? [],
      skuPicSetting: c.skuPicSetting ?? null,
      upcRequired: cat?.upcRequired ?? null,
      resourceType: cat?.resourceType ?? null,
      existedInRetailAndMedicine: cat?.existedInRetailAndMedicine ?? null,
      medicalDeviceQuaRequirement: cat?.medicalDeviceQuaRequirement ?? null,
      supportSpecType: cat?.supportSpecType ?? null,
      categoryCanModify: null,
      afterSaleServiceType: c.afterSaleServiceType ?? null,
      auditInfo: null,
      channelOnlineStatus: c.onlineStatus ?? null,
      channelSpuList: null,
      qualificationList: null,
      materialAuditList: null,
      recommendId: null,
    };
  });

  // ---- ch300 brandInfo 从 tenantChannelBrandList[] 派生 ----
  const ch300Brand = (asArray(detail.tenantChannelBrandList) ?? [])
    .map((b) => b as Record<string, unknown>)
    .find((b) => b?.channelId === 300);
  if (ch300Brand) {
    const channelList = out.spuChannelInfoList as Array<Record<string, unknown>>;
    const ch300 = channelList.find((c) => c.channelId === 300);
    if (ch300) {
      ch300.brandInfo = {
        brandCode: ch300Brand.brandCode,
        brandName: ch300Brand.brandName,
      };
    }
  }

  // ---- 顶层 brand 兜底(优先 ch100「品牌」属性,这里只兜底 brandName) ----
  if (!detail.brand && detail.brandName) {
    out.brand = { brandCode: null, brandName: detail.brandName };
  }

  // ---- backendCategoryCode ----
  const backendCat = detail.backendCategory as Record<string, unknown> | undefined;
  if (backendCat?.categoryCode && !detail.backendCategoryCode) {
    out.backendCategoryCode = backendCat.categoryCode;
  }

  // ---- storeFrontCategoryList[] from tenantMainFrontCategoryList[] ----
  const frontSrc =
    (asArray(detail.tenantMainFrontCategoryList) ?? []).length > 0
      ? (asArray(detail.tenantMainFrontCategoryList) ?? [])
      : (asArray(detail.mainFrontCategoryList) ?? []);
  out.storeFrontCategoryList = frontSrc.map((raw) => {
    const g = raw as Record<string, unknown>;
    return {
      groupId: g.groupId ?? 0,
      storeCategoryList: [
        {
          categoryCode: g.frontCategoryId,
          name: g.frontCategoryName,
          namePath: g.frontCategoryNamePath,
          channelIdList: asArray(g.channelIdList) ?? null,
        },
      ],
      auxiliaryStoreCategoryList: null,
      allCategoryCodeList: g.frontCategoryId ? [g.frontCategoryId] : null,
    };
  });

  return out;
}

function asArray(x: unknown): unknown[] | null {
  return Array.isArray(x) ? x : null;
}
