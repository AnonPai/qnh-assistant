/**
 * 在牵牛花后台页面里注入 UI:
 *   1. 在「门店商品列表」页的工具条里插入「📦 导出本店商品」按钮
 *   2. 在「主档商品列表」页的工具条里插入「📥 导入商品」按钮
 *   3. 点击按钮弹出「单页配置表单」(见 ./config-forms.ts)— 一张表填完所有选项,
 *      不再用引导式的多步弹窗
 *   4. 表单提交后启动任务,弹出右下角浮动进度面板;手动模式下每个商品写入前
 *      会弹出 requestImportConfirm 让用户三选一(确认 / 跳过 / 取消整批)
 *
 * 设计要点:
 * - MutationObserver 持续观察工具条,SPA 切路由后页面被重绘也能补回按钮
 * - 用 data-qnh-* 标记防重复注入
 * - 进度面板与确认弹窗用 Shadow DOM 包裹,样式与宿主页面隔离
 */

import type { ProgressEvent } from '@shared/messaging';
import type { CategoryMapping } from '@shared/types';
import {
  cancelCurrent,
  callInjected,
  startExport,
  startImport,
  startSync,
  subscribeProgress,
} from './index';
import { openExportForm, openImportForm, openSyncForm } from './config-forms';

const BTN_EXPORT_TEXT = '📦 导出本店商品';
const BTN_IMPORT_TEXT = '📥 导入商品';
const BTN_SYNC_TEXT = '🔄 同步库存价格';
const MARK_EXPORT_BTN = 'qnh-export-btn';
const MARK_IMPORT_BTN = 'qnh-import-btn';
const MARK_SYNC_BTN = 'qnh-sync-btn';
const MARK_PANEL = 'qnh-progress-panel';

/**
 * 路由收紧:导出按钮只在「门店商品列表」(store/spu-list)显示,导入按钮只在
 * 「主档(租户)商品列表」(tenant/spu-list)显示。两个入口语义不同,放错页面
 * 容易把"门店在售"和"租户主档"两套数据搞混。
 */
const TARGET_HOST = 'qnh.meituan.com';
// 牵牛花 SPA 的入口路径有两套:正式入口是 /home.html,官方网站直链是 /(直接走 HashRouter)。
// 两个路径都会跑同一份前端代码,按钮注入条件只看 hash 路由就够了。
const TARGET_PATHS = ['/', '/home.html'];
const EXPORT_HASH_PREFIX = '#/unifiedGoods/store/spu-list';
const IMPORT_HASH_PREFIX = '#/unifiedGoods/tenant/spu-list';

function isOnQnhSpa(): boolean {
  return location.hostname === TARGET_HOST && TARGET_PATHS.includes(location.pathname);
}
function isExportRoute(): boolean {
  return isOnQnhSpa() && location.hash.startsWith(EXPORT_HASH_PREFIX);
}
function isImportRoute(): boolean {
  return isOnQnhSpa() && location.hash.startsWith(IMPORT_HASH_PREFIX);
}

/** 启动注入观察 */
export function mountInPageUI() {
  let scheduled = false;
  const tryMount = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      mountToolbar();
    });
  };
  tryMount();

  const obs = new MutationObserver(tryMount);
  obs.observe(document.documentElement, { subtree: true, childList: true });

  // SPA hash 变更也补一次
  window.addEventListener('hashchange', tryMount);
  window.addEventListener('popstate', tryMount);
}

function mountToolbar() {
  const actions = [
    { mark: MARK_SYNC_BTN, label: BTN_SYNC_TEXT, visible: isExportRoute(), click: onSyncClick },
    { mark: MARK_EXPORT_BTN, label: BTN_EXPORT_TEXT, visible: isExportRoute(), click: onExportClick },
    { mark: MARK_IMPORT_BTN, label: BTN_IMPORT_TEXT, visible: isImportRoute(), click: onImportClick },
    { mark: 'qnh-store-import-btn', label: '导入本店商品', visible: isExportRoute(), click: () => onImportClick(true) },
  ];
  let anchor: HTMLElement | null = null;
  for (const action of actions) {
    const existing = document.querySelector(`[data-qnh="${action.mark}"]`);
    if (!action.visible) {
      existing?.remove();
      continue;
    }
    if (existing) continue;
    anchor ??= findAddProductButton();
    if (!anchor?.parentElement) continue;
    const wrapper = document.createElement('span');
    wrapper.className = anchor.className;
    wrapper.dataset.qnh = action.mark;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = action.label;
    button.style.cssText = 'height:32px;padding:0 12px;border:1px solid #a8c6bb;border-radius:7px;background:#f2f8f5;color:#185d50;font-size:13px;cursor:pointer;';
    button.addEventListener('click', () => void openTask(action.click));
    wrapper.append(button);
    anchor.before(wrapper);
  }
}

/**
 * 找页面上的「新增商品」按钮所在的工具条 item。
 *
 * 牵牛花用的是定制 antd,实际结构是:
 *   <div class="unifiedGoods-ant-space-item">新增商品</div>
 * 所以不能只找 button,需要按文本匹配任意元素,优先匹配 space-item。
 */
function findAddProductButton(): HTMLElement | null {
  const inSpace = Array.from(
    document.querySelectorAll<HTMLElement>('[class*="ant-space-item"]'),
  ).filter((el) => el.offsetParent !== null && (el.textContent || '').trim() === '新增商品');
  if (inSpace.length > 0) return inSpace[0];

  const all = document.querySelectorAll<HTMLElement>('div, span, button, a');
  for (const el of all) {
    if (el.children.length > 0) continue;
    if ((el.textContent || '').trim() !== '新增商品') continue;
    if (el.offsetParent === null) continue;
    const item = el.closest<HTMLElement>('[class*="ant-space-item"]') ?? el;
    return item;
  }
  return null;
}

/**
 * 从页面筛选区读取一个筛选输入框的当前值。匹配优先级:
 *   1) input 的 id 包含给定 idHints 之一(最可靠;牵牛花用 id="spuIdList" 等)
 *   2) placeholder 包含给定 keywords 之一(antd 常见 "请输入商品名称")
 *   3) 标签文本紧邻 input(适配 label 在 input 上方/左侧的布局)
 * 找不到返回空串。
 */
function readFilterInputValue(opts: { idHints?: string[]; keywords?: string[] }): string {
  const idHints = (opts.idHints ?? []).map((s) => s.toLowerCase());
  const keywords = opts.keywords ?? [];
  const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input, textarea'));

  // 1) 按 id 匹配(可见优先,但即使不可见也接受 —— 部分筛选项收在"更多筛选"里)
  if (idHints.length > 0) {
    const byId = inputs.find((inp) => {
      const id = (inp.id || '').toLowerCase();
      return id && idHints.some((h) => id.includes(h));
    });
    if (byId) {
      const v = (byId.value || '').trim();
      if (v) return v;
    }
  }

  // 2) 按 placeholder 匹配可见 input
  if (keywords.length > 0) {
    for (const inp of inputs) {
      if (inp.offsetParent === null) continue;
      const ph = inp.placeholder || '';
      if (ph && keywords.some((k) => ph.includes(k))) {
        const v = (inp.value || '').trim();
        if (v) return v;
      }
    }
    // 3) 兜底:按标签文本找邻近 input
    const labels = document.querySelectorAll<HTMLElement>('label, div, span');
    for (const el of labels) {
      if (el.children.length > 0) continue;
      const t = (el.textContent || '').trim().replace(/[::]\s*$/, '');
      if (!t || !keywords.some((k) => t === k)) continue;
      if (el.offsetParent === null) continue;
      let cur: HTMLElement | null = el;
      for (let depth = 0; depth < 4 && cur; depth++) {
        const inp = cur.parentElement?.querySelector<HTMLInputElement>('input');
        if (inp && inp.offsetParent !== null) {
          const v = (inp.value || '').trim();
          if (v) return v;
        }
        cur = cur.parentElement;
      }
    }
  }
  return '';
}

/**
 * 读取门店商品列表页筛选区的当前条件,作为导出表单的预填默认值。
 * 各字段找不到时返回空串,导出表单可让用户手动填。
 *
 * 牵牛花筛选项的真实 input id(抓自页面):
 *   - SPU ID: id="spuIdList"(placeholder「多码用","隔开,最多500条」)
 *   - SKU ID: id="skuIdList"(同上 placeholder)
 *   - 商品条码 / UPC: id 常见含 "upc"
 *   - 商品名称: id 常见含 "spuName" / "goodsName"
 */
function readPageFilters(): {
  spuNameKeyword: string;
  spuIds: string;
  skuIds: string;
  skuUpcs: string;
} {
  return {
    spuNameKeyword: readFilterInputValue({
      idHints: ['spuname', 'goodsname'],
      keywords: ['商品名称', '商品名'],
    }),
    spuIds: readFilterInputValue({
      idHints: ['spuidlist', 'spuid'],
      keywords: ['SPU ID', 'SPUID', 'SPU编码', 'SPU 编码', '商品ID', '商品 ID'],
    }),
    skuIds: readFilterInputValue({
      idHints: ['skuidlist', 'skuid'],
      keywords: ['SKU ID', 'SKUID', 'SKU编码', 'SKU 编码'],
    }),
    skuUpcs: readFilterInputValue({
      idHints: ['upclist', 'upc', 'barcode'],
      keywords: ['商品条码', 'SKU条码', 'SKU 条码', '条码', 'UPC'],
    }),
  };
}

/* ============================================================
   导出按钮:打开单页表单 → 用户填完一次性提交
   ============================================================ */

async function onExportClick() {
  const pageFilters = readPageFilters();
  const result = await openExportForm({
    callInjected,
    initialSpuNameKeyword: pageFilters.spuNameKeyword,
    initialSpuIds: pageFilters.spuIds,
    initialSkuIds: pageFilters.skuIds,
    initialSkuUpcs: pageFilters.skuUpcs,
  });
  if (!result) return; // 用户取消

  // 「重新开始」需要先把目录里的旧进度文件清掉,免得 runExport 当成续传
  if (result.startMode === 'overwrite') {
    try {
      await clearStaleProgress(result.targetDir);
    } catch (err) {
      showPanel({ title: '无法重新导出', body: (err as Error).message, tone: 'error' });
      return;
    }
  }

  showPanel({
    title: `导出 ${result.shop.shopName ?? result.shop.shopId} · 准备中`,
    body: `目录:${result.targetDir.name}${result.includeImages ? '' : ' · 不下图片'}${
      result.includeVideo ? ' · 含视频' : ''
    }${result.spuNameKeyword ? ` · 商品名筛选「${result.spuNameKeyword}」` : ''}${
      result.spuIdAllowlist ? ` · 指定 SPU ${result.spuIdAllowlist.length} 个` : ''
    }${result.skuIdList ? ` · SKU ID 筛选 ${result.skuIdList.length} 个` : ''}${
      result.skuUpcList ? ` · 商品条码筛选 ${result.skuUpcList.length} 个` : ''
    }`,
    tone: 'info',
  });
  await startExport({
    sourceShopId: result.shop.shopId,
    sourceShopName: result.shop.shopName,
    includeImages: result.includeImages,
    includeVideo: result.includeVideo,
    spuNameKeyword: result.spuNameKeyword ?? undefined,
    spuIdAllowlist: result.spuIdAllowlist ?? undefined,
    skuIdList: result.skuIdList ?? undefined,
    skuUpcList: result.skuUpcList ?? undefined,
    targetDir: result.targetDir,
  });
}

/* ============================================================
   同步库存价格按钮:打开表单 → 选门店 + 同步项 + 数据源目录
   ============================================================ */

async function onSyncClick() {
  const result = await openSyncForm({ callInjected });
  if (!result) return; // 用户取消

  const items: string[] = [];
  if (result.syncStock) items.push('库存');
  if (result.syncPrice) items.push('零售价');

  showPanel({
    title: `同步 ${result.shop.shopName ?? result.shop.shopId} · 准备中`,
    body: `数据源:${result.sourceDir.name} · 同步${items.join(' / ')}`,
    tone: 'info',
  });

  await startSync({
    shopId: result.shop.shopId,
    shopName: result.shop.shopName,
    syncStock: result.syncStock,
    syncPrice: result.syncPrice,
    sourceDir: result.sourceDir,
  });
}

/* ============================================================
   导入按钮:打开单页表单 → 用户填完一次性提交
   ============================================================ */

async function onImportClick(store = false) {
  const result = await openImportForm(store ? callInjected : undefined);
  if (!result) return;

  showPanel({
    title: result.shop ? `导入 ${result.shop.shopName ?? result.shop.shopId} · 准备中` : '导入数据 · 准备中',
    body: `源目录:${result.sourceDir.name} · ${result.mode === 'full' ? '全量' : '增量'} · ${
      result.confirmMode === 'auto' ? '自动' : '手动'
    } · ${result.syncImages ? '同步图片' : '不同步图片'}${
      result.mode === 'full' && result.updateOnNameMatch ? ' · 同名异UPC也改' : ''
    }${
      result.frontCategoryMappingFile ? ` · 分类映射:${result.frontCategoryMappingFile.name}` : ''
    }`,
    tone: 'info',
  });

  const mapping: CategoryMapping = {};
  await startImport({
    store: result.shop && { shopId: result.shop.shopId, purchaseUnitPrice: result.purchaseUnitPrice },
    sourceDir: result.sourceDir,
    mapping,
    mode: result.mode,
    confirmMode: result.confirmMode,
    syncImages: result.syncImages,
    updateOnNameMatch: result.updateOnNameMatch,
    frontCategoryMappingFile: result.frontCategoryMappingFile,
    requestConfirm: result.confirmMode === 'manual' ? requestImportConfirm : undefined,
  });
}

/**
 * 「重新导出」/「覆盖」时,把目录里旧的 .qnh-progress.json / manifest.json 删掉,
 * 这样 runExport 启动时就不会被认作续传任务。products / media 子目录里的旧文件
 * 不强删 — runExport 写新 SPU 用相同文件名会覆盖,旧的没引用就当孤儿留着,
 * 用户事后可以手动清理整个目录。
 */
async function clearStaleProgress(dir: FileSystemDirectoryHandle): Promise<void> {
  for (const name of ['.qnh-progress.json', 'manifest.json']) {
    try {
      await dir.removeEntry(name);
    } catch (err) {
      if ((err as Error).name !== 'NotFoundError') throw err;
    }
  }
}

/* ============================================================
   外部入口:popup 发现自己拿不到用户手势时,回退到"在页面里打开入口"
   ============================================================ */

let taskOpen = false;

async function openTask(action: () => Promise<void>) {
  if (taskOpen) {
    shadow?.querySelector('.qnh-card')?.classList.remove('qnh-hidden');
    return;
  }
  taskOpen = true;
  try {
    await action();
  } finally {
    taskOpen = false;
  }
}

export function openInPageEntry(kind: 'export' | 'import') {
  void openTask(kind === 'export' ? onExportClick : onImportClick);
}

/* ============================================================
   浮动进度面板(Shadow DOM)
   ============================================================ */

interface PanelInit {
  title: string;
  body?: string;
  tone?: 'info' | 'success' | 'error';
}

let shadowHost: HTMLDivElement | null = null;
let shadow: ShadowRoot | null = null;
let unsub: (() => void) | null = null;

function ensurePanel(): ShadowRoot {
  if (shadow) return shadow;
  shadowHost = document.createElement('div');
  shadowHost.dataset.qnh = MARK_PANEL;
  shadowHost.style.cssText =
    'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
  document.documentElement.appendChild(shadowHost);
  shadow = shadowHost.attachShadow({ mode: 'open' });
  shadow.innerHTML = panelHTML();
  bindPanelEvents(shadow);
  return shadow;
}

function showPanel(init: PanelInit) {
  const root = ensurePanel();
  const titleEl = root.querySelector('.qnh-title') as HTMLElement;
  const bodyEl = root.querySelector('.qnh-body') as HTMLElement;
  const cardEl = root.querySelector('.qnh-card') as HTMLElement;

  titleEl.textContent = init.title;
  bodyEl.textContent = init.body ?? '';
  cardEl.dataset.tone = init.tone ?? 'info';
  cardEl.classList.remove('qnh-hidden');

  root.querySelector<HTMLElement>('.qnh-bar > div')!.style.width = '0%';
  // 新任务开启:清空日志列表
  resetPanelLogs(root);

  // 进度订阅
  if (unsub) unsub();
  unsub = subscribeProgress((e) => onProgress(root, e));
}

function onProgress(root: ShadowRoot, e: ProgressEvent) {
  const titleEl = root.querySelector('.qnh-title') as HTMLElement;
  const bodyEl = root.querySelector('.qnh-body') as HTMLElement;
  const barEl = root.querySelector('.qnh-bar > div') as HTMLElement;
  const cardEl = root.querySelector('.qnh-card') as HTMLElement;

  if (e.kind === 'log') {
    appendPanelLog(root, e);
    return;
  }

  if (e.kind === 'export') {
    const phaseLabel = {
      list: '加载商品列表',
      detail: '抓取商品详情',
      media: '下载图片',
      pack: '打包',
    }[e.phase];
    const pCur =
      e.productCurrent ??
      (e.phase === 'detail' || e.phase === 'list' ? e.current : 0);
    const pTotal =
      e.productTotal ??
      (e.phase === 'detail' || e.phase === 'list' ? e.total : 0);
    titleEl.textContent = `导出中 · ${phaseLabel}`;
    bodyEl.textContent = `商品 ${pCur} / ${pTotal || '?'}${e.message ? ` · ${e.message}` : ''}`;
    if (pTotal > 0) {
      barEl.style.width = `${Math.min(100, (pCur / pTotal) * 100)}%`;
    }
    cardEl.dataset.tone = 'info';
  } else if (e.kind === 'import') {
    const phaseLabel = {
      parse: '解析数据包',
      media: '上传图片',
      product: '创建/修改商品',
    }[e.phase];
    const pCur = e.productCurrent ?? (e.phase === 'product' ? e.current : 0);
    const pTotal = e.productTotal ?? (e.phase === 'product' ? e.total : 0);
    titleEl.textContent = `导入中 · ${phaseLabel}`;
    bodyEl.textContent = `商品 ${pCur} / ${pTotal || '?'}${e.message ? ` · ${e.message}` : ''}`;
    if (pTotal > 0) {
      barEl.style.width = `${Math.min(100, (pCur / pTotal) * 100)}%`;
    }
    cardEl.dataset.tone = 'info';
  } else if (e.kind === 'sync') {
    const phaseLabel = {
      parse: '读取数据源',
      sku: '同步库存/零售价',
    }[e.phase];
    const pCur = e.productCurrent ?? (e.phase === 'sku' ? e.current : 0);
    const pTotal = e.productTotal ?? (e.phase === 'sku' ? e.total : 0);
    titleEl.textContent = `同步中 · ${phaseLabel}`;
    bodyEl.textContent = `商品 ${pCur} / ${pTotal || '?'}${e.message ? ` · ${e.message}` : ''}`;
    if (pTotal > 0) {
      barEl.style.width = `${Math.min(100, (pCur / pTotal) * 100)}%`;
    }
    cardEl.dataset.tone = 'info';
  } else if (e.kind === 'done') {
    if ('kind' in e.result) {
      const r = e.result;
      const failed = r.productFailed > 0 || r.priceFailed > 0 || r.stockFailed > 0;
      titleEl.textContent = r.cancelled ? '同步已取消' : failed ? '同步完成(有失败)' : '同步完成 ✓';
      const parts = [`商品 ${r.productProcessed}/${r.productTotal}`];
      if (r.productFailed > 0) parts.push(`商品处理失败 ${r.productFailed}`);
      if (r.productNotFound > 0) parts.push(`未匹配 ${r.productNotFound}`);
      if (r.syncedPrice) {
        parts.push(`零售价 成功 ${r.priceOk}·失败 ${r.priceFailed}·跳过 ${r.priceSkipped}`);
      }
      if (r.syncedStock) {
        parts.push(`库存 成功 ${r.stockOk}·失败 ${r.stockFailed}·跳过 ${r.stockSkipped}`);
      }
      let body = parts.join('\n');
      if (r.firstError) body += `\n首个错误: ${r.firstError}`;
      bodyEl.textContent = body;
      bodyEl.style.whiteSpace = 'pre-wrap';
      if (!r.cancelled) barEl.style.width = '100%';
      cardEl.dataset.tone = failed ? 'error' : r.cancelled ? 'info' : 'success';
      return;
    }
    if ('fileName' in e.result) {
      cardEl.dataset.tone = 'success';
      titleEl.textContent = '导出完成 ✓';
      bodyEl.textContent = `${e.result.manifest.productCount} 个商品已写入「${e.result.fileName}」。`;
    } else {
      const r = e.result;
      const failed = r.failed > 0;
      titleEl.textContent = r.cancelled ? '导入已取消' : failed ? '导入完成(有失败)' : '导入完成 ✓';
      cardEl.dataset.tone = failed ? 'error' : r.cancelled ? 'info' : 'success';
      const parts = [`共 ${r.total}`, `新建 ${r.succeeded}`];
      if (r.updated > 0) parts.push(`修改 ${r.updated}`);
      if (r.skipped > 0) parts.push(`跳过 ${r.skipped}`);
      parts.push(`失败 ${r.failed}`);
      let body = parts.join(' · ');
      if (failed) {
        const firstFail = r.items.find((x) => x.status === 'failed');
        if (firstFail) {
          body += `\n首个失败: ${firstFail.name}\n原因: ${firstFail.errorMessage ?? '(无)'}`;
        }
      }
      bodyEl.textContent = body;
      bodyEl.style.whiteSpace = 'pre-wrap';
      if (r.cancelled) return;
    }
    barEl.style.width = '100%';
  } else if (e.kind === 'error') {
    const cancelled = e.message === '已取消';
    titleEl.textContent = cancelled ? '任务已取消' : '出错了';
    bodyEl.textContent = e.message;
    cardEl.dataset.tone = cancelled ? 'info' : 'error';
  }
}

/** 浮动进度面板的日志列表上限,超过会从头丢弃,避免大批量任务撑爆 DOM */
const INPAGE_MAX_LOG_LINES = 50;

function resetPanelLogs(root: ShadowRoot) {
  const list = root.querySelector('.qnh-logs') as HTMLElement | null;
  if (!list) return;
  list.classList.add('qnh-hidden');
  list.innerHTML = '<div class="qnh-logs__empty">等待商品处理…</div>';
}

function appendPanelLog(
  root: ShadowRoot,
  e: Extract<ProgressEvent, { kind: 'log' }>,
) {
  const list = root.querySelector('.qnh-logs') as HTMLElement | null;
  if (!list) return;
  if (list.classList.contains('qnh-hidden')) {
    list.innerHTML = '';
    list.classList.remove('qnh-hidden');
  }
  const row = document.createElement('div');
  row.className = 'qnh-logrow';
  row.dataset.level = e.level;
  const idx = document.createElement('span');
  idx.className = 'qnh-logrow__index';
  idx.textContent = `${e.index}${e.total ? `/${e.total}` : ''}`;
  const text = document.createElement('span');
  text.className = 'qnh-logrow__text';
  text.textContent = e.text;
  text.title = e.text;
  row.append(idx, text);
  list.appendChild(row);

  while (list.childElementCount > INPAGE_MAX_LOG_LINES) {
    list.removeChild(list.firstElementChild!);
  }

  // 总是滚到底部,模仿安装器"当前正在处理 X"的体验
  list.scrollTop = list.scrollHeight;
}

function bindPanelEvents(root: ShadowRoot) {
  root.querySelector('.qnh-close')?.addEventListener('click', () => {
    (root.querySelector('.qnh-card') as HTMLElement).classList.add('qnh-hidden');
  });
  root.querySelector('.qnh-cancel')?.addEventListener('click', () => {
    cancelCurrent();
  });
}

function panelHTML(): string {
  return `
    <style>
      :host { all: initial; }
      .qnh-card {
        position: fixed;
        right: 20px;
        bottom: 20px;
        width: min(380px, calc(100vw - 40px));
        background: #fff;
        border: 1px solid #e6e8eb;
        border-radius: 8px;
        box-shadow: 0 6px 24px rgba(0,0,0,0.12);
        font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI",
          "PingFang SC", "Microsoft YaHei", sans-serif;
        color: #1f1f1f;
        overflow: hidden;
        display: flex; flex-direction: column;
      }
      .qnh-card.qnh-hidden { display: none; }
      .qnh-card[data-tone="success"] { border-color: #b7eb8f; }
      .qnh-card[data-tone="error"]   { border-color: #ffa39e; }

      .qnh-head {
        display: flex; align-items: center; justify-content: space-between;
        padding: 8px 12px;
        background: #fafbfc;
        border-bottom: 1px solid #f0f1f2;
      }
      .qnh-title { font-weight: 600; font-size: 13px; }
      .qnh-close {
        all: unset; cursor: pointer; padding: 0 6px;
        color: #999; font-size: 16px; line-height: 1;
      }
      .qnh-close:hover { color: #1f1f1f; }

      .qnh-content { padding: 10px 12px 8px; }
      .qnh-body { font-size: 12px; color: #555; min-height: 18px; word-break: break-all; }
      .qnh-bar {
        margin-top: 8px;
        height: 6px;
        background: #f0f3f7;
        border-radius: 3px;
        overflow: hidden;
      }
      .qnh-bar > div {
        height: 100%;
        width: 0%;
        background: #12675b;
        transition: width .25s ease;
      }
      .qnh-card[data-tone="success"] .qnh-bar > div { background: #52c41a; }
      .qnh-card[data-tone="error"]   .qnh-bar > div { background: #ff4d4f; }

      .qnh-logs {
        margin: 0 12px 8px;
        height: calc(12 * 18px + 12px);
        overflow-y: auto;
        background: #fafbfc;
        border: 1px solid #e6e8eb;
        border-radius: 6px;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 11px;
        line-height: 18px;
        padding: 6px 0;
      }
      .qnh-logs.qnh-hidden { display: none; }
      .qnh-logs__empty {
        padding: 16px; text-align: center; color: #999;
        font-family: inherit;
      }
      .qnh-logrow {
        display: flex; align-items: baseline; gap: 6px;
        padding: 1px 8px;
      }
      .qnh-logrow:hover { background: #eef2f7; }
      .qnh-logrow__index {
        flex: 0 0 auto; min-width: 40px; text-align: right;
        color: #999; font-variant-numeric: tabular-nums;
      }
      .qnh-logrow__text {
        flex: 1 1 auto; white-space: nowrap; overflow: hidden;
        text-overflow: ellipsis;
      }
      .qnh-logrow[data-level="success"] .qnh-logrow__text { color: #237804; }
      .qnh-logrow[data-level="info"]    .qnh-logrow__text { color: #1f1f1f; }
      .qnh-logrow[data-level="warn"]    .qnh-logrow__text { color: #ad6800; }
      .qnh-logrow[data-level="error"]   .qnh-logrow__text { color: #cf1322; }

      .qnh-foot {
        display: flex; justify-content: flex-end;
        padding: 8px 12px;
        border-top: 1px solid #f0f1f2;
        gap: 8px;
      }
      .qnh-btn {
        all: unset; cursor: pointer;
        padding: 4px 10px; border-radius: 4px;
        font-size: 12px; border: 1px solid #d9d9d9;
      }
      .qnh-btn:hover { background: #fafafa; }
    </style>
    <div class="qnh-card qnh-hidden" data-tone="info">
      <div class="qnh-head">
        <span class="qnh-title">导出</span>
        <button class="qnh-close" title="关闭">×</button>
      </div>
      <div class="qnh-content">
        <div class="qnh-body"></div>
        <div class="qnh-bar"><div></div></div>
      </div>
      <div class="qnh-logs qnh-hidden">
        <div class="qnh-logs__empty">等待商品处理…</div>
      </div>
      <div class="qnh-foot">
        <button class="qnh-btn qnh-cancel">取消任务</button>
      </div>
    </div>
  `;
}

/* ============================================================
   手动导入确认弹窗
   --------------------------------------------------------------
   每个商品写入(create / update)前调用一次,用户三选一:
     ✓ 确认本次写入
     →   跳过本商品(继续下一个)
     ✗ 取消整批导入
   返回的 Promise 会被 runImport 的 (c.5) 步骤 await,直到用户做出选择。
   ============================================================ */

const MARK_CONFIRM = 'qnh-import-confirm';

export function requestImportConfirm(info: {
  signal?: AbortSignal;
  productName: string;
  productCurrent: number;
  productTotal: number;
  action: 'create' | 'update';
}): Promise<import('./import').ConfirmDecision> {
  return new Promise((resolve) => {
    document.querySelector(`[data-qnh="${MARK_CONFIRM}"]`)?.remove();

    const host = document.createElement('div');
    host.dataset.qnh = MARK_CONFIRM;
    host.style.cssText =
      'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
    document.documentElement.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });

    const actionLabel = info.action === 'create' ? '新建' : '修改';
    const actionColor = info.action === 'create' ? '#1677ff' : '#fa8c16';

    root.innerHTML = `
      <style>
        :host { all: initial; }
        .qnh-cf-card {
          position: fixed;
          right: 20px;
          bottom: 240px;
          width: 360px;
          background: #fff;
          border: 1px solid #e6e8eb;
          border-radius: 8px;
          box-shadow: 0 6px 24px rgba(0,0,0,0.16);
          font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI",
            "PingFang SC", "Microsoft YaHei", sans-serif;
          color: #1f1f1f;
          overflow: hidden;
        }
        .qnh-cf-head {
          display: flex; align-items: center; justify-content: space-between;
          padding: 8px 12px;
          background: #fafbfc;
          border-bottom: 1px solid #f0f1f2;
        }
        .qnh-cf-title {
          font-weight: 600; font-size: 13px;
          display: flex; align-items: center; gap: 6px;
        }
        .qnh-cf-tag {
          display: inline-block;
          padding: 1px 6px; border-radius: 3px;
          font-size: 11px; line-height: 16px;
          color: #fff; background: ${actionColor};
        }
        .qnh-cf-prog {
          color: #888; font-size: 11px;
        }
        .qnh-cf-body {
          padding: 12px; font-size: 13px;
          word-break: break-all;
          max-height: 88px; overflow: auto;
        }
        .qnh-cf-foot {
          display: flex; justify-content: flex-end; gap: 8px;
          padding: 8px 12px;
          border-top: 1px solid #f0f1f2;
          background: #fafbff;
        }
        .qnh-cf-btn {
          all: unset; cursor: pointer;
          padding: 5px 12px; border-radius: 4px;
          font-size: 12px; border: 1px solid #d9d9d9;
        }
        .qnh-cf-btn:hover { background: #fafafa; }
        .qnh-cf-btn.ok {
          background: #52c41a; color: #fff; border-color: #52c41a;
        }
        .qnh-cf-btn.ok:hover { background: #73d13d; }
        .qnh-cf-btn.skip {
          background: #fff; color: #555;
        }
        .qnh-cf-btn.cancel {
          background: #fff; color: #cf1322; border-color: #ffa39e;
        }
        .qnh-cf-btn.cancel:hover { background: #fff1f0; }
        .qnh-cf-hint {
          padding: 0 12px 8px; color: #999; font-size: 11px;
        }
      </style>
      <div class="qnh-cf-card">
        <div class="qnh-cf-head">
          <div class="qnh-cf-title">
            <span class="qnh-cf-tag">${actionLabel}</span>
            <span>等待确认</span>
          </div>
          <div class="qnh-cf-prog">${info.productCurrent} / ${info.productTotal}</div>
        </div>
        <div class="qnh-cf-body" title=""></div>
        <div class="qnh-cf-hint">点击「对号」才会${actionLabel}该商品</div>
        <div class="qnh-cf-foot">
          <button class="qnh-cf-btn cancel">✗ 取消整批</button>
          <button class="qnh-cf-btn skip">→ 跳过</button>
          <button class="qnh-cf-btn ok">✓ 确认${actionLabel}</button>
        </div>
      </div>
    `;

    // textContent 比 innerHTML 更安全,避免商品名里有 < > 时出问题
    const body = root.querySelector('.qnh-cf-body') as HTMLElement;
    body.textContent = info.productName;
    body.title = info.productName;

    const dispose = (decision: import('./import').ConfirmDecision) => {
      host.remove();
      cleanup();
      resolve(decision);
    };
    root.querySelector('.qnh-cf-btn.ok')?.addEventListener('click', () => dispose('confirm'));
    root.querySelector('.qnh-cf-btn.skip')?.addEventListener('click', () => dispose('skip'));
    root
      .querySelector('.qnh-cf-btn.cancel')
      ?.addEventListener('click', () => dispose('cancel-all'));

    // 键盘快捷键:Enter=确认 / S=跳过 / Esc=取消整批
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        dispose('confirm');
      } else if (e.key === 'Escape') {
        e.preventDefault();
        dispose('cancel-all');
      } else if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        dispose('skip');
      }
    };
    const cancel = () => dispose('cancel-all');
    const cleanup = () => {
      window.removeEventListener('keydown', onKey, true);
      info.signal?.removeEventListener('abort', cancel);
    };
    window.addEventListener('keydown', onKey, true);
    if (info.signal?.aborted) cancel();
    else info.signal?.addEventListener('abort', cancel, { once: true });
  });
}
