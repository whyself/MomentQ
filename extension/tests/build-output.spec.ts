import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const dist = join(import.meta.dirname, '..', 'dist')

describe('loadable MV3 output', () => {
  it('keeps content and page bridge as self-contained classic scripts', async () => {
    for (const name of ['content.js', 'page-bridge.js']) {
      const source = await readFile(join(dist, 'assets', name), 'utf8')
      expect(source, name).not.toMatch(/(?:^|[;}])\s*import\s*(?:\(|[{'"*])/m)
      expect(source, name).not.toMatch(/(?:^|[;}])\s*export\s/m)
    }
  })

  it('keeps the content script UTF-8 and avoids bundling the side-panel markdown stack', async () => {
    const bytes = await readFile(join(dist, 'assets', 'content.js'))
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(bytes)).not.toThrow()
    // Content scripts only mount the page transcription control; pulling the
    // side-panel Markdown/Shiki graph here can make Chromium reject the file.
    expect(bytes.byteLength).toBeLessThan(1_000_000)
  })

  it('does not leave an unreferenced shared entry dependency', async () => {
    const files = await readdir(join(dist, 'assets'))
    expect(files.filter(name => name.startsWith('page-snapshot-'))).toEqual([])
  })
})
