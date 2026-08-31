/** Browser-safe typed client for the MomentQ loopback API. */

import type {
  EnsureContentRequest,
  EnsureContentResult,
  SessionMutationResult,
  SubmitMessageResult,
  ConversationHistoryEntry,
  ConversationTranscript,
  MessageStreamEvent,
  SyncTranscriptResult,
  TranscriptSegment,
} from './index.ts'
import type { ContentIdentity } from './content.ts'
import type { MomentQState } from './state.ts'

export type {
  EnsureContentRequest,
  EnsureContentResult,
  SessionMutationResult,
  SubmitMessageResult,
  ConversationHistoryEntry,
  ConversationTranscript,
  MessageStreamEvent,
  SyncTranscriptResult,
  TranscriptSegment,
  ContentIdentity,
  MomentQState,
}

export type MomentQApiErrorCode =
  | 'invalid-request'
  | 'content-not-found'
  | 'session-conflict'
  | 'internal'

/** Typed error returned by the MomentQ Host API. */
export class MomentQClientError extends Error {
  constructor(readonly code: MomentQApiErrorCode, message: string, readonly status: number) {
    super(message)
    this.name = 'MomentQClientError'
  }
}

export interface MomentQClientOptions {
  baseUrl: string
  fetch?: typeof globalThis.fetch | undefined
  /** Upper bound for each unary API call; a wedged Host turns into an error instead of a silent hang. */
  timeoutMs?: number | undefined
}

/** Minimal SDK surface shared by the browser extension and test clients. */
export class MomentQClient {
  private readonly baseUrl: string
  private readonly fetcher: typeof globalThis.fetch
  private readonly timeoutMs: number

  constructor(options: MomentQClientOptions) {
    let parsed: URL
    try {
      parsed = new URL(options.baseUrl)
    } catch (error) {
      throw new Error('MomentQ baseUrl must be a loopback HTTP URL', { cause: error })
    }
    if (!['http:', 'https:'].includes(parsed.protocol)
      || !['127.0.0.1', 'localhost'].includes(parsed.hostname)
      || parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') {
      throw new Error('MomentQ baseUrl must be a loopback HTTP URL')
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/, '')
    this.baseUrl = parsed.toString().replace(/\/+$/, '')
    this.fetcher = options.fetch ?? globalThis.fetch?.bind(globalThis)
    if (this.fetcher === undefined) throw new Error('MomentQClient requires fetch')
    this.timeoutMs = options.timeoutMs ?? 8_000
  }

  async ensureContent(request: EnsureContentRequest, signal?: AbortSignal): Promise<EnsureContentResult> {
    return await this.call('ensureContent', request, signal)
  }

  async getContent(identity: ContentIdentity, signal?: AbortSignal): Promise<MomentQState> {
    return await this.call('getContent', { identity }, signal)
  }

  async getHistory(identity: ContentIdentity, signal?: AbortSignal): Promise<ConversationHistoryEntry[]> {
    return await this.call('getHistory', { identity }, signal)
  }

  /** Read back the persisted transcript (restore path for reopened videos). */
  async getTranscript(identity: ContentIdentity, signal?: AbortSignal): Promise<ConversationTranscript> {
    return await this.call('getTranscript', { identity }, signal)
  }

  async submitMessage(
    identity: ContentIdentity,
    text: string,
    signal?: AbortSignal,
  ): Promise<SubmitMessageResult> {
    return await this.call('submitMessage', { identity, text }, signal)
  }

  async syncTranscript(
    identity: ContentIdentity,
    source: 'bilibili' | 'asr',
    segments: readonly TranscriptSegment[],
    signal?: AbortSignal,
  ): Promise<SyncTranscriptResult> {
    return await this.call('syncTranscript', { identity, source, segments }, signal)
  }

  /** Consume the Host's newline-delimited projection of native DSH stream events. */
  async streamMessage(
    identity: ContentIdentity,
    text: string,
    onEvent: (event: MessageStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<SubmitMessageResult> {
    const response = await this.fetcher(`${this.baseUrl}/momentq/api/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identity, text }),
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok || response.body === null) {
      throw await this.responseError(response)
    }
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
    let buffered = ''
    let result: SubmitMessageResult | undefined
    while (true) {
      const frame = await reader.read()
      buffered += frame.value ?? ''
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      for (const line of lines) {
        if (line === '') continue
        const event = this.parseStreamEvent(line, response.status)
        onEvent(event)
        if (event.type === 'complete') result = event.result
      }
      if (frame.done) break
    }
    if (buffered.trim() !== '') {
      const event = this.parseStreamEvent(buffered, response.status)
      onEvent(event)
      if (event.type === 'complete') result = event.result
    }
    if (result === undefined) throw new MomentQClientError('internal', 'MomentQ stream ended before completion', response.status)
    return result
  }

  async archiveSession(identity: ContentIdentity, signal?: AbortSignal): Promise<SessionMutationResult> {
    return await this.call('archiveSession', { identity }, signal)
  }

  async resetSession(
    identity: ContentIdentity,
    sessionInstructions?: string,
    signal?: AbortSignal,
  ): Promise<SessionMutationResult> {
    return await this.call('resetSession', {
      identity,
      ...(sessionInstructions === undefined ? {} : { sessionInstructions }),
    }, signal)
  }

  async deleteSession(
    identity: ContentIdentity,
    sessionInstructions?: string,
    signal?: AbortSignal,
  ): Promise<SessionMutationResult> {
    return await this.call('deleteSession', {
      identity,
      ...(sessionInstructions === undefined ? {} : { sessionInstructions }),
    }, signal)
  }

  async deleteContent(identity: ContentIdentity, signal?: AbortSignal): Promise<{ deleted: true }> {
    return await this.call('deleteContent', { identity }, signal)
  }

  /** Remove every Session log across all content; metadata and transcripts stay. */
  async clearAllSessions(signal?: AbortSignal): Promise<{ cleared: number; failed: string[] }> {
    return await this.call('clearAllSessions', {}, signal)
  }

  /** Store a write-only DeepSeek model credential in the Host credential provider. */
  async setModelApiKey(apiKey: string, signal?: AbortSignal): Promise<{ saved: true }> {
    return await this.call('setModelApiKey', { apiKey }, signal)
  }

  private async call<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs)
    const callSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal])
    const response = await this.fetcher(`${this.baseUrl}/momentq/api`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, params }),
      signal: callSignal,
    })
    let envelope: unknown
    try {
      envelope = await response.json()
    } catch (error) {
      throw new MomentQClientError('internal', 'MomentQ returned an invalid response', response.status)
    }
    if (typeof envelope !== 'object' || envelope === null || !Object.hasOwn(envelope, 'ok')) {
      throw new MomentQClientError('internal', 'MomentQ returned an invalid response', response.status)
    }
    if ((envelope as { ok: unknown }).ok === false) {
      const detail = (envelope as { error?: unknown }).error
      const codes: MomentQApiErrorCode[] = [
        'invalid-request', 'content-not-found', 'session-conflict', 'internal',
      ]
      if (typeof detail !== 'object' || detail === null) {
        throw new MomentQClientError('internal', 'MomentQ returned an invalid response', response.status)
      }
      const code = (detail as { code?: unknown }).code
      const message = (detail as { message?: unknown }).message
      if (typeof code !== 'string' || !codes.includes(code as MomentQApiErrorCode) || typeof message !== 'string') {
        throw new MomentQClientError('internal', 'MomentQ returned an invalid response', response.status)
      }
      throw new MomentQClientError(code as MomentQApiErrorCode, message, response.status)
    }
    if ((envelope as { ok: unknown }).ok !== true || !Object.hasOwn(envelope, 'value')) {
      throw new MomentQClientError('internal', 'MomentQ returned an invalid response', response.status)
    }
    return (envelope as { ok: true; value: T }).value
  }

  private async responseError(response: Response): Promise<MomentQClientError> {
    try {
      const envelope = await response.json() as { error?: { code?: unknown; message?: unknown } }
      const code = envelope.error?.code
      const message = envelope.error?.message
      if (typeof code === 'string' && typeof message === 'string') {
        return new MomentQClientError(code as MomentQApiErrorCode, message, response.status)
      }
    } catch {}
    return new MomentQClientError('internal', 'MomentQ returned an invalid response', response.status)
  }

  private parseStreamEvent(line: string, status: number): MessageStreamEvent {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      throw new MomentQClientError('internal', 'MomentQ returned an invalid stream event', status)
    }
    if (typeof value !== 'object' || value === null || typeof (value as { type?: unknown }).type !== 'string') {
      throw new MomentQClientError('internal', 'MomentQ returned an invalid stream event', status)
    }
    const type = (value as { type: string }).type
    if (type === 'error') {
      const error = value as { code?: unknown; message?: unknown }
      const codes: MomentQApiErrorCode[] = ['invalid-request', 'content-not-found', 'session-conflict', 'internal']
      if (typeof error.code !== 'string' || !codes.includes(error.code as MomentQApiErrorCode)
        || typeof error.message !== 'string') {
        throw new MomentQClientError('internal', 'MomentQ returned an invalid stream event', status)
      }
      throw new MomentQClientError(error.code as MomentQApiErrorCode, error.message, status)
    }
    if (!['started', 'assistant-delta', 'assistant-message', 'complete'].includes(type)) {
      throw new MomentQClientError('internal', 'MomentQ returned an invalid stream event', status)
    }
    return value as MessageStreamEvent
  }
}
