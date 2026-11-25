import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';

const bundle = await build({
  stdin: {
    contents: [
      "export { runSync } from './src/content/sync'",
      "export { FrontCategoryMappingRequiredError, runImport, lookupExistingForProduct } from './src/content/import'",
      "export { exportFilterKey, runExport } from './src/content/export'",
      "export { createProduct, fetchProductList, fetchProductDetail, fetchStoreSkuInfo, setNewStorePurchase } from './src/injected/api'",
      "export { createFrontCategory, fetchFrontCategoryTree, fetchStoreRelationCategory } from './src/injected/api'",
      "export { sendToActiveTab } from './src/popup/bridge'",
    ].join('\n'),
    resolveDir: process.cwd(),
  },
  bundle: true, format: 'esm', write: false, footer: { js: '//# sourceURL=qnh-product-workflows.js' },
});
const { runSync, FrontCategoryMappingRequiredError, runImport, lookupExistingForProduct, exportFilterKey, runExport,
  createProduct, fetchProductList, fetchProductDetail, fetchStoreSkuInfo, setNewStorePurchase,
  createFrontCategory, fetchFrontCategoryTree, fetchStoreRelationCategory, sendToActiveTab } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`
);

test('扩展上下文失效或牵牛花页面断开时提示用户刷新', async t => {
  const previous = globalThis.chrome;
  t.after(() => { if (previous) globalThis.chrome = previous; else delete globalThis.chrome; });
  let url = 'https://qnh.meituan.com/home.html';
  let response;
  let calls = 0;
  globalThis.chrome = { tabs: {
    async query() { return [{ id: 7, url }]; },
    async sendMessage() {
      calls++;
      if (response instanceof Error) throw response;
      return response;
    },
  } };
  for (const message of ['Extension context invalidated.', 'Could not establish connection. Receiving end does not exist.']) {
    response = new Error(message);
    assert.deepEqual(await sendToActiveTab({ type: 'GET_SHOP_INFO' }), {
      ok: false, error: '扩展已更新，请刷新牵牛花页面后重试。',
    });
  }
  assert.equal(calls, 2);
  response = { ok: false, error: '门店接口失败' };
  assert.deepEqual(await sendToActiveTab({ type: 'GET_SHOP_INFO' }), response);
  url = 'https://example.invalid/';
  response = new Error('Receiving end does not exist.');
  assert.deepEqual(await sendToActiveTab({ type: 'GET_SHOP_INFO' }), { ok: false, error: response.message });
});

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
    async removeEntry(name) { delete files[name]; },
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

test('门店新建缺少总部价格时使用源门店线上价，价格全空时不提交', async t => {
  const original = globalThis.location;
  globalThis.location = new URL('https://test.invalid');
  t.after(() => { if (original) globalThis.location = original; else delete globalThis.location; });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.ok(new URL(url, globalThis.location).pathname.endsWith('/store/create'));
    requests.push(JSON.parse(init.body));
    return Response.json({ code: 0, spuId: '123' });
  });
  const rawSku = { skuId: '10', specName: '', saleUnit: '份', suggestPrice: { tenantSuggestPrice: { unifiedSuggestPrice: '0' } } };
  const sourceSku = { sourceSkuId: '10', specs: [], price: 0, storePrice: 9999, onlinePrice: 6.9, channelPrices: [
    { channelId: 100, price: 6.9 }, { channelId: 200, price: 7.5 }, { channelId: 300, price: 0 },
  ] };
  const args = { scope: 'store', shopId: 12, mediaIdMap: {}, product: {
    ...product, raw: { detail: { skus: [rawSku] } }, skus: [sourceSku],
  } };
  await createProduct(args);
  assert.deepEqual(requests.at(-1).tenantSpu.skus[0].suggestPrice.tenantSuggestPrice, { channelSuggestPriceList: [
    { channelId: 100, suggestPrice: '6.9' }, { channelId: 200, suggestPrice: '7.5' },
  ] });
  rawSku.suggestPrice.tenantSuggestPrice.unifiedSuggestPrice = '8';
  await createProduct(args);
  assert.deepEqual(requests.at(-1).tenantSpu.skus[0].suggestPrice.tenantSuggestPrice, { unifiedSuggestPrice: '8' });
  rawSku.suggestPrice.tenantSuggestPrice.unifiedSuggestPrice = '0';
  delete sourceSku.channelPrices;
  await createProduct(args);
  assert.deepEqual(requests.at(-1).tenantSpu.skus[0].suggestPrice.tenantSuggestPrice, { unifiedSuggestPrice: '6.9' });
  delete sourceSku.onlinePrice;
  await assert.rejects(createProduct(args), /SKU 10.*缺少有效的总部建议售价和源门店线上零售价/);
  assert.equal(requests.length, 3);
});

test('门店导入把匹配到的长分类 ID 提交到门店字段，总部导入仍提交主档分类', async t => {
  const original = globalThis.location;
  globalThis.location = new URL('https://test.invalid');
  t.after(() => { if (original) globalThis.location = original; else delete globalThis.location; });
  const shopId = 25;
  const storeCategoryId = '9000000000000000401';
  const sourceCategoryId = '9000000000000000402';
  const source = { ...product, skus: [{ ...product.skus[0], sourceSkuId: '10' }], raw: { detail: {
    skus: [{ skuId: '10', specName: '', saleUnit: '份' }],
    storeFrontCategoryList: [{ storeCategoryList: [
      { categoryCode: sourceCategoryId, name: '应季鲜果', namePath: '水果蔬菜>应季鲜果' },
    ] }],
  } } };
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const path = new URL(url, globalThis.location).pathname;
    const body = JSON.parse(init.body);
    requests.push(path);
    if (path.endsWith('/front-category/query')) {
      assert.deepEqual(body, { storeGroupId: shopId, sceneIdentity: 20, storeSpuCustomFlag: 0 });
      return Response.json({ code: 0, data: `{"categoryList":[{"categoryId":9000000000000000403,
        "name":"水果蔬菜","children":[{"categoryId":${storeCategoryId},"name":"应季鲜果"}]}]}` });
    }
    if (path.endsWith('/store/create')) {
      assert.equal(body.storeId, shopId);
      assert.deepEqual(body.tenantSpu.storeFrontCategoryList, []);
      assert.deepEqual(body.storeSpu.storeMainFrontCategoryIdList, [storeCategoryId]);
      return Response.json({ code: 0, spuId: '9' });
    }
    assert.ok(path.endsWith('/tenant/create/v2'));
    assert.deepEqual(body.tenantSpu.storeFrontCategoryList, [{ groupId: 0, storeCategoryList: [
      { categoryCode: '12', name: '应季鲜果' },
    ], auxiliaryStoreCategoryList: [] }]);
    return Response.json({ code: 0, data: { spuId: '11' } });
  });

  let result;
  await runImport({
    sourceDir: pack({ '1.json': JSON.stringify(source) }), mapping: {}, store: { shopId },
    cancelFlag: { cancelled: false },
    onProgress(event) { if (event.kind === 'done') result = event.result; },
    async callInjected({ type, payload }) {
      switch (type) {
        case 'FETCH_FRONT_CATEGORY_TREE': return fetchFrontCategoryTree(payload);
        case 'FETCH_PRODUCT_LIST': return { list: [], total: 0 };
        case 'CREATE_PRODUCT': return createProduct(payload);
        case 'SET_NEW_STORE_PURCHASE': return;
        case 'FETCH_PRODUCT_DETAIL': return { raw: { detail: { skus: [] } } };
        default: assert.fail(type);
      }
    },
  });
  assert.equal(result.succeeded, 1);
  assert.equal(await createProduct({ shopId, product: source, mediaIdMap: {},
    frontCategoryIdRemap: { [sourceCategoryId]: '12' } }), '11');
  assert.deepEqual(requests, [
    '/qnh-gw3/api/product/support/front-category/query',
    '/qnh-gw3/api/product/store/create',
    '/qnh-gw3/api/product/tenant/create/v2',
  ]);
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
  async function run(existing, failPurchase = false) {
    const writes = [];
    let result;
    await runImport({
      sourceDir, mapping: {}, store: { shopId: 25 }, cancelFlag: { cancelled: false },
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
        assert.deepEqual(payload, { shopId: 25, targetSpuId: id, specs: ['小盒'] });
        if (failPurchase) throw new Error('采购接口失败');
      },
    });
    return { result, writes };
  }
  const partial = await run(undefined, true);
  assert.deepEqual(partial.writes, ['CREATE_PRODUCT', 'SET_NEW_STORE_PURCHASE']);
  assert.equal(partial.result.failed, 1);
  assert.equal(partial.result.items[0].targetSpuId, id);
  assert.match(partial.result.items[0].errorMessage, /门店商品已新建/);
  for (const scope of ['store', 'tenant']) {
    const repeat = await run(scope);
    assert.equal(repeat.result.skipped, 1);
    assert.deepEqual(repeat.writes, []);
  }
  const basic = await run();
  assert.equal(basic.result.succeeded, 1);
  assert.deepEqual(basic.writes, ['CREATE_PRODUCT', 'SET_NEW_STORE_PURCHASE']);
});

test('门店新建后按规格提交空供应关系列表', async t => {
  const original = globalThis.location;
  globalThis.location = new URL('https://test.invalid');
  t.after(() => { if (original) globalThis.location = original; else delete globalThis.location; });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(new URL(url, globalThis.location).pathname, '/api/v1/store/spu/create');
    requests.push(JSON.parse(init.body));
    return Response.json({ code: 0 });
  });
  const targetSpuId = '2100000000000000001';
  await setNewStorePurchase({ shopId: 25, targetSpuId, specs: ['小盒', '大盒'] });
  assert.deepEqual(requests, [{
    manualCreate: true, newPage: true, storeId: 25,
    storeSpu: { spuId: targetSpuId, purchaseInfo: ['小盒', '大盒'].map(spec => ({
      skuId: null, spec, purchaseStatus: 1, purchaseType: 1, distributeType: 1, distributeId: null,
      newSupplyRelations: [],
    })) },
  }]);
});

test('选择已有分类映射后生成文件并在写入商品前终止', async () => {
  const source = { ...product, raw: { detail: {
    storeFrontCategoryList: [{ storeCategoryList: [{ categoryCode: '1', namePath: '零食>饼干' }] }],
  } } };
  const sourceDir = Object.assign(pack({ '1.json': JSON.stringify(source) }), { name: 'ff' });
  await assert.rejects(runImport({
    sourceDir, mapping: {}, store: { shopId: 25 }, cancelFlag: { cancelled: false }, onProgress() {},
    async requestFrontCategoryAction({ paths, canCreate }) {
      assert.deepEqual(paths, ['零食/饼干']);
      assert.equal(canCreate, true);
      await assert.rejects(sourceDir.getFileHandle('front-category-mapping.txt'), { name: 'NotFoundError' });
      return 'map';
    },
    async callInjected({ type, payload }) {
      assert.equal(type, 'FETCH_FRONT_CATEGORY_TREE');
      assert.deepEqual(payload, { shopId: 25, storeGroupId: 25 });
      return { categories: [{ name: '食品', categoryId: '2' }] };
    },
  }), error => {
    assert.ok(error instanceof FrontCategoryMappingRequiredError);
    assert.equal(error.fileName, 'front-category-mapping.txt');
    assert.match(error.message, /缺少 1 项店内分类.*ff\/front-category-mapping\.txt/);
    return true;
  });
  const file = await (await sourceDir.getFileHandle('front-category-mapping.txt')).getFile();
  assert.match(await file.text(), /^零食\/饼干==>$/m);
});

test('按目标门店分类树新增缺失的父子分类，复用已有项并继续导入', async () => {
  const source = { ...product, raw: { detail: { skus: [{ specName: '小盒' }],
    storeFrontCategoryList: [{ storeCategoryList: [
      { categoryCode: 'a', namePath: '零食>饼干' },
      { categoryCode: 'b', namePath: '零食>糖果' },
      { categoryCode: 'c', namePath: '饮料>果汁' },
      { categoryCode: 'd', namePath: '水果蔬菜>应季鲜果' },
    ] }],
  } } };
  const sourceDir = pack({ '1.json': JSON.stringify(source) });
  const snack = { name: '零食', categoryId: '9000000000000000404', children: [] };
  const drinks = { name: '饮料', categoryId: '10', children: [] };
  const categories = [drinks, { name: '水果蔬菜', categoryId: '20', children: [
    { name: '应季鲜果', categoryId: '21' },
  ] }];
  const writes = [];
  let result;
  await runImport({
    sourceDir, mapping: {}, store: { shopId: 25 }, cancelFlag: { cancelled: false },
    onProgress(event) { if (event.kind === 'done') result = event.result; },
    async requestFrontCategoryAction(info) {
      assert.deepEqual(info.paths, ['零食/饼干', '零食/糖果', '饮料/果汁']);
      assert.equal(info.canCreate, true);
      return 'create';
    },
    async callInjected({ type, payload }) {
      switch (type) {
        case 'FETCH_FRONT_CATEGORY_TREE':
          // 通用查询看不到门店分类，即使管理页面已能查到并使用。
          if (payload.storeGroupId == null) return { categories: [] };
          assert.deepEqual(payload, { shopId: 25, storeGroupId: 25 });
          return { categories: structuredClone(categories), storeGroupId: 25 };
        case 'FETCH_STORE_RELATION_CATEGORY':
          assert.deepEqual(payload, { shopId: 25 });
          return { storeId: 25 };
        case 'CREATE_FRONT_CATEGORY':
          writes.push(payload);
          if (payload.parentCategoryId === '0') categories.push(snack);
          else {
            const parent = categories.find(category => category.categoryId === payload.parentCategoryId);
            parent.children.push({ name: payload.name, categoryId: String(100 + writes.length) });
          }
          return;
        case 'FETCH_PRODUCT_LIST': return { list: [], total: 0 };
        case 'CREATE_PRODUCT':
          assert.deepEqual(payload.frontCategoryIdRemap, { a: '102', b: '103', c: '104', d: '21' });
          return '9';
        case 'SET_NEW_STORE_PURCHASE': return;
        case 'FETCH_PRODUCT_DETAIL': return { raw: { detail: { skus: [] } } };
        default: assert.fail(type);
      }
    },
  });
  assert.equal(result.succeeded, 1);
  assert.deepEqual(writes, [
    { name: '零食', parentCategoryId: '0', storeGroupId: 25 },
    { name: '饼干', parentCategoryId: snack.categoryId, storeGroupId: 25 },
    { name: '糖果', parentCategoryId: snack.categoryId, storeGroupId: 25 },
    { name: '果汁', parentCategoryId: drinks.categoryId, storeGroupId: 25 },
  ]);
  await assert.rejects(sourceDir.getFileHandle('front-category-mapping.txt'), { name: 'NotFoundError' });
});

test('按所选门店查询关联分组，关联或分组查询失败时停止创建', async () => {
  const source = { ...product, raw: { detail: { skus: [{ specName: '小盒' }],
    storeFrontCategoryList: [{ storeCategoryList: [{ categoryCode: 'a', namePath: '零食' }] }],
  } } };
  const storeGroupId = 25;
  for (const failAt of ['relation', 'group', null]) {
    let created = false;
    let groupChecked = false;
    let relationChecked = false;
    const categoryProgress = [];
    const job = runImport({
      sourceDir: pack({ '1.json': JSON.stringify(source) }), mapping: {}, store: { shopId: 25 },
      cancelFlag: { cancelled: false },
      onProgress(event) { if (event.kind === 'import' && event.phase === 'category') categoryProgress.push(event); },
      async requestFrontCategoryAction() {
        assert.equal(categoryProgress.at(-1).loading, false);
        return 'create';
      },
      async callInjected({ type, payload }) {
        if (type === 'FETCH_STORE_RELATION_CATEGORY') {
          assert.deepEqual(payload, { shopId: 25 });
          assert.match(categoryProgress.at(-1).message, /正在查询目标门店关联分类/);
          if (failAt === 'relation') throw new Error('门店不可用');
          relationChecked = true;
          return { storeId: storeGroupId };
        }
        if (type === 'FETCH_FRONT_CATEGORY_TREE') {
          const pending = categoryProgress.at(-1);
          assert.equal(pending.loading, true);
          assert.deepEqual(payload, { shopId: 25, storeGroupId });
          if (relationChecked) {
            assert.match(pending.message, created ? /正在确认分类/ : /正在查询目标分类分组/);
            groupChecked = true;
            if (failAt === 'group') throw new Error('分组不可用');
          } else {
            assert.match(pending.message, /正在读取目标店内分类/);
          }
          return { categories: created ? [{ name: '零食', categoryId: '10' }] : [] };
        }
        if (type === 'CREATE_FRONT_CATEGORY') {
          assert.ok(groupChecked && !failAt);
          assert.match(categoryProgress.at(-1).message, /正在创建一级分类「零食」/);
          assert.deepEqual(payload, { storeGroupId, name: '零食', parentCategoryId: '0' });
          created = true;
          return;
        }
        assert.ok(created);
        if (type === 'FETCH_PRODUCT_LIST') return { list: [], total: 0 };
        if (type === 'CREATE_PRODUCT') return '9';
        if (type === 'SET_NEW_STORE_PURCHASE') return;
        if (type === 'FETCH_PRODUCT_DETAIL') return { raw: { detail: { skus: [] } } };
        assert.fail(type);
      },
    });
    if (failAt === 'relation') await assert.rejects(job, /无法查询目标门店关联分类.*门店不可用/);
    else if (failAt === 'group') await assert.rejects(job, /无法查询目标分类分组.*分组不可用/);
    else await job;
    assert.equal(created, !failAt);
    assert.equal(groupChecked, failAt !== 'relation');
  }
});

test('门店关联分类查询返回本次所选门店 ID，忽略分类节点的分组号', async t => {
  const original = globalThis.location;
  globalThis.location = new URL('https://test.invalid');
  t.after(() => { if (original) globalThis.location = original; else delete globalThis.location; });
  let response;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const endpoint = new URL(url, globalThis.location);
    assert.ok(endpoint.pathname.endsWith('/front-category/query-store-relation-category'));
    assert.equal(init.method, 'POST');
    assert.equal(init.credentials, 'include');
    assert.equal(init.headers.qnhreferrer, '/unifiedGoods/front-category');
    assert.deepEqual(JSON.parse(init.body), { storeId: 25, needChannelException: true, needHasPriceAdjustRate: true,
      needRelationSpuCount: true });
    return Response.json(response);
  });
  response = { code: 0, data: JSON.stringify({ storeId: 25, categoryList: [{ storeGroupId: '42' }] }) };
  assert.deepEqual(await fetchStoreRelationCategory({ shopId: '25' }), { storeId: 25 });
  response = { code: 0, data: { categoryList: [] } };
  assert.deepEqual(await fetchStoreRelationCategory({ shopId: 25 }), { storeId: 25 });
  response = { code: 0, data: { storeId: 26, storeGroupId: 42 } };
  await assert.rejects(fetchStoreRelationCategory({ shopId: 25 }), /关联分类与所选门店不一致/);
  response = { code: 0, data: { categoryList: [{ storeGroupId: 42 }, { storeGroupId: 43 }] } };
  assert.deepEqual(await fetchStoreRelationCategory({ shopId: 25 }), { storeId: 25 });
  response = { code: 1, msg: '没有门店权限' };
  await assert.rejects(fetchStoreRelationCategory({ shopId: 25 }), /没有门店权限/);
});

test('店内分类请求使用分组创建参数并保留长分类 ID', async t => {
  const original = globalThis.location;
  globalThis.location = new URL('https://test.invalid');
  t.after(() => { if (original) globalThis.location = original; else delete globalThis.location; });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const endpoint = new URL(url, globalThis.location);
    requests.push({ path: endpoint.pathname, body: JSON.parse(init.body), init });
    if (endpoint.pathname.endsWith('/query')) return Response.json({
      code: 0, data: '{"storeGroupId":42,"categoryList":[{"name":"零食","categoryId":9000000000000000404,"parentCategoryId":0}]}'
    });
    assert.equal(endpoint.searchParams.get('csecversion'), '4.3.0');
    return Response.json({ code: 0 });
  });
  const tree = await fetchFrontCategoryTree({ shopId: 7, storeGroupId: 42 });
  assert.equal(tree.storeGroupId, 42);
  assert.equal(tree.categories[0].categoryId, '9000000000000000404');
  await createFrontCategory({ storeGroupId: 42, parentCategoryId: tree.categories[0].categoryId, name: '饼干' });
  assert.deepEqual(requests[0].body, { storeGroupId: 42, sceneIdentity: 20, storeSpuCustomFlag: 0 });
  const { path, body, init } = requests[1];
  assert.ok(path.endsWith('/front-category/create'));
  assert.deepEqual(body, { storeGroupId: 42, parentCategoryId: '9000000000000000404', name: '饼干',
    sceneIdentity: 20, storeSpuCustomFlag: 0, channelIdList: [0] });
  assert.equal(init.headers.qnhreferrer, '/unifiedGoods/front-category');
  assert.equal(init.credentials, 'include');
  await assert.rejects(fetchFrontCategoryTree({ shopId: 7, storeGroupId: 99 }), /分类与指定分组不一致/);
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
  assert.notEqual(exportFilterKey({ skuIdList: ['1'] }), '{"name":"","upcs":[],"skus":["1"],"limit":0}');
  assert.notEqual(exportFilterKey({ spuIdAllowlist: ['1'] }), '{"spu":["1"]}');
  assert.notEqual(exportFilterKey({ spuNameKeyword: '奶' }), '{"name":"奶","upcs":[],"skus":[],"limit":0}');
  assert.notEqual(exportFilterKey({ skuUpcList: ['001'] }), '{"name":"","upcs":["001"],"skus":[],"limit":0}');
});

function mockExportExtension(t) {
  const previousLocation = globalThis.location;
  globalThis.location = new URL('https://test.invalid');
  t.after(() => { if (previousLocation) globalThis.location = previousLocation; else delete globalThis.location; });
  mockExtension(t, () => undefined);
  globalThis.chrome.runtime.getManifest = () => ({ version: 'test' });
}

async function exportProducts(filters, files = {}, products = {}) {
  await runExport({
    sourceShopId: 7, ...filters, cancelFlag: { cancelled: false }, onProgress() {},
    targetDir: directory(files, { products: directory(products), media: directory({}) }),
    async callInjected({ type, payload }) {
      switch (type) {
        case 'FETCH_SHOP_INFO': return {};
        case 'FETCH_CATEGORY_TREE': return [];
        case 'FETCH_PRODUCT_LIST': return fetchProductList(payload);
        case 'FETCH_STORE_SKU_INFO': return fetchStoreSkuInfo(payload);
        case 'FETCH_PRODUCT_DETAIL': return fetchProductDetail(payload);
        default: assert.fail(`意外的导出命令 ${type}`);
      }
    },
  });
  return JSON.parse(files['manifest.json']);
}

test('SKU 导出兼容两种列表字段及长数字 ID，缺少规格时查门店详情', async t => {
  mockExportExtension(t);
  const requestedSkuIds = ['9000000000000000201', '9000000000000000202', '9000000000000000203'];
  const otherSkuId = '9000000000000000204';
  const legacySpuId = '9000000000000000101';
  const [legacySkuId, currentSkuId, omittedSkuId] = requestedSkuIds;
  const skuBySpu = { [legacySpuId]: legacySkuId, 2: currentSkuId, 3: omittedSkuId };
  const details = [];
  const storeDetails = [];
  let filter = requestedSkuIds;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const path = new URL(url, globalThis.location).pathname;
    const body = JSON.parse(init.body);
    let data;
    if (path.endsWith('/store/page-query-spu')) {
      assert.deepEqual(body.skuIdList, filter);
      assert.deepEqual(body.storeIdList, ['7']);
      // 模拟服务端返回较宽的候选范围，仍需在导出端精确比对。
      data = `{"total":4,"list":[
        {"spuId":${legacySpuId},"storeSkuList":[{"skuId":${legacySkuId}}]},
        {"spuId":"2","skus":[{"skuId":"${currentSkuId}"}]},
        {"spuId":"3"},
        {"spuId":"4","skus":[{"skuId":${otherSkuId}}]}
      ]}`;
    } else if (path.endsWith('/store/detail')) {
      storeDetails.push(body.spuId);
      data = `{"storeSkuList":[{"skuId":${skuBySpu[body.spuId]},"stock":"5","onlinePrice":"6.9"}]}`;
    } else if (path.endsWith('/tenant/detail')) {
      details.push(body.spuId);
      data = `{"spuId":${body.spuId},"spuName":"商品","skus":[{"skuId":${skuBySpu[body.spuId]}}]}`;
    } else {
      assert.fail(`意外的接口请求 ${path}`);
    }
    return new Response(`{"code":0,"data":${data}}`, { headers: { 'content-type': 'application/json' } });
  });

  const files = {};
  const products = {};
  const manifest = await exportProducts({ skuIdList: requestedSkuIds }, files, products);
  assert.equal(manifest.productCount, 3);
  assert.deepEqual(manifest.productIds, [legacySpuId, '2', '3']);
  assert.deepEqual(details, manifest.productIds);
  assert.equal(storeDetails[0], '3');
  for (const spuId of manifest.productIds) {
    const [{ sourceSkuId, stock, onlinePrice }] = JSON.parse(products[spuId + '.json']).skus;
    assert.equal(String(sourceSkuId), skuBySpu[spuId]);
    assert.equal(stock, 5);
    assert.equal(onlinePrice, 6.9);
  }

  const noMatches = {};
  filter = ['9000000000000000205'];
  await assert.rejects(exportProducts({ skuIdList: filter }, noMatches), /没有符合筛选条件的商品/);
  assert.equal(noMatches['manifest.json'], undefined);
  assert.deepEqual(details, manifest.productIds);
});

test('名称在本地复核，UPC 兼容单值和门店详情，组合条件命中同一规格', async t => {
  mockExportExtension(t);
  const list = [
    { spuId: '1', goodsName: 'Milk A', storeSkuList: [{ skuId: '11', upc: '001' }] },
    { spuId: '2', spuName: 'Coffee', skus: [{ skuId: '21', upcList: ['001'] }] },
    { spuId: '3', spuName: 'Milk B', skus: [{ skuId: '31' }] },
    { spuId: '4', spuName: 'Milk C', skus: [{ skuId: '41', upcList: ['003'] }, { skuId: '42', upcList: ['001'] }] },
  ];
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const endpoint = new URL(url, globalThis.location).pathname;
    const body = JSON.parse(init.body);
    requests.push({ endpoint, body });
    if (endpoint.endsWith('/store/page-query-spu')) {
      return Response.json({ code: 0, data: { list, total: list.length } });
    }
    const item = list.find(row => row.spuId === body.spuId);
    assert.ok(item);
    const skus = item.skus ?? item.storeSkuList;
    if (endpoint.endsWith('/store/detail')) {
      const storeSkuList = item.spuId === '3' ? [{ skuId: '31', upc: '001' }] : skus;
      return Response.json({ code: 0, data: { storeSkuList } });
    }
    assert.ok(endpoint.endsWith('/tenant/detail'));
    return Response.json({ code: 0, data: { ...item, skus } });
  });

  const name = await exportProducts({ spuNameKeyword: '  milk  ' });
  assert.deepEqual(name.productIds, ['1', '3', '4']);
  assert.equal(requests[0].body.spuName, 'milk');

  requests.length = 0;
  const upc = await exportProducts({ skuUpcList: ['001'] });
  assert.deepEqual(upc.productIds, ['1', '2', '3', '4']);
  assert.equal(requests.filter(r => r.endpoint.endsWith('/store/detail') && r.body.spuId === '3').length, 1);

  const both = await exportProducts({ skuIdList: ['31', '41'], skuUpcList: ['001'] });
  assert.deepEqual(both.productIds, ['3']);

  for (const filter of [{ spuNameKeyword: 'missing' }, { skuUpcList: ['099'] }]) {
    const files = {};
    await assert.rejects(exportProducts(filter, files), /没有符合筛选条件的商品/);
    assert.equal(files['manifest.json'], undefined);
  }
});

test('SPU 清单在读取主档前核对门店，组合装依赖仍可一并导出', async t => {
  mockExportExtension(t);
  const tenantDetails = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const endpoint = new URL(url, globalThis.location).pathname;
    const { spuId, storeId } = JSON.parse(init.body);
    if (endpoint.endsWith('/store/detail')) {
      assert.equal(storeId, 7);
      if (spuId === '99' || spuId === '11') return Response.json({ code: 1, msg: '门店没有该商品' });
      const data = { spuId, storeId: spuId === '98' ? 8 : 7, storeSkuList: spuId === '97' ? [] : [{ skuId: '21' }] };
      return Response.json({ code: 0, data });
    }
    assert.ok(endpoint.endsWith('/tenant/detail'));
    tenantDetails.push(spuId);
    return Response.json({ code: 0, data: { spuId, skus: spuId === '10' ? [{ skuId: '21', childSkuList: [{ spuId: '11' }] }] : [] } });
  });

  for (const invalidId of ['99', '98', '97']) {
    const files = {};
    const products = {};
    await assert.rejects(exportProducts({ spuIdAllowlist: [invalidId] }, files, products), /无法确认 SPU .* 属于所选门店/);
    assert.equal(files['manifest.json'], undefined);
    assert.deepEqual(products, {});
  }
  assert.deepEqual(tenantDetails, []);

  const manifest = await exportProducts({ spuIdAllowlist: ['10'], spuNameKeyword: 'ignored' });
  assert.deepEqual(manifest.productIds, ['10', '11']);
  assert.deepEqual(tenantDetails, ['10', '11']);
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
