import { parseBilibiliLocation } from '../shared/bilibili'

export function sameContentLocation(leftUrl: string | undefined, rightUrl: string): boolean {
  if (leftUrl === undefined) return false
  const left = parseBilibiliLocation(leftUrl)
  const right = parseBilibiliLocation(rightUrl)
  if (left === null || right === null || left.kind !== right.kind) return false
  if (left.kind === 'vod' && right.kind === 'vod') {
    return left.bvid === right.bvid
      && (left.requestedPart ?? 1) === (right.requestedPart ?? 1)
  }
  return left.kind === 'live' && right.kind === 'live' && left.roomId === right.roomId
}
