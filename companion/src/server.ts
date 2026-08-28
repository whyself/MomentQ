/** Local HTTP + WebSocket surface for the browser extension. */

import { createServer } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import type { CompanionConfig } from './config'
import { baiduConfigured } from './config'
import { AsrSession } from './session'
import { isCompanionClientMessage } from '../../shared/src/companion-protocol'

export type CompanionServerHandle = {
  port: number
  close: () => Promise<void>
}

const MAX_FRAME_BYTES = 64 * 1024

export function startCompanionServer(
  config: CompanionConfig,
  options: {
    fetcher?: typeof fetch | undefined
    now?: (() => number) | undefined
    socketFactory?: ((url: string) => WebSocket) | undefined
  } = {},
): Promise<CompanionServerHandle> {
  const server = createServer((request, response) => {
    if (request.method === 'GET' && (request.url === '/health' || request.url === '/health/')) {
      const body = JSON.stringify({
        ok: true,
        provider: config.provider,
        configured: baiduConfigured(config.baidu),
      })
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
      response.end(body)
      return
    }
    response.writeHead(404).end()
  })
  const webSocketServer = new WebSocketServer({ server, maxPayload: MAX_FRAME_BYTES })

  webSocketServer.on('connection', (socket: WebSocket) => {
    let session: AsrSession | undefined
    socket.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) {
        void session?.feedAudio(Buffer.from(data as ArrayBuffer))
        return
      }
      let message: unknown
      try {
        message = JSON.parse(data.toString())
      } catch {
        socket.send(JSON.stringify({ type: 'error', code: 'invalid-message', message: 'MomentQ companion received an invalid message' }))
        return
      }
      if (!isCompanionClientMessage(message)) {
        socket.send(JSON.stringify({ type: 'error', code: 'invalid-message', message: 'MomentQ companion received an invalid message' }))
        return
      }
      if (message.type === 'start') {
        if (session !== undefined) return
        if (!baiduConfigured(config.baidu)) {
          socket.send(JSON.stringify({
            type: 'error',
            code: 'provider-not-configured',
            message: '百度 ASR 未配置：请在 companion 进程环境提供 BAIDU_ASR_APP_ID / BAIDU_ASR_API_KEY / BAIDU_ASR_SECRET_KEY',
          }))
          socket.close()
          return
        }
        session = new AsrSession({
          identity: message.identity,
          baidu: {
            appId: config.baidu.appId!,
            apiKey: config.baidu.apiKey!,
            secretKey: config.baidu.secretKey!,
            devPid: config.baidu.devPid,
          },
          hostBaseUrl: config.hostBaseUrl,
          provider: config.provider,
          fetcher: options.fetcher,
          now: options.now,
          socketFactory: options.socketFactory,
        }, {
          send: message => {
            if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message))
          },
        })
      }
      if (session !== undefined) void session.handleClientMessage(message)
    })
    socket.on('close', () => { void session?.stop() })
    socket.on('error', () => { void session?.stop() })
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, '127.0.0.1', () => {
      const address = server.address()
      const boundPort = typeof address === 'object' && address !== null ? address.port : config.port
      resolve({
        port: boundPort,
        close: async () => {
          for (const client of webSocketServer.clients) client.terminate()
          await new Promise<void>(resolveClose => webSocketServer.close(() => resolveClose()))
          // Upgraded WebSocket sockets keep the HTTP server's close callback
          // pending; force any stragglers shut.
          server.closeAllConnections()
          await new Promise<void>(resolveClose => server.close(() => resolveClose()))
        },
      })
    })
  })
}
