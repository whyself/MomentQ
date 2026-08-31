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
    submitMessage: vi.fn(async () => ({ replies: [{ id: 'reply', text: 'ok' }] })),
    syncTranscript: vi.fn(async () => ({ contentKey: 'key', source: 'bilibili', segments: 1 })),
    streamMessage: vi.fn(async (_identity: unknown, _text: string, _images: unknown, publish: (event: unknown) => void) => {
      const result = {
        contentKey: 'key', sessionId: 'session', userMessageId: 'user', replies: [{ id: 'reply', text: '# 标题' }],
      }
      publish({ type: 'started', contentKey: 'key', sessionId: 'session', userMessageId: 'user' })
      publish({ type: 'assistant-delta', turn: 1, step: 1, index: 0, text: '# 标' })
      publish({ type: 'assistant-delta', turn: 1, step: 1, index: 0, text: '题' })
      publish({
        type: 'assistant-message', turn: 1, step: 1, id: 'reply', text: '# 标题', blocks: ['# 标题'], interrupted: false,
      })
      publish({ type: 'complete', result })
      return result
    }),
    archiveSession: vi.fn(async () => ({ sessionId: null })),
    resetSession: vi.fn(async () => ({ sessionId: 'reset' })),
    deleteSession: vi.fn(async () => ({ sessionId: 'deleted' })),
    deleteContent: vi.fn(async () => ({ deleted: true as const })),
  }
  ctx.provide('momentq', momentq as never)
  const credentials = { set: vi.fn(async () => undefined) }
  ctx.provide('credentials', credentials as never)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(MomentQHttpApi)
  const endpoint = `http://127.0.0.1:${String(ctx.webServer.port)}/momentq/api`
  return { ctx, momentq, credentials, endpoint, streamEndpoint: `${endpoint}/stream` }
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

    expect((await call(h.endpoint, {
      method: 'submitMessage', params: { identity, text: '总结当前视频' },
    })).status).toBe(200)
    expect(h.momentq.submitMessage).toHaveBeenCalledWith(identity, '总结当前视频', undefined)

    expect((await call(h.endpoint, {
      method: 'syncTranscript',
      params: { identity, source: 'bilibili', segments: [{ start: 0, end: 1, text: '字幕' }] },
    })).status).toBe(200)
    expect(h.momentq.syncTranscript).toHaveBeenCalledWith(
      identity, 'bilibili', [{ start: 0, end: 1, text: '字幕' }],
    )

    expect((await call(h.endpoint, {
      method: 'setModelApiKey', params: { apiKey: 'sk-test' },
    })).status).toBe(200)
    expect(h.credentials.set).toHaveBeenCalledWith('DEEPSEEK_API_KEY', 'sk-test')

    for (const method of ['getContent', 'archiveSession', 'resetSession', 'deleteSession', 'deleteContent']) {
      expect((await call(h.endpoint, { method, params: { identity } })).status).toBe(200)
    }
  })

  it('rejects empty and oversized submitted messages', async () => {
    const h = await harness()
    expect((await call(h.endpoint, {
      method: 'submitMessage', params: { identity, text: '   ' },
    })).status).toBe(400)
    expect((await call(h.endpoint, {
      method: 'submitMessage', params: { identity, text: 'x'.repeat(32_001) },
    })).status).toBe(400)
    expect(h.momentq.submitMessage).not.toHaveBeenCalled()
  })

  it('forwards native DSH deltas as newline-delimited stream events', async () => {
    const h = await harness()
    const response = await call(h.streamEndpoint, { identity, text: '请用 Markdown 回答' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/x-ndjson')
    const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line))
    expect(events.map(event => event.type)).toEqual([
      'started', 'assistant-delta', 'assistant-delta', 'assistant-message', 'complete',
    ])
    expect(events.filter(event => event.type === 'assistant-delta').map(event => event.text).join('')).toBe('# 标题')
    expect(h.momentq.streamMessage).toHaveBeenCalledWith(
      identity, '请用 Markdown 回答', undefined, expect.any(Function), expect.any(AbortSignal),
    )
  })

  it('rejects malformed model API keys without writing credentials', async () => {
    const h = await harness()
    for (const apiKey of ['', '   ', 'DEEPSEEK_API_KEY=sk-test', '"sk-test"', 'sk-测试']) {
      expect((await call(h.endpoint, { method: 'setModelApiKey', params: { apiKey } })).status).toBe(400)
    }
    expect(h.credentials.set).not.toHaveBeenCalled()
  })

  it('rejects non-POST, malformed, unknown and oversized requests', async () => {
    const h = await harness()
    expect((await call(h.endpoint, {}, 'GET')).status).toBe(405)
    expect((await fetch(h.endpoint, { method: 'POST', body: JSON.stringify({ method: 'getContent', params: { identity } }) })).status).toBe(415)
    expect((await fetch(h.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/jsonp' },
      body: JSON.stringify({ method: 'getContent', params: { identity } }),
    })).status).toBe(415)
    expect((await fetch(h.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ method: 'deleteContent', params: { identity } }),
    })).status).toBe(403)
    expect((await call(h.endpoint, { method: 'unknown', params: {} })).status).toBe(400)
    expect((await call(h.endpoint, {
      method: 'getContent', params: { identity, cwd: 'D:\\secret', sessionId: 'x', presetId: 'x' },
    })).status).toBe(400)
    expect((await call(h.endpoint, {
      method: 'getContent', params: { identity, padding: 'x'.repeat(1024 * 1024) },
    })).status).toBe(400)
  })

  it('allows extension and loopback-preview CORS while rejecting remote origins', async () => {
    const h = await harness()
    for (const origin of ['chrome-extension://momentq-test', 'moz-extension://momentq-test', 'http://127.0.0.1:4176', 'http://localhost:4176']) {
      const preflight = await fetch(h.endpoint, {
        method: 'OPTIONS',
        headers: {
          origin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      })
      expect(preflight.status).toBe(204)
      expect(preflight.headers.get('access-control-allow-origin')).toBe(origin)
      expect(preflight.headers.get('access-control-allow-methods')).toContain('POST')

      const response = await fetch(h.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({ method: 'getContent', params: { identity } }),
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('access-control-allow-origin')).toBe(origin)
    }

    const rejected = await fetch(h.endpoint, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    })
    expect(rejected.status).toBe(403)
    expect(rejected.headers.get('access-control-allow-origin')).toBeNull()
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
    ctx.provide('credentials', {} as never)
    await expect(ctx.plugin(MomentQHttpApi)).rejects.toThrow(/loopback-only/)
  })
})
