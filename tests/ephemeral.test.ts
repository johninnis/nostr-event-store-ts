import { assertEquals } from "@std/assert"
import type { NostrEvent } from "@innis/nostr-core"
import { buildEventFixture, buildStore, freshIdbStore } from "./_helpers/fixtures.ts"

const EPHEMERAL_KIND = 20001

Deno.test("ingest - an ephemeral event is served from memory", () => {
  const store = buildStore()
  const event = buildEventFixture({ kind: EPHEMERAL_KIND })
  store.ingest(event)
  assertEquals(store.peek({ kinds: [EPHEMERAL_KIND] }).map((e) => e.id), [event.id])
})

Deno.test("ingest - an ephemeral event reaches live subscribers", () => {
  const store = buildStore()
  const heard: Array<NostrEvent> = []
  store.subscribe({ kinds: [EPHEMERAL_KIND] }, (e) => heard.push(e))
  const event = buildEventFixture({ kind: EPHEMERAL_KIND })
  store.ingest(event)
  assertEquals(heard.map((e) => e.id), [event.id])
})

Deno.test("ingest - an ephemeral event is never persisted to IndexedDB (NIP-01)", async () => {
  const writer = await freshIdbStore()
  const ephemeral = buildEventFixture({ kind: EPHEMERAL_KIND })
  writer.ingest(ephemeral)
  writer.close()
  const cold = buildStore()
  await cold.init()
  const hits: Array<NostrEvent> = []
  await cold.query({ ids: [ephemeral.id] }, (e) => hits.push(e))
  assertEquals(hits, [])
})
