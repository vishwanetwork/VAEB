import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:13002',
        changeOrigin: true,
        timeout: 120000, // 2 min — bridge + LLM calls can be slow
      },
    },
  },
});
