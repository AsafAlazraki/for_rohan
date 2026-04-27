import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, the Vite server proxies API + webhook + SSE traffic to the Node
// service on :3000. In production, Express serves the built assets directly.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api':     { target: 'http://localhost:3000', changeOrigin: true, ws: false },
      '/webhook': { target: 'http://localhost:3000', changeOrigin: true },
      '/health':  { target: 'http://localhost:3000', changeOrigin: true },
      '/ready':   { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
