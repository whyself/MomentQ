// The Bundle SDK is intentionally browser-safe; this bridge keeps the extension
// coupled to the one typed Host contract instead of duplicating its HTTP calls.
export {
  MomentQClient,
  MomentQClientError,
  type ContentIdentity,
  type MessageStreamEvent,
  type SubmitMessageResult,
  type ConversationHistoryEntry,
  type SyncTranscriptResult,
  type TranscriptSegment,
} from '../../../dsh/packages/bundle/src/sdk'
