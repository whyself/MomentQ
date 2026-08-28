import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const expectedCommit = 'b150a551b8d465e31e418e1b2eaf5e79bbb7d28e'
const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const extensionRoot = resolve(scriptDirectory, '..')
const vendorRoot = resolve(extensionRoot, 'src', 'vendor', 'deepseek-harness')
const allowedVendorParent = resolve(extensionRoot, 'src', 'vendor')
const sourceRoot = resolve(process.argv[2] ?? process.env.DSH_SOURCE_ROOT ?? '')

if (process.argv[2] === undefined && process.env.DSH_SOURCE_ROOT === undefined) {
  throw new Error('Pass the pinned deepseek-harness checkout path as the first argument')
}
if (!vendorRoot.startsWith(`${allowedVendorParent}${sep}`)) {
  throw new Error('Refusing to write outside extension/src/vendor')
}

const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: sourceRoot,
  encoding: 'utf8',
}).trim()
if (commit !== expectedCommit) {
  throw new Error(`Expected deepseek-harness ${expectedCommit}, received ${commit}`)
}

const selections = [
  'packages/client/ui-layout/src',
  'packages/client/ui-primitives/src',
  'packages/client/ui-theme/src',
  'packages/client/ui-conversation/src',
  'packages/client/ui-settings-general/src',
]

await rm(vendorRoot, { recursive: true, force: true })
await mkdir(vendorRoot, { recursive: true })
for (const selection of selections) {
  await cp(join(sourceRoot, selection), join(vendorRoot, selection), {
    recursive: true,
    force: true,
  })
}
await cp(join(sourceRoot, 'LICENSE'), join(vendorRoot, 'LICENSE'), { force: true })

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await listFiles(path))
    else files.push(path)
  }
  return files
}

const hashes = {}
for (const file of (await listFiles(vendorRoot)).sort()) {
  const path = relative(vendorRoot, file).replaceAll('\\', '/')
  if (path === 'manifest.json') continue
  const contents = await readFile(file)
  hashes[path] = createHash('sha256').update(contents).digest('hex')
}

await writeFile(join(vendorRoot, 'manifest.json'), `${JSON.stringify({
  repository: 'https://github.com/deepseek-ai/deepseek-harness.git',
  commit,
  selections,
  hashes,
}, null, 2)}\n`)
