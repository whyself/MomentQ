import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { CallId } from '@deepseek-ai/dsh-llm'
import { createScope, scopeOf, type Scope } from '@deepseek-ai/dsh-scope'
import type { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import * as TranscriptToolPolicy from '../src/tool-policy.ts'

const roots: string[] = []
const signal = new AbortController().signal

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function tool(name: string, properties: Record<string, unknown>): ToolDefinition {
  return {
    name,
    description: `global ${name}`,
    parameters: { type: 'object', properties, additionalProperties: true },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async args => args,
  }
}

async function harness(): Promise<{ ctx: Context; scope: Scope; agent: Agent; cwd: string }> {
  const root = await mkdtemp(join(tmpdir(), 'momentq-tools-'))
  roots.push(root)
  const cwd = join(root, 'content')
  await mkdir(cwd)
  await writeFile(join(cwd, 'transcript.jsonl'), '{"start":0,"end":1,"text":"matrix"}\n')
  await writeFile(join(root, 'secret.txt'), 'secret')

  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalFileSystem, { cwd })
  ctx.tools.register(tool('grep', { pattern: { type: 'string' }, path: { type: 'string' } }))
  ctx.tools.register(tool('read', {
    file_path: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' },
  }))
  ctx.tools.register(tool('write', { file_path: { type: 'string' } }))
  for (const [name, order] of [['read', 100], ['write', 101], ['edit', 102], ['glob', 103], ['grep', 104]] as const) {
    ctx.systemPrompt.section({ name: `tool:${name}`, order, text: `global guidance ${name}` })
  }

  const agent = {
    id: 'momentq-session' as SessionId,
    session: { header: { cwd } },
  } as Agent
  const scope = createScope(ctx, agent)
  Object.defineProperty(scope.ctx, 'agent', { value: agent, configurable: true })
  await scope.ctx.plugin(TranscriptToolPolicy)
  return { ctx, scope, agent, cwd }
}

async function execute(h: Awaited<ReturnType<typeof harness>>, name: string, args: Record<string, unknown>) {
  return await h.ctx.tools.execute({
    signal,
    callId: CallId(`call-${name}`),
    name,
    arguments: args,
    agent: h.agent,
  })
}

describe('MomentQ transcript tool policy', () => {
  it('exposes only grep and read without caller-controlled paths', async () => {
    const h = await harness()
    const schemas = h.ctx.tools.schemas(h.agent)
    expect(schemas.map(schema => schema.name).sort()).toEqual(['grep', 'read'])
    expect(schemas.find(schema => schema.name === 'grep')?.parameters.properties).not.toHaveProperty('path')
    expect(schemas.find(schema => schema.name === 'read')?.parameters.properties).not.toHaveProperty('file_path')
    expect(schemas.every(schema => schema.parameters.additionalProperties === false)).toBe(true)
  })

  it('delegates both tools to the exact transcript file', async () => {
    const h = await harness()
    const grep = await execute(h, 'grep', { pattern: 'matrix' })
    const read = await execute(h, 'read', { offset: 1, limit: 20 })
    expect(grep.isError).toBe(false)
    expect(grep.content[0]).toMatchObject({
      type: 'text', text: expect.stringContaining('transcript.jsonl'),
    })
    expect(read.isError).toBe(false)
    expect(read.content[0]).toMatchObject({
      type: 'text', text: expect.stringContaining('transcript.jsonl'),
    })
  })

  it('rejects removed tools and attempts to supply another file', async () => {
    const h = await harness()
    expect((await execute(h, 'write', { file_path: 'x' })).isError).toBe(true)
    expect((await execute(h, 'read', { file_path: '../secret.txt' })).isError).toBe(true)
    expect((await execute(h, 'grep', { pattern: 'secret', path: '../secret.txt' })).isError).toBe(true)
  })

  it('suppresses inherited filesystem guidance in the Agent scope', async () => {
    const h = await harness()
    const assembly = await h.ctx.systemPrompt.assemble({ scope: scopeOf(h.scope.ctx)! })
    expect(assembly.sections.filter(section => section.name.startsWith('tool:'))).toEqual([
      { name: 'tool:read', text: '' },
      { name: 'tool:write', text: '' },
      { name: 'tool:edit', text: '' },
      { name: 'tool:glob', text: '' },
      { name: 'tool:grep', text: '' },
    ])
  })

  it('fails setup without a Session cwd', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: process.cwd() })
    ctx.tools.register(tool('grep', {}))
    ctx.tools.register(tool('read', {}))
    Object.defineProperty(ctx, 'agent', { value: { id: 'x', session: { header: {} } }, configurable: true })
    await expect(ctx.plugin(TranscriptToolPolicy)).rejects.toThrow(/cwd/)
  })
})

