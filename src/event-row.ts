import type { NostrEvent } from "@innis/nostr-core"
import { isRecord, parseNostrEvent, replaceableStorageKey } from "@innis/nostr-core"

/**
 * The stored shape of an event in IndexedDB. The scalar columns (`id`, `pubkey`, `created_at`,
 * `replaceable_key`) are denormalised copies of fields on `event`; they exist only to back the
 * object-store's indices. They are never read back into application logic — readers take `event`
 * and re-apply `matchesFilter`, so the embedded event is the single source of truth.
 */
export interface EventRow {
  readonly id: string
  readonly event: NostrEvent
  readonly pubkey: string
  readonly created_at: number
  readonly replaceable_key?: string
}

export const rowFromEvent = (event: NostrEvent): EventRow => {
  const key = replaceableStorageKey(event)
  const base = { id: event.id, event, pubkey: event.pubkey, created_at: event.created_at }
  return key ? { ...base, replaceable_key: key } : base
}

export const parseEventFromRow = (row: unknown): NostrEvent | null => isRecord(row) ? parseNostrEvent(row.event) : null
