import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import MomentQService from '../src/index.ts'
import { readState } from '../src/state.ts'

const roots: string[] = []
const originalDshHome = process.env.DSH_HOME

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  if (originalDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalDshHome
})

interface FakeHarness {
  ctx: Context
  root: string
  create: ReturnType<typeof vi.fn>
  resume: ReturnType<typeof vi.fn>
  mount: ReturnType<typeof vi.fn>
  archive: ReturnType<typeof vi.fn>
  flush: ReturnType<typeof vi.fn>
  persisted: Array<{ id: string; cwd: string; agentPreset: string }>
  locations: Map<string, string>
  live: Map<string, any>
}

async function harness(): Promise<FakeHarness> {
  const root = await mkdtemp(join(tmpdir(), 'momentq-host-'))
  roots.push(root)
  process.env.DSH_HOME = join(root, 'dsh-home')
  await mkdir(join(root, 'dsh-home', 'sessions'), { recursive: true })

  const ctx = new Context()
  const live = new Map<string, any>()
  const persisted: FakeHarness['persisted'] = []
  const locations = new Map<string, string>()
  const mount = vi.fn(async () => ({ id: 'momentq' }))
  const flush = vi.fn(async () => true)
  const archive = vi.fn(async () => {})

  const makeHandle = async (options: any) => {
    await options.setup?.(ctx)
    const header = {
      version: 0,
      id: options.sessionId ?? options.resumeSessionId,
      createdAt: Date.now(),
      cwd: options.meta?.cwd ?? persisted.find(item => item.id === options.resumeSessionId)?.cwd,
      agentPreset: options.meta?.agentPreset
        ?? persisted.find(item => item.id === options.resumeSessionId)?.agentPreset,
    }
    const session = { id: header.id, header, events: [] }
    const agent = {
      id: header.id,
      session,
      status: 'idle',
      cancel: vi.fn(),
      whenIdle: vi.fn(async () => {}),
    }
    const handle = {
      agent,
      dispose: vi.fn(async () => { live.delete(String(agent.id)) }),
    }
    live.set(String(agent.id), agent)
    return handle
  }
  const create = vi.fn(makeHandle)
  const resume = vi.fn(makeHandle)

  ctx.provide('agents', { get: (id: string) => live.get(String(id)), create, resume } as never)
  ctx.provide('sessions', { flush } as never)
  ctx.provide('agentPresets', { mount } as never)
  ctx.provide('workspaceRegistry', { archiveSession: archive } as never)
  ctx.provide('sessionPersistence', {
    list: async () => persisted.map(item => ({
      version: 0, id: item.id, createdAt: 0, cwd: item.cwd, agentPreset: item.agentPreset,
    })),
    inspect: async (id: string) => {
      const item = persisted.find(candidate => candidate.id === String(id))
      if (item === undefined) throw new Error('missing persisted Session')
      return { meta: { version: 0, id: item.id, createdAt: 0, cwd: item.cwd, agentPreset: item.agentPreset }, events: [] }
    },
    locate: (header: { id: string }) => {
      const path = locations.get(String(header.id))
      return path === undefined ? undefined : { kind: 'jsonl', path }
    },
  } as never)

  await ctx.plugin(MomentQService, { root, defaultInstructions: 'Default instructions' })
  return { ctx, root, create, resume, mount, archive, flush, persisted, locations, live }
}

const request = {
  identity: { kind: 'vod', bvid: 'BV1xx', cid: '42' } as const,
  metadata: { title: 'Title', creator: { name: 'Uploader' } },
}

describe.sequential('MomentQ Host service', () => {
  it('creates one Agent for concurrent requests and fixes cwd, Preset and vision model', async () => {
    const h = await harness()
    const [first, second] = await Promise.all([
      h.ctx.momentq.ensureContent({ ...request, sessionInstructions: 'Custom' }),
      h.ctx.momentq.ensureContent({ ...request, sessionInstructions: 'Changed' }),
    ])

    expect(first).toEqual(second)
    expect(h.create).toHaveBeenCalledOnce()
    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: first.sessionId,
      meta: { cwd: first.cwd, agentPreset: 'momentq' },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' },
    }))
    expect(h.mount).toHaveBeenCalledWith(expect.anything(), 'momentq')
    expect((await readState(first.cwd)).session.active?.instructions).toBe('Custom')
  })

  it('serializes different operations instead of returning the wrong operation result', async () => {
    const h = await harness()
    const [ensured, deleted] = await Promise.all([
      h.ctx.momentq.ensureContent(request),
      h.ctx.momentq.deleteContent(request.identity),
    ])
    expect(ensured).toMatchObject({ contentKey: 'bilibili:vod:BV1xx:42', created: true })
    expect(deleted).toEqual({ deleted: true })
    await expect(stat(ensured.cwd)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('resumes one matching persisted Session and rejects a cwd conflict', async () => {
    const h = await harness()
    const initial = await h.ctx.momentq.ensureContent(request)
    h.live.clear()
    h.persisted.push({ id: String(initial.sessionId), cwd: initial.cwd, agentPreset: 'momentq' })

    await h.ctx.momentq.ensureContent(request)
    expect(h.resume).toHaveBeenCalledOnce()

    h.live.clear()
    h.persisted[0]!.cwd = join(h.root, 'other')
    await expect(h.ctx.momentq.ensureContent(request)).rejects.toThrow(/cwd/)
  })

  it('deletes only the current Session artifact and creates a new generation', async () => {
    const h = await harness()
    const initial = await h.ctx.momentq.ensureContent(request)
    const artifact = join(h.root, 'dsh-home', 'sessions', 'project', String(initial.sessionId), 'session.jsonl.zstd')
    await mkdir(dirname(artifact), { recursive: true })
    await writeFile(artifact, 'session')
    h.locations.set(String(initial.sessionId), artifact)

    const next = await h.ctx.momentq.deleteSession(request.identity)
    expect(next.previousSessionId).toBe(initial.sessionId)
    expect(next.sessionId).not.toBe(initial.sessionId)
    await expect(stat(dirname(artifact))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(initial.cwd, 'transcript.jsonl'), 'utf8')).toBe('')
    expect((await readState(initial.cwd)).session.retired.at(-1)?.disposition).toBe('deleted')
  })

  it('deletes all recorded Session artifacts and then the content directory', async () => {
    const h = await harness()
    const initial = await h.ctx.momentq.ensureContent(request)
    const artifact = join(h.root, 'dsh-home', 'sessions', 'project', String(initial.sessionId), 'session.jsonl.zstd')
    await mkdir(dirname(artifact), { recursive: true })
    await writeFile(artifact, 'session')
    h.locations.set(String(initial.sessionId), artifact)

    await expect(h.ctx.momentq.deleteContent(request.identity)).resolves.toEqual({ deleted: true })
    await expect(stat(initial.cwd)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(dirname(artifact))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a Session directory redirected to another directory inside DSH_HOME', async () => {
    const h = await harness()
    const initial = await h.ctx.momentq.ensureContent(request)
    const sessionsRoot = join(h.root, 'dsh-home', 'sessions')
    const victim = join(sessionsRoot, 'project', 'victim')
    const victimArtifact = join(victim, 'session.jsonl.zstd')
    const linkedDirectory = join(sessionsRoot, 'project', String(initial.sessionId))
    await mkdir(victim, { recursive: true })
    await writeFile(victimArtifact, 'must survive')
    await symlink(victim, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir')
    h.locations.set(String(initial.sessionId), join(linkedDirectory, 'session.jsonl.zstd'))

    await expect(h.ctx.momentq.deleteSession(request.identity)).rejects.toThrow(/filesystem link/)
    await expect(readFile(victimArtifact, 'utf8')).resolves.toBe('must survive')
  })

  it('fails fast when DSH_HOME is outside the configured root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'momentq-host-mismatch-'))
    roots.push(root)
    process.env.DSH_HOME = join(root, 'elsewhere')
    const ctx = new Context()
    for (const name of ['agents', 'sessions', 'agentPresets', 'workspaceRegistry', 'sessionPersistence']) {
      ctx.provide(name as never, {} as never)
    }
    await expect(ctx.plugin(MomentQService, { root: join(root, 'data') })).rejects.toThrow(/DSH_HOME/)
  })

  it('does not introduce a profile dependency cycle through agentPresets', () => {
    expect(MomentQService.inject).not.toContain('agentPresets')
  })
})
