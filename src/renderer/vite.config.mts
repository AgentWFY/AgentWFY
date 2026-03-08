import { defineConfig } from 'vite'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// https://vitejs.dev/config/
export default defineConfig({
  define: {
    'process.env': '{}',
    'process.versions': '{}',
  },
  resolve: {
    alias: [
      {
        find: 'app',
        replacement: path.resolve(__dirname, './src')
      }
    ]
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
