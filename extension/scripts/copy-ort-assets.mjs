// Copies the ONNX Runtime WebAssembly artifacts next to the bundled extension
// so the local Whisper engine can load them from the extension origin
// (MV3 pages cannot load remote scripts/wasm glue).
import { cp, mkdir, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', 'public', 'ort')

// transformers' package.json is not exported; resolve via its dist entry,
// then walk to its onnxruntime-web dependency on disk (exports maps block
// direct subpath resolution of the wasm).
const require = createRequire(join(here, '..', 'package.json'))
const transformersDist = dirname(require.resolve('@huggingface/transformers'))
// The wasm subpaths are exports-blocked; the package entry resolves inside
// its dist directory, which is exactly where the artifacts live.
const ortDist = dirname(createRequire(join(transformersDist, 'transformers.js')).resolve('onnxruntime-web'))

await mkdir(outDir, { recursive: true })
const files = (await readdir(ortDist)).filter(file => /^ort-wasm-simd-threaded.*\.(wasm|mjs)$/.test(file))
for (const file of files) {
  await cp(join(ortDist, file), join(outDir, file))
}
console.log(`[copy-ort-assets] ${files.length} artifacts -> public/ort`)
