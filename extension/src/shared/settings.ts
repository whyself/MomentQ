export const ASR_PROVIDERS = ['baidu'] as const
export const SUBTITLE_MODES = ['append', 'replace'] as const
export const THEME_PREFERENCES = ['light', 'dark', 'system'] as const

export type AsrProvider = typeof ASR_PROVIDERS[number]
export type SubtitleMode = typeof SUBTITLE_MODES[number]
export type ThemePreference = typeof THEME_PREFERENCES[number]

export type ExtensionSettings = {
  version: 2
  hostBaseUrl: string
  companionBaseUrl: string
  asrProvider: AsrProvider
  subtitleMode: SubtitleMode
  autoConnect: boolean
  theme: ThemePreference
}

export const DEFAULT_SETTINGS: Readonly<ExtensionSettings> = Object.freeze({
  version: 2,
  hostBaseUrl: 'http://127.0.0.1:3182',
  companionBaseUrl: 'http://127.0.0.1:3090',
  asrProvider: 'baidu',
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
    asrProvider: memberOf(source.asrProvider, ASR_PROVIDERS, DEFAULT_SETTINGS.asrProvider),
    subtitleMode: memberOf(source.subtitleMode, SUBTITLE_MODES, DEFAULT_SETTINGS.subtitleMode),
    autoConnect: typeof source.autoConnect === 'boolean' ? source.autoConnect : DEFAULT_SETTINGS.autoConnect,
    theme: memberOf(source.theme, THEME_PREFERENCES, DEFAULT_SETTINGS.theme),
  }
}
