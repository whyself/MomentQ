import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  // React's browser build still references process.env.NODE_ENV. Content
  // scripts run in an isolated world without a Node `process` global, so
  // replace it at build time instead of letting the bundle crash on startup.
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'process.env': '{}',
  },
  resolve: {
    alias: {
      '@deepseek-ai/dsh-client-ui-primitives': resolve(import.meta.dirname, 'src/dsh/primitives.ts'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: resolve(import.meta.dirname, 'src/content/index.tsx'),
      formats: ['iife'],
      name: 'MomentQContent',
      fileName: () => 'assets/content.js',
    },
  },
})
