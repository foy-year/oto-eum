import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['mediabunny'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  test: { environment: 'node', include: ['tests/**/*.test.ts', 'server/**/*.test.ts'] },
} as never);
