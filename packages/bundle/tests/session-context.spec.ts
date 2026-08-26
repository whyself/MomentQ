import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import type { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { afterEach, describe, expect, it } from 'vitest'
import * as SessionContext from '../src/session-context.ts'
import { modelMetadata } from '../src/session-context.ts'
import { ensureState, readState, writeState } from '../src/state.ts'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
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

async function assemble(directory: string | undefined, sessionId: string) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt, {})
  const agent = {
    id: sessionId as SessionId,
    session: { header: directory === undefined ? {} : { cwd: directory } },
  } as Agent
  const scope = createScope(ctx, agent)
  await scope.ctx.plugin(SessionContext)
  return await ctx.systemPrompt.assemble({ scope: scopeOf(scope.ctx)!, agent })
}

describe('MomentQ Session context', () => {
  it('registers frozen instructions and safe metadata sections', async () => {
    const { directory, active } = await fixture()
    const assembly = await assemble(directory, active.id)
    expect(assembly.sections.find(section => section.name === 'momentq:session-instructions')).toEqual({
      name: 'momentq:session-instructions',
      text: '<session-instructions>\nSession instruction\n</session-instructions>',
    })
    const metadataSection = assembly.sections.find(section => section.name === 'momentq:content-metadata')!
    expect(metadataSection).toMatchObject({ name: 'momentq:content-metadata' })
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
    const assembly = await assemble(directory, active.id)
    expect(assembly.sections.find(section => section.name === 'momentq:session-instructions')?.text)
      .toContain('Session instruction')
  })

  it('fails when cwd, state or matching Session ownership is absent', async () => {
    const { directory } = await fixture()
    await expect(assemble(undefined, 'x')).rejects.toThrow(/cwd/)
    await expect(assemble(directory, 'not-owned')).rejects.toThrow(/not recorded/)
    await expect(readState(directory)).resolves.toBeDefined()
  })
})
