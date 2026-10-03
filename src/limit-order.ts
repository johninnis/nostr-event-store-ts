import type { NostrEvent } from "@innis/nostr-core"

const precedesInLimitOrder = (a: NostrEvent, b: NostrEvent): boolean =>
  a.created_at > b.created_at || (a.created_at === b.created_at && a.id < b.id)

/**
 * Insert `event` into `sorted`, kept in NIP-01 `limit` order (newest first, lowest id first on a
 * `created_at` tie) and cut to `limit`, so a bounded read never holds more than `limit` events.
 */
export const insertInLimitOrder = (sorted: Array<NostrEvent>, event: NostrEvent, limit: number): void => {
  let low = 0
  let high = sorted.length
  while (low < high) {
    const mid = (low + high) >>> 1
    const probe = sorted[mid]
    if (probe !== undefined && precedesInLimitOrder(probe, event)) low = mid + 1
    else high = mid
  }
  if (low >= limit) return
  sorted.splice(low, 0, event)
  if (sorted.length > limit) sorted.pop()
}

/**
 * Whether a newest-first walk that has reached `createdAt` can still find an event for `sorted`:
 * true until `sorted` holds `limit` events all newer than `createdAt`. A same-second event can
 * still enter on a lower id, so the walk only stops once it is strictly older than the last kept.
 */
export const canStillEnter = (sorted: ReadonlyArray<NostrEvent>, createdAt: number, limit: number): boolean => {
  if (sorted.length < limit) return true
  const last = sorted[sorted.length - 1]
  return last !== undefined && createdAt >= last.created_at
}
