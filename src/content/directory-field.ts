import { directoryPermission, ensurePermission, pickDirectory, MANIFEST_FILE, PROGRESS_FILE } from './fs-stage';
import { loadWorkspaceRoot, saveWorkspaceRoot } from './recent-directory';

type Directory = FileSystemDirectoryHandle;
type MovableDirectory = Directory & { move?: (name: string) => Promise<void> };
type DirectoryTask = 'export' | 'import' | 'sync';

export const directoryMarkup = (label: string) => `
  <section aria-label="${label}">
    <div class="drop">
      <div class="root-location"><span>主目录</span><strong data-dir-name>选择或拖入文件夹</strong></div>
      <div class="directory-actions">
        <button type="button" data-reconnect hidden>重新授权</button>
        <button type="button" data-browse>选择主目录</button>
      </div>
    </div>
    <div class="folder-browser" data-folders hidden>
      <div class="folder-toolbar"><h3>项目</h3>
        <button type="button" data-add>＋ 新增</button>
      </div>
      <div class="folder-list" aria-label="项目列表" data-list></div>
      <div class="folder-create" data-create-row hidden>
        <p data-edit-hint></p>
        <input type="text" aria-label="项目名称" placeholder="输入项目名称" maxlength="255" data-folder-name>
        <button type="button" data-create>新建</button>
        <button type="button" data-edit-cancel>取消</button>
      </div>
    </div>
    <p class="folder-feedback" role="status" data-feedback hidden></p>
    <div class="status" role="status" data-dir-status></div>
    <div data-dir-extra></div>
  </section>`;

async function droppedDirectory(items: DataTransferItemList | undefined) {
  const files = Array.from(items ?? []).filter(item => item.kind === 'file');
  if (files.length !== 1) throw new Error('请一次拖入一个主目录。');
  const item = files[0] as DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> };
  const handle = await item.getAsFileSystemHandle?.();
  if (handle?.kind !== 'directory') throw new Error('请拖入文件夹，或点击“选择主目录”。');
  return handle as Directory;
}

async function readLevel(dir: Directory) {
  const children: Directory[] = [];
  let manifest = false;
  let progress = false;
  const iterable = dir as Directory & { values(): AsyncIterable<FileSystemHandle> };
  for await (const entry of iterable.values()) {
    if (entry.kind === 'directory') children.push(entry as Directory);
    else if (entry.name === MANIFEST_FILE) manifest = true;
    else if (entry.name === PROGRESS_FILE) progress = true;
  }
  const visible = manifest || progress
    ? children.filter(child => child.name !== 'products' && child.name !== 'media') : children;
  return { children: visible.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true })), manifest, progress };
}

function validateName(name: string) {
  if (!name || name !== name.trim() || /[. ]$/.test(name) || /[<>:"/\\|?*\u0000-\u001f]/.test(name) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)) {
    throw new Error('请输入有效的文件夹名称，避免路径分隔符、末尾空格或句点。');
  }
}

export function bindDirectory<T>(
  root: ShadowRoot,
  task: DirectoryTask,
  inspect: (dir: Directory) => Promise<T>,
  onChange: () => void,
) {
  const element = <E extends HTMLElement>(selector: string) => root.querySelector<E>(selector)!;
  const zone = element('.drop');
  const name = element('[data-dir-name]');
  const status = element('[data-dir-status]');
  const feedback = element('[data-feedback]');
  const browse = element<HTMLButtonElement>('[data-browse]');
  const reconnect = element<HTMLButtonElement>('[data-reconnect]');
  const browser = element('[data-folders]');
  const list = element('[data-list]');
  const newName = element<HTMLInputElement>('[data-folder-name]');
  const create = element<HTMLButtonElement>('[data-create]');
  const editor = element('[data-create-row]');
  const editHint = element('[data-edit-hint]');
  let renaming: MovableDirectory | undefined;
  let systemRename = false;
  let siblings: Directory[] = [];
  const exporting = task === 'export';
  const mode = task === 'sync' ? 'read' : 'readwrite';
  let main: Directory | undefined;
  let selected: { dir: Directory; info: T } | null = null;
  let busy = false;
  let packageLevel = false;
  let waitingForPermission = false;
  let saveRoot = false;

  function message(text: string, tone = '') {
    if (status.textContent !== text) status.textContent = text;
    status.dataset.tone = tone;
  }

  function notice(text = '') {
    feedback.textContent = text;
    feedback.hidden = !text;
  }

  function requirePermission() {
    selected = null;
    waitingForPermission = true;
    browser.hidden = true;
    reconnect.hidden = false;
    message('主目录权限已失效，重新授权后可继续使用其中的文件夹。', 'warn');
  }

  // 一次只执行一个目录操作，防止双击创建或旧目录的结果覆盖刚选的目录。
  async function run(action: () => Promise<void> | void) {
    if (busy || !root.host.isConnected) return;
    busy = true;
    browse.disabled = reconnect.disabled = newName.disabled = browser.inert = true;
    onChange();
    notice();
    try {
      await action();
    } catch (err) {
      const error = err as Error;
      if (error.name === 'NotAllowedError' && main && await directoryPermission(main, mode).catch(() => 'denied') !== 'granted') {
        requirePermission();
      } else if (error.name !== 'AbortError') {
        notice(error.name === 'NotFoundError' ? '文件夹已移动或删除，请重新打开项目列表。' : error.message);
      }
    } finally {
      busy = false;
      browse.disabled = reconnect.disabled = newName.disabled = browser.inert = false;
      onChange();
    }
  }

  function folderButton(label: string, action: () => Promise<void> | void) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.setAttribute('aria-label', label);
    button.addEventListener('click', () => void run(action));
    return button;
  }

  function closeEditor() {
    editor.hidden = true;
    renaming = undefined;
    systemRename = false;
    newName.value = '';
  }

  function renderEditor() {
    newName.hidden = systemRename;
    create.textContent = systemRename ? '打开文件夹窗口' : renaming ? '保存名称' : '新建';
    editHint.textContent = systemRename ? `在窗口中选中「${renaming!.name}」，按 F2 改名，再选择改名后的文件夹。`
      : renaming ? `重命名「${renaming.name}」` : '新增项目';
    create.disabled = !systemRename && !newName.value.trim();
    editor.hidden = false;
    requestAnimationFrame(() => { if (!editor.hidden) (systemRename ? create : newName).focus(); });
  }

  function edit(folder?: MovableDirectory) {
    closeEditor();
    renaming = folder;
    if (folder) {
      systemRename = typeof folder.move !== 'function';
      newName.value = folder.name;
    }
    renderEditor();
  }

  async function choose(dir: Directory) {
    selected = null;
    message('');
    const buttons = list.querySelectorAll<HTMLButtonElement>('.folder-select');
    for (const button of buttons) button.setAttribute('aria-pressed', 'false');
    const info = await inspect(dir);
    if (!root.host.isConnected) return;
    selected = { dir, info };
    for (const button of buttons) {
      if (button.textContent === dir.name) button.setAttribute('aria-pressed', 'true');
    }
  }

  async function showProjects(dir: Directory, preferredName?: string) {
    selected = null;
    message('');
    const level = await readLevel(dir);
    if (!root.host.isConnected) return;
    siblings = level.children;
    packageLevel = level.manifest || level.progress;
    closeEditor();
    browser.hidden = false;
    list.replaceChildren(...siblings.map(folder => {
      const row = document.createElement('div');
      row.className = 'folder-row';
      const select = folderButton(folder.name, async () => {
        closeEditor();
        await choose(folder);
      });
      select.className = 'folder-select';
      select.setAttribute('aria-pressed', 'false');
      const rename = folderButton('重命名', () => edit(folder));
      rename.setAttribute('aria-label', `重命名 ${folder.name}`);
      row.append(select, rename);
      return row;
    }));
    if (!siblings.length) list.textContent = '暂无项目';
    const preferred = siblings.find(folder => folder.name === preferredName);
    if (preferred) await choose(preferred);
    else message(exporting ? '选择或新增一个项目用于导出。' : '请选择已完成导出的项目。');
  }

  async function openMain(dir: Directory, source: 'choose' | 'restore' | 'reconnect') {
    if (!root.host.isConnected) return;
    main = dir;
    selected = null;
    browser.hidden = true;
    reconnect.hidden = true;
    waitingForPermission = false;
    message('');
    name.textContent = dir.name;
    name.title = dir.name;
    zone.classList.add('configured');
    browse.textContent = '更改';
    if (source === 'choose') saveRoot = true;
    const access = source === 'choose' ? 'readwrite' : mode;
    if (source === 'restore' && await directoryPermission(dir, access) !== 'granted') {
      requirePermission();
      return;
    }
    if (source !== 'restore') {
      try {
        await ensurePermission(dir, saveRoot ? 'readwrite' : access);
      } catch (err) {
        requirePermission();
        throw err;
      }
    }
    if (saveRoot) {
      if (!await saveWorkspaceRoot(dir)) notice('当前仅能在本标签页记住主目录。');
      saveRoot = false;
    }
    await showProjects(dir);
  }

  browse.onclick = () => void run(async () => {
    const dir = await pickDirectory({ id: 'qnh-workspace', mode: 'readwrite' });
    await openMain(dir, 'choose');
  });
  reconnect.onclick = () => void run(async () => { if (main) await openMain(main, 'reconnect'); });
  zone.ondragover = event => { event.preventDefault(); zone.classList.add('dragging'); };
  zone.ondragleave = event => {
    if (!zone.contains(event.relatedTarget as Node | null)) zone.classList.remove('dragging');
  };
  zone.ondrop = event => {
    event.preventDefault();
    event.stopPropagation();
    zone.classList.remove('dragging');
    void run(async () => openMain(await droppedDirectory(event.dataTransfer?.items), 'choose'));
  };
  element('[data-add]').onclick = () => void run(() => edit());
  element('[data-edit-cancel]').onclick = () => { closeEditor(); notice(); onChange(); };
  newName.oninput = () => {
    create.disabled = !newName.value;
    notice();
    if (newName.value) message('');
  };
  newName.onkeydown = event => {
    if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); create.click(); }
  };
  create.onclick = () => void run(async () => {
    const parent = main;
    if (!parent) throw new Error('请先选择主目录。');
    const oldName = renaming?.name;
    const previous = selected?.dir;
    const childName = newName.value;
    let child: Directory;
    if (systemRename) {
      try {
        const picked = await pickDirectory({ startIn: parent, mode: 'read' });
        const relative = await parent.resolve(picked);
        const after = await readLevel(parent);
        if (relative?.length !== 1 || siblings.some(folder => folder.name === picked.name) ||
            after.children.some(folder => folder.name === oldName) ||
            !after.children.some(folder => folder.name === picked.name)) {
          throw new Error('请从当前目录选择改名后的子目录。');
        }
        child = await parent.getDirectoryHandle(picked.name);
      } catch (err) {
        // 在系统窗口中完成改名后再点取消，磁盘也可能已经发生变化。
        await showProjects(parent, previous?.name);
        throw err;
      }
    } else {
      validateName(childName);
      if (childName === oldName) { closeEditor(); return; }
      await ensurePermission(parent, 'readwrite');
      if (packageLevel && ['products', 'media'].includes(childName.toLowerCase())) throw new Error('此名称用于导出数据，请换一个名称。');
      try {
        await parent.getDirectoryHandle(childName);
        throw new Error('此子目录已存在，请使用其他名称。');
      } catch (err) {
        if ((err as Error).name === 'TypeMismatchError') throw new Error('此名称已被文件占用。');
        if ((err as Error).name !== 'NotFoundError') throw err;
      }
      if (renaming?.move) {
        try { await renaming.move(childName); } catch (err) {
          if (!['NotSupportedError', 'NotImplementedError', 'InvalidStateError', 'SecurityError', 'NotAllowedError'].includes((err as Error).name)) throw err;
          systemRename = true;
          renderEditor();
          return;
        }
      }
      child = await parent.getDirectoryHandle(childName, { create: !renaming });
    }
    let preferred = previous;
    if (oldName ? previous?.name === oldName : exporting) preferred = child;
    await showProjects(parent, preferred?.name);
    notice(oldName ? `已重命名为「${child.name}」。` : `已新增「${child.name}」。`);
  });

  // 等宿主表单完成初始化，恢复时只查询授权状态。
  queueMicrotask(() => void run(async () => {
    const dir = await loadWorkspaceRoot();
    if (dir) await openMain(dir, 'restore');
  }));

  return {
    get selection() { return busy || !editor.hidden ? null : selected; },
    get hint() {
      if (waitingForPermission) return '请重新授权主目录';
      if (!editor.hidden) return renaming ? '正在重命名目录' : '正在新增子目录';
      return main ? '请选择项目' : '请选择主目录';
    },
    message,
    async authorize() {
      if (!main || !selected) throw new Error('请选择任务目录。');
      await ensurePermission(main, mode);
      const relative = await main.resolve(selected.dir);
      if (relative?.length !== 1) throw new Error('项目已移动，请重新选择。');
    },
  };
}
