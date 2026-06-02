import type { NostrFilter, PublicKey } from "@innis/nostr-core"
import { isParameterisedReplaceable, isReplaceable, replaceableStorageKey } from "@innis/nostr-core"

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
  return filter.kinds.every((kind) => isReplaceable(kind) && !isParameterisedReplaceable(kind))
}

export const replaceableLookupKey = (kind: number, pubkey: PublicKey): string | null =>
  replaceableStorageKey({ kind, pubkey, tags: [] })
