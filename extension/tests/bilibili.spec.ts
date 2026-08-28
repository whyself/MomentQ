import { describe, expect, it } from 'vitest'
import { normalizeBilibiliContext, parseBilibiliLocation } from '../src/shared/bilibili'
import { selectVodPage } from '../src/content/page-snapshot'

const VOD_URL = 'https://www.bilibili.com/video/BV1xx411c7mD'

describe('parseBilibiliLocation', () => {
  it('parses VOD URLs and an explicit part query', () => {
    expect(parseBilibiliLocation(VOD_URL)).toEqual({
      kind: 'vod',
      bvid: 'BV1xx411c7mD',
    })
    expect(parseBilibiliLocation(`${VOD_URL}?p=2`)).toEqual({
      kind: 'vod',
      bvid: 'BV1xx411c7mD',
      requestedPart: 2,
    })
  })

  it('parses live room URLs', () => {
    expect(parseBilibiliLocation('https://live.bilibili.com/123')).toEqual({
      kind: 'live',
      roomId: '123',
    })
  })

  it.each([
    'https://www.bilibili.com/video/not-a-bvid',
    'https://www.bilibili.com/video/BV1xx411c7mD?p=0',
    'https://live.bilibili.com/not-a-room',
    'https://example.com/video/BV1xx411c7mD',
  ])('rejects malformed or unsupported locations: %s', url => {
    expect(parseBilibiliLocation(url)).toBeNull()
  })
})

describe('normalizeBilibiliContext', () => {
  it('requires a decimal cid for VOD identity', () => {
    expect(normalizeBilibiliContext({
      url: VOD_URL,
      title: '单集视频',
      creator: { id: '42', name: '作者' },
      vod: { bvid: 'BV1xx411c7mD' },
    })).toBeNull()

    expect(normalizeBilibiliContext({
      url: VOD_URL,
      title: '单集视频',
      creator: { name: '作者' },
      vod: { bvid: 'BV1xx411c7mD', cid: 'not-decimal' },
    })).toBeNull()
  })

  it('does not invent part metadata for a single-part video', () => {
    const context = normalizeBilibiliContext({
      url: VOD_URL,
      title: '单集视频',
      creator: { id: '42', name: '作者' },
      vod: {
        bvid: 'BV1xx411c7mD',
        cid: '987654',
        pageNumber: 1,
        pageCount: 1,
        partTitle: '单集视频',
      },
    })

    expect(context).toEqual({
      kind: 'vod',
      identity: { kind: 'vod', bvid: 'BV1xx411c7mD', cid: '987654' },
      metadata: {
        title: '单集视频',
        creator: { id: '42', name: '作者' },
      },
      url: VOD_URL,
    })
    expect(context?.metadata).not.toHaveProperty('part')
  })

  it('adds part metadata only for a proven multi-part video', () => {
    expect(normalizeBilibiliContext({
      url: `${VOD_URL}?p=2`,
      title: '多 P 视频',
      creator: { name: '作者' },
      vod: {
        bvid: 'BV1xx411c7mD',
        cid: 987655,
        pageCount: 3,
        partTitle: '第二部分',
      },
    })).toMatchObject({
      metadata: { part: { number: 2, title: '第二部分' } },
    })

    expect(normalizeBilibiliContext({
      url: VOD_URL,
      title: '信息不足的视频',
      creator: { name: '作者' },
      vod: {
        bvid: 'BV1xx411c7mD',
        cid: '987656',
        pageCount: 3,
      },
    })?.metadata).not.toHaveProperty('part')
  })

  it('rejects a snapshot whose page number conflicts with the URL', () => {
    expect(normalizeBilibiliContext({
      url: `${VOD_URL}?p=2`,
      title: '多 P 视频',
      creator: { name: '作者' },
      vod: {
        bvid: 'BV1xx411c7mD',
        cid: '111',
        pageNumber: 1,
        pageCount: 2,
      },
    })).toBeNull()
  })

  it('normalizes live identity to a canonical room and ISO start time', () => {
    expect(normalizeBilibiliContext({
      url: 'https://live.bilibili.com/123',
      title: '直播标题',
      creator: { id: 42, name: '主播' },
      live: {
        roomId: '123',
        canonicalRoomId: 456,
        liveStartTime: '2026-08-26T02:03:04+08:00',
      },
    })).toEqual({
      kind: 'live',
      identity: {
        kind: 'live',
        canonicalRoomId: '456',
        liveStartTime: '2026-08-25T18:03:04.000Z',
      },
      metadata: {
        title: '直播标题',
        creator: { id: '42', name: '主播' },
      },
      url: 'https://live.bilibili.com/123',
    })
  })

  it.each([
    { canonicalRoomId: 'not-decimal', liveStartTime: '2026-08-26T02:03:04Z' },
    { canonicalRoomId: '456', liveStartTime: 'not-a-time' },
    { canonicalRoomId: '456', liveStartTime: '2026-02-30T12:00:00Z' },
    { canonicalRoomId: '456', liveStartTime: '2026-08-26T12:00:00+14:01' },
  ])('rejects malformed live identity: %o', live => {
    expect(normalizeBilibiliContext({
      url: 'https://live.bilibili.com/123',
      title: '直播标题',
      creator: { name: '主播' },
      live: { roomId: '123', ...live },
    })).toBeNull()
  })
})

describe('selectVodPage', () => {
  it('uses the explicit URL part and its cid even when the global cid is stale', () => {
    expect(selectVodPage([
      { page: 1, cid: 111, part: '第一部分' },
      { page: 2, cid: 222, part: '第二部分' },
    ], 2, 111)).toEqual({
      cid: 222,
      pageNumber: 2,
      partTitle: '第二部分',
    })
  })

  it('does not pair an unmatched explicit part with a stale cid', () => {
    expect(selectVodPage([
      { page: 1, cid: 111, part: '第一部分' },
    ], 2, 111)).toEqual({ pageNumber: 2 })
  })
})
