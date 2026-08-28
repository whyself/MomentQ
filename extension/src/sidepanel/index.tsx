import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import type { MomentQTabState, TabStateChangedMessage } from '../shared/protocol'
import { SidePanelStateController } from './state-controller'
import { App } from './App'

const rootElement = document.getElementById('root')
if (rootElement === null) throw new Error('MomentQ side-panel root is missing')

if (typeof chrome === 'undefined' || chrome.tabs === undefined) {
  const previewState: MomentQTabState = {
    tabId: 1,
    context: {
      kind: 'vod',
      identity: { kind: 'vod', bvid: 'BV1PREVIEW00', cid: '1' },
      metadata: { title: '当前 B 站视频', creator: { name: 'UP 主' } },
      url: 'https://www.bilibili.com/video/BV1PREVIEW00/',
    },
    transcription: 'inactive',
  }
  createRoot(rootElement).render(
    <StrictMode>
      <App
        subscribe={(publish) => { publish(previewState); return () => {} }}
      />
    </StrictMode>,
  )
} else {
let publishToReact: (state: MomentQTabState | null) => void = () => {}
let latestState: MomentQTabState | null = null

async function queryActiveTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  return tab?.id ?? null
}

const controller = new SidePanelStateController({
  queryActiveTabId,
  sendMessage: message => chrome.runtime.sendMessage(message) as Promise<MomentQTabState | null>,
  publishState: (state) => {
    latestState = state
    publishToReact(state)
  },
})

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (typeof message === 'object' && message !== null
    && (message as { type?: unknown }).type === 'MOMENTQ_FRAME_CAPTURED'
    && typeof (message as { dataUrl?: unknown }).dataUrl === 'string') {
    window.dispatchEvent(new CustomEvent('momentq-frame-captured', { detail: (message as { dataUrl: string }).dataUrl }))
    return false
  }
  if (typeof message !== 'object' || message === null) return false
  const update = message as Partial<TabStateChangedMessage>
  if (update.type !== 'MOMENTQ_TAB_STATE_CHANGED' || typeof update.tabId !== 'number'
    || !Object.hasOwn(update, 'state')) return false
  controller.handleStateChanged(update as TabStateChangedMessage)
  return false
})

// The first query can land inside the background's resolve throttle window
// (or before a cold service worker finishes resolving), leaving the panel
// empty until a page refresh. Re-query while empty instead of giving up.
let emptyStatePolls = 0

chrome.tabs.onActivated.addListener(({ tabId }) => {
  emptyStatePolls = 0
  void controller.activateTab(tabId)
})

window.setInterval(() => {
  if (latestState !== null) {
    emptyStatePolls = 0
    return
  }
  if (emptyStatePolls >= 8) return
  emptyStatePolls += 1
  void controller.loadActiveTabState()
}, 2_000)

createRoot(rootElement).render(
  <StrictMode>
    <App
      subscribe={(publish) => {
        publishToReact = publish
        void controller.loadActiveTabState()
        return () => { publishToReact = () => {} }
      }}
    />
  </StrictMode>,
)
}
