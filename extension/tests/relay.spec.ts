import { describe, expect, it } from 'vitest'
import { pageSnapshotToRuntimeMessage } from '../src/content/relay'

describe('pageSnapshotToRuntimeMessage', () => {
  it('ignores an incomplete snapshot while a supported page is still loading', () => {
    expect(pageSnapshotToRuntimeMessage({
      url: 'https://www.bilibili.com/video/BV1xx411c7mD',
    })).toEqual({
      type: 'MOMENTQ_RESOLVE_PAGE_SNAPSHOT',
      snapshot: { url: 'https://www.bilibili.com/video/BV1xx411c7mD' },
    })
  })

  it('clears tab context only after leaving a supported content URL', () => {
    expect(pageSnapshotToRuntimeMessage({
      url: 'https://www.bilibili.com/',
    })).toEqual({ type: 'MOMENTQ_PAGE_CONTEXT', context: null })
  })

  it('relays a complete normalized context', () => {
    expect(pageSnapshotToRuntimeMessage({
      url: 'https://www.bilibili.com/video/BV1xx411c7mD',
      title: '视频',
      creator: { name: '作者' },
      vod: { bvid: 'BV1xx411c7mD', cid: '123' },
    })).toMatchObject({
      type: 'MOMENTQ_PAGE_CONTEXT',
      context: { identity: { kind: 'vod', cid: '123' } },
    })
  })
})
