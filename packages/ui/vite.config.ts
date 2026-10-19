import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { MODEL_FILES, ORT_FILES } from './scripts/reflex-assets.mjs';

/** 旧 public 缓存可保留在磁盘上，但不再把无关 ORT 后端复制进安装产物。 */
function publicAssets(): Plugin {
  let publicDir: string;
  return {
    name: 'easycode-public-assets',
    apply: 'build',
    configResolved(config) { publicDir = config.publicDir; },
    generateBundle() {
      const emit = (file: string) => {
        const source = path.join(publicDir, file);
        if (!fs.existsSync(source)) {
          if (file.startsWith('ort/')) this.error(`Missing ORT asset: ${file}`);
          this.warn(`Optional Reflex model asset missing: ${file}`);
          return;
        }
        this.emitFile({ type: 'asset', fileName: file, source: fs.readFileSync(source) });
      };
      // 保留其它 public 资源的标准相对路径；只筛选已审查的模型/运行时目录。
      const walk = (relative: string) => {
        const dir = path.join(publicDir, relative);
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const file = relative ? `${relative}/${entry.name}` : entry.name;
          if (file === 'ort' || file === 'models/reflex') continue;
          if (entry.isDirectory()) walk(file);
          else if (entry.isFile()) emit(file);
        }
      };
      walk('');
      for (const file of MODEL_FILES) emit(`models/reflex/${file}`);
      for (const file of ORT_FILES) emit(`ort/${file}`);
    },
  };
}

export default defineConfig({
  plugins: [react(), publicAssets()],
  // ORT 按 wasmPaths 从本地 ort/ 加载，不再额外打包不可达的 WASM 副本。
  resolve: { conditions: ['onnxruntime-web-use-extern-wasm'] },
  // Electron 以 file:// 加载产物，必须用相对资源路径
  base: './',
  server: { port: 5183 },
  build: { outDir: 'dist', copyPublicDir: false, chunkSizeWarningLimit: 800 },
});
