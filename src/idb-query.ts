import type { NostrEvent, NostrFilter, PublicKey } from "@innis/nostr-core"
import { compileFilter, reportUnhandledError } from "@innis/nostr-core"
import { parseEventFromRow } from "./event-row.ts"
import {
  hasSearch,
  isEmptyFilter,
  isIdsOnlyFilter,
  isReplaceableLookupFilter,
  replaceableLookupKey,
} from "./filter-shape.ts"
import { DEFAULT_LIMIT, EVENTS_STORE } from "./constants.ts"

type Emit = (event: NostrEvent) => void

/** Surface an IndexedDB request/transaction error if one is present; ignore the no-error case. */
export const reportIdbError = (error: DOMException | null): void => {
  if (error) reportUnhandledError(error)
}

/**
 * The `pubkey_created_at` cursor range covering one author's events within the filter's time
 * window. Shared by the read (`query`) and write (`delete`) author paths so the prefix scan is
 * expressed exactly one way.
 */
export const authorCreatedAtRange = (author: PublicKey, filter: NostrFilter): IDBKeyRange =>
  IDBKeyRange.bound([author, filter.since ?? 0], [author, filter.until ?? Infinity])

const queryIdbIdsOnly = (store: IDBObjectStore, filter: NostrFilter, emit: Emit): void => {
  const { matches } = compileFilter(filter)
  for (const id of filter.ids ?? []) {
    const req = store.get(id)
    req.onsuccess = (): void => {
      const event = parseEventFromRow(req.result)
      if (event && matches(event)) emit(event)
    }
    req.onerror = (): void => reportIdbError(req.error)
  }
}

const queryIdbReplaceable = (store: IDBObjectStore, filter: NostrFilter, emit: Emit): void => {
  const { matches } = compileFilter(filter)
  const index = store.index("replaceable_key")
  for (const kind of filter.kinds ?? []) {
    for (const author of filter.authors ?? []) {
      const key = replaceableLookupKey(kind, author)
      if (!key) continue
      const req = index.get(key)
      req.onsuccess = (): void => {
        const event = parseEventFromRow(req.result)
        if (event && matches(event)) emit(event)
      }
      req.onerror = (): void => reportIdbError(req.error)
    }
  }
}

const queryIdbByAuthors = (store: IDBObjectStore, filter: NostrFilter, emit: Emit): void => {
  const { matches } = compileFilter(filter)
  const limit = filter.limit ?? DEFAULT_LIMIT
  const index = store.index("pubkey_created_at")
  let emitted = 0
  for (const author of filter.authors ?? []) {
    const cursorReq = index.openCursor(authorCreatedAtRange(author, filter), "prev")
    cursorReq.onsuccess = (): void => {
      const cursor = cursorReq.result
      if (!cursor || emitted >= limit) return
      const event = parseEventFromRow(cursor.value)
      if (event && matches(event)) {
        emit(event)
        emitted++
      }
      cursor.continue()
    }
    cursorReq.onerror = (): void => reportIdbError(cursorReq.error)
  }
}

const queryIdbDefault = (store: IDBObjectStore, filter: NostrFilter, emit: Emit): void => {
  const { matches } = compileFilter(filter)
  const limit = filter.limit ?? DEFAULT_LIMIT
  const range = IDBKeyRange.bound(filter.since ?? 0, filter.until ?? Infinity)
  const cursorReq = store.index("created_at").openCursor(range, "prev")
  let emitted = 0
  cursorReq.onsuccess = (): void => {
    const cursor = cursorReq.result
    if (!cursor || emitted >= limit) return
    const event = parseEventFromRow(cursor.value)
    if (event && matches(event)) {
      emit(event)
      emitted++
    }
    cursor.continue()
  }
  cursorReq.onerror = (): void => reportIdbError(cursorReq.error)
}

/**
 * Stream the IndexedDB events matching `filter` to `emit`, dispatching to the read path the
 * filter's shape selects. The returned promise resolves when the read transaction commits — the
 * single completion signal for every shape, so no path keeps its own outstanding-request tally.
 */
export const queryIdb = (db: IDBDatabase | null, filter: NostrFilter, emit: Emit): Promise<void> => {
  if (!db || hasSearch(filter) || isEmptyFilter(filter)) return Promise.resolve()
  return new Promise((resolve) => {
    const tx = db.transaction(EVENTS_STORE, "readonly")
    tx.oncomplete = (): void => resolve()
    tx.onerror = (): void => {
      reportIdbError(tx.error)
      resolve()
    }
    const store = tx.objectStore(EVENTS_STORE)
    if (isIdsOnlyFilter(filter)) queryIdbIdsOnly(store, filter, emit)
    else if (isReplaceableLookupFilter(filter)) queryIdbReplaceable(store, filter, emit)
    else if (filter.authors && filter.authors.length > 0) queryIdbByAuthors(store, filter, emit)
    else queryIdbDefault(store, filter, emit)
  })
}
