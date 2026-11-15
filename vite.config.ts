import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  worker: { format: 'es' },
  // onnxruntime-web finds its .wasm via import.meta.url: keep it un-prebundled
  optimizeDeps: { exclude: ['mediabunny', 'onnxruntime-web'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  // cross-origin isolation → SharedArrayBuffer → multi-threaded WebAssembly (faster neural separation)
  server: { headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } },
  preview: { headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } },
  test: { environment: 'node', include: ['tests/**/*.test.ts', 'server/**/*.test.ts'] },
} as never);
