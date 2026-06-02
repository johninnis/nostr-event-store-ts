import { assertEquals } from "@std/assert"
import type { NostrEvent } from "@innis/nostr-core"
import { KIND_CONTACT_LIST, KIND_RELAY_LIST, KIND_SHORT_NOTE } from "@innis/nostr-core"
import { EVENTS_STORE } from "../src/constants.ts"
import { buildEventFixture, buildStore, freshIdbStore, PUBKEY_A, PUBKEY_B } from "./helpers.ts"

Deno.test("idb integration - init opens v1 with no eager walk; ingest persists; second store reads back via IDB; replaceable atomic; delete clears IDB", async () => {
  const eventStore = buildStore()
  await eventStore.init()

  // Verify the schema was created at v1 with the events store
  const inspect = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open("nostr-events")
    req.onsuccess = (): void => resolve(req.result)
    req.onerror = (): void => reject(req.error)
  })
  assertEquals(inspect.version, 1)
  assertEquals(inspect.objectStoreNames.contains(EVENTS_STORE), true)
  inspect.close()

  // init() must NOT eager-walk: memory starts empty even after init
  const note = buildEventFixture({ kind: KIND_SHORT_NOTE, pubkey: PUBKEY_A, content: "from idb" })
  eventStore.ingest(note)
  await new Promise((r) => setTimeout(r, 100))

  // A second eventStore (sharing the same backing IDB) starts with cold
  // memory and proves the IDB tier of query() is doing real work.
  const cold = buildStore()
  await cold.init()
  assertEquals(cold.peek({ ids: [note.id] }).length, 0) // memory empty post-init
  const idbHits: Array<NostrEvent> = []
  await cold.query({ ids: [note.id] }, (e) => idbHits.push(e))
  assertEquals(idbHits.length, 1)
  assertEquals(idbHits[0]?.id, note.id)
  // After query, the cold store's memory should be warmed
  assertEquals(cold.peek({ ids: [note.id] })[0]?.id, note.id)

  // Atomic replaceable: newer replaces older through the unique index
  const older = buildEventFixture({ kind: KIND_RELAY_LIST, pubkey: PUBKEY_B, created_at: 1000 })
  const newer = buildEventFixture({ kind: KIND_RELAY_LIST, pubkey: PUBKEY_B, created_at: 2000 })
  eventStore.ingest(older)
  eventStore.ingest(newer)
  await new Promise((r) => setTimeout(r, 100))
  const cold2 = buildStore()
  await cold2.init()
  const replaceableHits: Array<NostrEvent> = []
  await cold2.query({ kinds: [KIND_RELAY_LIST], authors: [PUBKEY_B] }, (e) => replaceableHits.push(e))
  assertEquals(replaceableHits.length, 1)
  assertEquals(replaceableHits[0]?.id, newer.id)

  // delete({ids}) removes from both memory and IDB
  await eventStore.delete({ ids: [note.id] })
  assertEquals(eventStore.peek({ ids: [note.id] }).length, 0)
  const cold3 = buildStore()
  await cold3.init()
  const afterDelete: Array<NostrEvent> = []
  await cold3.query({ ids: [note.id] }, (e) => afterDelete.push(e))
  assertEquals(afterDelete.length, 0)
})

Deno.test("idb integration - event ingested before init() still persists once the DB opens", async () => {
  const eventStore = buildStore()
  const early = buildEventFixture({ kind: KIND_SHORT_NOTE, pubkey: PUBKEY_A, content: "before init" })
  eventStore.ingest(early)
  await eventStore.init()
  await new Promise((r) => setTimeout(r, 100))

  const cold = buildStore()
  await cold.init()
  const hits: Array<NostrEvent> = []
  await cold.query({ ids: [early.id] }, (e) => hits.push(e))
  assertEquals(hits.length, 1)
  assertEquals(hits[0]?.id, early.id)
})

Deno.test("query - returns empty for a filter that has a search clause", async () => {
  const eventStore = await freshIdbStore()
  const hits: Array<NostrEvent> = []
  await eventStore.query({ kinds: [KIND_SHORT_NOTE], search: "hello" }, (e) => hits.push(e))
  assertEquals(hits.length, 0)
})

Deno.test("query - empty filter emits nothing, matching peek (no all-events dump)", async () => {
  const eventStore = await freshIdbStore()
  eventStore.ingest(buildEventFixture({ kind: KIND_SHORT_NOTE, pubkey: PUBKEY_A }))
  await new Promise((r) => setTimeout(r, 100))
  const cold = buildStore()
  await cold.init()
  const hits: Array<NostrEvent> = []
  await cold.query({}, (e) => hits.push(e))
  assertEquals(hits.length, 0)
  assertEquals(cold.peek({}).length, 0)
  cold.close()
  eventStore.close()
})

Deno.test("query - hits queryIdbByAuthors path and respects limit", async () => {
  const eventStore = await freshIdbStore()
  for (let i = 0; i < 5; i++) {
    eventStore.ingest(buildEventFixture({ kind: KIND_SHORT_NOTE, pubkey: PUBKEY_A, created_at: 1700000000 + i }))
  }
  await new Promise((r) => setTimeout(r, 100))
  const cold = buildStore()
  await cold.init()
  const hits: Array<NostrEvent> = []
  await cold.query({ authors: [PUBKEY_A], limit: 2 }, (e) => hits.push(e))
  assertEquals(hits.length, 2)
})

Deno.test("query - hits queryIdbByAuthors with since/until bounds", async () => {
  const eventStore = await freshIdbStore()
  eventStore.ingest(buildEventFixture({ kind: KIND_SHORT_NOTE, pubkey: PUBKEY_A, created_at: 1000 }))
  eventStore.ingest(buildEventFixture({ kind: KIND_SHORT_NOTE, pubkey: PUBKEY_A, created_at: 2000 }))
  eventStore.ingest(buildEventFixture({ kind: KIND_SHORT_NOTE, pubkey: PUBKEY_A, created_at: 3000 }))
  await new Promise((r) => setTimeout(r, 100))
  const cold = buildStore()
  await cold.init()
  const hits: Array<NostrEvent> = []
  await cold.query({ authors: [PUBKEY_A], since: 1500, until: 2500 }, (e) => hits.push(e))
  assertEquals(hits.length, 1)
  assertEquals(hits[0]?.created_at, 2000)
})

Deno.test("query - falls back to queryIdbDefault when no authors and no ids", async () => {
  const eventStore = await freshIdbStore()
  const UNIQUE_KIND = 9999
  eventStore.ingest(buildEventFixture({ kind: UNIQUE_KIND, pubkey: PUBKEY_A, created_at: 1000 }))
  eventStore.ingest(buildEventFixture({ kind: UNIQUE_KIND, pubkey: PUBKEY_B, created_at: 2000 }))
  await new Promise((r) => setTimeout(r, 100))
  const cold = buildStore()
  await cold.init()
  const hits: Array<NostrEvent> = []
  await cold.query({ kinds: [UNIQUE_KIND], limit: 10 }, (e) => hits.push(e))
  assertEquals(hits.length, 2)
})

Deno.test("query - ids-only filter via IDB returns the persisted event", async () => {
  const eventStore = await freshIdbStore()
  const event = buildEventFixture({ kind: KIND_SHORT_NOTE, pubkey: PUBKEY_A })
  eventStore.ingest(event)
  await new Promise((r) => setTimeout(r, 100))
  const cold = buildStore()
  await cold.init()
  const hits: Array<NostrEvent> = []
  await cold.query({ ids: [event.id] }, (e) => hits.push(e))
  assertEquals(hits.length, 1)
})

Deno.test("query - ids-only consults IDB only for the ids memory cannot answer", async () => {
  const eventStore = await freshIdbStore()
  const a = buildEventFixture({ kind: KIND_SHORT_NOTE, pubkey: PUBKEY_A })
  const b = buildEventFixture({ kind: KIND_SHORT_NOTE, pubkey: PUBKEY_A })
  eventStore.ingest(a)
  eventStore.ingest(b)
  await new Promise((r) => setTimeout(r, 100))

  const cold = buildStore()
  await cold.init()
  await cold.query({ ids: [a.id] }, () => {})
  assertEquals(cold.peek({ ids: [a.id] }).length, 1)
  assertEquals(cold.peek({ ids: [b.id] }).length, 0)

  const hits: Array<NostrEvent> = []
  await cold.query({ ids: [a.id, b.id] }, (e) => hits.push(e))
  assertEquals(new Set(hits.map((e) => e.id)), new Set([a.id, b.id]))
  cold.close()
  eventStore.close()
})

Deno.test("query - ids-only fully served from memory resolves without an open database", async () => {
  const eventStore = buildStore()
  const a = buildEventFixture()
  eventStore.ingest(a)
  const hits: Array<NostrEvent> = []
  await eventStore.query({ ids: [a.id] }, (e) => hits.push(e))
  assertEquals(hits.map((e) => e.id), [a.id])
})

Deno.test("query - backfill from IDB warms memory but does not fire subscribers (live ingest only)", async () => {
  const eventStore = await freshIdbStore()
  const note = buildEventFixture({ kind: KIND_SHORT_NOTE, pubkey: PUBKEY_A })
  eventStore.ingest(note)
  await new Promise((r) => setTimeout(r, 100))

  const cold = buildStore()
  await cold.init()
  const fired: Array<NostrEvent> = []
  cold.subscribe({ kinds: [KIND_SHORT_NOTE] }, (e) => fired.push(e))

  const hits: Array<NostrEvent> = []
  await cold.query({ ids: [note.id] }, (e) => hits.push(e))
  assertEquals(hits.length, 1) // query delivered it
  assertEquals(cold.peek({ ids: [note.id] }).length, 1) // memory warmed
  assertEquals(fired.length, 0) // but the subscriber did NOT fire for a backfilled event

  cold.close()
  eventStore.close()
})

Deno.test("query - replaceable lookup via IDB returns the newest atomically", async () => {
  const eventStore = await freshIdbStore()
  eventStore.ingest(buildEventFixture({ kind: KIND_CONTACT_LIST, pubkey: PUBKEY_A, created_at: 1000 }))
  eventStore.ingest(buildEventFixture({ kind: KIND_CONTACT_LIST, pubkey: PUBKEY_A, created_at: 2000 }))
  await new Promise((r) => setTimeout(r, 100))
  const cold = buildStore()
  await cold.init()
  const hits: Array<NostrEvent> = []
  await cold.query({ kinds: [KIND_CONTACT_LIST], authors: [PUBKEY_A] }, (e) => hits.push(e))
  assertEquals(hits.length, 1)
  assertEquals(hits[0]?.created_at, 2000)
})

Deno.test("idb - precedence-aware flush: an older replaceable from a cold store cannot overwrite a newer IDB row", async () => {
  const writer = await freshIdbStore()
  const newer = buildEventFixture({ kind: KIND_RELAY_LIST, pubkey: PUBKEY_A, created_at: 2000 })
  writer.ingest(newer)
  await new Promise((r) => setTimeout(r, 100))
  writer.close()

  // A cold store has no in-memory record of this key, so an older event passes its in-memory
  // precedence guard and reaches the flush. The flush must refuse to clobber the newer IDB row.
  const stale = buildStore()
  await stale.init()
  stale.ingest(buildEventFixture({ kind: KIND_RELAY_LIST, pubkey: PUBKEY_A, created_at: 1000 }))
  await new Promise((r) => setTimeout(r, 100))
  stale.close()

  const reader = buildStore()
  await reader.init()
  const hits: Array<NostrEvent> = []
  await reader.query({ kinds: [KIND_RELAY_LIST], authors: [PUBKEY_A] }, (e) => hits.push(e))
  assertEquals(hits.length, 1)
  assertEquals(hits[0]?.id, newer.id)
  assertEquals(hits[0]?.created_at, 2000)
  reader.close()
})

Deno.test("delete - { kinds, authors } clears non-replaceable matches from IDB too", async () => {
  const eventStore = await freshIdbStore()
  const note = buildEventFixture({ kind: KIND_SHORT_NOTE, pubkey: PUBKEY_A, created_at: 1000 })
  const other = buildEventFixture({ kind: KIND_SHORT_NOTE, pubkey: PUBKEY_B, created_at: 2000 })
  eventStore.ingest(note)
  eventStore.ingest(other)
  await new Promise((r) => setTimeout(r, 100))
  await eventStore.delete({ kinds: [KIND_SHORT_NOTE], authors: [PUBKEY_A] })

  const cold = buildStore()
  await cold.init()
  const deletedHits: Array<NostrEvent> = []
  await cold.query({ ids: [note.id] }, (e) => deletedHits.push(e))
  assertEquals(deletedHits.length, 0)
  const survivingHits: Array<NostrEvent> = []
  await cold.query({ ids: [other.id] }, (e) => survivingHits.push(e))
  assertEquals(survivingHits.map((e) => e.id), [other.id])
  cold.close()
  eventStore.close()
})

Deno.test("delete - { authors, since } removes only events inside the time window, in IDB too", async () => {
  const eventStore = await freshIdbStore()
  const oldNote = buildEventFixture({ kind: KIND_SHORT_NOTE, pubkey: PUBKEY_A, created_at: 1000 })
  const newNote = buildEventFixture({ kind: KIND_SHORT_NOTE, pubkey: PUBKEY_A, created_at: 3000 })
  eventStore.ingest(oldNote)
  eventStore.ingest(newNote)
  await new Promise((r) => setTimeout(r, 100))
  await eventStore.delete({ authors: [PUBKEY_A], since: 2000 })

  const cold = buildStore()
  await cold.init()
  const survivors: Array<NostrEvent> = []
  await cold.query({ ids: [oldNote.id] }, (e) => survivors.push(e))
  assertEquals(survivors.map((e) => e.id), [oldNote.id])
  const deleted: Array<NostrEvent> = []
  await cold.query({ ids: [newNote.id] }, (e) => deleted.push(e))
  assertEquals(deleted.length, 0)
  cold.close()
  eventStore.close()
})

Deno.test("close - flushes pending writes then closes; a cold store reads them back", async () => {
  const eventStore = await freshIdbStore()
  const note = buildEventFixture({ kind: KIND_SHORT_NOTE, pubkey: PUBKEY_A, content: "flush on close" })
  eventStore.ingest(note)
  eventStore.close()
  await new Promise((r) => setTimeout(r, 100))

  const cold = buildStore()
  await cold.init()
  const hits: Array<NostrEvent> = []
  await cold.query({ ids: [note.id] }, (e) => hits.push(e))
  assertEquals(hits.length, 1)
  assertEquals(hits[0]?.id, note.id)
  cold.close()
})

Deno.test("close - init after close reopens the store", async () => {
  const eventStore = await freshIdbStore()
  eventStore.close()
  await eventStore.init()
  const note = buildEventFixture({ kind: KIND_SHORT_NOTE, pubkey: PUBKEY_A, content: "after reopen" })
  eventStore.ingest(note)
  await new Promise((r) => setTimeout(r, 100))

  const cold = buildStore()
  await cold.init()
  const hits: Array<NostrEvent> = []
  await cold.query({ ids: [note.id] }, (e) => hits.push(e))
  assertEquals(hits.length, 1)
  eventStore.close()
  cold.close()
})
