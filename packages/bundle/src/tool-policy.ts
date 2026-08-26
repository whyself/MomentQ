/** Agent-scoped exact-file wrappers over DSH's native grep and read tools. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'

export const name = 'momentq-transcript-tool-policy'
export const inject = ['tools', 'systemPrompt', 'fs']

const ALLOWED_TOOLS = ['grep', 'read'] as const

function requiredTool(ctx: Context, toolName: typeof ALLOWED_TOOLS[number]): ToolDefinition {
  const definition = ctx.tools.get(toolName)
  if (definition === undefined) {
    throw new Error(`momentq tool policy requires native tool "${toolName}"`)
  }
  return definition
}

function withoutParameter(parameters: Record<string, unknown>, key: string): Record<string, unknown> {
  const cloned = structuredClone(parameters)
  const properties = cloned.properties
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
    throw new Error(`momentq tool policy cannot constrain schema without object properties (${key})`)
  }
  delete (properties as Record<string, unknown>)[key]
  if (Array.isArray(cloned.required)) cloned.required = cloned.required.filter(value => value !== key)
  cloned.additionalProperties = false
  return cloned
}

function assertAbsent(args: unknown, key: string): void {
  if (typeof args === 'object' && args !== null && Object.hasOwn(args, key)) {
    throw new Error(`MomentQ transcript tool does not accept ${key}`)
  }
}

function shadow(
  ctx: Context,
  original: ToolDefinition,
  description: string,
  parameters: Record<string, unknown>,
  transform: (args: unknown, exec: ToolRunContext) => unknown | Promise<unknown>,
): void {
  ctx.tools.register({
    ...original,
    description,
    parameters,
    async execute(args, exec) {
      return await original.execute(await transform(args, exec), exec)
    },
  })
}

/** Restrict one Agent to native grep/read calls over its exact transcript. */
export async function apply(ctx: Context): Promise<void> {
  const agent = ctx.agent
  if (agent === undefined) throw new Error('momentq tool policy requires an Agent scope')
  const cwd = agent.session.header.cwd
  if (cwd === undefined) throw new Error('momentq tool policy requires a Session cwd')

  const root = await ctx.fs.resolve(cwd)
  const transcript = await ctx.fs.resolve('transcript.jsonl', { cwd })
  if (!ctx.fs.contains(root, transcript)) {
    throw new Error('MomentQ transcript path escapes the Session cwd')
  }
  const transcriptPath = ctx.fs.processPath(transcript)
  const grep = requiredTool(ctx, 'grep')
  const read = requiredTool(ctx, 'read')

  ctx.tools.restrict({ allow: [...ALLOWED_TOOLS] })
  shadow(
    ctx,
    grep,
    'Search the current video or live transcript. The transcript file cannot be changed.',
    withoutParameter(grep.parameters, 'path'),
    (args) => {
      assertAbsent(args, 'path')
      return { ...args as Record<string, unknown>, path: transcriptPath }
    },
  )
  shadow(
    ctx,
    read,
    'Read a line window from the current video or live transcript. The transcript file cannot be changed.',
    withoutParameter(read.parameters, 'file_path'),
    (args) => {
      assertAbsent(args, 'file_path')
      return { ...args as Record<string, unknown>, file_path: transcriptPath }
    },
  )

  for (const [toolName, order] of [
    ['read', 100], ['write', 101], ['edit', 102], ['glob', 103], ['grep', 104],
  ] as const) {
    ctx.systemPrompt.section({ name: `tool:${toolName}`, order, text: '' })
  }
}

export default apply

