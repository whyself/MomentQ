/**
 * Identity-consistency gate for page-world snapshot values.
 *
 * During Bilibili's SPA transition `__INITIAL_STATE__` still describes the
 * previous video while the extension has already resolved the new identity;
 * merging the resolved bvid/cid over that state leaves a poisoned trio where
 * `aid` belongs to the previous video. Probing subtitle endpoints with such a
 * trio imports the previous video's track under the new identity (the
 * subtitle-web protobuf response carries no verifiable identity of its own).
 */

export type RawVodIdentity = {
  bvid?: string | undefined
  cid?: string | number | undefined
  aid?: string | number | undefined
}

/** Whether page-state values may be combined with the target identity. */
export function identityConsistent(
  raw: RawVodIdentity | undefined,
  target: { bvid: string; cid: string },
): boolean {
  if (raw === undefined || raw.bvid === undefined || raw.cid === undefined) return false
  return raw.bvid === target.bvid && String(raw.cid) === String(target.cid)
}
