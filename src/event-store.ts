import type { EventId, NostrEvent, NostrFilter } from "@innis/nostr-core"
import { byCreatedAtDesc, matchesFilter, replaceableStorageKey, replaceableSupersedes } from "@innis/nostr-core"
import { coalesce } from "./timers.ts"
import { createEventCache } from "./event-cache.ts"
import { parseEventFromRow, rowFromEvent } from "./event-row.ts"
import {
  hasSearch,
  isEmptyFilter,
  isIdsOnlyFilter,
  isReplaceableLookupFilter,
  replaceableLookupKey,
} from "./filter-shape.ts"
import { authorCreatedAtRange, queryIdb, reportIdbError } from "./idb-query.ts"
import { DB_VERSION, DEFAULT_DB_NAME, DEFAULT_LIMIT, EVENTS_STORE, PERSIST_FLUSH_MS } from "./constants.ts"

type EventListener = (event: NostrEvent) => void

/**
 * A tiered Nostr event store: an in-memory cache backed by IndexedDB, read and written through one
 * NIP-01 filter language across `query`, `peek`, `subscribe`, and `delete`. Construct one with
 * {@link createEventStore}; it is inert until {@link EventStore.init} opens the connection.
 */
export interface EventStore {
  /**
   * Open the IndexedDB connection and resolve once it is ready. No eager walk — memory starts
   * empty; warm it by issuing `query` calls. Idempotent: a no-op once the connection is open.
   */
  readonly init: () => Promise<void>
  /**
   * Store an event, deduplicating against the in-memory cache and (when present) IndexedDB.
   * Returns `true` if the event was newly stored — a fresh id, or a replaceable event newer than
   * the one held — and `false` if it was a duplicate or stale. Callers can gate once-per-event side
   * effects (forwarding, counting) on the return rather than maintaining their own seen-set.
   */
  readonly ingest: (event: NostrEvent) => boolean
  /**
   * Stream every stored event matching `filter` to `onEvent`, memory first then IndexedDB,
   * deduplicated by event id. IndexedDB hits warm the in-memory cache as they surface, but warming
   * a backfilled event does not fire `subscribe` listeners — backfill is a read, not a live ingest.
   * Resolves once the IndexedDB pass completes. `search` and empty filters resolve with no emissions.
   */
  readonly query: (filter: NostrFilter, onEvent: EventListener) => Promise<void>
  /**
   * Synchronous, memory-only sibling of `query`: the newest matching events held in the cache,
   * honouring `limit`/`since`/`until` via `matchesFilter`. Returns `[]` for empty or `search`
   * filters. Use when a sync read surface is required (rendering) and a cache miss is acceptable.
   */
  readonly peek: (filter: NostrFilter) => ReadonlyArray<NostrEvent>
  /**
   * Remove every event matching `filter` from memory and IndexedDB. Throws for an empty filter
   * (which would match everything). Supports `{ ids }` or any filter carrying `authors`; the rest
   * of the filter (`kinds`, `#d`, `since`, `until`) narrows the authored set via `matchesFilter`.
   */
  readonly delete: (filter: NostrFilter) => Promise<void>
  /**
   * Register `fn` to fire on every subsequent live `ingest` whose event matches `filter` (not on
   * `query` backfill from IndexedDB). Returns an unsubscribe function. Kind-indexed when
   * `filter.kinds` is set, otherwise a flat bucket.
   */
  readonly subscribe: (filter: NostrFilter, fn: EventListener) => () => void
  /**
   * Flush any pending writes, cancel the deferred-flush timer, close the IndexedDB connection, and
   * drop all subscribers. Idempotent. After `close()` the store is inert — `init()` reopens it.
   */
  readonly close: () => void
}

/** Construction options for {@link createEventStore}. */
export interface EventStoreConfig {
  /** Name of the backing IndexedDB database. Defaults to `"nostr-events"`. */
  readonly databaseName?: string
}

interface FilterListener {
  readonly filter: NostrFilter
  readonly fn: EventListener
}

/**
 * Create an {@link EventStore}. The returned store is inert until {@link EventStore.init} opens the
 * IndexedDB connection; events ingested beforehand are buffered in memory and flushed once it opens.
 */
export const createEventStore = (config: EventStoreConfig = {}): EventStore => {
  const databaseName = config.databaseName ?? DEFAULT_DB_NAME
  let db: IDBDatabase | null = null
  const eventCache = createEventCache()
  const pendingEntries: Array<NostrEvent> = []
  const listenersByKind = new Map<number, Array<FilterListener>>()
  const listenersAll: Array<FilterListener> = []

  const fireFilterListeners = (event: NostrEvent): void => {
    const kindList = listenersByKind.get(event.kind)
    if (kindList) {
      for (const { filter, fn } of [...kindList]) if (matchesFilter(event, filter)) fn(event)
    }
    for (const { filter, fn } of [...listenersAll]) if (matchesFilter(event, filter)) fn(event)
  }

  const flushPersist = (): void => {
    if (!db || pendingEntries.length === 0) return
    const replaceableByKey = new Map<string, NostrEvent>()
    const nonReplaceable: Array<NostrEvent> = []
    for (const event of pendingEntries) {
      const key = replaceableStorageKey(event)
      if (!key) {
        nonReplaceable.push(event)
        continue
      }
      const existing = replaceableByKey.get(key)
      if (!existing || replaceableSupersedes(event, existing)) replaceableByKey.set(key, event)
    }
    pendingEntries.length = 0

    const tx = db.transaction(EVENTS_STORE, "readwrite")
    tx.onerror = (): void => reportIdbError(tx.error)
    const store = tx.objectStore(EVENTS_STORE)
    for (const event of nonReplaceable) store.put(rowFromEvent(event))
    const index = store.index("replaceable_key")
    for (const [key, event] of replaceableByKey) {
      const getReq = index.get(key)
      getReq.onsuccess = (): void => {
        const existing = parseEventFromRow(getReq.result)
        if (existing && !replaceableSupersedes(event, existing)) return
        if (existing) store.delete(existing.id)
        store.put(rowFromEvent(event))
      }
      getReq.onerror = (): void => reportIdbError(getReq.error)
    }
  }

  const schedulePersistFlush = coalesce(flushPersist, PERSIST_FLUSH_MS)

  const init = (): Promise<void> =>
    new Promise((resolve, reject) => {
      if (db) {
        resolve()
        return
      }
      const request = indexedDB.open(databaseName, DB_VERSION)

      request.onupgradeneeded = (): void => {
        const database = request.result
        for (const name of Array.from(database.objectStoreNames)) database.deleteObjectStore(name)
        const store = database.createObjectStore(EVENTS_STORE, { keyPath: "id" })
        store.createIndex("created_at", "created_at", { unique: false })
        store.createIndex("pubkey_created_at", ["pubkey", "created_at"], { unique: false })
        store.createIndex("replaceable_key", "replaceable_key", { unique: true })
      }

      request.onsuccess = (): void => {
        db = request.result
        if (pendingEntries.length > 0) schedulePersistFlush()
        resolve()
      }
      request.onerror = (): void => reject(request.error)
    })

  const ingest = (event: NostrEvent): boolean => {
    if (!eventCache.put(event)) return false
    fireFilterListeners(event)
    pendingEntries.push(event)
    if (db) schedulePersistFlush()
    return true
  }

  const peek = (filter: NostrFilter): ReadonlyArray<NostrEvent> => {
    if (hasSearch(filter)) return []

    if (isIdsOnlyFilter(filter)) {
      const out: Array<NostrEvent> = []
      for (const id of filter.ids ?? []) {
        const event = eventCache.get(id)
        if (event && matchesFilter(event, filter)) out.push(event)
      }
      return out
    }

    if (isReplaceableLookupFilter(filter)) {
      const out: Array<NostrEvent> = []
      for (const kind of filter.kinds ?? []) {
        for (const author of filter.authors ?? []) {
          const key = replaceableLookupKey(kind, author)
          if (!key) continue
          const event = eventCache.getReplaceable(key)
          if (event && matchesFilter(event, filter)) out.push(event)
        }
      }
      return out
    }

    if (isEmptyFilter(filter)) return []

    const matched: Array<NostrEvent> = []
    for (const event of eventCache.values()) {
      if (matchesFilter(event, filter)) matched.push(event)
    }
    matched.sort(byCreatedAtDesc)
    return matched.slice(0, filter.limit ?? DEFAULT_LIMIT)
  }

  const query = async (filter: NostrFilter, onEvent: EventListener): Promise<void> => {
    if (hasSearch(filter)) return
    const seen = new Set<EventId>()
    const emit = (event: NostrEvent): void => {
      if (seen.has(event.id)) return
      seen.add(event.id)
      onEvent(event)
    }
    for (const event of peek(filter)) emit(event)

    const onIdbHit = (event: NostrEvent): void => {
      eventCache.put(event)
      emit(event)
    }

    if (isIdsOnlyFilter(filter)) {
      const missing = (filter.ids ?? []).filter((id) => !seen.has(id))
      if (missing.length === 0) return
      await queryIdb(db, { ...filter, ids: missing }, onIdbHit)
      return
    }

    await queryIdb(db, filter, onIdbHit)
  }

  const deleteByIds = (ids: ReadonlyArray<EventId>): Promise<void> => {
    for (const id of ids) eventCache.delete(id)
    return new Promise((resolve) => {
      if (!db) {
        resolve()
        return
      }
      const tx = db.transaction(EVENTS_STORE, "readwrite")
      const store = tx.objectStore(EVENTS_STORE)
      for (const id of ids) store.delete(id)
      tx.oncomplete = (): void => resolve()
      tx.onerror = (): void => {
        reportIdbError(tx.error)
        resolve()
      }
    })
  }

  const deleteMatchingByAuthors = (filter: NostrFilter): Promise<void> => {
    eventCache.deleteMatching((event) => matchesFilter(event, filter))
    return new Promise((resolve) => {
      if (!db) {
        resolve()
        return
      }
      const tx = db.transaction(EVENTS_STORE, "readwrite")
      const store = tx.objectStore(EVENTS_STORE)
      const index = store.index("pubkey_created_at")
      for (const author of filter.authors ?? []) {
        const cursorReq = index.openCursor(authorCreatedAtRange(author, filter))
        cursorReq.onsuccess = (): void => {
          const cursor = cursorReq.result
          if (!cursor) return
          const event = parseEventFromRow(cursor.value)
          if (event && matchesFilter(event, filter)) store.delete(cursor.primaryKey)
          cursor.continue()
        }
      }
      tx.oncomplete = (): void => resolve()
      tx.onerror = (): void => {
        reportIdbError(tx.error)
        resolve()
      }
    })
  }

  const deleteByFilter = async (filter: NostrFilter): Promise<void> => {
    if (isEmptyFilter(filter)) {
      throw new Error("eventStore.delete: empty filter is forbidden (would match every event)")
    }
    if (filter.ids && filter.ids.length > 0) return deleteByIds(filter.ids)
    if (filter.authors && filter.authors.length > 0) return deleteMatchingByAuthors(filter)
    throw new Error("eventStore.delete: unsupported filter shape (require ids or authors)")
  }

  const close = (): void => {
    schedulePersistFlush.cancel()
    flushPersist()
    if (db) {
      db.close()
      db = null
    }
    listenersByKind.clear()
    listenersAll.length = 0
  }

  const subscribe = (filter: NostrFilter, fn: EventListener): () => void => {
    const entry: FilterListener = { filter, fn }
    if (filter.kinds && filter.kinds.length > 0) {
      const kinds = new Set(filter.kinds)
      for (const kind of kinds) {
        let list = listenersByKind.get(kind)
        if (!list) {
          list = []
          listenersByKind.set(kind, list)
        }
        list.push(entry)
      }
      return (): void => {
        for (const kind of kinds) {
          const list = listenersByKind.get(kind)
          if (!list) continue
          const idx = list.indexOf(entry)
          if (idx >= 0) list.splice(idx, 1)
        }
      }
    }
    listenersAll.push(entry)
    return (): void => {
      const idx = listenersAll.indexOf(entry)
      if (idx >= 0) listenersAll.splice(idx, 1)
    }
  }

  return Object.freeze({
    init,
    ingest,
    query,
    peek,
    delete: deleteByFilter,
    subscribe,
    close,
  })
}
