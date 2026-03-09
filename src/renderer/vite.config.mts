import { defineConfig } from 'vite'
// https://vitejs.dev/config/
export default defineConfig({
  define: {
    'process.env': '{}',
    'process.versions': '{}',
  },
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            return 'vendor';
          }
        }
      }
    }
  },
  server: {
    hmr: true,
  },
  optimizeDeps: {
  }
})
