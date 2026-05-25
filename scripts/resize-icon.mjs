import sharp from 'sharp';
import { resolve } from 'node:path';

const src = resolve('public/icons/ChatGPT Image 2026年5月25日 22_07_57.png');
const sizes = [16, 32, 48, 128];

for (const s of sizes) {
  await sharp(src).resize(s, s).toFile(resolve(`public/icons/icon-${s}.png`));
}
console.log('图标生成完毕');
