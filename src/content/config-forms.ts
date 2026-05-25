/**
 * 单页配置表单(导出 / 导入各一张)
 *
 * 替换原先的"门店选择 → 选项 → 目录 → 确认/三选 → 文件"逐步引导式弹窗,
 * 把所有可选项一次性铺在一张表上,用户按需填完之后点一次"开始"就跑。
 *
 * 设计要点:
 *   - Shadow DOM 隔离样式,避免被宿主页样式干扰(也不影响宿主页)。
 *   - 选目录 / 选映射文件按钮原地触发系统选择器(用户手势必须保留),
 *     选好之后只把"已选目录名 / 文件名"回显在表单上。
 *   - 目录选好之后立刻探测内容状态并就地展示(已完成 / 未完成 / 全新),
 *     不再用三选弹窗;若是未完成,提供「继续上次 / 重新开始」单选,
 *     全新与已完成则只有"开始"一种行为(已完成会显示"将覆盖"提示)。
 *   - 用户取消整张表单 = 关闭对话框,不发起任何操作。
 */

import { createLogger } from '@shared/logger';
import type { ShopBrief } from '@shared/messaging';
import { detectExportTargetStatus, type ExportTargetStatus } from './export';
import {
  pickDirectory,
  readManifestIfComplete,
} from './fs-stage';
import type { CallInjected } from './index';

const log = createLogger('inpage-form');

/* ============================================================
   公共原语
   ============================================================ */

const DIALOG_HOST_STYLE =
  'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';

/** 共享对话框样式;两张表单复用一份 CSS,变量化几个尺寸 */
const FORM_CSS = `
  :host { all: initial; }
  .qnh-fm-mask {
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.36);
    display: flex; align-items: center; justify-content: center;
    font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI",
      "PingFang SC", "Microsoft YaHei", sans-serif;
    color: #1f1f1f;
  }
  .qnh-fm-card {
    width: 560px; max-height: 86vh;
    background: #fff;
    border-radius: 8px;
    box-shadow: 0 12px 32px rgba(0,0,0,0.18);
    display: flex; flex-direction: column; overflow: hidden;
  }
  .qnh-fm-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid #f0f1f2;
  }
  .qnh-fm-title { font-weight: 600; font-size: 14px; }
  .qnh-fm-close {
    all: unset; cursor: pointer; padding: 0 6px;
    color: #999; font-size: 18px; line-height: 1;
  }
  .qnh-fm-close:hover { color: #1f1f1f; }
  .qnh-fm-body {
    padding: 12px 16px 4px;
    overflow-y: auto;
  }
  .qnh-fm-section {
    margin-bottom: 14px;
  }
  .qnh-fm-section:last-child { margin-bottom: 8px; }
  .qnh-fm-section__label {
    display: block;
    font-size: 12px; color: #555;
    margin-bottom: 6px;
    font-weight: 500;
  }
  .qnh-fm-section__hint {
    margin-top: 4px;
    color: #888; font-size: 11px;
    line-height: 1.5;
  }
  .qnh-fm-row {
    display: flex; align-items: center; gap: 8px;
  }
  .qnh-fm-input {
    flex: 1; min-width: 0;
    padding: 6px 8px;
    border: 1px solid #d9d9d9; border-radius: 4px;
    font-size: 13px; outline: none; background: #fff;
  }
  .qnh-fm-input:focus { border-color: #1677ff; }
  .qnh-fm-input[readonly] { background: #fafafa; color: #333; }
  .qnh-fm-select {
    width: 100%;
    border: 1px solid #d9d9d9; border-radius: 4px;
    font-size: 13px; padding: 2px;
    outline: none;
  }
  .qnh-fm-select:focus { border-color: #1677ff; }
  .qnh-fm-choices {
    display: flex; flex-direction: column; gap: 6px;
  }
  .qnh-fm-radio, .qnh-fm-check {
    display: flex; align-items: center; gap: 6px;
    font-size: 13px; cursor: pointer;
  }
  .qnh-fm-radio input, .qnh-fm-check input { margin: 0; }
  .qnh-fm-radio__hint, .qnh-fm-check__hint {
    color: #888; font-size: 11px;
  }
  .qnh-fm-pill {
    display: inline-flex; align-items: center;
    padding: 2px 8px; border-radius: 10px;
    font-size: 11px; line-height: 1.6;
    margin-left: 6px;
  }
  .qnh-fm-pill--info  { background: #e6f4ff; color: #0958d9; }
  .qnh-fm-pill--ok    { background: #f6ffed; color: #389e0d; }
  .qnh-fm-pill--warn  { background: #fff7e6; color: #d48806; }
  .qnh-fm-pill--err   { background: #fff1f0; color: #cf1322; }
  .qnh-fm-btn {
    all: unset; cursor: pointer;
    padding: 5px 12px; border-radius: 4px;
    font-size: 12px; border: 1px solid #d9d9d9;
    background: #fff;
  }
  .qnh-fm-btn:hover { background: #fafafa; }
  .qnh-fm-btn[disabled] { opacity: 0.5; cursor: not-allowed; }
  .qnh-fm-foot {
    display: flex; align-items: center; justify-content: flex-end;
    gap: 10px;
    padding: 10px 16px;
    border-top: 1px solid #f0f1f2;
    background: #fafbff;
  }
  .qnh-fm-foot__hint {
    margin-right: auto; color: #888; font-size: 11px;
  }
  .qnh-fm-foot__hint.err { color: #cf1322; }
  .qnh-fm-action {
    all: unset; cursor: pointer;
    padding: 6px 16px; border-radius: 4px;
    font-size: 13px; border: 1px solid #d9d9d9;
  }
  .qnh-fm-action:hover { background: #fafafa; }
  .qnh-fm-action.primary {
    background: #1677ff; color: #fff; border-color: #1677ff;
  }
  .qnh-fm-action.primary:hover { background: #4096ff; }
  .qnh-fm-action[disabled] { opacity: 0.5; cursor: not-allowed; }
  .qnh-fm-status {
    margin-top: 6px;
    padding: 8px 10px;
    background: #fafbfc;
    border: 1px solid #eef0f2;
    border-radius: 4px;
    font-size: 12px;
    line-height: 1.6;
    color: #555;
  }
  .qnh-fm-status.warn { background: #fffbe6; border-color: #ffe58f; color: #ad6800; }
  .qnh-fm-status.err  { background: #fff1f0; border-color: #ffccc7; color: #cf1322; }
  .qnh-fm-search {
    width: 100%; padding: 5px 8px;
    border: 1px solid #d9d9d9; border-radius: 4px;
    font-size: 12px; outline: none; margin-bottom: 6px;
  }
  .qnh-fm-search:focus { border-color: #1677ff; }
`;

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => {
    return ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    } as Record<string, string>)[c]!;
  });
}

function buildShadowHost(html: string): { host: HTMLDivElement; root: ShadowRoot } {
  const host = document.createElement('div');
  host.style.cssText = DIALOG_HOST_STYLE;
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = html;
  return { host, root };
}

/* ============================================================
   导出表单
   ============================================================ */

export interface ExportFormResult {
  shop: ShopBrief;
  spuNameKeyword: string | null;
  /** 是否一并下载图片(默认 true) */
  includeImages: boolean;
  includeVideo: boolean;
  /** 用户已经在表单内通过 showDirectoryPicker 拿到的目录 handle */
  targetDir: FileSystemDirectoryHandle;
  /** 由表单基于目录状态推导出的"启动姿态" */
  startMode: 'fresh' | 'overwrite' | 'resume';
}

export interface OpenExportFormArgs {
  /** 拉门店列表 */
  callInjected: CallInjected;
  /** 表单出现时,如果页面"商品名称"筛选框有值,可由调用方预填 */
  initialSpuNameKeyword?: string;
}

/**
 * 弹出导出配置表单。返回 Promise 在用户点"开始导出"时 resolve,
 * 关闭/取消时 resolve(null)。
 */
export function openExportForm(args: OpenExportFormArgs): Promise<ExportFormResult | null> {
  return new Promise((resolve) => {
    const { host, root } = buildShadowHost(`
      <style>${FORM_CSS}</style>
      <div class="qnh-fm-mask">
        <div class="qnh-fm-card" role="dialog" aria-modal="true">
          <div class="qnh-fm-head">
            <span class="qnh-fm-title">导出本店商品</span>
            <button class="qnh-fm-close" data-act="cancel" title="关闭">×</button>
          </div>
          <div class="qnh-fm-body">

            <div class="qnh-fm-section">
              <span class="qnh-fm-section__label">门店</span>
              <input class="qnh-fm-search" data-id="shop-search" placeholder="搜索门店名 / 编号 / 城市" />
              <select class="qnh-fm-select" data-id="shop-select" size="6"></select>
              <div class="qnh-fm-section__hint" data-id="shop-hint">加载门店列表中…</div>
            </div>

            <div class="qnh-fm-section">
              <span class="qnh-fm-section__label">商品名筛选(可选)</span>
              <input class="qnh-fm-input" data-id="spu-name" placeholder="留空则全店导出" />
              <div class="qnh-fm-section__hint">仅导出名称包含此关键字的商品。</div>
            </div>

            <div class="qnh-fm-section">
              <span class="qnh-fm-section__label">导出选项</span>
              <label class="qnh-fm-check">
                <input type="checkbox" data-id="include-images" checked />
                <span>下载图片到本地</span>
                <span class="qnh-fm-check__hint">(取消后图片字段保留原始 CDN URL,导入时按直链同步)</span>
              </label>
              <label class="qnh-fm-check" style="margin-top:6px;">
                <input type="checkbox" data-id="include-video" />
                <span>同时下载视频</span>
                <span class="qnh-fm-check__hint">(默认不下,体积大且导入端暂不支持自动上传)</span>
              </label>
            </div>

            <div class="qnh-fm-section">
              <span class="qnh-fm-section__label">导出目录</span>
              <div class="qnh-fm-row">
                <input class="qnh-fm-input" data-id="dir-name" readonly placeholder="尚未选择目录" />
                <button class="qnh-fm-btn" data-act="pick-dir">选择目录…</button>
              </div>
              <div class="qnh-fm-status" data-id="dir-status" style="display:none"></div>
            </div>

          </div>
          <div class="qnh-fm-foot">
            <span class="qnh-fm-foot__hint" data-id="foot-hint">填好"门店"和"导出目录"后开始</span>
            <button class="qnh-fm-action" data-act="cancel">取消</button>
            <button class="qnh-fm-action primary" data-act="ok" disabled>开始导出</button>
          </div>
        </div>
      </div>
    `);

    /* ---- DOM 引用 ---- */
    const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
      root.querySelector(sel) as T | null;
    const shopSearch = $<HTMLInputElement>('[data-id="shop-search"]')!;
    const shopSelect = $<HTMLSelectElement>('[data-id="shop-select"]')!;
    const shopHint = $('[data-id="shop-hint"]')!;
    const spuName = $<HTMLInputElement>('[data-id="spu-name"]')!;
    const includeImages = $<HTMLInputElement>('[data-id="include-images"]')!;
    const includeVideo = $<HTMLInputElement>('[data-id="include-video"]')!;
    const dirName = $<HTMLInputElement>('[data-id="dir-name"]')!;
    const dirStatus = $('[data-id="dir-status"]')!;
    const footHint = $('[data-id="foot-hint"]')!;
    const okBtn = $<HTMLButtonElement>('[data-act="ok"]')!;

    /* ---- 状态 ---- */
    let shops: ShopBrief[] = [];
    let selectedShop: ShopBrief | null = null;
    let dirHandle: FileSystemDirectoryHandle | null = null;
    let dirState: ExportTargetStatus | null = null;
    let resumeChoice: 'continue' | 'restart' = 'continue';

    if (args.initialSpuNameKeyword) {
      spuName.value = args.initialSpuNameKeyword;
    }

    /* ---- 关闭 ---- */
    const dispose = (result: ExportFormResult | null) => {
      host.remove();
      resolve(result);
    };

    root.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const act = target.closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act === 'cancel') dispose(null);
    });
    root.querySelector('.qnh-fm-mask')?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).classList.contains('qnh-fm-mask')) dispose(null);
    });

    /* ---- 拉门店列表 ---- */
    args.callInjected<ShopBrief[]>({ type: 'FETCH_SHOP_LIST' })
      .then((list) => {
        shops = Array.isArray(list) ? list : [];
        shopHint.textContent = shops.length === 0
          ? '当前账号下没有可管理的门店'
          : `共 ${shops.length} 家门店`;
        renderShopList();
      })
      .catch((err: Error) => {
        shopHint.textContent = `加载失败:${err.message}`;
        shopHint.classList.add('err');
        log.warn('门店列表加载失败', err);
      });

    function filterShops(): ShopBrief[] {
      const k = shopSearch.value.trim();
      if (!k) return shops;
      // 多 ID 搜索:逗号 / 顿号分隔
      if (/[,,、]/.test(k)) {
        const ids = k.split(/[,,、]/).map((x) => x.trim()).filter(Boolean);
        return shops.filter((s) => ids.some((q) => String(s.shopId).includes(q)));
      }
      const lower = k.toLowerCase();
      return shops.filter(
        (s) =>
          String(s.shopId).toLowerCase().includes(lower) ||
          (s.shopName ?? '').toLowerCase().includes(lower) ||
          (s.region ?? '').toLowerCase().includes(lower),
      );
    }

    function renderShopList() {
      const list = filterShops();
      shopSelect.innerHTML = list
        .map((s) => {
          const sel = selectedShop && String(selectedShop.shopId) === String(s.shopId);
          const region = s.region ? ` · ${escapeHtml(s.region)}` : '';
          return `<option value="${escapeHtml(String(s.shopId))}" ${sel ? 'selected' : ''}>${escapeHtml(s.shopName ?? '(未命名)')}${region} · #${escapeHtml(String(s.shopId))}</option>`;
        })
        .join('');
      shopSelect.size = Math.min(8, Math.max(3, list.length));
      if (list.length === 0) {
        shopSelect.innerHTML = '<option disabled>没有匹配门店</option>';
      }
      updateFoot();
    }

    shopSearch.addEventListener('input', () => renderShopList());
    shopSelect.addEventListener('change', () => {
      const v = shopSelect.value;
      selectedShop = shops.find((s) => String(s.shopId) === v) ?? null;
      updateFoot();
    });

    /* ---- 选目录 ---- */
    root.querySelector('[data-act="pick-dir"]')?.addEventListener('click', async () => {
      try {
        const dir = await pickDirectory({ id: 'qnh-export-dir', mode: 'readwrite' });
        dirHandle = dir;
        dirName.value = dir.name;
        dirStatus.style.display = 'none';
        dirStatus.classList.remove('warn', 'err');
        dirStatus.textContent = '检查目录状态…';
        dirStatus.style.display = '';
        try {
          dirState = await detectExportTargetStatus(dir);
          renderDirStatus();
        } catch (e) {
          dirState = null;
          dirStatus.classList.add('err');
          dirStatus.textContent = `读取目录失败:${(e as Error).message}`;
        }
        updateFoot();
      } catch (e) {
        if ((e as DOMException)?.name === 'AbortError') return;
        dirStatus.style.display = '';
        dirStatus.classList.add('err');
        dirStatus.textContent = `选择目录失败:${(e as Error).message}`;
      }
    });

    function renderDirStatus() {
      dirStatus.classList.remove('warn', 'err');
      if (!dirState) {
        dirStatus.style.display = 'none';
        return;
      }
      dirStatus.style.display = '';
      if (dirState.kind === 'empty') {
        dirStatus.textContent = '目录为空 / 尚无导出 — 将作为新任务写入。';
        return;
      }
      if (dirState.kind === 'complete') {
        dirStatus.classList.add('warn');
        const m = dirState.manifest;
        dirStatus.textContent =
          `目录里已有完整导出(${m.source.shopName ?? '?'} · ${m.productCount} 个商品)。` +
          ` 继续将覆盖此目录里的内容。`;
        return;
      }
      // incomplete
      const p = dirState.progress;
      const sameShop = !!selectedShop && String(p.source.shopId) === String(selectedShop.shopId);
      const sameOpts =
        p.options.includeVideo === includeVideo.checked &&
        (p.options.includeImages ?? true) === includeImages.checked;
      if (sameShop && sameOpts) {
        // 提供"继续 / 重来"两个 radio
        dirStatus.classList.add('warn');
        dirStatus.innerHTML = `
          <div>上次导出未完成:已完成 ${p.doneSpuIds.length} 个 SPU,队列还有 ${p.queue.length} 个。</div>
          <div class="qnh-fm-choices" style="margin-top:6px;">
            <label class="qnh-fm-radio">
              <input type="radio" name="qnh-resume" value="continue" ${resumeChoice === 'continue' ? 'checked' : ''} />
              <span>继续上次</span>
            </label>
            <label class="qnh-fm-radio">
              <input type="radio" name="qnh-resume" value="restart" ${resumeChoice === 'restart' ? 'checked' : ''} />
              <span>重新开始(丢弃旧进度)</span>
            </label>
          </div>
        `;
        dirStatus.querySelectorAll<HTMLInputElement>('input[name="qnh-resume"]').forEach((el) => {
          el.addEventListener('change', () => {
            if (el.checked) resumeChoice = (el.value as 'continue' | 'restart');
            updateFoot();
          });
        });
      } else {
        dirStatus.classList.add('warn');
        dirStatus.textContent =
          `目录里有未完成的导出(原:${p.source.shopName ?? '?'},选项与当前不一致)。` +
          ` 继续将丢弃旧进度,重新开始。`;
      }
    }

    /* 用户改了门店或视频选项 → 重新渲染目录状态(影响 sameShop / sameOpts 判断) */
    shopSelect.addEventListener('change', () => renderDirStatus());
    includeVideo.addEventListener('change', () => renderDirStatus());
    includeImages.addEventListener('change', () => renderDirStatus());

    /* ---- 表单状态汇总 ---- */
    function updateFoot() {
      const ready = !!selectedShop && !!dirHandle;
      okBtn.disabled = !ready;
      footHint.classList.remove('err');
      if (!selectedShop) {
        footHint.textContent = '请选择门店';
      } else if (!dirHandle) {
        footHint.textContent = '请选择导出目录';
      } else if (
        dirState?.kind === 'incomplete' &&
        selectedShop &&
        String(dirState.progress.source.shopId) === String(selectedShop.shopId) &&
        dirState.progress.options.includeVideo === includeVideo.checked &&
        (dirState.progress.options.includeImages ?? true) === includeImages.checked
      ) {
        footHint.textContent = resumeChoice === 'continue' ? '将继续上次导出' : '将丢弃旧进度并重新开始';
      } else if (dirState?.kind === 'complete') {
        footHint.textContent = '将覆盖目录中已有的导出';
      } else {
        footHint.textContent = '准备就绪';
      }
    }

    /* ---- 提交 ---- */
    root.querySelector('[data-act="ok"]')?.addEventListener('click', () => {
      if (!selectedShop || !dirHandle) return;
      let startMode: ExportFormResult['startMode'];
      if (dirState?.kind === 'complete') {
        startMode = 'overwrite';
      } else if (
        dirState?.kind === 'incomplete' &&
        String(dirState.progress.source.shopId) === String(selectedShop.shopId) &&
        dirState.progress.options.includeVideo === includeVideo.checked &&
        (dirState.progress.options.includeImages ?? true) === includeImages.checked
      ) {
        startMode = resumeChoice === 'continue' ? 'resume' : 'overwrite';
      } else if (dirState?.kind === 'incomplete') {
        // 选项不一致 — 等价于覆盖
        startMode = 'overwrite';
      } else {
        startMode = 'fresh';
      }
      dispose({
        shop: selectedShop,
        spuNameKeyword: spuName.value.trim() || null,
        includeImages: includeImages.checked,
        includeVideo: includeVideo.checked,
        targetDir: dirHandle,
        startMode,
      });
    });

    /* 默认聚焦搜索框 */
    setTimeout(() => shopSearch.focus(), 0);
  });
}

/* ============================================================
   导入表单
   ============================================================ */

export interface ImportFormResult {
  sourceDir: FileSystemDirectoryHandle;
  mode: 'full' | 'incremental';
  confirmMode: 'auto' | 'manual';
  /** 是否同步图片;false 时跳过所有图片上传 / 比对 */
  syncImages: boolean;
  /** 用户附带的店内分类映射文件(可选) */
  frontCategoryMappingFile: File | null;
}

export interface OpenImportFormArgs {
  /** 选完目录后用来检测是否是有效导出包 */
  // 不传 callInjected 也可以,但保留以备后续扩展
}

/**
 * 弹出导入配置表单。返回 Promise 在用户点"开始导入"时 resolve,关闭/取消 resolve(null)。
 */
export function openImportForm(_args: OpenImportFormArgs = {}): Promise<ImportFormResult | null> {
  return new Promise((resolve) => {
    const { host, root } = buildShadowHost(`
      <style>${FORM_CSS}</style>
      <div class="qnh-fm-mask">
        <div class="qnh-fm-card" role="dialog" aria-modal="true">
          <div class="qnh-fm-head">
            <span class="qnh-fm-title">导入商品</span>
            <button class="qnh-fm-close" data-act="cancel" title="关闭">×</button>
          </div>
          <div class="qnh-fm-body">

            <div class="qnh-fm-section">
              <span class="qnh-fm-section__label">导入源目录</span>
              <div class="qnh-fm-row">
                <input class="qnh-fm-input" data-id="dir-name" readonly placeholder="尚未选择目录" />
                <button class="qnh-fm-btn" data-act="pick-dir">选择目录…</button>
              </div>
              <div class="qnh-fm-status" data-id="dir-status" style="display:none"></div>
            </div>

            <div class="qnh-fm-section">
              <span class="qnh-fm-section__label">导入模式</span>
              <div class="qnh-fm-choices">
                <label class="qnh-fm-radio">
                  <input type="radio" name="qnh-mode" value="full" checked />
                  <span>全量导入</span>
                  <span class="qnh-fm-radio__hint">UPC 命中走"修改"接口,参数一致则跳过</span>
                </label>
                <label class="qnh-fm-radio">
                  <input type="radio" name="qnh-mode" value="incremental" />
                  <span>增量导入</span>
                  <span class="qnh-fm-radio__hint">已存在的按 UPC / 同名跳过</span>
                </label>
              </div>
            </div>

            <div class="qnh-fm-section">
              <span class="qnh-fm-section__label">执行方式</span>
              <div class="qnh-fm-choices">
                <label class="qnh-fm-radio">
                  <input type="radio" name="qnh-confirm" value="auto" checked />
                  <span>自动</span>
                  <span class="qnh-fm-radio__hint">程序自动逐个执行</span>
                </label>
                <label class="qnh-fm-radio">
                  <input type="radio" name="qnh-confirm" value="manual" />
                  <span>手动</span>
                  <span class="qnh-fm-radio__hint">每个商品写入前需点对号确认</span>
                </label>
              </div>
            </div>

            <div class="qnh-fm-section">
              <span class="qnh-fm-section__label">图片同步</span>
              <label class="qnh-fm-check">
                <input type="checkbox" data-id="sync-images" checked />
                <span>同步图片到目标店</span>
                <span class="qnh-fm-check__hint">取消后不会上传也不比对图片(更快,但目标店图片字段可能为空)</span>
              </label>
            </div>

            <div class="qnh-fm-section">
              <span class="qnh-fm-section__label">店内分类映射文件(可选)</span>
              <div class="qnh-fm-row">
                <input class="qnh-fm-input" data-id="mapping-name" readonly placeholder="未选择" />
                <button class="qnh-fm-btn" data-act="pick-mapping">选择文件…</button>
                <button class="qnh-fm-btn" data-act="clear-mapping" style="display:none">清除</button>
              </div>
              <div class="qnh-fm-section__hint">
                目标店若缺分类,首次导入会在源目录自动生成 <code>front-category-mapping.txt</code> 模板。
                编辑后再次导入可在这里附带它。
              </div>
            </div>

          </div>
          <div class="qnh-fm-foot">
            <span class="qnh-fm-foot__hint" data-id="foot-hint">请选择导入源目录</span>
            <button class="qnh-fm-action" data-act="cancel">取消</button>
            <button class="qnh-fm-action primary" data-act="ok" disabled>开始导入</button>
          </div>
        </div>
      </div>
    `);

    const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
      root.querySelector(sel) as T | null;
    const dirNameEl = $<HTMLInputElement>('[data-id="dir-name"]')!;
    const dirStatus = $('[data-id="dir-status"]')!;
    const syncImages = $<HTMLInputElement>('[data-id="sync-images"]')!;
    const mappingName = $<HTMLInputElement>('[data-id="mapping-name"]')!;
    const clearMappingBtn = $<HTMLButtonElement>('[data-act="clear-mapping"]')!;
    const footHint = $('[data-id="foot-hint"]')!;
    const okBtn = $<HTMLButtonElement>('[data-act="ok"]')!;

    let dirHandle: FileSystemDirectoryHandle | null = null;
    let dirOk = false;
    let mappingFile: File | null = null;

    const dispose = (result: ImportFormResult | null) => {
      host.remove();
      resolve(result);
    };

    root.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const act = target.closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act === 'cancel') dispose(null);
    });
    root.querySelector('.qnh-fm-mask')?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).classList.contains('qnh-fm-mask')) dispose(null);
    });

    /* ---- 选目录 ---- */
    root.querySelector('[data-act="pick-dir"]')?.addEventListener('click', async () => {
      try {
        const dir = await pickDirectory({ id: 'qnh-import-dir', mode: 'readwrite' });
        dirHandle = dir;
        dirNameEl.value = dir.name;
        dirStatus.style.display = '';
        dirStatus.classList.remove('warn', 'err');
        dirStatus.textContent = '校验目录…';
        const manifest = await readManifestIfComplete(dir);
        if (!manifest) {
          dirOk = false;
          dirStatus.classList.add('err');
          dirStatus.textContent =
            '所选目录里找不到 manifest.json,可能不是导出目录或上次导出未完成。';
        } else {
          dirOk = true;
          dirStatus.classList.remove('err');
          const m = manifest as {
            productCount?: number;
            mediaCount?: number;
            source?: { shopName?: string };
          };
          dirStatus.textContent =
            `导出包就绪 · ${m.source?.shopName ?? '?'} · ${m.productCount ?? '?'} 个商品 · ${m.mediaCount ?? '?'} 个媒体`;
        }
        updateFoot();
      } catch (e) {
        if ((e as DOMException)?.name === 'AbortError') return;
        dirStatus.style.display = '';
        dirStatus.classList.add('err');
        dirStatus.textContent = `选择目录失败:${(e as Error).message}`;
      }
    });

    /* ---- 选映射文件 ---- */
    root.querySelector('[data-act="pick-mapping"]')?.addEventListener('click', () => {
      pickMappingFile().then((f) => {
        if (!f) return;
        mappingFile = f;
        mappingName.value = f.name;
        clearMappingBtn.style.display = '';
      });
    });
    root.querySelector('[data-act="clear-mapping"]')?.addEventListener('click', () => {
      mappingFile = null;
      mappingName.value = '';
      clearMappingBtn.style.display = 'none';
    });

    /* ---- 表单状态 ---- */
    function updateFoot() {
      okBtn.disabled = !dirOk;
      footHint.classList.remove('err');
      if (!dirHandle) {
        footHint.textContent = '请选择导入源目录';
      } else if (!dirOk) {
        footHint.classList.add('err');
        footHint.textContent = '所选目录不是有效的导出包';
      } else {
        const parts: string[] = [];
        const mode = (root.querySelector<HTMLInputElement>('input[name="qnh-mode"]:checked')?.value ?? 'full');
        const confirm = (root.querySelector<HTMLInputElement>('input[name="qnh-confirm"]:checked')?.value ?? 'auto');
        parts.push(mode === 'full' ? '全量' : '增量');
        parts.push(confirm === 'auto' ? '自动' : '手动');
        parts.push(syncImages.checked ? '同步图片' : '不同步图片');
        if (mappingFile) parts.push('附带映射');
        footHint.textContent = parts.join(' · ');
      }
    }
    root.addEventListener('change', updateFoot);
    syncImages.addEventListener('change', updateFoot);

    /* ---- 提交 ---- */
    root.querySelector('[data-act="ok"]')?.addEventListener('click', () => {
      if (!dirHandle || !dirOk) return;
      const mode = (root.querySelector<HTMLInputElement>('input[name="qnh-mode"]:checked')?.value as 'full' | 'incremental') ?? 'full';
      const confirmMode = (root.querySelector<HTMLInputElement>('input[name="qnh-confirm"]:checked')?.value as 'auto' | 'manual') ?? 'auto';
      dispose({
        sourceDir: dirHandle,
        mode,
        confirmMode,
        syncImages: syncImages.checked,
        frontCategoryMappingFile: mappingFile,
      });
    });
  });
}

/* 弹出系统文件选择器,选一个 .txt / .tsv / .csv 文件,用户取消返回 null */
function pickMappingFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.txt,.tsv,.csv,text/plain';
    input.style.display = 'none';
    let settled = false;
    const finish = (f: File | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(f);
    };
    input.addEventListener('change', () => finish(input.files?.[0] ?? null));
    const onFocus = () => {
      window.removeEventListener('focus', onFocus);
      setTimeout(() => {
        if (!input.files || input.files.length === 0) finish(null);
      }, 300);
    };
    window.addEventListener('focus', onFocus);
    document.body.appendChild(input);
    input.click();
  });
}
