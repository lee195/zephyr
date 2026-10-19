import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  root: import.meta.dirname,
  plugins: [vue()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    // src/server.ts accepts mutating requests from this origin only at this port.
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:7317',
      '/events': 'http://127.0.0.1:7317',
      '/status': 'http://127.0.0.1:7317',
    },
  },
})
