import { defineConfig } from 'vite';
export default defineConfig({
  publicDir: 'public-runtime',
  server: {
    port: 5199,
    proxy: {
      '/api': { target: 'http://127.0.0.1:7742', changeOrigin: true },
      '/health': { target: 'http://127.0.0.1:7742', changeOrigin: true },
    },
  },
});
