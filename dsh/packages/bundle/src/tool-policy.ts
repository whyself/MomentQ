/** Agent-scoped exact-file wrappers over DSH's native grep and read tools. */

import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'

export const name = 'momentq-transcript-tool-policy'
export const inject = ['tools', 'systemPrompt', 'fs']

const ALLOWED_TOOLS = ['grep', 'read'] as const
/** Hard cap on JS grep matches; the native renderer caps the display anyway. */
const MAX_MATCHES = 5_000

function requiredTool(ctx: Context, toolName: typeof ALLOWED_TOOLS[number]): ToolDefinition {
  const definition = ctx.tools.get(toolName)
  if (definition === undefined) {
    throw new Error(`momentq tool policy requires native tool "${toolName}"`)
  }
  return definition
}

function withoutParameter(parameters: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const cloned = structuredClone(parameters)
  const properties = cloned.properties
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
    throw new Error(`momentq tool policy cannot constrain schema without object properties (${keys.join(',')})`)
  }
  for (const key of keys) delete (properties as Record<string, unknown>)[key]
  if (Array.isArray(cloned.required)) cloned.required = cloned.required.filter(value => !keys.includes(value))
  cloned.additionalProperties = false
  return cloned
}

function assertAbsent(args: unknown, keys: string[]): void {
  if (typeof args !== 'object' || args === null) return
  for (const key of keys) {
    if (Object.hasOwn(args, key)) {
      throw new Error(`MomentQ transcript tool does not accept ${key}`)
    }
  }
}

async function transcriptPath(ctx: Context, exec: ToolRunContext): Promise<string> {
  const agent = exec.agent
  if (agent === undefined) throw new Error('momentq tool policy requires an Agent execution')
  const cwd = agent.session.header.cwd
  if (cwd === undefined) throw new Error('momentq tool policy requires a Session cwd')
  const root = await ctx.fs.resolve(cwd, { signal: exec.signal })
  const transcript = await ctx.fs.resolve('transcript.jsonl', { cwd, signal: exec.signal })
  if (!ctx.fs.contains(root, transcript)) {
    throw new Error('MomentQ transcript path escapes the Session cwd')
  }
  return ctx.fs.processPath(transcript)
}

/**
 * Replace a native tool with a transcript-locked view of it.
 *
 * The model-facing schema has the path parameter stripped (the file is fixed
 * by the Session); `resolveArgs` injects the real path for execution. The
 * native output.render of `read` RE-PARSES the original call arguments
 * (args.file_path) — with the parameter stripped from the schema that call
 * crashed with "Cannot read properties of undefined (reading 'trim')" and
 * the model saw every read fail as a render error. Rehydrate the path from
 * the result (every result carries the resolved `path`) before rendering.
 */
function shadow(
  ctx: Context,
  original: ToolDefinition,
  description: string,
  parameters: Record<string, unknown>,
  run: {
    resolveArgs: (args: unknown, exec: ToolRunContext) => Promise<Record<string, unknown>>
    /** Full execute replacement; defaults to original.execute(resolvedArgs). */
    execute?: (args: Record<string, unknown>, transcript: string) => Promise<unknown>
  },
): void {
  ctx.tools.register({
    ...original,
    description,
    parameters,
    async execute(args, exec) {
      const transcript = await transcriptPath(ctx, exec)
      assertAbsent(args, ['path', 'file_path'])
      if (run.execute !== undefined) {
        return await run.execute({ ...(args as Record<string, unknown>) }, transcript)
      }
      return await original.execute(await run.resolveArgs(args, exec), exec)
    },
    ...(original.output === undefined ? {} : {
      output: {
        ...original.output,
        render: (args: unknown, value: unknown) => {
          const path = typeof value === 'object' && value !== null && typeof (value as { path?: unknown }).path === 'string'
            ? (value as { path: string }).path
            : 'transcript.jsonl'
          return original.output?.render?.({ ...(args as Record<string, unknown>), file_path: path, path }, value as never)
        },
      },
    }),
  })
}

/** Restrict every Agent joined to this Preset to its own exact transcript. */
export function apply(ctx: Context): void {
  const grep = requiredTool(ctx, 'grep')
  const read = requiredTool(ctx, 'read')

  ctx.tools.restrict({ allow: [...ALLOWED_TOOLS] })
  shadow(
    ctx,
    read,
    'Read a line window from the current video or live transcript. The transcript file cannot be changed.',
    withoutParameter(read.parameters, ['file_path']),
    { resolveArgs: async (args, exec) => ({ ...(args as Record<string, unknown>), file_path: await transcriptPath(ctx, exec) }) },
  )
  shadow(
    ctx,
    grep,
    'Search the current video or live transcript with a regular expression. Returns matching lines with line numbers. The transcript file cannot be changed.',
    withoutParameter(grep.parameters, ['path', 'include']),
    {
      // The native grep spawns the packaged ripgrep binary through the host's
      // sandboxed subprocess seam, which fails on this Windows setup
      // (exit 0xC0000142). The transcript is one small file: a plain JS scan
      // is equivalent and cannot fail to spawn.
      execute: async (args, transcript) => {
        const pattern = typeof args.pattern === 'string' ? args.pattern : ''
        let regex: RegExp
        try {
          regex = new RegExp(pattern)
        } catch (error) {
          throw new Error(`invalid pattern: ${error instanceof Error ? error.message : String(error)}`)
        }
        const text = await readFile(transcript, 'utf8')
        const matches: Array<{ path: string; lineNumber: number; line: string }> = []
        for (const [index, raw] of text.split('\n').entries()) {
          const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
          if (regex.test(line)) {
            matches.push({ path: 'transcript.jsonl', lineNumber: index + 1, line })
            if (matches.length >= MAX_MATCHES) break
          }
        }
        return { matches }
      },
      resolveArgs: async (args, exec) => ({ ...(args as Record<string, unknown>), path: await transcriptPath(ctx, exec) }),
    },
  )

  for (const [toolName, order] of [
    ['read', 100], ['write', 101], ['edit', 102], ['glob', 103], ['grep', 104],
  ] as const) {
    ctx.systemPrompt.section({ name: `tool:${toolName}`, order, text: '' })
  }
}

export default { name, inject, apply }
