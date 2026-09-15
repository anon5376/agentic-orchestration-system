import { defineConfig } from 'vite';

export default defineConfig(() => {
  const apiTarget = process.env.AOS_API_TARGET || 'http://127.0.0.1:7740';
  return {
    publicDir: 'public-runtime',
    server: {
      port: 5173,
      proxy: {
        '/api': { target: apiTarget, changeOrigin: true },
        '/health': { target: apiTarget, changeOrigin: true },
      },
    },
  };
});
