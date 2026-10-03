import type { NostrEvent, NostrFilter } from "@innis/nostr-core"
import { compileFilter, isEventExpired, kindCategory, replaceableStorageKey } from "@innis/nostr-core"
import { DEFAULT_LIMIT } from "./constants.ts"

export const hasSearch = (filter: NostrFilter): boolean => filter.search !== undefined

export const isEmptyFilter = (filter: NostrFilter): boolean => Object.keys(filter).length === 0

export const isIdsOnlyFilter = (filter: NostrFilter): boolean =>
  Array.isArray(filter.ids) && filter.kinds === undefined && filter.authors === undefined

export const isReplaceableLookupFilter = (filter: NostrFilter): boolean => {
  if (!filter.kinds || filter.kinds.length === 0) return false
  if (!filter.authors || filter.authors.length === 0) return false
  if (filter.since !== undefined || filter.until !== undefined) return false
  if (filter.ids !== undefined) return false
  for (const key of Object.keys(filter)) if (key.startsWith("#")) return false
  return filter.kinds.every((kind) => kindCategory(kind) === "replaceable")
}

export const replaceableLookupKeys = (filter: NostrFilter): ReadonlyArray<string> => {
  const keys = new Set<string>()
  for (const kind of filter.kinds ?? []) {
    for (const pubkey of filter.authors ?? []) {
      const key = replaceableStorageKey({ kind, pubkey, tags: [] })
      if (key !== null) keys.add(key)
    }
  }
  return [...keys]
}

export const readLimit = (filter: NostrFilter): number =>
  filter.limit ?? (isIdsOnlyFilter(filter) || isReplaceableLookupFilter(filter) ? Infinity : DEFAULT_LIMIT)

export const compileServable = (filter: NostrFilter, at: number): (event: NostrEvent) => boolean => {
  const { matches } = compileFilter(filter)
  return (event) => matches(event) && !isEventExpired(event, at)
}
