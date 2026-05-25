// 把 dist 打成可上架/分发的 zip
import { mkdirSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let JSZip;
try {
  JSZip = require('jszip');
} catch {
  console.error('请先安装 jszip 依赖: npm i');
  process.exit(1);
}

const root = resolve(process.cwd());
const dist = resolve(root, 'dist');
const out = resolve(root, 'dist-zip');
if (!existsSync(dist)) {
  console.error('dist 不存在,请先 npm run build');
  process.exit(1);
}
if (!existsSync(out)) mkdirSync(out, { recursive: true });

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8'));
const zip = new JSZip();

const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p);
    else zip.file(relative(dist, p).split('\\').join('/'), readFileSync(p));
  }
};
walk(dist);

const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
const file = resolve(out, `${pkg.name}-${pkg.version}.zip`);
writeFileSync(file, buf);
console.log('已生成', file);
