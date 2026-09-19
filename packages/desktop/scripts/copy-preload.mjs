// 复制 preload.cjs 到 dist（tsc 不处理 .cjs）
import { copyFileSync, mkdirSync } from 'node:fs';

mkdirSync(new URL('../dist/', import.meta.url), { recursive: true });
copyFileSync(
  new URL('../src/preload.cjs', import.meta.url),
  new URL('../dist/preload.cjs', import.meta.url),
);
console.log('preload.cjs → dist ✓');
