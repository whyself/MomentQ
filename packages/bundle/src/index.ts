/** MomentQ Host service: content state, DSH Session routing, and lifecycle management. */

import { mkdir, rm } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionHeader, type SessionId as DshSessionId } from '@deepseek-ai/dsh-session'
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
  readState,
  resolveSessionInstructions,
  writeState,
  type MomentQSessionRecord,
  type MomentQState,
} from './state.ts'

export type { ContentIdentity, ContentMetadata } from './content.ts'
export type { MomentQState } from './state.ts'

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

/** Host plugin configuration. */
export interface Config {
  root: string
  defaultInstructions?: string | undefined
  maxInstructionsLength?: number | undefined
}

const DEFAULT_INSTRUCTIONS = '直接、自然地完成用户的请求。需要视频上下文时使用提供的字幕、画面和工具。'
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
  static inject = ['agents', 'sessions', 'sessionPersistence', 'workspaceRegistry', 'agentPresets']

  static Config = z.object({
    root: z.string().required(),
    defaultInstructions: z.string().default(DEFAULT_INSTRUCTIONS),
    maxInstructionsLength: z.number().default(4000),
  })

  readonly root: string
  readonly contentRoot: string
  readonly dshHome: string
  readonly dshSessionsRoot: string
  readonly presetRoot = fileURLToPath(new URL('../presets/', import.meta.url))

  private readonly defaultInstructions: string
  private readonly maxInstructionsLength: number
  private readonly operations = new Map<string, Promise<unknown>>()
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
    if (resolve(configuredDshHome) !== this.dshHome) {
      throw new Error(`DSH_HOME must equal "${this.dshHome}"`)
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
  }

  /** Create or resume the one active Session for a content identity. */
  async ensureContent(request: EnsureContentRequest): Promise<EnsureContentResult> {
    return await this.forContent(request.identity, async () => {
      const cwd = contentDirectory(this.root, request.identity)
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
    })
  }

  /** Read one existing content state. */
  async getContent(identity: ContentIdentity): Promise<MomentQState> {
    return await this.forContent(identity, async () => {
      const state = await readState(contentDirectory(this.root, identity))
      this.assertIdentity(identity, state)
      return state
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
      const ids = [
        ...(state.session.active === null ? [] : [state.session.active.id]),
        ...state.session.retired.filter(item => item.disposition !== 'deleted').map(item => item.id),
      ]
      for (const id of ids) {
        await this.removeSessionArtifact(
          SessionId(id),
          activeHeader?.id === SessionId(id) ? activeHeader : undefined,
        )
      }
      const target = strictChild(this.contentRoot, cwd, 'content directory')
      await rm(target, { recursive: true, force: true })
      return { deleted: true }
    })
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
      if (disposition === 'deleted') await this.removeSessionArtifact(SessionId(active.id), agent.session.header)

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
      void await this.ctx.agentPresets.mount(agentCtx, PRESET_ID)
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

  private async removeSessionArtifact(id: DshSessionId, knownHeader?: SessionHeader): Promise<void> {
    let header = knownHeader
    if (header === undefined) {
      header = (await this.ctx.sessionPersistence.list()).find(item => item.id === id)
    }
    if (header === undefined) return
    const location = this.ctx.sessionPersistence.locate(header)
    if (location === undefined) return
    if (location.kind !== 'jsonl') throw new Error(`cannot delete unsupported Session artifact kind "${location.kind}"`)
    const sessionDirectory = strictChild(this.dshSessionsRoot, dirname(location.path), 'DSH Session directory')
    await rm(sessionDirectory, { recursive: true, force: true })
  }

  private async forContent<T>(identity: ContentIdentity, operation: () => Promise<T>): Promise<T> {
    const key = contentKey(identity)
    const existing = this.operations.get(key) as Promise<T> | undefined
    if (existing !== undefined) return await existing
    const current = operation().finally(() => {
      if (this.operations.get(key) === current) this.operations.delete(key)
    })
    this.operations.set(key, current)
    return await current
  }
}

export default MomentQService
