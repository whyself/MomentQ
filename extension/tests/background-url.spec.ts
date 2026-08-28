import { describe, expect, it } from 'vitest'
import { isSupportedBilibiliUrl } from '../src/background/url'

describe('isSupportedBilibiliUrl', () => {
  it.each([
    'https://www.bilibili.com/video/BV1xx411c7mD',
    'https://www.bilibili.com/video/BV1xx411c7mD?p=2',
    'https://live.bilibili.com/123',
  ])('accepts a supported HTTPS content URL: %s', url => {
    expect(isSupportedBilibiliUrl(url)).toBe(true)
  })

  it.each([
    'http://www.bilibili.com/video/BV1xx411c7mD',
    'https://www.bilibili.com/video/not-a-bvid',
    'https://www.bilibili.com/video/BV1xx411c7mD?p=999999999999999999999',
    'https://www.bilibili.com/',
    'https://live.bilibili.com/not-a-room',
  ])('rejects unsupported or malformed URLs: %s', url => {
    expect(isSupportedBilibiliUrl(url)).toBe(false)
  })
})
