/** Loopback-only JSON API over the same-process MomentQ Host service. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { EncodedImageAttachment } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { z } from 'zod'
import { contentIdentitySchema, contentMetadataSchema, MomentQStateNotFoundError } from './state.ts'

export const name = 'momentq-http-api'
export const inject = ['momentq', 'webServer', 'credentials']

const MAX_BODY_BYTES = 96 * 1024 * 1024

const ensureContentParams = z.object({
  identity: contentIdentitySchema,
  metadata: contentMetadataSchema,
  sessionInstructions: z.string().max(4000).optional(),
}).strict()

const identityParams = z.object({ identity: contentIdentitySchema }).strict()
const replaceParams = z.object({
  identity: contentIdentitySchema,
  sessionInstructions: z.string().max(4000).optional(),
}).strict()
// Images ride inline as canonical base64 (no data: prefix), mirroring the
// web composer's one-shot admission: the host persists them through the
// attachment store and references them from the message.
const encodedImageParams = z.object({
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  data: z.string().min(1),
  name: z.string().max(255).optional(),
}).strict()
const submitMessageParams = z.object({
  identity: contentIdentitySchema,
  text: z.string().trim().min(1).max(32_000),
  images: z.array(encodedImageParams).max(20).optional(),
}).strict()
const syncTranscriptParams = z.object({
  identity: contentIdentitySchema,
  source: z.enum(['bilibili', 'asr']),
  segments: z.array(z.object({
    start: z.number().finite().nonnegative(),
    end: z.number().finite().nonnegative(),
    text: z.string().trim().min(1).max(20_000),
  }).strict().refine(segment => segment.end >= segment.start)).max(100_000),
}).strict()
const streamMessageParams = submitMessageParams

/** Zod optionals carry explicit undefined; the wire type does not. */
function toEncodedImages(images: z.infer<typeof encodedImageParams>[] | undefined): EncodedImageAttachment[] | undefined {
  return images?.map(({ mediaType, data, name }) => ({ mediaType, data, ...(name === undefined ? {} : { name }) }))
}
const setModelApiKeyParams = z.object({
  apiKey: z.string()
    .min(1)
    .max(8192)
    .regex(/^[\x21-\x7e]+$/)
    .refine(value => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(value))
    .refine(value => !((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'")))),
}).strict()

const MODEL_API_KEY_REF = credentialRef('DEEPSEEK_API_KEY')

const requestSchema = z.object({
  method: z.enum([
    'ensureContent', 'getContent', 'getHistory', 'getTranscript', 'submitMessage', 'syncTranscript', 'clearTranscript', 'archiveSession', 'resetSession', 'deleteSession', 'deleteContent',
    'clearAllSessions', 'setModelApiKey',
  ]),
  params: z.unknown(),
}).strict()

const clearAllSessionsParams = z.object({}).strict()

type ApiErrorCode = 'invalid-request' | 'content-not-found' | 'session-conflict' | 'internal'

function allowedOrigin(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  try {
    const origin = new URL(value)
    const extension = origin.protocol === 'chrome-extension:' || origin.protocol === 'moz-extension:'
    const loopbackPreview = origin.protocol === 'http:'
      && (origin.hostname === '127.0.0.1' || origin.hostname === 'localhost')
    return extension || loopbackPreview ? value : undefined
  } catch {
    return undefined
  }
}

function corsHeaders(origin: string | undefined): Record<string, string> {
  return origin === undefined
    ? {}
    : {
        'access-control-allow-origin': origin,
        vary: 'Origin',
      }
}

function sendJson(res: ServerResponse, status: number, body: unknown, origin?: string): void {
  const content = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(content),
    'cache-control': 'no-store',
    ...corsHeaders(origin),
  })
  res.end(content)
}

async function bodyOf(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body exceeds 1 MiB')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch (error) {
    throw new Error('request body is not valid JSON', { cause: error })
  }
}

function apiFailure(error: unknown): { status: number; code: ApiErrorCode; message: string } {
  if (error instanceof z.ZodError) {
    return { status: 400, code: 'invalid-request', message: 'MomentQ request is invalid' }
  }
  if (error instanceof MomentQStateNotFoundError) {
    return { status: 404, code: 'content-not-found', message: 'MomentQ content was not found' }
  }
  const message = error instanceof Error ? error.message : String(error)
  if (/invalid JSON in MomentQ state|invalid MomentQ state/i.test(message)) {
    return { status: 500, code: 'internal', message: 'MomentQ request failed' }
  }
  if (/invalid|must|does not match|not accept|exceeds/i.test(message)) {
    return { status: 400, code: 'invalid-request', message: 'MomentQ request is invalid' }
  }
  if (/conflict|does not own|no active Session/i.test(message)) {
    return { status: 409, code: 'session-conflict', message: 'MomentQ Session state conflicts with this request' }
  }
  return { status: 500, code: 'internal', message: 'MomentQ request failed' }
}

/** Register the MomentQ API on the DSH loopback webserver. */
export function apply(ctx: Context): void {
  if (ctx.webServer.host !== '127.0.0.1') {
    throw new Error('momentq-http-api requires a loopback-only DSH webserver')
  }
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/momentq/api',
    async handler(req, res) {
      const requestOrigin = req.headers.origin
      const responseOrigin = allowedOrigin(requestOrigin)
      if (requestOrigin !== undefined && responseOrigin === undefined) {
        sendJson(res, 403, { ok: false, error: { code: 'invalid-request', message: 'Origin not allowed' } })
        return
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          ...corsHeaders(responseOrigin),
          'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-allow-headers': 'content-type',
          'access-control-max-age': '600',
        })
        res.end()
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: { code: 'invalid-request', message: 'POST required' } }, responseOrigin)
        return
      }
      const mediaType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
      if (mediaType !== 'application/json') {
        sendJson(res, 415, { ok: false, error: { code: 'invalid-request', message: 'JSON required' } }, responseOrigin)
        return
      }
      try {
        const request = requestSchema.parse(await bodyOf(req))
        let value: unknown
        switch (request.method) {
          case 'ensureContent': {
            const params = ensureContentParams.parse(request.params)
            value = await ctx.momentq.ensureContent(params)
            break
          }
          case 'getContent': {
            const { identity } = identityParams.parse(request.params)
            value = await ctx.momentq.getContent(identity)
            break
          }
          case 'getHistory': {
            const { identity } = identityParams.parse(request.params)
            value = await ctx.momentq.getHistory(identity)
            break
          }
          case 'getTranscript': {
            const { identity } = identityParams.parse(request.params)
            value = await ctx.momentq.getTranscript(identity)
            break
          }
          case 'submitMessage': {
            const params = submitMessageParams.parse(request.params)
            value = await ctx.momentq.submitMessage(params.identity, params.text, toEncodedImages(params.images))
            break
          }
          case 'syncTranscript': {
            const params = syncTranscriptParams.parse(request.params)
            value = await ctx.momentq.syncTranscript(params.identity, params.source, params.segments)
            break
          }
          case 'clearTranscript': {
            const { identity } = identityParams.parse(request.params)
            value = await ctx.momentq.clearTranscript(identity)
            break
          }
          case 'archiveSession': {
            const { identity } = identityParams.parse(request.params)
            value = await ctx.momentq.archiveSession(identity)
            break
          }
          case 'resetSession': {
            const params = replaceParams.parse(request.params)
            value = await ctx.momentq.resetSession(params.identity, params.sessionInstructions)
            break
          }
          case 'deleteSession': {
            const params = replaceParams.parse(request.params)
            value = await ctx.momentq.deleteSession(params.identity, params.sessionInstructions)
            break
          }
          case 'deleteContent': {
            const { identity } = identityParams.parse(request.params)
            value = await ctx.momentq.deleteContent(identity)
            break
          }
          case 'clearAllSessions': {
            clearAllSessionsParams.parse(request.params)
            value = await ctx.momentq.clearAllSessions()
            break
          }
          case 'setModelApiKey': {
            const { apiKey } = setModelApiKeyParams.parse(request.params)
            await ctx.credentials.set(MODEL_API_KEY_REF, apiKey)
            value = { saved: true }
            break
          }
        }
        sendJson(res, 200, { ok: true, value }, responseOrigin)
      } catch (error) {
        const failure = apiFailure(error)
        if (failure.status === 500) ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
        sendJson(res, failure.status, {
          ok: false,
          error: { code: failure.code, message: failure.message },
        }, responseOrigin)
      }
    },
  }))

  // Storage location for the settings page's data-path display. Read-only
  // and loopback-gated like every other MomentQ route.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/momentq/api/storage',
    async handler(req, res) {
      const requestOrigin = req.headers.origin
      const responseOrigin = allowedOrigin(requestOrigin)
      if (requestOrigin !== undefined && responseOrigin === undefined) {
        sendJson(res, 403, { ok: false, error: { code: 'invalid-request', message: 'Origin not allowed' } })
        return
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          ...corsHeaders(responseOrigin),
          'access-control-allow-methods': 'GET, OPTIONS',
          'access-control-max-age': '600',
        })
        res.end()
        return
      }
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: { code: 'invalid-request', message: 'GET required' } }, responseOrigin)
        return
      }
      sendJson(res, 200, { ok: true, value: { root: ctx.momentq.root } }, responseOrigin)
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/momentq/api/stream',
    async handler(req, res) {
      const requestOrigin = req.headers.origin
      const responseOrigin = allowedOrigin(requestOrigin)
      if (requestOrigin !== undefined && responseOrigin === undefined) {
        sendJson(res, 403, { ok: false, error: { code: 'invalid-request', message: 'Origin not allowed' } })
        return
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          ...corsHeaders(responseOrigin),
          'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-allow-headers': 'content-type',
          'access-control-max-age': '600',
        })
        res.end()
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: { code: 'invalid-request', message: 'POST required' } }, responseOrigin)
        return
      }
      const mediaType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
      if (mediaType !== 'application/json') {
        sendJson(res, 415, { ok: false, error: { code: 'invalid-request', message: 'JSON required' } }, responseOrigin)
        return
      }
      const abort = new AbortController()
      res.on('close', () => { if (!res.writableEnded) abort.abort() })
      try {
        const params = streamMessageParams.parse(await bodyOf(req))
        res.writeHead(200, {
          'content-type': 'application/x-ndjson; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          ...corsHeaders(responseOrigin),
        })
        await ctx.momentq.streamMessage(params.identity, params.text, toEncodedImages(params.images), (event) => {
          if (!res.destroyed) res.write(`${JSON.stringify(event)}\n`)
        }, abort.signal)
        res.end()
      } catch (error) {
        const failure = apiFailure(error)
        if (failure.status === 500) ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
        if (res.headersSent) {
          if (!res.destroyed) {
            res.end(`${JSON.stringify({
              type: 'error', code: failure.code, message: failure.message,
            })}\n`)
          }
        } else {
          sendJson(res, failure.status, {
            ok: false,
            error: { code: failure.code, message: failure.message },
          }, responseOrigin)
        }
      }
    },
  }))
}

export default { name, inject, apply }
