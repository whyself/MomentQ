/** Loopback-only JSON API over the same-process MomentQ Host service. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { z } from 'zod'
import { contentIdentitySchema, contentMetadataSchema, MomentQStateNotFoundError } from './state.ts'

export const name = 'momentq-http-api'
export const inject = ['momentq', 'webServer']

const MAX_BODY_BYTES = 1024 * 1024

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

const requestSchema = z.object({
  method: z.enum([
    'ensureContent', 'getContent', 'archiveSession', 'resetSession', 'deleteSession', 'deleteContent',
  ]),
  params: z.unknown(),
}).strict()

type ApiErrorCode = 'invalid-request' | 'content-not-found' | 'session-conflict' | 'internal'

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const content = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(content),
    'cache-control': 'no-store',
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
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: { code: 'invalid-request', message: 'POST required' } })
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
        }
        sendJson(res, 200, { ok: true, value })
      } catch (error) {
        const failure = apiFailure(error)
        if (failure.status === 500) ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
        sendJson(res, failure.status, {
          ok: false,
          error: { code: failure.code, message: failure.message },
        })
      }
    },
  }))
}

export default apply

