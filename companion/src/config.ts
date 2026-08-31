/** Companion runtime configuration. Credentials never pass through the extension. */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

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

export type StoredBaiduCredentials = {
  appId: string
  apiKey: string
  secretKey: string
  devPid: number
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
      devPid: port(env.BAIDU_ASR_DEV_PID, 15372),
    },
  }
}

export function baiduConfigured(baidu: BaiduAsrConfig): boolean {
  return baidu.appId !== undefined && baidu.apiKey !== undefined && baidu.secretKey !== undefined
}

/**
 * Credentials entered in the settings page persist next to the user's home
 * directory (never inside the extension, never in the repository); env vars
 * keep precedence for headless setups.
 */
export function configFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.MOMENTQ_COMPANION_CONFIG_FILE?.trim()
  if (configured !== undefined && configured !== '') return resolve(configured)
  return resolve(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.momentq-companion.json')
}

function storedCredentials(value: unknown): StoredBaiduCredentials | null {
  if (typeof value !== 'object' || value === null) return null
  const baidu = (value as { baidu?: unknown }).baidu
  if (typeof baidu !== 'object' || baidu === null) return null
  const record = baidu as { appId?: unknown; apiKey?: unknown; secretKey?: unknown; devPid?: unknown }
  const { appId, apiKey, secretKey } = record
  if (typeof appId !== 'string' || appId === '' || typeof apiKey !== 'string' || apiKey === ''
    || typeof secretKey !== 'string' || secretKey === '') return null
  return {
    appId,
    apiKey,
    secretKey,
    devPid: port(typeof record.devPid === 'number' ? String(record.devPid) : undefined, 15372),
  }
}

export async function loadStoredBaiduCredentials(path: string): Promise<StoredBaiduCredentials | null> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return null // No file yet: simply unconfigured.
  }
  try {
    return storedCredentials(JSON.parse(raw))
  } catch (error) {
    // The user SAVED credentials that now silently read as absent — say so
    // instead of letting them wonder where their configuration went.
    console.error(`[momentq-companion] 凭据文件无法解析（${path}）：${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

export async function saveStoredBaiduCredentials(path: string, value: StoredBaiduCredentials): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  // 0600: the file holds a plaintext secretKey and must not be readable by
  // other local users (Windows ACLs on the user profile already scope it).
  await writeFile(path, `${JSON.stringify({ baidu: value }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
}
