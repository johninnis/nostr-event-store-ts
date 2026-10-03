import type { NostrEvent, NostrFilter, PublicKey } from "@innis/nostr-core"
import { parseEventFromRow } from "./event-row.ts"
import { reportUnhandledError } from "./unhandled-error.ts"
import {
  compileServable,
  hasSearch,
  isEmptyFilter,
  isIdsOnlyFilter,
  isReplaceableLookupFilter,
  readLimit,
  replaceableLookupKeys,
} from "./filter-shape.ts"
import { canStillEnter, insertInLimitOrder } from "./limit-order.ts"
import { EVENTS_STORE } from "./constants.ts"

/** Surface an IndexedDB request/transaction error if one is present; ignore the no-error case. */
export const reportIdbError = (error: DOMException | null): void => {
  if (error) reportUnhandledError(error)
}

/**
 * The `pubkey_created_at` index range for one author, bounded by the filter's `since`/`until`
 * (open ends default to the full created_at span). Shared by the author-scoped read and delete
 * paths so both bound the same window.
 */
export const authorCreatedAtRange = (author: PublicKey, filter: NostrFilter): IDBKeyRange =>
  IDBKeyRange.bound([author, filter.since ?? 0], [author, filter.until ?? Infinity])

type Keep = (event: NostrEvent) => void

const keepEach = (requests: ReadonlyArray<IDBRequest>, keep: Keep): void => {
  for (const request of requests) {
    request.onsuccess = (): void => {
      const event = parseEventFromRow(request.result)
      if (event) keep(event)
    }
    request.onerror = (): void => reportIdbError(request.error)
  }
}

const keepWhileEntering = (
  cursorRequest: IDBRequest<IDBCursorWithValue | null>,
  keep: Keep,
  canEnter: (createdAt: number) => boolean,
): void => {
  cursorRequest.onsuccess = (): void => {
    const cursor = cursorRequest.result
    if (!cursor) return
    const event = parseEventFromRow(cursor.value)
    if (event && !canEnter(event.created_at)) return
    if (event) keep(event)
    cursor.continue()
  }
  cursorRequest.onerror = (): void => reportIdbError(cursorRequest.error)
}

const keyedReads = (store: IDBObjectStore, filter: NostrFilter): ReadonlyArray<IDBRequest> | null => {
  if (isIdsOnlyFilter(filter)) return [...new Set(filter.ids)].map((id) => store.get(id))
  if (!isReplaceableLookupFilter(filter)) return null
  const index = store.index("replaceable_key")
  return replaceableLookupKeys(filter).map((key) => index.get(key))
}

const cursorReads = (
  store: IDBObjectStore,
  filter: NostrFilter,
): ReadonlyArray<IDBRequest<IDBCursorWithValue | null>> => {
  if (!filter.authors || filter.authors.length === 0) {
    const range = IDBKeyRange.bound(filter.since ?? 0, filter.until ?? Infinity)
    return [store.index("created_at").openCursor(range, "prev")]
  }
  const index = store.index("pubkey_created_at")
  return [...new Set(filter.authors)].map((author) => index.openCursor(authorCreatedAtRange(author, filter), "prev"))
}

/**
 * Read the IndexedDB events matching `filter` and unexpired at `at` (NIP-40), by the path the
 * filter's shape selects, in NIP-01 `limit` order cut to `limit`. An expired row never takes a
 * place in the result. Resolves when the read transaction commits — the single completion signal
 * for every shape — with an empty result when the transaction fails.
 */
export const queryIdb = (
  db: IDBDatabase | null,
  filter: NostrFilter,
  at: number,
): Promise<ReadonlyArray<NostrEvent>> => {
  const limit = readLimit(filter)
  if (!db || hasSearch(filter) || isEmptyFilter(filter) || limit === 0) return Promise.resolve([])
  return new Promise((resolve) => {
    const tx = db.transaction(EVENTS_STORE, "readonly")
    const servable = compileServable(filter, at)
    const sorted: Array<NostrEvent> = []
    tx.oncomplete = (): void => resolve(sorted)
    tx.onerror = (): void => {
      reportIdbError(tx.error)
      resolve([])
    }
    const keep = (event: NostrEvent): void => {
      if (servable(event)) insertInLimitOrder(sorted, event, limit)
    }
    const store = tx.objectStore(EVENTS_STORE)
    const keyed = keyedReads(store, filter)
    if (keyed) {
      keepEach(keyed, keep)
      return
    }
    const canEnter = (createdAt: number): boolean => canStillEnter(sorted, createdAt, limit)
    for (const cursor of cursorReads(store, filter)) keepWhileEntering(cursor, keep, canEnter)
  })
}
