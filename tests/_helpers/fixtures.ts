import "fake-indexeddb/auto"
import type { NostrEvent } from "@innis/nostr-core"
import { KIND_SHORT_NOTE, parseEventId, parsePublicKey, parseSig } from "@innis/nostr-core"
import type { EventStore } from "../../src/event-store.ts"
import { createEventStore } from "../../src/event-store.ts"

export const PUBKEY_A = parsePublicKey("a".repeat(64))
export const PUBKEY_B = parsePublicKey("b".repeat(64))

let eventCounter = 0
export const buildEventFixture = (overrides: Partial<NostrEvent> = {}): NostrEvent => {
  eventCounter++
  const id = overrides.id ?? parseEventId(eventCounter.toString(16).padStart(64, "0"))
  return {
    id,
    pubkey: overrides.pubkey ?? PUBKEY_A,
    created_at: overrides.created_at ?? 1700000000 + eventCounter,
    kind: overrides.kind ?? KIND_SHORT_NOTE,
    tags: overrides.tags ?? [],
    content: overrides.content ?? "test",
    sig: overrides.sig ?? parseSig("c".repeat(128)),
  }
}

export const buildStore = (): EventStore => createEventStore()

export const rowFor = (event: NostrEvent): Record<string, unknown> => ({
  id: event.id,
  event,
  kind: event.kind,
  pubkey: event.pubkey,
  created_at: event.created_at,
})

export const freshIdbStore = async (): Promise<EventStore> => {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase("nostr-events")
    req.onsuccess = (): void => resolve()
    req.onerror = (): void => reject(req.error)
    req.onblocked = (): void => resolve()
  })
  const store = buildStore()
  await store.init()
  return store
}
