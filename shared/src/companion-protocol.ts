/**
 * Extension ↔ companion WebSocket protocol for streaming ASR.
 *
 * One WebSocket connection carries one recognition session for one tab.
 * JSON text frames are control/result messages validated by the guards
 * below; binary frames are raw `16kHz / 16bit / mono` little-endian PCM.
 * This module has no runtime dependencies so both the browser extension
 * and the Node companion can import it directly from source.
 */

/** Mirrors the Host content identity schema for vod and live content. */
export type AsrContentIdentity =
  | { kind: 'vod'; bvid: string; cid: string }
  | { kind: 'live'; canonicalRoomId: string; liveStartTime: string }

/** Client → server control messages. */
export type CompanionClientMessage =
  | { type: 'start'; identity: AsrContentIdentity }
  | { type: 'clock'; mediaTime: number }
  | { type: 'stop' }

/** Server → client result messages. */
export type CompanionServerMessage =
  | { type: 'ready'; provider: string }
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string; start: number; end: number }
  | { type: 'persisted'; segments: number }
  | { type: 'error'; code: string; message: string }

type PlainRecord = Record<string, unknown>

function isPlainRecord(value: unknown): value is PlainRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}

function hasOnlyKeys(value: PlainRecord, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}

function isIdentity(value: unknown): value is AsrContentIdentity {
  if (!isPlainRecord(value)) return false
  if (value.kind === 'vod') {
    return hasOnlyKeys(value, ['kind', 'bvid', 'cid'])
      && typeof value.bvid === 'string' && value.bvid.trim() !== ''
      && typeof value.cid === 'string' && value.cid.trim() !== ''
  }
  if (value.kind === 'live') {
    return hasOnlyKeys(value, ['kind', 'canonicalRoomId', 'liveStartTime'])
      && typeof value.canonicalRoomId === 'string' && value.canonicalRoomId.trim() !== ''
      && typeof value.liveStartTime === 'string' && Number.isFinite(Date.parse(value.liveStartTime))
  }
  return false
}

export function isCompanionClientMessage(value: unknown): value is CompanionClientMessage {
  if (!isPlainRecord(value)) return false
  if (value.type === 'start') {
    return hasOnlyKeys(value, ['type', 'identity']) && isIdentity(value.identity)
  }
  if (value.type === 'clock') {
    return hasOnlyKeys(value, ['type', 'mediaTime'])
      && typeof value.mediaTime === 'number' && Number.isFinite(value.mediaTime)
      && value.mediaTime >= 0
  }
  if (value.type === 'stop') return hasOnlyKeys(value, ['type'])
  return false
}

export function isCompanionServerMessage(value: unknown): value is CompanionServerMessage {
  if (!isPlainRecord(value)) return false
  if (value.type === 'ready') {
    return hasOnlyKeys(value, ['type', 'provider']) && typeof value.provider === 'string'
  }
  if (value.type === 'partial') {
    return hasOnlyKeys(value, ['type', 'text'])
      && typeof value.text === 'string' && value.text.trim() !== ''
  }
  if (value.type === 'final') {
    return hasOnlyKeys(value, ['type', 'text', 'start', 'end'])
      && typeof value.text === 'string' && value.text.trim() !== ''
      && typeof value.start === 'number' && Number.isFinite(value.start) && value.start >= 0
      && typeof value.end === 'number' && Number.isFinite(value.end) && value.end >= value.start
  }
  if (value.type === 'persisted') {
    return hasOnlyKeys(value, ['type', 'segments'])
      && typeof value.segments === 'number' && Number.isSafeInteger(value.segments)
      && value.segments >= 0
  }
  if (value.type === 'error') {
    return hasOnlyKeys(value, ['type', 'code', 'message'])
      && typeof value.code === 'string'
      && typeof value.message === 'string'
  }
  return false
}
