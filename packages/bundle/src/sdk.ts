/** Browser-safe typed client for the MomentQ loopback API. */

import type {
  EnsureContentRequest,
  EnsureContentResult,
  SessionMutationResult,
} from './index.ts'
import type { ContentIdentity } from './content.ts'
import type { MomentQState } from './state.ts'

export type {
  EnsureContentRequest,
  EnsureContentResult,
  SessionMutationResult,
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
}

interface ErrorEnvelope {
  ok: false
  error: { code: MomentQApiErrorCode; message: string }
}

/** Minimal SDK surface shared by the browser extension and test clients. */
export class MomentQClient {
  private readonly baseUrl: string
  private readonly fetcher: typeof globalThis.fetch

  constructor(options: MomentQClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    if (!/^https?:\/\//.test(this.baseUrl)) throw new Error('MomentQ baseUrl must be an HTTP URL')
    this.fetcher = options.fetch ?? globalThis.fetch
    if (this.fetcher === undefined) throw new Error('MomentQClient requires fetch')
  }

  async ensureContent(request: EnsureContentRequest, signal?: AbortSignal): Promise<EnsureContentResult> {
    return await this.call('ensureContent', request, signal)
  }

  async getContent(identity: ContentIdentity, signal?: AbortSignal): Promise<MomentQState> {
    return await this.call('getContent', { identity }, signal)
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

  private async call<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl}/momentq/api`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, params }),
      ...(signal === undefined ? {} : { signal }),
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
      const failure = envelope as ErrorEnvelope
      throw new MomentQClientError(failure.error.code, failure.error.message, response.status)
    }
    if ((envelope as { ok: unknown }).ok !== true || !Object.hasOwn(envelope, 'value')) {
      throw new MomentQClientError('internal', 'MomentQ returned an invalid response', response.status)
    }
    return (envelope as { ok: true; value: T }).value
  }
}

