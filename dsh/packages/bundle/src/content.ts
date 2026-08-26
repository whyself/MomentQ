/** Stable Bilibili content identities and their filesystem/session projections. */

import { createHash } from 'node:crypto'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { SessionId, type SessionId as DshSessionId } from '@deepseek-ai/dsh-session'

/** One Bilibili recording part or one concrete live occurrence. */
export type ContentIdentity =
  | { kind: 'vod'; bvid: string; cid: string }
  | { kind: 'live'; canonicalRoomId: string; liveStartTime: string }

/** Display metadata captured from the Bilibili page. */
export interface ContentMetadata {
  title: string
  description?: string | undefined
  creator: { id?: string | undefined; name: string }
  part?: { number: number; title?: string | undefined } | undefined
  durationSeconds?: number | undefined
  publishedAt?: string | undefined
  tags?: string[] | undefined
  area?: string | undefined
  endedAt?: string | undefined
}

const BVID = /^BV[0-9A-Za-z]+$/
const DECIMAL_ID = /^[0-9]+$/
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

function requireMatch(value: string, pattern: RegExp, name: string): void {
  if (!pattern.test(value)) throw new Error(`${name} is invalid`)
}

function liveEpoch(identity: Extract<ContentIdentity, { kind: 'live' }>): number {
  requireMatch(identity.canonicalRoomId, DECIMAL_ID, 'canonicalRoomId')
  requireMatch(identity.liveStartTime, ISO_INSTANT, 'liveStartTime')
  const epoch = Date.parse(identity.liveStartTime)
  if (!Number.isFinite(epoch)) throw new Error('liveStartTime is invalid')
  return epoch
}

function validateIdentity(identity: ContentIdentity): void {
  if (identity.kind === 'vod') {
    requireMatch(identity.bvid, BVID, 'bvid')
    requireMatch(identity.cid, DECIMAL_ID, 'cid')
    return
  }
  liveEpoch(identity)
}

/** Return the canonical platform identity used for routing and hashing. */
export function contentKey(identity: ContentIdentity): string {
  validateIdentity(identity)
  if (identity.kind === 'vod') return `bilibili:vod:${identity.bvid}:${identity.cid}`
  return `bilibili:live:${identity.canonicalRoomId}:${new Date(liveEpoch(identity)).toISOString()}`
}

/** Return the platform-relative content directory below `MOMENTQ_DATA_ROOT`. */
export function contentRelativePath(identity: ContentIdentity): string {
  validateIdentity(identity)
  if (identity.kind === 'vod') {
    return join('content', 'bilibili', 'vod', identity.bvid, identity.cid)
  }
  return join('content', 'bilibili', 'live', identity.canonicalRoomId, String(liveEpoch(identity)))
}

/** Resolve a content directory and prove it stays below the configured root. */
export function contentDirectory(dataRoot: string, identity: ContentIdentity): string {
  const root = resolve(dataRoot)
  const target = resolve(root, contentRelativePath(identity))
  const suffix = relative(root, target)
  if (suffix === '' || suffix === '..' || suffix.startsWith('..\\')
    || suffix.startsWith('../') || isAbsolute(suffix)) {
    throw new Error('content directory escapes MOMENTQ_DATA_ROOT')
  }
  return target
}

/** Derive one deterministic DSH Session id for a content generation. */
export function sessionIdFor(identity: ContentIdentity, generation: number): DshSessionId {
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error('session generation must be a non-negative safe integer')
  }
  const hash = createHash('sha256').update(contentKey(identity)).digest('hex').slice(0, 32)
  return SessionId(`momentq-${hash}-g${generation}`)
}
