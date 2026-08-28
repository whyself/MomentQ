import type {
  BilibiliContext,
  MomentQTabState,
  TranscriptionState,
} from '../shared/protocol'

export type TabStateAction =
  | { type: 'SET_CONTEXT'; tabId: number; context: BilibiliContext | null }
  | { type: 'SET_TRANSCRIPTION'; transcription: TranscriptionState }
  | { type: 'TOGGLE_TRANSCRIPTION' }
  | { type: 'REMOVE_TAB' }

export class TabOperationQueue {
  private readonly tails = new Map<number, Promise<void>>()

  run<T>(tabId: number, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(tabId) ?? Promise.resolve()
    const result = previous.then(operation)
    const tail = result.then(() => {}, () => {})
    this.tails.set(tabId, tail)
    void tail.then(() => {
      if (this.tails.get(tabId) === tail) this.tails.delete(tabId)
    })
    return result
  }
}

function sameIdentity(left: BilibiliContext, right: BilibiliContext): boolean {
  if (left.identity.kind !== right.identity.kind) return false
  if (left.identity.kind === 'vod' && right.identity.kind === 'vod') {
    return left.identity.bvid === right.identity.bvid && left.identity.cid === right.identity.cid
  }
  if (left.identity.kind === 'live' && right.identity.kind === 'live') {
    return left.identity.canonicalRoomId === right.identity.canonicalRoomId
      && left.identity.liveStartTime === right.identity.liveStartTime
  }
  return false
}

function canTransition(from: TranscriptionState, to: TranscriptionState): boolean {
  return (from === 'inactive' && to === 'active')
    || (from === 'active' && to === 'paused')
    || (from === 'paused' && to === 'active')
}

function toggledState(state: TranscriptionState): TranscriptionState {
  return state === 'active' ? 'paused' : 'active'
}

export function reduceTabState(
  state: MomentQTabState | null,
  action: TabStateAction,
): MomentQTabState | null {
  if (action.type === 'REMOVE_TAB') return null

  if (action.type === 'SET_CONTEXT') {
    if (action.context === null) return null
    const preserve = state !== null && state.tabId === action.tabId
      && sameIdentity(state.context, action.context)
    return {
      tabId: action.tabId,
      context: action.context,
      transcription: preserve ? state.transcription : 'inactive',
      ...(preserve && state.subtitleSegments !== undefined ? { subtitleSegments: state.subtitleSegments } : {}),
      ...(preserve && state.subtitleIdentity !== undefined ? { subtitleIdentity: state.subtitleIdentity } : {}),
    }
  }

  if (state === null) return null
  const next = action.type === 'TOGGLE_TRANSCRIPTION'
    ? toggledState(state.transcription)
    : action.transcription
  return canTransition(state.transcription, next)
    ? { ...state, transcription: next }
    : state
}
