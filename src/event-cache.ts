import type { EventId, NostrEvent } from "@innis/nostr-core"
import { replaceableStorageKey, replaceableSupersedes } from "@innis/nostr-core"
import { CACHE_MAX_ENTRIES, REPLACEABLE_CACHE_MAX_ENTRIES } from "./constants.ts"

export interface EventCache {
  readonly get: (id: EventId) => NostrEvent | null
  readonly getReplaceable: (replaceableKey: string) => NostrEvent | null
  readonly values: () => IterableIterator<NostrEvent>
  /** Iterate every cached event whose kind is in `kinds`, served from the per-kind index. */
  readonly valuesForKinds: (kinds: ReadonlyArray<number>) => IterableIterator<NostrEvent>
  readonly put: (event: NostrEvent) => boolean
  readonly delete: (id: EventId) => void
  readonly deleteMatching: (predicate: (event: NostrEvent) => boolean) => void
}

export const createEventCache = (): EventCache => {
  const byId = new Map<EventId, NostrEvent>()
  const byReplaceableKey = new Map<string, NostrEvent>()
  const byKind = new Map<number, Map<EventId, NostrEvent>>()

  const removeFromById = (id: EventId): void => {
    const event = byId.get(id)
    if (!event) return
    byId.delete(id)
    const bucket = byKind.get(event.kind)
    if (!bucket) return
    bucket.delete(id)
    if (bucket.size === 0) byKind.delete(event.kind)
  }

  const get = (id: EventId): NostrEvent | null => {
    const event = byId.get(id)
    if (!event) return null
    byId.delete(id)
    byId.set(id, event)
    return event
  }

  const getReplaceable = (replaceableKey: string): NostrEvent | null => {
    const event = byReplaceableKey.get(replaceableKey)
    if (!event) return null
    byReplaceableKey.delete(replaceableKey)
    byReplaceableKey.set(replaceableKey, event)
    return event
  }

  const values = (): IterableIterator<NostrEvent> => byId.values()

  function* valuesForKinds(kinds: ReadonlyArray<number>): IterableIterator<NostrEvent> {
    for (const kind of new Set(kinds)) {
      const bucket = byKind.get(kind)
      if (bucket) yield* bucket.values()
    }
  }

  const setById = (event: NostrEvent): void => {
    byId.delete(event.id)
    byId.set(event.id, event)
    let bucket = byKind.get(event.kind)
    if (!bucket) {
      bucket = new Map()
      byKind.set(event.kind, bucket)
    }
    bucket.set(event.id, event)
    if (byId.size > CACHE_MAX_ENTRIES) {
      const oldest = byId.keys().next().value
      if (oldest !== undefined) removeFromById(oldest)
    }
  }

  const setReplaceable = (replaceableKey: string, event: NostrEvent): void => {
    byReplaceableKey.delete(replaceableKey)
    byReplaceableKey.set(replaceableKey, event)
    if (byReplaceableKey.size > REPLACEABLE_CACHE_MAX_ENTRIES) {
      const oldestKey = byReplaceableKey.keys().next().value
      if (oldestKey !== undefined) {
        const evicted = byReplaceableKey.get(oldestKey)
        byReplaceableKey.delete(oldestKey)
        if (evicted) removeFromById(evicted.id)
      }
    }
  }

  const put = (event: NostrEvent): boolean => {
    const rkey = replaceableStorageKey(event)
    if (!rkey) {
      const isNew = !byId.has(event.id)
      setById(event)
      return isNew
    }

    const existing = byReplaceableKey.get(rkey)
    if (existing && !replaceableSupersedes(event, existing)) return false
    if (existing) removeFromById(existing.id)
    setReplaceable(rkey, event)
    setById(event)
    return true
  }

  const deleteById = (id: EventId): void => {
    const event = byId.get(id)
    if (!event) return
    removeFromById(id)
    const rkey = replaceableStorageKey(event)
    if (rkey && byReplaceableKey.get(rkey)?.id === id) byReplaceableKey.delete(rkey)
  }

  const deleteMatching = (predicate: (event: NostrEvent) => boolean): void => {
    for (const [id, event] of byId) {
      if (predicate(event)) removeFromById(id)
    }
    for (const [key, event] of byReplaceableKey) {
      if (predicate(event)) byReplaceableKey.delete(key)
    }
  }

  return Object.freeze({
    get,
    getReplaceable,
    values,
    valuesForKinds,
    put,
    delete: deleteById,
    deleteMatching,
  })
}
