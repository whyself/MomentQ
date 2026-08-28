/** MomentQ local companion: Baidu ASR orchestration for the browser extension. */

import { loadConfig, baiduConfigured } from './config'
import { startCompanionServer } from './server'

const config = loadConfig()

if (!baiduConfigured(config.baidu)) {
  console.warn('[momentq-companion] 百度 ASR 未配置（BAIDU_ASR_APP_ID / BAIDU_ASR_API_KEY / BAIDU_ASR_SECRET_KEY）；'
    + '服务将启动，但开始转录时会返回 provider-not-configured。')
}

const server = await startCompanionServer(config)
console.log(`[momentq-companion] listening on http://127.0.0.1:${server.port} (provider: ${config.provider})`)
console.log(`[momentq-companion] DSH Host: ${config.hostBaseUrl}`)

let closing = false
async function shutdown(signal: string): Promise<void> {
  if (closing) return
  closing = true
  console.log(`[momentq-companion] received ${signal}, closing`)
  await server.close()
  process.exit(0)
}

process.on('SIGINT', () => { void shutdown('SIGINT') })
process.on('SIGTERM', () => { void shutdown('SIGTERM') })
