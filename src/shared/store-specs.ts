interface SaleAttr {
  attrId?: string | number;
  attrName?: string;
  attrValue?: string;
  attrValueId?: string | null;
  picRelated?: boolean;
}

export interface StoreSpecDetail {
  specType?: number;
  spuChannelInfoList?: Array<{ channelId?: number; saleAttrList?: SaleAttr[] | null }>;
  skus?: Array<{ specName?: string; skuChannelInfoList?: Array<{
    channelId?: number; saleAttrValueList?: SaleAttr[] | null;
  }> | null }>;
}

/** 京东多规格新建需要渠道上的规格定义及每个 SKU 上同编号的实际取值。 */
export function jdStoreSpecs(detail: StoreSpecDetail | undefined) {
  if (!detail || Number(detail.specType) !== 2) return;
  const channel = detail.spuChannelInfoList?.find(c => Number(c.channelId) === 300);
  if (!channel) {
    if (detail.skus?.some(s => s.skuChannelInfoList?.some(c => Number(c.channelId) === 300))) {
      throw new Error('商品有京东到家 SKU，但缺少京东渠道配置，请在源商品补齐后重新导出。');
    }
    return;
  }
  const definitions = new Map<string, { attrId: string; attrName: string }>();
  const define = (attr: SaleAttr) => {
    const id = String(attr.attrId ?? '').trim();
    const name = attr.attrName?.trim();
    if (!id || !name || (definitions.has(id) && definitions.get(id)!.attrName !== name)) {
      throw new Error('京东到家规格定义缺少编号、名称或二者不一致，请在源商品补齐后重新导出。');
    }
    definitions.set(id, { attrId: id, attrName: name });
  };
  for (const attr of channel.saleAttrList ?? []) define(attr);
  const rows = (detail.skus ?? []).map(sku => {
    const attrs = sku.skuChannelInfoList?.find(c => Number(c.channelId) === 300)?.saleAttrValueList ?? [];
    for (const attr of attrs) define(attr);
    return { name: sku.specName, attrs };
  });
  if (!definitions.size) throw new Error('缺少京东到家的销售规格编号和取值，请在源商品补齐后重新导出。');
  const dimensions = [...definitions.values()];
  const values = rows.map(row => dimensions.map(d => {
    const matches = row.attrs.filter(a => String(a.attrId) === d.attrId);
    const value = matches[0]?.attrValue?.trim();
    if (matches.length !== 1 || !value) {
      throw new Error(`规格「${row.name ?? ''}」的京东到家「${d.attrName}」缺失或重复，请在源商品补齐后重新导出。`);
    }
    return { ...d, picRelated: matches[0].picRelated ?? channel.saleAttrList?.find(a => String(a.attrId) === d.attrId)?.picRelated ?? false,
      attrValue: value, ...(matches[0].attrValueId != null ? { attrValueId: matches[0].attrValueId } : {}) };
  }));
  return { dimensions, values };
}
