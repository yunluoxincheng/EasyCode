import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Electron 以 file:// 加载产物，必须用相对资源路径
  base: './',
  server: { port: 5183 },
  build: { outDir: 'dist', chunkSizeWarningLimit: 800 },
});
