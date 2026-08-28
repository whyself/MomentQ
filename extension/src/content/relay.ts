import { normalizeBilibiliContext, parseBilibiliLocation } from '../shared/bilibili'
import type {
  BilibiliPageSnapshot, PageContextRuntimeMessage, ResolvePageSnapshotMessage,
} from '../shared/protocol'

export function pageSnapshotToRuntimeMessage(
  snapshot: BilibiliPageSnapshot,
): PageContextRuntimeMessage | ResolvePageSnapshotMessage {
  if (parseBilibiliLocation(snapshot.url) === null) {
    return { type: 'MOMENTQ_PAGE_CONTEXT', context: null }
  }
  const context = normalizeBilibiliContext(snapshot)
  return context === null
    ? { type: 'MOMENTQ_RESOLVE_PAGE_SNAPSHOT', snapshot }
    : { type: 'MOMENTQ_PAGE_CONTEXT', context }
}
