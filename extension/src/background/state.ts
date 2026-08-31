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
    const result = previous.then(() => operation())
    // The timeout bounds how long a CALLER waits, not the operation itself:
    // releasing the queue while the previous operation is still writing let
    // two operations interleave read-modify-write on the same tab state.
    // (Operations here are local storage reads/writes only — network never
    // enters this queue — so a step that exceeds the caller timeout is rare
    // and the queue briefly pausing behind it is the safer failure.)
    let timer: ReturnType<typeof setTimeout> | undefined
    const bounded = Promise.race([
      result,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('MomentQ 内部状态操作超时，请重试')), 10_000)
      }),
    ])
    const tail = result.then(() => {
      if (timer !== undefined) clearTimeout(timer)
    }, () => {
      if (timer !== undefined) clearTimeout(timer)
    })
    this.tails.set(tabId, tail)
    void tail.then(() => {
      if (this.tails.get(tabId) === tail) this.tails.delete(tabId)
    })
    return bounded
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
    // Explicit stops (capture failure, companion loss) deactivate; TOGGLE
    // never produces 'inactive' so the user path stays pause/resume.
    || (to === 'inactive' && from !== 'inactive')
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
      ...(preserve && state.subtitleSource !== undefined ? { subtitleSource: state.subtitleSource } : {}),
      ...(preserve && state.subtitleTrusted !== undefined ? { subtitleTrusted: state.subtitleTrusted } : {}),
      ...(preserve && state.subtitleDiagnostic !== undefined ? { subtitleDiagnostic: state.subtitleDiagnostic } : {}),
      ...(preserve && state.transcriptPreview !== undefined ? { transcriptPreview: state.transcriptPreview } : {}),
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
