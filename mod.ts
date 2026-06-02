/**
 * In-memory event cache plus IndexedDB-backed event store for Nostr events.
 *
 * {@link createEventStore} returns an {@link EventStore}: one NIP-01 filter language drives memory
 * reads, IndexedDB reads, synchronous peeks, and live subscriptions, with atomic replaceable writes
 * via a unique index. See the README for the tiering model and trade-offs.
 *
 * @example
 * ```ts
 * import { createEventStore } from "@innis/nostr-event-store"
 *
 * const store = createEventStore()
 * await store.init()
 * store.ingest(event)
 * await store.query({ kinds: [1], authors: [pubkey] }, (e) => console.log(e.id))
 * ```
 *
 * @module
 */
export { createEventStore } from "./src/event-store.ts"
export type { EventStore, EventStoreConfig } from "./src/event-store.ts"
