import { describe, expect, it, vi } from 'vitest'
import { createBilibiliContextResolver, DEFAULT_VIEW_RETRY_INTERVAL_MS } from '../src/background/bilibili-api'

function viewResponse(data: unknown): Response {
  return new Response(JSON.stringify({ code: 0, data }), { status: 200 })
}

const fullVideo = {
  bvid: 'BV1xx411c7mD',
  title: '新版视频页',
  owner: { mid: 42, name: '作者' },
  cid: 111,
  videos: 2,
  pages: [
    { page: 1, cid: 111, part: '第一部分' },
    { page: 2, cid: 222, part: '第二部分' },
  ],
}

describe('current Bilibili VOD API resolution', () => {
  it('resolves the identity when the new page has no __INITIAL_STATE__', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(viewResponse(fullVideo))
    const resolve = createBilibiliContextResolver({ request })

    const context = await resolve({
      url: 'https://www.bilibili.com/video/BV1xx411c7mD?p=2',
    })

    expect(request).toHaveBeenCalledWith('https://api.bilibili.com/x/web-interface/view?bvid=BV1xx411c7mD')
    expect(context).toMatchObject({
      identity: { kind: 'vod', bvid: 'BV1xx411c7mD', cid: '222' },
      metadata: {
        title: '新版视频页',
        creator: { id: '42', name: '作者' },
        part: { number: 2, title: '第二部分' },
      },
    })
  })

  it('serves a resolved bvid from the cache without re-requesting', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(viewResponse(fullVideo))
    const resolve = createBilibiliContextResolver({ request })
    const snapshot = { url: 'https://www.bilibili.com/video/BV1xx411c7mD' }

    await resolve(snapshot)
    const second = await resolve(snapshot)

    expect(request).toHaveBeenCalledTimes(1)
    expect(second).toMatchObject({ identity: { cid: '111' } })
  })

  it('throttles repeated attempts for the same bvid while it stays unresolved', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"code":-799}', { status: 200 }))
    let clock = 0
    const resolve = createBilibiliContextResolver({
      request,
      now: () => clock,
      retryIntervalMs: DEFAULT_VIEW_RETRY_INTERVAL_MS,
    })
    const snapshot = { url: 'https://www.bilibili.com/video/BV1xx411c7mD' }

    await expect(resolve(snapshot)).resolves.toBeNull()
    clock = 100
    await expect(resolve(snapshot)).resolves.toBeNull()
    expect(request).toHaveBeenCalledTimes(1)
    clock = DEFAULT_VIEW_RETRY_INTERVAL_MS + 101
    await expect(resolve(snapshot)).resolves.toBeNull()
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('rejects a response for a different BV identity', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(viewResponse({ bvid: 'BV1DIFFERENT', cid: 111 }))
    const resolve = createBilibiliContextResolver({ request })
    await expect(resolve({
      url: 'https://www.bilibili.com/video/BV1xx411c7mD',
    })).resolves.toBeNull()
  })
})
