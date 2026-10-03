/**
 * Walkthrough of the main features of @innis/nostr-event-store.
 *
 * Run with: `deno run examples/walkthrough.ts` (no permissions required — IndexedDB is the
 * in-memory `fake-indexeddb`, so everything runs locally). Each step asserts what it shows.
 *
 * @module
 */

import "fake-indexeddb/auto"
import { assertEquals } from "@std/assert"
import { buildTextNote, createLocalSigner, generateSecretKey, KIND_METADATA, KIND_TEXT_NOTE } from "@innis/nostr-core"
import type { NostrEvent, UnsignedEvent } from "@innis/nostr-core"
import { createEventStore } from "../mod.ts"

const signer = createLocalSigner(generateSecretKey())
const sign = async (event: UnsignedEvent): Promise<NostrEvent> => {
  const signed = await signer.signEvent(event)
  if (!signed.success) throw new Error(signed.error.message)
  return signed.value
}

const store = createEventStore({ databaseName: "walkthrough" })
await store.init()

const live: Array<NostrEvent> = []
const unsubscribe = store.subscribe({ kinds: [KIND_TEXT_NOTE] }, (event) => live.push(event))

const note = await sign(buildTextNote("hello store", 1700000000))
assertEquals(store.ingest(note), true)
assertEquals(store.ingest(note), false)
assertEquals(live.map((event) => event.id), [note.id])

const olderProfile = await sign({ kind: KIND_METADATA, created_at: 1700000000, tags: [], content: '{"name":"old"}' })
const newerProfile = await sign({ kind: KIND_METADATA, created_at: 1700000100, tags: [], content: '{"name":"new"}' })
store.ingest(newerProfile)
assertEquals(store.ingest(olderProfile), false)
assertEquals(store.peek({ kinds: [KIND_METADATA], authors: [note.pubkey] }).map((event) => event.content), [
  '{"name":"new"}',
])

const queried: Array<NostrEvent> = []
await store.query({ kinds: [KIND_TEXT_NOTE], authors: [note.pubkey] }, (event) => queried.push(event))
assertEquals(queried.map((event) => event.id), [note.id])

await store.delete({ ids: [note.id] })
assertEquals(store.peek({ ids: [note.id] }), [])

unsubscribe()
store.close()
