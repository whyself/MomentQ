import { WebSocket, WebSocketServer } from 'ws'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { startCompanionServer } from '../src/server'
import type { CompanionConfig } from '../src/config'
import type { CompanionServerMessage } from '../../shared/src/companion-protocol'

const identity = { kind: 'vod', bvid: 'BV1xx411c7mD', cid: '42' } as const

const config: CompanionConfig = {
  port: 0,
  hostBaseUrl: 'http://127.0.0.1:3182',
  provider: 'baidu',
  baidu: { appId: 'app', apiKey: 'key', secretKey: 'secret', devPid: 80001 },
}

/** Queue-based frame reader: attach once per socket, await frames in order. */
function makeReader(socket: WebSocket): () => Promise<CompanionServerMessage> {
  const queue: CompanionServerMessage[] = []
  const waiters: Array<(message: CompanionServerMessage) => void> = []
  socket.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
    if (isBinary) return
    const message = JSON.parse(data.toString()) as CompanionServerMessage
    const waiter = waiters.shift()
    if (waiter !== undefined) waiter(message)
    else queue.push(message)
  })
  return () => new Promise((resolve, reject) => {
    const queued = queue.shift()
    if (queued !== undefined) return resolve(queued)
    const timer = setTimeout(() => reject(new Error('timed out waiting for companion message')), 2_000)
    waiters.push(message => {
      clearTimeout(timer)
      resolve(message)
    })
  })
}

async function startHarness(overrides: {
  baidu?: CompanionConfig['baidu']
  configFile?: string
  /** Rows the mock Host returns for getTranscript (the reopen-restore seed). */
  seedSegments?: Array<{ start: number; end: number; text: string }>
} = {}): Promise<{
  port: number
  connect: () => Promise<{ socket: WebSocket; nextMessage: () => Promise<CompanionServerMessage> }>
  upstreamFrames: unknown[]
  hostCalls: Array<{ url: string; body: unknown }>
  broadcastUpstream: (frame: unknown) => void
  close: () => Promise<void>
}> {
  // Fake Baidu upstream: official protocol — nothing is replied on START;
  // recognition frames flow only as MID_TEXT/FIN_TEXT.
  const upstreamFrames: unknown[] = []
  let upstreamClients: WebSocket[] = []
  const upstream = await new Promise<WebSocketServer>((resolve) => {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    server.on('connection', socket => {
      upstreamClients.push(socket)
      socket.on('message', (data, isBinary) => {
        if (isBinary) return
        const frame = JSON.parse(data.toString()) as unknown
        upstreamFrames.push(frame)
        void frame
      })
    })
    server.on('listening', () => resolve(server))
  })
  const upstreamAddress = upstream.address() as { port: number }

  // Mock fetch: OAuth token endpoint plus the MomentQ Host API.
  const hostCalls: Array<{ url: string; body: unknown }> = []
  const fetcher = (async (input: URL | string, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.includes('oauth/2.0/token')) {
      return Response.json({ access_token: 'tk', expires_in: 3600 })
    }
    if (url.includes('/momentq/api')) {
      const request = JSON.parse(String(init?.body ?? '{}')) as { method?: string }
      hostCalls.push({ url, body: request })
      const value = request.method === 'getTranscript'
        ? { source: 'asr', segments: overrides.seedSegments ?? [] }
        : { contentKey: 'k', source: 'asr', segments: 1 }
      return Response.json({ ok: true, value })
    }
    throw new Error(`unexpected fetch ${url}`)
  }) as unknown as typeof fetch

  const effective: CompanionConfig = {
    ...config,
    baidu: overrides.baidu ?? config.baidu,
  }
  const handle = await startCompanionServer(effective, {
    fetcher,
    socketFactory: () => new WebSocket(`ws://127.0.0.1:${upstreamAddress.port}`),
    ...(overrides.configFile === undefined ? {} : { configFilePath: overrides.configFile }),
  })

  return {
    port: handle.port,
    upstreamFrames,
    hostCalls,
    connect: async () => {
      // The upgrade handshake rejects non-extension origins (drive-by
      // webpage protection), so the test client presents one.
      const socket = new WebSocket(`ws://127.0.0.1:${handle.port}`, {
        headers: { origin: 'chrome-extension://momentq-test' },
      })
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve(), { once: true })
        socket.addEventListener('error', () => reject(new Error('connect failed')), { once: true })
      })
      return { socket, nextMessage: makeReader(socket) }
    },
    broadcastUpstream: frame => {
      for (const client of upstreamClients) {
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(frame))
      }
    },
    close: async () => {
      // Terminate every socket first: both servers' close callbacks wait for
      // their connections to disappear.
      for (const client of upstreamClients) client.terminate()
      upstreamClients = []
      await handle.close()
      await new Promise(done => upstream.close(() => done(undefined)))
    },
  }
}

describe('companion ASR server', () => {
  it('reports health and provider configuration', async () => {
    const harness = await startHarness()
    try {
      const response = await fetch(`http://127.0.0.1:${harness.port}/health`)
      expect(await response.json()).toMatchObject({ ok: true, provider: 'baidu', configured: true, configApi: true })
    } finally {
      await harness.close()
    }
  })

  it('anchors finals to the media clock and persists to the Host', async () => {
    const harness = await startHarness()
    try {
      const { socket, nextMessage } = await harness.connect()
      socket.send(JSON.stringify({ type: 'start', identity }))
      expect(await nextMessage()).toEqual({ type: 'ready', provider: 'baidu' })
      expect(harness.upstreamFrames.some(frame => (frame as { type?: string }).type === 'START')).toBe(true)

      // Anchor: 1 s of audio has already streamed when media reads 100 s.
      socket.send(Buffer.alloc(32_000)) // 1 s of 16k/16bit PCM
      socket.send(JSON.stringify({ type: 'clock', mediaTime: 100 }))
      socket.send(Buffer.alloc(32_000)) // 1 more second of audio

      // Attach readers before broadcasting: final and persisted are emitted
      // back-to-back once the upstream finalizes the sentence.
      const partialPromise = nextMessage()
      const finalPromise = nextMessage()
      const persistedPromise = nextMessage()
      harness.broadcastUpstream({
        type: 'MID_TEXT', err_no: 0, result: ' 部分结果',
      })
      expect(await partialPromise).toEqual({ type: 'partial', text: '部分结果' })
      harness.broadcastUpstream({
        type: 'FIN_TEXT', err_no: 0, result: '完整句子',
      })
      const final = await finalPromise
      expect(final.type).toBe('final')
      if (final.type === 'final') {
        expect(final.text).toBe('完整句子')
        expect(final.start).toBeCloseTo(100, 0)
        expect(final.end).toBeCloseTo(101, 0)
      }
      const persisted = await persistedPromise
      expect(persisted).toEqual({ type: 'persisted', segments: 1 })

      const sync = harness.hostCalls.find(call => (call.body as { method?: string }).method === 'syncTranscript')
      expect(sync).toBeDefined()
      expect((sync!.body as { params: { source: string; segments: Array<{ text: string }> } }).params.source).toBe('asr')
      expect((sync!.body as { params: { segments: Array<{ text: string }> } }).params.segments[0]?.text).toBe('完整句子')
      socket.close()
    } finally {
      await harness.close()
    }
  })

  it('seeds the previous transcript on reopen and keeps coverage unique', async () => {
    const harness = await startHarness({
      seedSegments: [
        { start: 20, end: 22, text: '更早的历史句子' },
        { start: 100, end: 101, text: '上次识别的旧结果' },
      ],
    })
    try {
      const { socket, nextMessage } = await harness.connect()
      socket.send(JSON.stringify({ type: 'start', identity }))
      expect(await nextMessage()).toEqual({ type: 'ready', provider: 'baidu' })

      // Anchor: 1 s of audio streamed when media reads 100 s; the next
      // finalized sentence re-covers 100–101, so it must REPLACE the seeded
      // row for that range while the untouched 20–22 row survives.
      socket.send(Buffer.alloc(32_000))
      socket.send(JSON.stringify({ type: 'clock', mediaTime: 100 }))
      socket.send(Buffer.alloc(32_000))
      const finalPromise = nextMessage()
      const persistedPromise = nextMessage()
      harness.broadcastUpstream({ type: 'FIN_TEXT', err_no: 0, result: '重看区域的新识别' })
      const final = await finalPromise
      expect(final.type).toBe('final')
      await persistedPromise

      const sync = harness.hostCalls.filter(call => (call.body as { method?: string }).method === 'syncTranscript').at(-1)
      expect(sync).toBeDefined()
      const segments = (sync!.body as { params: { segments: Array<{ start: number; text: string }> } }).params.segments
      expect(segments).toEqual([
        { start: 20, end: 22, text: '更早的历史句子' },
        { start: 100, end: 101, text: '重看区域的新识别' },
      ])
      socket.close()
    } finally {
      await harness.close()
    }
  })

  it('answers with an error frame for invalid JSON instead of crashing', async () => {
    const harness = await startHarness()
    try {
      const { socket, nextMessage } = await harness.connect()
      socket.send('not-json')
      expect(await nextMessage()).toMatchObject({ type: 'error', code: 'invalid-message' })
      socket.close()
    } finally {
      await harness.close()
    }
  })

  it('stores settings-page credentials locally and redacts them on read', async () => {
    const configFile = join(tmpdir(), `momentq-companion-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
    const harness = await startHarness({ baidu: { devPid: 80001 }, configFile })
    try {
      const base = `http://127.0.0.1:${harness.port}`
      await expect((await fetch(`${base}/health`)).json()).resolves.toEqual({
        ok: true, provider: 'baidu', configured: false, configApi: true,
      })

      const saved = await fetch(`${base}/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appId: '124213197', apiKey: 'abcdefgh', secretKey: 'sk' }),
      })
      expect(saved.status).toBe(200)
      expect(await saved.json()).toEqual({ ok: true, value: { saved: true } })

      await expect((await fetch(`${base}/health`)).json()).resolves.toEqual({
        ok: true, provider: 'baidu', configured: true, configApi: true,
      })
      await expect((await fetch(`${base}/config`)).json()).resolves.toEqual({
        ok: true,
        value: {
          provider: 'baidu',
          baidu: {
            configured: true, appId: '124213197', apiKeyMasked: 'ab****gh', apiKeyLength: 8,
            secretKeySet: true, secretKeyLength: 2, devPid: 80001,
          },
        },
      })
      // Credentials persist to the local file for the next start.
      const stored = JSON.parse(await readFile(configFile, 'utf8')) as {
        baidu: { appId: string; apiKey: string; secretKey: string }
      }
      expect(stored.baidu).toEqual({ appId: '124213197', apiKey: 'abcdefgh', secretKey: 'sk', devPid: 80001 })

      const bad = await fetch(`${base}/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appId: '124213197' }),
      })
      expect(bad.status).toBe(400)
    } finally {
      await harness.close()
    }
  })

  it('ends the session when the client disconnects, finishing the upstream', async () => {
    const harness = await startHarness()
    try {
      const { socket, nextMessage } = await harness.connect()
      socket.send(JSON.stringify({ type: 'start', identity }))
      await nextMessage()
      socket.close()
      await new Promise(done => setTimeout(done, 50))
      expect(harness.upstreamFrames.some(frame => (frame as { type?: string }).type === 'FINISH')).toBe(true)
    } finally {
      await harness.close()
    }
  })
})
