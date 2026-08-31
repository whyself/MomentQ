import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react'
import { Button, FishLogo, IconCheckOutline16, IconCloseOutline16, IconCopyOutline16, IconPlusOutline16, IconSendOutline16, MarkdownText, Tooltip, writeClipboard } from '../dsh/primitives'
import { IconPauseOutline16, IconPlayOutline16 } from '../vendor/deepseek-harness/packages/client/ui-primitives/src/icons/index.tsx'
import modalCss from '../vendor/deepseek-harness/packages/client/ui-primitives/src/Modal.module.css'
import type { ConversationHistoryEntry, MessageStreamEvent, SubmitMessageResult } from '../shared/host-client'
import type { BilibiliSubtitleSegment, MomentQTabState } from '../shared/protocol'
import assistantCss from '../vendor/deepseek-harness/packages/client/ui-conversation/src/client/chat/AssistantMarkdown.module.css'
import chatCss from '../vendor/deepseek-harness/packages/client/ui-conversation/src/client/chat/ChatView.module.css'
import messageCss from '../vendor/deepseek-harness/packages/client/ui-conversation/src/client/chat/MessageItem.module.css'
import conversationCss from '../vendor/deepseek-harness/packages/client/ui-conversation/src/client/skeleton/ConversationRoot.module.css'
import heroCss from '../vendor/deepseek-harness/packages/client/ui-conversation/src/client/skeleton/HeroShell.module.css'
import inputCss from '../vendor/deepseek-harness/packages/client/ui-conversation/src/client/skeleton/InputBar.module.css'
import { selectSubtitleWindow } from './subtitle-window'
import actionsCss from '../vendor/deepseek-harness/packages/client/ui-conversation/src/client/chat/MessageIconActions.module.css'
import { playbackStamp, splitVideoStamp, withVideoTimeSuffix } from './video-stamp'

function ContextHeader({ state, settings, transcriptionToggle, clearSession }: {
  state: MomentQTabState | null
  settings: ReactNode
  transcriptionToggle: ReactNode
  clearSession: ReactNode
}) {
  const metadata = state?.context.metadata
  const part = state?.context.kind === 'vod' ? state.context.metadata.part : undefined
  const partText = part === undefined ? undefined : `第 ${part.number} 集${part.title === undefined ? '' : ` · ${part.title}`}`
  return (
    <header className={conversationCss.header}>
      <div className={conversationCss.titleRow}>
        <div className={conversationCss.titleCluster}>
          <div className={conversationCss.crumbs}>
            <span
              className={`${conversationCss.crumb} ${conversationCss.crumbCurrent} momentq-title-crumb`}
              title={metadata?.title ?? 'MomentQ'}
            >
              {metadata?.title ?? 'MomentQ'}
            </span>
            {partText !== undefined && (
              <span className={conversationCss.crumbSeg}>
                <span className={conversationCss.crumbSep}>/</span>
                <span
                  className={`${conversationCss.crumb} ${conversationCss.crumbCurrent} momentq-part-crumb`}
                  title={partText}
                >
                  {partText}
                </span>
              </span>
            )}
          </div>
        </div>
        <div className={conversationCss.headerActions}>
          {transcriptionToggle}
          {clearSession}
          {settings}
        </div>
      </div>
      <div className={conversationCss.tabs}>
        <button type="button" className={`${conversationCss.tab} ${conversationCss.tabActive}`}>对话</button>
      </div>
    </header>
  )
}

/**
 * Side-panel transcription control. Starting capture from here is the
 * reliable path: the click handler runs on an extension surface, so the
 * tabCapture user-gesture gate is satisfied before the request is relayed.
 */
function TranscriptionToggle({ state, asrConfigured, onToggle }: {
  state: MomentQTabState | null
  asrConfigured: boolean | null
  onToggle: () => void
}) {
  if (state === null) return null
  const active = state.transcription === 'active'
  const label = state.transcription === 'inactive'
    ? '开始转录'
    : active ? '暂停转录' : '继续转录'
  const hint = asrConfigured === false ? '（百度云未配置）' : ''
  // B站字幕存在时按钮仍可用：识别结果会接在已导入字幕之后，用户可以用它
  // 补齐 B 站只做了一部分的字幕——这正是部分字幕视频的启动入口。
  const hasSubtitles = state.subtitleSource !== 'asr'
    && (state.subtitleSegments?.length ?? 0) > 0
  const subtitleHint = hasSubtitles && state.transcription === 'inactive'
    ? '（已有 B 站字幕，转录将补充识别缺失部分）'
    : ''
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label={`${label}${hint}${subtitleHint}`}
      title={state.transcriptionError !== undefined
        ? `${label}（${state.transcriptionError}）`
        : `${label}${hint}${subtitleHint}`}
      icon={active ? <IconPauseOutline16 size={16} /> : <IconPlayOutline16 size={16} />}
      onClick={onToggle}
    />
  )
}

function SubtitleTicker({ state, playbackTime }: { state: MomentQTabState | null; playbackTime: number | undefined }) {
  const subtitleMatches = state?.context.kind === 'vod'
    && state.subtitleIdentity?.bvid === state.context.identity.bvid
    && state.subtitleIdentity.cid === state.context.identity.cid
  const segments = subtitleMatches ? state.subtitleSegments ?? [] : []
  // Never guess a timestamp. During tab/context reconciliation the live clock
  // is briefly undefined; without it the cues cannot be placed at all.
  const historyRows = 5
  const preview = state?.transcriptPreview?.trim()
  const window = selectSubtitleWindow(segments, playbackTime, historyRows)
  // The probe diagnostic lives HERE, in the subtitle's own slot: the fixed
  // footprint keeps it from moving anything above, and "无轨道" reads exactly
  // where subtitles would appear.
  const liveAsr = state?.transcription !== 'inactive'
  const asrFinalsShown = state?.subtitleSource === 'asr' && segments.length > 0
  const diagnostic = state?.context.kind === 'vod' && !liveAsr && !asrFinalsShown
    && (!subtitleMatches || segments.length === 0)
    ? state.subtitleDiagnostic
    : undefined
  if (window === null && (preview === undefined || preview === '')) {
    // The diagnostic gets its own unmasked container: the ticker's dissolve
    // gradient would wash it out at this height.
    if (diagnostic !== undefined) {
      return (
        <div className="momentq-subtitle-ticker momentq-subtitle-note" data-subtitle-diagnostic aria-live="off">
          {diagnostic}
        </div>
      )
    }
    if (segments.length > 0) {
      return (
        <div className="momentq-subtitle-ticker momentq-subtitle-note" data-subtitle-diagnostic aria-live="off">
          字幕已就绪，等待页面播放时钟…
        </div>
      )
    }
    return null
  }
  const index = window?.index ?? -1
  const start = window?.start ?? 0
  const visible = window === null ? [] : segments.slice(start, index + 1)
  return (
    <SubtitleScroll
      key={state?.tabId ?? 'none'}
      rows={visible}
      preview={preview}
      currentIndex={index}
    />
  )
}

function SubtitleScroll({ rows, preview, currentIndex }: {
  rows: BilibiliSubtitleSegment[]
  preview: string | undefined
  currentIndex: number
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const previousIndex = useRef(-1)
  const hasAnimated = useRef(false)
  const fingerprint = `${currentIndex}|${preview ?? ''}`
  useEffect(() => {
    const node = scrollRef.current
    if (node === null) return
    // Advance = smooth rise (the new cue slides up from below the edge);
    // seek-back = snap. First paint pins without animation.
    const seekedBack = currentIndex < previousIndex.current
    const behavior: ScrollBehavior = !hasAnimated.current || seekedBack ? 'auto' : 'smooth'
    previousIndex.current = currentIndex
    hasAnimated.current = true
    node.scrollTo({ top: node.scrollHeight, behavior })
  }, [fingerprint, currentIndex])
  return (
    <div className="momentq-subtitle-ticker" aria-live="polite">
      <div className="momentq-subtitle-scroll" ref={scrollRef}>
        <div className="momentq-subtitle-track">
          {rows.map(segment => (
            <div key={`${segment.start}-${segment.end}-${segment.text}`} className="momentq-subtitle-line">
              {segment.text}
            </div>
          ))}
          {preview !== undefined && preview !== '' && (
            <div className="momentq-subtitle-line is-current" data-transcript-preview>{preview}</div>
          )}
        </div>
      </div>
    </div>
  )
}

type FrameAttachment = { dataUrl: string; name: string }

function Composer({ available, draft, pending, hero, frames, onCaptureFrame, onPasteFrame, onRemoveFrame, onDraftChange, onSubmit }: {
  available: boolean
  draft: string
  pending: boolean
  hero: boolean
  frames: FrameAttachment[]
  onCaptureFrame: () => void
  onPasteFrame: (event: ClipboardEvent<HTMLTextAreaElement>) => void
  onRemoveFrame: (index: number) => void
  onDraftChange: (value: string) => void
  onSubmit: () => void
}) {
  const placeholder = available ? '针对当前视频或直播提问' : '请先打开支持的 B 站视频或直播页面'
  const disabled = !available || pending
  const submitDisabled = disabled || (draft.trim() === '' && frames.length === 0)
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    if (!submitDisabled) onSubmit()
  }
  return (
    <div className={`${inputCss.root} ${hero ? inputCss.hero : ''}`}>
      <div className={inputCss.card} data-composer-card>
        <div className={inputCss.scroll}>
          {frames.length > 0 && (
            <div className={inputCss.accessory} aria-label="待发送图片" style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {frames.map((frame, index) => (
                <div key={`${frame.name}-${index}`} style={{ position: 'relative', display: 'inline-block' }}>
                  <img src={frame.dataUrl} alt={frame.name} style={{ maxWidth: '160px', maxHeight: '90px', borderRadius: '8px' }} />
                  <button
                    type="button"
                    className={modalCss.close}
                    aria-label={`移除图片 ${index + 1}`}
                    title="移除图片"
                    onClick={() => onRemoveFrame(index)}
                  >
                    <IconCloseOutline16 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className={inputCss.grow}>
            <div aria-hidden className={inputCss.backdrop} data-input-backdrop>
              {draft}
            </div>
            <textarea
              className={inputCss.input}
              value={draft}
              placeholder={placeholder}
              rows={2}
              disabled={disabled}
              onChange={event => { onDraftChange(event.target.value) }}
              onPaste={onPasteFrame}
              onKeyDown={onKeyDown}
            />
            <div aria-hidden className={inputCss.mirror}>{`${draft}\n`}</div>
          </div>
        </div>
        <div className={inputCss.row}>
          <div className={inputCss.tools}>
            <button
              type="button"
              className={inputCss.add}
              aria-label="添加当前画面"
              title="添加当前画面（Alt+Shift+C）"
              disabled={!available || pending}
              onClick={onCaptureFrame}
            >
              <IconPlusOutline16 size={14} />
            </button>
          </div>
          <div className={inputCss.trailing}>
            <button type="button" className={inputCss.primary} aria-label="发送" disabled={submitDisabled} onClick={onSubmit}>
              <IconSendOutline16 size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function UserEntry({ entry }: {
  entry: ConversationEntry
}) {
  const { body, stamp } = splitVideoStamp(entry.text)
  return (
    <div className={messageCss.userRow}>
      <div className={messageCss.userStack}>
        {(entry.images ?? (entry.image === undefined ? [] : [entry.image])).map((src, index) => (
          <img key={index} src={src} alt={`附件 ${index + 1}`} style={{ maxWidth: '240px', borderRadius: '12px' }} />
        ))}
        {body !== '' && <div className={messageCss.bubble}>{body}</div>}
        {stamp !== null && <div className="momentq-user-stamp">提问于 {stamp}</div>}
      </div>
    </div>
  )
}

type ConversationEntry = {
  id: string
  role: 'user' | 'assistant'
  text: string
  streaming?: boolean
  streamKey?: string
  blocks?: Readonly<Record<number, string>>
  image?: string
  images?: string[]
}

const markdownCodeLabels = { copyLabel: '复制', copiedLabel: '已复制' }

/**
 * The vendor copy action reads its labels through the chat locale seat; the
 * panel only mounts the copy (no branch/clock), so two keys cover it.
 */
/**
 * Copy action for settled assistant answers, mirroring the vendor
 * MessageIconActions chrome (icon button, tooltip, 1s check swap) without
 * pulling the vendor component's chat-store type graph into the panel.
 */
function AssistantCopyAction({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current) }, [])
  const onCopy = (): void => {
    if (copied) return
    void writeClipboard(text).then(ok => {
      if (!ok) return
      setCopied(true)
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = setTimeout(() => { timer.current = null; setCopied(false) }, 1000)
    })
  }
  return (
    <Tooltip label={copied ? '已复制' : '复制'} side="bottom">
      <button type="button" className={actionsCss.action} aria-label={copied ? '已复制' : '复制'} onClick={onCopy}>
        {copied ? <IconCheckOutline16 /> : <IconCopyOutline16 />}
      </button>
    </Tooltip>
  )
}

/**
 * Bracketed video timestamps in answers become seek buttons: single points
 * ([MM:SS], [H:MM:SS]) and ranges seek to their start. The model varies the
 * range separator freely (dash, comma, 、, ~, 至/到 — measured in the wild:
 * "[07:44, 07:55]") and decorates approximations ("[约 11:00-15:00]",
 * "[03:10 左右]"), so separators and 约/大约 prefixes and 左右/前后/附近
 * suffixes are all accepted. Bare forms never match, so ratios like 16:9
 * stay inert prose.
 */
const TIMESTAMP_PATTERN = /\[(?:大约|约)?\s*(\d{1,2}:[0-5]?\d(?::[0-5]?\d)?)(?:\s*[,\-–—，、~至到]\s*\d{1,2}:[0-5]?\d(?::[0-5]?\d)?)?(?:\s*(?:左右|前后|附近))?\]/g

function timestampSeconds(value: string): number | null {
  const parts = value.split(':').map(Number)
  if (parts.length < 2 || parts.some(part => !Number.isFinite(part))) return null
  return parts.reduce((total, part) => total * 60 + part, 0)
}

function AssistantText({ text, blocks, streaming, onSeek }: {
  text: string
  blocks?: Readonly<Record<number, string>> | undefined
  streaming: boolean
  onSeek: ((seconds: number) => void) | undefined
}) {
  const markdownBlocks = blocks === undefined
    ? [text]
    : Object.entries(blocks).sort(([left], [right]) => Number(left) - Number(right)).map(([, value]) => value)
  return (
    <div className={assistantCss.root}>
      <div className={assistantCss.body}>
        {markdownBlocks.map((block, index) => {
          if (onSeek === undefined || !block.includes('[')) {
            return (
              <MarkdownText
                key={index}
                text={block}
                streaming={streaming}
                codeLabels={markdownCodeLabels}
              />
            )
          }
          const segments: ReactNode[] = []
          let cursor = 0
          for (const match of block.matchAll(TIMESTAMP_PATTERN)) {
            const start = match.index ?? 0
            if (start > cursor) {
              segments.push(
                <MarkdownText
                  key={`${index}:t${cursor}`}
                  text={block.slice(cursor, start)}
                  streaming={streaming}
                  codeLabels={markdownCodeLabels}
                />,
              )
            }
            const seconds = timestampSeconds(match[1] ?? '')
            segments.push(
              <button
                key={`${index}:s${start}`}
                type="button"
                className="momentq-seek"
                title={seconds === null ? undefined : `跳转到 ${match[1]}`}
                onClick={() => { if (seconds !== null) onSeek(seconds) }}
              >
                {match[0].slice(1, -1)}
              </button>,
            )
            cursor = start + match[0].length
          }
          if (cursor < block.length || segments.length === 0) {
            segments.push(
              <MarkdownText
                key={`${index}:t${cursor}`}
                text={block.slice(cursor)}
                streaming={streaming}
                codeLabels={markdownCodeLabels}
              />,
            )
          }
          return <div key={index} className="momentq-seek-body">{segments}</div>
        })}
      </div>
    </div>
  )
}

function ConversationTranscript({ entries, pending, error, onSeek }: {
  entries: ConversationEntry[]
  pending: boolean
  error: string | null
  onSeek: ((seconds: number) => void) | undefined
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const node = scrollRef.current
    if (node === null) return
    // Keep a streaming answer in view. If the user deliberately scrolled up,
    // preserve that reading position until they return near the tail.
    const distanceFromTail = node.scrollHeight - node.scrollTop - node.clientHeight
    if (distanceFromTail < 180 || entries.some(entry => entry.streaming === true)) {
      node.scrollTop = node.scrollHeight
    }
  }, [entries, pending, error])
  return (
    <div className={chatCss.root}>
      <div className={chatCss.scroll} ref={scrollRef}>
        <div className={chatCss.column}>
          {entries.map(entry => entry.role === 'user' ? (
            <UserEntry key={entry.id} entry={entry} />
          ) : (
            <div key={entry.id} className="momentq-assistant-block">
              <AssistantText
                text={entry.text}
                blocks={entry.blocks}
                streaming={entry.streaming === true}
                onSeek={onSeek}
              />
              {entry.streaming !== true && (
                <div className={`momentq-message-actions ${actionsCss.actions}`}>
                  <AssistantCopyAction text={entry.text} />
                </div>
              )}
            </div>
          ))}
          {pending && <div className={chatCss.turnStatus} role="status" aria-live="polite">Deep diving...</div>}
          {error !== null && <div className={chatCss.openError} role="alert">{error}</div>}
        </div>
      </div>
    </div>
  )
}

export function ConversationView({ state, capturedFrame, playbackTime, settings, asrConfigured, transcriptionNotice, preTranscribe, onStartPreTranscription, onCancelPreTranscription, onCaptureFrame, onLoadHistory, onSubmit, onToggleTranscription, onSeekTo, onClearSession }: {
  state: MomentQTabState | null
  capturedFrame?: string | null
  playbackTime: number | undefined
  settings: ReactNode
  /** Tri-state from companion health: null = unknown/unreachable. */
  asrConfigured?: boolean | null
  /** Panel-local feedback for transcription operations that never resolved. */
  transcriptionNotice?: string | null
  onCaptureFrame: () => Promise<string | null>
  onLoadHistory: (state: MomentQTabState) => Promise<ConversationHistoryEntry[]>
  onSubmit: (
    text: string,
    images: readonly FrameAttachment[],
    onEvent: (event: MessageStreamEvent) => void,
    signal: AbortSignal,
  ) => Promise<SubmitMessageResult>
  onToggleTranscription?: () => void
  /** Full-video offline ASR: progress surface + start/cancel. */
  preTranscribe?: { running: boolean; message: string; fraction: number } | null
  onStartPreTranscription?: () => void
  onCancelPreTranscription?: () => void
  /** Seek the active video; undefined keeps timestamps as plain text. */
  onSeekTo?: (seconds: number) => void
  /** Delete the current conversation log and start a fresh Session. */
  onClearSession?: () => Promise<void>
}) {
  const [draft, setDraft] = useState('')
  const [frames, setFrames] = useState<FrameAttachment[]>([])
  const [entries, setEntries] = useState<ConversationEntry[]>([])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  const activeRequest = useRef<AbortController | null>(null)
  // Bind UI reset to the visible content location, not a transient player
  // CID. Bilibili can report adjacent preloaded CIDs for the same URL; using
  // identity here made a captured frame disappear and reset the conversation.
  const contentKey = (() => {
    if (state === null) return ''
    if (state.context.kind !== 'vod') return JSON.stringify(state.context.identity)
    try {
      const url = new URL(state.context.url)
      return `${state.context.identity.bvid}:p=${url.searchParams.get('p') ?? '1'}`
    } catch {
      return `${state.context.identity.bvid}:${state.context.identity.cid}`
    }
  })()

  useEffect(() => {
    if (capturedFrame !== null && capturedFrame !== undefined) {
      setFrames(current => [...current, { dataUrl: capturedFrame, name: `momentq-frame-${Date.now()}.png` }])
    }
  }, [capturedFrame])

  // Reset the conversation only when the video/session identity changes.
  // Subtitle clock updates and settings initialization must not wipe a live
  // response that is still being streamed.
  useEffect(() => {
    const requestGeneration = generation.current + 1
    generation.current = requestGeneration
    activeRequest.current?.abort()
    activeRequest.current = null
    setDraft('')
    // A captured frame is an explicit user attachment. Keep it until the user
    // sends or removes it; background context reconciliation must not make it
    // disappear immediately after capture.
    setEntries([])
    setPending(false)
    setError(null)
  }, [contentKey])

  // Loading history is separate from the identity reset. This lets the first
  // render wait for settings/Host availability without clearing an in-flight
  // answer when the callback is recreated.
  useEffect(() => {
    if (state === null) return
    const requestGeneration = generation.current
    void onLoadHistory(state).then(history => {
      if (generation.current !== requestGeneration) return
      setEntries(current => current.length > 0 ? current : history.map(item => ({
        id: item.id,
        role: item.role,
        text: item.text,
        blocks: Object.fromEntries(item.blocks.map((block, index) => [index, block])),
      })))
    }).catch(() => {
      // A dead DSH Host used to leave a silently empty conversation.
      if (generation.current !== requestGeneration) return
      setError('对话历史加载失败：请确认本地 DSH Host（127.0.0.1:3182）已启动')
    })
  }, [contentKey, onLoadHistory])

  useEffect(() => () => { activeRequest.current?.abort() }, [])

  const [clearing, setClearing] = useState(false)
  const clearSession = (): void => {
    if (state === null || clearing) return
    if (!window.confirm('清空当前视频的全部对话记录？此操作不可恢复。')) return
    void (async () => {
      setClearing(true)
      try {
        if (onClearSession !== undefined) await onClearSession()
        activeRequest.current?.abort()
        activeRequest.current = null
        setEntries([])
        setPending(false)
        setError(null)
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : '清空对话失败')
      } finally {
        setClearing(false)
      }
    })()
  }

  const captureFrame = (): void => {
    if (state === null || pending) return
    void onCaptureFrame().then(dataUrl => {
      if (dataUrl !== null) setFrames(current => [...current, { dataUrl, name: `momentq-frame-${Date.now()}.png` }])
      else setError('无法读取视频当前帧，请先播放视频并重试')
    }).catch((reason: unknown) => {
      setError(`读取当前帧失败：${reason instanceof Error ? reason.message : String(reason)}`)
    })
  }

  const pasteFrame = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = Array.from(event.clipboardData.items)
      .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
      .map(item => item.getAsFile())
      .filter((item): item is File => item !== null)
    if (files.length === 0) return
    event.preventDefault()
    for (const file of files) {
      const reader = new FileReader()
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          setFrames(current => [...current, { dataUrl: reader.result as string, name: file.name || `momentq-image-${Date.now()}.png` }])
        }
      }
      reader.onerror = () => setError('粘贴的图片读取失败，请重试')
      reader.readAsDataURL(file)
    }
  }

  useEffect(() => {
    const onShortcut = (event: globalThis.KeyboardEvent): void => {
      if (!event.altKey || !event.shiftKey || event.key.toLowerCase() !== 'c') return
      event.preventDefault()
      captureFrame()
    }
    window.addEventListener('keydown', onShortcut)
    return () => window.removeEventListener('keydown', onShortcut)
  })

  const submit = (): void => {
    const text = draft.trim()
    if (state === null || pending || (text === '' && frames.length === 0)) return
    const requestGeneration = generation.current
    const localId = `local:${String(Date.now())}`
    const controller = new AbortController()
    activeRequest.current?.abort()
    activeRequest.current = controller
    setDraft('')
    const sentImages = frames
    setFrames([])
    setError(null)
    setPending(true)
    const sentText = withVideoTimeSuffix(text, playbackStamp(playbackTime))
    setEntries(current => [...current, {
      id: localId,
      role: 'user',
      text: sentText,
      ...(sentImages.length === 0 ? {} : { images: sentImages.map(frame => frame.dataUrl) }),
    }])
    const onEvent = (event: MessageStreamEvent): void => {
      if (generation.current !== requestGeneration || controller.signal.aborted) return
      if (event.type === 'started') {
        setEntries(current => current.map(entry => entry.id === localId
          ? { ...entry, id: event.userMessageId }
          : entry))
        return
      }
      if (event.type === 'assistant-delta') {
        const streamKey = `${localId}:${String(event.turn)}:${String(event.step)}`
        setEntries((current) => {
          const found = current.findIndex(entry => entry.streamKey === streamKey)
          const previous = found < 0 ? undefined : current[found]
          const blocks = {
            ...(previous?.blocks ?? {}),
            [event.index]: `${previous?.blocks?.[event.index] ?? ''}${event.text}`,
          }
          const text = Object.entries(blocks)
            .sort(([left], [right]) => Number(left) - Number(right))
            .map(([, value]) => value)
            .join('\n')
          const next: ConversationEntry = {
            id: previous?.id ?? streamKey,
            role: 'assistant',
            text,
            streaming: true,
            streamKey,
            blocks,
          }
          if (found < 0) return [...current, next]
          return current.map((entry, index) => index === found ? next : entry)
        })
        return
      }
      if (event.type === 'assistant-message') {
        const streamKey = `${localId}:${String(event.turn)}:${String(event.step)}`
        setEntries((current) => {
          const found = current.findIndex(entry => entry.streamKey === streamKey)
          const settled: ConversationEntry = {
            id: event.id,
            role: 'assistant',
            text: event.text,
            streaming: false,
            streamKey,
            blocks: Object.fromEntries(event.blocks.map((block, index) => [index, block])),
          }
          if (found < 0) return [...current, settled]
          return current.map((entry, index) => index === found ? settled : entry)
        })
      }
    }
    void onSubmit(text, sentImages, onEvent, controller.signal).then(() => {
      if (generation.current !== requestGeneration || controller.signal.aborted) return
    }).catch((reason: unknown) => {
      if (generation.current !== requestGeneration || controller.signal.aborted) return
      setEntries(current => current.map((entry) => {
        if (entry.streaming !== true) return entry
        const { blocks: _blocks, ...settled } = entry
        return { ...settled, streaming: false }
      }))
      setError(reason instanceof Error ? reason.message : 'MomentQ 请求失败')
    }).finally(() => {
      if (generation.current === requestGeneration && activeRequest.current === controller) {
        activeRequest.current = null
        setPending(false)
      }
    })
  }

  const active = entries.length > 0 || pending || error !== null
  const asrUnconfigured = asrConfigured === false
    && state !== null
    && (state.subtitleSegments?.length ?? 0) === 0
  // Subtitle fetches land a few seconds after the panel opens; hold the
  // warning back so a loading video never flashes "unconfigured" and then
  // withdraws it.
  const [asrWarningLatched, setAsrWarningLatched] = useState(false)
  useEffect(() => {
    if (!asrUnconfigured) {
      setAsrWarningLatched(false)
      return
    }
    const timer = window.setTimeout(() => { setAsrWarningLatched(true) }, 3_000)
    return () => { window.clearTimeout(timer) }
  }, [asrUnconfigured])
  return (
    <section className={`momentq-conversation ${conversationCss.root}`} data-phase={active ? 'active' : 'hero'}>
      <ContextHeader
        state={state}
        settings={settings}
        transcriptionToggle={<>
          {onStartPreTranscription !== undefined && state?.context.kind === 'vod' && (
            <Button
              variant="ghost"
              size="sm"
              aria-label="预识别整视频字幕"
              title="预识别：下载整段音频离线识别，产出按真实时间轴对齐的完整字幕（可拖动进度条随意观看）"
              disabled={preTranscribe?.running === true}
              onClick={onStartPreTranscription}
            >
              预识别
            </Button>
          )}
          {onToggleTranscription === undefined
            ? null
            : <TranscriptionToggle state={state} asrConfigured={asrConfigured ?? null} onToggle={onToggleTranscription} />}
        </>}
        clearSession={state === null || !active ? null : (
          <Button
            variant="ghost"
            size="sm"
            aria-label="清空对话"
            title="清空当前视频的对话记录"
            disabled={clearing}
            onClick={clearSession}
          >
            清空
          </Button>
        )}
      />
      <div className={conversationCss.scrollBody}>
        {preTranscribe !== null && preTranscribe !== undefined && (
          <div className="momentq-pretranscribe" role="status">
            <div className="momentq-pretranscribe-bar" data-fraction={preTranscribe.fraction}>
              <div className="momentq-pretranscribe-fill" style={{ width: `${Math.round(preTranscribe.fraction * 100)}%` }} />
            </div>
            <span className="momentq-pretranscribe-text">{preTranscribe.message}</span>
            {preTranscribe.running
              ? <button type="button" className="momentq-pretranscribe-action" onClick={onCancelPreTranscription}>取消</button>
              : <button type="button" className="momentq-pretranscribe-action" onClick={onCancelPreTranscription}>关闭</button>}
          </div>
        )}
        {asrUnconfigured && asrWarningLatched && (
          <div className={`momentq-top-warning ${chatCss.openError}`} role="status" data-asr-warning>
            百度语音识别未配置：请打开设置 → 语音识别，填写百度云凭据
          </div>
        )}
        {state?.transcriptionError !== undefined && (
          <div className={`momentq-top-warning ${chatCss.openError}`} role="alert" data-transcription-error>
            {state.transcriptionError}
          </div>
        )}
        {transcriptionNotice !== null && transcriptionNotice !== undefined && (
          <div className={`momentq-top-warning ${chatCss.openError}`} role="alert" data-transcription-notice>
            {transcriptionNotice}
          </div>
        )}
        <div className={conversationCss.viewArea}>
          {active ? <ConversationTranscript entries={entries} pending={pending} error={error} onSeek={onSeekTo} /> : (
            <div className={heroCss.root}>
              <div className={heroCss.stack}>
                <div className={heroCss.headline}>
                  <span className={heroCss.fishHitbox}><FishLogo size={34} className={heroCss.fish} /></span>
                  <span className={heroCss.headlineText}>有什么可以帮你？</span>
                </div>
                <div className={heroCss.body} />
              </div>
            </div>
          )}
        </div>
      <div className={`${conversationCss.composerSeat} ${active ? '' : conversationCss.composerHero}`}>
          <SubtitleTicker state={state} playbackTime={playbackTime} />
          <Composer
            available={state !== null}
            draft={draft}
            pending={pending}
            hero={!active}
            frames={frames}
            onCaptureFrame={captureFrame}
            onPasteFrame={pasteFrame}
            onRemoveFrame={index => { setFrames(current => current.filter((_, i) => i !== index)) }}
            onDraftChange={setDraft}
            onSubmit={submit}
          />
        </div>
      </div>
    </section>
  )
}
