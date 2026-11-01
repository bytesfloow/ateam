import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../shared'),
    },
  },
  server: {
    host: '127.0.0.1',
    // A-Team 专属端口段（避开 CloudNine 3000/5173）；strictPort：被占直接报错而非静默漂移
    port: 5310,
    strictPort: true,
    fs: {
      allow: [path.resolve(__dirname, '..')],
    },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3310',
        changeOrigin: false,
        timeout: 0,
        proxyTimeout: 0,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
});
