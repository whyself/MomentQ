import { describe, expect, it, vi } from 'vitest'
import { resolveSnapshotViaBilibiliApi } from '../src/background/bilibili-api'

describe('current Bilibili VOD API resolution', () => {
  it('resolves the identity when the new page has no __INITIAL_STATE__', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      code: 0,
      data: {
        bvid: 'BV1xx411c7mD',
        title: '新版视频页',
        owner: { mid: 42, name: '作者' },
        cid: 111,
        videos: 2,
        pages: [
          { page: 1, cid: 111, part: '第一部分' },
          { page: 2, cid: 222, part: '第二部分' },
        ],
      },
    }), { status: 200 }))

    const context = await resolveSnapshotViaBilibiliApi({
      url: 'https://www.bilibili.com/video/BV1xx411c7mD?p=2',
    }, request)

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

  it('rejects a response for a different BV identity', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      code: 0,
      data: { bvid: 'BV1DIFFERENT', cid: 111 },
    }), { status: 200 }))
    await expect(resolveSnapshotViaBilibiliApi({
      url: 'https://www.bilibili.com/video/BV1xx411c7mD',
    }, request)).resolves.toBeNull()
  })
})
