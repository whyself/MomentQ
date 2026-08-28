import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  // The page bridge runs in the MAIN world next to Bilibili's own scripts.
  // The IIFE library build keeps every bundled binding — including the shared
  // subtitle parsers it imports — inside one closure, so minified top-level
  // names can never collide with page globals the way an ES chunk could.
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: resolve(import.meta.dirname, 'src/content/page-bridge.ts'),
      formats: ['iife'],
      name: 'MomentQPageBridge',
      fileName: () => 'assets/page-bridge.js',
    },
  },
})
