import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';

const bundle = await build({
  stdin: {
    contents: [
      "export { runSync } from './src/content/sync'",
      "export { runImport, lookupExistingForProduct } from './src/content/import'",
      "export { exportFilterKey } from './src/content/export'",
      "export { createProduct } from './src/injected/api'",
    ].join('\n'),
    resolveDir: process.cwd(),
  },
  bundle: true, format: 'esm', write: false, footer: { js: '//# sourceURL=qnh-product-workflows.js' },
});
const { runSync, runImport, lookupExistingForProduct, exportFilterKey, createProduct } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`
);

function directory(files, subdirs = {}) {
  return {
    async getFileHandle(name, options) {
      if (options?.create && !(name in files)) files[name] = '';
      if (!(name in files)) throw new DOMException(name, 'NotFoundError');
      return {
        getFile: async () => new Blob([files[name]]),
        createWritable: async () => ({ async write(value) { files[name] = value; }, async close() {} }),
      };
    },
    async getDirectoryHandle(name) {
      if (!(name in subdirs)) throw new DOMException(name, 'NotFoundError');
      return subdirs[name];
    },
    async *values() { for (const name of Object.keys(files)) yield { kind: 'file', name }; },
  };
}

const product = {
  sourceSpuId: '1', name: '测试商品', sourceCategoryNamePath: [], sourceCategoryPath: [1],
  skus: [
    { outerSkuCode: 'A', specs: [], stock: 3, price: 5 },
    { outerSkuCode: 'B', specs: [], stock: 7, price: 9 },
  ],
};

function pack(files, ids = ['1']) {
  return directory({
    'manifest.json': JSON.stringify({ source: {}, productCount: ids.length, productIds: ids }),
  }, { products: directory(files) });
}

test('门店多规格逐 SKU 组装总部零售价和京东属性，缺少规格时不提交', async t => {
  const original = globalThis.location;
  globalThis.location = new URL('https://test.invalid');
  t.after(() => { if (original) globalThis.location = original; else delete globalThis.location; });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push(JSON.parse(init.body));
    return Response.json({ code: 0, spuId: '123' });
  });
  const skus = ['XL', 'XXL'].map((specName, i) => ({
    skuId: i + 1, specName, saleUnit: '件',
    suggestPrice: { tenantSuggestPrice: { channelSuggestPriceList: [
      { channelId: '100', suggestPrice: '59.00' }, { channelId: '300', suggestPrice: i ? '69' : '59' },
    ] } },
    skuChannelInfoList: [{ channelId: 300, saleAttrValueList: [{ attrId: 1577303, attrName: '尺码', attrValue: specName }] }],
  }));
  const detail = { specType: 2, skus, spuChannelInfoList: [{ channelId: 300, saleAttrList: [{ attrId: '1577303', attrName: '尺码' }] }] };
  const args = { scope: 'store', shopId: 12, mediaIdMap: {}, product: {
    ...product, raw: { detail }, skus: skus.map(s => ({ sourceSkuId: s.skuId, price: 0 })),
  } };
  await createProduct(args);
  const { tenantSpu, storeSpu } = requests[0];
  assert.deepEqual(tenantSpu.skus.map(s => s.suggestPrice.tenantSuggestPrice), [
    { unifiedSuggestPrice: '59' }, { channelSuggestPriceList: [{ channelId: '100', suggestPrice: '59' }, { channelId: '300', suggestPrice: '69' }] },
  ]);
  assert.deepEqual(storeSpu.skuList.map(s => s.storePrice), ['9999', '9999']);
  assert.deepEqual(tenantSpu.spuChannelInfoList[0].saleAttrList, [{ attrId: '1577303', attrName: '尺码' }]);
  for (const s of tenantSpu.skus) {
    assert.deepEqual(s.skuChannelInfoList[0].saleAttrValueList, [{ attrId: '1577303', attrName: '尺码', picRelated: false, attrValue: s.specName }]);
  }
  skus[1].skuChannelInfoList[0].saleAttrValueList = [];
  await assert.rejects(createProduct(args), /XXL.*京东到家.*尺码/);
  assert.equal(requests.length, 1);
});

function mockExtension(t, getBytes) {
  const records = new Map();
  const previous = globalThis.chrome;
  globalThis.chrome = {
    storage: { local: {
      async get(keys) { return Object.fromEntries(keys.filter(k => records.has(k)).map(k => [k, structuredClone(records.get(k))])); },
      async set(values) { for (const [key, value] of Object.entries(values)) records.set(key, structuredClone(value)); },
    } },
    runtime: { async sendMessage({ url }) {
      const bytes = getBytes(url);
      return bytes === undefined ? { ok: false, error: 'HTTP 404' } :
        { ok: true, bytesBase64: Buffer.from(bytes).toString('base64') };
    } },
  };
  t.after(() => { if (previous) globalThis.chrome = previous; else delete globalThis.chrome; });
}

test('本店导入使用所选门店，采购配置失败后保留目标编号，重复导入跳过已有商品', async () => {
  const id = '2100000000000000001';
  const spec = { specName: '小盒', saleUnit: '盒' };
  const source = { ...product, raw: { detail: { skus: [spec] } } };
  const sourceDir = pack({ '1.json': JSON.stringify(source) });
  async function run(existing, purchaseUnitPrice) {
    const writes = [];
    let result;
    await runImport({
      sourceDir, mapping: {}, store: { shopId: 25, purchaseUnitPrice }, cancelFlag: { cancelled: false },
      onProgress(e) { if (e.kind === 'done') result = e.result; },
      async callInjected({ type, payload }) {
        if (type === 'FETCH_PRODUCT_LIST') {
          assert.equal(payload.shopId, 25);
          return { list: payload.scope === existing ? [{ spuId: id, upcList: ['A'] }] : [], total: 0 };
        }
        if (type === 'FETCH_PRODUCT_DETAIL') return { raw: { detail: { skus: [] } } };
        assert.equal(payload.shopId, 25);
        writes.push(type);
        if (type === 'CREATE_PRODUCT') { assert.equal(payload.scope, 'store'); return id; }
        assert.equal(type, 'SET_NEW_STORE_PURCHASE');
        assert.equal(payload.targetSpuId, id);
        assert.deepEqual(payload.specs, [{ spec: '小盒', saleUnit: '盒' }]);
        if (purchaseUnitPrice !== undefined) throw new Error('采购接口失败');
      },
    });
    return { result, writes };
  }
  const partial = await run(undefined, 3);
  assert.deepEqual(partial.writes, ['CREATE_PRODUCT', 'SET_NEW_STORE_PURCHASE']);
  assert.equal(partial.result.failed, 1);
  assert.equal(partial.result.items[0].targetSpuId, id);
  assert.match(partial.result.items[0].errorMessage, /门店商品已新建/);
  for (const scope of ['store', 'tenant']) {
    const repeat = await run(scope, 3);
    assert.equal(repeat.result.skipped, 1);
    assert.deepEqual(repeat.writes, []);
  }
  const basic = await run(undefined, undefined);
  assert.equal(basic.result.succeeded, 1);
  assert.deepEqual(basic.writes, ['CREATE_PRODUCT', 'SET_NEW_STORE_PURCHASE']);
});

test('导入和同步在写入前报告缺失、损坏及商品编号不符的文件', async () => {
  for (const contents of [undefined, '{', JSON.stringify(product)]) {
    const files = { '1.json': JSON.stringify(product) };
    if (contents !== undefined) files['2.json'] = contents;
    const requests = [];
    const args = {
      sourceDir: pack(files, ['1', '2']), cancelFlag: { cancelled: false }, onProgress() {},
      async callInjected({ type }) { requests.push(type); return [{ shopId: 'shop' }]; },
    };
    await assert.rejects(runSync(args), /products\/2\.json/);
    await assert.rejects(runImport({ ...args, mapping: {} }), /products\/2\.json/);
    assert.deepEqual(requests, ['FETCH_SHOP_LIST']);
  }
});

test('条码匹配核实候选商品，未命中时按名称精确查找', async () => {
  const wrong = { spuId: 'wrong', name: '其他商品', upcList: ['Z'] };
  const right = { spuId: 'right', name: '测试商品', upcList: ['B'] };
  assert.equal((await lookupExistingForProduct(async () => ({ list: [wrong, right] }), 1, product)).spuId, 'right');
  const byName = await lookupExistingForProduct(async ({ payload }) => {
    assert.equal(payload.scope, 'tenant');
    return { list: payload.upcList ? [wrong] : [{ ...right, upcList: [] }] };
  }, 1, product);
  assert.deepEqual(byName, { spuId: 'right', reason: '同名' });
});

async function syncWith(detail, source = product) {
  const writes = [];
  const cancelFlag = { cancelled: false };
  let summary;
  await runSync({
    sourceDir: pack({ '1.json': JSON.stringify(source) }), shopId: 'target',
    syncPrice: true, syncStock: true, cancelFlag,
    onProgress(e) { if (e.kind === 'done') summary = e.result; },
    async callInjected({ type, payload }) {
      if (type === 'FETCH_PRODUCT_LIST') {
        assert.equal(payload.scope, 'store');
        assert.equal(payload.shopId, 'target');
        return { list: [{ spuId: 'matched', upcList: ['A'] }] };
      }
      if (type === 'FETCH_PRODUCT_DETAIL') return detail(cancelFlag);
      writes.push([type, payload]);
    },
  });
  return { writes, summary };
}

test('换序规格按条码写入，重复或不匹配的规格均跳过', async () => {
  const sku = (skuId, upc) => ({ skuId, upcList: [upc] });
  const run = skus => syncWith(() => ({ raw: { detail: { skus } } }));
  const { writes } = await run([sku('second', 'B'), sku('first', 'A')]);
  assert.deepEqual(writes[0][1].skuPriceList.map(row => [row.skuId, row.channelPrices[0].fixedPrice]),
    [['first', 5], ['second', 9]]);
  assert.deepEqual(writes[1][1].skuStockList.map(row => [row.skuId, row.newQuantity]),
    [['first', 3], ['second', 7]]);
  for (const targets of [[sku('x', 'C'), sku('y', 'D')], [sku('x', 'A'), sku('y', 'A')]]) {
    const result = await run(targets);
    assert.deepEqual(result.writes, []);
    assert.equal(result.summary.priceSkipped, 2);
    assert.equal(result.summary.stockSkipped, 2);
  }
});

test('取消后停止写入，目标详情读取异常计入失败', async () => {
  const stopped = await syncWith(flag => {
    flag.cancelled = true;
    return { skus: [{ sourceSkuId: 'target-sku', outerSkuCode: 'A' }] };
  });
  assert.equal(stopped.summary.cancelled, true);
  assert.deepEqual(stopped.writes, []);
  const failed = await syncWith(() => { throw new Error('目标详情读取失败'); });
  assert.equal(failed.summary.productFailed, 1);
  assert.equal(failed.summary.firstError, '目标详情读取失败');
  assert.deepEqual(failed.writes, []);
});

test('断点续传区分筛选范围，等效清单换序可复用', () => {
  assert.equal(exportFilterKey({}), '');
  assert.equal(exportFilterKey({ spuIdAllowlist: ['2', '1'] }), exportFilterKey({ spuIdAllowlist: [1, 2] }));
  for (const filter of [{ limitCount: 12 }, { spuNameKeyword: '奶' }, { skuIdList: ['1'] }, { skuUpcList: ['A'] }]) {
    assert.notEqual(exportFilterKey(filter), '');
  }
});

test('同一目标连续导入，只改文字、换一张图、重编码后再次修改，分别上传 0、1、0 张', async t => {
  const hash = data => createHash('sha256').update(data).digest('hex');
  const a = 'https://cdn.example/photo?crop=a';
  const b = 'https://cdn.example/photo?crop=b';
  const c = 'https://cdn.example/uploaded-c';
  const bytes = new Map([[a, 'A'], [b, 'B'], [c, 'C-reencoded']]);
  const fetches = [];
  mockExtension(t, url => {
    fetches.push(url);
    return bytes.get(url);
  });

  const files = {};
  const sourceDir = directory({
    'manifest.json': JSON.stringify({ source: {}, productCount: 1, productIds: ['1'] }),
  }, { products: directory(files), media: directory({ [hash('C') + '.jpg']: 'C' }) });
  let target = { description: '旧文字', picUrlList: [a, b] };
  async function run(description, images) {
    const detail = { description, picUrlList: images.map(x => 'media://' + hash(x)) };
    files['1.json'] = JSON.stringify({ ...product, raw: { detail } });
    const uploads = [];
    let summary;
    await runImport({
      sourceDir, mapping: {}, cancelFlag: { cancelled: false },
      onProgress(event) { if (event.kind === 'done') summary = event.result; },
      async callInjected({ type, payload }) {
        if (type === 'FETCH_SHOP_LIST') return [{ shopId: 'target' }];
        if (type === 'FETCH_PRODUCT_LIST') return { list: [{ spuId: 'target-spu', upcList: ['A'] }] };
        if (type === 'FETCH_PRODUCT_DETAIL') return { raw: { detail: target } };
        if (type === 'UPLOAD_MEDIA') {
          uploads.push(Buffer.from(payload.bytesBase64, 'base64').toString());
          return { fileUrl: c };
        }
        assert.equal(type, 'UPDATE_PRODUCT');
        target = { description, picUrlList: images.map(x => payload.mediaIdMap[hash(x)].fileUrl) };
        return 'target-spu';
      },
    });
    assert.equal(summary.failed, 0);
    return { updates: summary.updated, uploads };
  }
  assert.deepEqual(await run('改文字', ['A', 'B']), { updates: 1, uploads: [] });
  assert.deepEqual(target.picUrlList, [a, b]);
  assert.deepEqual(await run('改文字', ['C', 'A']), { updates: 1, uploads: ['C'] });
  assert.deepEqual(target.picUrlList, [c, a]);
  assert.deepEqual(await run('再改文字', ['A', 'C']), { updates: 1, uploads: [] });
  assert.deepEqual(target.picUrlList, [a, c]);
  assert.deepEqual(await run('再改文字', ['A', 'C']), { updates: 0, uploads: [] });
  assert.deepEqual(fetches, [a, b, c]);
});

test('不同导出目录和商品跨批复用图片，隔离目标门店，失效或内容变动时重新上传', async t => {
  const cdn = new Map();
  mockExtension(t, url => cdn.get(url));
  const hash = createHash('sha256').update('shared-image').digest('hex');
  const uploads = [];
  async function importNewProduct(id, shopId) {
    const spu = { ...product, sourceSpuId: id, name: '商品' + id, raw: { detail: { picUrlList: ['media://' + hash] } } };
    const sourceDir = directory({
      'manifest.json': JSON.stringify({ source: {}, productCount: 1, productIds: [id] }),
    }, {
      products: directory({ [id + '.json']: JSON.stringify(spu) }),
      media: directory({ [hash + '.jpg']: 'shared-image' }),
    });
    let written, summary;
    await runImport({
      sourceDir, mapping: {}, cancelFlag: { cancelled: false },
      onProgress(event) { if (event.kind === 'done') summary = event.result; },
      async callInjected({ type, payload }) {
        if (type === 'FETCH_SHOP_LIST') return [{ shopId }];
        if (type === 'FETCH_PRODUCT_LIST') return { list: [], total: 0 };
        if (type === 'FETCH_PRODUCT_DETAIL') return { raw: { detail: {} } };
        if (type === 'UPLOAD_MEDIA') {
          const fileUrl = 'https://cdn.example/' + shopId + '/' + id;
          uploads.push(id);
          cdn.set(fileUrl, 'platform-reencoded-image');
          return { fileUrl };
        }
        assert.equal(type, 'CREATE_PRODUCT');
        written = payload.mediaIdMap[hash].fileUrl;
        return id;
      },
    });
    assert.equal(summary.succeeded, 1);
    return written;
  }
  const original = await importNewProduct('1', 'A');
  assert.equal(await importNewProduct('2', 'A'), original);
  assert.notEqual(await importNewProduct('3', 'B'), original);
  cdn.delete(original);
  const replacement = await importNewProduct('4', 'A');
  assert.notEqual(replacement, original);
  cdn.set(replacement, 'different-content');
  assert.notEqual(await importNewProduct('5', 'A'), replacement);
  assert.deepEqual(uploads, ['1', '3', '4', '5']);
});
