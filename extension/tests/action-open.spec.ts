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
    expect(fastPath).toContain('trackNeedsChineseTranslation(stored.subtitleSegments ?? [])')
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

  it('retires zombie recognition states at worker startup', async () => {
    const background = await readFile(join(import.meta.dirname, '..', 'src', 'background', 'index.ts'), 'utf8')
    // Reloading the extension mid-recording destroys the offscreen document,
    // leaving tab states stuck 'active' whose 'asr' provenance then blocked
    // every later subtitle import. The startup sweep retires them; only the
    // tab owning a re-attached live session survives.
    const sweep = background.slice(background.indexOf('async function recoverOrphanedTranscription'))
    expect(sweep).toContain('tabId === asrTabId')
    expect(sweep).toContain("current.transcription === 'inactive'")
    expect(sweep).toContain('await deactivateTranscription(tabId, current)')
    expect(background).toContain('void restoreAsrSession().then(() => { void recoverOrphanedTranscription() })')
    // Ownership is keyed on the live transcription state; the source field is
    // provenance for already-imported finals and must not block imports.
    const pageTracks = background.slice(background.indexOf('async function syncPageSubtitleTracks'))
    expect(pageTracks).not.toContain("state.subtitleSource === 'asr' || state.transcription")
    // A proven-empty probe must not erase ASR finals for a trackless video.
    const sync = background.slice(background.indexOf('async function syncBilibiliSubtitle'))
    expect(sync).toContain('asrFinals')
    // A dead DSH Host must surface in the panel, not vanish silently.
    expect(sync).toContain('同步失败：')
    // Dead-context chrome calls throw synchronously; every send is guarded.
    const content = await readFile(join(import.meta.dirname, '..', 'src', 'content', 'index.tsx'), 'utf8')
    expect(content).toContain('function runtimeSend')
    const guard = content.slice(content.indexOf('function runtimeSend'))
    expect(guard.slice(0, guard.indexOf('}') + 1)).toContain('chrome.runtime.sendMessage')
    // No unguarded sends outside the helper.
    expect(content.slice(content.indexOf('}', content.indexOf('function runtimeSend')) + 1))
      .not.toMatch(/chrome\.runtime\.sendMessage\(/)
  })

  it('waits for the offscreen listener before sending START', async () => {
    const background = await readFile(join(import.meta.dirname, '..', 'src', 'background', 'index.ts'), 'utf8')
    // createDocument resolving does not mean the offscreen listener is up; a
    // START sent into that gap is dropped and the toggle looks dead.
    expect(background).toContain('async function waitUntilOffscreenReady')
    const begin = background.slice(background.indexOf('async function beginTranscription'))
    expect(begin.indexOf('waitUntilOffscreenReady')).toBeLessThan(begin.indexOf("'MOMENTQ_ASR_START'"))
    expect(begin).toContain('音频采集管线未就绪')
    // The offscreen answers MOMENTQ_ASR_QUERY in-band so the probe and the
    // worker-restart re-attach both observe it.
    const offscreen = await readFile(join(import.meta.dirname, '..', 'src', 'offscreen', 'index.ts'), 'utf8')
    expect(offscreen).toMatch(/MOMENTQ_ASR_QUERY[\s\S]{0,400}sendResponse/)
    expect(background).toContain("reply.type === 'MOMENTQ_ASR_SESSION'")
  })

  it('never lets a part-1 resolution clobber a player-proven part binding', async () => {
    const background = await readFile(join(import.meta.dirname, '..', 'src', 'background', 'index.ts'), 'utf8')
    // A p-less URL resolves to part 1; overwriting the playing part with it
    // displayed part-1 subtitles over whatever part was actually playing.
    for (const name of ['async function refreshVodContext', 'async function readOrResolveState']) {
      const body = background.slice(background.indexOf(name))
      expect(body).toContain('requestedPart === undefined')
      expect(body).toMatch(/\w+\.context\.identity\.bvid === context\.identity\.bvid/)
    }
  })
})
