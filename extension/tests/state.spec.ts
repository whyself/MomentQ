import { describe, expect, it } from 'vitest'
import { reduceTabState, TabOperationQueue } from '../src/background/state'
import type { BilibiliContext } from '../src/shared/protocol'

const firstContext: BilibiliContext = {
  kind: 'vod',
  identity: { kind: 'vod', bvid: 'BV1xx411c7mD', cid: '100' },
  metadata: { title: '第一个视频', creator: { name: '作者' } },
  url: 'https://www.bilibili.com/video/BV1xx411c7mD',
}

const sameIdentityUpdated: BilibiliContext = {
  ...firstContext,
  metadata: { title: '更新后的标题', creator: { name: '作者' } },
}

const secondContext: BilibiliContext = {
  kind: 'vod',
  identity: { kind: 'vod', bvid: 'BV1xx411c7mD', cid: '200' },
  metadata: { title: '第二个分 P', creator: { name: '作者' }, part: { number: 2 } },
  url: 'https://www.bilibili.com/video/BV1xx411c7mD?p=2',
}

describe('reduceTabState', () => {
  it('starts a newly detected context as inactive', () => {
    expect(reduceTabState(null, { type: 'SET_CONTEXT', tabId: 7, context: firstContext })).toEqual({
      tabId: 7,
      context: firstContext,
      transcription: 'inactive',
    })
  })

  it('preserves transcription for the same identity while refreshing metadata', () => {
    const active = {
      tabId: 7,
      context: firstContext,
      transcription: 'active' as const,
      subtitleSegments: [{ start: 0, end: 1, text: '当前字幕' }],
      subtitleIdentity: { bvid: 'BV1xx411c7mD', cid: '100' },
    }
    expect(reduceTabState(active, {
      type: 'SET_CONTEXT',
      tabId: 7,
      context: sameIdentityUpdated,
    })).toEqual({
      tabId: 7,
      context: sameIdentityUpdated,
      transcription: 'active',
      subtitleSegments: [{ start: 0, end: 1, text: '当前字幕' }],
      subtitleIdentity: { bvid: 'BV1xx411c7mD', cid: '100' },
    })
  })

  it('resets transcription when content identity changes', () => {
    const active = {
      tabId: 7,
      context: firstContext,
      transcription: 'active' as const,
    }
    expect(reduceTabState(active, {
      type: 'SET_CONTEXT',
      tabId: 7,
      context: secondContext,
    })?.transcription).toBe('inactive')
  })

  it('accepts only inactive → active → paused → active', () => {
    const inactive = reduceTabState(null, { type: 'SET_CONTEXT', tabId: 7, context: firstContext })
    const active = reduceTabState(inactive, { type: 'SET_TRANSCRIPTION', transcription: 'active' })
    const paused = reduceTabState(active, { type: 'SET_TRANSCRIPTION', transcription: 'paused' })
    const resumed = reduceTabState(paused, { type: 'SET_TRANSCRIPTION', transcription: 'active' })

    expect(active?.transcription).toBe('active')
    expect(paused?.transcription).toBe('paused')
    expect(resumed?.transcription).toBe('active')
    expect(reduceTabState(inactive, {
      type: 'SET_TRANSCRIPTION', transcription: 'paused',
    })).toBe(inactive)
    expect(reduceTabState(active, {
      type: 'SET_TRANSCRIPTION', transcription: 'inactive',
    })).toBe(active)
  })

  it('toggles through the same legal transitions', () => {
    const inactive = reduceTabState(null, { type: 'SET_CONTEXT', tabId: 7, context: firstContext })
    const active = reduceTabState(inactive, { type: 'TOGGLE_TRANSCRIPTION' })
    const paused = reduceTabState(active, { type: 'TOGGLE_TRANSCRIPTION' })
    const resumed = reduceTabState(paused, { type: 'TOGGLE_TRANSCRIPTION' })
    expect([active?.transcription, paused?.transcription, resumed?.transcription]).toEqual([
      'active', 'paused', 'active',
    ])
  })

  it('removes state when the context or tab disappears', () => {
    const state = reduceTabState(null, { type: 'SET_CONTEXT', tabId: 7, context: firstContext })
    expect(reduceTabState(state, { type: 'SET_CONTEXT', tabId: 7, context: null })).toBeNull()
    expect(reduceTabState(state, { type: 'REMOVE_TAB' })).toBeNull()
  })
})

describe('TabOperationQueue', () => {
  it('serializes context and toggle operations for the same tab', async () => {
    const queue = new TabOperationQueue()
    let releaseFirst: (() => void) | undefined
    const firstMayFinish = new Promise<void>(resolve => { releaseFirst = resolve })
    let state = reduceTabState(null, { type: 'SET_CONTEXT', tabId: 7, context: firstContext })

    const contextUpdate = queue.run(7, async () => {
      await firstMayFinish
      state = reduceTabState(state, {
        type: 'SET_CONTEXT', tabId: 7, context: sameIdentityUpdated,
      })
    })
    const toggle = queue.run(7, async () => {
      state = reduceTabState(state, { type: 'TOGGLE_TRANSCRIPTION' })
    })

    expect(state?.transcription).toBe('inactive')
    releaseFirst?.()
    await Promise.all([contextUpdate, toggle])
    expect(state).toMatchObject({
      context: sameIdentityUpdated,
      transcription: 'active',
    })
  })

  it('does not block operations for different tabs', async () => {
    const queue = new TabOperationQueue()
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const blocked = queue.run(1, () => gate)
    await expect(queue.run(2, async () => 'ready')).resolves.toBe('ready')
    release?.()
    await blocked
  })
})
