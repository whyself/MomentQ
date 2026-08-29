import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, sanitizeSettings } from '../src/shared/settings'
import { loadModelApiKey, saveModelApiKey } from '../src/shared/settings-store'

afterEach(() => { vi.unstubAllGlobals() })

describe('extension settings', () => {
  it('uses local non-secret defaults', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      version: 2,
      hostBaseUrl: 'http://127.0.0.1:3182',
      companionBaseUrl: 'http://127.0.0.1:3090',
      asrProvider: 'baidu',
      whisperModel: 'base',
      subtitleMode: 'append',
      autoConnect: true,
      theme: 'system',
    })
  })

  it('accepts and normalizes supported values', () => {
    expect(sanitizeSettings({
      version: 2,
      hostBaseUrl: 'http://127.0.0.1:3182/',
      companionBaseUrl: 'http://localhost:3090/',
      asrProvider: 'baidu',
      whisperModel: 'base',
      subtitleMode: 'replace',
      autoConnect: false,
      theme: 'dark',
    })).toEqual({
      version: 2,
      hostBaseUrl: 'http://127.0.0.1:3182',
      companionBaseUrl: 'http://localhost:3090',
      asrProvider: 'baidu',
      whisperModel: 'base',
      subtitleMode: 'replace',
      autoConnect: false,
      theme: 'dark',
    })
  })

  it('migrates the former 3080 default to the active development Host port', () => {
    expect(sanitizeSettings({ ...DEFAULT_SETTINGS, version: 1, hostBaseUrl: 'http://127.0.0.1:3080' })).toMatchObject({
      version: 2,
      hostBaseUrl: 'http://127.0.0.1:3182',
    })
    expect(sanitizeSettings({ ...DEFAULT_SETTINGS, version: 2, hostBaseUrl: 'http://127.0.0.1:3080' })).toMatchObject({
      version: 2,
      hostBaseUrl: 'http://127.0.0.1:3080',
    })
  })

  it('falls back for malformed values and never retains credentials', () => {
    const settings = sanitizeSettings({
      version: 1,
      hostBaseUrl: 'javascript:alert(1)',
      companionBaseUrl: 'https://example.com',
      asrProvider: 'other',
      subtitleMode: 'unknown',
      autoConnect: 'yes',
      theme: 'neon',
      apiKey: 'do-not-store',
      secretKey: 'do-not-store',
      accessToken: 'do-not-store',
      password: 'do-not-store',
    })
    expect(settings).toEqual(DEFAULT_SETTINGS)
    expect(JSON.stringify(settings)).not.toMatch(/apiKey|secretKey|accessToken|password/)
  })
})

describe('model API key local storage', () => {
  it('persists and reloads the extension-owned local copy separately from settings', async () => {
    const values: Record<string, unknown> = {}
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: values[key] })),
          set: vi.fn(async (entries: Record<string, unknown>) => { Object.assign(values, entries) }),
          remove: vi.fn(async (key: string) => { delete values[key] }),
        },
      },
    })

    await expect(saveModelApiKey('sk-local-test')).resolves.toBe('sk-local-test')
    await expect(loadModelApiKey()).resolves.toBe('sk-local-test')
    expect(JSON.stringify(sanitizeSettings({ modelApiKey: 'sk-local-test' }))).not.toContain('sk-local-test')

    await expect(saveModelApiKey('')).resolves.toBe('')
    await expect(loadModelApiKey()).resolves.toBe('')
  })

  it('rejects malformed local copies', async () => {
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async () => ({ 'momentq.modelApiKey': 'DEEPSEEK_API_KEY=secret' })),
          set: vi.fn(),
          remove: vi.fn(),
        },
      },
    })
    await expect(loadModelApiKey()).resolves.toBe('')
    await expect(saveModelApiKey('DEEPSEEK_API_KEY=secret')).rejects.toThrow(/格式无效/)
  })
})
