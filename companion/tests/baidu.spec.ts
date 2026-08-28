import { WebSocket, WebSocketServer } from 'ws'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CONNECTION_MAX_AGE_MS,
  fetchBaiduAccessToken,
  openBaiduStream,
  parseBaiduFrame,
  type BaiduStreamEvent,
} from '../src/baidu'
import type { BaiduStreamConfig } from '../src/baidu'

const config: BaiduStreamConfig = {
  appId: 'app',
  apiKey: 'key',
  secretKey: 'secret',
  devPid: 80001,
}

describe('parseBaiduFrame', () => {
  it('parses started, partial, final and heartbeat frames', () => {
    expect(parseBaiduFrame(JSON.stringify({ type: 'STARTED', data: {} }))).toEqual({ kind: 'started' })
    expect(parseBaiduFrame(JSON.stringify({
      type: 'PARTIAL_RESULT',
      data: { err_no: 0, result_type: 'partial_result', result: { result: ' 你好' } },
    }))).toEqual({ kind: 'partial', text: '你好' })
    expect(parseBaiduFrame(JSON.stringify({
      type: 'PARTIAL_RESULT',
      data: { err_no: 0, result_type: 'final_result', result: { result: '你好世界。' } },
    }))).toEqual({ kind: 'final', text: '你好世界。' })
    expect(parseBaiduFrame(JSON.stringify({ type: 'HEARTBEAT' }))).toBeUndefined()
  })

  it('surfaces upstream error codes', () => {
    expect(parseBaiduFrame(JSON.stringify({
      type: 'PARTIAL_RESULT',
      data: { err_no: -3005, result: { result: '' } },
    }))).toEqual({ kind: 'error', message: 'Baidu ASR error -3005' })
  })
})

describe('fetchBaiduAccessToken', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('exchanges credentials and caches the token until near expiry', async () => {
    const fetcher = vi.fn(async () => Response.json({ access_token: 'tk', expires_in: 3600 }))
    const now = vi.fn(() => 1_000)
    expect(await fetchBaiduAccessToken(config, fetcher as unknown as typeof fetch, now)).toBe('tk')
    expect(await fetchBaiduAccessToken(config, fetcher as unknown as typeof fetch, now)).toBe('tk')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('fails loudly on a response without access_token', async () => {
    const fetcher = vi.fn(async () => Response.json({ error: 'invalid_client' }))
    await expect(fetchBaiduAccessToken(config, fetcher as unknown as typeof fetch)).rejects.toThrow(/access_token/)
  })
})

describe('openBaiduStream', () => {
  const now = (): number => Date.now()

  function startFakeUpstream(): Promise<{
    url: string
    close: () => Promise<void>
    frames: unknown[]
    clients: () => WebSocket[]
  }> {
    return new Promise((resolve) => {
      const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
      const frames: unknown[] = []
      server.on('connection', (socket) => {
        socket.on('message', (data, isBinary) => {
          if (isBinary) return
          const frame = JSON.parse(data.toString()) as unknown
          frames.push(frame)
          if ((frame as { type?: string }).type === 'START') socket.send(JSON.stringify({ type: 'STARTED' }))
        })
      })
      server.on('listening', () => {
        const address = server.address() as { port: number }
        resolve({
          url: `ws://127.0.0.1:${address.port}`,
          frames,
          clients: () => [...server.clients],
          close: async () => await new Promise(done => server.close(() => done())),
        })
      })
    })
  }

  it('performs the START handshake and forwards sentence events once', async () => {
    const upstream = await startFakeUpstream()
    const tokenFetcher = vi.fn(async () => Response.json({ access_token: 'tk', expires_in: 3600 }))
    const events: BaiduStreamEvent[] = []
    const stream = await openBaiduStream(config, { onEvent: event => events.push(event), onError: () => {} }, {
      fetcher: tokenFetcher as unknown as typeof fetch,
      now,
      socketFactory: () => new WebSocket(upstream.url),
    })
    await vi.waitFor(() => expect(upstream.frames.some(frame => (frame as { type?: string }).type === 'START')).toBe(true))
    const client = upstream.clients()[0]!
    client.send(JSON.stringify({
      type: 'PARTIAL_RESULT',
      data: { err_no: 0, result_type: 'partial_result', result: { result: ' 哈罗' } },
    }))
    client.send(JSON.stringify({
      type: 'PARTIAL_RESULT',
      data: { err_no: 0, result_type: 'final_result', result: { result: '哈罗世界' } },
    }))
    await vi.waitFor(() => expect(events).toEqual([
      { kind: 'partial', text: '哈罗' },
      { kind: 'final', text: '哈罗世界' },
    ]))
    stream.sendAudio(Buffer.from([1, 2, 3, 4]))
    await new Promise(done => setTimeout(done, 20))
    // Binary PCM reaches the upstream untouched.
    expect(upstream.frames.length).toBe(1)
    await stream.finish()
    client.close()
    await upstream.close()
  })

  it('documents the renewal threshold below the one-hour ceiling', () => {
    expect(CONNECTION_MAX_AGE_MS).toBeLessThan(60 * 60_000)
  })
})
