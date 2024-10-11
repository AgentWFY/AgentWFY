import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import path from 'path';

// https://vitejs.dev/config
export default defineConfig({
  plugins: [
    viteStaticCopy({
      targets: [
        {
          src: path.resolve(__dirname, 'tmp', 'server', 'dist'),
          dest: path.resolve(__dirname, 'dist', 'main', 'server'),
        },
        {
          src: path.resolve(__dirname, 'tmp', 'client', 'dist'),
          dest: path.resolve(__dirname, 'dist', 'main', 'client'),
        },
      ],
    }),
  ],
});
