import type { BilibiliContext } from '../shared/protocol'
import { sameContentLocation } from './content-location'

export type CurrentVodResolverDependencies = {
  resolve: (url: string) => Promise<BilibiliContext | null>
  currentUrl: () => Promise<string | undefined>
}

/** Resolve one VOD URL only while that exact content identity is still current. */
export async function resolveCurrentVodContext(
  requestedUrl: string,
  dependencies: CurrentVodResolverDependencies,
): Promise<BilibiliContext | null> {
  const context = await dependencies.resolve(requestedUrl)
  if (context === null) return null
  const currentUrl = await dependencies.currentUrl()
  return sameContentLocation(currentUrl, requestedUrl) ? context : null
}
