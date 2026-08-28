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
    root.render(<Control state={state} onToggle={() => { void onToggle() }} />)
  }
  update(null)
  return { update }
}
