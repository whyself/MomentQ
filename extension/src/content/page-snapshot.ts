type UnknownRecord = Record<string, unknown>

export type SelectedVodPage = {
  cid?: string | number
  pageNumber?: number
  partTitle?: string
}

function record(value: unknown): UnknownRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : null
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
    const parsed = Number(value)
    if (Number.isSafeInteger(parsed)) return parsed
  }
  return undefined
}

function id(value: unknown): string | number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function selectVodPage(
  pages: readonly unknown[],
  requestedPage: number | undefined,
  currentCid: string | number | undefined,
): SelectedVodPage {
  const records = pages.map(record).filter(page => page !== null)
  const selected = requestedPage === undefined
    ? records.find(page => currentCid !== undefined && String(page.cid) === String(currentCid))
    : records.find(page => positiveInteger(page.page) === requestedPage)
  const pageNumber = positiveInteger(selected?.page) ?? requestedPage
  const partTitle = typeof selected?.part === 'string' && selected.part.trim()
    ? selected.part.trim()
    : undefined
  const selectedCid = selected === undefined && requestedPage !== undefined
    ? undefined
    : id(selected?.cid) ?? currentCid
  return {
    ...(selectedCid === undefined ? {} : { cid: selectedCid }),
    ...(pageNumber === undefined ? {} : { pageNumber }),
    ...(partTitle === undefined ? {} : { partTitle }),
  }
}
