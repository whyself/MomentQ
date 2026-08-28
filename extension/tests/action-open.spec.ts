import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('toolbar side-panel opening', () => {
  it('opens from the toolbar user gesture without requiring Bilibili state', async () => {
    const source = await readFile(join(import.meta.dirname, '..', 'src', 'background', 'index.ts'), 'utf8')
    expect(source).toContain("chrome.sidePanel.setOptions({ path: 'sidepanel.html', enabled: true })")
    expect(source).toContain('chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })')
    expect(source).not.toContain('setOptions({ enabled: false })')
    expect(source).not.toContain('next !== null)')
  })

  it('opens the keyboard shortcut without requiring a parsed content identity', async () => {
    const source = await readFile(join(import.meta.dirname, '..', 'src', 'background', 'index.ts'), 'utf8')
    const commandHandler = source.slice(source.indexOf('chrome.commands.onCommand'))
    expect(commandHandler).toContain('chrome.sidePanel.open({ tabId })')
    expect(commandHandler).not.toContain('readState(tabId)')
  })

  it('resolves a missing VOD state when the opened side panel queries its tab', async () => {
    const source = await readFile(join(import.meta.dirname, '..', 'src', 'background', 'index.ts'), 'utf8')
    expect(source).toContain('readOrResolveState(tabId)')
    expect(source).toContain('resolveCurrentVodContext(url')
    expect(source).toContain('resolveSnapshotViaBilibiliApi({ url: currentUrl })')
  })

  it('keeps network resolution outside the per-tab operation queue', async () => {
    const source = await readFile(join(import.meta.dirname, '..', 'src', 'background', 'index.ts'), 'utf8')
    // A stalled request inside the queue used to freeze the tab on its
    // previous video until restart; only fast local state work may be queued.
    const queueBody = source.slice(source.indexOf('async function applyContextUnlocked'))
    expect(queueBody).toContain('void syncBilibiliSubtitle(tabId, context)')
    expect(queueBody).not.toMatch(/tabOperations\.run\([^)]*\)[\s\S]{0,400}?await (?:client|fetch)/)
  })
})
