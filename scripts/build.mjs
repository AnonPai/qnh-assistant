/**
 * 统一构建脚本
 * - background / content / injected:用 esbuild 打成单文件 IIFE,放 dist/ 根
 * - popup:用 vite 打包,产物放 dist/(popup.html + popup.js + popup.css)
 * - manifest.json 与 icons/ 复制到 dist/
 *
 * 单独建 SW / content / injected 的原因:
 *   Chrome MV3 的 content_scripts 不支持 ES module。
 *   即便 background 设置 "type":"module",也建议保持单文件、零 chunk,加载更稳。
 */

import { build as esbuild, context as esbuildContext } from 'esbuild';
import { build as viteBuild } from 'vite';
import { resolve, dirname } from 'node:path';
import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const dist = resolve(root, 'dist');
const isWatch = process.argv.includes('--watch');
// dev 仅由 --dev 显式开启;watch 不再隐式切到 dev,这样生产模式也能开 watch
const isDev = process.argv.includes('--dev');

const aliasPlugin = {
  name: 'qnh-alias',
  setup(b) {
    const tryResolve = (base) => {
      const candidates = [base, base + '.ts', base + '.tsx', base + '/index.ts', base + '/index.tsx'];
      for (const c of candidates) {
        if (existsSync(c)) return c;
      }
      return base; // 让 esbuild 自己报错
    };
    b.onResolve({ filter: /^@shared\// }, (args) => ({
      path: tryResolve(resolve(root, 'src/shared', args.path.replace(/^@shared\//, ''))),
    }));
    b.onResolve({ filter: /^@\// }, (args) => ({
      path: tryResolve(resolve(root, 'src', args.path.replace(/^@\//, ''))),
    }));
  },
};

/** 打 background / content / injected */
async function buildScripts() {
  const common = {
    bundle: true,
    target: ['chrome120'],
    platform: 'browser',
    format: 'iife',
    loader: { '.css': 'text' },
    sourcemap: isDev ? 'inline' : false,
    minify: !isDev,
    logLevel: 'info',
    plugins: [aliasPlugin],
    define: {
      'process.env.NODE_ENV': isDev ? '"development"' : '"production"',
      __DEV__: isDev ? 'true' : 'false',
    },
  };

  const entries = [
    { in: resolve(root, 'src/background/index.ts'), out: resolve(dist, 'background.js') },
    { in: resolve(root, 'src/content/index.ts'), out: resolve(dist, 'content.js') },
    { in: resolve(root, 'src/injected/index.ts'), out: resolve(dist, 'injected.js') },
  ];

  if (isWatch) {
    for (const e of entries) {
      const ctx = await esbuildContext({
        ...common,
        entryPoints: [e.in],
        outfile: e.out,
      });
      await ctx.watch();
    }
    console.log('[esbuild] 监听中…');
  } else {
    for (const e of entries) {
      await esbuild({ ...common, entryPoints: [e.in], outfile: e.out });
    }
  }
}

/** 打 popup */
async function buildPopup() {
  /**
   * 用一个 vite 插件:
   *  - 在生成 bundle 时,把 src/popup/index.html 这个 emitted asset 改名为 popup.html
   *  - 修正 html 里对 popup.js / popup.css 的引用为 ./
   *
   * 这样 vite 直接输出 dist/popup.html、dist/popup.js、dist/popup.css 到根,
   * 无需 __popup_tmp 后处理,watch 模式也不会有删了又写的竞态。
   */
  const popupRenamePlugin = {
    name: 'qnh-popup-rename',
    writeBundle(opts, bundle) {
      const outDir = opts.dir || dist;
      const nestedHtml = resolve(outDir, 'src/popup/index.html');
      const targetHtml = resolve(outDir, 'popup.html');
      if (!existsSync(nestedHtml)) return;
      // 修正 html 内引用并写到根
      let html = readFileSync(nestedHtml, 'utf-8');
      html = html.replace(/(src|href)="[^"]*?(popup\.(?:js|css))"/g, '$1="./$2"');
      writeFileSync(targetHtml, html);
      // 清理 dist/src
      rmSync(resolve(outDir, 'src'), { recursive: true, force: true });
      void bundle;
    },
  };

  await viteBuild({
    configFile: false,
    root,
    resolve: {
      alias: {
        '@': resolve(root, 'src'),
        '@shared': resolve(root, 'src/shared'),
      },
    },
    define: {
      __DEV__: isDev ? 'true' : 'false',
    },
    plugins: [
      (await import('@vitejs/plugin-react')).default(),
      popupRenamePlugin,
    ],
    build: {
      outDir: dist,
      emptyOutDir: false, // 不要清空 dist,避免删掉 esbuild 已经写好的脚本
      sourcemap: isDev,
      target: 'chrome120',
      minify: !isDev,
      watch: isWatch ? {} : null,
      rollupOptions: {
        input: resolve(root, 'src/popup/index.html'),
        output: {
          entryFileNames: 'popup.js',
          chunkFileNames: 'chunks/popup-[hash].js',
          assetFileNames: (info) => {
            if (info.name?.endsWith('.css')) return 'popup.css';
            return 'assets/[name]-[hash][extname]';
          },
          inlineDynamicImports: true,
        },
      },
    },
  });
}

/** 复制 manifest 与 icons */
function copyAssets() {
  if (!existsSync(dist)) mkdirSync(dist, { recursive: true });
  copyFileSync(resolve(root, 'public/manifest.json'), resolve(dist, 'manifest.json'));
  const iconsSrc = resolve(root, 'public/icons');
  const iconsDst = resolve(dist, 'icons');
  if (existsSync(iconsSrc)) cpSync(iconsSrc, iconsDst, { recursive: true });
}

async function run() {
  if (existsSync(dist)) rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  await buildScripts();
  await buildPopup();
  copyAssets();
  console.log(`\n✅ 构建完成 (${isDev ? 'dev' : 'prod'}),产物在 dist/`);
  if (isWatch) {
    console.log('监听中,改代码会自动重新构建,扩展会自动 reload。');
    // 保持进程不退出
    setInterval(() => {}, 1 << 30);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
