import { describe, expect, it, vi } from 'vitest'
import { MomentQClient, MomentQClientError } from '../src/sdk.ts'

const identity = { kind: 'vod', bvid: 'BV1xx', cid: '42' } as const

describe('MomentQ browser SDK', () => {
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

  it('covers archive, reset, Session deletion and content deletion methods', async () => {
    const methods: string[] = []
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      methods.push((JSON.parse(String(init?.body)) as { method: string }).method)
      return new Response(JSON.stringify({ ok: true, value: { deleted: true } }), { status: 200 })
    })
    const client = new MomentQClient({ baseUrl: 'http://localhost:3080', fetch: fetcher })
    await client.getContent(identity)
    await client.archiveSession(identity)
    await client.resetSession(identity, 'new instructions')
    await client.deleteSession(identity)
    await client.deleteContent(identity)
    expect(methods).toEqual([
      'getContent', 'archiveSession', 'resetSession', 'deleteSession', 'deleteContent',
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
  })

  it('rejects a non-HTTP base URL', () => {
    expect(() => new MomentQClient({ baseUrl: 'file:///tmp/momentq' })).toThrow(/HTTP URL/)
  })
})
