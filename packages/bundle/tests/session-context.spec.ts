import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, modelMetadata } from '../src/session-context.ts'
import { ensureState, readState, writeState } from '../src/state.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'momentq-context-'))
  roots.push(directory)
  const result = await ensureState({
    directory,
    identity: { kind: 'vod', bvid: 'BV1xx', cid: '42' },
    metadata: {
      title: 'Title\nwith newline',
      description: `Description ${'x'.repeat(2100)}`,
      creator: { id: 'creator-secret-id', name: 'Uploader\r\nName' },
      part: { number: 1, title: 'Part\nOne' },
      durationSeconds: 120,
      publishedAt: '2026-08-25T12:00:00+08:00',
      tags: Array.from({ length: 12 }, (_, index) => `tag-${index}-${'y'.repeat(60)}`),
    },
    defaultInstructions: 'Default',
    requestedInstructions: 'Session instruction',
    maxInstructionsLength: 4000,
  })
  return { directory, state: result.state, active: result.state.session.active! }
}

function fakeContext(directory: string, sessionId: string) {
  const section = vi.fn()
  return {
    section,
    ctx: {
      agent: { id: sessionId, session: { header: { cwd: directory } } },
      systemPrompt: { section },
    } as unknown as Context,
  }
}

describe('MomentQ Session context', () => {
  it('registers frozen instructions and safe metadata sections', async () => {
    const { directory, active } = await fixture()
    const h = fakeContext(directory, active.id)
    await apply(h.ctx)

    expect(h.section).toHaveBeenNthCalledWith(1, {
      name: 'momentq:session-instructions',
      order: 10,
      text: '<session-instructions>\nSession instruction\n</session-instructions>',
    })
    const metadataSection = h.section.mock.calls[1]?.[0]
    expect(metadataSection).toMatchObject({ name: 'momentq:content-metadata', order: 20 })
    expect(metadataSection.text).toContain('"title": "Title with newline"')
    expect(metadataSection.text).toContain('"creator": "Uploader Name"')
    expect(metadataSection.text).toContain('"title": "Part One"')
    expect(metadataSection.text).not.toContain('creator-secret-id')
    expect(metadataSection.text).not.toContain(active.id)
    expect(metadataSection.text).not.toContain(directory)
  })

  it('caps description and tags in the model projection', async () => {
    const { state } = await fixture()
    const projected = modelMetadata(state)
    expect(projected.description).toHaveLength(2000)
    expect(projected.tags).toHaveLength(10)
    expect(projected.tags?.every(tag => [...tag].length <= 50)).toBe(true)
  })

  it('finds the original instructions when an archived Session is resumed', async () => {
    const { directory, state, active } = await fixture()
    await writeState(directory, {
      ...state,
      session: {
        generation: 0,
        active: null,
        retired: [{ ...active, generation: 0, disposition: 'archived', retiredAt: new Date().toISOString() }],
      },
    })
    const h = fakeContext(directory, active.id)
    await apply(h.ctx)
    expect(h.section.mock.calls[0]?.[0].text).toContain('Session instruction')
  })

  it('fails when cwd, state or matching Session ownership is absent', async () => {
    const { directory } = await fixture()
    await expect(apply({ agent: { id: 'x', session: { header: {} } } } as unknown as Context))
      .rejects.toThrow(/cwd/)
    await expect(apply(fakeContext(directory, 'not-owned').ctx)).rejects.toThrow(/not recorded/)
    await expect(readState(directory)).resolves.toBeDefined()
  })
})

