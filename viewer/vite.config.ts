import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  root: import.meta.dirname,
  plugins: [vue()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:7317',
      '/events': 'http://127.0.0.1:7317',
      '/status': 'http://127.0.0.1:7317',
    },
  },
})
