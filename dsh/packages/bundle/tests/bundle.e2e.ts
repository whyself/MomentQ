import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import MomentQService from '../src/index.ts'

const PERSONA = '你是 MomentQ（刻问），一个能够使用当前视频或直播上下文的通用助手。'
const roots: string[] = []
const originalDshHome = process.env.DSH_HOME

afterEach(async () => {
  if (originalDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalDshHome
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function isStrictChild(parent: string, target: string): boolean {
  const suffix = relative(resolve(parent), resolve(target))
  return suffix !== '' && suffix !== '..' && !suffix.startsWith('..\\')
    && !suffix.startsWith('../') && !isAbsolute(suffix)
}

class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function nativeTool(name: 'grep' | 'read'): ToolDefinition {
  const pathName = name === 'grep' ? 'path' : 'file_path'
  return {
    name,
    description: `native ${name}`,
    parameters: {
      type: 'object',
      properties: {
        ...(name === 'grep' ? { pattern: { type: 'string' } } : {}),
        [pathName]: { type: 'string' },
      },
      required: name === 'grep' ? ['pattern', pathName] : [pathName],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async args => args,
  }
}

interface Runtime {
  ctx: Context
  adapter: RecordingAdapter
}

async function disposeRuntime(ctx: Context): Promise<void> {
  await (ctx as Context & { fiber: { dispose(): Promise<void> } }).fiber.dispose()
}

async function boot(root: string): Promise<Runtime> {
  process.env.DSH_HOME = join(root, 'dsh-home')
  const ctx = new Context()
  await ctx.plugin(Loader, { baseUrl: new URL('../', import.meta.url).href })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, {
    root: join(root, 'dsh-home', 'sessions'),
    compression: 'none',
    writeBatchMaxDelayMs: 1,
  })
  await ctx.plugin(LocalFileSystem, { cwd: root })
  ctx.tools.register(nativeTool('grep'))
  ctx.tools.register(nativeTool('read'))

  const adapter = new RecordingAdapter()
  ctx.llm.registerAdapter(['deepseek-official'], adapter)
  await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })

  ctx.provide('workspaceRegistry', { archiveSession: async () => {} } as never)
  await ctx.plugin(AgentPresets, {
    default: 'momentq',
    roots: [{ path: fileURLToPath(new URL('../presets/', import.meta.url)), trust: 'system' }],
    includeUserRoot: false,
  })
  await ctx.plugin(MomentQService, { root })
  return { ctx, adapter }
}

const request = {
  identity: { kind: 'vod', bvid: 'BV1xx', cid: '42' } as const,
  metadata: {
    title: '线性代数',
    description: '特征值与特征向量',
    creator: { name: '讲师' },
    tags: ['知识'],
  },
  sessionInstructions: '公式出现时说明符号含义。',
}

async function ask(runtime: Runtime, sessionId: string): Promise<GenerateOptions> {
  const agent = runtime.ctx.agents.get(sessionId as never)
  if (agent === undefined) throw new Error(`missing live Agent ${sessionId}`)
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: '总结当前内容' }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
  await runtime.ctx.sessions.flush(agent.session)
  const recorded = runtime.adapter.requests.at(-1)
  if (recorded === undefined) throw new Error('mock LLM did not receive a request')
  return recorded
}

describe.sequential('assembled MomentQ Bundle runtime', () => {
  it('keeps runtime-context snapshots out of the conversation history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'momentq-bundle-history-'))
    roots.push(root)

    const runtime = await boot(root)
    await runtime.ctx.momentq.ensureContent(request)
    await runtime.ctx.momentq.submitMessage(request.identity, '解释一下特征值')
    // The agent loop projects dynamic runtime context as user messages with
    // this prefix; a live projection lands the same way.
    await runtime.ctx.momentq.submitMessage(
      request.identity,
      'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nCurrent DSH file policy: read-only.',
    )
    const history = await runtime.ctx.momentq.getHistory(request.identity)
    expect(history.map(entry => entry.role)).toEqual(['user', 'assistant', 'assistant'])
    expect(history.some(entry => entry.text.startsWith('Current runtime context'))).toBe(false)
    await disposeRuntime(runtime.ctx)
  })

  it('persists one composed Agent and resumes it without credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'momentq-bundle-e2e-'))
    roots.push(root)

    const firstRuntime = await boot(root)
    const first = await firstRuntime.ctx.momentq.ensureContent(request)
    await writeFile(join(first.cwd, 'transcript.jsonl'), '{"start":0,"end":1,"text":"matrix"}\n', 'utf8')
    const duplicate = await firstRuntime.ctx.momentq.ensureContent({
      ...request,
      sessionInstructions: '不得覆盖第一次指令。',
    })
    expect(duplicate).toEqual({ ...first, created: false })

    const firstRequest = await ask(firstRuntime, String(first.sessionId))
    expect(firstRequest.system).toContain(PERSONA)
    expect(firstRequest.system).toContain(request.sessionInstructions)
    expect(firstRequest.system).toContain('"title": "线性代数"')
    expect(firstRequest.system).toContain('"creator": "讲师"')
    expect(firstRequest.tools?.map(tool => tool.name).sort()).toEqual(['grep', 'read'])

    const submitted = await firstRuntime.ctx.momentq.submitMessage(request.identity, '解释一下特征值')
    expect(submitted).toMatchObject({
      contentKey: first.contentKey,
      sessionId: first.sessionId,
      replies: [{ text: 'ok' }],
    })

    const streamedEvents: string[] = []
    const streamed = await firstRuntime.ctx.momentq.streamMessage(
      request.identity,
      '流式解释一下特征值',
      [],
      event => { streamedEvents.push(event.type) },
    )
    expect(streamed.replies).toEqual([{ id: expect.any(String), text: 'ok' }])
    expect(streamedEvents).toEqual([
      'started', 'assistant-delta', 'assistant-message', 'complete',
    ])

    const firstAgent = firstRuntime.ctx.agents.get(first.sessionId)
    if (firstAgent === undefined) throw new Error('first Agent disappeared before persistence inspection')
    const artifact = firstRuntime.ctx.sessionPersistence.locate(firstAgent.session.header)
    expect(artifact?.kind).toBe('jsonl')
    if (artifact?.kind !== 'jsonl') throw new Error('expected JSONL Session persistence')
    expect(isStrictChild(join(root, 'dsh-home'), artifact.path)).toBe(true)
    expect(isStrictChild(join(root, 'content'), first.cwd)).toBe(true)

    await disposeRuntime(firstRuntime.ctx)

    const secondRuntime = await boot(root)
    const resumed = await secondRuntime.ctx.momentq.ensureContent(request)
    expect(resumed).toEqual({ ...first, created: false })
    const resumedAgent = secondRuntime.ctx.agents.get(resumed.sessionId)
    expect(resumedAgent?.session.events.length).toBeGreaterThan(0)

    const resumedRequest = await ask(secondRuntime, String(resumed.sessionId))
    expect(resumedRequest.system).toContain(request.sessionInstructions)
    expect(resumedRequest.system).not.toContain('不得覆盖第一次指令。')
    expect(resumedRequest.tools?.map(tool => tool.name).sort()).toEqual(['grep', 'read'])

    const topLevel = (await readdir(root)).sort()
    expect(topLevel).toEqual(['content', 'dsh-home'])
    await disposeRuntime(secondRuntime.ctx)
  })
})
