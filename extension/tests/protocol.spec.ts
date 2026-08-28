import { describe, expect, it } from 'vitest'
import { isPageMessageEnvelope, isPageSubtitleMessageEnvelope, isPageSubtitleTracksMessageEnvelope } from '../src/shared/protocol'

const validEnvelope = {
  source: 'momentq-page',
  version: 1,
  type: 'PAGE_SNAPSHOT',
  payload: {
    url: 'https://www.bilibili.com/video/BV1xx411c7mD',
    canonicalUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
    title: '标题',
    creator: { id: 42, name: '作者' },
    vod: {
      bvid: 'BV1xx411c7mD',
      cid: '123',
      pageNumber: 2,
      pageCount: 3,
      partTitle: '第二部分',
    },
  },
} as const

describe('isPageMessageEnvelope', () => {
  it('accepts the exact page snapshot envelope', () => {
    expect(isPageMessageEnvelope(validEnvelope)).toBe(true)
  })

  it('rejects inherited envelope properties', () => {
    expect(isPageMessageEnvelope(Object.create(validEnvelope))).toBe(false)
  })

  it.each([
    { ...validEnvelope, source: 'another-page' },
    { ...validEnvelope, version: 2 },
    { ...validEnvelope, type: 'UNKNOWN' },
    { ...validEnvelope, extra: true },
    { ...validEnvelope, payload: { ...validEnvelope.payload, title: 123 } },
    { ...validEnvelope, payload: { ...validEnvelope.payload, vod: { cid: {} } } },
    { ...validEnvelope, payload: Object.assign(Object.create({ title: 'inherited' }), { url: validEnvelope.payload.url }) },
  ])('rejects malformed input: %o', value => {
    expect(isPageMessageEnvelope(value)).toBe(false)
  })
})

describe('isPageSubtitleMessageEnvelope', () => {
  it('accepts normalized subtitle segments', () => {
    expect(isPageSubtitleMessageEnvelope({
      source: 'momentq-page', version: 1, type: 'PAGE_SUBTITLE',
      payload: { bvid: 'BV1xx411c7mD', cid: '123', segments: [{ start: 0, end: 1.2, text: '你好' }] },
    })).toBe(true)
  })

  it.each([
    { source: 'momentq-page', version: 1, type: 'PAGE_SUBTITLE', payload: { bvid: 'BV', cid: '1', segments: [] } },
    { source: 'momentq-page', version: 1, type: 'PAGE_SUBTITLE', payload: { bvid: 'BV', cid: '1', segments: [{ start: -1, end: 1, text: 'x' }] } },
    { source: 'momentq-page', version: 1, type: 'PAGE_SUBTITLE', payload: { bvid: 'BV', cid: '1', segments: [{ start: 2, end: 1, text: 'x' }] } },
  ])('rejects malformed subtitle payload: %o', value => {
    expect(isPageSubtitleMessageEnvelope(value)).toBe(false)
  })
})

describe('isPageSubtitleTracksMessageEnvelope', () => {
  it('accepts available tracks and definitive absence as separate states', () => {
    expect(isPageSubtitleTracksMessageEnvelope({
      source: 'momentq-page', version: 1, type: 'PAGE_SUBTITLE_TRACKS',
      payload: { bvid: 'BV1xx', cid: '42', status: 'available', tracks: ['https://aisubtitle.hdslb.com/a.json'] },
    })).toBe(true)
    expect(isPageSubtitleTracksMessageEnvelope({
      source: 'momentq-page', version: 1, type: 'PAGE_SUBTITLE_TRACKS',
      payload: { bvid: 'BV1xx', cid: '42', status: 'absent', tracks: [] },
    })).toBe(true)
  })

  it('rejects contradictory subtitle availability states', () => {
    expect(isPageSubtitleTracksMessageEnvelope({
      source: 'momentq-page', version: 1, type: 'PAGE_SUBTITLE_TRACKS',
      payload: { bvid: 'BV1xx', cid: '42', status: 'available', tracks: [] },
    })).toBe(false)
    expect(isPageSubtitleTracksMessageEnvelope({
      source: 'momentq-page', version: 1, type: 'PAGE_SUBTITLE_TRACKS',
      payload: { bvid: 'BV1xx', cid: '42', status: 'absent', tracks: ['https://aisubtitle.hdslb.com/a.json'] },
    })).toBe(false)
  })
})
