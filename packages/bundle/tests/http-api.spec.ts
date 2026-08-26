import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as MomentQHttpApi from '../src/http-api.ts'
import { MomentQStateNotFoundError } from '../src/state.ts'

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

async function harness() {
  const ctx = new Context()
  context = ctx
  const momentq = {
    ensureContent: vi.fn(async (value: unknown) => ({ route: value })),
    getContent: vi.fn(async () => ({ schemaVersion: 1 })),
    archiveSession: vi.fn(async () => ({ sessionId: null })),
    resetSession: vi.fn(async () => ({ sessionId: 'reset' })),
    deleteSession: vi.fn(async () => ({ sessionId: 'deleted' })),
    deleteContent: vi.fn(async () => ({ deleted: true as const })),
  }
  ctx.provide('momentq', momentq as never)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(MomentQHttpApi)
  const endpoint = `http://127.0.0.1:${String(ctx.webServer.port)}/momentq/api`
  return { ctx, momentq, endpoint }
}

async function call(endpoint: string, value: unknown, method = 'POST') {
  return await fetch(endpoint, {
    method,
    ...(method === 'POST'
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }
      : {}),
  })
}

const identity = { kind: 'vod', bvid: 'BV1xx', cid: '42' } as const

describe('MomentQ loopback HTTP API', () => {
  it('dispatches the allowlisted service methods', async () => {
    const h = await harness()
    const response = await call(h.endpoint, {
      method: 'ensureContent',
      params: { identity, metadata: { title: 'Title', creator: { name: 'Uploader' } } },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, value: { route: { identity } } })
    expect(h.momentq.ensureContent).toHaveBeenCalledOnce()

    for (const method of ['getContent', 'archiveSession', 'resetSession', 'deleteSession', 'deleteContent']) {
      expect((await call(h.endpoint, { method, params: { identity } })).status).toBe(200)
    }
  })

  it('rejects non-POST, malformed, unknown and oversized requests', async () => {
    const h = await harness()
    expect((await call(h.endpoint, {}, 'GET')).status).toBe(405)
    expect((await call(h.endpoint, { method: 'unknown', params: {} })).status).toBe(400)
    expect((await call(h.endpoint, {
      method: 'getContent', params: { identity, cwd: 'D:\\secret', sessionId: 'x', presetId: 'x' },
    })).status).toBe(400)
    expect((await call(h.endpoint, {
      method: 'getContent', params: { identity, padding: 'x'.repeat(1024 * 1024) },
    })).status).toBe(400)
  })

  it('maps missing state and redacts internal errors', async () => {
    const h = await harness()
    h.momentq.getContent.mockRejectedValueOnce(new MomentQStateNotFoundError('D:\\private\\state.json'))
    const missing = await call(h.endpoint, { method: 'getContent', params: { identity } })
    expect(missing.status).toBe(404)
    expect(JSON.stringify(await missing.json())).not.toContain('private')

    h.momentq.getContent.mockRejectedValueOnce(new Error('secret at D:\\private'))
    const failed = await call(h.endpoint, { method: 'getContent', params: { identity } })
    expect(failed.status).toBe(500)
    expect(await failed.json()).toEqual({
      ok: false,
      error: { code: 'internal', message: 'MomentQ request failed' },
    })
  })

  it('fails closed when mounted on an all-interfaces webserver', async () => {
    const ctx = new Context()
    ctx.provide('momentq', {} as never)
    ctx.provide('webServer', { host: '0.0.0.0' } as never)
    await expect(ctx.plugin(MomentQHttpApi)).rejects.toThrow(/loopback-only/)
  })
})

