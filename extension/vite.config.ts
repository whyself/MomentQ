import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, 'public/manifest.json'), 'utf8')) as { version: string }

export default defineConfig({
  plugins: [react()],
  // Baked into the side-panel bundle: comparing it against the running
  // background's manifest version exposes a panel document that survived an
  // extension reload and is still executing stale code.
  define: {
    __MOMENTQ_BUILD_VERSION__: JSON.stringify(manifest.version),
  },
  resolve: {
    alias: {
      '@deepseek-ai/dsh-client-ui-primitives': resolve(import.meta.dirname, 'src/dsh/primitives.ts'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Vite emits <link rel="modulepreload"> for lazy chunks; in the
    // extension page world Chrome rejects them ("cross-world extension
    // resource mismatch"), which surfaces as errors on the extensions
    // page. Disable emission entirely.
    modulePreload: false,
    rollupOptions: {
      input: {
        sidepanel: resolve(import.meta.dirname, 'sidepanel.html'),
        background: resolve(import.meta.dirname, 'src/background/index.ts'),
        offscreen: resolve(import.meta.dirname, 'src/offscreen/index.ts'),
      },
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
})
