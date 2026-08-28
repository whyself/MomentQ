/** MomentQ local companion: Baidu ASR orchestration for the browser extension. */

import { loadConfig, baiduConfigured } from './config'
import { startCompanionServer } from './server'

const config = loadConfig()

// startCompanionServer merges stored credentials (settings-page saves) into
// the config, so the readiness verdict must come after it, not before.
const server = await startCompanionServer(config)
if (!baiduConfigured(config.baidu)) {
  console.warn('[momentq-companion] 百度 ASR 未配置（环境变量 BAIDU_ASR_* 或设置页保存的凭据均缺失）；'
    + '服务将启动，但开始转录时会返回 provider-not-configured。')
} else {
  console.log(`[momentq-companion] 百度 ASR 凭据已就绪（appId: ${config.baidu.appId}）`)
}
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
