import { describe, expect, it } from 'vitest'
import { sameContentLocation } from '../src/background/content-location'

describe('sameContentLocation', () => {
  it('ignores Bilibili tracking-query rewrites for the same video', () => {
    expect(sameContentLocation(
      'https://www.bilibili.com/video/BV1a7411w7tC/?spm_id_from=333.788&vd_source=abc',
      'https://www.bilibili.com/video/BV1a7411w7tC/?trackid=xyz',
    )).toBe(true)
  })

  it('keeps different videos and different parts separate', () => {
    expect(sameContentLocation(
      'https://www.bilibili.com/video/BV1a7411w7tC/',
      'https://www.bilibili.com/video/BV1xx411c7mD/',
    )).toBe(false)
    expect(sameContentLocation(
      'https://www.bilibili.com/video/BV1a7411w7tC/?p=2',
      'https://www.bilibili.com/video/BV1a7411w7tC/?p=3',
    )).toBe(false)
  })
})
