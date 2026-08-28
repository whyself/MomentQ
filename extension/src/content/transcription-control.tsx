import { createRoot } from 'react-dom/client'
import { Button } from '../vendor/deepseek-harness/packages/client/ui-primitives/src/Button.tsx'
import { IconPauseOutline16, IconPlayOutline16 } from '../vendor/deepseek-harness/packages/client/ui-primitives/src/icons/index.tsx'
import type { MomentQTabState } from '../shared/protocol'
import baseCss from '../vendor/deepseek-harness/packages/client/ui-theme/src/styles/base.css?inline'
import designCss from '../vendor/deepseek-harness/packages/client/ui-theme/src/styles/design-platform.css?inline'
import buttonCss from '../vendor/deepseek-harness/packages/client/ui-primitives/src/Button.module.css?inline'

const hostCss = `
:host {
  position: fixed;
  top: 50%;
  right: 0;
  z-index: 2147483647;
  transform: translateY(-50%);
  touch-action: none;
}
`

function subtitleFingerprint(state: MomentQTabState | null): string {
  const segments = state?.subtitleSegments ?? []
  // FNV-1a is sufficient for a compact DOM diagnostic. It lets real-browser
  // tests catch same-length track replacement without exposing subtitle text
  // in an attribute.
  let hash = 0x811c9dc5
  for (const segment of segments) {
    const value = `${segment.start}|${segment.end}|${segment.text}\n`
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193)
    }
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function Control({ state, onToggle }: { state: MomentQTabState | null; onToggle: () => void }) {
  if (state === null) return null
  const active = state.transcription === 'active'
  const source = state.subtitleSource
  const hasSubtitle = state.context.kind === 'vod'
    && state.subtitleIdentity?.bvid === state.context.identity.bvid
    && state.subtitleIdentity.cid === state.context.identity.cid
    && (state.subtitleSegments?.length ?? 0) > 0
  const title = hasSubtitle && source === 'asr'
    ? '实时字幕生成中'
    : hasSubtitle
      ? '已使用 B 站字幕，不需要语音转录'
      : (active ? '暂停转录' : '开始转录')
  return (
    <Button
      variant="toolbar"
      size="sm"
      // One consistent tone: the disabled with-subtitle state sits at 0.4
      // opacity, so the enabled state matches it instead of switching to a
      // darker blob when subtitles are missing.
      style={hasSubtitle ? undefined : { opacity: 0.4 }}
      aria-label={title}
      title={title}
      icon={active ? <IconPauseOutline16 size={16} /> : <IconPlayOutline16 size={16} />}
      disabled={hasSubtitle}
      onClick={onToggle}
    />
  )
}

export function mountTranscriptionControl(onToggle: () => void | Promise<void>): {
  update: (state: MomentQTabState | null) => void
} {
  const host = document.createElement('div')
  host.id = 'momentq-transcription-control'
  host.dataset.momentqVersion = chrome.runtime.getManifest().version
  const shadow = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = `${baseCss.replaceAll(':root', ':host')}\n${designCss.replaceAll('body', ':host')}\n${buttonCss}\n${hostCss}`
  const mount = document.createElement('div')
  shadow.append(style, mount)
  document.documentElement.append(host)

  // Vertical drag along the right edge. A press that moves more than a few
  // pixels is a drag (position follows the pointer, persisted for the
  // session); a press that stays put is a click and toggles transcription.
  let suppressClick = false
  let pointerActive = false
  let dragged = false
  let startY = 0
  let startTop = 0
  const topStorageKey = 'momentq.transcriptionControlTop'
  const clampTop = (top: number): number => Math.min(
    Math.max(top, 8),
    Math.max(window.innerHeight - host.offsetHeight - 8, 8),
  )
  const storedTop = Number(window.sessionStorage.getItem(topStorageKey))
  if (Number.isFinite(storedTop) && storedTop >= 8) {
    host.style.top = `${storedTop}px`
    host.style.transform = 'translateY(0)'
  }
  host.addEventListener('pointerdown', (event: PointerEvent) => {
    if (event.button !== 0) return
    pointerActive = true
    dragged = false
    startY = event.clientY
    startTop = host.getBoundingClientRect().top
  })
  window.addEventListener('pointermove', (event: PointerEvent) => {
    if (!pointerActive) return
    const offset = event.clientY - startY
    if (!dragged && Math.abs(offset) < 4) return
    dragged = true
    const top = clampTop(startTop + offset)
    host.style.top = `${top}px`
    host.style.transform = 'translateY(0)'
    window.sessionStorage.setItem(topStorageKey, String(top))
  })
  window.addEventListener('pointerup', () => {
    if (!pointerActive) return
    pointerActive = false
    if (!dragged) return
    // The drag ends with the browser synthesizing a click on the button;
    // swallow exactly that one so moving the control never toggles.
    suppressClick = true
    window.setTimeout(() => { suppressClick = false }, 0)
  })

  const root = createRoot(mount)
  const update = (state: MomentQTabState | null) => {
    host.dataset.contextIdentity = state?.context.kind === 'vod'
      ? `${state.context.identity.bvid}:${state.context.identity.cid}`
      : state?.context.kind === 'live'
        ? `${state.context.identity.canonicalRoomId}:${state.context.identity.liveStartTime}`
        : ''
    host.dataset.subtitleIdentity = state?.subtitleIdentity === undefined
      ? ''
      : `${state.subtitleIdentity.bvid}:${state.subtitleIdentity.cid}`
    host.dataset.subtitleCount = String(state?.subtitleSegments?.length ?? 0)
    host.dataset.subtitleFingerprint = subtitleFingerprint(state)
    root.render(<Control state={state} onToggle={() => {
      // A drag ends with a synthesized click on the button; swallow it.
      if (!suppressClick) void onToggle()
    }} />)
  }
  update(null)
  return { update }
}
