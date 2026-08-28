import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const extensionRoot = join(import.meta.dirname, '..')

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'prototype'
      || (directory === extensionRoot && ['scripts', 'tests'].includes(entry.name))
      || (directory === join(extensionRoot, 'src') && entry.name === 'vendor')) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await sourceFiles(path))
    else if (/\.(?:ts|tsx|js|jsx)$/.test(entry.name)) files.push(path)
  }
  return files
}

describe('standalone extension architecture', () => {
  it('vendors the pinned DSH settings surface used by the standalone UI', async () => {
    const vendorRoot = join(extensionRoot, 'src', 'vendor', 'deepseek-harness')
    const manifest = JSON.parse(await readFile(join(vendorRoot, 'manifest.json'), 'utf8')) as {
      selections: string[]
    }
    expect(manifest.selections).toContain('packages/client/ui-settings-general/src')
  })

  it('pins the exact DSH source baseline', async () => {
    const contract = await readFile(join(extensionRoot, 'UPSTREAM.md'), 'utf8')
    expect(contract).toContain('b150a551b8d465e31e418e1b2eaf5e79bbb7d28e')
    expect(contract).toContain('hand-redrawn replacements')
  })

  it('does not turn the browser frontend into a DSH UI plugin', async () => {
    const files = await sourceFiles(extensionRoot)
    const violations: string[] = []
    for (const file of files) {
      if (file === import.meta.filename) continue
      const source = await readFile(file, 'utf8')
      if (/ctx\.slots\.register\s*\(/.test(source)
        || /@deepseek-ai\/dsh-client-ui-(?:layout|sidebar|conversation)\/(?:client|invariant)/.test(source)) {
        violations.push(relative(extensionRoot, file))
      }
    }
    expect(violations).toEqual([])
  })

  it('keeps every vendored DSH source file byte-identical to its manifest', async () => {
    const vendorRoot = join(extensionRoot, 'src', 'vendor', 'deepseek-harness')
    const manifest = JSON.parse(await readFile(join(vendorRoot, 'manifest.json'), 'utf8')) as {
      commit: string
      hashes: Record<string, string>
    }
    expect(manifest.commit).toBe('b150a551b8d465e31e418e1b2eaf5e79bbb7d28e')
    for (const [path, expected] of Object.entries(manifest.hashes)) {
      const actual = createHash('sha256').update(await readFile(join(vendorRoot, path))).digest('hex')
      expect(actual, path).toBe(expected)
    }
  })

  it('reuses the shared subtitle parsers in the MAIN-world page bridge', async () => {
    const source = await readFile(join(extensionRoot, 'src', 'content', 'page-bridge.ts'), 'utf8')
    // The parsers must exist once; the bridge imports them instead of keeping
    // a second drifting copy inside its isolation closure.
    expect(source).toContain("from '../shared/bilibili-subtitle'")
    expect(source).not.toMatch(/\bfunction\s+(?:parseSubtitleIndex|subtitleTracks|normalizeSubtitleBody)\b/)
  })
})
