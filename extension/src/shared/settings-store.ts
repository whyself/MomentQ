import { DEFAULT_SETTINGS, sanitizeSettings } from './settings'
import type { ExtensionSettings } from './settings'

const STORAGE_KEY = 'momentq.settings'
const MODEL_API_KEY_STORAGE_KEY = 'momentq.modelApiKey'

function modelApiKey(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8192) return ''
  if (!/^[\x21-\x7e]+$/.test(value)) return ''
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) return ''
  if ((value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))) return ''
  return value
}

export async function loadSettings(): Promise<ExtensionSettings> {
  if (typeof chrome === 'undefined' || chrome.storage?.local === undefined) {
    return { ...DEFAULT_SETTINGS }
  }
  const stored = await chrome.storage.local.get(STORAGE_KEY)
  return sanitizeSettings(stored[STORAGE_KEY])
}

export async function saveSettings(value: unknown): Promise<ExtensionSettings> {
  const settings = sanitizeSettings(value)
  if (typeof chrome === 'undefined' || chrome.storage?.local === undefined) return settings
  await chrome.storage.local.set({ [STORAGE_KEY]: settings })
  return settings
}

/** Read the extension-owned local copy; the Host credential store remains write-only. */
export async function loadModelApiKey(): Promise<string> {
  if (typeof chrome !== 'undefined' && chrome.storage?.local !== undefined) {
    const stored = await chrome.storage.local.get(MODEL_API_KEY_STORAGE_KEY)
    return modelApiKey(stored[MODEL_API_KEY_STORAGE_KEY])
  }
  if (typeof localStorage === 'undefined') return ''
  return modelApiKey(localStorage.getItem(MODEL_API_KEY_STORAGE_KEY))
}

/** Persist or remove the extension-owned local copy after a successful Host save. */
export async function saveModelApiKey(value: string): Promise<string> {
  const apiKey = modelApiKey(value)
  if (value !== '' && apiKey === '') throw new Error('模型 API Key 格式无效')
  if (typeof chrome !== 'undefined' && chrome.storage?.local !== undefined) {
    if (apiKey === '') await chrome.storage.local.remove(MODEL_API_KEY_STORAGE_KEY)
    else await chrome.storage.local.set({ [MODEL_API_KEY_STORAGE_KEY]: apiKey })
    return apiKey
  }
  if (typeof localStorage !== 'undefined') {
    if (apiKey === '') localStorage.removeItem(MODEL_API_KEY_STORAGE_KEY)
    else localStorage.setItem(MODEL_API_KEY_STORAGE_KEY, apiKey)
  }
  return apiKey
}
