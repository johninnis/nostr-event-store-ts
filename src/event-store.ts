import type { EventId, NostrEvent, NostrFilter } from "@innis/nostr-core"
import {
  byCreatedAtDesc,
  compileFilter,
  replaceableStorageKey,
  replaceableSupersedes,
  reportUnhandledError,
} from "@innis/nostr-core"
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
   * honouring `limit`/`since`/`until` via `compileFilter`. Returns `[]` for empty or `search`
   * filters. Use when a sync read surface is required (rendering) and a cache miss is acceptable.
   */
  readonly peek: (filter: NostrFilter) => ReadonlyArray<NostrEvent>
  /**
   * Remove every event matching the whole of `filter` from memory and IndexedDB. Throws for an
   * empty filter (which would match everything). Supports `{ ids }` or any filter carrying
   * `authors`; the rest of the filter (`authors`, `kinds`, `#d`, `since`, `until`) narrows the
   * candidate set via `compileFilter`, so `{ ids, authors }` removes only those ids by those authors.
   */
  readonly delete: (filter: NostrFilter) => Promise<void>
  /**
   * Register `fn` to fire on every subsequent live `ingest` whose event matches `filter` (not on
   * `query` backfill from IndexedDB). Returns an unsubscribe function. Kind-indexed when
   * `filter.kinds` is set, otherwise a flat bucket.
   *
   * With `{ replay: true }` the subscription behaves like a Nostr `REQ`: stored events first, then
   * live. The live listener is registered before the stored read starts, then every stored match is
   * streamed through `fn` exactly as `query` would deliver it (memory synchronously, before
   * `subscribe` returns, then IndexedDB). Each event id reaches `fn` at most once across the
   * replay/live boundary. Replayed events arrive in `query` order and live events as they are
   * ingested, so a live event can precede an older replayed one. Unsubscribing during the replay
   * stops further delivery from both sources.
   */
  readonly subscribe: (filter: NostrFilter, fn: EventListener, options?: SubscribeOptions) => () => void
  /**
   * Flush any pending writes, cancel the deferred-flush timer, close the IndexedDB connection, and
   * drop all subscribers. Idempotent. After `close()` the store is inert — `init()` reopens it.
   */
  readonly close: () => void
}

/** Options for {@link EventStore.subscribe}. */
export interface SubscribeOptions {
  /**
   * Deliver the stored events matching the filter (memory, then IndexedDB) before and alongside
   * live ingests, each event id at most once. Defaults to `false`: live ingests only.
   */
  readonly replay?: boolean
}

/** Construction options for {@link createEventStore}. */
export interface EventStoreConfig {
  /** Name of the backing IndexedDB database. Defaults to `"nostr-events"`. */
  readonly databaseName?: string
}

interface FilterListener {
  readonly matches: (event: NostrEvent) => boolean
  readonly fn: EventListener
}

// Bounded top-N insertion ordered by byCreatedAtDesc. Equal created_at inserts after existing
// equals (comparator <= 0 walks right), so ties keep their first-seen order — the same result as
// collecting every match and running a stable sort, without holding more than `limit` events.
const insertNewestFirst = (sorted: Array<NostrEvent>, event: NostrEvent, limit: number): void => {
  if (sorted.length >= limit) {
    const last = sorted[sorted.length - 1]
    if (last === undefined || byCreatedAtDesc(last, event) <= 0) return
  }
  let low = 0
  let high = sorted.length
  while (low < high) {
    const mid = (low + high) >>> 1
    const probe = sorted[mid]
    if (probe !== undefined && byCreatedAtDesc(probe, event) <= 0) low = mid + 1
    else high = mid
  }
  sorted.splice(low, 0, event)
  if (sorted.length > limit) sorted.pop()
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
  const listenersByKind = new Map<number, ReadonlyArray<FilterListener>>()
  let listenersAll: ReadonlyArray<FilterListener> = []

  const fireFilterListeners = (event: NostrEvent): void => {
    // Listener arrays are copy-on-write: subscribe/unsubscribe replace the array rather than
    // mutate it, so iterating the current reference keeps the same snapshot semantics the old
    // per-dispatch spread provided, without copying on every event.
    const kindList = listenersByKind.get(event.kind)
    if (kindList) {
      for (const { matches, fn } of kindList) if (matches(event)) fn(event)
    }
    for (const { matches, fn } of listenersAll) if (matches(event)) fn(event)
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
    const { matches } = compileFilter(filter)

    if (isIdsOnlyFilter(filter)) {
      const out: Array<NostrEvent> = []
      for (const id of filter.ids ?? []) {
        const event = eventCache.get(id)
        if (event && matches(event)) out.push(event)
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
          if (event && matches(event)) out.push(event)
        }
      }
      return out
    }

    if (isEmptyFilter(filter)) return []

    const limit = filter.limit ?? DEFAULT_LIMIT
    const source = filter.kinds && filter.kinds.length > 0
      ? eventCache.valuesForKinds(filter.kinds)
      : eventCache.values()
    const top: Array<NostrEvent> = []
    for (const event of source) {
      if (matches(event)) insertNewestFirst(top, event, limit)
    }
    return top
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

  const deleteByIds = (filter: NostrFilter): Promise<void> => {
    const { matches } = compileFilter(filter)
    const ids = filter.ids ?? []
    for (const id of ids) {
      const cached = eventCache.get(id)
      if (cached && matches(cached)) eventCache.delete(id)
    }
    return new Promise((resolve) => {
      if (!db) {
        resolve()
        return
      }
      const tx = db.transaction(EVENTS_STORE, "readwrite")
      const store = tx.objectStore(EVENTS_STORE)
      for (const id of ids) {
        const getReq = store.get(id)
        getReq.onsuccess = (): void => {
          const event = parseEventFromRow(getReq.result)
          if (event && matches(event)) store.delete(id)
        }
      }
      tx.oncomplete = (): void => resolve()
      tx.onerror = (): void => {
        reportIdbError(tx.error)
        resolve()
      }
    })
  }

  const deleteMatchingByAuthors = (filter: NostrFilter): Promise<void> => {
    const { matches } = compileFilter(filter)
    eventCache.deleteMatching(matches)
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
          if (event && matches(event)) store.delete(cursor.primaryKey)
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
    if (filter.ids && filter.ids.length > 0) return deleteByIds(filter)
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
    listenersAll = []
  }

  const addListener = (filter: NostrFilter, fn: EventListener): () => void => {
    const entry: FilterListener = { matches: compileFilter(filter).matches, fn }
    if (filter.kinds && filter.kinds.length > 0) {
      const kinds = new Set(filter.kinds)
      for (const kind of kinds) {
        listenersByKind.set(kind, [...listenersByKind.get(kind) ?? [], entry])
      }
      return (): void => {
        for (const kind of kinds) {
          const remaining = (listenersByKind.get(kind) ?? []).filter((e) => e !== entry)
          if (remaining.length === 0) listenersByKind.delete(kind)
          else listenersByKind.set(kind, remaining)
        }
      }
    }
    listenersAll = [...listenersAll, entry]
    return (): void => {
      listenersAll = listenersAll.filter((e) => e !== entry)
    }
  }

  // The delivered-id set only lives for the replay pass: it holds at most the replayed matches plus
  // the live arrivals that overlap them, and is dropped once the stored read resolves, after which
  // the store's own ingest dedup is the only guard the live path needs.
  const subscribeWithReplay = (filter: NostrFilter, fn: EventListener): () => void => {
    let active = true
    let deliveredDuringReplay: Set<EventId> | null = new Set()
    const deliverOnce = (event: NostrEvent): void => {
      if (!active) return
      if (deliveredDuringReplay) {
        if (deliveredDuringReplay.has(event.id)) return
        deliveredDuringReplay.add(event.id)
      }
      fn(event)
    }
    const removeListener = addListener(filter, deliverOnce)
    query(filter, deliverOnce).then(() => {
      deliveredDuringReplay = null
    }, reportUnhandledError)
    return (): void => {
      active = false
      deliveredDuringReplay = null
      removeListener()
    }
  }

  const subscribe = (filter: NostrFilter, fn: EventListener, options: SubscribeOptions = {}): () => void =>
    options.replay ? subscribeWithReplay(filter, fn) : addListener(filter, fn)

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
