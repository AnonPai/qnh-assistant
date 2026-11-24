import type { ShopBrief } from '@shared/messaging';
import { bindDirectory, directoryMarkup } from './directory-field';
import { detectExportTargetStatus, exportFilterKey, type ExportTargetStatus } from './export';
import { readManifestIfComplete } from './fs-stage';
import type { CallInjected } from './index';
import styles from './config-forms.css?inline';

export interface ExportFormResult {
  shop: ShopBrief;
  spuNameKeyword: string | null;
  spuIdAllowlist: string[] | null;
  skuIdList: string[] | null;
  skuUpcList: string[] | null;
  includeImages: boolean;
  includeVideo: boolean;
  targetDir: FileSystemDirectoryHandle;
  startMode: 'fresh' | 'overwrite' | 'resume';
}

export interface OpenExportFormArgs {
  callInjected: CallInjected;
  initialSpuNameKeyword?: string;
  initialSpuIds?: string;
  initialSkuIds?: string;
  initialSkuUpcs?: string;
}

export interface ImportFormResult {
  shop?: ShopBrief;
  purchaseUnitPrice?: number;
  sourceDir: FileSystemDirectoryHandle;
  mode: 'full' | 'incremental';
  confirmMode: 'auto' | 'manual';
  syncImages: boolean;
  updateOnNameMatch: boolean;
  frontCategoryMappingFile: File | null;
}

export interface SyncFormResult {
  shop: ShopBrief;
  syncStock: boolean;
  syncPrice: boolean;
  sourceDir: FileSystemDirectoryHandle;
}

function parseIds(text: string) {
  const ids = text.split(/[\s,，、;；]+/).filter(Boolean);
  return ids.length ? [...new Set(ids)] : null;
}

function choice(id: string, title: string, hint: string, checked = false, group?: string) {
  const type = group ? `type="radio" name="${group}"` : 'type="checkbox"';
  return `<label class="choice"><input id="${id}" ${type} ${checked ? 'checked' : ''}>
    <span>${title}</span><small>${hint}</small></label>`;
}

function section(title: string, body: string) {
  return `<section><h3>${title}</h3><div class="choices">${body}</div></section>`;
}

function shopMarkup(title: string) {
  return `<section><h3>${title}</h3><div class="shop-fields">
    <input type="search" id="shop-search" aria-label="搜索门店" placeholder="搜索名称、编号或城市">
    <select id="shop" aria-label="${title}"><option value="">请选择门店</option></select>
    </div><p class="hint" id="shop-hint" role="status">正在加载门店…</p></section>`;
}

function bindShop(root: ShadowRoot, call: CallInjected, changed: () => void) {
  const search = root.querySelector<HTMLInputElement>('#shop-search')!;
  const select = root.querySelector<HTMLSelectElement>('#shop')!;
  const hint = root.querySelector<HTMLElement>('#shop-hint')!;
  let shops: ShopBrief[] = [];

  function render() {
    const previous = select.value;
    const query = search.value.trim().toLowerCase();
    const ids = /[,，、]/.test(query) ? parseIds(query) : null;
    const visible = shops.filter(shop => ids
      ? ids.some(id => String(shop.shopId).includes(id))
      : [shop.shopName, shop.shopId, shop.region].some(value => String(value ?? '').toLowerCase().includes(query)));
    select.replaceChildren(new Option('请选择门店', ''), ...visible.map(shop =>
      new Option([shop.shopName, shop.region, `#${shop.shopId}`].filter(Boolean).join(' · '), String(shop.shopId))));
    select.value = visible.some(shop => String(shop.shopId) === previous) ? previous : '';
    if (shops.length === 1 && visible.length === 1) select.selectedIndex = 1;
    hint.textContent = visible.length ? `共 ${visible.length} 家门店` : '没有匹配的门店';
    changed();
  }

  search.addEventListener('input', render);
  select.addEventListener('change', changed);
  call<ShopBrief[]>({ type: 'FETCH_SHOP_LIST' }).then(list => {
    shops = list;
    render();
  }).catch((err: Error) => {
    hint.textContent = `门店加载失败 · ${err.message}`;
    hint.classList.add('error');
  });
  return () => shops.find(shop => String(shop.shopId) === select.value);
}

let closeActive: (() => void) | undefined;

function openForm<T>(
  title: string, action: string, body: string,
  setup: (root: ShadowRoot, refresh: () => void) => {
    state: () => { hint: string; result?: T };
    authorize: () => Promise<void>;
  },
): Promise<T | null> {
  closeActive?.();
  return new Promise(resolve => {
    const host = document.createElement('div');
    document.documentElement.append(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${styles}</style><dialog aria-labelledby="title">
      <header><h2 id="title">${title}</h2><button class="close" aria-label="关闭">×</button></header>
      <main>${body}</main>
      <footer><span class="hint" role="status"></span><button class="cancel">取消</button>
      <button class="primary" disabled>${action}</button></footer></dialog>`;
    const dialog = root.querySelector('dialog')!;
    const main = root.querySelector('main')!;
    const start = root.querySelector<HTMLButtonElement>('.primary')!;
    const hint = root.querySelector<HTMLElement>('footer .hint')!;
    let busy = false;
    const form = setup(root, refresh);

    function refresh() {
      const state = form.state();
      start.disabled = busy || !state.result;
      hint.classList.remove('error');
      hint.textContent = busy ? '正在获取目录权限…' : state.hint;
    }

    function finish(result: T | null) {
      if (!host.isConnected) return;
      dialog.close();
      host.remove();
      closeActive = undefined;
      resolve(result);
    }

    closeActive = () => finish(null);
    for (const button of root.querySelectorAll('.close, .cancel')) button.addEventListener('click', closeActive);
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const box = dialog.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right ||
          event.clientY < box.top || event.clientY > box.bottom) finish(null);
    });
    start.addEventListener('click', async () => {
      const { result } = form.state();
      if (!result || busy) return;
      busy = true;
      main.inert = true;
      refresh();
      try {
        await form.authorize();
        finish(result);
      } catch (err) {
        busy = false;
        main.inert = false;
        refresh();
        hint.textContent = `目录授权失败，请重试或重新浏览。${(err as Error).message}`;
        hint.classList.add('error');
      }
    });
    root.addEventListener('change', refresh);
    dialog.showModal();
    refresh();
  });
}

function input(root: ShadowRoot, id: string) {
  return root.querySelector<HTMLInputElement>(`#${id}`)!;
}

async function inspectSource(dir: FileSystemDirectoryHandle) {
  const manifest = await readManifestIfComplete(dir);
  if (!manifest) throw new Error(`项目「${dir.name}」缺少 manifest.json，请选择已完成导出的项目。`);
  try {
    await dir.getDirectoryHandle('products');
  } catch (err) {
    if ((err as Error).name !== 'NotFoundError') throw err;
    throw new Error('目录缺少 products 子文件夹。');
  }
  return `${manifest.source.shopName ?? '导出包'} · ${manifest.productCount} 个商品`;
}

export function openExportForm(args: OpenExportFormArgs) {
  const filters = [
    ['spu-name', '商品名称', args.initialSpuNameKeyword],
    ['spu-ids', 'SPU ID', args.initialSpuIds],
    ['sku-ids', 'SKU ID', args.initialSkuIds],
    ['sku-upcs', '商品条码 / UPC', args.initialSkuUpcs],
  ] as const;
  const body = shopMarkup('来源门店') + directoryMarkup('导出到') +
    section('媒体文件',
      choice('images', '下载图片', '关闭后保留原图链接', true) +
      choice('video', '下载视频', '导入时需手动补传视频')) +
    `<section aria-labelledby="export-filters-title">
      <h3 id="export-filters-title">商品筛选</h3>
      <p class="hint">留空导出全店。多个编号可用逗号或空格分隔。指定 SPU ID 时仅按该清单导出。</p>
      <div class="filter-grid">${filters.map(([id, label]) => `<label>${label}<input type="text" id="${id}"></label>`).join('')}</div>
    </section>`;

  return openForm<ExportFormResult>('导出本店商品', '开始导出', body, (root, refresh) => {
    for (const [id, , value] of filters) input(root, id).value = value ?? '';
    root.addEventListener('input', refresh);
    const shopValue = bindShop(root, args.callInjected, refresh);
    const directory = bindDirectory(root, 'export', detectExportTargetStatus, () => {
      input(root, 'resume').checked = true;
      refresh();
    });
    const extra = root.querySelector<HTMLElement>('[data-dir-extra]')!;
    extra.className = 'choices resume';
    extra.innerHTML = choice('resume', '继续上次', '接续已完成的商品', true, 'restart') +
      choice('restart', '重新导出', '丢弃旧进度', false, 'restart');

    return {
      authorize: directory.authorize,
      state() {
        const shop = shopValue();
        const chosen = directory.selection;
        const status: ExportTargetStatus | undefined = chosen?.info;
        const includeImages = input(root, 'images').checked;
        const includeVideo = input(root, 'video').checked;
        const ids = parseIds(input(root, 'spu-ids').value);
        const spuNameKeyword = ids ? null : input(root, 'spu-name').value.trim() || null;
        const skuIdList = ids ? null : parseIds(input(root, 'sku-ids').value);
        const skuUpcList = ids ? null : parseIds(input(root, 'sku-upcs').value);
        const filterKey = exportFilterKey({ spuIdAllowlist: ids ?? undefined, spuNameKeyword: spuNameKeyword ?? undefined,
          skuIdList: skuIdList ?? undefined, skuUpcList: skuUpcList ?? undefined });
        const resumable = status?.kind === 'incomplete' && !!shop &&
          String(status.progress.source.shopId) === String(shop.shopId) &&
          status.progress.options.includeVideo === includeVideo &&
          (status.progress.options.filterKey ?? '') === filterKey &&
          (status.progress.options.includeImages ?? true) === includeImages;
        extra.hidden = !resumable;
        for (const id of ['sku-ids', 'sku-upcs', 'spu-name']) input(root, id).disabled = !!ids;
        let startMode: ExportFormResult['startMode'] = 'fresh';
        if (status?.kind === 'complete') {
          startMode = 'overwrite';
          directory.message(`已有完整导出（${status.manifest.source.shopName ?? '未知门店'}，${status.manifest.productCount} 个商品）。开始后将覆盖已有导出。`, 'warn');
        } else if (status?.kind === 'incomplete') {
          startMode = resumable && input(root, 'resume').checked ? 'resume' : 'overwrite';
          const next = !resumable ? '门店、商品筛选和媒体设置与上次一致时可续传。按当前设置开始将重新导出。'
            : startMode === 'resume' ? '将继续上次任务。' : '开始后将重新导出。';
          directory.message(`已有未完成的导出，已写入 ${status.progress.doneSpuIds.length} 个商品。${next}`, 'warn');
        } else if (status) directory.message('商品及媒体文件将直接写入此目录。');
        if (!shop || !chosen) return { hint: !shop ? '请选择来源门店' : directory.hint };
        return {
          hint: `${shop.shopName ?? shop.shopId} · ${ids ? `指定 ${ids.length} 个 SPU` : '准备就绪'}`,
          result: {
            shop, startMode, includeImages, includeVideo,
            targetDir: chosen.dir,
            spuIdAllowlist: ids,
            spuNameKeyword, skuIdList, skuUpcList,
          },
        };
      },
    };
  });
}

export function openSyncForm(args: { callInjected: CallInjected }) {
  const body = shopMarkup('目标门店') + directoryMarkup('数据源目录') +
    section('同步内容', choice('stock', '库存', '以源 SKU 库存覆盖目标门店库存', true) +
      choice('price', '零售价', '将固定价同步至美团闪购和饿了么', true));
  return openForm<SyncFormResult>('同步库存与零售价', '开始同步', body, (root, refresh) => {
    const shopValue = bindShop(root, args.callInjected, refresh);
    const directory = bindDirectory(root, 'sync', inspectSource, refresh);
    return { authorize: directory.authorize, state() {
      const chosen = directory.selection;
      const shop = shopValue();
      const syncStock = input(root, 'stock').checked;
      const syncPrice = input(root, 'price').checked;
      if (chosen) directory.message(chosen.info);
      if (!shop) return { hint: '请选择目标门店' };
      if (!chosen) return { hint: directory.hint };
      if (!syncStock && !syncPrice) return { hint: '请至少选择一项同步内容' };
      return { hint: `目标门店 · ${shop.shopName ?? shop.shopId}`, result: { shop, syncStock, syncPrice, sourceDir: chosen.dir } };
    } };
  });
}

export function openImportForm(storeCall?: CallInjected) {
  const body = (storeCall ? shopMarkup('目标门店') : '') + directoryMarkup('导入源目录') +
    (storeCall ? `<section><h3>门店新建</h3>
      <p class="hint">已有匹配商品时跳过。每个规格按总部零售价新建，各渠道同价时统一设置，异价时保留分渠道定价。库存和门店渠道价可在导入后同步。</p>
      <label>采购单价（可选）<input type="text" inputmode="decimal" id="purchase-price" placeholder="元 / 基础销售单位"></label>
      <p class="hint">填写后，对本批新建商品的每个规格使用此采购价和默认供应关系。留空可稍后在门店配置。</p></section>` :
      section('导入模式', choice('full', '全量导入', '更新有差异的商品，并创建缺少的商品', true, 'mode') +
      choice('incremental', '增量导入', '已有 UPC 或同名商品直接跳过', false, 'mode'))) +
    section('执行方式', choice('auto', '自动执行', '依次写入商品', true, 'confirm') +
      choice('manual', '逐条确认', '每次写入前可确认或跳过', false, 'confirm')) +
    section('商品设置', choice('images', '同步图片', '关闭后跳过图片上传和比对', true) +
      (storeCall ? '' : choice('by-name', '更新同名异 UPC 商品', '仅全量模式生效，可能覆盖同名商品', true))) +
    `<details><summary>店内分类映射文件</summary><p class="hint">目标店缺少分类时，编辑源目录中的 front-category-mapping.txt，然后在此选择。</p>
      <div class="file-row"><input id="mapping" aria-label="店内分类映射文件" type="file" accept=".txt,.csv,.tsv,text/plain"><button id="clear" hidden>清除</button></div></details>`;
  return openForm<ImportFormResult>(storeCall ? '导入本店商品' : '导入商品', '开始导入', body, (root, refresh) => {
    const getShop = storeCall && bindShop(root, storeCall, refresh);
    if (storeCall) input(root, 'purchase-price').addEventListener('input', refresh);
    const directory = bindDirectory(root, 'import', inspectSource, refresh);
    const file = input(root, 'mapping');
    const clear = root.querySelector<HTMLButtonElement>('#clear')!;
    clear.onclick = () => { file.value = ''; refresh(); };
    return { authorize: directory.authorize, state() {
      const chosen = directory.selection;
      const full = !storeCall && input(root, 'full').checked;
      const manual = input(root, 'manual').checked;
      const byName = input(root, 'by-name');
      if (byName) byName.disabled = !full;
      const shop = getShop?.();
      const price = storeCall ? input(root, 'purchase-price').value.trim() : '';
      const mapping = file.files?.[0] ?? null;
      clear.hidden = !mapping;
      if (storeCall && !shop) return { hint: '请选择目标门店' };
      if (price && (!/^\d+(\.\d{1,2})?$/.test(price) || !Number.isFinite(Number(price)) || Number(price) <= 0)) {
        return { hint: '采购单价须大于 0，最多两位小数' };
      }
      if (!chosen) return { hint: directory.hint };
      directory.message(chosen.info);
      return { hint: [shop?.shopName ?? (full ? '全量' : '增量'), manual ? '逐条确认' : '自动执行', mapping && '已附带分类映射'].filter(Boolean).join(' · '),
        result: { sourceDir: chosen.dir, shop, purchaseUnitPrice: price ? Number(price) : undefined, mode: full ? 'full' : 'incremental', confirmMode: manual ? 'manual' : 'auto',
          syncImages: input(root, 'images').checked, updateOnNameMatch: full && byName.checked, frontCategoryMappingFile: mapping } };
    } };
  });
}
