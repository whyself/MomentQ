/**
 * Video-time stamp attached to user questions.
 *
 * The Host needs `[当前视频播放时间：m:ss]` inside the stored message so the
 * agent can reason about "right now"; the bubble does not. Both sides share
 * this module: append on send, split off for display.
 */

export function playbackStamp(seconds: number | undefined): string | null {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return null
  const whole = Math.floor(seconds)
  const minutes = Math.floor(whole / 60)
  const rest = whole % 60
  return `${minutes}:${String(rest).padStart(2, '0')}`
}

export function withVideoTimeSuffix(text: string, stamp: string | null): string {
  return stamp === null ? text : `${text}\n\n[当前视频播放时间：${stamp}]`
}

const VIDEO_TIME_SUFFIX = /\n+\[当前视频播放时间[：:]\s*([0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?)\]\s*$/

/** Split the machine suffix off a user message for display. */
export function splitVideoStamp(text: string): { body: string; stamp: string | null } {
  const match = text.match(VIDEO_TIME_SUFFIX)
  if (match === null || match.index === undefined) return { body: text, stamp: null }
  return { body: text.slice(0, match.index).trimEnd(), stamp: match[1] ?? null }
}
