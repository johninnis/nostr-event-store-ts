import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert"
import type { NostrEvent, NostrFilter } from "@innis/nostr-core"
import { KIND_CONTACT_LIST, KIND_METADATA, KIND_SHORT_NOTE, parseEventId, parsePublicKey } from "@innis/nostr-core"
import { REPLACEABLE_CACHE_MAX_ENTRIES } from "../src/constants.ts"
import { parseEventFromRow } from "../src/event-row.ts"
import { createEventStore } from "../src/event-store.ts"
import { buildEventFixture, buildStore, PUBKEY_A, PUBKEY_B, rowFor } from "./_helpers/fixtures.ts"

Deno.test("createEventStore - exposes the documented public surface and is frozen", () => {
  const store = createEventStore()
  const methods = ["init", "ingest", "query", "peek", "delete", "subscribe", "close"] as const
  for (const method of methods) assertEquals(typeof store[method], "function")
  assertEquals(Object.isFrozen(store), true)
})

Deno.test("peek - ids-only filter returns events that are in memory, skips misses", () => {
  const eventStore = buildStore()
  const a = buildEventFixture({ id: parseEventId("11".padEnd(64, "0")) })
  const b = buildEventFixture({ id: parseEventId("22".padEnd(64, "0")) })
  eventStore.ingest(a)
  eventStore.ingest(b)
  const result = eventStore.peek({ ids: [a.id, parseEventId("ff".padEnd(64, "0")), b.id] })
  assertEquals(result.length, 2)
  assertEquals(new Set(result.map((e) => e.id)), new Set([a.id, b.id]))
})

Deno.test("peek - replaceable lookup filter pulls from byReplaceableKey", () => {
  const eventStore = buildStore()
  const meta = buildEventFixture({ kind: KIND_METADATA, pubkey: PUBKEY_A, content: "{}" })
  eventStore.ingest(meta)
  const result = eventStore.peek({ kinds: [KIND_METADATA], authors: [PUBKEY_A] })
  assertEquals(result.length, 1)
  assertStrictEquals(result[0], meta)
})

Deno.test("peek - generic author feed filter returns in-memory matches newest-first", () => {
  const eventStore = buildStore()
  const older = buildEventFixture({ kind: 1, pubkey: PUBKEY_A, created_at: 1700000100 })
  const newer = buildEventFixture({ kind: 1, pubkey: PUBKEY_A, created_at: 1700000200 })
  const other = buildEventFixture({ kind: 1, pubkey: PUBKEY_B, created_at: 1700000300 })
  eventStore.ingest(older)
  eventStore.ingest(newer)
  eventStore.ingest(other)
  const result = eventStore.peek({ kinds: [1], authors: [PUBKEY_A] })
  assertEquals(result.map((e) => e.id), [newer.id, older.id])
})

Deno.test("peek - generic filter honours limit and since", () => {
  const eventStore = buildStore()
  eventStore.ingest(buildEventFixture({ kind: 1, pubkey: PUBKEY_A, created_at: 1700000100 }))
  const mid = buildEventFixture({ kind: 1, pubkey: PUBKEY_A, created_at: 1700000200 })
  const top = buildEventFixture({ kind: 1, pubkey: PUBKEY_A, created_at: 1700000300 })
  eventStore.ingest(mid)
  eventStore.ingest(top)
  assertEquals(eventStore.peek({ kinds: [1], authors: [PUBKEY_A], limit: 2 }).map((e) => e.id), [top.id, mid.id])
  assertEquals(eventStore.peek({ kinds: [1], authors: [PUBKEY_A], since: 1700000250 }).map((e) => e.id), [top.id])
})

Deno.test("peek - generic kind filter caps at limit, newest first, honouring since/until", () => {
  const eventStore = buildStore()
  const UNIQUE_KIND = 4242
  for (let i = 1; i <= 6; i++) {
    eventStore.ingest(buildEventFixture({ kind: UNIQUE_KIND, pubkey: PUBKEY_A, created_at: 1000 + i * 100 }))
  }
  const top = eventStore.peek({ kinds: [UNIQUE_KIND], limit: 3 })
  assertEquals(top.map((e) => e.created_at), [1600, 1500, 1400])
  const window = eventStore.peek({ kinds: [UNIQUE_KIND], since: 1150, until: 1350 })
  assertEquals(window.map((e) => e.created_at), [1300, 1200])
})

Deno.test("peek - equal created_at events keep first-seen order under the bounded top-N", () => {
  const eventStore = buildStore()
  const UNIQUE_KIND = 4243
  const first = buildEventFixture({ kind: UNIQUE_KIND, created_at: 2000 })
  const second = buildEventFixture({ kind: UNIQUE_KIND, created_at: 2000 })
  const third = buildEventFixture({ kind: UNIQUE_KIND, created_at: 2000 })
  eventStore.ingest(first)
  eventStore.ingest(second)
  eventStore.ingest(third)
  assertEquals(eventStore.peek({ kinds: [UNIQUE_KIND], limit: 2 }).map((e) => e.id), [first.id, second.id])
})

Deno.test("peek - filter with search returns empty without consulting cache", () => {
  const eventStore = buildStore()
  eventStore.ingest(buildEventFixture({ kind: 1 }))
  const filter: NostrFilter = { kinds: [1], search: "foo" }
  assertEquals(eventStore.peek(filter).length, 0)
})

Deno.test("peek - generic scan never surfaces a superseded replaceable (older arrives after newer)", () => {
  const eventStore = buildStore()
  const newer = buildEventFixture({ kind: KIND_METADATA, pubkey: PUBKEY_A, created_at: 2000, content: "{}" })
  const older = buildEventFixture({ kind: KIND_METADATA, pubkey: PUBKEY_A, created_at: 1000, content: "{}" })
  eventStore.ingest(newer)
  eventStore.ingest(older)
  const result = eventStore.peek({ kinds: [KIND_METADATA] })
  assertEquals(result.map((e) => e.id), [newer.id])
})

Deno.test("peek - generic scan never surfaces a superseded replaceable (newer replaces older)", () => {
  const eventStore = buildStore()
  const older = buildEventFixture({ kind: KIND_METADATA, pubkey: PUBKEY_A, created_at: 1000, content: "{}" })
  const newer = buildEventFixture({ kind: KIND_METADATA, pubkey: PUBKEY_A, created_at: 2000, content: "{}" })
  eventStore.ingest(older)
  eventStore.ingest(newer)
  const result = eventStore.peek({ kinds: [KIND_METADATA] })
  assertEquals(result.map((e) => e.id), [newer.id])
})

Deno.test("ingest - replaceable tie on created_at keeps the lexicographically lower id (NIP-01)", () => {
  const eventStore = buildStore()
  const opts = { kind: KIND_METADATA, pubkey: PUBKEY_A, created_at: 1000, content: "{}" }
  const lowId = buildEventFixture({ ...opts, id: parseEventId("11".padEnd(64, "0")) })
  const highId = buildEventFixture({ ...opts, id: parseEventId("22".padEnd(64, "0")) })

  assertEquals(eventStore.ingest(highId), true)
  assertEquals(eventStore.ingest(lowId), true)
  assertEquals(eventStore.peek({ kinds: [KIND_METADATA], authors: [PUBKEY_A] }).map((e) => e.id), [lowId.id])
})

Deno.test("ingest - replaceable tie does not let a higher id supersede the lower one already held", () => {
  const eventStore = buildStore()
  const opts = { kind: KIND_METADATA, pubkey: PUBKEY_A, created_at: 1000, content: "{}" }
  const lowId = buildEventFixture({ ...opts, id: parseEventId("11".padEnd(64, "0")) })
  const highId = buildEventFixture({ ...opts, id: parseEventId("22".padEnd(64, "0")) })

  assertEquals(eventStore.ingest(lowId), true)
  assertEquals(eventStore.ingest(highId), false)
  assertEquals(eventStore.peek({ kinds: [KIND_METADATA], authors: [PUBKEY_A] }).map((e) => e.id), [lowId.id])
})

Deno.test("cache - byReplaceableKey is bounded: the least-recently-used replaceable is evicted past the cap", () => {
  const eventStore = buildStore()
  const authorAt = (i: number) => parsePublicKey(i.toString(16).padStart(64, "0"))
  eventStore.ingest(buildEventFixture({ kind: KIND_METADATA, pubkey: authorAt(0), content: "{}" }))
  for (let i = 1; i <= REPLACEABLE_CACHE_MAX_ENTRIES; i++) {
    eventStore.ingest(buildEventFixture({ kind: KIND_METADATA, pubkey: authorAt(i), content: "{}" }))
  }
  assertEquals(eventStore.peek({ kinds: [KIND_METADATA], authors: [authorAt(0)] }).length, 0)
  assertEquals(
    eventStore.peek({ kinds: [KIND_METADATA], authors: [authorAt(REPLACEABLE_CACHE_MAX_ENTRIES)] }).length,
    1,
  )
})

Deno.test("peek - kind scan reflects replaceable cache eviction: the evicted author's event is gone", () => {
  const eventStore = buildStore()
  const authorAt = (i: number) => parsePublicKey(i.toString(16).padStart(64, "0"))
  for (let i = 0; i <= REPLACEABLE_CACHE_MAX_ENTRIES; i++) {
    eventStore.ingest(buildEventFixture({ kind: KIND_METADATA, pubkey: authorAt(i), content: "{}" }))
  }
  const scanned = eventStore.peek({ kinds: [KIND_METADATA], limit: REPLACEABLE_CACHE_MAX_ENTRIES + 1 })
  assertEquals(scanned.length, REPLACEABLE_CACHE_MAX_ENTRIES)
  assertEquals(scanned.some((e) => e.pubkey === authorAt(0)), false)
})

Deno.test("subscribe - kind-filtered listener fires when matching event ingests", () => {
  const eventStore = buildStore()
  const seen: Array<NostrEvent> = []
  eventStore.subscribe({ kinds: [KIND_METADATA] }, (e) => seen.push(e))
  eventStore.ingest(buildEventFixture({ kind: KIND_METADATA, pubkey: PUBKEY_A }))
  eventStore.ingest(buildEventFixture({ kind: KIND_SHORT_NOTE, pubkey: PUBKEY_A }))
  assertEquals(seen.length, 1)
  assertEquals(seen[0]?.kind, KIND_METADATA)
})

Deno.test("subscribe - kind+author filter fires only for matching author (no manual check needed)", () => {
  const eventStore = buildStore()
  const seen: Array<NostrEvent> = []
  eventStore.subscribe({ kinds: [KIND_CONTACT_LIST], authors: [PUBKEY_A] }, (e) => seen.push(e))
  eventStore.ingest(buildEventFixture({ kind: KIND_CONTACT_LIST, pubkey: PUBKEY_A }))
  eventStore.ingest(buildEventFixture({ kind: KIND_CONTACT_LIST, pubkey: PUBKEY_B }))
  assertEquals(seen.length, 1)
  assertEquals(seen[0]?.pubkey, PUBKEY_A)
})

Deno.test("subscribe - filter without kinds uses flat bucket and fires for any matching event", () => {
  const eventStore = buildStore()
  const seen: Array<NostrEvent> = []
  eventStore.subscribe({ authors: [PUBKEY_A] }, (e) => seen.push(e))
  eventStore.ingest(buildEventFixture({ kind: KIND_SHORT_NOTE, pubkey: PUBKEY_A }))
  eventStore.ingest(buildEventFixture({ kind: KIND_METADATA, pubkey: PUBKEY_A }))
  eventStore.ingest(buildEventFixture({ kind: KIND_SHORT_NOTE, pubkey: PUBKEY_B }))
  assertEquals(seen.length, 2)
})

Deno.test("subscribe - unsubscribe removes listener and stops firing", () => {
  const eventStore = buildStore()
  const seen: Array<NostrEvent> = []
  const unsubscribe = eventStore.subscribe({ kinds: [KIND_METADATA] }, (e) => seen.push(e))
  eventStore.ingest(buildEventFixture({ kind: KIND_METADATA, pubkey: PUBKEY_A }))
  unsubscribe()
  eventStore.ingest(buildEventFixture({ kind: KIND_METADATA, pubkey: PUBKEY_B }))
  assertEquals(seen.length, 1)
})

Deno.test("subscribe - a listener that unsubscribes mid-fire does not skip its siblings", () => {
  const eventStore = buildStore()
  const seen: Array<string> = []
  const unsubscribeFirst = eventStore.subscribe({ kinds: [KIND_METADATA] }, () => {
    seen.push("first")
    unsubscribeFirst()
  })
  eventStore.subscribe({ kinds: [KIND_METADATA] }, () => seen.push("second"))
  eventStore.ingest(buildEventFixture({ kind: KIND_METADATA, pubkey: PUBKEY_A }))
  assertEquals(seen, ["first", "second"])
})

Deno.test("subscribe - a listener added mid-fire does not receive the in-flight event", () => {
  const eventStore = buildStore()
  const seen: Array<string> = []
  eventStore.subscribe({ kinds: [KIND_METADATA] }, () => {
    seen.push("first")
    eventStore.subscribe({ kinds: [KIND_METADATA] }, () => seen.push("late"))
  })
  eventStore.ingest(buildEventFixture({ kind: KIND_METADATA, pubkey: PUBKEY_A }))
  assertEquals(seen, ["first"])
})

Deno.test("subscribe - flat-bucket listener that unsubscribes mid-fire does not skip its siblings", () => {
  const eventStore = buildStore()
  const seen: Array<string> = []
  const unsubscribeFirst = eventStore.subscribe({ authors: [PUBKEY_A] }, () => {
    seen.push("first")
    unsubscribeFirst()
  })
  eventStore.subscribe({ authors: [PUBKEY_A] }, () => seen.push("second"))
  eventStore.ingest(buildEventFixture({ kind: KIND_SHORT_NOTE, pubkey: PUBKEY_A }))
  assertEquals(seen, ["first", "second"])
  eventStore.ingest(buildEventFixture({ kind: KIND_SHORT_NOTE, pubkey: PUBKEY_A }))
  assertEquals(seen, ["first", "second", "second"])
})

Deno.test("subscribe - duplicate kinds in a filter fire the listener once per matching event", () => {
  const eventStore = buildStore()
  const seen: Array<NostrEvent> = []
  eventStore.subscribe({ kinds: [KIND_METADATA, KIND_METADATA] }, (e) => seen.push(e))
  eventStore.ingest(buildEventFixture({ kind: KIND_METADATA, pubkey: PUBKEY_A }))
  assertEquals(seen.length, 1)
})

Deno.test("delete - empty filter throws, never wipes the store", async () => {
  const eventStore = buildStore()
  await assertRejects(() => eventStore.delete({}), Error, "empty filter")
})

Deno.test("delete - { ids } removes events from memory", () => {
  const eventStore = buildStore()
  const a = buildEventFixture({ id: parseEventId("11".padEnd(64, "0")) })
  eventStore.ingest(a)
  assertEquals(eventStore.peek({ ids: [a.id] }).length, 1)
  eventStore.delete({ ids: [a.id] })
  assertEquals(eventStore.peek({ ids: [a.id] }).length, 0)
})

Deno.test("delete - { ids, authors } removes only the listed ids by those authors", () => {
  const eventStore = buildStore()
  const alice = parsePublicKey("a".repeat(64))
  const bob = parsePublicKey("b".repeat(64))
  const byAlice = buildEventFixture({ id: parseEventId("12".padEnd(64, "0")), pubkey: alice })
  const byBob = buildEventFixture({ id: parseEventId("13".padEnd(64, "0")), pubkey: bob })
  eventStore.ingest(byAlice)
  eventStore.ingest(byBob)
  eventStore.delete({ ids: [byAlice.id, byBob.id], authors: [bob] })
  assertEquals(eventStore.peek({ ids: [byAlice.id, byBob.id] }).map((e) => e.id), [byAlice.id])
})

Deno.test("delete - { authors } clears every event by that author from memory", () => {
  const eventStore = buildStore()
  eventStore.ingest(buildEventFixture({ kind: 1, pubkey: PUBKEY_A, id: parseEventId("aa".padEnd(64, "0")) }))
  eventStore.ingest(buildEventFixture({ kind: 1, pubkey: PUBKEY_A, id: parseEventId("bb".padEnd(64, "0")) }))
  eventStore.ingest(
    buildEventFixture({ kind: KIND_METADATA, pubkey: PUBKEY_A, id: parseEventId("cc".padEnd(64, "0")) }),
  )
  eventStore.ingest(buildEventFixture({ kind: 1, pubkey: PUBKEY_B, id: parseEventId("dd".padEnd(64, "0")) }))
  eventStore.delete({ authors: [PUBKEY_A] })
  assertEquals(eventStore.peek({ ids: [parseEventId("aa".padEnd(64, "0"))] }).length, 0)
  assertEquals(eventStore.peek({ kinds: [KIND_METADATA], authors: [PUBKEY_A] }).length, 0)
  assertEquals(eventStore.peek({ ids: [parseEventId("dd".padEnd(64, "0"))] })[0]?.pubkey, PUBKEY_B)
})

Deno.test("delete - { kinds, authors } removes non-replaceable matches from memory", () => {
  const eventStore = buildStore()
  const a1 = buildEventFixture({ kind: KIND_SHORT_NOTE, pubkey: PUBKEY_A, id: parseEventId("a1".padEnd(64, "0")) })
  const a2 = buildEventFixture({ kind: KIND_SHORT_NOTE, pubkey: PUBKEY_A, id: parseEventId("a2".padEnd(64, "0")) })
  const b1 = buildEventFixture({ kind: KIND_SHORT_NOTE, pubkey: PUBKEY_B, id: parseEventId("b1".padEnd(64, "0")) })
  eventStore.ingest(a1)
  eventStore.ingest(a2)
  eventStore.ingest(b1)
  eventStore.delete({ kinds: [KIND_SHORT_NOTE], authors: [PUBKEY_A] })
  assertEquals(eventStore.peek({ ids: [a1.id] }).length, 0)
  assertEquals(eventStore.peek({ ids: [a2.id] }).length, 0)
  assertEquals(eventStore.peek({ ids: [b1.id] }).length, 1)
})

Deno.test("delete - { authors, kinds } removes only matching events", () => {
  const eventStore = buildStore()
  const note = buildEventFixture({ kind: KIND_SHORT_NOTE, pubkey: PUBKEY_A })
  const meta = buildEventFixture({ kind: KIND_METADATA, pubkey: PUBKEY_A })
  eventStore.ingest(note)
  eventStore.ingest(meta)
  eventStore.delete({ kinds: [KIND_METADATA], authors: [PUBKEY_A] })
  assertEquals(eventStore.peek({ ids: [note.id] }).length, 1)
  assertEquals(eventStore.peek({ kinds: [KIND_METADATA], authors: [PUBKEY_A] }).length, 0)
})

Deno.test("close - is idempotent and drops subscribers", () => {
  const eventStore = buildStore()
  const seen: Array<NostrEvent> = []
  eventStore.subscribe({ kinds: [KIND_METADATA] }, (e) => seen.push(e))
  eventStore.ingest(buildEventFixture({ kind: KIND_METADATA, pubkey: PUBKEY_A }))
  assertEquals(seen.length, 1)

  eventStore.close()
  eventStore.close()
  eventStore.ingest(buildEventFixture({ kind: KIND_METADATA, pubkey: PUBKEY_B }))
  assertEquals(seen.length, 1)
})

Deno.test("parseEventFromRow - extracts the embedded event from a well-formed row", () => {
  const event = buildEventFixture()
  assertEquals(parseEventFromRow(rowFor(event))?.id, event.id)
})

Deno.test("parseEventFromRow - returns null for input that is not an object", () => {
  assertEquals(parseEventFromRow("nope"), null)
  assertEquals(parseEventFromRow(null), null)
  assertEquals(parseEventFromRow([1, 2, 3]), null)
})

Deno.test("parseEventFromRow - returns null when the embedded event is missing or malformed", () => {
  const event = buildEventFixture()
  assertEquals(parseEventFromRow({ ...rowFor(event), event: { ...event, id: "tooshort" } }), null)
  assertEquals(parseEventFromRow({ ...rowFor(event), event: "not an event" }), null)
  assertEquals(parseEventFromRow({ id: event.id }), null)
})
