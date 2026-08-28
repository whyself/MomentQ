import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

interface Manifest {
  manifest_version: number
  permissions: string[]
  host_permissions: string[]
  background: { service_worker: string; type: string }
  side_panel: { default_path: string }
  content_scripts: Array<{ matches: string[]; js: string[]; world?: string }>
  commands: Record<string, { suggested_key?: { default?: string } }>
}

describe('extension manifest', () => {
  it('declares the standalone MV3 side-panel entries', async () => {
    const path = join(import.meta.dirname, '..', 'public', 'manifest.json')
    const manifest = JSON.parse(await readFile(path, 'utf8')) as Manifest

    expect(manifest.manifest_version).toBe(3)
    expect(manifest.background).toEqual({ service_worker: 'assets/background.js', type: 'module' })
    expect(manifest.side_panel.default_path).toBe('sidepanel.html')
    expect(manifest.permissions).toEqual(expect.arrayContaining(['tabCapture', 'offscreen', 'scripting']))
    expect(manifest.host_permissions).toContain('https://api.bilibili.com/*')
    expect(manifest.host_permissions).toContain('https://*.hdslb.com/*')
    expect(manifest.commands['open-side-panel']?.suggested_key?.default).toBe('Alt+Q')

    const pageBridge = manifest.content_scripts.find(script => script.world === 'MAIN')
    const isolated = manifest.content_scripts.find(script => script.world !== 'MAIN')
    expect(pageBridge?.js).toEqual(['assets/page-bridge.js'])
    expect(isolated?.js).toEqual(['assets/content.js'])
    for (const script of [pageBridge, isolated]) {
      expect(script?.matches).toEqual([
        'https://www.bilibili.com/*',
        'https://live.bilibili.com/*',
      ])
    }
  })

  it('ships the offscreen capture entry points', async () => {
    const publicDir = join(import.meta.dirname, '..', 'public')
    const offscreen = await readFile(join(publicDir, 'offscreen.html'), 'utf8')
    expect(offscreen).toContain('assets/offscreen.js')
    const worklet = await readFile(join(publicDir, 'capture-worklet.js'), 'utf8')
    expect(worklet).toContain("registerProcessor('momentq-capture'")
  })
})
