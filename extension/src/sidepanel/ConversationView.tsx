import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react'
import { Button, FishLogo, IconCloseOutline16, IconPlusOutline16, IconSendOutline16, MarkdownText } from '../dsh/primitives'
import { IconPauseOutline16, IconPlayOutline16 } from '../vendor/deepseek-harness/packages/client/ui-primitives/src/icons/index.tsx'
import modalCss from '../vendor/deepseek-harness/packages/client/ui-primitives/src/Modal.module.css'
import type { ConversationHistoryEntry, MessageStreamEvent, SubmitMessageResult } from '../shared/host-client'
import type { MomentQTabState } from '../shared/protocol'
import assistantCss from '../vendor/deepseek-harness/packages/client/ui-conversation/src/client/chat/AssistantMarkdown.module.css'
import chatCss from '../vendor/deepseek-harness/packages/client/ui-conversation/src/client/chat/ChatView.module.css'
import messageCss from '../vendor/deepseek-harness/packages/client/ui-conversation/src/client/chat/MessageItem.module.css'
import conversationCss from '../vendor/deepseek-harness/packages/client/ui-conversation/src/client/skeleton/ConversationRoot.module.css'
import heroCss from '../vendor/deepseek-harness/packages/client/ui-conversation/src/client/skeleton/HeroShell.module.css'
import inputCss from '../vendor/deepseek-harness/packages/client/ui-conversation/src/client/skeleton/InputBar.module.css'
import { selectSubtitleWindow } from './subtitle-window'

function ContextHeader({ state, settings, transcriptionToggle }: {
  state: MomentQTabState | null
  settings: ReactNode
  transcriptionToggle: ReactNode
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
  const blockedBySubtitles = state.subtitleSource !== 'asr'
    && (state.subtitleSegments?.length ?? 0) > 0
  if (blockedBySubtitles) return null
  const active = state.transcription === 'active'
  const label = state.transcription === 'inactive'
    ? '开始转录'
    : active ? '暂停转录' : '继续转录'
  const hint = asrConfigured === false ? '（百度云未配置）' : ''
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label={`${label}${hint}`}
      title={state.transcriptionError !== undefined
        ? `${label}（${state.transcriptionError}）`
        : `${label}${hint}`}
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
  // is briefly undefined; falling back to zero made the ticker show the first
  // caption and then jump back to the real playback position.
  const historyRows = 4
  const preview = state?.transcriptPreview?.trim()
  const window = selectSubtitleWindow(segments, playbackTime, historyRows)
  // Render only the visible window. Keeping hundreds of transparent rows in
  // the DOM made each 250 ms state update recalculate a large scrollHeight;
  // that is visually indistinguishable from subtitles jumping up and down.
  // The probe diagnostic is hidden only while a live recognition session
  // runs or ASR finals are on screen; a failed session left the 'asr'
  // provenance with no finals, and that must not blank the panel.
  const liveAsr = state?.transcription !== 'inactive'
  const asrFinalsShown = state?.subtitleSource === 'asr' && segments.length > 0
  const diagnostic = state?.context.kind === 'vod' && !liveAsr && !asrFinalsShown
    && (!subtitleMatches || segments.length === 0)
    ? state.subtitleDiagnostic
    : undefined
  if (window === null && (preview === undefined || preview === '')) {
    if (diagnostic !== undefined) {
      return (
        <div className="momentq-subtitle-ticker" data-subtitle-diagnostic aria-live="off">
          <div className="momentq-subtitle-line">{diagnostic}</div>
        </div>
      )
    }
    // Segments exist but no playback clock has arrived: the ticker cannot
    // place them. Saying so beats a silently empty panel.
    if (segments.length > 0 && (playbackTime === undefined || !Number.isFinite(playbackTime))) {
      return (
        <div className="momentq-subtitle-ticker" data-subtitle-diagnostic aria-live="off">
          <div className="momentq-subtitle-line">字幕已就绪，等待页面播放时钟…</div>
        </div>
      )
    }
    return null
  }
  const index = window?.index ?? -1
  const start = window?.start ?? 0
  const visible = window === null ? [] : segments.slice(start, index + 1)
  // An in-flight ASR sentence is the live line; committed rows shift one slot
  // further into the fade history while it is on screen.
  const previewOffset = preview !== undefined && preview !== '' ? 1 : 0
  return (
    <div
      className="momentq-subtitle-ticker"
      data-subtitle-ticker
      aria-live="polite"
    >
      <div className="momentq-subtitle-track">
        {visible.map((segment, visibleIndex) => {
          const segmentIndex = start + visibleIndex
          const distance = index - segmentIndex + previewOffset
          const active = previewOffset === 0 && distance === 0
          return <div
            key={`${segment.start}-${segment.end}-${segment.text}`}
            className={`momentq-subtitle-line${active ? ' is-current' : ''}`}
            style={{ opacity: active ? 1 : distance <= historyRows ? Math.max(0.2, 0.78 - distance * 0.14) : 0 }}
          >{segment.text}</div>
        })}
        {previewOffset === 1 && (
          <div
            className="momentq-subtitle-line is-current"
            data-transcript-preview
            style={{ opacity: 1 }}
          >{preview}</div>
        )}
      </div>
    </div>
  )
}

type FrameAttachment = { dataUrl: string; name: string }

function Composer({ available, draft, pending, hero, frame, onCaptureFrame, onPasteFrame, onRemoveFrame, onDraftChange, onSubmit }: {
  available: boolean
  draft: string
  pending: boolean
  hero: boolean
  frame: FrameAttachment | null
  onCaptureFrame: () => void
  onPasteFrame: (event: ClipboardEvent<HTMLTextAreaElement>) => void
  onRemoveFrame: () => void
  onDraftChange: (value: string) => void
  onSubmit: () => void
}) {
  const placeholder = available ? '针对当前视频或直播提问' : '请先打开支持的 B 站视频或直播页面'
  const disabled = !available || pending
  const submitDisabled = disabled || (draft.trim() === '' && frame === null)
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    if (!submitDisabled) onSubmit()
  }
  return (
    <div className={`${inputCss.root} ${hero ? inputCss.hero : ''}`}>
      <div className={inputCss.card} data-composer-card>
        <div className={inputCss.scroll}>
          {frame !== null && (
            <div className={inputCss.accessory} aria-label="待发送图片">
              <img src={frame.dataUrl} alt={frame.name} style={{ maxWidth: '160px', maxHeight: '90px', borderRadius: '8px' }} />
              <button
                type="button"
                className={modalCss.close}
                aria-label="移除图片"
                title="移除图片"
                onClick={onRemoveFrame}
              >
                <IconCloseOutline16 size={14} />
              </button>
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

type ConversationEntry = {
  id: string
  role: 'user' | 'assistant'
  text: string
  streaming?: boolean
  streamKey?: string
  blocks?: Readonly<Record<number, string>>
  image?: string
}

const markdownCodeLabels = { copyLabel: '复制', copiedLabel: '已复制' }

function AssistantText({ text, blocks, streaming }: {
  text: string
  blocks?: Readonly<Record<number, string>> | undefined
  streaming: boolean
}) {
  const markdownBlocks = blocks === undefined
    ? [text]
    : Object.entries(blocks).sort(([left], [right]) => Number(left) - Number(right)).map(([, value]) => value)
  return (
    <div className={assistantCss.root}>
      <div className={assistantCss.body}>
        {markdownBlocks.map((block, index) => (
          <MarkdownText
            key={index}
            text={block}
            streaming={streaming}
            codeLabels={markdownCodeLabels}
          />
        ))}
      </div>
    </div>
  )
}

function ConversationTranscript({ entries, pending, error }: {
  entries: ConversationEntry[]
  pending: boolean
  error: string | null
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
            <div key={entry.id} className={messageCss.userRow}>
              <div className={messageCss.userStack}>
                {entry.image !== undefined && <img src={entry.image} alt="当前画面" style={{ maxWidth: '240px', borderRadius: '12px' }} />}
                {entry.text !== '' && <div className={messageCss.bubble}>{entry.text}</div>}
              </div>
            </div>
          ) : (
            <AssistantText
              key={entry.id}
              text={entry.text}
              blocks={entry.blocks}
              streaming={entry.streaming === true}
            />
          ))}
          {pending && <div className={chatCss.turnStatus} role="status" aria-live="polite">Deep diving...</div>}
          {error !== null && <div className={chatCss.openError} role="alert">{error}</div>}
        </div>
      </div>
    </div>
  )
}

export function ConversationView({ state, capturedFrame, playbackTime, settings, asrConfigured, onCaptureFrame, onLoadHistory, onSubmit, onToggleTranscription }: {
  state: MomentQTabState | null
  capturedFrame?: string | null
  playbackTime: number | undefined
  settings: ReactNode
  /** Tri-state from companion health: null = unknown/unreachable. */
  asrConfigured?: boolean | null
  onCaptureFrame: () => Promise<string | null>
  onLoadHistory: (state: MomentQTabState) => Promise<ConversationHistoryEntry[]>
  onSubmit: (
    text: string,
    onEvent: (event: MessageStreamEvent) => void,
    signal: AbortSignal,
  ) => Promise<SubmitMessageResult>
  onToggleTranscription?: () => void
}) {
  const [draft, setDraft] = useState('')
  const [frame, setFrame] = useState<FrameAttachment | null>(null)
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
      setFrame({ dataUrl: capturedFrame, name: `momentq-frame-${Date.now()}.png` })
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
    }).catch(() => {})
  }, [contentKey, onLoadHistory])

  useEffect(() => () => { activeRequest.current?.abort() }, [])

  const captureFrame = (): void => {
    if (state === null || pending) return
    void onCaptureFrame().then(dataUrl => {
      if (dataUrl !== null) setFrame({ dataUrl, name: `momentq-frame-${Date.now()}.png` })
      else setError('无法读取视频当前帧，请先播放视频并重试')
    })
  }

  const pasteFrame = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const file = Array.from(event.clipboardData.items)
      .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
      .map(item => item.getAsFile())
      .find((item): item is File => item !== null)
    if (file === undefined) return
    event.preventDefault()
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') setFrame({ dataUrl: reader.result, name: file.name || `momentq-image-${Date.now()}.png` })
    }
    reader.readAsDataURL(file)
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
    if (state === null || pending || (text === '' && frame === null)) return
    const requestGeneration = generation.current
    const localId = `local:${String(Date.now())}`
    const controller = new AbortController()
    activeRequest.current?.abort()
    activeRequest.current = controller
    setDraft('')
    setFrame(null)
    setError(null)
    setPending(true)
    setEntries(current => [...current, {
      id: localId,
      role: 'user',
      text,
      ...(frame === null ? {} : { image: frame.dataUrl }),
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
    void onSubmit(text, onEvent, controller.signal).then(() => {
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
        transcriptionToggle={onToggleTranscription === undefined
          ? null
          : <TranscriptionToggle state={state} asrConfigured={asrConfigured ?? null} onToggle={onToggleTranscription} />}
      />
      <div className={conversationCss.scrollBody}>
        {asrUnconfigured && asrWarningLatched && (
          <div className={`momentq-top-warning ${chatCss.openError}`} role="status" data-asr-warning>
            百度语音识别未配置：请打开设置 → 语音识别，填写百度云凭据
          </div>
        )}
        <div className={conversationCss.viewArea}>
          {active ? <ConversationTranscript entries={entries} pending={pending} error={error} /> : (
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
          {state?.transcriptionError !== undefined && (
            <div className={chatCss.openError} role="alert" data-transcription-error>
              {state.transcriptionError}
            </div>
          )}
          <Composer
            available={state !== null}
            draft={draft}
            pending={pending}
            hero={!active}
            frame={frame}
            onCaptureFrame={captureFrame}
            onPasteFrame={pasteFrame}
            onRemoveFrame={() => { setFrame(null) }}
            onDraftChange={setDraft}
            onSubmit={submit}
          />
        </div>
      </div>
    </section>
  )
}
