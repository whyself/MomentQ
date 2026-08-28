import { describe, expect, it, vi } from 'vitest'
import { MomentQClient, MomentQClientError } from '../src/sdk.ts'

const identity = { kind: 'vod', bvid: 'BV1xx', cid: '42' } as const

describe('MomentQ browser SDK', () => {
  it('rejects non-loopback and credential-confused base URLs', () => {
    expect(() => new MomentQClient({ baseUrl: 'http://127.0.0.1:3080@evil.example' })).toThrow(/loopback/)
    expect(() => new MomentQClient({ baseUrl: 'https://example.com' })).toThrow(/loopback/)
  })
  it('sends typed calls to the fixed API path', async () => {
    let seenInit: RequestInit | undefined
    const fetcher: typeof globalThis.fetch = vi.fn(async (_input, init) => {
      seenInit = init
      return new Response(JSON.stringify({
        ok: true,
        value: { contentKey: 'key', sessionId: 'session', cwd: 'cwd', created: true },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const client = new MomentQClient({ baseUrl: 'http://127.0.0.1:3080/', fetch: fetcher })
    const signal = new AbortController().signal
    await client.ensureContent({
      identity,
      metadata: { title: 'Title', creator: { name: 'Uploader' } },
    }, signal)

    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:3080/momentq/api', expect.objectContaining({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal,
    }))
    expect(JSON.parse(String(seenInit?.body))).toEqual({
      method: 'ensureContent',
      params: { identity, metadata: { title: 'Title', creator: { name: 'Uploader' } } },
    })
  })

  it('accepts localhost as a loopback Host address', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true, value: { schemaVersion: 1 } })))
    const client = new MomentQClient({ baseUrl: 'http://localhost:3182/', fetch: fetcher })
    await client.getContent(identity)
    expect(fetcher).toHaveBeenCalledWith('http://localhost:3182/momentq/api', expect.anything())
  })

  it('binds the browser fetch receiver when no custom fetch is supplied', async () => {
    const original = globalThis.fetch
    let receiver: unknown
    globalThis.fetch = function (this: unknown) {
      receiver = this
      return Promise.resolve(new Response(JSON.stringify({ ok: true, value: { schemaVersion: 1 } })))
    } as typeof globalThis.fetch
    try {
      const client = new MomentQClient({ baseUrl: 'http://127.0.0.1:3080' })
      await client.getContent(identity)
      expect(receiver).toBe(globalThis)
    } finally {
      globalThis.fetch = original
    }
  })

  it('delivers every NDJSON delta before returning the completed result', async () => {
    const result = {
      contentKey: 'key', sessionId: 'session', userMessageId: 'user', replies: [{ id: 'reply', text: '**完成**' }],
    }
    const frames = [
      { type: 'started', contentKey: 'key', sessionId: 'session', userMessageId: 'user' },
      { type: 'assistant-delta', turn: 1, step: 1, index: 0, text: '**完' },
      { type: 'assistant-delta', turn: 1, step: 1, index: 0, text: '成**' },
      {
        type: 'assistant-message', turn: 1, step: 1, id: 'reply', text: '**完成**', blocks: ['**完成**'], interrupted: false,
      },
      { type: 'complete', result },
    ]
    const fetcher = vi.fn(async () => new Response(
      frames.map(frame => JSON.stringify(frame)).join('\n') + '\n',
      { status: 200, headers: { 'content-type': 'application/x-ndjson' } },
    ))
    const client = new MomentQClient({ baseUrl: 'http://127.0.0.1:3080', fetch: fetcher })
    const seen: string[] = []
    await expect(client.streamMessage(identity, 'question', event => { seen.push(event.type) })).resolves.toEqual(result)
    expect(seen).toEqual(frames.map(frame => frame.type))
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:3080/momentq/api/stream', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ identity, text: 'question' }),
    }))
  })

  it('maps malformed stream frames to a typed client error', async () => {
    const client = new MomentQClient({
      baseUrl: 'http://127.0.0.1:3080',
      fetch: async () => new Response('{bad-json}\n', {
        status: 200, headers: { 'content-type': 'application/x-ndjson' },
      }),
    })
    await expect(client.streamMessage(identity, 'question', () => undefined)).rejects.toMatchObject({
      name: 'MomentQClientError', code: 'internal', status: 200,
    } satisfies Partial<MomentQClientError>)
  })

  it('covers archive, reset, Session deletion and content deletion methods', async () => {
    const methods: string[] = []
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      methods.push((JSON.parse(String(init?.body)) as { method: string }).method)
      return new Response(JSON.stringify({ ok: true, value: { deleted: true } }), { status: 200 })
    })
    const client = new MomentQClient({ baseUrl: 'http://127.0.0.1:3080', fetch: fetcher })
    await client.getContent(identity)
    await client.submitMessage(identity, 'question')
    await client.syncTranscript(identity, 'bilibili', [{ start: 0, end: 1, text: '字幕' }])
    await client.archiveSession(identity)
    await client.resetSession(identity, 'new instructions')
    await client.deleteSession(identity)
    await client.deleteContent(identity)
    await client.setModelApiKey('sk-test')
    expect(methods).toEqual([
      'getContent', 'submitMessage', 'syncTranscript', 'archiveSession', 'resetSession', 'deleteSession', 'deleteContent',
      'setModelApiKey',
    ])
  })

  it('maps API failures and invalid responses', async () => {
    const rejected = new MomentQClient({
      baseUrl: 'http://127.0.0.1:3080',
      fetch: async () => new Response(JSON.stringify({
        ok: false,
        error: { code: 'content-not-found', message: 'missing' },
      }), { status: 404 }),
    })
    await expect(rejected.getContent(identity)).rejects.toMatchObject({
      name: 'MomentQClientError', code: 'content-not-found', status: 404,
    } satisfies Partial<MomentQClientError>)

    const invalid = new MomentQClient({
      baseUrl: 'http://127.0.0.1:3080',
      fetch: async () => new Response('not json', { status: 500 }),
    })
    await expect(invalid.getContent(identity)).rejects.toMatchObject({ code: 'internal', status: 500 })

    const nullError = new MomentQClient({
      baseUrl: 'http://127.0.0.1:3080',
      fetch: async () => new Response(JSON.stringify({ ok: false, error: null }), { status: 500 }),
    })
    await expect(nullError.getContent(identity)).rejects.toMatchObject({
      name: 'MomentQClientError', code: 'internal', status: 500,
    } satisfies Partial<MomentQClientError>)
  })

  it('rejects a non-HTTP base URL', () => {
    expect(() => new MomentQClient({ baseUrl: 'file:///tmp/momentq' })).toThrow(/loopback HTTP URL/)
  })
})
