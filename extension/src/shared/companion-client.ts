/** Settings-page client for the local companion's config endpoints. */

export type CompanionBaiduConfigView = {
  configured: boolean
  appId: string | null
  apiKeyMasked: string | null
  secretKeySet: boolean
  devPid: number
}

export type CompanionConfigView = {
  provider: string
  baidu: CompanionBaiduConfigView
}

export class CompanionClientError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'CompanionClientError'
  }
}

function companionOrigin(baseUrl: string): string {
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch (error) {
    throw new Error('companion 地址必须是本机 HTTP URL', { cause: error })
  }
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname)) {
    throw new Error('companion 地址必须是 127.0.0.1 或 localhost 的 HTTP URL')
  }
  return parsed.origin
}

async function companionCall<T>(baseUrl: string, init: RequestInit, fetcher: typeof fetch): Promise<T> {
  const response = await fetcher(`${companionOrigin(baseUrl)}/config`, {
    ...init,
    headers: { 'content-type': 'application/json' },
  })
  let envelope: unknown
  try {
    envelope = await response.json()
  } catch {
    throw new CompanionClientError(response.status, 'companion 返回了无效响应')
  }
  if (typeof envelope !== 'object' || envelope === null) {
    throw new CompanionClientError(response.status, 'companion 返回了无效响应')
  }
  const record = envelope as { ok?: unknown; value?: unknown; error?: { message?: unknown } }
  if (record.ok !== true || !('value' in record)) {
    const message = typeof record.error?.message === 'string' ? record.error.message : 'companion 请求失败'
    throw new CompanionClientError(response.status, message)
  }
  return record.value as T
}

/** Read the redacted credential view; unreachable companions reject. */
export async function fetchCompanionConfig(
  baseUrl: string,
  fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<CompanionConfigView> {
  return await companionCall<CompanionConfigView>(baseUrl, { method: 'GET' }, fetcher)
}

/** Store Baidu credentials in the local companion (never in the extension). */
export async function saveCompanionBaiduCredentials(
  baseUrl: string,
  input: { appId: string; apiKey: string; secretKey: string },
  fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<void> {
  await companionCall<{ saved: true }>(baseUrl, {
    method: 'POST',
    body: JSON.stringify(input),
  }, fetcher)
}
