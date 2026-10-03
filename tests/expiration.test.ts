import { assertEquals } from "@std/assert"
import type { NostrEvent } from "@innis/nostr-core"
import { buildEventFixture, buildStore, freshIdbStore, PUBKEY_A } from "./_helpers/fixtures.ts"

const T = 1800000000
const expiringAt = (at: number): Partial<NostrEvent> => ({ tags: [["expiration", String(at)]] })

const settableClock = (start: number): { readonly clock: () => number; readonly set: (at: number) => void } => {
  let current = start
  return { clock: (): number => current, set: (at: number): void => void (current = at) }
}

const collect = async (
  read: (onEvent: (event: NostrEvent) => void) => Promise<void>,
): Promise<ReadonlyArray<NostrEvent>> => {
  const hits: Array<NostrEvent> = []
  await read((event) => hits.push(event))
  return hits
}

Deno.test("ingest - drops an event whose expiration is the store's current time (NIP-40)", () => {
  const store = buildStore({ clock: () => T })
  const event = buildEventFixture(expiringAt(T))
  assertEquals(store.ingest(event), false)
})

Deno.test("ingest - an event expired on arrival is not served and fires no subscriber", () => {
  const store = buildStore({ clock: () => T })
  const heard: Array<NostrEvent> = []
  store.subscribe({ kinds: [1] }, (e) => heard.push(e))
  const event = buildEventFixture(expiringAt(T - 1))
  store.ingest(event)
  assertEquals([store.peek({ ids: [event.id] }).length, heard.length], [0, 0])
})

Deno.test("ingest - stores an event whose expiration is still ahead", () => {
  const store = buildStore({ clock: () => T })
  assertEquals(store.ingest(buildEventFixture(expiringAt(T + 1))), true)
})

Deno.test("peek - stops serving a held event once the clock reaches its expiration", () => {
  const time = settableClock(T)
  const store = buildStore({ clock: time.clock })
  const event = buildEventFixture(expiringAt(T + 60))
  store.ingest(event)
  time.set(T + 60)
  assertEquals(store.peek({ ids: [event.id] }), [])
})

Deno.test("query - stops serving a held event from memory once the clock reaches its expiration", async () => {
  const time = settableClock(T)
  const store = buildStore({ clock: time.clock })
  const event = buildEventFixture({ ...expiringAt(T + 60), pubkey: PUBKEY_A })
  store.ingest(event)
  time.set(T + 60)
  assertEquals(await collect((onEvent) => store.query({ authors: [PUBKEY_A] }, onEvent)), [])
})

Deno.test("query - skips an IndexedDB row that has expired since it was persisted", async () => {
  const time = settableClock(T)
  const writer = await freshIdbStore({ clock: time.clock })
  const event = buildEventFixture(expiringAt(T + 60))
  writer.ingest(event)
  writer.close()
  time.set(T + 60)
  const cold = buildStore({ clock: time.clock })
  await cold.init()
  assertEquals(await collect((onEvent) => cold.query({ ids: [event.id] }, onEvent)), [])
})

Deno.test("query - an expired IndexedDB row does not count towards limit", async () => {
  const time = settableClock(T)
  const writer = await freshIdbStore({ clock: time.clock })
  const kept = buildEventFixture({ kind: 4300, created_at: 1000 })
  writer.ingest(kept)
  writer.ingest(buildEventFixture({ ...expiringAt(T + 60), kind: 4300, created_at: 2000 }))
  writer.close()
  time.set(T + 60)
  const cold = buildStore({ clock: time.clock })
  await cold.init()
  const hits = await collect((onEvent) => cold.query({ kinds: [4300], limit: 1 }, onEvent))
  assertEquals(hits.map((e) => e.id), [kept.id])
})
