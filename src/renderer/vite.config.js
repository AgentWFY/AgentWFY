import { defineConfig } from 'vite'
import path from 'path'

// https://vitejs.dev/config/
export default defineConfig({
  define: {
    'process.env': '{}',
    'process.versions': '{}',
  },
  resolve: {
    alias: [
      {
        find: /^@mariozechner\/pi-ai$/,
        replacement: path.resolve(__dirname, './src/agent/pi_ai_browser.ts')
      },
      {
        find: 'app',
        replacement: path.resolve(__dirname, './src')
      }
    ]
  },
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
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
    watch: {
      usePolling: true,
    },
  },
  optimizeDeps: {
  }
})
