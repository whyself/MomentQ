import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  contentDirectory,
  contentKey,
  contentRelativePath,
  sessionIdFor,
  type ContentIdentity,
} from '../src/content.ts'

describe('MomentQ content identity', () => {
  it('builds stable VOD keys and paths', () => {
    const identity = { kind: 'vod', bvid: 'BV1xx', cid: '42' } as const
    expect(contentKey(identity)).toBe('bilibili:vod:BV1xx:42')
    expect(contentRelativePath(identity)).toBe(join('content', 'bilibili', 'vod', 'BV1xx', '42'))
    expect(contentDirectory('D:\\MomentQData', identity))
      .toBe(resolve('D:\\MomentQData', 'content', 'bilibili', 'vod', 'BV1xx', '42'))
  })

  it('uses a Windows-safe epoch segment for one live occurrence', () => {
    const identity = {
      kind: 'live',
      canonicalRoomId: '100',
      liveStartTime: '2026-08-25T19:30:00+08:00',
    } as const
    expect(contentKey(identity)).toBe('bilibili:live:100:2026-08-25T11:30:00.000Z')
    expect(contentRelativePath(identity))
      .toBe(join('content', 'bilibili', 'live', '100', '1787657400000'))
  })

  it('derives generation-specific opaque Session ids', () => {
    const identity = { kind: 'vod', bvid: 'BV1xx', cid: '42' } as const
    expect(String(sessionIdFor(identity, 0))).toMatch(/^momentq-[0-9a-f]{32}-g0$/)
    expect(sessionIdFor(identity, 1)).not.toBe(sessionIdFor(identity, 0))
  })

  it.each([
    { kind: 'vod', bvid: '../escape', cid: '42' },
    { kind: 'vod', bvid: 'BV1xx', cid: '../42' },
    { kind: 'live', canonicalRoomId: '../100', liveStartTime: '2026-08-25T19:30:00+08:00' },
    { kind: 'live', canonicalRoomId: '100', liveStartTime: 'invalid' },
  ] as ContentIdentity[])('rejects invalid identity %#', (identity) => {
    expect(() => contentKey(identity)).toThrow()
  })

  it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid generation %s',
    (generation) => {
      expect(() => sessionIdFor({ kind: 'vod', bvid: 'BV1xx', cid: '42' }, generation)).toThrow()
    },
  )
})

