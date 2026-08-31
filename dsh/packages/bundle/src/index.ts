/** MomentQ Host service: content state, DSH Session routing, and lifecycle management. */

import { mkdir, readdir, realpath, rm } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent, type SessionHeader, type SessionId as DshSessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import z from '@deepseek-ai/schemastery'
import {
  contentDirectory,
  contentKey,
  sessionIdFor,
  type ContentIdentity,
  type ContentMetadata,
} from './content.ts'
import {
  ensureState,
  MomentQStateNotFoundError,
  readState,
  resolveSessionInstructions,
  writeState,
  replaceTranscript,
  type TranscriptSegment,
  type MomentQSessionRecord,
  type MomentQState,
} from './state.ts'

export type { ContentIdentity, ContentMetadata } from './content.ts'
export type { MomentQState } from './state.ts'
export type { TranscriptSegment } from './state.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    momentq: MomentQService
  }
}

/** One create-or-resume request; filesystem and DSH identities stay Host-owned. */
export interface EnsureContentRequest {
  identity: ContentIdentity
  metadata: ContentMetadata
  sessionInstructions?: string | undefined
}

/** Active content route returned to a trusted caller. */
export interface EnsureContentResult {
  contentKey: string
  sessionId: DshSessionId
  cwd: string
  created: boolean
}

/** Result of replacing or archiving one active Session. */
export interface SessionMutationResult {
  contentKey: string
  previousSessionId: DshSessionId
  sessionId: DshSessionId | null
  cwd: string
}

/** One visible assistant message returned after a submitted user turn. */
export interface ConversationReply {
  id: string
  text: string
}

/** Text messages already committed in the active DSH Session. */
export interface ConversationHistoryEntry {
  id: string
  role: 'user' | 'assistant'
  text: string
  blocks: readonly string[]
}

/**
 * The agent loop projects dynamic runtime context (file policy, approval
 * policy, workspace facts) into the Session as user messages so the model
 * sees fresh state each turn. They are model-facing plumbing, never
 * conversation turns, and both the snapshot and the "cleared" variants
 * share this prefix.
 */
const RUNTIME_CONTEXT_PREFIX = 'Current runtime context'

/** Result of submitting one user message to the active content Session. */
export interface SubmitMessageResult {
  contentKey: string
  sessionId: DshSessionId
  userMessageId: string
  replies: ConversationReply[]
}

export interface SyncTranscriptResult {
  contentKey: string
  source: 'bilibili' | 'asr'
  segments: number
  updatedAt?: string
}

/** Incremental events exposed by the loopback browser transport. */
export type MessageStreamEvent =
  | {
      type: 'started'
      contentKey: string
      sessionId: DshSessionId
      userMessageId: string
    }
  | {
      type: 'assistant-delta'
      turn: number
      step: number
      index: number
      text: string
    }
  | {
      type: 'assistant-message'
      turn: number
      step: number
      id: string
      text: string
      blocks: readonly string[]
      interrupted: boolean
    }
  | { type: 'complete'; result: SubmitMessageResult }

/** Host plugin configuration. */
export interface Config {
  root: string
  defaultInstructions?: string | undefined
  maxInstructionsLength?: number | undefined
}

const DEFAULT_INSTRUCTIONS = '直接、自然地完成用户的请求。需要视频上下文时只使用已提供的字幕、画面和工具证据；证据不足或没有字幕时明确说明无法判断，不得编造视频内容。'
const PRESET_ID = 'momentq'
const PROVIDER = 'deepseek-official'
const MODEL = 'deepseek-v4-flash-vision-exp'

function strictChild(parent: string, target: string, label: string): string {
  const base = resolve(parent)
  const candidate = resolve(target)
  const suffix = relative(base, candidate)
  if (suffix === '' || suffix === '..' || suffix.startsWith('..\\')
    || suffix.startsWith('../') || isAbsolute(suffix)) {
    throw new Error(`${label} escapes its configured root`)
  }
  return candidate
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

async function canonicalStrictChild(parent: string, target: string, label: string): Promise<string> {
  const lexicalTarget = strictChild(parent, target, label)
  const [canonicalParent, canonicalTarget] = await Promise.all([realpath(parent), realpath(target)])
  const physicalTarget = strictChild(canonicalParent, canonicalTarget, label)
  const comparable = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value
  if (comparable(lexicalTarget) !== comparable(physicalTarget)) {
    throw new Error(`${label} is redirected through a filesystem link`)
  }
  return physicalTarget
}

function sameSessionRecord(record: MomentQSessionRecord, header: SessionHeader, cwd: string): void {
  if (header.cwd !== cwd) {
    throw new Error(`Session "${record.id}" cwd conflicts with its MomentQ content directory`)
  }
  if (header.agentPreset !== PRESET_ID) {
    throw new Error(`Session "${record.id}" preset conflicts with MomentQ`)
  }
}

/** Content and Session router registered as `ctx.momentq`. */
export class MomentQService extends Service {
  // agentPresets is mounted only when an Agent is created. Keeping it out of
  // service-init dependencies breaks the profile cycle where the MomentQ-only
  // preset roster obtains this service's package-owned presetRoot.
  static inject = ['agents', 'sessions', 'sessionPersistence', 'workspaceRegistry']

  static Config = z.object({
    root: z.string().required(),
    defaultInstructions: z.string().default(DEFAULT_INSTRUCTIONS),
    maxInstructionsLength: z.number().default(4000),
  })

  root: string
  contentRoot: string
  dshHome: string
  dshSessionsRoot: string
  readonly presetRoot = fileURLToPath(new URL('../presets/', import.meta.url))

  private readonly defaultInstructions: string
  private readonly maxInstructionsLength: number
  private readonly operations = new Map<string, {
    tail: Promise<void>
    pendingEnsure?: Promise<unknown> | undefined
  }>()
  private readonly handles = new Map<string, AgentHandle>()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'momentq')
    if (config.root.trim() === '') throw new Error('MomentQ data root must not be empty')
    this.root = resolve(config.root)
    this.contentRoot = resolve(this.root, 'content')
    this.dshHome = resolve(this.root, 'dsh-home')
    this.dshSessionsRoot = resolve(this.dshHome, 'sessions')
    const configuredDshHome = process.env.DSH_HOME
    if (configuredDshHome === undefined || configuredDshHome.trim() === '') {
      throw new Error('DSH_HOME must be set to <MOMENTQ_DATA_ROOT>/dsh-home')
    }
    this.defaultInstructions = (config.defaultInstructions ?? DEFAULT_INSTRUCTIONS).trim()
    this.maxInstructionsLength = config.maxInstructionsLength ?? 4000
    resolveSessionInstructions({
      defaultInstructions: this.defaultInstructions,
      maxInstructionsLength: this.maxInstructionsLength,
    })
  }

  protected async [Service.init](): Promise<void> {
    await Promise.all([
      mkdir(this.contentRoot, { recursive: true }),
      mkdir(this.dshSessionsRoot, { recursive: true }),
    ])
    const configuredDshHome = process.env.DSH_HOME!
    const [root, contentRoot, dshHome, dshSessionsRoot] = await Promise.all([
      realpath(this.root), realpath(this.contentRoot), realpath(this.dshHome), realpath(this.dshSessionsRoot),
    ])
    let configured: string
    try {
      configured = await realpath(configuredDshHome)
    } catch (error) {
      throw new Error('DSH_HOME must name the configured MomentQ dsh-home directory', { cause: error })
    }
    if (configured !== dshHome) throw new Error(`DSH_HOME must equal "${this.dshHome}" after canonicalization`)
    strictChild(root, contentRoot, 'MomentQ content root')
    strictChild(root, dshHome, 'DSH home')
    strictChild(dshHome, dshSessionsRoot, 'DSH sessions root')
    this.root = root
    this.contentRoot = contentRoot
    this.dshHome = dshHome
    this.dshSessionsRoot = dshSessionsRoot
  }

  /** Create or resume the one active Session for a content identity. */
  async ensureContent(request: EnsureContentRequest): Promise<EnsureContentResult> {
    return await this.forContent(request.identity, async () => {
      const cwd = contentDirectory(this.root, request.identity)
      try {
        const existing = await readState(cwd)
        if (existing.session.active !== null) await this.validateStoredSession(existing.session.active, cwd)
      } catch (error) {
        if (!(error instanceof MomentQStateNotFoundError)) throw error
      }
      const ensured = await ensureState({
        directory: cwd,
        identity: request.identity,
        metadata: request.metadata,
        defaultInstructions: this.defaultInstructions,
        ...(request.sessionInstructions === undefined
          ? {} : { requestedInstructions: request.sessionInstructions }),
        maxInstructionsLength: this.maxInstructionsLength,
      })
      let state = ensured.state
      let activated = false
      if (state.session.active === null) {
        state = await this.activate(cwd, state, request.sessionInstructions)
        activated = true
      }
      const active = state.session.active
      if (active === null) throw new Error('MomentQ failed to activate a Session')
      await this.ensureAgent(active, cwd)
      return {
        contentKey: contentKey(request.identity),
        sessionId: SessionId(active.id),
        cwd,
        created: ensured.created || activated,
      }
    }, true)
  }

  /** Read one existing content state. */
  async getContent(identity: ContentIdentity): Promise<MomentQState> {
    return await this.forContent(identity, async () => {
      const state = await readState(contentDirectory(this.root, identity))
      this.assertIdentity(identity, state)
      return state
    })
  }

  /** Read the committed user/assistant message history for one Session. */
  async getHistory(identity: ContentIdentity): Promise<ConversationHistoryEntry[]> {
    return await this.forContent(identity, async () => {
      const cwd = contentDirectory(this.root, identity)
      const state = await readState(cwd)
      this.assertIdentity(identity, state)
      const active = this.requireActive(state)
      const agent = await this.ensureAgent(active, cwd)
      return agent.session.events.flatMap((event): ConversationHistoryEntry[] => {
        if (event.type === 'user/message') {
          const blocks = event.data.content.filter(block => block.type === 'text').map(block => block.text)
          const text = blocks.join('\n').trim()
          if (text.startsWith(RUNTIME_CONTEXT_PREFIX)) return []
          return text === '' ? [] : [{ id: String(event.data.id), role: 'user', text, blocks }]
        }
        if (event.type === 'assistant/message') {
          const blocks = event.data.message.content.filter(block => block.type === 'text').map(block => block.text)
          const text = blocks.join('\n').trim()
          return text === '' ? [] : [{ id: String(event.data.message.id), role: 'assistant', text, blocks }]
        }
        return []
      })
    })
  }

  /** Atomically replace the transcript consumed by the current Agent. */
  async syncTranscript(
    identity: ContentIdentity,
    source: 'bilibili' | 'asr',
    segments: readonly TranscriptSegment[],
  ): Promise<SyncTranscriptResult> {
    return await this.forContent(identity, async () => {
      const cwd = contentDirectory(this.root, identity)
      const state = await readState(cwd)
      this.assertIdentity(identity, state)
      const next = await replaceTranscript(cwd, source, segments)
      return {
        contentKey: contentKey(identity),
        source,
        segments: segments.length,
        ...(next.transcript.updatedAt === undefined ? {} : { updatedAt: next.transcript.updatedAt }),
      }
    })
  }

  /** Submit one real user turn and return the assistant text committed by DSH. */
  async submitMessage(identity: ContentIdentity, text: string): Promise<SubmitMessageResult> {
    let result: SubmitMessageResult | undefined
    await this.streamMessage(identity, text, (event) => {
      if (event.type === 'complete') result = event.result
    })
    if (result === undefined) throw new Error('MomentQ Agent did not complete the submitted message')
    return result
  }

  /** Submit one user turn while forwarding DSH's native committed chunk lifecycle. */
  async streamMessage(
    identity: ContentIdentity,
    text: string,
    publish: (event: MessageStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<SubmitMessageResult> {
    const prompt = text.trim()
    if (prompt === '' || prompt.length > 32_000) throw new Error('message must contain 1 to 32000 characters')
    return await this.forContent(identity, async () => {
      if (signal?.aborted === true) throw new Error('MomentQ request aborted')
      const cwd = contentDirectory(this.root, identity)
      const state = await readState(cwd)
      this.assertIdentity(identity, state)
      const active = this.requireActive(state)
      const agent = await this.ensureAgent(active, cwd)
      const eventOffset = agent.session.events.length
      const message = createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'user' },
      })
      const forward = (session: Agent['session'], event: SessionEvent): void => {
        if (session !== agent.session || event.seq < eventOffset) return
        if (event.type === 'assistant/chunk' && event.data.chunk.type === 'text-delta') {
          publish({
            type: 'assistant-delta',
            turn: event.data.turn,
            step: event.data.step,
            index: event.data.chunk.index,
            text: event.data.chunk.text,
          })
          return
        }
        if (event.type !== 'assistant/message') return
        const blocks = event.data.message.content
          .filter(block => block.type === 'text')
          .map(block => block.text)
        const replyText = blocks.join('\n')
        if (replyText.trim() === '') return
        publish({
          type: 'assistant-message',
          turn: event.data.turn,
          step: event.data.step,
          id: String(event.data.message.id),
          text: replyText,
          blocks,
          interrupted: event.data.interrupted === true,
        })
      }
      const disposeListener = this.ctx.on('session/event', forward)
      const cancel = (): void => { if (agent.status !== 'idle') agent.cancel({ kind: 'user' }) }
      signal?.addEventListener('abort', cancel, { once: true })
      publish({
        type: 'started',
        contentKey: contentKey(identity),
        sessionId: SessionId(active.id),
        userMessageId: String(message.id),
      })
      try {
        agent.followup(message)
        await agent.whenIdle()
        await this.ctx.sessions.flush(agent.session)
      } finally {
        signal?.removeEventListener('abort', cancel)
        disposeListener()
      }

      const replies: ConversationReply[] = []
      for (const event of agent.session.events.slice(eventOffset)) {
        if (event.type !== 'assistant/message') continue
        const text = event.data.message.content
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join('\n')
        if (text.trim() !== '') replies.push({ id: String(event.data.message.id), text })
      }
      if (replies.length === 0) throw new Error('MomentQ Agent returned no text response')
      const result = {
        contentKey: contentKey(identity),
        sessionId: SessionId(active.id),
        userMessageId: String(message.id),
        replies,
      }
      publish({ type: 'complete', result })
      return result
    })
  }

  /** Archive the active Session and leave the content without an active conversation. */
  async archiveSession(identity: ContentIdentity): Promise<SessionMutationResult> {
    return await this.forContent(identity, async () => {
      const cwd = contentDirectory(this.root, identity)
      const state = await readState(cwd)
      this.assertIdentity(identity, state)
      const active = this.requireActive(state)
      const agent = await this.ensureAgent(active, cwd)
      await this.ctx.workspaceRegistry.archiveSession(SessionId(active.id))
      await this.stopOwnedAgent(agent)
      await writeState(cwd, this.retire(state, active, 'archived', null))
      return {
        contentKey: contentKey(identity),
        previousSessionId: SessionId(active.id),
        sessionId: null,
        cwd,
      }
    })
  }

  /** Archive the active Session and replace it with a fresh generation. */
  async resetSession(identity: ContentIdentity, sessionInstructions?: string): Promise<SessionMutationResult> {
    return await this.replaceSession(identity, 'archived', sessionInstructions)
  }

  /** Physically remove the active Session log and replace it with a fresh generation. */
  async deleteSession(identity: ContentIdentity, sessionInstructions?: string): Promise<SessionMutationResult> {
    return await this.replaceSession(identity, 'deleted', sessionInstructions)
  }

  /** Physically remove all MomentQ-owned Sessions and the exact content directory. */
  async deleteContent(identity: ContentIdentity): Promise<{ deleted: true }> {
    return await this.forContent(identity, async () => {
      const cwd = contentDirectory(this.root, identity)
      const state = await readState(cwd)
      this.assertIdentity(identity, state)
      let activeHeader: SessionHeader | undefined
      if (state.session.active !== null) {
        const agent = await this.ensureAgent(state.session.active, cwd)
        activeHeader = agent.session.header
        await this.stopOwnedAgent(agent)
      }
      const records: MomentQSessionRecord[] = [
        ...(state.session.active === null ? [] : [state.session.active]),
        ...state.session.retired.filter(item => item.disposition !== 'deleted'),
      ]
      for (const record of records) {
        await this.removeSessionArtifact(
          record,
          cwd,
          activeHeader?.id === SessionId(record.id) ? activeHeader : undefined,
        )
      }
      const target = await canonicalStrictChild(this.contentRoot, cwd, 'content directory')
      await rm(target, { recursive: true, force: true })
      return { deleted: true }
    })
  }

  /**
   * Physically remove every Session log across all content, leaving metadata
   * and transcripts in place. Each content directory is routed through its
   * per-identity queue so an in-flight stream serializes instead of racing
   * the teardown.
   */
  async clearAllSessions(): Promise<{ cleared: number; failed: string[] }> {
    const entries = await readdir(this.contentRoot, { withFileTypes: true }).catch(() => [])
    let cleared = 0
    const failed: string[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const cwd = resolve(this.contentRoot, entry.name)
      try {
        const state = await readState(cwd)
        const removed = await this.forContent(state.identity, async () => {
          const current = await readState(cwd)
          const records: MomentQSessionRecord[] = [
            ...(current.session.active === null ? [] : [current.session.active]),
            ...current.session.retired.filter(item => item.disposition !== 'deleted'),
          ]
          if (records.length === 0) return false
          let activeHeader: SessionHeader | undefined
          if (current.session.active !== null) {
            const agent = await this.ensureAgent(current.session.active, cwd)
            activeHeader = agent.session.header
            await this.stopOwnedAgent(agent)
          }
          for (const record of records) {
            await this.removeSessionArtifact(
              record,
              cwd,
              activeHeader?.id === SessionId(record.id) ? activeHeader : undefined,
            )
          }
          // Retired records must survive in state (their generations stay
          // reserved against future activations); only the logs are gone.
          const next: MomentQState = {
            ...current,
            session: {
              generation: current.session.generation,
              active: null,
              retired: current.session.retired.map(item => item.disposition === 'deleted'
                ? item
                : { ...item, disposition: 'deleted' as const }),
            },
          }
          await writeState(cwd, next)
          return true
        })
        if (removed) cleared += 1
      } catch (error) {
        failed.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return { cleared, failed }
  }

  private async replaceSession(
    identity: ContentIdentity,
    disposition: 'archived' | 'deleted',
    sessionInstructions?: string,
  ): Promise<SessionMutationResult> {
    return await this.forContent(identity, async () => {
      const cwd = contentDirectory(this.root, identity)
      const state = await readState(cwd)
      this.assertIdentity(identity, state)
      const active = this.requireActive(state)
      const agent = await this.ensureAgent(active, cwd)
      if (disposition === 'archived') {
        await this.ctx.workspaceRegistry.archiveSession(SessionId(active.id))
      }
      await this.stopOwnedAgent(agent)
      if (disposition === 'deleted') await this.removeSessionArtifact(active, cwd, agent.session.header)

      const generation = state.session.generation + 1
      const replacement: MomentQSessionRecord = {
        id: String(sessionIdFor(identity, generation)),
        presetId: PRESET_ID,
        instructions: resolveSessionInstructions({
          defaultInstructions: this.defaultInstructions,
          ...(sessionInstructions === undefined ? {} : { requestedInstructions: sessionInstructions }),
          maxInstructionsLength: this.maxInstructionsLength,
        }),
        createdAt: new Date().toISOString(),
      }
      const next = this.retire(state, active, disposition, replacement)
      await writeState(cwd, next)
      await this.ensureAgent(replacement, cwd)
      return {
        contentKey: contentKey(identity),
        previousSessionId: SessionId(active.id),
        sessionId: SessionId(replacement.id),
        cwd,
      }
    })
  }

  private async activate(
    cwd: string,
    state: MomentQState,
    requestedInstructions?: string,
  ): Promise<MomentQState> {
    const generation = state.session.generation + 1
    const active: MomentQSessionRecord = {
      id: String(sessionIdFor(state.identity, generation)),
      presetId: PRESET_ID,
      instructions: resolveSessionInstructions({
        defaultInstructions: this.defaultInstructions,
        ...(requestedInstructions === undefined ? {} : { requestedInstructions }),
        maxInstructionsLength: this.maxInstructionsLength,
      }),
      createdAt: new Date().toISOString(),
    }
    return await writeState(cwd, {
      ...state,
      session: { ...state.session, generation, active },
    })
  }

  private retire(
    state: MomentQState,
    active: MomentQSessionRecord,
    disposition: 'archived' | 'deleted',
    replacement: MomentQSessionRecord | null,
  ): MomentQState {
    return {
      ...state,
      session: {
        generation: replacement === null ? state.session.generation : state.session.generation + 1,
        active: replacement,
        retired: [...state.session.retired, {
          ...active,
          generation: state.session.generation,
          disposition,
          retiredAt: new Date().toISOString(),
        }],
      },
    }
  }

  private requireActive(state: MomentQState): MomentQSessionRecord {
    if (state.session.active === null) throw new Error('MomentQ content has no active Session')
    return state.session.active
  }

  private assertIdentity(identity: ContentIdentity, state: MomentQState): void {
    if (contentKey(identity) !== contentKey(state.identity)) {
      throw new Error('MomentQ state identity does not match the requested content')
    }
  }

  private async ensureAgent(record: MomentQSessionRecord, cwd: string): Promise<Agent> {
    const id = SessionId(record.id)
    const live = this.ctx.agents.get(id)
    if (live !== undefined) {
      sameSessionRecord(record, live.session.header, cwd)
      return live
    }

    const stored = (await this.ctx.sessionPersistence.list()).find(header => header.id === id)
    const setup = async (agentCtx: Context): Promise<void> => {
      const agentPresets = this.ctx.get('agentPresets')
      if (agentPresets === undefined) throw new Error('MomentQ requires the agent presets service')
      void await agentPresets.mount(agentCtx, PRESET_ID)
    }
    let handle: AgentHandle
    if (stored !== undefined) {
      const inspected = await this.ctx.sessionPersistence.inspect(id)
      sameSessionRecord(record, inspected.meta, cwd)
      handle = await this.ctx.agents.resume({
        resumeSessionId: id,
        agentOptions: { provider: PROVIDER, model: MODEL },
        setup,
      })
    } else {
      handle = await this.ctx.agents.create({
        sessionId: id,
        meta: { cwd, agentPreset: PRESET_ID },
        agentOptions: { provider: PROVIDER, model: MODEL },
        setup,
      })
    }
    this.handles.set(record.id, handle)
    return handle.agent
  }

  private async validateStoredSession(record: MomentQSessionRecord, cwd: string): Promise<void> {
    const id = SessionId(record.id)
    const live = this.ctx.agents.get(id)
    if (live !== undefined) {
      sameSessionRecord(record, live.session.header, cwd)
      return
    }
    const stored = (await this.ctx.sessionPersistence.list()).find(header => header.id === id)
    if (stored === undefined) return
    sameSessionRecord(record, (await this.ctx.sessionPersistence.inspect(id)).meta, cwd)
  }

  private async stopOwnedAgent(agent: Agent): Promise<void> {
    const id = String(agent.id)
    const handle = this.handles.get(id)
    if (handle === undefined || handle.agent !== agent) {
      throw new Error(`MomentQ does not own live Session "${id}"`)
    }
    if (agent.status !== 'idle') agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    await this.ctx.sessions.flush(agent.session)
    await handle.dispose()
    this.handles.delete(id)
  }

  private async removeSessionArtifact(
    record: MomentQSessionRecord,
    cwd: string,
    knownHeader?: SessionHeader,
  ): Promise<void> {
    const id = SessionId(record.id)
    let header = knownHeader
    if (header === undefined) {
      header = (await this.ctx.sessionPersistence.list()).find(item => item.id === id)
    }
    if (header === undefined) return
    sameSessionRecord(record, header, cwd)
    const location = this.ctx.sessionPersistence.locate(header)
    if (location === undefined) return
    if (location.kind !== 'jsonl') throw new Error(`cannot delete unsupported Session artifact kind "${location.kind}"`)
    const lexicalDirectory = strictChild(this.dshSessionsRoot, dirname(location.path), 'DSH Session directory')
    const segments = relative(this.dshSessionsRoot, lexicalDirectory).split(sep).filter(Boolean)
    if (segments.length < 2) throw new Error('DSH Session directory is not session-owned')
    let sessionDirectory: string
    try {
      sessionDirectory = await canonicalStrictChild(this.dshSessionsRoot, lexicalDirectory, 'DSH Session directory')
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return
      throw error
    }
    await rm(sessionDirectory, { recursive: true, force: true })
  }

  private async forContent<T>(
    identity: ContentIdentity,
    operation: () => Promise<T>,
    coalesceEnsure = false,
  ): Promise<T> {
    const key = contentKey(identity)
    let queue = this.operations.get(key)
    if (coalesceEnsure && queue?.pendingEnsure !== undefined) return await queue.pendingEnsure as T
    if (queue === undefined) {
      queue = { tail: Promise.resolve() }
      this.operations.set(key, queue)
    }
    if (!coalesceEnsure) queue.pendingEnsure = undefined
    const current = queue.tail.catch(() => {}).then(operation)
    queue.tail = current.then(() => undefined, () => undefined)
    if (coalesceEnsure) queue.pendingEnsure = current
    const tail = queue.tail
    void tail.finally(() => {
      const active = this.operations.get(key)
      if (active?.tail !== tail) return
      if (active.pendingEnsure === current) active.pendingEnsure = undefined
      if (active.pendingEnsure === undefined) this.operations.delete(key)
    })
    return await current
  }
}

export default MomentQService
