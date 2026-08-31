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
    // The guard is keyed on the running version: a plain boolean let the NEW
    // build's revival injection become a no-op behind the OLD build's flag.
    expect(source).toContain('__momentqContentBridgeVersion')
    expect(source).toContain('if (bridge.__momentqContentBridgeVersion !== bridgeVersion)')
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
    expect(sync).toContain('trackNeedsChineseTranslation(segments)')
    const reconcile = source.slice(source.indexOf('async function reconcileVideoSubtitles'))
    expect(reconcile).toContain('trackNeedsChineseTranslation(segments)')
  })

  it('drives the player menu to surface the built-in translated track', async () => {
    const source = await readFile(join(import.meta.dirname, '..', 'src', 'content', 'page-bridge.ts'), 'utf8')
    // The player-menu auto-click is deliberately GONE: during navigation it
    // made Bilibili attach a translation of the previous video's audio to
    // the new video permanently (poisoned tracks that import cleanly).
    expect(source).not.toContain('requestBilibiliSubtitleLoad')
    expect(source).not.toContain("querySelector<HTMLElement>('.bpx-player-ctrl-subtitle')")
    expect(source).toContain('no player-menu auto-click')
  })

  it('trusts only the WBI index on every channel (legacy is the poison habitat)', async () => {
    // 2026-08-29 logged-in probe: every rotating foreign track for trackless
    // videos arrived from /x/player/v2 disguised as ai_type=0; WBI stayed
    // clean in both rounds. Neither unsigned query may touch legacy, and the
    // tap must reject legacy responses even when the player itself makes them.
    const backgroundProbe = await readFile(join(import.meta.dirname, '..', 'src', 'background', 'bilibili-subtitle.ts'), 'utf8')
    expect(backgroundProbe).not.toContain('/x/player/v2')
    const bridge = await readFile(join(import.meta.dirname, '..', 'src', 'content', 'page-bridge.ts'), 'utf8')
    const probe = bridge.slice(
      bridge.indexOf('async function publishSubtitle'),
      bridge.indexOf('function installSubtitleNetworkTap'),
    )
    expect(probe).not.toContain('x/player/v2')
    const tap = bridge.slice(bridge.indexOf('function installSubtitleNetworkTap'))
    expect(tap).toContain("raw.includes('/x/player/v2')")
  })

  it('vetoes every late import once WBI proves an identity trackless', async () => {
    const background = await readFile(join(import.meta.dirname, '..', 'src', 'background', 'index.ts'), 'utf8')
    // Short poison tracks (measured: 137s inside a 464s host) physically fit
    // the host video, so the duration gate alone cannot catch them. A WBI
    // definitive empty must veto all later imports from any channel.
    expect(background).toContain('const provenTracklessIdentities = new Set<string>()')
    const sync = background.slice(background.indexOf('async function syncBilibiliSubtitle'))
    expect(sync).toContain('provenTracklessIdentities.add(verifyKey)')
    const pageTracks = background.slice(background.indexOf('async function syncPageSubtitleTracks'))
    expect(pageTracks).toContain('provenTracklessIdentities.has(')
    // The veto runs before ownership checks: even a live ASR session must not
    // let a poison track in, and its diagnostic names the rejecting channel.
    expect(pageTracks.indexOf('provenTracklessIdentities.has('))
      .toBeLessThan(pageTracks.indexOf("state.transcription !== 'inactive'"))
    expect(pageTracks).toContain('已否决迟到的串台轨')
  })

  it('never drops a failed capture start silently from the panel', async () => {
    const app = await readFile(join(import.meta.dirname, '..', 'src', 'sidepanel', 'App.tsx'), 'utf8')
    // A capture failure in the panel reports back to the background, which
    // deactivates with the reason — never a silent dead click.
    expect(app).toContain('MOMENTQ_ASR_PANEL_CAPTURE_FAILED')
    const background = await readFile(join(import.meta.dirname, '..', 'src', 'background', 'index.ts'), 'utf8')
    expect(background).toContain("type === 'MOMENTQ_ASR_PANEL_CAPTURE_FAILED'")
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

  it('routes cloud sessions to the offscreen host with a panel fallback', async () => {
    const background = await readFile(join(import.meta.dirname, '..', 'src', 'background', 'index.ts'), 'utf8')
    // Closing the side panel must not end transcription: cloud-engine
    // sessions are hosted by the offscreen document (the panel mints the id
    // in its click handler, offscreen consumes it), with the media clock
    // relayed by the background so the panel's own poll dying is irrelevant.
    const begin = background.slice(background.indexOf('async function beginTranscription'))
    expect(begin).toContain("'MOMENTQ_ASR_START'")
    expect(begin).toContain('ensureOffscreenDocument')
    expect(begin).toContain('startClockRelay(tabId)')
    expect(begin).toContain("consumer: 'panel'")
    expect(background).toContain('armStartAckWatchdog')
    expect(background).toContain('offscreenStarted.has(tabId)')
    const app = await readFile(join(import.meta.dirname, '..', 'src', 'sidepanel', 'App.tsx'), 'utf8')
    expect(app).toContain('MOMENTQ_ASR_START_FROM_PANEL')
    expect(app).toContain('getMediaStreamId({ targetTabId: tabId })')
    expect(app).toContain('面板等待后台响应超时')
    expect(app).toContain('setTranscriptionNotice')
    const session = await readFile(join(import.meta.dirname, '..', 'src', 'sidepanel', 'asr-session.ts'), 'utf8')
    expect(session).toContain('export async function startPanelSession')
    expect(session).toContain("engine: 'baidu' | 'whisper'")
  })

  it('drives the player menu to surface the built-in translated track', async () => {
    const source = await readFile(join(import.meta.dirname, '..', 'src', 'content', 'page-bridge.ts'), 'utf8')
    // The player-menu auto-click is deliberately GONE: during navigation it
    // made Bilibili attach a translation of the previous video's audio to
    // the new video permanently (poisoned tracks that import cleanly).
    expect(source).not.toContain('requestBilibiliSubtitleLoad')
    expect(source).not.toContain("querySelector<HTMLElement>('.bpx-player-ctrl-subtitle')")
    expect(source).toContain('no player-menu auto-click')
  })

  it('trusts only the WBI index on every channel (legacy is the poison habitat)', async () => {
    // 2026-08-29 logged-in probe: every rotating foreign track for trackless
    // videos arrived from /x/player/v2 disguised as ai_type=0; WBI stayed
    // clean in both rounds. Neither unsigned query may touch legacy, and the
    // tap must reject legacy responses even when the player itself makes them.
    const backgroundProbe = await readFile(join(import.meta.dirname, '..', 'src', 'background', 'bilibili-subtitle.ts'), 'utf8')
    expect(backgroundProbe).not.toContain('/x/player/v2')
    const bridge = await readFile(join(import.meta.dirname, '..', 'src', 'content', 'page-bridge.ts'), 'utf8')
    const probe = bridge.slice(
      bridge.indexOf('async function publishSubtitle'),
      bridge.indexOf('function installSubtitleNetworkTap'),
    )
    expect(probe).not.toContain('x/player/v2')
    const tap = bridge.slice(bridge.indexOf('function installSubtitleNetworkTap'))
    expect(tap).toContain("raw.includes('/x/player/v2')")
  })

  it('vetoes every late import once WBI proves an identity trackless', async () => {
    const background = await readFile(join(import.meta.dirname, '..', 'src', 'background', 'index.ts'), 'utf8')
    // Short poison tracks (measured: 137s inside a 464s host) physically fit
    // the host video, so the duration gate alone cannot catch them. A WBI
    // definitive empty must veto all later imports from any channel.
    expect(background).toContain('const provenTracklessIdentities = new Set<string>()')
    const sync = background.slice(background.indexOf('async function syncBilibiliSubtitle'))
    expect(sync).toContain('provenTracklessIdentities.add(verifyKey)')
    const pageTracks = background.slice(background.indexOf('async function syncPageSubtitleTracks'))
    expect(pageTracks).toContain('provenTracklessIdentities.has(')
    // The veto runs before ownership checks: even a live ASR session must not
    // let a poison track in, and its diagnostic names the rejecting channel.
    expect(pageTracks.indexOf('provenTracklessIdentities.has('))
      .toBeLessThan(pageTracks.indexOf("state.transcription !== 'inactive'"))
    expect(pageTracks).toContain('已否决迟到的串台轨')
  })

  it('never drops a failed capture start silently from the panel', async () => {
    const app = await readFile(join(import.meta.dirname, '..', 'src', 'sidepanel', 'App.tsx'), 'utf8')
    // A capture failure in the panel reports back to the background, which
    // deactivates with the reason — never a silent dead click.
    expect(app).toContain('MOMENTQ_ASR_PANEL_CAPTURE_FAILED')
    const background = await readFile(join(import.meta.dirname, '..', 'src', 'background', 'index.ts'), 'utf8')
    expect(background).toContain("type === 'MOMENTQ_ASR_PANEL_CAPTURE_FAILED'")
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

  it('keeps the panel path as the offscreen fallback with an audible monitor', async () => {
    const background = await readFile(join(import.meta.dirname, '..', 'src', 'background', 'index.ts'), 'utf8')
    // When the offscreen consumer refuses the stream on some Edge build, the
    // start falls back ONCE to a panel-hosted session instead of dying.
    const begin = background.slice(background.indexOf('async function beginTranscription'))
    expect(begin).toContain("'MOMENTQ_ASR_REQUEST_START'")
    expect(background).toContain('armStartAckWatchdog')
    expect(background).toContain('已回退到面板内采集')
    const app = await readFile(join(import.meta.dirname, '..', 'src', 'sidepanel', 'App.tsx'), 'utf8')
    expect(app).toContain('startPanelSession')
    expect(app).toContain('面板等待后台响应超时')
    expect(app).toContain('setTranscriptionNotice')
    const session = await readFile(join(import.meta.dirname, '..', 'src', 'sidepanel', 'asr-session.ts'), 'utf8')
    expect(session).toContain('export async function startPanelSession')
    expect(session).toContain('MOMENTQ_ASR_SESSION')
    const offscreen = await readFile(join(import.meta.dirname, '..', 'src', 'offscreen', 'index.ts'), 'utf8')
    // Tab capture diverts the tab audio into this document; without an
    // explicit re-play the user watches a silent video.
    expect(offscreen).toContain('monitor.srcObject = captureStream')
    expect(offscreen).toContain('AUDIO_PLAYBACK')
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

  it('drops videoData fields while the SPA bvid update is mid-flight', async () => {
    const bridge = await readFile(join(import.meta.dirname, '..', 'src', 'content', 'page-bridge.ts'), 'utf8')
    // During navigation Bilibili updates __INITIAL_STATE__.bvid before
    // videoData; the mixed snapshot bound the previous video's cid/title to
    // the new bvid and imported the previous video's subtitles under the
    // new identity (they pass every check — the pair is self-consistent).
    const snapshot = bridge.slice(bridge.indexOf('function vodSnapshot'))
    expect(snapshot).toContain('stateSettled')
    expect(snapshot).toContain('stateBvid === videoDataBvid')
  })
})
