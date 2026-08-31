/**
 * ASR providers are descriptors, not extension code: recognition runs inside
 * the local companion, so adding a cloud vendor or a local model is a one-line
 * entry here plus a companion-side implementation. The extension never holds
 * provider credentials.
 */
export const ASR_PROVIDERS = [
  { id: 'baidu', label: '百度智能云' },
  { id: 'whisper-local', label: '本地 Whisper（备用）' },
] as const

export const WHISPER_MODELS = [
  { id: 'base', label: '快速 · base（默认）' },
  { id: 'small', label: '均衡 · small' },
  { id: 'large-turbo', label: '精准 · turbo（需 WebGPU）' },
] as const

export type WhisperModelId = (typeof WHISPER_MODELS)[number]['id']

export const SUBTITLE_MODES = ['append', 'replace'] as const
export const THEME_PREFERENCES = ['light', 'dark', 'system'] as const

export type AsrProviderId = (typeof ASR_PROVIDERS)[number]['id']
export type SubtitleMode = typeof SUBTITLE_MODES[number]
export type ThemePreference = typeof THEME_PREFERENCES[number]

export type ExtensionSettings = {
  version: 2
  hostBaseUrl: string
  companionBaseUrl: string
  asrProvider: AsrProviderId
  whisperModel: WhisperModelId
  subtitleMode: SubtitleMode
  autoConnect: boolean
  theme: ThemePreference
}

export const DEFAULT_SETTINGS: Readonly<ExtensionSettings> = Object.freeze({
  version: 2,
  hostBaseUrl: 'http://127.0.0.1:3182',
  companionBaseUrl: 'http://127.0.0.1:3090',
  asrProvider: 'baidu',
  whisperModel: 'base',
  subtitleMode: 'append',
  autoConnect: true,
  theme: 'system',
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function localHttpUrl(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' || (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost')) return fallback
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return fallback
    return url.origin
  } catch {
    return fallback
  }
}

function memberOf<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === 'string' && values.some(candidate => candidate === value)
    ? value as T
    : fallback
}

const ASR_PROVIDER_IDS = ASR_PROVIDERS.map(provider => provider.id)
const WHISPER_MODEL_IDS = WHISPER_MODELS.map(model => model.id)

export function sanitizeSettings(value: unknown): ExtensionSettings {
  const source = isRecord(value) ? value : {}
  const sanitizedHost = localHttpUrl(source.hostBaseUrl, DEFAULT_SETTINGS.hostBaseUrl)
  const hostBaseUrl = source.version === 1 && sanitizedHost === 'http://127.0.0.1:3080'
    ? DEFAULT_SETTINGS.hostBaseUrl
    : sanitizedHost
  return {
    version: 2,
    hostBaseUrl,
    companionBaseUrl: localHttpUrl(source.companionBaseUrl, DEFAULT_SETTINGS.companionBaseUrl),
    asrProvider: memberOf(source.asrProvider, ASR_PROVIDER_IDS, DEFAULT_SETTINGS.asrProvider),
    whisperModel: memberOf(source.whisperModel, WHISPER_MODEL_IDS, DEFAULT_SETTINGS.whisperModel),
    subtitleMode: memberOf(source.subtitleMode, SUBTITLE_MODES, DEFAULT_SETTINGS.subtitleMode),
    autoConnect: typeof source.autoConnect === 'boolean' ? source.autoConnect : DEFAULT_SETTINGS.autoConnect,
    theme: memberOf(source.theme, THEME_PREFERENCES, DEFAULT_SETTINGS.theme),
  }
}
