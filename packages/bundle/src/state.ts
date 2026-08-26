/** Versioned MomentQ content state and atomic persistence. */

import { open, mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import writeFileAtomic from 'write-file-atomic'
import { z } from 'zod'
import { contentKey, sessionIdFor, type ContentIdentity, type ContentMetadata } from './content.ts'

const isoInstant = z.string().refine(value => Number.isFinite(Date.parse(value)), 'invalid timestamp')

/** Runtime schema for one supported Bilibili identity. */
export const contentIdentitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('vod'), bvid: z.string(), cid: z.string() }).strict(),
  z.object({ kind: z.literal('live'), canonicalRoomId: z.string(), liveStartTime: isoInstant }).strict(),
]) satisfies z.ZodType<ContentIdentity>

/** Runtime schema for the metadata snapshot owned by MomentQ. */
export const contentMetadataSchema = z.object({
  title: z.string().trim().min(1).max(500),
  description: z.string().max(20_000).optional(),
  creator: z.object({
    id: z.string().max(100).optional(),
    name: z.string().trim().min(1).max(200),
  }).strict(),
  part: z.object({
    number: z.number().int().positive(),
    title: z.string().max(500).optional(),
  }).strict().optional(),
  durationSeconds: z.number().finite().nonnegative().optional(),
  publishedAt: isoInstant.optional(),
  tags: z.array(z.string().max(200)).max(100).optional(),
  area: z.string().max(500).optional(),
  endedAt: isoInstant.optional(),
}).strict() satisfies z.ZodType<ContentMetadata>

const sessionRecordSchema = z.object({
  id: z.string().min(1),
  presetId: z.literal('momentq'),
  instructions: z.string().min(1).max(65_536),
  createdAt: isoInstant,
}).strict()

const retiredSessionSchema = sessionRecordSchema.extend({
  generation: z.number().int().nonnegative(),
  disposition: z.enum(['archived', 'deleted']),
  retiredAt: isoInstant,
}).strict()

/** Current serialized state schema. */
export const momentQStateSchema = z.object({
  schemaVersion: z.literal(1),
  identity: contentIdentitySchema,
  metadata: contentMetadataSchema,
  transcript: z.object({
    source: z.enum(['none', 'bilibili', 'asr']),
    coveredRanges: z.array(z.object({
      start: z.number().finite().nonnegative(),
      end: z.number().finite().nonnegative(),
    }).strict().refine(range => range.end >= range.start, 'coverage end precedes start')),
    updatedAt: isoInstant.optional(),
  }).strict(),
  session: z.object({
    generation: z.number().int().nonnegative(),
    active: sessionRecordSchema.nullable(),
    retired: z.array(retiredSessionSchema),
  }).strict(),
}).strict()

/** Durable content state. */
export type MomentQState = z.infer<typeof momentQStateSchema>
export type MomentQSessionRecord = z.infer<typeof sessionRecordSchema>
export type MomentQRetiredSession = z.infer<typeof retiredSessionSchema>

/** Missing state is distinct from corrupt state for API error mapping. */
export class MomentQStateNotFoundError extends Error {}

const stateOperations = new Map<string, Promise<void>>()

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

async function serialized<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  const key = resolve(directory)
  const predecessor = stateOperations.get(key) ?? Promise.resolve()
  const current = predecessor.catch(() => {}).then(operation)
  const tail = current.then(() => undefined, () => undefined)
  stateOperations.set(key, tail)
  try {
    return await current
  } finally {
    if (stateOperations.get(key) === tail) stateOperations.delete(key)
  }
}

function parseState(text: string, path: string): MomentQState {
  let decoded: unknown
  try {
    decoded = JSON.parse(text)
  } catch (error) {
    throw new Error(`invalid JSON in MomentQ state "${path}"`, { cause: error })
  }
  const parsed = momentQStateSchema.safeParse(decoded)
  if (!parsed.success) {
    throw new Error(`invalid MomentQ state "${path}": ${z.prettifyError(parsed.error)}`)
  }
  return parsed.data
}

async function readStateOrUndefined(directory: string): Promise<MomentQState | undefined> {
  const path = join(resolve(directory), 'state.json')
  try {
    return parseState(await readFile(path, 'utf8'), path)
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined
    throw error
  }
}

async function publishState(directory: string, state: MomentQState): Promise<MomentQState> {
  const parsed = momentQStateSchema.safeParse(state)
  if (!parsed.success) throw new Error(`invalid MomentQ state: ${z.prettifyError(parsed.error)}`)
  await writeFileAtomic(join(resolve(directory), 'state.json'), `${JSON.stringify(parsed.data, null, 2)}\n`, {
    encoding: 'utf8',
  })
  return parsed.data
}

/** Resolve and length-check the frozen instructions for a newly created Session. */
export function resolveSessionInstructions(input: {
  defaultInstructions: string
  requestedInstructions?: string
  maxInstructionsLength: number
}): string {
  if (!Number.isSafeInteger(input.maxInstructionsLength) || input.maxInstructionsLength <= 0) {
    throw new Error('maxInstructionsLength must be a positive safe integer')
  }
  const requested = input.requestedInstructions?.trim()
  const value = requested === undefined || requested.length === 0
    ? input.defaultInstructions.trim()
    : requested
  if (value.length === 0) throw new Error('effective Session instructions must not be empty')
  if ([...value].length > input.maxInstructionsLength) {
    throw new Error(`Session instructions must contain at most ${input.maxInstructionsLength} Unicode code points`)
  }
  return value
}

/** Read and validate one existing content state. */
export async function readState(directory: string): Promise<MomentQState> {
  const state = await readStateOrUndefined(directory)
  if (state === undefined) throw new MomentQStateNotFoundError(`MomentQ state is missing in "${resolve(directory)}"`)
  return state
}

/** Atomically validate and replace one existing state document. */
export async function writeState(directory: string, state: MomentQState): Promise<MomentQState> {
  return await serialized(directory, async () => await publishState(directory, state))
}

/** Atomically read, transform, validate and replace one existing state document. */
export async function updateState(
  directory: string,
  update: (state: MomentQState) => MomentQState | Promise<MomentQState>,
): Promise<MomentQState> {
  return await serialized(directory, async () => {
    const current = await readStateOrUndefined(directory)
    if (current === undefined) {
      throw new MomentQStateNotFoundError(`MomentQ state is missing in "${resolve(directory)}"`)
    }
    return await publishState(directory, await update(current))
  })
}

/** Create or refresh one content state without changing its Session ownership. */
export async function ensureState(input: {
  directory: string
  identity: ContentIdentity
  metadata: ContentMetadata
  defaultInstructions: string
  requestedInstructions?: string
  maxInstructionsLength: number
}): Promise<{ state: MomentQState; created: boolean }> {
  return await serialized(input.directory, async () => {
    const directory = resolve(input.directory)
    await mkdir(directory, { recursive: true })
    const transcript = await open(join(directory, 'transcript.jsonl'), 'a')
    await transcript.close()

    const metadata = contentMetadataSchema.parse(input.metadata)
    const existing = await readStateOrUndefined(directory)
    if (existing !== undefined) {
      if (contentKey(existing.identity) !== contentKey(input.identity)) {
        throw new Error('existing MomentQ state identity does not match the requested content')
      }
      const state = await publishState(directory, { ...existing, metadata })
      return { state, created: false }
    }

    const instructions = resolveSessionInstructions(input)
    const createdAt = new Date().toISOString()
    const state = await publishState(directory, {
      schemaVersion: 1,
      identity: contentIdentitySchema.parse(input.identity),
      metadata,
      transcript: { source: 'none', coveredRanges: [] },
      session: {
        generation: 0,
        active: {
          id: String(sessionIdFor(input.identity, 0)),
          presetId: 'momentq',
          instructions,
          createdAt,
        },
        retired: [],
      },
    })
    return { state, created: true }
  })
}
