import crx3 from 'crx3';
import { resolve } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

const distDir = resolve('dist');
const outDir = resolve('dist-crx');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const crxFile = resolve(outDir, 'qnh-assistant.crx');
const keyFile = resolve(outDir, 'qnh-assistant.pem');

await crx3([distDir], {
  crxPath: crxFile,
  keyPath: keyFile,
});

console.log(`CRX 已生成: ${crxFile}`);
