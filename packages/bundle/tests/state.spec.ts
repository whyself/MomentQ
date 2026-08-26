import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureState, readState, writeState } from '../src/state.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function freshDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'momentq-state-'))
  roots.push(root)
  return join(root, 'content')
}

const identity = { kind: 'vod', bvid: 'BV1xx', cid: '42' } as const
const metadata = {
  title: 'First title',
  description: 'Description',
  creator: { id: '7', name: 'Uploader' },
  part: { number: 1, title: 'Part one' },
  durationSeconds: 120,
  publishedAt: '2026-08-25T12:00:00+08:00',
  tags: ['knowledge'],
}

describe('MomentQ state persistence', () => {
  it('creates state and an empty transcript with the effective default instruction', async () => {
    const directory = await freshDirectory()
    const result = await ensureState({
      directory,
      identity,
      metadata,
      defaultInstructions: '  Default instruction  ',
      requestedInstructions: '   ',
      maxInstructionsLength: 4000,
    })

    expect(result.created).toBe(true)
    expect(result.state.session.active).toMatchObject({
      id: expect.stringMatching(/^momentq-[0-9a-f]{32}-g0$/),
      presetId: 'momentq',
      instructions: 'Default instruction',
    })
    expect(result.state.session).toMatchObject({ generation: 0, retired: [] })
    expect(await readFile(join(directory, 'transcript.jsonl'), 'utf8')).toBe('')
    expect(JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'))).toEqual(result.state)
  })

  it('preserves Session fields while refreshing metadata', async () => {
    const directory = await freshDirectory()
    const first = await ensureState({
      directory,
      identity,
      metadata,
      defaultInstructions: 'Default',
      requestedInstructions: 'Custom',
      maxInstructionsLength: 4000,
    })
    const second = await ensureState({
      directory,
      identity,
      metadata: { ...metadata, title: 'Updated title' },
      defaultInstructions: 'Changed default',
      requestedInstructions: 'Changed custom',
      maxInstructionsLength: 4000,
    })

    expect(second.created).toBe(false)
    expect(second.state.metadata.title).toBe('Updated title')
    expect(second.state.session).toEqual(first.state.session)
  })

  it('serializes concurrent initialization into one valid state', async () => {
    const directory = await freshDirectory()
    const [first, second] = await Promise.all([
      ensureState({ directory, identity, metadata, defaultInstructions: 'Default', maxInstructionsLength: 4000 }),
      ensureState({ directory, identity, metadata, defaultInstructions: 'Default', maxInstructionsLength: 4000 }),
    ])
    expect([first.created, second.created].sort()).toEqual([false, true])
    expect(first.state.session).toEqual(second.state.session)
    await expect(readState(directory)).resolves.toEqual(first.state)
  })

  it('rejects invalid JSON, versions and identity replacement', async () => {
    const directory = await freshDirectory()
    await ensureState({ directory, identity, metadata, defaultInstructions: 'Default', maxInstructionsLength: 4000 })

    await writeFile(join(directory, 'state.json'), '{broken', 'utf8')
    await expect(readState(directory)).rejects.toThrow(/invalid JSON/)

    await writeFile(join(directory, 'state.json'), JSON.stringify({ schemaVersion: 2 }), 'utf8')
    await expect(readState(directory)).rejects.toThrow(/invalid MomentQ state/)

    await ensureState({ directory, identity, metadata, defaultInstructions: 'Default', maxInstructionsLength: 4000 })
      .catch(() => {})
    const restored = await freshDirectory()
    await ensureState({ directory: restored, identity, metadata, defaultInstructions: 'Default', maxInstructionsLength: 4000 })
    await expect(ensureState({
      directory: restored,
      identity: { kind: 'vod', bvid: 'BV1yy', cid: '99' },
      metadata,
      defaultInstructions: 'Default',
      maxInstructionsLength: 4000,
    })).rejects.toThrow(/identity does not match/)
  })

  it('rejects overlong instructions by Unicode code point', async () => {
    await expect(ensureState({
      directory: await freshDirectory(),
      identity,
      metadata,
      defaultInstructions: 'Default',
      requestedInstructions: '😀😀😀',
      maxInstructionsLength: 2,
    })).rejects.toThrow(/at most 2/)
  })

  it('validates updates before publishing them', async () => {
    const directory = await freshDirectory()
    const initial = await ensureState({
      directory,
      identity,
      metadata,
      defaultInstructions: 'Default',
      maxInstructionsLength: 4000,
    })
    await expect(writeState(directory, {
      ...initial.state,
      schemaVersion: 2 as 1,
    })).rejects.toThrow(/invalid MomentQ state/)
    await expect(readState(directory)).resolves.toEqual(initial.state)
  })

  it('rejects Session ids that do not belong to the recorded identity and generation', async () => {
    const directory = await freshDirectory()
    const initial = await ensureState({
      directory,
      identity,
      metadata,
      defaultInstructions: 'Default',
      maxInstructionsLength: 4000,
    })
    const corrupted = {
      ...initial.state,
      session: {
        ...initial.state.session,
        active: { ...initial.state.session.active!, id: 'momentq-someone-else-g0' },
      },
    }
    await writeFile(join(directory, 'state.json'), JSON.stringify(corrupted), 'utf8')
    await expect(readState(directory)).rejects.toThrow(/Session id does not match generation/)
  })
})
