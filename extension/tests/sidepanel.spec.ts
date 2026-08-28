import { describe, expect, it } from 'vitest'
import { SidePanelStateController } from '../src/sidepanel/state-controller'
import type { MomentQTabState } from '../src/shared/protocol'

function tabState(tabId: number): MomentQTabState {
  return {
    tabId,
    context: {
      kind: 'vod',
      identity: { kind: 'vod', bvid: 'BV1xx411c7mD', cid: String(tabId) },
      metadata: { title: `Tab ${tabId}`, creator: { name: '作者' } },
      url: 'https://www.bilibili.com/video/BV1xx411c7mD',
    },
    transcription: 'inactive',
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('SidePanelStateController', () => {
  it('does not publish a late response from the previously active tab', async () => {
    let activeTabId = 1
    const responses = new Map([
      [1, deferred<MomentQTabState | null>()],
      [2, deferred<MomentQTabState | null>()],
    ])
    const published: Array<MomentQTabState | null> = []
    const controller = new SidePanelStateController({
      queryActiveTabId: async () => activeTabId,
      sendMessage: async message => responses.get(message.tabId)!.promise,
      publishState: state => published.push(state),
    })

    const loadA = controller.loadActiveTabState()
    await Promise.resolve()
    activeTabId = 2
    const loadB = controller.activateTab(2)
    await Promise.resolve()
    responses.get(2)!.resolve(tabState(2))
    await loadB
    responses.get(1)!.resolve(tabState(1))
    await loadA

    expect(published).toEqual([tabState(2)])
  })

  it('rechecks the active tab before toggling instead of using cached state', async () => {
    let activeTabId = 1
    const sentTo: number[] = []
    const controller = new SidePanelStateController({
      queryActiveTabId: async () => activeTabId,
      sendMessage: async message => {
        sentTo.push(message.tabId)
        return tabState(message.tabId)
      },
      publishState: () => {},
    })
    await controller.loadActiveTabState()
    activeTabId = 2
    await controller.toggleTranscription()
    expect(sentTo).toEqual([1, 2])
  })

  it('does not let an older GET response overwrite a newer pushed state', async () => {
    const response = deferred<MomentQTabState | null>()
    const published: Array<MomentQTabState | null> = []
    const controller = new SidePanelStateController({
      queryActiveTabId: async () => 1,
      sendMessage: async () => response.promise,
      publishState: state => published.push(state),
    })
    const load = controller.loadActiveTabState()
    await Promise.resolve()
    const pushed = { ...tabState(1), transcription: 'active' as const }
    controller.handleStateChanged({
      type: 'MOMENTQ_TAB_STATE_CHANGED', tabId: 1, state: pushed,
    })
    response.resolve(tabState(1))
    await load
    expect(published).toEqual([pushed])
  })

  it('rejects a late pushed state with an older publication revision', async () => {
    const published: Array<MomentQTabState | null> = []
    const controller = new SidePanelStateController({
      queryActiveTabId: async () => 1,
      sendMessage: async () => tabState(1),
      publishState: state => published.push(state),
    })
    await controller.loadActiveTabState()
    published.length = 0
    const newest = { ...tabState(1), transcription: 'active' as const }
    controller.handleStateChanged({
      type: 'MOMENTQ_TAB_STATE_CHANGED', tabId: 1, state: newest, revision: 200,
    })
    controller.handleStateChanged({
      type: 'MOMENTQ_TAB_STATE_CHANGED', tabId: 1, state: tabState(1), revision: 199,
    })
    expect(published).toEqual([newest])
  })
})
