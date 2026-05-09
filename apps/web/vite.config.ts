import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  build: {
    /**
     * Manual chunk strategy. Default Vite output produces one ~325KB
     * `index.js` that the browser fully parses on first paint AND
     * re-fetches whenever ANY package version changes. Splitting
     * the heaviest stable vendors into named chunks improves:
     *   - Cache hit rate across deploys (a Rose code change no
     *     longer invalidates the React vendor chunk).
     *   - Parallel HTTP/2 downloads of react + query + the shell.
     *   - Smaller per-chunk parse cost so the main thread frees
     *     up sooner.
     *
     * Keep the chunk count modest — past ~5 the fixed per-request
     * overhead starts to dominate the gains.
     */
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          'query-vendor': ['@tanstack/react-query'],
          'icons-vendor': ['lucide-react'],
        },
      },
    },
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_API_URL ?? 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
});
