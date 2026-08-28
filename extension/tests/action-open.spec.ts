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

describe('panel-open bridge recovery', () => {
  it('re-injects the content bridge instead of demanding a page refresh', async () => {
    const source = await readFile(join(import.meta.dirname, '..', 'src', 'background', 'index.ts'), 'utf8')
    expect(source).toContain("chrome.scripting.executeScript({ target: { tabId }, files: ['assets/content.js'] })")
    // The probe, the injection, and the retry: the clock must recover in one
    // panel-open without any Bilibili page reload.
    const timeHandler = source.slice(source.indexOf("if (type === 'MOMENTQ_GET_CURRENT_VIDEO_TIME') {"))
    expect(timeHandler).toContain('await ensureTabBridge(active.id)')
    expect(timeHandler.indexOf('readTime')).toBeLessThan(timeHandler.indexOf('await ensureTabBridge'))
    expect(source).toContain('void ensureTabBridge(tabId)')
  })

  it('guards the content entry against double registration on re-injection', async () => {
    const source = await readFile(join(import.meta.dirname, '..', 'src', 'content', 'index.tsx'), 'utf8')
    expect(source).toContain('__momentqContentBridge')
    expect(source).toContain('if (bridge.__momentqContentBridge !== true)')
  })

  it('re-checks a trackless video the moment the panel asks for state', async () => {
    const source = await readFile(join(import.meta.dirname, '..', 'src', 'background', 'index.ts'), 'utf8')
    const fastPath = source.slice(source.indexOf('async function readOrResolveState'))
    expect(fastPath).toContain('void syncBilibiliSubtitle(tabId, stored.context)')
    expect(fastPath).toContain("stored.subtitleSource !== 'asr'")
  })

  it('stays subscribed to a foreign track until Bilibili ships its ai-zh translation', async () => {
    const source = await readFile(join(import.meta.dirname, '..', 'src', 'background', 'index.ts'), 'utf8')
    const sync = source.slice(source.indexOf('async function syncBilibiliSubtitle'))
    // A non-Chinese import must not be marked final: the lazy ai-zh track can
    // still replace it through the throttled retry and reconcile loops.
    expect(sync).toContain('trackNeedsChineseTranslation(report.segments)')
    const reconcile = source.slice(source.indexOf('async function reconcileVideoSubtitles'))
    expect(reconcile).toContain('trackNeedsChineseTranslation(segments)')
  })

  it('drives the player menu to surface the built-in translated track', async () => {
    const source = await readFile(join(import.meta.dirname, '..', 'src', 'content', 'page-bridge.ts'), 'utf8')
    const click = source.slice(source.indexOf('function requestBilibiliSubtitleLoad'))
    expect(click).toContain('[data-lan="ai-zh"]')
    expect(click).toContain('自动翻译')
  })

  it('never drops a failed capture start silently from the panel', async () => {
    const app = await readFile(join(import.meta.dirname, '..', 'src', 'sidepanel', 'App.tsx'), 'utf8')
    const toggle = app.slice(app.indexOf('function toggleTranscription'))
    // When Chrome refuses the panel-obtained stream id the click must still
    // land somewhere visible: the background retries and records the reason.
    expect(toggle).toContain('streamId === null')
    expect(toggle.indexOf('streamId === null')).toBeLessThan(toggle.indexOf("type: 'MOMENTQ_ASR_START_FROM_PANEL'"))
    expect(toggle).toMatch(/streamId === null[\s\S]{0,400}MOMENTQ_TOGGLE_TRANSCRIPTION/)
  })

  it('rebinds part switches that keep a p-less URL', async () => {
    const background = await readFile(join(import.meta.dirname, '..', 'src', 'background', 'index.ts'), 'utf8')
    const handler = background.slice(background.indexOf("if (type === 'MOMENTQ_PAGE_CONTEXT') {"))
    // A changed player cid must re-verify and rebind even when the URL still
    // maps to the same content location; only an identical cid is a no-op.
    expect(handler).toContain('previous.context.identity.cid === incoming.identity.cid')
    expect(handler).toContain('cid: incoming.identity.cid')
    // The player-reported cid wins over the previously resolved identity on a
    // part switch; overriding it snapped every switch back to the first part.
    const bridge = await readFile(join(import.meta.dirname, '..', 'src', 'content', 'page-bridge.ts'), 'utf8')
    expect(bridge).toContain('playerCidDiffers')
  })
})
