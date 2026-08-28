/** Companion runtime configuration. Credentials never pass through the extension. */

export type BaiduAsrConfig = {
  appId?: string
  apiKey?: string
  secretKey?: string
  devPid: number
}

export type CompanionConfig = {
  port: number
  hostBaseUrl: string
  provider: 'baidu'
  baidu: BaiduAsrConfig
}

function port(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed < 65_536 ? parsed : fallback
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CompanionConfig {
  const appId = env.BAIDU_ASR_APP_ID?.trim()
  const apiKey = env.BAIDU_ASR_API_KEY?.trim()
  const secretKey = env.BAIDU_ASR_SECRET_KEY?.trim()
  return {
    port: port(env.MOMENTQ_COMPANION_PORT, 3090),
    hostBaseUrl: env.MOMENTQ_HOST_BASE_URL?.trim() || 'http://127.0.0.1:3182',
    provider: 'baidu',
    baidu: {
      ...(appId !== undefined && appId !== '' ? { appId } : {}),
      ...(apiKey !== undefined && apiKey !== '' ? { apiKey } : {}),
      ...(secretKey !== undefined && secretKey !== '' ? { secretKey } : {}),
      devPid: port(env.BAIDU_ASR_DEV_PID, 80001),
    },
  }
}

export function baiduConfigured(baidu: BaiduAsrConfig): boolean {
  return baidu.appId !== undefined && baidu.apiKey !== undefined && baidu.secretKey !== undefined
}
