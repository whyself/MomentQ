import { describe, expect, it } from 'vitest'
import { identityConsistent, type RawVodIdentity } from '../src/content/snapshot-identity'

describe('identityConsistent', () => {
  it('accepts page state that already matches the target identity', () => {
    const raw: RawVodIdentity = { bvid: 'BV1zzz', cid: 42, aid: 7 }
    expect(identityConsistent(raw, { bvid: 'BV1zzz', cid: '42' })).toBe(true)
  })

  it('compares numeric and string cids by value', () => {
    expect(identityConsistent({ bvid: 'BV1zzz', cid: '42' }, { bvid: 'BV1zzz', cid: '42' })).toBe(true)
    expect(identityConsistent({ bvid: 'BV1zzz', cid: 42 }, { bvid: 'BV1zzz', cid: '42' })).toBe(true)
  })

  it('rejects the poisoned SPA transition trio (new bvid/cid, previous aid)', () => {
    // __INITIAL_STATE__ still describes the previous video while the resolved
    // identity was merged on top: the surviving aid must not be probed.
    const raw: RawVodIdentity = { bvid: 'BV1old', cid: 111, aid: 900 }
    expect(identityConsistent(raw, { bvid: 'BV1new', cid: '222' })).toBe(false)
  })

  it('rejects missing or partial page state', () => {
    expect(identityConsistent(undefined, { bvid: 'BV1zzz', cid: '42' })).toBe(false)
    expect(identityConsistent({ aid: 7 }, { bvid: 'BV1zzz', cid: '42' })).toBe(false)
    expect(identityConsistent({ bvid: 'BV1zzz' }, { bvid: 'BV1zzz', cid: '42' })).toBe(false)
  })
})
