import type { EventId, NostrEvent } from "@innis/nostr-core"
import { replaceableStorageKey, replaceableSupersedes } from "@innis/nostr-core"
import { CACHE_MAX_ENTRIES, REPLACEABLE_CACHE_MAX_ENTRIES } from "./constants.ts"

export interface EventCache {
  readonly get: (id: EventId) => NostrEvent | null
  readonly getReplaceable: (replaceableKey: string) => NostrEvent | null
  readonly values: () => IterableIterator<NostrEvent>
  readonly put: (event: NostrEvent) => boolean
  readonly delete: (id: EventId) => void
  readonly deleteMatching: (predicate: (event: NostrEvent) => boolean) => void
}

export const createEventCache = (): EventCache => {
  const byId = new Map<EventId, NostrEvent>()
  const byReplaceableKey = new Map<string, NostrEvent>()

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

  const setById = (event: NostrEvent): void => {
    byId.delete(event.id)
    byId.set(event.id, event)
    if (byId.size > CACHE_MAX_ENTRIES) {
      const oldest = byId.keys().next().value
      if (oldest !== undefined) byId.delete(oldest)
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
        if (evicted) byId.delete(evicted.id)
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
    if (existing) byId.delete(existing.id)
    setReplaceable(rkey, event)
    setById(event)
    return true
  }

  const deleteById = (id: EventId): void => {
    const event = byId.get(id)
    if (!event) return
    byId.delete(id)
    const rkey = replaceableStorageKey(event)
    if (rkey && byReplaceableKey.get(rkey)?.id === id) byReplaceableKey.delete(rkey)
  }

  const deleteMatching = (predicate: (event: NostrEvent) => boolean): void => {
    for (const [id, event] of byId) {
      if (predicate(event)) byId.delete(id)
    }
    for (const [key, event] of byReplaceableKey) {
      if (predicate(event)) byReplaceableKey.delete(key)
    }
  }

  return Object.freeze({
    get,
    getReplaceable,
    values,
    put,
    delete: deleteById,
    deleteMatching,
  })
}
