import { describe, expect, it } from 'vitest'
import type { BilibiliContext } from '../src/shared/protocol'
import { resolveCurrentVodContext } from '../src/background/vod-refresh'

function context(url: string, bvid = 'BV1xx411c7mD'): BilibiliContext {
  return {
    kind: 'vod',
    identity: { kind: 'vod', bvid, cid: '1' },
    metadata: { title: bvid, creator: { name: 'UP' } },
    url,
  }
}

describe('current VOD refresh', () => {
  it('accepts tracking-parameter rewrites for the same content identity', async () => {
    const requested = 'https://www.bilibili.com/video/BV1xx411c7mD/?spm_id_from=old'
    await expect(resolveCurrentVodContext(requested, {
      resolve: async url => context(url),
      currentUrl: async () => 'https://www.bilibili.com/video/BV1xx411c7mD/?trackid=new',
    })).resolves.toEqual(context(requested))
  })

  it('does not let a slow response for the previous video overwrite the new video', async () => {
    const requested = 'https://www.bilibili.com/video/BV1xx411c7mD/'
    await expect(resolveCurrentVodContext(requested, {
      resolve: async url => context(url),
      currentUrl: async () => 'https://www.bilibili.com/video/BV1a7411w7tC/',
    })).resolves.toBeNull()
  })
})
