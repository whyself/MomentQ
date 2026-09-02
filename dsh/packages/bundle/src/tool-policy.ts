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

function formatTimestamp(totalSeconds: number): string {
  const whole = Math.max(0, Math.round(totalSeconds))
  const h = Math.floor(whole / 3600)
  const m = Math.floor((whole % 3600) / 60)
  const s = whole % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}

/**
 * Prepend a seek-renderer-ready [MM:SS–MM:SS] stamp to a transcript.jsonl
 * row. The model previously had to convert the row's raw seconds into
 * MM:SS itself and kept failing ([240–268] instead of [04:00–04:28], which
 * the seek-button renderer then could not match). With the stamp inline it
 * copies verbatim — no arithmetic left to get wrong.
 */
function annotateTranscriptLine(line: string): string {
  // Fast path: the line is complete JSON.
  try {
    const row = JSON.parse(line) as { start?: unknown; end?: unknown; text?: unknown }
    if (typeof row.start === 'number' && typeof row.end === 'number' && typeof row.text === 'string') {
      return `[${formatTimestamp(row.start)}–${formatTimestamp(row.end)}] ${row.text}`
    }
    return line
  } catch { /* fall through to the regex path */ }
  // The read/grep tools truncate long lines; the truncated JSON cannot
  // parse, but the transcript's shape is fixed — extract the fields with a
  // tolerant regex so every row still carries its formatted stamp.
  const match = /"start":\s*([\d.]+)\s*,\s*"end":\s*([\d.]+)(?:[\s\S]*?"text":\s*"((?:[^"\\]|\\.)*)")?/.exec(line)
  if (match !== null) {
    const start = Number(match[1])
    const end = Number(match[2])
    const text = (match[3] ?? '').replace(/\\n/g, ' ').replace(/\\/g, '').trim()
    return `[${formatTimestamp(start)}–${formatTimestamp(end)}] ${text}`
  }
  return line
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
  resolveArgs: (args: unknown, exec: ToolRunContext) => Promise<Record<string, unknown>>,
  /** Post-execute transform: annotate transcript lines with formatted times. */
  transformOutput?: (result: unknown) => unknown,
): void {
  ctx.tools.register({
    ...original,
    description,
    parameters,
    async execute(args, exec) {
      assertAbsent(args, ['path', 'file_path'])
      const result = await original.execute(await resolveArgs(args, exec), exec)
      return transformOutput === undefined ? result : transformOutput(result)
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

/** Annotate every transcript line in a grep/read result (tolerant of shape). */
function annotateLines(value: unknown, field: 'line' | 'text'): unknown {
  if (typeof value !== 'object' || value === null) return value
  const record = value as Record<string, unknown>
  const key = field === 'line' ? 'matches' : 'lines'
  if (!Array.isArray(record[key])) return value
  record[key] = (record[key] as Array<Record<string, unknown>>).map(entry => {
    const raw = entry[field]
    return typeof raw === 'string' ? { ...entry, [field]: annotateTranscriptLine(raw) } : entry
  })
  return value
}

/** Restrict every Agent joined to this Preset to its own exact transcript. */
export function apply(ctx: Context): void {
  const grep = requiredTool(ctx, 'grep')
  const read = requiredTool(ctx, 'read')

  ctx.tools.restrict({ allow: [...ALLOWED_TOOLS] })
  shadow(
    ctx,
    read,
    'Read a line window from the current video or live transcript. Every transcript row is prefixed with its [MM:SS–MM:SS] video timestamp — cite these verbatim. The transcript file cannot be changed.',
    withoutParameter(read.parameters, ['file_path']),
    async (args, exec) => ({ ...(args as Record<string, unknown>), file_path: await transcriptPath(ctx, exec) }),
    result => annotateLines(result, 'text'),
  )
  shadow(
    ctx,
    grep,
    'Search the current video or live transcript with a regular expression. Returns matching lines with line numbers and their [MM:SS–MM:SS] video timestamps — cite those verbatim. The transcript file cannot be changed.',
    withoutParameter(grep.parameters, ['path', 'include']),
    async (args, exec) => ({ ...(args as Record<string, unknown>), path: await transcriptPath(ctx, exec) }),
    result => annotateLines(result, 'line'),
  )

  for (const [toolName, order] of [
    ['read', 100], ['write', 101], ['edit', 102], ['glob', 103], ['grep', 104],
  ] as const) {
    ctx.systemPrompt.section({ name: `tool:${toolName}`, order, text: '' })
  }
}

export default { name, inject, apply }
